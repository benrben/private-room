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
  /** Extracted text: provenance line + "[m:ss] …" rows (may be null). */
  text: string | null;
  target?: { quote?: string } | null;
}

interface Row {
  seconds: number | null; // null = plain text row (e.g. the provenance line)
  stamp: string;
  text: string;
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

export default function AudioView({ kind, mime, dataB64, text, target }: Props) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);

  const rows = useMemo(() => parseRows(text), [text]);

  // Blob URL for the encrypted-at-rest bytes; revoked on unmount. The stored
  // mime is normalized first: mime-guessers label .m4a as audio/m4a or
  // audio/mp4a-latm, which WKWebView's <audio> silently refuses to play —
  // the type it accepts for AAC-in-MP4 is audio/mp4.
  const src = useMemo(() => {
    const bytes = base64ToBytes(dataB64);
    return URL.createObjectURL(new Blob([bytes], { type: playableMime(mime, kind) }));
  }, [dataB64, mime, kind]);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);

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
        />
      )}
      {rows.length > 0 ? (
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
      ) : (
        <div className="empty-hint">
          No transcript yet — it appears here automatically once the voice
          model has transcribed this recording (Settings → Model → Dictation).
        </div>
      )}
    </div>
  );
}
