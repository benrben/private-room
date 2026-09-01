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
import { ExecToolDeps, ToolOutcome, emitSafely, errMessage, fail, ok, requireRoom } from "./execToolEffects.js";
import { asString } from "./execToolMemory.js";
// ---------------------------------------------------------------- skill arms

/**
 * The skill COMMAND layer's read/write arms, ported from
 * `src-tauri/src/commands/skills.rs` against the already-committed
 * `db-host/skills.ts`. Every refusal string below is verbatim from that source.
 *
 * `delete_skill` and `run_skill_script` are NOT here: the first needs the
 * `confirm_destructive` consent dialog and the second needs script execution,
 * neither of which is ported — see their stub arms.
 */

export const SKILL_LIST_TRUNCATED =
  "\n… (list truncated — this room holds more skills than this tool can return.)";
export const SKILL_BODY_TRUNCATED =
  "\n\n… (instructions truncated — the full SKILL.md is longer than this tool can return. " +
  "Work from what is above and say so if the rest was needed.)";
export const SKILL_RESOURCES_TRUNCATED = "\n… (more bundled resources than this tool can list.)";
export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 2000;
export const MAX_INSTRUCTIONS = 200_000;

export function tryDecodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Ported from `commands::skills::normalize_skill_path`. */
export function normalizeSkillPath(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\\/g, "/");
  const issue = skillPathIssue(trimmed);
  if (issue !== null) return { ok: false, error: issue };
  const parts = trimmed.split("/").filter((p) => p !== "");
  if (parts.some(isUnsafeSkillPathPart)) return { ok: false, error: unsafeSkillPathError() };
  if (parts.length === 0) return { ok: false, error: "Use a short relative resource path." };
  return { ok: true, value: parts.join("/") };
}

export function skillPathIssue(path: string): string | null {
  if (path === "" || path.length > 240) return "Use a short relative resource path.";
  if (path.endsWith("/")) return 'A resource path must name a file, not a folder — remove the trailing "/".';
  if (path.startsWith("/") || path.toLowerCase() === "skill.md") return unsafeSkillPathError();
  return null;
}

export function isUnsafeSkillPathPart(part: string): boolean {
  return part === "." || part === "..";
}

export function unsafeSkillPathError(): string {
  return "Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields.";
}

export const SKILL_RESOURCE_KINDS: ReadonlyMap<string, string> = new Map([
  ["scripts", "script"],
  ["references", "reference"],
  ["assets", "asset"],
  ["agents", "agent"],
]);

/** Ported from `commands::skills::skill_resource_kind`. */
export function skillResourceKind(path: string): string {
  const kind = SKILL_RESOURCE_KINDS.get(path.split("/")[0] as string);
  return kind === undefined ? "resource" : kind;
}

/** Ported from `commands::skills::check_resource_paths`. Case-fold is ASCII
 * (`toLowerCase` on the compared slice), matching Rust's
 * `eq_ignore_ascii_case`, since a resource path is expected to be ASCII. */
export function checkResourcePaths(paths: readonly string[]): string | null {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const conflict = resourcePathConflict(paths[i]!, paths[j]!);
      if (conflict !== null) return conflict;
    }
  }
  return null;
}

export function resourcePathConflict(first: string, second: string): string | null {
  const [directory, nested] = first.length < second.length ? [first, second] : [second, first];
  if (!isNestedResourcePath(directory, nested)) return null;
  return `"${directory}" and "${nested}" can't both be in one skill: a file and a folder cannot share a name. Rename one of them.`;
}

export function isNestedResourcePath(directory: string, nested: string): boolean {
  return (
    nested.length > directory.length &&
    nested[directory.length] === "/" &&
    nested.slice(0, directory.length).toLowerCase() === directory.toLowerCase()
  );
}

export function checkNewResourcePath(conn: Database.Database, skillId: string, path: string): string | null {
  const paths = listSkillResourcesDb(conn, skillId)
    .map((r) => r.path)
    .filter((p) => p !== path);
  paths.push(path);
  return checkResourcePaths(paths);
}

/** Ported from `commands::skills::validate_skill_name`. */
export function validateSkillName(name: string): { ok: true; value: string } | { ok: false; error: string } {
  const n = name.trim().toLowerCase().replace(/[ _]/g, "-");
  if (n === "") return { ok: false, error: "Give the skill a name." };
  const error = skillNameFormatError(n);
  if (error !== null) return { ok: false, error };
  return { ok: true, value: n };
}

export function skillNameFormatError(name: string): string | null {
  if (name.length > MAX_NAME) return SKILL_NAME_FORMAT_ERROR;
  if (name.startsWith("-") || name.endsWith("-")) return SKILL_NAME_FORMAT_ERROR;
  return /^[a-z0-9-]+$/.test(name) ? null : SKILL_NAME_FORMAT_ERROR;
}

export const SKILL_NAME_FORMAT_ERROR =
  "Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.";

/** Ported from `commands::skills::validate_skill_fields`. */
export function validateSkillFields(
  name: string,
  description: string,
  instructions: string
): { ok: true; value: string } | { ok: false; error: string } {
  const nameResult = validateSkillName(name);
  if (!nameResult.ok) return nameResult;
  const error = skillTextFieldsError(description, instructions);
  if (error !== null) return { ok: false, error };
  return { ok: true, value: nameResult.value };
}

export function skillTextFieldsError(description: string, instructions: string): string | null {
  const desc = description.trim();
  if (desc === "") {
    return "Describe what the skill does and when the assistant should use it.";
  }
  if (Array.from(desc).length > MAX_DESCRIPTION) {
    return `Keep the skill description under ${MAX_DESCRIPTION} characters.`;
  }
  if (Array.from(instructions).length > MAX_INSTRUCTIONS) {
    return "SKILL.md is too large. Move detailed material into references/.";
  }
  return null;
}

export function execListSkills(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const all = listSkillsDb(room.db, false);
  const caller = asString(args["agent"]).trim();
  // The Skills inventory and Skill builder are room-wide catalog owners.
  // The sidecar injects their own agent ids just like any domain specialist;
  // treating that injected id as an ownership filter hid drafts the UI could
  // see (and made exact read requests falsely claim they did not exist).
  const roomWideInventory = caller === "skills.use" || caller === "skills.author";
  const skills = all.filter((s) => {
    const owner = s.agent.trim();
    return owner === "" || caller === "" || roomWideInventory || owner === caller;
  });
  if (skills.length === 0) {
    return ok(all.length === 0 ? "No skills are stored in this room yet." : "No skills are assigned to you yet.");
  }
  const lines = skills
    .map(
      (s) =>
        `- ${s.name} [${s.enabled ? "enabled" : "disabled draft"}]${
          s.agent.trim() !== "" && s.agent.trim() === caller
            ? " (yours)"
            : roomWideInventory && s.agent.trim() !== ""
              ? ` (assigned to ${s.agent.trim()})`
              : ""
        } — ${s.description} (${s.resourceCount} resources)`
    )
    .join("\n");
  return ok(clampBytesMarked(lines, 12_000, SKILL_LIST_TRUNCATED));
}

export function execReadSkill(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]);
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  const resources = listSkillResourcesDb(room.db, skill.id);
  const tree =
    resources.length === 0
      ? "(no bundled resources)"
      : resources.map((r) => `- ${r.path} (${r.kind})`).join("\n");
  const instructions = clampBytesMarked(skill.instructions, 16_000, SKILL_BODY_TRUNCATED);
  const treeClamped = clampBytesMarked(tree, 3_000, SKILL_RESOURCES_TRUNCATED);
  return ok(
    `# Skill: ${skill.name}\nStatus: ${skill.enabled ? "enabled" : "disabled draft"}\nDescription: ${skill.description}\n\n${instructions}\n\nBundled resources:\n${treeClamped}`
  );
}

export function execReadSkillResource(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]);
  const pathResult = normalizeSkillPath(asString(args["path"]));
  if (!pathResult.ok) return fail(pathResult.error);
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  let resource;
  try {
    resource = getSkillResourceDb(room.db, skill.id, pathResult.value);
  } catch (e) {
    return fail(errMessage(e));
  }
  const text = tryDecodeUtf8(resource.content);
  if (text === null) return fail(`${pathResult.value} is binary and cannot be loaded as text.`);
  return ok(clampBytes(text, 20_000));
}

export function execSaveSkill(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  try {
    return ok(agentSaveSkill(room.db, args, deps.emit));
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function execWriteSkillResource(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]);
  const pathResult = normalizeSkillPath(asString(args["path"]));
  if (!pathResult.ok) return fail(pathResult.error);
  const content = asString(args["content"]);
  if (Buffer.byteLength(content, "utf8") > MAX_RESOURCE_BYTES) {
    return fail("That resource is too large (32 MB maximum).");
  }
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  const clash = checkNewResourcePath(room.db, skill.id, pathResult.value);
  if (clash !== null) return fail(clash);
  upsertSkillResourceDb(
    room.db,
    skill.id,
    pathResult.value,
    skillResourceKind(pathResult.value),
    Buffer.from(content, "utf8")
  );
  setSkillEnabledDb(room.db, skill.id, false);
  emitSafely(deps, "skills-changed", undefined);
  return ok(`Saved ${pathResult.value} in "${skill.name}" and left the skill disabled for review.`);
}

export function execDeleteSkillResource(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]).trim();
  const path = asString(args["path"]).trim().replace(/\\/g, "/");
  if (key === "") return fail("delete_skill_resource needs a skill name or id.");
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  try {
    deleteSkillResourceDb(room.db, skill.id, path);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(deps, "skills-changed", undefined);
  return ok(`Deleted ${path} from skill "${skill.name}".`);
}
