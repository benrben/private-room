import { useState, type KeyboardEvent } from "react";
import {
  SPEAKER_TONES,
} from "./Waveform";
import { By, NoteKind, RecMeta } from "../api";
import {
  Quote,
  formatTimestamp,
  highlightQuote,
} from "./recReview";

/** How far back "Mark this moment" reaches while recording. You press it AFTER
 * hearing the thing worth keeping, so a mark that started at the press would
 * begin just past the sentence it is about. Six seconds is about one spoken
 * sentence. */
export const LOOK_BACK_CS = 600;

export const SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** Have the words moved since the room read them?
 *
 * `readOf` is the stamp Rust wrote when the reading pass ran (`ReadStamp::of`):
 * the number of phrases, and the transcript's length in **UTF-8 bytes** —
 * `String::len`. JavaScript's `String.length` counts UTF-16 code units, so the
 * two sides only ever agreed on pure ASCII: a Hebrew, Russian or emoji
 * transcript never matched its own stamp, and every note, highlight and chapter
 * was labelled "about a transcript that no longer exists" for ever. The unit is
 * converted here, at the seam, rather than compared across it.
 */
export function readingIsStale(
  readOf: { turns: number; chars: number } | undefined,
  segments: readonly { text: string }[],
): boolean {
  if (!readOf) return false;
  const utf8 = new TextEncoder();
  const chars = segments.reduce((n, s) => n + utf8.encode(s.text).length, 0);
  return readOf.turns !== segments.length || readOf.chars !== chars;
}

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
 * The audio is the subject, so the page opens with it: ONE transport cluster,
 * then the wave at full size with its tick scale and a lane per voice. Reading
 * comes below that, split into tabs, at the full width of the pane — and everything
 * technical (translate, re-transcribe, the three exports) lives in a closed
 * drawer at the foot, because those are things you do to a recording ONCE and
 * the toolbar they used to share was seven controls wide over every reading.
 *
 * "One transport" is load-bearing. QA 2026-08-15 found two: this cluster AND a
 * native `<audio controls>` further down the page, kept for the volume, speed
 * and keyboard scrubbing the cluster lacked. Two players on one screen leave
 * nobody able to say which one owns playback, so the missing controls were
 * built here instead and the element stays in the DOM UNRENDERED — it is still
 * the single truth the wave, the transcript, the cut-skipping and the clock all
 * drive, and now nothing draws a second set of buttons on top of it.
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
export const LANGS = [
  "English", "עברית (Hebrew)", "Español (Spanish)", "Français (French)",
  "Deutsch (German)", "العربية (Arabic)", "Русский (Russian)", "中文 (Chinese)",
  "日本語 (Japanese)", "Português (Portuguese)", "Italiano (Italian)", "हिन्दी (Hindi)",
  "Українська (Ukrainian)", "Nederlands (Dutch)", "Polski (Polish)", "Türkçe (Turkish)",
];

/**
 * Containers a capture session can NOT be written into — read by `capturable`
 * below, which is where the whole rule is argued.
 *
 * The media containers the room imports and downloads, minus `wav`: WAV is the
 * one format `rec_start`'s splice decodes (`decodeWav`), so it is the one a
 * recording can be continued into. Mirrors main's `AUDIO_EXTENSIONS` /
 * `VIDEO_EXTENSIONS` (peaksTools.ts) — the renderer cannot import from main, so
 * this is a deliberate second copy, widened by the containers a download can
 * arrive as. Being a list and not "anything but wav" is load-bearing: a name is
 * free text, and a file called "Dr. Cohen call" must not be read as a container.
 */
export const NO_CAPTURE_CONTAINERS: ReadonlySet<string> = new Set([
  // audio
  "m4a", "m4b", "mp3", "aac", "flac", "aiff", "aif", "caf", "ogg", "oga",
  "opus", "wma", "amr", "alac",
  // video
  "mp4", "mov", "m4v", "webm", "mkv", "avi", "mpg", "mpeg", "3gp", "ts",
]);

/** The reading tabs. All four read one `RecMeta`: Transcript draws its
 * segments, and the other three are one `ReadPanel` over the notes, highlights
 * and chapters the `rec_read` job writes. Each tab states its own count, so
 * "is there anything in Notes" is answered before a click rather than after —
 * which is what the old `empty` flag was for, back when three of the four
 * could never hold anything. */
export const TABS = [
  { id: "transcript", label: "Transcript" },
  { id: "notes", label: "Notes" },
  { id: "highlights", label: "Highlights" },
  { id: "chapters", label: "Chapters" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

/**
 * Stable marker class per speaker.
 *
 * Keyed on the machine LABEL, never on the name, so renaming "Speaker 2" to
 * "Dana" cannot change her colour — and so the chip in the transcript and the
 * lane under the wave are guaranteed to agree, because both ask this one
 * function.
 *
 * "You" gets the pen (the app-wide accent) because it is not one voice among
 * several, it is the person reading the page. The rest walk the four-hue
 * speaker palette, which deliberately excludes red — red means recording or
 * urgent everywhere in this product and a voice is neither.
 */
export function speakerTone(label: string): string {
  if (label === "You") return "rec-tone-self";
  const n = parseInt(label.replace(/\D/g, ""), 10) || 1;
  return SPEAKER_TONES[(n - 1) % SPEAKER_TONES.length];
}

export function speakerTitle(label: string, name: string, guessed: boolean): string {
  if (guessed) {
    return `Recognised from a voice you named before — click if this isn't ${name}. The engine calls this voice ${label}.`;
  }
  if (name !== label) return `Rename — the engine calls this voice ${label}`;
  return "Name this speaker — renames every line they said here, and this room will recognise the voice in later recordings";
}

export function speakerDraft(label: string, name: string): string {
  return name === label ? "" : name;
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
export function SpeakerChip({
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
        aria-label={`Name for ${label} — also taught to this room`}
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
      title={speakerTitle(label, name, guessed)}
      onClick={() => {
        setDraft(speakerDraft(label, name));
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


export const NOTE_LABEL: Record<NoteKind, string> = {
  decision: "Decided",
  action: "To do",
  question: "Open",
  point: "Point",
};
/** The order the Notes tab reads in: what was settled, what someone owes, what
 * is still open, then the running summary. Not chronological — the first three
 * are what a person opens a finished meeting to find. */
export const NOTE_ORDER: NoteKind[] = ["decision", "action", "question", "point"];

export function readItemCount(
  kind: "notes" | "highlights" | "chapters",
  notes: number,
  highlights: number,
  chapters: number,
): number {
  if (kind === "notes") return notes;
  if (kind === "highlights") return highlights;
  return chapters;
}

export function readPanelItems(meta: RecMeta | null) {
  return {
    notes: meta?.notes ?? [],
    highlights: meta?.highlights ?? [],
    chapters: meta?.chapters ?? [],
  };
}

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
export function ReadPanel({
  kind,
  meta,
  quotes,
  reading,
  hasTranscript,
  onRead,
  onSeek,
  onJump,
  onAddChapter,
  onDelete,
  empty,
  blank,
}: {
  kind: "notes" | "highlights" | "chapters";
  meta: RecMeta | null;
  /** The transcript phrases a highlight is quoted FROM. Passed in rather than
   * read off `meta.segments` so the words here are the ones on screen — the
   * deleted ones already applied — and so this panel cannot make up a
   * sentence: with no overlapping phrase it says so instead. */
  quotes: readonly Quote[];
  reading: boolean;
  /** `start_rec_read` refuses a recording with no turns outright, so offering
   * the read button here would be a primary action whose only answer is the
   * engine's error string. */
  hasTranscript: boolean;
  onRead: () => void;
  onSeek: (cs: number) => void;
  /** Show this moment in the transcript WITHOUT starting playback — the other
   * half of reviewing a mark, and the reason the row has two actions. */
  onJump: (cs: number) => void;
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
  const { notes, highlights, chapters } = readPanelItems(meta);
  const count = readItemCount(kind, notes.length, highlights.length, chapters.length);
  const everRead = !!meta?.readOf;
  // The words moved under the reading — a re-transcribe, or corrections. The
  // findings are about a transcript that no longer exists, so say so rather
  // than let them read as current.
  const stale = readingIsStale(meta?.readOf, meta?.segments ?? []);

  const readButton = (label: string, primary: boolean) => (
    <button
      className={primary ? "nb-btn" : "nb-btn nb-btn-quiet"}
      disabled={reading}
      data-testid="rec-read-btn"
      onClick={onRead}
      // Where the reading happens, said in the same breath as what it does —
      // the live-translate box beside it already has to say this, and this
      // pass sends the WHOLE transcript, not one phrase.
      title="The room reads the transcript and writes what happened in it — on the room's AI model. In a cloud room the transcript is sent to the provider."
    >
      {reading ? "Reading…" : label}
    </button>
  );

  function ChapterAdder() {
    if (kind !== "chapters") return null;
    if (adding) {
      const cancel = () => {
        setTitle("");
        setAdding(false);
      };
      const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") commitChapter();
        if (e.key === "Escape") cancel();
      };
      return <input autoFocus className="rec-correct-input" placeholder="Name this section…" aria-label="Chapter name" data-testid="chapter-input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commitChapter} onKeyDown={onKeyDown} />;
    }
    return <button className="nb-btn nb-btn-quiet" data-testid="add-chapter" title="Name a section starting where you are listening" onClick={() => { setTitle(""); setAdding(true); }}>Add chapter here</button>;
  }

  function EmptyReadPanel() {
    return (
      <div className="rec-blank" data-testid="rec-read-empty">
        <EmptyReadHeading />
        <EmptyReadAside />
        <p className="rec-blank-body">{blank}</p>
        <MissingTranscriptNotice />
        <div className="rec-read-actions"><ReadEmptyButton /><ChapterAdder /></div>
      </div>
    );
  }

  function EmptyReadHeading() {
    const text = !hasTranscript ? "Nothing to read yet" : everRead ? empty : "Not read yet";
    return <h3 className="rec-blank-title">{text}</h3>;
  }

  function EmptyReadAside() {
    const text = !hasTranscript ? "this recording has no transcript" : everRead ? "the room read it and found none" : "nobody has read this one";
    return <p className="rec-blank-aside nb-note">{text}</p>;
  }

  function MissingTranscriptNotice() {
    if (hasTranscript) return null;
    return <p className="rec-blank-body">Nothing has been transcribed yet — there is nothing here to read. Transcribe it on the Transcript tab and this fills in.</p>;
  }

  function ReadEmptyButton() {
    if (!hasTranscript) return null;
    return <>{readButton("Read this recording", true)}</>;
  }

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
    return <EmptyReadPanel />;
  }

  const row = (
    key: string,
    t0: number,
    by: By | undefined,
    lead: React.ReactNode,
    body: React.ReactNode,
    /** Extra acts for this kind of item, before the remove button. */
    actions?: React.ReactNode,
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
          // It seeks AND plays, which "jump" did not say. This is the row's
          // one play control: a second button doing the same thing is the
          // two-transports mistake in miniature.
          title="Play from this moment"
          aria-label={`Play from ${formatTimestamp(t0)}`}
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
        {actions}
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

  function PopulatedReadHeader() {
    return <div className="rec-read-actions"><StaleNotice /><ChapterAdder />{readButton("Read again", false)}</div>;
  }

  function StaleNotice() {
    if (!stale) return null;
    return <span className="rec-read-stale" data-testid="rec-read-stale">The transcript changed since this was read.</span>;
  }

  function ReadPanelList() {
    return <ul className="rec-found-list"><ChapterRows /><HighlightRows /><NoteRows /></ul>;
  }

  function ChapterRows() {
    if (kind !== "chapters") return null;
    return <>{chapters.map((chapter) => row(chapter.id, chapter.t0, chapter.by, null, <b dir="auto">{chapter.title}</b>))}</>;
  }

  function HighlightRows() {
    if (kind !== "highlights") return null;
    return <>{highlights.map((highlight) => {
      const quote = highlightQuote(quotes, highlight.t0, highlight.t1);
      const title = quote ? quote.title : "Nothing transcribed in this stretch";
      const body = <span className="rec-hl"><b className={`rec-hl-title${quote ? "" : " is-silent"}`} dir="auto" data-testid="rec-hl-title">{title}</b><HighlightExcerpt excerpt={quote?.excerpt} /><span className="rec-found-span nb-num">{formatTimestamp(highlight.t0)}–{formatTimestamp(highlight.t1)}</span></span>;
      const action = <button className="nb-btn nb-btn-quiet rec-found-act" data-testid="rec-hl-jump" title="Show these words in the transcript, without playing" onClick={() => onJump(highlight.t0)}>Show in transcript</button>;
      return row(highlight.id, highlight.t0, highlight.by, null, body, action);
    })}</>;
  }

  function HighlightExcerpt({ excerpt }: { excerpt: string | undefined }) {
    if (!excerpt) return null;
    return <span className="rec-hl-quote" dir="auto">{excerpt}</span>;
  }

  function NoteRows() {
    if (kind !== "notes") return null;
    return <>{NOTE_ORDER.flatMap((noteKind) => notes.filter((note) => note.kind === noteKind).map((note) => row(note.id, note.t0, note.by, <span className={`rec-found-kind kind-${noteKind}`}>{NOTE_LABEL[noteKind]}</span>, <NoteBody text={note.text} who={note.who} />)))}</>;
  }

  function NoteBody({ text, who }: { text: string; who: string | undefined }) {
    return <span dir="auto">{text}<NoteAuthor who={who} /></span>;
  }

  function NoteAuthor({ who }: { who: string | undefined }) {
    if (!who) return null;
    return <span className="rec-found-who"> — {who}</span>;
  }

  return (
    <div className="rec-found-panel">
      <PopulatedReadHeader />
      <ReadPanelList />
    </div>
  );
}

/** One phrase inside a turn. `visible` is the words to draw ("Show deleted"
 * already applied); null means the segment has no word timings — draw its
 * plain text. `text` is that same phrase as a plain string — computed once
 * here because the search and the highlight quotes both need it, and two
 * places deriving "what this phrase says" is two places that can disagree
 * about a deleted word. */

import { useRecordingController } from "./recordingController";
import { RecordingSurface } from "./RecordingSurface";

export default function RecordingView(props: RecordingViewProps) {
  const controller = useRecordingController(props);
  return <RecordingSurface controller={controller} />;
}
