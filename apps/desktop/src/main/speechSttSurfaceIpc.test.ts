import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const mocks = vi.hoisted(() => ({
  createWriteStream: vi.fn(),
  getFileFull: vi.fn(),
  getFileMeta: vi.fn(),
  mediaKind: vi.fn(),
  mkdtemp: vi.fn(),
  pipeline: vi.fn(),
  rm: vi.fn(),
  setFileExtractedText: vi.fn(),
  setSetting: vi.fn(),
  sidecarJsonCancellable: vi.fn(),
  speakOne: vi.fn(),
  sttEffectiveModel: vi.fn(),
  transcribeMediaWithSpeakers: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    createWriteStream: mocks.createWriteStream,
    promises: {
      mkdtemp: mocks.mkdtemp,
      rm: mocks.rm,
      writeFile: mocks.writeFile,
    },
  },
}));
vi.mock("node:os", () => ({ default: { tmpdir: () => "/tmp" } }));
vi.mock("node:stream/promises", () => ({ pipeline: mocks.pipeline }));
vi.mock("./db-host/files.js", () => ({
  getFileFull: mocks.getFileFull,
  getFileMeta: mocks.getFileMeta,
  setFileExtractedText: mocks.setFileExtractedText,
}));
vi.mock("./db-host/settings.js", () => ({ setSetting: mocks.setSetting }));
vi.mock("./mediaTranscribeJob.js", () => ({
  transcribeMediaWithSpeakers: mocks.transcribeMediaWithSpeakers,
}));
vi.mock("./peaksTools.js", () => ({ mediaKind: mocks.mediaKind }));
vi.mock("./sidecarJsonCancellable.js", () => ({
  sidecarJsonCancellable: mocks.sidecarJsonCancellable,
}));
vi.mock("./studiosPodcastAudio.js", () => ({ speakOne: mocks.speakOne }));
vi.mock("./sttTools.js", () => ({ sttEffectiveModel: mocks.sttEffectiveModel }));

import {
  registerSpeechSttSurfaceIpc,
  retranscribeFile,
  retranscribeFileRouted,
  transcribeMediaBytes,
} from "./speechSttSurfaceIpc.js";

const ROOM_PATH = "/rooms/current";
const FILE_ID = "file-1";

function openRoom(workspace?: { readStream: ReturnType<typeof vi.fn> }) {
  return { conn: { room: "db" }, path: ROOM_PATH, workspace };
}

function roomState(room: ReturnType<typeof openRoom> | null = openRoom()): RoomManagerState {
  return { room } as unknown as RoomManagerState;
}

function events(): { calls: Array<[string, unknown]>; emit: EventSender } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    emit: ((event: string, payload: unknown) => calls.push([event, payload])) as EventSender,
  };
}

function routedDeps(state: RoomManagerState, emit: EventSender, onIndexed?: (roomPath: string) => void) {
  return { emit, onIndexed, resourcesPath: null, state, userDataDir: "/userdata" } as Parameters<
    typeof retranscribeFileRouted
  >[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFileFull.mockReturnValue(["meeting.wav", "audio/wav", Buffer.from("audio")]);
  mocks.getFileMeta.mockReturnValue({ mimeType: "audio/wav", name: "meeting.wav" });
  mocks.mediaKind.mockReturnValue("audio");
  mocks.mkdtemp.mockResolvedValue("/tmp/arcelle-stt-case");
  mocks.pipeline.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.setFileExtractedText.mockReturnValue(undefined);
  mocks.setSetting.mockReturnValue(undefined);
  mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "ok", value: { text: "Transcript" } });
  mocks.speakOne.mockResolvedValue("spoken");
  mocks.sttEffectiveModel.mockReturnValue("/models/speech.bin");
  mocks.transcribeMediaWithSpeakers.mockResolvedValue({ segments: [] });
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.createWriteStream.mockReturnValue({ stream: "destination" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retranscribeFile preflight", () => {
  it("rejects before staging or emitting when the room, file, or stored bytes are unavailable", async () => {
    const emit = events();
    await expect(retranscribeFile(roomState(null), "/userdata", null, emit.emit, FILE_ID)).rejects.toThrow(
      "No room is open.",
    );

    mocks.mediaKind.mockReturnValue(null);
    await expect(retranscribeFile(roomState(), "/userdata", null, emit.emit, FILE_ID)).rejects.toThrow(
      "isn't audio or video",
    );

    mocks.mediaKind.mockReturnValue("audio");
    mocks.getFileFull.mockReturnValue(["meeting.wav", "audio/wav", undefined]);
    await expect(retranscribeFile(roomState(), "/userdata", null, emit.emit, FILE_ID)).rejects.toThrow(
      "no stored audio bytes",
    );

    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(emit.calls).toEqual([]);
  });

  it("announces a missing model but does not stage, fail, or reject", async () => {
    const emit = events();
    mocks.sttEffectiveModel.mockReturnValue(null);

    await expect(retranscribeFile(roomState(), "/userdata", null, emit.emit, FILE_ID)).resolves.toBeUndefined();

    expect(emit.calls).toEqual([["stt-progress", ["meeting.wav", "model-missing"]]]);
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
  });
});

describe("retranscribeFile staging and completion", () => {
  it("stages stored bytes, commits only to the current room, and emits the completion sequence", async () => {
    const state = roomState();
    const emit = events();
    const onIndexed = vi.fn();

    await retranscribeFile(state, "/userdata", null, emit.emit, FILE_ID, onIndexed);

    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/tmp/arcelle-stt-case/source.wav",
      Buffer.from("audio"),
      { mode: 0o600 },
    );
    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/stt/transcribe_file",
      expect.objectContaining({ kind: "audio", model_path: "/models/speech.bin", path: "/tmp/arcelle-stt-case/source.wav" }),
      expect.anything(),
      10 * 60 * 60 * 1000,
    );
    expect(mocks.setFileExtractedText).toHaveBeenCalledWith(state.room!.conn, FILE_ID, "Transcript");
    expect(emit.calls).toEqual([
      ["stt-progress", ["meeting.wav", "started"]],
      ["file-updated", FILE_ID],
      ["room-files-changed", {}],
      ["stt-progress", ["meeting.wav", "done"]],
    ]);
    expect(onIndexed).toHaveBeenCalledWith(ROOM_PATH);
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/arcelle-stt-case", { force: true, recursive: true });
  });

  it("streams workspace bytes and reports an empty transcript as none", async () => {
    const readStream = vi.fn(() => ({ stream: "source" }));
    const emit = events();
    mocks.getFileFull.mockReturnValue(["meeting.m4a", undefined, undefined]);
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "ok", value: { text: "  " } });

    await retranscribeFile(roomState(openRoom({ readStream })), "/userdata", null, emit.emit, FILE_ID);

    expect(mocks.pipeline).toHaveBeenCalledWith({ stream: "source" }, { stream: "destination" });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(emit.calls.at(-1)).toEqual(["stt-progress", ["meeting.m4a", "none"]]);
  });

  it.each([
    ["stopped", { kind: "stopped" }, "Stopped.", "Stopped."],
    ["sidecar error", { error: { error: "decoder failed" }, kind: "error" }, "decoder failed", "decoder failed"],
    ["malformed reply", { kind: "ok", value: {} }, "no transcript", "The speech engine returned no transcript."],
  ])("reports %s after staging and always cleans up", async (_case, outcome, message, failure) => {
    const emit = events();
    mocks.sidecarJsonCancellable.mockResolvedValue(outcome);

    await expect(retranscribeFile(roomState(), "/userdata", null, emit.emit, FILE_ID)).rejects.toThrow(message);

    expect(emit.calls).toEqual([
      ["stt-progress", ["meeting.wav", "started"]],
      ["stt-progress", ["meeting.wav", `failed: ${failure}`]],
    ]);
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/arcelle-stt-case", { force: true, recursive: true });
  });

  it("does not commit when the room changes while the sidecar is running", async () => {
    const state = roomState();
    const emit = events();
    mocks.sidecarJsonCancellable.mockImplementation(async () => {
      state.room = null;
      return { kind: "ok", value: { text: "Transcript" } };
    });

    await expect(retranscribeFile(state, "/userdata", null, emit.emit, FILE_ID)).rejects.toThrow(
      "room was closed",
    );

    expect(mocks.setFileExtractedText).not.toHaveBeenCalled();
    expect(emit.calls.at(-1)).toEqual([
      "stt-progress",
      ["meeting.wav", "failed: The room was closed while transcription was running."],
    ]);
  });
});

describe("retranscribeFileRouted", () => {
  it("uses the text-only lane for non-media and enforces model/job failures for media", async () => {
    const state = roomState();
    const emit = events();
    mocks.mediaKind.mockReturnValue(null);

    await expect(retranscribeFileRouted(routedDeps(state, emit.emit), FILE_ID)).rejects.toThrow(
      "isn't audio or video",
    );
    expect(mocks.getFileFull).toHaveBeenCalledWith(state.room!.conn, FILE_ID);

    mocks.mediaKind.mockReturnValue("audio");
    mocks.sttEffectiveModel.mockReturnValue(null);
    await expect(retranscribeFileRouted(routedDeps(state, emit.emit), FILE_ID)).rejects.toThrow(
      "No speech model is installed",
    );

    mocks.sttEffectiveModel.mockReturnValue("/models/speech.bin");
    mocks.transcribeMediaWithSpeakers.mockResolvedValue(null);
    await expect(retranscribeFileRouted(routedDeps(state, emit.emit), FILE_ID)).rejects.toThrow(
      "nothing was changed",
    );

    mocks.transcribeMediaWithSpeakers.mockResolvedValue({ segments: [] });
    await expect(retranscribeFileRouted(routedDeps(state, emit.emit), FILE_ID)).resolves.toBeUndefined();
  });

  it("rejects before routing when no room is open", async () => {
    await expect(retranscribeFileRouted(routedDeps(roomState(null), events().emit), FILE_ID)).rejects.toThrow(
      "No room is open.",
    );
  });
});

describe("transcribeMediaBytes", () => {
  it("requires a model before staging", async () => {
    mocks.sttEffectiveModel.mockReturnValue(null);
    await expect(transcribeMediaBytes("/userdata", null, Buffer.from("audio"), "wav", "audio")).rejects.toThrow(
      "speech model is not installed",
    );
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
  });

  it.each([
    ["success", { kind: "ok", value: { text: "Words" } }, "Words"],
    ["stopped", { kind: "stopped" }, "Stopped."],
    ["error", { error: { error: "engine failed" }, kind: "error" }, "engine failed"],
    ["malformed", { kind: "ok", value: {} }, "no transcript"],
  ])("handles %s sidecar replies and always removes its temp directory", async (_case, outcome, expected) => {
    mocks.sidecarJsonCancellable.mockResolvedValue(outcome);
    const operation = transcribeMediaBytes("/userdata", null, Buffer.from("audio"), "wav", "audio");

    if (outcome.kind === "ok" && "text" in outcome.value) await expect(operation).resolves.toBe(expected);
    else await expect(operation).rejects.toThrow(expected);

    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/tmp/arcelle-stt-case/source.wav",
      Buffer.from("audio"),
      { mode: 0o600 },
    );
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/arcelle-stt-case", { force: true, recursive: true });
  });
});

describe("registerSpeechSttSurfaceIpc", () => {
  it("registers speech, voice catalog, and retranscription handlers", async () => {
    const handlers = new Map<string, (event: never, raw?: unknown) => Promise<unknown> | unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (event: never, raw?: unknown) => unknown) => {
      handlers.set(channel, handler);
    }) };
    const state = roomState();
    const emit = events();
    registerSpeechSttSurfaceIpc(ipcMain, state, "/userdata", null, emit.emit);

    expect([...handlers.keys()]).toEqual(["speak_text_neural", "list_neural_voices", "retranscribe_file"]);
    await expect(handlers.get("speak_text_neural")!(undefined as never, { text: "Hello", voice: "Ada" })).resolves.toBe("spoken");
    expect(mocks.speakOne).toHaveBeenCalledWith(state.room!.conn, "Hello", "Ada", undefined, undefined);

    mocks.sidecarJsonCancellable.mockResolvedValue({
      kind: "ok",
      value: { voices: [
        { gender: "female", id: "Multilingual Ada", locale: "en" },
        { gender: "male", id: "Ben", locale: "he" },
        { id: "invalid" },
      ] },
    });
    await expect(handlers.get("list_neural_voices")!(undefined as never)).resolves.toEqual([
      { gender: "female", id: "Multilingual Ada", locale: "en" },
      { gender: "male", id: "Ben", locale: "he" },
    ]);
    expect(mocks.setSetting).toHaveBeenCalledWith(state.room!.conn, "voice_catalog_ids", "Multilingual Ada,Ben");

    mocks.mediaKind.mockReturnValueOnce(null).mockReturnValue("audio");
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "ok", value: { text: "Transcript" } });
    await expect(handlers.get("retranscribe_file")!(undefined as never, { fileId: FILE_ID })).resolves.toBeUndefined();
  });

  it.each([
    ["stopped", { kind: "stopped" }, "Stopped."],
    ["error", { error: { error: "voice service down" }, kind: "error" }, "voice service down"],
    ["missing catalog", { kind: "ok", value: {} }, "voice catalog returned no voices"],
  ])("rejects an invalid voice-catalog result: %s", async (_case, outcome, expected) => {
    const handlers = new Map<string, (event: never, raw?: unknown) => Promise<unknown> | unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (event: never, raw?: unknown) => unknown) => {
      handlers.set(channel, handler);
    }) };
    mocks.sidecarJsonCancellable.mockResolvedValue(outcome);
    registerSpeechSttSurfaceIpc(ipcMain, roomState(null), "/userdata", null, events().emit);

    await expect(handlers.get("list_neural_voices")!(undefined as never)).rejects.toThrow(expected);
  });
});
