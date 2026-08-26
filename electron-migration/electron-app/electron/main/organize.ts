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
  anyFileName,
  availableName,
  findFileLikeQualified,
  getFileExtractedText,
  insertFile,
  renameFile,
  trashFile,
  type TrashActor,
} from "./db-host/files.js";

// ---------------------------------------------------------------------------
// The slice of bulk.rs organize.rs itself depends on — see the module doc.
// ---------------------------------------------------------------------------

/**
 * Ceiling on one batch.
 *
 * Not a performance number — a blast radius. The agent reaches these same
 * functions, and "tidy up the room" against a model that miscounted must not
 * be able to sweep an unbounded number of files, or folders, in one round. The
 * caller is TOLD when the cap bites ({@link OrganizeReport.capped},
 * `BulkReport.capped`); a silently truncated batch would report success over
 * work it never did.
 */
export const MAX_BULK_FILES = 200;

/**
 * `bulk.rs`'s `take_capped`: de-duplicate, then cap.
 *
 * Duplicates matter for the reason bulk.rs's own comment gives — the same id
 * twice would be reported twice, and for trash the second pass fails ("already
 * in the trash"), turning a harmless repeat into a receipt that claims a
 * failure that did not happen.
 */
function takeCapped(ids: readonly string[]): [string[], number] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return [unique.slice(0, MAX_BULK_FILES), Math.max(0, unique.length - MAX_BULK_FILES)];
}

/**
 * Move a set of files to the trash, attributed to `actor` — `bulk.rs`'s
 * `trash_files_in` fused with the `each_file` loop it rides.
 *
 * The name is read BEFORE the file is trashed: afterwards the row is hidden
 * from every ordinary lookup, and a receipt assembled later could only print
 * ids. {@link anyFileName} is exactly the trash-tolerant reader bulk.rs relies
 * on for this, and it answers `null` (rather than throwing) for an id that
 * names nothing, which is an ordinary outcome for a batch.
 */
function trashFilesIn(
  db: Database.Database,
  ids: readonly string[],
  actor: TrashActor
): BulkReport {
  const [kept, capped] = takeCapped(ids);
  const report: BulkReport = { ok: [], failed: [], capped };
  for (const id of kept) {
    const name = anyFileName(db, id) ?? id;
    try {
      trashFile(db, id, actor);
      report.ok.push(name);
    } catch (e) {
      report.failed.push({ name, error: errorText(e) });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// extraction.rs's extension_of, and a mime_guess substitute.
// ---------------------------------------------------------------------------

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. Local copy; see module doc. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/** A small, honest substitute for the `mime_guess` crate: real for every
 * extension a merged document actually lands under, and defaulting to
 * `text/plain` exactly as `mime_guess::from_path(..).first_or(TEXT_PLAIN)`
 * does for anything it has no entry for either. Kept identical to
 * `turnEngine.ts`'s table so the two copies collapse cleanly later. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  py: "text/x-python",
  js: "text/javascript",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

/** `MIME_BY_EXT[extensionOf(name)] ?? "text/plain"`, own-property-guarded —
 * see `docsHtml.ts`'s `noteMime` for the bug this pattern fixes. `into`
 * (`merge_files`'s new-file name, this function's only caller) is MODEL
 * INPUT: an extension of `constructor`/`__proto__`/… reads `Object`/
 * `Object.prototype` off the plain `{}` literal above, `?? "text/plain"`
 * never fires for a non-nullish value, and a non-string mime reaching
 * `insertFile` dies inside better-sqlite3 instead of falling back like
 * `mime_guess::from_path` (no prototype chain to leak) does in Rust. */
function mimeFor(name: string): string {
  const ext = extensionOf(name);
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext) ? (MIME_BY_EXT[ext] as string) : "text/plain";
}

/** The message a thrown DB error contributes to a {@link BulkFailure} — the
 * TS stand-in for the `String` Rust's `Result` carried. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// resolve(): the shared name-resolution pass behind all three verbs.
// ---------------------------------------------------------------------------

/**
 * A file the agent named, resolved to a real room row — or the reason it could
 * not be. Resolution is reported per NAME rather than failing the batch, for
 * the same reason the bulk verbs are best-effort: one hallucinated filename in
 * a plan of thirty must not discard the twenty-nine real ones.
 */
interface Resolved {
  /** (index in the names list, id, real name) — the pairing is carried out of
   * the resolve rather than recovered later, because the loop that consumes it
   * RENAMES and MOVES files: a second lookup of the same name runs against a
   * database the caller has already changed, and matches something else or
   * nothing at all. */
  hits: Array<[number, string, string]>;
  misses: BulkFailure[];
  /** Names that resolved to a file an earlier name already claimed. */
  dupes: BulkFailure[];
}

/**
 * Resolve the names in a plan, in order, dropping duplicates.
 *
 * Uses {@link findFileLikeQualified}, so the folder-prefixed names the agent
 * was shown by `list_room_files` ("Invoices/q3.pdf") resolve — the round trip
 * that silently failed before.
 *
 * De-duplication is by resolved ID, not by the string the model wrote: a plan
 * that names the same file twice, once as `q3.pdf` and once as
 * `Invoices/q3.pdf`, is one file. Left in, the second entry would either
 * double-apply a move or report a bogus failure. The duplicate is REPORTED
 * (`dupes`) rather than dropped in silence — for the verbs where a second
 * entry carried instructions of its own, saying nothing about it is a receipt
 * that claims a plan was carried out whole when part of it never ran.
 */
function resolve(db: Database.Database, names: readonly string[]): Resolved {
  const hits: Array<[number, string, string]> = [];
  const misses: BulkFailure[] = [];
  const dupes: BulkFailure[] = [];
  const seen = new Set<string>();
  names.forEach((raw, at) => {
    const name = raw.trim();
    if (name === "") {
      return;
    }
    try {
      const [id, real] = findFileLikeQualified(db, name);
      if (seen.has(id)) {
        dupes.push({ name, error: "names the same file as an earlier entry" });
      } else {
        seen.add(id);
        hits.push([at, id, real]);
      }
    } catch (e) {
      misses.push({ name, error: errorText(e) });
    }
  });
  return { hits, misses, dupes };
}

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
  const verb = (n: number, past: string, future: string): string =>
    dryRun ? `would ${future} ${n}` : `${past} ${n}`;
  const parts: string[] = [];
  if (report.moved.length > 0) {
    parts.push(`${verb(report.moved.length, "moved", "move")} (${report.moved.join(", ")})`);
  }
  if (report.renamed.length > 0) {
    parts.push(`${verb(report.renamed.length, "renamed", "rename")} (${report.renamed.join(", ")})`);
  }
  if (report.foldersMade.length > 0) {
    parts.push(`created folder(s) ${report.foldersMade.join(", ")}`);
  }
  if (report.foldersRemoved.length > 0) {
    parts.push(`removed folder(s) ${report.foldersRemoved.join(", ")}${removedFolderNote}`);
  }
  let out: string;
  if (parts.length === 0) {
    out = "Nothing was changed.";
  } else if (dryRun) {
    out = `PREVIEW ONLY, nothing was changed — ${parts.join("; ")}.`;
  } else {
    out = `${parts.join("; ")}.`;
  }
  if (report.failed.length > 0) {
    const detail = report.failed.slice(0, 10).map((f) => `"${f.name}" (${f.error})`);
    out += ` ${report.failed.length} could not be done: ${detail.join("; ")}.`;
  }
  if (report.capped > 0) {
    out += ` ${report.capped} entries were not attempted — one call handles at most ${MAX_BULK_FILES}.`;
  }
  return out;
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
  // Every list in one call carries the same ceiling. Folder maintenance used
  // to have none, so one call could create — or delete — thousands of folders,
  // and the receipt said nothing had been held back because nothing had been.
  const report = freshReport(
    Math.max(0, entries.length - MAX_BULK_FILES) +
      Math.max(0, makeFolders.length - MAX_BULK_FILES) +
      Math.max(0, removeFolders.length - MAX_BULK_FILES)
  );

  // Folders are created FIRST so an empty folder can be made in the same call
  // that files are moved into it, and so `folder:` on an entry below finds a
  // folder this very plan asked for rather than making a second one.
  for (const raw of makeFolders.slice(0, MAX_BULK_FILES)) {
    const name = raw.trim();
    if (name === "" || meansTopLevel(name)) {
      continue;
    }
    // An existing folder is not news. Reporting it as "created" would be a
    // claim about work that did not happen — and this receipt is exactly what
    // `react_verify` checks the agent's story against.
    if (existingFolder(db, name) !== null) {
      continue;
    }
    if (dryRun) {
      report.foldersMade.push(`"${name}"`);
      continue;
    }
    try {
      report.foldersMade.push(`"${createFolder(db, name).name}"`);
    } catch (e) {
      report.failed.push({ name, error: errorText(e) });
    }
  }

  const plan = entries.slice(0, MAX_BULK_FILES);
  const resolved = resolve(
    db,
    // `?? ""` is Rust's `#[serde(default)]` on `OrganizeEntry::name`: an entry
    // with no name resolves to nothing and is skipped by `resolve`.
    plan.map((e) => e.name ?? "")
  );
  report.failed.push(...resolved.misses, ...resolved.dupes);

  // Each hit carries the index of the entry it came from. Looking the name up
  // a SECOND time here would search a room this very loop is renaming: an
  // entry that moves "final.md" after an earlier entry renamed something else
  // to "final.md" would find the wrong file, or none — and a hit with no entry
  // was silently skipped, done nowhere and reported nowhere.
  for (const [at, id, realName] of resolved.hits) {
    // `at` is the index `resolve` was handed, which came from mapping `plan`
    // itself, so this is always the entry that produced the hit.
    const entry = plan[at]!;
    const folder = entry.folder;
    if (folder !== undefined && folder !== null) {
      const whereTo = meansTopLevel(folder) ? "the top level" : `"${folder.trim()}"`;
      if (dryRun) {
        // Nothing is resolved and nothing is created — a preview that left
        // folders behind is the bug this branch exists for.
        report.moved.push(`"${realName}" → ${whereTo}`);
      } else {
        try {
          moveFileToFolder(db, id, folderIdFor(db, folder));
          report.moved.push(`"${realName}" → ${whereTo}`);
        } catch (e) {
          report.failed.push({ name: realName, error: errorText(e) });
        }
      }
    }
    const newName = entry.newName?.trim();
    if (newName !== undefined && newName !== "") {
      // Keep the extension when the model drops it — the same courtesy
      // `rename_file` extends, and for the same reason: a model renaming
      // "q3.pdf" to "Q3 report" means the title, not the file type.
      const finalName = withKeptExtension(newName, realName);
      if (dryRun) {
        report.renamed.push(`"${realName}" → "${finalName}"`);
      } else {
        try {
          renameFile(db, id, finalName);
          report.renamed.push(`"${realName}" → "${finalName}"`);
        } catch (e) {
          report.failed.push({ name: realName, error: errorText(e) });
        }
      }
    }
  }

  // Folders are removed LAST, so a plan that empties a folder and then drops
  // it does both in the right order. `deleteFolder` never deletes files — they
  // return to the top level (ADD-16) — which is what makes this safe to give a
  // model at all.
  for (const raw of removeFolders.slice(0, MAX_BULK_FILES)) {
    const name = raw.trim();
    if (name === "") {
      continue;
    }
    const folder = existingFolder(db, name);
    if (folder === null) {
      report.failed.push({ name, error: "no folder by that name" });
      continue;
    }
    if (dryRun) {
      report.foldersRemoved.push(`"${folder.name}"`);
    } else {
      try {
        deleteFolder(db, folder.id);
        report.foldersRemoved.push(`"${folder.name}"`);
      } catch (e) {
        report.failed.push({ name: folder.name, error: errorText(e) });
      }
    }
  }

  return report;
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

// --------------------------------------------------------------- merge_files

/**
 * Join several text files into one new room file. Returns
 * `[writtenName, receipt, failures]`.
 *
 * NO MODEL CALL. That is the whole design: the bytes never enter a context
 * window, so this works identically on a 4B and on a cloud engine, and it
 * works on inputs far past any window. The result is a plain concatenation —
 * if the user wanted the documents *synthesized* rather than joined, that is
 * the whole-file pass, and `merge_files`' description points there.
 *
 * Sources are NOT deleted unless asked, and when they are, they go to the
 * trash like everything else the agent removes.
 *
 * Throws (Rust's two `Err` returns) when fewer than two names resolve, or when
 * fewer than two of those carry readable text.
 */
export function merge(
  db: Database.Database,
  names: readonly string[],
  into: string,
  headings: boolean,
  trashSources: boolean
): [string, string, BulkFailure[]] {
  const resolved = resolve(db, names);
  // `misses` only, never `dupes` — the Rust source seeds `failures` from
  // `resolved.misses` alone, and a name repeated here simply resolves to the
  // one file it always meant.
  const failures: BulkFailure[] = [...resolved.misses];
  if (resolved.hits.length < 2) {
    const notFound =
      failures.length === 0 ? "" : ` Not found: ${failures.map((f) => `"${f.name}"`).join(", ")}.`;
    throw new Error(
      `merge_files needs at least two files it can find; matched ${resolved.hits.length}.${notFound}`
    );
  }

  let body = "";
  const merged: string[] = [];
  for (const [, id, name] of resolved.hits) {
    // A file whose text the room never extracted (a PDF that failed OCR, a
    // recording with no transcript, an image) has nothing to contribute.
    // Skipping it SILENTLY would produce a merge that looks complete and is
    // not, so it is reported as a per-file failure like any other.
    const text = getFileExtractedText(db, id);
    if (text === null || text.trim() === "") {
      failures.push({ name, error: "no readable text in this file" });
      continue;
    }
    if (headings) {
      // The heading names the SOURCE, so the merged document can still be
      // traced back — a merge that loses provenance is a merge nobody can
      // check.
      body += `\n\n## ${name}\n\n`;
    } else if (body !== "") {
      body += "\n\n";
    }
    body += text.trim();
    merged.push(name);
  }
  if (merged.length < 2) {
    throw new Error("merge_files needs at least two files with readable text; the rest had none.");
  }

  const requested = into.trim();
  let name: string;
  if (requested === "") {
    name = "Merged notes.md";
  } else if (extensionOf(requested) === "") {
    name = `${requested}.md`;
  } else {
    name = requested;
  }
  // `into` names a NEW file (so says the tool's own schema), and the default
  // is the app's own — so neither may land on a name already in use. Merging
  // twice with no `into` produced a second "Merged notes.md" beside the first,
  // same name and different content, and every name-based verb after that
  // reached only the newest one. The receipt reports the name that was really
  // written, so it keeps telling the truth about which file that was.
  name = availableName(db, name);
  const content = body.trimStart();
  const meta = insertFile(db, name, mimeFor(name), Buffer.from(content, "utf8"), content, "generated");

  // Only now, and only if asked. Trashing before the write would risk losing
  // the sources to a failed insert. Only the files that really CONTRIBUTED are
  // trashed: one that had no readable text was reported as a failure, not
  // merged, and must not be deleted for a document it is not inside.
  if (trashSources) {
    const ids = resolved.hits.filter(([, , n]) => merged.includes(n)).map(([, id]) => id);
    failures.push(...trashFilesIn(db, ids, { kind: "agent", who: "merge_files" }).failed);
  }

  const skipped =
    failures.length === 0
      ? ""
      : ` Skipped: ${failures.map((f) => `"${f.name}" (${f.error})`).join("; ")}.`;
  const receipt =
    `Merged ${merged.length} files into "${meta.name}" ` +
    // `[...content].length` counts code points, matching Rust's `chars()`.
    `(${[...content].length} characters)` +
    (trashSources ? " and moved the originals to the trash" : " — the originals are untouched") +
    `.${skipped}`;

  return [meta.name, receipt, failures];
}
