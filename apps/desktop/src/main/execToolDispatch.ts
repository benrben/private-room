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
import { execConsultAdvisor, withRealPrivacyGates } from "./execToolAdvisor.js";
import { execConnectorRoute, execDownloadMedia } from "./execToolConnectors.js";
import { NamedToolCall, NamedToolHandler, execBrowseTool, execEditTool, execMemoryTool, execRoomReadTool, execRoomRuntimeTool, execRuntimeOverride, execSetInLibraryTool, execSkillTool, execUiTool, execViewFileImageTool, normalizedToolArgs } from "./execToolDispatchCore.js";
import { ExecToolDeps, ToolEffects, ToolOutcome, emitSafely, errMessage, fail, notImplemented, ok, requireRoom } from "./execToolEffects.js";
import { asString } from "./execToolMemory.js";
import { execFetchPage, execWebSearch } from "./execToolWeb.js";
export function execWebSearchTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execWebSearch(call.deps, call.effects, call.args);
}

export function execFetchPageTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execFetchPage(call.deps, call.args);
}

export function execSaveLinkTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented(
      "commands/files.rs's import_link_and_index (the save-as-Markdown / YouTube-transcript " +
        "ingestion funnel behind save_link) — Batch D. Its two READ engines are already ported " +
        "and tested as web.ts's fetchReadable/youtubeTranscript; do not re-port web/fetch.rs"
    )
  );
}

export function execDownloadUrlTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented(
      "commands/files.rs's import_download (staged temp file → room file), plus the " +
        "outbound_url_hides cloud-privacy gate every download/save tool checks first — Batch D. " +
        "The guarded download engine itself IS ported and tested (web/fetch.rs's " +
        "download_to_temp is web.ts's downloadToTemp), as is the privacy check (privacy.ts, " +
        "installed via withRealPrivacyGates); do not re-port either. download_media (yt-dlp's " +
        "media engine) is wired for real; see that arm"
    )
  );
}

export function execDownloadMediaTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execDownloadMedia(call.deps, call.args);
}

export function execScriptsTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented("the Scripts subsystem (fingerprint consent + script execution) — Batch D")
  );
}

export function execReadDrawingTool(call: NamedToolCall): ToolOutcome | Promise<ToolOutcome> {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  return room.room === null
    ? execReadDrawing(room.db, call.args, call.effects)
    : execReadDrawingInRoom(room.room, call.args, call.effects);
}

export function execDrawTool(call: NamedToolCall): ToolOutcome | Promise<ToolOutcome> {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  return room.room === null
    ? execDraw(room.db, call.args, call.deps.emit)
    : execDrawInRoom(room.room, call.args, call.deps.emit);
}

export function unavailableStudioTool(name: string): ToolOutcome {
  switch (name) {
    case "studio_mindmap":
      return notImplemented(RUN_STUDIO_PIPELINE_GAP_MINDMAP);
    case "generate_podcast_script":
      return notImplemented(RUN_STUDIO_PIPELINE_GAP_PODCAST);
    default:
      return notImplemented(EXEC_STUDIO_FLASHCARDS_GAP);
  }
}

export function studioParentRun(call: NamedToolCall): string | null {
  return call.deps.runId === undefined ? null : call.deps.runId;
}

export function studioSpecForTool(name: string): StudioSpec {
  return name === "studio_mindmap" ? mindmapSpec() : podcastSpec();
}

export async function runStudioTool(call: NamedToolCall, studioDeps: RunStudioDeps): Promise<ToolOutcome> {
  try {
    if (call.name === "studio_flashcards") {
      const receipt = await execStudioFlashcards(studioDeps, studioParentRun(call), call.args);
      call.effects.wrote = true;
      return ok(receipt);
    }
    const receipt = await execStudio(studioDeps, studioSpecForTool(call.name), studioParentRun(call), call.args);
    call.effects.wrote = true;
    return ok(receipt);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execStudioTool(call: NamedToolCall): Promise<ToolOutcome> {
  const studioDeps = call.deps.runStudioDeps;
  if (studioDeps === undefined) return Promise.resolve(unavailableStudioTool(call.name));
  return runStudioTool(call, studioDeps);
}

export function execSttTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented("rec/engine.py's on-device STT surface — Batch C/D")
  );
}

export async function execDeleteSkillTool(call: NamedToolCall): Promise<ToolOutcome> {
  const confirmDestructive = call.deps.confirmDestructive;
  if (confirmDestructive === undefined) {
    return notImplemented(
      "the confirm_destructive consent dialog for a skill deletion is not wired up — Batch D"
    );
  }
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    const text = await agentDeleteSkill(room.db, call.args, confirmDestructive);
    emitSafely(call.deps, "skills-changed", undefined);
    return ok(text);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execRunSkillScriptTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented("skill script execution (fingerprint consent + the script runner) — Batch D")
  );
}

export function execListMcpsTool(call: NamedToolCall): ToolOutcome {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(agentListMcps(room.db, call.deps.mcpStatuses ?? new Map()));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execReadMcpTool(call: NamedToolCall): ToolOutcome {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(agentReadMcp(room.db, asString(call.args["name"])));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execSaveMcpTool(call: NamedToolCall): ToolOutcome {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(agentSaveMcp(room.db, call.args, {
      forgetConnectorGrants: call.deps.mcpForgetConnectorGrants,
      reconnect: call.deps.mcpReconnect,
    }));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execDeleteMcpTool(call: NamedToolCall): Promise<ToolOutcome> {
  const confirmDestructive = call.deps.confirmDestructive;
  if (confirmDestructive === undefined) {
    return notImplemented(
      "the confirm_destructive consent dialog for a connector deletion is not wired up — Batch D"
    );
  }
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    const text = await agentDeleteMcp(room.db, call.args, {
      confirmDestructive,
      forgetConnectorGrants: call.deps.mcpForgetConnectorGrants,
      reconnect: call.deps.mcpReconnect,
    });
    return ok(text);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execJobsTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented("the jobs/workflows backend (no db-host/jobs.ts yet) — Batch C")
  );
}

export function workflowName(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function execListWorkflowsTool(call: NamedToolCall): ToolOutcome {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(agentListWorkflows(room.db, workflowName(call.args["name"])));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execSaveWorkflowTool(call: NamedToolCall): Promise<ToolOutcome> {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(await agentSaveWorkflow(room.db, call.args, "agent", {}, call.deps.emit));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execUpdateWorkflowTool(call: NamedToolCall): Promise<ToolOutcome> {
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(await agentUpdateWorkflow(room.db, call.args, {}, call.deps.emit));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export const WORKFLOW_QUEUE_GAP =
  "the workflow job-queue wiring (an app-wide JobQueueDeps + the room's script-approvals " +
  "dir) is not connected to execTool yet — Batch D";

export async function execTestWorkflowTool(call: NamedToolCall): Promise<ToolOutcome> {
  const workflowRun = call.deps.workflowRun;
  if (workflowRun === undefined) return notImplemented(WORKFLOW_QUEUE_GAP);
  try {
    return ok(await agentTestWorkflow(workflowRun, call.args));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execDeleteWorkflowTool(call: NamedToolCall): Promise<ToolOutcome> {
  const confirmDestructive = call.deps.confirmDestructive;
  if (confirmDestructive === undefined) {
    return notImplemented(
      "the confirm_destructive consent dialog for a workflow deletion is not wired up — Batch D"
    );
  }
  const room = requireRoom(call.deps);
  if (!room.ok) return fail(room.error);
  try {
    const text = await agentDeleteWorkflow(
      room.db,
      call.args,
      confirmDestructive,
      DELETE_DECLINED,
      call.deps.workflowRun?.cancelState,
      call.deps.emit
    );
    return ok(text);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export async function execRunWorkflowTool(call: NamedToolCall): Promise<ToolOutcome> {
  const workflowRun = call.deps.workflowRun;
  if (workflowRun === undefined) return notImplemented(WORKFLOW_QUEUE_GAP);
  try {
    return ok(await agentRunWorkflow(workflowRun, call.args));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execLocalGenerateTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execRuntimeOverride(
    call,
    () => notImplemented("Ollama local-model execution (ollama.rs) — Batch D")
  );
}

export function execConsultAdvisorTool(call: NamedToolCall): Promise<ToolOutcome> {
  return execConsultAdvisor(call.deps, call.effects, call.args);
}

export const NAMED_TOOL_HANDLERS: ReadonlyMap<string, NamedToolHandler> = new Map<string, NamedToolHandler>([
  ["add_memory", execMemoryTool],
  ["list_memories", execMemoryTool],
  ["update_memory", execMemoryTool],
  ["delete_memory", execMemoryTool],
  ["list_skills", execSkillTool],
  ["read_skill", execSkillTool],
  ["read_skill_resource", execSkillTool],
  ["save_skill", execSkillTool],
  ["write_skill_resource", execSkillTool],
  ["delete_skill_resource", execSkillTool],
  ["list_room_files", execRoomReadTool],
  ["search_room", execRoomReadTool],
  ["open_file", execRoomReadTool],
  ["annotate_file", execRoomReadTool],
  ["view_file_image", execViewFileImageTool],
  ["mark_image", execRoomRuntimeTool],
  ["create_file", execRoomRuntimeTool],
  ["rename_file", execRoomRuntimeTool],
  ["move_file", execRoomRuntimeTool],
  ["organize_files", execRoomRuntimeTool],
  ["trash_files", execRoomRuntimeTool],
  ["merge_files", execRoomRuntimeTool],
  ["set_in_library", execSetInLibraryTool],
  ["edit_file", execEditTool],
  ["edit_files", execEditTool],
  ["write_file", execEditTool],
  ["set_cells", execEditTool],
  ["ui_snapshot", execUiTool],
  ["ui_act", execUiTool],
  ["view_screenshot", execUiTool],
  ["view_media_frame", execUiTool],
  ["read_skin", execUiTool],
  ["update_skin_draft", execUiTool],
  ["undo_skin_change", execUiTool],
  ["validate_skin", execUiTool],
  ["save_skin", execUiTool],
  ["web_search", execWebSearchTool],
  ["fetch_page", execFetchPageTool],
  ["save_link", execSaveLinkTool],
  ["download_url", execDownloadUrlTool],
  ["download_media", execDownloadMediaTool],
  ["list_scripts", execScriptsTool],
  ["run_script", execScriptsTool],
  ["read_drawing", execReadDrawingTool],
  ["draw", execDrawTool],
  ["studio_flashcards", execStudioTool],
  ["studio_mindmap", execStudioTool],
  ["generate_podcast_script", execStudioTool],
  ["stt_status", execSttTool],
  ["read_recording", execSttTool],
  ["retranscribe_file", execSttTool],
  ["delete_skill", execDeleteSkillTool],
  ["run_skill_script", execRunSkillScriptTool],
  ["list_mcps", execListMcpsTool],
  ["read_mcp", execReadMcpTool],
  ["save_mcp", execSaveMcpTool],
  ["delete_mcp", execDeleteMcpTool],
  ["start_file_pass", execJobsTool],
  ["job_status", execJobsTool],
  ["list_workflows", execListWorkflowsTool],
  ["save_workflow", execSaveWorkflowTool],
  ["update_workflow", execUpdateWorkflowTool],
  ["test_workflow", execTestWorkflowTool],
  ["delete_workflow", execDeleteWorkflowTool],
  ["run_workflow", execRunWorkflowTool],
  ["local_generate", execLocalGenerateTool],
  ["consult_advisor", execConsultAdvisorTool],
]);

/**
 * One tool call, dispatched by name. Ported from `exec_tool`'s outer shell —
 * see the module doc for exactly which arms are real vs. `NOT_IMPLEMENTED`
 * stubs.
 */
export async function execTool(
  name: string,
  rawArgs: Record<string, unknown>,
  effects: ToolEffects,
  deps: ExecToolDeps
): Promise<ToolOutcome> {
  const args = normalizedToolArgs(rawArgs);
  const missing = missingRequiredArg(name, args);
  if (missing !== null) return fail(missing);
  const call = { name, args, effects, deps };
  const browse = await execBrowseTool(call);
  if (browse !== null) return browse;
  const handler = NAMED_TOOL_HANDLERS.get(name);
  if (handler !== undefined) return handler(call);
  return execConnectorRoute(deps, effects, name, args);
}
