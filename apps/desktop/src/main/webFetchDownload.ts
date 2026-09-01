import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { MAX_DOWNLOAD_BYTES, safeFileName } from "./browser/downloads.js";
import {
  bodyCapped,
  declaredLength,
  discard,
  fetchPage,
  guardedGet,
  headerString,
  type CappableResponse,
} from "./webFetchCore.js";

export const INLINE_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** A file staged to the app's temp area by {@link downloadToTemp}, ready for
 * an import step to move into the room. Ported from `Downloaded`. */
export interface Downloaded {
  path: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

/** Outcome of a capped download. `tooLarge` is an OUTCOME, not a thrown error,
 * because the caller chooses what it means: at the inline cap it promotes the
 * download to a background job (D18); at the hard cap it is a truthful refusal
 * (D15). Ported from `DownloadOutcome`. */
export type DownloadOutcome = { kind: "done"; downloaded: Downloaded } | { kind: "tooLarge" };

/**
 * The server's suggested filename from a Content-Disposition header, if any.
 * Reads `filename*=charset''value` (kept raw — percent escapes fall to
 * `safeFileName`) and quoted or bare `filename=`. Ported from
 * `disposition_file_name`, INCLUDING its order of operations: quotes are
 * trimmed from both ends first (repeatedly, like `trim_matches('"')`) and
 * whitespace after, so `filename= "x"` keeps its quotes exactly as Rust does.
 */
export function dispositionFileName(value: string): string | null {
  for (const rawPart of value.split(";")) {
    const part = rawPart.trim();
    let raw: string;
    if (part.startsWith("filename*=")) {
      const v = part.slice("filename*=".length);
      const idx = v.lastIndexOf("''");
      raw = idx === -1 ? v : v.slice(idx + 2);
    } else if (part.startsWith("filename=")) {
      raw = part.slice("filename=".length);
    } else {
      continue;
    }
    const name = raw.replace(/^"+|"+$/g, "").trim();
    if (name !== "") {
      return name;
    }
  }
  return null;
}

/**
 * A small extension → MIME table. DEVIATION from Rust, which calls the
 * `mime_guess` crate: no equivalent dependency is installed in this migration,
 * and adding one for this would be scope creep. Anything not listed reads as
 * the generic binary type, exactly as `mime_guess`'s own
 * `first_or_octet_stream()` fallback does.
 */
const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  ["html", "text/html"],
  ["htm", "text/html"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["xml", "application/xml"],
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["heic", "image/heic"],
  ["heif", "image/heic"],
  ["psd", "image/vnd.adobe.photoshop"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["jxl", "image/jxl"],
  ["svg", "image/svg+xml"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["flac", "audio/flac"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["mkv", "video/x-matroska"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["epub", "application/epub+zip"],
  ["mobi", "application/x-mobipocket-ebook"],
  ["azw", "application/vnd.amazon.ebook"],
  ["azw3", "application/vnd.amazon.ebook"],
  ["fb2", "application/x-fictionbook+xml"],
  ["cbz", "application/vnd.comicbook+zip"],
  ["7z", "application/x-7z-compressed"],
  ["rar", "application/vnd.rar"],
  ["tar", "application/x-tar"],
  ["gz", "application/gzip"],
  ["msg", "application/vnd.ms-outlook"],
]);

export function guessDownloadMime(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return "application/octet-stream";
  }
  return EXTENSION_MIME.get(fileName.slice(dot + 1).toLowerCase()) ?? "application/octet-stream";
}

function urlLastSegment(url: string): string | null {
  const segments = new URL(url).pathname.split("/").filter((segment) => segment !== "");
  return segments.length > 0 ? segments[segments.length - 1]! : null;
}

/** The staging area `download_to_temp` writes into. */
export function defaultDownloadTempDir(): string {
  return path.join(os.tmpdir(), "arcelle-downloads");
}

type CancelProbe = { load(): boolean } | null | undefined;

interface DownloadMetadata {
  fileName: string;
  mime: string;
}

interface StagedDownload {
  filePath: string;
  out: fs.WriteStream;
  closed: Promise<void>;
}

interface DownloadCopyArgs {
  stream: Readable;
  out: fs.WriteStream;
  cap: number;
  cancel: CancelProbe;
  declared: number | null;
  progress: (soFar: number, declared: number | null) => void;
  cleanUp: () => Promise<void>;
}

function declaredDownloadIsTooLarge(headers: http.IncomingHttpHeaders, cap: number): boolean {
  const declared = declaredLength(headers);
  return declared !== null && declared > cap;
}

function suggestedDownloadName(url: string, headers: http.IncomingHttpHeaders): string {
  const disposition = headers["content-disposition"];
  const fromHeader = typeof disposition === "string" ? dispositionFileName(disposition) : null;
  return fromHeader ?? urlLastSegment(url) ?? "download";
}

function downloadMime(headers: http.IncomingHttpHeaders, fileName: string): string {
  const headerMime = headerString(headers, "content-type").split(";")[0]!.trim();
  if (headerMime === "" || headerMime === "application/octet-stream") {
    return guessDownloadMime(fileName);
  }
  return headerMime;
}

function downloadMetadata(url: string, headers: http.IncomingHttpHeaders): DownloadMetadata {
  const fileName = safeFileName(suggestedDownloadName(url, headers));
  return { fileName, mime: downloadMime(headers, fileName) };
}

function openStagedDownload(tempDir: string, fileName: string): StagedDownload {
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${randomUUID()}-${fileName}`);
  const out = fs.createWriteStream(filePath);
  return {
    filePath,
    out,
    closed: new Promise<void>((resolve) => out.once("close", () => resolve())),
  };
}

async function cleanUpStagedDownload(resp: CappableResponse, stage: StagedDownload): Promise<void> {
  resp.stream.destroy();
  stage.out.destroy();
  await stage.closed;
  await fs.promises.rm(stage.filePath, { force: true }).catch(() => {});
}

async function stopCancelledDownload(cancel: CancelProbe, cleanUp: () => Promise<void>): Promise<void> {
  if (cancel?.load() !== true) {
    return;
  }
  await cleanUp();
  throw new Error("Stopped.");
}

function downloadPiece(piece: unknown): Buffer {
  return Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
}

function writeStagedChunk(out: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

function downloadStreamError(error: unknown): Error {
  if (error instanceof Error && error.message === "Stopped.") {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`The download failed partway: ${message}`);
}

async function copyDownloadStream(args: DownloadCopyArgs): Promise<number | null> {
  let total = 0;
  try {
    for await (const piece of args.stream) {
      await stopCancelledDownload(args.cancel, args.cleanUp);
      const chunk = downloadPiece(piece);
      total += chunk.length;
      if (total > args.cap) {
        await args.cleanUp();
        return null;
      }
      await writeStagedChunk(args.out, chunk);
      args.progress(total, args.declared);
    }
  } catch (error) {
    await args.cleanUp();
    throw downloadStreamError(error);
  }
  return total;
}

function finishStagedDownload(out: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    out.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

/**
 * Download any URL — binary included — to a staged temp file, streaming and
 * size-capped. Same SSRF posture as every other fetch (public-URL check, SEC-5
 * DNS pinning, hop-by-hop redirect re-checks); unlike {@link fetchPage} it
 * accepts every content type. The caller owns the staged file: import it into
 * the room, then delete it. Ported from `download_to_temp`.
 *
 * `cancel` is polled per chunk (a set flag aborts with "Stopped." and removes
 * the partial file); `progress` receives (bytes so far, declared total).
 *
 * `tempDir` is a PARAMETER (Rust hardcodes `std::env::temp_dir()`) purely so a
 * test can point it at a fresh directory and assert the partial file really is
 * gone; it defaults to the same path Rust uses.
 */
export async function downloadToTemp(
  url: string,
  cap: number,
  cancel: CancelProbe,
  progress: (soFar: number, declared: number | null) => void,
  tempDir: string = defaultDownloadTempDir()
): Promise<DownloadOutcome> {
  const resp = await guardedGet(url);
  if (declaredDownloadIsTooLarge(resp.headers, cap)) {
    discard(resp.stream);
    return { kind: "tooLarge" };
  }
  const metadata = downloadMetadata(url, resp.headers);
  const stage = openStagedDownload(tempDir, metadata.fileName);
  // `createWriteStream` opens the fd ASYNCHRONOUSLY. Deleting the partial file
  // without waiting for the stream to close first is a race the abort paths
  // lose: the unlink runs, THEN the pending open re-creates the file, and the
  // "removed the partial file" promise is quietly false. Both candidate ports
  // had this; an already-cancelled download left its empty file behind.
  const cleanUp = (): Promise<void> => cleanUpStagedDownload(resp, stage);
  // Rust polls the flag at the TOP of the loop, before awaiting a chunk — so a
  // download that starts already-cancelled writes nothing at all.
  await stopCancelledDownload(cancel, cleanUp);
  const total = await copyDownloadStream({
    stream: resp.stream,
    out: stage.out,
    cap,
    cancel,
    declared: declaredLength(resp.headers),
    progress,
    cleanUp,
  });
  if (total === null) {
    return { kind: "tooLarge" };
  }
  await finishStagedDownload(stage.out);
  return {
    kind: "done",
    downloaded: { path: stage.filePath, fileName: metadata.fileName, mime: metadata.mime, sizeBytes: total },
  };
}

// -------------------------------------------------- YouTube transcripts (ADD-19)

/** Rust's `trim_start_matches` strips the prefix REPEATEDLY; a single
 * `String.replace` does not, and "www.www.youtube.com" would then miss. */
