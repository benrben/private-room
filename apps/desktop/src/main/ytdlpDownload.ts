/** Cohesive extraction from ytdlp.ts; the facade preserves its public API. */
import { createInterface } from "node:readline";
import { CancelFlag } from "./cancel.js";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";
import { type FetchLike, type MediaProgress, type SpawnFn } from "./ytdlpProcess.js";
import { CANCEL_POLL_MS, MAX_DOWNLOAD_BYTES, MEDIA_DOWNLOAD_BUDGET_MS, parseYtdlpPercent, parseYtdlpTotalBytes } from "./ytdlpOptions.js";
import { abandonDownload, completedDownload, startYtdlpDownload, waitForDownload } from "./ytdlpFiles.js";


// ------------------------------------------------------------- the download

/** A media file staged by yt-dlp: the work dir to sweep and the file inside
 * it. */
export interface MediaDownload {
  workDir: string;
  path: string;
}


/** The minimal shape {@link pumpDownloadProgress} needs — satisfied by a real
 * `ChildProcess`, by {@link SpawnedProcess}, and by a bare `{ stdout }` in a
 * test that wants to drive the loop with nothing but a `PassThrough`. */
export interface StdoutSource {
  readonly stdout: NodeJS.ReadableStream | null;
}


/**
 * Read the downloader's stdout line by line, watching three things at once —
 * exactly Rust's `tokio::select!` loop: an announced total over the cap
 * (abandon in the first second, not after the file fully arrives), the Stop
 * flag, and the overall budget. Returns the abandonment reason, or `null` if
 * the stream simply ended (the process is on its way out; the caller reads
 * its real exit code next).
 *
 * Stop used to be checked only when a progress line ARRIVED, so a stalled
 * download ignored it completely — hence the timer racing the read rather
 * than a check inside the line handler. The race is on the pending read
 * itself rather than on closing the reader from a timer, so nothing depends
 * on `Interface#close()` interrupting an in-flight `next()`.
 *
 * Exported as its own seam so the cancellation/budget/oversize logic can be
 * exercised deterministically against a scripted `PassThrough`, without
 * spawning anything or waiting out the real one-hour budget.
 */
export async function pumpDownloadProgress(
  child: StdoutSource,
  cancel: CancelFlag | undefined,
  progress: MediaProgress,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
  budgetMs: number = MEDIA_DOWNLOAD_BUDGET_MS,
  pollMs: number = CANCEL_POLL_MS,
): Promise<string | null> {
  if (!child.stdout) return null;
  const rl = createInterface({ input: child.stdout });
  const iter = rl[Symbol.asyncIterator]();
  try {
    return await pumpYtdlpLines(iter, cancel, progress, maxBytes, budgetMs, pollMs);
  } finally {
    rl.close();
  }
}


async function pumpYtdlpLines(
  iter: AsyncIterator<string>,
  cancel: CancelFlag | undefined,
  progress: MediaProgress,
  maxBytes: number,
  budgetMs: number,
  pollMs: number,
): Promise<string | null> {
  const started = Date.now();
  let pending = nextYtdlpLine(iter);
  for (;;) {
    const winner = await nextYtdlpReadEvent(pending, pollMs);
    const outcome = ytdlpReadOutcome(winner, iter, maxBytes, progress);
    if (outcome.done) return null; // stdout closed: the process is on its way out.
    if (outcome.pending !== null) pending = outcome.pending;
    if (outcome.rejection !== null) return outcome.rejection;
    const stopped = downloadStopReason(cancel, started, budgetMs);
    if (stopped !== null) return stopped;
  }
}


interface YtdlpReadOutcome {
  done: boolean;
  pending: Promise<IteratorResult<string>> | null;
  rejection: string | null;
}


function ytdlpReadOutcome(
  event: YtdlpReadEvent,
  iter: AsyncIterator<string>,
  maxBytes: number,
  progress: MediaProgress,
): YtdlpReadOutcome {
  if (event.tag === "poll") return { done: false, pending: null, rejection: null };
  if (event.result.done) return { done: true, pending: null, rejection: null };
  return {
    done: false,
    pending: nextYtdlpLine(iter),
    rejection: downloadLineRejection(event.result.value, maxBytes, progress),
  };
}


type YtdlpReadEvent =
  | { tag: "line"; result: IteratorResult<string> }
  | { tag: "poll" };


function nextYtdlpLine(iter: AsyncIterator<string>): Promise<IteratorResult<string>> {
  // A stream error means the process is on its way out; the caller reads its
  // real exit code and explains the failure from stderr, so a rejection here
  // is folded into "the stream ended" rather than thrown from the pump.
  return iter
    .next()
    .catch(() => ({ done: true, value: undefined }) as IteratorResult<string>);
}


async function nextYtdlpReadEvent(
  pending: Promise<IteratorResult<string>>,
  pollMs: number,
): Promise<YtdlpReadEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = new Promise<{ tag: "poll" }>((resolve) => {
    timer = setTimeout(() => resolve({ tag: "poll" }), pollMs);
  });
  const winner = await Promise.race([
    pending.then((result) => ({ tag: "line" as const, result })),
    poll,
  ]);
  clearTimeout(timer);
  return winner;
}


function downloadLineRejection(
  line: string,
  maxBytes: number,
  progress: MediaProgress,
): string | null {
  // A file the room will refuse is abandoned on the FIRST progress line, not
  // after it fully arrives — same truthful refusal, an hour earlier.
  const total = parseYtdlpTotalBytes(line);
  if (total !== null && total > maxBytes) return oversizedDownloadMessage(total, maxBytes);
  const percent = parseYtdlpPercent(line);
  if (percent !== null) progress("Downloading the video…", percent);
  return null;
}


function oversizedDownloadMessage(total: number, maxBytes: number): string {
  return (
    `This video is about ${Math.floor(total / (1024 * 1024))} MB — larger than the ` +
    `${Math.floor(maxBytes / (1024 * 1024))} MB limit for a room file. ` +
    "Stopped before downloading it."
  );
}


function downloadStopReason(
  cancel: CancelFlag | undefined,
  started: number,
  budgetMs: number,
): string | null {
  if (cancel?.load() === true) return "Stopped.";
  if (Date.now() - started <= budgetMs) return null;
  return `The video download gave up after ${Math.floor(budgetMs / 60_000)} minutes — it may be stalled.`;
}


/** Everything {@link downloadMediaToTemp} takes beyond the data dir and the
 * URL. The `*Fn`/`*Ms`/`maxDownloadBytes`/`tempDir` members are injection
 * points for the test suite; production callers pass only `maxHeight`,
 * `cancel` and `progress`. */
export interface DownloadMediaOptions {
  maxHeight?: number | null;
  /** Polled the same way Rust's `Option<&AtomicBool>` was: a Stop lands
   * within {@link CANCEL_POLL_MS} even while the downloader is silent. */
  cancel?: CancelFlag;
  progress: MediaProgress;
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  maxDownloadBytes?: number;
  tempDir?: string;
  cancelPollMs?: number;
  mediaDownloadBudgetMs?: number;
}


/**
 * BROWSE-2: download the media at any yt-dlp-supported URL into a temp work
 * dir. Format choice is {@link formatSelector}'s: pre-muxed first, split
 * streams joined by a system ffmpeg when the machine has one.
 *
 * D16: yt-dlp is a subprocess doing its own networking, so the SSRF guard
 * cannot pin its connections — it gets a pre-flight instead (literal check +
 * DNS resolve of the target). The redirect residual risk is documented and
 * accepted, the same posture the YouTube feature always shipped with.
 * D15: the size cap is enforced on the finished file before import, AND on
 * the first progress line that announces an over-cap total.
 */
export async function downloadMediaToTemp(
  dataDir: string,
  url: string,
  opts: DownloadMediaOptions,
): Promise<MediaDownload> {
  const parsed = checkPublicHttpUrl(url);
  await resolvePublicAddr(parsed.hostname, knownPortOrDefault(parsed));
  return runYtdlpDownload(dataDir, url, opts);
}


/** `URL.port` is `""` for a default port; fill in the scheme's known default
 * the way Rust's `Url::port_or_known_default` does. */
export function knownPortOrDefault(parsed: URL): number {
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "http:" ? 80 : 443;
}


/**
 * The yt-dlp subprocess engine, with the SSRF pre-flight already done by
 * {@link downloadMediaToTemp}. See this file's header for why it is exported
 * separately; nothing in production calls it directly.
 */
export async function runYtdlpDownload(
  dataDir: string,
  url: string,
  opts: DownloadMediaOptions,
): Promise<MediaDownload> {
  const download = await startYtdlpDownload(dataDir, url, opts);
  const abandoned = await pumpDownloadProgress(
    download.child,
    opts.cancel,
    opts.progress,
    download.maxBytes,
    opts.mediaDownloadBudgetMs ?? MEDIA_DOWNLOAD_BUDGET_MS,
    opts.cancelPollMs ?? CANCEL_POLL_MS,
  );
  if (abandoned !== null) await abandonDownload(download, abandoned);
  await waitForDownload(download);
  return completedDownload(download);
}
