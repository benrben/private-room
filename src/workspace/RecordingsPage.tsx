import { formatSize, isRecordingFile, type FileMeta, type RoomInfo } from "../api";
import { MicIcon } from "../icons";
import { displayName, formatWhen } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { useAdaptiveText } from "./adaptiveText";

/** The Recordings landing page.
 *
 * This used to be the generic empty-viewer composition — a 40px microphone
 * centred in the pane over two buttons — which said the same thing whether the
 * room held nothing or held forty recordings. What a reader arriving here
 * wants is the room's own tape shelf: what was captured, when, and whether it
 * has been written down yet.
 *
 * ON WHAT THE CARDS DO NOT SHOW. The brief asks a recording card for duration,
 * speakers and a waveform. None of the three is in the file list: `FileMeta`
 * carries a name, a size, a created-at and whether text was extracted, and
 * length only exists once something has read the container. Drawing a plausible
 * waveform behind each card, or a length guessed from the byte count, would
 * put a picture of the reader's own audio on screen that the file never said —
 * the exact failure `mediaMeta.ts` is written to avoid ("a plausible default is
 * indistinguishable from a fact once it is on screen"). So the card shows the
 * four things the list actually knows, and the detail view — which does read
 * the file — is still where the waveform lives. */
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
  const liveId = s.recLive?.fileId ?? null;
  const noteMic = a.micState("note");

  // A1 "living dek": the static subtitle below is always the fallback (RULE
  // 1/3/8) — this only ever REPLACES it visually when a fresh sentence is
  // ready. Facts are exactly what the shelf itself already knows: how many
  // tapes, how many are written up, and the newest one's name — the same
  // three things `RecordingCard` renders, never anything fetched fresh for
  // this purpose (RULE 4/10). Gated on having at least one recording — an
  // empty shelf has nothing true to say beyond the static line.
  const newest = recs[0] ?? null;
  const transcribedCount = recs.filter((f) => f.hasText).length;
  const recDekFacts = newest
    ? {
        count: recs.length,
        transcribedCount,
        newestName: displayName(newest.name),
        recordingNow: liveId != null,
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
        {recs.length > 0 && (
          <span className="nb-circled nb-sem-saved rec-home-count">
            {recs.length}
          </span>
        )}
        <p className="nb-subtitle rec-home-sub">
          {recDek ?? "Captured here, transcribed here"}
        </p>
      </header>

      {/* The two ways in, told apart. They are genuinely different captures —
          one takes the Mac's own output as well as the mic — and side by side
          with a line each is the only place in the app that says so. The left
          pane repeats them as compact rows so a capture can still be started
          while a recording is open; that is a navigator echoing the page, not
          the same control drawn twice in one view. */}
      <div className="rec-home-start">
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
              The mic and the Mac's own audio together, with the transcript
              appearing as it runs.
            </span>
          </span>
        </button>
        <button
          className="rec-record rec-home-action"
          disabled={noteMic.disabled}
          onClick={() => a.recordVoiceNote()}
        >
          <span className="rec-record-ring is-quiet" aria-hidden>
            <MicIcon size={16} />
          </span>
          <span className="rec-home-action-main">
            <span className="rec-record-word">Voice note</span>
            <span className="rec-home-action-copy">
              Just the mic. Saved into this room and written up afterwards.
            </span>
          </span>
        </button>
      </div>

      <div className="rec-home-shelf-head">
        <span className="group-heading">In this room</span>
        <hr className="nb-rule rec-home-rule" />
      </div>

      {recs.length === 0 ? (
        // A direction, in the margin voice — not a picture of a microphone.
        <p className="nb-note rec-home-empty">
          Nothing captured yet. Start one above — or drag in audio and video
          files, which write themselves up in the background.
        </p>
      ) : (
        <ul className="rec-home-list nb-list">
          {recs.map((f) => (
            <RecordingCard
              key={f.id}
              file={f}
              live={f.id === liveId}
              current={s.openFile?.id === f.id}
              onOpen={() => void a.viewFile(f.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One tape on the shelf. Every value shown is read off the file list; see the
 * note at the head of this file about the ones that are not. */
function RecordingCard({
  file,
  live,
  current,
  onOpen,
}: {
  file: FileMeta;
  live: boolean;
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
            colour alone: each chip carries the word as well. Red is reserved
            for a capture that is running right now, which is the one urgent
            thing this page can be showing. */}
        {live ? (
          <span className="nb-tape nb-sem-urgent rec-home-state">
            Recording now
          </span>
        ) : file.hasText ? (
          <span className="nb-chip nb-sem-done rec-home-state">Transcribed</span>
        ) : (
          <span className="nb-chip nb-sem-pending rec-home-state">
            No transcript yet
          </span>
        )}
      </button>
    </li>
  );
}
