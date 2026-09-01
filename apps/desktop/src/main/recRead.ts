/**
 * The reading pass: the room reads a recording and writes what happened in
 * it — chapters, highlights, and notes (decisions, action items, open
 * questions, key points).
 *
 * Port of `src-tauri/src/commands/jobs/rec_read.rs` (1046 lines, including its
 * `#[cfg(test)] mod tests`, all seven fixtures of which are reproduced in
 * `recRead.test.ts`).
 *
 * Runs by itself when a recording is stopped, in the background for recordings
 * the room already had, and from the "Read this recording" button.
 *
 * Shape (a simpler `file_pass`, and the differences are the point):
 *   1. {@link partitionTurns} splits the transcript into consecutive windows of
 *      WHOLE speaker turns (plan-time, pure). A turn is atomic — half a
 *      sentence in each of two windows would be read twice and understood
 *      neither time.
 *   2. N chained "map" steps walk the meeting IN ORDER, each receiving its
 *      turns plus the short `thread` carried from the previous step. Each
 *      writes an artifact.
 *   3. **No compose step.** `file_pass` needs one because a document's sections
 *      have to be written; here the findings are already local to their window,
 *      so the reduce is {@link mergeFindings} — ordinary code. That is
 *      deliberate: `file_pass`'s own header records a whole-file model fold
 *      collapsing on a small local model and losing an 850 KB book's chapters.
 *      Nothing here may reintroduce a global model fold.
 *   4. A "publish" step (no model) resolves turn numbers to times, merges, and
 *      writes into the recording's meta.
 *
 * **THE PROPERTY THIS FILE EXISTS TO PRESERVE — the model never states a
 * time.** It answers with the turn NUMBER it was shown (`#12`), and
 * {@link mergeFindings} converts that to the exact centisecond of that turn by
 * a plain array index into the REAL turn list. A number outside that list is
 * DROPPED — not clamped, not wrapped, not resolved to a "nearest" turn, and
 * never defaulted to turn 0. So a hallucinated timestamp cannot exist: the
 * worst case is a finding attached to the wrong REAL moment, never a mark at a
 * moment that never happened. {@link coerceReadArtifact} is part of that
 * guarantee too — a finding whose `turn` is missing or not a whole number is
 * discarded rather than given a number it never claimed.
 *
 * Every step is checkpointed by the ADD-30 job runner, so a read survives Stop,
 * app quit and crashes, and resumes from its cursor.
 *
 * =============================================================================
 * DEPENDENCIES REUSED, NOT RE-PORTED
 * =============================================================================
 *   - `RecMeta`/`RecChapter`/`RecHighlight`/`RecNote`/`ReadStamp`/`By`/
 *     `NoteKind` + `segmentVisibleText`/`formatStamp`/`displaySpeaker`/
 *     `readStampOf`/`transcriptText` — `./recFormat.js`.
 *   - `parseRecMeta` (Rust's `parse_meta`) — `./recBridge.js`.
 *   - `Job`/`createJob`/`checkpointJob`/`setJobStatus`/`listJobs`/
 *     `getJobArtifact`/`putJobArtifact` — `./db-host/jobs.js`.
 *   - `getRecMeta`/`setRecMeta` — `./db-host/recordings.js`; `getFileName`/
 *     `setFileExtractedText` — `./db-host/files.js`.
 *   - `Lane`/`Step`/`StepResult`/`RunOutcome`/`CancelSignal`/`ProgressSink`/
 *     `RoomSource`/`JobRunnerDeps`/`runPlan`/`densePrefix`/`pinnedDb`/
 *     `emitProgress`/`spawnJobRunner` — `./jobs.js` (what Rust's `use super::*`
 *     pulls in from `commands/jobs.rs`).
 *   - `atCapacity`/`tryReserve`/`QUEUE_FULL`/`UNREADABLE_PLAN`/`JobQueueDeps`/
 *     `RowStarter`/`runnerDepsFrom` — `./jobQueue.js` (Rust's `super::queue`).
 *   - `resolvedBaseUrl` — `./engineRouting.js`. This IS the port of
 *     `ollama::resolved_base_url()`, so the map body's `base_url` is the room's
 *     really-configured Ollama URL rather than a hardcoded default.
 *   - `ensureUp`/`busy`/`authedHeaders` — `./sidecar.js`.
 *   - `CancelFlag`/`CancelState` — `./cancel.js`; `obs.warn`/`id`/`count` —
 *     `./obs.js`.
 *
 * =============================================================================
 * WHAT HAS NO PORT YET, AND WHAT THIS FILE DOES INSTEAD
 * =============================================================================
 *
 * - `resolve_pass_engine` (`commands/jobs.rs:1247`) reaches `ollama::list_models`,
 *   `runs_on_this_mac`, `capabilities` and a `model_setting` DB read — the same
 *   "engines/models" gap `jobs.ts`'s module doc excludes for `spawn_file_pass`.
 *   Injected as {@link ResolveReadEngine}, defaulting to
 *   {@link resolveReadEngineNotImplemented}: a labeled failure, never a
 *   fabricated model choice that would send a room's meeting transcript to
 *   whatever happens to be first in a hardcoded list. Same "stub, don't fake"
 *   convention as `jobs.ts`'s `renderPodcastAudioNotImplemented`.
 *
 * - `crate::sidecar::sidecar_json_cancellable` has no port in `sidecar.ts`
 *   (which ports only the STREAMING `/run` client). {@link sidecarJsonCancellableAt}
 *   is a small purpose-built analogue following the same shape Rust uses
 *   (`tokio::select!` between the POST and a 100 ms cancel poll): it races the
 *   `fetch` against a cancel poll and, on a Stop, calls `AbortController.abort()`
 *   — the TS equivalent of Rust dropping the in-flight future, which is what
 *   actually severs the connection so the sidecar's `until_hangup` fires.
 *   {@link sidecarErrorSentinel} is a faithful port of `SidecarError::sentinel`,
 *   `humanize_empty_generation` included, and the connect-vs-other split matches
 *   `sidecar_json_timeout`'s own `e.is_connect()` branch, so a mid-body network
 *   failure stays a NON-fatal skipped window and a refused connection parks the
 *   job for Resume.
 *
 * - PRIV-1's policy injection (`commands::inject_policy` /
 *   `ensure_provider_catalog` / `inject_provider_runtime`) lives in
 *   `sidecar_json_timeout` on the Rust side and has no port in this migration
 *   yet. A body posted through this helper reaches the sidecar exactly as
 *   given, with no privacy-door seam attached — tracked as a real gap, not
 *   silently absent.
 *
 * - `edit_rec_meta`'s Electron port is `recBridge.ts`'s `routeEdit`, an
 *   UNEXPORTED function bound to a closed op union (rename_speaker/add_note/
 *   set_note/add_chapter/set_chapter/add_highlight/delete_item) with no
 *   "replace every room finding" op. So the publish step reproduces routeEdit's
 *   own OFFLINE-branch body — which is `edit_rec_meta`'s own offline body,
 *   `recording_cmds.rs:761-771`: parse → mutate → `transcriptText` →
 *   `setFileExtractedText` → `setRecMeta` — by calling the exact same exported
 *   primitives. The mutation itself ({@link installFindings}) is ported
 *   line-for-line. NOT reproduced: routeEdit's LIVE branch (POSTing
 *   `/rec/edit_meta` while the file is the currently-recording session). Rust's
 *   own module header says a read runs only "when a recording is stopped, in
 *   the background for recordings the room already had, and from the 'Read this
 *   recording' button" — never against a live session. A future batch that
 *   needs that must add a sidecar op; this port does not invent one.
 *
 * - `ReadPlan`'s Rust struct carries no `#[serde(rename_all)]`, so a real Tauri
 *   room's `jobs.plan` column holds `file_id`/`file_name`/`visible_chars`. This
 *   port is camelCase, the SAME deviation `jobs.ts` already discloses for
 *   `Step.dependsOn`, for the same reason. Whoever wires cross-version job-row
 *   migration owns an adapter at that one seam.
 */

export { READ_WINDOW_CHARS, MIN_CHAPTER_GAP_CS, MAX_PER_WINDOW, type Turn, type ReadPlan, type FoundChapter, type FoundHighlight, type FoundNote, type ReadArtifact, defaultReadArtifact, turnsOf, visibleChars, turnsMoved, type JobProgressPayload, type ProgressSink, type RoomSource } from "./recReadTypes.js";
export { partitionTurns, windowText, mergeFindings } from "./recReadPlan.js";
export { installFindings, buildReadSteps, isFatal, readProgressLabel, coerceReadArtifact, parseReadPlan } from "./recReadMerge.js";
export { type SidecarJsonError, type SidecarJsonOutcome, type RecReadSidecarCall, sidecarErrorSentinel, sidecarJsonCancellableAt, sidecarJsonCancellable } from "./recReadSidecar.js";
export { type RecReadLog, type ResolveReadEngine, RESOLVE_READ_ENGINE_NOT_IMPLEMENTED, resolveReadEngineNotImplemented, type RecReadDoneEvent, type RecReadStepDeps, type RecReadRunnerDeps } from "./recReadStorage.js";
export { executeReadStep } from "./recReadSteps.js";
export { spawnRecRead } from "./recReadRunner.js";
export { type RecReadExtraDeps, readingNow, startRecRead, recReadRowStarter } from "./recReadStart.js";
