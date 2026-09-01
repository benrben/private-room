import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("does not record a final change set for a read-only run", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-read-only-run-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const context: HarnessContext = {
        runId: "read-only-run",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "gpt-test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "local",
        writeEnabled: false,
        exposureVerified: true,
      };
      const protection = new RunProtection(workspace, descriptor.roomId);
      await protection.createBaseline(context);

      await workspace.createFile("untracked.txt", Readable.from(["created later"]), "agent");

      await expect(protection.captureFinalState(context.runId)).resolves.toEqual({
        changedPaths: [], changedFiles: [], count: 0,
      });
      await protection.finish(context.runId, "completed");
      await expect(protection.rollback(context.runId))
        .rejects.toThrow("This run has no complete rollback baseline.");
    } finally {
      db.close();
    }
  });

  it("keeps every change classification stable across repeated capture and finalization", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-idempotency-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const modified = await workspace.createFile(
        "modified.txt", Readable.from(["before modified"]), "import",
      );
      const moved = await workspace.createFile(
        "moved.txt", Readable.from(["before moved"]), "import",
      );
      const deleted = await workspace.createFile(
        "deleted.txt", Readable.from(["before deleted"]), "import",
      );
      const context: HarnessContext = {
        runId: "repeat-capture-run",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "gpt-test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "local",
        writeEnabled: true,
        exposureVerified: true,
      };
      const protection = new RunProtection(workspace, descriptor.roomId);
      await protection.createBaseline(context);

      await workspace.writeAtomic(modified.fileId, Readable.from(["after modified"]));
      await workspace.move(moved.fileId, "Archive/moved.txt");
      await workspace.trash(deleted.fileId);
      await workspace.createFile(
        "created.bin", Readable.from([Buffer.from([0x00, 0xff, 0x41])]), "agent",
      );

      const expected = [
        { relativePath: "Archive/moved.txt", change: "moved" },
        { relativePath: "created.bin", change: "created" },
        { relativePath: "deleted.txt", change: "deleted" },
        { relativePath: "modified.txt", change: "modified" },
      ];
      const first = await protection.captureFinalState(context.runId);
      const second = await protection.captureFinalState(context.runId);
      expect(first.changedFiles.map(({ relativePath, change }) => ({ relativePath, change })))
        .toEqual(expected);
      expect(second.changedFiles.map(({ relativePath, change }) => ({ relativePath, change })))
        .toEqual(expected);

      // finish() captures once more. A later history refresh may also capture
      // again, so prove both paths leave the durable classifications intact.
      await protection.finish(context.runId, "completed");
      const afterFinish = await protection.captureFinalState(context.runId);
      expect(afterFinish.changedFiles.map(({ relativePath, change }) => ({ relativePath, change })))
        .toEqual(expected);
      expect((await protection.listHistory())[0]?.changes.map(
        ({ relativePath, change }) => ({ relativePath, change }),
      )).toEqual(expected);
    } finally {
      db.close();
    }
  });

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

  it("removes an unchanged file created by a completed write run", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-created-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const context: HarnessContext = {
        runId: "created-run",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "gpt-test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "local",
        writeEnabled: true,
        exposureVerified: true,
      };
      const protection = new RunProtection(workspace, descriptor.roomId);
      await protection.createBaseline(context);
      await workspace.createFile("created.txt", Readable.from(["agent output"]), "agent");
      await protection.finish(context.runId, "completed");

      const rollback = await new RunProtection(workspace, descriptor.roomId).rollback(context.runId);
      expect(rollback).toEqual({ restored: [], removedCreated: ["created.txt"], conflicts: [] });
      expect(existsSync(path.join(workspaceRoot, "created.txt"))).toBe(false);
      expect((await protection.listHistory())[0]).toMatchObject({
        rollbackStatus: "completed",
        changes: [{ relativePath: "created.txt", rollbackState: "removed" }],
      });

      const changedContext = { ...context, runId: "created-conflict-run", provider: "claude" };
      const changedRun = new RunProtection(workspace, descriptor.roomId);
      await changedRun.createBaseline(changedContext);
      await workspace.createFile("changed.txt", Readable.from(["agent output"]), "agent");
      await changedRun.finish(changedContext.runId, "completed");
      await writeFile(path.join(workspaceRoot, "changed.txt"), "later user edit", "utf8");

      await expect(new RunProtection(workspace, descriptor.roomId).rollback(changedContext.runId))
        .resolves.toEqual({ restored: [], removedCreated: [], conflicts: ["changed.txt"] });
      expect(await readFile(path.join(workspaceRoot, "changed.txt"), "utf8")).toBe("later user edit");
    } finally {
      db.close();
    }
  });

  it("does not overwrite a later file at a moved baseline path", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-moved-conflict-"));
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
      const context: HarnessContext = {
        runId: "moved-conflict-run",
        roomId: descriptor.roomId,
        provider: "arcelle-deep",
        model: "gpt-test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "local",
        writeEnabled: true,
        exposureVerified: true,
      };
      const protection = new RunProtection(workspace, descriptor.roomId);
      await protection.createBaseline(context);
      await workspace.move(file.fileId, "Archive/notes.txt");
      await protection.finish(context.runId, "completed");
      await writeFile(path.join(workspaceRoot, "notes.txt"), "later user edit", "utf8");

      await expect(new RunProtection(workspace, descriptor.roomId).rollback(context.runId))
        .resolves.toEqual({ restored: [], removedCreated: [], conflicts: ["notes.txt"] });
      expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("later user edit");
    } finally {
      db.close();
    }
  });

  it("reports when no baseline-copy filename is available", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-copy-name-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const protection = new RunProtection(
        workspace,
        descriptor.roomId,
        async () => undefined,
        undefined,
        () => true,
      );
      const finder = protection as unknown as { availableBaselineCopyPath(relativePath: string): string };
      expect(() => finder.availableBaselineCopyPath("notes.txt"))
        .toThrow("Could not find an available name for the baseline copy.");
    } finally {
      db.close();
    }
  });

  it("marks a failed baseline snapshot as failed and clears its write-run state", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-snapshot-failure-"));
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
        runId: "snapshot-failure-run",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "gpt-test",
        workspacePath: workspaceRoot,
        runtimePath: path.join(parent, "runtime"),
        privacyMode: "local",
        writeEnabled: true,
        exposureVerified: true,
      };
      vi.spyOn(workspace, "snapshot").mockRejectedValueOnce(new Error("object store unavailable"));
      const protection = new RunProtection(workspace, descriptor.roomId);

      await expect(protection.createBaseline(context))
        .rejects.toThrow("The protected write baseline could not be completed: object store unavailable");
      expect(db.prepare("SELECT status FROM agent_runs WHERE run_id = ?").get(context.runId))
        .toEqual({ status: "failed" });
      await protection.finish(context.runId, "failed");
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
      await workspace.move(file.fileId, "Archive/notes.txt");
      await workspace.writeAtomic(file.fileId, Readable.from(["agent edit"]));
      await protection.finish(context.runId, "completed");

      await writeFile(path.join(workspaceRoot, "Archive/notes.txt"), "later user edit", "utf8");
      // New instance = new app process. Neither operation may depend on the
      // old in-memory writeRuns/orchestrator state.
      const restarted = new RunProtection(workspace, descriptor.roomId);
      const rollback = await restarted.rollback(context.runId);
      expect(rollback.conflicts).toEqual(["Archive/notes.txt"]);
      expect(await readFile(path.join(workspaceRoot, "Archive/notes.txt"), "utf8")).toBe("later user edit");

      const secondRestart = new RunProtection(workspace, descriptor.roomId);
      await expect(secondRestart.restoreBaselineAsCopies(context.runId, [...rollback.conflicts, "missing.txt"]))
        .rejects.toThrow("One or more requested files do not belong to this rollback baseline.");
      const copies = await secondRestart.restoreBaselineAsCopies(context.runId, rollback.conflicts);
      expect(copies).toEqual(["notes (baseline).txt"]);
      expect(await readFile(path.join(workspaceRoot, copies[0]!), "utf8")).toBe("before agent");
      expect(await readFile(path.join(workspaceRoot, "Archive/notes.txt"), "utf8")).toBe("later user edit");
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
