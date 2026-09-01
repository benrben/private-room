/** Cohesive extraction from ytdlp.ts; the facade preserves its public API. */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { Dirent } from "node:fs";
import { killQuietly, realSpawn, safeRmdir, type SpawnedProcess } from "./ytdlpProcess.js";
import { type DownloadMediaOptions, type MediaDownload } from "./ytdlpDownload.js";
import { explainDownloadFailure, findFfmpeg, formatSelector, MAX_DOWNLOAD_BYTES, STDERR_TAIL_LINES } from "./ytdlpOptions.js";
import { ensureYtdlp } from "./ytdlpInstall.js";


interface DownloadWatch {
  closed: Promise<{ code: number | null }>;
  spawnError: () => string | null;
  stderrTail: string[];
}


interface ActiveYtdlpDownload extends DownloadWatch {
  child: SpawnedProcess;
  workDir: string;
  hasFfmpeg: boolean;
  maxBytes: number;
}


function downloadWorkDir(tempDir: string | undefined): string {
  return path.join(tempDir ?? os.tmpdir(), `arcelle-yt-${randomUUID()}`);
}


function downloadFfmpeg(opts: DownloadMediaOptions): string | null {
  return (opts.findFfmpegFn ?? (() => findFfmpeg()))();
}


function ytdlpDownloadArgs(
  workDir: string,
  ffmpeg: string | null,
  maxHeight: number | null | undefined,
): string[] {
  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "-f",
    formatSelector(ffmpeg !== null, maxHeight),
    "-o",
    path.join(workDir, "%(title).100B.%(ext)s"),
  ];
  if (ffmpeg !== null) args.push("--ffmpeg-location", ffmpeg);
  return args;
}


function watchYtdlp(child: SpawnedProcess): DownloadWatch {
  let spawnError: string | null = null;
  child.on("error", (err) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });
  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code) => resolve({ code }));
  });
  const stderrTail: string[] = [];
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (line: string) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });
  }
  return { closed, spawnError: () => spawnError, stderrTail };
}


export async function startYtdlpDownload(
  dataDir: string,
  url: string,
  opts: DownloadMediaOptions,
): Promise<ActiveYtdlpDownload> {
  const bin = await ensureYtdlp(dataDir, opts.progress, {
    spawnFn: opts.spawnFn,
    fetchFn: opts.fetchFn,
  });
  const workDir = downloadWorkDir(opts.tempDir);
  await fsp.mkdir(workDir, { recursive: true });
  opts.progress("Downloading the video…", 0);
  const ffmpeg = downloadFfmpeg(opts);
  const args = ytdlpDownloadArgs(workDir, ffmpeg, opts.maxHeight);
  args.push(url);
  const child = (opts.spawnFn ?? realSpawn)(bin, args);
  return {
    child,
    workDir,
    hasFfmpeg: ffmpeg !== null,
    maxBytes: opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES,
    ...watchYtdlp(child),
  };
}


export async function abandonDownload(
  download: ActiveYtdlpDownload,
  reason: string,
): Promise<never> {
  killQuietly(download.child);
  await download.closed;
  await safeRmdir(download.workDir);
  throw new Error(reason);
}


export async function waitForDownload(download: ActiveYtdlpDownload): Promise<void> {
  const { code } = await download.closed;
  const spawnError = download.spawnError();
  if (spawnError !== null) {
    await safeRmdir(download.workDir);
    throw new Error(`couldn't start the video downloader: ${spawnError}`);
  }
  if (code !== 0) {
    await safeRmdir(download.workDir);
    throw new Error(
      explainDownloadFailure(download.stderrTail.join(" "), download.hasFfmpeg),
    );
  }
}


export async function completedDownload(
  download: ActiveYtdlpDownload,
): Promise<MediaDownload> {
  // The finished file is whatever yt-dlp left behind (partials are cleaned up
  // by yt-dlp itself on success).
  const downloaded = await pickDownloadedFile(download.workDir);
  if (downloaded === null)
    throw new Error("The downloader finished but produced no file.");
  const size = (await fsp.stat(downloaded)).size;
  if (size > download.maxBytes) {
    await safeRmdir(download.workDir);
    throw new Error(
      `The video is ${Math.floor(size / (1024 * 1024))} MB — larger than the ` +
        `${Math.floor(download.maxBytes / (1024 * 1024))} MB limit for a room file.`,
    );
  }
  return { workDir: download.workDir, path: downloaded };
}


/** The largest non-`.part` file directly inside `dir`, or null if there is
 * none. */
async function pickDownloadedFile(workDir: string): Promise<string | null> {
  const entries = await downloadDirectoryEntries(workDir);
  if (entries === null) return null;
  let best: DownloadCandidate | null = null;
  for (const entry of entries) {
    const candidate = await downloadedFileCandidate(workDir, entry);
    if (candidate !== null) best = largerDownloadCandidate(best, candidate);
  }
  return best?.path ?? null;
}


interface DownloadCandidate {
  path: string;
  size: number;
}


async function downloadDirectoryEntries(workDir: string): Promise<Dirent[] | null> {
  try {
    return await fsp.readdir(workDir, { withFileTypes: true });
  } catch {
    return null;
  }
}


async function downloadedFileCandidate(
  workDir: string,
  entry: Dirent,
): Promise<DownloadCandidate | null> {
  if (!entry.isFile() || entry.name.endsWith(".part")) return null;
  const filePath = path.join(workDir, entry.name);
  return { path: filePath, size: await downloadedFileSize(filePath) };
}


async function downloadedFileSize(filePath: string): Promise<number> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return 0;
  }
}


function largerDownloadCandidate(
  best: DownloadCandidate | null,
  candidate: DownloadCandidate,
): DownloadCandidate {
  if (best === null || candidate.size > best.size) return candidate;
  return best;
}


// -------------------------------------------------------------- format list

/** A boolean-returning check for the room's internet on/off switch —
 * injected, per the porting brief, rather than reimplementing
 * `commands::require_web_access` (a room-settings read this batch does not
 * own). `true` means the room may reach the network. */
export type WebAccessCheck = () => boolean;
