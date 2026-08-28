import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { createRoomManagerState, type RoomManagerDeps } from "../roomManager.js";
import { setRecMeta } from "../db-host/recordings.js";
import { registerFileRuntimeSurfaceIpc } from "../fileRuntimeSurfaceIpc.js";
import { registerFileSurfaceIpc } from "../fileSurfaceIpc.js";
import { createDownloadEngineDeps } from "../mediaDownloadSurfaceIpc.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceContentStore } from "./contentStore.js";
import { WorkspaceService } from "./workspaceService.js";
import { createWorkspaceMcpBridge } from "./workspaceMcp.js";
import { mediaStreamingResponse } from "../mediaTools.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

async function fixture() {
  temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-content-cutover-"));
  const root = path.join(temporary, "Room");
  const created = createWorkspaceRoom(root, "correct horse battery staple", "Room");
  const workspace = new WorkspaceService(created.db, root);
  const state = createRoomManagerState();
  state.room = {
    conn: created.db,
    path: root,
    name: "Room",
    password: "correct horse battery staple",
    descriptor: created.descriptor,
    workspace,
    contentStore: new WorkspaceContentStore(workspace),
  };
  return { root, state, db: created.db, workspace };
}

function ipcHandlers(): {
  ipc: Pick<IpcMain, "handle">;
  handlers: Map<string, (...args: unknown[]) => unknown>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipc: {
      handle(channel, handler): void {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
  };
}

const event = {} as IpcMainInvokeEvent;

describe("workspace content cutover", () => {
  it("repairs and opens a database-only agent artifact as a real workspace file", async () => {
    const { root, state, db } = await fixture();
    const { ipc, handlers } = ipcHandlers();
    registerFileRuntimeSurfaceIpc(
      ipc,
      state,
      { userDataDir: temporary!, spawnRoomServerIfEnabled: () => {} },
      temporary!,
      () => {},
      { openPath: async () => {} },
    );
    const ghost = {
      id: "legacy-agent-artifact",
      name: "Uncle Bob Martin on Software Fundamentals in the Age of AI.md",
    };
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text, storage_kind)
       VALUES (?, ?, 'text/markdown', ?, 'generated', ?, ?, 'blob')`,
    ).run(
      ghost.id,
      ghost.name,
      Buffer.byteLength("# Recovered agent output\n"),
      Buffer.from("# Recovered agent output\n"),
      "# Recovered agent output\n",
    );

    try {
      const content = await handlers.get("get_file_content")!(event, { id: ghost.id }) as {
        kind: string;
        text: string | null;
      };
      expect(content).toMatchObject({ kind: "markdown", text: "# Recovered agent output\n" });
      expect(await readFile(path.join(root, ghost.name), "utf8"))
        .toBe("# Recovered agent output\n");
      expect(db.prepare(
        "SELECT storage_kind, original_bytes, relative_path FROM files WHERE id = ?",
      ).get(ghost.id)).toEqual({
        storage_kind: "workspace",
        original_bytes: null,
        relative_path: ghost.name,
      });
    } finally {
      db.close();
    }
  });

  it("adopts an interrupted blob repair at its original path and stable id", async () => {
    const { root, db, workspace } = await fixture();
    const id = "interrupted-agent-artifact";
    const name = "Recovered report.md";
    const bytes = Buffer.from("# Survived the crash\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, storage_kind)
       VALUES (?, ?, 'text/markdown', ?, 'generated', ?, 'blob')`,
    ).run(id, name, bytes.length, bytes);
    await writeFile(path.join(root, name), bytes);
    const operationId = randomUUID();
    db.prepare(
      `INSERT INTO fs_operations(
         operation_id, operation_type, phase, file_id, new_path, new_hash
       ) VALUES (?, 'repair_live_blob', 'filesystem_committed', ?, ?, ?)`,
    ).run(operationId, id, name, hash);

    try {
      expect(workspace.recoverIncompleteOperations()).toBe(1);
      await expect(workspace.materializeLiveBlobFile(id)).resolves.toBe(true);
      expect(await readFile(path.join(root, name), "utf8")).toBe(bytes.toString("utf8"));
      await expect(readFile(path.join(root, "Recovered report (2).md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(db.prepare(
        "SELECT storage_kind, original_bytes, relative_path FROM files WHERE id = ?",
      ).get(id)).toEqual({ storage_kind: "workspace", original_bytes: null, relative_path: name });
      expect(db.prepare(
        "SELECT phase FROM fs_operations WHERE operation_id = ?",
      ).get(operationId)).toEqual({ phase: "completed" });
    } finally {
      db.close();
    }
  });

  it("gives concurrent same-name ghost repairs distinct normal files", async () => {
    const { root, db, workspace } = await fixture();
    const insert = db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, storage_kind)
       VALUES (?, 'Agent report.md', 'text/markdown', ?, 'generated', ?, 'blob')`,
    );
    const first = Buffer.from("first agent output\n");
    const second = Buffer.from("second agent output\n");
    insert.run("ghost-one", first.length, first);
    insert.run("ghost-two", second.length, second);

    try {
      await Promise.all([
        workspace.materializeLiveBlobFile("ghost-one"),
        workspace.materializeLiveBlobFile("ghost-two"),
      ]);
      const rows = db.prepare(
        `SELECT id, relative_path, storage_kind, original_bytes FROM files
         WHERE id IN ('ghost-one', 'ghost-two') ORDER BY id`,
      ).all() as Array<{
        id: string;
        relative_path: string;
        storage_kind: string;
        original_bytes: Buffer | null;
      }>;
      expect(rows.map((row) => row.relative_path).sort()).toEqual([
        "Agent report (2).md",
        "Agent report.md",
      ]);
      expect(rows.every((row) => row.storage_kind === "workspace" && row.original_bytes === null)).toBe(true);
      for (const row of rows) {
        const expected = row.id === "ghost-one" ? first : second;
        expect(await readFile(path.join(root, row.relative_path))).toEqual(expected);
      }
    } finally {
      db.close();
    }
  });

  it("opens a converted sketch from its normal JSON file, not its search labels", async () => {
    const { state, db, workspace } = await fixture();
    const { ipc, handlers } = ipcHandlers();
    const stores = registerFileRuntimeSurfaceIpc(
      ipc,
      state,
      { userDataDir: temporary!, spawnRoomServerIfEnabled: () => {} },
      temporary!,
      () => {},
      { openPath: async () => {} },
    );
    const json = JSON.stringify({
      version: 1,
      width: 1600,
      height: 1000,
      seq: 1,
      elements: [{
        id: "e1", type: "rect", x: 20, y: 20, w: 120, h: 70,
        ink: "blue", label: "Real file label",
      }],
    });
    const created = await workspace.createFile(
      "Converted flow.sketch",
      Readable.from([Buffer.from(json)]),
      "migration",
    );
    db.prepare(
      "UPDATE files SET mime_type = 'application/json', extracted_text = ? WHERE id = ?",
    ).run("Real file label\n", created.fileId);

    try {
      const content = await handlers.get("get_file_content")!(event, { id: created.fileId }) as {
        kind: string;
        text: string | null;
        mediaToken: string | null;
      };
      expect(content.kind).toBe("sketch");
      expect(content.text).toBe(json);
      expect(content.text).not.toBe("Real file label\n");
      expect(content.mediaToken).toBeNull();
      expect(stores.mediaStreams.map.size).toBe(0);
    } finally {
      db.close();
    }
  });

  it("creates and decodes the scratch pad as a normal file without live blob bytes", async () => {
    const { root, state, db } = await fixture();
    const { ipc, handlers } = ipcHandlers();
    const deps: RoomManagerDeps = {
      userDataDir: temporary!,
      spawnRoomServerIfEnabled: () => {},
    };
    registerFileRuntimeSurfaceIpc(
      ipc,
      state,
      deps,
      temporary!,
      () => {},
      { openPath: async () => {} },
    );

    try {
      const meta = await handlers.get("open_scratch_pad")!(event) as { id: string };
      expect(await readFile(path.join(root, "Scratch pad.md"), "utf8")).toBe("# Scratch pad\n\n");
      const row = db.prepare(
        "SELECT storage_kind, original_bytes, extracted_text FROM files WHERE id = ?",
      ).get(meta.id) as { storage_kind: string; original_bytes: Buffer | null; extracted_text: string };
      expect(row).toEqual({
        storage_kind: "workspace",
        original_bytes: null,
        extracted_text: "# Scratch pad\n\n",
      });

      const decoded = await handlers.get("decode_file_text")!(event, { id: meta.id }) as { text: string };
      expect(decoded.text).toBe("# Scratch pad\n\n");
    } finally {
      db.close();
    }
  });

  it("streams workspace media ranges without staging the whole file in memory", async () => {
    const { state, db, workspace } = await fixture();
    const { ipc, handlers } = ipcHandlers();
    const stores = registerFileRuntimeSurfaceIpc(
      ipc,
      state,
      { userDataDir: temporary!, spawnRoomServerIfEnabled: () => {} },
      temporary!,
      () => {},
      { openPath: async () => {} },
    );
    const created = await workspace.createFile(
      "movie.mp4",
      Readable.from([Buffer.from("0123456789")]),
      "import",
    );

    try {
      const content = await handlers.get("get_file_content")!(event, { id: created.fileId }) as {
        mediaToken: string;
      };
      const staged = stores.mediaStreams.map.get(content.mediaToken)!;
      expect(staged.bytes).toHaveLength(0);
      expect(staged.openStream).toEqual(expect.any(Function));

      const response = await mediaStreamingResponse(
        stores.mediaStreams,
        `/${content.mediaToken}`,
        "bytes=2-5",
      );
      expect(response.status).toBe(206);
      expect(Buffer.from(await new Response(response.body).arrayBuffer()).toString("utf8")).toBe("2345");
    } finally {
      db.close();
    }
  });

  it("serves preserved legacy recording MIME as playable audio after conversion", async () => {
    const { state, db, workspace } = await fixture();
    const { ipc, handlers } = ipcHandlers();
    const stores = registerFileRuntimeSurfaceIpc(
      ipc,
      state,
      { userDataDir: temporary!, spawnRoomServerIfEnabled: () => {} },
      temporary!,
      () => {},
      { openPath: async () => {} },
    );
    const audioBytes = Buffer.from("aac-in-mp4 fixture bytes");
    const created = await workspace.createFile(
      "Recordings/converted-call.m4a",
      Readable.from([audioBytes]),
      "recording",
    );
    // Old rooms used several labels for the same AAC-in-MP4 container. The
    // conversion keeps this private metadata exactly, so the viewer boundary
    // must normalize it when it exposes the now-normal file to Chromium.
    db.prepare("UPDATE files SET mime_type = 'audio/m4a' WHERE id = ?").run(created.fileId);
    setRecMeta(db, created.fileId, JSON.stringify({ durationCs: 100, segments: [] }));

    try {
      const content = await handlers.get("get_file_content")!(event, { id: created.fileId }) as {
        kind: string;
        mediaToken: string;
      };
      expect(content.kind).toBe("recording");
      expect(stores.mediaStreams.map.get(content.mediaToken)?.mime).toBe("audio/mp4");

      const response = await mediaStreamingResponse(
        stores.mediaStreams,
        `/${content.mediaToken}`,
        "bytes=0-2",
      );
      expect(response.status).toBe(206);
      expect(response.headers).toContainEqual(["Content-Type", "audio/mp4"]);
      expect(Buffer.from(await new Response(response.body).arrayBuffer()))
        .toEqual(audioBytes.subarray(0, 3));
    } finally {
      db.close();
    }
  });

  it("imports a completed download into the workspace and keeps URL provenance", async () => {
    const { root, state, db } = await fixture();
    const downloaded = path.join(temporary!, "downloaded.txt");
    await writeFile(downloaded, "# Downloaded\n\nNormal file.", "utf8");
    const engine = createDownloadEngineDeps(state, temporary!, () => {}, {
      extractText: async (_name, bytes) => bytes.toString("utf8"),
    });

    try {
      const meta = await engine.importDownload!(downloaded, "downloaded.txt", "https://example.test/file");
      expect(await readFile(path.join(root, "downloaded.txt"), "utf8")).toContain("Normal file.");
      const row = db.prepare(
        "SELECT storage_kind, original_bytes, source, origin_url, extracted_text FROM files WHERE id = ?",
      ).get(meta.id) as Record<string, unknown>;
      expect(row).toMatchObject({
        storage_kind: "workspace",
        original_bytes: null,
        source: "download",
        origin_url: "https://example.test/file",
      });
      expect(String(row.extracted_text)).toContain("Normal file.");
    } finally {
      db.close();
    }
  });

  it("keeps workspace MCP writes searchable and uses optimistic trash", async () => {
    const { root, state, db, workspace } = await fixture();
    const bridge = createWorkspaceMcpBridge(state, true);

    try {
      expect(await bridge.call("write", { path: "/notes/today.md", content: "alpha beta" }))
        .toEqual({ path: "/notes/today.md" });
      expect(await readFile(path.join(root, "notes/today.md"), "utf8")).toBe("alpha beta");
      const row = db.prepare(
        "SELECT id, original_bytes, extracted_text FROM files WHERE relative_path = 'notes/today.md'",
      ).get() as { id: string; original_bytes: Buffer | null; extracted_text: string };
      expect(row.original_bytes).toBeNull();
      expect(row.extracted_text).toBe("alpha beta");

      expect(await bridge.call("write", {
        path: "/notes/today.md",
        content: "alpha delta",
      })).toEqual({ path: "/notes/today.md" });
      expect(await bridge.call("edit", {
        path: "/notes/today.md",
        old_string: "delta",
        new_string: "gamma",
      })).toMatchObject({ occurrences: 1 });
      expect(await bridge.call("grep", { path: "/notes", pattern: "gamma" }))
        .toMatchObject({ matches: [{ path: "/notes/today.md", line: 1, text: "alpha gamma" }] });

      const versions = db.prepare(
        `SELECT v.id, v.cause, length(v.bytes) AS inline_bytes, r.object_id
         FROM file_versions v
         JOIN content_object_refs r
           ON r.owner_type = 'file_version' AND r.owner_id = v.id AND r.role = 'content'
         WHERE v.file_id = ? ORDER BY v.rowid`,
      ).all(row.id) as Array<{ id: string; cause: string; inline_bytes: number; object_id: string }>;
      expect(versions.map(({ cause, inline_bytes }) => ({ cause, inline_bytes }))).toEqual([
        { cause: "Agent workspace rewrite", inline_bytes: 0 },
        { cause: "Agent workspace edit", inline_bytes: 0 },
      ]);
      expect(versions.every((version) => typeof version.object_id === "string" && version.object_id.length > 0)).toBe(true);
      expect((await workspace.versionSnapshot(versions[0]!.id)).bytes.toString("utf8")).toBe("alpha beta");
      expect((await workspace.versionSnapshot(versions[1]!.id)).bytes.toString("utf8")).toBe("alpha delta");
      await workspace.restoreVersion(versions[0]!.id);
      expect(await readFile(path.join(root, "notes/today.md"), "utf8")).toBe("alpha beta");

      expect((await bridge.call("delete", { path: "/notes/today.md" })).error).toBeUndefined();
      await expect(readFile(path.join(root, "notes/today.md"))).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("maps standard Room MCP file mutations onto normal workspace files", async () => {
    const { root, state, db, workspace } = await fixture();
    const bridge = createWorkspaceMcpBridge(state, true);

    try {
      expect(await bridge.call("standard_create", { name: "Draft.md", content: "first" }))
        .toMatchObject({ created: true, path: "/Draft.md" });
      expect(await bridge.call("standard_write", { name: "Draft.md", content: "second" }))
        .toMatchObject({ path: "/Draft.md" });
      expect(await bridge.call("standard_edit", {
        name: "draft",
        old_text: "second",
        new_text: "third",
      })).toMatchObject({ path: "/Draft.md", occurrences: 1 });
      const file = db.prepare("SELECT id FROM files WHERE relative_path = 'Draft.md'").get() as { id: string };
      const versions = db.prepare(
        `SELECT v.id, v.cause, length(v.bytes) AS inline_bytes, r.object_id
         FROM file_versions v
         JOIN content_object_refs r
           ON r.owner_type = 'file_version' AND r.owner_id = v.id AND r.role = 'content'
         WHERE v.file_id = ? ORDER BY v.rowid`,
      ).all(file.id) as Array<{ id: string; cause: string; inline_bytes: number; object_id: string }>;
      expect(versions.map(({ cause, inline_bytes }) => ({ cause, inline_bytes }))).toEqual([
        { cause: "AI rewrite", inline_bytes: 0 },
        { cause: "AI edit", inline_bytes: 0 },
      ]);
      expect(versions.every((version) => typeof version.object_id === "string" && version.object_id.length > 0)).toBe(true);
      expect((await workspace.versionSnapshot(versions[0]!.id)).bytes.toString("utf8")).toBe("first");
      expect((await workspace.versionSnapshot(versions[1]!.id)).bytes.toString("utf8")).toBe("second");
      await workspace.restoreVersion(versions[0]!.id);
      expect(await bridge.call("standard_rename", { name: "Draft.md", new_name: "Final" }))
        .toMatchObject({ path: "/Final.md" });
      expect(await readFile(path.join(root, "Final.md"), "utf8")).toBe("first");
      expect(await bridge.call("standard_trash", { names: ["Final"] }))
        .toMatchObject({ trashed: ["/Final.md"] });
      await expect(readFile(path.join(root, "Final.md"))).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("moves and renames binary workspace files without text conversion", async () => {
    const { root, state, db, workspace } = await fixture();
    const bridge = createWorkspaceMcpBridge(state, true);
    const bytes = Buffer.from([0x00, 0xff, 0x41, 0x52, 0x43, 0x45, 0x4c, 0x4c, 0x45]);

    try {
      await workspace.createFile("Uploads/source.pdf", Readable.from([bytes]), "agent");
      expect(await bridge.call("move", {
        source_path: "/Uploads/source.pdf",
        destination_path: "/Filed/source.pdf",
      })).toEqual({ old_path: "/Uploads/source.pdf", path: "/Filed/source.pdf" });
      expect(await bridge.call("rename", {
        source_path: "/Filed/source.pdf",
        new_name: "signed.pdf",
      })).toEqual({ old_path: "/Filed/source.pdf", path: "/Filed/signed.pdf" });
      expect(await readFile(path.join(root, "Filed/signed.pdf"))).toEqual(bytes);
      await expect(readFile(path.join(root, "Uploads/source.pdf"))).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects move and rename through a read-only workspace bridge", async () => {
    const { state, db, workspace } = await fixture();
    const bridge = createWorkspaceMcpBridge(state, false);
    try {
      await workspace.createFile("source.pdf", Readable.from([Buffer.from([0xff])]), "agent");
      expect(await bridge.call("move", {
        source_path: "/source.pdf",
        destination_path: "/Filed/source.pdf",
      })).toEqual({ error: "This workspace bridge is read-only." });
      expect(await bridge.call("rename", {
        source_path: "/source.pdf",
        new_name: "renamed.pdf",
      })).toEqual({ error: "This workspace bridge is read-only." });
    } finally {
      db.close();
    }
  });

  it("applies renderer bulk trash and restore to normal workspace files", async () => {
    const { root, state, db, workspace } = await fixture();
    const { ipc, handlers } = ipcHandlers();
    registerFileSurfaceIpc(ipc, state, () => {});
    const one = await workspace.createFile("one.txt", Readable.from(["one"]), "import");
    const two = await workspace.createFile("two.txt", Readable.from(["two"]), "import");

    try {
      const trashed = await handlers.get("trash_files")!(event, { ids: [one.fileId, two.fileId] }) as {
        ok: string[];
      };
      expect(trashed.ok).toEqual(["one.txt", "two.txt"]);
      await expect(readFile(path.join(root, "one.txt"))).rejects.toThrow();
      await expect(readFile(path.join(root, "two.txt"))).rejects.toThrow();

      const restored = await handlers.get("restore_files")!(event, { ids: [one.fileId, two.fileId] }) as {
        ok: string[];
      };
      expect(restored.ok).toEqual(["one.txt", "two.txt"]);
      expect(await readFile(path.join(root, "one.txt"), "utf8")).toBe("one");
      expect(await readFile(path.join(root, "two.txt"), "utf8")).toBe("two");
    } finally {
      db.close();
    }
  });
});
