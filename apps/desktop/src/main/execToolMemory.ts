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
import { ExecToolDeps, ToolOutcome, emitSafely, ok } from "./execToolEffects.js";
// ---------------------------------------------------------------- memory arm

/**
 * UX-5: an existing memory whose normalized text equals `content`'s, if any.
 * Ported verbatim from `commands::library::duplicate_memory`.
 */
export function duplicateMemory(db: Database.Database, content: string): Memory | null {
  const norm = normalizeForMatch(content);
  return listMemories(db).find((m) => normalizeForMatch(m.content) === norm) ?? null;
}

/** Wave 1b (idea 5): fold a raw category string onto the fixed vocabulary.
 * Ported verbatim from `commands::library::normalize_category`. */
export function normalizeCategory(raw: string): string | null {
  switch (raw.trim().toLowerCase()) {
    case "preference":
      return "preference";
    case "fact":
      return "fact";
    case "project":
      return "project";
    case "instruction":
      return "instruction";
    default:
      return null;
  }
}

/** Ported verbatim from `format_memory_list`. */
export function formatMemoryList(memories: readonly Memory[]): string {
  const total = memories.length;
  const lines = memories.slice(0, MAX_LISTED_MEMORIES).map((m) =>
    m.category !== null ? `- [${m.category}] ${m.content}` : `- ${m.content}`
  );
  if (total > MAX_LISTED_MEMORIES) {
    lines.push(
      `…and ${total - MAX_LISTED_MEMORIES} more memories — ask about something more specific to find them.`
    );
  }
  return lines.join("\n");
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function execAddMemory(
  deps: ExecToolDeps,
  db: Database.Database,
  args: Record<string, unknown>
): ToolOutcome {
  const raw = asString(args.content);
  if ([...raw].length > MAX_MEMORY_CONTENT_CHARS) {
    return ok(
      `Memory too long (${[...raw].length} chars); save a shorter note under ${MAX_MEMORY_CONTENT_CHARS} characters.`
    );
  }
  const category = typeof args.category === "string" ? normalizeCategory(args.category) : null;
  if (duplicateMemory(db, raw) !== null) {
    return ok("Already remembered.");
  }
  addMemory(db, raw, category);
  emitSafely(deps, "memories-changed", undefined);
  return ok("Memory saved.");
}

export function execListMemories(db: Database.Database): ToolOutcome {
  const memories = listMemories(db);
  if (memories.length === 0) {
    return ok("No memories are saved in this room yet.");
  }
  return ok(formatMemoryList(memories));
}

export function execUpdateOrDeleteMemory(
  deps: ExecToolDeps,
  db: Database.Database,
  toolName: "update_memory" | "delete_memory",
  args: Record<string, unknown>
): ToolOutcome {
  const find = asString(args.find).trim();
  const missingFind = missingMemoryFindOutcome(find);
  if (missingFind !== null) return missingFind;
  const hits = memoriesLike(db, find.toLowerCase());
  const matchOutcome = memoryMatchOutcome(find, hits);
  if (matchOutcome !== null) return matchOutcome;
  const [id, old] = hits[0]!;
  if (toolName === "delete_memory") return deleteMemoryOutcome(deps, db, id, old);
  return updateMemoryOutcome(deps, db, id, old, args);
}

export function missingMemoryFindOutcome(find: string): ToolOutcome | null {
  return find.length === 0 ? ok("Say which note to change, using a phrase from it.") : null;
}

export function memoryMatchOutcome(find: string, hits: readonly [string, string][]): ToolOutcome | null {
  if (hits.length === 0) return ok(`No memory contains "${find}". Call list_memories to see them.`);
  if (hits.length === 1) return null;
  const listing = hits.map(([, content]) => `- ${content}`).join("\n");
  return ok(`"${find}" matches ${hits.length} notes; be more specific:\n${listing}`);
}

export function deleteMemoryOutcome(
  deps: ExecToolDeps,
  db: Database.Database,
  id: string,
  old: string,
): ToolOutcome {
  deleteMemory(db, id, { kind: "agent", who: "delete_memory" });
  emitSafely(deps, "memories-changed", undefined);
  return ok(`Forgot: ${old}`);
}

export function updateMemoryOutcome(
  deps: ExecToolDeps,
  db: Database.Database,
  id: string,
  old: string,
  args: Record<string, unknown>,
): ToolOutcome {
  const content = asString(args.content).trim();
  if (content.length === 0) return ok("Give the corrected note in `content`.");
  if ([...content].length > MAX_MEMORY_CONTENT_CHARS) {
    return ok(`Memory too long (${[...content].length} chars); keep it under ${MAX_MEMORY_CONTENT_CHARS}.`);
  }
  // update_memory SETs category, so a text-only fix would silently clear it —
  // carry the existing one.
  const keep = listMemories(db).find((m) => m.id === id)?.category ?? null;
  updateMemory(db, id, content, keep);
  emitSafely(deps, "memories-changed", undefined);
  return ok(`Updated. Was: ${old}`);
}
