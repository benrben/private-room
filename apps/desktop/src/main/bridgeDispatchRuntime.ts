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
import type { ToolCallResult, ToolDispatcher, ToolScope, ToolSpec } from "./mcpBridge.js";
import type { CancelFlagLike } from "./mcpBridge.js";
import { execTool, type ExecToolDeps, type ToolEffects } from "./execTool.js";
import { advisorPreparation, callToolsForScope, cloudPolicyForCall, dispatchedToolResult, dispatchPreparation, effectiveToolsForCloudPrivacy, mcpSearchResult, preparedCallArguments, type RoomToolDispatcherOptions, unavailableToolResult, workspaceOperationFor, workspacePayloadResult, workspaceTools } from "./bridgeDispatchPreparation.js";
import { type RedactionPolicy, servedToolsWith, toolCancelFor, withWebBrake } from "./bridgeRuntime.js";
import { MCP_SEARCH_TOOL } from "./bridgeCatalog.js";


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
    const cloudPrivacyActive =
      (scope.kind === "CloudAdvisor" || scope.kind === "CloudEngine" || scope.kind === "ExternalAgent")
      && !this.opts.privacyBypass
      && this.opts.activePolicy() !== null;
    return effectiveToolsForCloudPrivacy([
      ...servedToolsWith(this.opts.webEnabled, this.opts.lanes, scope, this.opts.advisor, this.opts.routes),
      ...workspaceTools(scope, this.opts.workspace),
    ], cloudPrivacyActive);
  }

  async callTool(scope: ToolScope, name: string, rawArgs: Record<string, unknown>): Promise<ToolCallResult> {
    const { opts } = this;
    const toolCancel = toolCancelFor(opts.advisor, opts.runCancel);
    const cloudPolicy = cloudPolicyForCall(scope, opts);
    const unfilteredServed = callToolsForScope(scope, opts);
    const served = effectiveToolsForCloudPrivacy(unfilteredServed, cloudPolicy !== null);
    if (!served.some((t) => t.name === name)) {
      return unavailableToolResult(name, unfilteredServed, cloudPolicy);
    }
    opts.markToolRan?.();
    return this.callAdvertisedTool(scope, name, rawArgs, cloudPolicy, toolCancel);
  }

  private async callAdvertisedTool(
    scope: ToolScope,
    name: string,
    rawArgs: unknown,
    cloudPolicy: RedactionPolicy | null,
    toolCancel: CancelFlagLike | null,
  ): Promise<ToolCallResult> {
    const { redactedArgs, args } = preparedCallArguments(rawArgs, cloudPolicy);
    const workspaceResult = await this.workspaceResult(name, args, redactedArgs, cloudPolicy);
    if (workspaceResult !== null) return workspaceResult;
    const advisor = name === "consult_advisor" ? advisorPreparation(this.opts.advisor, args) : { args };
    if ("result" in advisor) return advisor.result;
    if (name === MCP_SEARCH_TOOL) return mcpSearchResult(advisor.args, this.opts.routes);
    const prepared = dispatchPreparation(name, advisor.args, this.opts.routes);
    if ("result" in prepared) return prepared.result;
    const execDeps: ExecToolDeps = { ...this.opts.execDeps, routes: this.opts.routes, cancel: toolCancel };
    const outcome = await this.dispatch(scope, prepared.dispatchName, prepared.dispatchArgs, execDeps);
    return dispatchedToolResult(outcome.text, outcome.isError, outcome.images, cloudPolicy);
  }

  private async workspaceResult(
    name: string,
    args: Record<string, unknown>,
    redactedArgs: Record<string, unknown>,
    cloudPolicy: RedactionPolicy | null,
  ): Promise<ToolCallResult | null> {
    const operation = workspaceOperationFor(name);
    const workspace = this.opts.workspace;
    if (operation === null || workspace == null) return null;
    const payload = await workspace.call(operation, args, redactedArgs);
    return workspacePayloadResult(payload, cloudPolicy);
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
    mediaFrames: [],
    visionChat: scope.kind === "ExternalAgent",
    editOutcomes: [],
    runScoped: false,
    editApprovedThisTurn: false,
    tokenUsage: null,
    agentPlan: null,
  };
}
