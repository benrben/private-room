/** Cohesive extraction from ytdlp.ts; the facade preserves its public API. */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ChunkReader } from "./sidecar.js";
import { looksLikeMacosBinary, MAX_YTDLP_BYTES, MIN_YTDLP_BYTES, YTDLP_FETCH_TIMEOUT_MS, YTDLP_STALE_AFTER_MS, YTDLP_UPDATE_BUDGET_MS, YTDLP_URL, ytdlpPath } from "./ytdlpOptions.js";
import { type FetchLike, type HttpResponseLike, type MediaProgress, realFetch, realSpawn, type RefreshYtdlpDeps, refreshYtdlpIfStale, runCapturing, safeUnlink, type SpawnFn, swapDownloading } from "./ytdlpProcess.js";


export function isStaleYtdlp(mtimeMs: number, now: () => number): boolean {
  return now() - mtimeMs > YTDLP_STALE_AFTER_MS;
}


export async function refreshYtdlp(
  dest: string,
  progress: MediaProgress,
  deps: RefreshYtdlpDeps,
  now: () => number,
): Promise<void> {
  progress("Updating the video downloader…", null);
  const result = await runCapturing(
    deps.spawnFn ?? realSpawn,
    dest,
    ["-U"],
    deps.updateBudgetMs ?? YTDLP_UPDATE_BUDGET_MS,
  );
  if (result.kind === "exited" && result.code === 0) await stampYtdlpRefresh(dest, now);
}


async function stampYtdlpRefresh(dest: string, now: () => number): Promise<void> {
  // "Already up to date" leaves the file (and its mtime) untouched, which
  // would re-run this check on every download for the rest of the release
  // gap — mark the check done either way.
  const stamp = new Date(now());
  try {
    await fsp.utimes(dest, stamp, stamp);
  } catch {
    // Best-effort.
  }
}


export interface EnsureYtdlpDeps {
  fetchFn?: FetchLike;
  spawnFn?: SpawnFn;
  now?: () => number;
  /** Test-only overrides of {@link MAX_YTDLP_BYTES}/{@link MIN_YTDLP_BYTES}/
   * {@link YTDLP_FETCH_TIMEOUT_MS}. They exist so the oversized, undersized
   * and stalled-body branches can be exercised with a few hundred bytes and a
   * few milliseconds instead of 200 MB and ten minutes. Production callers
   * never pass them. */
  maxBytes?: number;
  minBytes?: number;
  fetchTimeoutMs?: number;
}


/** A deadline fired while waiting for something that has no timeout of its
 * own. */
const DEADLINE = Symbol("deadline");


function raceDeadline<T>(
  work: Promise<T>,
  deadline: AbortSignal,
): Promise<T | typeof DEADLINE> {
  if (deadline.aborted) return Promise.resolve(DEADLINE);
  return new Promise<T | typeof DEADLINE>((resolve, reject) => {
    const onAbort = (): void => resolve(DEADLINE);
    deadline.addEventListener("abort", onAbort, { once: true });
    // `work`'s own rejection is handled here whether or not the deadline won
    // the race, so abandoning it can never surface as an unhandled rejection.
    work.then(
      (v) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        deadline.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}


/**
 * Fetch the yt-dlp binary if it isn't installed yet, or let it refresh itself
 * if it's stale. `.part` + rename so a failed download never leaves a half
 * binary behind (stt_download_model's pattern).
 */
export async function ensureYtdlp(
  dataDir: string,
  progress: MediaProgress,
  deps: EnsureYtdlpDeps = {},
): Promise<string> {
  const dest = ytdlpPath(dataDir);
  if (fs.existsSync(dest)) {
    await refreshYtdlpIfStale(dest, progress, {
      spawnFn: deps.spawnFn,
      now: deps.now,
    });
    return dest;
  }
  if (swapDownloading(true)) {
    throw new Error(
      "The video downloader is already being installed — try again in a moment.",
    );
  }
  try {
    await downloadYtdlpBinary(dest, progress, deps);
    return dest;
  } finally {
    swapDownloading(false);
  }
}


interface YtdlpDownloadConfig {
  maxBytes: number;
  minBytes: number;
  timeoutMs: number;
  fetchFn: FetchLike;
}


interface YtdlpFetchDeadline {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  timedOut: Error;
}


interface YtdlpStreamResult {
  got: number;
  headBytes: number[];
  stopped: "stalled" | "oversized" | null;
}


function ytdlpDownloadConfig(deps: EnsureYtdlpDeps): YtdlpDownloadConfig {
  return {
    maxBytes: deps.maxBytes ?? MAX_YTDLP_BYTES,
    minBytes: deps.minBytes ?? MIN_YTDLP_BYTES,
    timeoutMs: deps.fetchTimeoutMs ?? YTDLP_FETCH_TIMEOUT_MS,
    fetchFn: deps.fetchFn ?? realFetch,
  };
}


async function prepareYtdlpDownload(
  dest: string,
  progress: MediaProgress,
): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  progress("Getting the video downloader (first time only)…", null);
}


function ytdlpFetchDeadline(timeoutMs: number): YtdlpFetchDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    timer,
    timedOut: new Error(
      `downloader fetch failed: gave up after ${Math.floor(timeoutMs / 1000)}s with no answer`,
    ),
  };
}


async function fetchYtdlpResponse(
  fetchFn: FetchLike,
  deadline: YtdlpFetchDeadline,
): Promise<HttpResponseLike> {
  let response: HttpResponseLike;
  try {
    response = await fetchFn(YTDLP_URL, {
      signal: deadline.controller.signal,
    });
  } catch (error) {
    if (deadline.controller.signal.aborted) throw deadline.timedOut;
    throw new Error(
      `downloader fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new Error(`downloader fetch failed: HTTP ${response.status}`);
  return response;
}


function declaredYtdlpLength(response: HttpResponseLike): number | null {
  const header = response.headers.get("content-length");
  const parsed = header === null ? null : Number(header);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}


function assertPlausibleYtdlpLength(
  declared: number | null,
  maxBytes: number,
): void {
  if (declared !== null && declared > maxBytes) {
    throw new Error(
      "The video downloader download is implausibly large — refused.",
    );
  }
}


function ytdlpDownloadTotal(declared: number | null): number {
  return declared ?? 35 * 1024 * 1024;
}


function ytdlpResponseBody(
  response: HttpResponseLike,
): NonNullable<HttpResponseLike["body"]> {
  if (response.body === null)
    throw new Error("downloader fetch failed: empty response body");
  return response.body;
}


function collectYtdlpHeader(headBytes: number[], value: Uint8Array): void {
  if (headBytes.length >= 4) return;
  const limit = Math.min(4 - headBytes.length, value.length);
  for (let index = 0; index < limit; index += 1) {
    const byte = value[index];
    if (byte !== undefined) headBytes.push(byte);
  }
}


async function streamYtdlpBytes(
  reader: ChunkReader,
  handle: fsp.FileHandle,
  deadline: AbortSignal,
  maxBytes: number,
  total: number,
  progress: MediaProgress,
): Promise<YtdlpStreamResult> {
  let got = 0;
  const headBytes: number[] = [];
  for (;;) {
    const step = await raceDeadline(reader.read(), deadline);
    if (step === DEADLINE) return { got, headBytes, stopped: "stalled" };
    if (step.done || !step.value) return { got, headBytes, stopped: null };
    got += step.value.length;
    if (got > maxBytes) return { got, headBytes, stopped: "oversized" };
    collectYtdlpHeader(headBytes, step.value);
    await handle.write(step.value);
    progress(
      "Getting the video downloader (first time only)…",
      Math.min((got / total) * 100, 100),
    );
  }
}


async function downloadYtdlpPart(
  part: string,
  body: NonNullable<HttpResponseLike["body"]>,
  deadline: AbortSignal,
  config: YtdlpDownloadConfig,
  total: number,
  progress: MediaProgress,
): Promise<YtdlpStreamResult> {
  const handle = await fsp.open(part, "w");
  try {
    return await streamYtdlpBytes(
      body.getReader(),
      handle,
      deadline,
      config.maxBytes,
      total,
      progress,
    );
  } finally {
    await handle.close();
  }
}


async function rejectInvalidYtdlpPart(
  part: string,
  result: YtdlpStreamResult,
  minBytes: number,
  timedOut: Error,
): Promise<void> {
  if (result.stopped === "stalled") {
    await safeUnlink(part);
    throw timedOut;
  }
  if (result.stopped === "oversized") {
    await safeUnlink(part);
    throw new Error(
      "The video downloader download is implausibly large — refused.",
    );
  }
  if (
    result.got < minBytes ||
    !looksLikeMacosBinary(Uint8Array.from(result.headBytes))
  ) {
    await safeUnlink(part);
    throw new Error(
      "What arrived is not the video downloader — the download was refused rather than run.",
    );
  }
}


async function installYtdlpPart(part: string, dest: string): Promise<void> {
  await fsp.chmod(part, 0o755);
  await fsp.rename(part, dest);
}


async function downloadYtdlpBinary(
  dest: string,
  progress: MediaProgress,
  deps: EnsureYtdlpDeps,
): Promise<void> {
  const config = ytdlpDownloadConfig(deps);
  await prepareYtdlpDownload(dest, progress);
  const part = `${dest}.part`;
  const deadline = ytdlpFetchDeadline(config.timeoutMs);
  try {
    const response = await fetchYtdlpResponse(config.fetchFn, deadline);
    const declared = declaredYtdlpLength(response);
    assertPlausibleYtdlpLength(declared, config.maxBytes);
    const result = await downloadYtdlpPart(
      part,
      ytdlpResponseBody(response),
      deadline.controller.signal,
      config,
      ytdlpDownloadTotal(declared),
      progress,
    );
    await rejectInvalidYtdlpPart(
      part,
      result,
      config.minBytes,
      deadline.timedOut,
    );
    await installYtdlpPart(part, dest);
  } finally {
    clearTimeout(deadline.timer);
  }
}
