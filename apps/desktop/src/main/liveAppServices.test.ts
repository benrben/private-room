import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentUiRuntime, type AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import { RoomToolDispatcher, WEB_LANES_ALL } from "./bridgeDispatcher.js";
import { createFolder, moveFileToFolder } from "./db-host/folders.js";
import { insertFile } from "./db-host/files.js";
import { createRoom } from "./db-host/open.js";
import { createToolEffects } from "./execTool.js";
import {
  playableVideoMime,
  requestLiveMediaFrame,
} from "./liveAppServices.js";
import { createMediaStreams, type MediaStreams } from "./mediaTools.js";
import { createRoomManagerState, type RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

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
      { name: "Media/qa.mp4", at: "0:01" },
    );

    expect(result).toEqual({
      isError: false,
      content: [
        {
          type: "text",
          text: `Frame receipt: Media/qa.mp4 at 1.031s; SHA-256 ${FRAME_SHA}; 1280×720 PNG.`,
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
      fileName: "Media/qa.mp4",
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

    await requestLiveMediaFrame(
      state,
      { mediaStreams: streams },
      runtime,
      emit,
      { name: "camera.mov", at: "0" },
    );

    expect(rendererArgs).not.toBeNull();
    const args = rendererArgs as unknown as Record<string, unknown>;
    expect(args.mime).toBe("video/quicktime");
    expect(streams.map.get(String(args.token))?.mime).toBe("video/quicktime");
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
