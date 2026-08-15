import { Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Waveform, {
  SPEAKER_TONES,
  SpeakerRegion,
  WAVE_HEIGHT_LARGE,
} from "./Waveform";
import { api, By, NoteKind, RecMeta, RecSegment, RecWord } from "../api";
import { PauseIcon, PlayIcon, StopIcon } from "../icons";
import { liveSttOn, micMuted, noteLiveStt, setMicMuted } from "../workspace/liveRec";
import { cutShiftBefore } from "./recTiming";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** How far back "Mark this moment" reaches while recording. You press it AFTER
 * hearing the thing worth keeping, so a mark that started at the press would
 * begin just past the sentence it is about. Six seconds is about one spoken
 * sentence. */
const LOOK_BACK_CS = 600;

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
 *
 * ----- how the page is laid out -----
 *
 * The audio is the subject, so the page opens with it: one transport cluster,
 * then the wave at full size with its tick scale and a lane per voice. Reading
 * comes below that, split into tabs, with the clips beside it — and everything
 * technical (translate, re-transcribe, the three exports) lives in a closed
 * drawer at the foot, because those are things you do to a recording ONCE and
 * the toolbar they used to share was seven controls wide over every reading.
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

/** The reading tabs. Transcript is the only one this app has data for today;
 * the other three say so in their own words rather than being hidden, because
 * "where would my notes go" is a question the page should answer.
 *
 * `empty` is what keeps that from being a lie told by the tab ROW. A
 * role="tablist" is a promise of four panels of content, and three of these
 * can never hold any — there is no per-recording note, highlight or chapter
 * table in the schema and no command that could write one. So the tab itself
 * carries the state, visibly (a dashed edge) and in its accessible name, and
 * the reader learns it before spending a click rather than after. Delete the
 * flag, not the tab, on the day the data exists. */
const TABS = [
  { id: "transcript", label: "Transcript" },
  { id: "notes", label: "Notes" },
  { id: "highlights", label: "Highlights" },
  { id: "chapters", label: "Chapters" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * Stable marker class per speaker.
 *
 * Keyed on the machine LABEL, never on the name, so renaming "Speaker 2" to
 * "Dana" cannot change her colour — and so the chip in the transcript, the row
 * in the clips panel and the lane under the wave are guaranteed to agree,
 * because all three ask this one function.
 *
 * "You" gets the pen (the app-wide accent) because it is not one voice among
 * several, it is the person reading the page. The rest walk the four-hue
 * speaker palette, which deliberately excludes red — red means recording or
 * urgent everywhere in this product and a voice is neither.
 */
function speakerTone(label: string): string {
  if (label === "You") return "rec-tone-self";
  const n = parseInt(label.replace(/\D/g, ""), 10) || 1;
  return SPEAKER_TONES[(n - 1) % SPEAKER_TONES.length];
}

/** GH #5: the speaker chip, renameable once you know who was talking.
 *
 * The machine label ("Speaker 2") stays the identity underneath — the name is
 * an overlay keyed by it — so one edit renames every line that person said, and
 * the name survives the engine re-clustering the meeting. Colour is keyed on
 * the LABEL, not the name, so renaming doesn't change anyone's chip colour.
 *
 * `guessed` marks a name the app RECOGNISED from a voice this room has been
 * told before, rather than one the user typed. It is drawn differently and
 * says so on hover, because the two are different claims: the app's is a
 * guess that a click can correct, and correcting it also teaches the room. A
 * guess that looked identical to an asserted name would be this feature's
 * worst failure — the wrong person's name, quietly wearing the user's
 * authority. */
function SpeakerChip({
  label,
  name,
  tone,
  guessed,
  onRename,
}: {
  label: string;
  name: string;
  tone: string;
  guessed: boolean;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

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
      className={`rec-speaker rec-speaker-btn ${tone}${guessed ? " rec-speaker-guessed" : ""}`}
      // The name can be in any script and the chip truncates at 22ch, so it
      // has to ellipse from the correct end — the same reason the edit input
      // beside it carries dir="auto".
      dir="auto"
      data-speaker={label}
      data-guessed={guessed || undefined}
      data-testid="speaker-chip"
      title={
        guessed
          ? `Recognised from a voice you named before — click if this isn't ${name}. The engine calls this voice ${label}.`
          : named
            ? `Rename — the engine calls this voice ${label}`
            : "Name this speaker — renames every line they said"
      }
      onClick={() => {
        setDraft(named ? name : "");
        setEditing(true);
      }}
    >
      {name}
      {/* Said in text, not colour alone: the whole point of the mark is that
          it survives a screenshot, a colourblind reader and a screen reader. */}
      {guessed && <span className="rec-speaker-guess-mark" aria-label=" (recognised)">?</span>}
    </button>
  );
}


const NOTE_LABEL: Record<NoteKind, string> = {
  decision: "Decided",
  action: "To do",
  question: "Open",
  point: "Point",
};
/** The order the Notes tab reads in: what was settled, what someone owes, what
 * is still open, then the running summary. Not chronological — the first three
 * are what a person opens a finished meeting to find. */
const NOTE_ORDER: NoteKind[] = ["decision", "action", "question", "point"];

/** One of the three panels the room fills in: Notes, Highlights or Chapters.
 *
 * Every item says who put it there. An item the ROOM found is drawn with a
 * dashed edge and carries "?" — the same mark a recognised speaker name gets —
 * because the room reads every recording by itself and is sometimes wrong, and
 * an invented action item with a real colleague's name on it must never look
 * like something the user wrote. Editing an item makes it theirs and the room
 * stops touching it.
 *
 * The empty state is a BUTTON, not an apology: a tab is empty when the room
 * has not read this recording yet (no model installed at the time, the app was
 * busy, an old recording the sweep has not reached), and the answer to all of
 * those is to read it now. */
function ReadPanel({
  kind,
  meta,
  reading,
  onRead,
  onSeek,
  onAddChapter,
  onDelete,
  empty,
  blank,
}: {
  kind: "notes" | "highlights" | "chapters";
  meta: RecMeta | null;
  reading: boolean;
  onRead: () => void;
  onSeek: (cs: number) => void;
  onAddChapter: (title: string) => void;
  onDelete: (kind: "note" | "chapter" | "highlight", id: string) => void;
  empty: string;
  blank: string;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const commitChapter = () => {
    const t = title.trim();
    setAdding(false);
    setTitle("");
    if (t) onAddChapter(t);
  };
  /** "Add chapter here" — at the playhead, so where it lands is what you are
   * already listening to. Only on Chapters: a note wants words about a moment
   * you have selected, and a mark wants a stretch. */
  const addChapter =
    kind === "chapters" &&
    (adding ? (
      <input
        autoFocus
        className="rec-correct-input"
        placeholder="Name this section…"
        aria-label="Chapter name"
        data-testid="chapter-input"
        maxLength={80}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitChapter}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitChapter();
          if (e.key === "Escape") {
            setTitle("");
            setAdding(false);
          }
        }}
      />
    ) : (
      <button
        className="nb-btn nb-btn-quiet"
        data-testid="add-chapter"
        title="Name a section starting where you are listening"
        onClick={() => {
          setTitle("");
          setAdding(true);
        }}
      >
        Add chapter here
      </button>
    ));
  const notes = meta?.notes ?? [];
  const highlights = meta?.highlights ?? [];
  const chapters = meta?.chapters ?? [];
  const count =
    kind === "notes" ? notes.length : kind === "highlights" ? highlights.length : chapters.length;
  const everRead = !!meta?.readOf;
  // The words moved under the reading — a re-transcribe, or corrections. The
  // findings are about a transcript that no longer exists, so say so rather
  // than let them read as current.
  const stale =
    everRead &&
    (meta!.readOf!.turns !== (meta?.segments.length ?? 0) ||
      meta!.readOf!.chars !== (meta?.segments ?? []).reduce((n, s) => n + s.text.length, 0));

  const readButton = (label: string, primary: boolean) => (
    <button
      className={primary ? "nb-btn" : "nb-btn nb-btn-quiet"}
      disabled={reading}
      data-testid="rec-read-btn"
      onClick={onRead}
      title="The room reads the transcript and writes what happened in it"
    >
      {reading ? "Reading…" : label}
    </button>
  );

  if (reading && count === 0) {
    return (
      <div className="rec-blank" data-testid="rec-read-busy">
        <h3 className="rec-blank-title">Reading this recording…</h3>
        <p className="rec-blank-aside nb-note">this can take a minute</p>
        <p className="rec-blank-body">{blank}</p>
      </div>
    );
  }

  if (count === 0) {
    return (
      <div className="rec-blank" data-testid="rec-read-empty">
        <h3 className="rec-blank-title">{everRead ? empty : "Not read yet"}</h3>
        <p className="rec-blank-aside nb-note">
          {everRead ? "the room read it and found none" : "nobody has read this one"}
        </p>
        <p className="rec-blank-body">{blank}</p>
        <div className="rec-read-actions">
          {readButton("Read this recording", true)}
          {addChapter}
        </div>
      </div>
    );
  }

  const row = (
    key: string,
    t0: number,
    by: By | undefined,
    lead: React.ReactNode,
    body: React.ReactNode,
  ) => {
    const guessed = (by ?? "room") === "room";
    return (
      <li
        key={key}
        className={`rec-found${guessed ? " is-guessed" : ""}`}
        data-by={by ?? "room"}
        data-testid="rec-found"
      >
        <button
          className="rec-found-at nb-num"
          onClick={() => onSeek(t0)}
          title="Jump to this moment"
        >
          {formatTimestamp(t0)}
        </button>
        <span className="rec-found-body">
          {lead}
          {body}
          {/* Said in text, not colour alone — it has to survive a screenshot,
              a colourblind reader and a screen reader. */}
          {guessed && (
            <span className="rec-found-mark" aria-label=" (the room wrote this)">
              ?
            </span>
          )}
        </span>
        <button
          className="rec-found-x"
          data-testid="rec-found-remove"
          title="Remove this"
          aria-label="Remove this"
          onClick={() =>
            onDelete(
              kind === "notes" ? "note" : kind === "chapters" ? "chapter" : "highlight",
              key,
            )
          }
        >
          ×
        </button>
      </li>
    );
  };

  return (
    <div className="rec-found-panel">
      <div className="rec-read-actions">
        {/* A consequence the reader has to act on, so never the hand. */}
        {stale && (
          <span className="rec-read-stale" data-testid="rec-read-stale">
            The transcript changed since this was read.
          </span>
        )}
        {addChapter}
        {readButton("Read again", false)}
      </div>
      <ul className="rec-found-list">
        {kind === "chapters" &&
          chapters.map((c) => row(c.id, c.t0, c.by, null, <b dir="auto">{c.title}</b>))}
        {kind === "highlights" &&
          highlights.map((h) =>
            row(
              h.id,
              h.t0,
              h.by,
              null,
              <span className="rec-found-span">
                {formatTimestamp(h.t0)}–{formatTimestamp(h.t1)}
              </span>,
            ),
          )}
        {kind === "notes" &&
          NOTE_ORDER.flatMap((k) =>
            notes
              .filter((n) => n.kind === k)
              .map((n) =>
                row(
                  n.id,
                  n.t0,
                  n.by,
                  <span className={`rec-found-kind kind-${k}`}>{NOTE_LABEL[k]}</span>,
                  <span dir="auto">
                    {n.text}
                    {n.who && <span className="rec-found-who"> — {n.who}</span>}
                  </span>,
                ),
              ),
          )}
      </ul>
    </div>
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
  /** The note box on the selection bar. */
  const [noting, setNoting] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  /** A reading pass is in flight for this recording. Set optimistically when
   * the button is pressed and cleared by `rec-read-done`, so the three tabs
   * agree with each other without polling the job list. */
  const [reading, setReading] = useState(false);
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
  // Which reading tab is showing, and the playback mirror the transport draws
  // from — the <audio> element is the truth, these follow its events.
  const [tab, setTab] = useState<TabId>("transcript");
  const [playing, setPlaying] = useState(false);
  const [playCs, setPlayCs] = useState(0);

  // The sys-lane failure toast fires once per outage, not on every event.
  const sysToastedRef = useRef(false);
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
                // The overlay travels with the labels: a voice the room
                // recognises mid-meeting gets its name here, and taking only
                // the labels would leave that name off screen until reload.
                speakerNames: p.speakerNames ?? m.speakerNames,
                recognized: p.recognized ?? m.recognized,
              }
            : m,
        );
      }),
      // The room finished reading — pull the meta so the three tabs fill in
      // without the user clicking anything. This is also how a reading the
      // room started BY ITSELF (on Stop, or the background sweep) reaches a
      // recording that is already open.
      api.onRecReadDone((p) => {
        if (p.fileId !== fileId) return;
        setReading(false);
        void api
          .recGet(fileId)
          .then((f) => setMeta(f.meta))
          .catch(() => {});
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
          // …and so must the colour, which is why the tone is computed from
          // the machine label here rather than left to the wave's own
          // first-heard ordering.
          tone: speakerTone(t.speaker),
        };
      }),
    [turns, meta?.speakerNames],
  );

  /** Every turn as a playable clip: who, when, how long, and what was said.
   *
   * Derived from the same turns the transcript draws, so a clip's length is
   * the real distance between the first and last word timing the engine
   * produced — nothing here is rounded up to look tidier. */
  const clips = useMemo(
    () =>
      turns.map((t) => {
        const last = t.segs[t.segs.length - 1].seg;
        return {
          key: t.key,
          speaker: t.speaker,
          t0: t.t0,
          t1: Math.max(last.t1 ?? t.t0, t.t0),
          dir: t.dir,
          text: t.segs
            .map(({ seg, visible }) =>
              visible ? visible.map((w) => w.w).join(" ") : seg.text,
            )
            .join(" ")
            .trim(),
        };
      }),
    [turns],
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
    // Stored at WHOLE SECONDS, which is all the readout shows. timeupdate
    // fires about four times a second, and keeping the raw value here would
    // re-render the entire transcript on every one of them for a digit that
    // did not change; at this resolution three of the four setStates are a
    // no-op and React drops them.
    setPlayCs(Math.floor(cs / 100) * 100);
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

  /** The transport's play/pause. The <audio> element stays the single truth —
   * this only asks it, and `playing` is set from the events it fires back, so
   * the button can never claim a state the element is not in. */
  function togglePlay() {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
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

  /** Mark the selected stretch. Not an edit: no cut, no rewrite, the audio and
   * the words are untouched. */
  async function markSelection() {
    if (!selection) return;
    try {
      const updated = await api.recHighlightAdd(fileId, selection.t0, selection.t1);
      setMeta((m) => (m ? { ...m, highlights: updated.highlights } : updated));
      setSelection(null);
      pushToast("success", "Marked. It's in Highlights.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** Your own note about the selected moment. */
  async function saveNote() {
    const text = noteDraft.trim();
    if (!text || !selection) return;
    try {
      const updated = await api.recNoteAdd(fileId, selection.t0, "point", text);
      setMeta((m) => (m ? { ...m, notes: updated.notes } : updated));
      setNoting(false);
      setNoteDraft("");
      setSelection(null);
      pushToast("success", "Saved. It's in Notes.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** Mark the moment that just passed, WHILE recording.
   *
   * The span ends now and starts a few seconds back, because you press this
   * after hearing the thing worth keeping, not before. This is the button the
   * `EngineMsg::EditMeta` work exists for — a mark written mid-recording used
   * to be erased by the engine's next save. */
  async function markNow() {
    const at = Math.max(0, durationCs);
    try {
      const updated = await api.recHighlightAdd(fileId, Math.max(0, at - LOOK_BACK_CS), at);
      setMeta((m) => (m ? { ...m, highlights: updated.highlights } : updated));
      pushToast("success", "Marked this moment.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** Name a section starting where the playhead is. */
  async function addChapterHere(title: string) {
    const at = Math.round((mediaRef.current?.currentTime ?? 0) * 100);
    try {
      const updated = await api.recChapterAdd(fileId, at, title);
      setMeta((m) => (m ? { ...m, chapters: updated.chapters } : updated));
      pushToast("success", `Chapter “${title}” added.`);
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** Remove one item the room found, or one you wrote. */
  async function deleteItem(kind: "note" | "chapter" | "highlight", itemId: string) {
    try {
      const updated = await api.recItemDelete(fileId, kind, itemId);
      setMeta((m) =>
        m
          ? {
              ...m,
              notes: updated.notes,
              chapters: updated.chapters,
              highlights: updated.highlights,
            }
          : updated,
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** How much each tab holds — drawn on the tab itself, so "is there anything
   * in Notes" is answered before spending a click. */
  function tabCount(id: TabId): number {
    if (id === "transcript") return turns.length;
    if (id === "notes") return meta?.notes?.length ?? 0;
    if (id === "highlights") return meta?.highlights?.length ?? 0;
    return meta?.chapters?.length ?? 0;
  }

  /** Ask the room to read this recording. The same job it starts by itself on
   * Stop — this is the button for when it did not, and for re-reading after
   * the transcript was corrected. */
  async function startReading() {
    if (reading) return;
    setReading(true);
    try {
      await api.recReadStart(fileId);
      pushToast("success", "Reading this recording — the tabs will fill in.");
    } catch (e) {
      setReading(false);
      pushToast("error", String(e));
    }
  }

  /** GH #5: what to CALL a speaker — the user's name if they gave one, else the
   * engine's label. Every rendering of a speaker goes through this. */
  function speakerName(label: string): string {
    return meta?.speakerNames?.[label] || label;
  }

  /** Is this name the app's GUESS, from a voice the room was told before?
   * Keyed by name rather than label because that is how the engine keys it —
   * re-clustering moves labels, so a guess pinned to one would follow the
   * wrong person. */
  function speakerGuessed(label: string): boolean {
    const name = meta?.speakerNames?.[label];
    return !!name && !!meta?.recognized?.includes(name);
  }

  async function renameSpeaker(label: string, next: string) {
    const name = next.trim();
    // Unchanged (or Escape) — EXCEPT over a name the app guessed, where typing
    // the same name is not a no-op at all: it is the user confirming the
    // guess, which turns it into their own assertion. Nothing else in the UI
    // can say "yes, that is her", and without this the "?" would never come
    // off a guess that happened to be right.
    if (name === speakerName(label) && !speakerGuessed(label)) return;
    // Clicking an UNNAMED chip opens the editor with an empty draft, so a click
    // followed by a click elsewhere commits "" — which is not a no-op by the
    // check above (speakerName() returns the label, not ""). Treat "clear a
    // name that was never set" as the nothing-happened it is, instead of a
    // pointless write and a "Back to Speaker 2" toast for an edit nobody made.
    if (!name && !meta?.speakerNames?.[label]) return;
    try {
      const was = speakerName(label);
      const wasGuessed = speakerGuessed(label);
      const updated = await api.recSetSpeakerName(fileId, label, name);
      // Merge ONLY the names: a live recording is still appending segments via
      // events, and the backend's copy of `segments` can lag behind ours.
      setMeta((m) =>
        m ? { ...m, speakerNames: updated.speakerNames, recognized: updated.recognized } : updated,
      );
      pushToast(
        "success",
        // Say what the room LEARNED, not just what the transcript now reads.
        // Renaming used to be a local edit; it now changes what later
        // recordings will call people, and a silent side effect on someone's
        // name is not one to discover by accident.
        !name
          ? `Back to "${label}".`
          : wasGuessed && name === was
            ? `Confirmed — "${name}" it is.`
            : wasGuessed
              ? `Every line ${label} said is now "${name}" — and this room won't call that voice "${was}" again.`
              : `Every line ${label} said is now "${name}". New recordings will recognise this voice.`,
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

  /** Tablist keyboard contract: arrows move and select, Home/End jump to the
   * ends. Focus follows selection because every panel is cheap to draw. */
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const at = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
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
  const canPlay = !!src && durationCs > 0;
  const voices = new Set(segments.map((s) => s.speaker)).size;
  /** The one-word state of the transcript, drawn as a tape label. Colour rides
   * with the word, never instead of it. */
  const state = recordingNow
    ? { word: "Recording", mark: "nb-sem-urgent" }
    : status === "paused"
      ? { word: "Paused", mark: "nb-sem-pending" }
      : status === "saving"
        ? { word: "Saving", mark: "nb-sem-pending" }
        : segments.length > 0
          ? { word: "Transcript ready", mark: "nb-sem-done" }
          : hasAudio
            ? { word: "No transcript yet", mark: "nb-sem-pending" }
            : { word: "Nothing recorded", mark: "nb-sem-linked" };

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

  /** The transport's primary control is always about the SESSION — start it,
   * or stop it — and it is the one place in this view that wears red. */
  const primary = recordingNow || status === "paused"
    ? {
        cls: "rec-record is-stopping",
        label: "Stop & save",
        title: "Stop recording and save this file",
        glyph: <StopIcon size={14} />,
        run: () => void onStop(),
      }
    : {
        cls: "rec-record",
        label: segments.length || hasAudio ? "Continue recording" : "Start recording",
        title:
          segments.length || hasAudio
            ? "Keep recording into this file — nothing already recorded is lost"
            : "Record the microphone, and the Mac's own audio, into this file",
        glyph: null,
        run: () => void start(),
      };

  return (
    <div className="rec-view">
      {/* Shared suggestions for BOTH language boxes (live and after the fact);
          neither is limited to this list. */}
      <datalist id="rec-langs">
        {LANGS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>

      {/* ---- the stage: transport, wave, facts ---- */}
      <div className="rec-stage">
        <div className="rec-transport">
          <div className="rec-transport-side">
            {recordingNow && (
              <span className="rec-live-chip">
                <span className="rec-dot pulsing" aria-hidden="true" /> REC{" "}
                <b className="nb-num">{formatTimestamp(durationCs)}</b>
              </span>
            )}
            {/* Mark the moment that just passed, mid-meeting. The reason the
                whole `EngineMsg::EditMeta` path exists: a mark written while
                recording used to be erased by the engine's next save. */}
            {(recordingNow || status === "paused") && (
              <button
                className="nb-btn rec-mark-now"
                data-testid="mark-now"
                title="Mark what was just said, so you can find it afterwards"
                onClick={() => void markNow()}
              >
                Mark this moment
              </button>
            )}
            {status === "paused" && (
              <span className="rec-live-chip paused">
                Paused at <b className="nb-num">{formatTimestamp(durationCs)}</b>
              </span>
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
            {!isLive && canPlay && (
              <span className="rec-clock nb-num">
                {formatTimestamp(playCs)} <i>/</i> {formatTimestamp(durationCs)}
              </span>
            )}
          </div>

          <div className="rec-transport-main">
            {!isLive && canPlay && (
              <button
                className="rec-tbtn"
                aria-label={playing ? "Pause playback" : "Play the recording"}
                title={playing ? "Pause" : "Play"}
                onClick={togglePlay}
              >
                {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
              </button>
            )}
            {recordingNow && (
              <button
                className="rec-tbtn"
                aria-label="Pause recording"
                title="Pause recording"
                onClick={() => void onPause()}
              >
                <PauseIcon size={14} />
              </button>
            )}
            {status === "paused" && (
              <button
                className="rec-tbtn"
                aria-label="Resume recording"
                title="Resume recording"
                onClick={() => void onResume()}
              >
                <PlayIcon size={14} />
              </button>
            )}
            {status !== "saving" && (
              <button className={primary.cls} title={primary.title} onClick={primary.run}>
                {/* The rings are decoration on a control, so they are drawn as
                    pseudo-elements of this span and never reach the tree. */}
                <span className="rec-record-ring" aria-hidden="true">
                  {primary.glyph ?? <span className="rec-record-dot" />}
                </span>
                <span className="rec-record-word">{primary.label}</span>
              </button>
            )}
          </div>

          <div className="rec-transport-side rec-transport-end">
            {recordingNow && (
              <>
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
                    <span className="rec-meter-track">
                      <b style={{ width: `${micIsMuted ? 0 : Math.min(100, levels.mic * 400)}%` }} />
                    </span>
                  </span>
                  <span
                    className="rec-meter"
                    title="The Mac's own audio — the meeting or video playing on this computer"
                  >
                    <i>Mac</i>
                    <span className="rec-meter-track">
                      <b style={{ width: `${Math.min(100, levels.sys * 400)}%` }} />
                    </span>
                  </span>
                </span>
              </>
            )}
          </div>
        </div>

        {/* Session options. Kept off the transport line so the one thing the
            page is FOR stays the biggest thing on it. */}
        <div className="rec-options">
          {status === "idle" && (
            <>
              <label className="rec-opt" title="Hear whatever the Mac plays — Google Meet, Zoom, Teams, Slack calls, videos">
                <input
                  type="checkbox"
                  checked={withSystem}
                  onChange={(e) => setWithSystem(e.target.checked)}
                />
                Include the Mac’s audio (meetings)
              </label>
              <span
                className="rec-opt rec-opt-note"
                title="Voices are told apart as people talk, and the labels correct themselves as the meeting goes on — nothing to set up. Afterwards, click a speaker's name to say who they were."
              >
                Speakers detected automatically — name them later
              </span>
            </>
          )}
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
            // the Translate box in the drawer (recording.rs
            // `room_translation_model`). This used to say "(on this Mac)",
            // which is the opposite of what happens in a cloud room: there,
            // every finished sentence of a live meeting is sent to the provider
            // for as long as the box is set. The status bar's trust chip says
            // which kind of room this is; the control must not contradict it.
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
        </div>

        {/* The Mac-audio lane died (in practice: the Screen & System Audio
            Recording permission) — say so where it can't be missed, with the
            fix one click away. Clears itself if a later rec-source says "on". */}
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

        {/* The conversation's shape, with each speaker's turns on their own
            lane under the wave. Diarization has run on this file since v0.14.0
            and none of it was visible above the transcript — a bare
            <audio controls> was the whole picture. Live recording has no
            waveform: there is no finished file to compute an envelope from
            yet. */}
        {canPlay && (
          <Waveform
            fileId={fileId}
            media={mediaEl}
            regions={speakerRegions}
            height={WAVE_HEIGHT_LARGE}
            lanes
            // The link between the two halves of the page: whatever the
            // transcript has selected is drawn over the audio it refers to.
            mark={
              selection ? { start: selection.t0 / 100, end: selection.t1 / 100 } : null
            }
            // What the room found, on the audio it found it in — so a long
            // recording has a readable shape without scrubbing through it.
            marks={(meta?.highlights ?? []).map((h) => ({
              start: h.t0 / 100,
              end: h.t1 / 100,
            }))}
            chapters={(meta?.chapters ?? []).map((c) => ({
              at: c.t0 / 100,
              title: c.title,
            }))}
          />
        )}

        <div className="rec-facts">
          <span className="rec-fact">
            <i>Length</i>
            <b className="nb-num">{formatTimestamp(durationCs)}</b>
          </span>
          {voices > 0 && (
            <span className="rec-fact">
              <i>Voices</i>
              <b className="nb-num">{voices}</b>
            </span>
          )}
          {clips.length > 0 && (
            <span className="rec-fact">
              <i>Clips</i>
              <b className="nb-num">{clips.length}</b>
            </span>
          )}
          {cuts.length > 0 && (
            <span className="rec-fact">
              <i>Removed</i>
              <b className="nb-num">{cuts.length}</b>
            </span>
          )}
          <span className={`nb-tape rec-state ${state.mark}`}>{state.word}</span>
          {/* The full player keeps volume, speed and keyboard scrubbing — the
              transport above is a shortcut to it, not a replacement, so it is
              quietened rather than removed. Both drive the same element. */}
          {canPlay && (
            <audio
              ref={(el) => {
                mediaRef.current = el;
                setMediaEl(el);
              }}
              className="rec-player"
              src={src ?? undefined}
              controls
              aria-label="Recording player — volume, speed and scrubbing"
              onTimeUpdate={() => {
                onTime();
                armCutSkip();
              }}
              onPlay={() => {
                setPlaying(true);
                armCutSkip();
              }}
              onSeeked={armCutSkip}
              onRateChange={armCutSkip}
              onPause={() => {
                setPlaying(false);
                window.clearTimeout(skipTimerRef.current);
              }}
              onEnded={() => setPlaying(false)}
            />
          )}
        </div>
      </div>

      {/* ---- reading: tabs + the clips beside them ---- */}
      <div className="rec-tabbar">
        <div className="rec-tabs" role="tablist" aria-label="Recording views">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              id={`rec-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`rec-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`rec-tab${tab === t.id ? " is-on nb-underline" : ""}`}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
              {/* The count IS the state now. These tabs used to carry an
                  `empty` flag because three of them could never hold anything;
                  the room fills them in today, so what the reader needs to
                  know is how much is in each one. */}
              {tabCount(t.id) > 0 && (
                <span className="nb-circled rec-tab-count">{tabCount(t.id)}</span>
              )}
            </button>
          ))}
        </div>
        {hasWords && tab === "transcript" && (
          <label className="rec-opt rec-tabbar-opt">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
            />
            Show deleted
          </label>
        )}
      </div>

      <div className="rec-body">
        <div
          className="rec-panel"
          role="tabpanel"
          id={`rec-panel-${tab}`}
          aria-labelledby={`rec-tab-${tab}`}
          // A tabpanel is focusable only when it holds nothing focusable of
          // its own — otherwise it would be a second, empty stop in front of
          // the transcript, which already takes focus and carries its own
          // accessible name.
          tabIndex={tab === "transcript" ? undefined : 0}
        >
          {tab === "transcript" && (
            <div
              className="rec-transcript"
              ref={listRef}
              tabIndex={0}
              aria-label="Transcript — select words here to correct them, or to delete them from the recording"
              onMouseUp={captureSelection}
            >
              {segments.length === 0 && !partials.mic && !partials.sys && (
                <div className="rec-empty">
                  {status === "idle" ? (
                    <>
                      <p className="rec-empty-lead">
                        <strong>This file records and understands speech — live.</strong>
                      </p>
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
                    <p className="rec-empty-lead">Listening… speak, or bring the meeting on.</p>
                  )}
                </div>
              )}
              {turns.map((turn, ti) => {
                // The still-speaking (partial) line joins the last turn when it
                // is the same voice continuing; otherwise it gets its own ghost.
                const inlineGhosts = ti === turns.length - 1 ? attachedGhosts : [];
                return (
                  <div
                    key={turn.key}
                    className={`rec-turn ${turn.segs.some(({ seg }) => seg.id === activeSeg) ? "active" : ""}`}
                  >
                    <button
                      className="rec-stamp nb-num"
                      title="Jump to this moment"
                      onClick={() => seek(turn.t0)}
                    >
                      {formatTimestamp(turn.t0)}
                    </button>
                    <div className="rec-turn-main">
                      <div className="rec-turn-head">
                        <SpeakerChip
                          label={turn.speaker}
                          name={speakerName(turn.speaker)}
                          tone={speakerTone(turn.speaker)}
                          guessed={speakerGuessed(turn.speaker)}
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
                  </div>
                );
              })}
              {standaloneGhosts.map((g) => (
                <div key={g.lane} className="rec-turn ghost">
                  <span className="rec-stamp nb-num" aria-hidden="true">…</span>
                  <div className="rec-turn-main">
                    <div className="rec-turn-head">
                      <span className={`rec-speaker ${speakerTone(g.speaker)}`} dir="auto">
                        {speakerName(g.speaker)}
                      </span>
                    </div>
                    <div className="rec-turn-body" dir="auto">
                      <span className="rec-seg ghost" dir="auto">{g.text}</span>
                    </div>
                  </div>
                </div>
              ))}
              {!isLive && segments.length > 0 && (
                <p className="rec-read-note">
                  Select words above to correct them, or to delete them from the
                  recording.
                </p>
              )}
              <div ref={listEndRef} />
            </div>
          )}

          {tab === "notes" && (
            <ReadPanel
              kind="notes"
              meta={meta}
              reading={reading}
              onRead={() => void startReading()}
              onSeek={seek}
              onAddChapter={(t) => void addChapterHere(t)}
              onDelete={(k, i) => void deleteItem(k, i)}
              empty="Nothing to note in this recording."
              blank="Notes are what the room found: decisions, who agreed to do what, questions left open, and the point of each stretch."
            />
          )}
          {tab === "highlights" && (
            <ReadPanel
              kind="highlights"
              meta={meta}
              reading={reading}
              onRead={() => void startReading()}
              onSeek={seek}
              onAddChapter={(t) => void addChapterHere(t)}
              onDelete={(k, i) => void deleteItem(k, i)}
              empty="Nothing marked in this recording."
              blank="Highlights are the moments that carried weight — a commitment, a number, a decisive sentence. Click one to hear it."
            />
          )}
          {tab === "chapters" && (
            <ReadPanel
              kind="chapters"
              meta={meta}
              reading={reading}
              onRead={() => void startReading()}
              onSeek={seek}
              onAddChapter={(t) => void addChapterHere(t)}
              onDelete={(k, i) => void deleteItem(k, i)}
              empty="This recording has no chapters."
              blank="Chapters are the meeting in sections, each with a real start time."
            />
          )}
        </div>

        {/* ---- clips ----
            Not a new data model: one clip IS one speaker turn, which is what
            diarization already produced and what the transcript is grouped by.
            Duration is the distance between the first and last word timing in
            the turn, so it is measured, not estimated. */}
        <aside className="rec-clips" aria-label="Clips in this recording">
          <div className="rec-clips-head">
            <h3>Clips</h3>
            <span className="rec-clips-note">
              {clips.length === 0
                ? "none yet"
                : `${clips.length} turn${clips.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {clips.length === 0 ? (
            <p className="rec-clips-empty">
              A clip appears for every turn a voice takes. Record or import
              audio and they fill in as the transcript does.
            </p>
          ) : (
            <ul className="rec-clip-list">
              {clips.map((c) => (
                <li key={c.key}>
                  <button
                    className="rec-clip"
                    disabled={!canPlay}
                    title={c.text || "Play from here"}
                    onClick={() => seek(c.t0)}
                  >
                    <span className="rec-clip-line">
                      <span
                        className={`rec-clip-who ${speakerTone(c.speaker)}`}
                        dir="auto"
                      >
                        {speakerName(c.speaker)}
                      </span>
                      <span className="rec-clip-at nb-num">{formatTimestamp(c.t0)}</span>
                      <span className="rec-clip-len nb-num">
                        {formatTimestamp(Math.max(0, c.t1 - c.t0))}
                      </span>
                    </span>
                    {c.text && (
                      <span className="rec-clip-text" dir={c.dir}>
                        {c.text}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Spans the transcript edits removed. Read-only on purpose: playback
              skips them, so a row that seeked into one would do nothing. */}
          {cuts.length > 0 && (
            <div className="rec-cuts">
              <hr className="nb-rule-dash" />
              <h4>Removed spans</h4>
              <ul>
                {cuts.map((c, i) => (
                  <li key={i} className="rec-cut">
                    <span className="nb-tape nb-sem-urgent rec-cut-tag">Cut</span>
                    <span className="nb-num rec-cut-at">
                      {formatTimestamp(c.t0)}–{formatTimestamp(c.t1)}
                    </span>
                    <span className="nb-num rec-cut-len">
                      {formatTimestamp(Math.max(0, c.t1 - c.t0))}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="rec-cuts-note">
                Still in the file — playback skips them. “Export edited copy”
                writes a version with them really removed.
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* selection action bar */}
      {selection && canEdit && (
        <div className="rec-selectbar">
          <span className="rec-selectbar-what">
            <b>{selection.words}</b> word{selection.words > 1 ? "s" : ""}{" "}
            <span className="nb-num">
              {formatTimestamp(selection.t0)}–{formatTimestamp(selection.t1)}
            </span>
          </span>
          {noting ? (
            <>
              <input
                autoFocus
                className="rec-correct-input"
                placeholder="What about this moment…"
                aria-label="Your note"
                data-testid="note-input"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveNote();
                  if (e.key === "Escape") {
                    setNoting(false);
                    setNoteDraft("");
                  }
                }}
              />
              <button
                className="nb-btn"
                disabled={!noteDraft.trim()}
                onClick={() => void saveNote()}
              >
                Save note
              </button>
              <button
                className="nb-btn nb-btn-quiet"
                onClick={() => {
                  setNoting(false);
                  setNoteDraft("");
                }}
              >
                Cancel
              </button>
            </>
          ) : correcting ? (
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
                className="nb-btn"
                disabled={!correction.trim()}
                onClick={() => void correctSelection()}
              >
                Save correction
              </button>
              <button
                className="nb-btn nb-btn-quiet"
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
              {/* Marking and noting are not editing: no cut, no rewrite, and
                  the audio is untouched. They sit before the two buttons that
                  DO change the transcript. */}
              <button
                className="nb-btn"
                title="Mark this stretch so you can find it again"
                data-testid="mark-selection"
                onClick={() => void markSelection()}
              >
                Mark
              </button>
              <button
                className="nb-btn"
                title="Write a note about this moment"
                data-testid="note-selection"
                onClick={() => {
                  setNoteDraft("");
                  setNoting(true);
                }}
              >
                Note here
              </button>
              <button
                className="nb-btn"
                title="Retype what this actually says. The audio is untouched."
                onClick={() => {
                  setCorrection("");
                  setCorrecting(true);
                }}
              >
                Fix the words
              </button>
              <button
                className="nb-btn nb-btn-danger"
                onClick={() => void deleteSelection()}
              >
                Delete from recording
              </button>
              <button className="nb-btn nb-btn-quiet" onClick={() => setSelection(null)}>
                Keep
              </button>
            </>
          )}
        </div>
      )}

      {/* ---- the drawer ----
          Translation, re-transcription and the three exports. Closed by
          default: these are things done to a recording once, and as a
          seven-control toolbar they sat across the bottom of every reading of
          it. Anything actually RUNNING is reported on the summary line, which
          is always visible, so closing the drawer can never hide progress. */}
      {(segments.length > 0 || canRetranscribe) && (
        <details className="rec-drawer">
          <summary className="rec-drawer-head">
            <span className="rec-drawer-caret" aria-hidden="true" />
            <span className="rec-drawer-title">Export &amp; rebuild</span>
            <span className="rec-drawer-hint">
              Transcript, subtitles, edited copy, translation, re-transcribe
            </span>
            {(translating || retrans || exporting) && (
              <span className="nb-tape nb-sem-linked rec-drawer-run">
                {translating
                  ? `Translating ${translating.done}/${translating.total}…`
                  : retrans
                    ? `Re-transcribing ${Math.min(100, Math.round((retrans.doneCs / Math.max(1, retrans.totalCs)) * 100))}%…`
                    : "Exporting edited copy…"}
              </span>
            )}
          </summary>
          <div className="rec-tools">
            {segments.length > 0 && (
              <span className="rec-tool">
                <input
                  list="rec-langs"
                  placeholder="Translate into…"
                  aria-label="Translate the transcript into"
                  value={translateTo}
                  disabled={busy}
                  onChange={(e) => setTranslateTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runTranslate();
                  }}
                />
                <button
                  className="nb-btn"
                  disabled={busy || !translateTo.trim()}
                  onClick={() => void runTranslate()}
                >
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
                  <button
                    className="nb-btn nb-btn-danger"
                    onClick={() => void runRetranscribe()}
                  >
                    Re-transcribe
                  </button>
                  <button className="nb-btn nb-btn-quiet" onClick={() => setConfirmRetrans(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="nb-btn"
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
                  className="nb-btn"
                  disabled={busy}
                  title="Save the transcript into this room as a plain text file — timestamps are this recording's own"
                  onClick={() => void exportTranscript("text")}
                >
                  Export transcript
                </button>
                <button
                  className="nb-btn"
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
              <button
                className="nb-btn"
                disabled={busy || (!cuts.length && !segments.some((s) => s.words.some((w) => w.del)))}
                title="Save a copy with the deleted words really cut out of the audio"
                onClick={() => void exportClean()}
              >
                {exporting ? "Exporting edited copy…" : "Export edited copy"}
              </button>
            )}
          </div>
        </details>
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
