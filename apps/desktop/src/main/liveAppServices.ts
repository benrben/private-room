import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { McpRuntime } from "./mcpSurfaceIpc.js";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import { requestAgentUi } from "./agentUiSurfaceIpc.js";
import type { FileRuntimeStores } from "./fileRuntimeSurfaceIpc.js";
import { findFileLikeQualified, getFileBytes, getFileMeta } from "./db-host/files.js";
import { getSetting } from "./db-host/settings.js";
import { playableMediaMime, stageMediaBytes, stageMediaStream } from "./mediaTools.js";
import { guessDownloadMime } from "./webFetch.js";
import { createDownloadEngineDeps } from "./mediaDownloadSurfaceIpc.js";
import { createWorkflowRunDeps } from "./jobWorkflowSurfaceIpc.js";
import {
  MCP_CONFIG_KEY,
  MCP_TOOL_PREFS_KEY,
  effectivePower,
  forgetConnectorGrants,
  mcpAutoApproveFile,
  mcpOutboundUnmaskFile,
  parseToolPrefs,
  readMcpConnectorPowers,
  readMcpFlag,
} from "./mcpConfig.js";
import { emptyPrivacyReport } from "./privacyRedact.js";
import { remoteSeamRedactor } from "./privacy.js";
import { parseMcpConfig, sanitizeToolName, type McpManager } from "./mcpClient.js";
import { BUILTIN_TOOL_NAMES, type McpRoute, type OllamaToolSpec } from "./toolSpecs.js";
import type { ExecToolDeps, RemoteSeam } from "./execTool.js";
import type { RunStudioDeps } from "./studiosCmds.js";
import type { Browser } from "./browser/browser.js";
import type { SttModelState } from "./sttTools.js";
import { createLiveRuntimeTool } from "./liveRuntimeTools.js";
import {
  videoVisualIndex,
  VIDEO_VISUAL_WARM_TIMEOUT_MS,
  type CachedVisualFrame,
  type VideoVisualIndexClient,
} from "./videoVisualIndex.js";

/** A cold interactive lookup may do one bounded local index build, but never
 * hold an agent tool call for the background transcription lane's full 120s. */
export const INTERACTIVE_VISUAL_INDEX_BUDGET_MS = 30_000;

type BeforeDeadline<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

async function beforeDeadline<T>(operation: Promise<T | null>, deadline: number): Promise<BeforeDeadline<T | null>> {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return { timedOut: true };
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, remaining);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value: null });
      },
    );
  });
}

export interface LiveAppServices {
  roomDeps: RoomManagerDeps;
  userDataDir: string;
  mcp: McpRuntime;
  agentUi: AgentUiRuntime;
  files: FileRuntimeStores;
  browser: Browser;
  sttModelState: SttModelState;
  resourcesPath: string | null;
  runtimeTool?: ExecToolDeps["runtimeTool"];
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return 0;
  const parts = raw.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`Invalid media timestamp: ${raw}`);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The Content-Type the renderer's hidden video element should receive.
 *
 * Normal imports already persist a video MIME, but an existing workspace can
 * be reconciled from filenames alone and older rows commonly carry
 * `application/octet-stream`. The ordinary viewer repairs that label with
 * `playableMediaMime`; the agent frame path must make the same repair or a
 * file the user can watch is rejected before the renderer ever sees it. */
export function playableVideoMime(name: string, storedMime: string): string | null {
  const extension = extensionOf(name);
  const normalized = storedMime.trim().toLowerCase();
  const guessed = guessDownloadMime(name);
  const sourceMime = normalized.startsWith("video/")
    ? normalized
    : guessed.startsWith("video/")
      ? guessed
      : extension === "m4v"
        ? "video/mp4"
        : null;
  return sourceMime === null ? null : playableMediaMime(sourceMime, extension, true);
}

/** Resolve a media mention without treating the chat mention sigil as part of
 * the filename. Try the literal spelling first so a real file whose name
 * begins with `@` remains addressable; only then retry without the sigil. */
export function findMentionedMediaFile(
  conn: Parameters<typeof findFileLikeQualified>[0],
  rawName: unknown,
): [string, string] {
  const requested = typeof rawName === "string" ? rawName.trim() : "";
  try {
    return findFileLikeQualified(conn, requested);
  } catch (literalError) {
    if (!requested.startsWith("@") || requested.slice(1).trim() === "") throw literalError;
    try {
      return findFileLikeQualified(conn, requested.slice(1).trim());
    } catch {
      throw literalError;
    }
  }
}

async function coldWorkspaceVisualFrame(
  openRoom: NonNullable<RoomManagerState["room"]>,
  fileId: string,
  sourceSha256: string,
  extension: string,
  seconds: number,
  visualIndex: Pick<VideoVisualIndexClient, "capture" | "frame" | "warm">,
  deadline: number,
): Promise<CachedVisualFrame | null> {
  if (openRoom.workspace === undefined) return null;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  if (remaining() === 0) return null;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-visual-index-")).catch(() => null);
  if (tempDir === null) return null;
  const staged = path.join(tempDir, `source.${extension || "bin"}`);
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), remaining());
  let cleanupDeferred = false;
  const cleanup = async (): Promise<void> => {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await pipeline(
      openRoom.workspace.readStream(fileId),
      fs.createWriteStream(staged, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal },
    );
    if (remaining() === 0) return null;
    // The exact 56m production fixture needs ~55s for a full 1-FPS cold
    // index. Build that under the background 120s budget for later requests,
    // while the latency-critical endpoint captures only this exact second for
    // the current answer. Both share this one private staged source.
    const warmOperation = visualIndex.warm(
      staged,
      sourceSha256,
      VIDEO_VISUAL_WARM_TIMEOUT_MS,
    );
    const captureOperation = visualIndex.capture(staged, seconds, remaining());
    // Deleting after the fast capture alone would make the full warm's
    // post-capture source re-hash fail. Retain staging until BOTH settle.
    cleanupDeferred = true;
    void Promise.allSettled([warmOperation, captureOperation]).then(cleanup);
    const captureBeforeDeadline = await beforeDeadline(
      captureOperation,
      deadline,
    );
    return captureBeforeDeadline.timedOut ? null : captureBeforeDeadline.value;
  } catch {
    return null;
  } finally {
    clearTimeout(budget);
    if (!cleanupDeferred) await cleanup();
  }
}

/** Resolve, stage and ask the live renderer for one video frame.
 *
 * Kept as a narrow exported seam so the real qualified-name lookup,
 * roommedia staging and AgentUi round-trip can be regression-tested together
 * without constructing the unrelated browser/job/runtime dependencies used by
 * the rest of {@link applyLiveAppServices}. */
export async function requestLiveMediaFrame(
  state: RoomManagerState,
  files: Pick<FileRuntimeStores, "mediaStreams">,
  agentUi: AgentUiRuntime,
  emit: EventSender,
  args: Record<string, unknown>,
  visualIndex: Pick<VideoVisualIndexClient, "capture" | "frame" | "warm"> = videoVisualIndex,
): Promise<unknown> {
  if (state.room === null) throw new Error("No room is open.");
  const [id] = findMentionedMediaFile(state.room.conn, args.name);
  const meta = getFileMeta(state.room.conn, id);
  const streamMime = playableVideoMime(meta.name, meta.mimeType);
  if (streamMime === null) {
    throw new Error(`“${meta.name}” is not a supported video file.`);
  }

  const seconds = parseTimestamp(args.at);
  let token: string;
  if (state.room.workspace !== undefined) {
    const row = state.room.conn.prepare(
      `SELECT size_bytes, content_sha256 FROM files
       WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).get(id) as { size_bytes: number; content_sha256: string | null } | undefined;
    if (row === undefined) throw new Error("That video is unavailable in the workspace.");
    // Cache hits return the exact same renderer response shape, so the MCP
    // bridge's SHA verification, pending-image drain and Cloud Privacy image
    // valve remain unchanged. A missing, stale or corrupt derived entry is
    // only a miss; the ordinary hidden renderer remains the source of truth.
    if (row.content_sha256 !== null) {
      const deadline = Date.now() + INTERACTIVE_VISUAL_INDEX_BUDGET_MS;
      const hit = await beforeDeadline(
        visualIndex.frame(row.content_sha256, seconds, deadline - Date.now()),
        deadline,
      );
      let cached = hit.timedOut ? null : hit.value;
      if (cached === null) {
        cached = await coldWorkspaceVisualFrame(
          state.room,
          id,
          row.content_sha256,
          extensionOf(meta.name),
          seconds,
          visualIndex,
          deadline,
        );
      }
      if (cached !== null) return cached;
    }
    const openRoom = state.room;
    token = stageMediaStream(
      files.mediaStreams,
      row.size_bytes,
      streamMime,
      async () => openRoom.workspace!.readStream(id),
      async (start, end) => openRoom.workspace!.readStream(id, { start, end }),
    );
  } else {
    const bytes = getFileBytes(state.room.conn, id);
    if (bytes === null) throw new Error("That video has no saved bytes to decode.");
    token = stageMediaBytes(files.mediaStreams, bytes, streamMime);
  }

  return requestAgentUi(agentUi, emit, "media_frame", {
    token,
    mime: streamMime,
    seconds,
  });
}

function schemaObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { type: "object", properties: {} };
}

export function liveMcpRoutes(state: RoomManagerState, manager: McpManager): McpRoute[] {
  const disabled = state.room === null
    ? {}
    : parseToolPrefs(getSetting(state.room.conn, MCP_TOOL_PREFS_KEY) ?? "{}");
  const taken = new Set(BUILTIN_TOOL_NAMES);
  const routes: McpRoute[] = [];
  for (const server of manager.servers) {
    if (server.status !== "connected" || server.client === null) continue;
    for (const tool of server.tools) {
      if (disabled[server.name]?.has(tool.name)) continue;
      const base = `${sanitizeToolName(server.name)}_${sanitizeToolName(tool.name)}`;
      let catalogName = base;
      for (let n = 2; taken.has(catalogName); n += 1) catalogName = `${base}_${n}`;
      taken.add(catalogName);
      const fn: Record<string, unknown> = {
        name: catalogName,
        description: tool.description.length > 2_000 ? `${tool.description.slice(0, 1_997)}…` : tool.description,
        parameters: schemaObject(tool.schema),
      };
      if (tool.annotations !== null) fn.annotations = tool.annotations;
      routes.push({
        catalogName,
        toolName: tool.name,
        serverName: server.name,
        remote: server.remote,
        spec: { type: "function", function: fn } as OllamaToolSpec,
      });
    }
  }
  return routes;
}

function identityRemoteSeam(): RemoteSeam {
  return { redactValue: (value) => ({ value, entitiesHidden: 0 }), restore: (text) => text };
}

function liveRemoteSeam(): RemoteSeam {
  const policy = remoteSeamRedactor();
  if (policy === null) return identityRemoteSeam();
  return {
    redactValue: (value) => {
      const report = emptyPrivacyReport();
      const redacted = policy.redactor.redactValue(value, report);
      return { value: schemaObject(redacted), entitiesHidden: report.entitiesHidden };
    },
    restore: (text) => policy.redactor.restore(text),
  };
}

function connectorPower(services: LiveAppServices, server: string, power: "autoApprove" | "outboundUnmask"): boolean {
  const powers = readMcpConnectorPowers(services.userDataDir);
  const globalFile = power === "autoApprove"
    ? mcpAutoApproveFile(services.userDataDir)
    : mcpOutboundUnmaskFile(services.userDataDir);
  return effectivePower(readMcpFlag(globalFile), powers[server]?.[power]);
}

async function askConsent(
  state: RoomManagerState,
  emit: EventSender,
  server: string,
  tool: string,
  args: string,
  confirm?: string,
): Promise<{ approved: boolean; remember: boolean }> {
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.mcpPending.delete(id);
      resolve({ approved: false, remember: false });
    }, 600_000);
    timer.unref?.();
    state.mcpPending.set(id, (decision) => {
      clearTimeout(timer);
      resolve(decision);
    });
    emit("mcp-approve-request", { id, server, tool, args, ...(confirm === undefined ? {} : { confirm }) });
  });
}

/** Build the Studio runner over the exact open-room content backend.
 *
 * Workspace rooms must carry their WorkspaceService here: Artifact.commit()
 * intentionally refuses hybrid-storage rooms, while commitToWorkspace() is
 * the only path that atomically writes normal-file bytes and metadata. */
export function createLiveStudioDeps(state: RoomManagerState, emit: EventSender): RunStudioDeps {
  return {
    rooms: {
      current: () => state.room === null ? null : {
        db: state.room.conn,
        path: state.room.path,
        name: state.room.name,
        ...(state.room.workspace === undefined ? {} : { workspace: state.room.workspace }),
      },
      rollingBack: () => state.rollingBack,
    },
    cancelState: state.cancel,
    emit,
  };
}

export function applyLiveAppServices(
  base: ExecToolDeps,
  state: RoomManagerState,
  emit: EventSender,
  services: LiveAppServices,
): ExecToolDeps {
  const routes = liveMcpRoutes(state, services.mcp.manager);
  const engineDeps = createDownloadEngineDeps(state, services.userDataDir, emit);
  const queue = services.roomDeps.jobQueue;
  return {
    ...base,
    currentRoom: () => state.room === null ? null : {
      db: state.room.conn,
      path: state.room.path,
      ...(state.room.workspace === undefined ? {} : { workspace: state.room.workspace }),
    },
    routes,
    ...(queue === undefined ? {} : {
      downloadJob: { ...queue, ...engineDeps },
      workflowRun: createWorkflowRunDeps(state, services.roomDeps, services.userDataDir, emit),
    }),
    runStudioDeps: createLiveStudioDeps(state, emit),
    runtimeTool: services.runtimeTool ??= createLiveRuntimeTool({
      state,
      roomDeps: services.roomDeps,
      userDataDir: services.userDataDir,
      resourcesPath: services.resourcesPath,
      emit,
      browser: services.browser,
      agentUi: services.agentUi,
      sttModelState: services.sttModelState,
    }),
    agentUi: async (kind, args) => {
      if (kind === "media_frame") {
        return requestLiveMediaFrame(state, services.files, services.agentUi, emit, args);
      }
      return requestAgentUi(services.agentUi, emit, kind, args);
    },
    callConnectorTool: async (route, args) => {
      const server = services.mcp.manager.servers.find((entry) => entry.name === route.serverName);
      if (server?.client === null || server?.client === undefined) throw new Error(`Connector “${route.serverName}” is no longer connected.`);
      return server.client.callTool(route.toolName, args);
    },
    outboundUnmaskFor: (server) => connectorPower(services, server, "outboundUnmask"),
    remoteSeam: liveRemoteSeam(),
    connectorApproved: async (route, sentArgs) => {
      if (state.mcpSessionOk.has(route.serverName) || connectorPower(services, route.serverName, "autoApprove")) return true;
      const decision = await askConsent(state, emit, route.serverName, route.toolName, JSON.stringify(sentArgs, null, 2));
      if (decision.approved && decision.remember) state.mcpSessionOk.add(route.serverName);
      return decision.approved;
    },
    confirmDestructive: async (what, name, detail) => {
      const decision = await askConsent(state, emit, name, what, "{}", detail);
      return decision.approved;
    },
    mcpStatuses: new Map(services.mcp.manager.statuses().map((status) => [status.name, status.status])),
    mcpForgetConnectorGrants: (server) => ({
      cleared: forgetConnectorGrants(services.userDataDir, state.mcpSessionOk, server),
    }),
    mcpReconnect: (servers) => { void services.mcp.reconnect?.([...servers]); },
  };
}

export function refreshMcpConnections(state: RoomManagerState, services: LiveAppServices): void {
  if (state.room === null || services.mcp.reconnect === undefined) return;
  void services.mcp.reconnect(parseMcpConfig(getSetting(state.room.conn, MCP_CONFIG_KEY) ?? '{"mcpServers":{}}'));
}
