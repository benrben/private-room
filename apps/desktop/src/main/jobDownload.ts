/**
 * BROWSE-2 (D18): the "download" job kind — a URL fetched (or media pulled via
 * yt-dlp) into the room as a durable background job with live progress and
 * cancel. A download is a SINGLE atomic unit like the studio/podcast runners:
 * no mid-work checkpoint, so a Stop or crash parks the job and resuming
 * re-downloads from scratch. The live `job-progress` events carry the 0–100
 * byte percentage, and that is what draws the card's bar; the ROW's own total
 * is 0, because nothing ever advances its cursor (see
 * {@link startDownloadJobInner}).
 *
 * Ported from `src-tauri/src/commands/jobs/download.rs` (274 lines, read in
 * full, including its `#[cfg(test)] mod tests`), against the already-committed
 * job-queue foundation (`jobs.ts`'s `spawnJobRunner`/`emitProgress`/`pinnedDb`,
 * `jobQueue.ts`'s `JobQueueDeps`/`RowStarter`/`runnerDepsFrom`) and the
 * already-committed yt-dlp core (`ytdlp.ts`'s `downloadMediaToTemp`). This file
 * adds no plumbing of its own: it is one more job kind wired against that
 * foundation, exactly as `podcastAudioRowStarter` is.
 *
 * WHAT IS REAL — everything `download.rs` itself owns:
 *   - {@link downloadTitle} — `download_title`, the short honest job title.
 *   - {@link startDownloadJobInner} — `start_download_job_inner`: engine
 *     validation, `require_web_access` and `check_public_http_url` at CREATION
 *     time (a bad address or an offline room is refused before a row is ever
 *     written, not discovered by a queued runner later), the queue-capacity
 *     check, the row written with NO step count, and — mirroring the Rust
 *     source's own structure — reserving the slot and spawning the runner
 *     ITSELF rather than going through `jobQueue.ts`'s generic per-kind
 *     dispatch. That is not this port's choice: `start_download_job_inner`
 *     does the same (`queue::try_reserve` + a direct `spawn_download`,
 *     bypassing `start_job_from_row`), because the caller already holds the
 *     fresh `url`/`engine` and re-reading them off the row it just wrote would
 *     be pointless. Ported as found.
 *   - {@link downloadRowStarter} — `start_download_row`: the {@link RowStarter}
 *     the queue PUMP/RESUME path uses to restart a "download" row left 'queued'
 *     or 'paused' (an app restart, or a room carried over from before this
 *     migration), rebuilding `url`/`engine` from the immutable plan.
 *   - {@link spawnDownload} — `spawn_download`: the runner's full lifecycle
 *     (row → 'running', progress events, cancel-vs-error classification,
 *     terminal status, cancel-flag release, terminal event, queue-slot
 *     handoff), wrapped in `jobs.ts`'s `spawnJobRunner` crash net exactly as
 *     `spawnPodcastAudio` is, per that module's doc: "a runner's own uncaught
 *     failure must still leave the row terminal and the queue pumped".
 *   - `run_download`'s MEDIA branch: the real, already-ported
 *     {@link downloadMediaToTemp}. Best quality, always — "the background job
 *     has no picker in front of it", verbatim from the Rust comment
 *     (`maxHeight` is never set).
 *
 * INJECTED SEAMS — "stub, don't fake" (`jobs.ts`'s own `RenderPodcastAudio`
 * convention):
 *   - The FETCH engine (a plain URL, not a media site). `run_download`'s fetch
 *     branch calls `web::download_to_temp` (`web/fetch.rs`), which has no
 *     Electron port yet: that guarded HTTP stack — per-hop SSRF re-check, DNS
 *     pinning, streamed byte caps — is its own unported file, and the privacy
 *     door that belongs in front of a generic URL fetch (`privacy.rs`'s
 *     `outbound_url_hides`, a separate concurrent porting effort) is unported
 *     too. Half-implementing the fetch with neither would be worse than an
 *     honest stub — note `web/fetch.rs` has no `privacy.rs` dependency of its
 *     own; the two are simply both still to do. Rather
 *     than leave the engine unhandled (a legacy room's stored
 *     `{engine:"fetch"}` plan reaches it through {@link downloadRowStarter}),
 *     it is an injectable {@link DownloadToTempFn} defaulting to
 *     {@link downloadToTempNotImplemented}: a fetch-engine download takes the
 *     EXACT error path a genuine failure would (row → 'error', terminal event
 *     with `failed: true`, Retry offered). Never a silent success, never an
 *     unhandled rejection. Its signature is `download_to_temp`'s own — cap,
 *     cancel flag, `(gotBytes, declaredBytes | null)` progress, and a
 *     `TooLarge` outcome — so the eventual real port drops straight in and the
 *     "larger than the N MB limit" refusal is already wired.
 *   - {@link ImportDownloadFn} is NOT re-declared here: it is imported as-is
 *     from `ytdlp.ts`, which already owns it (both engines funnel into the
 *     same "bring this file into the room" seam), and it is REQUIRED on
 *     {@link DownloadEngineDeps} for the same reason `ytdlp.ts`'s own
 *     `ImportMediaOptions` requires it — a caller must not be able to wire a
 *     download job that silently imports nothing.
 *   - {@link DownloadMediaFn} defaults to the REAL {@link downloadMediaToTemp};
 *     it exists so a lifecycle test can drive an exact progress/failure script
 *     without yt-dlp's subprocess machinery (already covered end to end by
 *     `ytdlp.test.ts`). Production wiring re-ports nothing, and this file's own
 *     tests still exercise the real engine (fake `spawnFn` only) for the paths
 *     where the wrapper's correctness depends on it.
 *
 * OUT OF SCOPE, deliberately: the `#[tauri::command] start_download_job`
 * wrapper (a one-line `rolling_back()`/`ROLLBACK_BUSY` guard around
 * {@link startDownloadJobInner} — no `rollingBack()`/IPC channel exists in this
 * migration yet, the same "no AppState port" gap `jobs.ts`'s module doc names),
 * and registering `["download", downloadRowStarter(...)]` into a running app's
 * starters map (`jobQueue.ts`'s `defaultRowStarters()` predates this batch and
 * this batch does not edit that committed file — a host-bootstrap batch adds
 * the entry, exactly the extension point that file documents).
 *
 * DEVIATION — no `commands.ts` seam for `require_web_access` exists yet
 * (`ytdlp.ts`'s `WEB_OFF_MESSAGE` doc names the same gap), so
 * {@link requireWebAccess} below composes it from the two already-ported
 * pieces: `browser/webAccess.ts`'s `webAccessEnabled` and `ytdlp.ts`'s copy of
 * `commands.rs`'s `WEB_OFF_MESSAGE`. `browser/webAccess.ts`'s own
 * `requireWebEnabled` is NOT it — that is Rust's `require_web_enabled`, the
 * BROWSER inlet, whose refusal ends "…to use the browser". Delete this local
 * helper once a real `commands.ts` exists.
 *
 * DEVIATION — `download.rs`'s `a_download_job_claims_no_step_count_it_never_
 * advances` test reads its own Rust source with `include_str!` to pin the
 * literal `create_job(…, 0)?;` call site. That is a source-TEXT assertion with
 * no TS analogue worth having (this file's layout is not the thing being
 * protected); the port pins the BEHAVIOUR instead — a real row, read back from
 * a real DB, has `total === 0` — which is what the Rust test's own comment
 * says the total is FOR.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CancelFlag } from "./cancel.js";
import { checkPublicHttpUrl } from "./browser/guard.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { createJob, setJobStatus, type Job } from "./db-host/jobs.js";
import {
  emitProgress,
  pinnedDb,
  spawnJobRunner,
  type JobRunnerDeps,
  type RoomSource,
} from "./jobs.js";
import {
  atCapacity,
  QUEUE_FULL,
  runnerDepsFrom,
  tryReserve,
  UNREADABLE_PLAN,
  type JobQueueDeps,
  type RowStarter,
  type RowStartResult,
} from "./jobQueue.js";
import {
  downloadMediaToTemp,
  MAX_DOWNLOAD_BYTES,
  WEB_OFF_MESSAGE,
  type DownloadMediaOptions,
  type FetchLike,
  type ImportDownloadFn,
  type MediaDownload,
  type MediaProgress,
  type SpawnFn,
} from "./ytdlp.js";
import type { FileMeta } from "../shared/apiTypes.js";

/** Plain fetch of one file (`web::download_to_temp`) — see this module's doc
 * for why that engine is an injected seam here. */
export const DOWNLOAD_ENGINE_FETCH = "fetch";
/** yt-dlp media download (`download_media_to_temp`) — the engine this batch
 * wires for real, end to end. */
export const DOWNLOAD_ENGINE_MEDIA = "media";

/** `state.with_room(…)`'s own refusal when nothing is open, verbatim. */
const NO_ROOM_OPEN = "No room is open.";

// ============================================================================
// download_title
// ============================================================================

/**
 * A short honest job title: the filename when the URL has one (FETCH engine
 * only — a media URL's last segment is rarely meaningful, e.g. YouTube's
 * `watch`), else the host, else the raw text when it doesn't even parse.
 *
 * Exported (Rust's `download_title` is module-private, reached by its sibling
 * `#[cfg(test)]` through `use super::*;`) purely so this port's test file can
 * pin the same cases.
 */
export function downloadTitle(url: string, engine: string): string {
  let short: string | null = null;
  try {
    const parsed = new URL(url);
    // Rust: the last NON-EMPTY path segment, kept only for the fetch engine
    // (`.filter(|s| engine == DOWNLOAD_ENGINE_FETCH && !s.is_empty())`), then
    // `.or_else(|| u.host_str())`.
    const lastSegment = parsed.pathname.split("/").filter((p) => p !== "").at(-1) ?? null;
    const fromPath = engine === DOWNLOAD_ENGINE_FETCH ? lastSegment : null;
    short = fromPath ?? (parsed.hostname !== "" ? parsed.hostname : null);
  } catch {
    short = null;
  }
  return `Download ${short ?? url}`;
}

// ============================================================================
// The FETCH engine — an injected seam (see this module's doc)
// ============================================================================

/** A file staged by the plain-fetch engine — Rust's `web::Downloaded`,
 * restricted to the two fields `run_download`'s fetch branch reads. */
export interface DownloadedFile {
  path: string;
  fileName: string;
}

/** `web::DownloadOutcome` — either a finished file, or "the room's size cap
 * refused it". */
export type DownloadToTempOutcome = { kind: "done"; file: DownloadedFile } | { kind: "too-large" };

/** `web::download_to_temp`'s shape: a URL, the byte cap, an optional cancel
 * flag, and a `(gotBytes, declaredBytes | null)` progress callback. Not
 * reimplemented — see this module's doc. */
export type DownloadToTempFn = (
  url: string,
  maxBytes: number,
  cancel: CancelFlag | undefined,
  progress: (gotBytes: number, declaredBytes: number | null) => void
) => Promise<DownloadToTempOutcome>;

/** The labeled reason the stubbed fetch engine fails with. Exported so a
 * caller or a test can recognize it without hand-copying the string. */
export const FETCH_DOWNLOAD_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: web::download_to_temp (web/fetch.rs's plain-HTTP engine behind a " +
  '"download" job\'s DOWNLOAD_ENGINE_FETCH path, and the outbound_url_hides privacy door ' +
  "that must sit in front of it) has no Electron port yet — that guarded HTTP stack is its own " +
  "unported file, and privacy.rs is a separate concurrent porting effort. " +
  "This batch wires the yt-dlp media engine (DOWNLOAD_ENGINE_MEDIA) " +
  "and the job-queue plumbing around both engines, which is why a fetch-engine download job " +
  "reaches a real error path rather than hanging or silently succeeding.";

/** The stub {@link runDownload}'s fetch branch falls back to when no real
 * `downloadToTemp` is supplied — a clearly-labeled failure, never a fabricated
 * success. */
export const downloadToTempNotImplemented: DownloadToTempFn = () =>
  Promise.reject(new Error(FETCH_DOWNLOAD_NOT_IMPLEMENTED));

/** {@link downloadMediaToTemp}'s own signature, named as a seam so a lifecycle
 * test can script an exact progress/failure sequence. Defaults to the real
 * function — see this module's doc. */
export type DownloadMediaFn = (
  dataDir: string,
  url: string,
  opts: DownloadMediaOptions
) => Promise<MediaDownload>;

// ============================================================================
// Dependencies
// ============================================================================

/** Everything a download job's own logic needs beyond the job-lifecycle
 * plumbing {@link JobRunnerDeps}/{@link JobQueueDeps} already carry: where
 * yt-dlp keeps its binary, the shared "bring this file into the room" funnel,
 * and the engine injection points. Mirrors `ytdlp.ts`'s own
 * `ImportMediaOptions` shape, including its REQUIRED `importDownload`. */
export interface DownloadEngineDeps {
  /** Where yt-dlp's binary lives — `ytdlpPath(dataDir)`/`ensureYtdlp`. Passed
   * explicitly: no Electron `app` module seam exists in this migration yet,
   * the same call `ytdlp.ts`'s own module doc makes. */
  dataDir: string;
  importDownload: ImportDownloadFn;
  /** FETCH-engine seam — see this module's doc. */
  downloadToTemp?: DownloadToTempFn;
  /** MEDIA-engine seam; defaults to the real {@link downloadMediaToTemp}. */
  downloadMedia?: DownloadMediaFn;
  /** Threaded straight through to the media engine — test injection points
   * `ytdlp.ts` already owns (a no-op when a caller supplies its own
   * {@link DownloadMediaFn} fake). */
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  maxDownloadBytes?: number;
  tempDir?: string;
  cancelPollMs?: number;
  mediaDownloadBudgetMs?: number;
}

/** What {@link startDownloadJobInner} and {@link downloadRowStarter} need: the
 * full job-queue seam (to reserve the running-job slot and register this job's
 * cancel flag exactly where `runnerDepsFrom`'s `removeCancelFlag` will later
 * look for it) plus this file's own engine deps. */
export type DownloadJobDeps = JobQueueDeps & DownloadEngineDeps;

/** What {@link spawnDownload} needs: the generic job-runner plumbing plus this
 * file's own engine deps — the same split `jobs.ts` makes for
 * `SpawnPodcastAudioDeps`, so a runner can be driven from runner deps alone. */
export type SpawnDownloadDeps = JobRunnerDeps & DownloadEngineDeps;

/** Rust: `crate::commands::require_web_access(state)` — the room's own
 * "there is nowhere to check" refusal first, then the switch. See this
 * module's DEVIATION note for why it is composed here. */
function requireWebAccess(rooms: RoomSource): void {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (!webAccessEnabled(room.db)) {
    throw new Error(WEB_OFF_MESSAGE);
  }
}

// ============================================================================
// start_download_job_inner — create + submit
// ============================================================================

/**
 * Create + submit a download job. The URL passes the literal guard here so a
 * bad address is refused at creation, not discovered by a queued runner later;
 * the full guard (DNS) runs again inside the engines.
 *
 * Throws (never returns a refusal as a value) on an unknown engine, a closed
 * room, the room's internet switch being off, a URL that fails the literal
 * SSRF pre-flight, or a full queue — mirroring the Rust source's
 * `Result<String, String>` via `?`. A caller wanting a friendly (non-error)
 * sentence for "web access is off", as `agent.rs`'s `exec_tool` arms do,
 * checks that itself first, exactly as those arms do.
 *
 * Synchronous where Rust's is an `async fn`: nothing in it ever awaits (its
 * `async` is the Tauri command signature's, not the work's), and being
 * synchronous makes structural what the Rust source only implies — the slot
 * reservation and the cancel-flag registration are both complete before the
 * caller's next line runs. The runner itself is fire-and-forget, as in Rust.
 *
 * Always returns the new job's id, whether or not it started running: a slot
 * held by other work leaves the row 'queued' for a later `pump`.
 */
export function startDownloadJobInner(
  deps: DownloadJobDeps,
  url: string,
  engine: string
): string {
  if (engine !== DOWNLOAD_ENGINE_FETCH && engine !== DOWNLOAD_ENGINE_MEDIA) {
    throw new Error("Unknown download engine.");
  }
  // Refuse at CREATION when the room is offline, rather than queueing a job
  // whose only possible outcome is a network reach the switch forbids.
  requireWebAccess(deps.rooms);
  checkPublicHttpUrl(url);

  // One read of the open room for both the row and the path the runner pins
  // its writes to — Rust's `state.with_room(|room| … (id, room.path.clone()))`
  // is one lock hold for exactly that reason.
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (atCapacity(room.db)) {
    throw new Error(QUEUE_FULL);
  }
  // No step count, for the Studio row's reason: the cursor never moves, so a
  // total of 100 turned that absence into a claim — a finished download sat in
  // History reading "Finished — 0 of 100 steps". The percentage the user
  // watches comes from the live event, which still carries its own 0–100; the
  // row itself states no fraction.
  const jobId = createJob(room.db, "download", downloadTitle(url, engine), { url, engine }, 0);
  const roomPath = room.path;

  if (tryReserve(deps.state, jobId)) {
    const cancel = new CancelFlag();
    deps.cancelState.jobCancels.set(jobId, cancel);
    void spawnDownload(runnerFor(deps), jobId, roomPath, url, engine, cancel);
  }
  return jobId;
}

/** This queue's runner deps for a download runner: the queue's own room/sink/
 * cancel registry and slot handoff ({@link runnerDepsFrom}) plus the engine
 * deps carried alongside them. Spread rather than field-by-field so a new
 * {@link DownloadEngineDeps} option can never be silently dropped on the way
 * to the runner; the queue-only members that ride along are inert here. */
function runnerFor(deps: DownloadJobDeps): SpawnDownloadDeps {
  return { ...deps, ...runnerDepsFrom(deps) };
}

// ============================================================================
// start_download_row — the queue's RowStarter for an existing 'download' row
// ============================================================================

/** Read a string field off a stored plan blob, or `null` if it isn't one — the
 * same shape `jobQueue.ts`'s own (unexported) `planString` has, duplicated
 * rather than reaching into a sibling module's private helper or editing that
 * committed file to export one. */
function planString(plan: unknown, key: string): string | null {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  const value = (plan as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Queue-pump entry: rebuild a download job from its stored plan and spawn the
 * runner. Ported from `start_download_row`. `engineDeps` is closed over at
 * registration time (mirroring `podcastAudioRowStarter`'s `render`) rather
 * than threaded through the `RowStarter` call's own `deps`, which is the plain
 * {@link JobQueueDeps} the whole registry shares — production wires the real
 * `dataDir`/`importDownload` here, a test wires its own fakes.
 */
export function downloadRowStarter(engineDeps: DownloadEngineDeps): RowStarter {
  return async (deps, job: Job, roomPath: string, cancel: CancelFlag): Promise<RowStartResult> => {
    const url = planString(job.plan, "url");
    if (url === null) {
      return { kind: "error", message: UNREADABLE_PLAN };
    }
    const engine = planString(job.plan, "engine") ?? DOWNLOAD_ENGINE_FETCH;
    void spawnDownload(
      { ...runnerDepsFrom(deps), ...engineDeps },
      job.id,
      roomPath,
      url,
      engine,
      cancel
    );
    return { kind: "runner" };
  };
}

// ============================================================================
// spawn_download — the runner
// ============================================================================

/**
 * The runner: download by engine, import through the room's download funnel
 * (`import_download` — D13), report truthfully, free the queue slot. Ported
 * from `spawn_download`, using `spawnJobRunner` for the crash-safety net
 * exactly as `spawnPodcastAudio` does.
 *
 * Any error raised while the cancel flag is set is reported as a clean Pause
 * rather than a failure to explain — the same convention the studio and
 * podcast runners use — because a download rejection racing a Stop is exactly
 * what a deliberate cancel looks like from here, and inventing a distinct "was
 * it really an error" signal would only re-derive `cancel` itself.
 *
 * Exported (Rust's `fn spawn_download` is module-private) so a test can await
 * the whole lifecycle directly, the same reason `jobs.ts` exports
 * `spawnPodcastAudio`; returns the settled promise for that reason too, while
 * real callers fire and forget it as Rust's `spawn` does.
 */
export function spawnDownload(
  deps: SpawnDownloadDeps,
  jobId: string,
  roomPath: string,
  url: string,
  engine: string,
  cancel: CancelFlag
): Promise<void> {
  return spawnJobRunner(deps, jobId, roomPath, async () => {
    const startingDb = pinnedDb(deps.rooms, roomPath);
    if (startingDb !== null) {
      setJobStatus(startingDb, jobId, "running", null);
    }
    emitProgress(deps.sink, jobId, "Downloading…", 0, 100);

    // Ok(meta) = imported; Err(None) = paused (Stop); Err(Some(e)) = error.
    let outcome:
      | { readonly kind: "done"; readonly meta: FileMeta }
      | { readonly kind: "paused" }
      | { readonly kind: "error"; readonly error: string };
    try {
      const meta = await runDownload(deps, jobId, url, engine, cancel);
      outcome = { kind: "done", meta };
    } catch (err) {
      outcome = cancel.load()
        ? { kind: "paused" }
        : { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }

    const finishingDb = pinnedDb(deps.rooms, roomPath);
    if (finishingDb !== null) {
      const [status, error]: [string, string | null] =
        outcome.kind === "done"
          ? ["done", null]
          : outcome.kind === "paused"
            ? ["paused", null]
            : ["error", outcome.error];
      setJobStatus(finishingDb, jobId, status, error);
    }
    deps.removeCancelFlag(jobId);

    if (outcome.kind === "done") {
      deps.sink.emit({
        jobId,
        label: `${outcome.meta.name} arrived in the room`,
        done: 100,
        total: 100,
        finished: true,
        fileId: outcome.meta.id,
      });
    } else if (outcome.kind === "paused") {
      deps.sink.emit({ jobId, label: "Paused", done: 0, total: 100, paused: true });
    } else {
      deps.sink.emit({
        jobId,
        label: `Download failed — ${outcome.error}`,
        done: 0,
        total: 100,
        failed: true,
      });
    }
    await deps.onSettled(jobId);
  });
}

/** Best-effort work-dir sweep — Rust's `let _ = std::fs::remove_dir_all(…)`. */
async function bestEffortRemoveDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort by design: a temp dir that outlives its job is not a reason
    // to fail an import that already succeeded.
  }
}

/**
 * One download by engine, ending in the room. Byte progress maps onto the
 * 0–100 card; a fetch with no declared length just keeps its bar at zero
 * rather than inventing one. Ported from `run_download`.
 */
async function runDownload(
  deps: SpawnDownloadDeps,
  jobId: string,
  url: string,
  engine: string,
  cancel: CancelFlag
): Promise<FileMeta> {
  if (engine === DOWNLOAD_ENGINE_MEDIA) {
    const downloadMedia = deps.downloadMedia ?? downloadMediaToTemp;
    const progress: MediaProgress = (status, pct) => {
      // Rust: `pct.unwrap_or(0.0).clamp(0.0, 100.0) as usize` — a cast that
      // TRUNCATES, so 42.9% reads 42, never 43.
      const done = Math.floor(Math.min(100, Math.max(0, pct ?? 0)));
      emitProgress(deps.sink, jobId, status, done, 100);
    };
    // The background job has no picker in front of it — best quality.
    const media = await downloadMedia(deps.dataDir, url, {
      maxHeight: null,
      cancel,
      progress,
      spawnFn: deps.spawnFn,
      fetchFn: deps.fetchFn,
      findFfmpegFn: deps.findFfmpegFn,
      maxDownloadBytes: deps.maxDownloadBytes,
      tempDir: deps.tempDir,
      cancelPollMs: deps.cancelPollMs,
      mediaDownloadBudgetMs: deps.mediaDownloadBudgetMs,
    });
    const name = path.basename(media.path) || "media";
    emitProgress(deps.sink, jobId, "Sealing into the room…", 99, 100);
    try {
      return await deps.importDownload(media.path, name, url);
    } finally {
      // Unconditional, exactly as Rust sweeps the work dir on the line after
      // `import_download` whether or not it returned an error.
      await bestEffortRemoveDir(media.workDir);
    }
  }

  // DOWNLOAD_ENGINE_FETCH — and anything else a legacy or corrupted stored plan
  // might carry, since `start_download_row`'s own default is this same engine.
  const downloadToTemp = deps.downloadToTemp ?? downloadToTempNotImplemented;
  const maxBytes = deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const outcome = await downloadToTemp(url, maxBytes, cancel, (got, declared) => {
    // Capped at 99, not 100: the bar reaches full only when the file is in the
    // room, and a server that declares nothing leaves it at zero rather than
    // inventing a fraction.
    const done =
      declared !== null && declared > 0
        ? Math.floor(Math.min(99, Math.max(0, (got / declared) * 100)))
        : 0;
    emitProgress(deps.sink, jobId, "Downloading…", done, 100);
  });
  if (outcome.kind === "too-large") {
    throw new Error(
      `The file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit for a room file.`
    );
  }
  emitProgress(deps.sink, jobId, "Sealing into the room…", 99, 100);
  return deps.importDownload(outcome.file.path, outcome.file.fileName, url);
}
