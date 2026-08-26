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
    const { root, state, db } = await fixture();
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

      expect(await bridge.call("edit", {
        path: "/notes/today.md",
        old_string: "beta",
        new_string: "gamma",
      })).toMatchObject({ occurrences: 1 });
      expect(await bridge.call("grep", { path: "/notes", pattern: "gamma" }))
        .toMatchObject({ matches: [{ path: "/notes/today.md", line: 1, text: "alpha gamma" }] });
      expect((await bridge.call("delete", { path: "/notes/today.md" })).error).toBeUndefined();
      await expect(readFile(path.join(root, "notes/today.md"))).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("maps standard Room MCP file mutations onto normal workspace files", async () => {
    const { root, state, db } = await fixture();
    const bridge = createWorkspaceMcpBridge(state, true);

    try {
      expect(await bridge.call("standard_create", { name: "Draft.md", content: "first" }))
        .toMatchObject({ created: true, path: "/Draft.md" });
      expect(await bridge.call("standard_edit", {
        name: "draft",
        old_text: "first",
        new_text: "second",
      })).toMatchObject({ path: "/Draft.md", occurrences: 1 });
      expect(await bridge.call("standard_rename", { name: "Draft.md", new_name: "Final" }))
        .toMatchObject({ path: "/Final.md" });
      expect(await readFile(path.join(root, "Final.md"), "utf8")).toBe("second");
      expect(await bridge.call("standard_trash", { names: ["Final"] }))
        .toMatchObject({ trashed: ["/Final.md"] });
      await expect(readFile(path.join(root, "Final.md"))).rejects.toThrow();
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
