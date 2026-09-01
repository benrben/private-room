/**
 * Ollama LOCAL model management: the "best default model" pickers, the
 * vision-grounding pick, the RAM-based keep-alive policy, and the commands
 * that list / badge / warm / download / delete an installed model.
 *
 * Ported from `src-tauri/src/commands/models.rs` (698 lines, read in full,
 * including its `#[cfg(test)] mod tests`) plus the model-management slice of
 * `src-tauri/src/ollama.rs` (847 lines) that `models.rs` itself calls and that
 * had no Electron port anywhere in this tree yet: `capabilities`,
 * `native_context_length`, `delete_model`, `warm`, `pull`/`pull_cancellable`.
 *
 * ARCHITECTURE, AS THE RUST SOURCE ACTUALLY IS TODAY: none of these functions
 * speak to Ollama's `http://127.0.0.1:11434` REST API. `ollama.rs`'s own
 * "MIGRATION Phase 1" banner moved every one of them behind the Python
 * sidecar — they POST to `/models`, `/pull`, `/delete`, `/capabilities`,
 * `/warm`, `/context_length`, and the sidecar is what talks to Ollama. This
 * port makes the same hop, through the already-ported `sidecar.ts` /
 * `sidecarJsonCancellable.ts` / `engineRouting.ts`, rather than a
 * pre-migration direct-to-daemon client that no longer exists.
 *
 * ══════════════════════════════ REUSED, NOT RE-PORTED ══════════════════════
 * Much of `models.rs` already has a committed, unsuffixed port elsewhere in
 * this tree. Re-declaring any of it would be the "second model-info shape"
 * this migration keeps warning about:
 *   - {@link isEmbeddingModel}, {@link bestDefault}, `DEFAULT_MODEL`,
 *     {@link isExternalEngine} — `turnContext.ts`
 *     (`models.rs::is_embedding_model`/`best_default`, `commands.rs`'s
 *     `DEFAULT_MODEL`, `external.rs::is_external_engine`).
 *   - {@link servedByOllamaEngine}, {@link runsOnThisMac},
 *     {@link ollamaRunsHere}, {@link imageReachesModel} (a VERBATIM port of
 *     `models.rs::image_reaches_model` — its own doc names this file as its
 *     source), {@link visionSupport}/{@link isYes} — `capabilities.ts`.
 *   - {@link listInstalledModels}/`resolvedBaseUrl` — `engineRouting.ts`
 *     (`ollama::list_models`/`resolved_base_url`). `listModels` folds every
 *     failure into `[]`; {@link aiStatus} needs the raw Ok/Err split, so it
 *     gets its own small private duplicate — see {@link rawListModels}.
 *   - `ensureUp`/`authedHeaders`/`busy`/`splitCompleteLines`/`ChunkReader` —
 *     `sidecar.ts`.
 *   - `sidecarJsonCancellable`/`sidecarErrorSentinel` —
 *     `sidecarJsonCancellable.ts`, the same `{code,error}` envelope
 *     `ollama::sidecar_post`/`map_sidecar_error` decode.
 *   - `activePolicy` — `privacy.ts` (`privacy::active_policy().is_some()`).
 *   - `ensureProviderCatalog`/`providerModelVision`/`providerConnected` —
 *     `providers.ts`.
 *   - `clampChars` — `textClamp.ts`, for {@link openOllamaFailure}'s
 *     `.chars().take(200)`.
 *   - `CancelFlag`/`CancelState`/`forget` — `cancel.ts`, the SAME flat
 *     `state.cancels` registry `models.rs::pull_model` inserts into, so
 *     `cancelId(state, pullCancelKey(name))` stops a running download exactly
 *     as Rust's `cancel_ask` does.
 *   - `AiStatus`/`ModelCaps` wire shapes — `shared/apiTypes.ts` (camelCase,
 *     matching Rust's `#[serde(rename_all = "camelCase")]`).
 *
 * ══════════════════════════════ GENUINELY NEW HERE ═════════════════════════
 * {@link bestLocalDefault}, {@link chatModelSeesImages}, {@link groundingPick},
 * {@link groundingModelForRoom}, the HLT-5 keep-alive constants with
 * {@link visionKeepAlive}/{@link totalRamBytes}, {@link registryName} and
 * {@link pullCancelKey}, {@link pullModel}/{@link pullCancellable} (real
 * streaming NDJSON with a real cancel and a real stall timeout),
 * {@link openOllama}/{@link openOllamaFailure}, {@link warmModel},
 * {@link modelCapabilities}, {@link aiStatus}, and the `ollama.rs` network
 * calls {@link ollamaCapabilities}, {@link ollamaNativeContextLength},
 * {@link deleteModel}, {@link warm}.
 *
 * The first two of those network calls also CLOSE a seam
 * `capabilities.ts` explicitly left open: its `CapabilitiesForDeps`/
 * `VisionSupportDeps` document `ollamaCapabilities`/`ollamaNativeContextLength`
 * as "no TS port yet", and a caller can now wire the real thing instead of a
 * fake ({@link defaultVisionSupportDeps}).
 *
 * ══════════════════════════════ DELIBERATELY OUT OF SCOPE ═══════════════════
 *   - `ollama::wake_daemon`/`ollama_lifecycle::ensure_up` — actually SPAWNING
 *     a sleeping local `ollama serve`. `engineRouting.ts` and
 *     `ollamaLifecycle.ts` already draw this exact line for the same reason:
 *     a genuinely asleep daemon surfaces as a real connection failure from
 *     the sidecar rather than being silently woken.
 *   - PRIV-1's `inject_policy` and the provider-catalog priming
 *     `ollama::sidecar_post` performs before every POST. None of `/models`,
 *     `/pull`, `/delete`, `/capabilities`, `/context_length`, `/warm` carries
 *     chat content or images, so the omission (inherited from
 *     `engineRouting.ts`/`sidecarJsonCancellable.ts`) has no observable effect
 *     here.
 *   - `external.rs::detect_external_blocking`/`ollama_installed_blocking` —
 *     the cloud-CLI/Ollama-installed detectors, which fork an INTERACTIVE
 *     `zsh -ilc` login shell (that probe is the documented root cause of a
 *     live TCC "data from other apps" prompt loop) and belong to whichever
 *     batch owns `external.rs`'s catalog half — `externalAdvisor.ts`'s own
 *     doc already names them as unported. {@link aiStatus} takes them as
 *     REQUIRED, un-defaulted dependencies and ships honestly-throwing
 *     stand-ins as their only "default"
 *     ({@link AI_STATUS_DETECTION_NOT_IMPLEMENTED}) — never a fabricated
 *     "no CLIs found"/"not installed".
 *   - IPC WIRING. {@link registerOllamaModelsIpc} is written and tested but
 *     is NOT called from any bootstrap file — Phase 2 needs an explicit owner
 *     go-ahead, same as `recIpc.ts`/`dictStopTimeout.ts`.
 *
 * ══════════════════════════════ TOOL ROUTER ════════════════════════════════
 * None of `models.rs`'s seven commands (`lib.rs:323-336`: `ai_status`,
 * `model_capabilities`, `grounding_model_for_room`, `open_ollama`,
 * `warm_model`, `pull_model`, `delete_model`) appears in `exec_tool`'s match
 * arms (`agent.rs`). They are renderer-invoked commands, never model-invoked
 * tools, so no `execTool.ts` arm is added by this batch.
 *
 * ══════════════════════════════ ONE DELIBERATE IMPROVEMENT ═════════════════
 * {@link PullOutcome} is a discriminated union (`ok` | `cancelled` | `error`)
 * rather than Rust's `Result<(), String>`, which collapses a user's Stop and a
 * genuine failure into one channel distinguishable only by string-comparing
 * against `PULL_CANCELLED`. House rule: a user-initiated Stop must be
 * classified distinctly from an error — the same upgrade
 * `sidecarJsonCancellable.ts`'s `SidecarPostOutcome` already made. The WIRE
 * contract is unchanged: {@link registerOllamaModelsIpc}'s `pull_model`
 * handler rejects with {@link PULL_CANCELLED} for the cancelled arm, exactly
 * what `src/api.ts`'s `pullModel` already reads as "stopped".
 */

import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { AiStatus, ModelCaps } from "../shared/apiTypes.js";
import {
  imageReachesModel,
  isYes,
  ollamaRunsHere,
  runsOnThisMac,
  servedByOllamaEngine,
  visionSupport,
  type VisionSupportDeps,
} from "./capabilities.js";
import { CancelFlag, forget, type CancelState } from "./cancel.js";
import { listModels as listInstalledModels, resolvedBaseUrl } from "./engineRouting.js";
import { activePolicy } from "./privacy.js";
import { ensureProviderCatalog, providerConnected, providerModelVision } from "./providers.js";
import { authedHeaders, busy, ensureUp, splitCompleteLines, type ChunkReader } from "./sidecar.js";
import { sidecarErrorSentinel, sidecarJsonCancellable, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import { clampChars } from "./textClamp.js";
import { bestDefault, DEFAULT_MODEL, isEmbeddingModel, isExternalEngine } from "./turnContext.js";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ============================================================================
// models.rs — the default pickers
// ============================================================================

/**
 * `models.rs::installed_default` — the installed tag that IS the default: an
 * exact match first, else a build-suffixed one (`qwen3.5:4b-mlx`).
 *
 * Duplicated in one line from `turnContext.ts`'s private helper of the same
 * name and shape (that module keeps it unexported; there is nothing to
 * import), the same convention `capabilities.ts`'s module doc names for a
 * predicate too small to inject.
 */
export function installedDefault(models: readonly string[]): string | undefined {
  return models.find((m) => m === DEFAULT_MODEL) ?? models.find((m) => m.startsWith(DEFAULT_MODEL));
}

/**
 * `models.rs::best_local_default` — a chat-capable model that runs ON THIS
 * MAC: not an embedding model, not an external CLI/provider, not a relayed
 * Ollama `:cloud` tag. Distinct from `turnContext.ts`'s {@link bestDefault},
 * which permits a `:cloud`/external pick — this one feeds the tool-driving
 * agent loop and the privacy scan, neither of which may land on a model that
 * leaks tool calls inline.
 *
 * Prefers the tuned default IN WHATEVER FORM IT IS ACTUALLY INSTALLED AS,
 * never the bare constant when only a build-suffixed tag exists: a Mac holding
 * `qwen3.5:4b-mlx` and nothing else asked Ollama for `qwen3.5:4b`, which it
 * has never heard of, and live QA saw that as the privacy scan failing on all
 * 20 files with no reason given.
 *
 * The eligibility question is `servedByOllamaEngine` (the MODEL question), NOT
 * `runsOnThisMac` (which also asks where the transport points): with the
 * Closet pointed at another computer every installed tag fails the privacy
 * question and this would have no model left to name.
 */
export function bestLocalDefault(models: readonly string[]): string {
  const installed = installedDefault(models);
  if (installed !== undefined) {
    return installed;
  }
  return models.find((m) => !isEmbeddingModel(m) && servedByOllamaEngine(m)) ?? DEFAULT_MODEL;
}

// ============================================================================
// models.rs — HLT-5 keep-alive policy
// ============================================================================

/** `models.rs::KEEP_ALIVE_WARM` — keep the chat model resident this long so
 * follow-up questions are snappy. */
export const KEEP_ALIVE_WARM = "30m";
/** `models.rs::KEEP_ALIVE_SHORT` — release a distinct vision model quickly on
 * low-RAM machines. */
export const KEEP_ALIVE_SHORT = "2m";
/** `models.rs::HIGH_RAM_THRESHOLD_BYTES` — machines at or above this stay warm
 * even for a second (vision) model. */
export const HIGH_RAM_THRESHOLD_BYTES = 32 * 1024 * 1024 * 1024;

let cachedTotalRamBytes: number | null = null;

/**
 * `models.rs::total_ram_bytes` — total physical RAM in bytes, read once and
 * cached (Rust: `sysinfo` behind a `OnceLock`; here `os.totalmem()`, a real
 * syscall, cached the same way — the value cannot change while the process
 * runs and refreshing memory info is not free).
 */
export function totalRamBytes(): number {
  if (cachedTotalRamBytes === null) {
    cachedTotalRamBytes = totalmem();
  }
  return cachedTotalRamBytes;
}

/** Test-only: forget the cached value, mirroring `providers.ts`'s
 * `resetProviderStateForTests` convention for a process-lifetime cache. */
export function resetTotalRamCacheForTests(): void {
  cachedTotalRamBytes = null;
}

/**
 * `models.rs::vision_keep_alive` — how long a vision/grounding call should keep
 * its model resident. When the vision model IS the chat model only one model is
 * ever loaded, so the warm value costs nothing; otherwise a machine under
 * {@link HIGH_RAM_THRESHOLD_BYTES} releases it quickly rather than hold two
 * models resident, which has overwhelmed and crashed Ollama on 16 GB Macs.
 * Pure, so the policy is testable without touching `os.totalmem()`.
 */
export function visionKeepAlive(totalRam: number, visionModel: string, chatModel: string): string {
  return visionModel === chatModel || totalRam >= HIGH_RAM_THRESHOLD_BYTES ? KEEP_ALIVE_WARM : KEEP_ALIVE_SHORT;
}

// ============================================================================
// ollama.rs — the metadata + management POSTs
// ============================================================================

/** `ollama.rs::METADATA_TIMEOUT` (60s) — capabilities/context-length are
 * metadata reads (`/api/show` underneath, no model load) and must not stall a
 * Settings badge for the length of a whole generation budget. */
export const METADATA_TIMEOUT_MS = 60_000;

/**
 * `ollama::capabilities` — a model's declared capabilities
 * ("tools"/"vision"/"completion"/…) via the sidecar's `/capabilities`
 * (Ollama's `/api/show` underneath — metadata only, no model load).
 *
 * EMPTY ON ANY FAILURE (sidecar down, non-2xx, malformed body), matching the
 * Rust source's contract exactly: callers treat "unknown" as "no special
 * capability" rather than failing, so a Settings badge simply doesn't show.
 * Built on {@link sidecarJsonCancellable} with a fresh, never-flipped
 * {@link CancelFlag} — this call has no Stop button in Rust either.
 */
export async function ollamaCapabilities(model: string): Promise<string[]> {
  const outcome = await sidecarJsonCancellable(
    "/capabilities",
    { model, base_url: resolvedBaseUrl() },
    new CancelFlag(),
    METADATA_TIMEOUT_MS
  );
  if (outcome.kind !== "value") {
    return [];
  }
  const list = isRecord(outcome.value) ? outcome.value.capabilities : undefined;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Strict, metadata-only validation for a model picker or first-use guard.
 * Unlike {@link ollamaCapabilities}, failure is meaningful here: a tag that
 * Ollama cannot resolve must never be persisted and sent to a real agent run.
 * `/capabilities` delegates to Ollama `/api/show`; it does not load or run the
 * model and therefore is safe for cloud relay tags as well as local tags.
 */
export async function probeOllamaModelSelection(model: string): Promise<{ ok: boolean; detail: string | null }> {
  const outcome = await sidecarJsonCancellable(
    "/probe_model",
    { model, base_url: resolvedBaseUrl() },
    new CancelFlag(),
    METADATA_TIMEOUT_MS
  );
  if (outcome.kind === "value") return { ok: true, detail: null };
  if (outcome.kind === "error") {
    return { ok: false, detail: sidecarErrorSentinel(outcome.error, model) };
  }
  return { ok: false, detail: "The model check was cancelled." };
}

/**
 * `ollama::native_context_length` — a model's real advertised context length,
 * from Ollama's own catalog (the sidecar's `/context_length`,
 * `model_limits.native_context_length` underneath). `null` on ANY failure —
 * "unknown, not zero", the same contract as {@link ollamaCapabilities}, so a
 * dead sidecar degrades to a display fallback rather than erroring.
 *
 * Rust reads it as `as_u64()` then casts to `u32`, so a negative or fractional
 * value is not a context length at all and reads as `None`.
 */
export async function ollamaNativeContextLength(model: string): Promise<number | null> {
  const outcome = await sidecarJsonCancellable(
    "/context_length",
    { model, base_url: resolvedBaseUrl() },
    new CancelFlag(),
    METADATA_TIMEOUT_MS
  );
  if (outcome.kind !== "value") {
    return null;
  }
  const n = isRecord(outcome.value) ? outcome.value.context_length : undefined;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Unwrap a POST whose {@link CancelFlag} is never flipped. The `"stopped"` arm
 * is structurally unreachable, so it throws LOUDLY rather than resolving as a
 * silent success — a future change that DID start flipping the flag would
 * otherwise quietly discard the delete/warm it was meant to stop.
 */
export function unwrapNeverCancelled(outcome: SidecarPostOutcome, model: string, what: string): void {
  if (outcome.kind === "value") {
    return;
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  throw new Error(`unreachable: the sidecar reported ${what} as stopped, but no Stop was requested`);
}

/**
 * `ollama::delete_model` — delete a pulled model via the sidecar's `/delete`.
 * Success is silent; a failure is the SAME classified sentinel every other
 * gateway call surfaces (`OLLAMA_DOWN` / `MODEL_MISSING:<model>` / a plain
 * `Local AI error (…)` line), rebuilt by {@link sidecarErrorSentinel} — which
 * is `ollama.rs::map_sidecar_error`'s own sentinel logic, reused rather than
 * re-implemented.
 */
export async function deleteModel(model: string): Promise<void> {
  const outcome = await sidecarJsonCancellable("/delete", { model, base_url: resolvedBaseUrl() }, new CancelFlag());
  unwrapNeverCancelled(outcome, model, "the delete");
}

/**
 * `ollama::warm` — load a model into memory without generating anything, via
 * the sidecar's `/warm`, always at {@link KEEP_ALIVE_WARM} (the constant, not a
 * second literal: two spellings of one policy is how they drift). The loaded
 * weights are not read back; only a transport/engine failure surfaces.
 */
export async function warm(model: string): Promise<void> {
  const outcome = await sidecarJsonCancellable(
    "/warm",
    { model, base_url: resolvedBaseUrl(), keep_alive: KEEP_ALIVE_WARM },
    new CancelFlag()
  );
  unwrapNeverCancelled(outcome, model, "the warm-up");
}
