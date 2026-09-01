import { formatSize, type FileMeta, type RoomInfo } from "../api";
import { displayName, formatWhen } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";
import {
  ATTENTION_COPY,
  ATTENTION_SHOWN,
  ATTENTION_WORD,
  CAPTURE_MARK,
  CAPTURE_WORD,
  captureDetail,
  countLabel,
  recordingOverview,
  shelfChip,
  transcribedPhrase,
  type CaptureNow,
  type LiveCapture,
  type RecordingAttention,
  type RecordingOverview,
  type SaveDrain,
  type ShelfChip,
  type ShelfTally,
} from "./recordingsOverview";
import "../styles/recordingsPage.css";

export * from "./recordingsOverview";

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
 * Bytes ARE in the file list, so bytes are what the tally states.
 *
 * `info` is still accepted (the pane passes it) but deliberately unread: the
 * only thing that ever wanted it was a model-written subtitle, and writing one
 * meant sending the newest recording's FILE NAME to whatever engine this room
 * is set to — off the machine, in a cloud room, to decorate the one page whose
 * whole subject is private capture. */
export default function RecordingsPage({
  s,
  a,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  const overview = recordingOverview(s);
  return (
    <div className="rec-home">
      <RecordingsHeader tally={overview.tally} />
      <CurrentRecordingWork
        now={overview.now}
        recSave={s.recSave}
        writingUp={overview.writingUp}
        files={overview.recs}
        onOpen={(id) => void a.viewFile(id)}
      />
      <RecordingsShelf
        overview={overview}
        recLive={s.recLive}
        sttStatus={s.sttStatus}
        openFileId={s.openFile?.id}
        onStart={() => void a.startLiveRecording()}
        onOpen={(id) => void a.viewFile(id)}
      />
    </div>
  );
}

function RecordingsHeader({ tally }: { tally: ShelfTally }) {
  return (
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
        Captured here, transcribed here
      </p>
    </header>
  );
}

function CurrentRecordingWork({
  now,
  recSave,
  writingUp,
  files,
  onOpen,
}: {
  now: CaptureNow | null;
  recSave: SaveDrain | null;
  writingUp: FileMeta[];
  files: FileMeta[];
  onOpen: (id: string) => void;
}) {
  if (!now && writingUp.length === 0) return null;
  return <NowPanel now={now} recSave={recSave} writingUp={writingUp} files={files} onOpen={onOpen} />;
}

function RecordingsShelf({
  overview,
  recLive,
  sttStatus,
  openFileId,
  onStart,
  onOpen,
}: {
  overview: RecordingOverview;
  recLive: LiveCapture | null;
  sttStatus: Record<string, string>;
  openFileId: string | undefined;
  onStart: () => void;
  onOpen: (id: string) => void;
}) {
  if (overview.tally.count === 0) {
    return <EmptyShelf recording={recLive != null} onStart={onStart} />;
  }
  return <RecordedShelf overview={overview} sttStatus={sttStatus} openFileId={openFileId} onOpen={onOpen} />;
}

function EmptyShelf({ recording, onStart }: { recording: boolean; onStart: () => void }) {
  return (
    <>
      <p className="nb-note rec-home-empty">
        Nothing captured yet. Start one here or from the left — or drag in
        audio and video files, which write themselves up in the background.
      </p>
      <div className="rec-over-empty-cta">
        <button className="rec-record rec-home-action" disabled={recording} onClick={onStart}>
          <span className="rec-record-ring" aria-hidden>
            <span className="rec-record-dot" />
          </span>
          <span className="rec-home-action-main">
            <span className="rec-record-word">Start a live recording</span>
            <span className="rec-home-action-copy">
              The mic and the Mac&rsquo;s own audio together, with the transcript appearing as it runs.
            </span>
          </span>
        </button>
      </div>
    </>
  );
}

function RecordedShelf({
  overview,
  sttStatus,
  openFileId,
  onOpen,
}: {
  overview: RecordingOverview;
  sttStatus: Record<string, string>;
  openFileId: string | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <ShelfFigures tally={overview.tally} />
      <NewestRecording overview={overview} sttStatus={sttStatus} openFileId={openFileId} onOpen={onOpen} />
      <AttentionShelf overview={overview} openFileId={openFileId} onOpen={onOpen} />
    </>
  );
}

function ShelfFigures({ tally }: { tally: ShelfTally }) {
  return (
    <>
      <SectionHead>What is here</SectionHead>
      <div className="rec-over-figs">
        <Figure value={String(tally.count)} label={countLabel(tally.count)} />
        <Figure value={String(tally.transcribed)} label={transcribedPhrase(tally)} />
        <Figure value={formatSize(tally.bytes)} label="stored in this room" />
      </div>
    </>
  );
}

function NewestRecording({
  overview,
  sttStatus,
  openFileId,
  onOpen,
}: {
  overview: RecordingOverview;
  sttStatus: Record<string, string>;
  openFileId: string | undefined;
  onOpen: (id: string) => void;
}) {
  if (!overview.newest || overview.newestDrawnElsewhere) return null;
  const file = overview.newest;
  return (
    <>
      <SectionHead>Most recent</SectionHead>
      <ul className="rec-home-list nb-list">
        <RecordingCard
          file={file}
          chip={shelfChip(file, overview.now, sttStatus[file.name])}
          current={openFileId === file.id}
          onOpen={() => onOpen(file.id)}
        />
      </ul>
    </>
  );
}

function AttentionShelf({
  overview,
  openFileId,
  onOpen,
}: {
  overview: RecordingOverview;
  openFileId: string | undefined;
  onOpen: (id: string) => void;
}) {
  if (overview.waiting.length === 0) return null;
  return (
    <>
      <SectionHead>Waiting on a transcript</SectionHead>
      <ul className="rec-home-list nb-list">
        {overview.waitingShown.map((item) => (
          <AttentionCard
            key={item.file.id}
            item={item}
            current={openFileId === item.file.id}
            onOpen={() => onOpen(item.file.id)}
          />
        ))}
      </ul>
      <AttentionOverflow count={overview.waiting.length - ATTENTION_SHOWN} />
    </>
  );
}

function AttentionOverflow({ count }: { count: number }) {
  if (count <= 0) return null;
  return <p className="rec-over-more">{count} more are waiting too — the list on the left has every one.</p>;
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
  return (
    <section className="nb-panel rec-over-now" aria-label="Happening now">
      {now && <LiveCaptureStatus now={now} recSave={recSave} files={files} onOpen={onOpen} />}
      {writingUp.length > 0 && <WritingUpStatus files={writingUp} />}
    </section>
  );
}

function LiveCaptureStatus({
  now,
  recSave,
  files,
  onOpen,
}: {
  now: CaptureNow;
  recSave: SaveDrain | null;
  files: FileMeta[];
  onOpen: (id: string) => void;
}) {
  const named = files.find((file) => file.id === now.fileId) ?? null;
  return (
    <div className="rec-over-now-line" role="status">
      <div className="rec-over-now-head">
        <span className={`nb-tape ${CAPTURE_MARK[now.phase]}`}>
          {CAPTURE_WORD[now.phase]}
        </span>
        {named && <span className="rec-over-now-title">{displayName(named.name)}</span>}
      </div>
      <p className="rec-over-now-copy">{captureDetail(now.phase, recSave)}</p>
      <div className="rec-over-now-actions">
        <button className="nb-btn" onClick={() => onOpen(now.fileId)}>
          Open the recording
        </button>
      </div>
    </div>
  );
}

function WritingUpStatus({ files }: { files: FileMeta[] }) {
  return (
    <div className="rec-over-now-line" role="status">
      <div className="rec-over-now-head">
        <span className="nb-chip nb-sem-linked">Writing up</span>
        <span className="rec-over-now-title">{writingUpName(files)}</span>
      </div>
      <p className="rec-over-now-copy">
        Being transcribed on this Mac, in the background. They stay usable while it runs.
      </p>
    </div>
  );
}

function writingUpName(files: FileMeta[]): string {
  if (files.length === 1) return displayName(files[0].name);
  return `${files.length} recordings`;
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
