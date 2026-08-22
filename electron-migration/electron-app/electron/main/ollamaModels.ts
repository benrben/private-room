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

function isRecord(v: unknown): v is Record<string, unknown> {
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
function installedDefault(models: readonly string[]): string | undefined {
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
const METADATA_TIMEOUT_MS = 60_000;

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
function unwrapNeverCancelled(outcome: SidecarPostOutcome, model: string, what: string): void {
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

// ============================================================================
// models.rs — the grounding pick (which model may see the room's image)
// ============================================================================

/** The REAL {@link VisionSupportDeps}: this file's own `/capabilities` POST for
 * the Ollama arm, `providers.ts`'s already-real catalog calls for the
 * OpenRouter arm. Nothing here is a stub — this is the bundle
 * `capabilities.ts`'s doc says has "no TS port yet". */
export const defaultVisionSupportDeps: VisionSupportDeps = {
  ollamaCapabilities,
  ensureProviderCatalog,
  providerModelVision,
};

/**
 * `models.rs::chat_model_sees_images` — can this model READ an image fed into
 * its context?
 *
 * ASKED, NEVER GUESSED FROM THE NAME: wraps `capabilities.ts`'s already-ported
 * {@link visionSupport} and collapses its `Support` exactly as `is_yes` does.
 * The collapse of `unknown` to `false` lives HERE, at the caller, because it is
 * a decision about this particular question ("may we hand it pixels?") and not
 * a fact about the engine — an engine that answers nothing is one whose vision
 * call was going to fail anyway.
 */
export async function chatModelSeesImages(
  model: string,
  deps: VisionSupportDeps = defaultVisionSupportDeps
): Promise<boolean> {
  return isYes(await visionSupport(model, deps));
}

/** Everything {@link groundingPick} needs beyond {@link VisionSupportDeps}. */
export interface GroundingPickDeps extends VisionSupportDeps {
  /** `privacy::active_policy().is_some()` — is this room's privacy door on?
   * Real default: {@link activePolicy} is non-null. */
  privacyDoorActive(): boolean;
}

/** A fully real {@link GroundingPickDeps} — every piece wired to a landed port. */
export const defaultGroundingPickDeps: GroundingPickDeps = {
  ...defaultVisionSupportDeps,
  privacyDoorActive: () => activePolicy() !== null,
};

/**
 * `models.rs::grounding_pick` — which model would mark an image for this room,
 * or `null` when nothing can. Order of truth, capability only:
 *   1. the room's OWN chosen model, when its engine says it takes images AND an
 *      image can actually reach it ({@link imageReachesModel}) — the user
 *      picked it, so it wins;
 *   2. any OTHER installed model that reports vision, on-Mac ones only, because
 *      by here the user has expressed no preference and pixels should not leave
 *      the machine on a pick they never made;
 *   3. `null` — and only then is "nothing here can see images" a true thing to
 *      say.
 *
 * Step 1's `imageReachesModel` guard is not redundant with capability: the
 * privacy door STRIPS every image out of a non-local request and only counts
 * what it blocked, so a capable cloud model in a door-on room would be handed a
 * grounding prompt with no picture, answer with nothing, and have that rendered
 * as "The AI could not locate that in this image" — a false statement about the
 * user's own photograph.
 */
export async function groundingPick(
  models: readonly string[],
  chatModel: string,
  deps: GroundingPickDeps = defaultGroundingPickDeps
): Promise<string | null> {
  if (imageReachesModel(chatModel, deps.privacyDoorActive) && (await chatModelSeesImages(chatModel, deps))) {
    return chatModel;
  }
  for (const m of models) {
    if (m === chatModel || !runsOnThisMac(m)) {
      continue;
    }
    if (await chatModelSeesImages(m, deps)) {
      return m;
    }
  }
  return null;
}

/** Everything {@link groundingModelForRoom} needs beyond {@link GroundingPickDeps}. */
export interface GroundingModelForRoomDeps extends GroundingPickDeps {
  /** `ollama::list_models()`, which the Rust command reads
   * `.unwrap_or_default()` — a failure here is "no models installed", never a
   * failure of the whole pick. `engineRouting.ts`'s `listModels` already has
   * exactly that contract. */
  listModels(): Promise<string[]>;
}

/** A fully real, ready-to-use {@link GroundingModelForRoomDeps}. */
export const defaultGroundingModelForRoomDeps: GroundingModelForRoomDeps = {
  ...defaultGroundingPickDeps,
  listModels: listInstalledModels,
};

/**
 * `models.rs::grounding_model_for_room` — which model would mark an image for
 * the OPEN room. One answer, the same one the grounding call itself will use,
 * so the viewer's vision offer and Settings → AI helpers cannot re-derive two
 * different ones.
 *
 * `explicitModel` is the room's `model` setting (`model_setting(&room.conn)`, a
 * plain DB read the Rust command takes under the room lock BEFORE any await) —
 * resolved by the caller and passed in, `null` when the room has none, mirroring
 * `capabilities.ts`'s own `resolveRoomModel` convention rather than reaching
 * into a room from here.
 */
export async function groundingModelForRoom(
  explicitModel: string | null,
  deps: GroundingModelForRoomDeps = defaultGroundingModelForRoomDeps
): Promise<string | null> {
  const models = await deps.listModels();
  const chatModel = explicitModel ?? bestDefault(models);
  return groundingPick(models, chatModel, deps);
}

// ============================================================================
// models.rs — model_capabilities (ADD-22 Settings badges)
// ============================================================================

/** Everything {@link modelCapabilities} needs — a bundle rather than two
 * positional callbacks, so a test can swap either half independently. */
export interface ModelCapabilitiesDeps {
  listModels(): Promise<string[]>;
  ollamaCapabilities(model: string): Promise<readonly string[]>;
}

export const defaultModelCapabilitiesDeps: ModelCapabilitiesDeps = {
  listModels: listInstalledModels,
  ollamaCapabilities,
};

/**
 * `models.rs::model_capabilities` — every installed model's tool/vision badge,
 * so Settings can warn when the chosen one can't drive the app. Sequential, one
 * `/capabilities` POST per model in list order, matching the Rust `for` loop;
 * an unreachable Ollama yields an empty list rather than an error.
 */
export async function modelCapabilities(
  deps: ModelCapabilitiesDeps = defaultModelCapabilitiesDeps
): Promise<ModelCaps[]> {
  const models = await deps.listModels();
  const out: ModelCaps[] = [];
  for (const name of models) {
    const caps = await deps.ollamaCapabilities(name);
    out.push({ name, tools: caps.includes("tools"), vision: caps.includes("vision") });
  }
  return out;
}

// ============================================================================
// models.rs — open_ollama (ADD-10)
// ============================================================================

/** The minimal slice of a spawned child process {@link openOllama} needs — a
 * real Node `ChildProcess` satisfies it structurally, and a test supplies a
 * lightweight fake. Same DI shape `ytdlp.ts`/`sidecar.ts` use for their own
 * subprocess seams, restated locally rather than imported from an unrelated
 * module. */
export interface OpenOllamaProcess {
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

export type OpenOllamaSpawnFn = (command: string, args: string[]) => OpenOllamaProcess;

const realOpenOllamaSpawn: OpenOllamaSpawnFn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });

/**
 * `models.rs::open_ollama_failure` — the sentence for a failed launch: `open`'s
 * own reason when it gave one (truncated to 200 CODE POINTS, mirroring Rust's
 * `.chars().take(200)` via `textClamp.ts`'s already-ported {@link clampChars}),
 * never invented — plus the one thing that actually helps, because the common
 * case is a real, working Ollama installed without its `.app`.
 */
export function openOllamaFailure(stderr: Buffer | string): string {
  const raw = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  const detail = clampChars(raw.trim(), 200);
  const head = detail === "" ? "Couldn't open the Ollama app." : `Couldn't open the Ollama app: ${detail}`;
  return (
    `${head} If you installed Ollama from the command line there is no app to open — ` +
    "start it with `ollama serve` in Terminal."
  );
}

/**
 * `models.rs::open_ollama` — launch the Ollama app so a first-time user never
 * touches a terminal.
 *
 * WAITS for `open` to report (`.once("close", …)`, Rust's `Command::output()`)
 * rather than firing and forgetting: spawning alone only fails when `open`
 * itself cannot be executed — which never happens on macOS — so "Unable to find
 * application named 'Ollama'" used to reach the user as a launch that worked,
 * with the "not running" banner just staying up unexplained. `open` returns as
 * soon as it has handed the launch off, so waiting costs nothing.
 */
export function openOllama(spawnFn: OpenOllamaSpawnFn = realOpenOllamaSpawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: OpenOllamaProcess;
    try {
      child = spawnFn("open", ["-a", "Ollama"]);
    } catch (err) {
      reject(new Error(`Could not open Ollama: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const stderrChunks: Buffer[] = [];
    child.stderr?.on?.("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (err) => {
      reject(new Error(`Could not open Ollama: ${err.message}`));
    });
    child.once("close", (code) => {
      // Rust branches on `out.status.success()`, which is exit code 0 only —
      // a signal-killed `open` (code `null` here) is a failure, not a launch.
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(openOllamaFailure(Buffer.concat(stderrChunks))));
    });
  });
}

// ============================================================================
// models.rs — warm_model
// ============================================================================

export interface WarmModelDeps {
  listModels(): Promise<string[]>;
  warm(model: string): Promise<void>;
}

export const defaultWarmModelDeps: WarmModelDeps = { listModels: listInstalledModels, warm };

/**
 * `models.rs::warm_model` — pre-load the room's chat model so vision/marking
 * stays fast. A cloud CLI needs no warm-up, so a room set to one warms the
 * installed default instead (and does nothing at all when nothing is
 * installed). ONLY ONE model is ever warmed: keeping two resident overwhelms
 * 16 GB machines and takes Ollama down.
 *
 * FIDELITY NOTE: the external-engine fallback is Rust's `best_default`, not
 * `best_local_default` — so a room on a CLI whose only installed tag is a
 * `:cloud` relay warms that relay. Reproduced as written rather than
 * "corrected" here; changing it is a product decision, not a port decision.
 */
export async function warmModel(
  explicitModel: string | null,
  deps: WarmModelDeps = defaultWarmModelDeps
): Promise<void> {
  const models = await deps.listModels();
  let chatModel = explicitModel ?? bestDefault(models);
  if (isExternalEngine(chatModel)) {
    if (models.length === 0) {
      return;
    }
    chatModel = bestDefault(models);
  }
  await deps.warm(chatModel);
}

// ============================================================================
// ollama.rs + models.rs — pull_model (cancellable, throttled progress)
// ============================================================================

/** `models.rs::PULL_PROGRESS_STEP` — the smallest change in a download's
 * percentage worth repainting the bar for. */
export const PULL_PROGRESS_STEP = 0.5;

/** `ollama::PULL_CANCELLED` — what a pull the user stopped reports. A sentence,
 * not a sentinel: shown as-is. Nothing in THIS module branches on it
 * ({@link PullOutcome} carries the classification), but the IPC boundary
 * rejects with it so the existing renderer contract is unchanged. */
export const PULL_CANCELLED = "The download was cancelled.";

/** `ollama::PULL_STALL_TIMEOUT` (300s) — how long a download may go without
 * receiving a single byte before it is abandoned. NOT a cap on the transfer:
 * pulls are multi-gigabyte and can legitimately run for an hour on a slow line;
 * only the GAP between chunks is bounded. */
export const PULL_STALL_TIMEOUT_MS = 300_000;

/** `ollama::pull_cancellable`'s own `sleep(Duration::from_millis(150))` — the
 * cadence at which a quiet stream is re-checked for a Stop or a stall. */
const PULL_POLL_MS = 150;

/**
 * `models.rs::pull_cancel_key` — the cancel-registry key a running download is
 * filed under, so Stop reaches it. One download per model, keyed by the model's
 * own AS-TYPED name (not the normalised registry name): the frontend rebuilds
 * this string as `cancelAsk('pull:' + <the name it asked for>)`, and a key it
 * cannot reproduce is a Stop button that does nothing.
 */
export function pullCancelKey(name: string): string {
  return `pull:${name}`;
}

/**
 * `models.rs::registry_name` — what Ollama will actually be asked for, from
 * what the user typed.
 *
 * Ollama files a pulled model under the EXACT string it was given, and only its
 * own library is case-insensitive about finding one. For a local model a stray
 * capital is cosmetic; for a hosted one it is fatal — `/api/chat` strips the
 * `-cloud` suffix and proxies the rest verbatim, so `Gpt-oss:120b-cloud`
 * answers `model 'Gpt-oss:120b' not found` on every request, forever, for a
 * model Settings lists as installed. A name carrying a host or namespace
 * (`hf.co/Owner/Repo`, `someone/Model`) belongs to THAT registry's own casing
 * and must not be touched — lowercasing it 404s, the same bug pointed the other
 * way.
 */
export function registryName(typed: string): string {
  const trimmed = typed.trim();
  return trimmed.includes("/") ? trimmed : trimmed.toLowerCase();
}

/** Rust's `Result<(), String>` reshaped as a discriminated union — see the
 * module doc's "ONE DELIBERATE IMPROVEMENT". */
export type PullOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

export type PullProgressListener = (status: string, percent: number | null) => void;

/** Walk an error's `.cause` chain for a POSIX `ECONNREFUSED` — the same check
 * `sidecar.ts`'s and `sidecarJsonCancellable.ts`'s own local copies make,
 * duplicated for the same reason theirs is: this port's established convention
 * for a small predicate a neighbouring module does not export. */
function isConnectionRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** `ollama::map_send_err`, narrowed to the branches reachable for a pull's
 * initial POST — which, matching the Rust source's own bare
 * `reqwest::Client::builder().build()`, carries no whole-request timeout, so
 * the `is_timeout()` branch cannot fire here and is not reproduced. */
function classifyPullSendError(err: unknown): string {
  if (isConnectionRefused(err)) {
    return "OLLAMA_DOWN";
  }
  return `Local AI request failed: ${err instanceof Error ? err.message : String(err)}`;
}

type PullChunkStep =
  | { kind: "chunk"; value: Uint8Array }
  | { kind: "ended" }
  | { kind: "cancelled" }
  | { kind: "stalled" };

/**
 * Wait for the next `/pull` chunk while staying answerable to BOTH a Stop and a
 * stalled connection — the two independent reasons `ollama::pull_cancellable`
 * ends a wait early, checked every {@link PULL_POLL_MS} by the same
 * re-race-the-same-pending-read technique `sidecar.ts`'s
 * `waitForNextChunkOrCancel` uses (see that function's doc for why a single
 * `Promise.race` is not equivalent: the read must never be abandoned or
 * re-issued, only re-awaited alongside a fresh timer).
 *
 * A DISTINCT function rather than a reuse of that one, mirroring the Rust
 * source itself — `ollama.rs`'s `tokio::select!` loop is not shared with
 * `sidecar.rs`'s either — because this one polls a {@link CancelFlag} rather
 * than an `AbortSignal` AND additionally tracks elapsed time since the wait
 * BEGAN (Rust's `let waited = Instant::now();`, declared fresh inside the outer
 * per-chunk loop, hence read here and not by the caller).
 */
async function waitForPullChunk(
  reader: ChunkReader,
  cancel: CancelFlag,
  stallTimeoutMs: number
): Promise<PullChunkStep> {
  const started = Date.now();
  const readPromise = reader.read();
  let pollDelayMs = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollPromise = new Promise<{ tag: "poll" }>((resolve) => {
      timer = setTimeout(() => resolve({ tag: "poll" }), pollDelayMs);
    });
    pollDelayMs = PULL_POLL_MS;
    try {
      const winner = await Promise.race([readPromise.then((r) => ({ tag: "read" as const, r })), pollPromise]);
      if (winner.tag === "read") {
        return winner.r.done ? { kind: "ended" } : { kind: "chunk", value: winner.r.value ?? new Uint8Array() };
      }
    } finally {
      clearTimeout(timer);
    }
    if (cancel.load()) {
      readPromise.catch(() => {});
      return { kind: "cancelled" };
    }
    if (Date.now() - started >= stallTimeoutMs) {
      readPromise.catch(() => {});
      return { kind: "stalled" };
    }
    // Neither settled: loop back and re-race the SAME read against a fresh timer.
  }
}

/**
 * `ollama::pull_cancellable` against an EXPLICIT sidecar base URL — the
 * testable core, the same `…At` split `engineRouting.ts`'s `listModelsAt` and
 * `sidecar.ts`'s `streamRun` already establish, so a real `node:http` stand-in
 * can drive the whole stream without going through {@link ensureUp}'s
 * process-spawning lifecycle.
 *
 * Cancellation is checked BEFORE anything else (Rust returns `PULL_CANCELLED`
 * without opening a connection), then between chunks and once more the instant
 * a chunk lands — the per-chunk placement is Rust's, so a buffer holding
 * several complete lines is drained rather than half-processed.
 *
 * Every NDJSON line goes through `sidecar.ts`'s already-ported
 * {@link splitCompleteLines} (a line is not decoded until its trailing `\n` has
 * actually arrived); a malformed line is skipped rather than fatal; a line
 * carrying `{"error": …}` is classified exactly as Rust's own per-line match
 * does (`OLLAMA_DOWN` straight through, `MODEL_MISSING` re-tagged with the
 * model name, anything else verbatim).
 *
 * `stallTimeoutMs` defaults to the real {@link PULL_STALL_TIMEOUT_MS} and is
 * overridable ONLY so a test can exercise the stall branch in well under five
 * minutes; production callers never pass it.
 */
export async function pullCancellableAt(
  base: string,
  model: string,
  cancel: CancelFlag,
  onProgress: PullProgressListener,
  stallTimeoutMs: number = PULL_STALL_TIMEOUT_MS
): Promise<PullOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}/pull`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ model, base_url: resolvedBaseUrl() }),
    });
  } catch (err) {
    return { kind: "error", message: classifyPullSendError(err) };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { kind: "error", message: `Download failed: ${text}` };
  }
  if (resp.body === null) {
    return { kind: "error", message: "Download failed: the sidecar returned no body" };
  }

  const reader = resp.body.getReader();
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      let step: PullChunkStep;
      try {
        step = await waitForPullChunk(reader, cancel, stallTimeoutMs);
      } catch (err) {
        // Rust: `Some(c) => c.map_err(|e| format!("Download interrupted: {e}"))?`
        // — a stream that BREAKS mid-transfer is its own message, distinct
        // from a stall and from a Stop. Without this the rejected read escaped
        // the PullOutcome contract entirely and reached the caller as a raw
        // network exception.
        return { kind: "error", message: `Download interrupted: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (step.kind === "cancelled") {
        return { kind: "cancelled" };
      }
      if (step.kind === "stalled") {
        return {
          kind: "error",
          message:
            `The download stopped receiving data for ${Math.floor(stallTimeoutMs / 60_000)} minutes and was ` +
            "cancelled. Check your connection and try again.",
        };
      }
      if (step.kind === "ended") {
        break;
      }
      // A Stop that landed the instant a chunk was already in hand.
      if (cancel.load()) {
        return { kind: "cancelled" };
      }
      buffered = Buffer.concat([buffered, Buffer.from(step.value)]);
      const split = splitCompleteLines(buffered);
      buffered = split.rest;
      for (const line of split.lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // a malformed line is skipped, not fatal — matching Rust
        }
        if (!isRecord(parsed)) {
          continue;
        }
        if (typeof parsed.error === "string") {
          const code = typeof parsed.code === "string" ? parsed.code : undefined;
          const message =
            code === "OLLAMA_DOWN" ? "OLLAMA_DOWN" : code === "MODEL_MISSING" ? `MODEL_MISSING:${model}` : parsed.error;
          return { kind: "error", message };
        }
        const status = typeof parsed.status === "string" ? parsed.status : "";
        const completed = typeof parsed.completed === "number" ? parsed.completed : null;
        const total = typeof parsed.total === "number" ? parsed.total : null;
        const percent = completed !== null && total !== null && total > 0 ? (completed / total) * 100 : null;
        onProgress(status, percent);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already released/consumed by a normal end-of-stream — best effort,
      // same as `sidecar.ts`'s `streamRun`.
    }
  }
  return { kind: "ok" };
}

/**
 * {@link pullCancellableAt} against the real, ensured-up sidecar — the
 * production entry point. The already-cancelled check comes FIRST, before
 * `ensureUp`, exactly as Rust checks the flag before `wake_daemon`/`ensure_up`:
 * a pull the user already stopped must not start a sidecar to do nothing.
 *
 * A multi-gigabyte pull is exactly the long-running request a missed health
 * probe must not kill, hence the {@link busy} guard for the whole transfer.
 */
export async function pullCancellable(
  model: string,
  cancel: CancelFlag,
  onProgress: PullProgressListener,
  stallTimeoutMs: number = PULL_STALL_TIMEOUT_MS
): Promise<PullOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }
  let base: string;
  try {
    base = await ensureUp();
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const guard = busy();
  try {
    return await pullCancellableAt(base, model, cancel, onProgress, stallTimeoutMs);
  } finally {
    guard.release();
  }
}

/**
 * `models.rs::pull_model`'s own progress throttle, factored out pure.
 *
 * A multi-gigabyte pull emits a progress line per chunk — hundreds a second,
 * each one a separate IPC message and a React render, for a bar that cannot
 * show more than about 200 distinct positions. Forward only what actually
 * changes something the user can see: a new phase, half a percent of progress,
 * or the final 100%.
 *
 * Ported branch-for-branch from the Rust `match (percent, last_percent)`: a
 * FIRST percentage value always counts as moved (there was nothing to compare
 * it to); a later one moves only past {@link PULL_PROGRESS_STEP} or at/after
 * 100; the absence of a percentage never counts as movement on its own, so a
 * status-only line repaints only when the phase itself changed.
 */
export function pullProgressShouldEmit(
  status: string,
  percent: number | null,
  lastStatus: string,
  lastPercent: number | null
): boolean {
  const phaseChanged = status !== lastStatus;
  const moved =
    percent !== null &&
    (lastPercent === null || Math.abs(percent - lastPercent) >= PULL_PROGRESS_STEP || percent >= 100);
  return phaseChanged || moved;
}

export interface PullModelDeps {
  pullCancellable(model: string, cancel: CancelFlag, onProgress: PullProgressListener): Promise<PullOutcome>;
}

export const defaultPullModelDeps: PullModelDeps = {
  pullCancellable: (model, cancel, onProgress) => pullCancellable(model, cancel, onProgress),
};

/**
 * `models.rs::pull_model` — download a model, reporting THROTTLED progress
 * through `onProgress` (Rust's `window.emit("pull-progress", …)`; a plain
 * callback here so the window layer is the caller's concern).
 *
 * Cancellable FROM HERE DOWN: the flag is registered in `state.cancels` under
 * {@link pullCancelKey} — the SAME flat registry chat's Stop uses — so
 * `cancelId(state, "pull:<name>")` abandons a running download. The key is
 * built from what the CALLER typed, never the normalised registry name, because
 * the Stop button rebuilds it from the name it asked with.
 *
 * The registry entry is removed on EVERY return path (success, cancel, error),
 * mirroring `commands.rs::CancelGuard`'s `Drop`, which also forgets the (here
 * unused, but harmless-to-clear) cancel-tree entry.
 */
export async function pullModel(
  state: CancelState,
  name: string,
  onProgress: PullProgressListener,
  deps: PullModelDeps = defaultPullModelDeps
): Promise<PullOutcome> {
  const flag = new CancelFlag();
  const key = pullCancelKey(name);
  state.cancels.set(key, flag);
  try {
    let lastStatus = "";
    let lastPercent: number | null = null;
    return await deps.pullCancellable(registryName(name), flag, (status, percent) => {
      if (!pullProgressShouldEmit(status, percent, lastStatus, lastPercent)) {
        return;
      }
      lastStatus = status;
      // `last_percent` moves only when this update carried one, so a
      // phase-only line does not blank a percentage the bar already shows.
      if (percent !== null) {
        lastPercent = percent;
      }
      onProgress(status, percent);
    });
  } finally {
    state.cancels.delete(key);
    forget(state, key);
  }
}

// ============================================================================
// models.rs — ai_status
// ============================================================================

/**
 * `ollama::list_models`'s REAL `Result<Vec<String>, String>` contract.
 *
 * Distinct from `engineRouting.ts`'s ported `listModels`, which deliberately
 * folds EVERY failure into `[]` (its own doc: "all three of its real call sites
 * immediately `.unwrap_or_default()` it"). {@link aiStatus} is a FOURTH call
 * site that reads the Ok/Err split itself — `running` IS `list_models().is_ok()`
 * in the Rust source — so reusing the folded version here would make an
 * unreachable engine indistinguishable from a reachable one with nothing
 * installed. A small private duplicate of the same `/models` POST, not a second
 * public list-models API.
 */
async function rawListModels(): Promise<string[]> {
  const base = await ensureUp();
  const guard = busy();
  try {
    const resp = await fetch(`${base}/models`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ base_url: resolvedBaseUrl() }),
    });
    if (!resp.ok) {
      throw new Error(`sidecar /models status ${resp.status}`);
    }
    const value: unknown = await resp.json();
    const models = isRecord(value) ? value.models : undefined;
    return Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : [];
  } finally {
    guard.release();
  }
}

/** The honest refusal for {@link AiStatusDeps.detectedExternal}/
 * {@link AiStatusDeps.ollamaInstalled} — see the module doc's "DELIBERATELY OUT
 * OF SCOPE". A genuinely unported dependency refuses; it never fabricates
 * "no CLIs found" or "not installed", either of which would be a confident
 * false statement about the user's machine. */
export const AI_STATUS_DETECTION_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: external-CLI / Ollama-installed detection " +
  "(commands/external.rs's `zsh -ilc` probes) has no Electron port in this tree yet.";

export function detectedExternalNotImplemented(): Promise<string[]> {
  return Promise.reject(new Error(AI_STATUS_DETECTION_NOT_IMPLEMENTED));
}

export function ollamaInstalledNotImplemented(): Promise<boolean> {
  return Promise.reject(new Error(AI_STATUS_DETECTION_NOT_IMPLEMENTED));
}

/** Everything {@link aiStatus} needs. `detectedExternal`/`ollamaInstalled` have
 * NO real default (see above); the rest do, because they are genuinely ported
 * already. */
export interface AiStatusDeps {
  /** `external.rs::detect_external_blocking`, cached PER SESSION by the caller
   * — mirroring `state.external_cache`, a cache this file does not own since
   * owning it would mean owning the whole unported subsystem. Rust probes once
   * because the probe forks an interactive login shell and `ai_status` runs on
   * every image open and every status refresh. */
  detectedExternal(): Promise<string[]>;
  /** `external.rs::ollama_installed_blocking`. */
  ollamaInstalled(): Promise<boolean>;
  /** `providers::provider_connected`. */
  providerConnected(provider: string): boolean;
  /** `capabilities::ollama_runs_here`. */
  ollamaRunsHere(): boolean;
  /** `ollama::list_models`'s raw, throwing contract — see {@link rawListModels}. */
  listModelsRaw(): Promise<string[]>;
}

export const defaultAiStatusDeps: AiStatusDeps = {
  detectedExternal: detectedExternalNotImplemented,
  ollamaInstalled: ollamaInstalledNotImplemented,
  providerConnected,
  ollamaRunsHere,
  listModelsRaw: rawListModels,
};

/**
 * `models.rs::ai_status` — the room's AI status: is Ollama answering, is it
 * installed at all, what is installed, which model the room would use, which
 * external CLIs were detected, and whether this room's Ollama is ANOTHER
 * computer. `explicitModel` is the room's `model` setting, resolved by the
 * caller (same convention as {@link groundingModelForRoom}).
 *
 * "Reachable means installed, regardless of the app-path check" is Rust's own
 * comment on the success arm, hence the hardcoded `installed: true` there.
 *
 * NOTE: with {@link defaultAiStatusDeps} this REJECTS — honestly — because
 * `detectedExternal`/`ollamaInstalled` have no implementation in this tree yet.
 * A caller must inject both before it can answer for real.
 */
export async function aiStatus(
  explicitModel: string | null,
  deps: AiStatusDeps = defaultAiStatusDeps
): Promise<AiStatus> {
  // A copy, so the caller's cached probe array is never mutated by the
  // openrouter push below (Rust clones the cached Vec for the same reason).
  const external = [...(await deps.detectedExternal())];
  if (deps.providerConnected("openrouter")) {
    external.push("openrouter");
  }
  const installed = await deps.ollamaInstalled();
  const remoteRelay = !deps.ollamaRunsHere();
  try {
    const models = await deps.listModelsRaw();
    return {
      running: true,
      installed: true,
      models,
      defaultModel: explicitModel ?? bestDefault(models),
      external,
      remoteRelay,
    };
  } catch {
    return {
      running: false,
      installed,
      models: [],
      defaultModel: explicitModel ?? DEFAULT_MODEL,
      external,
      remoteRelay,
    };
  }
}

// ============================================================================
// IPC shim — written, NOT wired into any bootstrap file
// ============================================================================

/**
 * Everything a live renderer would need injected to drive this surface over
 * IPC. `explicitModel` mirrors every command above: the caller resolves the
 * room's `model` setting (a DB read Rust takes under the room lock) and hands
 * it in, rather than this shim reaching into a room itself.
 */
export interface OllamaModelsIpcDeps {
  /** The app's shared cancel registry — the same one a Stop
   * (`cancelId(state, 'pull:<name>')`) reaches into. */
  cancelState: CancelState;
  explicitModel(): string | null;
  aiStatusDeps?: AiStatusDeps;
  groundingDeps?: GroundingModelForRoomDeps;
  modelCapabilitiesDeps?: ModelCapabilitiesDeps;
  warmModelDeps?: WarmModelDeps;
  pullModelDeps?: PullModelDeps;
}

/**
 * Register every `models.rs` channel on `ipcMain`. Channel names are the Rust
 * `#[tauri::command]` names and the argument shape is the object `src/api.ts`
 * already passes (`invoke("pull_model", { name })`), so a future renderer needs
 * no rename — the same convention `recIpc.ts` follows.
 *
 * NOT called from any bootstrap file by this batch (Phase 2 needs an explicit
 * owner go-ahead), exactly like `registerRecIpc`/`registerDictIpc`.
 */
export function registerOllamaModelsIpc(ipcMain: Pick<IpcMain, "handle">, deps: OllamaModelsIpcDeps): void {
  ipcMain.handle("ai_status", () => aiStatus(deps.explicitModel(), deps.aiStatusDeps));
  ipcMain.handle("model_capabilities", () => modelCapabilities(deps.modelCapabilitiesDeps));
  ipcMain.handle("grounding_model_for_room", () => groundingModelForRoom(deps.explicitModel(), deps.groundingDeps));
  ipcMain.handle("open_ollama", () => openOllama());
  ipcMain.handle("warm_model", () => warmModel(deps.explicitModel(), deps.warmModelDeps));
  ipcMain.handle("delete_model", (_event: IpcMainInvokeEvent, args: { name: string }) => deleteModel(args.name));
  // `pull_model`'s progress rides on the INVOKING window, mirroring the Rust
  // command's own `window: tauri::Window` parameter and its
  // `window.emit("pull-progress", …)` — `IpcMainInvokeEvent.sender` is the
  // WebContents that called `invoke()`, the direct Electron analogue.
  //
  // The OUTCOME is flattened back to Rust's wire contract here, at the boundary
  // and nowhere else: `Ok(())` resolves, a Stop rejects with the exact
  // PULL_CANCELLED sentence every "start a pull" surface already reads as
  // "stopped", and a real failure rejects with its own message.
  ipcMain.handle("pull_model", async (event: IpcMainInvokeEvent, args: { name: string }) => {
    const outcome = await pullModel(
      deps.cancelState,
      args.name,
      (status, percent) => {
        event.sender.send("pull-progress", { status, percent });
      },
      deps.pullModelDeps
    );
    if (outcome.kind === "ok") {
      return;
    }
    throw new Error(outcome.kind === "cancelled" ? PULL_CANCELLED : outcome.message);
  });
}
