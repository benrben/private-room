/** Start an automatic deep-summary job for one room. */
export type StartDeepSummaryAuto = (roomPath: string) => Promise<string>;

export const START_DEEP_SUMMARY_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: start_deep_summary_inner (the deep-summary plan builder, " +
  "engine resolution and per-file summarizer runner, in " +
  "src-tauri/src/commands/jobs.rs) has no Electron port yet — this batch " +
  "ports only the auto-index scheduler that decides when to call it.";

export const startDeepSummaryAutoNotImplemented: StartDeepSummaryAuto = () =>
  Promise.reject(new Error(START_DEEP_SUMMARY_NOT_IMPLEMENTED));

/** Start the reading pass for one recording. */
export type StartRecRead = (roomPath: string, fileId: string) => Promise<string>;

export const START_REC_READ_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: start_rec_read (the reading-pass plan builder and runner, " +
  "in src-tauri/src/commands/jobs/rec_read.rs) has no Electron port yet — " +
  "this batch ports only the scheduler that decides a recording is due for one.";

export const startRecReadNotImplemented: StartRecRead = () =>
  Promise.reject(new Error(START_REC_READ_NOT_IMPLEMENTED));

/** Fire-and-forget quiet summary filler seam. */
export type SpawnSummaryFiller = (roomPath: string, delaySecs: number) => void;

export const SUMMARY_FILLER_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: spawn_summary_filler (the legacy opportunistic one-liner " +
  "filler, in src-tauri/src/commands/stt_cmds.rs) has no Electron port yet — " +
  "this tick would have started it for a small drop.";

export const spawnSummaryFillerNotImplemented: SpawnSummaryFiller = () => {
  console.error(SUMMARY_FILLER_NOT_IMPLEMENTED);
};
