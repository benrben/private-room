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
import { withRealPrivacyGates } from "./execToolAdvisor.js";
import { execTool } from "./execToolDispatch.js";
import { ExecToolDeps, ToolEffects, ToolOutcome, errMessage, fail, notImplemented, ok, requireRoom } from "./execToolEffects.js";
import { asString } from "./execToolMemory.js";
// -------------------------------------------------------------- REAL: web_search

/**
 * BROWSE-3: free multi-engine web search with no account or API key. Ported
 * from `exec_tool`'s own `"web_search"` arm (agent.rs lines ~3591-3683).
 *
 * PRIV-4 GATE FIRST, mirroring the Rust arm's own order: the query is masked
 * (or the call refused outright while the seam is unwired — see
 * {@link ExecToolDeps.maskOutboundWeb}'s own doc) before anything else runs,
 * including before the room's own internet switch is read.
 *
 * CHG-33's two caches: an exact-or-normalized repeat within 15 minutes is
 * served from `db-host/webCache.ts` with no network touched at all; once a
 * live search fails outright this turn ({@link ToolEffects.webSearchThrottled}),
 * the model is steered to stop calling this tool rather than deepening
 * whatever blocked it. An empty fusion is reported as EITHER "no results"
 * (the web really had nothing) OR "the search did not run" (every engine
 * was blocked/rate-limited/too slow) — conflating the two would tell a model
 * a subject does not exist online because a scraper hit a 429.
 */
export async function execWebSearch(
  deps: ExecToolDeps,
  effects: ToolEffects,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const prepared = preparedWebSearch(deps, asString(args.query));
  if ("ok" in prepared) return prepared;
  const room = enabledWebRoom(deps);
  if ("ok" in room) return room;
  const cached = cachedSearchOutcome(room, prepared);
  if (cached !== null) return cached;
  const throttled = throttledSearchOutcome(effects);
  if (throttled !== null) return throttled;
  return liveSearchOutcome(room, prepared, effects);
}

export interface PreparedWebSearch {
  readonly query: string;
  readonly maskNote: string;
}

export function preparedWebSearch(deps: ExecToolDeps, asked: string): PreparedWebSearch | ToolOutcome {
  if (deps.maskOutboundWeb === undefined) {
    return notImplemented(
      "nothing has installed the PRIV-4 outbound-query mask on this deps object, so this refused " +
        "rather than sending an unmasked query to seven search engines. Both halves ARE " +
        "implemented for real — privacy.ts's maskOutboundWeb/webMaskNote and web.ts's search " +
        "fusion — and execTool.ts's withRealPrivacyGates() installs the mask in one line. Do NOT " +
        "re-port privacy.rs or web/search.rs",
    );
  }
  const masked = deps.maskOutboundWeb(asked);
  return { query: masked?.query ?? asked, maskNote: masked?.note ?? "" };
}

export function enabledWebRoom(deps: ExecToolDeps): Database.Database | ToolOutcome {
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  if (!webAccessEnabled(room.db)) return ok("Web access is turned off in Settings → Online features.");
  return room.db;
}

export function cachedSearchOutcome(room: Database.Database, search: PreparedWebSearch): ToolOutcome | null {
  const cached = getFreshWebSearch(room, search.query);
  return cached === null ? null : ok(`${renderHits(cached)}${search.maskNote}`);
}

export function throttledSearchOutcome(effects: ToolEffects): ToolOutcome | null {
  if (!effects.webSearchThrottled) return null;
  return ok(
    "Web search is unavailable right now; answer from what you already have or from fetched " +
      "pages — do not search again this turn.",
  );
}

export async function liveSearchOutcome(
  room: Database.Database,
  search: PreparedWebSearch,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  try {
    return renderedSearchOutcome(room, search, await searchWeb(search.query));
  } catch (error) {
    effects.webSearchThrottled = true;
    return fail(errMessage(error));
  }
}

export function renderedSearchOutcome(
  room: Database.Database,
  search: PreparedWebSearch,
  page: SearchPage,
): ToolOutcome {
  if (page.hits.length === 0) return emptySearchOutcome(page, search.maskNote);
  saveSearchResults(room, search.query, page.hits);
  return ok(`${renderedSearchHits(page)}${search.maskNote}`);
}

export function emptySearchOutcome(page: SearchPage, maskNote: string): ToolOutcome {
  if (page.failed.length === 0) return ok(`No results found.${maskNote}`);
  return ok(
    `The search did not run: ${joinNames(page.failed)} could not be reached (blocked, rate ` +
      "limited or too slow). This is NOT evidence that nothing exists for this query — tell the " +
      "user the search was blocked rather than reporting no results, and answer from a fetched " +
      "page or what you already have.",
  );
}

export function saveSearchResults(room: Database.Database, query: string, hits: SearchPage["hits"]): void {
  try {
    putWebSearch(room, query, hits);
  } catch {
    // Best-effort, matching Rust's `let _ = db::put_web_search(...)`.
  }
}

export function renderedSearchHits(page: SearchPage): string {
  const note = blockedNote(page);
  const hits = renderHits(page.hits);
  return note === null ? hits : `${hits}\n\n${note}`;
}

// -------------------------------------------------------------- REAL: fetch_page

/**
 * Read one web page's text. Ported from `exec_tool`'s own `"fetch_page"` arm
 * (agent.rs lines ~3684-3731).
 *
 * PRIV-4 GATE FIRST, mirroring the Rust arm's own order and its own reasoning
 * for reusing `outbound_url_refusal` (the same seam `download_media` needs)
 * rather than `web_search`'s masking seam: a URL is ENCODED, so a masked
 * placeholder in a path or query string just 404s — this REFUSES instead of
 * fetching, and refuses outright (a `NOT_IMPLEMENTED` result) while the seam
 * itself is unwired, exactly like `download_media`.
 *
 * RM-2's cache: a fetch within the last 24h is served from
 * `db-host/webCache.ts` with no network touched, and (because a cache hit
 * carries no live redirect info) the redirect note only ever appears on a
 * fresh fetch that actually landed somewhere other than the requested URL.
 */
export async function execFetchPage(deps: ExecToolDeps, args: Record<string, unknown>): Promise<ToolOutcome> {
  const prepared = preparedFetchPage(deps, args);
  if ("ok" in prepared) return prepared;
  const room = enabledWebRoom(deps);
  if ("ok" in room) return room;
  const page = await cachedOrFetchedPage(room, prepared.url);
  if ("ok" in page) return page;
  return ok(fetchPageReply(page.title, prepared.url, page.text, prepared.start, page.redirectedTo));
}

export interface PreparedFetchPage {
  readonly url: string;
  readonly start: number;
}

export interface LoadedFetchPage {
  readonly title: string;
  readonly text: string;
  readonly redirectedTo: string | null;
}

export function preparedFetchPage(deps: ExecToolDeps, args: Record<string, unknown>): PreparedFetchPage | ToolOutcome {
  const url = asString(args.url);
  const privacyOutcome = fetchPagePrivacyOutcome(deps, url);
  if (privacyOutcome !== null) return privacyOutcome;
  return { url, start: fetchStartOffset(args.start) };
}

export function fetchPagePrivacyOutcome(deps: ExecToolDeps, url: string): ToolOutcome | null {
  if (deps.outboundUrlRefusal === undefined) {
    return notImplemented(
      "nothing has installed the PRIV-4 outbound-URL check on this deps object, so this refused " +
        "rather than skipping it. Both halves ARE implemented for real — privacy.ts's " +
        "outboundUrlHides and web.ts's guarded HTTP client (per-hop SSRF re-check, DNS pinning, " +
        "streamed byte caps) — and execTool.ts's withRealPrivacyGates() installs the check in one " +
        "line. Do NOT re-port privacy.rs or web/fetch.rs",
    );
  }
  const refusal = deps.outboundUrlRefusal(url);
  return refusal === null ? null : ok(refusal);
}

export function fetchStartOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export async function cachedOrFetchedPage(
  room: Database.Database,
  url: string,
): Promise<LoadedFetchPage | ToolOutcome> {
  const cached = getFreshWebPage(room, url);
  if (cached !== null) return { title: cached.title, text: cached.text, redirectedTo: null };
  try {
    const fetched = await fetchPage(url);
    saveFetchedPage(room, url, fetched);
    return fetchedPageResult(url, fetched);
  } catch (error) {
    return fail(errMessage(error));
  }
}

export function saveFetchedPage(room: Database.Database, url: string, page: FetchedPage): void {
  try {
    saveWebPage(room, url, page.title, page.text);
  } catch {
    // Best-effort, matching Rust's `let _ = db::save_web_page(...)`.
  }
}

export function fetchedPageResult(url: string, page: FetchedPage): LoadedFetchPage {
  return {
    title: page.title,
    text: page.text,
    redirectedTo: page.finalUrl !== url ? page.finalUrl : null,
  };
}
