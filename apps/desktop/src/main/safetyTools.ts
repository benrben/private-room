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
import { createWriteStream, existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
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
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { createSealedPackage, importSealedPackage } from "./workspace/sealedPackage.js";
import type { RoomDescriptor } from "./workspace/types.js";
import { errMsg, workspaceVersionContent } from "./safetyVersionOperations.js";
export { fileVersionsKept, listFileVersions, pinFileVersion, deleteFileVersion, getFileProvenance, contentText, versionContent, restoreVersionInto } from "./safetyVersionOperations.js";


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
  return exportableName(rustTrim(neutralizeExportName(lastExportPathPart(name))));
}

function lastExportPathPart(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts.at(-1) ?? name;
}

function neutralizeExportName(name: string): string {
  return [...name].map((char) => (char === "/" || char === "\\" || char === "\0" ? "_" : char)).join("");
}

function exportableName(name: string): string {
  return name === "" || name === "." || name === ".." ? "unnamed" : name;
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

async function exportWorkspaceFile(
  db: Database.Database,
  workspace: WorkspaceService,
  id: string,
  destPath: string,
): Promise<void> {
  // Resolve the row before opening the destination. A missing/trashed file
  // must never leave an empty export behind.
  const stream = workspace.readStream(id);
  try {
    await pipeline(stream, createWriteStream(destPath));
  } catch (error) {
    await rm(destPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not save the file: ${errMsg(error)}`);
  }
  if (fileOriginUrl(db, id) !== null) markAsDownloaded(destPath);
}

/** ADD-1: export every file into `destDir`, never overwriting. Returns the
 * number written. Ported from `export_all_core` (the async
 * `block_in_place`-wrapped `export_all` — see this file's module doc on why
 * `async` here is contract shape, not a real blocking fix). */
export async function exportAll(db: Database.Database, destDir: string): Promise<number> {
  assertExportDirectory(destDir);
  return listFiles(db).reduce((written, file) => written + exportListedFile(db, destDir, file), 0);
}

function assertExportDirectory(destDir: string): void {
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new Error("Choose a folder to export into.");
  }
}

function exportDestination(destDir: string, fileName: string): { name: string; path: string } {
  // Files written earlier this run land on disk, so the existence check also
  // dedups same-named files against each other.
  const name = uniqueExportName(safeExportName(fileName), (candidate) =>
    existsSync(join(destDir, candidate))
  );
  return { name, path: join(destDir, name) };
}

function writeExportedFile(path: string, name: string, bytes: Buffer): void {
  try {
    writeFileSync(path, bytes);
  } catch (err) {
    throw new Error(`Could not write "${name}": ${errMsg(err)}`);
  }
}

function exportListedFile(
  db: Database.Database,
  destDir: string,
  file: ReturnType<typeof listFiles>[number],
): number {
  const bytes = getFileBytes(db, file.id) ?? Buffer.alloc(0);
  const destination = exportDestination(destDir, file.name);
  writeExportedFile(destination.path, destination.name, bytes);
  if (fileOriginUrl(db, file.id) !== null) markAsDownloaded(destination.path);
  return 1;
}

async function exportAllWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  destDir: string,
): Promise<number> {
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new Error("Choose a folder to export into.");
  }
  const files = listFiles(db);
  let written = 0;
  for (const file of files) {
    const name = uniqueExportName(safeExportName(file.name), (candidate) =>
      existsSync(join(destDir, candidate))
    );
    await exportWorkspaceFile(db, workspace, file.id, join(destDir, name));
    written += 1;
  }
  return written;
}
export { changePasswordCore, changePassword, duplicateRoomCore, duplicateRoom, compactRoom, registerSafetyIpc } from "./safetyRoomOperations.js";
export type { ChangePasswordPaths, EmitFn, SafetyOpenRoom, SafetyRoomSource, SafetyIpcDeps } from "./safetyRoomOperations.js";


export { exportAllWorkspace, exportWorkspaceFile, workspaceVersionContent };
