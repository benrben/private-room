/** Focused execution coverage for execTool's Map-dispatched live seams. */

import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./organizeTools.js", () => ({
  execCreateFile: vi.fn(() => ({ ok: true as const, text: "created" })),
  execMarkImage: vi.fn(() => ({ ok: true as const, text: "marked" })),
  execMergeFiles: vi.fn(() => ({ ok: true as const, text: "merged" })),
  execMoveFile: vi.fn(() => ({ ok: true as const, text: "moved" })),
  execOrganizeFiles: vi.fn(() => ({ ok: true as const, text: "organized" })),
  execRenameFile: vi.fn(() => ({ ok: true as const, text: "renamed" })),
  execSetInLibrary: vi.fn(() => ({ ok: true as const, text: "set" })),
  execTrashFiles: vi.fn(() => ({ ok: true as const, text: "trashed" })),
}));

vi.mock("./staticVisualTools.js", () => ({
  execViewFileImage: vi.fn(async () => ({ ok: true as const, text: "image" })),
}));

vi.mock("./sketchCommands.js", () => ({
  execDraw: vi.fn(() => ({ ok: true as const, text: "drawn" })),
  execDrawInRoom: vi.fn(() => ({ ok: true as const, text: "drawn in room" })),
  execReadDrawing: vi.fn(async () => ({ ok: true as const, text: "drawing" })),
  execReadDrawingInRoom: vi.fn(async () => ({ ok: true as const, text: "drawing in room" })),
}));

vi.mock("./studiosFlashcards.js", () => ({
  EXEC_STUDIO_FLASHCARDS_GAP: "flashcard gap",
  execStudioFlashcards: vi.fn(async () => "flashcards"),
}));

vi.mock("./studiosMindmap.js", () => ({
  RUN_STUDIO_PIPELINE_GAP: "mindmap gap",
  mindmapSpec: vi.fn(() => ({ kind: "mindmap" })),
}));

vi.mock("./studiosPodcast.js", () => ({
  RUN_STUDIO_PIPELINE_GAP: "podcast gap",
  podcastSpec: vi.fn(() => ({ kind: "podcast" })),
}));

vi.mock("./studiosCmds.js", () => ({
  execStudio: vi.fn(async () => "studio"),
}));

vi.mock("./skillsCmds.js", () => ({
  agentDeleteSkill: vi.fn(async () => "skill deleted"),
  agentSaveSkill: vi.fn(),
}));

vi.mock("./mcpConfig.js", () => ({
  DELETE_DECLINED: "delete declined",
  agentDeleteMcp: vi.fn(async () => "mcp deleted"),
  agentListMcps: vi.fn(() => "mcps"),
  agentReadMcp: vi.fn(() => "mcp"),
  agentSaveMcp: vi.fn(() => "mcp saved"),
}));

vi.mock("./workflowRuns.js", () => ({
  agentDeleteWorkflow: vi.fn(async () => "workflow deleted"),
  agentListWorkflows: vi.fn(() => "workflows"),
  agentRunWorkflow: vi.fn(async () => "workflow running"),
  agentSaveWorkflow: vi.fn(async () => "workflow saved"),
  agentTestWorkflow: vi.fn(async () => "workflow tested"),
  agentUpdateWorkflow: vi.fn(async () => "workflow updated"),
}));

import { agentDeleteSkill } from "./skillsCmds.js";
import { agentListMcps } from "./mcpConfig.js";
import type { SketchRoom } from "./sketchCommands.js";
import { execStudio } from "./studiosCmds.js";
import {
  agentDeleteWorkflow,
  agentListWorkflows,
  agentRunWorkflow,
  agentSaveWorkflow,
  agentTestWorkflow,
  agentUpdateWorkflow,
} from "./workflowRuns.js";
import { createToolEffects, execTool, type ExecToolDeps } from "./execTool.js";
import {
  mediaFrameNote,
  mediaFrameReceipt,
  ORGANIZE_RUNTIME_ACTIONS,
  type NamedToolCall,
} from "./execToolDispatchCore.js";
import { realOutboundUrlRefusal } from "./execToolAdvisor.js";
import { execCreateFile, execMarkImage } from "./organizeTools.js";

const db = {} as Database.Database;

function deps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
  return { db, routes: [], ...overrides };
}

afterEach(() => vi.clearAllMocks());

describe("media-frame receipt validation", () => {
  it("allows an ordinary URL when privacy has no protected name to hide", () => {
    expect(realOutboundUrlRefusal("https://example.com/public")).toBeNull();
  });

  it("rejects a renderer hash mismatch before recording an image", () => {
    const imageB64 = Buffer.from("frame bytes").toString("base64");
    expect(mediaFrameReceipt({ sha256: "not-the-hash", atSeconds: 1 }, { name: "clip.mp4" }, imageB64))
      .toEqual({ error: "That video frame failed its SHA-256 receipt check." });
  });

  it("builds a readable default note when the renderer supplies none", () => {
    expect(mediaFrameNote({}, {
      fileName: "clip.mp4",
      requestedAt: "1",
      actualSeconds: 1.25,
      sha256: "abc123",
      width: 640,
      height: 360,
    })).toBe("Frame receipt: clip.mp4 at 1.250s; SHA-256 abc123; 640×360 PNG.");
  });
});

describe("organized create-file dispatch", () => {
  it("dispatches mark-image through its room action", () => {
    const call: NamedToolCall = {
      name: "mark_image",
      args: { name: "frame.png" },
      effects: createToolEffects(),
      deps: deps(),
    };

    expect(ORGANIZE_RUNTIME_ACTIONS.get("mark_image")!(db, call)).toEqual({ ok: true, text: "marked" });
    expect(execMarkImage).toHaveBeenCalledWith(db, call.args, call.effects);
  });

  it("forwards the run context used to index a newly created artifact", () => {
    const call: NamedToolCall = {
      name: "create_file",
      args: { name: "note.md", content: "hello" },
      effects: createToolEffects(),
      deps: deps(),
    };

    expect(ORGANIZE_RUNTIME_ACTIONS.get("create_file")!(db, call)).toEqual({ ok: true, text: "created" });
    expect(execCreateFile).toHaveBeenCalledWith(db, call.args, call.effects, {
      runId: undefined,
      cancel: undefined,
      emit: undefined,
    });
  });
});

describe("execTool Map dispatch live seams", () => {
  it("describes connector images honestly when no local vision chat is available", async () => {
    const route = {
      catalogName: "files_preview",
      toolName: "preview",
      serverName: "files",
      remote: false,
      spec: { type: "function", function: { name: "files_preview", description: "preview", parameters: {} } },
    } as const;
    const effects = createToolEffects();
    const context = deps({
      routes: [route],
      connectorApproved: async () => true,
      callConnectorTool: async () => ({ text: "connector text", images: ["image-one", "image-two"] }),
    });

    const outcome = await execTool("files_preview", {}, effects, context);

    expect(outcome.ok && outcome.text).toContain('image 1 from "preview" could not be attached');
    expect(outcome.ok && outcome.text).toContain('image 2 from "preview" could not be attached');
    expect(effects.pendingImages).toEqual([]);
  });

  it("uses runtime overrides for browse calls and falls back after a null override", async () => {
    const runtimeTool = vi.fn(async (name: string) =>
      name === "browse_open" ? { ok: true as const, text: "live browse" } : null
    );
    await expect(execTool("browse_open", { url: "https://example.test" }, createToolEffects(), deps({ runtimeTool })))
      .resolves.toEqual({ ok: true, text: "live browse" });
    await expect(execTool("list_scripts", {}, createToolEffects(), deps({ runtimeTool })))
      .resolves.toMatchObject({ ok: false });
    await expect(execTool("create_file", { name: "note.md", content: "x" }, createToolEffects(), deps({ runtimeTool })))
      .resolves.toEqual({ ok: true, text: "created" });
  });

  it("preserves UI payload, receipt, and broker-error outcomes", async () => {
    const imageB64 = Buffer.from("frame bytes").toString("base64");
    let call = 0;
    const agentUi = vi.fn(async () => {
      call += 1;
      if (call === 1) return 7;
      if (call === 2) throw new Error("renderer down");
      if (call === 3) return { imageB64, atSeconds: null };
      return { imageB64, atSeconds: 1, width: 2, height: 3, note: "custom receipt" };
    });
    const effects = createToolEffects();
    const context = deps({ agentUi });

    await expect(execTool("ui_snapshot", {}, effects, context)).resolves.toEqual({ ok: true, text: "{\n  \"value\": 7\n}" });
    await expect(execTool("ui_snapshot", {}, effects, context)).resolves.toEqual({ ok: false, error: "renderer down" });
    await expect(execTool("view_media_frame", { name: "clip.mp4", at: "0:01" }, effects, context))
      .resolves.toEqual({ ok: false, error: "That video frame arrived without its exact timestamp." });
    await expect(execTool("view_media_frame", { name: "clip.mp4", at: "0:01" }, effects, context))
      .resolves.toEqual({ ok: true, text: "custom receipt" });
    expect(effects.pendingImages).toEqual([imageB64]);
  });

  it("forwards successful sketch, studio, deletion, and workflow calls", async () => {
    const studioDeps = {} as NonNullable<ExecToolDeps["runStudioDeps"]>;
    const workflowRun = {} as NonNullable<ExecToolDeps["workflowRun"]>;
    const context = deps({
      runStudioDeps: studioDeps,
      workflowRun,
      confirmDestructive: async () => true,
    });
    const effects = createToolEffects();

    await expect(execTool("read_drawing", { name: "diagram" }, effects, context)).resolves.toEqual({ ok: true, text: "drawing" });
    await expect(execTool("draw", { name: "diagram", script: "rect" }, effects, context)).resolves.toEqual({ ok: true, text: "drawn" });
    const liveRoom: SketchRoom = { db, path: "/tmp/room" };
    const liveContext = deps({ currentRoom: () => liveRoom });
    await expect(execTool("read_drawing", { name: "diagram" }, effects, liveContext)).resolves.toEqual({ ok: true, text: "drawing in room" });
    await expect(execTool("draw", { name: "diagram", script: "rect" }, effects, liveContext)).resolves.toEqual({ ok: true, text: "drawn in room" });
    await expect(execTool("studio_flashcards", {}, effects, context)).resolves.toEqual({ ok: true, text: "flashcards" });
    await expect(execTool("generate_podcast_script", {}, effects, context)).resolves.toEqual({ ok: true, text: "studio" });
    await expect(execTool("delete_skill", { skill: "s" }, effects, context)).resolves.toEqual({ ok: true, text: "skill deleted" });
    await expect(execTool("list_mcps", {}, effects, context)).resolves.toEqual({ ok: true, text: "mcps" });
    await expect(execTool("list_workflows", { name: "daily" }, effects, context)).resolves.toEqual({ ok: true, text: "workflows" });
    await expect(
      execTool("save_workflow", { name: "daily", definition: { version: 1, nodes: [], edges: [] } }, effects, context)
    ).resolves.toEqual({ ok: true, text: "workflow saved" });
    await expect(execTool("update_workflow", { name_or_id: "daily" }, effects, context)).resolves.toEqual({ ok: true, text: "workflow updated" });
    await expect(execTool("test_workflow", { name_or_id: "daily" }, effects, context)).resolves.toEqual({ ok: true, text: "workflow tested" });
    await expect(execTool("delete_workflow", { name_or_id: "daily" }, effects, context)).resolves.toEqual({ ok: true, text: "workflow deleted" });
    await expect(execTool("run_workflow", { name_or_id: "daily" }, effects, context)).resolves.toEqual({ ok: true, text: "workflow running" });
    expect(effects.wrote).toBe(true);
  });

  it("turns dispatch-seam failures into tool failures", async () => {
    const context = deps({
      runStudioDeps: {} as NonNullable<ExecToolDeps["runStudioDeps"]>,
      workflowRun: {} as NonNullable<ExecToolDeps["workflowRun"]>,
      confirmDestructive: async () => true,
    });
    vi.mocked(execStudio).mockRejectedValueOnce(new Error("studio failed"));
    vi.mocked(agentDeleteSkill).mockRejectedValueOnce(new Error("skill failed"));
    vi.mocked(agentListMcps).mockImplementationOnce(() => { throw new Error("mcp failed"); });
    vi.mocked(agentListWorkflows).mockImplementationOnce(() => { throw new Error("list failed"); });
    vi.mocked(agentSaveWorkflow).mockRejectedValueOnce(new Error("save failed"));
    vi.mocked(agentUpdateWorkflow).mockRejectedValueOnce(new Error("update failed"));
    vi.mocked(agentTestWorkflow).mockRejectedValueOnce(new Error("test failed"));
    vi.mocked(agentDeleteWorkflow).mockRejectedValueOnce(new Error("delete failed"));
    vi.mocked(agentRunWorkflow).mockRejectedValueOnce(new Error("run failed"));

    for (const [name, args, error] of [
      ["studio_mindmap", {}, "studio failed"],
      ["delete_skill", { skill: "s" }, "skill failed"],
      ["list_mcps", {}, "mcp failed"],
      ["list_workflows", {}, "list failed"],
      ["save_workflow", { name: "daily", definition: { version: 1, nodes: [], edges: [] } }, "save failed"],
      ["update_workflow", { name_or_id: "daily" }, "update failed"],
      ["test_workflow", { name_or_id: "daily" }, "test failed"],
      ["delete_workflow", { name_or_id: "daily" }, "delete failed"],
      ["run_workflow", { name_or_id: "daily" }, "run failed"],
    ] as const) {
      await expect(execTool(name, args, createToolEffects(), context)).resolves.toEqual({ ok: false, error });
    }
  });
});
