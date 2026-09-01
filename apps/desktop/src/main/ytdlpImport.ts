/** Cohesive extraction from ytdlp.ts; the facade preserves its public API. */
import * as path from "node:path";
import { CancelFlag } from "./cancel.js";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";
import type { FileMeta, ImportReport, MediaQualityOption } from "../shared/apiTypes.js";
import { type WebAccessCheck } from "./ytdlpFiles.js";
import { armMediaCancel, type FetchLike, MEDIA_CANCEL, type MediaProgress, noopProgress, realSpawn, runCapturing, type RunOutcome, safeRmdir, type SpawnFn, youtubeVideoId } from "./ytdlpProcess.js";
import { findFfmpeg, FORMAT_PROBE_BUDGET_MS, qualityOptions, STDERR_TAIL_LINES, tailLines, WEB_OFF_MESSAGE } from "./ytdlpOptions.js";
import { type DownloadMediaOptions, downloadMediaToTemp, knownPortOrDefault, type MediaDownload } from "./ytdlpDownload.js";
import { ensureYtdlp } from "./ytdlpInstall.js";


export interface ListMediaFormatsOptions {
  dataDir: string;
  webAccessAllowed: WebAccessCheck;
  progress?: MediaProgress;
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  /** Test-only override of {@link FORMAT_PROBE_BUDGET_MS}. */
  formatProbeBudgetMs?: number;
}


/**
 * The qualities a video actually offers, for the modal's picker. Same web
 * gating and SSRF pre-flight as the download itself — a metadata probe is
 * still an outbound reach.
 */
export async function listMediaFormats(
  url: string,
  opts: ListMediaFormatsOptions,
): Promise<MediaQualityOption[]> {
  if (!opts.webAccessAllowed()) {
    throw new Error(WEB_OFF_MESSAGE);
  }
  const trimmed = url.trim();
  const parsed = checkPublicHttpUrl(trimmed);
  await resolvePublicAddr(parsed.hostname, knownPortOrDefault(parsed));
  return probeMediaFormats(trimmed, opts);
}


/**
 * The `-j` probe engine, with the web gate and SSRF pre-flight already done
 * by {@link listMediaFormats}. See this file's header for why it is exported
 * separately; nothing in production calls it directly.
 */
export async function probeMediaFormats(
  url: string,
  opts: ListMediaFormatsOptions,
): Promise<MediaQualityOption[]> {
  const progress = opts.progress ?? noopProgress;
  const bin = await ensureYtdlp(opts.dataDir, progress, {
    fetchFn: opts.fetchFn,
    spawnFn: opts.spawnFn,
  });
  // `-j`: the video's whole info dict as one JSON line, nothing downloaded.
  const result = await runCapturing(
    opts.spawnFn ?? realSpawn,
    bin,
    ["--no-playlist", "--no-warnings", "-j", url],
    opts.formatProbeBudgetMs ?? FORMAT_PROBE_BUDGET_MS,
  );
  const info = parseFormatProbeInfo(formatProbeOutput(result));
  return qualityOptions(
    info,
    (opts.findFfmpegFn ?? (() => findFfmpeg()))() !== null,
  );
}


function formatProbeOutput(result: RunOutcome): string {
  if (result.kind === "spawn-error") {
    throw new Error(`couldn't start the video downloader: ${result.error}`);
  }
  if (result.kind === "timeout") {
    throw new Error("Looking up this video's qualities took too long.");
  }
  if (result.code !== 0) {
    throw new Error(
      `Couldn't look up this video's qualities: ${tailLines(result.stderr, STDERR_TAIL_LINES)}`,
    );
  }
  return result.stdout;
}


function parseFormatProbeInfo(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("The site's answer about this video made no sense.");
  }
}


// ------------------------------------------------------------ entry points

/**
 * The shared "bring this downloaded file into the encrypted room" funnel
 * (Rust's `import_download`: extraction, OCR/STT lanes, auto-index, privacy
 * scan, and the `source="download"` provenance with its origin URL). Takes
 * the staged file's path, its display name and the URL it came from; returns
 * (or resolves to) the room's `FileMeta`, or throws/rejects on failure.
 *
 * Typed as possibly-async even though Rust's is synchronous: the real
 * implementation is a future batch's to write and may reasonably do async
 * I/O. Every call site awaits it either way, which is a no-op for a
 * synchronous return.
 */
export type ImportDownloadFn = (
  filePath: string,
  displayName: string,
  sourceUrl: string,
) => FileMeta | Promise<FileMeta>;


export interface ImportMediaOptions {
  dataDir: string;
  maxHeight?: number | null;
  webAccessAllowed: WebAccessCheck;
  importDownload: ImportDownloadFn;
  progress?: MediaProgress;
  /** Defaults to the process-global {@link MEDIA_CANCEL} — the interactive
   * Stop button. A job runner passes its own run's flag instead. */
  cancel?: CancelFlag;
  spawnFn?: SpawnFn;
  fetchFn?: FetchLike;
  findFfmpegFn?: () => string | null;
  maxDownloadBytes?: number;
  tempDir?: string;
  cancelPollMs?: number;
  mediaDownloadBudgetMs?: number;
}


/**
 * BROWSE-2: the same download for ANY yt-dlp-supported site — what the
 * toolbar's "Download video" and the Add-link modal's non-YouTube video
 * option call. yt-dlp failing on an unsupported site surfaces truthfully.
 *
 * FAITHFUL-PORT NOTE: Rust removes the work dir and emits "Done" 100%
 * UNCONDITIONALLY — even when `import_download` itself fails — and only the
 * final `Result` differs on that path. A failed import still saying "Done"
 * reads as an inconsistency, but it is what the source does and this port
 * preserves behaviour rather than quietly improving it. Flagged here, and
 * pinned by a test, for the owner to decide.
 */
export async function importMediaUrl(
  url: string,
  opts: ImportMediaOptions,
): Promise<ImportReport> {
  const trimmed = url.trim();
  // Fail fast (and fetch nothing) when the room's internet switch is off:
  // downloading a video is as much a network reach as the browser's address
  // bar, which has been gated since BROWSE-1.
  if (!opts.webAccessAllowed()) {
    throw new Error(WEB_OFF_MESSAGE);
  }
  // Clear FIRST: a Stop pressed against a download that already ended must
  // not cancel the next one before it has fetched a byte.
  armMediaCancel();
  const progress = opts.progress ?? noopProgress;
  const media = await downloadMediaToTemp(opts.dataDir, trimmed, mediaDownloadOptions(opts, progress));
  const imported = await importDownloadedMedia(opts, media, trimmed, progress);
  return { imported: [imported], errors: [] };
}


function mediaDownloadOptions(
  opts: ImportMediaOptions,
  progress: MediaProgress,
): DownloadMediaOptions {
  return {
    maxHeight: opts.maxHeight ?? null,
    cancel: opts.cancel ?? MEDIA_CANCEL,
    progress,
    spawnFn: opts.spawnFn,
    fetchFn: opts.fetchFn,
    findFfmpegFn: opts.findFfmpegFn,
    maxDownloadBytes: opts.maxDownloadBytes,
    tempDir: opts.tempDir,
    cancelPollMs: opts.cancelPollMs,
    mediaDownloadBudgetMs: opts.mediaDownloadBudgetMs,
  };
}


async function importDownloadedMedia(
  opts: ImportMediaOptions,
  media: MediaDownload,
  sourceUrl: string,
  progress: MediaProgress,
): Promise<FileMeta> {
  progress("Sealing the video into the room…", null);
  const name = path.basename(media.path) || "video.mp4";
  let imported: FileMeta | null = null;
  let importError: unknown = null;
  try {
    imported = await opts.importDownload(media.path, name, sourceUrl);
  } catch (err) {
    importError = err;
  }
  // See the FAITHFUL-PORT NOTE: both of these run even when the import just
  // failed.
  await safeRmdir(media.workDir);
  progress("Done", 100);
  if (importError !== null) throw importError;
  return imported as FileMeta;
}


/**
 * Download a YouTube video into the room. Fetches yt-dlp on first use, saves
 * the best format it can get to a private temp folder, imports it through the
 * download funnel (so preview + background transcription just happen, and the
 * file keeps its origin URL), then removes the temp copy. The captions-only
 * import (ADD-19) remains a separate, cheaper path.
 */
export async function importYoutubeVideo(
  url: string,
  opts: ImportMediaOptions,
): Promise<ImportReport> {
  const trimmed = url.trim();
  if (youtubeVideoId(trimmed) === null) {
    throw new Error("That doesn't look like a YouTube video link.");
  }
  return importMediaUrl(trimmed, opts);
}
