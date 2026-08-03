import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Waveform, { SpeakerRegion } from "./Waveform";
import { api, RecMeta, RecSegment, RecWord } from "../api";
import { PlayIcon, PauseIcon, StopIcon } from "../icons";
import { liveSttOn, micMuted, noteLiveStt, setMicMuted } from "../workspace/liveRec";
import { cutShiftBefore } from "./recTiming";
import type { UnlistenFn } from "@tauri-apps/api/event";

const SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * ADD-27: the Recording file — record live (mic + the Mac's own audio, so a
 * Google Meet/Zoom/Teams call is heard), watch the transcript appear WHILE
 * people speak, with speakers told apart; then edit the recording by editing
 * its text (select words → delete: playback skips them, "Export edited copy"
 * cuts the audio for real) and translate the whole thing into any language.
 * Transcription always happens on this Mac (Whisper, on-device). Translation —
 * live and whole-file alike — runs on the ROOM's chosen model, which may be a
 * cloud one; nothing here may claim otherwise.
 *
 * The capture session itself lives in the backend + a workspace-level mic
 * tap, NOT here — this view attaches to it, so navigating away never stops
 * a recording.
 */

export interface RecordingLiveState {
  fileId: string;
  status: string;
}

export interface RecordingViewProps {
  fileId: string;
  mediaToken: string | null;
  /** The workspace-wide live session (null when nothing is recording). */
  live: RecordingLiveState | null;
  /** Stop→saved drain readout — the audio is already durable when this is
   * non-null, and `remaining` counts the phrase decodes still queued. */
  saveProgress: { stage: "transcribing" | "writing"; remaining: number } | null;
  pushToast: (
    kind: "info" | "success" | "error",
    text: string,
    action?: { label: string; run: () => void },
  ) => void;
  onStart: (
    fileId: string,
    opts: { systemAudio: boolean; liveTranslate: string | null },
  ) => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
}

/** Suggestions only — every language box in this view is free text, because
 * the engine translates into anything. A fixed dropdown for LIVE translation
 * while the after-the-fact box accepted any language meant you could get Greek
 * afterwards but not as it happened. */
const LANGS = [
  "English", "עברית (Hebrew)", "Español (Spanish)", "Français (French)",
  "Deutsch (German)", "العربية (Arabic)", "Русский (Russian)", "中文 (Chinese)",
  "日本語 (Japanese)", "Português (Portuguese)", "Italiano (Italian)", "हिन्दी (Hindi)",
  "Українська (Ukrainian)", "Nederlands (Dutch)", "Polski (Polish)", "Türkçe (Turkish)",
];

/** Stable chip color per speaker: "You" gets the accent, meeting voices walk
 * a small hue palette by their number. */
function speakerHue(speaker: string): number | null {
  if (speaker === "You") return null;
  const n = parseInt(speaker.replace(/\D/g, ""), 10) || 1;
  return [155, 25, 265, 330, 95, 200][(n - 1) % 6];
}

/** GH #5: the speaker chip, renameable once you know who was talking.
 *
 * The machine label ("Speaker 2") stays the identity underneath — the name is
 * an overlay keyed by it — so one edit renames every line that person said, and
 * the name survives the engine re-clustering the meeting. Colour is keyed on
 * the LABEL, not the name, so renaming doesn't change anyone's chip colour. */
function SpeakerChip({
  label,
  name,
  hue,
  onRename,
}: {
  label: string;
  name: string;
  hue: number | null;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const style =
    hue == null
      ? undefined
      : { background: `hsl(${hue} 60% 45% / .18)`, color: `hsl(${hue} 70% 35%)` };

  if (editing) {
    const commit = () => {
      setEditing(false);
      onRename(draft);
    };
    return (
      <input
        className="rec-speaker rec-speaker-input"
        autoFocus
        dir="auto"
        maxLength={60}
        value={draft}
        aria-label={`Name for ${label}`}
        data-testid="speaker-input"
        placeholder={label}
        onChange={(e) => setDraft(e.target.value)}
        // Escape resets the draft first, so the blur it triggers commits the
        // unchanged name — which the caller treats as a no-op.
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }
  const named = name !== label;
  return (
    <button
      className="rec-speaker rec-speaker-btn"
      style={style}
      data-speaker={label}
      data-testid="speaker-chip"
      title={
        named
          ? `Rename — the engine calls this voice ${label}`
          : "Name this speaker — renames every line they said"
      }
      onClick={() => {
        setDraft(named ? name : "");
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}

/** One phrase inside a turn. `visible` is the words to draw ("Show deleted"
 * already applied); null means the segment has no word timings — draw its
 * plain text. */
interface TurnSeg {
  seg: RecSegment;
  visible: RecWord[] | null;
}

/** A run of consecutive same-speaker segments, shown as one block: timestamp
 * and speaker chip once, the phrases flowing together as a paragraph. */
interface Turn {
  key: string;
  speaker: string;
  t0: number;
  dir: "rtl" | "ltr" | "auto";
  segs: TurnSeg[];
}

/** The turn body needs an explicit direction: its per-segment children carry
 * dir="auto" (so a mixed-language turn isolates each phrase), and HTML's
 * dir="auto" resolution skips children that have a dir attribute — the parent
 * would always fall back to LTR. So resolve "first strong letter wins" here. */
function strongDir(text: string): "rtl" | "ltr" | null {
  const m = text.match(/\p{L}/u);
  if (!m) return null;
  return /[\u0591-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(m[0]) ? "rtl" : "ltr";
}

function formatTimestamp(centiseconds: number): string {
  const s = Math.max(0, Math.floor(centiseconds / 100));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export default function RecordingView({
  fileId,
  mediaToken,
  live,
  saveProgress,
  pushToast,
  onStart,
  onPause,
  onResume,
  onStop,
}: RecordingViewProps) {
  const [meta, setMeta] = useState<RecMeta | null>(null);
  const [partials, setPartials] = useState<{ mic?: string; sys?: string }>({});
  const [levels, setLevels] = useState<{ mic: number; sys: number }>({ mic: 0, sys: 0 });
  const [durationCs, setDurationCs] = useState(0);
  const [liveTranslations, setLiveTranslations] = useState<Record<string, string>>({});
  const [sysNote, setSysNote] = useState<string | null>(null);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [selection, setSelection] = useState<{ t0: number; t1: number; words: number } | null>(null);
  // The correction box, opened from the selection bar. Held apart from
  // `selection` so opening it cannot be mistaken for having typed anything.
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  // Read by `captureSelection`, which the `selectionchange` listener holds from
  // the first render — a state read there would be permanently `false`.
  const correctingRef = useRef(false);
  correctingRef.current = correcting;
  const [translating, setTranslating] = useState<{ done: number; total: number } | null>(null);
  const [retrans, setRetrans] = useState<{ doneCs: number; totalCs: number } | null>(null);
  const [confirmRetrans, setConfirmRetrans] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Export edited copy" decodes, splices and re-encodes the whole WAV — minutes
  // on a long meeting. It no longer freezes the room (the work is off the UI
  // thread), but the button simply greyed out and said nothing, which is what
  // "the app has hung" looks like. There is no honest percentage to show —
  // nothing reports one — so the button says what it is doing and no more.
  const [exporting, setExporting] = useState(false);
  const [activeSeg, setActiveSeg] = useState<string | null>(null);
  // Pre-start choices (also editable mid-flight for live translate).
  const [withSystem, setWithSystem] = useState(true);
  const [liveLang, setLiveLang] = useState("");
  const [translateTo, setTranslateTo] = useState("");
  // Session controls whose truth lives OUTSIDE this view (liveRec module
  // state), because the view unmounts while the recording keeps running.
  const [micIsMuted, setMicIsMuted] = useState(micMuted());
  const [liveStt, setLiveStt] = useState(liveSttOn());

  // The sys-lane failure toast fires once per outage, not on every event.
  const sysToastedRef = useRef(false);
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const mine = live?.fileId === fileId ? live : null;
  const status = mine?.status ?? "idle";
  const isLive = status === "recording" || status === "paused" || status === "saving";
  const recordingNow = status === "recording";

  // ---- load + subscribe -------------------------------------------------
  useEffect(() => {
    let dead = false;
    void api
      .recGet(fileId)
      .then((r) => {
        if (!dead) {
          setMeta(r.meta);
          setDurationCs(r.meta.durationCs);
        }
      })
      .catch((e) => pushToast("error", String(e)));
    // A source may have died BEFORE this view mounted; the engine keeps the
    // latest health durable exactly for this read.
    void api
      .recLiveStatus()
      .then((r) => {
        if (dead || !r || r.fileId !== fileId) return;
        setSysNote(r.sys[0] === "error" ? r.sys[1] : null);
        setMicNote(r.mic[0] === "error" ? r.mic[1] : null);
      })
      .catch(() => {});
    const subs: Promise<UnlistenFn>[] = [
      api.onRecSegment((p) => {
        if (p.fileId !== fileId) return;
        setMeta((m) => {
          if (!m) return m;
          const segments = [...m.segments];
          let at = segments.length;
          while (at > 0 && segments[at - 1].t0 > p.segment.t0) at--;
          segments.splice(at, 0, p.segment);
          return { ...m, segments };
        });
        setPartials((prev) => ({ ...prev, [p.segment.source]: undefined }));
      }),
      api.onRecSegmentDrop((p) => {
        if (p.fileId !== fileId) return;
        setMeta((m) => (m ? { ...m, segments: m.segments.filter((s) => s.id !== p.id) } : m));
      }),
      api.onRecPartial((p) => {
        if (p.fileId !== fileId) return;
        setPartials((prev) => ({ ...prev, [p.source]: p.text || undefined }));
      }),
      // Speakers sort themselves out as the meeting goes on: the engine
      // re-clusters every few phrases and corrects the labels on screen.
      api.onRecRelabel((p) => {
        if (p.fileId !== fileId) return;
        const by = new Map(p.labels.map((l) => [l.id, l.speaker]));
        setMeta((m) =>
          m
            ? {
                ...m,
                segments: m.segments.map((s) =>
                  by.get(s.id) && by.get(s.id) !== s.speaker
                    ? { ...s, speaker: by.get(s.id)! }
                    : s,
                ),
              }
            : m,
        );
      }),
      api.onRecLevel((p) => {
        if (p.fileId !== fileId) return;
        setLevels({ mic: p.mic, sys: p.sys });
        setDurationCs(p.durationCs);
      }),
      api.onRecSource((p) => {
        if (p.fileId !== fileId) return;
        if (p.source === "sys") {
          if (p.status === "error") {
            setSysNote(p.message);
            if (!sysToastedRef.current) {
              sysToastedRef.current = true;
              pushToast("error", p.message);
            }
          } else {
            setSysNote(null);
            sysToastedRef.current = false;
          }
        } else if (p.source === "mic") {
          setMicNote(p.status === "error" ? p.message : null);
        }
      }),
      api.onRecLiveTranslation((p) => {
        if (p.fileId !== fileId) return;
        setLiveTranslations((t) => ({ ...t, [p.segId]: p.text }));
      }),
      api.onRecTranslateProgress((p) => {
        if (p.fileId !== fileId) return;
        setTranslating(p.done >= p.total ? null : { done: p.done, total: p.total });
      }),
      api.onRecRetranscribe((p) => {
        if (p.fileId !== fileId) return;
        setRetrans(p.doneCs >= p.totalCs ? null : { doneCs: p.doneCs, totalCs: p.totalCs });
      }),
    ];
    return () => {
      dead = true;
      subs.forEach((s) => void s.then((un) => un()));
    };
  }, [fileId, pushToast]);

  // Live view follows the newest words.
  useEffect(() => {
    if (recordingNow) listEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [meta?.segments.length, partials.mic, partials.sys, recordingNow]);

  // No "still speaking…" line survives a pause/stop.
  useEffect(() => {
    if (!recordingNow) setPartials({});
  }, [recordingNow]);

  // Pause/stop tears the mic tap down, which resets the mute — re-read the
  // module truth whenever the session status moves.
  useEffect(() => {
    setMicIsMuted(micMuted());
  }, [status]);

  // A dead session's sys-lane error must not greet the next one: the engine
  // emits no rec-source on stop, so the banner/toast guard reset here.
  useEffect(() => {
    if (!isLive) {
      setSysNote(null);
      setMicNote(null);
      sysToastedRef.current = false;
    }
  }, [isLive]);

  // Pause/stop rewrote the file (audio + transcript): reload the saved truth.
  useEffect(() => {
    if (status === "idle" || status === "paused") {
      void api.recGet(fileId).then((r) => setMeta(r.meta)).catch(() => {});
    }
  }, [status, fileId]);

  const segments = meta?.segments ?? [];
  const cuts = useMemo(() => meta?.cuts ?? [], [meta]);

  // Turns are derived, never stored: rec-segment / rec-relabel /
  // rec-segment-drop keep editing the flat segment list, and the grouping
  // re-splits on its own (e.g. a relabel that flips a middle segment's
  // speaker breaks its old turn in two).
  const turns = useMemo<Turn[]>(() => {
    const out: Turn[] = [];
    for (const seg of segments) {
      const visible = seg.words.length
        ? seg.words.filter((w) => showDeleted || !w.del)
        : null;
      // A word-timed segment whose every word is deleted (and hidden) has
      // nothing to draw — seg.text still holds the original words, so it
      // must not be the fallback here, or deleting a whole utterance leaves
      // a dangling speaker header over an empty paragraph.
      if (visible && visible.length === 0) continue;
      if (!visible && !seg.text) continue;
      const last = out[out.length - 1];
      if (last && last.speaker === seg.speaker) last.segs.push({ seg, visible });
      else out.push({ key: seg.id, speaker: seg.speaker, t0: seg.t0, dir: "auto", segs: [{ seg, visible }] });
    }
    for (const t of out) {
      t.dir =
        strongDir(
          t.segs
            .map(({ seg, visible }) => (visible ? visible.map((w) => w.w).join(" ") : seg.text))
            .join(" "),
        ) ?? "auto";
    }
    return out;
  }, [segments, showDeleted]);

  // The waveform's speaker bands, taken straight off the SEGMENTS rather than
  // parsed back out of the transcript: this viewer already holds the
  // structured diarization result, complete with the user's own names for each
  // voice. Consecutive segments from one speaker merge into a single band, so
  // a conversation reads as a handful of turns instead of a stripe per phrase.
  const speakerRegions = useMemo<SpeakerRegion[]>(
    () =>
      turns.map((t) => {
        const last = t.segs[t.segs.length - 1].seg;
        return {
          start: t.t0 / 100,
          end: Math.max(last.t1 ?? t.t0, t.t0 + 1) / 100,
          // The user's own name for this voice when they gave one — the
          // legend must match the chips down the transcript.
          speaker: meta?.speakerNames?.[t.speaker] || t.speaker,
        };
      }),
    [turns, meta?.speakerNames],
  );

  // ---- playback (skips deleted spans) ------------------------------------
  const src = mediaToken && !isLive ? `roommedia://localhost/${mediaToken}` : null;
  // The waveform drives the same element the transcript and the cut-skipping
  // do, so there is exactly one playhead.
  const [mediaEl, setMediaEl] = useState<HTMLAudioElement | null>(null);

  /**
   * Jump the playhead out of, or over, a deleted span.
   *
   * timeupdate only fires about four times a second, so checking there alone
   * played roughly a quarter-second of deleted audio before the skip. Arm a
   * timer for the exact moment the next cut starts instead; the timeupdate
   * check below stays as a safety net (a stalled or re-buffered element can
   * drift past the scheduled instant).
   */
  const skipTimerRef = useRef(0);
  function armCutSkip() {
    window.clearTimeout(skipTimerRef.current);
    const el = mediaRef.current;
    if (!el || el.paused || cuts.length === 0) return;
    const cs = el.currentTime * 100;
    const inside = cuts.find((c) => cs >= c.t0 && cs < c.t1);
    if (inside) {
      el.currentTime = inside.t1 / 100 + 0.01; // the seek re-arms us
      return;
    }
    let next: { t0: number; t1: number } | null = null;
    for (const c of cuts) {
      if (c.t0 > cs && (!next || c.t0 < next.t0)) next = c;
    }
    if (!next) return;
    const jumpTo = next.t1 / 100 + 0.01;
    const ms = (((next.t0 - cs) / 100) * 1000) / (el.playbackRate || 1);
    skipTimerRef.current = window.setTimeout(
      () => {
        const e = mediaRef.current;
        if (e) e.currentTime = jumpTo;
      },
      Math.max(0, ms),
    );
  }
  useEffect(() => () => window.clearTimeout(skipTimerRef.current), []);
  // A deleted span added or removed while the file is open re-arms the timer.
  useEffect(armCutSkip, [cuts]);

  function onTime() {
    const el = mediaRef.current;
    if (!el) return;
    const cs = el.currentTime * 100;
    for (const c of cuts) {
      if (cs >= c.t0 && cs < c.t1) {
        el.currentTime = c.t1 / 100 + 0.01;
        return;
      }
    }
    let current: string | null = null;
    for (const seg of segments) {
      if (seg.t0 <= cs) current = seg.id;
      else break;
    }
    if (current !== activeSeg) setActiveSeg(current);
  }

  function seek(cs: number) {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = cs / 100;
    void el.play().catch(() => {});
  }

  // ---- transcript selection → delete -------------------------------------
  /**
   * Watch the SELECTION, not the mouse. Hanging the delete bar off mouseup
   * meant a selection made with the keyboard (or Select All, or a screen
   * reader) never woke it up, so a keyboard-only user could read a transcript
   * but never edit the recording through it. Coalesced to one check per frame:
   * selectionchange fires continuously during a drag.
   */
  useEffect(() => {
    let raf = 0;
    const onSel = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        captureSelection();
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      if (raf) cancelAnimationFrame(raf);
    };
    // captureSelection reads only refs and setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function captureSelection() {
    // While the correction box is open the transcript selection is FROZEN.
    // Focusing a text input clears the document selection (the box autofocuses,
    // and clicking into it does the same), so re-reading it here would report
    // "nothing selected", unmount the whole selection bar, and take the words
    // being corrected — and whatever had been typed — with it. The feature was
    // unusable the moment the caret entered the box.
    if (correctingRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !listRef.current) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    let t0 = Infinity;
    let t1 = -Infinity;
    let words = 0;
    listRef.current.querySelectorAll<HTMLElement>("[data-t0]").forEach((sp) => {
      if (range.intersectsNode(sp)) {
        t0 = Math.min(t0, Number(sp.dataset.t0));
        t1 = Math.max(t1, Number(sp.dataset.t1));
        words++;
      }
    });
    setSelection(words > 0 ? { t0, t1, words } : null);
  }

  /** The other half of editing a transcript: RETYPE a span.
   *
   * Deleting was the only edit there was, so a misheard name left you choosing
   * between a wrong transcript and a missing sentence — and this text is what
   * search, the AI and every export read. Correcting is not deleting: no cut is
   * added and the audio is untouched, which is why it is a separate button
   * beside the red one rather than a mode of it. */
  async function correctSelection() {
    if (!selection || !correction.trim()) return;
    try {
      const updated = await api.recCorrectRange(
        fileId,
        selection.t0,
        selection.t1,
        correction.trim(),
      );
      setMeta(updated);
      setSelection(null);
      setCorrection("");
      setCorrecting(false);
      window.getSelection()?.removeAllRanges();
      pushToast("success", "Transcript corrected — the audio is unchanged.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function deleteSelection() {
    if (!selection) return;
    try {
      const updated = await api.recDeleteRange(fileId, selection.t0, selection.t1);
      setMeta(updated);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      pushToast(
        "success",
        `Removed ${selection.words} word${selection.words > 1 ? "s" : ""} — playback now skips it. "Export edited copy" makes it permanent.`,
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** GH #5: what to CALL a speaker — the user's name if they gave one, else the
   * engine's label. Every rendering of a speaker goes through this. */
  function speakerName(label: string): string {
    return meta?.speakerNames?.[label] || label;
  }

  async function renameSpeaker(label: string, next: string) {
    const name = next.trim();
    if (name === speakerName(label)) return; // unchanged (or Escape)
    // Clicking an UNNAMED chip opens the editor with an empty draft, so a click
    // followed by a click elsewhere commits "" — which is not a no-op by the
    // check above (speakerName() returns the label, not ""). Treat "clear a
    // name that was never set" as the nothing-happened it is, instead of a
    // pointless write and a "Back to Speaker 2" toast for an edit nobody made.
    if (!name && !meta?.speakerNames?.[label]) return;
    try {
      const updated = await api.recSetSpeakerName(fileId, label, name);
      // Merge ONLY the names: a live recording is still appending segments via
      // events, and the backend's copy of `segments` can lag behind ours.
      setMeta((m) => (m ? { ...m, speakerNames: updated.speakerNames } : updated));
      pushToast(
        "success",
        name
          ? `Every line ${label} said is now "${name}".`
          : `Back to "${label}".`,
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function runTranslate() {
    if (!translateTo.trim() || busy) return;
    setBusy(true);
    setTranslating({ done: 0, total: 1 });
    try {
      const f = await api.recTranslate(fileId, translateTo.trim());
      pushToast("success", `Translated into ${translateTo.trim()} — saved "${f.name}".`);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
      setTranslating(null);
    }
  }

  /** The phrases that survive the transcript edits, in order — the shared
   * source for both exports below. Deleted words never leave the app.
   *
   * `shifted` re-times them onto the SHORTENED timeline of the edited copy.
   * Subtitles need that: they caption only the surviving words, so the only
   * audio they line up with is the one with the cut spans actually removed —
   * against the original file every cue after the first cut runs late. */
  function keptPhrases(
    shifted = false,
  ): { t0: number; t1: number; speaker: string; text: string }[] {
    const out: { t0: number; t1: number; speaker: string; text: string }[] = [];
    const at = (t: number) => (shifted ? t - cutShiftBefore(cuts, t) : t);
    for (const seg of segments) {
      const kept = seg.words.length ? seg.words.filter((w) => !w.del) : null;
      const text = kept ? kept.map((w) => w.w).join(" ") : seg.text;
      if (!text.trim()) continue;
      out.push({
        t0: at(kept?.length ? kept[0].t0 : seg.t0),
        t1: at(kept?.length ? kept[kept.length - 1].t1 : seg.t1),
        speaker: speakerName(seg.speaker),
        text: text.trim(),
      });
    }
    return out;
  }

  /** Centiseconds → "hh:mm:ss,mmm" (SubRip). */
  function srtStamp(cs: number): string {
    const ms = Math.max(0, Math.round(cs * 10));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
  }

  /** Save the transcript into the room as its own file — pressing a button,
   * not typing a chat command. `.txt` reads as a plain transcript; `.srt` is
   * the subtitle file players and video editors take. */
  async function exportTranscript(kind: "text" | "srt") {
    if (busy) return;
    // Subtitles belong to the edited copy (see keptPhrases); the plain
    // transcript keeps the original file's timeline, which is also the one the
    // player above scrubs on.
    const phrases = keptPhrases(kind === "srt" && cuts.length > 0);
    if (phrases.length === 0) {
      pushToast("info", "There is nothing transcribed to export yet.");
      return;
    }
    const body =
      kind === "srt"
        ? phrases
            .map(
              (p, i) =>
                `${i + 1}\n${srtStamp(p.t0)} --> ${srtStamp(
                  Math.max(p.t1, p.t0 + 50),
                )}\n${p.speaker}: ${p.text}\n`,
            )
            .join("\n")
        : phrases
            .map((p) => `[${formatTimestamp(p.t0)}] ${p.speaker}: ${p.text}`)
            .join("\n");
    const stamp = new Date().toISOString().slice(0, 10);
    setBusy(true);
    try {
      const f = await api.saveGeneratedFile(
        `Transcript ${stamp}.${kind === "srt" ? "srt" : "txt"}`,
        body,
      );
      pushToast(
        "success",
        kind === "srt" && cuts.length > 0
          ? `Saved "${f.name}" into this room — timed for the edited copy, not the original.`
          : `Saved "${f.name}" into this room.`,
      );
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportClean() {
    if (busy || exporting) return;
    setBusy(true);
    setExporting(true);
    // Said up front, because the work that follows can run for minutes on a
    // long recording and the only other sign of it is a disabled button.
    pushToast("info", "Cutting the audio and saving the edited copy — this can take a while.");
    try {
      const f = await api.recExportClean(fileId);
      pushToast("success", `Saved "${f.name}" with your edits applied to the audio.`);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setExporting(false);
      setBusy(false);
    }
  }

  function toggleMicMute() {
    const next = !micIsMuted;
    setMicMuted(next);
    setMicIsMuted(next);
  }

  async function toggleLiveStt(on: boolean) {
    setLiveStt(on);
    noteLiveStt(on);
    // The engine clears its ghost lines itself; drop ours right away too.
    if (!on) setPartials({});
    try {
      await api.recSetLiveStt(on);
    } catch (e) {
      // Nothing changed in the engine — the control must not lie.
      setLiveStt(!on);
      noteLiveStt(!on);
      pushToast("error", String(e));
    }
  }

  async function runRetranscribe() {
    if (busy) return;
    setConfirmRetrans(false);
    setBusy(true);
    setRetrans({ doneCs: 0, totalCs: Math.max(1, durationCs) });
    try {
      const updated = await api.recRetranscribe(fileId);
      setMeta(updated);
      setDurationCs(updated.durationCs);
      setLiveTranslations({});
      pushToast("success", "Transcript rebuilt from the audio — the old one is in this file's History.");
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
      setRetrans(null);
    }
  }

  /** The live-translate language actually in force, so typing in the box
   * doesn't clear the translations already on screen on every keystroke. */
  const appliedLiveLangRef = useRef("");
  async function commitLiveLang() {
    const lang = liveLang.trim();
    if (lang === appliedLiveLangRef.current) return;
    appliedLiveLangRef.current = lang;
    setLiveTranslations({});
    if (isLive) {
      try {
        await api.recSetLiveTranslate(lang || null);
      } catch (e) {
        pushToast("error", String(e));
      }
    }
  }

  // ---- render -------------------------------------------------------------
  // Stop first, then edit: the backend refuses rec_delete_range while the
  // file has a live session — even paused, the engine's in-memory meta would
  // overwrite the edit on its next flush.
  const canEdit = !isLive;
  const hasWords = segments.some((s) => s.words.length > 0);
  // Audio already in the file — a recording with sound but no transcript lines
  // (live transcription off, or a silent stretch) is still CONTINUED, never
  // started over, and the button must not suggest otherwise. Length is the only
  // honest signal: the backend hands this viewer a media token for EVERY
  // recording file, including one whose stored audio is a bare WAV header, so
  // OR-ing it in made "Start recording" unreachable and left the button
  // contradicting the empty-state panel right below it.
  const hasAudio = durationCs > 0;
  // mediaToken too: a corrupted (unparseable) meta reads as durationCs 0,
  // and re-transcribe is the rescue tool for exactly that file.
  const canRetranscribe = !isLive && (durationCs > 0 || !!mediaToken);

  // One "still speaking…" ghost per lane. A ghost whose speaker matches the
  // last turn renders inside it (the same voice, mid-sentence); the rest —
  // including everything when there are no finals yet — stand alone.
  // `speaker` is the machine LABEL, exactly as on a finished turn, so the ghost
  // is drawn through speakerName() too — otherwise renaming "You" left the
  // line being spoken right now under the old name, the same person appearing
  // twice in one transcript.
  const ghosts = (["mic", "sys"] as const).flatMap((lane) => {
    const text = partials[lane];
    return text ? [{ lane, speaker: lane === "mic" ? "You" : "Meeting", text }] : [];
  });
  const lastTurn = turns[turns.length - 1];
  const attachedGhosts = lastTurn ? ghosts.filter((g) => g.speaker === lastTurn.speaker) : [];
  const standaloneGhosts = ghosts.filter((g) => !attachedGhosts.includes(g));

  return (
    <div className="rec-view">
      {/* Shared suggestions for BOTH language boxes (live and after the fact);
          neither is limited to this list. */}
      <datalist id="rec-langs">
        {LANGS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {/* header: controls + meters */}
      <div className="rec-head">
        {status === "idle" && (
          <>
            <button
              className="primary rec-btn"
              onClick={() => void start()}
              title={
                segments.length || hasAudio
                  ? "Keep recording into this file — nothing already recorded is lost"
                  : undefined
              }
            >
              <span className="rec-dot" />{" "}
              {segments.length || hasAudio ? "Continue recording" : "Start recording"}
            </button>
            <label className="rec-opt" title="Hear whatever the Mac plays — Google Meet, Zoom, Teams, Slack calls, videos">
              <input
                type="checkbox"
                checked={withSystem}
                onChange={(e) => setWithSystem(e.target.checked)}
              />
              Include the Mac’s audio (meetings)
            </label>
            <span
              className="rec-opt"
              title="Voices are told apart as people talk, and the labels correct themselves as the meeting goes on — nothing to set up. Afterwards, click a speaker's name to say who they were."
            >
              Speakers detected automatically — name them later
            </span>
          </>
        )}
        {status === "recording" && (
          <>
            <button className="subtle rec-btn" onClick={() => void onPause()}><PauseIcon size={13} /> Pause</button>
            <button className="primary rec-btn" onClick={() => void onStop()}><StopIcon size={13} /> Stop &amp; save</button>
            <span className="rec-live-chip">
              <span className="rec-dot pulsing" /> REC {formatTimestamp(durationCs)}
            </span>
            <button
              className={`rec-mute ${micIsMuted ? "muted" : ""}`}
              // Only promise the Mac's audio when it is actually being
              // captured: with the checkbox off (or the lane failed), muting
              // the mic means NOTHING is being recorded, and saying otherwise
              // hands the user an empty recording and a reassurance.
              title={
                micIsMuted
                  ? "Unmute the microphone"
                  : withSystem && !sysNote
                    ? "Mute the microphone (the Mac's audio keeps recording)"
                    : "Mute the microphone — the Mac's audio is not being recorded, so nothing at all will be captured while muted"
              }
              aria-label={
                micIsMuted ? "Unmute the microphone" : "Mute the microphone"
              }
              aria-pressed={micIsMuted}
              onClick={toggleMicMute}
            >
              <span aria-hidden="true">🎙</span>
            </button>
            <span className="rec-meters" title="Microphone / Mac audio levels">
              <span
                className="rec-meter"
                title="Your microphone — your own voice"
              >
                <i>Mic</i>
                <b style={{ width: `${micIsMuted ? 0 : Math.min(100, levels.mic * 400)}%` }} />
              </span>
              <span
                className="rec-meter"
                title="The Mac's own audio — the meeting or video playing on this computer"
              >
                <i>Mac</i>
                <b style={{ width: `${Math.min(100, levels.sys * 400)}%` }} />
              </span>
            </span>
          </>
        )}
        {status === "paused" && (
          <>
            <button className="primary rec-btn" onClick={() => void onResume()}><PlayIcon size={13} /> Resume</button>
            <button className="subtle rec-btn" onClick={() => void onStop()}><StopIcon size={13} /> Stop &amp; save</button>
            <span className="rec-live-chip paused">Paused at {formatTimestamp(durationCs)}</span>
          </>
        )}
        {status === "saving" && (
          // The scariest moment of the flow, named precisely: the audio is
          // already safe (the engine checkpoints it before the first save
          // event), the wait is only the transcript tail — and the user is
          // free to leave; the sidebar card keeps showing progress.
          <span className="rec-live-chip saving">
            {saveProgress?.stage === "writing"
              ? "Audio saved — writing the recording into the room…"
              : saveProgress
                ? `Audio saved — finishing the transcript${
                    saveProgress.remaining > 0
                      ? ` (${saveProgress.remaining} to go)`
                      : "…"
                  }`
                : "Saving…"}
            <span className="rec-save-note">
              You can keep working — this finishes on its own.
            </span>
          </span>
        )}

        <span className="rec-head-right">
          {isLive && (
            <label
              className="rec-opt"
              title="Turn off to keep recording audio without writing live text — rebuild the missing part later with Re-transcribe"
            >
              <input
                type="checkbox"
                checked={liveStt}
                onChange={(e) => void toggleLiveStt(e.target.checked)}
              />
              Live transcription
            </label>
          )}
          <label
            className="rec-opt"
            // Live translation runs on the ROOM's chosen model, exactly like
            // the Translate box below (recording.rs `room_translation_model`).
            // This used to say "(on this Mac)", which is the opposite of what
            // happens in a cloud room: there, every finished sentence of a live
            // meeting is sent to the provider for as long as the box is set.
            // The status bar's trust chip says which kind of room this is; the
            // control must not contradict it.
            title="Translate each phrase as it lands — any language, on the room's AI model, the same as the Translate box below. In a cloud room that means each sentence is sent to the provider as it lands."
          >
            Live translate
            <input
              list="rec-langs"
              placeholder="off"
              value={liveLang}
              onChange={(e) => setLiveLang(e.target.value)}
              onBlur={() => void commitLiveLang()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitLiveLang();
                }
              }}
            />
          </label>
        </span>
      </div>

      {/* The Mac-audio lane died (in practice: the Screen & System Audio
          Recording permission) — say so where it can't be missed, with the fix
          one click away. Clears itself if a later rec-source says "on". */}
      {sysNote && isLive && (
        <div className="rec-sys-banner" role="alert">
          <span className="rec-sys-banner-text">{sysNote}</span>
          <button
            onClick={() =>
              void openUrl(SCREEN_CAPTURE_SETTINGS_URL).catch((e) =>
                pushToast("error", String(e)),
              )
            }
          >
            Open System Settings
          </button>
          <span className="rec-sys-banner-note">
            After granting, quit and reopen Arcelle — macOS applies the
            permission only to a fresh launch.
          </span>
        </div>
      )}
      {micNote && isLive && (
        <div className="rec-sys-banner" role="alert">
          <span className="rec-sys-banner-text">{micNote}</span>
        </div>
      )}

      {/* player (idle/paused, once there is audio) */}
      {src && durationCs > 0 && (
        <audio
          ref={(el) => {
            mediaRef.current = el;
            setMediaEl(el);
          }}
          className="rec-player"
          src={src}
          controls
          onTimeUpdate={() => {
            onTime();
            armCutSkip();
          }}
          onPlay={armCutSkip}
          onSeeked={armCutSkip}
          onRateChange={armCutSkip}
          onPause={() => window.clearTimeout(skipTimerRef.current)}
        />
      )}

      {/* The conversation's shape, with each speaker's turns drawn over the
          wave. Diarization has run on this file since v0.14.0 and none of it
          was visible above the transcript — a bare <audio controls> was the
          whole picture. Live recording has no waveform: there is no finished
          file to compute an envelope from yet. */}
      {src && durationCs > 0 && (
        <Waveform fileId={fileId} media={mediaEl} regions={speakerRegions} />
      )}

      {/* transcript */}
      <div
        className="rec-transcript"
        ref={listRef}
        tabIndex={0}
        aria-label="Transcript — select words here to correct them, or to delete them from the recording"
        onMouseUp={captureSelection}
      >
        {segments.length === 0 && !partials.mic && !partials.sys && (
          <div className="empty-hint rec-empty">
            {status === "idle" ? (
              <>
                <p><strong>This file records and understands speech — live.</strong></p>
                <p>
                  Press <em>{hasAudio ? "Continue recording" : "Start recording"}</em>: your
                  words (and, if you leave the checkbox on,
                  whatever the Mac plays — a Google Meet, Zoom, Teams or Slack call) appear here
                  as text while people are still speaking, with speakers told apart.
                </p>
                <p>
                  Afterwards, edit the audio by editing the text (select words → delete), run any
                  AI action on it, or translate the whole thing. Speech is recognised on this Mac;
                  AI actions and translation use the room's model — the trust chip in the status
                  bar says whether that one is local or in the cloud.
                </p>
              </>
            ) : (
              <p>Listening… speak, or bring the meeting on.</p>
            )}
          </div>
        )}
        {turns.map((turn, ti) => {
          const hue = speakerHue(turn.speaker);
          // The still-speaking (partial) line joins the last turn when it is
          // the same voice continuing; otherwise it gets its own ghost turn.
          const inlineGhosts = ti === turns.length - 1 ? attachedGhosts : [];
          return (
            <div
              key={turn.key}
              className={`rec-turn ${turn.segs.some(({ seg }) => seg.id === activeSeg) ? "active" : ""}`}
            >
              <div className="rec-turn-head">
                <button
                  className="rec-stamp"
                  title="Jump to this moment"
                  onClick={() => seek(turn.t0)}
                >
                  {formatTimestamp(turn.t0)}
                </button>
                <SpeakerChip
                  label={turn.speaker}
                  name={speakerName(turn.speaker)}
                  hue={hue}
                  onRename={(next) => void renameSpeaker(turn.speaker, next)}
                />
              </div>
              <div className="rec-turn-body" dir={turn.dir}>
                {turn.segs.map(({ seg, visible }) => {
                  const translation = liveTranslations[seg.id];
                  return (
                    <Fragment key={seg.id}>
                      <span
                        className={`rec-seg ${activeSeg === seg.id ? "active" : ""}`}
                        dir="auto"
                      >
                        {visible
                          ? visible.map((w, i) => (
                              <span
                                key={i}
                                data-t0={w.t0}
                                data-t1={w.t1}
                                className={w.del ? "rec-word deleted" : "rec-word"}
                                onClick={() => {
                                  // A drag is a delete-selection, not a seek.
                                  if (window.getSelection()?.isCollapsed) seek(w.t0);
                                }}
                              >
                                {w.w}{" "}
                              </span>
                            ))
                          : seg.text}
                        {translation && <span className="rec-translation" dir="auto">{translation}</span>}
                      </span>{" "}
                    </Fragment>
                  );
                })}
                {inlineGhosts.map((g) => (
                  <span key={g.lane} className="rec-seg ghost" dir="auto">{g.text}</span>
                ))}
              </div>
            </div>
          );
        })}
        {standaloneGhosts.map((g) => (
          <div key={g.lane} className="rec-turn ghost">
            <div className="rec-turn-head">
              <span className="rec-stamp">…</span>
              <span className="rec-speaker">{speakerName(g.speaker)}</span>
            </div>
            <div className="rec-turn-body" dir="auto">
              <span className="rec-seg ghost" dir="auto">{g.text}</span>
            </div>
          </div>
        ))}
        <div ref={listEndRef} />
      </div>

      {/* selection action bar */}
      {selection && canEdit && (
        <div className="rec-selectbar">
          <span>
            {selection.words} word{selection.words > 1 ? "s" : ""} · {formatTimestamp(selection.t0)}–{formatTimestamp(selection.t1)}
          </span>
          {correcting ? (
            <>
              <input
                autoFocus
                className="rec-correct-input"
                placeholder="What was actually said…"
                aria-label="Corrected words"
                value={correction}
                onChange={(e) => setCorrection(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void correctSelection();
                  if (e.key === "Escape") {
                    setCorrecting(false);
                    setCorrection("");
                  }
                }}
              />
              <button
                className="subtle"
                disabled={!correction.trim()}
                onClick={() => void correctSelection()}
              >
                Save correction
              </button>
              <button
                className="subtle"
                onClick={() => {
                  setCorrecting(false);
                  setCorrection("");
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {/* Correcting is NOT deleting: no cut, no audio change. It sits
                  beside the red button because "the transcript is wrong" and
                  "cut this out of the recording" are different intentions. */}
              <button
                className="subtle"
                title="Retype what this actually says. The audio is untouched."
                onClick={() => {
                  setCorrection("");
                  setCorrecting(true);
                }}
              >
                Fix the words
              </button>
              <button className="danger" onClick={() => void deleteSelection()}>
                Delete from recording
              </button>
              <button className="subtle" onClick={() => setSelection(null)}>Keep</button>
            </>
          )}
        </div>
      )}

      {/* footer toolbar */}
      {(segments.length > 0 || canRetranscribe) && (
        <div className="rec-tools">
          {segments.length > 0 && (
            <span className="rec-tool">
              <input
                list="rec-langs"
                placeholder="Translate into…"
                value={translateTo}
                disabled={busy}
                onChange={(e) => setTranslateTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runTranslate();
                }}
              />
              <button className="subtle" disabled={busy || !translateTo.trim()} onClick={() => void runTranslate()}>
                {translating ? `Translating ${translating.done}/${translating.total}…` : "Translate"}
              </button>
            </span>
          )}
          {canRetranscribe &&
            (confirmRetrans ? (
              <span className="rec-tool rec-retrans-confirm">
                <span>
                  Rebuild the whole transcript from the audio? The current one moves to History;
                  the audio is untouched.
                  {Object.keys(meta?.speakerNames ?? {}).length > 0 && (
                    <>
                      {" "}
                      <b>
                        The voices are re-numbered from scratch, so check the names you
                        gave them afterwards.
                      </b>
                    </>
                  )}
                </span>
                <button className="danger" onClick={() => void runRetranscribe()}>
                  Re-transcribe
                </button>
                <button className="subtle" onClick={() => setConfirmRetrans(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="subtle"
                disabled={busy}
                title="Rebuild the transcript from the audio with the current pipeline — fixes recordings saved with garbled words, the wrong language, or old speaker labels"
                onClick={() => setConfirmRetrans(true)}
              >
                {retrans
                  ? `Re-transcribing ${Math.min(100, Math.round((retrans.doneCs / Math.max(1, retrans.totalCs)) * 100))}%…`
                  : "Re-transcribe"}
              </button>
            ))}
          {segments.length > 0 && !isLive && (
            <>
              <button
                className="subtle"
                disabled={busy}
                title="Save the transcript into this room as a plain text file — timestamps are this recording's own"
                onClick={() => void exportTranscript("text")}
              >
                Export transcript
              </button>
              <button
                className="subtle"
                disabled={busy}
                title={
                  cuts.length > 0
                    ? "Save subtitles (.srt) into this room — timed for the edited copy, since they caption only the words you kept"
                    : "Save subtitles (.srt) into this room — for a video editor or a player"
                }
                onClick={() => void exportTranscript("srt")}
              >
                Export subtitles
              </button>
            </>
          )}
          {hasWords && (
            <>
              <button
                className="subtle"
                disabled={busy || (!cuts.length && !segments.some((s) => s.words.some((w) => w.del)))}
                title="Save a copy with the deleted words really cut out of the audio"
                onClick={() => void exportClean()}
              >
                {exporting ? "Exporting edited copy…" : "Export edited copy"}
              </button>
              <label className="rec-opt">
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => setShowDeleted(e.target.checked)}
                />
                Show deleted
              </label>
            </>
          )}
          {!isLive && (
            <span className="rec-hint-inline">
              Select words in the transcript to delete them from the recording.
            </span>
          )}
        </div>
      )}
    </div>
  );

  async function start() {
    // Session controls reset with the session: live transcription is ON at
    // every rec_start (the actions layer syncs the module mirror).
    setLiveStt(true);
    setMicIsMuted(false);
    const lang = liveLang.trim();
    appliedLiveLangRef.current = lang;
    await onStart(fileId, { systemAudio: withSystem, liveTranslate: lang || null });
  }
}
