import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginRetranscribe: vi.fn(),
  busy: vi.fn(),
  coerceRecMeta: vi.fn(),
  endRetranscribe: vi.fn(),
  ensureUp: vi.fn(),
  getFileFull: vi.fn(),
  getRecMeta: vi.fn(),
  inTransaction: vi.fn(),
  knownVoices: vi.fn(),
  mediaKind: vi.fn(),
  mkdtemp: vi.fn(),
  pipeline: vi.fn(),
  parseRecMeta: vi.fn(),
  rm: vi.fn(),
  snapshotFileVersion: vi.fn(),
  setFileExtractedText: vi.fn(),
  setRecMeta: vi.fn(),
  splitCompleteLines: vi.fn(),
  sttEffectiveModel: vi.fn(),
  transcriptText: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    createWriteStream: vi.fn(() => ({ fabricated: "write-stream" })),
    promises: {
      mkdtemp: mocks.mkdtemp,
      rm: mocks.rm,
      writeFile: mocks.writeFile,
    },
  },
  existsSync: vi.fn(() => false),
}));
vi.mock("node:os", () => ({ default: { tmpdir: () => "/fabricated-tmp" } }));
vi.mock("node:stream/promises", () => ({ pipeline: mocks.pipeline }));
vi.mock("undici", () => ({ Agent: class Agent {} }));
vi.mock("./db-host/files.js", () => ({
  getFileFull: mocks.getFileFull,
  inTransaction: mocks.inTransaction,
  setFileExtractedText: mocks.setFileExtractedText,
}));
vi.mock("./db-host/recordings.js", () => ({
  getRecMeta: mocks.getRecMeta,
  setRecMeta: mocks.setRecMeta,
}));
vi.mock("./db-host/voices.js", () => ({ knownVoices: mocks.knownVoices }));
vi.mock("./db-host/versions.js", () => ({ snapshotFileVersion: mocks.snapshotFileVersion }));
vi.mock("./obs.js", () => ({
  errKind: (value: string) => value,
  id: (value: string) => value,
  warn: vi.fn(),
}));
vi.mock("./peaksTools.js", () => ({ mediaKind: mocks.mediaKind }));
vi.mock("./recBridge.js", () => ({
  beginRetranscribe: mocks.beginRetranscribe,
  coerceRecMeta: mocks.coerceRecMeta,
  endRetranscribe: mocks.endRetranscribe,
  parseRecMeta: mocks.parseRecMeta,
}));
vi.mock("./recFormat.js", () => ({
  defaultRecMeta: () => freshMeta(),
  transcriptText: mocks.transcriptText,
}));
vi.mock("./sidecar.js", () => ({
  authedHeaders: () => ({}),
  busy: mocks.busy,
  ensureUp: mocks.ensureUp,
  splitCompleteLines: mocks.splitCompleteLines,
}));
vi.mock("./sttTools.js", () => ({ sttEffectiveModel: mocks.sttEffectiveModel }));

import { transcribeMediaWithSpeakers } from "./mediaTranscribeJob.js";

type FakeMeta = {
  durationCs: number;
  segments: unknown[];
  speakerNames: Record<string, string>;
  recognized: string[];
  cuts: unknown[];
  chapters: unknown[];
  highlights: unknown[];
  notes: unknown[];
  readOf: null;
  maxSpeakers: number;
};

function freshMeta(overrides: Partial<FakeMeta> = {}): FakeMeta {
  return {
    durationCs: 120,
    segments: [],
    speakerNames: {},
    recognized: [],
    cuts: [],
    chapters: [],
    highlights: [],
    notes: [],
    readOf: null,
    maxSpeakers: 4,
    ...overrides,
  };
}

function terminalStream(line: Record<string, unknown>): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(`${JSON.stringify(line)}\n`);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function fakeResponse(line: Record<string, unknown>): Response {
  return { body: terminalStream(line), ok: true } as Response;
}

function fakeJob() {
  const room = { conn: {}, name: "Fabricated", path: "/fabricated-room" };
  const state = { cancel: {}, editPending: new Map(), room, roomEpoch: 7, rollingBack: false };
  const emitted: [string, unknown][] = [];
  return {
    deps: {
      emit: (event: string, payload: unknown) => emitted.push([event, payload]),
      resourcesPath: null,
      state,
      userDataDir: "/fabricated-user-data",
    } as never,
    emitted,
    state,
  };
}

function configureFakes(): void {
  mocks.beginRetranscribe.mockReturnValue(true);
  mocks.busy.mockReturnValue({ release: vi.fn() });
  mocks.coerceRecMeta.mockImplementation((meta: FakeMeta) => meta);
  mocks.ensureUp.mockResolvedValue("http://fabricated-sidecar");
  mocks.getFileFull.mockReturnValue([
    "meeting.mp3",
    "audio/mpeg",
    Buffer.from("fabricated-media"),
    null,
  ]);
  mocks.getRecMeta.mockReturnValue(null);
  mocks.inTransaction.mockImplementation((_conn: unknown, action: () => void) => action());
  mocks.knownVoices.mockReturnValue([]);
  mocks.mediaKind.mockReturnValue("audio");
  mocks.mkdtemp.mockResolvedValue("/fabricated-stage");
  mocks.parseRecMeta.mockImplementation(() => freshMeta());
  mocks.pipeline.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.splitCompleteLines.mockImplementation((bytes: Buffer) => ({
    lines: bytes.toString("utf8").split("\n").filter(Boolean),
    rest: Buffer.alloc(0),
  }));
  mocks.sttEffectiveModel.mockReturnValue("/fabricated-model.bin");
  mocks.transcriptText.mockReturnValue("[0:00] Speaker 1: fabricated transcript");
  mocks.writeFile.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.resetAllMocks();
  configureFakes();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runPreparedTranscription through its public fake-only entry point", () => {
  it("keeps the prior transcript untouched when the fabricated sidecar cannot start", async () => {
    const { deps, emitted } = fakeJob();
    mocks.ensureUp.mockRejectedValueOnce(new Error("sidecar unavailable"));

    await expect(transcribeMediaWithSpeakers(deps, "file-1")).resolves.toBeNull();

    expect(emitted).toEqual([
      ["stt-progress", ["meeting.mp3", "started"]],
      ["stt-progress", ["meeting.mp3", "failed: sidecar unavailable"]],
    ]);
    expect(mocks.setFileExtractedText).not.toHaveBeenCalled();
    expect(mocks.setRecMeta).not.toHaveBeenCalled();
    expect(mocks.endRetranscribe).toHaveBeenCalledWith("file-1");
    expect(mocks.rm).toHaveBeenCalledWith("/fabricated-stage", { force: true, recursive: true });
  });

  it("reports a stopped fabricated stream and does not persist a partial transcript", async () => {
    const { deps, emitted } = fakeJob();
    const fetch = vi.fn().mockResolvedValue(fakeResponse({ kind: "stopped" }));
    vi.stubGlobal("fetch", fetch);

    await expect(transcribeMediaWithSpeakers(deps, "file-2")).resolves.toBeNull();

    expect(fetch).toHaveBeenCalledWith(
      "http://fabricated-sidecar/rec/retranscribe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(emitted).toEqual([
      ["stt-progress", ["meeting.mp3", "started"]],
      ["stt-progress", ["meeting.mp3", "failed: the rebuild was stopped before it finished — nothing was changed"]],
    ]);
    expect(mocks.setFileExtractedText).not.toHaveBeenCalled();
    expect(mocks.setRecMeta).not.toHaveBeenCalled();
  });

  it("persists only a completed fabricated rebuild, then emits the completion fan-out", async () => {
    const { deps, emitted } = fakeJob();
    const rebuilt = freshMeta({ durationCs: 345, segments: [{ speaker: "Speaker 1" }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({
      kind: "done",
      meta: rebuilt,
      neural: true,
    })));

    await expect(transcribeMediaWithSpeakers(deps, "file-3")).resolves.toEqual(rebuilt);

    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/fabricated-stage/source.mp3",
      Buffer.from("fabricated-media"),
      { mode: 0o600 },
    );
    expect(mocks.setFileExtractedText).toHaveBeenCalledWith(
      expect.anything(),
      "file-3",
      "[0:00] Speaker 1: fabricated transcript",
    );
    expect(mocks.setRecMeta).toHaveBeenCalledWith(expect.anything(), "file-3", JSON.stringify(rebuilt));
    expect(emitted).toEqual([
      ["stt-progress", ["meeting.mp3", "started"]],
      ["rec-retranscribe", { fileId: "file-3", doneCs: 345, totalCs: 345 }],
      ["file-updated", "file-3"],
      ["room-files-changed", {}],
      ["stt-progress", ["meeting.mp3", "done"]],
    ]);
  });

  it("refuses a completed fabricated rebuild if its original room closes before persistence", async () => {
    const { deps, emitted, state } = fakeJob();
    mocks.ensureUp.mockImplementationOnce(async () => {
      state.room = null as never;
      return "http://fabricated-sidecar";
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({
      kind: "done",
      meta: freshMeta(),
      neural: true,
    })));

    await expect(transcribeMediaWithSpeakers(deps, "file-closed-room")).resolves.toBeNull();

    expect(mocks.setFileExtractedText).not.toHaveBeenCalled();
    expect(mocks.setRecMeta).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      ["stt-progress", ["meeting.mp3", "started"]],
      ["stt-progress", ["meeting.mp3", "failed: the room was closed while the transcript was being rebuilt"]],
    ]);
  });

  it("turns a fabricated staging write error into a named failure and still releases the reservation", async () => {
    const { deps, emitted } = fakeJob();
    mocks.writeFile.mockRejectedValueOnce(new Error("staging write refused"));

    await expect(transcribeMediaWithSpeakers(deps, "file-4")).resolves.toBeNull();

    expect(mocks.ensureUp).not.toHaveBeenCalled();
    expect(emitted).toEqual([[
      "stt-progress",
      ["meeting.mp3", "failed: staging write refused"],
    ]]);
    expect(mocks.endRetranscribe).toHaveBeenCalledWith("file-4");
    expect(mocks.rm).toHaveBeenCalledWith("/fabricated-stage", { force: true, recursive: true });
  });

  it("refuses a source whose room row disappears during loading", async () => {
    const { deps, emitted } = fakeJob();
    mocks.getFileFull.mockImplementationOnce(() => {
      throw new Error("fabricated row race");
    });

    await expect(transcribeMediaWithSpeakers(deps, "missing-file")).resolves.toBeNull();

    expect(emitted).toEqual([]);
    expect(mocks.beginRetranscribe).not.toHaveBeenCalled();
  });

  it("names an absent stored blob before reserving private staging", async () => {
    const { deps, emitted } = fakeJob();
    mocks.getFileFull.mockReturnValueOnce(["empty.mp3", "audio/mpeg", null, null]);

    await expect(transcribeMediaWithSpeakers(deps, "empty-file")).resolves.toBeNull();

    expect(emitted).toEqual([["stt-progress", ["empty.mp3", "failed: this recording has no stored audio"]]]);
    expect(mocks.beginRetranscribe).not.toHaveBeenCalled();
  });

  it("releases the retranscription claim when private staging cannot be reserved", async () => {
    const { deps, emitted } = fakeJob();
    mocks.mkdtemp.mockRejectedValueOnce(new Error("fabricated private-directory failure"));

    await expect(transcribeMediaWithSpeakers(deps, "unstageable-file")).resolves.toBeNull();

    expect(mocks.endRetranscribe).toHaveBeenCalledWith("unstageable-file");
    expect(emitted).toEqual([[
      "stt-progress",
      ["meeting.mp3", "failed: a private staging folder could not be created"],
    ]]);
  });

  it("streams a workspace video and tolerates corrupt prior metadata and best-effort callback failures", async () => {
    const { deps, emitted, state } = fakeJob();
    const readStream = vi.fn(() => ({ fabricated: "read-stream" }));
    const snapshotVersion = vi.fn().mockRejectedValue(new Error("fabricated snapshot race"));
    state.room = {
      ...state.room,
      conn: {
        prepare: vi.fn(() => ({ get: vi.fn(() => ({ content_sha256: "video-sha" })) })),
      },
      workspace: { readStream, snapshotVersion },
    } as never;
    mocks.getFileFull.mockReturnValueOnce(["meeting.mp4", "video/mp4", null, "prior transcript"]);
    mocks.mediaKind.mockReturnValueOnce("video");
    mocks.getRecMeta.mockReturnValue("{not-readable-json");
    mocks.parseRecMeta.mockImplementation(() => {
      throw new Error("fabricated prior metadata parse failure");
    });
    mocks.knownVoices.mockImplementationOnce(() => {
      throw new Error("fabricated voice-table race");
    });
    const warmVisualIndex = vi.fn().mockRejectedValue(new Error("fabricated visual-index failure"));
    const onIndexed = vi.fn(() => {
      throw new Error("fabricated index notification failure");
    });
    Object.assign(deps, { warmVisualIndex, onIndexed });
    const rebuilt = freshMeta({ durationCs: 900, segments: [{ speaker: "Speaker 1" }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ kind: "done", meta: rebuilt, neural: true })));

    await expect(transcribeMediaWithSpeakers(deps, "workspace-video")).resolves.toEqual(rebuilt);

    expect(readStream).toHaveBeenCalledWith("workspace-video");
    expect(mocks.pipeline).toHaveBeenCalledWith(
      { fabricated: "read-stream" },
      { fabricated: "write-stream" },
    );
    expect(warmVisualIndex).toHaveBeenCalledWith("/fabricated-stage/source.mp4", "video-sha");
    expect(snapshotVersion).toHaveBeenCalledWith("workspace-video", "Re-transcribed");
    expect(mocks.knownVoices).toHaveBeenCalled();
    expect(onIndexed).toHaveBeenCalledWith("/fabricated-room");
    expect(emitted.at(-1)).toEqual(["stt-progress", ["meeting.mp4", "done"]]);
  });
});
