/** Cloud-engine model pickers and the provider-backed Create shelf. */

import { execFile } from "node:child_process";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  CreateCatalog,
  CreateExclusion,
  CreateModel,
  ExternalModelInfo,
  ModelSelectionValidation,
} from "../shared/apiTypes.js";
import { DECLARED } from "./capabilities.js";
import { probeOllamaModelSelection } from "./ollamaModels.js";
import {
  listProviderModels,
  openrouterKey,
  probeOpenrouterModelSelection,
  providerModelSelectable,
  providerConnected,
} from "./providers.js";
import { ensureMediaLimits, limitsFor, mediaTableLoaded } from "./mediaLimits.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function baseModel(slug: string, label: string): ExternalModelInfo {
  return {
    slug,
    label,
    efforts: [],
    defaultEffort: null,
    contextWindow: null,
    description: null,
    inputPrice: null,
    outputPrice: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    tools: true,
    vision: false,
    imageOutput: false,
    videoOutput: false,
    reasoning: false,
    structuredOutputs: true,
  };
}

function claudeModels(): ExternalModelInfo[] {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  return ["opus", "sonnet", "haiku", "fable"].map((slug) => ({
    ...baseModel(slug, slug[0]!.toUpperCase() + slug.slice(1)),
    efforts,
    inputModalities: ["text", "image"],
    vision: true,
    reasoning: true,
  }));
}

function runCodexCatalog(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/zsh", ["-ilc", "codex debug models"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`codex debug models failed: ${String(stderr || error.message).slice(0, 400)}`));
      } else {
        resolve(stdout);
      }
    });
    // These catalog commands are non-interactive, but both CLIs inherit the
    // pipe that execFile creates for stdin. Antigravity in particular keeps
    // waiting while that pipe is open, so the picker would sit on “Checking…”
    // until our 30-second timeout despite the catalog already being ready.
    child.stdin?.end();
  });
}

function runAntigravityCatalog(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/zsh", ["-ilc", "agy --output-format json models"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`agy models failed: ${String(stderr || error.message).slice(0, 400)}`));
      else resolve(stdout);
    });
    child.stdin?.end();
  });
}

function codexModelsFromJson(raw: string): ExternalModelInfo[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`bad JSON from codex: ${error instanceof Error ? error.message : String(error)}`);
  }
  const models = object(parsed).models;
  if (!Array.isArray(models)) return [];
  const out: ExternalModelInfo[] = [];
  for (const item of models) {
    const row = object(item);
    if (row.visibility !== "list" || typeof row.slug !== "string") continue;
    const levels = Array.isArray(row.supported_reasoning_levels)
      ? row.supported_reasoning_levels.map(object).map((level) => level.effort).filter((v): v is string => typeof v === "string")
      : [];
    out.push({
      ...baseModel(row.slug, typeof row.display_name === "string" ? row.display_name : row.slug),
      efforts: levels,
      defaultEffort: typeof row.default_reasoning_level === "string" ? row.default_reasoning_level : null,
      contextWindow: typeof row.context_window === "number" ? row.context_window : null,
      reasoning: levels.length > 0,
    });
  }
  return out;
}

export function antigravityModelsFromJson(raw: string): ExternalModelInfo[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`bad JSON from agy: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rows = object(object(object(parsed).command).data).models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) => {
    const row = object(item);
    if (typeof row.id !== "string") return [];
    return [{
      ...baseModel(row.id, typeof row.label === "string" ? row.label : row.id),
      contextWindow: 1_048_576,
      reasoning: true,
    }];
  });
}

export async function listEngineModels(engine: string): Promise<ExternalModelInfo[]> {
  if (engine === "openrouter") return listProviderModels("openrouter");
  if (engine === "claude-cli") return claudeModels();
  if (engine === "codex-cli") return codexModelsFromJson(await runCodexCatalog());
  if (engine === "antigravity-cli") return antigravityModelsFromJson(await runAntigravityCatalog());
  throw new Error(`Unknown engine: ${engine}`);
}

export interface ModelSelectionValidatorDeps {
  probeOllama(model: string): Promise<{ ok: boolean; detail: string | null }>;
  listProviderModels(provider: string): Promise<ExternalModelInfo[]>;
  providerModelKnown(selection: string): boolean;
  /** Low-token runtime probe for the one chosen provider model. */
  probeProviderModel?(model: string): Promise<{ ok: boolean; detail: string | null }>;
  now(): number;
}

const FAILED_VALIDATION_TTL_MS = 60_000;

/**
 * Exact-ID capability check used by the model picker. Successes live for this
 * process; transient failures are retried after one minute. OpenRouter is
 * deliberately lazy: its hundreds of catalog rows are not probed one by one.
 */
export function createModelSelectionValidator(deps: ModelSelectionValidatorDeps) {
  const cache = new Map<string, { result: ModelSelectionValidation; expiresAt: number }>();
  return async (engine: string, model: string): Promise<ModelSelectionValidation> => {
    const exactId = model.trim();
    if (exactId === "") return { selectable: false, reason: "Choose a specific model first." };
    const cacheKey = `${engine}\0${exactId}`;
    const prior = cache.get(cacheKey);
    if (prior && prior.expiresAt > deps.now()) return prior.result;

    let result: ModelSelectionValidation;
    if (engine === "ollama-local" || engine === "ollama-cloud") {
      const probe = await deps.probeOllama(exactId);
      result = probe.ok
        ? { selectable: true, reason: null }
        : {
            selectable: false,
            reason: `Ollama could not validate the exact model ID “${exactId}”. ${probe.detail ?? "Refresh the model list and try again."}`,
          };
    } else if (engine === "openrouter") {
      // A prior picker catalog fetch already populated this exact-slug cache.
      // Otherwise do one authenticated, account-scoped catalog read now. This
      // is one lazy check for the chosen model, not N probes for N rows.
      let known = deps.providerModelKnown(`openrouter::${exactId}`);
      if (known !== true) {
        const rows = await deps.listProviderModels("openrouter");
        known = rows.some((row) => row.slug === exactId);
      }
      if (!known) {
        result = {
            selectable: false,
            reason: `OpenRouter does not offer the exact model ID “${exactId}” for this account. Refresh the catalog or choose another model.`,
        };
      } else {
        const probe = await deps.probeProviderModel?.(exactId) ?? { ok: true, detail: null };
        result = probe.ok
          ? { selectable: true, reason: null }
          : {
              selectable: false,
              reason: `OpenRouter could not run the exact model ID “${exactId}”. ${probe.detail ?? "Choose another model."}`,
            };
      }
    } else {
      // Native CLI catalogs are produced by the installed CLI itself. Their
      // listed IDs are already the runtime IDs and need no second provider call.
      result = { selectable: true, reason: null };
    }
    cache.set(cacheKey, {
      result,
      expiresAt: result.selectable ? Number.POSITIVE_INFINITY : deps.now() + FAILED_VALIDATION_TTL_MS,
    });
    return result;
  };
}

export const validateModelSelection = createModelSelectionValidator({
  probeOllama: probeOllamaModelSelection,
  listProviderModels,
  providerModelKnown: (selection) => providerModelSelectable(selection) === true,
  probeProviderModel: probeOpenrouterModelSelection,
  now: Date.now,
});

function exclusion(engine: string, reason: string, names: string[]): CreateExclusion | null {
  if (names.length === 0) return null;
  return {
    engineLabel: DECLARED.find((decl) => decl.id === engine)?.label ?? engine,
    reason,
    count: names.length,
    examples: names.slice(0, 3),
  };
}

export async function listCreateModels(): Promise<CreateCatalog> {
  const models: CreateModel[] = [];
  const excluded: CreateExclusion[] = [];
  let scanned = 0;
  let error: string | null = null;
  const anyProvider = providerConnected("openrouter");
  if (anyProvider) {
    const key = openrouterKey();
    if (key) await ensureMediaLimits(key);
    try {
      const catalog = await listProviderModels("openrouter");
      scanned += catalog.length;
      const textOnly: string[] = [];
      for (const model of catalog) {
        if (!model.imageOutput && !model.videoOutput) {
          textOnly.push(model.slug);
          continue;
        }
        models.push({
          model: `openrouter::${model.slug}`,
          slug: model.slug,
          label: model.label,
          engine: "openrouter",
          engineLabel: "OpenRouter",
          local: false,
          description: model.description,
          image: model.imageOutput,
          video: model.videoOutput,
          outputPrice: model.outputPrice,
          limits: limitsFor(model.slug) ?? null,
        });
      }
      const textRow = exclusion("openrouter", "Text output only, per the provider's own catalog.", textOnly);
      if (textRow) excluded.push(textRow);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  for (const decl of DECLARED) {
    if (decl.id === "openrouter") continue;
    scanned += 1;
    const reason = decl.id === "claude-cli" || decl.id === "codex-cli" || decl.id === "antigravity-cli"
      ? "Reads pictures, cannot make them — vision in, no image out."
      : "Serves chat models. A drawing model is not reachable over its chat API at all, so nothing local can make a picture yet.";
    const row = exclusion(decl.id, reason, [decl.label]);
    if (row) excluded.push(row);
  }
  if (mediaTableLoaded()) {
    const unreachable: string[] = [];
    for (let i = models.length - 1; i >= 0; i -= 1) {
      if (limitsFor(models[i]!.slug) === undefined) unreachable.push(models.splice(i, 1)[0]!.label);
    }
    const row = exclusion(
      "openrouter",
      "Declares pictures on the chat API, but the provider's own picture and video endpoints do not serve it — a call would return no endpoint found.",
      unreachable,
    );
    if (row) excluded.push(row);
  }
  models.sort((a, b) => Number(a.slug.startsWith("openrouter/auto")) - Number(b.slug.startsWith("openrouter/auto")) || (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
  return { models, scanned, excluded, anyProvider, error };
}

export function registerModelCatalogSurfaceIpc(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle("list_engine_models", (_event: IpcMainInvokeEvent, raw: unknown) =>
    listEngineModels(String(object(raw).engine ?? "")));
  ipcMain.handle("list_create_models", () => listCreateModels());
  ipcMain.handle("validate_engine_model", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const row = object(raw);
    return validateModelSelection(String(row.engine ?? ""), String(row.model ?? ""));
  });
}
