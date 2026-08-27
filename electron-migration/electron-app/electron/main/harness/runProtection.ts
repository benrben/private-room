import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../workspace/hash.js";
import { resolveWorkspacePath } from "../workspace/pathSafety.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import type { HarnessContext } from "./types.js";
import type { WorkspaceOperationProgressSink } from "../../shared/workspaceProgress.js";
import { WorkspaceOperationReporter } from "../workspace/operationProgress.js";
import type { HarnessHistoryRun } from "../../shared/harnessTypes.js";

interface RunFileRow {
  file_id: string;
  baseline_path: string | null;
  baseline_hash: string | null;
  baseline_object_id: string | null;
  final_path: string | null;
  final_hash: string | null;
  rollback_state: string | null;
}

export interface RollbackResult {
  restored: string[];
  removedCreated: string[];
  conflicts: string[];
}

export interface RunChangeSummary {
  changedPaths: string[];
  changedFiles: Array<{
    fileId: string;
    relativePath: string;
    change: "created" | "modified" | "moved" | "deleted";
  }>;
  count: number;
}

/** Keep rollback/audit history useful without allowing it to grow forever. */
export const AGENT_AUDIT_RETAIN_RUNS = 100;
export const AGENT_AUDIT_RETAIN_DAYS = 90;

export class RunProtection {
  private readonly writeRuns = new Set<string>();
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly roomId: string,
    private readonly reindexChanged: () => Promise<unknown> = async () => undefined,
    private readonly progress?: WorkspaceOperationProgressSink,
  ) {}

  async createBaseline(context: HarnessContext): Promise<void> {
    const reporter = context.writeEnabled
      ? new WorkspaceOperationReporter("write-baseline", this.progress, context.runId)
      : null;
    reporter?.start();
    try {
      await this.createBaselineCore(context, reporter);
      reporter?.complete();
    } catch (error) {
      reporter?.fail();
      throw error;
    }
  }

  private async createBaselineCore(
    context: HarnessContext,
    reporter: WorkspaceOperationReporter | null,
  ): Promise<void> {
    reporter?.emit("scanning", 0, null);
    await this.workspace.reconcile();
    this.workspace.db.prepare(
      `INSERT INTO agent_runs(
         run_id, room_id, provider, harness, model, privacy_mode, status,
         write_enabled, baseline_completed
       ) VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, 0)`,
    ).run(
      context.runId,
      this.roomId,
      context.provider,
      context.provider === "codex" ? "codex-app-server" : context.provider === "claude" ? "claude-agent-sdk" : "arcelle-deep",
      context.model,
      context.privacyMode,
      context.writeEnabled ? 1 : 0,
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
      let completed = 0;
      reporter?.emit("snapshotting", completed, files.length, "files");
      for (const file of files) {
        const object = await this.workspace.snapshot(file.id, "agent_run", context.runId, "baseline");
        this.workspace.db.prepare(
          `INSERT INTO agent_run_files(
             run_id, file_id, baseline_path, baseline_hash, baseline_object_id
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(context.runId, file.id, file.relative_path, object.sha256, object.id);
        completed += 1;
        reporter?.emit("snapshotting", completed, files.length, "files");
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
      await this.pruneAuditHistory();
      return;
    }
    await this.captureFinalState(runId);
    this.writeRuns.delete(runId);
    this.workspace.db.prepare(
      `UPDATE agent_runs SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE run_id = ?`,
    ).run(status, runId);
    await this.pruneAuditHistory();
  }

  /**
   * Retain at least the newest 100 finished runs and every run from the last
   * 90 days. Older baselines lose their references and are reclaimed only by
   * the object store's reachability collector, so shared file versions and
   * trash recovery objects can never be deleted by this policy.
   */
  async pruneAuditHistory(
    retainRuns = AGENT_AUDIT_RETAIN_RUNS,
    retainDays = AGENT_AUDIT_RETAIN_DAYS,
  ): Promise<number> {
    const count = Math.max(1, Math.floor(retainRuns));
    const days = Math.max(1, Math.floor(retainDays));
    const rows = this.workspace.db.prepare(
      `SELECT run_id FROM agent_runs
       WHERE completed_at IS NOT NULL
         AND status NOT IN ('preparing', 'running')
         AND completed_at < datetime('now', ?)
       ORDER BY completed_at DESC, rowid DESC
       LIMIT -1 OFFSET ?`,
    ).all(`-${days} days`, count) as Array<{ run_id: string }>;
    if (rows.length === 0) return 0;
    this.workspace.db.transaction(() => {
      for (const row of rows) {
        this.workspace.db.prepare(
          "DELETE FROM content_object_refs WHERE owner_type = 'agent_run' AND owner_id = ?",
        ).run(row.run_id);
        this.workspace.db.prepare("DELETE FROM agent_run_files WHERE run_id = ?").run(row.run_id);
        this.workspace.db.prepare("DELETE FROM agent_runs WHERE run_id = ?").run(row.run_id);
      }
    })();
    await this.workspace.objects.collectGarbage();
    return rows.length;
  }

  /** Reconcile and persist a reviewable, idempotent change set. */
  async captureFinalState(runId: string): Promise<RunChangeSummary> {
    const run = this.workspace.db.prepare(
      "SELECT write_enabled, baseline_completed FROM agent_runs WHERE run_id = ?",
    ).get(runId) as { write_enabled: number; baseline_completed: number } | undefined;
    if (run?.write_enabled !== 1 || run.baseline_completed !== 1) {
      return { changedPaths: [], changedFiles: [], count: 0 };
    }
    await this.workspace.reconcile();
    // A terminal harness event is not final until changed normal files have a
    // hash-matched extraction/search state. Failed extraction is recorded per
    // file and does not damage or roll back the user's file.
    await this.reindexChanged();
    const baseline = this.workspace.db.prepare(
      `SELECT file_id, baseline_path, baseline_hash FROM agent_run_files
       WHERE run_id = ? AND baseline_object_id IS NOT NULL`,
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
      `SELECT file_id, coalesce(final_path, baseline_path) AS path, change_type
       FROM agent_run_files
       WHERE run_id = ? AND change_type IN ('created', 'modified', 'moved', 'deleted')
       ORDER BY path`,
    ).all(runId) as Array<{
      file_id: string;
      path: string;
      change_type: "created" | "modified" | "moved" | "deleted";
    }>;
    return {
      changedPaths: changes.map((row) => row.path),
      changedFiles: changes.map((row) => ({
        fileId: row.file_id,
        relativePath: row.path,
        change: row.change_type,
      })),
      count: changes.length,
    };
  }

  async rollback(runId: string): Promise<RollbackResult> {
    const run = this.workspace.db.prepare(
      "SELECT baseline_completed, write_enabled FROM agent_runs WHERE run_id = ?",
    ).get(runId) as { baseline_completed: number; write_enabled: number } | undefined;
    if (run?.baseline_completed !== 1 || run.write_enabled !== 1) {
      throw new Error("This run has no complete rollback baseline.");
    }
    this.workspace.db.prepare("UPDATE agent_run_files SET rollback_state = NULL WHERE run_id = ?").run(runId);
    const rows = this.workspace.db.prepare(
      `SELECT file_id, baseline_path, baseline_hash, baseline_object_id, final_path, final_hash,
              rollback_state
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
          this.setRollbackState(runId, row.file_id, "removed");
        } else {
          result.conflicts.push(row.final_path);
          this.setRollbackState(runId, row.file_id, "conflict");
        }
        continue;
      }

      const baselinePath = resolveWorkspacePath(this.workspace.rootPath, row.baseline_path);
      if (row.final_path !== null) {
        const finalPath = resolveWorkspacePath(this.workspace.rootPath, row.final_path);
        if (existsSync(finalPath)) {
          const currentHash = await sha256File(finalPath);
          if (row.final_hash === null || currentHash !== row.final_hash) {
            result.conflicts.push(row.final_path);
            this.setRollbackState(runId, row.file_id, "conflict");
            continue;
          }
          if (finalPath !== baselinePath) await rm(finalPath);
        }
      }
      if (existsSync(baselinePath)) {
        const currentHash = await sha256File(baselinePath);
        if (row.final_path !== row.baseline_path && currentHash !== row.baseline_hash) {
          result.conflicts.push(row.baseline_path);
          this.setRollbackState(runId, row.file_id, "conflict");
          continue;
        }
      }
      await this.workspace.objects.restoreTo(row.baseline_object_id, baselinePath);
      result.restored.push(row.baseline_path);
      this.setRollbackState(runId, row.file_id, "restored");
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
      `SELECT file_id, baseline_path, final_path, baseline_object_id
       FROM agent_run_files WHERE run_id = ? AND baseline_object_id IS NOT NULL`,
    ).all(runId) as Array<{
      file_id: string;
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
      this.workspace.db.prepare(
        `UPDATE agent_run_files SET rollback_state = 'copied'
         WHERE run_id = ? AND file_id = ?`,
      ).run(runId, row.file_id);
    }
    const remaining = this.workspace.db.prepare(
      "SELECT count(*) AS n FROM agent_run_files WHERE run_id = ? AND rollback_state = 'conflict'",
    ).get(runId) as { n: number };
    if (remaining.n === 0) {
      this.workspace.db.prepare(
        "UPDATE agent_runs SET rollback_status = 'completed' WHERE run_id = ?",
      ).run(runId);
    }
    return restored;
  }

  recordHarness(runId: string, harness: string): void {
    this.workspace.db.prepare("UPDATE agent_runs SET harness = ? WHERE run_id = ?").run(harness, runId);
  }

  /** Recover process-local statuses, then return the encrypted durable audit. */
  async listHistory(
    activeRunIds: readonly string[] = [],
    recoverStale = true,
  ): Promise<HarnessHistoryRun[]> {
    const active = new Set(activeRunIds);
    const stale = recoverStale ? this.workspace.db.prepare(
      `SELECT run_id, write_enabled, baseline_completed FROM agent_runs
       WHERE status IN ('preparing', 'running')`,
    ).all() as Array<{ run_id: string; write_enabled: number; baseline_completed: number }> : [];
    for (const row of stale) {
      if (active.has(row.run_id)) continue;
      if (row.write_enabled === 1 && row.baseline_completed === 1) {
        // A process crash cannot emit final provider events. Capture the
        // filesystem as found now so rollback keeps the same optimistic hash
        // safety it has for normally completed runs.
        await this.captureFinalState(row.run_id).catch(() => undefined);
      }
      this.workspace.db.prepare(
        `UPDATE agent_runs SET status = 'interrupted',
           completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         WHERE run_id = ? AND status IN ('preparing', 'running')`,
      ).run(row.run_id);
    }

    const runs = this.workspace.db.prepare(
      `SELECT run_id, provider, harness, model, privacy_mode, status,
              write_enabled, baseline_completed, rollback_status,
              started_at, completed_at
       FROM agent_runs
       ORDER BY started_at DESC, rowid DESC
       LIMIT ?`,
    ).all(AGENT_AUDIT_RETAIN_RUNS) as Array<{
      run_id: string;
      provider: string;
      harness: string;
      model: string;
      privacy_mode: HarnessHistoryRun["privacyMode"];
      status: string;
      write_enabled: number;
      baseline_completed: number;
      rollback_status: string;
      started_at: string;
      completed_at: string | null;
    }>;
    const fileRows = this.workspace.db.prepare(
      `SELECT file_id, coalesce(final_path, baseline_path) AS relative_path,
              change_type, rollback_state
       FROM agent_run_files
       WHERE run_id = ? AND change_type IN ('created', 'modified', 'moved', 'deleted')
       ORDER BY relative_path`,
    );
    return runs.map((run) => ({
      runId: run.run_id,
      provider: run.provider,
      harness: run.harness,
      model: run.model,
      privacyMode: run.privacy_mode,
      status: run.status,
      writeEnabled: run.write_enabled === 1,
      baselineCompleted: run.baseline_completed === 1,
      rollbackStatus: run.rollback_status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      changes: (fileRows.all(run.run_id) as Array<{
        file_id: string;
        relative_path: string;
        change_type: string;
        rollback_state: string | null;
      }>).map((file) => ({
        fileId: file.file_id,
        relativePath: file.relative_path,
        change: file.change_type,
        rollbackState: file.rollback_state,
      })),
    }));
  }

  private setRollbackState(runId: string, fileId: string, state: string): void {
    this.workspace.db.prepare(
      "UPDATE agent_run_files SET rollback_state = ? WHERE run_id = ? AND file_id = ?",
    ).run(state, runId, fileId);
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
