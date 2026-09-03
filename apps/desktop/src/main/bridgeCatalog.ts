/** Cohesive extraction from bridgeDispatcher.ts; the facade preserves its public API. */
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
import type { ToolScope, ToolSpec } from "./mcpBridge.js";
import { includeMcp } from "./mcpBridge.js";
import { browseToolsSpecs, downloadToolsSpecs, drawToolsSpecs, externalAgentToolsSpecs, jobToolsSpecs, mcpManagementToolsSpecs, mediaToolsSpecs, organizeToolsSpecs, scriptToolsSpecs, skinToolsSpecs, studioToolsSpecs, toolsCatalog, transcribeToolsSpecs, uiToolsSpecs, workflowToolsSpecs, type McpRoute, type OllamaToolSpec, type WebLanes } from "./toolSpecs.js";
import { servedToolsWith } from "./bridgeRuntime.js";


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

type ToolAnnotationValues = readonly [
  readOnly: boolean,
  destructive: boolean,
  idempotent: boolean,
  openWorld: boolean,
];


function annotationEntries(
  names: readonly string[],
  values: ToolAnnotationValues,
): Array<[string, ToolAnnotationValues]> {
  return names.map((name) => [name, values]);
}


const CLOSED_READ: ToolAnnotationValues = [true, false, true, false];

const OPEN_READ: ToolAnnotationValues = [true, false, true, true];

const OPEN_NON_IDEMPOTENT: ToolAnnotationValues = [true, false, false, true];

const OPEN_MUTATION: ToolAnnotationValues = [false, false, false, true];

const ROOM_MUTATION: ToolAnnotationValues = [false, false, false, false];

const DELETION: ToolAnnotationValues = [false, true, false, false];


/** The switch-equivalent registry of each built-in tool's standard MCP hints.
 * The grouped values retain the original categories while allowing the lookup
 * itself to remain small and total. */
const ARCELLE_TOOL_ANNOTATIONS: ReadonlyMap<string, ToolAnnotationValues> = new Map([
  // Room/content reads and viewer-only effects.
  ...annotationEntries(
    [
      "list_room_files",
      "search_room",
      "open_file",
      "view_file_image",
      "mark_image",
      "annotate_file",
      "list_memories",
      "list_skills",
      "read_skill",
      "read_skill_resource",
      "job_status",
      "list_workflows",
      "list_scripts",
      "stt_status",
      "ui_snapshot",
      "view_screenshot",
      "view_media_frame",
      "read_skin",
      "validate_skin",
      "local_generate",
      "list_mcps",
      "read_drawing",
      "read_mcp",
    ],
    CLOSED_READ,
  ),
  // Reads that may contact the public web, including BROWSE-1 page reads.
  ...annotationEntries(
    ["web_search", "fetch_page", "browse_read", "browse_find", "browse_snapshot", "browse_look"],
    OPEN_READ,
  ),
  ...annotationEntries(["browse_open"], OPEN_NON_IDEMPOTENT),
  ...annotationEntries(["browse_do", "save_link", "download_url", "download_media", "consult_advisor"], OPEN_MUTATION),
  // Recoverable room mutations, including browse_save.
  ...annotationEntries(
    [
      "browse_save",
      "create_file",
      "edit_file",
      "edit_files",
      "write_file",
      "set_cells",
      "rename_file",
      "move_file",
      "set_in_library",
      "add_memory",
      "update_memory",
      "save_skill",
      "write_skill_resource",
      "run_skill_script",
      "start_file_pass",
      "save_workflow",
      "update_workflow",
      "run_workflow",
      "run_script",
      "studio_flashcards",
      "studio_mindmap",
      "generate_podcast_script",
      "draw",
      "retranscribe_file",
      "read_recording",
      "test_workflow",
      "ui_act",
      "update_skin_draft",
      "undo_skin_change",
      "save_skin",
      "organize_files",
      "merge_files",
      "save_mcp",
    ],
    ROOM_MUTATION,
  ),
  // Deletion is intentionally marked honestly.
  ...annotationEntries(
    ["trash_files", "delete_memory", "delete_skill", "delete_skill_resource", "delete_workflow", "delete_mcp"],
    DELETION,
  ),
]);


/**
 * Standard MCP tool hints (readOnly/destructive/idempotent/openWorld) for a
 * built-in tool name. Ported from `arcelle_tool_annotations`.
 */
export function arcelleToolAnnotations(name: string): Record<string, boolean> | null {
  const values = ARCELLE_TOOL_ANNOTATIONS.get(name);
  if (!values) return null;
  const [readOnly, destructive, idempotent, openWorld] = values;
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}


/** Keep only the standard boolean MCP hints from a connected third-party
 * server. Ported verbatim from `sanitized_tool_annotations`. */
function annotationSource(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object") return null;
  if (value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}


function copyBooleanAnnotation(source: Record<string, unknown>, output: Record<string, boolean>, key: string): void {
  if (typeof source[key] === "boolean") output[key] = source[key] as boolean;
}


export function sanitizedToolAnnotations(value: unknown): Record<string, boolean> | null {
  const source = annotationSource(value);
  if (source === null) return null;
  const out: Record<string, boolean> = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    copyBooleanAnnotation(source, out, key);
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
function searchTermScore(text: string, term: string, score: number): number {
  return text.includes(term) ? score : 0;
}


function mcpTermScore(entry: SearchableMcpTool, term: string): number {
  return (
    searchTermScore(entry.tool.toLowerCase(), term, 4)
    + searchTermScore(entry.name.toLowerCase(), term, 4)
    + searchTermScore(entry.connector.toLowerCase(), term, 3)
    + searchTermScore(entry.description.toLowerCase(), term, 1)
  );
}


export function mcpSearchScore(entry: SearchableMcpTool, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  return terms.reduce((total, term) => total + mcpTermScore(entry, term), 0);
}


/** How many connector tools one `search_mcp_tools` call may return. Ported
 * from `MAX_MCP_SEARCH_RESULTS`. */
export const MAX_MCP_SEARCH_RESULTS = 12;


/** Ported verbatim from `search_mcp_entries`, including its ranked-then-
 * alphabetical tie-break. */
function searchTerms(query: string): string[] {
  return query.split(/\s+/).map((term) => term.toLowerCase()).filter((term) => term.length > 0);
}


function connectorFilterValue(connector: string | undefined): string | undefined {
  const trimmed = connector?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed.toLowerCase();
}


function connectorMatches(entry: SearchableMcpTool, connector: string | undefined): boolean {
  return connector === undefined || entry.connector.toLowerCase().includes(connector);
}


function scoredMcpEntries(
  entries: readonly SearchableMcpTool[],
  terms: readonly string[],
  connector: string | undefined,
): Array<[number, SearchableMcpTool]> {
  const scored: Array<[number, SearchableMcpTool]> = [];
  for (const entry of entries) {
    if (!connectorMatches(entry, connector)) continue;
    const score = mcpSearchScore(entry, terms);
    if (score > 0) scored.push([score, entry]);
  }
  return scored;
}


function compareMcpEntries([scoreA, a]: [number, SearchableMcpTool], [scoreB, b]: [number, SearchableMcpTool]): number {
  if (scoreB !== scoreA) return scoreB - scoreA;
  return a.tool.localeCompare(b.tool);
}


export function searchMcpEntries(
  entries: readonly SearchableMcpTool[],
  query: string,
  connector: string | undefined
): SearchableMcpTool[] {
  const scored = scoredMcpEntries(entries, searchTerms(query), connectorFilterValue(connector));
  scored.sort(compareMcpEntries);
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
function jobScopedTools(): OllamaToolSpec[] {
  return [
    ...jobToolsSpecs(),
    ...workflowToolsSpecs(),
    ...scriptToolsSpecs(),
    ...studioToolsSpecs(),
    ...transcribeToolsSpecs(),
    ...drawToolsSpecs(),
  ];
}


function browseScopedTools(): OllamaToolSpec[] {
  return [...browseToolsSpecs(), ...downloadToolsSpecs()];
}


function appendToolsWhen(target: OllamaToolSpec[], include: boolean, tools: () => OllamaToolSpec[]): void {
  if (include) target.push(...tools());
}


export function scopedSpecs(webEnabled: boolean, scope: ToolScope): ToolSpec[] {
  const list = builtinMcpTools(webEnabled);
  const extras: OllamaToolSpec[] = [];
  appendToolsWhen(extras, includeUiTools(scope), uiToolsSpecs);
  appendToolsWhen(extras, includeUiTools(scope), skinToolsSpecs);
  appendToolsWhen(extras, includeJobTools(scope), jobScopedTools);
  appendToolsWhen(extras, includeOrganizeTools(scope), organizeToolsSpecs);
  appendToolsWhen(extras, includeMcpManagementTools(scope), mcpManagementToolsSpecs);
  appendToolsWhen(extras, includeExternalTools(scope), externalAgentToolsSpecs);
  appendToolsWhen(extras, includeMediaPerception(scope), mediaToolsSpecs);
  appendToolsWhen(extras, webEnabled && includeBrowseTools(scope), browseScopedTools);
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


export function namesOf(tools: readonly ToolSpec[]): string[] {
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
