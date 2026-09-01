import { openUrl } from "../platform";
import Waveform, { WAVE_HEIGHT_LARGE } from "./Waveform";
import { type RecWord } from "../api";
import { PauseIcon, PlayIcon } from "../icons";
import { PLAYBACK_RATES, clampVolume, formatTimestamp, needsPreflight, rateLabel, seekLabel, showsChoicesInline } from "./recReview";
import { SCREEN_CAPTURE_SETTINGS_URL, LANGS, TABS, speakerTone, SpeakerChip, ReadPanel } from "./RecordingView";
import { TurnSeg, Turn } from "./recordingModel";
import type { RecordingController } from "./recordingController";
import { useRecordingPresentation } from "./recordingPresentation";

export function RecordingSurface({ controller }: { controller: RecordingController }) {
  const presentation = useRecordingPresentation(controller);
  const { fileId, saveProgress, pushToast, onPause, onResume, meta, partials, levels, durationCs, setDurationCs, liveTranslations, sysNote, micNote, showDeleted, setShowDeleted, selection, reading, busy, activeSeg, withSystem, micIsMuted, liveStt, tab, setTab, playing, setPlaying, playbackError, setPlaybackError, playCs, volume, rate, setVolume, setRate, preflight, setPreflight, query, setQuery, findSeg, listRef, listEndRef, panelRef, tabRefs, status, isLive, recordingNow, segments, cuts, turns, speakerRegions, found, quotes, src, mediaEl, rememberMedia, skipTimerRef, armCutSkip, onTime, seek, scrubTo, showInTranscript, askVolume, askRate, togglePlay, captureSelection, markNow, addChapterHere, deleteItem, tabCount, startReading, speakerName, speakerGuessed, renameSpeaker, toggleMicMute, toggleLiveStt, runRetranscribe, onTabKey, start, canEdit, capturable, hasDeleted, canRetranscribe, canPlay, retransPct, voices, stage, marks, state, lastTurn, attachedGhosts, standaloneGhosts, primary, captureChoices, liveTranslateOpt, SelectionBar, RecordingDrawer } = presentation;


  function SavingStatus() {
    const message = saveProgress?.stage === "writing"
      ? "Audio saved — writing the recording into the room…"
      : saveProgress
        ? `Audio saved — finishing the transcript${saveProgress.remaining > 0 ? ` (${saveProgress.remaining} to go)` : "…"}`
        : "Saving…";
    return <span className="rec-live-chip saving">{message}<span className="rec-save-note">You can keep working — this finishes on its own.</span></span>;
  }

  function TransportStart() {
    return <div className="rec-transport-side"><LiveChip /><MarkNowButton /><PausedStatus /><SavingIndicator /><PlaybackClock /></div>;
  }

  function LiveChip() {
    if (!recordingNow) return null;
    return <span className="rec-live-chip"><span className="rec-dot pulsing" aria-hidden="true" /> REC <b className="nb-num">{formatTimestamp(durationCs)}</b></span>;
  }

  function MarkNowButton() {
    if (!recordingNow && status !== "paused") return null;
    return <button className="nb-btn rec-mark-now" data-testid="mark-now" title="Mark what was just said, so you can find it afterwards" onClick={() => void markNow()}>Mark this moment</button>;
  }

  function PausedStatus() {
    if (status !== "paused") return null;
    return <span className="rec-live-chip paused">Paused at <b className="nb-num">{formatTimestamp(durationCs)}</b></span>;
  }

  function SavingIndicator() {
    if (status !== "saving") return null;
    return <SavingStatus />;
  }

  function PlaybackClock() {
    if (isLive || !canPlay) return null;
    return <span className="rec-clock nb-num">{formatTimestamp(playCs)} <i>/</i> {formatTimestamp(durationCs)}</span>;
  }

  function TransportMain() {
    return (
      <div className="rec-transport-main">
        <PlaybackButton />
        <SessionPauseButton />
        <SessionResumeButton />
        <SessionPrimaryButton />
      </div>
    );
  }

  function PlaybackButton() {
    if (isLive || !canPlay) return null;
    return <button className="rec-tbtn" aria-label={playing ? "Pause playback" : "Play the recording"} title={playing ? "Pause" : "Play"} onClick={togglePlay}>{playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}</button>;
  }

  function SessionPauseButton() {
    if (!recordingNow) return null;
    return <button className="rec-tbtn" aria-label="Pause recording" title="Pause recording" onClick={() => void onPause()}><PauseIcon size={14} /></button>;
  }

  function SessionResumeButton() {
    if (status !== "paused") return null;
    return <button className="rec-tbtn" aria-label="Resume recording" title="Resume recording" onClick={() => void onResume()}><PlayIcon size={14} /></button>;
  }

  function SessionPrimaryButton() {
    if (status === "saving" || !capturable) return null;
    return (
      <button className={primary.cls} title={primary.title} onClick={primary.run} aria-expanded={primary.expands ? preflight : undefined} aria-controls={primary.expands ? "rec-preflight" : undefined}>
        <span className="rec-record-ring" aria-hidden="true">{primary.glyph ?? <span className="rec-record-dot" />}</span>
        <span className="rec-record-word">{primary.label}</span>
      </button>
    );
  }

  function Meters() {
    return <span className="rec-meters" title="Microphone / Mac audio levels"><span className="rec-meter" title="Your microphone — your own voice"><i>Mic</i><span className="rec-meter-track"><b style={{ width: `${micIsMuted ? 0 : Math.min(100, levels.mic * 400)}%` }} /></span></span><span className="rec-meter" title="The Mac's own audio — the meeting or video playing on this computer"><i>Mac</i><span className="rec-meter-track"><b style={{ width: `${Math.min(100, levels.sys * 400)}%` }} /></span></span></span>;
  }

  function MuteControl() {
    if (!recordingNow) return null;
    return <><MuteButton /><Meters /></>;
  }

  function muteTitle(): string {
    if (micIsMuted) return "Unmute the microphone";
    if (withSystem && !sysNote) return "Mute the microphone (the Mac's audio keeps recording)";
    return "Mute the microphone — the Mac's audio is not being recorded, so nothing at all will be captured while muted";
  }

  function MuteButton() {
    const action = micIsMuted ? "Unmute the microphone" : "Mute the microphone";
    return <button className={`rec-mute ${micIsMuted ? "muted" : ""}`} title={muteTitle()} aria-label={action} aria-pressed={micIsMuted} onClick={toggleMicMute}><span aria-hidden="true">🎙</span></button>;
  }

  function PlaybackDials() {
    if (isLive || !canPlay) return null;
    return <><span className="rec-dial" title="Playback volume"><i aria-hidden="true">🔈</i><input type="range" className="rec-vol" min={0} max={1} step={0.05} value={volume} aria-label="Volume" aria-valuetext={`${Math.round(volume * 100)}%`} onChange={(e) => askVolume(Number(e.target.value))} /></span><span className="rec-dial" title="Playback speed"><select className="rec-speed" aria-label="Playback speed" value={rate} onChange={(e) => askRate(Number(e.target.value))}>{PLAYBACK_RATES.map((r) => <option key={r} value={r}>{rateLabel(r)}</option>)}</select></span></>;
  }

  function TransportEnd() {
    return <div className="rec-transport-side rec-transport-end"><MuteControl /><PlaybackDials /></div>;
  }

  function TransportScrub() {
    if (isLive || !canPlay) return null;
    return <div className="rec-scrub"><span className="rec-seekmarks" aria-hidden="true">{marks.map((m) => <span key={m.key} className={`rec-seekmark is-${m.kind}`} style={{ left: `${m.atPct}%` }} title={m.title} />)}</span><input type="range" className="rec-seek" min={0} max={Math.max(1, durationCs)} step={100} value={Math.min(playCs, durationCs)} aria-label="Seek in the recording" aria-valuetext={seekLabel(playCs, durationCs)} onChange={(e) => scrubTo(Number(e.target.value))} /></div>;
  }

  function LiveTranscriptionToggle() {
    if (!isLive) return null;
    return <label className="rec-opt" title="Turn off to keep recording audio without writing live text — rebuild the missing part later with Re-transcribe"><input type="checkbox" checked={liveStt} onChange={(e) => void toggleLiveStt(e.target.checked)} />Live transcription</label>;
  }

  function IdleCaptureChoices() {
    if (status !== "idle") return null;
    return <>{captureChoices}</>;
  }

  function SessionOptions() {
    if (!capturable || !showsChoicesInline(stage)) return null;
    return <div className="rec-options"><IdleCaptureChoices /><LiveTranscriptionToggle />{liveTranslateOpt}</div>;
  }

  function CapturePreflight() {
    if (!capturable || !needsPreflight(stage) || !preflight) return null;
    return <div className="rec-preflight" id="rec-preflight" data-testid="rec-preflight"><p className="rec-preflight-lead">Continue recording into this file — nothing already recorded is lost. These apply to the new stretch:</p><div className="rec-options">{captureChoices}{liveTranslateOpt}</div><div className="rec-preflight-go"><button className="nb-btn" data-testid="rec-preflight-start" onClick={() => void start()}>Continue recording</button><button className="nb-btn nb-btn-quiet" onClick={() => setPreflight(false)}>Cancel</button></div></div>;
  }

  function SystemAudioBanner() {
    if (!sysNote || !isLive) return null;
    const openSettings = () => void openUrl(SCREEN_CAPTURE_SETTINGS_URL).catch((e) => pushToast("error", String(e)));
    return <div className="rec-sys-banner" role="alert"><span className="rec-sys-banner-text">{sysNote}</span><button onClick={openSettings}>Open System Settings</button><span className="rec-sys-banner-note">After granting, quit and reopen Arcelle — macOS applies the permission only to a fresh launch.</span></div>;
  }

  function MicBanner() {
    if (!micNote || !isLive) return null;
    return <div className="rec-sys-banner" role="alert"><span className="rec-sys-banner-text">{micNote}</span></div>;
  }

  function PlaybackBanner() {
    if (!playbackError || isLive) return null;
    return <div className="rec-sys-banner" role="alert"><span className="rec-sys-banner-text">{playbackError}</span></div>;
  }

  function StageBanners() {
    return <><SystemAudioBanner /><MicBanner /><PlaybackBanner /></>;
  }

  function RecordingWaveform() {
    if (!canPlay) return null;
    const mark = selection ? { start: selection.t0 / 100, end: selection.t1 / 100 } : null;
    const highlights = (meta?.highlights ?? []).map((h) => ({ start: h.t0 / 100, end: h.t1 / 100 }));
    const chapters = (meta?.chapters ?? []).map((c) => ({ at: c.t0 / 100, title: c.title }));
    return <Waveform fileId={fileId} media={mediaEl} regions={speakerRegions} height={WAVE_HEIGHT_LARGE} lanes mark={mark} marks={highlights} chapters={chapters} />;
  }

  function PlaybackElement() {
    if (!canPlay) return null;
    const updateDuration = (e: React.SyntheticEvent<HTMLAudioElement>) => {
      const seconds = e.currentTarget.duration;
      if (durationCs <= 0 && Number.isFinite(seconds) && seconds > 0) setDurationCs(Math.round(seconds * 100));
    };
    const onPlay = () => {
      setPlaybackError("");
      setPlaying(true);
      armCutSkip();
    };
    const onError = () => {
      setPlaying(false);
      setPlaybackError("This recording could not be played. Its file is still safe.");
    };
    const onRateChange = (e: React.SyntheticEvent<HTMLAudioElement>) => {
      setRate(e.currentTarget.playbackRate);
      armCutSkip();
    };
    const onPause = () => {
      setPlaying(false);
      window.clearTimeout(skipTimerRef.current);
    };
    return <audio ref={rememberMedia} className="rec-player" src={src ?? undefined} onTimeUpdate={() => { onTime(); armCutSkip(); }} onPlay={onPlay} onLoadedMetadata={updateDuration} onCanPlay={() => setPlaybackError("")} onError={onError} onSeeked={armCutSkip} onVolumeChange={(e) => setVolume(clampVolume(e.currentTarget.volume))} onRateChange={onRateChange} onPause={onPause} onEnded={() => setPlaying(false)} />;
  }

  function RecordingFacts() {
    return <div className="rec-facts"><span className="rec-fact"><i>Length</i><b className="nb-num">{formatTimestamp(durationCs)}</b></span><VoiceFact /><CutFact /><span className={`nb-tape rec-state ${state.mark}`}>{state.word}</span>{PlaybackElement()}</div>;
  }

  function VoiceFact() {
    if (voices === 0) return null;
    return <span className="rec-fact"><i>Voices</i><b className="nb-num">{voices}</b></span>;
  }

  function CutFact() {
    if (cuts.length === 0) return null;
    return <span className="rec-fact"><i>Removed</i><b className="nb-num">{cuts.length}</b></span>;
  }

  function TabButton({ item, index }: { item: (typeof TABS)[number]; index: number }) {
    const count = tabCount(item.id);
    const selected = tab === item.id;
    return <button ref={(el) => { tabRefs.current[index] = el; }} role="tab" id={`rec-tab-${item.id}`} aria-selected={selected} aria-controls={`rec-panel-${item.id}`} tabIndex={selected ? 0 : -1} className={`rec-tab${selected ? " is-on nb-underline" : ""}`} onClick={() => setTab(item.id)} onKeyDown={onTabKey}>{item.label}<TabCount count={count} /></button>;
  }

  function TabCount({ count }: { count: number }) {
    if (count === 0) return null;
    return <span className="nb-circled rec-tab-count">{count}</span>;
  }

  function RecordingTabs() {
    return <div className="rec-tabs" role="tablist" aria-label="Recording views">{TABS.map((item, index) => <TabButton key={item.id} item={item} index={index} />)}</div>;
  }

  function SearchStatus() {
    if (!found.searching) return null;
    const message = found.phrases === 0 ? "no matches" : `${found.phrases} phrase${found.phrases === 1 ? "" : "s"}`;
    return <span className="rec-search-count" role="status">{message}</span>;
  }

  function TranscriptSearch() {
    if (tab !== "transcript" || recordingNow || turns.length === 0) return null;
    return <span className="rec-opt rec-search"><input type="search" value={query} placeholder="Find in transcript…" aria-label="Find in the transcript" data-testid="rec-search" onChange={(e) => setQuery(e.target.value)} /><SearchStatus /></span>;
  }

  function DeletedToggle() {
    if (!hasDeleted || tab !== "transcript") return null;
    return <label className="rec-opt"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />Show deleted</label>;
  }

  function RecordingTabBar() {
    return <div className="rec-tabbar"><RecordingTabs /><div className="rec-tabbar-end"><TranscriptSearch /><DeletedToggle /></div></div>;
  }

  function TranscriptStamp({ t0 }: { t0: number }) {
    if (!canPlay) return <span className="rec-stamp nb-num">{formatTimestamp(t0)}</span>;
    return <button className="rec-stamp nb-num" title="Play from here" aria-label={`Play from ${formatTimestamp(t0)}`} onClick={() => seek(t0)}>{formatTimestamp(t0)}</button>;
  }

  function TranscriptWord({ word, index }: { word: RecWord; index: number }) {
    const place = canPlay ? () => { if (window.getSelection()?.isCollapsed) scrubTo(word.t0); } : undefined;
    if (word.del) return <del key={index} data-t0={word.t0} data-t1={word.t1} className="rec-word deleted" onClick={place}>{word.w} </del>;
    return <span key={index} data-t0={word.t0} data-t1={word.t1} className="rec-word" onClick={place}>{word.w} </span>;
  }

  function TranscriptTranslation({ text }: { text: string | undefined }) {
    if (!text) return null;
    return <span className="rec-translation" dir="auto">{text}</span>;
  }

  function TranscriptLine({ turn, phrase }: { turn: Turn; phrase: TurnSeg }) {
    const { seg, visible, text } = phrase;
    const className = `rec-line${activeSeg === seg.id ? " is-active" : ""}${found.hits.has(seg.id) ? " is-hit" : ""}${findSeg === seg.id ? " is-found" : ""}`;
    return <div key={seg.id} data-seg={seg.id} className={className}><TranscriptStamp t0={seg.t0} /><div className="rec-line-text" dir={turn.dir}><span className={`rec-seg ${activeSeg === seg.id ? "active" : ""}`} dir="auto">{visible ? visible.map((word, index) => <TranscriptWord key={index} word={word} index={index} />) : text}<TranscriptTranslation text={liveTranslations[seg.id]} /></span></div></div>;
  }

  function InlineGhosts({ ghosts }: { ghosts: typeof attachedGhosts }) {
    return <>{ghosts.map((ghost) => <div key={ghost.lane} className="rec-line"><span className="rec-stamp nb-num" aria-hidden="true">…</span><div className="rec-line-text" dir="auto"><span className="rec-seg ghost" dir="auto">{ghost.text}</span></div></div>)}</>;
  }

  function TranscriptTurn({ turn }: { turn: Turn }) {
    const ghosts = turn.key === lastTurn?.key ? attachedGhosts : [];
    return <div className="rec-turn"><div className="rec-turn-head"><SpeakerChip label={turn.speaker} name={speakerName(turn.speaker)} tone={speakerTone(turn.speaker)} guessed={speakerGuessed(turn.speaker)} onRename={(next) => void renameSpeaker(turn.speaker, next)} /></div>{turn.segs.map((phrase) => <TranscriptLine key={phrase.seg.id} turn={turn} phrase={phrase} />)}<InlineGhosts ghosts={ghosts} /></div>;
  }

  function TranscriptTurns() {
    return <>{found.turns.map((turn) => <TranscriptTurn key={turn.key} turn={turn} />)}</>;
  }

  function ReadTab({ kind, empty, blank }: { kind: "notes" | "highlights" | "chapters"; empty: string; blank: string }) {
    if (tab !== kind) return null;
    return <ReadPanel kind={kind} meta={meta} quotes={quotes} reading={reading} hasTranscript={segments.length > 0} onRead={() => void startReading()} onSeek={seek} onJump={showInTranscript} onAddChapter={(title) => void addChapterHere(title)} onDelete={(itemKind, index) => void deleteItem(itemKind, index)} empty={empty} blank={blank} />;
  }

  function NoTranscriptMatches() {
    if (!found.searching || found.turns.length > 0 || segments.length === 0) return null;
    return <p className="rec-find-none" data-testid="rec-find-none">No phrase in this transcript contains “{query.trim()}”.</p>;
  }

  function TranscriptEditingHint() {
    if (!canEdit) return null;
    return <> Select words above to correct them, or to delete them from the recording.</>;
  }

  function TranscriptNote() {
    if (segments.length === 0) return null;
    return <p className="rec-read-note">Click a speaker’s name to say who they were.<TranscriptEditingHint /></p>;
  }

  function TranscriptEmpty() {
    if (segments.length > 0 || partials.mic || partials.sys) return null;
    return <div className="rec-empty"><EmptyTranscriptMessage /></div>;
  }

  function EmptyTranscriptMessage() {
    if (stage === "fresh" && capturable) return <FreshTranscriptMessage />;
    if (isFinishedTranscriptState()) return <FinishedTranscriptMessage />;
    if (stage === "paused") return <p className="rec-empty-lead">Paused — nothing is being recorded. Resume above to keep going.</p>;
    if (stage === "saving") return <p className="rec-empty-lead">Saving — the audio is already safe; the transcript is finishing.</p>;
    return <p className="rec-empty-lead">Listening… speak, or bring the meeting on.</p>;
  }

  function isFinishedTranscriptState() {
    return stage === "finished" || !capturable;
  }

  function FreshTranscriptMessage() {
    return <><p className="rec-empty-lead"><strong>This file records and understands speech — live.</strong></p><p>Press <em>Start recording</em>: your words (and, with the Mac’s-audio option on, whatever the Mac plays — a Google Meet, Zoom, Teams or Slack call) appear here as text while people are still speaking, with speakers told apart.</p><p>Afterwards, edit the audio by editing the text (select words → delete), run any AI action on it, or translate the whole thing. Speech is recognised on this Mac; AI actions, translation, and the room's own reading of a finished recording — which starts by itself when you press Stop — use the room's model, and the trust chip in the status bar says whether that one is local or in the cloud.</p></>;
  }

  function FinishedTranscriptMessage() {
    const explanation = capturable ? "Live transcription may have been off while it was made, or the speech model missing at the time. Writing it up rebuilds the words from the audio this file already holds — on this Mac, and the audio is untouched." : "Writing it up reads the words out of the audio this file already holds — on this Mac, and the audio is untouched.";
    return <><p className="rec-empty-lead"><strong>This recording has audio, but no transcript — nothing has written it up yet.</strong></p><p>{explanation}</p><EmptyRetranscribeButton /></>;
  }

  function EmptyRetranscribeButton() {
    if (!canRetranscribe) return null;
    const label = retransPct !== null ? `Transcribing ${retransPct}%…` : "Write it up";
    return <button className="nb-btn" disabled={busy} data-testid="rec-transcribe-empty" title="Write up this recording from the audio it already holds — speech is recognised on this Mac" onClick={() => void runRetranscribe()}>{label}</button>;
  }

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
          <TransportStart />

          <TransportMain />

          <TransportEnd />

          <TransportScrub />
        </div>

        <SessionOptions />

        <CapturePreflight />

        <StageBanners />

        {RecordingWaveform()}
        {RecordingFacts()}
      </div>

      <RecordingTabBar />

      <div className="rec-body">
        <div
          className="rec-panel"
          ref={panelRef}
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
              // The editing invitation follows the same rule as the visible
              // hint at the foot of the list: the backend refuses an edit
              // while the file has a live session, so telling a screen reader
              // to select words mid-meeting describes an act that produces no
              // selection bar at all.
              aria-label={
                isLive
                  ? "Transcript — appearing as people speak"
                  : "Transcript — select words here to correct them, or to delete them from the recording"
              }
              onMouseUp={captureSelection}
            >
              <TranscriptEmpty />
              <NoTranscriptMatches />
              {/* QA 2026-08-15 (P1): a turn used to be one paragraph of run-on
                  phrases with a single timestamp at the top, so the phrase
                  being played could only be told apart by a marker inside a
                  wall of text, and there was no way to start from any other
                  one. A turn is now its speaker followed by its phrases, each
                  a line with its own time and its own play — which is also
                  what makes "Show in transcript" able to land somewhere. */}
              <TranscriptTurns />
              {standaloneGhosts.map((g) => (
                <div key={g.lane} className="rec-turn ghost">
                  <div className="rec-turn-head">
                    {g.speaker ? (
                      <span className={`rec-speaker ${speakerTone(g.speaker)}`} dir="auto">
                        {speakerName(g.speaker)}
                      </span>
                    ) : (
                      /* A tape label, not a speaker chip: nobody has been
                         identified yet, and a chip is a claim that somebody
                         has. */
                      <span className="nb-tape nb-sem-pending">the Mac’s audio</span>
                    )}
                  </div>
                  <div className="rec-line">
                    <span className="rec-stamp nb-num" aria-hidden="true">
                      …
                    </span>
                    <div className="rec-line-text" dir="auto">
                      <span className="rec-seg ghost" dir="auto">
                        {g.text}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
              <TranscriptNote />
              <div ref={listEndRef} />
            </div>
          )}

          <ReadTab kind="notes" empty="Nothing to note in this recording." blank="Notes are what the room found: decisions, who agreed to do what, questions left open, and the point of each stretch." />
          <ReadTab kind="highlights" empty="Nothing marked in this recording." blank="Highlights are the moments that carried weight — a commitment, a number, a decisive sentence. Click one to hear it." />
          <ReadTab kind="chapters" empty="This recording has no chapters." blank="Chapters are the meeting in sections, each with a real start time." />
        </div>
      </div>

      <SelectionBar />
      <RecordingDrawer />
    </div>
    );
}
