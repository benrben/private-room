/** Cohesive extraction from execTool.ts; its public API remains on that module. */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { webAccessEnabled } from "./browser/webAccess.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  memoriesLike,
  updateMemory,
  type Memory,
} from "./db-host/memories.js";
import {
  createSkill as createSkillDb,
  deleteSkillResource as deleteSkillResourceDb,
  findSkill as findSkillDb,
  getSkillResource as getSkillResourceDb,
  listSkillResources as listSkillResourcesDb,
  listSkills as listSkillsDb,
  setSkillEnabled as setSkillEnabledDb,
  updateSkill as updateSkillDb,
  upsertSkillResource as upsertSkillResourceDb,
} from "./db-host/skills.js";
import { agentDeleteSkill, agentSaveSkill } from "./skillsCmds.js";
import {
  execAnnotateFile,
  execListRoomFiles,
  execOpenFile,
  execSearchRoom,
} from "./fileTools.js";
import {
  execDraw,
  execDrawInRoom,
  execReadDrawing,
  execReadDrawingInRoom,
  type SketchRoom,
} from "./sketchCommands.js";
import { execViewFileImage } from "./staticVisualTools.js";
import {
  agentDeleteMcp,
  agentListMcps,
  agentReadMcp,
  agentSaveMcp,
} from "./mcpConfig.js";
import type { ServerConfig } from "./mcpClient.js";
import {
  execCreateFile,
  execMarkImage,
  execMergeFiles,
  execMoveFile,
  execOrganizeFiles,
  execRenameFile,
  execSetInLibrary,
  execTrashFiles,
} from "./organizeTools.js";
import {
  DOWNLOAD_ENGINE_MEDIA,
  startDownloadJobInner,
  type DownloadJobDeps,
} from "./jobDownload.js";
import { makeRunAdvisorCli, realRunAdvisorCli, type RunExternalOptions } from "./externalAdvisor.js";
import {
  agentDeleteWorkflow,
  agentListWorkflows,
  agentRunWorkflow,
  agentSaveWorkflow,
  agentTestWorkflow,
  agentUpdateWorkflow,
  type AgentTestWorkflowDeps,
} from "./workflowRuns.js";
import { DELETE_DECLINED } from "./mcpConfig.js";
import { getFreshWebPage, getFreshWebSearch, putWebSearch, saveWebPage } from "./db-host/webCache.js";
import { blockedNote, fetchPage, joinNames, renderHits, searchWeb, type FetchedPage, type SearchPage } from "./web.js";
import { fetchPageReply } from "./fetchPageWindow.js";
import { maskOutboundWeb as privacyMaskOutboundWeb, outboundUrlHides, webMaskNote } from "./privacy.js";
import { clampBytes, clampBytesMarked, normalizeForMatch } from "./textClamp.js";
import {
  BUILTIN_TOOL_NAMES,
  MAX_ADVISOR_CALLS,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_LISTED_MEMORIES,
  SKILL_AGENT_IDS,
  isBrowseTool,
  maskedArgsNote,
  masksOutboundArgs,
  type McpRoute,
} from "./toolSpecs.js";
import { missingRequiredArg } from "./toolSchema.js";
import { mindmapSpec, RUN_STUDIO_PIPELINE_GAP as RUN_STUDIO_PIPELINE_GAP_MINDMAP } from "./studiosMindmap.js";
import { EXEC_STUDIO_FLASHCARDS_GAP, execStudioFlashcards } from "./studiosFlashcards.js";
import { execStudio, type RunStudioDeps, type StudioSpec } from "./studiosCmds.js";
import { podcastSpec, RUN_STUDIO_PIPELINE_GAP as RUN_STUDIO_PIPELINE_GAP_PODCAST } from "./studiosPodcast.js";
import { execTool } from "./execToolDispatch.js";
import { ExecToolDeps, MediaFrameReceipt, ToolEffects, ToolOutcome, errMessage, fail, notImplemented, ok, requireRoom } from "./execToolEffects.js";
import { execAddMemory, execListMemories, execUpdateOrDeleteMemory } from "./execToolMemory.js";
import { execDeleteSkillResource, execListSkills, execReadSkill, execReadSkillResource, execSaveSkill, execWriteSkillResource } from "./execToolSkills.js";
// ------------------------------------------------------------ dispatch (Rust: match)

/**
 * The names {@link execTool} answers with a NAMED arm rather than the
 * connector-route fallthrough: `BUILTIN_TOOL_NAMES` MINUS the MCP proxy pair.
 *
 * `search_mcp_tools`/`run_mcp_tool` are intercepted one layer up, in
 * `bridgeDispatcher.ts` — the Rust `exec_tool` never receives either name as
 * `call.name` either, so an arm for them here would be dead code pretending to
 * be coverage.
 *
 * DERIVED, not written down: a hand-kept second copy of the tool list is
 * exactly the thing that drifts. The exhaustive test in `execTool.test.ts`
 * does not trust this constant either — it DRIVES every name through the real
 * `execTool` with schema-satisfying arguments and asserts none of them comes
 * back as the `Unknown tool:` fallthrough.
 */
export const NAMED_ARM_TOOL_NAMES: readonly string[] = BUILTIN_TOOL_NAMES.filter(
  (n) => n !== "search_mcp_tools" && n !== "run_mcp_tool"
);

export interface NamedToolCall {
  name: string;
  args: Record<string, unknown>;
  effects: ToolEffects;
  deps: ExecToolDeps;
}

export type NamedToolHandler = (call: NamedToolCall) => ToolOutcome | Promise<ToolOutcome>;
export type RoomToolAction = (db: Database.Database, call: NamedToolCall) => ToolOutcome;

export function normalizedToolArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {};
  }
  return rawArgs;
}

export async function execBrowseTool(call: NamedToolCall): Promise<ToolOutcome | null> {
  if (!isBrowseTool(call.name)) return null;
  if (call.deps.runtimeTool !== undefined) {
    const live = await call.deps.runtimeTool(call.name, call.args, call.effects);
    if (live !== null) return live;
  }
  return notImplemented(
    "the private browser's command surface (commands/browse.rs -> src/main/browser/) is a separate, in-progress porting effort this batch did not wire into exec_tool"
  );
}

export function execMappedRoomTool(call: NamedToolCall, actions: ReadonlyMap<string, RoomToolAction>): ToolOutcome {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  return actions.get(call.name)!(room.db, call);
}

export const MEMORY_ACTIONS: ReadonlyMap<string, RoomToolAction> = new Map([
  ["add_memory", (db, call) => execAddMemory(call.deps, db, call.args)],
  ["list_memories", (db) => execListMemories(db)],
  ["update_memory", (db, call) => execUpdateOrDeleteMemory(call.deps, db, "update_memory", call.args)],
  ["delete_memory", (db, call) => execUpdateOrDeleteMemory(call.deps, db, "delete_memory", call.args)],
]);

export function execMemoryTool(call: NamedToolCall): ToolOutcome {
  return execMappedRoomTool(call, MEMORY_ACTIONS);
}

export const SKILL_ACTIONS: ReadonlyMap<string, (deps: ExecToolDeps, args: Record<string, unknown>) => ToolOutcome> = new Map([
  ["list_skills", execListSkills],
  ["read_skill", execReadSkill],
  ["read_skill_resource", execReadSkillResource],
  ["save_skill", execSaveSkill],
  ["write_skill_resource", execWriteSkillResource],
  ["delete_skill_resource", execDeleteSkillResource],
]);

export function execSkillTool(call: NamedToolCall): ToolOutcome {
  return SKILL_ACTIONS.get(call.name)!(call.deps, call.args);
}

export const ROOM_READ_ACTIONS: ReadonlyMap<string, RoomToolAction> = new Map([
  ["list_room_files", (db) => execListRoomFiles(db)],
  ["search_room", (db, call) => execSearchRoom(db, call.args)],
  ["open_file", (db, call) => execOpenFile(db, call.args, call.deps.emit)],
  ["annotate_file", (db, call) => execAnnotateFile(db, call.args, call.effects, call.deps.emit)],
]);

export function execRoomReadTool(call: NamedToolCall): ToolOutcome {
  return execMappedRoomTool(call, ROOM_READ_ACTIONS);
}

export function execViewFileImageTool(call: NamedToolCall): ToolOutcome | Promise<ToolOutcome> {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  return execViewFileImage(room.room ?? { db: room.db, path: "" }, call.args, call.effects);
}

export type RoomRuntimeAction = (db: Database.Database, call: NamedToolCall) => ToolOutcome;

export const ORGANIZE_RUNTIME_ACTIONS: ReadonlyMap<string, RoomRuntimeAction> = new Map([
  ["mark_image", (db, call) => execMarkImage(db, call.args, call.effects)],
  [
    "create_file",
    (db, call) => execCreateFile(db, call.args, call.effects, {
      runId: call.deps.runId,
      cancel: call.deps.cancel,
      emit: call.deps.emit,
    }),
  ],
  ["rename_file", (db, call) => execRenameFile(db, call.args, call.effects, call.deps.emit)],
  ["move_file", (db, call) => execMoveFile(db, call.args, call.effects, call.deps.emit)],
  ["organize_files", (db, call) => execOrganizeFiles(db, call.args, call.effects, call.deps.emit)],
  ["trash_files", (db, call) => execTrashFiles(db, call.args, call.effects, call.deps.emit)],
  ["merge_files", (db, call) => execMergeFiles(db, call.args, call.effects, call.deps.emit)],
]);

export async function execRuntimeOverride(
  call: NamedToolCall,
  fallback: () => ToolOutcome | Promise<ToolOutcome>
): Promise<ToolOutcome> {
  if (call.deps.runtimeTool === undefined) return fallback();
  const live = await call.deps.runtimeTool(call.name, call.args, call.effects);
  if (live !== null) return live;
  return fallback();
}

export function execRoomRuntimeTool(call: NamedToolCall): Promise<ToolOutcome> {
  const room = requireRoom(call.deps);
  if (!room.ok) return Promise.resolve(fail(room.error));
  return execRuntimeOverride(call, () => ORGANIZE_RUNTIME_ACTIONS.get(call.name)!(room.db, call));
}

export const SET_LIBRARY_ACTIONS: ReadonlyMap<string, RoomToolAction> = new Map([
  ["set_in_library", (db, call) => execSetInLibrary(db, call.args, call.effects, call.deps.emit)],
]);

export function execSetInLibraryTool(call: NamedToolCall): ToolOutcome {
  return execMappedRoomTool(call, SET_LIBRARY_ACTIONS);
}

export function execEditTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented("the edit_match.rs port (diff-preview gate + fuzzy/section matching) — Batch D")
  );
}

export function uiKind(name: string): "ui_snapshot" | "ui_act" | "view_screenshot" | "media_frame" {
  return name === "view_media_frame" ? "media_frame" : name as "ui_snapshot" | "ui_act" | "view_screenshot";
}

export function asUiPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : { value: payload };
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function mediaFrameDimensions(value: Record<string, unknown>): [number, number] {
  return [finiteNumber(value.width) ?? 0, finiteNumber(value.height) ?? 0];
}

export function mediaFrameFileName(args: Record<string, unknown>): string {
  return typeof args.name === "string" ? args.name : "video";
}

export function mediaFrameRequestedAt(args: Record<string, unknown>): string {
  const at = args.at;
  return typeof at === "string" || typeof at === "number" ? String(at) : "0";
}

export function rendererHashMatches(value: Record<string, unknown>, sha256: string): boolean {
  const rendererHash = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  return rendererHash === "" || rendererHash === sha256;
}

export function mediaFrameReceipt(
  value: Record<string, unknown>,
  args: Record<string, unknown>,
  imageB64: string
): { receipt: MediaFrameReceipt } | { error: string } {
  const bytes = Buffer.from(imageB64, "base64");
  if (bytes.length === 0) return { error: "That video frame arrived empty." };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!rendererHashMatches(value, sha256)) {
    return { error: "That video frame failed its SHA-256 receipt check." };
  }
  const actualSeconds = finiteNumber(value.atSeconds);
  if (actualSeconds === null) {
    return { error: "That video frame arrived without its exact timestamp." };
  }
  const [width, height] = mediaFrameDimensions(value);
  return {
    receipt: {
      fileName: mediaFrameFileName(args),
      requestedAt: mediaFrameRequestedAt(args),
      actualSeconds,
      sha256,
      width,
      height,
    },
  };
}

export function mediaFrameNote(value: Record<string, unknown>, receipt: MediaFrameReceipt): string {
  return typeof value.note === "string"
    ? value.note
    : `Frame receipt: ${receipt.fileName} at ${receipt.actualSeconds.toFixed(3)}s; ` +
      `SHA-256 ${receipt.sha256}; ${receipt.width}×${receipt.height} PNG.`;
}

export function execUiImage(call: NamedToolCall, value: Record<string, unknown>, imageB64: string): ToolOutcome {
  const result = mediaFrameReceipt(value, call.args, imageB64);
  if ("error" in result) return fail(result.error);
  call.effects.pendingImages.push(imageB64);
  call.effects.mediaFrames.push(result.receipt);
  return ok(mediaFrameNote(value, result.receipt));
}

export function execUiPayload(call: NamedToolCall, payload: unknown): ToolOutcome {
  const value = asUiPayload(payload);
  if (typeof value.error === "string") return fail(value.error);
  const imageB64 = nonEmptyString(value.imageB64);
  if (imageB64 !== null) return execUiImage(call, value, imageB64);
  return ok(JSON.stringify(value, null, 2));
}

export async function execUiTool(call: NamedToolCall): Promise<ToolOutcome> {
  const agentUi = call.deps.agentUi;
  if (agentUi === undefined) {
    return notImplemented("the live renderer AgentUi broker is not attached to this tool context");
  }
  try {
    return execUiPayload(call, await agentUi(uiKind(call.name), call.args));
  } catch (error) {
    return fail(errMessage(error));
  }
}
