import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { RunProtection } from "./runProtection.js";
import type { HarnessContext } from "./types.js";
import type { WorkspaceOperationProgressEvent } from "../../shared/workspaceProgress.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RunProtection conflict recovery", () => {
  it("recovers a stale write run into durable history and rolls it back after restart", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-history-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const source = path.join(parent, "source.txt");
    await writeFile(source, "before agent", "utf8");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      await workspace.importFile(source, "notes.txt");
      const context: HarnessContext = {
        runId: "stale-run",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "gpt-test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "cloud-direct",
        writeEnabled: true,
        exposureVerified: true,
      };
      const firstProcess = new RunProtection(workspace, descriptor.roomId);
      await firstProcess.createBaseline(context);
      firstProcess.recordHarness(context.runId, "legacy-cli");
      await writeFile(path.join(workspaceRoot, "notes.txt"), "agent edit", "utf8");

      const restarted = new RunProtection(workspace, descriptor.roomId);
      expect((await restarted.listHistory([], false))[0]?.status).toBe("running");
      const history = await restarted.listHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        runId: "stale-run",
        provider: "codex",
        harness: "legacy-cli",
        model: "gpt-test",
        privacyMode: "cloud-direct",
        status: "interrupted",
        writeEnabled: true,
        baselineCompleted: true,
        rollbackStatus: "none",
        changes: [{ relativePath: "notes.txt", change: "modified", rollbackState: null }],
      });

      await expect(restarted.rollback(context.runId)).resolves.toMatchObject({
        restored: ["notes.txt"], conflicts: [],
      });
      expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("before agent");
      expect((await restarted.listHistory())[0]).toMatchObject({
        status: "rolled_back", rollbackStatus: "completed",
        changes: [{ rollbackState: "restored" }],
      });
    } finally {
      db.close();
    }
  });

  it("retains recent audit history and prunes only old runs beyond the count floor", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-retention-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const insert = db.prepare(
        `INSERT INTO agent_runs(
           run_id, room_id, provider, harness, model, privacy_mode, status,
           baseline_completed, started_at, completed_at
         ) VALUES (?, ?, 'codex', 'codex-app-server', 'test', 'local', ?, 1,
           datetime('now', ?), datetime('now', ?))`,
      );
      insert.run("old-1", descriptor.roomId, "completed", "-140 days", "-140 days");
      insert.run("old-2", descriptor.roomId, "failed", "-130 days", "-130 days");
      insert.run("old-3", descriptor.roomId, "cancelled", "-120 days", "-120 days");
      insert.run("recent", descriptor.roomId, "completed", "-5 days", "-5 days");
      db.prepare(
        `INSERT INTO agent_runs(run_id, room_id, provider, harness, model, privacy_mode, status)
         VALUES ('active', ?, 'codex', 'codex-app-server', 'test', 'local', 'running')`,
      ).run(descriptor.roomId);

      const protection = new RunProtection(workspace, descriptor.roomId);
      expect(await protection.pruneAuditHistory(1, 90)).toBe(2);
      const remaining = (db.prepare("SELECT run_id FROM agent_runs ORDER BY run_id").all() as Array<{ run_id: string }>)
        .map((row) => row.run_id);
      expect(remaining).toEqual(["active", "old-3", "recent"]);
    } finally {
      db.close();
    }
  });

  it("restores a protected baseline as a copy without overwriting a later user edit", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-protection-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const source = path.join(parent, "source.txt");
    await writeFile(source, "before agent", "utf8");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const file = await workspace.importFile(source, "notes.txt");
      const progress: WorkspaceOperationProgressEvent[] = [];
      const protection = new RunProtection(
        workspace,
        descriptor.roomId,
        async () => undefined,
        (event) => progress.push(event),
      );
      const context: HarnessContext = {
        runId: "run-1",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "local",
        writeEnabled: true,
        exposureVerified: true,
      };
      await protection.createBaseline(context);
      expect(progress.filter((event) => event.phase === "snapshotting").map((event) => event.completed))
        .toEqual([0, 1]);
      expect(progress.at(-1)).toMatchObject({
        operationId: "run-1", operation: "write-baseline", phase: "completed", status: "completed",
      });
      await workspace.writeAtomic(file.fileId, Readable.from(["agent edit"]));
      await protection.finish(context.runId, "completed");

      await writeFile(path.join(workspaceRoot, "notes.txt"), "later user edit", "utf8");
      // New instance = new app process. Neither operation may depend on the
      // old in-memory writeRuns/orchestrator state.
      const restarted = new RunProtection(workspace, descriptor.roomId);
      const rollback = await restarted.rollback(context.runId);
      expect(rollback.conflicts).toEqual(["notes.txt"]);
      expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("later user edit");

      const secondRestart = new RunProtection(workspace, descriptor.roomId);
      const copies = await secondRestart.restoreBaselineAsCopies(context.runId, rollback.conflicts);
      expect(copies).toEqual(["notes (baseline).txt"]);
      expect(await readFile(path.join(workspaceRoot, copies[0]!), "utf8")).toBe("before agent");
      expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("later user edit");
      const copyRow = db.prepare(
        "SELECT original_bytes, source, relative_path FROM files WHERE relative_path = ?",
      ).get(copies[0]) as { original_bytes: Buffer | null; source: string; relative_path: string };
      expect(copyRow).toEqual({
        original_bytes: null,
        source: "rollback-copy",
        relative_path: "notes (baseline).txt",
      });
      expect((await secondRestart.listHistory())[0]?.rollbackStatus).toBe("completed");
    } finally {
      db.close();
    }
  });
});
