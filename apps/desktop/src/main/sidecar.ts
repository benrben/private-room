/**
 * Manage the local Python/LangGraph agent sidecar, AND drive one answer
 * through it. Two halves, ported from two different Rust files:
 *
 * 1. PROCESS LIFECYCLE — ported from `src-tauri/src/sidecar_lifecycle.rs`
 *    (617 lines). Everything from here down to {@link spawnAndWait}.
 * 2. THE `/run` NDJSON STREAMING CLIENT — ported from the OTHER half of
 *    `src-tauri/src/sidecar.rs` (2331 lines), specifically its
 *    `stream_run`/`run_via_sidecar` pair. Everything below the
 *    "`/run` streaming RPC client" banner near the end of this file.
 *
 * The two live together because half of what the second one does is call the
 * first: {@link runViaSidecar} resolves a base URL through {@link ensureUp}
 * and holds a {@link busy} guard for the whole streaming answer, which is the
 * one thing that stops another task's health probe SIGTERMing the process
 * mid-reply.
 *
 * The sidecar is the app's SOLE AI engine — not an option and not a
 * preference. If this module cannot start the process the app cannot
 * answer at all; there is nothing to fall back to. This module owns the
 * process — spawn it on demand, learn the loopback port it chose, hand out
 * its base URL, and SIGTERM it on app exit.
 *
 * Same safety rule as the Rust source's `ollama_lifecycle` sibling: we only
 * ever stop a process WE spawned, and it is bound to `127.0.0.1` only. The
 * sidecar never sees the room key — it reaches the room's tools solely
 * through the token-guarded loopback MCP bridge.
 *
 * TEMPORARY LOCATION: this file currently lives in the migration workspace
 * (`apps/desktop/src/main/sidecar.ts`) so it can be
 * built and tested standalone against the shared contract before cutover.
 * Once the migration lands this moves to `src/main/sidecar.ts` at the
 * repo root, replacing `src-tauri` entirely — see {@link defaultDevSidecarDir}
 * for the one path computation that has to change along with it.
 */

export { TOKEN_ENV, VISUAL_INDEX_DIR_ENV, configureVisualIndexDir, authToken, authedHeaders, busy, inflightCount, parsePortLine, type Probe, shouldReplace, probeOnce, type RecordedProbeDeps, probeRecorded } from "./sidecarAuth.js";
export { baseUrlIfRunning, forgetRoomMemory, type EnsureUpDeps, ensureUp, stopIfOurs, stderrLogPath, previousStderrLogPath, STDERR_LOG_BUDGET, type LaunchCommand, launchCommand } from "./sidecarLifecycle.js";
export { spawnAndWait, type SidecarChatMessage, type RunViaSidecarMcp, type RunViaSidecarRequest, buildRunRequestBody } from "./sidecarLaunch.js";
export { type SidecarOutcome, type SidecarEventName, type SidecarLineEvent, type StreamAccumulator, freshAccumulator, type LineOutcome, answerSoFar, processLine, finalOutcome } from "./sidecarProtocol.js";
export { splitCompleteLines, type ChunkReader, type ChunkStep, waitForNextChunkOrCancel, type CancelPostResult, CANCEL_RETRY_DELAY_MS, cancelVerdict, deliverCancel } from "./sidecarStream.js";
export { safeValidationDetail, type RunViaSidecarOptions, streamRun, runViaSidecar } from "./sidecarRun.js";
