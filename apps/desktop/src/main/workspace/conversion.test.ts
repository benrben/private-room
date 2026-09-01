import { chmod, mkdtemp, open as openFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("../db-host/open.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-host/open.js")>();
  return { ...actual, openRoom: vi.fn(actual.openRoom) };
});
import { insertFile } from "../db-host/files.js";
import { setRecMeta } from "../db-host/recordings.js";
import { createFolder, moveFileToFolder } from "../db-host/folders.js";
import { setMeta } from "../db-host/meta.js";
import { createRoom, openRoom, openRoomReadonly } from "../db-host/open.js";
import { createRoomManagerState } from "../roomManager.js";
import { HarnessController, type HarnessProvider } from "../harness/controller.js";
import type { HarnessContext, HarnessRun, HarnessRuntime } from "../harness/types.js";
import { sha256File } from "./hash.js";
import { openWorkspaceRoom } from "./roomLayout.js";
import { convertLegacyRoomToWorkspace, discardWorkspaceConversion } from "./conversion.js";
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
    // Reproduce rooms created by older builds. Conversion must not preserve
    // this loose mode into the new workspace.
    await chmod(sourcePath, 0o644);
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
    expect((await stat(path.join(destinationPath, ".arcelle", "room.db"))).mode & 0o777)
      .toBe(0o600);

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
    const resumedDb = path.join(
      root,
      ".Resumed Room.arcelle-conversion.tmp",
      ".arcelle",
      "room.db",
    );
    await chmod(resumedDb, 0o644);
    expect(progress.at(-1)).toMatchObject({
      operationId: "convert-failed", operation: "legacy-conversion", phase: "failed", status: "failed",
    });

    const report = await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);
    expect(report.resumed).toBe(true);
    expect((await stat(path.join(destinationPath, ".arcelle", "room.db"))).mode & 0o777)
      .toBe(0o600);
    expect(report.convertedFiles).toBe(2);
    expect(await readFile(path.join(destinationPath, "one.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(destinationPath, "two.txt"), "utf8")).toBe("two");
    expect(await sha256File(sourcePath)).toBe(sourceHash);
  });

  it("records legacy rows without current bytes as skipped while publishing the empty workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-missing-bytes-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Missing Bytes Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const missing = insertFile(legacy, "gone.txt", "text/plain", Buffer.from("gone"), null, "upload");
    legacy.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(missing.id);
    legacy.close();

    const report = await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);

    expect(report.convertedFiles).toBe(0);
    expect(report.skipped).toEqual([{
      fileId: missing.id,
      name: "gone.txt",
      reason: "This legacy row has no current file bytes.",
    }]);
    expect((await stat(path.join(destinationPath, ".arcelle", "room.db"))).isFile()).toBe(true);
  });

  it("does not publish when validation finds an exported normal file missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-validate-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Validation Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    const tempRoot = path.join(root, ".Validation Room.arcelle-conversion.tmp");

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: async () => rm(path.join(tempRoot, "notes.txt"), { force: true }),
    })).rejects.toThrow("Conversion validation found 0 files but expected 1.");

    await expect(stat(destinationPath)).rejects.toThrow();
    expect((await stat(path.join(tempRoot, ".arcelle", "room.db"))).isFile()).toBe(true);
  });

  it("rejects a source that changes after the conversion copy was opened, before publishing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-source-change-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Changed Source Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: async () => writeFile(sourcePath, "source changed after copy", "utf8"),
    })).rejects.toThrow("The legacy source changed during conversion. The workspace was not published.");

    await expect(stat(destinationPath)).rejects.toThrow();
  });

  it("keeps the resumable temp workspace when a close reports an error after publication is refused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-close-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Close Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    const actualOpen = vi.mocked(openRoom).getMockImplementation();
    expect(actualOpen).toBeDefined();
    vi.mocked(openRoom).mockImplementation((filePath, roomPassword) => {
      const db = actualOpen!(filePath, roomPassword);
      let closeCount = 0;
      return new Proxy(db, {
        get(target, property) {
          if (property === "close") {
            return () => {
              closeCount += 1;
              if (closeCount > 1) throw new Error("simulated close failure");
              return target.close();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    try {
      await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
        afterFile: async () => writeFile(sourcePath, "source changed after copy", "utf8"),
      })).rejects.toThrow("The legacy source changed during conversion. The workspace was not published.");
      await expect(stat(destinationPath)).rejects.toThrow();
    } finally {
      vi.mocked(openRoom).mockImplementation(actualOpen!);
    }
  });

  it("keeps destination preflight refusal order and rejects sealed backups before creating a temp workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-preflight-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Destination");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    legacy.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, sourcePath)).rejects.toThrow(
      "Choose a different destination folder for the workspace.",
    );
    await writeFile(destinationPath, "already occupied", "utf8");
    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).rejects.toThrow(
      "A file or folder already exists at the destination.",
    );
    await rm(destinationPath);

    const sealed = openRoom(sourcePath, password);
    sealed.exec("CREATE TABLE sealed_package_meta (id TEXT)");
    sealed.close();
    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).rejects.toThrow(
      "This is a sealed backup. Use sealed import instead of legacy conversion.",
    );
    await expect(stat(path.join(root, ".Destination.arcelle-conversion.tmp"))).rejects.toThrow();
  });

  it("rejects a damaged persisted report when resuming, leaving its temp workspace for recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-report-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Report Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: () => { throw new Error("pause after commit"); },
    })).rejects.toThrow("pause after commit");
    const tempDb = path.join(root, ".Report Room.arcelle-conversion.tmp", ".arcelle", "room.db");
    const resumed = openRoom(tempDb, password);
    setMeta(resumed, "workspace_conversion_report", "{damaged");
    resumed.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).rejects.toThrow(
      "The saved workspace conversion report is damaged.",
    );
    expect((await stat(tempDb)).isFile()).toBe(true);
  });

  it("refuses to resume a temp workspace created from a different legacy source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-resume-source-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const replacementPath = path.join(root, "Replacement.roomai");
    const destinationPath = path.join(root, "Resume Source Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: () => { throw new Error("pause after commit"); },
    })).rejects.toThrow("pause after commit");

    const replacement = createRoom(replacementPath, password, "Replacement");
    insertFile(replacement, "replacement.txt", "text/plain", Buffer.from("changed"), "changed", "upload");
    replacement.close();
    await rename(replacementPath, sourcePath);

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).rejects.toThrow(
      "The legacy source changed after this conversion started. Remove the temporary conversion and try again.",
    );
  });

  it("re-exports an existing normal file when a crashed conversion left its BLOB row pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-reexport-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Re-export Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const file = insertFile(legacy, "notes.txt", "text/plain", Buffer.from("source bytes"), "notes", "upload");
    legacy.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: () => { throw new Error("pause after commit"); },
    })).rejects.toThrow("pause after commit");
    const tempRoot = path.join(root, ".Re-export Room.arcelle-conversion.tmp");
    const resumed = openRoom(path.join(tempRoot, ".arcelle", "room.db"), password);
    resumed.prepare("UPDATE files SET storage_kind = 'blob', original_bytes = ? WHERE id = ?")
      .run(Buffer.from("re-exported bytes"), file.id);
    resumed.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).resolves.toMatchObject({
      resumed: true,
      convertedFiles: 1,
    });
    expect(await readFile(path.join(destinationPath, "notes.txt"), "utf8")).toBe("re-exported bytes");
  });

  it("detects a same-sized normal-file hash mismatch during validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-hash-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Hash Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    const tempRoot = path.join(root, ".Hash Room.arcelle-conversion.tmp");

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: async () => writeFile(path.join(tempRoot, "notes.txt"), "other", "utf8"),
    })).rejects.toThrow("Conversion validation failed for file");
  });

  it("refuses publication while a live legacy blob remains in the copied database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-live-blob-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Live Blob Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const file = insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    const tempRoot = path.join(root, ".Live Blob Room.arcelle-conversion.tmp");

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: async () => {
        const copied = openRoom(path.join(tempRoot, ".arcelle", "room.db"), password);
        copied.prepare("UPDATE files SET storage_kind = 'blob', original_bytes = ? WHERE id = ?")
          .run(Buffer.from("notes"), file.id);
        copied.close();
        await rm(path.join(tempRoot, "notes.txt"));
      },
    })).rejects.toThrow(
      "Conversion validation found live file bytes still stored in SQLCipher.",
    );
    await expect(stat(destinationPath)).rejects.toThrow();
  });

  it("reports a useful error instead of reusing more than ten thousand colliding paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-collision-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Collision Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    const originalHas = Set.prototype.has;
    const collisions = vi.spyOn(Set.prototype, "has").mockImplementation(function (value) {
      const allocatorCall = new Error().stack?.includes("availableRelativePath") === true;
      return allocatorCall ? true : originalHas.call(this, value);
    });

    try {
      await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).rejects.toThrow(
        "Could not create a unique workspace path for notes.txt.",
      );
    } finally {
      collisions.mockRestore();
    }
  });

  it("treats directory fsync refusal as nonfatal because validation still protects publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-sync-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Sync Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();
    const actualOpen = vi.mocked(openFile).getMockImplementation();
    expect(actualOpen).toBeDefined();
    vi.mocked(openFile).mockImplementation(async (...args) => {
      if (args[1] === "r") {
        throw new Error("simulated filesystem does not support directory sync");
      }
      return actualOpen!(...args);
    });

    try {
      await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath)).resolves.toMatchObject({
        convertedFiles: 1,
      });
    } finally {
      vi.mocked(openFile).mockImplementation(actualOpen!);
    }
  });

  it("removes an abandoned resumable conversion root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-discard-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Discard Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "notes.txt", "text/plain", Buffer.from("notes"), "notes", "upload");
    legacy.close();

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: () => { throw new Error("pause after commit"); },
    })).rejects.toThrow("pause after commit");
    const tempRoot = path.join(root, ".Discard Room.arcelle-conversion.tmp");
    expect((await stat(tempRoot)).isDirectory()).toBe(true);
    await discardWorkspaceConversion(destinationPath);
    await expect(stat(tempRoot)).rejects.toThrow();
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
