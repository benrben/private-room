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
import { ollamaCapabilities, warm } from "./ollamaModelsCore.js";

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

export async function preferredModelSeesImages(model: string, deps: GroundingPickDeps): Promise<boolean> {
  return imageReachesModel(model, deps.privacyDoorActive) && await chatModelSeesImages(model, deps);
}

export async function firstLocalVisionModel(
  models: readonly string[],
  chatModel: string,
  deps: GroundingPickDeps,
): Promise<string | null> {
  for (const model of models) {
    if (model !== chatModel && runsOnThisMac(model) && await chatModelSeesImages(model, deps)) {
      return model;
    }
  }
  return null;
}

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
  if (await preferredModelSeesImages(chatModel, deps)) {
    return chatModel;
  }
  return firstLocalVisionModel(models, chatModel, deps);
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

export const realOpenOllamaSpawn: OpenOllamaSpawnFn = (command, args) =>
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
