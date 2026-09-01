/** Cohesive extraction from workflowEngine.ts; the facade preserves its public API. */
import { CancelFlag } from "./cancel.js";
import { laneSlots, type Lane, type RoomSource } from "./jobs.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { busy, deliverCancel, ensureUp } from "./sidecar.js";
import { sidecarErrorSentinel, sidecarJsonCancellable, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import { stripHtml } from "./editMatchHtml.js";
import { type FetchedPage } from "./webFetch.js";
import { executeScriptInWorkspace } from "./scriptRun.js";
import { type EmitFn, type ResolvePassEngine, type SidecarPostFn } from "./filePass.js";
import { asRecord, KEEP_ALIVE_WARM, replaceLiteral, SIDECAR_CHAIN_TIMEOUT_MS, type WfNodePostFn } from "./workflowEngineInputs.js";


/**
 * A `CancelFlag` that, the FIRST time it observes its wrapped flag go `true`,
 * fires a best-effort `/cancel` delivery for `runId`. `delivered()` resolves
 * once that attempt has settled.
 *
 * This exists so {@link sidecarJsonCancellableRun} can reuse the already-
 * reviewed {@link sidecarJsonCancellable} transport verbatim instead of
 * hand-copying its fetch/abort/poll/timeout loop a second time (a copy would
 * be one more place to forget to clear a ten-hour timer, and one more place
 * for the two to drift). The one deliberate ordering difference from Rust —
 * the socket drop and the `/cancel` POST race, rather than strictly
 * sequencing "deliver, THEN drop" — does not change what actually stops the
 * sidecar's work: that is the `/cancel` POST landing on a SEPARATE
 * connection, which happens either way.
 */
class DeliverCancelOnStop extends CancelFlag {
  private deliveryPromise: Promise<void> | null = null;

  constructor(
    private readonly inner: CancelFlag,
    private readonly runId: string
  ) {
    super();
  }

  override load(): boolean {
    const flagged = this.inner.load();
    if (flagged && this.deliveryPromise === null) {
      this.deliveryPromise = (async () => {
        try {
          const base = await ensureUp();
          const guard = busy();
          try {
            await deliverCancel(base, this.runId);
          } finally {
            guard.release();
          }
        } catch {
          // Best-effort, matching Rust's `if let Ok(base) = ensure_up().await`:
          // if the sidecar is unreachable the chain finishes on its own, which
          // is the pre-existing behavior, not worse.
        }
      })();
    }
    return flagged;
  }

  delivered(): Promise<void> {
    return this.deliveryPromise ?? Promise.resolve();
  }
}


/**
 * Like {@link sidecarJsonCancellable}, but for a CHAIN endpoint (`/wf_node`)
 * that runs many generations behind one POST and therefore cannot be stopped
 * by hanging up: measured against the sidecar's pinned uvicorn/starlette, a
 * non-streaming handler kept running seconds past a hard disconnect, which on
 * `Lane::LocalLlm`'s single slot would waste up to six more generations. So
 * Stop is DELIVERED, not implied — POST `/cancel` with the same `run_id` the
 * body carried. Ported from `sidecar_json_cancellable_run`.
 */
export async function sidecarJsonCancellableRun(
  path: string,
  body: unknown,
  cancel: CancelFlag,
  runId: string,
  timeoutMs: number = SIDECAR_CHAIN_TIMEOUT_MS
): Promise<SidecarPostOutcome> {
  if (cancel.load()) {
    // Never reached the sidecar at all — nothing is registered under `runId`
    // for a `/cancel` to find, so there is nothing to deliver.
    return { kind: "stopped" };
  }
  const derived = new DeliverCancelOnStop(cancel, runId);
  const outcome = await sidecarJsonCancellable(path, body, derived, timeoutMs);
  await derived.delivered();
  return outcome;
}


/**
 * The workflow's single LLM entry point: one cancellable `/generate` call with
 * an optional structured-output `format` schema. The `generate` node and
 * `for_each_file`'s per-file calls both come through here, so engine-parity
 * and Stop behave identically across them. Ported from `wf_generate`.
 */
export async function wfGenerate(
  post: SidecarPostFn,
  model: string,
  prompt: string,
  format: unknown | undefined,
  cancel: CancelFlag
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    base_url: resolvedBaseUrl(),
    messages: [{ role: "user", content: prompt }],
    keep_alive: KEEP_ALIVE_WARM,
  };
  if (format !== undefined) {
    body.format = format;
  }
  const outcome = await post("/generate", body, cancel);
  if (outcome.kind === "stopped") {
    throw new Error("STOPPED");
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  const text = asRecord(outcome.value)?.text;
  return typeof text === "string" ? text : "";
}


/** The reserved top-level payload keys `wf_node_value` guards. A node's own
 * body fields are merged UNDER these, never over them — see this module's
 * doc. */
const WF_NODE_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "model",
  "base_url",
  "keep_alive",
  "run_id",
  "parallel",
]);


/**
 * Build one `/wf_node` payload. Ported from `wf_node_value`'s payload
 * construction — read this module's RESERVED KEYS section before changing it.
 */
export function buildWfNodePayload(
  kind: string,
  model: string,
  runId: string,
  lane: Lane,
  body: unknown
): Record<string, unknown> {
  const payload: Record<string, unknown> = Object.create(null);
  payload.kind = kind;
  // TOP-LEVEL, deliberately: `sidecar_json` keys `inject_policy` and
  // `inject_provider_runtime` off `body["model"]`, so nesting it would
  // silently drop the privacy door and the Keychain-backed provider
  // credentials on a cloud engine.
  payload.model = model;
  payload.base_url = resolvedBaseUrl();
  payload.keep_alive = KEEP_ALIVE_WARM;
  payload.run_id = runId;
  // The lane budget, re-imposed INSIDE the step. `plan_dispatch` enforces
  // `local_llm => 1` ACROSS steps because the local model and Whisper are
  // serial; a fan-out inside ONE step would bypass it entirely.
  payload.parallel = laneSlots(lane);
  const fields = asRecord(body);
  if (fields !== null) {
    for (const [k, v] of Object.entries(fields)) {
      if (!WF_NODE_RESERVED_KEYS.has(k)) {
        payload[k] = v;
      }
    }
  }
  return payload;
}


/**
 * Run one workflow CHAIN node in the sidecar's LangGraph (MIGRATION slice
 * 1/2/3, owner decision 2026-07-25: "Rust drives, Python thinks"). Ported from
 * `wf_node_value`.
 */
export async function wfNodeValue(
  post: WfNodePostFn,
  kind: string,
  model: string,
  jobId: string,
  stepId: number,
  lane: Lane,
  body: unknown,
  cancel: CancelFlag
): Promise<Record<string, unknown>> {
  const runId = `${jobId}:${stepId}`;
  const payload = buildWfNodePayload(kind, model, runId, lane, body);
  const outcome = await post("/wf_node", payload, cancel, runId, SIDECAR_CHAIN_TIMEOUT_MS);
  if (outcome.kind === "stopped") {
    throw new Error("STOPPED");
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  const v = asRecord(outcome.value);
  // The sidecar's own Stop answer maps to the same sentinel the host-side one
  // produces — `spawn_workflow_job` normalises it to Paused either way.
  if (v?.stopped === true) {
    throw new Error("STOPPED");
  }
  return v ?? {};
}


/** The common case: a chain node whose whole artifact is its text. Ported from
 * `wf_node`. */
export async function wfNode(
  post: WfNodePostFn,
  kind: string,
  model: string,
  jobId: string,
  stepId: number,
  lane: Lane,
  body: unknown,
  cancel: CancelFlag
): Promise<string> {
  const v = await wfNodeValue(post, kind, model, jobId, stepId, lane, body, cancel);
  return typeof v.result === "string" ? v.result : "";
}


// ============================================================================
// summarize_file's shared sentinel policy (jobs.rs::classify_liner /
// summarize_one_liner + summarize.rs::summarize_one_file)
// ============================================================================

/** What caching ONE file's one-liner produced. Ported from `LinerOutcome`. */
export type LinerOutcome =
  | { readonly kind: "cached"; readonly liner: string }
  | { readonly kind: "stuck" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "hard"; readonly error: string };


/** One file's one-liner model call — Rust's `summarize_one_file`. Throws on
 * failure (this port's `Result<String,String>` convention). */
export type SummarizeOneFileFn = (model: string, name: string, mime: string, text: string) => Promise<string>;


/**
 * The REAL `/summarize_file` client — a thin proxy, exactly like Rust's
 * `summarize_one_file`: all of the compute (smart_filter, the read_text
 * paging, the structured call and `clean_one_liner`) already lives in the
 * sidecar endpoint, so this posts the same six fields and reads `summary`.
 *
 * Rust calls the NON-cancellable `sidecar_json` here deliberately — the
 * `summarize_file` node checks Stop BETWEEN files, never mid-call, so a call
 * that has started always runs to completion. A fresh {@link CancelFlag} that
 * nothing can flip reproduces exactly that through the already-ported
 * cancellable transport, rather than duplicating a second POST client for the
 * sake of one missing feature.
 */
export const summarizeOneFileViaSidecar: SummarizeOneFileFn = async (model, name, mime, text) => {
  const body = { model, name, text, mime, base_url: resolvedBaseUrl(), keep_alive: KEEP_ALIVE_WARM };
  const outcome = await sidecarJsonCancellable("/summarize_file", body, new CancelFlag());
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  if (outcome.kind === "stopped") {
    // Unreachable: the flag above is never handed to anything that could set
    // it. Kept as an honest branch rather than a cast that claims otherwise.
    throw new Error("STOPPED");
  }
  // Already clean_one_liner'd on the sidecar (≤200 chars, may be "").
  const summary = asRecord(outcome.value)?.summary;
  return typeof summary === "string" ? summary : "";
};


/**
 * The sentinel policy as a pure decision over what the model call returned —
 * testable without a model. Ported from `classify_liner`. See `LinerOutcome`
 * for why an empty ANSWER and a failed CALL must not land in the same bucket.
 *
 * ONE ADDITION beyond the Rust original: an error whose text starts with this
 * port's own `NOT_IMPLEMENTED:` sentinel (which cannot occur in Rust, and
 * cannot come from the real endpoint) classifies as `hard`, never `failed` — a
 * per-file "trying again next time" line would silently mask an entire
 * unported capability as ordinary network flakiness.
 */
export function classifyLiner(reply: { ok: true; liner: string } | { ok: false; error: string }): LinerOutcome {
  if (reply.ok) {
    return reply.liner.trim() !== "" ? { kind: "cached", liner: reply.liner } : { kind: "stuck" };
  }
  const e = reply.error;
  if (e === "OLLAMA_DOWN" || e.startsWith("MODEL_MISSING") || e.startsWith("NOT_IMPLEMENTED")) {
    return { kind: "hard", error: e };
  }
  return { kind: "failed", error: e };
}


/** Ported from `summarize_one_liner` — the classify-wrapped call. */
export async function summarizeOneLiner(
  fn: SummarizeOneFileFn,
  model: string,
  name: string,
  mime: string,
  text: string
): Promise<LinerOutcome> {
  try {
    return classifyLiner({ ok: true, liner: await fn(model, name, mime, text) });
  } catch (err) {
    return classifyLiner({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}


// ============================================================================
// apply_transform / apply_merge (workflow.rs:1428-1471) — pure, unit-tested
// ============================================================================

const USIZE_DIGITS = /^\+?[0-9]+$/;


/** `v.trim().parse::<usize>().unwrap_or(0)` — a STRICT integer parse (a
 * decimal point, a `-`, or trailing junk is the Rust parse FAILURE, i.e. 0),
 * never `parseInt`'s lenient "read a prefix" behavior. */
function parseUsizeOrZero(raw: string): number {
  const t = raw.trim();
  if (!USIZE_DIGITS.test(t)) {
    return 0;
  }
  const big = BigInt(t.startsWith("+") ? t.slice(1) : t);
  // No realistic text is longer than Number.MAX_SAFE_INTEGER characters, so
  // clamping here reads as "take everything" — which is what a `usize` that
  // large would also do.
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
}


type TextTransform = (find: string | null, value: string | null, input: string) => string;


function replaceTransform(find: string | null, value: string | null, input: string): string {
  return find !== null && find !== "" ? replaceLiteral(input, find, value ?? "") : input;
}


const TEXT_TRANSFORMS: Readonly<Record<string, TextTransform>> = {
  append: (_find, value, input) => `${input}${value ?? ""}`,
  prepend: (_find, value, input) => `${value ?? ""}${input}`,
  // LITERAL, like Rust's `str::replace` — see this module's doc on why
  // `String.replaceAll` would expand `$&`/`` $` ``/`$'`/`$1` in `value`.
  replace: replaceTransform,
  upper: (_find, _value, input) => input.toUpperCase(),
  lower: (_find, _value, input) => input.toLowerCase(),
  trim: (_find, _value, input) => input.trim(),
  truncate: (_find, value, input) => Array.from(input).slice(0, parseUsizeOrZero(value ?? "")).join(""),
  strip_html: (_find, _value, input) => stripHtml(input),
};


/** Pure deterministic text transform (unit-tested). Ported from
 * `apply_transform`. */
export function applyTransform(op: string, find: string | null, value: string | null, input: string): string {
  return (TEXT_TRANSFORMS[op] ?? ((_find, _value, original) => original))(find, value, input);
}


/** Rust's `str::lines()`: split on `\n`, strip a preceding `\r`, and — unlike
 * a bare `.split("\n")` — never yield a trailing EMPTY segment for a string
 * that simply ended with `\n`. `""` has zero lines, not one empty one. */
function rustLines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}


/** Pure fan-in reducer over the live incoming branch results (unit-tested).
 * Ported from `apply_merge`. */
function dedupedLines(inputs: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of inputs) {
    for (const line of rustLines(block)) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out.join("\n");
}


/** Pure fan-in reducer over the live incoming branch results (unit-tested).
 * Ported from `apply_merge`. */
export function applyMerge(mode: string, separator: string | null, inputs: readonly string[]): string {
  const sep = separator ?? "\n\n";
  if (mode === "numbered") return inputs.map((input, index) => `${index + 1}. ${input}`).join(sep);
  if (mode === "dedupe_lines") return dedupedLines(inputs);
  return inputs.join(sep); // "concat", and anything unrecognized — validation catches that earlier.
}


// ============================================================================
// executor seams
// ============================================================================

/** A headless agent-turn runner, injected by the concrete spawner so the
 * generic executor stays mock-drivable. Ported from `AgentRunFn`. */
export type AgentRunFn = (question: string, cancel?: CancelFlag, roomPath?: string) => Promise<string>;


export const AGENT_RUN_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: run_agent_headless (workflow.rs:2429-2535, past this batch's range — a headless " +
  "agent turn needs room/tool/engine state, the sidecar loop or an external-CLI bridge) has no Electron port yet.";


/** The stub the `agent_run` arm falls back to — "stub, don't fake",
 * `jobs.ts`'s `renderPodcastAudioNotImplemented` convention. */
export const agentRunNotImplemented: AgentRunFn = () => Promise.reject(new Error(AGENT_RUN_NOT_IMPLEMENTED));


/**
 * Marks the error of a `script_run` step that PARKED for the user's approval
 * instead of failing. A later batch's `park_outcome` strips it and lands the
 * run as paused with the reason attached. It has exactly two readers, and both
 * strip it before anything is shown: that one, and the node-status emit in
 * {@link executeWorkflowStep}. Ported from `NEEDS_APPROVAL`.
 */
export const NEEDS_APPROVAL = "NEEDS_APPROVAL: ";


/**
 * Everything {@link executeWorkflowStep}/{@link runWorkflowNode} need beyond
 * their own arguments — the "no `AppState`/`tauri::Window` port exists yet"
 * seam `jobs.ts`/`filePass.ts`/`scriptRun.ts` already establish, not a second
 * one. Every optional field defaults to the REAL implementation, except
 * `agentRun` and `resolveEngine`, whose Rust originals genuinely have no
 * Electron port and which fall back to labeled refusals.
 */
export interface WorkflowStepDeps {
  rooms: RoomSource;
  /** `app.path().app_cache_dir()` — `runScriptProcess`'s script workspaces
   * live underneath it. Required, because `scriptRun.ts` IS ported: refusing a
   * `script_run` node for a directory Electron can always supply would be a
   * fake gap. */
  cacheDir: string;
  /** The live pipeline-diagram sink — see this module's doc (Phase 2 gap).
   * Also forwarded to `driveFilePass`, which emits its own progress. */
  emit?: EmitFn;
  /** `/generate` transport (the `generate` node, and `for_each_file`'s
   * per-file calls). Defaults to the real {@link sidecarJsonCancellable}. */
  post?: SidecarPostFn;
  /** `/wf_node` transport (extract/route/vote/refine/plan_and_map). Defaults
   * to the real {@link sidecarJsonCancellableRun}. */
  wfNodePost?: WfNodePostFn;
  /** `run_agent_headless` — genuinely unported; defaults to a refusal. */
  agentRun?: AgentRunFn;
  /** `resolve_pass_engine` — genuinely unported; passed straight through to
   * {@link driveFilePass}, which applies its OWN refusal default. */
  resolveEngine?: ResolvePassEngine;
  /** Defaults to the real {@link summarizeOneFileViaSidecar}. */
  summarizeOneFile?: SummarizeOneFileFn;
  /** `crate::web::fetch_page` — defaults to `webFetch.ts`'s SSRF-guarded
   * {@link realFetchPage}; overridable so tests need no network. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** `main_window(app).emit("room-files-changed", ())` — the same optional
   * callback shape `turnEngine.ts`'s `AskDeps` uses for the identical Rust
   * broadcast, since no `BrowserWindow` wiring exists in this migration yet. */
  notifyFilesChanged?: () => void;
  /** Test seam passed straight through to `runScriptProcess`'s own
   * `ScriptRunDeps.execute`. */
  scriptExecute?: typeof executeScriptInWorkspace;
}
