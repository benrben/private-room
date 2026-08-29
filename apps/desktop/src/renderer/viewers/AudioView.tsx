import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { MediaMeta } from "../apiTypes";
import { RefreshIcon } from "../icons";
import { base64ToBytes, sttFailure } from "./util";
import { grabFrame } from "./frameGrab";
import { describeSpan, formatDuration, videoFacts } from "./mediaMeta";
import { normalizeForMatch } from "./highlight";
import Waveform, { SpeakerRegion } from "./Waveform";

/**
 * ADD-18: player for recordings/videos with a clickable timestamped
 * transcript. The transcript is the file's extracted text — "[m:ss] line"
 * rows written by the on-device transcriber (or a YouTube caption import) —
 * and clicking a row seeks the player to that moment. The AI quoting
 * "[12:30] …" therefore lands you at the exact second it means.
 */

interface Props {
  kind: "audio" | "video";
  /** The room file id — lets the viewer re-run transcription on demand. */
  fileId: string;
  mime: string;
  dataB64: string;
  /** ADD-24: token for the roommedia:// streaming protocol (seekable, any
   * size). Null for rooms saved before streaming existed → dataB64 fallback. */
  mediaToken: string | null;
  /** Extracted text: provenance line + "[m:ss] …" rows (may be null). */
  text: string | null;
  /** Video only: what the container says about itself, if it has ever been
   * probed. Null means "not probed yet" — the viewer asks for one on mount,
   * which is also how rooms that predate the column fill in. */
  mediaMeta?: MediaMeta | null;
  target?: { quote?: string } | null;
  /** ADD-18: the background voice model is working on this file right now —
   * "no transcript yet" would be a lie while it is. */
  transcribing?: boolean;
  /** The raw last `stt-progress` stage for this file, if any. Carries the
   * "failed: <reason>" the backend reports for a file it could not DECODE —
   * which no screen showed, so such a file read as a silent recording. */
  sttStage?: string;
}

interface Row {
  seconds: number | null; // null = plain text row (e.g. the provenance line)
  stamp: string;
  text: string;
  /** Who is speaking, when the transcript names them ("[m:ss] Dana: …"). */
  speaker: string | null;
}

/** A speaker label is what precedes the first ": " on a timestamped line —
 * the shape `recording::transcript_text` writes. Guarded so ordinary prose
 * containing a colon ("So: two things") isn't mistaken for a name: a label is
 * short and has no sentence punctuation in it. */
const SPEAKER = /^([^:]{1,40}):\s+(.*)$/;

function splitSpeaker(text: string): { speaker: string | null; text: string } {
  const m = SPEAKER.exec(text);
  if (!m) return { speaker: null, text };
  const who = m[1].trim();
  if (!who || /[.!?,;]/.test(who)) return { speaker: null, text };
  return { speaker: who, text: m[2] };
}

const STAMP = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s?(.*)$/;

/** A mime WKWebView will actually play. m4a-flavored labels → audio/mp4;
 * unknown/octet-stream falls back to the container the kind implies. */
function playableMime(mime: string, kind: "audio" | "video"): string {
  const m = (mime || "").toLowerCase();
  if (["audio/m4a", "audio/x-m4a", "audio/mp4a-latm", "audio/aac"].includes(m)) {
    return "audio/mp4";
  }
  if (!m || m === "application/octet-stream") {
    return kind === "video" ? "video/mp4" : "audio/mp4";
  }
  return mime;
}

function parseRows(text: string | null): Row[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = STAMP.exec(line);
      if (!m) return { seconds: null, stamp: "", text: line, speaker: null };
      const h = m[1] ? parseInt(m[1], 10) : 0;
      const secs = h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      const { speaker, text: body } = splitSpeaker(m[4]);
      return {
        seconds: secs,
        stamp: m[1] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[2]}:${m[3]}`,
        text: body,
        speaker,
      };
    });
}

export default function AudioView({
  kind,
  fileId,
  mime,
  dataB64,
  mediaToken,
  text,
  mediaMeta,
  target,
  transcribing,
  sttStage,
}: Props) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  // Local "just kicked off a re-transcribe" flag: gives instant feedback in the
  // window before the backend's stt-progress "started" event flips `transcribing`
  // true, and self-clears so a same-text result can't leave it stuck.
  const [kicked, setKicked] = useState(false);
  const [retranscribeErr, setRetranscribeErr] = useState<string | null>(null);
  const busy = transcribing || kicked;
  // Asked for, but the lane hasn't spoken about this file yet. The transcriber
  // runs one job at a time, so behind a long import "queued" is the truth for
  // minutes — and it is a different sentence from "Transcribing on this Mac…".
  const queued = kicked && !transcribing;
  // Why the transcriber gave up, when it did. A file macOS cannot decode is
  // not a silent recording, and saying "no transcript yet" to someone whose
  // file simply needs converting sends them away to wait for nothing.
  const sttWhy = busy ? null : sttFailure(sttStage);
  // The two other endings the backend names. Both fell through to "No
  // transcript yet", which tells someone with no speech model installed to
  // wait for a model that is never going to run.
  const sttEnd =
    !busy && (sttStage === "model-missing" || sttStage === "none") ? sttStage : null;
  // What the lane had last said about this file when Transcribe was pressed.
  // The flag clears when that changes — the job started, failed or finished —
  // never on a timer: reverting the button to "Transcribe" after six seconds
  // while the job was still queued let a second and third decode of the very
  // same file be enqueued behind it.
  const stageWhenKicked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!kicked) return;
    // "model-missing" is the one answer that repeats itself: the job reports it
    // and returns before it ever starts, so waiting for the stage to CHANGE
    // would leave the button queued for a run that already ended.
    if (sttStage !== stageWhenKicked.current || sttStage === "model-missing") {
      setKicked(false);
    }
  }, [kicked, sttStage]);
  async function retranscribe() {
    setRetranscribeErr(null);
    stageWhenKicked.current = sttStage;
    setKicked(true);
    try {
      await api.retranscribeFile(fileId);
    } catch (e) {
      setKicked(false);
      setRetranscribeErr(String(e));
    }
  }
  // A file the PLAYER rejects (empty, truncated, or a codec Chromium does not
  // support) must say so — but that says nothing about the separate on-device
  // transcription decoder. In particular CAF/AIFF/AIF can fail here while the
  // transcription lane can still read their audio.
  const [mediaDead, setMediaDead] = useState(false);
  // Real playback duration in seconds once known, or null while unknown. A
  // streamed source often reports Infinity until forced (see onMediaMeta).
  const [dur, setDur] = useState<number | null>(null);
  const forcedDurRef = useRef(false);
  // Where playback is actually meant to be. The duration probe below seeks
  // past the end and then has to come back — coming back to a hard 0 wiped out
  // a jump to an AI-quoted moment. It comes back to HERE instead. It also
  // holds a jump that arrived before the media had loaded its metadata.
  const resumeAtRef = useRef(0);

  // ---- video: what it is, cutting it, keeping a still from it -------------
  // Whatever the room had already stored. A video that has never been probed
  // asks for one on mount — which is also how rooms saved before the column
  // existed fill themselves in, one file at a time as they are opened.
  const [meta, setMeta] = useState<MediaMeta | null>(mediaMeta ?? null);
  const probedFor = useRef<string | null>(null);
  useEffect(() => setMeta(mediaMeta ?? null), [mediaMeta, fileId]);
  useEffect(() => {
    if (kind !== "video" || mediaMeta || probedFor.current === fileId) return;
    // Guarded by a ref, not by `meta`: a probe that honestly finds nothing
    // returns null, and re-running on that would never stop.
    probedFor.current = fileId;
    api.probeVideoMeta(fileId).then(setMeta, () => {
      // A failed probe leaves every field unknown, which is exactly what the
      // strip already shows — there is nothing extra to say.
    });
  }, [kind, fileId, mediaMeta]);

  const [trimIn, setTrimIn] = useState<number | null>(null);
  const [trimOut, setTrimOut] = useState<number | null>(null);
  const [videoBusy, setVideoBusy] = useState<"" | "trim" | "frame">("");
  // Receipts, not reassurance: both are set from what the backend actually
  // returned (the stored file's real name), never from having called it.
  const [videoNote, setVideoNote] = useState<string | null>(null);
  const [videoErr, setVideoErr] = useState<string | null>(null);
  const span = describeSpan(trimIn, trimOut);
  const facts = useMemo(() => videoFacts(meta, dur), [meta, dur]);

  function markTrim(which: "in" | "out") {
    const at = mediaRef.current?.currentTime ?? 0;
    setVideoErr(null);
    setVideoNote(null);
    if (which === "in") setTrimIn(at);
    else setTrimOut(at);
  }

  async function runTrim() {
    if (trimIn == null || trimOut == null || span == null) return;
    setVideoBusy("trim");
    setVideoErr(null);
    setVideoNote(null);
    try {
      const file = await api.videoTrim(fileId, trimIn, trimOut);
      setVideoNote(`Saved “${file.name}” to this room. The original is unchanged.`);
    } catch (e) {
      setVideoErr(String(e));
    } finally {
      setVideoBusy("");
    }
  }

  async function saveFrame() {
    const el = mediaRef.current;
    if (!el || !mediaToken) {
      setVideoErr("This video isn't streaming, so a frame can't be exported.");
      return;
    }
    setVideoBusy("frame");
    setVideoErr(null);
    setVideoNote(null);
    try {
      // No width cap: this still is a file the user keeps, unlike the agent's
      // grab, which is capped because it is feeding a vision model.
      const shot = await grabFrame(
        mediaToken,
        playableMime(mime, kind),
        el.currentTime,
        Infinity,
      );
      if ("error" in shot) {
        setVideoErr(shot.error);
        return;
      }
      const file = await api.saveVideoFrame(fileId, shot.imageB64, shot.atSeconds);
      setVideoNote(
        `Saved “${file.name}” (${shot.width} × ${shot.height}) to this room.`,
      );
    } catch (e) {
      setVideoErr(String(e));
    } finally {
      setVideoBusy("");
    }
  }

  const rows = useMemo(() => parseRows(text), [text]);
  // Real speech = a TIMESTAMPED row carrying words. The provenance line
  // ("(transcribed from recording)") is a plain (seconds==null) row and has
  // letters, so counting it would make a "." -only transcript look transcribed.
  const hasSpeech = useMemo(
    () => rows.some((r) => r.seconds != null && /[\p{L}\p{N}]/u.test(r.text)),
    [rows],
  );

  // ADD-24: with a mediaToken the player streams from the Range-capable
  // roommedia:// protocol (any size, seekable; the response carries the right
  // Content-Type server-side). Legacy fallback: a blob URL for the
  // encrypted-at-rest bytes, revoked on unmount. The stored mime is normalized
  // first: mime-guessers label .m4a as audio/m4a or audio/mp4a-latm, which
  // WKWebView's <audio> silently refuses to play — the type it accepts for
  // AAC-in-MP4 is audio/mp4.
  const src = useMemo(() => {
    if (mediaToken) return `roommedia://localhost/${mediaToken}`;
    const bytes = base64ToBytes(dataB64);
    return URL.createObjectURL(new Blob([bytes], { type: playableMime(mime, kind) }));
  }, [mediaToken, dataB64, mime, kind]);
  useEffect(() => () => {
    if (src.startsWith("blob:")) URL.revokeObjectURL(src);
  }, [src]);
  useEffect(() => {
    setMediaDead(false);
    // A pending "I just asked for this one" belongs to the file it was pressed
    // on; carrying it over would call the next file queued.
    setKicked(false);
    setRetranscribeErr(null);
    setDur(null);
    forcedDurRef.current = false;
    resumeAtRef.current = 0;
    // A trim span belongs to the file it was marked on — carrying it to the
    // next video would cut a stranger at someone else's timestamps.
    setTrimIn(null);
    setTrimOut(null);
    setVideoNote(null);
    setVideoErr(null);
  }, [src]);

  /** Move the playhead. Survives both "metadata isn't loaded yet" and the
   * duration probe, either of which used to silently swallow the jump. */
  function seekTo(secs: number, play = false) {
    resumeAtRef.current = secs;
    const el = mediaRef.current;
    // Only the POSITION has to wait for metadata. play() is safe on a still-
    // loading element — the browser queues it — and has to be asked for here,
    // inside the click that wanted it, or the autoplay policy can refuse it
    // later. Deferring it with the seek dropped the play intent of a
    // transcript row clicked in the first moments of the viewer.
    if (play && el) void el.play().catch(() => {});
    if (!el || el.readyState === 0) return; // applied by onMediaMeta instead
    el.currentTime = secs;
  }

  // Decode failure (error event) or a zero-length track both mean "this will
  // never play"; a streaming source may briefly report no duration, so only a
  // hard 0 counts.
  function onMediaError() {
    setMediaDead(true);
  }
  // WKWebView reports `duration === Infinity` for a streamed source whose
  // container has no upfront duration (common for MP3/roommedia://). The known
  // fix: seek far past the end once — the browser then computes the true
  // duration and fires `durationchange` — then snap back to the start.
  function onMediaMeta() {
    const el = mediaRef.current;
    if (!el) return;
    const d = el.duration;
    if (d === 0) {
      setMediaDead(true);
    } else if (!Number.isFinite(d)) {
      if (!forcedDurRef.current) {
        forcedDurRef.current = true;
        try {
          el.currentTime = 1e101;
        } catch {
          /* some engines throw on an out-of-range seek — ignore */
        }
      }
    } else {
      setDur(d);
      // A jump that landed before the media was ready applies now.
      if (resumeAtRef.current > 0 && el.currentTime === 0) {
        el.currentTime = resumeAtRef.current;
      }
    }
  }
  function onDurationChange() {
    const d = mediaRef.current?.duration;
    if (d != null && Number.isFinite(d) && d > 0) {
      setDur(d);
      if (forcedDurRef.current && mediaRef.current) {
        // Back to where the listener actually wants to be — snapping to a
        // hard 0 here threw away a jump to a quoted moment.
        mediaRef.current.currentTime = resumeAtRef.current;
        forcedDurRef.current = false;
      }
    }
  }

  // An AI quote targets a transcript row: scroll it into view and flash it.
  useEffect(() => {
    const quote = target?.quote;
    if (!quote || rows.length === 0) return;
    const needle = normalizeForMatch(quote);
    const idx = rows.findIndex(
      (r) => needle && normalizeForMatch(r.text).includes(needle),
    );
    if (idx < 0) return;
    setActiveIdx(idx);
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "center" });
    const secs = rows[idx].seconds;
    if (secs != null) seekTo(secs);
    // seekTo is a stable closure over refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.quote, rows]);

  // A speaker's turn runs from their line to the next timestamped line (or to
  // the end of the recording). Consecutive lines from the SAME speaker merge
  // into one band, so a back-and-forth reads as a handful of turns rather than
  // as one stripe per sentence.
  const speakerRegions = useMemo<SpeakerRegion[]>(() => {
    const timed = rows.filter((r) => r.seconds != null && r.speaker);
    if (timed.length === 0) return [];
    const end = dur ?? (timed[timed.length - 1].seconds ?? 0) + 5;
    const out: SpeakerRegion[] = [];
    for (let i = 0; i < timed.length; i++) {
      const start = timed[i].seconds as number;
      const stop = i + 1 < timed.length ? (timed[i + 1].seconds as number) : end;
      const who = timed[i].speaker as string;
      const last = out[out.length - 1];
      if (last && last.speaker === who && Math.abs(last.end - start) < 0.01) {
        last.end = stop;
      } else {
        out.push({ start, end: stop, speaker: who });
      }
    }
    return out;
  }, [rows, dur]);

  // The waveform drives the SAME element the native controls and the
  // transcript use, so it has to be told when React swaps it in.
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((el: HTMLMediaElement | null) => {
    mediaRef.current = el;
    setMediaEl(el);
  }, []);
  const onWaveformSeek = useCallback((secs: number) => {
    resumeAtRef.current = secs;
  }, []);

  function seek(row: Row, idx: number) {
    if (row.seconds == null) return;
    seekTo(row.seconds, true);
    setActiveIdx(idx);
  }

  // Follow playback: highlight the row the playhead is inside.
  function onTime() {
    const t = mediaRef.current?.currentTime ?? 0;
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i].seconds;
      if (s != null && s <= t) idx = i;
      if (s != null && s > t) break;
    }
    if (idx !== activeIdx) setActiveIdx(idx);
  }

  return (
    <div className="audio-view">
      {kind === "video" ? (
        <video
          ref={attachMedia}
          className="audio-view-media"
          src={src}
          controls
          onTimeUpdate={onTime}
          onError={onMediaError}
          onLoadedMetadata={onMediaMeta}
          onDurationChange={onDurationChange}
        />
      ) : (
        <audio
          ref={attachMedia}
          className="audio-view-media"
          src={src}
          controls
          onTimeUpdate={onTime}
          onError={onMediaError}
          onLoadedMetadata={onMediaMeta}
          onDurationChange={onDurationChange}
        />
      )}
      {/* What this video ACTUALLY is, read from its own container. A field the
          file never stated reads "unknown" and is greyed — the one thing this
          strip must never do is show a plausible number for something nobody
          measured. It replaces the "Length m:ss" the shared strip below shows
          for audio, which is why that one is now audio-only. */}
      {kind === "video" && (
        <div className="video-facts">
          {facts.map((f) => (
            <span key={f.label} className={f.known ? "video-fact" : "video-fact unknown"}>
              <span className="video-fact-label">{f.label}</span>
              {f.value}
            </span>
          ))}
        </div>
      )}
      {/* Transcript readiness is a first-class state, named right under the
          player — scanning it must never require reading the empty-hint prose.
          The strip and button are ALWAYS drawn: browser playback and the
          on-device transcriber use different decoders, so a media `error`
          must not remove the one action that can still recover CAF/AIFF/AIF. */}
      <div className="audio-meta">
        <span>
          {kind !== "video" && dur != null && (
            <>
              Length {formatDuration(dur)}
              {" · "}
            </>
          )}
          {transcribing
            ? "Transcribing on this Mac…"
            : queued
              ? "Queued for transcription"
              : hasSpeech
                ? "Transcript ready"
                : rows.length > 0
                  ? "No speech detected"
                  : sttWhy
                    ? "Transcription failed"
                    : sttEnd === "model-missing"
                      ? "No speech model"
                      : sttEnd === "none"
                        ? "No speech detected"
                        : "No transcript yet"}
        </span>
        <button
          className="btn-ic audio-retranscribe"
          disabled={busy}
          onClick={() => void retranscribe()}
          title={
            hasSpeech
              ? "Run the on-device transcriber again, replacing this transcript"
              : "Run the on-device transcriber on this file"
          }
        >
          <RefreshIcon size={12} className={transcribing ? "spin" : undefined} />
          {queued
            ? "Queued…"
            : transcribing
              ? "Transcribing…"
              : hasSpeech
                ? "Re-transcribe"
                : "Transcribe"}
        </button>
      </div>
      {retranscribeErr && <div className="gate-error">{retranscribeErr}</div>}
      {/* Trim and stills. Both WRITE A NEW FILE — the video you are watching is
          never modified — so the strip says so rather than leaving "trim" to
          read as "cut this down". */}
      {kind === "video" && !mediaDead && (
        <div className="video-tools">
          <button
            className="btn-ic"
            onClick={() => markTrim("in")}
            title="Start the trim at the current playhead"
          >
            Set start{trimIn != null && ` · ${formatDuration(trimIn)}`}
          </button>
          <button
            className="btn-ic"
            onClick={() => markTrim("out")}
            title="End the trim at the current playhead"
          >
            Set end{trimOut != null && ` · ${formatDuration(trimOut)}`}
          </button>
          <button
            className="btn-ic"
            disabled={span == null || videoBusy !== ""}
            onClick={() => void runTrim()}
            title={
              span
                ? `Save ${span} as a new video file — the original is untouched`
                : trimIn != null && trimOut != null
                  ? // Both points ARE marked; the span is the problem. Saying
                    // "mark a start and an end first" here is a small lie in
                    // the one place the user is asking why the button is dead.
                    `The end (${formatDuration(trimOut)}) has to be at least a moment after the start (${formatDuration(trimIn)}).`
                  : "Mark a start and an end first"
            }
          >
            {videoBusy === "trim" ? "Trimming…" : span ? `Trim ${span}` : "Trim"}
          </button>
          <button
            className="btn-ic"
            disabled={videoBusy !== ""}
            onClick={() => void saveFrame()}
            title="Save the frame on screen as a PNG file in this room"
          >
            {videoBusy === "frame" ? "Saving…" : "Save frame"}
          </button>
        </div>
      )}
      {videoNote && <div className="video-note">{videoNote}</div>}
      {videoErr && <div className="gate-error">{videoErr}</div>}
      {/* The shape of the conversation, with each speaker's turns drawn over
          it. Skipped when the file can't be decoded at all — there would be
          nothing to draw and the peaks command would only fail again. */}
      {!mediaDead && (
        <Waveform
          fileId={fileId}
          media={mediaEl}
          regions={speakerRegions}
          hasAudioTrack={meta?.hasAudio ?? null}
          // One lane per voice, the same as a room recording gets: an
          // imported podcast or meeting has exactly the same question to
          // answer — who was talking, and when — and a single mixed ribbon
          // makes a two-person interview look like one continuous stripe.
          // The component falls back to the ribbon on its own past the
          // number of voices lanes stay readable at.
          lanes
          onSeek={onWaveformSeek}
        />
      )}
      {hasSpeech ? (
        <div className="audio-transcript" ref={listRef}>
          {rows.map((r, i) =>
            r.seconds == null ? (
              <div key={i} className="audio-line plain">
                {r.text}
              </div>
            ) : (
              <button
                key={i}
                className={`audio-line ${i === activeIdx ? "active" : ""}`}
                title="Jump to this moment"
                onClick={() => seek(r, i)}
              >
                <span className="audio-stamp">{r.stamp}</span>
                {r.speaker && <span className="audio-speaker">{r.speaker}</span>}
                <span dir="auto">{r.text}</span>
              </button>
            ),
          )}
        </div>
      ) : mediaDead ? (
        <div className="empty-hint">
          This {kind === "video" ? "video" : "recording"} couldn't be played in
          the built-in player. Playback and on-device transcription use different
          decoders, so Transcribe above may still read its audio. If that fails,
          convert it to {kind === "video" ? "MP4" : "M4A, MP3 or WAV"} and import
          it again.
        </div>
      ) : rows.length > 0 ? (
        // Rows exist but none carry words (a lone "." or silence markers) — the
        // model ran and heard no speech, not "still transcribing".
        <div className="empty-hint">
          No speech detected — this {kind === "video" ? "video" : "recording"}{" "}
          appears to be silent or contains no recognizable speech.
        </div>
      ) : queued ? (
        <div className="empty-hint">
          Queued for transcription — the voice model takes one file at a time,
          so this starts when the file ahead of it is done. You can keep working
          meanwhile.
        </div>
      ) : busy ? (
        <div className="empty-hint">
          Transcribing on this Mac… the transcript will appear here on its
          own — you can keep working meanwhile.
        </div>
      ) : sttWhy ? (
        // The transcriber reported a REASON. It was being stored and then
        // dropped, so a container this Mac can't open looked identical to a
        // silent recording and the one hint that would help — convert it —
        // never reached anyone.
        <div className="empty-hint">
          This {kind === "video" ? "video" : "recording"} couldn’t be
          transcribed: {sttWhy}. Converting it to a common format (M4A, MP3,
          WAV or MP4) and importing it again usually fixes this.
        </div>
      ) : sttEnd === "model-missing" ? (
        // The backend named this reason and the app was holding it: without
        // this branch the button ran, nothing happened, and the hint below
        // still promised a transcript that no installed model could write.
        <div className="empty-hint">
          No speech model is installed, so nothing has read this{" "}
          {kind === "video" ? "video" : "recording"} yet. Install one in
          Settings → Model → Dictation and this will transcribe itself.
        </div>
      ) : sttEnd === "none" ? (
        <div className="empty-hint">
          The audio was read all the way through and held no speech.
        </div>
      ) : (
        <div className="empty-hint">
          No transcript yet — it appears automatically once the voice model has
          transcribed this recording (Settings → Model → Dictation). A silent or
          speechless recording stays empty.
        </div>
      )}
    </div>
  );
}
