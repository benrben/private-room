import path from "node:path";
import { Readable } from "node:stream";
import type Database from "better-sqlite3-multiple-ciphers";
import { setFileExtractedText } from "./db-host/files.js";
import {
  EditError,
  extractText,
  hashBytes,
  type PlannedWrite,
} from "./editMatch.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

function strictText(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface WorkspacePlanState {
  relativePath: string;
  hash: string;
}

interface AppliedWorkspacePlan {
  plan: PlannedWrite;
  finalHash: string;
  renamed: boolean;
}

function staleWorkspaceNameError(plan: PlannedWrite): EditError {
  return new EditError(
    `"${plan.realName}" was renamed or removed while the approval was pending; ` +
      "nothing was applied. Look it up again and retry.",
    "stale",
  );
}

function staleWorkspaceBytesError(plan: PlannedWrite): EditError {
  return new EditError(
    `"${plan.realName}" changed while the approval was pending; nothing was applied. ` +
      "Read it again and retry.",
    "stale",
  );
}

async function preflightWorkspacePlan(
  db: Database.Database,
  workspace: WorkspaceService,
  plan: PlannedWrite,
): Promise<WorkspacePlanState> {
  const row = db
    .prepare(
      `SELECT name, relative_path FROM files
       WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    )
    .get(plan.fileId) as { name: string; relative_path: string } | undefined;
  if (row === undefined || row.name !== plan.realName) {
    throw staleWorkspaceNameError(plan);
  }
  const hash = hashBytes(await workspace.readBuffer(plan.fileId)).toString(
    "hex",
  );
  if (plan.staleness !== null && hash !== plan.staleness.toString("hex")) {
    throw staleWorkspaceBytesError(plan);
  }
  return { relativePath: row.relative_path, hash };
}

async function preflightWorkspacePlans(
  db: Database.Database,
  workspace: WorkspaceService,
  plans: readonly PlannedWrite[],
): Promise<Map<string, WorkspacePlanState>> {
  const current = new Map<string, WorkspacePlanState>();
  for (const plan of plans) {
    current.set(
      plan.fileId,
      await preflightWorkspacePlan(db, workspace, plan),
    );
  }
  return current;
}

async function snapshotWorkspacePlans(
  workspace: WorkspaceService,
  plans: readonly PlannedWrite[],
  cause: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (const plan of plans) {
    if (plan.newBytes !== null) {
      versions.set(
        plan.fileId,
        await workspace.snapshotVersion(plan.fileId, cause),
      );
    }
  }
  return versions;
}

function workspaceRenameDestination(
  relativePath: string,
  name: string,
): string {
  const parent = path.posix.dirname(relativePath);
  return parent === "." ? name : path.posix.join(parent, name);
}

async function writeWorkspacePlanBytes(
  db: Database.Database,
  workspace: WorkspaceService,
  plan: PlannedWrite,
  expectedHash: string,
): Promise<string> {
  const newBytes = plan.newBytes!;
  await workspace.writeAtomic(
    plan.fileId,
    Readable.from([newBytes]),
    expectedHash,
  );
  const finalHash = hashBytes(newBytes).toString("hex");
  setFileExtractedText(
    db,
    plan.fileId,
    extractText(plan.realName, newBytes) ?? strictText(newBytes) ?? "",
  );
  return finalHash;
}

async function moveWorkspacePlan(
  workspace: WorkspaceService,
  plan: PlannedWrite,
  relativePath: string,
  expectedHash: string,
): Promise<void> {
  if (plan.renameTo === null) return;
  await workspace.move(
    plan.fileId,
    workspaceRenameDestination(relativePath, plan.renameTo),
    expectedHash,
  );
}

async function applyWorkspacePlan(
  db: Database.Database,
  workspace: WorkspaceService,
  plan: PlannedWrite,
  before: WorkspacePlanState,
  applied: AppliedWorkspacePlan[],
): Promise<void> {
  if (plan.newBytes === null) {
    await moveWorkspacePlan(
      workspace,
      plan,
      before.relativePath,
      before.hash,
    );
    applied.push({
      plan,
      finalHash: before.hash,
      renamed: plan.renameTo !== null,
    });
    return;
  }
  const finalHash = await writeWorkspacePlanBytes(
    db,
    workspace,
    plan,
    before.hash,
  );
  const appliedPlan = { plan, finalHash, renamed: false };
  applied.push(appliedPlan);
  await moveWorkspacePlan(workspace, plan, before.relativePath, finalHash);
  if (plan.renameTo !== null) appliedPlan.renamed = true;
}

async function restoreWorkspacePlan(
  db: Database.Database,
  workspace: WorkspaceService,
  current: ReadonlyMap<string, WorkspacePlanState>,
  versions: ReadonlyMap<string, string>,
  applied: AppliedWorkspacePlan,
): Promise<void> {
  const before = current.get(applied.plan.fileId)!;
  if (applied.renamed) {
    await workspace.move(
      applied.plan.fileId,
      before.relativePath,
      applied.finalHash,
    );
  }
  const versionId = versions.get(applied.plan.fileId);
  if (versionId === undefined) return;
  const snapshot = await workspace.versionSnapshot(versionId);
  await workspace.writeAtomic(
    applied.plan.fileId,
    Readable.from([snapshot.bytes]),
    applied.finalHash,
  );
  if (snapshot.text !== null) {
    setFileExtractedText(db, applied.plan.fileId, snapshot.text);
  }
}

async function rollbackWorkspacePlans(
  db: Database.Database,
  workspace: WorkspaceService,
  current: ReadonlyMap<string, WorkspacePlanState>,
  versions: ReadonlyMap<string, string>,
  applied: readonly AppliedWorkspacePlan[],
): Promise<boolean> {
  let rollbackFailed = false;
  for (const entry of [...applied].reverse()) {
    try {
      await restoreWorkspacePlan(db, workspace, current, versions, entry);
    } catch {
      rollbackFailed = true;
    }
  }
  return rollbackFailed;
}

async function deleteTransientWorkspaceVersions(
  workspace: WorkspaceService,
  versions: ReadonlyMap<string, string>,
): Promise<void> {
  for (const versionId of versions.values()) {
    await workspace.deleteVersion(versionId).catch(() => undefined);
  }
}

/** Apply a guarded workspace batch, rolling back any partial conflict. */
export async function applyWorkspaceWithStaleness(
  db: Database.Database,
  workspace: WorkspaceService,
  plans: readonly PlannedWrite[],
  cause: string,
): Promise<void> {
  const current = await preflightWorkspacePlans(db, workspace, plans);
  const versions = await snapshotWorkspacePlans(workspace, plans, cause);
  const applied: AppliedWorkspacePlan[] = [];
  try {
    for (const plan of plans) {
      await applyWorkspacePlan(
        db,
        workspace,
        plan,
        current.get(plan.fileId)!,
        applied,
      );
    }
  } catch (error) {
    const rollbackFailed = await rollbackWorkspacePlans(
      db,
      workspace,
      current,
      versions,
      applied,
    );
    if (!rollbackFailed) {
      await deleteTransientWorkspaceVersions(workspace, versions);
    }
    if (rollbackFailed) {
      throw new EditError(
        "The batch hit a conflict and Arcelle could not safely restore every earlier file. " +
          "Review the changed files and use History to restore them.",
        "error",
      );
    }
    throw error;
  }
}
