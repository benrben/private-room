/**
 * Recording-timeline arithmetic, kept out of RecordingView so it can be tested
 * on its own (tests/contract/rec-timing.test.mjs).
 *
 * A recording has TWO timelines: the file's own, and the shortened one of the
 * copy "Export edited copy" writes with the deleted spans spliced out. Anything
 * that describes only the surviving words — subtitles — has to be stated on the
 * second, or every cue after the first cut runs late.
 */
import type { RecCut } from "../apiTypes";

/**
 * How much cut time (centiseconds) lies strictly before `t` — the timestamp
 * shift a spliced copy needs. Mirrors `cut_shift_before` in
 * src-tauri/src/recording.rs, which is what the exported copy's own transcript
 * is re-timed with; the two must agree or the subtitles drift against it.
 */
export function cutShiftBefore(cuts: readonly RecCut[], t: number): number {
  let shift = 0;
  for (const c of cuts) shift += Math.max(0, Math.min(c.t1, t) - c.t0);
  return shift;
}
