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
  const duration = meta?.durationSecs ?? playerDurationSecs;
  const size =
    meta?.width != null && meta.height != null
      ? `${meta.width} × ${meta.height}`
      : null;
  // `hasAudio === false` is a FINDING — "this video is silent" — and must not
  // be flattened into the same "unknown" that `null` means.
  let audio: string | null = null;
  if (meta?.hasAudio === false) audio = "none";
  else if (meta?.hasAudio === true) audio = meta.audioCodec ?? "yes";

  const facts: MediaFact[] = [
    fact("Length", duration != null ? formatDuration(duration) : null),
    fact("Size", size),
    fact("Video", meta?.videoCodec ?? null),
    fact("Frame rate", meta?.frameRate != null ? formatFps(meta.frameRate) : null),
    fact("Audio", audio),
  ];
  // Bitrate is not one of the five things a person opens a video to check, so
  // it appears only when the file actually stated it — a sixth "unknown" would
  // cost more attention than the field is worth.
  if (meta?.bitrateKbps != null) {
    facts.push(fact("Bitrate", `${meta.bitrateKbps} kbps`));
  }
  return facts;
}

/** How a trim span reads in the button: "0:07 → 0:19 (12s)". Returns null when
 * there is no usable span yet, which is what disables the button. */
export function describeSpan(
  start: number | null,
  end: number | null,
): string | null {
  if (start == null || end == null) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end - start < 0.1) return null;
  const secs = end - start;
  // Not rounded to whole seconds: this label says what the button is about to
  // cut, and "12s" for an 11.7s span is a small lie in the one place the user
  // is checking the numbers.
  const length = Number.isInteger(secs) ? `${secs}s` : `${secs.toFixed(1)}s`;
  return `${formatDuration(start)} → ${formatDuration(end)} (${length})`;
}
