/**
 * THE ENGINE-ROUTING GAP — the handful of functions the turn engine
 * (`turnEngine.ts`, `gatherContext.ts`) needs from Rust modules this
 * migration has NOT ported: `ollama.rs`, `ollama_lifecycle.rs`,
 * `capabilities.rs`, `providers.rs`. That is a real, large structural gap of
 * its own (local-daemon lifecycle, the provider/CLI catalog, per-model
 * capability detection). Nothing in this file pretends otherwise.
 *
 * Kept in its OWN file, separate from every other module this batch wrote, so
 * the future "engines/models" batch that actually ports those four Rust
 * modules has exactly ONE file to replace — nothing in `turnEngine.ts` should
 * ever import from here for a reason other than "which base URL, is it awake,
 * which models exist, summarize this conversation".
 *
 * WHAT IS REAL HERE, AND HOW REAL:
 *
 * - {@link resolvedBaseUrl}/{@link setBaseUrlOverride} — REAL, a full port of
 *   `ollama.rs`'s C1 layering (runtime override > `ARCELLE_OLLAMA_URL` env >
 *   the local default). Pure precedence logic, nothing to stub.
 * - {@link isAwake} — REAL, ported from `ollama_lifecycle::is_awake`/
 *   `reachable`: one `GET {base}/api/version` on the same 1200 ms budget,
 *   direct to the Ollama daemon, never through the sidecar. "Never starts
 *   anything" is Rust's own doc for this function and stays true here.
 * - {@link listModels}/{@link handoffSummary} — REAL POSTs to the sidecar
 *   endpoints the Rust originals use (`/models`, `/handoff_summary`), through
 *   `sidecar.ts`'s already-ported `ensureUp`/`busy`/`authedHeaders`. What is
 *   DROPPED, on purpose, because each belongs to a different unported
 *   subsystem: `commands::inject_policy` (the PRIV-1 privacy door,
 *   `commands/privacy.rs`), `commands::ensure_provider_catalog`/
 *   `inject_provider_runtime` (the API-provider catalog, `providers.rs`), and
 *   `wake_daemon()` (actually spawning `ollama serve` — `ollama_lifecycle.rs`'s
 *   own process dance, NOT the same thing {@link isAwake} does, which only
 *   probes). A genuinely asleep local daemon makes either call fail with a
 *   real connection error from the sidecar rather than a silent wrong answer.
 * - {@link stripThinkSpans} — REAL, verbatim port of
 *   `ollama::strip_think_spans`.
 *
 * NOT here, and not stubbed at all (out of scope even as a seam): per-model
 * capability detection (`chat_model_sees_images`, `grounding_pick`,
 * `capabilities_for(...).context_window`), the provider catalog, and daemon
 * spawn/idle-sleep. Callers that need one take it as an explicit injected
 * dependency instead (see `turnEngine.ts`'s `AskDeps`/`HandoffChatDeps`) —
 * this file does not grow a stub for every shape of "wire this up later".
 */

import { authedHeaders, busy, ensureUp } from "./sidecar.js";
import type { SidecarChatMessage } from "./sidecar.js";

/** `ollama.rs`'s own default when neither an override nor the env var is set. */
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/** `ollama_lifecycle::reachable`'s own `Duration::from_millis(1200)`. */
const PROBE_TIMEOUT_MS = 1_200;

// ------------------------------------------------------------- base URL (C1)

/**
 * C1's runtime override — the "closet supercomputer" Settings value that
 * points the app at a remote Ollama box on the LAN. `null` (the default) means
 * "no override — fall back to env, then the local default", mirroring
 * `ollama.rs`'s `base_url_override` (a process-lifetime
 * `RwLock<Option<String>>`; a plain module variable here, since this process
 * has no threads to race over it).
 */
let baseUrlOverride: string | null = null;

/**
 * Set (or clear, with `null`) the runtime base-URL override. Ported from
 * `ollama::set_base_url_override`: trailing slashes are trimmed so a pasted
 * `http://box:11434/` is stored the same as `http://box:11434`, and an empty
 * or whitespace-only string clears the override, same as `null`.
 */
export function setBaseUrlOverride(url: string | null): void {
  const trimmed = url?.trim().replace(/\/+$/, "") ?? "";
  baseUrlOverride = trimmed === "" ? null : trimmed;
}

/** Test-only: back to the unset state, named for intent at call sites that
 * just want a clean slate between cases. */
export function resetBaseUrlOverrideForTests(): void {
  baseUrlOverride = null;
}

/**
 * The base URL actual requests use. Precedence: runtime override
 * ({@link setBaseUrlOverride}) > `ARCELLE_OLLAMA_URL` env > the local default.
 * Ported from `ollama::resolved_base_url` (layered over the env-read
 * `base_url()`).
 *
 * ONE deliberate difference from the Rust source: `base_url()` caches the env
 * read in a `OnceLock`, so a change after first use is invisible for the
 * process's lifetime. This re-reads `process.env` every call — the env var is
 * set once at launch in production either way, and a cached read would make
 * this untestable without a per-test process.
 */
export function resolvedBaseUrl(): string {
  if (baseUrlOverride !== null) {
    return baseUrlOverride;
  }
  const fromEnv = process.env.ARCELLE_OLLAMA_URL?.trim().replace(/\/+$/, "") ?? "";
  return fromEnv !== "" ? fromEnv : DEFAULT_BASE_URL;
}

// ------------------------------------------------------------------ is_awake

/**
 * Is the Ollama daemon answering right now? A cheap probe for UI feedback
 * ("Starting the local AI…") that NEVER starts anything, matching Rust's own
 * doc for `is_awake`. `true` only on a successful response; `false` on any
 * failure (bad URL, refused connection, timeout, non-2xx) — never throws,
 * mirroring `reachable`'s `.unwrap_or(false)`.
 */
export async function isAwake(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- sidecar JSON POST

/**
 * A plain JSON POST to one of the sidecar's non-streaming endpoints — the
 * shape of `ollama::sidecar_post`, MINUS the two steps that belong to other
 * unported subsystems (see the module doc): no `inject_policy`, no
 * provider-catalog priming/injection. Takes `base` explicitly so
 * {@link listModelsAt}/{@link handoffSummaryAt} are testable against a fake
 * HTTP server with no real sidecar process — the same reason `sidecar.ts`
 * splits `streamRun(base, …)` out of `runViaSidecar(…)`.
 */
async function sidecarJsonPostAt(
  base: string,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...authedHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`sidecar ${path} status ${resp.status}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/** As {@link sidecarJsonPostAt}, but resolving the sidecar's base URL itself
 * (`ensureUp`) and holding a {@link busy} guard for the call — the entry point
 * a production caller uses, mirroring `runViaSidecar` wrapping `streamRun`. */
async function sidecarJsonPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = await ensureUp();
  const guard = busy();
  try {
    return await sidecarJsonPostAt(base, path, body);
  } finally {
    guard.release();
  }
}

// ---------------------------------------------------------------- list_models

/** The pure translation of a `/models` body into a model-name list, so
 * {@link listModelsAt}/{@link listModels} share one reading of a possibly
 * malformed body rather than two. */
function parseModelsBody(value: Record<string, unknown>): string[] {
  const models = value.models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models.filter((m): m is string => typeof m === "string");
}

/**
 * As {@link listModels}, against an explicit sidecar base URL — the testable
 * core, ported from `ollama::list_models`'s POST + parse.
 *
 * DEVIATION: the Rust function returns `Result<Vec<String>, String>`; this one
 * never throws. All three of its real call sites (`ask`, `list_specialists`,
 * `handoff_chat`) immediately `.unwrap_or_default()`, so folding that in here
 * is a faithful simplification of the observed behavior, not a change to it.
 */
export async function listModelsAt(base: string): Promise<string[]> {
  try {
    return parseModelsBody(await sidecarJsonPostAt(base, "/models", { base_url: resolvedBaseUrl() }));
  } catch {
    return [];
  }
}

/** The installed Ollama model tags, via the sidecar's own `/models` (the hop
 * `ollama::list_models` makes — the sidecar is the app's sole AI service, so
 * the host never queries the daemon's `/api/tags` itself). See
 * {@link listModelsAt} for the one deliberate deviation. */
export async function listModels(): Promise<string[]> {
  try {
    return parseModelsBody(await sidecarJsonPost("/models", { base_url: resolvedBaseUrl() }));
  } catch {
    return [];
  }
}

// --------------------------------------------------------- strip_think_spans

/**
 * Remove the `<think>…</think>` reasoning spans a model leaks into its visible
 * answer. Ported verbatim from `ollama::strip_think_spans`, including the
 * unterminated-tag behavior: an UNCLOSED `<think>` truncates everything from
 * that point on, because everything after it is unclosed reasoning, not answer.
 */
export function stripThinkSpans(raw: string): string {
  let out = raw;
  for (;;) {
    const start = out.indexOf("<think>");
    if (start === -1) {
      return out;
    }
    const relEnd = out.slice(start).indexOf("</think>");
    if (relEnd === -1) {
      return out.slice(0, start);
    }
    out = out.slice(0, start) + out.slice(start + relEnd + "</think>".length);
  }
}

// ---------------------------------------------------------- handoff_summary

/** As {@link handoffSummary}, against an explicit sidecar base URL — the
 * testable core. Ported from `ollama::handoff_summary`'s POST + parse, minus
 * `wake_daemon()`/`inject_policy` (see the module doc). */
export async function handoffSummaryAt(
  base: string,
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null
): Promise<string> {
  const value = await sidecarJsonPostAt(base, "/handoff_summary", {
    model,
    messages,
    base_url: resolvedBaseUrl(),
    temperature,
  });
  const summary = typeof value.summary === "string" ? value.summary : "";
  return stripThinkSpans(summary).trim();
}

/**
 * One-shot conversation summary for a context handoff, via the sidecar's
 * `/handoff_summary`. Unlike {@link listModels} this DOES throw on failure,
 * matching the Rust function's `Result` and its one caller (`handoff_chat`),
 * which propagates with `?` rather than defaulting anything — there is no
 * honest empty-string fallback for "the summarization call failed", and an
 * empty recap is treated by the caller as a FAILED handoff.
 */
export async function handoffSummary(
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null
): Promise<string> {
  const base = await ensureUp();
  const guard = busy();
  try {
    return await handoffSummaryAt(base, model, messages, temperature);
  } finally {
    guard.release();
  }
}
