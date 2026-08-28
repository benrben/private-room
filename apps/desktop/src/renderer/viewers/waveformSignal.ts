/** What the waveform lane can honestly say about a file's audio.
 *
 * Pure, and in its own module rather than inside Waveform.tsx: these are the
 * rules worth pinning in a test (`tests/contract/waveformSignal.test.mjs`),
 * and a file that imports React cannot be loaded by the plain-Node runner.
 *
 * The lane used to draw a flat strip and say nothing for THREE different
 * situations — peaks not computed yet, a file with no audio in it at all, and
 * a track that is genuinely silent — which read as a broken component. They
 * are not the same thing and must not share a sentence: only the host knows
 * whether a file decoded, so what it sends back is what decides here.
 */
import type { AudioPeaks } from "../apiTypes";

export type WaveformSignal =
  /** A normal track: draw it, say nothing extra. */
  | { state: "signal" }
  /** Nothing to draw — the envelope came back empty or lengthless. */
  | { state: "empty"; note: string }
  /** Drawn, but flat: the file decoded and nothing in it is audible. */
  | { state: "silent"; note: string };

/**
 * Read the envelope the host computed.
 *
 * "empty" is checked FIRST and does not borrow the silence wording: an
 * envelope with no buckets is the absence of an answer, not the knowledge that
 * a file is quiet, and calling it "silent" would be a claim nothing supports.
 */
export function readSignal(data: AudioPeaks): WaveformSignal {
  if (!data.peaks.length || !(data.duration > 0)) {
    return { state: "empty", note: "This file has no readable audio to draw." };
  }
  if (data.silent) {
    return { state: "silent", note: "No audio signal — this track is silent." };
  }
  return { state: "signal" };
}

/**
 * The one thing the lane can say WITHOUT decoding anything: what the
 * container's own track list said (`media_probe.rs`, surfaced as
 * `MediaMeta.hasAudio`).
 *
 * Only `false` is a finding — AVFoundation read the tracks and there is no
 * audio one. `true` and "never probed" both return null: an unknown must not
 * be worded as an absence, which is the same rule `readSignal` applies to an
 * empty envelope. This is why the flat lane on a silent video does not have to
 * wait for `avconvert` to fail and then show its failure in red — nothing
 * failed, the file simply has no sound in it.
 */
export function trackNote(hasAudioTrack: boolean | null | undefined): string | null {
  return hasAudioTrack === false ? "This file has no audio track." : null;
}

