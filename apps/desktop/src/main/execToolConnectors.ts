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
import { ConnectorReply, ExecToolDeps, RemoteSeam, ToolEffects, ToolOutcome, errMessage, fail, notImplemented, ok } from "./execToolEffects.js";
import { asString } from "./execToolMemory.js";
import { enabledWebRoom } from "./execToolWeb.js";
// ------------------------------------------------------------ REAL: download_media

/**
 * BROWSE-2 (D18): download the media at a yt-dlp-supported URL as a durable
 * background job. Ported from `exec_tool`'s own `"download_media"` arm
 * (agent.rs lines ~3817-3836).
 *
 * TWO GATES RUN BEFORE THE JOB IS EVEN CREATED, mirrored from the Rust arm in
 * the same order:
 *   1. `outbound_url_refusal` (privacy.rs's `outbound_url_hides`) — refused
 *      (never silently skipped) while {@link ExecToolDeps.outboundUrlRefusal}
 *      is unwired; see that field's own doc. Needs no open room, so it runs
 *      BEFORE "No room is open." can even be asked — exactly the Rust arm's
 *      own order.
 *   2. The room's own internet switch, answered with a friendly `ok()`
 *      sentence rather than a tool FAILURE — exactly the Rust arm's own
 *      `Ok("Web access is turned off...")`, not an error a model would need
 *      to recover from.
 *
 * Only once both pass does {@link ExecToolDeps.downloadJob} — the real
 * job-queue wiring ({@link startDownloadJobInner} from `jobDownload.ts`) —
 * actually create, and (if the slot is free) start, the job.
 */
export async function execDownloadMedia(
  deps: ExecToolDeps,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const url = asString(args.url).trim();
  const privacyOutcome = mediaDownloadPrivacyOutcome(deps, url);
  if (privacyOutcome !== null) return privacyOutcome;
  const room = enabledWebRoom(deps);
  if ("ok" in room) return room;
  const downloadJob = deps.downloadJob;
  if (downloadJob === undefined) return missingDownloadJobOutcome();
  return startMediaDownload(downloadJob, url);
}

export function mediaDownloadPrivacyOutcome(deps: ExecToolDeps, url: string): ToolOutcome | null {
  if (deps.outboundUrlRefusal === undefined) {
    return notImplemented(
      "privacy.rs's outbound_url_hides check (the cloud-privacy protected-name guard every " +
        "download/save tool runs before reaching the network) has no Electron port yet — refused " +
        "rather than skipping it. jobDownload.ts's yt-dlp job-queue wrapper is fully implemented " +
        "and tested; it is ready to wire in once that check lands",
    );
  }
  const refusal = deps.outboundUrlRefusal(url);
  return refusal === null ? null : ok(refusal);
}

export function missingDownloadJobOutcome(): ToolOutcome {
  return notImplemented(
    "the download-job queue wiring (an app-wide JobQueueDeps + yt-dlp's data dir + the room's " +
      "import funnel) is not connected to execTool yet — Batch D",
  );
}

export function startMediaDownload(
  downloadJob: NonNullable<ExecToolDeps["downloadJob"]>,
  url: string,
): ToolOutcome {
  try {
    const jobId = startDownloadJobInner(downloadJob, url, DOWNLOAD_ENGINE_MEDIA);
    return ok(
      `Downloading the media as background job ${jobId} — track it with job_status. Once it ` +
        "arrives the file is transcribed on this Mac with speakers separated; that pass starts " +
        "after the job ends, so the transcript appears on the file some minutes later — and not " +
        "at all if no speech model is installed."
    );
  } catch (e) {
    return fail(errMessage(e));
  }
}

// ------------------------------------------------- the connector-route default

/**
 * `exec_tool`'s `other => match routes.iter().find(...)` arm: a name that is
 * not a built-in is looked up as a connected MCP tool, and is a real
 * `Unknown tool:` error only when no route claims it.
 *
 * TWO DOORS STAND BETWEEN A MODEL AND A CONNECTOR IN RUST, and this port
 * refuses rather than skipping either:
 *
 * 1. The OUTBOUND redaction seam. A remote connector is a non-local
 *    destination, so the room's known entities are masked in the arguments
 *    before they leave and restored in the result on the way home
 *    ({@link masksOutboundArgs}). What the consent card SHOWS is what is
 *    SENT — Rust computes the masked copy before building the card precisely
 *    because it once did the opposite, and a user approved "look up Dana
 *    Cohen" while the connector was asked about "[Person A]".
 * 2. SEC-1b consent. The user is asked before a connector's tool runs, unless
 *    they chose "always allow" for it earlier this session.
 *
 * Neither subsystem is ported. So when a call WOULD be masked and no
 * {@link RemoteSeam} exists, this refuses instead of sending the room's real
 * text to a remote server; and with no {@link ExecToolDeps.connectorApproved}
 * it refuses instead of running ungated. `routes` is empty in production today
 * (no connector manager is ported either), so this is reachable only from a
 * caller that supplies its own route — and that caller has to supply the doors
 * with it.
 */
export async function execConnectorRoute(
  deps: ExecToolDeps,
  effects: ToolEffects,
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const route = deps.routes.find((r) => r.catalogName === name);
  if (route === undefined) return fail(`Unknown tool: ${name}`);
  if (deps.callConnectorTool === undefined) {
    return notImplemented(
      `connector dispatch for "${name}" (the MCP client transport) is not wired up — Batch D`,
    );
  }
  const prepared = preparedConnectorCall(deps, route, args);
  if ("ok" in prepared) return prepared;
  const approvalOutcome = await connectorApprovalOutcome(deps, prepared);
  if (approvalOutcome !== null) return approvalOutcome;
  const reply = await connectorReply(deps.callConnectorTool, prepared);
  if ("ok" in reply) return reply;
  const result = connectorResult(deps, effects, prepared, reply);
  return connectorOutcome(route.serverName, prepared.hidden, result);
}

export interface PreparedConnectorCall {
  readonly route: McpRoute;
  readonly sent: Record<string, unknown>;
  readonly hidden: number;
  readonly masks: boolean;
}

export function preparedConnectorCall(
  deps: ExecToolDeps,
  route: McpRoute,
  args: Record<string, unknown>,
): PreparedConnectorCall | ToolOutcome {
  const unmaskOutbound = deps.outboundUnmaskFor?.(route.serverName) ?? false;
  if (!masksOutboundArgs(route.remote, unmaskOutbound)) return unmaskedConnectorCall(route, args);
  const seam = deps.remoteSeam;
  if (seam === undefined) return missingConnectorMaskOutcome(route);
  const masked = seam.redactValue(args);
  return {
    route,
    sent: masked.value,
    hidden: masked.entitiesHidden,
    masks: true,
  };
}

export function unmaskedConnectorCall(route: McpRoute, args: Record<string, unknown>): PreparedConnectorCall {
  return { route, sent: args, hidden: 0, masks: false };
}

export function missingConnectorMaskOutcome(route: McpRoute): ToolOutcome {
  return notImplemented(
    `outbound masking for the remote connector "${route.serverName}" (privacy.rs's ` +
      `remote_seam_redactor) is not ported, and sending this room's real values to a remote ` +
      `server unmasked is not a substitute — refused, nothing left this room`,
  );
}

export async function connectorApprovalOutcome(
  deps: ExecToolDeps,
  call: PreparedConnectorCall,
): Promise<ToolOutcome | null> {
  if (deps.connectorApproved === undefined) return missingConnectorApprovalOutcome(call.route);
  if (await deps.connectorApproved(call.route, call.sent)) return null;
  return ok(
    `The user declined to run the "${call.route.toolName}" tool from "${call.route.serverName}", so it did ` +
      `not run and nothing left this room. Answer from what you already have, and tell the user ` +
      `you skipped that connected tool.`,
  );
}

export function missingConnectorApprovalOutcome(route: McpRoute): ToolOutcome {
  return notImplemented(
    `the SEC-1b consent gate (mcp_call_approved) is not ported, so "${route.toolName}" from ` +
      `"${route.serverName}" cannot be run with the user's approval — refused, nothing left this room`,
  );
}

export async function connectorReply(
  callConnectorTool: NonNullable<ExecToolDeps["callConnectorTool"]>,
  call: PreparedConnectorCall,
): Promise<ConnectorReply | ToolOutcome> {
  try {
    return await callConnectorTool(call.route, call.sent);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function connectorResult(
  deps: ExecToolDeps,
  effects: ToolEffects,
  call: PreparedConnectorCall,
  reply: ConnectorReply,
): string {
  const text = restoredConnectorText(deps, call.masks, reply.text);
  return connectorResultWithImages(effects, call.route, reply.images ?? [], text);
}

export function restoredConnectorText(deps: ExecToolDeps, masks: boolean, text: string): string {
  if (!masks || deps.remoteSeam === undefined) return text;
  return deps.remoteSeam.restore(text);
}

export function connectorResultWithImages(
  effects: ToolEffects,
  route: McpRoute,
  images: readonly string[],
  initial: string,
): string {
  let result = initial;
  for (const [index, image] of images.entries()) {
    const caption = `image ${index + 1} from "${route.toolName}"`;
    if (effects.visionChat) effects.pendingImages.push(image);
    else result += `\n\n[${caption} could not be attached: the local vision describer (perceive_image) is not ported yet]`;
  }
  return result;
}

export function connectorOutcome(serverName: string, hidden: number, result: string): ToolOutcome {
  const note = maskedArgsNote(serverName, hidden);
  return ok(note === null ? result : `${result}${note}`);
}
