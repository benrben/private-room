import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../workspace/hash.js";
import { resolveWorkspacePath } from "../workspace/pathSafety.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import type { HarnessContext } from "./types.js";

interface RunFileRow {
  file_id: string;
  baseline_path: string | null;
  baseline_hash: string | null;
  baseline_object_id: string | null;
  final_path: string | null;
  final_hash: string | null;
}

export interface RollbackResult {
  restored: string[];
  removedCreated: string[];
  conflicts: string[];
}

export interface RunChangeSummary {
  changedPaths: string[];
  count: number;
}

export class RunProtection {
  private readonly writeRuns = new Set<string>();
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly roomId: string,
    private readonly reindexChanged: () => Promise<unknown> = async () => undefined,
  ) {}

  async createBaseline(context: HarnessContext): Promise<void> {
    await this.workspace.reconcile();
    this.workspace.db.prepare(
      `INSERT INTO agent_runs(
         run_id, room_id, provider, harness, model, privacy_mode, status, baseline_completed
       ) VALUES (?, ?, ?, ?, ?, ?, 'preparing', 0)`,
    ).run(
      context.runId,
      this.roomId,
      context.provider,
      context.provider === "codex" ? "codex-app-server" : context.provider === "claude" ? "claude-agent-sdk" : "arcelle-deep",
      context.model,
      context.privacyMode,
    );
    if (!context.writeEnabled) {
      this.workspace.db.prepare("UPDATE agent_runs SET baseline_completed = 1, status = 'running' WHERE run_id = ?")
        .run(context.runId);
      return;
    }
    this.writeRuns.add(context.runId);
    const files = this.workspace.db.prepare(
      `SELECT id, relative_path, content_sha256 FROM files
       WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND index_state != 'offline'
       ORDER BY relative_path`,
    ).all() as Array<{ id: string; relative_path: string; content_sha256: string }>;
    try {
      for (const file of files) {
        const object = await this.workspace.snapshot(file.id, "agent_run", context.runId, "baseline");
        this.workspace.db.prepare(
          `INSERT INTO agent_run_files(
             run_id, file_id, baseline_path, baseline_hash, baseline_object_id
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(context.runId, file.id, file.relative_path, object.sha256, object.id);
      }
      this.workspace.db.prepare("UPDATE agent_runs SET baseline_completed = 1, status = 'running' WHERE run_id = ?")
        .run(context.runId);
    } catch (error) {
      this.writeRuns.delete(context.runId);
      this.workspace.db.prepare("UPDATE agent_runs SET status = 'failed' WHERE run_id = ?").run(context.runId);
      throw new Error(`The protected write baseline could not be completed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async finish(runId: string, status: "completed" | "cancelled" | "failed"): Promise<void> {
    if (!this.writeRuns.has(runId)) {
      this.workspace.db.prepare(
        `UPDATE agent_runs SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE run_id = ?`,
      ).run(status, runId);
      return;
    }
    await this.captureFinalState(runId);
    this.writeRuns.delete(runId);
    this.workspace.db.prepare(
      `UPDATE agent_runs SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE run_id = ?`,
    ).run(status, runId);
  }

  /** Reconcile and persist a reviewable, idempotent change set. */
  async captureFinalState(runId: string): Promise<RunChangeSummary> {
    if (!this.writeRuns.has(runId)) return { changedPaths: [], count: 0 };
    await this.workspace.reconcile();
    // A terminal harness event is not final until changed normal files have a
    // hash-matched extraction/search state. Failed extraction is recorded per
    // file and does not damage or roll back the user's file.
    await this.reindexChanged();
    const baseline = this.workspace.db.prepare(
      "SELECT file_id, baseline_path, baseline_hash FROM agent_run_files WHERE run_id = ?",
    ).all(runId) as Array<{ file_id: string; baseline_path: string | null; baseline_hash: string | null }>;
    const baselineIds = new Set(baseline.map((row) => row.file_id));
    const current = this.workspace.db.prepare(
      `SELECT id, relative_path, content_sha256, index_state FROM files
       WHERE storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).all() as Array<{ id: string; relative_path: string; content_sha256: string | null; index_state: string }>;
    const currentById = new Map(current.map((row) => [row.id, row]));
    for (const row of baseline) {
      const now = currentById.get(row.file_id);
      const finalPath = now?.index_state === "offline" ? null : now?.relative_path ?? null;
      const finalHash = now?.index_state === "offline" ? null : now?.content_sha256 ?? null;
      const change = finalPath === null
        ? "deleted"
        : finalPath !== row.baseline_path
          ? "moved"
          : finalHash !== row.baseline_hash
            ? "modified"
            : "unchanged";
      this.workspace.db.prepare(
        `UPDATE agent_run_files SET final_path = ?, final_hash = ?, change_type = ?
         WHERE run_id = ? AND file_id = ?`,
      ).run(finalPath, finalHash, change, runId, row.file_id);
    }
    for (const now of current) {
      if (now.index_state === "offline" || baselineIds.has(now.id)) continue;
      this.workspace.db.prepare(
        `INSERT INTO agent_run_files(run_id, file_id, final_path, final_hash, change_type)
         VALUES (?, ?, ?, ?, 'created')
         ON CONFLICT(run_id, file_id) DO UPDATE SET
           final_path = excluded.final_path, final_hash = excluded.final_hash,
           change_type = excluded.change_type`,
      ).run(runId, now.id, now.relative_path, now.content_sha256);
    }
    const changes = this.workspace.db.prepare(
      `SELECT coalesce(final_path, baseline_path) AS path FROM agent_run_files
       WHERE run_id = ? AND change_type IN ('created', 'modified', 'moved', 'deleted')
       ORDER BY path`,
    ).all(runId) as Array<{ path: string }>;
    return { changedPaths: changes.map((row) => row.path), count: changes.length };
  }

  async rollback(runId: string): Promise<RollbackResult> {
    const run = this.workspace.db.prepare(
      "SELECT baseline_completed FROM agent_runs WHERE run_id = ?",
    ).get(runId) as { baseline_completed: number } | undefined;
    if (run?.baseline_completed !== 1) throw new Error("This run has no complete rollback baseline.");
    const rows = this.workspace.db.prepare(
      `SELECT file_id, baseline_path, baseline_hash, baseline_object_id, final_path, final_hash
       FROM agent_run_files WHERE run_id = ?`,
    ).all(runId) as RunFileRow[];
    const result: RollbackResult = { restored: [], removedCreated: [], conflicts: [] };
    for (const row of rows) {
      if (row.baseline_object_id === null || row.baseline_path === null || row.baseline_hash === null) {
        if (row.final_path === null) continue;
        const currentPath = resolveWorkspacePath(this.workspace.rootPath, row.final_path);
        if (!existsSync(currentPath)) continue;
        const currentHash = await sha256File(currentPath);
        if (row.final_hash !== null && currentHash === row.final_hash) {
          await this.workspace.trash(row.file_id, currentHash);
          result.removedCreated.push(row.final_path);
        } else {
          result.conflicts.push(row.final_path);
        }
        continue;
      }

      const baselinePath = resolveWorkspacePath(this.workspace.rootPath, row.baseline_path);
      if (row.final_path !== null) {
        const finalPath = resolveWorkspacePath(this.workspace.rootPath, row.final_path);
        if (existsSync(finalPath)) {
          const currentHash = await sha256File(finalPath);
          if (row.final_hash !== null && currentHash !== row.final_hash) {
            result.conflicts.push(row.final_path);
            continue;
          }
          if (finalPath !== baselinePath) await rm(finalPath);
        }
      }
      if (existsSync(baselinePath)) {
        const currentHash = await sha256File(baselinePath);
        if (row.final_path !== row.baseline_path && currentHash !== row.baseline_hash) {
          result.conflicts.push(row.baseline_path);
          continue;
        }
      }
      await this.workspace.objects.restoreTo(row.baseline_object_id, baselinePath);
      result.restored.push(row.baseline_path);
    }
    await this.workspace.reconcile();
    await this.reindexChanged();
    this.workspace.db.prepare(
      `UPDATE agent_runs SET rollback_status = ?, status = 'rolled_back'
       WHERE run_id = ?`,
    ).run(result.conflicts.length === 0 ? "completed" : "conflicts", runId);
    return result;
  }

  /**
   * Keep a later user edit and restore selected protected baselines beside it.
   * The requested paths must belong to this run; callers cannot use this as a
   * general object-store extraction API.
   */
  async restoreBaselineAsCopies(runId: string, requestedPaths: string[]): Promise<string[]> {
    const wanted = new Set(requestedPaths);
    if (wanted.size === 0) return [];
    if (wanted.size > 100) throw new Error("Restore at most 100 baseline copies at one time.");
    const rows = this.workspace.db.prepare(
      `SELECT baseline_path, final_path, baseline_object_id
       FROM agent_run_files WHERE run_id = ? AND baseline_object_id IS NOT NULL`,
    ).all(runId) as Array<{
      baseline_path: string | null;
      final_path: string | null;
      baseline_object_id: string;
    }>;
    const selected = rows.filter((row) =>
      (row.baseline_path !== null && wanted.has(row.baseline_path))
      || (row.final_path !== null && wanted.has(row.final_path))
    );
    if (selected.length !== wanted.size) {
      throw new Error("One or more requested files do not belong to this rollback baseline.");
    }
    const restored: string[] = [];
    for (const row of selected) {
      if (row.baseline_path === null) continue;
      const copyPath = this.availableBaselineCopyPath(row.baseline_path);
      await this.workspace.createFileFromObject(row.baseline_object_id, copyPath, "rollback-copy");
      restored.push(copyPath);
    }
    return restored;
  }

  private availableBaselineCopyPath(relativePath: string): string {
    const extension = path.posix.extname(relativePath);
    const stem = relativePath.slice(0, relativePath.length - extension.length);
    for (let number = 1; number <= 10_000; number += 1) {
      const suffix = number === 1 ? " (baseline)" : ` (baseline ${number})`;
      const candidate = `${stem}${suffix}${extension}`;
      if (!existsSync(resolveWorkspacePath(this.workspace.rootPath, candidate))) return candidate;
    }
    throw new Error("Could not find an available name for the baseline copy.");
  }
}
