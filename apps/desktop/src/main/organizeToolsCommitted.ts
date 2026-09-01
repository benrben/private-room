import type Database from "better-sqlite3-multiple-ciphers";
import {
  fileByExactName,
  findFileLikeQualified,
  findImageLike,
  availableName,
  getFileExtractedText,
  getFileMeta,
  inTransaction,
  renameFile,
  setLibraryVisibility,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { createFolder, listFolders, moveFileToFolder } from "./db-host/folders.js";
import { setFileProvenance, snapshotFileVersion } from "./db-host/versions.js";
import {
  commitStaged,
  discardStaged,
  provenanceToJson,
  stageArtifact,
  type Provenance,
} from "./db-host/artifacts.js";
import {
  merge,
  organize,
  organizeSentence,
  trashNamed,
  type OrganizeEntry,
  type OrganizeReport,
} from "./organize.js";
import { bulkReportChangedAnything, bulkReportSentence } from "./bulkReport.js";
import { htmlDocument, isScratchPadName, noteMime, SCRATCH_PAD_NAME } from "./docsHtml.js";
import {
  asBoolDefault,
  asString,
  emitSafely,
  errMessage,
  extensionOf,
  fail,
  notImplemented,
  ok,
  parseOrganizeEntries,
  parseStringArray,
  type EmitFn,
  type OrganizeToolOutcome,
} from "./organizeToolsModel.js";

export function execMarkImage(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { boxes: unknown },
): OrganizeToolOutcome {
  const imageName = asString(args.image_name).toLowerCase();

  let id: string;
  let realName: string;
  try {
    [id, realName] = findImageLike(db, imageName);
  } catch (e) {
    return fail(errMessage(e));
  }

  // CHG-17: if this image was already grounded this turn, don't run a second
  // multi-GB vision pass — reuse the existing boxes.
  const existing = effects.boxes;
  if (typeof existing === "object" && existing !== null) {
    if ((existing as Record<string, unknown>).fileId === id) {
      return ok(`The image "${realName}" is already marked.`);
    }
  }

  return notImplemented(
    `mark_image found "${realName}", but the vision grounding pass — ollama.rs's model ` +
      "listing and vision pick, the privacy-door check, image preparation, and " +
      "ground_prepared_image — has no Electron port yet, so no image was marked — Batch D",
  );
}

// --------------------------------------------------------------- create_file

/**
 * `commands/artifact.rs`'s `Artifact::commit`, narrowed to exactly what
 * `create_file`'s two branches use (no `.indexed_as()`, no `.from_files()`, no
 * `.by()`): stage → read the cancel token → commit.
 *
 * THE CANCEL CHECK SITS BETWEEN STAGING AND COMMITTING, and the flag is read
 * HERE rather than by the caller, because that is the whole reason the funnel
 * has this shape. Rust's own comment: "Checking earlier would leave a window
 * in which a Stop is honoured everywhere except the write." A flag snapshotted
 * before `stageArtifact` ran would miss a Stop pressed during the staging
 * write itself — which is why {@link CreateFileOpts.cancel} carries the live
 * flag object rather than a boolean.
 *
 * Discarding is best-effort on both paths — Rust writes `let _ =
 * db::discard_staged(...)`, and the sweep on the next room open is the real
 * backstop — so a failing discard must not replace the accurate error the
 * caller is about to be told with a database complaint about cleanup.
 *
 * Throws exactly where `Artifact::commit` returns `Err`: an empty, nameless or
 * oversized artifact (`stageArtifact`'s own validation), a cancelled write, or
 * a failed commit.
 */
export function commitArtifact(
  db: Database.Database,
  name: string,
  mime: string,
  content: string,
  provenance: Provenance,
  cancel: { load(): boolean } | null | undefined,
): { meta: FileMeta; versioned: boolean } {
  const staged = stageArtifact(
    db,
    name,
    mime,
    Buffer.from(content, "utf8"),
    content,
    provenance,
  );
  if (cancel?.load() ?? false) {
    discardQuietly(db, staged.id);
    throw new Error(
      `Stopped before "${staged.name}" was saved — nothing was written to the room.`,
    );
  }
  try {
    const [meta, versioned] = commitStaged(db, staged.id);
    return { meta, versioned };
  } catch (e) {
    discardQuietly(db, staged.id);
    throw e;
  }
}

/** `let _ = db::discard_staged(conn, &id)` — see {@link commitArtifact}. */
export function discardQuietly(db: Database.Database, stagingId: string): void {
  try {
    discardStaged(db, stagingId);
  } catch {
    // Best-effort by design; the staged-artifact sweep is the backstop.
  }
}

/**
 * `commands/files.rs`'s `store_file_bytes`: snapshot the file's CURRENT bytes
 * into version history tagged with `cause`, then overwrite them.
 *
 * ONE WRITE, not two, and that is load-bearing rather than tidy. Rust's own
 * comment: taken separately, a failed overwrite (a blob past SQLite's ceiling,
 * a full disk) still cut a version — the file was unchanged, its history had
 * gained a duplicate of the current bytes, and at the ten-unpinned-version
 * window the oldest snapshot was evicted to make room for it, while the caller
 * was told nothing had been saved.
 *
 * A local copy for the same reason `recBridge.ts` already carries one: there
 * is no `files.ts`-level port of this two-call pairing to import, only the two
 * halves.
 */
export function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Buffer,
  text: string | null,
  cause: string,
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/**
 * What `execCreateFile` needs beyond `db`/`args`/`effects`, grouped so the
 * arm's signature stays readable. Mirrors `execTool.ts`'s `ExecToolDeps`
 * fields of the same names.
 */
export interface CreateFileOpts {
  /** `turn.map(|t| t.run_id())` — the run this write belongs to, recorded in
   * the file's provenance so History can say which answer produced it.
   * `undefined`/`null` both mean "no run behind this call", which is Rust's
   * own `turn: None` path (a tool dispatched by the persistent room bridge
   * runs behind no ask) rather than a gap this port introduces. */
  runId?: string | null;
  /** The run's Stop flag, read once immediately before the write — see
   * {@link commitArtifact} for why the live object rather than a boolean. */
  cancel?: { load(): boolean } | null;
  emit?: EmitFn;
}

export function createFileProvenance(runId: string | null | undefined): Provenance {
  return runId === undefined || runId === null ? { tool: "create_file" } : { tool: "create_file", runId };
}

export function documentTarget(rawName: string, content: string): { name: string; content: string } {
  const name = extensionOf(rawName) === "" ? `${rawName}.html` : rawName;
  return { name, content: extensionOf(name) === "html" ? htmlDocument(name, content) : content };
}

export function rewrittenScratchPad(
  db: Database.Database,
  content: string,
  effects: { wrote: boolean },
  opts: CreateFileOpts,
  provenance: Provenance,
): OrganizeToolOutcome | null {
  const existing = fileByExactName(db, SCRATCH_PAD_NAME);
  if (existing === null) return null;
  if (content.trim() === "") {
    return fail(
      `Nothing was generated for "${existing.name}" — it was left as it was. ` +
        "(An empty pad would look like finished work.)",
    );
  }
  if (opts.cancel?.load() ?? false) {
    return fail(`Stopped before "${existing.name}" was rewritten — nothing was written to the room.`);
  }
  storeFileBytes(db, existing.id, Buffer.from(content, "utf8"), content, "AI edit");
  setFileProvenance(db, existing.id, provenanceToJson(provenance));
  emitSafely(opts.emit, "room-files-changed", undefined);
  emitSafely(opts.emit, "file-updated", existing.id);
  effects.wrote = true;
  return ok(
    `"${existing.name}" already exists — rewrote it instead of creating a duplicate. ` +
      "The previous notes are kept in History.",
  );
}

export function committedCreateFile(
  db: Database.Database,
  name: string,
  content: string,
  provenance: Provenance,
  cancel: CreateFileOpts["cancel"],
): { meta: FileMeta; versioned: boolean } | OrganizeToolOutcome {
  try {
    return commitArtifact(db, name, noteMime(name), content, provenance, cancel);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function isCreateFailure(
  result: { meta: FileMeta; versioned: boolean } | OrganizeToolOutcome,
): result is OrganizeToolOutcome {
  return "ok" in result && !result.ok;
}

export function createFileSuccess(
  written: { meta: FileMeta; versioned: boolean },
  effects: { wrote: boolean },
  emit: EmitFn | undefined,
): OrganizeToolOutcome {
  emitSafely(emit, "room-files-changed", undefined);
  effects.wrote = true;
  return ok(
    written.versioned
      ? `"${written.meta.name}" already existed — rewrote it instead of creating a duplicate. ` +
        "The previous version is kept in History."
      : `Created "${written.meta.name}" in the room.`,
  );
}

/** Ported from `exec_tool`'s `"create_file"` arm. */
export function execCreateFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  opts: CreateFileOpts = {},
): OrganizeToolOutcome {
  const rawName = typeof args.name === "string" ? args.name : "AI note";
  const content = asString(args.content);
  const provenance = createFileProvenance(opts.runId);

  // Wave 1b (idea 10): the canonical scratch pad is get-or-create. Every name
  // resolver returns the NEWEST match, so a duplicate "Scratch pad.md" would
  // silently shadow the real pad (and its notes) for the chip and every future
  // agent edit — redirect a create onto the existing pad as a normal versioned
  // overwrite.
  if (isScratchPadName(rawName)) {
    const rewritten = rewrittenScratchPad(db, content, effects, opts, provenance);
    if (rewritten !== null) return rewritten;
    // No pad yet: create it under the CANONICAL name (never the HTML-defaulted
    // variant), so the chip and prompt line resolve it.
    const created = committedCreateFile(db, SCRATCH_PAD_NAME, content, provenance, opts.cancel);
    return isCreateFailure(created) ? created : createFileSuccess(created, effects, opts.emit);
  }

  // ADD-22 (HTML-first): a document with no explicit extension defaults to
  // HTML; body/plain content is wrapped in a styled standalone page (a no-op
  // when the model already returned a full HTML document).
  const target = documentTarget(rawName, content);

  // ART-1: the agent's own write goes through the staging funnel like every
  // other generated artifact. Two consequences the model is told about below:
  // a Stop pressed while it was writing lands BEFORE the commit, and asking
  // for the same document twice versions it instead of leaving two files with
  // the same name.
  const written = committedCreateFile(db, target.name, target.content, provenance, opts.cancel);
  return isCreateFailure(written) ? written : createFileSuccess(written, effects, opts.emit);
}

// --------------------------------------------------------------- rename_file

/** Ported from `exec_tool`'s `"rename_file"` arm. */
export function execRenameFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): OrganizeToolOutcome {
  const name = asString(args.name);
  const newName = asString(args.new_name).trim();
  if (newName === "") {
    return fail("new_name is required.");
  }

  let id: string;
  let realName: string;
  try {
    // `_qualified`: `list_room_files` prints a filed document as
    // "Invoices/q3.pdf", so that string has to work here. The plain matcher
    // searches the name column alone and rejected the exact text it had just
    // shown.
    [id, realName] = findFileLikeQualified(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }

  // Keep the original extension if the model dropped it.
  let finalName: string;
  if (extensionOf(newName) !== "") {
    finalName = newName;
  } else {
    const ext = extensionOf(realName);
    finalName = ext === "" ? newName : `${newName}.${ext}`;
  }

  try {
    renameFile(db, id, finalName);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "file-updated", id);
  effects.wrote = true;
  return ok(`Renamed "${realName}" to "${finalName}".`);
}

// ------------------------------------------------------------ set_in_library

/**
 * Ported from `exec_tool`'s `"set_in_library"` arm.
 *
 * Promotion is an ACT the agent reports, not a side effect it performs.
 * `effects.wrote` marks the room changed, which is what the honesty gate reads
 * before it lets a reply claim to have organised anything; the returned
 * sentence says what actually changed — including that the object stayed where
 * it was, because "added to Library" alone reads like a move.
 *
 * `assistant-organized` is the other half, and it is a SEPARATE event from
 * `room-files-changed` on purpose. That one says the list is stale; this one
 * says who changed what, which is the only form in which Activity can carry
 * it.
 */
export function execSetInLibrary(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): OrganizeToolOutcome {
  const name = asString(args.name);
  const linked = asBoolDefault(args.in_library, true);

  let id: string;
  let realName: string;
  try {
    [id, realName] = findFileLikeQualified(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }
  try {
    setLibraryVisibility(db, id, linked);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "assistant-organized", { id, name: realName, linked });
  effects.wrote = true;
  return ok(
    linked
      ? `Added "${realName}" to the Library. It is still in its own section, and no copy was made.`
      : `Removed "${realName}" from the Library. The object itself is untouched and still in its own section.`,
  );
}

// ----------------------------------------------------------------- move_file

/** The vocabulary that means "the top level" rather than a folder — the same
 * words `organize.ts`'s own (private) copy accepts. Re-spelled rather than
 * shared; see the module doc. */
const TOP_LEVEL_WORDS = ["none", "top", "top level", "root", "/"];

export function meansTopLevel(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "" || TOP_LEVEL_WORDS.includes(trimmed);
}

/** Ported from `exec_tool`'s `"move_file"` arm. */
export function execMoveFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): OrganizeToolOutcome {
  const name = asString(args.name);
  const folder = asString(args.folder).trim();

  let id: string;
  let realName: string;
  try {
    // Same round-trip fix as `rename_file` above.
    [id, realName] = findFileLikeQualified(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }

  let whereTo: string;
  try {
    // Get-or-create is deliberate: "file this under Invoices" before an
    // Invoices folder exists is what the request means. Everything from
    // resolving the destination to the move itself shares one catch, because
    // Rust `?`-propagates all three of these calls into the same `Err` — a
    // folder that cannot be listed or created is a refusal the model can read,
    // never an exception out of the dispatch.
    let folderId: string | null;
    if (meansTopLevel(folder)) {
      folderId = null;
      whereTo = "the top level";
    } else {
      const lower = folder.toLowerCase();
      const existing = listFolders(db).find(
        (f) => f.name.toLowerCase() === lower,
      );
      folderId =
        existing !== undefined ? existing.id : createFolder(db, folder).id;
      whereTo = `"${folder}"`;
    }
    moveFileToFolder(db, id, folderId);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  effects.wrote = true;
  return ok(`Moved "${realName}" to ${whereTo}.`);
}

// ------------------------------------------------------------ organize_files

type OrganizeRequest = { entries: OrganizeEntry[]; make: string[]; remove: string[]; dryRun: boolean };

export function organizeRequest(args: Record<string, unknown>): OrganizeRequest {
  return {
    entries: parseOrganizeEntries(args.files),
    make: parseStringArray(args.make_folders),
    remove: parseStringArray(args.remove_folders),
    dryRun: asBoolDefault(args.dry_run, false),
  };
}

export function organizeRequestIsEmpty(request: OrganizeRequest): boolean {
  return request.entries.length === 0 && request.make.length === 0 && request.remove.length === 0;
}

export function organizeChanged(report: OrganizeReport): boolean {
  return report.moved.length > 0 || report.renamed.length > 0 || report.foldersMade.length > 0 || report.foldersRemoved.length > 0;
}

export function organizedReport(db: Database.Database, request: OrganizeRequest): OrganizeReport | OrganizeToolOutcome {
  try {
    return organize(db, request.entries, request.make, request.remove, request.dryRun);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function isOrganizeFailure(result: OrganizeReport | OrganizeToolOutcome): result is OrganizeToolOutcome {
  return "ok" in result;
}

/** Ported from `exec_tool`'s `"organize_files"` arm. */
export function execOrganizeFiles(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): OrganizeToolOutcome {
  const request = organizeRequest(args);
  if (organizeRequestIsEmpty(request)) {
    // Refuse rather than reporting a cheerful nothing: an empty plan is a
    // model that misread the schema, and "done!" over it is precisely the
    // false completion `react_verify` exists for.
    return fail(
      "organize_files needs at least one entry in files, make_folders or remove_folders.",
    );
  }

  const report = organizedReport(db, request);
  if (isOrganizeFailure(report)) return report;

  if (!request.dryRun) {
    emitSafely(emit, "room-files-changed", undefined);
    // Only a run that CHANGED something counts as a write — a preview must not
    // arm the undo affordance for edits it never made, and a plan that matched
    // nothing must not either.
    //
    // `||=`, never `=`: the flag belongs to the whole TURN, and a plan that
    // matched nothing used to erase an earlier tool's real write — so a
    // truthful "I created plan.md and tidied up" was handed the "no file was
    // actually changed" correction.
    effects.wrote ||= organizeChanged(report);
  }
  return ok(organizeSentence(report, request.dryRun));
}

// --------------------------------------------------------------- trash_files

/** Ported from `exec_tool`'s `"trash_files"` arm. */
export function execTrashFiles(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): OrganizeToolOutcome {
  const names = parseStringArray(args.names);
  if (names.length === 0) {
    return fail("trash_files needs at least one file name.");
  }

  const [report, misses] = trashNamed(db, names);
  emitSafely(emit, "room-files-changed", undefined);
  // `||=` for the same reason `organize_files` uses it: a name that matched
  // nothing must not un-say an earlier write in this turn.
  effects.wrote ||= bulkReportChangedAnything(report);

  let out = bulkReportSentence(report, "moved to the trash");
  if (misses.length > 0) {
    out += ` Not found: ${misses.map((m) => `"${m.name}"`).join(", ")}.`;
  }
  // Name the way back, every time. The user did not press this button, so the
  // sentence they read has to carry the undo.
  out += " They are recoverable from Library → Trash.";
  return ok(out);
}

// --------------------------------------------------------------- merge_files

/** Ported from `exec_tool`'s `"merge_files"` arm. */
export function execMergeFiles(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): OrganizeToolOutcome {
  const names = parseStringArray(args.names);
  const into = asString(args.into);
  const headings = asBoolDefault(args.headings, true);
  const trashSources = asBoolDefault(args.trash_sources, false);

  let receipt: string;
  try {
    [, receipt] = merge(db, names, into, headings, trashSources);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  effects.wrote = true;
  return ok(receipt);
}

// ------------------------------------------------------ workspace live paths
