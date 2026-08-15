import { formatSize, isRecordingFile, type FileMeta, type RoomInfo } from "../api";
import { displayName, formatWhen } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { useAdaptiveText } from "./adaptiveText";
import "../styles/recordingsPage.css";

/** The Recordings OVERVIEW — the workspace half of the Recordings destination.
 *
 * P2 (QA pass, 2026-08-15): this page drew the contextual sidebar a second
 * time. `RecordingsNav` in workspace/Sidebar.tsx already owns both capture
 * buttons and the filterable list of every recording in the room; the centre
 * repeated both, so one screen carried the same two controls twice with nothing
 * to say which was authoritative, and the widest surface in the app spent
 * itself on navigation the second column had already provided.
 *
 * What is here now is only what the CENTRE can give and the column cannot:
 * what the room is doing this second, what the shelf adds up to, the way back
 * into the newest tape, and the recordings still waiting on a transcript. The
 * list and the two capture verbs stay in the sidebar. The one exception is the
 * empty state, which offers a single way to begin — a room with no recordings
 * has nothing to overview, and one direction is not a duplicated navigator.
 *
 * ON WHAT THIS PAGE STILL DOES NOT SHOW. There is no total LENGTH, and that is
 * deliberate. `FileMeta` carries a name, a size, a created-at and whether text
 * was extracted; a duration only exists once something has decoded the
 * container, which nothing on this page does. A total in minutes would have to
 * be guessed from byte counts, and a plausible default is indistinguishable
 * from a fact once it is on screen (the rule mediaMeta.ts is written around).
 * Bytes ARE in the file list, so bytes are what the tally states. */
export default function RecordingsPage({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  // Newest first: a shelf is read from the most recent tape backwards, and the
  // library's own sort is a reader preference about browsing, not about this.
  const recs = s.files
    .filter(isRecordingFile)
    .slice()
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const newest = recs[0] ?? null;

  const now = captureNow(s.recLive, s.recSave);
  const writingUp = transcribingNow(recs, s.sttStatus);
  // The file the room is busy with is not "waiting on a transcript" — it is
  // being made right now, and the panel above already says so.
  const waiting = needsAttention(recs, s.sttStatus, now?.fileId ?? null);
  const waitingShown = waiting.slice(0, ATTENTION_SHOWN);
  const tally = shelfTally(recs);
  // "Most recent" exists to give a way back into the newest tape. When some
  // other section on this page has already drawn that same tape — it is the
  // capture in flight, or it is one of the ones waiting — a second card for it
  // is the page repeating ITSELF, which is the same fault as repeating the
  // sidebar, one scale down.
  const newestDrawnElsewhere =
    newest !== null && newestAlreadyOnPage(newest.id, now, waitingShown);

  // A1 "living dek": the static subtitle below is always the fallback (RULE
  // 1/3/8) — this only ever REPLACES it visually when a fresh sentence is
  // ready. Facts are exactly what this page itself states: how many tapes, how
  // many are written up, and the newest one's name — never anything fetched
  // fresh for this purpose (RULE 4/10). Gated on having at least one
  // recording — an empty shelf has nothing true to say beyond the static line.
  const recDekFacts = newest
    ? {
        count: tally.count,
        transcribedCount: tally.transcribed,
        newestName: displayName(newest.name),
        recordingNow: now?.phase === "recording",
      }
    : null;
  const recDek = useAdaptiveText({
    roomId: info.path,
    kind: "dek",
    prompt: recDekFacts
      ? `Write one plain sentence, max 20 words, for the header of this room's Recordings shelf. Use ONLY these facts: ${JSON.stringify(recDekFacts)}. Match this voice: short, concrete, no hype (existing example: "Captured here, transcribed here"). No preamble, just the sentence.`
      : "",
    facts: recDekFacts,
    maxWords: 20,
    enabled: recDekFacts !== null,
  });

  return (
    <div className="rec-home">
      <header className="rec-home-head">
        <h1 className="rec-home-title">Recordings</h1>
        {/* The count is a count — hand-circled, which is what the product does
            with every other number of things in a place. Absent at zero: a
            circled 0 is a mark drawn around nothing. */}
        {tally.count > 0 && (
          <span className="nb-circled nb-sem-saved rec-home-count">
            {tally.count}
          </span>
        )}
        <p className="nb-subtitle rec-home-sub">
          {recDek ?? "Captured here, transcribed here"}
        </p>
      </header>

      {(now || writingUp.length > 0) && (
        <NowPanel
          now={now}
          recSave={s.recSave}
          writingUp={writingUp}
          files={recs}
          onOpen={(id) => void a.viewFile(id)}
        />
      )}

      {tally.count === 0 ? (
        <>
          {/* A direction, in the margin voice — and ONE way to act on it. The
              sidebar's two capture rows are still there; a reader who has
              never recorded anything should not have to find them. */}
          <p className="nb-note rec-home-empty">
            Nothing captured yet. Start one here or from the left — or drag in
            audio and video files, which write themselves up in the background.
          </p>
          <div className="rec-over-empty-cta">
            <button
              className="rec-record rec-home-action"
              disabled={s.recLive != null}
              onClick={() => void a.startLiveRecording()}
            >
              <span className="rec-record-ring" aria-hidden>
                <span className="rec-record-dot" />
              </span>
              <span className="rec-home-action-main">
                <span className="rec-record-word">Start a live recording</span>
                <span className="rec-home-action-copy">
                  The mic and the Mac&rsquo;s own audio together, with the
                  transcript appearing as it runs.
                </span>
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <SectionHead>What is here</SectionHead>
          {/* Three figures, each read straight off the file list. See the note
              at the head of this file about the fourth one a reader might
              expect and will not find. */}
          <div className="rec-over-figs">
            <Figure value={String(tally.count)} label={countLabel(tally.count)} />
            <Figure
              value={String(tally.transcribed)}
              label={transcribedPhrase(tally)}
            />
            <Figure value={formatSize(tally.bytes)} label="stored in this room" />
          </div>

          {newest && !newestDrawnElsewhere && (
            <>
              <SectionHead>Most recent</SectionHead>
              <ul className="rec-home-list nb-list">
                <RecordingCard
                  file={newest}
                  chip={shelfChip(newest, now, s.sttStatus[newest.name])}
                  current={s.openFile?.id === newest.id}
                  onOpen={() => void a.viewFile(newest.id)}
                />
              </ul>
            </>
          )}

          {waiting.length > 0 && (
            <>
              <SectionHead>Waiting on a transcript</SectionHead>
              <ul className="rec-home-list nb-list">
                {waitingShown.map((w) => (
                  <AttentionCard
                    key={w.file.id}
                    item={w}
                    current={s.openFile?.id === w.file.id}
                    onOpen={() => void a.viewFile(w.file.id)}
                  />
                ))}
              </ul>
              {/* The overflow is NAMED rather than silently cropped — and it
                  points at the column that lists all of them, instead of
                  growing a second full list here. Not in the hand: the sentence
                  carries a computed count (paper.css §3). */}
              {waiting.length > ATTENTION_SHOWN && (
                <p className="rec-over-more">
                  {waiting.length - ATTENTION_SHOWN} more are waiting too — the
                  list on the left has every one.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- what the room is doing right now ---------- */

/** The live capture session, as the workspace holds it (`WSState.recLive`). */
export interface LiveCapture {
  fileId: string;
  status: string;
}

/** The stop-to-saved drain (`WSState.recSave`). Its presence means the audio is
 * already durable — that is the whole reason it is surfaced. */
export interface SaveDrain {
  stage: "transcribing" | "writing";
  remaining: number;
  startedAt: string;
}

export type CapturePhase = "recording" | "paused" | "saving";

export interface CaptureNow {
  phase: CapturePhase;
  /** The recording being made. Always known: a save drain only exists for a
   * session, and the session carries the id. */
  fileId: string;
}

/** Which of the three capture phases the room is in, or null for none.
 *
 * A recording is "being written out" while EITHER signal is up — `recSave` and
 * a `recLive.status` of "saving" arrive a beat apart, and Activity's own
 * counter uses exactly this rule (AiPane's `savingRec`). Reading only one of
 * them makes the panel flicker through a gap where the room looks idle in the
 * middle of a save. */
export function captureNow(
  recLive: LiveCapture | null,
  recSave: SaveDrain | null,
): CaptureNow | null {
  if (!recLive) return null;
  if (recSave != null || recLive.status === "saving") {
    return { phase: "saving", fileId: recLive.fileId };
  }
  if (recLive.status === "paused") return { phase: "paused", fileId: recLive.fileId };
  return { phase: "recording", fileId: recLive.fileId };
}

/** The word each phase is announced with. Red (`nb-sem-urgent`) is reserved for
 * the capture that is actually running — the one thing on this page that is
 * happening to the microphone right now. */
export const CAPTURE_WORD: Record<CapturePhase, string> = {
  recording: "Recording now",
  paused: "Paused",
  saving: "Saving",
};

export const CAPTURE_MARK: Record<CapturePhase, string> = {
  recording: "nb-sem-urgent",
  paused: "nb-sem-pending",
  saving: "nb-sem-linked",
};

/** How far along a save is, in the room's own words.
 *
 * The same three sentences the Activity pane uses, and for the same reason: the
 * audio is on disk from the first event, so every one of them has to say so —
 * "Saving" on its own reads as "your recording is not safe yet". */
export function saveDetail(recSave: SaveDrain | null): string {
  if (recSave?.stage === "writing") return "Audio saved — writing into the room…";
  if (recSave && recSave.remaining > 0) {
    return `Audio saved — transcribing (${recSave.remaining} to go)`;
  }
  return "Audio saved — finishing the transcript…";
}

/** What each phase means, for the reader who did not start it themselves. */
export function captureDetail(
  phase: CapturePhase,
  recSave: SaveDrain | null,
): string {
  if (phase === "saving") return saveDetail(recSave);
  if (phase === "paused") {
    return "The microphone is closed. Nothing is lost — resume it in the recording itself.";
  }
  return "The microphone is open. Open the recording to watch it, stop it, or name a speaker.";
}

/** Imported audio and video whose transcript is being decoded in the
 * background. Keyed by file NAME because that is what `stt-progress` carries
 * (see effects.ts) — the event has no id to key on. */
export function transcribingNow(
  recs: FileMeta[],
  sttStatus: Record<string, string>,
): FileMeta[] {
  return recs.filter((f) => sttStatus[f.name] === "processing");
}

/* ---------- what still needs a look ---------- */

/** Why one recording has no transcript.
 *
 * `hasText` is the only DURABLE signal — `sttStatus` is filled by events and so
 * is empty after a restart, which is exactly when a reader comes back to find
 * out what happened. So the list is built from `hasText`, and the session's
 * stage only supplies the REASON when it happens to know it. */
export type AttentionReason = "model-missing" | "failed" | "no-speech" | "not-yet";

export interface RecordingAttention {
  file: FileMeta;
  reason: AttentionReason;
  /** The backend's own explanation of a failure, when it sent one. "" for
   * every other reason — the app never writes a cause it was not given. */
  detail: string;
}

/** Worst first. A missing speech model is room-wide (nothing will transcribe
 * until it is installed), a failure is about this one file, "no speech" is a
 * finished answer rather than a problem, and "not yet" is just the queue. */
const ATTENTION_RANK: Record<AttentionReason, number> = {
  "model-missing": 0,
  failed: 1,
  "no-speech": 2,
  "not-yet": 3,
};

/** How many waiting recordings the centre draws before it defers to the column.
 * A cap, not a crop: the overflow is counted out loud below the list. */
export const ATTENTION_SHOWN = 5;

export const ATTENTION_WORD: Record<AttentionReason, string> = {
  "model-missing": "No speech model",
  failed: "Could not be read",
  "no-speech": "No speech found",
  "not-yet": "No transcript yet",
};

export const ATTENTION_COPY: Record<AttentionReason, string> = {
  "model-missing":
    "Install a speech model in Settings and this will transcribe itself.",
  failed: "Converting the file to a common format usually fixes this.",
  "no-speech": "The audio was read all the way through and held no speech.",
  "not-yet": "Nothing has read it yet. Open it to write it up.",
};

/** The backend sends `failed: <why>`; the why is the half worth showing. */
export function failureDetail(stage: string | undefined): string {
  if (!stage?.startsWith("failed")) return "";
  return stage.slice("failed:".length).trim();
}

/** Why this one recording is on the waiting list, or null if it is not.
 *
 * `busyFileId` is the session the room is capturing or saving right now: it has
 * no transcript yet because it is still being MADE, which the panel above the
 * fold already says. Listing it here as well would ask the reader to do
 * something about work that is already under way. */
export function attentionReason(
  f: FileMeta,
  stage: string | undefined,
  busyFileId: string | null,
): AttentionReason | null {
  if (f.hasText) return null;
  if (f.id === busyFileId) return null;
  if (stage === "processing") return null;
  if (stage === "model-missing") return "model-missing";
  if (stage?.startsWith("failed")) return "failed";
  if (stage === "none") return "no-speech";
  return "not-yet";
}

/** Every recording still waiting on a transcript, worst reason first and
 * newest first within a reason. */
export function needsAttention(
  recs: FileMeta[],
  sttStatus: Record<string, string>,
  busyFileId: string | null,
): RecordingAttention[] {
  const waiting: RecordingAttention[] = [];
  for (const f of recs) {
    const stage = sttStatus[f.name];
    const reason = attentionReason(f, stage, busyFileId);
    if (reason === null) continue;
    waiting.push({ file: f, reason, detail: failureDetail(stage) });
  }
  return waiting.sort(
    (x, y) =>
      ATTENTION_RANK[x.reason] - ATTENTION_RANK[y.reason] ||
      y.file.createdAt.localeCompare(x.file.createdAt),
  );
}

/** Has some other section of this page already drawn the newest recording?
 *
 * The live panel names the capture in flight, and the waiting list names every
 * recording without a transcript. Either one makes a "Most recent" card for the
 * same file a second copy of a row the reader is already looking at — and both
 * of those cards are a way into the file, so nothing is lost by dropping it. */
export function newestAlreadyOnPage(
  newestId: string,
  now: CaptureNow | null,
  shownWaiting: RecordingAttention[],
): boolean {
  if (now?.fileId === newestId) return true;
  return shownWaiting.some((w) => w.file.id === newestId);
}

/** The one status word a recording card carries, and how it is drawn.
 *
 * One function so the card can never contradict the panel above it. The first
 * cut of this page had the card read `hasText` alone, which put "No transcript
 * yet" on the very recording the live panel was announcing as being written up.
 *
 * `loud` is the marker tape rather than the quiet chip, and only a capture that
 * is actually running gets it: red on this page means the microphone is open,
 * and spending it on a status would leave nothing for the one urgent thing. */
export interface ShelfChip {
  word: string;
  mark: string;
  loud: boolean;
}

export function shelfChip(
  file: FileMeta,
  now: CaptureNow | null,
  stage: string | undefined,
): ShelfChip {
  if (now?.fileId === file.id) {
    return {
      word: CAPTURE_WORD[now.phase],
      mark: CAPTURE_MARK[now.phase],
      loud: now.phase === "recording",
    };
  }
  if (stage === "processing") {
    return { word: "Writing up", mark: "nb-sem-linked", loud: false };
  }
  if (file.hasText) {
    return { word: "Transcribed", mark: "nb-sem-done", loud: false };
  }
  return { word: "No transcript yet", mark: "nb-sem-pending", loud: false };
}

/* ---------- what the shelf adds up to ---------- */

export interface ShelfTally {
  count: number;
  transcribed: number;
  /** Bytes on disk. The one size the file list can answer for — see the note
   * at the head of this file about the length it cannot. */
  bytes: number;
}

export function shelfTally(recs: FileMeta[]): ShelfTally {
  return {
    count: recs.length,
    transcribed: recs.filter((f) => f.hasText).length,
    bytes: recs.reduce((sum, f) => sum + f.sizeBytes, 0),
  };
}

/** The noun under the count, singular when it has to be. */
export function countLabel(count: number): string {
  return count === 1 ? "recording" : "recordings";
}

/** The label under the transcribed figure. It states the RATIO, because "9"
 * under "written up" beside "12" under "recordings" makes a reader do the
 * subtraction — and the interesting number is the three that are not. */
export function transcribedPhrase(t: ShelfTally): string {
  if (t.count === 0) return "written up";
  if (t.transcribed === t.count) return "written up — all of them";
  if (t.transcribed === 0) return `written up — none of ${t.count} yet`;
  return `written up of ${t.count}`;
}

/* ---------- pieces ---------- */

/** The same ruled heading the shelf used, so a section here reads as part of
 * the same page rather than as a new component. */
function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="rec-home-shelf-head">
      <span className="group-heading">{children}</span>
      <hr className="nb-rule rec-home-rule" />
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="rec-over-fig">
      <span className="rec-over-fig-value">{value}</span>
      <span className="rec-over-fig-label">{label}</span>
    </div>
  );
}

/** What the room is doing this second — the one thing the sidebar's list of
 * files structurally cannot say. */
function NowPanel({
  now,
  recSave,
  writingUp,
  files,
  onOpen,
}: {
  now: CaptureNow | null;
  /** Threaded rather than re-derived: the drain's own counters are the only
   * thing that can say how much of a save is left. */
  recSave: SaveDrain | null;
  writingUp: FileMeta[];
  files: FileMeta[];
  onOpen: (id: string) => void;
}) {
  // A capture that started seconds ago may not be in the file list yet, so the
  // name is shown only when the list actually has it. No placeholder: a made-up
  // title on the one card claiming to describe live work is the worst possible
  // place for a guess.
  const named = now ? (files.find((f) => f.id === now.fileId) ?? null) : null;
  return (
    <section className="nb-panel rec-over-now" aria-label="Happening now">
      {now && (
        <div className="rec-over-now-line" role="status">
          <div className="rec-over-now-head">
            <span className={`nb-tape ${CAPTURE_MARK[now.phase]}`}>
              {CAPTURE_WORD[now.phase]}
            </span>
            {named && (
              <span className="rec-over-now-title">{displayName(named.name)}</span>
            )}
          </div>
          <p className="rec-over-now-copy">
            {captureDetail(now.phase, recSave)}
          </p>
          <div className="rec-over-now-actions">
            <button className="nb-btn" onClick={() => onOpen(now.fileId)}>
              Open the recording
            </button>
          </div>
        </div>
      )}
      {writingUp.length > 0 && (
        <div className="rec-over-now-line" role="status">
          <div className="rec-over-now-head">
            <span className="nb-chip nb-sem-linked">Writing up</span>
            <span className="rec-over-now-title">
              {writingUp.length === 1
                ? displayName(writingUp[0].name)
                : `${writingUp.length} recordings`}
            </span>
          </div>
          <p className="rec-over-now-copy">
            Being transcribed on this Mac, in the background. They stay usable
            while it runs.
          </p>
        </div>
      )}
    </section>
  );
}

/** One tape on the shelf. Every value shown is read off the file list; see the
 * note at the head of this file about the ones that are not. */
function RecordingCard({
  file,
  chip,
  current,
  onOpen,
}: {
  file: FileMeta;
  /** Decided by `shelfChip` in one place, so this card cannot disagree with the
   * live panel about the same recording. */
  chip: ShelfChip;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        className={`nb-card rec-home-card${current ? " is-current" : ""}`}
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
      >
        <span className="rec-home-card-mark" aria-hidden>
          <span className="rec-home-card-dot" />
        </span>
        <span className="rec-home-card-main">
          <span className="rec-home-card-title">{displayName(file.name)}</span>
          <span className="rec-home-card-meta">
            {/* Both are facts the room recorded — the date in the sans at the
                metadata rung, the size in mono and tabular because it is a
                figure that has to line up down the column. */}
            <span className="rec-home-when">
              {formatWhen(file.createdAt)}
            </span>
            <span className="nb-num">{formatSize(file.sizeBytes)}</span>
          </span>
        </span>
        {/* Transcript state, in the product's marker vocabulary — and never as
            colour alone: the chip carries the word as well. */}
        <span
          className={`${chip.loud ? "nb-tape" : "nb-chip"} ${chip.mark} rec-home-state`}
        >
          {chip.word}
        </span>
      </button>
    </li>
  );
}

/** A recording that is waiting on a transcript, with the reason and a way in.
 *
 * Deliberately NOT drawn in red, however bad the reason: this page keeps red
 * for the capture that is running, and every chip carries its word, so the
 * failure is legible without borrowing the one colour that means "live". */
function AttentionCard({
  item,
  current,
  onOpen,
}: {
  item: RecordingAttention;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        className={`nb-card rec-home-card${current ? " is-current" : ""}`}
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
      >
        <span className="rec-home-card-mark" aria-hidden>
          <span className="rec-home-card-dot" />
        </span>
        <span className="rec-home-card-main">
          <span className="rec-home-card-title">
            {displayName(item.file.name)}
          </span>
          <span className="rec-home-card-meta">
            <span className="rec-home-when">
              {formatWhen(item.file.createdAt)}
            </span>
            {/* The backend's own words when it gave any, this app's guidance
                when it did not. Never both invented. */}
            <span className="rec-over-why">
              {item.detail || ATTENTION_COPY[item.reason]}
            </span>
          </span>
        </span>
        <span className="nb-chip nb-sem-pending rec-home-state">
          {ATTENTION_WORD[item.reason]}
        </span>
      </button>
    </li>
  );
}
