import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, RecMeta, RecSegment, RecWord } from "../api";
import { PlayIcon, PauseIcon, StopIcon } from "../icons";
import { liveSttOn, micMuted, noteLiveStt, setMicMuted } from "../workspace/liveRec";
import type { UnlistenFn } from "@tauri-apps/api/event";

const SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * ADD-27: the Recording file — record live (mic + the Mac's own audio, so a
 * Google Meet/Zoom/Teams call is heard), watch the transcript appear WHILE
 * people speak, with speakers told apart; then edit the recording by editing
 * its text (select words → delete: playback skips them, "Export edited copy"
 * cuts the audio for real) and translate the whole thing into any language.
 * All transcription and translation happen on this Mac.
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
  const [translating, setTranslating] = useState<{ done: number; total: number } | null>(null);
  const [retrans, setRetrans] = useState<{ doneCs: number; totalCs: number } | null>(null);
  const [confirmRetrans, setConfirmRetrans] = useState(false);
  const [busy, setBusy] = useState(false);
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

  // ---- playback (skips deleted spans) ------------------------------------
  const src = mediaToken && !isLive ? `roommedia://localhost/${mediaToken}` : null;

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
  function captureSelection() {
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

  async function exportClean() {
    if (busy) return;
    setBusy(true);
    try {
      const f = await api.recExportClean(fileId);
      pushToast("success", `Saved "${f.name}" with your edits applied to the audio.`);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
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

  async function toggleLiveLang(lang: string) {
    setLiveLang(lang);
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
  // mediaToken too: a corrupted (unparseable) meta reads as durationCs 0,
  // and re-transcribe is the rescue tool for exactly that file.
  const canRetranscribe = !isLive && (durationCs > 0 || !!mediaToken);

  // One "still speaking…" ghost per lane. A ghost whose speaker matches the
  // last turn renders inside it (the same voice, mid-sentence); the rest —
  // including everything when there are no finals yet — stand alone.
  const ghosts = (["mic", "sys"] as const).flatMap((lane) => {
    const text = partials[lane];
    return text ? [{ lane, speaker: lane === "mic" ? "You" : "Meeting", text }] : [];
  });
  const lastTurn = turns[turns.length - 1];
  const attachedGhosts = lastTurn ? ghosts.filter((g) => g.speaker === lastTurn.speaker) : [];
  const standaloneGhosts = ghosts.filter((g) => !attachedGhosts.includes(g));

  return (
    <div className="rec-view">
      {/* header: controls + meters */}
      <div className="rec-head">
        {status === "idle" && (
          <>
            <button className="primary rec-btn" onClick={() => void start()}>
              <span className="rec-dot" /> {segments.length ? "Continue recording" : "Start recording"}
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
              title="Voices are told apart as people talk, and the labels correct themselves as the meeting goes on — nothing to set up"
            >
              Speakers detected automatically
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
              title={
                micIsMuted
                  ? "Unmute the microphone"
                  : "Mute the microphone (the Mac's audio keeps recording)"
              }
              onClick={toggleMicMute}
            >
              🎙
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
          <label className="rec-opt" title="Translate each phrase as it lands (on this Mac)">
            Live translate
            <select value={liveLang} onChange={(e) => void toggleLiveLang(e.target.value)}>
              <option value="">off</option>
              {LANGS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
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
          }}
          className="rec-player"
          src={src}
          controls
          onTimeUpdate={onTime}
        />
      )}

      {/* transcript */}
      <div className="rec-transcript" ref={listRef} onMouseUp={captureSelection}>
        {segments.length === 0 && !partials.mic && !partials.sys && (
          <div className="empty-hint rec-empty">
            {status === "idle" ? (
              <>
                <p><strong>This file records and understands speech — live.</strong></p>
                <p>
                  Press <em>Start recording</em>: your words (and, if you leave the checkbox on,
                  whatever the Mac plays — a Google Meet, Zoom, Teams or Slack call) appear here
                  as text while people are still speaking, with speakers told apart.
                </p>
                <p>
                  Afterwards, edit the audio by editing the text (select words → delete), run any
                  AI action on it, or translate the whole thing — everything stays on this Mac.
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
                <span
                  className="rec-speaker"
                  style={hue == null ? undefined : { background: `hsl(${hue} 60% 45% / .18)`, color: `hsl(${hue} 70% 35%)` }}
                >
                  {turn.speaker}
                </span>
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
              <span className="rec-speaker">{g.speaker}</span>
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
          <button className="danger" onClick={() => void deleteSelection()}>
            Delete from recording
          </button>
          <button className="subtle" onClick={() => setSelection(null)}>Keep</button>
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
              <datalist id="rec-langs">
                {LANGS.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
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
          {hasWords && (
            <>
              <button
                className="subtle"
                disabled={busy || (!cuts.length && !segments.some((s) => s.words.some((w) => w.del)))}
                title="Save a copy with the deleted words really cut out of the audio"
                onClick={() => void exportClean()}
              >
                Export edited copy
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
    await onStart(fileId, { systemAudio: withSystem, liveTranslate: liveLang || null });
  }
}
