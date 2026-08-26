/**
 * The REAL `ToolDispatcher` — `room_mcp.rs`'s `tool_call` wrapper around
 * `exec_tool`, implementing the seam `mcpBridge.ts` declared and left for a
 * later batch (its module doc names this file's whole job explicitly: "The
 * real tool catalog … `tool_call`'s dispatch body past the transport layer …
 * depends on `exec_tool`'s whole command surface").
 *
 * Ported from `src-tauri/src/room_mcp.rs`:
 * - lines ~48-215: `ToolScope`'s predicate methods beyond `include_mcp`
 *   (already ported in `mcpBridge.ts`) — `include_ui_tools`,
 *   `include_job_tools`, `include_external_tools`, `include_media_perception`,
 *   `include_browse_tools`, `include_organize_tools`,
 *   `include_mcp_management_tools`, `label`.
 * - lines ~242-313: `EffectsSink`/`WebThrottle`/`AdvisorRuntime` (adapted —
 *   see each type's own doc for what changed and why).
 * - lines ~858-1270: the catalog-assembly plumbing `served_tools_with` sits
 *   on top of (`arcelle_tool_annotations`, `sanitized_tool_annotations`,
 *   `to_mcp_tool`, `mcp_proxy_tools`, `searchable_mcp_tools`/
 *   `mcp_search_score`/`search_mcp_entries`, `scoped_specs`, `tier_tool_names`,
 *   `room_tool_names_with`) — genuinely pure, and the direct enabler of a
 *   REAL `listTools`, so ported here even though the task's Part 2 list names
 *   only the lines-1344-1800 functions explicitly.
 * - lines ~1344-1797: `served_tools_with`, `tool_cancel_for`, `tool_call`,
 *   `nested_run_arguments`, `json_kind`, `tool_result`.
 *
 * OUT OF SCOPE, injected as seams (see each interface's doc for the TODO):
 * - {@link RedactionPolicy}/{@link PrivacyDeps} — the room's cloud-privacy
 *   redactor (`privacy.rs`'s `PolicyState`/`active_policy`). TODO: a future
 *   privacy/redaction batch supplies a real implementation.
 * - `execTool.ts`'s `ExecToolDeps.callConnectorTool`/`connectorApproved`/
 *   `remoteSeam` — the MCP client transport, the SEC-1b consent gate and the
 *   outbound redaction seam. `execTool` REFUSES rather than skipping either
 *   door; see its `execConnectorRoute`.
 *
 * THE CATALOG IS COMPLETE. {@link scopedSpecs} folds in every group
 * `scoped_specs` does — `workflow_tools_specs`, `browse_tools_specs`,
 * `draw_tools_specs` and `download_tools_specs` included — even though the
 * `exec_tool` arms behind those four are still `NOT_IMPLEMENTED` stubs. That
 * split is deliberate and it is the safe direction: a catalog missing a tool
 * is a capability the engine silently loses with nothing in the transcript
 * explaining why, while a served tool whose arm refuses tells the model
 * exactly what happened.
 *
 * WHAT IT DOES NOT DO — stated because an earlier draft of this comment
 * claimed the opposite: serving a group here does NOT put it in
 * `toolSchema.ts`'s `builtinParamSchemas` table, and that table is missing
 * three of the groups this function serves. `organize_tools_specs`,
 * `download_tools_specs` and `draw_tools_specs` are absorbed by neither the
 * Rust `builtin_param_schemas` nor its port, so `missingRequiredArg` is a
 * NO-OP for `organize_files` / `trash_files` / `set_in_library` /
 * `merge_files` / `save_link` / `download_url` / `download_media` / `draw` /
 * `read_drawing`. Faithful to the Rust source (whose own sweep test iterates
 * that table and so cannot see past it), and harmless while all nine arms are
 * stubs — but Batch D must port each arm's OWN argument validation rather than
 * assuming the central guard covered it. `toolSchema.test.ts` pins the gap by
 * name so it cannot be mistaken for coverage.
 */

import type { ToolCallResult, ToolContent, ToolDispatcher, ToolScope, ToolSpec } from "./mcpBridge.js";
import { includeMcp } from "./mcpBridge.js";
import type { CancelFlagLike } from "./mcpBridge.js";
import {
  MAX_ADVISOR_CALLS,
  browseToolsSpecs,
  consultAdvisorSpec,
  downloadToolsSpecs,
  drawToolsSpecs,
  externalAgentToolsSpecs,
  jobToolsSpecs,
  mcpManagementToolsSpecs,
  mediaToolsSpecs,
  organizeToolsSpecs,
  scriptToolsSpecs,
  studioToolsSpecs,
  toolsCatalog,
  transcribeToolsSpecs,
  uiToolsSpecs,
  webLanesAreAll,
  webLanesBlock,
  workflowToolsSpecs,
  WEB_LANES_ALL,
  type McpRoute,
  type OllamaToolSpec,
  type WebLanes,
} from "./toolSpecs.js";
import { execTool, type ExecToolDeps, type ToolEffects } from "./execTool.js";

// ------------------------------------------------------------ ToolScope extras

/**
 * The app-driving/screen-observing tools (`ui_snapshot`, `ui_act`,
 * `view_screenshot`). Ported verbatim from `ToolScope::include_ui_tools`.
 */
export function includeUiTools(scope: ToolScope): boolean {
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent";
}

/** The whole-file-pass job tools. Ported verbatim from
 * `ToolScope::include_job_tools`. */
export function includeJobTools(scope: ToolScope): boolean {
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent";
}

/** `local_generate`. Ported verbatim from `ToolScope::include_external_tools`. */
export function includeExternalTools(scope: ToolScope): boolean {
  return scope.kind === "ExternalAgent";
}

/** `view_media_frame`. Ported verbatim from
 * `ToolScope::include_media_perception`. */
export function includeMediaPerception(scope: ToolScope): boolean {
  return scope.kind === "CloudEngine" || scope.kind === "ExternalAgent";
}

/** BROWSE-1's tools. Ported verbatim from `ToolScope::include_browse_tools`. */
export function includeBrowseTools(scope: ToolScope): boolean {
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent";
}

/** The File agent's organize box. Ported verbatim from
 * `ToolScope::include_organize_tools`. */
export function includeOrganizeTools(scope: ToolScope): boolean {
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent";
}

/** Connector CRUD. Ported verbatim from
 * `ToolScope::include_mcp_management_tools`. */
export function includeMcpManagementTools(scope: ToolScope): boolean {
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine";
}

/** The tier's name for the host log. Ported verbatim from `ToolScope::label`. */
export function scopeLabel(scope: ToolScope): string {
  switch (scope.kind) {
    case "CloudAdvisor":
      return scope.includeMcp ? "CloudAdvisor+mcp" : "CloudAdvisor";
    case "CloudEngine":
      return "CloudEngine";
    case "LocalEngine":
      return "LocalEngine";
    case "ExternalAgent":
      return "ExternalAgent";
  }
}

// ------------------------------------------------------------- tool annotations

/**
 * Standard MCP tool hints (readOnly/destructive/idempotent/openWorld) for a
 * built-in tool name. Ported verbatim from `arcelle_tool_annotations` —
 * every arm's reasoning comment is preserved.
 */
export function arcelleToolAnnotations(name: string): Record<string, boolean> | null {
  let readOnly: boolean;
  let destructive: boolean;
  let idempotent: boolean;
  let openWorld: boolean;
  switch (name) {
    // Room/content reads and viewer-only effects.
    case "list_room_files":
    case "search_room":
    case "open_file":
    case "mark_image":
    case "annotate_file":
    case "list_memories":
    case "list_skills":
    case "read_skill":
    case "read_skill_resource":
    case "job_status":
    case "list_workflows":
    case "list_scripts":
    case "stt_status":
    case "ui_snapshot":
    case "view_screenshot":
    case "view_media_frame":
    case "local_generate":
    case "list_mcps":
    case "read_drawing":
    case "read_mcp":
      [readOnly, destructive, idempotent, openWorld] = [true, false, true, false];
      break;
    // Reads that may contact the public web.
    case "web_search":
    case "fetch_page":
      [readOnly, destructive, idempotent, openWorld] = [true, false, true, true];
      break;
    // BROWSE-1: reads of a live web page.
    case "browse_read":
    case "browse_find":
    case "browse_snapshot":
    case "browse_look":
      [readOnly, destructive, idempotent, openWorld] = [true, false, true, true];
      break;
    case "browse_open":
      [readOnly, destructive, idempotent, openWorld] = [true, false, false, true];
      break;
    case "browse_do":
      [readOnly, destructive, idempotent, openWorld] = [false, false, false, true];
      break;
    case "browse_save":
      [readOnly, destructive, idempotent, openWorld] = [false, false, false, false];
      break;
    case "save_link":
    case "download_url":
    case "download_media":
      [readOnly, destructive, idempotent, openWorld] = [false, false, false, true];
      break;
    case "consult_advisor":
      [readOnly, destructive, idempotent, openWorld] = [false, false, false, true];
      break;
    // Recoverable room mutations.
    case "create_file":
    case "edit_file":
    case "edit_files":
    case "write_file":
    case "set_cells":
    case "rename_file":
    case "move_file":
    case "set_in_library":
    case "add_memory":
    case "update_memory":
    case "save_skill":
    case "write_skill_resource":
    case "run_skill_script":
    case "start_file_pass":
    case "save_workflow":
    case "update_workflow":
    case "run_workflow":
    case "run_script":
    case "studio_flashcards":
    case "studio_mindmap":
    case "generate_podcast_script":
    case "draw":
    case "retranscribe_file":
    case "read_recording":
    case "test_workflow":
    case "ui_act":
    case "organize_files":
    case "merge_files":
    case "save_mcp":
      [readOnly, destructive, idempotent, openWorld] = [false, false, false, false];
      break;
    // Deletion is intentionally marked honestly.
    case "trash_files":
    case "delete_memory":
    case "delete_skill":
    case "delete_skill_resource":
    case "delete_workflow":
    case "delete_mcp":
      [readOnly, destructive, idempotent, openWorld] = [false, true, false, false];
      break;
    default:
      return null;
  }
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}

/** Keep only the standard boolean MCP hints from a connected third-party
 * server. Ported verbatim from `sanitized_tool_annotations`. */
export function sanitizedToolAnnotations(value: unknown): Record<string, boolean> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof source[key] === "boolean") {
      out[key] = source[key] as boolean;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Translate one ollama-shaped `{"function": {...}}` spec to an MCP tool
 * record. Ported verbatim from `to_mcp_tool`. */
export function toMcpTool(t: OllamaToolSpec, arcelleOwned: boolean): ToolSpec {
  const f = t.function;
  const annotations = arcelleOwned ? arcelleToolAnnotations(f.name) : sanitizedToolAnnotations(f.annotations);
  const tool: ToolSpec = {
    name: f.name,
    description: f.description ?? "",
    inputSchema: f.parameters ?? { type: "object", properties: {} },
  };
  if (annotations !== null) {
    tool.annotations = annotations;
  }
  return tool;
}

// --------------------------------------------------------------- MCP proxy pair

export const MCP_SEARCH_TOOL = "search_mcp_tools";
export const MCP_RUN_TOOL = "run_mcp_tool";

/** The stable two-tool surface for every connected room connector. Ported
 * verbatim from `mcp_proxy_tools`. */
export function mcpProxyTools(): ToolSpec[] {
  return [
    {
      name: MCP_SEARCH_TOOL,
      description:
        "Search all enabled, connected MCP tools installed in this room. Use this before run_mcp_tool. Returns exact tool ids, connector names, descriptions, and input schemas.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What capability or data source you need, such as stock prices, forecasts, web fetch, or prediction markets.",
          },
          connector: { type: "string", description: "Optional connector name to search within." },
        },
        required: ["query"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: MCP_RUN_TOOL,
      description:
        "Run one connected room MCP tool returned by search_mcp_tools. Pass its exact tool id and arguments matching the returned input schema.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Exact tool id returned by search_mcp_tools." },
          arguments: { type: "object", description: "Arguments matching that tool's input schema." },
        },
        required: ["tool", "arguments"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
}

// ------------------------------------------------------------- connector search

export interface SearchableMcpTool {
  tool: string;
  connector: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Ported verbatim from `searchable_mcp_tools`. */
export function searchableMcpTools(routes: readonly McpRoute[]): SearchableMcpTool[] {
  return routes.map((route) => ({
    tool: route.catalogName,
    connector: route.serverName,
    name: route.toolName,
    description: route.spec.function.description ?? "",
    inputSchema: route.spec.function.parameters,
  }));
}

/** Ported verbatim from `mcp_search_score`. */
export function mcpSearchScore(entry: SearchableMcpTool, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 1;
  }
  const tool = entry.tool.toLowerCase();
  const connector = entry.connector.toLowerCase();
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    total +=
      (tool.includes(term) ? 4 : 0) +
      (name.includes(term) ? 4 : 0) +
      (connector.includes(term) ? 3 : 0) +
      (description.includes(term) ? 1 : 0);
  }
  return total;
}

/** How many connector tools one `search_mcp_tools` call may return. Ported
 * from `MAX_MCP_SEARCH_RESULTS`. */
export const MAX_MCP_SEARCH_RESULTS = 12;

/** Ported verbatim from `search_mcp_entries`, including its ranked-then-
 * alphabetical tie-break. */
export function searchMcpEntries(
  entries: readonly SearchableMcpTool[],
  query: string,
  connector: string | undefined
): SearchableMcpTool[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
  const connectorFilter = connector?.trim();
  const connectorLower =
    connectorFilter !== undefined && connectorFilter.length > 0 ? connectorFilter.toLowerCase() : undefined;
  const scored: Array<[number, SearchableMcpTool]> = [];
  for (const entry of entries) {
    if (connectorLower !== undefined && !entry.connector.toLowerCase().includes(connectorLower)) {
      continue;
    }
    const score = mcpSearchScore(entry, terms);
    if (score > 0) {
      scored.push([score, entry]);
    }
  }
  scored.sort(([scoreA, a], [scoreB, b]) => {
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    return a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;
  });
  return scored.map(([, entry]) => entry);
}

// -------------------------------------------------------------- scoped_specs

/**
 * The built-in room catalog translated to MCP tool records. Ported verbatim
 * from `builtin_mcp_tools` — same source of truth as the local agent
 * (`toolsCatalog`), so the two engines can never drift apart.
 */
export function builtinMcpTools(webEnabled: boolean): ToolSpec[] {
  return toolsCatalog(webEnabled).map((tool) => toMcpTool(tool, true));
}

/**
 * The tier catalog for `scope`, PLUS whatever extra tool group its
 * predicates admit. Ported from `scoped_specs`, group for group and in the
 * same order — `workflow_tools_specs()`, `browse_tools_specs()`,
 * `draw_tools_specs()` and `download_tools_specs()` INCLUDED, even though
 * `execTool.ts` still answers those four with `NOT_IMPLEMENTED`. See the
 * module doc for why that split is the safe direction, and for the one thing
 * serving a group here does not buy.
 *
 * INHERITED WART, not a port slip: for `CloudEngine` and `ExternalAgent` both
 * `includeUiTools` and `includeMediaPerception` hold, so `view_media_frame` is
 * pushed TWICE and appears twice in `tools/list`. Rust's `scoped_specs` does
 * exactly the same (`ui_tools_specs()` contains it and `media_tools_specs()`
 * IS it), and de-duplicating here would make the two catalogs disagree — so
 * the duplicate is kept and written down instead. `callTool`'s allow-check is
 * a `some(...)`, so the duplicate changes nothing about what is callable.
 */
export function scopedSpecs(webEnabled: boolean, scope: ToolScope): ToolSpec[] {
  const list = builtinMcpTools(webEnabled);
  const extras: OllamaToolSpec[] = [];
  if (includeUiTools(scope)) {
    extras.push(...uiToolsSpecs());
  }
  if (includeJobTools(scope)) {
    extras.push(...jobToolsSpecs());
    // Wave 4a: the workflow-authoring tools share the job tools' trust class.
    // save/update only produce drafts a human must activate, and run_workflow
    // is the same compute class as start_file_pass.
    extras.push(...workflowToolsSpecs());
    // Scripts share that trust class; run_script keeps its own consent gate.
    extras.push(...scriptToolsSpecs());
    // Studio generation and on-device transcription: same local-compute trust
    // class (minutes of work, results land as reviewable room files).
    extras.push(...studioToolsSpecs());
    extras.push(...transcribeToolsSpecs());
    // The Sketch page's drawing tools, same trust class for the same reason.
    // A merely CONSULTED advisor still gets none of them — drawing on the
    // user's page is an action, not advice.
    extras.push(...drawToolsSpecs());
  }
  if (includeOrganizeTools(scope)) {
    extras.push(...organizeToolsSpecs());
  }
  if (includeMcpManagementTools(scope)) {
    extras.push(...mcpManagementToolsSpecs());
  }
  if (includeExternalTools(scope)) {
    extras.push(...externalAgentToolsSpecs());
  }
  if (includeMediaPerception(scope)) {
    extras.push(...mediaToolsSpecs());
  }
  // Gated on `webEnabled` — the user's "may this room reach the web" switch —
  // rather than on the browser being open, which would be circular: the model
  // could never call `browse_open` because the tool that opens the browser
  // would only appear once it was already open.
  if (webEnabled && includeBrowseTools(scope)) {
    extras.push(...browseToolsSpecs());
    // BROWSE-2 (D17): the download/save tools share the browse trust class —
    // engine tiers only, never a consulted advisor. Same web gate.
    extras.push(...downloadToolsSpecs());
  }
  list.push(...extras.map((tool) => toMcpTool(tool, true)));
  return list;
}

/** The BUILT-IN tool names one tier may ever be served. Ported from
 * `tier_tool_names`. */
export function tierToolNames(webEnabled: boolean, scope: ToolScope): string[] {
  const specs = scopedSpecs(webEnabled, scope);
  if (includeMcp(scope)) {
    specs.push(...mcpProxyTools());
  }
  return namesOf(specs);
}

function namesOf(tools: readonly ToolSpec[]): string[] {
  return tools.map((t) => t.name);
}

/**
 * The tool names THIS ROOM's bridge would serve right now, for `scope`.
 * Ported from `room_tool_names_with` (the handle-free half of
 * `room_tool_names` — no `tauri::AppHandle`/`AppState` exists to thread
 * through here, so this batch ports only the pinnable half, exactly as the
 * Rust source's own doc comment describes the split).
 */
export function roomToolNamesWith(
  webEnabled: boolean,
  lanes: WebLanes,
  scope: ToolScope,
  routes: readonly McpRoute[]
): string[] {
  return namesOf(servedToolsWith(webEnabled, lanes, scope, null, routes));
}

/**
 * The room's per-agent web switches, re-exported from `toolSpecs.ts` so a
 * caller wiring a bridge has ONE import site for everything the dispatcher's
 * options need. The type itself lives with the specs because
 * {@link webLanesBlock} is defined against the tool NAMES those specs declare.
 */
export { WEB_LANES_ALL, webLanesAreAll, webLanesBlock, type WebLanes };

// ---------------------------------------------------------------- WebThrottle

/**
 * CHG-33: the bridge-lifetime "web search is failing, stop hammering it"
 * brake. Ported from `room_mcp.rs`'s `WebThrottle`/`web_throttled`/
 * `note_web_throttled` (lines ~242-282).
 *
 * `ToolEffects.webSearchThrottled` is where a hard `web_search` failure raises
 * it, and for the LocalEngine scope that flag rides the run-scoped sink, so it
 * survives the whole answer. EVERY other scope — a consulted advisor, an
 * external agent, a headless workflow turn — gets a THROWAWAY `ToolEffects`
 * per `tools/call`, so the flag was dropped before the next call could read it
 * and the model retried the same dead endpoint every round. Holding it HERE
 * fixes that without giving those scopes a run-scoped sink (which would also
 * switch on the per-turn edit-approval cadence).
 *
 * Stored as "when it last failed" rather than a bare bool because the Leash's
 * external-agent bridge lives for the whole session: refusing every search for
 * hours because one was rate-limited is its own bug.
 */
export interface WebThrottle {
  /** Is the brake currently on (and not yet expired)? */
  isOn(): boolean;
  /** Raise the brake, starting a fresh cooldown. */
  raise(): void;
}

/** How long a hard web-search failure keeps the brake on. Ported from
 * `WEB_THROTTLE_COOLDOWN` — 180 seconds. */
export const WEB_THROTTLE_COOLDOWN_MS = 180_000;

/**
 * Seed one call's `ToolEffects` from the bridge-lifetime brake, run it, and
 * carry a newly-raised flag back OUT to the bridge. Ported from the pair of
 * lines around `exec_tool` in `tool_call`'s sink-less branch
 * (`effects.web_search_throttled = was_throttled` … `if
 * effects.web_search_throttled && !was_throttled { note_web_throttled(...) }`).
 *
 * A named unit rather than four lines inline, because it is the whole of
 * CHG-33 and it is testable on its own: the arm that RAISES the flag
 * (`web_search`, on a rate-limit or human-check) is not ported yet, so
 * without this seam the fix would sit in the tree with nothing exercising it
 * until Batch D lands — and "written but never run" is how CHG-33 got
 * reintroduced the first time.
 *
 * `!wasThrottled` in the raise condition is not redundant: re-raising on every
 * call while the brake is already on would slide the cooldown forward forever,
 * and a session-long external-agent bridge would never search again.
 */
export async function withWebBrake<T>(
  throttle: WebThrottle | undefined,
  effects: ToolEffects,
  fn: (effects: ToolEffects) => Promise<T>
): Promise<T> {
  const wasThrottled = throttle?.isOn() ?? false;
  effects.webSearchThrottled = wasThrottled;
  const result = await fn(effects);
  if (effects.webSearchThrottled && !wasThrottled) {
    throttle?.raise();
  }
  return result;
}

/**
 * A {@link WebThrottle} over a monotonic clock. `now` is injected so a test
 * can advance time without sleeping for three minutes; it defaults to
 * `Date.now`, and the Rust source's `Instant::elapsed` is monotonic, which is
 * why this compares a stored stamp rather than trusting the wall clock to move
 * forward.
 */
export function createWebThrottle(now: () => number = Date.now): WebThrottle {
  let lastFailure: number | null = null;
  return {
    isOn(): boolean {
      return lastFailure !== null && now() - lastFailure < WEB_THROTTLE_COOLDOWN_MS;
    },
    raise(): void {
      lastFailure = now();
    },
  };
}

// ------------------------------------------------------------ served_tools_with

/**
 * The full list served over the bridge for `scope`. Ported verbatim from
 * `served_tools_with`.
 */
export function servedToolsWith(
  webEnabled: boolean,
  lanes: WebLanes,
  scope: ToolScope,
  advisor: AdvisorRuntime | null,
  routes: readonly McpRoute[]
): ToolSpec[] {
  let list = scopedSpecs(webEnabled, scope);
  // The room's per-agent web switches, applied HERE because this one
  // function is what both `tools/list` and `tools/call`'s allow-check go
  // through — so a lane the user turned off is neither advertised nor
  // executable.
  if (!webLanesAreAll(lanes)) {
    list = list.filter((t) => !webLanesBlock(lanes, t.name));
  }
  if (scope.kind !== "ExternalAgent") {
    const advisorTool = advisor?.tool() ?? null;
    if (advisorTool !== null) {
      list.push(advisorTool);
    }
  }
  if (includeMcp(scope) && routes.length > 0) {
    list.push(...mcpProxyTools());
  }
  return list;
}

// ------------------------------------------------------------- AdvisorRuntime

/**
 * A top-level model's permission and runtime state for `consult_advisor`.
 * Ported from `AdvisorRuntime` — MINUS `room_bridge: Option<Arc<Bridge>>`,
 * which threads a nested room-tools bridge into a consulted Claude advisor;
 * that nested-bridge wiring is out of scope here (there is no ported
 * process-lifecycle `Bridge` to hand it), so `consult_advisor`'s stub in
 * `execTool.ts` never receives one either way.
 */
export class AdvisorRuntime {
  private calls = 0;

  constructor(
    readonly advisors: readonly string[],
    readonly cancel: CancelFlagLike
  ) {}

  /** Ported from `AdvisorRuntime::tool` — `null` when no recognised CLI is
   * installed. */
  tool(): ToolSpec | null {
    const spec = consultAdvisorSpec(this.advisors);
    if (spec === null) {
      return null;
    }
    return toMcpTool(spec, true);
  }

  /**
   * SATURATING increment-and-check: records this attempt, then reports
   * whether it was UNDER `maxCalls` (i.e. allowed) — mirroring
   * `runtime.calls.fetch_update(...|n| Some(n.saturating_add(1))).
   * unwrap_or(u8::MAX) >= MAX_ADVISOR_CALLS`, which compares the value
   * BEFORE the increment, so `maxCalls` attempts are allowed and every one
   * after is refused.
   *
   * WHAT `Math.min(…, 255)` DOES AND DOES NOT BUY, stated precisely because
   * an earlier version of this comment overclaimed: the bug the Rust source
   * fixed was `fetch_add` on an `AtomicU8` WRAPPING to 0 after 256 refused
   * calls, letting the very next one through. A JS number does not wrap, so
   * a plain `this.calls + 1` here would NOT reintroduce that bug — the clamp
   * is a faithful port of the ported expression's shape, not a live guard,
   * and mutating it away breaks no test because there is nothing to break.
   *
   * What IS guarded, and what the 300-iteration test in
   * `bridgeDispatcher.test.ts` genuinely kills, is the realistic JS spelling
   * of the same mistake: any counter that returns to a value below
   * `maxCalls` — modular arithmetic, a reset, a per-call re-initialisation.
   * The property under test is "once refused, refused forever", which is the
   * property that actually matters for a slow, paid cloud call, and it is
   * asserted directly rather than inferred from the clamp.
   */
  tryConsume(maxCalls: number): boolean {
    const before = this.calls;
    this.calls = Math.min(this.calls + 1, 255);
    return before < maxCalls;
  }
}

/**
 * Which Stop flag one dispatched tool carries down to its own commit gate.
 * Ported verbatim from `tool_cancel_for`.
 */
export function toolCancelFor(
  advisor: AdvisorRuntime | null,
  runCancel: CancelFlagLike | null
): CancelFlagLike | null {
  return advisor?.cancel ?? runCancel;
}

// ---------------------------------------------------------------- privacy seam

/**
 * The room's cloud-privacy redaction engine, restricted to what `tool_call`
 * needs. Ported as an injected seam — see the module doc's OUT OF SCOPE
 * section. TODO(future privacy/redaction batch): implement for real against
 * the room's entity map, matching `privacy.rs`'s `Redactor::restore_value`/
 * `Redactor::redact`.
 */
export interface RedactionPolicy {
  /** `Redactor::restore_value` — placeholders in a cloud client's tool
   * ARGUMENTS become real room values before a room tool sees them. */
  restoreValue(value: unknown): unknown;
  /** `Redactor::redact` — real values in a tool RESULT become placeholders
   * before they leave for a cloud client. Returns the redacted text and how
   * many entities were hidden (the `PrivacyReport::entities_hidden` this
   * batch needs; the other two `PrivacyReport` fields are not threaded
   * through here since nothing in this batch's scope reads them). */
  redact(text: string): { text: string; entitiesHidden: number };
}

/** `commands::active_policy()` — the room's currently active redaction
 * policy, or `null` when cloud privacy is off / no room is open. Injected for
 * the same reason as {@link RedactionPolicy} itself. */
export type ActivePolicy = () => RedactionPolicy | null;

// ------------------------------------------------------------------ tool_call

/** Ported verbatim from `json_kind`. */
function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return "a true/false value";
  if (typeof value === "number") return "a number";
  if (typeof value === "string") return "a string";
  if (Array.isArray(value)) return "an array";
  return "an object";
}

/**
 * The `arguments` a `run_mcp_tool` call carries FOR the connector tool, or
 * the complaint to hand back to the model. Ported verbatim from
 * `nested_run_arguments`.
 */
export function nestedRunArguments(
  args: Record<string, unknown>,
  target: string
): { ok: true; value: Record<string, unknown> } | { ok: false; complaint: string } {
  const nested = args.arguments;
  if (nested === undefined || nested === null) {
    return { ok: true, value: {} };
  }
  if (typeof nested === "object" && !Array.isArray(nested)) {
    return { ok: true, value: nested as Record<string, unknown> };
  }
  return {
    ok: false,
    complaint:
      `run_mcp_tool's \`arguments\` must be a JSON object matching ${target}'s inputSchema, ` +
      `not ${jsonKind(nested)}. Call it again with the arguments as an object.`,
  };
}

/**
 * Build the JSON-RPC `tools/call` result envelope. Ported verbatim from
 * `tool_result`, `mimeType` included.
 *
 * The image block is EXACTLY the Phase-1 sidecar shape —
 * `{"type":"image","data":<standard-base64>,"mimeType":"image/png"}` — with no
 * `data:` URI prefix (the sidecar prepends `data:image/png;base64,` itself) and
 * `mimeType` camelCase per MCP spec `2024-11-05`.
 *
 * `mimeType` is load-bearing even though `mcp_client.py`'s
 * `_parse_tool_result` ignores it: this bridge also serves `claude -p` and
 * `codex exec`, which parse image content per the MCP spec, where the field is
 * REQUIRED. Leaving it off makes our own Python client happy and a cloud CLI's
 * image block malformed — the kind of gap that only shows up in the one
 * configuration nobody tests.
 *
 * On `isError` only the text is used, so images attach to a successful result
 * only.
 */
export function toolResult(text: string, isError: boolean, images: readonly string[]): ToolCallResult {
  const content: ToolContent[] = [{ type: "text", text }];
  if (!isError) {
    for (const data of images) {
      content.push({ type: "image", data, mimeType: "image/png" });
    }
  }
  return { isError, content };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a `tools/call`'s raw `arguments` field. Ported verbatim from the
 * `tool_call` body's own normalization: MCP says `arguments` is an object,
 * but a model can emit anything and the transport forwards it verbatim —
 * a non-object becomes `{}` rather than reaching code that indexes it. Rust's
 * comment is explicit that `serde_json`'s `IndexMut` PANICS on a non-object;
 * the JS analogue of that crash is a later `args["question"]`-style access
 * throwing on a string/array/number, so this guard is exactly as load-bearing
 * here as it is there.
 */
function normalizeArguments(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? raw : {};
}

/**
 * Constructor options for {@link RoomToolDispatcher}. Deliberately has NO
 * `scope` field: `ToolDispatcher`'s interface (already ported in
 * `mcpBridge.ts`) takes `scope` as a per-CALL parameter to both `listTools`
 * and `callTool`, mirroring how `McpBridge` holds one fixed scope for its
 * whole lifetime and passes it down to `dispatchJsonRpc` on every request —
 * so this dispatcher reads `scope` from its call arguments, never from
 * stored options, and there is exactly one place a caller can get that
 * value wrong (the `McpBridge` construction site), not two.
 */
export interface RoomToolDispatcherOptions {
  webEnabled: boolean;
  lanes: WebLanes;
  routes: readonly McpRoute[];
  /** `null` for no per-turn advisor runtime (the common case: most rooms have
   * no Advisor configured) — mirrors `prepare_advisor_runtime` returning
   * `None`. */
  advisor: AdvisorRuntime | null;
  /** The ask's own cancel flag (`run_cancel` in the Rust source), or `null`. */
  runCancel: CancelFlagLike | null;
  /** `Some(effects_sink)` in the Rust source: a run-scoped `ToolEffects` that
   * PERSISTS across every call this turn (the LocalEngine posture). `null`
   * (throwaway effects created fresh per call) for every other scope. */
  sharedEffects: ToolEffects | null;
  /** `privacy_bypass` — when true, no cloud-redaction policy is applied even
   * for a cloud-bound scope. */
  privacyBypass: boolean;
  /** `commands::active_policy()`, injected — see {@link ActivePolicy}. */
  activePolicy: ActivePolicy;
  /** CHG-33's bridge-lifetime web-search brake. Optional: a bridge without one
   * behaves exactly as before the brake existed (every scope retries), which
   * is the right default for a caller that has not thought about it yet — but
   * a real per-ask bridge should pass {@link createWebThrottle}'s result. */
  webThrottle?: WebThrottle;
  /** `execTool.ts`'s dependency bundle, reused for every dispatched call.
   * Its own `routes` field is IGNORED and overwritten with this options
   * object's top-level `routes` at call time, so there is exactly one place
   * (this `routes` field) a caller sets the connector list — matching the
   * Rust source, where `tool_call` computes `routes` once and it is both
   * the served-catalog check's and `exec_tool`'s routes argument. */
  execDeps: ExecToolDeps;
  /** Set unconditionally, BEFORE dispatch, on every scope — the authoritative
   * "a tool ran on this bridge" signal a sidecar-side fallback guard reads
   * (mirrors `Bridge.tool_ran`, an `AtomicBool` the Rust source sets before
   * `exec_tool` runs specifically so a crash right after the commit can never
   * be misread as "no tool ran"). Optional because most callers/tests have
   * nothing listening for it yet. */
  markToolRan?: () => void;
  /** Trusted workspace filesystem projection used by Deep Agents. It accepts
   * only virtual room paths and never exposes the SQLCipher key or host path. */
  workspace?: {
    call(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  } | null;
}

const WORKSPACE_TOOL_SPECS: ToolSpec[] = ([
  ["workspace_list", "List normal files and folders in one workspace directory."],
  ["workspace_read", "Read a line range from a normal text file."],
  ["workspace_write", "Create or atomically replace a normal text file."],
  ["workspace_edit", "Replace exact text in a normal text file."],
  ["workspace_delete", "Move one normal file to Arcelle Trash."],
  ["workspace_glob", "Find normal workspace files by a glob pattern."],
  ["workspace_grep", "Search normal workspace text files for literal text."],
] as const).map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: "object", additionalProperties: true },
}));

function workspaceTools(scope: ToolScope, workspace: RoomToolDispatcherOptions["workspace"]): ToolSpec[] {
  if (workspace == null) return [];
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent"
    ? WORKSPACE_TOOL_SPECS
    : [];
}

function standardWorkspaceOperation(name: string): string | null {
  switch (name) {
    case "create_file": return "standard_create";
    case "write_file": return "standard_write";
    case "edit_file": return "standard_edit";
    case "rename_file": return "standard_rename";
    case "move_file": return "standard_move";
    case "trash_files": return "standard_trash";
    case "edit_files":
    case "set_cells":
      return "standard_unsupported";
    default:
      return null;
  }
}

/**
 * THE REAL {@link ToolDispatcher}. Ported from `room_mcp.rs`'s `tool_call`
 * (the transport-independent dispatch body — everything from "only an
 * advertised tool is callable" through the cloud-redaction wrap at the end).
 *
 * JUDGMENT CALL — how `tool_call`'s `Result<Value, String>` maps onto an
 * interface that returns a bare `Promise<ToolCallResult>`: in the REAL Rust
 * source, `tool_call`'s `Err(String)` (unknown tool, `consult_advisor`
 * reached with no `AdvisorRuntime`, …) becomes a JSON-RPC `error` object
 * (code -32601) in `dispatch_jsonrpc`'s `match result { Err(msg) => … }` arm.
 * `mcpBridge.ts`'s ALREADY-PORTED `dispatchJsonRpc`, however, has no such
 * arm for `tools/call` — it does `outcome = { ok: true, value: await
 * dispatcher.callTool(...) }` unconditionally, so the only way this
 * dispatcher could produce that Rust behavior would be to THROW, which
 * `dispatchJsonRpc` does not catch at the JSON-RPC layer either — it would
 * surface as an opaque HTTP 500 from `McpBridge.handleRequest`'s outer
 * catch, not Rust's well-formed 200-with-JSON-RPC-error-object. Since the
 * refusals in question ("unknown tool", "no AdvisorRuntime for this bridge")
 * are ordinary, EXPECTED outcomes a model can perfectly well react to — not
 * bugs — this port instead folds every one of them into an `isError: true`
 * {@link ToolCallResult}, matching `mcpBridge.ts`'s own stated wire doctrine
 * ("a tool FAILURE … comes back as a normal result with `isError: true`").
 * A thrown exception is reserved for what it already meant one layer up: a
 * genuine bug, never a modeled refusal.
 */
export class RoomToolDispatcher implements ToolDispatcher {
  constructor(private readonly opts: RoomToolDispatcherOptions) {}

  listTools(scope: ToolScope): ToolSpec[] {
    return [
      ...servedToolsWith(this.opts.webEnabled, this.opts.lanes, scope, this.opts.advisor, this.opts.routes),
      ...workspaceTools(scope, this.opts.workspace),
    ];
  }

  async callTool(scope: ToolScope, name: string, rawArgs: Record<string, unknown>): Promise<ToolCallResult> {
    const { opts } = this;
    const toolCancel = toolCancelFor(opts.advisor, opts.runCancel);

    // PRIV-1: a cloud-bound scope restores placeholders in the incoming
    // arguments and redacts the outgoing result, unless bypassed.
    const cloudPolicy: RedactionPolicy | null =
      (scope.kind === "CloudAdvisor" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent") &&
      !opts.privacyBypass
        ? opts.activePolicy()
        : null;

    // Only an advertised tool for THIS scope is callable, even if a client
    // fabricates a name — checked against the SAME served list `tools/list`
    // returns, so the two can never disagree.
    const served = [
      ...servedToolsWith(opts.webEnabled, opts.lanes, scope, opts.advisor, opts.routes),
      ...workspaceTools(scope, opts.workspace),
    ];
    if (!served.some((t) => t.name === name)) {
      // See this class's doc: an ordinary refusal, folded into isError:true
      // rather than thrown.
      return toolResult(`unknown tool: ${name}`, true, []);
    }

    // A real, advertised tool is about to hit `execTool` — record it NOW,
    // before the (possibly side-effecting) dispatch, unconditionally, on
    // every scope. See `markToolRan`'s doc for why the ordering is
    // load-bearing rather than cosmetic.
    opts.markToolRan?.();

    let args = normalizeArguments(rawArgs);
    if (cloudPolicy !== null) {
      const restored = cloudPolicy.restoreValue(args);
      args = normalizeArguments(restored);
    }

    const workspaceOperation = name.startsWith("workspace_")
      ? name.slice("workspace_".length)
      : standardWorkspaceOperation(name);
    if (workspaceOperation !== null && opts.workspace != null) {
      const operation = workspaceOperation;
      const payload = await opts.workspace.call(operation, args);
      const isError = typeof payload.error === "string" && payload.error.length > 0;
      const text = JSON.stringify(payload);
      if (cloudPolicy !== null) {
        return toolResult(cloudPolicy.redact(text).text, isError, []);
      }
      return toolResult(text, isError, []);
    }

    if (name === "consult_advisor") {
      const runtime = opts.advisor;
      if (runtime === null) {
        // Defensive-only, matching the Rust source's own comment: a nested
        // bridge with no `AdvisorRuntime` never advertises `consult_advisor`
        // via `servedToolsWith` in the first place, so the check above
        // already refused a fabricated call before this line — this exists
        // only so that invariant stays true even if that gating ever drifts.
        return toolResult("unknown tool: consult_advisor", true, []);
      }
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (question.length === 0) {
        return toolResult("consult_advisor requires a non-empty, self-contained question.", true, []);
      }
      const requested = typeof args.advisor === "string" ? args.advisor : undefined;
      let chosen: string;
      if (requested === "claude" && runtime.advisors.includes("claude-cli")) {
        chosen = "claude";
      } else if (requested === "codex" && runtime.advisors.includes("codex-cli")) {
        chosen = "codex";
      } else if (requested !== undefined) {
        return toolResult(`Advisor ${JSON.stringify(requested)} is not installed or available for this turn.`, true, []);
      } else if (runtime.advisors.includes("claude-cli")) {
        chosen = "claude";
      } else {
        chosen = "codex";
      }
      args = { ...args, advisor: chosen };
      // SATURATING, not a plain increment — see `AdvisorRuntime.tryConsume`'s
      // own doc for the wrapping-counter bug this must not reintroduce.
      if (!runtime.tryConsume(MAX_ADVISOR_CALLS)) {
        return toolResult(
          "You have already consulted an advisor this turn. Use that answer instead of consulting again.",
          false,
          []
        );
      }
    }

    if (name === MCP_SEARCH_TOOL) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length === 0) {
        return toolResult("search_mcp_tools requires a non-empty query.", true, []);
      }
      const connector = typeof args.connector === "string" ? args.connector : undefined;
      const entries = searchableMcpTools(opts.routes);
      const matches = searchMcpEntries(entries, query, connector);
      const total = matches.length;
      const shown = matches.slice(0, MAX_MCP_SEARCH_RESULTS);
      const next =
        total > shown.length
          ? `Showing the ${shown.length} best of ${total} matches — search again with more ` +
            `specific words if none fit. Then call run_mcp_tool with an exact ` +
            `tool id and arguments matching its inputSchema.`
          : "Call run_mcp_tool with an exact tool id and arguments matching its inputSchema.";
      const text = JSON.stringify(
        { count: shown.length, total_matches: total, matches: shown, next },
        null,
        2
      );
      return toolResult(text, false, []);
    }

    let dispatchName = name;
    let dispatchArgs = args;
    if (name === MCP_RUN_TOOL) {
      const target = typeof args.tool === "string" ? args.tool : undefined;
      if (target === undefined) {
        return toolResult(
          "run_mcp_tool requires the exact tool id returned by search_mcp_tools.",
          true,
          []
        );
      }
      if (!opts.routes.some((r) => r.catalogName === target)) {
        return toolResult(
          `Unknown or disconnected room MCP tool: ${target}. Search again with search_mcp_tools.`,
          true,
          []
        );
      }
      const nested = nestedRunArguments(args, target);
      if (!nested.ok) {
        return toolResult(nested.complaint, true, []);
      }
      dispatchName = target;
      dispatchArgs = nested.value;
    }

    const execDeps: ExecToolDeps = { ...opts.execDeps, routes: opts.routes, cancel: toolCancel };
    const { text, isError, images } = await this.dispatch(scope, dispatchName, dispatchArgs, execDeps);

    if (cloudPolicy !== null) {
      // Real values out of the room tools → placeholders for the cloud client,
      // and NO PIXELS AT ALL: an image cannot be redacted, so it does not leave.
      const redacted = cloudPolicy.redact(text);
      return toolResult(redacted.text, isError, []);
    }
    return toolResult(text, isError, images);
  }

  /**
   * Run one call against the right `ToolEffects`, draining the images it
   * captured. Ported from `tool_call`'s `match effects_sink` — both branches.
   *
   * ADD-33: the LOCAL engine accumulates into the run-scoped sink so
   * `wrote`/`annotation`/`boxes` reach the post-answer gate, and the Rust
   * source holds a `tokio::sync::Mutex` guard across the WHOLE `exec_tool`
   * await, serialising concurrent bridge calls into that one sink. That
   * serialisation is behaviour, not incidental locking: two `tools/call`s can
   * genuinely overlap on this bridge, and an interleaved `splice` on
   * `pendingImages` would hand one call's screenshot back with the other
   * call's text. {@link EffectsSink} is the JS equivalent — a promise chain,
   * since there is no lock to take.
   *
   * Every other scope gets a THROWAWAY per call (its effects are correctly
   * discarded), which is exactly why the web-search brake below cannot live on
   * it. See {@link WebThrottle}.
   */
  private async dispatch(
    scope: ToolScope,
    name: string,
    args: Record<string, unknown>,
    execDeps: ExecToolDeps
  ): Promise<{ text: string; isError: boolean; images: string[] }> {
    const { opts } = this;
    const run = async (effects: ToolEffects): Promise<{ text: string; isError: boolean; images: string[] }> => {
      let text: string;
      let isError: boolean;
      try {
        const outcome = await execTool(name, args, effects, execDeps);
        if (outcome.ok) {
          text = outcome.text;
          isError = false;
        } else {
          text = outcome.error;
          isError = true;
        }
      } catch (e) {
        // A THROW is a bug, not a modeled refusal — but it must still come
        // back as a tool-shaped failure rather than killing the connection
        // task with no HTTP response, which is what the Rust source's own
        // `IndexMut` panic comment is about one layer up.
        text = e instanceof Error ? e.message : String(e);
        isError = true;
      }
      // DRAIN here so captured pixels ride exactly one tool result and are
      // never re-sent on the next call.
      const images = effects.pendingImages.splice(0, effects.pendingImages.length);
      return { text, isError, images };
    };

    if (opts.sharedEffects !== null) {
      const shared = opts.sharedEffects;
      return this.serialise(async () => {
        // Wave 2 (Idea 6): only the run-scoped sink lives for the whole
        // answer, so "Apply for the rest of this answer" is meaningful here
        // (and hidden for the sink-less scopes below).
        shared.runScoped = true;
        return run(shared);
      });
    }

    // CHG-33: seed the web-search brake from the BRIDGE, not from this
    // throwaway. Without it a failed search raised the flag, the `ToolEffects`
    // carrying it was dropped at the end of this call, and the model searched
    // again — every round, forever.
    return withWebBrake(opts.webThrottle, createThrowawayEffects(scope), run);
  }

  /** The promise chain standing in for Rust's `sink.lock().await` — each call
   * waits for the previous one to finish, whether it resolved or rejected. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private queue: Promise<unknown> = Promise.resolve();
}

/** The throwaway `ToolEffects` a non-LocalEngine call gets — matches the
 * Rust source's `None` branch: `vision_chat` is set for `ExternalAgent`
 * (parity with the in-room agent's content-perception tool), everything
 * else is default. */
function createThrowawayEffects(scope: ToolScope): ToolEffects {
  return {
    boxes: null,
    annotation: null,
    wrote: false,
    webSearchThrottled: false,
    advisorCalls: 0,
    pendingImages: [],
    visionChat: scope.kind === "ExternalAgent",
    editOutcomes: [],
    runScoped: false,
    editApprovedThisTurn: false,
    tokenUsage: null,
    agentPlan: null,
  };
}
