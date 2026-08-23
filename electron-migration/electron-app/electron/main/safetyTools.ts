/**
 * Ported from `src-tauri/src/commands/safety.rs` (773 lines, read in full).
 *
 * SCOPE CORRECTION, stated up front because the porting brief assumed
 * otherwise: despite the filename, this Rust module has NOTHING to do with
 * content moderation. There is no moderation endpoint, no sidecar call, no
 * network call of any kind — every command here is 100% local SQLCipher/
 * filesystem logic. "Safety" here means room/data safety: file VERSION
 * history (list/pin/delete/restore/compare — ADD-2, Idea 11), the "came from
 * the web" quarantine mark on exported downloads (macOS Gatekeeper), file
 * export (single + whole-room), and three room-maintenance operations
 * (SEC-4 change-password, ADD-4 duplicate-room, SEC-7 compact-room). The
 * actual content-safety/moderation concern in this codebase — the privacy
 * gatekeeper's mechanical redact/restore door — is `commands/privacy.rs`,
 * already ported as `privacy.ts` / `privacyRedact.ts` / `db-host/privacy.ts`;
 * nothing in THIS file overlaps it (that module's own header describes its
 * three-way split, none of it here).
 *
 * DB-HOST ADDITIONS THIS BATCH MADE (additive, no existing export touched):
 *   - `db-host/fileVersionsList.ts`: that file's own header already named
 *     itself as the deliberate landing spot for the rest of `versions.rs`'s
 *     read/pin/delete surface once a caller needed it — `getVersion`,
 *     `setVersionPinned`, `deleteFileVersion`, `versionProvenanceJson` are
 *     added there now that this file is that caller.
 *   - `db-host/rekey.ts`: `reclaimableBytes`/`vacuum`/`vacuumInto` — that
 *     file's SIBLING module (`versions.ts`) already (inaccurately) claimed
 *     these three were "ALREADY PORTED as `rekey.ts`"; they were not, so this
 *     fulfills that claim rather than leaving it stale.
 * Everything else this file needs — `getFileBytes`/`getFileFull`/
 * `getFileName`/`fileOriginUrl`/`listFiles`/`inTransaction`/
 * `updateFileContent` (files.ts), `snapshotFileVersion`/`setFileProvenance`/
 * `VERSIONS_KEPT` (versions.ts), `fileProvenance` (artifacts.ts),
 * `setRecMeta` (recordings.ts), `verifyPassword`/`rekey`/`rekeyCopy`
 * (rekey.ts), `hasRecovery`/`writeRecovery`/`removeRecovery` (recovery.ts),
 * `checkpointCkPaths` (checkpoints.ts), `has`/`store`/`deleteEntry`
 * (keychain.ts, the real Touch-ID Keychain FFI, now also wired into
 * `roomManager.ts`'s `touchId*` commands) — was already ported and is
 * reused as-is.
 *
 * ONE GENUINE FIDELITY GAP, documented rather than hidden (rule 3 — no
 * fabrication): `version_content`/`restore_version_into` re-derive a
 * pre-compound-snapshot version's missing `text` via, in order,
 * `extraction::extract_text` THEN a raw UTF-8 decode. BOTH arms are wired
 * here — see {@link rederiveVersionText}. `extractText` is `editMatch.ts`'s
 * port of the first, and the gap is that port's OWN documented narrowing,
 * not its absence: it reads text extensions, `.docx` and `.html`/`.htm`,
 * while the Rust extractor also reads pdf/xlsx/pptx/legacy-Office/epub/rtf/
 * iWork/ipynb/eml/subtitle/svg/sketch, each needing an extractor module no
 * batch has ported. So the observable difference is exactly this: a version
 * saved before compound snapshots existed (this app's very early days), of a
 * file in one of THOSE formats, whose `text` column is NULL, compares and
 * restores with `null` text ("no text to compare") instead of Rust's
 * re-extracted prose. Every other path — every version saved since compound
 * snapshots (the overwhelming majority, and the only kind
 * `snapshotFileVersion` has written since ADD-2 shipped), and every legacy
 * text/html/docx version — is faithful.
 *
 * (An earlier draft of this header claimed `extractText` had no port at all
 * and skipped the first arm entirely. That was wrong on both counts, and it
 * was not a harmless simplification: a legacy `.html` version restored with
 * RAW MARKUP written into `extracted_text`, i.e. into the search index, and a
 * legacy `.txt` in a non-UTF-8 encoding restored with no indexed text at all
 * because the strict decode refused it. Both are pinned by tests now.)
 *
 * NOT PORTED, honestly: `versions_bytes` (`db/versions.rs`) — nothing in
 * `commands/safety.rs` calls it (it is a different, uncalled command's
 * concern), so it stays with `fileVersionsList.ts`'s own "no test to anchor
 * it" convention. `stranded_checkpoint_names` (`commands/room_checkpoints.rs`)
 * — used only by THIS file's own Rust `#[cfg(test)]` module, never by
 * production code here; the real `list_stranded_checkpoints` command it backs
 * lives in `room_checkpoints.rs`, which `checkpoints.ts`'s own header already
 * defers to "a future `rollback_room_checkpoint` port". This file's tests
 * verify the same rekey-loop behaviour directly against `rekeyCopy`/
 * `verifyPassword`, exactly as `rekey.test.ts`'s own header already did for
 * the two Rust tests it borrowed from this module.
 *
 * NO MODEL-INVOCABLE SURFACE: checked `toolSpecs.ts`/`toolSchema.ts` and
 * `commands/agent.rs`'s tool catalog — none of this file's commands (version
 * history, export, password/duplicate/compact) is an `exec_tool` arm. Nothing
 * to wire into `execTool.ts`.
 *
 * ASYNC SHAPE, NOT A PERFORMANCE FIX: the Rust commands for the three
 * room-sized operations (`change_password`, `duplicate_room`, `compact_room`)
 * and `export_all` are `pub async fn` wrapping `tokio::task::block_in_place`,
 * because a synchronous Tauri command runs its whole body on the thread that
 * dispatched it and a multi-GB VACUUM/rekey would freeze the window's
 * redraw. Electron's main process has no `block_in_place` equivalent yet
 * anywhere in this migration (grepped: none exists), so the functions below
 * are `async` for CONTRACT parity with `ipc-contract.ts` (every channel here
 * already resolves through a Promise-returning `ipcMain.handle`) but still
 * run the SQLCipher work synchronously on the main thread underneath, same as
 * every other room-sized operation already ported (e.g. `checkpoints.ts`'s
 * `writeCheckpoint`). A future batch that gives ANY ported command a worker
 * thread should give these the same treatment; inventing one here alone
 * would be a new, untested pattern for a single file.
 *
 * NO IPC WIRING in this batch, same as `recIpc.ts`/`dictStopTimeout.ts`:
 * {@link registerSafetyIpc} exists, ready to be wired, but nothing in this
 * migration's bootstrap calls it yet (rule 4).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import koffi from "koffi";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileVersion, Provenance, VersionContent } from "../shared/apiTypes.js";
import { checkpointCkPaths } from "./db-host/checkpoints.js";
import {
  deleteFileVersion as dbDeleteFileVersion,
  getVersion,
  listFileVersions as dbListFileVersions,
  setVersionPinned as dbSetVersionPinned,
  versionProvenanceJson,
} from "./db-host/fileVersionsList.js";
import {
  fileOriginUrl,
  getFileBytes,
  getFileFull,
  getFileName,
  inTransaction,
  listFiles,
  updateFileContent,
} from "./db-host/files.js";
import { fileProvenance } from "./db-host/artifacts.js";
import { MIN_ROOM_PASSWORD_CHARS } from "./db-host/open.js";
import { hasRecovery, removeRecovery, writeRecovery } from "./db-host/recovery.js";
import { setRecMeta } from "./db-host/recordings.js";
import { reclaimableBytes, rekey, rekeyCopy, vacuum, vacuumInto, verifyPassword } from "./db-host/rekey.js";
import { setFileProvenance, snapshotFileVersion, VERSIONS_KEPT } from "./db-host/versions.js";
import { extractText } from "./editMatch.js";
import { decodeTextBytes, extensionOf, isImage, isTextExtension } from "./editMatchExtraction.js";
import { deleteEntry as keychainDeleteEntry, has as keychainHas, store as keychainStore } from "./keychain.js";
import { mediaKind } from "./peaksTools.js";
import { clampBytes } from "./textClamp.js";

function errMsg(err: unknown): string {
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

/** Ceiling past which a raw-text row degrades to a clipped read-only preview
 * (`PLAIN`, i.e. `Extracted`) instead of an editable Raw buffer. Ported from
 * `formats::MAX_RAW_TEXT_BYTES`. */
const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;

type TextSource = "raw" | "extracted";

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

/** Ported from `classify_file(...).text` — extension wins over MIME (a raw
 * row past its ceiling degrades to `extracted`, an unregistered extension
 * falls through to image/code/plain, exactly as the Rust table does). */
function classifyTextSource(name: string, mime: string, len: number): TextSource {
  const ext = extensionOf(name);
  const row = FORMAT_TEXT_SOURCE.get(ext);
  if (row) {
    if (row.maxBytes === null || len <= row.maxBytes) {
      return row.text;
    }
    return "extracted"; // degrades to PLAIN
  }
  if (isImage(mime)) {
    return "extracted"; // IMAGE
  }
  if (isTextExtension(ext) && len <= MAX_RAW_TEXT_BYTES) {
    return "raw"; // CODE
  }
  return "extracted"; // PLAIN
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

// ============================================================================
// The "came from the web" mark (quarantine)
// ============================================================================
//
// macOS shows its "downloaded from the Internet — are you sure?" warning off
// a single extended attribute, `com.apple.quarantine`. A file that arrived in
// a room over the network carries that history in `files.origin_url`
// ({@link fileOriginUrl}), but bytes written back out on export were plain,
// unmarked files — exporting must not launder a download.

const IS_MACOS = process.platform === "darwin";

type SetxattrFn = (
  path: string,
  name: string,
  value: Uint8Array,
  size: number,
  position: number,
  options: number
) => number;

let cachedSetxattr: SetxattrFn | null = null;

/** libc's `setxattr`, loaded once via koffi — the same FFI approach
 * `keychain.ts` uses for Security.framework, applied here to the two-line
 * macOS syscall the Rust source declares its own `extern "C"` block for
 * rather than pulling in `libc` as a new dependency. */
function loadSetxattr(): SetxattrFn {
  if (cachedSetxattr) {
    return cachedSetxattr;
  }
  const lib = koffi.load("/usr/lib/libSystem.B.dylib");
  cachedSetxattr = lib.func(
    "int setxattr(const char *path, const char *name, const uint8_t *value, size_t size, uint32_t position, int options)"
  ) as SetxattrFn;
  return cachedSetxattr;
}

/** The `com.apple.quarantine` value written on an exported download. Format
 * is `flags;hex-timestamp;agent;uuid`. The last two fields are DELIBERATELY
 * the app name and an empty uuid: the real Safari-style value ends with a
 * LaunchServices id tying the file back to the URL it came from, and the
 * origin URL is the user's — it belongs inside the room, not on a file
 * travelling to their Desktop. Flag `0001` (QTN_FLAG_DOWNLOAD) is the bit
 * Gatekeeper reads. Ported verbatim from `quarantine_value`. */
export function quarantineValue(nowSecs: number): string {
  return `0001;${nowSecs.toString(16)};Arcelle;`;
}

/** Put the quarantine mark on a just-exported file. Best-effort, matching the
 * Rust source's own reasoning: a filesystem that cannot hold extended
 * attributes (a FAT USB stick, a network share) — or, here, a non-macOS
 * platform, or the FFI call itself failing to load — is not a reason to fail
 * an export the user asked for. Ported from `mark_as_downloaded`. */
export function markAsDownloaded(path: string): void {
  if (!IS_MACOS) {
    return;
  }
  try {
    const setxattr = loadSetxattr();
    const nowSecs = Math.floor(Date.now() / 1000);
    const value = Buffer.from(quarantineValue(nowSecs), "utf8");
    setxattr(path, "com.apple.quarantine", value, value.length, 0, 0);
  } catch {
    // best-effort — see doc comment above.
  }
}

// ============================================================================
// Export (ADD-1)
// ============================================================================

/** Rust's `str::trim`, which is the Unicode `White_Space` property and
 * NOTHING else — deliberately not JS's `String.prototype.trim`, whose set
 * differs at both ends: it also strips U+FEFF (a BOM, which Rust keeps) and
 * does NOT strip U+0085 (NEL, which Rust removes). A stored file name is
 * never validated on the way in, so those two characters really can reach
 * {@link safeExportName}, and each one changes the name a file is exported
 * under. `\p{White_Space}` is exactly `char::is_whitespace`'s set. */
function rustTrim(s: string): string {
  return s.replace(/^\p{White_Space}+/u, "").replace(/\p{White_Space}+$/u, "");
}

/** Reduce a stored file name to something that can only land INSIDE the
 * folder the user picked: keep the last path component and neutralise
 * separators / NUL. Ported verbatim from `safe_export_name`. */
export function safeExportName(name: string): string {
  const parts = name.split(/[/\\]/);
  const base = parts[parts.length - 1] ?? name;
  let cleaned = "";
  for (const c of base) {
    cleaned += c === "/" || c === "\\" || c === "\0" ? "_" : c;
  }
  const trimmed = rustTrim(cleaned);
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    return "unnamed";
  }
  return trimmed;
}

/** Choose a destination name inside a folder that will not overwrite
 * anything: on a clash, insert " (2)", " (3)", … before the extension.
 * Ported verbatim from `unique_export_name`. */
export function uniqueExportName(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  for (;;) {
    const candidate = `${stem} (${n})${ext}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
    n += 1;
  }
}

/** ADD-1: write one file's original bytes out as a normal (unencrypted)
 * file. Ported from `export_file`. */
export function exportFile(db: Database.Database, id: string, destPath: string): void {
  const bytes = getFileBytes(db, id);
  if (bytes === null) {
    throw new Error("This file has no stored content to export.");
  }
  // Read BEFORE the write: a file that came over the network keeps the
  // "downloaded" mark on the way out.
  const fromWeb = fileOriginUrl(db, id) !== null;
  try {
    writeFileSync(destPath, bytes);
  } catch (err) {
    throw new Error(`Could not save the file: ${errMsg(err)}`);
  }
  if (fromWeb) {
    markAsDownloaded(destPath);
  }
}

/** ADD-1: export every file into `destDir`, never overwriting. Returns the
 * number written. Ported from `export_all_core` (the async
 * `block_in_place`-wrapped `export_all` — see this file's module doc on why
 * `async` here is contract shape, not a real blocking fix). */
export async function exportAll(db: Database.Database, destDir: string): Promise<number> {
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new Error("Choose a folder to export into.");
  }
  const files = listFiles(db);
  let written = 0;
  for (const f of files) {
    const bytes = getFileBytes(db, f.id) ?? Buffer.alloc(0);
    // Files written earlier this run land on disk, so the existence check
    // also dedups same-named files against each other.
    const name = uniqueExportName(safeExportName(f.name), (candidate) =>
      existsSync(join(destDir, candidate))
    );
    const out = join(destDir, name);
    try {
      writeFileSync(out, bytes);
    } catch (err) {
      throw new Error(`Could not write "${name}": ${errMsg(err)}`);
    }
    // A room's downloads leave as downloads: exporting must not strip the
    // mark macOS shows its Gatekeeper warning off.
    if (fileOriginUrl(db, f.id) !== null) {
      markAsDownloaded(out);
    }
    written += 1;
  }
  return written;
}

// ============================================================================
// SEC-4: change password
// ============================================================================

/**
 * Rotate the room's password: verify `currentPassword` on a throwaway
 * connection, re-key the LIVE connection, keep Touch ID working if it was
 * enabled, re-wrap the recovery sidecar (if any) around the new password, and
 * re-key every whole-room checkpoint from the old password to the new.
 * Returns the fresh recovery code to show once, or `null` when the room has
 * no recovery. Ported from `change_password_core`.
 *
 * CALLER OWNS THE IN-MEMORY PASSWORD: Rust holds `room.password` inside the
 * same `AppState` lock this function's body ran under and updates it in
 * place. Nothing in this migration has that lock yet (see this file's module
 * doc), so — on a successful return — the CALLER is responsible for updating
 * whatever it holds as "the room's current password" to `newPassword` before
 * any subsequent operation (another `changePassword`, a `duplicateRoom`,
 * biometrics) needs it again. A future host-state batch that wires
 * {@link registerSafetyIpc} should pass an `onPasswordChanged` that does
 * exactly this.
 */
export async function changePasswordCore(
  db: Database.Database,
  roomPath: string,
  currentPassword: string,
  newPassword: string
): Promise<string | null> {
  verifyPassword(roomPath, currentPassword);
  rekey(db, newPassword);
  // ADD-11: keep Touch ID working after a password change. Chosen behavior:
  // UPDATE the Keychain entry with the new password. If that somehow fails,
  // delete the stale entry so Touch ID can never hand back the old password.
  if (keychainHas(roomPath)) {
    try {
      keychainStore(roomPath, newPassword);
    } catch {
      try {
        keychainDeleteEntry(roomPath);
      } catch {
        // best-effort, matching Rust's own swallowed `let _ = ...delete(...)`
      }
    }
  }
  // Same policy for the recovery sidecar: re-wrap under the new password and
  // hand back the fresh code; if re-wrapping fails, delete the stale sidecar
  // so the unlock gate never offers a code that cannot work.
  let newCode: string | null = null;
  if (hasRecovery(roomPath)) {
    try {
      newCode = await writeRecovery(roomPath, newPassword);
    } catch {
      try {
        await removeRecovery(roomPath);
      } catch {
        // best-effort
      }
      newCode = null;
    }
  }
  // `vacuum_into` copies keep the key of the moment they were made, so a
  // later rekey would strand every checkpoint. Re-key each one from the OLD
  // password to the new. A failure is NOT fatal — the room itself is already
  // re-keyed and refusing now would be worse — but it is reported, never
  // swallowed into a false "all clean".
  let stranded = 0;
  for (const ck of checkpointCkPaths(roomPath)) {
    try {
      rekeyCopy(ck, currentPassword, newPassword);
    } catch {
      stranded += 1;
    }
  }
  if (stranded > 0) {
    // The counter is deliberately content-free: a checkpoint path carries the
    // room's own file name, which is the user's, and it never goes to a log.
    console.error(`change_password: ${stranded} checkpoint(s) could not be re-keyed`);
  }
  return newCode;
}

/** Outer validation + dispatch matching the Rust `#[tauri::command] pub async
 * fn change_password` (the length floor and the rollback-busy refusal live
 * HERE, not in {@link changePasswordCore}, exactly as they do in Rust). The
 * rollback-busy check is a caller-supplied predicate rather than a direct
 * `RoomManagerState` import, matching `privacy.ts`'s own "each missing piece
 * of host state is a named dependency" convention — nothing in this
 * migration wires a rollback flag to this file yet. */
export async function changePassword(
  db: Database.Database,
  roomPath: string,
  currentPassword: string,
  newPassword: string,
  isRollingBack?: () => boolean
): Promise<string | null> {
  if ([...newPassword].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (isRollingBack?.()) {
    throw new Error(ROLLBACK_BUSY);
  }
  return changePasswordCore(db, roomPath, currentPassword, newPassword);
}

// ============================================================================
// ADD-4: duplicate room
// ============================================================================

/** A full copy of the open room as it is now, optionally with its own new
 * password. The original is never touched. Ported from
 * `duplicate_room_core`. */
export function duplicateRoomCore(
  db: Database.Database,
  roomPassword: string,
  destPath: string,
  newPassword: string | null
): void {
  vacuumInto(db, destPath);
  if (newPassword !== null) {
    try {
      rekeyCopy(destPath, roomPassword, newPassword);
    } catch (err) {
      try {
        unlinkSync(destPath);
      } catch {
        // best-effort cleanup, matching Rust's `let _ = std::fs::remove_file(...)`
      }
      throw err;
    }
  }
}

/** Outer validation matching `#[tauri::command] pub async fn duplicate_room`:
 * the new password's length floor and the destination-must-not-exist guard
 * both live here, ahead of the (potentially minutes-long) copy. */
export async function duplicateRoom(
  db: Database.Database,
  roomPassword: string,
  destPath: string,
  newPassword: string | null
): Promise<void> {
  if (newPassword !== null && [...newPassword].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (existsSync(destPath)) {
    throw new Error("A file already exists at that location.");
  }
  duplicateRoomCore(db, roomPassword, destPath, newPassword);
}

// ============================================================================
// SEC-7: compact room
// ============================================================================

/** Compact the open room on demand, reporting how much was reclaimed. Ported
 * from `compact_room_core`. */
export async function compactRoom(db: Database.Database): Promise<string> {
  const reclaimable = reclaimableBytes(db);
  const mb = reclaimable / (1024 * 1024);
  if (mb < 0.05) {
    return "Nothing to recover.";
  }
  vacuum(db);
  return `Recovered ${mb.toFixed(1)} MB.`;
}

// ============================================================================
// IPC registration — NOT wired into any bootstrap file (rule 4)
// ============================================================================

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful call into a failed one. Same narrowest-possible contract
 * as `organizeTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

/** The slice of room state every handler in this file needs: whichever room
 * is open RIGHT NOW. Deliberately its OWN shape (not `turnEngine.ts`'s
 * `OpenRoom`, which is `{db, path}` only) because `changePassword`/
 * `duplicateRoom` need the room's current password too — the same
 * `state.room.lock()` analogue `recIpc.ts`'s `RoomSource` documents, widened
 * by exactly the one field this file additionally needs. */
export interface SafetyOpenRoom {
  conn: Database.Database;
  path: string;
  password: string;
}

export interface SafetyRoomSource {
  currentRoom(): SafetyOpenRoom | null;
}

/** `AppState::with_room`'s own refusal, so an IPC call made between rooms
 * says what the shipped app says. */
const NO_ROOM_OPEN = "No room is open.";

/** The rollback-in-flight refusal text, ported from `commands.rs`'s
 * `ROLLBACK_BUSY` — restated as a literal (not imported from
 * `turnContext.ts`) so this file has no hard dependency on the room-manager
 * batch that owns the real rollback flag; a future wiring batch can swap this
 * for the shared constant without changing behavior, since the string is
 * identical either way. */
const ROLLBACK_BUSY = "The room is rolling back — try again in a moment.";

function openRoomOrThrow(room: SafetyRoomSource): SafetyOpenRoom {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
}

/** Optional collaborators {@link registerSafetyIpc} needs beyond the open
 * room itself — each a named dependency, following `privacy.ts`'s convention,
 * rather than a wider `RoomManagerState`/`AppState` import this migration
 * does not have yet. */
export interface SafetyIpcDeps {
  /** Wave 3 (Idea 9)'s rollback-in-flight guard. Absent means "never busy". */
  isRollingBack?: () => boolean;
  /** `window.emit`, for `restore_file_version`'s two best-effort broadcasts. */
  emit?: EmitFn;
  /** Called after a successful `change_password` with the new password — see
   * {@link changePasswordCore}'s own doc on why the caller, not this file,
   * owns the in-memory room password. */
  onPasswordChanged?: (newPassword: string) => void;
}

/** Register every `commands/safety.rs` channel on `ipcMain`. Channel names
 * are the Rust `#[tauri::command]` names `ipc-contract.ts` already declares,
 * so the renderer side needs no rename. */
export function registerSafetyIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: SafetyRoomSource,
  deps: SafetyIpcDeps = {}
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("list_file_versions", (args: { id: string }) =>
    listFileVersions(openRoomOrThrow(room).conn, args.id)
  );
  handle("file_versions_kept", () => fileVersionsKept());
  handle("pin_file_version", (args: { versionId: string; pinned: boolean }) =>
    pinFileVersion(openRoomOrThrow(room).conn, args.versionId, args.pinned)
  );
  handle("delete_file_version", (args: { versionId: string }) =>
    deleteFileVersion(openRoomOrThrow(room).conn, args.versionId)
  );
  handle("get_file_provenance", (args: { id: string }) =>
    getFileProvenance(openRoomOrThrow(room).conn, args.id)
  );
  handle("get_file_version", (args: { versionId: string }) =>
    versionContent(openRoomOrThrow(room).conn, args.versionId)
  );
  handle("restore_file_version", (args: { versionId: string }) => {
    const fileId = restoreVersionInto(openRoomOrThrow(room).conn, args.versionId);
    emitSafely(deps.emit, "room-files-changed", undefined);
    emitSafely(deps.emit, "file-updated", fileId);
  });
  handle("export_file", (args: { id: string; destPath: string }) =>
    exportFile(openRoomOrThrow(room).conn, args.id, args.destPath)
  );
  handle("export_all", (args: { destDir: string }) => exportAll(openRoomOrThrow(room).conn, args.destDir));
  handle("change_password", async (args: { current: string; newPassword: string }) => {
    const open = openRoomOrThrow(room);
    const code = await changePassword(
      open.conn,
      open.path,
      args.current,
      args.newPassword,
      deps.isRollingBack
    );
    deps.onPasswordChanged?.(args.newPassword);
    return code;
  });
  handle("duplicate_room", (args: { destPath: string; newPassword: string | null }) => {
    const open = openRoomOrThrow(room);
    return duplicateRoom(open.conn, open.password, args.destPath, args.newPassword);
  });
  handle("compact_room", () => compactRoom(openRoomOrThrow(room).conn));
}
