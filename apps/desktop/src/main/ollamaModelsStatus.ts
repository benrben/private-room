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
import { isRecord, deleteModel } from "./ollamaModelsCore.js";
import { GroundingModelForRoomDeps, groundingModelForRoom, ModelCapabilitiesDeps, modelCapabilities, openOllama, WarmModelDeps, warmModel } from "./ollamaModelsSelection.js";
import { PULL_CANCELLED, PullModelDeps, pullModel } from "./ollamaModelsPull.js";

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
export async function rawListModels(): Promise<string[]> {
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
