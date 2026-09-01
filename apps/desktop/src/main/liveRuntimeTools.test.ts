import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom } from "./db-host/open.js";
import { insertFile, setFileExtractedText } from "./db-host/files.js";
import { createJob, getJob, listJobs, setJobStatus } from "./db-host/jobs.js";
import { CancelFlag, createCancelState } from "./cancel.js";
import { createRoomManagerState } from "./roomManager.js";
import { createLiveRuntimeTool } from "./liveRuntimeTools.js";
import { createToolEffects } from "./execTool.js";
import { SttModelState, sttModelPath } from "./sttTools.js";
import type { Browser } from "./browser/browser.js";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";

const runtimeMocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ ok: true as const, text: "created" })),
  rename: vi.fn(async () => ({ ok: true as const, text: "renamed" })),
  move: vi.fn(async () => ({ ok: true as const, text: "moved" })),
  organize: vi.fn(async () => ({ ok: true as const, text: "organized" })),
  trash: vi.fn(async () => ({ ok: true as const, text: "trashed" })),
  merge: vi.fn(async () => ({ ok: true as const, text: "merged" })),
  locate: vi.fn(async () => []),
  scripts: vi.fn(async () => "No scripts."),
  runScript: vi.fn(async () => ""),
  skillScript: vi.fn(async () => "Skill ran."),
  readRecording: vi.fn(async () => "read-job"),
  fetchPage: vi.fn(async () => ({ title: "Example", text: "Saved page" })),
  downloadTemp: vi.fn(),
  importDownload: vi.fn(async () => ({ name: "downloaded.txt" })),
  startDownload: vi.fn(() => "download-job"),
  listModels: vi.fn(async () => ["local-model"]),
  resolveModel: vi.fn(() => "local-model"),
  generate: vi.fn(async () => "answer"),
  structured: vi.fn(async () => "structured answer"),
  filePass: vi.fn(async () => ({ message: "Full file pass ready", meta: null })),
}));

vi.mock("./organizeTools.js", () => ({
  execCreateFileWorkspace: runtimeMocks.create,
  execRenameFileWorkspace: runtimeMocks.rename,
  execMoveFileWorkspace: runtimeMocks.move,
  execOrganizeFilesWorkspace: runtimeMocks.organize,
  execTrashFilesWorkspace: runtimeMocks.trash,
  execMergeFilesWorkspace: runtimeMocks.merge,
}));
vi.mock("./visionTools.js", () => ({ locateInImage: runtimeMocks.locate }));
vi.mock("./scriptConsent.js", () => ({
  agentListScriptsInRoom: runtimeMocks.scripts,
  clampScriptOutput: (_name: string, output: string) => output,
  scriptOutput: () => "Script output",
}));
vi.mock("./scriptSurfaceIpc.js", () => ({
  createScriptBytesApprovalRequester: () => async () => true,
  runScriptFile: runtimeMocks.runScript,
}));
vi.mock("./skillsCmds.js", () => ({ agentRunSkillScript: runtimeMocks.skillScript }));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: () => true }));
vi.mock("./privacy.js", () => ({ outboundUrlHides: () => null }));
vi.mock("./webFetch.js", () => ({
  INLINE_DOWNLOAD_BYTES: 64 * 1024 * 1024,
  downloadToTemp: runtimeMocks.downloadTemp,
  fetchReadable: runtimeMocks.fetchPage,
  youtubeTranscript: vi.fn(),
  youtubeVideoId: () => null,
}));
vi.mock("./mediaDownloadSurfaceIpc.js", () => ({
  createDownloadEngineDeps: () => ({ importDownload: runtimeMocks.importDownload }),
}));
vi.mock("./jobDownload.js", () => ({ DOWNLOAD_ENGINE_FETCH: "fetch", startDownloadJobInner: runtimeMocks.startDownload }));
vi.mock("./recRead.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./recRead.js")>(),
  startRecRead: runtimeMocks.readRecording,
}));
vi.mock("./engineRouting.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./engineRouting.js")>(),
  listModels: runtimeMocks.listModels,
}));
vi.mock("./toolSpecs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./toolSpecs.js")>(),
  resolveLocalGenerateModel: runtimeMocks.resolveModel,
}));
vi.mock("./ollamaGenerate.js", () => ({ chatStructured: runtimeMocks.structured, generate: runtimeMocks.generate }));
vi.mock("./filePass.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./filePass.js")>(),
  driveFilePass: runtimeMocks.filePass,
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live retranscribe_file", () => {
  it("waits for terminal transcript storage and returns a durable completion receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-live-stt-"));
    roots.push(root);
    const roomPath = path.join(root, "room.roomai");
    const userDataDir = path.join(root, "user-data");
    const modelPath = sttModelPath(userDataDir);
    await mkdir(path.dirname(modelPath), { recursive: true });
    await writeFile(modelPath, "installed model marker");

    const db = createRoom(roomPath, "correct horse battery staple", "STT test");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "STT test", password: "correct horse battery staple" };
    const media = insertFile(db, "interview.flac", "audio/flac", Buffer.from("audio"), null, "import");
    try {
      const runtime = createLiveRuntimeTool({
        state,
        roomDeps: { userDataDir, spawnRoomServerIfEnabled: () => undefined },
        userDataDir,
        resourcesPath: null,
        emit: () => undefined,
        browser: {} as Browser,
        agentUi: {} as AgentUiRuntime,
        sttModelState: new SttModelState(),
        retranscribe: async (_state, _data, _resources, _emit, fileId) => {
          expect(fileId).toBe(media.id);
          setFileExtractedText(db, fileId, "Hello from the finished transcript.");
        },
      });

      const result = await runtime("retranscribe_file", { name: "interview.flac" }, createToolEffects());
      expect(result).toMatchObject({ ok: true });
      expect(result?.ok && result.text).toContain("TRANSCRIPTION_RECEIPT");
      expect(result?.ok && result.text).toContain('"status":"completed"');
      expect(result?.ok && result.text).toContain("Hello from the finished transcript.");
      expect(listJobs(db)).toEqual([
        expect.objectContaining({ kind: "retranscribe", status: "done", cursor: 1, total: 1 }),
      ]);
      expect(listJobs(db)[0]?.state).toMatchObject({
        fileId: media.id,
        status: "completed",
        characters: 35,
      });
    } finally {
      state.room = null;
      db.close();
    }
  });

  it("keeps runtime validation, unavailable-model, and no-workspace outcomes distinct", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-live-runtime-"));
    roots.push(root);
    const roomPath = path.join(root, "room.roomai");
    const userDataDir = path.join(root, "user-data");
    const db = createRoom(roomPath, "correct horse battery staple", "Runtime test");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Runtime test", password: "correct horse battery staple" };
    const media = insertFile(db, "interview.flac", "audio/flac", Buffer.from("audio"), null, "import");
    const roomDeps = { userDataDir, spawnRoomServerIfEnabled: () => undefined };
    const runtime = createLiveRuntimeTool({
      state,
      roomDeps,
      userDataDir,
      resourcesPath: null,
      emit: () => undefined,
      browser: {} as Browser,
      agentUi: {} as AgentUiRuntime,
      sttModelState: new SttModelState(),
    });
    try {
      await expect(runtime("create_file", {}, createToolEffects())).resolves.toBeNull();
      await expect(runtime("not_a_runtime_tool", {}, createToolEffects())).resolves.toBeNull();
      await expect(runtime("job_status", {}, createToolEffects())).resolves.toEqual({ ok: true, text: "There are no background jobs in this room." });
      await expect(runtime("stt_status", {}, createToolEffects())).resolves.toEqual({
        ok: true,
        text: expect.stringContaining("not installed"),
      });
      await expect(runtime("retranscribe_file", { name: media.name }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: expect.stringContaining("not installed"),
      });
      await expect(runtime("edit_file", { name: "notes.md", old_text: "" }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: "old_text is required — copy the exact text to replace.",
      });
      await expect(runtime("set_cells", { name: "table.xlsx", updates: [] }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: "No cells given — pass updates: [{cell, value}, …].",
      });
      await expect(runtime("local_generate", { prompt: "  " }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: "local_generate needs a non-empty `prompt`.",
      });
      await expect(runtime("start_file_pass", { name: media.name }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: "The background job queue is unavailable.",
      });
      state.room = null;
      await expect(runtime("job_status", {}, createToolEffects())).resolves.toEqual({ ok: false, error: "No room is open." });
    } finally {
      state.room = null;
      db.close();
    }
  });

  it("records a failed retranscription without leaving the file marked busy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-live-stt-error-"));
    roots.push(root);
    const roomPath = path.join(root, "room.roomai");
    const userDataDir = path.join(root, "user-data");
    const modelPath = sttModelPath(userDataDir);
    await mkdir(path.dirname(modelPath), { recursive: true });
    await writeFile(modelPath, "installed model marker");
    const db = createRoom(roomPath, "correct horse battery staple", "STT error test");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "STT error test", password: "correct horse battery staple" };
    const media = insertFile(db, "broken.flac", "audio/flac", Buffer.from("audio"), null, "import");
    const runtime = createLiveRuntimeTool({
      state,
      roomDeps: { userDataDir, spawnRoomServerIfEnabled: () => undefined },
      userDataDir,
      resourcesPath: null,
      emit: () => undefined,
      browser: {} as Browser,
      agentUi: {} as AgentUiRuntime,
      sttModelState: new SttModelState(),
      retranscribe: async () => { throw new Error("decoder stopped"); },
    });
    try {
      await expect(runtime("retranscribe_file", { name: media.name }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: expect.stringContaining("decoder stopped"),
      });
      expect(listJobs(db)).toEqual([expect.objectContaining({ kind: "retranscribe", status: "error", error: "decoder stopped" })]);
      await expect(runtime("retranscribe_file", { name: media.name }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: expect.stringContaining("decoder stopped"),
      });
    } finally {
      state.room = null;
      db.close();
    }
  });

  it("runs file-pass queue rows with fake engine work and preserves terminal outcomes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-live-file-pass-"));
    roots.push(root);
    const roomPath = path.join(root, "room.roomai");
    const userDataDir = path.join(root, "user-data");
    const db = createRoom(roomPath, "correct horse battery staple", "File pass test");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "File pass test", password: "correct horse battery staple" };
    const progress: unknown[] = [];
    const queue = {
      state: { runningJob: null },
      rooms: { current: () => state.room === null ? null : { db, path: roomPath } },
      sink: { emit: (event: unknown) => progress.push(event) },
      cancelState: createCancelState(),
      starters: new Map(),
    };
    const roomDeps = { userDataDir, spawnRoomServerIfEnabled: () => undefined, jobQueue: queue };
    const runtime = createLiveRuntimeTool({
      state,
      roomDeps,
      userDataDir,
      resourcesPath: null,
      emit: () => undefined,
      browser: {} as Browser,
      agentUi: {} as AgentUiRuntime,
      sttModelState: new SttModelState(),
    });
    const starter = roomDeps.jobQueue.starters.get("file_pass");
    if (!starter) throw new Error("file pass starter was not registered");
    const start = async (plan: unknown): Promise<string> => {
      const jobId = createJob(db, "file_pass", "Full pass — notes.md", plan, 1);
      await expect(starter(roomDeps.jobQueue, getJob(db, jobId), roomPath, new CancelFlag())).resolves.toEqual({ kind: "runner" });
      return jobId;
    };
    try {
      runtimeMocks.filePass.mockReset();
      runtimeMocks.filePass.mockImplementationOnce(async (deps: { resolveEngine(): Promise<unknown> }) => {
        await deps.resolveEngine();
        return { message: "Finished notes", meta: null };
      });
      const finished = await start({ fileId: "file-1", fileName: "notes.md", instruction: "summarize", mode: "merge" });
      await vi.waitFor(() => expect(getJob(db, finished).status).toBe("done"));
      expect(progress).toContainEqual(expect.objectContaining({ jobId: finished, finished: true, label: "Finished notes" }));

      runtimeMocks.filePass.mockRejectedValueOnce(new Error("model stopped"));
      const failed = await start({ fileId: "file-2", fileName: "notes.md" });
      await vi.waitFor(() => expect(getJob(db, failed).status).toBe("error"));
      expect(getJob(db, failed).error).toBe("model stopped");
      expect(progress).toContainEqual(expect.objectContaining({ jobId: failed, failed: true }));

      runtimeMocks.filePass.mockRejectedValueOnce(new Error("STOPPED"));
      const paused = await start({ fileId: "file-3", fileName: "notes.md" });
      await vi.waitFor(() => expect(getJob(db, paused).status).toBe("paused"));
      expect(getJob(db, paused).error).toBeNull();
      expect(progress).toContainEqual(expect.objectContaining({ jobId: paused, paused: true }));

      const malformed = createJob(db, "file_pass", "Broken pass", {}, 1);
      await expect(starter(roomDeps.jobQueue, getJob(db, malformed), roomPath, new CancelFlag())).resolves.toEqual({
        kind: "error",
        message: "This file pass has an unreadable plan.",
      });
      const nullPlan = createJob(db, "file_pass", "Null pass", null, 1);
      await expect(starter(roomDeps.jobQueue, getJob(db, nullPlan), roomPath, new CancelFlag())).resolves.toEqual({
        kind: "error",
        message: "This file pass has an unreadable plan.",
      });

      db.prepare("UPDATE jobs SET id = ? WHERE id = ?").run("shared-done", finished);
      db.prepare("UPDATE jobs SET id = ? WHERE id = ?").run("shared-error", failed);
      const listed = await runtime("job_status", {}, createToolEffects());
      expect(listed).toMatchObject({ ok: true, text: expect.stringContaining("shared-d") });
      await expect(runtime("job_status", { job_id: "shared-error" }, createToolEffects())).resolves.toMatchObject({
        ok: true,
        text: expect.stringContaining("Error: model stopped"),
      });
      await expect(runtime("job_status", { job_id: "shared" }, createToolEffects())).resolves.toMatchObject({
        ok: true,
        text: expect.stringContaining("be more specific"),
      });
      await expect(runtime("job_status", { job_id: "absent" }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: expect.stringContaining("No background job matches"),
      });
    } finally {
      state.room = null;
      db.close();
    }
  });

  it("routes each non-network runtime tool arm through its matching helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-live-runtime-arms-"));
    roots.push(root);
    const roomPath = path.join(root, "room.roomai");
    const userDataDir = path.join(root, "user-data");
    const db = createRoom(roomPath, "correct horse battery staple", "Runtime arms test");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Runtime arms test", password: "correct horse battery staple" };
    const note = insertFile(db, "notes.md", "text/markdown", Buffer.from("before"), "before", "import");
    const image = insertFile(db, "photo.png", "image/png", Buffer.from("image"), null, "import");
    insertFile(db, "table.csv", "text/csv", Buffer.from("before,after\nthird,fourth"), "before,after\nthird,fourth", "import");
    const roomDeps = { userDataDir, spawnRoomServerIfEnabled: () => undefined };
    const runtime = createLiveRuntimeTool({
      state,
      roomDeps,
      userDataDir,
      resourcesPath: null,
      emit: () => undefined,
      browser: {} as Browser,
      agentUi: {} as AgentUiRuntime,
      sttModelState: new SttModelState(),
    });
    try {
      state.room.workspace = {} as never;
      for (const [name, text] of [
        ["create_file", "created"], ["rename_file", "renamed"], ["move_file", "moved"],
        ["organize_files", "organized"], ["trash_files", "trashed"], ["merge_files", "merged"],
      ]) {
        await expect(runtime(name, {}, createToolEffects())).resolves.toEqual({ ok: true, text });
      }
      state.room.workspace = undefined;
      const effects = createToolEffects();
      await expect(runtime("mark_image", { image_name: image.name, find: "person" }, effects)).resolves.toEqual({
        ok: true,
        text: `I couldn't find person in "${image.name}".`,
      });
      await expect(runtime("mark_image", { image_name: image.name, find: "person" }, effects)).resolves.toEqual({
        ok: true,
        text: `The image "${image.name}" is already marked.`,
      });
      runtimeMocks.locate.mockResolvedValueOnce([{}]);
      await expect(runtime("mark_image", { image_name: image.name, find: "person" }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: `Marked 1 match for person in "${image.name}".`,
      });
      await expect(runtime("edit_file", {
        name: note.name, old_text: "before", new_text: "after", dry_run: true,
      }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Dry run only") });
      await expect(runtime("edit_files", {
        edits: [{ name: note.name, old_text: "before", new_text: "after" }], dry_run: true,
      }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Dry run only") });
      await expect(runtime("edit_file", {
        name: note.name, old_text: "before", new_text: "after",
      }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Replaced 1 occurrence") });
      await expect(runtime("edit_files", {
        edits: [{ name: note.name, old_text: "after", new_text: "final" }],
      }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Applied 1 change") });
      await expect(runtime("write_file", {
        name: note.name, content: "Replacement document",
      }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining(`Rewrote "${note.name}"`) });
      await expect(runtime("set_cells", {
        name: "table.csv", updates: [{ cell: "A1", value: "changed" }],
      }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Set A1=changed") });
      await expect(runtime("list_scripts", {}, createToolEffects())).resolves.toEqual({ ok: true, text: "No scripts." });
      await expect(runtime("read_recording", { name: note.name }, createToolEffects())).resolves.toEqual({
        ok: false,
        error: "The background job queue is unavailable.",
      });
      roomDeps.jobQueue = { starters: new Map() } as never;
      runtimeMocks.readRecording.mockImplementationOnce(async (_queue, options) => {
        const recorder = options as { resolvePassEngine(): Promise<unknown>; onReadDone(event: unknown): void };
        await recorder.resolvePassEngine();
        recorder.onReadDone({});
        return "read-job";
      });
      await expect(runtime("read_recording", { name: note.name }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: `Started reading "${note.name}" as background job read-job. Chapters, highlights and notes appear when it finishes.`,
      });
      const scriptJob = createJob(db, "script", "Run script", {}, 1);
      setJobStatus(db, scriptJob, "done", null);
      runtimeMocks.runScript.mockResolvedValueOnce(scriptJob);
      await expect(runtime("run_script", { name: note.name }, createToolEffects())).resolves.toEqual({ ok: true, text: "Script output" });
      const waitingScriptJob = createJob(db, "script", "Wait for script", {}, 1);
      setJobStatus(db, waitingScriptJob, "running", null);
      runtimeMocks.runScript.mockResolvedValueOnce(waitingScriptJob);
      setTimeout(() => setJobStatus(db, waitingScriptJob, "done", null), 10);
      await expect(runtime("run_script", { name: note.name }, createToolEffects())).resolves.toEqual({ ok: true, text: "Script output" });
      await expect(runtime("job_status", {}, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Run script") });
      await expect(runtime("run_skill_script", {}, createToolEffects())).resolves.toEqual({ ok: true, text: "Skill ran." });
      await expect(runtime("save_link", { url: "https://example.test/page" }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: "Saved \"Example.md\" into the room.",
      });
      const downloaded = path.join(root, "download.txt");
      await writeFile(downloaded, "download");
      runtimeMocks.downloadTemp.mockResolvedValueOnce({ kind: "downloaded", downloaded: { path: downloaded, fileName: "download.txt" } });
      await expect(runtime("download_url", { url: "https://example.test/download" }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: "Downloaded \"downloaded.txt\" into the room.",
      });
      runtimeMocks.downloadTemp.mockResolvedValueOnce({ kind: "tooLarge" });
      await expect(runtime("download_url", { url: "https://example.test/large" }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: "This file is larger than 64 MB, so it is continuing as background job download-job. Track it with job_status.",
      });
      await expect(runtime("local_generate", { prompt: "Say hi", system: "Be terse" }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: "answer",
      });
      await expect(runtime("local_generate", { prompt: "Use JSON", schema: { type: "object" } }, createToolEffects())).resolves.toEqual({
        ok: true,
        text: "structured answer",
      });
    } finally {
      state.room = null;
      db.close();
    }
  });
});
