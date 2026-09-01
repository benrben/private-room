import type Database from "better-sqlite3-multiple-ciphers";
import path from "node:path";
import { Readable } from "node:stream";
import {
  availableName,
  fileByExactName,
  findFileLikeQualified,
  getFileMeta,
  renameFile,
  setFileExtractedText,
  type FileMeta,
} from "./db-host/files.js";
import { setFileProvenance } from "./db-host/versions.js";
import { discardStaged, provenanceToJson, stageArtifact, type Provenance } from "./db-host/artifacts.js";
import { isScratchPadName, noteMime, SCRATCH_PAD_NAME } from "./docsHtml.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import {
  asString,
  emitSafely,
  errMessage,
  extensionOf,
  fail,
  ok,
  parseStringArray,
  type EmitFn,
  type OrganizeToolOutcome,
} from "./organizeToolsModel.js";
import {
  createFileProvenance,
  createFileSuccess,
  discardQuietly,
  documentTarget,
  meansTopLevel,
  type CreateFileOpts,
} from "./organizeToolsCommitted.js";

export async function writeWorkspaceGenerated(
  db: Database.Database,
  workspace: WorkspaceService,
  desiredName: string,
  mime: string,
  content: string,
  provenance: Provenance,
  cancel?: { load(): boolean } | null,
): Promise<{ meta: FileMeta; versioned: boolean }> {
  const bytes = Buffer.from(content, "utf8");
  const staged = stageArtifact(
    db,
    desiredName,
    mime,
    bytes,
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
    const existing = db
      .prepare(
        `SELECT id, content_sha256 FROM files
       WHERE source = 'generated' AND storage_kind = 'workspace' AND trashed_at IS NULL
         AND (lower(artifact_key) = lower(?)
              OR (artifact_key IS NULL AND lower(name) = lower(?)))
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(staged.name, staged.name) as
      | { id: string; content_sha256: string | null }
      | undefined;
    let id: string;
    let versioned: boolean;
    if (existing !== undefined) {
      await workspace.snapshotVersion(existing.id, "AI regenerated");
      await workspace.writeAtomic(
        existing.id,
        Readable.from([bytes]),
        existing.content_sha256 ?? undefined,
      );
      setFileExtractedText(db, existing.id, content);
      id = existing.id;
      versioned = true;
    } else {
      const entry = await workspace.createFile(
        availableName(db, staged.name),
        Readable.from([bytes]),
        "generated",
      );
      setFileExtractedText(db, entry.fileId, content);
      id = entry.fileId;
      versioned = false;
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE files SET mime_type = ?, provenance = ?, artifact_key = ? WHERE id = ?",
      ).run(mime, provenanceToJson(provenance), staged.name, id);
      discardStaged(db, staged.id);
    })();
    return { meta: getFileMeta(db, id), versioned };
  } catch (error) {
    discardQuietly(db, staged.id);
    throw error;
  }
}

export async function rewriteWorkspaceScratchPad(
  db: Database.Database,
  workspace: WorkspaceService,
  content: string,
  effects: { wrote: boolean },
  opts: CreateFileOpts,
  provenance: Provenance,
): Promise<OrganizeToolOutcome | null> {
  try {
    const existing = fileByExactName(db, SCRATCH_PAD_NAME);
    if (existing === null) return null;
    const refusal = scratchRewriteRefusal(existing.name, content, opts.cancel);
    if (refusal !== null) return refusal;
    return await rewriteExistingWorkspaceScratch(db, workspace, existing, content, effects, opts.emit, provenance);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function scratchRewriteRefusal(
  name: string,
  content: string,
  cancel: CreateFileOpts["cancel"],
): OrganizeToolOutcome | null {
  if (content.trim() === "") return fail(`Nothing was generated for "${name}" — it was left as it was.`);
  return cancel?.load() ?? false
    ? fail(`Stopped before "${name}" was rewritten — nothing was written to the room.`)
    : null;
}

export async function rewriteExistingWorkspaceScratch(
  db: Database.Database,
  workspace: WorkspaceService,
  existing: FileMeta,
  content: string,
  effects: { wrote: boolean },
  emit: EmitFn | undefined,
  provenance: Provenance,
): Promise<OrganizeToolOutcome> {
  const row = db.prepare("SELECT content_sha256 FROM files WHERE id = ?").get(existing.id) as {
    content_sha256: string | null;
  };
  await workspace.snapshotVersion(existing.id, "AI edit");
  await workspace.writeAtomic(existing.id, Readable.from([Buffer.from(content)]), row.content_sha256 ?? undefined);
  setFileExtractedText(db, existing.id, content);
  setFileProvenance(db, existing.id, provenanceToJson(provenance));
  effects.wrote = true;
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "file-updated", existing.id);
  return ok(
    `"${existing.name}" already exists — rewrote it instead of creating a duplicate. The previous notes are kept in History.`,
  );
}

export async function createWorkspaceDocument(
  db: Database.Database,
  workspace: WorkspaceService,
  target: { name: string; content: string },
  effects: { wrote: boolean },
  opts: CreateFileOpts,
  provenance: Provenance,
): Promise<OrganizeToolOutcome> {
  try {
    const written = await writeWorkspaceGenerated(
      db, workspace, target.name, noteMime(target.name), target.content, provenance, opts.cancel,
    );
    return createFileSuccess(written, effects, opts.emit);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execCreateFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  opts: CreateFileOpts = {},
): Promise<OrganizeToolOutcome> {
  const rawName = typeof args.name === "string" ? args.name : "AI note";
  const content = asString(args.content);
  const provenance = createFileProvenance(opts.runId);
  if (isScratchPadName(rawName)) {
    const rewritten = await rewriteWorkspaceScratchPad(db, workspace, content, effects, opts, provenance);
    if (rewritten !== null) return rewritten;
    return createWorkspaceDocument(
      db, workspace, { name: SCRATCH_PAD_NAME, content }, effects, opts, provenance,
    );
  }
  return createWorkspaceDocument(db, workspace, documentTarget(rawName, content), effects, opts, provenance);
}

export function workspaceRow(
  db: Database.Database,
  id: string,
): { relativePath: string; hash: string | null } {
  const row = db
    .prepare(
      "SELECT relative_path, content_sha256 FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL",
    )
    .get(id) as
    | { relative_path: string; content_sha256: string | null }
    | undefined;
  if (row === undefined)
    throw new Error("That normal workspace file is no longer available.");
  return { relativePath: row.relative_path, hash: row.content_sha256 };
}

export function renamedWorkspaceFileName(newName: string, currentName: string): string {
  if (extensionOf(newName) !== "") return newName;
  const extension = extensionOf(currentName);
  return extension === "" ? newName : `${newName}.${extension}`;
}

export async function execRenameFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const newName = asString(args.new_name).trim();
  if (newName === "") return fail("new_name is required.");
  try {
    const [id, realName] = findFileLikeQualified(db, asString(args.name));
    const row = workspaceRow(db, id);
    const finalName = renamedWorkspaceFileName(newName, realName);
    const parent = path.posix.dirname(row.relativePath);
    await workspace.move(
      id,
      parent === "." ? finalName : path.posix.join(parent, finalName),
      row.hash ?? undefined,
    );
    effects.wrote = true;
    emitSafely(emit, "room-files-changed", undefined);
    emitSafely(emit, "file-updated", id);
    return ok(`Renamed "${realName}" to "${finalName}".`);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execMoveFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  try {
    const [id, realName] = findFileLikeQualified(db, asString(args.name));
    const row = workspaceRow(db, id);
    const folder = asString(args.folder).trim();
    const destination = meansTopLevel(folder)
      ? realName
      : path.posix.join(folder, realName);
    await workspace.move(id, destination, row.hash ?? undefined);
    effects.wrote = true;
    emitSafely(emit, "room-files-changed", undefined);
    return ok(
      `Moved "${realName}" to ${meansTopLevel(folder) ? "the top level" : `"${folder}"`}.`,
    );
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function trashWorkspaceFile(
  db: Database.Database,
  workspace: WorkspaceService,
  name: string,
): Promise<string | null> {
  try {
    const [id, realName] = findFileLikeQualified(db, name);
    const row = workspaceRow(db, id);
    await workspace.trash(id, row.hash ?? undefined);
    return realName;
  } catch {
    return null;
  }
}

export function workspaceTrashReceipt(trashed: readonly string[], missed: readonly string[]): OrganizeToolOutcome {
  let text = trashed.length === 0
    ? "Nothing was moved to the trash."
    : `Moved ${trashed.map((name) => `"${name}"`).join(", ")} to the trash.`;
  if (missed.length > 0) text += ` Not found: ${missed.map((name) => `"${name}"`).join(", ")}.`;
  return ok(`${text} They are recoverable from Library → Trash.`);
}

export async function execTrashFilesWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const names = parseStringArray(args.names);
  if (names.length === 0)
    return fail("trash_files needs at least one file name.");
  const trashed: string[] = [];
  const missed: string[] = [];
  for (const name of names) {
    const realName = await trashWorkspaceFile(db, workspace, name);
    if (realName === null) missed.push(name);
    else trashed.push(realName);
  }
  effects.wrote ||= trashed.length > 0;
  emitSafely(emit, "room-files-changed", undefined);
  return workspaceTrashReceipt(trashed, missed);
}
