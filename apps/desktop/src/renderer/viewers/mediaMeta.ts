import type { MediaMeta } from "../apiTypes";

/**
 * Turning a probe result into the line under the player.
 *
 * Pure on purpose: this is where "we don't know" has to survive the trip to
 * the screen, and that is worth a test rather than a JSX expression. Every
 * field the probe could not read is rendered as the word "unknown" — the
 * viewer never falls back to 0 fps, 0 × 0 or "H.264 probably", because a
 * plausible default is indistinguishable from a fact once it is on screen.
 */

/** One row of the technical strip. `known` lets the viewer grey out what the
 * file never said, so a glance separates facts from gaps. */
export interface MediaFact {
  label: string;
  value: string;
  known: boolean;
}

const UNKNOWN = "unknown";

/** Seconds → "m:ss" (or "h:mm:ss" past an hour). */
export function formatDuration(secs: number): string {
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "24 fps", "29.97 fps" — trailing zeros dropped, because "29.97000 fps"
 * reads as more precision than the container actually stated. */
function formatFps(fps: number): string {
  return `${Number(fps.toFixed(2))} fps`;
}

function fact(label: string, value: string | null): MediaFact {
  return value == null
    ? { label, value: UNKNOWN, known: false }
    : { label, value, known: true };
}

function durationValue(meta: MediaMeta | null, playerDurationSecs: number | null): string | null {
  const duration = meta?.durationSecs ?? playerDurationSecs;
  return duration == null ? null : formatDuration(duration);
}

function sizeValue(meta: MediaMeta | null): string | null {
  if (meta?.width == null || meta.height == null) return null;
  return `${meta.width} × ${meta.height}`;
}

function audioValue(meta: MediaMeta | null): string | null {
  if (meta?.hasAudio === false) return "none";
  return meta?.hasAudio === true ? meta.audioCodec ?? "yes" : null;
}

function standardVideoFacts(meta: MediaMeta | null, playerDurationSecs: number | null): MediaFact[] {
  return [
    fact("Length", durationValue(meta, playerDurationSecs)),
    fact("Size", sizeValue(meta)),
    fact("Video", meta?.videoCodec ?? null),
    fact("Frame rate", meta?.frameRate != null ? formatFps(meta.frameRate) : null),
    fact("Audio", audioValue(meta)),
  ];
}

function bitrateFact(meta: MediaMeta | null): MediaFact | null {
  return meta?.bitrateKbps != null ? fact("Bitrate", `${meta.bitrateKbps} kbps`) : null;
}

/**
 * The technical facts to show for a video.
 *
 * `playerDurationSecs` is the length the `<video>` element worked out from the
 * same bytes; it stands in when the container never stated one. That is a
 * second reading of the real file, not a guess — but it only exists while the
 * viewer is open, which is why the probe is what gets stored.
 */
export function videoFacts(
  meta: MediaMeta | null,
  playerDurationSecs: number | null,
): MediaFact[] {
  const facts = standardVideoFacts(meta, playerDurationSecs);
  // Bitrate is not one of the five things a person opens a video to check, so
  // it appears only when the file actually stated it — a sixth "unknown" would
  // cost more attention than the field is worth.
  const bitrate = bitrateFact(meta);
  return bitrate === null ? facts : [...facts, bitrate];
}

function usableSpan(start: number | null, end: number | null): number | null {
  if (start == null || end == null) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = end - start;
  return seconds >= 0.1 ? seconds : null;
}

function spanLength(seconds: number): string {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/** How a trim span reads in the button: "0:07 → 0:19 (12s)". Returns null when
 * there is no usable span yet, which is what disables the button. */
export function describeSpan(
  start: number | null,
  end: number | null,
): string | null {
  const seconds = usableSpan(start, end);
  if (seconds === null || start === null || end === null) return null;
  // Not rounded to whole seconds: this label says what the button is about to
  // cut, and "12s" for an 11.7s span is a small lie in the one place the user
  // is checking the numbers.
  return `${formatDuration(start)} → ${formatDuration(end)} (${spanLength(seconds)})`;
}
