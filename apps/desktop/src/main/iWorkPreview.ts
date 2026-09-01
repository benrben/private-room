/** Embedded preview extraction for Pages, Keynote and Numbers ZIP bundles. */

import { readZipEntryBytes, zipEntryNames } from "./editMatchZip.js";
import { extractRawPreview } from "./rawPreview.js";

export interface IWorkPreview {
  readonly bytes: Buffer;
  readonly entryName: string;
  readonly extension: ".pdf" | ".jpg";
  readonly mimeType: "application/pdf" | "image/jpeg";
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function safeArchiveName(name: string): boolean {
  if (name.length === 0 || name.includes("\0") || name.includes("\\") || name.startsWith("/")) return false;
  return name.split("/").every((part) => part !== "..");
}

/**
 * Select a preview deterministically. A PDF wins because it can contain every
 * page/slide and supports text extraction; modern bundles with only a JPEG
 * use their root (or one package-folder-deep) `preview.jpg`.
 */
export function iWorkPreviewEntry(names: readonly string[]): string | null {
  const safe = names.filter(safeArchiveName);
  const pdf = safe.find((name) => asciiLower(name).endsWith("quicklook/preview.pdf"));
  if (pdf !== undefined) return pdf;
  return safe.find((name) => {
    const parts = asciiLower(name).split("/").filter(Boolean);
    return parts.at(-1) === "preview.jpg" && parts.length <= 2;
  }) ?? null;
}

function validPdfPreview(bytes: Buffer): boolean {
  const header = bytes.toString("ascii", 0, Math.min(bytes.length, 8));
  const tail = bytes.toString("latin1", Math.max(0, bytes.length - 2048));
  return /^%PDF-\d\.\d/.test(header) && tail.includes("%%EOF");
}

function pdfPreview(bytes: Buffer, entryName: string): IWorkPreview {
  return { bytes, entryName, extension: ".pdf", mimeType: "application/pdf" };
}

function jpegPreview(bytes: Buffer, entryName: string): IWorkPreview | null {
  const jpeg = extractRawPreview(bytes, 1);
  if (jpeg === null || jpeg.offset !== 0 || jpeg.bytes.length !== bytes.length) return null;
  return { bytes, entryName, extension: ".jpg", mimeType: "image/jpeg" };
}

/** Recover and validate the preferred embedded preview; malformed input is null. */
export function extractIWorkPreview(bytes: Uint8Array): IWorkPreview | null {
  const entryName = iWorkPreviewEntry(zipEntryNames(bytes));
  if (entryName === null) return null;
  const preview = readZipEntryBytes(bytes, entryName);
  if (preview === undefined) return null;
  const lower = asciiLower(entryName);
  if (lower.endsWith(".pdf")) {
    return validPdfPreview(preview) ? pdfPreview(preview, entryName) : null;
  }
  // iWork owns the preview and may legitimately embed a compact thumbnail.
  // The 1000px quality floor belongs only to camera-RAW extraction.
  return jpegPreview(preview, entryName);
}
