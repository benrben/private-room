/** File-viewer classification, import preflight, and RAW fallback validation. */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ViewerKind } from "../shared/apiTypes.js";
import { snapshotUnknownFormat, type DerivedPreviewStoreResult } from "./derivedPreview.js";
import { MIN_RAW_PREVIEW_WIDTH } from "./rawPreview.js";
import { renderQuickLook, type PreviewRenderFn } from "./previewTools.js";
import type { RoomContentHandle } from "./workspace/roomContent.js";
import { mediaKind } from "./peaksTools.js";
import { isCodeTextExtension } from "../shared/fileExtensions.js";
import sharp from "sharp";

export function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const FORCED_EXTENSION_VIEWERS: ReadonlyMap<string, ViewerKind> = new Map([
  ["ai", "pdf"],
  ["pdf", "pdf"],
  ["svg", "svg"],
]);

const EXTENSION_VIEWERS: ReadonlyMap<string, ViewerKind> = new Map([
  ["docx", "docx"],
  ["doc", "worddoc"],
  ["xlsx", "sheet"],
  ["xls", "sheet"],
  ["ods", "sheet"],
  ["csv", "csv"],
  ["tsv", "csv"],
  ["pptx", "slides"],
  ["ppt", "slides"],
  ["odp", "slides"],
  ["epub", "book"],
  ["mobi", "book"],
  ["azw", "book"],
  ["azw3", "book"],
  ["fb2", "book"],
  ["cbz", "book"],
  ["zip", "archive"],
  ["tar", "archive"],
  ["gz", "archive"],
  ["7z", "archive"],
  ["rar", "archive"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["html", "html"],
  ["htm", "html"],
  ["sketch", "sketch"],
  ["ipynb", "notebook"],
  ["json", "json"],
  ["srt", "subtitle"],
  ["vtt", "subtitle"],
  ["eml", "email"],
  ["msg", "email"],
  ["txt", "prose"],
  ["log", "log"],
]);

export function mediaViewerKind(mime: string, extension: string): ViewerKind | null {
  if (mime.startsWith("image/")) return "image";
  // Audio and video are resolved by the SAME `mediaKind` the transcriber
  // itself gates on (`retranscribeFile`), not by a second rule that could
  // drift away from it. It answers on the MIME first — so this is identical
  // to the `audio/*` / `video/*` prefix tests it replaces — and falls back to
  // the container extension, which is the part that matters: `.aac`, `.aiff`,
  // `.aif`, `.caf` and `.m4v` have no entry in `guessDownloadMime`'s table, so
  // they import as `application/octet-stream` and used to land in BinaryView.
  // BinaryView offers no Transcribe button, so those files could not be
  // transcribed at all — the media viewer is how the offer reaches the person.
  //
  // Chromium may still be unable to play `.caf`/`.aiff`/`.aif`, but AudioView
  // deliberately keeps its on-device Transcribe action available after a
  // media-element error.  The route here is therefore useful even when the
  // built-in player cannot decode the container; AudioView's CAF regression
  // pins that cross-process contract.
  return mediaKind(mime, extension);
}

export function fallbackViewerKind(mime: string, extension: string): ViewerKind {
  if (isCodeTextExtension(extension)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "binary";
}

export function viewerKind(name: string, mime: string): ViewerKind {
  const extension = ext(name);
  // Extension-specific formats must win over broad MIME families. Illustrator
  // files are commonly labelled PostScript or generic binary even when their
  // modern payload is PDF-compatible, while SVG has its own safe text viewer.
  const forcedKind = FORCED_EXTENSION_VIEWERS.get(extension);
  if (forcedKind !== undefined) return forcedKind;
  const media = mediaViewerKind(mime, extension);
  if (media !== null) return media;
  const extensionKind = EXTENSION_VIEWERS.get(extension);
  if (extensionKind !== undefined) return extensionKind;
  return fallbackViewerKind(mime, extension);
}

/**
 * Whether an imported file is ELIGIBLE for on-device transcription: audio or
 * video, decided by the same {@link mediaKind} resolver `retranscribeFile`
 * gates on, never by a second extension list that could drift away from it.
 *
 * ELIGIBILITY IS NOT A TRIGGER, and the difference is the owner's decision:
 * drag-dropped imports stay ON-DEMAND, because dropping a folder of two
 * hundred podcasts must not pin this Mac's CPU for hours without anyone
 * asking. What eligibility buys is the OFFER and the handling:
 *
 *  - {@link viewerKind} routes an eligible file to the media viewer, whose
 *    "Transcribe" button runs the speaker-aware pass on the one file the
 *    person actually wants. That is the on-demand affordance; before this,
 *    a `.aac`/`.aiff`/`.caf`/`.m4v` import reached BinaryView, which has no
 *    such button, so those files had no way to be transcribed at all. The
 *    routing is only half the offer: see {@link viewerKind}'s own note for the
 *    renderer guard that still hides that button on a container the media
 *    element cannot decode (`.caf`/`.aiff`/`.aif` today).
 *  - `import_files` streams an eligible original into the workspace instead
 *    of reading it whole into the main-process heap and running document
 *    extraction and OCR over video bytes.
 *
 * {@link shouldAutoTranscribeImport} is the narrower question — "run it now,
 * unasked" — and answers yes for far less than this.
 */
export function transcribeEligibleImport(name: string, mime: string): boolean {
  return mediaKind(mime, ext(name)) !== null;
}

/**
 * The one import that still transcribes itself without being asked: lossless
 * `.flac` audio, which nothing in Arcelle produces — it is a file somebody
 * deliberately kept uncompressed, and it has been auto-transcribed on import
 * since before this eligibility split existed.
 *
 * DELIBERATELY NOT `transcribeEligibleImport`. Widening this to every media
 * container is exactly what the owner refused: a bulk drop would queue every
 * file behind the single-job transcriber and run for hours. Everything else
 * eligible gets the button, not the job. If the auto case should go away
 * entirely, this function is the only thing to delete — the offer does not
 * depend on it.
 */
export function shouldAutoTranscribeImport(name: string, mime: string): boolean {
  return transcribeEligibleImport(name, mime) && ext(name) === "flac";
}

const RAW_TEXT_VIEWER_KINDS: ReadonlySet<ViewerKind> = new Set([
  "markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "sketch", "notebook",
]);

const EDITABLE_VIEWER_KINDS: ReadonlySet<ViewerKind> = new Set([
  "markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "csv", "notebook",
]);

export const RAW_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  "3fr", "arw", "cr2", "cr3", "dng", "erf", "kdc", "mos", "mrw", "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "sr2", "srf", "x3f",
]);

export const IWORK_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(["pages", "key", "numbers"]);

export function viewerKindIsEditable(kind: ViewerKind): boolean {
  return EDITABLE_VIEWER_KINDS.has(kind);
}

export function viewerKindReadsRawText(kind: ViewerKind): boolean {
  return RAW_TEXT_VIEWER_KINDS.has(kind);
}

export function jsonOrNull<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

/** Validate the complete picker selection before importing the first item.
 * Finder packages such as .numbers and .rtfd are directories; treating them
 * as flat files produced partial rows followed by UNIQUE/EISDIR errors. A
 * package-aware archive format is not defined yet, so refuse the whole batch
 * without residue. */
export async function preflightImportPaths(filePaths: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(filePaths.map(async (filePath) => {
    try {
      const info = await fs.promises.stat(filePath);
      return info.isFile()
        ? null
        : `${path.basename(filePath)}: Folder/package imports are not supported. Export or compress the package as one file first.`;
    } catch (error) {
      return `${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }));
  return checks.filter((message): message is string => message !== null);
}

/** Quick Look promises PNG bytes. Check its signature, then fully decode it
 * before trusting the dimensions or making a RAW fallback durable. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function asPngBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function hasPngHeader(png: Buffer): boolean {
  return png.length >= 24 && png.subarray(0, 8).equals(PNG_SIGNATURE) && png.toString("ascii", 12, 16) === "IHDR";
}

export function validDimensions(width: number | undefined, height: number | undefined): { width: number; height: number } | null {
  return width !== undefined && height !== undefined && width > 0 && height > 0 ? { width, height } : null;
}

export async function decodedPngDimensions(png: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const decoded = await sharp(png, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    return validDimensions(decoded.info.width, decoded.info.height);
  } catch {
    return null;
  }
}

export async function rawFallbackPngDimensions(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  const png = asPngBuffer(bytes);
  if (!hasPngHeader(png)) return null;
  // Force a complete pixel decode, not just metadata parsing. A forged IHDR
  // with missing/truncated IDAT bytes must never become a durable preview.
  return decodedPngDimensions(png);
}

/** Decode Quick Look's PNG completely, enforce the RAW minimum, and publish a
 * normal JPEG that the image viewer can reopen without relying on Quick Look. */
export async function rawFallbackJpeg(png: Uint8Array): Promise<Buffer | null> {
  const dimensions = await rawFallbackPngDimensions(png);
  if (dimensions === null || dimensions.width < MIN_RAW_PREVIEW_WIDTH) return null;
  try {
    const jpeg = await sharp(png, { failOn: "error" }).jpeg({ quality: 90 }).toBuffer();
    const verified = await sharp(jpeg, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    return verified.info.width >= MIN_RAW_PREVIEW_WIDTH && verified.info.height > 0 ? jpeg : null;
  } catch {
    return null;
  }
}

/** Store a RAW Quick Look fallback only when it is a readable, full-size PNG.
 * Returning unavailable keeps an unsupported CR2 honest instead of silently
 * persisting corrupt pixels or another small embedded thumbnail. */
export function snapshotRawFallback(
  room: RoomContentHandle,
  originalId: string,
  render: PreviewRenderFn = renderQuickLook,
): Promise<DerivedPreviewStoreResult> {
  return snapshotUnknownFormat(room, originalId, render, {
    prepare: async (png) => {
      const jpeg = await rawFallbackJpeg(png);
      return jpeg === null ? null : { bytes: jpeg, mimeType: "image/jpeg", extension: "jpg" };
    },
  });
}
