import { type KeyboardEvent } from "react";
import { StopIcon } from "../icons";
import { CaptureStage, captureStage, formatTimestamp, needsPreflight } from "./recReview";
import { canCaptureInto, recordingCapabilities, retranscribePercent, recordingState, transcriptMarks, hasRecordingContent, ghostsForSpeaker } from "./recordingModel";
import type { RecordingController } from "./recordingController";

export function useRecordingPresentation(controller: RecordingController) {
  const { mediaToken, onStop, meta, fileName, partials, durationCs, selection, setSelection, correcting, setCorrecting, correction, setCorrection, noting, setNoting, noteDraft, setNoteDraft, translating, retrans, confirmRetrans, setConfirmRetrans, busy, exporting, withSystem, setWithSystem, liveLang, setLiveLang, translateTo, setTranslateTo, setPreflight, status, isLive, recordingNow, segments, cuts, turns, src, correctSelection, deleteSelection, markSelection, saveNote, runTranslate, exportTranscript, exportClean, runRetranscribe, commitLiveLang, start } = controller;

  // ---- render -------------------------------------------------------------
  // Stop first, then edit: the backend refuses rec_delete_range while the
  // file has a live session — even paused, the engine's in-memory meta would
  // overwrite the edit on its next flush.
  const canEdit = !isLive;
  /**
   * Can a capture session write into THIS file?
   *
   * A `recordings` row used to be proof that Arcelle made the file. It is not
   * any more: an imported or downloaded media file gets one too, so that it
   * opens in this view — speaker chips, click-to-rename, the waveform's lanes —
   * instead of the plain player. Capture is the one thing that does NOT carry
   * over. `rec_start` splices the new audio onto the samples it decodes out of
   * the stored file, and that decoder (`decodeWav`) reads WAV and nothing else,
   * so "Continue recording" on an imported .mp3 is the page's one red primary
   * button offering an act whose only possible answer is the engine's error
   * string — over a preflight that promises "nothing already recorded is lost"
   * about a file nothing ever recorded into.
   *
   * The name is the only container signal this view is handed (`rec_get`
   * returns it beside the meta), and it is read the way the rest of the app
   * reads a container: by extension. Every unknown defaults toward KEEPING the
   * control, because losing the record button on a real recording is a far
   * worse failure than an error toast on an import:
   *   - the name has not arrived, or `rec_get` failed  → unknown, keep it;
   *   - the name has no extension (a recording someone renamed to "Standup")
   *     → unknown, keep it;
   *   - the name ends in something that is not a container this app knows
   *     → unknown, keep it. This is the list and not `!== "wav"` for a reason:
   *     a file's name is free text a person types, so "Dr. Cohen call",
   *     "Q3 kickoff v1.2" and "2026.08.28 standup" all end in a dotted token,
   *     and reading those as containers called "cohen call", "2" and
   *     "28 standup" took the record button off three perfectly ordinary
   *     recordings — the very failure this note calls the worse one.
   * Only a name positively stating some OTHER container takes the capture
   * cluster away. And a live session on this very file is proof by
   * demonstration that capture works here, whatever the name says.
   */
  const capturable = canCaptureInto(isLive, fileName);
  const hasWords = segments.some((s) => s.words.length > 0);
  // Anything actually cut. `hasWords` is true of every word-timed transcript,
  // edited or not, so gating "Show deleted" on it put a permanent checkbox
  // with nothing to reveal beside the search box. One predicate, so the
  // checkbox and "Export edited copy" can never disagree about it.
  const hasDeleted = segments.some((s) => s.words.some((w) => w.del));
  // Audio already in the file — a recording with sound but no transcript lines
  // (live transcription off, or a silent stretch) is still CONTINUED, never
  // started over, and the button must not suggest otherwise. Length is the only
  // honest signal: the backend hands this viewer a media token for EVERY
  // recording file, including one whose stored audio is a bare WAV header, so
  // OR-ing it in made "Start recording" unreachable and left the button
  // contradicting the empty-state panel right below it.
  const { hasAudio, canRetranscribe, rebuildOnlyInDrawer } = recordingCapabilities(
    isLive,
    durationCs,
    mediaToken,
  );
  // mediaToken too: a corrupted (unparseable) meta reads as durationCs 0,
  // and re-transcribe is the rescue tool for exactly that file.
  /** The empty transcript panel offers the rebuild itself, but only on the
   * `finished` reading of the file — which needs a duration. A file whose meta
   * lost its duration reads as `fresh`, so the drawer stays its one route to
   * the tool that rescues it. */
  // The real media file, not a derived duration stored in old recording
  // metadata, decides whether playback is available. Converted legacy rooms
  // can contain a valid recording whose old `durationCs` is missing or zero;
  // refusing to mount the audio element made that perfectly good normal file
  // impossible to play or measure. Once metadata loads below, it repairs the
  // in-memory duration used by the clock and seek controls.
  const canPlay = !!src;
  /** The re-transcribe figure the engine actually reported, written once so
   * the three places that show it cannot round it differently. */
  const retransPct = retranscribePercent(retrans);
  const voices = new Set(segments.map((s) => s.speaker)).size;
  // Anything already in this file: audio, or — for a file whose meta lost its
  // duration — transcribed words. The button's label and the capture stage
  // read the SAME fact, so "Continue recording" can never sit above a page
  // that thinks nothing has been recorded here yet.
  const everRecorded = hasRecordingContent(hasAudio, segments);
  const stage: CaptureStage = captureStage(status, everRecorded);
  const marks = transcriptMarks(meta, durationCs);
  /** The one-word state of the transcript, drawn as a tape label. Colour rides
   * with the word, never instead of it. */
  const state = recordingState(status, recordingNow, hasAudio, segments);

  // One "still speaking…" ghost per lane. A ghost whose speaker matches the
  // last turn renders inside it (the same voice, mid-sentence); the rest —
  // including everything when there are no finals yet — stand alone.
  //
  // The MIC lane's `speaker` is the machine LABEL, exactly as on a finished
  // turn, so its ghost is drawn through speakerName() too — otherwise renaming
  // "You" left the line being spoken right now under the old name, the same
  // person appearing twice in one transcript.
  //
  // The Mac's audio lane has no label to give: its finals arrive as "Speaker N"
  // once the engine has clustered the voice. "Meeting" was drawn as if it were
  // one — Speaker 1's colour, a name no rename could ever reach — and a moment
  // later the same words reappeared as a differently-coloured "Speaker 3". It
  // is provisional, so it is presented as provisional and claims no speaker.
  const ghosts = (["mic", "sys"] as const).flatMap((lane) => {
    const text = partials[lane];
    if (!text) return [];
    return [{ lane, speaker: lane === "mic" ? "You" : null, text }];
  });
  const lastTurn = turns[turns.length - 1];
  const attachedGhosts = ghostsForSpeaker(lastTurn?.speaker, ghosts);
  const standaloneGhosts = ghosts.filter((g) => !attachedGhosts.includes(g));

  /** The transport's primary control is always about the SESSION — start it,
   * or stop it — and it is the one place in this view that wears red.
   *
   * On a finished recording it opens the capture choices instead of starting
   * straight away: those choices (the Mac's audio, live translate) apply to
   * the session it is about to begin, and leaving them on screen for a
   * recording that ended was the P1 — review controls and capture controls
   * side by side, with nothing to say which was which. */
  const primary = primaryAction();

  function primaryAction() {
    if (recordingNow || status === "paused") {
      return { cls: "rec-record is-stopping", label: "Stop & save", title: "Stop recording and save this file", glyph: <StopIcon size={14} />, expands: false, run: () => void onStop() };
    }
    const continuing = everRecorded;
    const expands = needsPreflight(stage);
    const run = () => {
      if (expands) setPreflight((open) => !open);
      else void start();
    };
    return { cls: "rec-record", label: continuing ? "Continue recording" : "Start recording", title: continuing ? "Keep recording into this file — nothing already recorded is lost" : "Record the microphone, and the Mac's own audio, into this file", glyph: null, expands, run };
  }

  /** The choices a capture STARTS with. Written once and drawn in exactly one
   * of two places — inline on a file nobody has recorded into yet, or inside
   * the preflight when a finished recording is being continued. Two copies of
   * a checkbox bound to one state is two controls that can look different. */
  const captureChoices = (
    <>
      <label
        className="rec-opt"
        title="Hear whatever the Mac plays — Google Meet, Zoom, Teams, Slack calls, videos"
      >
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
  );

  const liveTranslateOpt = (
    <label
      className="rec-opt"
      // Live translation runs on the ROOM's chosen model, exactly like the
      // Translate box in the drawer (recording.rs `room_translation_model`).
      // This used to say "(on this Mac)", which is the opposite of what happens
      // in a cloud room: there, every finished sentence of a live meeting is
      // sent to the provider for as long as the box is set. The status bar's
      // trust chip says which kind of room this is; the control must not
      // contradict it.
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
  );

  function SelectionBar() {
    if (!selection || !canEdit) return null;
    return (
      <div className="rec-selectbar">
        <SelectionSummary />
        <SelectionEditor />
      </div>
    );
  }

  function SelectionSummary() {
    if (!selection) return null;
    return (
      <span className="rec-selectbar-what">
        <b>{selection.words}</b> word{selection.words > 1 ? "s" : ""}{" "}
        <span className="nb-num">
          {formatTimestamp(selection.t0)}–{formatTimestamp(selection.t1)}
        </span>
      </span>
    );
  }

  function SelectionEditor() {
    if (noting) return <NoteEditor />;
    if (correcting) return <CorrectionEditor />;
    return <SelectionActions />;
  }

  function NoteEditor() {
    const cancel = () => {
      setNoting(false);
      setNoteDraft("");
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") void saveNote();
      if (e.key === "Escape") cancel();
    };
    return (
      <>
        <input
          autoFocus
          className="rec-correct-input"
          placeholder="What about this moment…"
          aria-label="Your note"
          data-testid="note-input"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="nb-btn" disabled={!noteDraft.trim()} onClick={() => void saveNote()}>
          Save note
        </button>
        <button className="nb-btn nb-btn-quiet" onClick={cancel}>Cancel</button>
      </>
    );
  }

  function CorrectionEditor() {
    const cancel = () => {
      setCorrecting(false);
      setCorrection("");
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") void correctSelection();
      if (e.key === "Escape") cancel();
    };
    return (
      <>
        <input
          autoFocus
          className="rec-correct-input"
          placeholder="What was actually said…"
          aria-label="Corrected words"
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="nb-btn" disabled={!correction.trim()} onClick={() => void correctSelection()}>
          Save correction
        </button>
        <button className="nb-btn nb-btn-quiet" onClick={cancel}>Cancel</button>
      </>
    );
  }

  function SelectionActions() {
    const beginNote = () => {
      setNoteDraft("");
      setNoting(true);
    };
    const beginCorrection = () => {
      setCorrection("");
      setCorrecting(true);
    };
    return (
      <>
        <button className="nb-btn" title="Mark this stretch so you can find it again" data-testid="mark-selection" onClick={() => void markSelection()}>
          Mark
        </button>
        <button className="nb-btn" title="Write a note about this moment" data-testid="note-selection" onClick={beginNote}>
          Note here
        </button>
        <button className="nb-btn" title="Retype what this actually says. The audio is untouched." onClick={beginCorrection}>
          Fix the words
        </button>
        <button className="nb-btn nb-btn-danger" onClick={() => void deleteSelection()}>
          Delete from recording
        </button>
        <button className="nb-btn nb-btn-quiet" onClick={() => setSelection(null)}>Keep</button>
      </>
    );
  }

  function drawerActivityText(): string {
    if (translating === "starting") return "Translating…";
    if (translating) return `Translating ${translating.done}/${translating.total}…`;
    if (retransPct !== null) return `Re-transcribing ${retransPct}%…`;
    return "Exporting edited copy…";
  }

  function DrawerActivity() {
    if (!translating && !retrans && !exporting) return null;
    return <span className="nb-tape nb-sem-linked rec-drawer-run">{drawerActivityText()}</span>;
  }

  function TranslateTool() {
    if (segments.length === 0) return null;
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") void runTranslate();
    };
    const label = translating === "starting"
      ? "Translating…"
      : translating
        ? `Translating ${translating.done}/${translating.total}…`
        : "Translate";
    return (
      <span className="rec-tool">
        <input
          list="rec-langs"
          placeholder="Translate into…"
          aria-label="Translate the transcript into"
          value={translateTo}
          disabled={busy}
          onChange={(e) => setTranslateTo(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="nb-btn" disabled={busy || !translateTo.trim()} onClick={() => void runTranslate()}>
          {label}
        </button>
      </span>
    );
  }

  function RetranscribeTool() {
    if (!canRetranscribe) return null;
    if (!confirmRetrans) {
      return (
        <button
          className="nb-btn"
          disabled={busy}
          title="Rebuild the transcript from the audio with the current pipeline — fixes recordings saved with garbled words, the wrong language, or old speaker labels"
          onClick={() => setConfirmRetrans(true)}
        >
          {retransPct !== null ? `Re-transcribing ${retransPct}%…` : "Re-transcribe"}
        </button>
      );
    }
    return (
      <span className="rec-tool rec-retrans-confirm">
        <span>
          Rebuild the whole transcript from the audio? The current one moves to History; the audio is untouched.
          <RetranscribeSpeakerWarning />
        </span>
        <button className="nb-btn nb-btn-danger" onClick={() => void runRetranscribe()}>Re-transcribe</button>
        <button className="nb-btn nb-btn-quiet" onClick={() => setConfirmRetrans(false)}>Cancel</button>
      </span>
    );
  }

  function RetranscribeSpeakerWarning() {
    if (Object.keys(meta?.speakerNames ?? {}).length === 0) return null;
    return <b> The voices are re-numbered from scratch, so check the names you gave them afterwards.</b>;
  }

  function TranscriptExports() {
    if (segments.length === 0 || isLive) return null;
    const subtitlesTitle = cuts.length > 0
      ? "Save subtitles (.srt) into this room — timed for the edited copy, since they caption only the words you kept"
      : "Save subtitles (.srt) into this room — for a video editor or a player";
    return (
      <>
        <button className="nb-btn" disabled={busy} title="Save the transcript into this room as a plain text file — timestamps are this recording's own" onClick={() => void exportTranscript("text")}>
          Export transcript
        </button>
        <button className="nb-btn" disabled={busy} title={subtitlesTitle} onClick={() => void exportTranscript("srt")}>
          Export subtitles
        </button>
      </>
    );
  }

  function CleanExport() {
    if (!hasWords) return null;
    return (
      <button className="nb-btn" disabled={busy || (!cuts.length && !hasDeleted)} title="Save a copy with the deleted words really cut out of the audio" onClick={() => void exportClean()}>
        {exporting ? "Exporting edited copy…" : "Export edited copy"}
      </button>
    );
  }

  function RemovedCuts() {
    if (cuts.length === 0) return null;
    return (
      <div className="rec-cuts">
        <hr className="nb-rule-dash" />
        <h4>Removed spans</h4>
        <ul>{cuts.map((c, i) => <li key={i} className="rec-cut"><span className="nb-tape nb-sem-urgent rec-cut-tag">Cut</span><span className="nb-num rec-cut-at">{formatTimestamp(c.t0)}–{formatTimestamp(c.t1)}</span><span className="nb-num rec-cut-len">{formatTimestamp(Math.max(0, c.t1 - c.t0))}</span></li>)}</ul>
        <p className="rec-cuts-note">Still in the file — playback skips them. “Export edited copy” writes a version with them really removed.</p>
      </div>
    );
  }

  function RecordingDrawer() {
    if (segments.length === 0 && !rebuildOnlyInDrawer) return null;
    return (
      <details className="rec-drawer">
        <summary className="rec-drawer-head">
          <span className="rec-drawer-caret" aria-hidden="true" />
          <span className="rec-drawer-title">Export &amp; rebuild</span>
          <span className="rec-drawer-hint">Transcript, subtitles, edited copy, translation, re-transcribe</span>
          <DrawerActivity />
        </summary>
        <div className="rec-tools"><TranslateTool /><RetranscribeTool /><TranscriptExports /><CleanExport /></div>
        <RemovedCuts />
      </details>
    );
  }
  return { ...controller,
    canEdit,
    capturable,
    hasWords,
    hasDeleted,
    hasAudio,
    canRetranscribe,
    rebuildOnlyInDrawer,
    canPlay,
    retransPct,
    voices,
    everRecorded,
    stage,
    marks,
    state,
    ghosts,
    lastTurn,
    attachedGhosts,
    standaloneGhosts,
    primary,
    primaryAction,
    captureChoices,
    liveTranslateOpt,
    SelectionBar,
    SelectionSummary,
    SelectionEditor,
    NoteEditor,
    CorrectionEditor,
    SelectionActions,
    drawerActivityText,
    DrawerActivity,
    TranslateTool,
    RetranscribeTool,
    RetranscribeSpeakerWarning,
    TranscriptExports,
    CleanExport,
    RemovedCuts,
    RecordingDrawer
  };
}

export type RecordingPresentation = ReturnType<typeof useRecordingPresentation>;
