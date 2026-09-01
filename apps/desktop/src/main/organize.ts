/**
 * Port of `src-tauri/src/commands/organize.rs` (810 lines, read in full): the
 * File agent's organize verbs — tidy the room, delete into the trash, merge
 * documents.
 *
 * THREE VERBS, AND WHY THEY ARE THREE (organize.rs's own module doc, kept
 * because the reasoning is the design):
 *
 *   - {@link organize} — moves, renames and folder maintenance in ONE call.
 *     A change that spans files, issued as N single calls, is N chances for a
 *     small model to drift and N rounds of budget. One call is also one plan a
 *     person can read in one card, and it can be previewed (`dryRun`) before
 *     it lands.
 *   - {@link trashNamed} — deletion is DELIBERATELY not a key inside the verb
 *     above. A separate tool name is what lets the lane label, the tier gate
 *     and the host log treat destruction differently from filing, and what
 *     makes it legible in a transcript.
 *   - {@link merge} — DETERMINISTIC concatenation, no model call. Faking it
 *     with `open_file` + `create_file` pushes both documents through the
 *     context window to get their own bytes back out: it fails on a 4B and it
 *     fails on anything book-sized regardless of model.
 *
 * The agent has trash, never `delete_file` and never `empty_trash`. Everything
 * here is recoverable from Library → Trash, by hand, with the agent named as
 * the actor.
 *
 * WHAT THIS FILE IS NOT: the `exec_tool` arms themselves. Rust's
 * `commands/agent.rs` (~4101-4181) is what parses `args`, refuses an empty
 * plan, emits `room-files-changed`, folds `effects.wrote` and appends
 * "recoverable from Library → Trash" — that side is `execTool.ts`'s job (an
 * existing file whose own header already lists these three names as
 * `NOT_IMPLEMENTED — Batch D`). This module mirrors organize.rs's three
 * `pub(crate)` entry points and its `pub(crate)` types and nothing else, so a
 * later wiring batch calls these exactly the way `agent.rs` calls
 * `super::organize::*` today.
 *
 * DB LAYER: entirely `db-host/folders.ts` (`listFolders`, `createFolder`,
 * `deleteFolder`, `moveFileToFolder`) and `db-host/files.ts`
 * (`findFileLikeQualified`, `availableName`, `insertFile`, `renameFile`,
 * `getFileExtractedText`, `anyFileName`, `trashFile`). Nothing those modules
 * already expose is re-implemented. `db-host/versions.ts` and
 * `db-host/artifacts.ts` are deliberately NOT used: organize.rs never calls
 * `snapshot_file_version` and never enters the ART-1 staging funnel — that is
 * `agent.rs`'s own `create_file` arm, a different code path this batch does
 * not touch.
 *
 * ERROR CONVENTION. This directory's DB layer throws a plain `Error` instead
 * of returning `Result<T, String>` (see `db-host/util.ts`'s deviation note),
 * so organize.rs's `match … { Ok(_) => …, Err(e) => … }` becomes a try/catch
 * per site — the same translation `fileTools.ts` already uses.
 *   - {@link organize} is `Result<OrganizeReport, String>` in Rust but never
 *     actually returns `Err` (every failure is caught per item into
 *     `report.failed`; there is no `?` anywhere in its body), so it is ported
 *     as a function that returns an {@link OrganizeReport}. The ONE way it can
 *     still throw is a catastrophic `listFolders` failure — Rust swallows that
 *     with `unwrap_or_default()`, which would make a room whose folder table
 *     is unreadable silently CREATE the folders it could not see. Surfacing it
 *     is the safer half of that trade, and a room that cannot list folders is
 *     failing every other call in the turn anyway.
 *   - {@link merge} has real `Err` returns (too few resolvable files, too few
 *     with readable text) and throws in exactly those two cases.
 *
 * NOT PORTED — `commands/bulk.rs`. No `bulk.ts` exists yet, and porting all of
 * it (`move_files_in`/`restore_files_in`/`destroy_files_in`, its four
 * `#[tauri::command]` wrappers, `BulkReport::changed_anything`/`::sentence`,
 * the Library's multi-select wiring) is that module's own batch. organize.rs
 * needs exactly four things from it, and only those are here:
 *   - `BulkFailure`/`BulkReport` — NOT redeclared. They already exist,
 *     camelCased and field-for-field, in `shared/apiTypes.ts`, so they are
 *     imported from there rather than forked into a second definition.
 *   - {@link MAX_BULK_FILES} — copied as a literal, since there is nothing to
 *     import yet.
 *   - `take_capped` + `each_file` + `trash_files_in`, fused into the private
 *     {@link trashFilesIn} (organize.rs never calls `each_file` for anything
 *     else, so there is no generic helper worth preserving).
 * Whoever ports `bulk.rs` for real should delete `trashFilesIn` and the local
 * `MAX_BULK_FILES` in favour of that module's exports; every call site here is
 * written so that swap is a pure import change. NOTE for the wiring batch:
 * `execTool.ts`'s `trash_files` arm also needs `BulkReport::changed_anything`
 * and `BulkReport::sentence("moved to the trash")`, which live in `bulk.rs`
 * and are NOT here — that arm needs `bulk.ts`, not just this file.
 *
 * NOT PORTED — `extraction::extension_of` and `mime_guess`. Both are external
 * to `commands::organize`, and `extension_of` is mid-port in a concurrent
 * batch (`extraction_b.ts`). Rather than depend on another batch's in-flight
 * file, this module carries local copies — the SAME choice `turnEngine.ts`'s
 * `saveGeneratedFile` already made for this exact pair, so it is a precedented
 * divergence, not a novel one. All the copies should collapse onto one
 * `extraction.ts` when that module lands.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { BulkFailure, BulkReport } from "../shared/apiTypes.js";
import {
  createFolder,
  deleteFolder,
  listFolders,
  moveFileToFolder,
  type Folder,
} from "./db-host/folders.js";
import {
  renameFile,
} from "./db-host/files.js";
import {
  errorText,
  extensionOf,
  MAX_BULK_FILES,
  resolve,
  trashFilesIn,
} from "./organizeCore.js";

export { MAX_BULK_FILES } from "./organizeCore.js";
export { merge } from "./organizeMerge.js";

/** The vocabulary that means "the top level" rather than a folder — the same
 * words `move_file`'s own arm accepts, kept in one place so the two tools
 * cannot disagree about what "no folder" is called. */
const TOP_LEVEL_WORDS = ["none", "top", "top level", "root", "/"];

function meansTopLevel(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "" || TOP_LEVEL_WORDS.includes(trimmed);
}

/** The existing folder with this name, if there is one — compared without
 * regard to case, matching both Rust's `eq_ignore_ascii_case` and
 * `folders.ts`'s own `COLLATE NOCASE` uniqueness rule. */
function existingFolder(db: Database.Database, name: string): Folder | null {
  const trimmed = name.trim().toLowerCase();
  return listFolders(db).find((f) => f.name.toLowerCase() === trimmed) ?? null;
}

/**
 * Find a folder by name, or make one.
 *
 * ONLY the real run may call this. A DRY RUN used to resolve every destination
 * through here, and resolving meant creating — so previewing "file these under
 * Invoices, Receipts and Tax" silently left three real folders in the room. A
 * preview that mutates is worse than no preview, because it is the one the
 * user trusted; the dry-run branches below report the destination by NAME and
 * never reach this function.
 *
 * Get-or-create is deliberate and unchanged: `move_file` has always made a
 * folder on the way into it, and "file these under Invoices" before an
 * Invoices folder exists is what the request means.
 */
function folderIdFor(db: Database.Database, name: string): string | null {
  if (meansTopLevel(name)) {
    return null;
  }
  const trimmed = name.trim();
  const existing = existingFolder(db, trimmed);
  return existing !== null ? existing.id : createFolder(db, trimmed).id;
}

// ------------------------------------------------------------ organize_files

/**
 * One entry in an organize plan, as the model writes it.
 *
 * Every field is optional because Rust's `OrganizeEntry` carries
 * `#[serde(default)]` on all three: an entry the model wrote without a `name`
 * is legal input that resolves to nothing and is skipped, NOT a crash. (The
 * wiring batch will hand this straight out of `JSON.parse`, where a missing
 * key really is `undefined`.)
 *
 * `folder` and `newName` are `Option<String>` in Rust, which is why they are
 * `string | null | undefined` here rather than plain `string`: absent means
 * "don't touch this", while `""` (present, empty) means "move it to the top
 * level". An empty string alone cannot say both, which is exactly why Rust
 * made these `Option` in the first place.
 */
export interface OrganizeEntry {
  /** The file this entry is about (name, fragment, or `Folder/name`). */
  name?: string;
  /** Destination folder, or the top level — see above. */
  folder?: string | null;
  /** New name, extension optional (kept from the original when omitted). */
  newName?: string | null;
}

/** What an organize run did, per file — the receipt the model reports from.
 * Mirrors Rust's `OrganizeReport`; its `sentence` method is
 * {@link organizeSentence}. */
export interface OrganizeReport {
  moved: string[];
  renamed: string[];
  foldersMade: string[];
  foldersRemoved: string[];
  failed: BulkFailure[];
  /** Entries past {@link MAX_BULK_FILES}, across all three input lists, that
   * were never attempted. */
  capped: number;
}

function freshReport(capped: number): OrganizeReport {
  return { moved: [], renamed: [], foldersMade: [], foldersRemoved: [], failed: [], capped };
}

/**
 * The sentence the tool returns.
 *
 * Every clause is counted from work that actually happened. `react_verify`
 * ground-truths what this agent claims it changed, so a vague or inflated
 * receipt is not merely bad manners — it is what the verifier catches, and a
 * run that over-claims gets retried instead of finishing.
 */
export function organizeSentence(
  report: OrganizeReport,
  dryRun: boolean,
  removedFolderNote = " — their files went to the top level",
): string {
  const sentence = sentenceForChanges(reportChangeClauses(report, dryRun, removedFolderNote), dryRun);
  return appendReceiptLimits(appendReceiptFailures(sentence, report.failed), report.capped);
}

function reportChangeClauses(report: OrganizeReport, dryRun: boolean, removedFolderNote: string): string[] {
  return [
    changedFileClause(report.moved, "moved", "move", dryRun),
    changedFileClause(report.renamed, "renamed", "rename", dryRun),
    folderMadeClause(report.foldersMade),
    folderRemovedClause(report.foldersRemoved, removedFolderNote),
  ].filter((clause): clause is string => clause !== null);
}

function changedFileClause(files: readonly string[], past: string, future: string, dryRun: boolean): string | null {
  if (files.length === 0) return null;
  const verb = dryRun ? `would ${future} ${files.length}` : `${past} ${files.length}`;
  return `${verb} (${files.join(", ")})`;
}

function folderMadeClause(folders: readonly string[]): string | null {
  return folders.length === 0 ? null : `created folder(s) ${folders.join(", ")}`;
}

function folderRemovedClause(folders: readonly string[], note: string): string | null {
  return folders.length === 0 ? null : `removed folder(s) ${folders.join(", ")}${note}`;
}

function sentenceForChanges(parts: readonly string[], dryRun: boolean): string {
  if (parts.length === 0) return "Nothing was changed.";
  return dryRun ? `PREVIEW ONLY, nothing was changed — ${parts.join("; ")}.` : `${parts.join("; ")}.`;
}

function appendReceiptFailures(sentence: string, failures: readonly BulkFailure[]): string {
  if (failures.length === 0) return sentence;
  const detail = failures.slice(0, 10).map((failure) => `"${failure.name}" (${failure.error})`);
  return `${sentence} ${failures.length} could not be done: ${detail.join("; ")}.`;
}

function appendReceiptLimits(sentence: string, capped: number): string {
  if (capped === 0) return sentence;
  return `${sentence} ${capped} entries were not attempted — one call handles at most ${MAX_BULK_FILES}.`;
}

/**
 * Apply an organize plan.
 *
 * `dryRun` resolves every name and computes every outcome, then writes
 * nothing. It exists for the same reason `edit_file`'s does: the model can put
 * a whole reorganization in front of the user before it lands, and a plan
 * built on a misread filename shows up as a miss in the preview instead of as
 * forty files in the wrong place.
 */
export function organize(
  db: Database.Database,
  entries: readonly OrganizeEntry[],
  makeFolders: readonly string[],
  removeFolders: readonly string[],
  dryRun: boolean
): OrganizeReport {
  const report = freshReport(cappedOrganizeEntries(entries, makeFolders, removeFolders));
  createOrganizeFolders(db, makeFolders, dryRun, report);
  organizeFiles(db, entries.slice(0, MAX_BULK_FILES), dryRun, report);
  removeOrganizeFolders(db, removeFolders, dryRun, report);
  return report;
}

function cappedOrganizeEntries(entries: readonly OrganizeEntry[], makeFolders: readonly string[], removeFolders: readonly string[]): number {
  return cappedLength(entries.length) + cappedLength(makeFolders.length) + cappedLength(removeFolders.length);
}

function cappedLength(length: number): number {
  return Math.max(0, length - MAX_BULK_FILES);
}

function createOrganizeFolders(db: Database.Database, names: readonly string[], dryRun: boolean, report: OrganizeReport): void {
  for (const raw of names.slice(0, MAX_BULK_FILES)) createOrganizeFolder(db, raw.trim(), dryRun, report);
}

function createOrganizeFolder(db: Database.Database, name: string, dryRun: boolean, report: OrganizeReport): void {
  if (skippedCreatedFolder(name) || existingFolder(db, name) !== null) return;
  if (dryRun) {
    report.foldersMade.push(`"${name}"`);
    return;
  }
  recordFolderCreation(db, name, report);
}

function skippedCreatedFolder(name: string): boolean {
  return name === "" || meansTopLevel(name);
}

function recordFolderCreation(db: Database.Database, name: string, report: OrganizeReport): void {
  try {
    report.foldersMade.push(`"${createFolder(db, name).name}"`);
  } catch (error) {
    report.failed.push({ name, error: errorText(error) });
  }
}

function organizeFiles(db: Database.Database, plan: readonly OrganizeEntry[], dryRun: boolean, report: OrganizeReport): void {
  const resolved = resolve(db, plan.map((entry) => entry.name ?? ""));
  report.failed.push(...resolved.misses, ...resolved.dupes);
  for (const [at, id, realName] of resolved.hits) organizeResolvedFile(db, id, realName, plan[at]!, dryRun, report);
}

function organizeResolvedFile(
  db: Database.Database, id: string, realName: string, entry: OrganizeEntry, dryRun: boolean, report: OrganizeReport,
): void {
  organizeFileMove(db, id, realName, entry.folder, dryRun, report);
  organizeFileRename(db, id, realName, entry.newName, dryRun, report);
}

function organizeFileMove(
  db: Database.Database, id: string, realName: string, folder: OrganizeEntry["folder"], dryRun: boolean, report: OrganizeReport,
): void {
  if (folder === undefined || folder === null) return;
  const receipt = `"${realName}" → ${folderDestination(folder)}`;
  if (dryRun) {
    report.moved.push(receipt);
    return;
  }
  recordFileMove(db, id, realName, folder, receipt, report);
}

function folderDestination(folder: string): string {
  return meansTopLevel(folder) ? "the top level" : `"${folder.trim()}"`;
}

function recordFileMove(
  db: Database.Database, id: string, realName: string, folder: string, receipt: string, report: OrganizeReport,
): void {
  try {
    moveFileToFolder(db, id, folderIdFor(db, folder));
    report.moved.push(receipt);
  } catch (error) {
    report.failed.push({ name: realName, error: errorText(error) });
  }
}

function organizeFileRename(
  db: Database.Database, id: string, realName: string, rawName: OrganizeEntry["newName"], dryRun: boolean, report: OrganizeReport,
): void {
  const newName = requestedOrganizeName(rawName);
  if (newName === null) return;
  const finalName = withKeptExtension(newName, realName);
  const receipt = `"${realName}" → "${finalName}"`;
  if (dryRun) {
    report.renamed.push(receipt);
    return;
  }
  recordFileRename(db, id, realName, finalName, receipt, report);
}

function requestedOrganizeName(rawName: OrganizeEntry["newName"]): string | null {
  const name = rawName?.trim();
  return name === undefined || name === "" ? null : name;
}

function recordFileRename(
  db: Database.Database, id: string, realName: string, finalName: string, receipt: string, report: OrganizeReport,
): void {
  try {
    renameFile(db, id, finalName);
    report.renamed.push(receipt);
  } catch (error) {
    report.failed.push({ name: realName, error: errorText(error) });
  }
}

function removeOrganizeFolders(db: Database.Database, names: readonly string[], dryRun: boolean, report: OrganizeReport): void {
  for (const raw of names.slice(0, MAX_BULK_FILES)) removeOrganizeFolder(db, raw.trim(), dryRun, report);
}

function removeOrganizeFolder(db: Database.Database, name: string, dryRun: boolean, report: OrganizeReport): void {
  if (name === "") return;
  const folder = existingFolder(db, name);
  if (folder === null) {
    report.failed.push({ name, error: "no folder by that name" });
    return;
  }
  if (dryRun) {
    report.foldersRemoved.push(`"${folder.name}"`);
    return;
  }
  recordFolderRemoval(db, folder, report);
}

function recordFolderRemoval(db: Database.Database, folder: Folder, report: OrganizeReport): void {
  try {
    deleteFolder(db, folder.id);
    report.foldersRemoved.push(`"${folder.name}"`);
  } catch (error) {
    report.failed.push({ name: folder.name, error: errorText(error) });
  }
}

/** `newName` with `oldName`'s extension appended when the model dropped it. */
function withKeptExtension(newName: string, oldName: string): string {
  if (extensionOf(newName) !== "") {
    return newName;
  }
  const ext = extensionOf(oldName);
  return ext === "" ? newName : `${newName}.${ext}`;
}

// --------------------------------------------------------------- trash_files

/**
 * Move the named files to the trash, attributed to the agent. Returns the
 * batch's own report and, separately, the names that matched nothing.
 *
 * Rides {@link trashFilesIn} — the stand-in for `bulk::trash_files_in`, the
 * SAME function the Library's own multi-selection will call once `bulk.rs` is
 * ported — so an AI deletion and a human one stay one operation with a
 * different actor recorded, rather than two implementations that will
 * eventually disagree about what deleting means.
 *
 * A name that resolved to a file an earlier name already claimed
 * (`resolved.dupes`) is dropped here rather than reported, exactly as the Rust
 * source drops it: unlike {@link organize}, a second reference to the same
 * file carries no instruction of its own for `trash_files` to lose.
 */
export function trashNamed(
  db: Database.Database,
  names: readonly string[]
): [BulkReport, BulkFailure[]] {
  const resolved = resolve(db, names);
  const ids = resolved.hits.map(([, id]) => id);
  return [trashFilesIn(db, ids, { kind: "agent", who: "trash_files" }), resolved.misses];
}
