import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(() => "job-1"),
  submit: vi.fn(async () => {}),
  atCapacity: vi.fn(() => false),
  getPodcast: vi.fn(),
  listShots: vi.fn(() => []),
  listCast: vi.fn(() => []),
  listStoryLists: vi.fn(() => []),
  unfinishedJobs: vi.fn(() => []),
  currentRoom: null as { db: object; path: string; name: string } | null,
  progress: vi.fn(),
  removeCancelFlag: vi.fn(),
  onSettled: vi.fn(async () => {}),
  runnerSink: { emit: vi.fn() },
  setJobStatus: vi.fn(),
  checkpointJob: vi.fn(),
  spawnPodcastAudio: vi.fn(async () => {}),
  renderPodcastAudio: vi.fn(),
  listModels: vi.fn(async () => []),
  summarizeOneFile: vi.fn(async () => "A useful summary"),
  writeRoomSummary: vi.fn(async () => ({ id: "summary-file" })),
  getFileMeta: vi.fn(() => ({ name: "reference.png", mimeType: "image/png", aiSummary: null })),
  getFileExtractedText: vi.fn(() => "source text"),
  listFilesForSummary: vi.fn(() => [{ id: "file-1", name: "notes.txt", source: "upload" }]),
  filesMissingSummary: vi.fn(() => [["file-1"]]),
  setFileAiSummary: vi.fn(),
  markSectionOnly: vi.fn(),
  readRoomFile: vi.fn(async () => ({ bytes: Buffer.from("reference") })),
  createRoomFile: vi.fn(async () => ({ id: "created-file" })),
  sidecarJson: vi.fn(async () => ({ kind: "value", value: { artwork_b64: Buffer.from("image").toString("base64") } })),
  runStudioCore: vi.fn(async () => ({ id: "studio-file" })),
  limitsFor: vi.fn(() => undefined),
  allowsSeconds: vi.fn(() => true),
  defaultSeconds: vi.fn(() => 5),
  takesFirstFrame: vi.fn(() => true),
}));

vi.mock("./jobQueue.js", () => ({
  atCapacity: mocks.atCapacity,
  createJobQueueState: vi.fn(() => ({})),
  defaultRowStarters: vi.fn(() => new Map()),
  QUEUE_FULL: "The background job queue is full.",
  runnerDepsFrom: vi.fn(() => ({
    rooms: { current: () => mocks.currentRoom },
    sink: mocks.runnerSink,
    removeCancelFlag: mocks.removeCancelFlag,
    onSettled: mocks.onSettled,
  })),
  submit: mocks.submit,
}));

vi.mock("./db-host/jobs.js", () => ({
  createJob: mocks.createJob,
  getJob: vi.fn(),
  setJobStatus: mocks.setJobStatus,
  checkpointJob: mocks.checkpointJob,
  unfinishedJobs: mocks.unfinishedJobs,
}));

vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: vi.fn(() => true) }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: vi.fn(() => false) }));

vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn(() => null) }));
vi.mock("./engineRouting.js", () => ({ listModels: mocks.listModels }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: vi.fn(() => "summary-model") }));

vi.mock("./providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers.js")>();
  return {
    ...actual,
    ensureProviderCatalog: vi.fn(async () => {}),
    injectProviderRuntime: vi.fn((body) => body),
    providerModelFacts: vi.fn(() => ({ imageOutput: true, videoOutput: true })),
  };
});

vi.mock("./mediaLimits.js", () => ({
  limitsFor: mocks.limitsFor,
  allowsSeconds: mocks.allowsSeconds,
  defaultSeconds: mocks.defaultSeconds,
  takesFirstFrame: mocks.takesFirstFrame,
}));

vi.mock("./studiosCmds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./studiosCmds.js")>();
  return {
    ...actual,
    runStudioCore: mocks.runStudioCore,
    studioSpecFor: vi.fn((kind: string) => kind === "flashcards" ? { kind } : null),
    studioTitle: vi.fn(() => "Flashcards"),
  };
});

vi.mock("./studiosPodcastAudio.js", () => ({
  getPodcast: mocks.getPodcast,
  renderPodcastAudio: mocks.renderPodcastAudio,
}));

vi.mock("./db-host/story.js", () => ({
  castFaces: vi.fn(() => []),
  listCast: mocks.listCast,
  listShots: mocks.listShots,
  listStoryLists: mocks.listStoryLists,
  setShotResult: vi.fn(),
}));

vi.mock("./jobs.js", () => ({
  emitProgress: mocks.progress,
  pinnedDb: vi.fn((rooms, roomPath) => {
    const room = rooms.current();
    return room?.path === roomPath ? room.db : null;
  }),
  runPlan: vi.fn(async (steps, completed, cancel, execute, checkpoint, progress) => {
    const done = new Set(completed);
    for (const step of steps) {
      if (done.has(step.id)) continue;
      const result = await execute(step);
      if (!result.ok) return { kind: "error", error: result.error };
      done.add(step.id);
      checkpoint(done);
      progress(done.size, steps.length);
    }
    return cancel.load() ? { kind: "paused" } : { kind: "done" };
  }),
  spawnJobRunner: vi.fn(async (_runner, _id, _path, work) => work()),
  spawnPodcastAudio: mocks.spawnPodcastAudio,
}));

vi.mock("./summarizeTools.js", () => ({
  isSummaryFile: vi.fn(() => false),
  MAX_SUMMARY_FILES: 50,
  summarizeOneFile: mocks.summarizeOneFile,
  writeRoomSummary: mocks.writeRoomSummary,
}));

vi.mock("./db-host/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-host/files.js")>();
  return {
    ...actual,
    getFileExtractedText: mocks.getFileExtractedText,
    getFileMeta: mocks.getFileMeta,
    listFilesForSummary: mocks.listFilesForSummary,
    filesMissingSummary: mocks.filesMissingSummary,
    markSectionOnly: mocks.markSectionOnly,
    setFileAiSummary: mocks.setFileAiSummary,
  };
});

vi.mock("./workspace/roomContent.js", () => ({
  readRoomFile: mocks.readRoomFile,
  createRoomFile: mocks.createRoomFile,
}));

vi.mock("./sidecarJsonCancellable.js", () => ({ sidecarJsonCancellable: mocks.sidecarJson }));

import {
  creativeAttachment,
  installCreativeJobStarters,
  registerCreativeJobSurfaceIpc,
  startDeepSummaryJob,
} from "./creativeJobSurfaceIpc.js";
import { CancelFlag } from "./cancel.js";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

type Listener = (event: unknown, raw?: unknown) => unknown;

function fixture(): {
  state: RoomManagerState;
  deps: RoomManagerDeps;
  handlers: Map<string, Listener>;
  emit: EventSender;
} {
  const handlers = new Map<string, Listener>();
  const state = {
    room: { conn: {}, path: "/rooms/test.roomai", name: "Test", password: "secret" },
    rollingBack: false,
    cancel: { cancels: new Map(), jobCancels: new Map() },
  } as unknown as RoomManagerState;
  mocks.currentRoom = {
    db: state.room!.conn as unknown as object,
    path: state.room!.path,
    name: state.room!.name,
  };
  const deps = { jobQueue: { starters: new Map() } } as unknown as RoomManagerDeps;
  const emit = vi.fn() as unknown as EventSender;
  registerCreativeJobSurfaceIpc(
    { handle: (channel: string, listener: Listener) => handlers.set(channel, listener) } as never,
    state,
    deps,
    emit,
  );
  return { state, deps, handlers, emit };
}

function handler(handlers: Map<string, Listener>, channel: string): Listener {
  const registered = handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing ${channel}`);
  return registered;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.currentRoom = null;
  mocks.atCapacity.mockReturnValue(false);
  mocks.listShots.mockReturnValue([]);
  mocks.listCast.mockReturnValue([]);
  mocks.listStoryLists.mockReturnValue([]);
  mocks.unfinishedJobs.mockReturnValue([]);
  mocks.runStudioCore.mockResolvedValue({ id: "studio-file" });
  mocks.limitsFor.mockReturnValue(undefined);
  mocks.allowsSeconds.mockReturnValue(true);
  mocks.defaultSeconds.mockReturnValue(5);
  mocks.takesFirstFrame.mockReturnValue(true);
});

describe("creative job IPC", () => {
  it("normalizes a create request before persisting and submitting it", async () => {
    const { handlers } = fixture();

    await expect(handler(handlers, "start_create_job")({}, {
      prompt: "  a bright city at night  ", model: "provider::image", kind: "image",
      variations: 99, seconds: 20, resolution: "", aspectRatio: "",
      referenceFileIds: ["one", 2, "two"], frameFileId: "frame", referencesAck: true, shotId: "shot-1",
    })).resolves.toBe("job-1");

    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.anything(),
      "create",
      "Painting “a bright city at night”",
      expect.objectContaining({
        prompt: "a bright city at night", variations: 4, seconds: null,
        referenceFileIds: ["one", "two"], frameFileId: "frame", shotId: "shot-1",
      }),
      100,
    );
    expect(mocks.submit).toHaveBeenCalledWith(expect.anything(), "job-1");
  });

  it("keeps validation and queue errors on their existing IPC channels", async () => {
    const { handlers, state } = fixture();

    await expect(handler(handlers, "start_create_job")({}, { prompt: " ", model: "image" }))
      .rejects.toThrow("Say what to make first.");
    await expect(handler(handlers, "start_studio_job")({}, { kind: "unknown" }))
      .rejects.toThrow("Unknown studio kind.");
    state.rollingBack = true;
    await expect(handler(handlers, "start_studio_job")({}, { kind: "flashcards" }))
      .rejects.toThrow("A room rollback is in progress — try again when it finishes.");
  });

  it("validates podcast scripts before creating their job", async () => {
    const { handlers } = fixture();
    mocks.getPodcast.mockReturnValueOnce(null).mockReturnValueOnce({ turns: [] }).mockReturnValueOnce({ turns: [{ text: "Hi" }] });

    await expect(handler(handlers, "start_podcast_audio_job")({}, { scriptFileId: "script" }))
      .rejects.toThrow("This file has no podcast script attached.");
    await expect(handler(handlers, "start_podcast_audio_job")({}, { scriptFileId: "script" }))
      .rejects.toThrow("This script has no lines to read.");
    await expect(handler(handlers, "start_podcast_audio_job")({}, { scriptFileId: "script" }))
      .resolves.toBe("job-1");
  });

  it("returns a film-plan summary without submitting work", () => {
    const { handlers } = fixture();
    mocks.listStoryLists.mockReturnValue([{ id: "list", logline: "A journey", clipResolution: "1080p", stillResolution: "", aspectRatio: "16:9" }]);
    mocks.listShots.mockReturnValue([
      { id: "first", action: "walks", castIds: [], seconds: 5, imageModel: "image", videoModel: "video", stillFileId: null, clipFileId: null },
      { id: "second", action: "rests", castIds: [], seconds: 7, imageModel: "", videoModel: "video", stillFileId: null, clipFileId: null },
    ]);

    expect(handler(handlers, "story_film_plan")({}, { listId: "list", kind: "image" })).toMatchObject({
      kind: "image", sending: 1, skipped: 1, totalSeconds: 0,
      shots: [expect.objectContaining({ shotId: "first", skip: null }), expect.objectContaining({ shotId: "second", skip: "no picture model chosen" })],
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("runs registered studio, summary, podcast, and creation starters through their queue lifecycle", async () => {
    const { deps } = fixture();
    const queue = deps.jobQueue!;
    const starters = queue.starters as Map<string, (queue: unknown, job: unknown, roomPath: string, cancel: CancelFlag) => Promise<unknown>>;

    await expect(starters.get("studio")!(queue, { id: "studio-job", plan: { kind: "flashcards" }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "runner" });
    await expect(starters.get("deep_summary")!(queue, { id: "summary-job", plan: { fileIds: ["file-1"], model: "model", auto: false, reduce: true }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "runner" });
    await expect(starters.get("podcast_audio")!(queue, { id: "podcast-job", plan: { scriptFileId: "script" }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "runner" });
    await expect(starters.get("create")!(queue, { id: "create-job", plan: { prompt: "Sunset", model: "image", kind: "image", variations: 1, seconds: null, resolution: "", aspectRatio: "", referenceFileIds: [], frameFileId: null, lastFrameFileId: null, chained: false, referencesAck: false, shotId: null }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "runner" });
    await vi.waitFor(() => expect(mocks.summarizeOneFile).toHaveBeenCalled());
    await vi.waitFor(() => expect(mocks.createRoomFile).toHaveBeenCalled());
    expect(mocks.spawnPodcastAudio).toHaveBeenCalledOnce();
    expect(mocks.setFileAiSummary).toHaveBeenCalledWith(expect.anything(), "file-1", "A useful summary");
    expect(mocks.createRoomFile).toHaveBeenCalledWith(expect.anything(), "Sunset.png", "image/png", expect.any(Buffer), "Sunset", "generated");
  });

  it("returns unreadable-plan errors without launching registered work", async () => {
    const { deps } = fixture();
    const queue = deps.jobQueue!;
    const starters = queue.starters as Map<string, (queue: unknown, job: unknown, roomPath: string, cancel: CancelFlag) => Promise<unknown>>;

    await expect(starters.get("studio")!(queue, { id: "bad", plan: {}, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "error", message: "This job's plan is unreadable." });
    await expect(starters.get("podcast_audio")!(queue, { id: "bad", plan: {}, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "error", message: "This job's plan is unreadable." });
    await expect(starters.get("deep_summary")!(queue, { id: "bad", plan: {}, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "error", message: "This job's plan is unreadable." });
    await expect(starters.get("create")!(queue, { id: "bad", plan: {}, cursor: 0 }, "/rooms/test.roomai", new CancelFlag()))
      .resolves.toEqual({ kind: "error", message: "This job's plan is unreadable." });
  });

  it("starts summary jobs with its default model and preserves its refusals", async () => {
    const { state, deps } = fixture();

    await expect(startDeepSummaryJob(state, deps, false)).resolves.toBe("job-1");
    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.anything(), "deep_summary", "Room summary",
      { fileIds: ["file-1"], model: "summary-model", auto: false, reduce: true }, 1,
    );
    state.rollingBack = true;
    await expect(startDeepSummaryJob(state, deps, false)).rejects.toThrow(
      "A room rollback is in progress — try again when it finishes."
    );
  });

  it("keeps starter failure and pause results observable to the queue", async () => {
    const { deps } = fixture();
    const queue = deps.jobQueue!;
    const starters = queue.starters as Map<string, (queue: unknown, job: unknown, roomPath: string, cancel: CancelFlag) => Promise<unknown>>;
    mocks.runStudioCore.mockRejectedValueOnce(new Error("studio failed"));
    mocks.sidecarJson.mockResolvedValueOnce({ kind: "error", error: { error: "provider failed" } });

    await starters.get("studio")!(queue, { id: "studio-fail", plan: { kind: "flashcards" }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await starters.get("create")!(queue, { id: "create-fail", plan: { prompt: "Sunset", model: "image", kind: "image", variations: 1, seconds: null, resolution: "", aspectRatio: "", referenceFileIds: [], frameFileId: null, lastFrameFileId: null, chained: false, referencesAck: false, shotId: null }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());

    await vi.waitFor(() => expect(mocks.runnerSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "create-fail", failed: true })
    ));
    expect(mocks.runnerSink.emit).toHaveBeenCalledWith(expect.objectContaining({ jobId: "studio-fail", failed: true }));
    expect(mocks.runnerSink.emit).toHaveBeenCalledWith(expect.objectContaining({ jobId: "create-fail", failed: true }));
  });

  it("refuses a creative attachment without bytes", async () => {
    mocks.readRoomFile.mockResolvedValueOnce({ bytes: null });
    await expect(creativeAttachment({ db: {}, path: "/rooms/test.roomai" } as never, "missing"))
      .rejects.toThrow("That reference file has no saved bytes.");
  });

  it("creates its queue lazily and keeps no-room and no-queue errors explicit", async () => {
    const { state, emit, handlers } = fixture();
    const unavailable = {} as RoomManagerDeps;
    await expect(startDeepSummaryJob(state, unavailable, false)).rejects.toThrow(
      "The background job queue is unavailable."
    );
    const installed = installCreativeJobStarters(state, unavailable, emit);
    expect(installed.starters).toBeInstanceOf(Map);
    expect(installed.rooms.current()).toMatchObject({ path: "/rooms/test.roomai", name: "Test" });

    state.room = null;
    await expect(handler(handlers, "start_create_job")({}, { prompt: "cat", model: "image" }))
      .rejects.toThrow("No room is open.");
  });

  it("keeps automatic summary selection, empty queues, and capacity refusals distinct", async () => {
    const { state, deps } = fixture();
    await expect(startDeepSummaryJob(state, deps, true)).resolves.toBe("job-1");
    expect(mocks.createJob).toHaveBeenLastCalledWith(
      expect.anything(), "deep_summary", "Indexing new files",
      expect.objectContaining({ auto: true, reduce: false }), 1,
    );

    mocks.filesMissingSummary.mockReturnValue([]);
    await expect(startDeepSummaryJob(state, deps, true)).rejects.toThrow("There are no new files to index.");
    mocks.filesMissingSummary.mockReturnValue([["file-1"]]);
    mocks.atCapacity.mockReturnValue(true);
    await expect(startDeepSummaryJob(state, deps, false)).rejects.toThrow("The background job queue is full.");
  });

  it("runs summary failure and skip paths without hiding their queue results", async () => {
    const { deps } = fixture();
    const queue = deps.jobQueue!;
    const starter = (queue.starters as Map<string, (queue: unknown, job: unknown, roomPath: string, cancel: CancelFlag) => Promise<unknown>>).get("deep_summary")!;
    mocks.summarizeOneFile.mockRejectedValueOnce(new Error("OLLAMA_DOWN"));

    await starter(queue, { id: "summary-down", plan: { fileIds: ["file-1"], model: "model", auto: false, reduce: false }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await vi.waitFor(() => expect(mocks.runnerSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "summary-down", failed: true })
    ));

    mocks.getFileMeta.mockReturnValueOnce({ name: "reference.png", mimeType: "image/png", aiSummary: "already done" });
    await starter(queue, { id: "summary-skip", plan: { fileIds: ["file-1"], model: "model", auto: true, reduce: false }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await vi.waitFor(() => expect(mocks.runnerSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "summary-skip", finished: true, label: "Indexing finished" })
    ));

    mocks.summarizeOneFile.mockRejectedValueOnce(new Error("temporary provider error"));
    await starter(queue, { id: "summary-soft-error", plan: { fileIds: ["file-1"], model: "model", auto: true, reduce: false }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await vi.waitFor(() => expect(mocks.runnerSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "summary-soft-error", finished: true })
    ));

    mocks.writeRoomSummary.mockRejectedValueOnce(new Error("summary write failed"));
    await starter(queue, { id: "summary-write-fail", plan: { fileIds: ["file-1"], model: "model", auto: false, reduce: true }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await vi.waitFor(() => expect(mocks.runnerSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "summary-write-fail", failed: true })
    ));
  });

  it("applies provider limits before persisting a video create plan", async () => {
    const { handlers } = fixture();
    const limits = { maxReferences: 1, aspectRatios: ["1:1"], resolutions: ["720p"], frameImages: [] };
    mocks.limitsFor.mockReturnValue(limits);
    mocks.takesFirstFrame.mockReturnValue(false);

    await expect(handler(handlers, "start_create_job")({}, {
      prompt: "clip", model: "provider::video", kind: "video", frameFileId: "first",
    })).rejects.toThrow("video cannot start from a picture.");

    mocks.takesFirstFrame.mockReturnValue(true);
    mocks.allowsSeconds.mockReturnValue(false);
    await expect(handler(handlers, "start_create_job")({}, {
      prompt: "clip", model: "provider::video", kind: "video", seconds: 9,
    })).rejects.toThrow("video does not make 9-second clips.");

    mocks.allowsSeconds.mockReturnValue(true);
    await expect(handler(handlers, "start_create_job")({}, {
      prompt: "clip", model: "provider::video", kind: "video", variations: 2, seconds: null,
      aspectRatio: "wide", resolution: "4k", referenceFileIds: ["one", "two"], frameFileId: "first",
    })).resolves.toBe("job-1");
    expect(mocks.createJob).toHaveBeenLastCalledWith(expect.anything(), "create", expect.stringContaining("Filming"), expect.objectContaining({
      seconds: 5, aspectRatio: "", resolution: "", referenceFileIds: ["one"],
    }), 100);
  });

  it("generates and saves a completed video through its polling protocol", async () => {
    vi.useFakeTimers();
    const { deps } = fixture();
    const queue = deps.jobQueue!;
    const starter = (queue.starters as Map<string, (queue: unknown, job: unknown, roomPath: string, cancel: CancelFlag) => Promise<unknown>>).get("create")!;
    mocks.sidecarJson
      .mockResolvedValueOnce({ kind: "value", value: { video_id: "video-1" } })
      .mockResolvedValueOnce({ kind: "value", value: { progress: 10 } })
      .mockResolvedValueOnce({ kind: "value", value: { done: true } })
      .mockResolvedValueOnce({ kind: "value", value: { artwork_b64: Buffer.from("video").toString("base64") } });

    await starter(queue, { id: "video-job", plan: { prompt: "Clip", model: "video", kind: "video", variations: 1, seconds: 5, resolution: "", aspectRatio: "", referenceFileIds: ["ref"], frameFileId: "first", lastFrameFileId: "tail", chained: false, referencesAck: false, shotId: "shot" }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(mocks.createRoomFile).toHaveBeenCalledWith(
      expect.anything(), "Clip.mp4", "video/mp4", expect.any(Buffer), "Clip", "generated"
    ));
  });

  it("exposes room changes, podcast callbacks, and attachment output to callers", async () => {
    const { state, deps } = fixture();
    mocks.listModels.mockImplementationOnce(async () => {
      state.room = null;
      return [];
    });
    await expect(startDeepSummaryJob(state, deps, false)).rejects.toThrow("The room changed while the summary was starting.");

    const { deps: podcastDeps } = fixture();
    const podcast = (podcastDeps.jobQueue!.starters as Map<string, (queue: unknown, job: unknown, path: string, cancel: CancelFlag) => Promise<unknown>>).get("podcast_audio")!;
    mocks.spawnPodcastAudio.mockImplementationOnce(async (runner: { render: (id: string, cancel: CancelFlag) => unknown }) => {
      await runner.render("script", new CancelFlag());
    });
    await podcast(podcastDeps.jobQueue!, { id: "podcast-callback", plan: { scriptFileId: "script" }, cursor: 0 }, "/rooms/test.roomai", new CancelFlag());
    await vi.waitFor(() => expect(mocks.renderPodcastAudio).toHaveBeenCalled());
    await expect(creativeAttachment({ db: {}, path: "/rooms/test.roomai" } as never, "reference"))
      .resolves.toEqual({ b64: Buffer.from("reference").toString("base64"), mime: "image/png" });
  });

  it("reports shot skips, invalid joins, and a partial batch without hiding started work", async () => {
    const { handlers } = fixture();
    const shot = (id: string, extra = {}) => ({ id, action: "walks", castIds: [], seconds: 5, imageModel: "image", videoModel: "video", stillFileId: null, clipFileId: null, ...extra });
    mocks.unfinishedJobs.mockReturnValue([{ kind: "create", plan: { shotId: "inflight" } }]);
    mocks.listShots.mockReturnValue([
      shot("inflight"),
      shot("done", { stillFileId: "picture" }),
    ]);
    expect(handler(handlers, "story_film_plan")({}, { listId: "list", kind: "image" })).toMatchObject({
      skipped: 2,
      shots: [
        expect.objectContaining({ skip: "already being drawn — a job for it is queued or running" }),
        expect.objectContaining({ skip: "already drawn" }),
      ],
    });

    mocks.unfinishedJobs.mockReturnValue([]);
    mocks.limitsFor.mockReturnValue({ maxReferences: 1, aspectRatios: [], resolutions: [], frameImages: [] });
    mocks.takesFirstFrame.mockReturnValue(false);
    mocks.listShots.mockReturnValue([shot("invalid", { stillFileId: "first" })]);
    expect(handler(handlers, "story_film_plan")({}, { listId: "list", kind: "video" })).toMatchObject({
      skipped: 1,
      shots: [expect.objectContaining({ skip: "video cannot start from a picture." })],
    });

    mocks.limitsFor.mockReturnValue(undefined);
    mocks.listShots.mockReturnValue([
      shot("previous", { clipFileId: "clip" }),
      shot("joined", { stillFileId: "first" }),
    ]);
    expect(handler(handlers, "story_film_plan")({}, { listId: "list", kind: "video", continuous: true })).toMatchObject({
      joined: 1,
      shots: [expect.anything(), expect.objectContaining({ startsOnPrevious: true })],
    });

    mocks.listShots.mockReturnValue([shot("first"), shot("second")]);
    mocks.createJob.mockImplementationOnce(() => "first-job").mockImplementationOnce(() => { throw new Error("second refused"); });
    await expect(handler(handlers, "start_shot_list_job")({}, { listId: "list", kind: "image" }))
      .resolves.toEqual({ jobIds: ["first-job"], asked: 2, shortfall: "Only 1 of 2 could be started — second refused" });
  });

  it("submits valid studio requests after their validations", async () => {
    const { handlers } = fixture();
    await expect(handler(handlers, "start_studio_job")({}, { kind: "flashcards", scope: "section", refs: ["file"] }))
      .resolves.toBe("job-1");
  });

  it("starts only actionable shot plans and preserves zero and over-limit refusals", async () => {
    const { handlers } = fixture();
    const shot = (id: string) => ({ id, action: "walks", castIds: [], seconds: 5, imageModel: "image", videoModel: "video", stillFileId: null, clipFileId: null });
    mocks.listShots.mockReturnValue([shot("one")]);

    await expect(handler(handlers, "start_shot_list_job")({}, { listId: "list", kind: "image" }))
      .resolves.toEqual({ jobIds: ["job-1"], asked: 1, shortfall: null });
    mocks.listShots.mockReturnValue([]);
    await expect(handler(handlers, "start_shot_list_job")({}, { listId: "list", kind: "video" }))
      .rejects.toThrow("Nothing to film");
    mocks.listShots.mockReturnValue(Array.from({ length: 81 }, (_, index) => shot(`shot-${index}`)));
    await expect(handler(handlers, "start_shot_list_job")({}, { listId: "list", kind: "image" }))
      .rejects.toThrow("81 generations in one go");
  });
});
