import { useEffect, useMemo, useRef, useState } from "react";
import { base64ToBytes } from "./util";
import { normalizeForMatch } from "./highlight";

/**
 * ADD-18: player for recordings/videos with a clickable timestamped
 * transcript. The transcript is the file's extracted text — "[m:ss] line"
 * rows written by the on-device transcriber (or a YouTube caption import) —
 * and clicking a row seeks the player to that moment. The AI quoting
 * "[12:30] …" therefore lands you at the exact second it means.
 */

interface Props {
  kind: "audio" | "video";
  mime: string;
  dataB64: string;
  /** ADD-24: token for the roommedia:// streaming protocol (seekable, any
   * size). Null for rooms saved before streaming existed → dataB64 fallback. */
  mediaToken: string | null;
  /** Extracted text: provenance line + "[m:ss] …" rows (may be null). */
  text: string | null;
  target?: { quote?: string } | null;
  /** ADD-18: the background voice model is working on this file right now —
   * "no transcript yet" would be a lie while it is. */
  transcribing?: boolean;
}

interface Row {
  seconds: number | null; // null = plain text row (e.g. the provenance line)
  stamp: string;
  text: string;
}

const STAMP = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s?(.*)$/;

/** Seconds → "m:ss" (or "h:mm:ss" past an hour), for the length label. */
function fmtDur(secs: number): string {
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

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
      if (!m) return { seconds: null, stamp: "", text: line };
      const h = m[1] ? parseInt(m[1], 10) : 0;
      const secs = h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      return {
        seconds: secs,
        stamp: m[1] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[2]}:${m[3]}`,
        text: m[4],
      };
    });
}

export default function AudioView({ kind, mime, dataB64, mediaToken, text, target, transcribing }: Props) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  // A file the decoder rejects (empty, truncated, unsupported codec) must say
  // so — "No transcript yet" on a 0-duration recording reads as "keep waiting"
  // for audio that will never play or transcribe.
  const [mediaDead, setMediaDead] = useState(false);
  // Real playback duration in seconds once known, or null while unknown. A
  // streamed source often reports Infinity until forced (see onMediaMeta).
  const [dur, setDur] = useState<number | null>(null);
  const forcedDurRef = useRef(false);

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
    setDur(null);
    forcedDurRef.current = false;
  }, [src]);

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
    }
  }
  function onDurationChange() {
    const d = mediaRef.current?.duration;
    if (d != null && Number.isFinite(d) && d > 0) {
      setDur(d);
      if (forcedDurRef.current && mediaRef.current) {
        mediaRef.current.currentTime = 0;
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
    if (rows[idx].seconds != null && mediaRef.current) {
      mediaRef.current.currentTime = rows[idx].seconds!;
    }
  }, [target?.quote, rows]);

  function seek(row: Row, idx: number) {
    if (row.seconds == null || !mediaRef.current) return;
    mediaRef.current.currentTime = row.seconds;
    void mediaRef.current.play().catch(() => {});
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
          ref={(el) => {
            mediaRef.current = el;
          }}
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
          ref={(el) => {
            mediaRef.current = el;
          }}
          className="audio-view-media"
          src={src}
          controls
          onTimeUpdate={onTime}
          onError={onMediaError}
          onLoadedMetadata={onMediaMeta}
          onDurationChange={onDurationChange}
        />
      )}
      {dur != null && (
        // Transcript readiness is a first-class state, named right under the
        // player — scanning it must never require reading the empty-hint prose.
        <div className="audio-meta">
          Length {fmtDur(dur)}
          {" · "}
          {hasSpeech
            ? "Transcript ready"
            : transcribing
              ? "Transcribing on this Mac…"
              : rows.length > 0
                ? "No speech detected"
                : "No transcript yet"}
        </div>
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
                <span dir="auto">{r.text}</span>
              </button>
            ),
          )}
        </div>
      ) : mediaDead ? (
        <div className="empty-hint">
          This {kind === "video" ? "video" : "recording"} couldn't be decoded —
          the file appears to be empty or in a format this Mac can't play, so
          there is no audio to transcribe. Try re-importing the original file.
        </div>
      ) : rows.length > 0 ? (
        // Rows exist but none carry words (a lone "." or silence markers) — the
        // model ran and heard no speech, not "still transcribing".
        <div className="empty-hint">
          No speech detected — this {kind === "video" ? "video" : "recording"}{" "}
          appears to be silent or contains no recognizable speech.
        </div>
      ) : transcribing ? (
        <div className="empty-hint">
          Transcribing on this Mac… the transcript will appear here on its
          own — you can keep working meanwhile.
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
