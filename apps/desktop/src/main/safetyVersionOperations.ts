import type Database from "better-sqlite3-multiple-ciphers";
import type { FileVersion, Provenance, VersionContent } from "../shared/apiTypes.js";
import { deleteFileVersion as dbDeleteFileVersion, getVersion, listFileVersions as dbListFileVersions, setVersionPinned as dbSetVersionPinned, versionProvenanceJson } from "./db-host/fileVersionsList.js";
import { getFileFull, getFileName, inTransaction, updateFileContent } from "./db-host/files.js";
import { fileProvenance } from "./db-host/artifacts.js";
import { setRecMeta } from "./db-host/recordings.js";
import { setFileProvenance, snapshotFileVersion, VERSIONS_KEPT } from "./db-host/versions.js";
import { extractText } from "./editMatch.js";
import { decodeTextBytes, extensionOf, isImage, isTextExtension } from "./editMatchExtraction.js";
import { mediaKind } from "./peaksTools.js";
import { clampBytes } from "./textClamp.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


// ============================================================================
// File versions (ADD-2) — thin readers/writers over the db-host layer
// ============================================================================

/** How many unpinned versions a file keeps — so the History strip can SAY it.
 * Ported from `file_versions_kept`. */
export function fileVersionsKept(): number {
  return VERSIONS_KEPT;
}


/** ADD-2: a file's saved versions (newest first). Ported from
 * `list_file_versions`. */
export function listFileVersions(db: Database.Database, id: string): FileVersion[] {
  return dbListFileVersions(db, id);
}


/** Keep (or stop keeping) one saved version. Ported from
 * `pin_file_version`. */
export function pinFileVersion(db: Database.Database, versionId: string, pinned: boolean): void {
  dbSetVersionPinned(db, versionId, pinned);
}


/** Delete one saved version outright. Ported from `delete_file_version`. */
export function deleteFileVersion(db: Database.Database, versionId: string): void {
  dbDeleteFileVersion(db, versionId);
}


/** ART-1: what produced the file's CURRENT content, if the app recorded it.
 * Ported from `get_file_provenance`. */
export function getFileProvenance(db: Database.Database, id: string): Provenance | null {
  return fileProvenance(db, id);
}
export

// -------------------------------------------------------- version compare (Idea 11)

/** Strict UTF-8 decode, matching Rust's `String::from_utf8(bytes).ok()` — NOT
 * `Buffer.prototype.toString("utf8")`, which is lossy (invalid sequences
 * become U+FFFD rather than failing). `TextDecoder`'s `fatal` mode rejects
 * exactly what Rust's strict validator rejects, so a legacy binary snapshot
 * (a JPEG, a PDF) answers `null` here rather than a string of replacement
 * boxes standing in for real content. */
function utf8OrNull(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
export

/**
 * The text a version saved BEFORE compound snapshots (its `text` column is
 * NULL) is re-derived with — Rust's
 * `extraction::extract_text(name, bytes).or_else(|| String::from_utf8(bytes).ok())`,
 * both arms, in that order. `version_content` and `restore_version_into`
 * share this chain in the Rust source precisely so a compare shows what a
 * restore would write; they share it here for the same reason.
 *
 * ORDER IS THE WHOLE POINT and dropping the first arm was not equivalent: a
 * legacy `.html` version fell through to the raw-UTF-8 arm and put MARKUP
 * (`<h1>Hi</h1>…`) into `extracted_text`, i.e. into the search index, where
 * Rust puts the stripped prose; a legacy `.txt` in a non-UTF-8 encoding
 * (cp1252, a latin-1 export) failed the strict decode outright and restored
 * with NO indexed text at all, where Rust's `decode_text_bytes` reads it.
 *
 * {@link extractText} is `editMatch.ts`'s port of that extractor, and it is
 * NARROWER than the Rust one by its own documented scope: text extensions,
 * `.docx` and `.html`/`.htm`. pdf/xlsx/pptx/legacy-Office/epub/rtf/iWork/
 * ipynb/eml/subtitle/svg/sketch each need their own extractor module that no
 * batch has ported yet, so a legacy version of one of THOSE still answers
 * `null` here rather than Rust's re-extracted prose. That is the real,
 * remaining gap — narrower than "the extractor is unported", which this
 * file's header used to claim and which was simply not true.
 */
function rederiveVersionText(name: string, bytes: Buffer): string | null {
  return extractText(name, bytes) ?? utf8OrNull(bytes);
}
export

/** Clip huge extracted text at a UTF-8 byte boundary for preview/compare
 * payloads. Ported from `clip_preview`, reusing `textClamp.ts`'s already-
 * ported `clampBytes` (cut-without-reserving, matching `clip_preview`'s own
 * "truncate then push_str the marker" order — unlike `clampBytesMarked`,
 * which reserves the marker's bytes INSIDE the ceiling). */
function clipPreview(t: string): string {
  if (Buffer.byteLength(t, "utf8") > 1_000_000) {
    return `${clampBytes(t, 1_000_000)}\n\n… (truncated preview)`;
  }
  return t;
}
export

/** Ceiling past which a raw-text row degrades to a clipped read-only preview
 * (`PLAIN`, i.e. `Extracted`) instead of an editable Raw buffer. Ported from
 * `formats::MAX_RAW_TEXT_BYTES`. */
const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;
export type TextSource = "raw" | "extracted";
export

/**
 * NARROW SLICE of `formats.rs`'s `FORMATS` table: only the `text`
 * (`TextSource`) and `max_bytes` columns `content_text`/`classify_file`
 * actually consult. `kind`/`editable`/`delivery` are NOT reproduced — nothing
 * in this file reads them, and reproducing them would be a second, drifting
 * copy of a registry this migration has not ported as its own module yet
 * (confirmed: no `classifyFile`/`FileView` export exists anywhere in this
 * tree). Same scope-line convention `editMatchExtraction.ts`'s own header
 * documents for its slice of `extraction.rs`: "a future `formats.rs` batch
 * extends this file" if more of the table is ever needed here.
 */
const FORMAT_TEXT_SOURCE: ReadonlyMap<string, { text: TextSource; maxBytes: number | null }> = new Map([
  ["pdf", { text: "extracted", maxBytes: null }],
  ["docx", { text: "extracted", maxBytes: null }],
  ["xlsx", { text: "extracted", maxBytes: null }],
  ["xls", { text: "extracted", maxBytes: null }],
  ["ods", { text: "extracted", maxBytes: null }],
  ["pptx", { text: "extracted", maxBytes: null }],
  ["ppt", { text: "extracted", maxBytes: null }],
  ["doc", { text: "extracted", maxBytes: null }],
  ["rtf", { text: "extracted", maxBytes: null }],
  ["epub", { text: "extracted", maxBytes: null }],
  ["zip", { text: "extracted", maxBytes: null }],
  ["csv", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["tsv", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["md", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["markdown", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["html", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["htm", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["svg", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["sketch", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["ipynb", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["json", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["jsonl", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["ndjson", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["srt", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["vtt", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["eml", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["txt", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
  ["log", { text: "raw", maxBytes: MAX_RAW_TEXT_BYTES }],
]);
export

/** Ported from `classify_file(...).text` — extension wins over MIME (a raw
 * row past its ceiling degrades to `extracted`, an unregistered extension
 * falls through to image/code/plain, exactly as the Rust table does). */
function classifyTextSource(name: string, mime: string, len: number): TextSource {
  const ext = extensionOf(name);
  return registeredTextSource(ext, len) ?? fallbackTextSource(ext, mime, len);
}
export function registeredTextSource(ext: string, len: number): TextSource | null {
  const row = FORMAT_TEXT_SOURCE.get(ext);
  if (row === undefined) return null;
  return row.maxBytes === null || len <= row.maxBytes ? row.text : "extracted";
}
export function fallbackTextSource(ext: string, mime: string, len: number): TextSource {
  if (isImage(mime)) return "extracted";
  return isTextExtension(ext) && len <= MAX_RAW_TEXT_BYTES ? "raw" : "extracted";
}


/**
 * The text representation the viewer AND the Idea 11 compare view show for a
 * file's bytes — both shaped identically so the two diff panes can never
 * disagree about which representation they're comparing. Ported from
 * `commands::files::content_text`.
 */
export function contentText(
  name: string,
  mime: string,
  bytes: Buffer,
  extracted: string | null
): string | null {
  const ext = extensionOf(name);
  // Media (audio/video/recording): the transcript is the comparable text.
  if (mediaKind(mime, ext) !== null) {
    return extracted !== null ? clipPreview(extracted) : null;
  }
  const source = classifyTextSource(name, mime, bytes.length);
  if (source === "raw") {
    return clipPreview(decodeTextBytes(bytes));
  }
  return extracted !== null ? clipPreview(extracted) : null;
}


/**
 * Idea 11: the text of one saved version alongside the file's CURRENT text,
 * both shaped by `contentText` so the compare view diffs like-for-like. Pure
 * over a `Database` handle, matching `version_content`'s own Rust
 * signature. Throws when the version id is unknown ({@link getVersion}'s
 * `VERSION_NOT_AVAILABLE`) or when the owning file is gone/trashed
 * ({@link getFileFull}'s "no rows" — trashed files are excluded there the
 * same way `get_file_full` excludes them in Rust, which is what makes a
 * trashed file's compare view correctly refuse rather than diff a deleted
 * file's text).
 */
export function versionContent(db: Database.Database, versionId: string): VersionContent {
  const v = getVersion(db, versionId);
  const [name, mimeRaw, currentBytesRaw, currentExtracted] = getFileFull(db, v.fileId);
  const mime = mimeRaw ?? "";
  // Versions saved before compound snapshots carry no text: re-derive it
  // exactly as `restoreVersionInto` does, so the diff matches a restore.
  const versionText = v.text !== null ? v.text : rederiveVersionText(name, v.bytes);
  const currentBytes = currentBytesRaw ?? Buffer.alloc(0);
  return {
    fileName: name,
    versionText: contentText(name, mime, v.bytes, versionText),
    currentText: contentText(name, mime, currentBytes, currentExtracted),
  };
}
export async function workspaceVersionContent(
  db: Database.Database,
  workspace: WorkspaceService,
  versionId: string,
): Promise<VersionContent> {
  const version = await workspace.versionSnapshot(versionId);
  const file = db.prepare(
    `SELECT name, mime_type, extracted_text FROM files
     WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
  ).get(version.fileId) as {
    name: string;
    mime_type: string | null;
    extracted_text: string | null;
  } | undefined;
  if (file === undefined) throw new Error("That file is no longer in this room.");
  const currentBytes = await workspace.readBuffer(version.fileId);
  const versionText = version.text ?? rederiveVersionText(file.name, version.bytes);
  return {
    fileName: file.name,
    versionText: contentText(file.name, file.mime_type ?? "", version.bytes, versionText),
    currentText: contentText(file.name, file.mime_type ?? "", currentBytes, file.extracted_text),
  };
}
export

/** The single write path for changing an existing file's bytes. Snapshots the
 * CURRENT bytes into version history tagged with `cause`, then overwrites —
 * ONE transaction, so a failed overwrite never cuts a version for content
 * that was never actually replaced. Ported from `commands::files::
 * store_file_bytes`. */
function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Buffer,
  text: string | null,
  cause: string
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}


/**
 * The body of `restore_file_version`, over a plain `Database` handle — pure
 * for the same reason `versionContent` is. Restores bytes, extracted text,
 * ART-1 provenance and (for a Recording) transcript meta all in ONE
 * transaction — a half-restored recording would show words from one era
 * against speakers from another. Returns the id of the file that was
 * restored. Ported from `restore_version_into`.
 */
export function restoreVersionInto(db: Database.Database, versionId: string): string {
  const v = getVersion(db, versionId);
  // A version row outlives a delete (trash is reversible), so a version id
  // held by an open tab still resolves after the file is gone — but writing
  // through it would put an old draft into a file the room isn't showing.
  // `getFileName` hides trashed rows the same way Rust's does, so this guard
  // costs nothing extra — and the name it returns doubles as the
  // re-derivation input below, exactly as the Rust source notes.
  let name: string;
  try {
    name = getFileName(db, v.fileId);
  } catch {
    throw new Error("That file is no longer in this room.");
  }
  // Versions saved before compound snapshots carry no text: re-derive it.
  const text = v.text !== null ? v.text : rederiveVersionText(name, v.bytes);
  // ART-1: whatever made THIS version made the file's content again, so the
  // head's provenance moves back with the bytes. Read before the write.
  const backTo = versionProvenanceJson(db, versionId);
  inTransaction(db, () => {
    storeFileBytes(db, v.fileId, v.bytes, text, "Restored");
    setFileProvenance(db, v.fileId, backTo);
    if (v.recMeta !== null) {
      setRecMeta(db, v.fileId, v.recMeta);
    }
  });
  return v.fileId;
}
