import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentUiRuntime, type AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import { RoomToolDispatcher, WEB_LANES_ALL } from "./bridgeDispatcher.js";
import { createFolder, moveFileToFolder } from "./db-host/folders.js";
import { insertFile } from "./db-host/files.js";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import { createToolEffects } from "./execTool.js";
import {
  INTERACTIVE_VISUAL_INDEX_BUDGET_MS,
  liveMcpRoutes,
  playableVideoMime,
  requestLiveMediaFrame,
} from "./liveAppServices.js";
import { createMediaStreams, type MediaStreams } from "./mediaTools.js";
import { MCP_TOOL_PREFS_KEY } from "./mcpConfig.js";
import type { McpManager } from "./mcpClient.js";
import { createRoomManagerState, type RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { VIDEO_VISUAL_INDEX_PROFILE_ID } from "./videoVisualIndex.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

const PASSWORD = "correct horse battery staple";
const FRAME_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";
const FRAME_SHA = createHash("sha256").update(Buffer.from(FRAME_B64, "base64")).digest("hex");

let tempDir: string | null = null;
let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function fixtureRoom(): { state: RoomManagerState; streams: MediaStreams } {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "live-media-frame-"));
  const roomPath = path.join(tempDir, `${randomUUID()}.roomai`);
  db = createRoom(roomPath, PASSWORD, "Video frame fixture");
  const state = createRoomManagerState();
  state.room = { conn: db, path: roomPath, name: "Video frame fixture", password: PASSWORD };
  return { state, streams: createMediaStreams() };
}

async function fixtureWorkspaceVideo(
  bytes = Buffer.from("workspace video bytes"),
  name = "lecture.mp4",
): Promise<{
  state: RoomManagerState;
  streams: MediaStreams;
  workspace: WorkspaceService;
  fileId: string;
  sourceSha256: string;
}> {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "live-media-frame-workspace-"));
  const root = path.join(tempDir, "Room");
  const created = createWorkspaceRoom(root, PASSWORD, "Video frame fixture");
  db = created.db;
  const workspace = new WorkspaceService(created.db, root);
  const entry = await workspace.createFile(name, Readable.from([bytes]), "import");
  created.db.prepare("UPDATE files SET mime_type = 'video/mp4' WHERE id = ?").run(entry.fileId);
  const row = created.db.prepare("SELECT content_sha256 FROM files WHERE id = ?").get(entry.fileId) as {
    content_sha256: string;
  };
  const state = createRoomManagerState();
  state.room = {
    conn: created.db,
    path: root,
    name: "Video frame fixture",
    password: PASSWORD,
    workspace,
  };
  return {
    state,
    streams: createMediaStreams(),
    workspace,
    fileId: entry.fileId,
    sourceSha256: row.content_sha256,
  };
}

function answeringRenderer(
  runtime: AgentUiRuntime,
  answer: Record<string, unknown>,
  inspect?: (payload: Record<string, unknown>) => void,
): EventSender {
  return (event, raw) => {
    expect(event).toBe("agent-ui-request");
    const payload = raw as Record<string, unknown>;
    inspect?.(payload);
    const resolve = runtime.pending.get(String(payload.id));
    expect(resolve).toBeTypeOf("function");
    resolve?.(answer);
  };
}

describe("playableVideoMime", () => {
  it("normalizes old octet-stream video rows exactly like the viewer", () => {
    expect(playableVideoMime("camera.MOV", "application/octet-stream")).toBe("video/quicktime");
    expect(playableVideoMime("capture.webm", "")).toBe("video/webm");
    expect(playableVideoMime("archive.mkv", "application/octet-stream")).toBe("video/x-matroska");
    expect(playableVideoMime("phone.m4v", "application/octet-stream")).toBe("video/mp4");
    expect(playableVideoMime("clip.mp4", "Video/MP4")).toBe("video/mp4");
  });

  it("does not relabel an unsupported arbitrary file as video", () => {
    expect(playableVideoMime("notes.bin", "application/octet-stream")).toBeNull();
    expect(playableVideoMime("notes.txt", "text/plain")).toBeNull();
  });
});

describe("liveMcpRoutes", () => {
  it("preserves route ordering, reserved-name disambiguation, schemas, and annotations using only manager fakes", () => {
    const manager = {
      servers: [
        {
          name: "offline",
          status: "failed",
          client: {},
          remote: false,
          tools: [{ name: "ignored", description: "ignored", schema: {}, annotations: null }],
        },
        {
          name: "missing",
          status: "connected",
          client: null,
          remote: false,
          tools: [{ name: "ignored", description: "ignored", schema: {}, annotations: null }],
        },
        {
          name: "list",
          status: "connected",
          client: {},
          remote: true,
          tools: [
            {
              name: "room files",
              description: "a".repeat(2_001),
              schema: ["not an object"],
              annotations: { title: "Visible files" },
            },
            { name: "room files", description: "second", schema: { type: "string" }, annotations: null },
          ],
        },
      ],
    } as unknown as McpManager;

    const routes = liveMcpRoutes(createRoomManagerState(), manager);

    expect(routes.map((route) => route.catalogName)).toEqual(["list_room_files_2", "list_room_files_3"]);
    expect(routes).toMatchObject([{
      toolName: "room files",
      serverName: "list",
      remote: true,
      spec: {
        type: "function",
        function: {
          name: "list_room_files_2",
          description: `${"a".repeat(1_997)}…`,
          parameters: { type: "object", properties: {} },
          annotations: { title: "Visible files" },
        },
      },
    }, {
      spec: { function: { name: "list_room_files_3", description: "second", parameters: { type: "string" } } },
    }]);
  });

  it("honors the open room's persisted disabled-tool preference", () => {
    const { state } = fixtureRoom();
    setSetting(db!, MCP_TOOL_PREFS_KEY, JSON.stringify({ files: ["hidden"] }));
    const manager = {
      servers: [{
        name: "files",
        status: "connected",
        client: {},
        remote: false,
        tools: [
          { name: "hidden", description: "not exposed", schema: {}, annotations: null },
          { name: "shown", description: "exposed", schema: {}, annotations: null },
        ],
      }],
    } as unknown as McpManager;

    expect(liveMcpRoutes(state, manager).map((route) => route.toolName)).toEqual(["shown"]);
  });
});

describe("requestLiveMediaFrame through RoomToolDispatcher", () => {
  it("resolves the exact folder-qualified inventory name and preserves PNG base64 + SHA to MCP", async () => {
    const { state, streams } = fixtureRoom();
    const bytes = Buffer.from("deterministic staged video bytes");
    const file = insertFile(db!, "qa.mp4", "video/mp4", bytes, null, "import");
    const folder = createFolder(db!, "Media");
    moveFileToFolder(db!, file.id, folder.id);

    const runtime = createAgentUiRuntime();
    let rendererArgs: Record<string, unknown> | null = null;
    const emit = answeringRenderer(
      runtime,
      {
        imageB64: FRAME_B64,
        width: 1280,
        height: 720,
        atSeconds: 1.03125,
        sha256: FRAME_SHA,
      },
      (payload) => {
        expect(payload.kind).toBe("media_frame");
        rendererArgs = payload.args as Record<string, unknown>;
      },
    );
    const sharedEffects = createToolEffects();
    const dispatcher = new RoomToolDispatcher({
      webEnabled: false,
      lanes: WEB_LANES_ALL,
      routes: [],
      advisor: null,
      runCancel: null,
      sharedEffects,
      privacyBypass: false,
      activePolicy: () => null,
      execDeps: {
        db: null,
        routes: [],
        agentUi: (kind, args) => {
          expect(kind).toBe("media_frame");
          return requestLiveMediaFrame(state, { mediaStreams: streams }, runtime, emit, args);
        },
      },
    });

    const result = await dispatcher.callTool(
      { kind: "LocalEngine" },
      "view_media_frame",
      { name: "@Media/qa.mp4", at: "0:01" },
    );

    expect(result).toEqual({
      isError: false,
      content: [
        {
          type: "text",
          text: `Frame receipt: @Media/qa.mp4 at 1.031s; SHA-256 ${FRAME_SHA}; 1280×720 PNG.`,
        },
        { type: "image", data: FRAME_B64, mimeType: "image/png" },
      ],
    });
    expect(rendererArgs).not.toBeNull();
    const args = rendererArgs as unknown as Record<string, unknown>;
    expect(args.mime).toBe("video/mp4");
    expect(args.seconds).toBe(1);
    const token = String(args.token);
    expect(streams.map.get(token)?.bytes).toEqual(bytes);
    expect(streams.map.get(token)?.mime).toBe("video/mp4");
    expect(sharedEffects.mediaFrames).toEqual([{
      fileName: "@Media/qa.mp4",
      requestedAt: "0:01",
      actualSeconds: 1.03125,
      sha256: FRAME_SHA,
      width: 1280,
      height: 720,
    }]);
    // `pendingImages` was drained into exactly this MCP result, not retained for
    // a later tool call where the wrong model could receive it.
    expect(sharedEffects.pendingImages).toEqual([]);
  });

  it("stages an old octet-stream MOV with a decoder-readable MIME", async () => {
    const { state, streams } = fixtureRoom();
    insertFile(db!, "camera.mov", "application/octet-stream", Buffer.from("mov bytes"), null, "import");
    const runtime = createAgentUiRuntime();
    let rendererArgs: Record<string, unknown> | null = null;
    const emit = answeringRenderer(runtime, {
      imageB64: FRAME_B64,
      width: 1,
      height: 1,
      atSeconds: 0,
      sha256: FRAME_SHA,
    }, (payload) => {
      rendererArgs = payload.args as Record<string, unknown>;
    });
    const frame = vi.fn(async () => { throw new Error("sealed/legacy bytes must not enter the derived cache"); });
    const capture = vi.fn(async () => { throw new Error("sealed/legacy bytes must not enter the derived cache"); });
    const warm = vi.fn(async () => { throw new Error("sealed/legacy bytes must not enter the derived cache"); });

    await requestLiveMediaFrame(
      state,
      { mediaStreams: streams },
      runtime,
      emit,
      { name: "camera.mov", at: "0" },
      { capture, frame, warm },
    );

    expect(rendererArgs).not.toBeNull();
    const args = rendererArgs as unknown as Record<string, unknown>;
    expect(args.mime).toBe("video/quicktime");
    expect(streams.map.get(String(args.token))?.mime).toBe("video/quicktime");
    expect(frame).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
  });

  it("serves a warm workspace visual index without waking the hidden renderer", async () => {
    const { state, streams, sourceSha256 } = await fixtureWorkspaceVideo();
    const runtime = createAgentUiRuntime();
    const frame = vi.fn(async () => ({
      imageB64: FRAME_B64,
      width: 1,
      height: 1,
      atSeconds: 360,
      sha256: FRAME_SHA,
    }));
    const capture = vi.fn(async () => null);
    const warm = vi.fn(async () => null);

    const result = await requestLiveMediaFrame(
      state,
      { mediaStreams: streams },
      runtime,
      () => { throw new Error("cache hit must not ask the renderer"); },
      { name: "@lecture.mp4", at: "6:00" },
      { capture, frame, warm },
    );

    expect(result).toMatchObject({ atSeconds: 360, sha256: FRAME_SHA });
    expect(frame).toHaveBeenCalledWith(sourceSha256, 360, expect.any(Number));
    expect(capture).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect(streams.map.size).toBe(0);
  });

  it("starts a cold warm, captures the exact second immediately, and returns the existing PNG contract", async () => {
    const source = Buffer.from("cold existing Unicode video bytes");
    const { state, streams, sourceSha256 } = await fixtureWorkspaceVideo(
      source,
      "LIVE： Uncle Bob on Software Fundamentals in the Age of AI.mp4",
    );
    const runtime = createAgentUiRuntime();
    const frame = vi.fn().mockResolvedValueOnce(null);
    let stagedDuringCapture = "";
    const capture = vi.fn(async (stagedPath: string, second: number) => {
      stagedDuringCapture = stagedPath;
      expect(path.basename(path.dirname(stagedPath))).toMatch(/^arcelle-visual-index-/);
      expect(readFileSync(stagedPath)).toEqual(source);
      expect(second).toBe(360);
      return {
        imageB64: FRAME_B64,
        width: 1,
        height: 1,
        atSeconds: 360,
        sha256: FRAME_SHA,
      };
    });
    const warm = vi.fn(async (stagedPath: string, expectedSha: string) => {
      expect(path.basename(path.dirname(stagedPath))).toMatch(/^arcelle-visual-index-/);
      expect(readFileSync(stagedPath)).toEqual(source);
      expect(expectedSha).toBe(sourceSha256);
      return {
        indexId: `${sourceSha256}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        sourceSha256,
        frameCount: 10,
        reused: false,
      };
    });

    const result = await requestLiveMediaFrame(
      state,
      { mediaStreams: streams },
      runtime,
      () => { throw new Error("successful cold warm must not ask the renderer"); },
      {
        name: "@LIVE： Uncle Bob on Software Fundamentals in the Age of AI.mp4",
        at: "6:00",
      },
      { capture, frame, warm },
    );

    expect(result).toMatchObject({ imageB64: FRAME_B64, atSeconds: 360, sha256: FRAME_SHA });
    expect(frame).toHaveBeenCalledTimes(1);
    expect(frame).toHaveBeenCalledWith(sourceSha256, 360, expect.any(Number));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledTimes(1);
    // Both operations resolved before the answer; detached cleanup is queued.
    expect(stagedDuringCapture).not.toBe("");
    expect(streams.map.size).toBe(0);
  });

  it("falls back at the 30s interactive deadline but retains staging until the detached warm settles", async () => {
    let detachedStagedPath = "";
    vi.useFakeTimers();
    try {
      const { state, streams, sourceSha256 } = await fixtureWorkspaceVideo();
      const runtime = createAgentUiRuntime();
      const frame = vi.fn(async () => null);
      let settleWarm: (() => void) | null = null;
      let settleCapture: (() => void) | null = null;
      let signalWarmStarted: (() => void) | null = null;
      const warmStarted = new Promise<void>((resolve) => { signalWarmStarted = resolve; });
      const warm = vi.fn((pathArg: string, expectedSha: string, timeoutMs?: number) => {
        detachedStagedPath = pathArg;
        expect(expectedSha).toBe(sourceSha256);
        // The build gets the background budget even though this request waits
        // only for the interactive budget.
        expect(timeoutMs).toBe(120_000);
        signalWarmStarted?.();
        return new Promise<null>((resolve) => { settleWarm = () => resolve(null); });
      });
      const capture = vi.fn((pathArg: string, second: number, timeoutMs?: number) => {
        expect(pathArg).toBe(detachedStagedPath);
        expect(second).toBe(360);
        expect(timeoutMs).toBeLessThanOrEqual(INTERACTIVE_VISUAL_INDEX_BUDGET_MS);
        return new Promise<null>((resolve) => { settleCapture = () => resolve(null); });
      });
      const emit = answeringRenderer(runtime, {
        imageB64: FRAME_B64,
        width: 1,
        height: 1,
        atSeconds: 360,
        sha256: FRAME_SHA,
      });

      const pending = requestLiveMediaFrame(
        state,
        { mediaStreams: streams },
        runtime,
        emit,
        { name: "lecture.mp4", at: "6:00" },
        { capture, frame, warm },
      );
      await warmStarted;
      expect(existsSync(detachedStagedPath)).toBe(true);
      await vi.advanceTimersByTimeAsync(INTERACTIVE_VISUAL_INDEX_BUDGET_MS);
      await expect(pending).resolves.toMatchObject({ imageB64: FRAME_B64, atSeconds: 360 });
      // The renderer fallback has answered, but deleting now would make the
      // backend's post-capture source hash fail. Cleanup is deferred.
      expect(existsSync(detachedStagedPath)).toBe(true);
      settleWarm?.();
      // Warm alone settling is not enough: capture still owns the staged file.
      await Promise.resolve();
      expect(existsSync(detachedStagedPath)).toBe(true);
      settleCapture?.();
    } finally {
      vi.useRealTimers();
    }
    for (let attempt = 0; attempt < 20 && existsSync(detachedStagedPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(existsSync(detachedStagedPath)).toBe(false);
  });

  it("never serves an old source hash after a workspace video changes, then falls back honestly", async () => {
    const first = Buffer.from("first source");
    const second = Buffer.from("changed source");
    const { state, streams, workspace, fileId, sourceSha256: oldSha } = await fixtureWorkspaceVideo(first);
    await workspace.writeAtomic(fileId, Readable.from([second]), oldSha);
    const current = db!.prepare("SELECT content_sha256 FROM files WHERE id = ?").get(fileId) as {
      content_sha256: string;
    };
    expect(current.content_sha256).not.toBe(oldSha);

    const runtime = createAgentUiRuntime();
    const frame = vi.fn(async (sha: string) => sha === oldSha
      ? { imageB64: FRAME_B64, width: 1, height: 1, atSeconds: 0, sha256: FRAME_SHA }
      : null);
    const capture = vi.fn(async () => null);
    const warm = vi.fn(async () => null);
    const emit = answeringRenderer(runtime, {
      imageB64: FRAME_B64,
      width: 1,
      height: 1,
      atSeconds: 0,
      sha256: FRAME_SHA,
    });

    await requestLiveMediaFrame(
      state,
      { mediaStreams: streams },
      runtime,
      emit,
      { name: "lecture.mp4", at: "0" },
      { capture, frame, warm },
    );

    expect(frame.mock.calls.every((call) => call[0] === current.content_sha256)).toBe(true);
    expect(warm).toHaveBeenCalledWith(expect.any(String), current.content_sha256, expect.any(Number));
    expect(warm.mock.calls[0]?.[2]).toBe(120_000);
    const captureBudget = Number(capture.mock.calls[0]?.[2]);
    expect(captureBudget).toBeGreaterThan(0);
    expect(captureBudget).toBeLessThanOrEqual(INTERACTIVE_VISUAL_INDEX_BUDGET_MS);
    const staged = [...streams.map.values()][0];
    expect(staged?.openStream).toBeTypeOf("function");
    const chunks: Buffer[] = [];
    for await (const chunk of await staged!.openStream!()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(second);
  });

  it("keeps cached pixels behind the existing Cloud Privacy fail-closed valve", async () => {
    const { state, streams } = await fixtureWorkspaceVideo();
    const runtime = createAgentUiRuntime();
    const frame = vi.fn(async () => ({
      imageB64: FRAME_B64,
      width: 1,
      height: 1,
      atSeconds: 360,
      sha256: FRAME_SHA,
    }));
    const capture = vi.fn(async () => null);
    const warm = vi.fn(async () => null);
    const dispatcher = new RoomToolDispatcher({
      webEnabled: false,
      lanes: WEB_LANES_ALL,
      routes: [],
      advisor: null,
      runCancel: null,
      sharedEffects: null,
      privacyBypass: false,
      activePolicy: () => ({
        restoreValue: (value) => value,
        redact: (text) => ({ text, entitiesHidden: 0 }),
      }),
      execDeps: {
        db: null,
        routes: [],
        agentUi: (_kind, args) => requestLiveMediaFrame(
          state,
          { mediaStreams: streams },
          runtime,
          () => { throw new Error("cache hit must not ask the renderer"); },
          args,
          { capture, frame, warm },
        ),
      },
    });

    const result = await dispatcher.callTool(
      { kind: "CloudEngine" },
      "view_media_frame",
      { name: "@lecture.mp4", at: "6:00" },
    );

    expect(result.content).toEqual([{
      type: "text",
      text:
        "view_media_frame is unavailable while Cloud Privacy is active because it cannot use the " +
        "validated redacted workspace. Switch the model to On this Mac to use this action.",
    }]);
    expect(frame).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
  });

  it("returns an honest tool error when the named file is not supported media", async () => {
    const { state, streams } = fixtureRoom();
    insertFile(db!, "notes.bin", "application/octet-stream", Buffer.from("not video"), null, "import");
    const runtime = createAgentUiRuntime();
    let emitted = false;
    const dispatcher = new RoomToolDispatcher({
      webEnabled: false,
      lanes: WEB_LANES_ALL,
      routes: [],
      advisor: null,
      runCancel: null,
      sharedEffects: createToolEffects(),
      privacyBypass: false,
      activePolicy: () => null,
      execDeps: {
        db: null,
        routes: [],
        agentUi: (_kind, args) => requestLiveMediaFrame(
          state,
          { mediaStreams: streams },
          runtime,
          () => { emitted = true; },
          args,
        ),
      },
    });

    const result = await dispatcher.callTool(
      { kind: "LocalEngine" },
      "view_media_frame",
      { name: "notes.bin", at: "0" },
    );

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "“notes.bin” is not a supported video file." }],
    });
    expect(emitted).toBe(false);
    expect(streams.map.size).toBe(0);
  });

  it("propagates a renderer decoder refusal as an error without receipt-only success", async () => {
    const { state, streams } = fixtureRoom();
    insertFile(db!, "unsupported.mp4", "video/mp4", Buffer.from("unsupported codec"), null, "import");
    const runtime = createAgentUiRuntime();
    const emit = answeringRenderer(runtime, {
      error: "That video couldn't be loaded for a frame grab (unsupported codec or container).",
    });
    const dispatcher = new RoomToolDispatcher({
      webEnabled: false,
      lanes: WEB_LANES_ALL,
      routes: [],
      advisor: null,
      runCancel: null,
      sharedEffects: createToolEffects(),
      privacyBypass: false,
      activePolicy: () => null,
      execDeps: {
        db: null,
        routes: [],
        agentUi: (_kind, args) => requestLiveMediaFrame(
          state,
          { mediaStreams: streams },
          runtime,
          emit,
          args,
        ),
      },
    });

    const result = await dispatcher.callTool(
      { kind: "LocalEngine" },
      "view_media_frame",
      { name: "unsupported.mp4", at: "0" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "That video couldn't be loaded for a frame grab (unsupported codec or container).",
    }]);
  });
});
