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
import type { ToolCallResult, ToolContent, ToolScope, ToolSpec } from "./mcpBridge.js";
import { includeMcp } from "./mcpBridge.js";
import type { CancelFlagLike } from "./mcpBridge.js";
import { consultAdvisorSpec, webLanesAreAll, webLanesBlock, type McpRoute, type WebLanes } from "./toolSpecs.js";
import { type ToolEffects } from "./execTool.js";
import { mcpProxyTools, scopedSpecs, toMcpTool } from "./bridgeCatalog.js";


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
function laneFilteredTools(webEnabled: boolean, lanes: WebLanes, scope: ToolScope): ToolSpec[] {
  const tools = scopedSpecs(webEnabled, scope);
  return webLanesAreAll(lanes) ? tools : tools.filter((tool) => !webLanesBlock(lanes, tool.name));
}


function appendAdvisorTool(tools: ToolSpec[], scope: ToolScope, advisor: AdvisorRuntime | null): void {
  if (scope.kind === "ExternalAgent") return;
  const advisorTool = advisor?.tool() ?? null;
  if (advisorTool !== null) tools.push(advisorTool);
}


function appendMcpProxyTools(tools: ToolSpec[], scope: ToolScope, routes: readonly McpRoute[]): void {
  if (includeMcp(scope) && routes.length > 0) tools.push(...mcpProxyTools());
}


export function servedToolsWith(
  webEnabled: boolean,
  lanes: WebLanes,
  scope: ToolScope,
  advisor: AdvisorRuntime | null,
  routes: readonly McpRoute[]
): ToolSpec[] {
  const tools = laneFilteredTools(webEnabled, lanes, scope);
  appendAdvisorTool(tools, scope, advisor);
  appendMcpProxyTools(tools, scope, routes);
  return tools;
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
export function normalizeArguments(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? raw : {};
}
