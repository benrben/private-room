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
import type { ToolCallResult, ToolScope, ToolSpec } from "./mcpBridge.js";
import type { CancelFlagLike } from "./mcpBridge.js";
import { MAX_ADVISOR_CALLS, type McpRoute, type WebLanes } from "./toolSpecs.js";
import { type ExecToolDeps, type ToolEffects } from "./execTool.js";
import { type ActivePolicy, AdvisorRuntime, nestedRunArguments, normalizeArguments, type RedactionPolicy, servedToolsWith, toolResult, type WebThrottle } from "./bridgeRuntime.js";
import { MAX_MCP_SEARCH_RESULTS, MCP_RUN_TOOL, namesOf, searchableMcpTools, searchMcpEntries } from "./bridgeCatalog.js";


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
    call(
      operation: string,
      args: Record<string, unknown>,
      redactedMirrorArgs?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  } | null;
}


const WORKSPACE_PATH_DESCRIPTION =
  "A path relative to the exposed workspace root. A leading slash is accepted. Never use an absolute host path or .arcelle.";


/**
 * Exact MCP contracts for the normal-file backend. These schemas are model
 * instructions as well as validation metadata: an open-ended object caused
 * native agents to guess `name`, `file`, or `files` for destructive calls,
 * which the backend correctly ignored because it requires `path`.
 */
const WORKSPACE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "workspace_list",
    description: "List normal files and folders. Use path to limit the listing to one workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: `${WORKSPACE_PATH_DESCRIPTION} Omit it or use / for the workspace root.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workspace_read",
    description: "Read normal UTF-8 text from exactly one workspace file. This tool does not read binary files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: WORKSPACE_PATH_DESCRIPTION },
        offset: { type: "integer", minimum: 0, description: "Zero-based line offset. Defaults to 0." },
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum lines to return. Defaults to 2000." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_write",
    description: "Create or atomically replace one normal UTF-8 text file. Call with exactly path and content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: WORKSPACE_PATH_DESCRIPTION },
        content: { type: "string", description: "The complete new UTF-8 file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_edit",
    description: "Replace exact text in one normal UTF-8 text file. The edit fails if old_string is absent or ambiguous unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: WORKSPACE_PATH_DESCRIPTION },
        old_string: { type: "string", minLength: 1, description: "Exact existing text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_delete",
    description: "Move exactly one normal file to recoverable Arcelle Trash. Call once per file with {\"path\":\"delete-me.txt\"}.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: WORKSPACE_PATH_DESCRIPTION },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_move",
    description: "Move or rename exactly one normal file, including a binary file, to an exact destination path. Call with source_path and destination_path.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", minLength: 1, description: `Existing file. ${WORKSPACE_PATH_DESCRIPTION}` },
        destination_path: { type: "string", minLength: 1, description: `Exact new file path, including its file name. ${WORKSPACE_PATH_DESCRIPTION}` },
      },
      required: ["source_path", "destination_path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_rename",
    description: "Rename exactly one normal file, including a binary file, inside its current folder. Call with source_path and the new file name only.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", minLength: 1, description: `Existing file. ${WORKSPACE_PATH_DESCRIPTION}` },
        new_name: { type: "string", minLength: 1, description: "The new base file name only, with no slash or folder path." },
      },
      required: ["source_path", "new_name"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_glob",
    description: "Find normal workspace files whose relative paths match a glob pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Glob such as **/*.md or *.pdf." },
        path: { type: "string", description: `${WORKSPACE_PATH_DESCRIPTION} Omit it or use / to search the whole workspace.` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_grep",
    description: "Search normal UTF-8 workspace text files for literal text.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Literal text to find." },
        path: { type: "string", description: `${WORKSPACE_PATH_DESCRIPTION} Omit it or use / to search the whole workspace.` },
        max_count: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum matching lines to return. Defaults to 1000." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];


export function workspaceTools(scope: ToolScope, workspace: RoomToolDispatcherOptions["workspace"]): ToolSpec[] {
  if (workspace == null) return [];
  return scope.kind === "LocalEngine" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent"
    ? WORKSPACE_TOOL_SPECS
    : [];
}


const STANDARD_WORKSPACE_OPERATIONS = new Map<string, string>([
  ["create_file", "standard_create"],
  ["write_file", "standard_write"],
  ["edit_file", "standard_edit"],
  ["rename_file", "standard_rename"],
  ["move_file", "standard_move"],
  ["trash_files", "standard_trash"],
  ["edit_files", "standard_unsupported"],
  ["set_cells", "standard_unsupported"],
]);


function standardWorkspaceOperation(name: string): string | null {
  return STANDARD_WORKSPACE_OPERATIONS.get(name) ?? null;
}


/**
 * File-producing or file-reorganising tools whose legacy execTool arms target
 * the real room. During Cloud Privacy they must never bypass the redacted
 * workspace backend. The simple create/edit/rename/move/trash tools are not in
 * this set because standardWorkspaceOperation routes them through that backend.
 */
const MIRROR_UNROUTED_WORKSPACE_MUTATIONS = new Set([
  "organize_files",
  "merge_files",
  "set_in_library",
  "save_link",
  "download_url",
  "download_media",
  "browse_save",
  "run_script",
  "run_skill_script",
  "save_workflow",
  "update_workflow",
  "delete_workflow",
  "start_file_pass",
  "run_workflow",
  "test_workflow",
  "studio_flashcards",
  "studio_mindmap",
  "generate_podcast_script",
  "draw",
  "retranscribe_file",
  "local_generate",
  "ui_act",
  // Pixel results cannot pass through the text redaction mirror. Advertising
  // any of these tools under Cloud Privacy guarantees a result whose image block is
  // stripped before the provider can inspect it.
  "view_media_frame",
  "view_screenshot",
  "view_file_image",
  "read_drawing",
  "browse_look",
]);


/**
 * Whether Cloud Privacy must hide a tool because its implementation still
 * writes directly to the real room instead of going through the validated
 * redacted-workspace backend. Exported so specialist discovery can derive the
 * same effective capability catalog as tools/list.
 */
export function cloudPrivacyBlocksDirectTool(name: string): boolean {
  return MIRROR_UNROUTED_WORKSPACE_MUTATIONS.has(name);
}


/** Apply the Cloud Privacy capability door to an already-scoped catalog. */
export function effectiveToolsForCloudPrivacy(
  tools: readonly ToolSpec[],
  cloudPrivacyActive: boolean,
): ToolSpec[] {
  return cloudPrivacyActive
    ? tools.filter((tool) => !cloudPrivacyBlocksDirectTool(tool.name))
    : [...tools];
}


/**
 * The effective names advertised to a cloud engine for this room. This is the
 * discovery-side counterpart of RoomToolDispatcher.listTools/callTool.
 */
export function effectiveRoomToolNamesWith(
  webEnabled: boolean,
  lanes: WebLanes,
  scope: ToolScope,
  routes: readonly McpRoute[],
  cloudPrivacyActive: boolean,
): string[] {
  const applies = cloudPrivacyActive
    && (scope.kind === "CloudAdvisor" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent");
  return namesOf(effectiveToolsForCloudPrivacy(
    servedToolsWith(webEnabled, lanes, scope, null, routes),
    applies,
  ));
}


interface PreparedCallArguments {
  readonly redactedArgs: Record<string, unknown>;
  readonly args: Record<string, unknown>;
}


type AdvisorPreparation = { readonly args: Record<string, unknown> } | { readonly result: ToolCallResult };

type DispatchPreparation =
  | { readonly dispatchName: string; readonly dispatchArgs: Record<string, unknown> }
  | { readonly result: ToolCallResult };


function isCloudBoundScope(scope: ToolScope): boolean {
  return scope.kind === "CloudAdvisor" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent";
}


export function cloudPolicyForCall(scope: ToolScope, opts: RoomToolDispatcherOptions): RedactionPolicy | null {
  if (!isCloudBoundScope(scope) || opts.privacyBypass) return null;
  return opts.activePolicy();
}


export function callToolsForScope(scope: ToolScope, opts: RoomToolDispatcherOptions): ToolSpec[] {
  return [
    ...servedToolsWith(opts.webEnabled, opts.lanes, scope, opts.advisor, opts.routes),
    ...workspaceTools(scope, opts.workspace),
  ];
}


function privacyBlocksUnservedTool(
  name: string,
  unfilteredServed: readonly ToolSpec[],
  cloudPolicy: RedactionPolicy | null,
): boolean {
  if (cloudPolicy === null || !cloudPrivacyBlocksDirectTool(name)) return false;
  return unfilteredServed.some((tool) => tool.name === name);
}


export function unavailableToolResult(
  name: string,
  unfilteredServed: readonly ToolSpec[],
  cloudPolicy: RedactionPolicy | null,
): ToolCallResult {
  if (privacyBlocksUnservedTool(name, unfilteredServed, cloudPolicy)) {
    return toolResult(
      `${name} is unavailable while Cloud Privacy is active because it cannot use the validated redacted workspace. `
      + "Switch the model to On this Mac to use this action.",
      true,
      [],
    );
  }
  return toolResult(`unknown tool: ${name}`, true, []);
}


function restoredCallArguments(redactedArgs: Record<string, unknown>, cloudPolicy: RedactionPolicy | null): Record<string, unknown> {
  if (cloudPolicy === null) return redactedArgs;
  return normalizeArguments(cloudPolicy.restoreValue(structuredClone(redactedArgs)));
}


export function preparedCallArguments(rawArgs: unknown, cloudPolicy: RedactionPolicy | null): PreparedCallArguments {
  const redactedArgs = normalizeArguments(rawArgs);
  return { redactedArgs, args: restoredCallArguments(redactedArgs, cloudPolicy) };
}


export function workspaceOperationFor(name: string): string | null {
  return name.startsWith("workspace_") ? name.slice("workspace_".length) : standardWorkspaceOperation(name);
}


function workspacePayloadIsError(payload: Record<string, unknown>): boolean {
  return typeof payload.error === "string" && payload.error.length > 0;
}


export function workspacePayloadResult(payload: Record<string, unknown>, cloudPolicy: RedactionPolicy | null): ToolCallResult {
  const text = JSON.stringify(payload);
  const isError = workspacePayloadIsError(payload);
  return cloudPolicy === null
    ? toolResult(text, isError, [])
    : toolResult(cloudPolicy.redact(text).text, isError, []);
}


function advisorQuestion(args: Record<string, unknown>): string {
  return typeof args.question === "string" ? args.question.trim() : "";
}


function requestedAdvisor(args: Record<string, unknown>): string | undefined {
  return typeof args.advisor === "string" ? args.advisor : undefined;
}


function installedAdvisor(runtime: AdvisorRuntime, requested: "claude" | "codex"): "claude" | "codex" | undefined {
  const engine = requested === "claude" ? "claude-cli" : "codex-cli";
  return runtime.advisors.includes(engine) ? requested : undefined;
}


function selectedAdvisor(runtime: AdvisorRuntime, requested: string | undefined): "claude" | "codex" | undefined {
  if (requested === "claude") return installedAdvisor(runtime, requested);
  if (requested === "codex") return installedAdvisor(runtime, requested);
  if (requested !== undefined) return undefined;
  return runtime.advisors.includes("claude-cli") ? "claude" : "codex";
}


export function advisorPreparation(runtime: AdvisorRuntime | null, args: Record<string, unknown>): AdvisorPreparation {
  if (runtime === null) return { result: toolResult("unknown tool: consult_advisor", true, []) };
  if (advisorQuestion(args).length === 0) {
    return { result: toolResult("consult_advisor requires a non-empty, self-contained question.", true, []) };
  }
  const requested = requestedAdvisor(args);
  const chosen = selectedAdvisor(runtime, requested);
  if (chosen === undefined) {
    return { result: toolResult(`Advisor ${JSON.stringify(requested)} is not installed or available for this turn.`, true, []) };
  }
  if (!runtime.tryConsume(MAX_ADVISOR_CALLS)) {
    return {
      result: toolResult(
        "You have already consulted an advisor this turn. Use that answer instead of consulting again.",
        false,
        [],
      ),
    };
  }
  return { args: { ...args, advisor: chosen } };
}


export function mcpSearchResult(args: Record<string, unknown>, routes: readonly McpRoute[]): ToolCallResult {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0) return toolResult("search_mcp_tools requires a non-empty query.", true, []);
  const connector = typeof args.connector === "string" ? args.connector : undefined;
  const matches = searchMcpEntries(searchableMcpTools(routes), query, connector);
  const shown = matches.slice(0, MAX_MCP_SEARCH_RESULTS);
  const next = matches.length > shown.length
    ? `Showing the ${shown.length} best of ${matches.length} matches — search again with more `
      + "specific words if none fit. Then call run_mcp_tool with an exact "
      + "tool id and arguments matching its inputSchema."
    : "Call run_mcp_tool with an exact tool id and arguments matching its inputSchema.";
  return toolResult(JSON.stringify({ count: shown.length, total_matches: matches.length, matches: shown, next }, null, 2), false, []);
}


function mcpRunPreparation(args: Record<string, unknown>, routes: readonly McpRoute[]): DispatchPreparation {
  const target = typeof args.tool === "string" ? args.tool : undefined;
  if (target === undefined) {
    return { result: toolResult("run_mcp_tool requires the exact tool id returned by search_mcp_tools.", true, []) };
  }
  if (!routes.some((route) => route.catalogName === target)) {
    return { result: toolResult(`Unknown or disconnected room MCP tool: ${target}. Search again with search_mcp_tools.`, true, []) };
  }
  const nested = nestedRunArguments(args, target);
  if (!nested.ok) return { result: toolResult(nested.complaint, true, []) };
  return { dispatchName: target, dispatchArgs: nested.value };
}


export function dispatchPreparation(name: string, args: Record<string, unknown>, routes: readonly McpRoute[]): DispatchPreparation {
  return name === MCP_RUN_TOOL ? mcpRunPreparation(args, routes) : { dispatchName: name, dispatchArgs: args };
}


export function dispatchedToolResult(
  text: string,
  isError: boolean,
  images: readonly string[],
  cloudPolicy: RedactionPolicy | null,
): ToolCallResult {
  if (cloudPolicy === null) return toolResult(text, isError, images);
  return toolResult(cloudPolicy.redact(text).text, isError, []);
}
