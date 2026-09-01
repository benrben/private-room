import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { MediaMeta } from "../apiTypes";
import { RefreshIcon } from "../icons";
import { base64ToBytes, sttFailure } from "./util";
import { grabFrame } from "./frameGrab";
import { describeSpan, formatDuration, videoFacts } from "./mediaMeta";
import { normalizeForMatch } from "./highlight";
import Waveform, { SpeakerRegion } from "./Waveform";

interface Props {
  kind: "audio" | "video";
  fileId: string;
  mime: string;
  dataB64: string;
  mediaToken: string | null;
  text: string | null;
  mediaMeta?: MediaMeta | null;
  target?: { quote?: string } | null;
  transcribing?: boolean;
  sttStage?: string;
}

interface Row {
  seconds: number | null;
  stamp: string;
  text: string;
  speaker: string | null;
}

type MediaElement = HTMLVideoElement | HTMLAudioElement;
type VideoBusy = "" | "trim" | "frame";

const SPEAKER = /^([^:]{1,40}):\s+(.*)$/;
const STAMP = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s?(.*)$/;

function splitSpeaker(text: string): { speaker: string | null; text: string } {
  const match = SPEAKER.exec(text);
  if (!match) return { speaker: null, text };
  const speaker = match[1].trim();
  if (!speaker || /[.!?,;]/.test(speaker)) return { speaker: null, text };
  return { speaker, text: match[2] };
}

function playableMime(mime: string, kind: "audio" | "video"): string {
  const normalized = (mime || "").toLowerCase();
  if (["audio/m4a", "audio/x-m4a", "audio/mp4a-latm", "audio/aac"].includes(normalized)) return "audio/mp4";
  if (!normalized || normalized === "application/octet-stream") return kind === "video" ? "video/mp4" : "audio/mp4";
  return mime;
}

function parseRows(text: string | null): Row[] {
  if (!text) return [];
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = STAMP.exec(line);
    if (!match) return { seconds: null, stamp: "", text: line, speaker: null };
    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const seconds = hours * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
    const { speaker, text: body } = splitSpeaker(match[4]);
    return { seconds, stamp: match[1] ? `${match[1]}:${match[2]}:${match[3]}` : `${match[2]}:${match[3]}`, text: body, speaker };
  });
}

function useMediaSource(dataB64: string, mediaToken: string | null, mime: string, kind: Props["kind"]) {
  const src = useMemo(() => {
    if (mediaToken) return `roommedia://localhost/${mediaToken}`;
    const bytes = base64ToBytes(dataB64);
    return URL.createObjectURL(new Blob([bytes], { type: playableMime(mime, kind) }));
  }, [mediaToken, dataB64, mime, kind]);
  useEffect(() => () => { if (src.startsWith("blob:")) URL.revokeObjectURL(src); }, [src]);
  return src;
}

function useRetranscription(fileId: string, sttStage: string | undefined, transcribing: boolean | undefined, source: string) {
  const [kicked, setKicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageWhenKicked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!kicked) return;
    if (sttStage !== stageWhenKicked.current || sttStage === "model-missing") setKicked(false);
  }, [kicked, sttStage]);
  useEffect(() => { setKicked(false); setError(null); }, [source]);
  const retranscribe = useCallback(async () => {
    setError(null);
    stageWhenKicked.current = sttStage;
    setKicked(true);
    try { await api.retranscribeFile(fileId); }
    catch (reason) { setKicked(false); setError(String(reason)); }
  }, [fileId, sttStage]);
  return { busy: Boolean(transcribing || kicked), error, queued: kicked && !transcribing, retranscribe };
}

function useVideoMetadata(kind: Props["kind"], fileId: string, mediaMeta: MediaMeta | null | undefined) {
  const [meta, setMeta] = useState<MediaMeta | null>(mediaMeta ?? null);
  const probedFor = useRef<string | null>(null);
  useEffect(() => setMeta(mediaMeta ?? null), [mediaMeta, fileId]);
  useEffect(() => {
    if (kind !== "video" || mediaMeta || probedFor.current === fileId) return;
    probedFor.current = fileId;
    api.probeVideoMeta(fileId).then(setMeta, () => {});
  }, [kind, fileId, mediaMeta]);
  return meta;
}

function forceDurationProbe(element: MediaElement, forced: React.MutableRefObject<boolean>) {
  if (forced.current) return;
  forced.current = true;
  try { element.currentTime = 1e101; } catch { /* an out-of-range seek leaves duration unknown */ }
}

function applyKnownDuration(element: MediaElement, duration: number, resumeAt: React.MutableRefObject<number>, setDuration: (duration: number) => void) {
  setDuration(duration);
  if (resumeAt.current > 0 && element.currentTime === 0) element.currentTime = resumeAt.current;
}

function handleMediaMetadata(mediaRef: React.MutableRefObject<MediaElement | null>, forced: React.MutableRefObject<boolean>, resumeAt: React.MutableRefObject<number>, setMediaDead: (dead: boolean) => void, setDuration: (duration: number) => void) {
  const element = mediaRef.current;
  if (!element) return;
  if (element.duration === 0) { setMediaDead(true); return; }
  if (!Number.isFinite(element.duration)) { forceDurationProbe(element, forced); return; }
  applyKnownDuration(element, element.duration, resumeAt, setDuration);
}

function restoreProbedPosition(mediaRef: React.MutableRefObject<MediaElement | null>, forced: React.MutableRefObject<boolean>, resumeAt: React.MutableRefObject<number>) {
  if (!forced.current || !mediaRef.current) return;
  mediaRef.current.currentTime = resumeAt.current;
  forced.current = false;
}

function usePlayback(source: string) {
  const mediaRef = useRef<MediaElement | null>(null);
  const forcedDuration = useRef(false);
  const resumeAt = useRef(0);
  const [mediaDead, setMediaDead] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  useEffect(() => { setMediaDead(false); setDuration(null); forcedDuration.current = false; resumeAt.current = 0; }, [source]);
  const attachMedia = useCallback((element: MediaElement | null) => { mediaRef.current = element; setMedia(element); }, []);
  function seekTo(seconds: number, play = false) {
    resumeAt.current = seconds;
    const element = mediaRef.current;
    if (play && element) void element.play().catch(() => {});
    if (!element || element.readyState === 0) return;
    element.currentTime = seconds;
  }
  function onLoadedMetadata() { handleMediaMetadata(mediaRef, forcedDuration, resumeAt, setMediaDead, setDuration); }
  function onDurationChange() {
    const value = mediaRef.current?.duration;
    if (value == null || !Number.isFinite(value) || value <= 0) return;
    setDuration(value);
    restoreProbedPosition(mediaRef, forcedDuration, resumeAt);
  }
  return { attachMedia, duration, media, mediaDead, mediaRef, onDurationChange, onError: () => setMediaDead(true), onLoadedMetadata, resumeAt, seekTo };
}

function useVideoActions({ fileId, kind, mediaRef, mediaToken, mime, source }: { fileId: string; kind: Props["kind"]; mediaRef: React.MutableRefObject<MediaElement | null>; mediaToken: string | null; mime: string; source: string }) {
  const [trimIn, setTrimIn] = useState<number | null>(null);
  const [trimOut, setTrimOut] = useState<number | null>(null);
  const [busy, setBusy] = useState<VideoBusy>("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const span = describeSpan(trimIn, trimOut);
  useEffect(() => { setTrimIn(null); setTrimOut(null); setNote(null); setError(null); }, [source]);
  function markTrim(which: "in" | "out") {
    const at = mediaRef.current?.currentTime ?? 0;
    setError(null); setNote(null);
    if (which === "in") setTrimIn(at); else setTrimOut(at);
  }
  async function runTrim() {
    if (trimIn == null || trimOut == null || span == null) return;
    setBusy("trim"); setError(null); setNote(null);
    try { const file = await api.videoTrim(fileId, trimIn, trimOut); setNote(`Saved “${file.name}” to this room. The original is unchanged.`); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }
  async function saveFrame() {
    const element = mediaRef.current;
    if (!element || !mediaToken) { setError("This video isn't streaming, so a frame can't be exported."); return; }
    setBusy("frame"); setError(null); setNote(null);
    try {
      const shot = await grabFrame(mediaToken, playableMime(mime, kind), element.currentTime, Infinity);
      if ("error" in shot) { setError(shot.error); return; }
      const file = await api.saveVideoFrame(fileId, shot.imageB64, shot.atSeconds);
      setNote(`Saved “${file.name}” (${shot.width} × ${shot.height}) to this room.`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }
  return { busy, error, markTrim, note, runTrim, saveFrame, span, trimIn, trimOut };
}

function hasWords(row: Row) { return row.seconds != null && /[\p{L}\p{N}]/u.test(row.text); }
function speakerRows(rows: Row[]) { return rows.filter((row) => row.seconds != null && row.speaker != null); }
function regionEnd(rows: Row[], index: number, fallback: number) { return index + 1 < rows.length ? rows[index + 1].seconds as number : fallback; }
function mergesWithLast(last: SpeakerRegion | undefined, speaker: string, start: number) { return Boolean(last && last.speaker === speaker && Math.abs(last.end - start) < 0.01); }
function speakerRegionsFor(rows: Row[], duration: number | null) {
  const timed = speakerRows(rows);
  if (timed.length === 0) return [];
  const fallback = (timed[timed.length - 1].seconds as number) + 5;
  const end = duration ?? fallback;
  const regions: SpeakerRegion[] = [];
  for (let index = 0; index < timed.length; index += 1) {
    const row = timed[index]; const start = row.seconds as number; const stop = regionEnd(timed, index, end); const speaker = row.speaker as string; const last = regions[regions.length - 1];
    if (mergesWithLast(last, speaker, start)) last!.end = stop; else regions.push({ start, end: stop, speaker });
  }
  return regions;
}

function quoteRowIndex(rows: Row[], quote: string | undefined) {
  if (!quote || rows.length === 0) return -1;
  const needle = normalizeForMatch(quote);
  return rows.findIndex((row) => needle && normalizeForMatch(row.text).includes(needle));
}

function activeRowIndex(rows: Row[], time: number) {
  let index = -1;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const seconds = rows[rowIndex].seconds;
    if (seconds != null && seconds <= time) index = rowIndex;
    if (seconds != null && seconds > time) break;
  }
  return index;
}

function useTranscript(rows: Row[], target: Props["target"], duration: number | null, mediaRef: React.MutableRefObject<MediaElement | null>, seekTo: (seconds: number, play?: boolean) => void) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const speakerRegions = useMemo(() => speakerRegionsFor(rows, duration), [rows, duration]);
  useEffect(() => {
    const index = quoteRowIndex(rows, target?.quote);
    if (index < 0) return;
    setActiveIdx(index);
    const element = listRef.current?.children[index] as HTMLElement | undefined;
    element?.scrollIntoView({ block: "center" });
    const seconds = rows[index].seconds;
    if (seconds != null) seekTo(seconds);
    // seekTo only closes over refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.quote, rows]);
  function seek(row: Row, index: number) { if (row.seconds == null) return; seekTo(row.seconds, true); setActiveIdx(index); }
  function onTimeUpdate() {
    const time = mediaRef.current?.currentTime ?? 0;
    const index = activeRowIndex(rows, time);
    if (index !== activeIdx) setActiveIdx(index);
  }
  return { activeIdx, listRef, onTimeUpdate, seek, speakerRegions };
}

function MediaPlayer({ kind, src, playback, onTimeUpdate }: { kind: Props["kind"]; src: string; playback: ReturnType<typeof usePlayback>; onTimeUpdate: () => void }) {
  const props = { ref: playback.attachMedia, className: "audio-view-media", src, controls: true, onTimeUpdate, onError: playback.onError, onLoadedMetadata: playback.onLoadedMetadata, onDurationChange: playback.onDurationChange };
  return kind === "video" ? <video {...props} /> : <audio {...props} />;
}

function VideoFacts({ facts, kind }: { facts: ReturnType<typeof videoFacts>; kind: Props["kind"] }) {
  if (kind !== "video") return null;
  return <div className="video-facts">{facts.map((fact) => <span key={fact.label} className={fact.known ? "video-fact" : "video-fact unknown"}><span className="video-fact-label">{fact.label}</span>{fact.value}</span>)}</div>;
}

function terminalTranscriptStatus(why: string | null, end: string | null) { if (why) return "Transcription failed"; if (end === "model-missing") return "No speech model"; if (end === "none") return "No speech detected"; return "No transcript yet"; }
function transcriptStatus(transcribing: boolean | undefined, queued: boolean, hasSpeech: boolean, rows: Row[], why: string | null, end: string | null) { if (transcribing) return "Transcribing on this Mac…"; if (queued) return "Queued for transcription"; if (hasSpeech) return "Transcript ready"; if (rows.length > 0) return "No speech detected"; return terminalTranscriptStatus(why, end); }
function transcribeTitle(hasSpeech: boolean) { return hasSpeech ? "Run the on-device transcriber again, replacing this transcript" : "Run the on-device transcriber on this file"; }
function transcribeLabel(queued: boolean, transcribing: boolean | undefined, hasSpeech: boolean) { if (queued) return "Queued…"; if (transcribing) return "Transcribing…"; return hasSpeech ? "Re-transcribe" : "Transcribe"; }

function TranscriptionMeta({ busy, duration, hasSpeech, kind, queued, retranscribe, rows, sttEnd, sttWhy, transcribing }: { busy: boolean; duration: number | null; hasSpeech: boolean; kind: Props["kind"]; queued: boolean; retranscribe: () => Promise<void>; rows: Row[]; sttEnd: string | null; sttWhy: string | null; transcribing: boolean | undefined }) {
  return <div className="audio-meta"><span>{kind !== "video" && duration != null && <>Length {formatDuration(duration)}{" · "}</>}{transcriptStatus(transcribing, queued, hasSpeech, rows, sttWhy, sttEnd)}</span><button className="btn-ic audio-retranscribe" disabled={busy} onClick={() => void retranscribe()} title={transcribeTitle(hasSpeech)}><RefreshIcon size={12} className={transcribing ? "spin" : undefined} />{transcribeLabel(queued, transcribing, hasSpeech)}</button></div>;
}

function trimTitle(span: string | null, trimIn: number | null, trimOut: number | null) { if (span) return `Save ${span} as a new video file — the original is untouched`; if (trimIn != null && trimOut != null) return `The end (${formatDuration(trimOut)}) has to be at least a moment after the start (${formatDuration(trimIn)}).`; return "Mark a start and an end first"; }
function trimLabel(busy: VideoBusy, span: string | null) { if (busy === "trim") return "Trimming…"; return span ? `Trim ${span}` : "Trim"; }

function trimPointLabel(label: string, point: number | null) { return point == null ? label : `${label} · ${formatDuration(point)}`; }

function TrimTools({ actions }: { actions: ReturnType<typeof useVideoActions> }) {
  const { busy, markTrim, runTrim, span, trimIn, trimOut } = actions;
  return <>
    <button className="btn-ic" onClick={() => markTrim("in")} title="Start the trim at the current playhead">{trimPointLabel("Set start", trimIn)}</button>
    <button className="btn-ic" onClick={() => markTrim("out")} title="End the trim at the current playhead">{trimPointLabel("Set end", trimOut)}</button>
    <button className="btn-ic" disabled={span == null || busy !== ""} onClick={() => void runTrim()} title={trimTitle(span, trimIn, trimOut)}>{trimLabel(busy, span)}</button>
  </>;
}

function FrameTool({ actions }: { actions: ReturnType<typeof useVideoActions> }) {
  return <button className="btn-ic" disabled={actions.busy !== ""} onClick={() => void actions.saveFrame()} title="Save the frame on screen as a PNG file in this room">{actions.busy === "frame" ? "Saving…" : "Save frame"}</button>;
}

function VideoTools({ actions, kind, mediaDead }: { actions: ReturnType<typeof useVideoActions>; kind: Props["kind"]; mediaDead: boolean }) {
  if (kind !== "video" || mediaDead) return null;
  return <div className="video-tools"><TrimTools actions={actions} /><FrameTool actions={actions} /></div>;
}

function TranscriptRows({ activeIdx, listRef, rows, seek }: { activeIdx: number; listRef: React.RefObject<HTMLDivElement | null>; rows: Row[]; seek: (row: Row, index: number) => void }) {
  return <div className="audio-transcript" ref={listRef}>{rows.map((row, index) => row.seconds == null ? <div key={index} className="audio-line plain">{row.text}</div> : <button key={index} className={`audio-line ${index === activeIdx ? "active" : ""}`} title="Jump to this moment" onClick={() => seek(row, index)}><span className="audio-stamp">{row.stamp}</span>{row.speaker && <span className="audio-speaker">{row.speaker}</span>}<span dir="auto">{row.text}</span></button>)}</div>;
}

function MediaKind({ kind }: { kind: Props["kind"] }) { return <>{kind === "video" ? "video" : "recording"}</>; }
function DecodeError({ kind }: { kind: Props["kind"] }) { return <div className="empty-hint">This <MediaKind kind={kind} /> couldn't be played in the built-in player. Playback and on-device transcription use different decoders, so Transcribe above may still read its audio. If that fails, convert it to {kind === "video" ? "MP4" : "M4A, MP3 or WAV"} and import it again.</div>; }
function NoSpeech({ kind }: { kind: Props["kind"] }) { return <div className="empty-hint">No speech detected — this <MediaKind kind={kind} /> appears to be silent or contains no recognizable speech.</div>; }
function TerminalTranscriptHint({ end, kind }: { end: string | null; kind: Props["kind"] }) { if (end === "model-missing") return <div className="empty-hint">No speech model is installed, so nothing has read this <MediaKind kind={kind} /> yet. Install one in Settings → Model → Dictation and this will transcribe itself.</div>; if (end === "none") return <div className="empty-hint">The audio was read all the way through and held no speech.</div>; return <div className="empty-hint">No transcript yet — it appears automatically once the voice model has transcribed this recording (Settings → Model → Dictation). A silent or speechless recording stays empty.</div>; }

function WaitingTranscriptHint({ busy, end, kind, queued, why }: { busy: boolean; end: string | null; kind: Props["kind"]; queued: boolean; why: string | null }) {
  if (queued) return <div className="empty-hint">Queued for transcription — the voice model takes one file at a time, so this starts when the file ahead of it is done. You can keep working meanwhile.</div>;
  if (busy) return <div className="empty-hint">Transcribing on this Mac… the transcript will appear here on its own — you can keep working meanwhile.</div>;
  if (why) return <div className="empty-hint">This <MediaKind kind={kind} /> couldn’t be transcribed: {why}. Converting it to a common format (M4A, MP3, WAV or MP4) and importing it again usually fixes this.</div>;
  return <TerminalTranscriptHint end={end} kind={kind} />;
}

function TranscriptBody({ activeIdx, busy, end, hasSpeech, kind, listRef, mediaDead, queued, rows, seek, why }: { activeIdx: number; busy: boolean; end: string | null; hasSpeech: boolean; kind: Props["kind"]; listRef: React.RefObject<HTMLDivElement | null>; mediaDead: boolean; queued: boolean; rows: Row[]; seek: (row: Row, index: number) => void; why: string | null }) {
  if (hasSpeech) return <TranscriptRows activeIdx={activeIdx} listRef={listRef} rows={rows} seek={seek} />;
  if (mediaDead) return <DecodeError kind={kind} />;
  if (rows.length > 0) return <NoSpeech kind={kind} />;
  return <WaitingTranscriptHint busy={busy} end={end} kind={kind} queued={queued} why={why} />;
}

function sttEndFor(stage: string | undefined) {
  if (stage === "model-missing" || stage === "none") return stage;
  return null;
}

function sttState(stage: string | undefined, busy: boolean) {
  if (busy) return { end: null, why: null };
  return { end: sttEndFor(stage), why: sttFailure(stage) };
}

function MediaFeedback({ retranscriptionError, videoActions }: { retranscriptionError: string | null; videoActions: ReturnType<typeof useVideoActions> }) {
  return <>
    {retranscriptionError && <div className="gate-error">{retranscriptionError}</div>}
    {videoActions.note && <div className="video-note">{videoActions.note}</div>}
    {videoActions.error && <div className="gate-error">{videoActions.error}</div>}
  </>;
}

function WaveformPanel({ fileId, media, mediaDead, meta, regions, resumeAt }: { fileId: string; media: HTMLMediaElement | null; mediaDead: boolean; meta: MediaMeta | null; regions: SpeakerRegion[]; resumeAt: React.MutableRefObject<number> }) {
  if (mediaDead) return null;
  return <Waveform fileId={fileId} media={media} regions={regions} hasAudioTrack={meta?.hasAudio ?? null} lanes onSeek={(seconds) => { resumeAt.current = seconds; }} />;
}

export default function AudioView({ kind, fileId, mime, dataB64, mediaToken, text, mediaMeta, target, transcribing, sttStage }: Props) {
  const source = useMediaSource(dataB64, mediaToken, mime, kind);
  const playback = usePlayback(source);
  const retranscription = useRetranscription(fileId, sttStage, transcribing, source);
  const meta = useVideoMetadata(kind, fileId, mediaMeta);
  const videoActions = useVideoActions({ fileId, kind, mediaRef: playback.mediaRef, mediaToken, mime, source });
  const rows = useMemo(() => parseRows(text), [text]);
  const hasSpeech = useMemo(() => rows.some(hasWords), [rows]);
  const transcript = useTranscript(rows, target, playback.duration, playback.mediaRef, playback.seekTo);
  const facts = useMemo(() => videoFacts(meta, playback.duration), [meta, playback.duration]);
  const stt = sttState(sttStage, retranscription.busy);
  return <div className="audio-view">
    <MediaPlayer kind={kind} src={source} playback={playback} onTimeUpdate={transcript.onTimeUpdate} />
    <VideoFacts facts={facts} kind={kind} />
    <TranscriptionMeta busy={retranscription.busy} duration={playback.duration} hasSpeech={hasSpeech} kind={kind} queued={retranscription.queued} retranscribe={retranscription.retranscribe} rows={rows} sttEnd={stt.end} sttWhy={stt.why} transcribing={transcribing} />
    <VideoTools actions={videoActions} kind={kind} mediaDead={playback.mediaDead} />
    <MediaFeedback retranscriptionError={retranscription.error} videoActions={videoActions} />
    <WaveformPanel fileId={fileId} media={playback.media} mediaDead={playback.mediaDead} meta={meta} regions={transcript.speakerRegions} resumeAt={playback.resumeAt} />
    <TranscriptBody activeIdx={transcript.activeIdx} busy={retranscription.busy} end={stt.end} hasSpeech={hasSpeech} kind={kind} listRef={transcript.listRef} mediaDead={playback.mediaDead} queued={retranscription.queued} rows={rows} seek={transcript.seek} why={stt.why} />
  </div>;
}
