/**
 * `ollama.rs`'s ONE-SHOT GENERATION surface — the only slice of
 * `src-tauri/src/ollama.rs` (847 lines, read in full) that no Electron port
 * covers yet: `plain_generate_body`, `generate`, `StructuredOpts`,
 * `chat_structured`, and the `sidecar_post` + `post_generate_cancellable`
 * plumbing those two share.
 *
 * `generate`/`chat_structured` have real callers all over the Rust tree —
 * `commands/vision.rs:221`, `commands/studios.rs:387,565`,
 * `commands/chat_commands.rs:310,356`, `commands/stt_cmds.rs:853`,
 * `commands/recording_cmds.rs:1603`, `commands/browse/search.rs:413`,
 * `commands/agent.rs:4595,4608,5163`, `recording.rs:2742` and
 * `commands/jobs/workflow.rs:3662` — so this is a real gap, not a
 * speculative one. The last of those is the seam `workflowCompose.ts` already
 * declares (see "THE workflowCompose SEAM" below).
 *
 * ══════════════════ ALREADY PORTED ELSEWHERE — VERIFIED, NOT ASSUMED ═══════
 * Every claim below was checked by reading BOTH sides. None of it is
 * re-declared here; re-porting any of it would be the "second X shape" this
 * migration keeps warning about.
 *
 *   - `resolved_base_url`/`set_base_url_override`/`base_url` (the C1
 *     override > env > default layering, ollama.rs:16-62) →
 *     `engineRouting.ts:65-102` (`resolvedBaseUrl`/`setBaseUrlOverride`).
 *   - `strip_think_spans` (ollama.rs:457-472) → `engineRouting.ts:212-225`
 *     (`stripThinkSpans`), imported here, never re-declared.
 *   - `handoff_summary` (ollama.rs:426-451) → `engineRouting.ts:232-268`
 *     (`handoffSummary`/`handoffSummaryAt`).
 *   - `list_models` (ollama.rs:692-703) → `engineRouting.ts`'s `listModels`
 *     (failure folded to `[]`) and `ollamaModels.ts`'s private `rawListModels`
 *     (the raw Ok/Err split `ai_status` needs).
 *   - `embed` (ollama.rs:503-527) → `retrievalBackfill.ts:226-281`
 *     (`embedAt`/`embedViaSidecar`). CONFIRMED the same endpoint under the
 *     same shape: POST `/embed` with `{model, texts, base_url, keep_alive}`,
 *     parsed as `{embeddings}` with the same "a non-array entry is an empty
 *     vector" reading. Nothing to port.
 *   - `EMBED_MODEL` (ollama.rs:68) → `retrievalBackfill.ts:137` and
 *     `turnContext.ts:57` (each with its own documented copy).
 *   - `capabilities`, `native_context_length`, `delete_model`, `warm`,
 *     `pull`/`pull_cancellable`, `PULL_CANCELLED`, `PULL_STALL_TIMEOUT`,
 *     `METADATA_TIMEOUT` → `ollamaModels.ts` (`ollamaCapabilities`,
 *     `ollamaNativeContextLength`, `deleteModel`, `warm`,
 *     `pullCancellable`/`pullCancellableAt`/`pullModel`, `PULL_CANCELLED`,
 *     `PULL_STALL_TIMEOUT_MS`, `METADATA_TIMEOUT_MS`).
 *   - `ChatMessage` (ollama.rs:70-90) → `sidecar.ts:775-786`
 *     ({@link SidecarChatMessage}), whose own doc states it is "exactly ...
 *     what `crate::ollama::ChatMessage` already serializes to". Its
 *     `ChatMessage::new(role, content)` constructor is a plain object literal
 *     in TS and needs no port.
 *   - `client`/`client_timeout`/`metadata_client`/`map_send_err`/
 *     `map_sidecar_error`/`sidecar_post` (ollama.rs:107-226) → subsumed by
 *     `sidecarJsonCancellable.ts` (`sidecarJsonCancellable` = ensure-up +
 *     busy guard + POST + timeout + cancel-abort, on the same 3600s
 *     `SIDECAR_TIMEOUT` budget `client_timeout()` reads; `sidecarErrorSentinel`
 *     = the `{code,error}` classification), which `ollamaModels.ts` already
 *     builds its own gateway calls on.
 *
 *     ONE HONEST DIFFERENCE, shared with `ollamaModels.ts` and stated rather
 *     than glossed: `sidecarErrorSentinel` is `sidecar.rs`'s
 *     `SidecarError::sentinel`, a strict SUPERSET of `ollama.rs`'s
 *     `map_sidecar_error` — it adds a `SIDECAR_DOWN` arm (which `ollama.rs`
 *     never reaches, because there `ensure_up`'s failure propagates as a bare
 *     string) and runs `humanize_empty_generation` before the generic
 *     `Local AI error (<status>): …` line. The two arms every caller actually
 *     BRANCHES on are identical — `OLLAMA_DOWN` verbatim and
 *     `MODEL_MISSING:<model>` re-tagged — so only the wording of the
 *     never-matched-on arms differs, and it differs by saying something truer
 *     (a helper that would not start, or a cloud model out of quota) than
 *     `ollama.rs`'s status-code line does. Reusing the landed port beats a
 *     second, three-branch sentinel shape.
 *   - `inject_policy` (PRIV-1) → `privacy.ts:459-489` ({@link injectPolicy}),
 *     with the same idempotent "already has a `privacy` key → skip" contract
 *     `sidecar_post`'s own comment describes.
 *   - `ensure_provider_catalog`/`inject_provider_runtime` →
 *     `providers.ts:836-855` and `providers.ts:930-947`.
 *
 * `ollama::ToolCall` (ollama.rs:92-96) is deliberately NOT ported. Its only
 * two sites in the whole Rust tree are `room_mcp.rs:1619` (which builds one
 * purely to bundle `(name, arguments)` before destructuring it back out at the
 * call one line later) and `commands/agent.rs:3056` — both in unported files
 * outside `ollama.rs`'s scope. `execTool.ts`'s real entry point already takes
 * that pair as two plain parameters, so a carrier interface here would be
 * scaffolding for a wiring point that does not exist.
 *
 * ══════════════════ THE FULL sidecar_post CONTRACT, NOT A STRIPPED ONE ═════
 * `sidecarJsonCancellable.ts`'s own doc says it sends a body "EXACTLY as the
 * caller built it" — no `inject_policy`, no provider catalog/runtime — because
 * neither had an Electron port when that file was written. For the METADATA
 * endpoints `ollamaModels.ts` builds on it (`/capabilities`,
 * `/context_length`, `/delete`, `/warm`) that omission is genuinely inert:
 * none of those bodies carries chat content, and the model is a fixed local
 * tag.
 *
 * `/generate` is different. Its body carries the room's actual `messages`
 * (studio HTML, meeting transcripts, grounding images ride inline on the user
 * turns) and its `model` can be any engine the user picked, cloud included.
 * Sending it through the bare foundation would be a REAL regression against
 * the Rust source — the exact failure `sidecar_post`'s own PRIV-1 comment was
 * written about ("privacy.guard_outbound sidecar-side sees `policy is None`
 * and returns the messages UNTOUCHED") — plus an `openrouter::…` model
 * arriving with no API key or base URL at all.
 *
 * Since `injectPolicy` and `ensureProviderCatalog`/`injectProviderRuntime`
 * turned out to ALREADY be real (found by reading `privacy.ts`/`providers.ts`
 * rather than trusting `sidecarJsonCancellable.ts`'s doc about the gap),
 * {@link postGenerateCancellable} wires all three in, in the Rust source's own
 * order: policy first (it reads `body.model` itself), then catalog priming and
 * runtime injection.
 *
 * ══════════════════ wake_daemon — WHY THIS FILE NEVER CALLS IT ════════════
 * In Rust both `generate` (via `post_generate_cancellable`) and
 * `chat_structured` call `ollama::wake_daemon()` first for a non-external
 * model: `ollama_lifecycle::ensure_up`'s spawn / idle-sleep / health-probe
 * process dance. That subsystem has NO Electron port — `ollamaLifecycle.ts`
 * ports only `hostOf`/`baseIsLocal` and says so itself.
 *
 * This is not a gap invented here. It is the SAME line already drawn, for the
 * same reason, by every other content-carrying gateway call in this tree:
 * `engineRouting.ts`'s `handoffSummary` (summarizes a real conversation),
 * `retrievalBackfill.ts`'s `embedViaSidecar` (embeds real room text), and
 * `ollamaModels.ts`'s `warm`/`pullCancellable` (both of which DO call
 * `wake_daemon` in Rust). A sleeping local daemon surfaces as an ordinary
 * `OLLAMA_DOWN` from the sidecar's own POST — never a silent hang, never a
 * fabricated answer.
 *
 * The other half of Rust's branch — `is_external_engine(model)`, which exists
 * ONLY to decide whether to skip `wake_daemon` for a CLI engine — has nothing
 * left to gate once the call is gone, so it is not reproduced either.
 *
 * ══════════════════ THE workflowCompose SEAM ══════════════════════════════
 * `workflowCompose.ts`'s `generateTextAnyEngine` defaults its
 * `GenerateTextAnyEngineDeps.generateOllama` to an honest
 * `OLLAMA_GENERATE_NOT_IMPLEMENTED` rejection, naming `ollama::generate` lines
 * 408-418 as the one thing missing. {@link generate} is a verified structural
 * drop-in for that seam's `GenerateOllamaFn` type — proved at compile time in
 * this module's test, not merely asserted — so `deps.generateOllama = generate`
 * closes it. NOT wired here: `workflowCompose.ts` is concurrently in flight
 * (jobs/workflow.rs parts 2 and 4), and editing it is out of this batch's
 * scope.
 *
 * ══════════════════ ONE DELIBERATE DUPLICATION: recoverJson ═══════════════
 * `workflowCompose.ts` already carries a copy of `ollama::recover_json`, and
 * its own doc justifies porting it ("five lines of pure string slicing over
 * the already-real `strip_think_spans` ... genuinely self-contained, not a
 * stand-in"). This file declares its own rather than importing that one, for a
 * reason specific to the dependency DIRECTION: `ollama.rs` (lines 481-491) is
 * `recover_json`'s actual home and `workflow.rs` is its consumer, so importing
 * upward would invert the Rust layering — and would become a genuine ESM
 * import cycle the moment a batch wires `deps.generateOllama = generate`
 * there. Pure, stateless, no branching on anything: the two copies cannot
 * drift into different observable behaviour without one being edited on
 * purpose. A follow-up batch that owns `workflowCompose.ts` should collapse
 * its copy into an import from HERE, not the other way round.
 */

import { CancelFlag } from "./cancel.js";
import { resolvedBaseUrl, stripThinkSpans } from "./engineRouting.js";
import { injectPolicy } from "./privacy.js";
import {
  defaultProviderDeps,
  ensureProviderCatalog,
  injectProviderRuntime,
  type ProviderDeps,
} from "./providers.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { sidecarErrorSentinel, sidecarJsonCancellable, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * An OWN-property read, which is what Rust's `value["text"]` on a
 * `serde_json::Map` is. A plain `value.text` would also find an inherited
 * `Object.prototype.text` — and a polluted prototype (a bug class this
 * codebase has hit four times) turning into a model answer nobody generated is
 * exactly the fabricated result the migration's rules forbid. Same guard
 * `privacy.ts`'s `ownValue` and `jsonTools.ts`'s make, restated locally
 * (neither exports it).
 */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// ============================================================================
// recover_json (ollama.rs:481-491) — see the module doc's "ONE DELIBERATE
// DUPLICATION" for why this lives here rather than being imported.
// ============================================================================

/** The FIRST index of any character in `chars` — Rust's
 * `s.find(|c| c == '{' || c == '[')`. Braces and brackets are
 * single-UTF-16-unit ASCII, so this walk lands on the same logical positions
 * Rust's byte-indexed `find`/`rfind` do. */
function firstIndexOfAny(s: string, chars: string): number {
  let best = -1;
  for (const c of chars) {
    const idx = s.indexOf(c);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

/** The LAST index of any character in `chars` — Rust's
 * `s.rfind(|c| c == '}' || c == ']')`. */
function lastIndexOfAny(s: string, chars: string): number {
  let best = -1;
  for (const c of chars) {
    best = Math.max(best, s.lastIndexOf(c));
  }
  return best;
}

/**
 * Recover the JSON payload from a structured-output response. Models that
 * honor Ollama's `format` return bare JSON, so this is a no-op for them; but
 * some — notably Ollama *cloud* models, which ignore `format` — wrap the JSON
 * in a ` ```json ` code fence or emit a `<think>` preamble, which a strict
 * parse then rejects (the caller reports "nothing usable"). Drop any `<think>`
 * span, then slice from the first opening bracket to the last closing one, so
 * a fence is stripped as a SIDE EFFECT of the slice and never matched
 * explicitly. Ported verbatim from `ollama::recover_json`.
 */
export function recoverJson(text: string): string {
  const s = stripThinkSpans(text.trim()).trim();
  const open = firstIndexOfAny(s, "{[");
  const close = lastIndexOfAny(s, "}]");
  if (open !== -1 && close !== -1 && close >= open) {
    return s.slice(open, close + 1);
  }
  return s;
}

// ============================================================================
// plain_generate_body (ollama.rs:379-393)
// ============================================================================

/**
 * Build the `/generate` request body for a tool-less, plain-text chat — the
 * shared schema the streaming (`sidecar::generate_stream`) and non-streaming
 * ({@link generate}) plain paths both POST. Ported verbatim from
 * `plain_generate_body`: NO `num_ctx` (the sidecar's payload-fitted sizing
 * owns the context window), no `format` (that is {@link chatStructured}'s
 * grammar path), no `tools`.
 *
 * Returns a plain `Record` rather than a named interface on purpose: it flows
 * straight into {@link injectPolicy}, whose parameter is
 * `Readonly<Record<string, unknown>>` — an `interface` without an index
 * signature is not assignable to that.
 */
export function plainGenerateBody(
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null,
  keepAlive: string
): Record<string, unknown> {
  return {
    model,
    messages,
    base_url: resolvedBaseUrl(),
    // `null` when unset — the sidecar treats a null temperature as "omit".
    // Rust's `"temperature": temperature` inside `serde_json::json!` always
    // serializes the key, `null` for `None`, so the key is present here too.
    temperature,
    keep_alive: keepAlive,
  };
}

// ============================================================================
// sidecar_post + post_generate_cancellable (ollama.rs:165-203, 249-279),
// fused — minus wake_daemon; see the module doc.
// ============================================================================

/**
 * `ollama::sidecar_post`'s policy + provider wiring fused with
 * `post_generate_cancellable`'s cancellation race, built on the already-real
 * {@link sidecarJsonCancellable} rather than a second HTTP client. Always
 * POSTs `/generate`: that is the one endpoint both {@link generate} and
 * {@link chatStructured} use in Rust (the `format` schema is just an extra
 * body key, not a different route).
 *
 * Cancellation is checked FIRST, before any policy or provider work — a
 * deliberate strengthening of Rust's own race, which starts the whole
 * `sidecar_post` future (policy injection and a possible catalog FETCH
 * included) and only discovers the flag at the next 100 ms poll. The
 * observable contract is identical (an already-stopped call yields empty
 * text); this just declines to do network work for a call already abandoned,
 * the same "check before anything else" discipline
 * `sidecarJsonCancellable`'s own doc establishes for the network hop.
 *
 * A Stop that lands DURING the prelude is checked once more, for the half of
 * Rust's race that a leading check cannot stand in for: `tokio::select!` races
 * the whole `sidecar_post` future — the catalog fetch and
 * `inject_provider_runtime` included — so a flag set while that runs returns
 * `Ok(json!({"text": ""}))` and the prelude's own error never surfaces. The
 * reachable case is a first-ever provider turn (the catalog is genuinely
 * fetched, and it is a large document) during which the user presses Stop and
 * the key stops resolving. Without the re-check, that user gets an "AI error"
 * dialog for a call they themselves stopped — the exact outcome
 * `sidecarJsonCancellable`'s own doc refuses for the network hop, and the
 * reason a Stop must not be reported as a failure: `isFatal` does not park a
 * job for it, so the caller marks the window skipped and carries on PAST the
 * Stop.
 */
async function postGenerateCancellable(
  body: Record<string, unknown>,
  model: string,
  cancel: CancelFlag,
  providerDeps: ProviderDeps
): Promise<SidecarPostOutcome> {
  if (cancel.load()) {
    return { kind: "stopped" };
  }
  let withProvider: unknown;
  try {
    // PRIV-1: reads `body.model` ITSELF (independent of the `model` argument
    // here), exactly like Rust's `inject_policy(body)`. Idempotent — a body
    // that already carries a `privacy` key is handed back untouched.
    const withPolicy = injectPolicy(body) ?? body;
    // What an API-provider model can do is learned only while fetching the
    // catalog, and that cache is in-memory — so after a restart it is empty
    // and every model reads as "unknown". Fill it once here, exactly where
    // Rust does.
    await ensureProviderCatalog(model, providerDeps);
    // Throws for a provider model whose key is no longer saved, matching
    // Rust's `inject_provider_runtime(&body, model)?` propagating that error.
    withProvider = injectProviderRuntime(withPolicy, model, providerDeps);
  } catch (err) {
    if (cancel.load()) {
      return { kind: "stopped" };
    }
    throw err;
  }
  return sidecarJsonCancellable("/generate", withProvider, cancel);
}

/**
 * `value["text"].as_str().unwrap_or_default()` — the response text, or `""`
 * for a missing/non-string field.
 *
 * A Stop resolves the SAME empty string rather than throwing: Rust's cancelled
 * branch returns `Ok(json!({"text": ""}))`, which every caller reads as an
 * ordinary empty result under the "partial == stopped" contract the old
 * streamed path had. Only a genuine engine failure throws, and it throws the
 * classified sentinel (`OLLAMA_DOWN` / `MODEL_MISSING:<model>` / a plain
 * `Local AI error (…)` line) that `summarize.rs`/`jobs.rs`/`file_pass.rs`
 * already branch on.
 */
function textFromOutcome(outcome: SidecarPostOutcome, model: string): string {
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  if (outcome.kind === "stopped") {
    return "";
  }
  const value = outcome.value;
  if (!isRecord(value)) {
    return "";
  }
  const text = ownValue(value, "text");
  return typeof text === "string" ? text : "";
}

// ============================================================================
// generate (ollama.rs:408-418)
// ============================================================================

/**
 * The optional knobs {@link generate} takes. Rust passes `cancel` as a bare
 * trailing `Option<Arc<AtomicBool>>` positional; folding it into one optional
 * trailing object leaves room for {@link providerDeps} without changing the
 * required-parameter list — which is what keeps this function a valid drop-in
 * for `workflowCompose.ts`'s `GenerateOllamaFn` (TypeScript compares only
 * REQUIRED parameter counts, so extra optional trailing parameters are
 * assignable).
 */
export interface GenerateOpts {
  /** ADD-7/ADD-31: a caller-owned Stop. Omitted means a fresh, never-flipped
   * flag — the "no Stop affordance here" idiom `ollamaModels.ts` already
   * establishes for `deleteModel`/`warm`/`ollamaCapabilities`. */
  cancel?: CancelFlag;
  /** The provider catalog/runtime seam. Defaults to the real Keychain +
   * `fetch` ({@link defaultProviderDeps}); injectable so a test never reads a
   * real key or opens a real connection. */
  providerDeps?: ProviderDeps;
}

/**
 * Non-streaming plain-text generation through the sidecar `/generate` — the
 * drop-in for the tool-less calls whose output was never streamed (a
 * #command's quiet step, dictation shaping, recording/segment naming and
 * translation, and `compose_workflow`'s local-model branch). Ported from
 * `ollama::generate`.
 *
 * Returns the model's RAW text: no {@link recoverJson} on this path — these
 * are prose, not JSON — and no `stripThinkSpans` either, which callers apply
 * themselves exactly as `workflowCompose.ts`'s `generateTextAnyEngine`
 * already does for its Ollama branch.
 *
 * A Stop resolves `""`; an engine failure rejects with the classified
 * sentinel. See {@link textFromOutcome}.
 */
export async function generate(
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null,
  keepAlive: string,
  opts: GenerateOpts = {}
): Promise<string> {
  const cancel = opts.cancel ?? new CancelFlag();
  const providerDeps = opts.providerDeps ?? defaultProviderDeps;
  const body = plainGenerateBody(model, messages, temperature, keepAlive);
  return textFromOutcome(await postGenerateCancellable(body, model, cancel, providerDeps), model);
}

// ============================================================================
// chat_structured / StructuredOpts (ollama.rs:292-356)
// ============================================================================

/**
 * Ported from `ollama::StructuredOpts`. Rust's `with_cancel` builder method is
 * not reproduced — a plain object literal is this migration's idiom for the
 * same thing, and a fluent builder would be the only one of its kind here. Its
 * `tier: CtxTier` field was already DELETED at the source (its own doc: "no
 * longer changes the context window"), so it is not reproduced either.
 */
export interface StructuredOpts {
  /** ADD-31/ADD-32: a caller-owned flag for a long structured generation the
   * user must be able to stop — a Studio writing a whole HTML page, or a
   * whole-file pass running one Job-tier call per window. */
  cancel?: CancelFlag;
  /** See {@link GenerateOpts.providerDeps}. */
  providerDeps?: ProviderDeps;
}

/** `serde_json::to_string(schema).unwrap_or_default()`. A schema that cannot
 * serialize (a cycle, a BigInt — not expected for a plain JSON-schema object,
 * but `schema` is `unknown`) yields the empty string rather than throwing,
 * which is what `unwrap_or_default` does. */
function schemaToJson(schema: unknown): string {
  try {
    return JSON.stringify(schema) ?? "";
  } catch {
    return "";
  }
}

/**
 * Ground the forced-JSON output by appending the schema to the LAST message
 * whose role is `"user"`, searched from the end — Rust's
 * `messages.iter_mut().rev().find(|m| m.role == "user")`.
 *
 * CRITICAL (Ollama's own guidance): `format` constrains the output GRAMMAR but
 * the model NEVER SEES the schema, so without this a small model tends to fill
 * the forced JSON with empty strings.
 *
 * A message list carrying no user turn at all is left completely unchanged,
 * matching Rust's `if let Some(last) = …` doing nothing when the search fails.
 * Returns a NEW array of NEW message objects — the caller's `messages` is
 * never mutated, where Rust mutates its own OWNED `Vec` in place.
 */
export function injectSchemaInstruction(
  messages: readonly SidecarChatMessage[],
  schema: unknown
): SidecarChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg !== undefined && msg.role === "user") {
      msg.content +=
        "\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n" +
        schemaToJson(schema);
      break;
    }
  }
  return out;
}

/**
 * ADD-22 training wheel: a one-shot call whose output is CONSTRAINED to a JSON
 * schema via Ollama's `format` (grammar-based token masking). No tools, no
 * streaming — for the small side-jobs (grounding boxes, field extraction,
 * list-making, summaries) that used to beg the model for JSON in prose and
 * salvage-parse the result. Ported from `ollama::chat_structured`.
 *
 * The body is built inline rather than through {@link plainGenerateBody},
 * matching the Rust source (which does not reuse `plain_generate_body` here
 * either). Images for vision grounding ride INLINE on the user messages —
 * there is no separate `images` field on the body, exactly as in Rust.
 *
 * The reply goes through {@link recoverJson}, so a model that ignores `format`
 * (Ollama cloud models do) and wraps its answer in a ` ```json ` fence or a
 * `<think>` preamble still parses. A Stop therefore resolves
 * `recoverJson("")` — `""`.
 */
export async function chatStructured(
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null,
  keepAlive: string,
  schema: unknown,
  opts: StructuredOpts = {}
): Promise<string> {
  const cancel = opts.cancel ?? new CancelFlag();
  const providerDeps = opts.providerDeps ?? defaultProviderDeps;
  const body: Record<string, unknown> = {
    model,
    messages: injectSchemaInstruction(messages, schema),
    base_url: resolvedBaseUrl(),
    temperature,
    keep_alive: keepAlive,
    // ADD-22: the structured-output grammar — the sidecar passes it to Ollama
    // as `format`.
    format: schema,
  };
  return recoverJson(textFromOutcome(await postGenerateCancellable(body, model, cancel, providerDeps), model));
}
