import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertFile } from "../db-host/files.js";
import { setRecMeta } from "../db-host/recordings.js";
import { createFolder, moveFileToFolder } from "../db-host/folders.js";
import { setMeta } from "../db-host/meta.js";
import { createRoom, openRoomReadonly } from "../db-host/open.js";
import { createRoomManagerState } from "../roomManager.js";
import { HarnessController, type HarnessProvider } from "../harness/controller.js";
import type { HarnessContext, HarnessRun, HarnessRuntime } from "../harness/types.js";
import { sha256File } from "./hash.js";
import { openWorkspaceRoom } from "./roomLayout.js";
import { convertLegacyRoomToWorkspace } from "./conversion.js";
import { createWorkspaceMcpBridge } from "./workspaceMcp.js";
import { WorkspaceService } from "./workspaceService.js";
import { audioPeaksForRoom, createPeakCache } from "../peaksTools.js";
import { encodeWav } from "../recFormat.js";
import type { WorkspaceOperationProgressEvent } from "../../shared/workspaceProgress.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy workspace conversion", () => {
  it("keeps a converted recording playable and draws peaks from its normal file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-recording-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Converted Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const wav = encodeWav(new Float32Array(1_600).fill(0.4));
    const recording = insertFile(
      legacy,
      "meeting.wav",
      "audio/wav",
      wav,
      "[00:00] Speaker 1: converted recording",
      "recording",
    );
    setRecMeta(legacy, recording.id, JSON.stringify({ durationCs: 10, segments: [] }));
    legacy.close();

    await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);
    const converted = openWorkspaceRoom(destinationPath, password);
    const workspace = new WorkspaceService(converted.db, destinationPath);
    try {
      const peaks = await audioPeaksForRoom(
        { db: converted.db, path: destinationPath, workspace },
        createPeakCache(),
        recording.id,
        64,
      );
      expect(peaks.peaks).toHaveLength(64);
      expect(peaks.silent).toBe(false);
      expect(peaks.duration).toBeCloseTo(0.1, 3);
      expect(await readFile(path.join(destinationPath, "meeting.wav"))).toEqual(wav);
      expect(converted.db.prepare(
        "SELECT storage_kind, original_bytes FROM files WHERE id = ?",
      ).get(recording.id)).toEqual({ storage_kind: "workspace", original_bytes: null });
      expect(converted.db.prepare(
        "SELECT json_extract(meta, '$.durationCs') AS duration FROM recordings WHERE file_id = ?",
      ).get(recording.id)).toEqual({ duration: 10 });
    } finally {
      converted.db.close();
    }
  });

  it("exports normal files, preserves private state and leaves the source unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Converted Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const folder = createFolder(legacy, "Research");
    const first = insertFile(
      legacy,
      "notes?.txt",
      "text/plain",
      Buffer.from("first bytes"),
      "first extracted text",
      "upload",
    );
    moveFileToFolder(legacy, first.id, folder.id);
    const second = insertFile(
      legacy,
      "notes*.txt",
      "text/plain",
      Buffer.from("second bytes"),
      "second extracted text",
      "generated",
    );
    moveFileToFolder(legacy, second.id, folder.id);
    setMeta(legacy, "private_test_state", "kept");
    legacy.close();
    const sourceHashBefore = await sha256File(sourcePath);

    const progress: WorkspaceOperationProgressEvent[] = [];
    const report = await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      operationId: "convert-1",
      progress: (event) => progress.push(event),
    });

    expect(report.convertedFiles).toBe(2);
    expect(report.renamed).toHaveLength(2);
    expect(report.skipped).toEqual([]);
    expect(progress[0]).toMatchObject({
      operationId: "convert-1", operation: "legacy-conversion", phase: "preparing", status: "started",
    });
    expect(progress.filter((event) => event.phase === "copying-files").map((event) => event.completed))
      .toEqual([0, 1, 2]);
    expect(progress.at(-1)).toMatchObject({ phase: "completed", status: "completed" });
    expect(await sha256File(sourcePath)).toBe(sourceHashBefore);
    expect(await readFile(path.join(destinationPath, "Research", "notes_.txt"), "utf8"))
      .toBe("first bytes");
    expect(await readFile(path.join(destinationPath, "Research", "notes_ (2).txt"), "utf8"))
      .toBe("second bytes");

    const workspace = openWorkspaceRoom(destinationPath, password);
    try {
      const rows = workspace.db.prepare(
        `SELECT id, original_bytes, storage_kind, relative_path, extracted_text
         FROM files ORDER BY rowid`,
      ).all() as Array<{
        id: string;
        original_bytes: Buffer | null;
        storage_kind: string;
        relative_path: string;
        extracted_text: string;
      }>;
      expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(rows.every((row) => row.original_bytes === null)).toBe(true);
      expect(rows.every((row) => row.storage_kind === "workspace")).toBe(true);
      expect(rows.map((row) => row.extracted_text)).toEqual([
        "first extracted text",
        "second extracted text",
      ]);
      expect(workspace.db.prepare("SELECT value FROM meta WHERE key = 'private_test_state'").pluck().get())
        .toBe("kept");
    } finally {
      workspace.db.close();
    }

    const source = openRoomReadonly(sourcePath, password);
    try {
      const sourceRows = source.prepare("SELECT id, original_bytes FROM files ORDER BY rowid")
        .all() as Array<{ id: string; original_bytes: Buffer }>;
      expect(sourceRows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(sourceRows.map((row) => row.original_bytes.toString("utf8"))).toEqual([
        "first bytes",
        "second bytes",
      ]);
    } finally {
      source.close();
    }
  });

  it("resumes after a file was exported and committed before interruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-resume-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Resumed Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "one.txt", "text/plain", Buffer.from("one"), "one", "upload");
    insertFile(legacy, "two.txt", "text/plain", Buffer.from("two"), "two", "upload");
    legacy.close();
    const sourceHash = await sha256File(sourcePath);
    let exported = 0;
    const progress: WorkspaceOperationProgressEvent[] = [];

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      operationId: "convert-failed",
      progress: (event) => progress.push(event),
      afterFile: () => {
        exported += 1;
        if (exported === 1) throw new Error("simulated interruption");
      },
    })).rejects.toThrow(/simulated interruption/);
    expect(progress.at(-1)).toMatchObject({
      operationId: "convert-failed", operation: "legacy-conversion", phase: "failed", status: "failed",
    });

    const report = await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);
    expect(report.resumed).toBe(true);
    expect(report.convertedFiles).toBe(2);
    expect(await readFile(path.join(destinationPath, "one.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(destinationPath, "two.txt"), "utf8")).toBe("two");
    expect(await sha256File(sourcePath)).toBe(sourceHash);
  });

  it("opens converted files to native and Deep agent tools with rollback and no live blobs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-harness-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Converted Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const original = insertFile(
      legacy,
      "notes.txt",
      "text/plain",
      Buffer.from("converted baseline"),
      "converted baseline",
      "upload",
    );
    legacy.close();
    await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);

    const opened = openWorkspaceRoom(destinationPath, password);
    const workspace = new WorkspaceService(opened.db, destinationPath);
    const state = createRoomManagerState();
    state.room = {
      conn: opened.db,
      path: destinationPath,
      name: "Converted Room",
      password,
      descriptor: opened.descriptor,
      workspace,
    };
    let terminal: ((runId: string) => void) | null = null;
    const nativeRuntime: HarnessRuntime = {
      name: "claude-agent-sdk",
      available: async () => true,
      startTurn: async (context: HarnessContext): Promise<HarnessRun> => {
        const target = path.join(context.workspacePath, "notes.txt");
        const current = await readFile(target, "utf8");
        await writeFile(target, `${current}\n${context.provider} own file tool`, "utf8");
        async function* events() {
          yield { type: "run_started", runId: context.runId, harness: "claude-agent-sdk" } as const;
          yield { type: "run_completed", runId: context.runId, status: "completed" } as const;
        }
        return { events: events(), cancel: async () => undefined, approve: async () => undefined };
      },
    };
    const controller = new HarnessController(state, root, (event, payload) => {
      if (event !== "harness-event") return;
      const row = payload as { type?: string; runId?: string };
      if ((row.type === "run_completed" || row.type === "run_failed") && row.runId) terminal?.(row.runId);
    }, {
      runtimes: {
        codex: nativeRuntime,
        claude: nativeRuntime,
        "ollama-local": nativeRuntime,
        "ollama-cloud": nativeRuntime,
        openrouter: nativeRuntime,
      },
      flag: () => true,
      outsideWorkspaceIsolation: true,
      verifyExposure: async () => true,
    });

    try {
      for (const provider of ["codex", "claude"] satisfies HarnessProvider[]) {
        const completed = new Promise<string>((resolve) => { terminal = resolve; });
        const runId = await controller.start({
          provider,
          model: "installed-test-model",
          privacyMode: "cloud-direct",
          writeEnabled: true,
          text: "Use your own file tool to update notes.txt.",
        });
        await expect(completed).resolves.toBe(runId);
        expect(await readFile(path.join(destinationPath, "notes.txt"), "utf8"))
          .toContain(`${provider} own file tool`);
        await expect(controller.rollback(runId)).resolves.toMatchObject({ conflicts: [] });
        expect(await readFile(path.join(destinationPath, "notes.txt"), "utf8"))
          .toBe("converted baseline");
      }

      const deepFiles = createWorkspaceMcpBridge(state, true);
      expect(await deepFiles.call("read", { path: "/notes.txt", offset: 0, limit: 100 }))
        .toMatchObject({ file_data: { content: "converted baseline" } });
      expect(await deepFiles.call("edit", {
        path: "/notes.txt",
        old_string: "converted baseline",
        new_string: "converted by Deep file tools",
      })).toMatchObject({ occurrences: 1 });
      expect(await readFile(path.join(destinationPath, "notes.txt"), "utf8"))
        .toBe("converted by Deep file tools");

      const row = opened.db.prepare(
        "SELECT id, storage_kind, relative_path, original_bytes FROM files WHERE id = ?",
      ).get(original.id) as {
        id: string;
        storage_kind: string;
        relative_path: string;
        original_bytes: Buffer | null;
      };
      expect(row).toMatchObject({
        id: original.id,
        storage_kind: "workspace",
        relative_path: "notes.txt",
        original_bytes: null,
      });
    } finally {
      await controller.stopAll();
      opened.db.close();
    }
  });
});
