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

function parseCatalogJson(raw: string, source: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`bad JSON from ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

function codexReasoningLevels(row: Record<string, unknown>): string[] {
  const rawLevels = row.supported_reasoning_levels;
  if (!Array.isArray(rawLevels)) return [];
  return rawLevels.map(object).map((level) => level.effort).filter((value): value is string => typeof value === "string");
}

function codexModelFromRow(item: unknown): ExternalModelInfo | null {
  const row = object(item);
  if (row.visibility !== "list" || typeof row.slug !== "string") return null;
  const levels = codexReasoningLevels(row);
  return {
    ...baseModel(row.slug, typeof row.display_name === "string" ? row.display_name : row.slug),
    efforts: levels,
    defaultEffort: typeof row.default_reasoning_level === "string" ? row.default_reasoning_level : null,
    contextWindow: typeof row.context_window === "number" ? row.context_window : null,
    reasoning: levels.length > 0,
  };
}

export function codexModelsFromJson(raw: string): ExternalModelInfo[] {
  const parsed = parseCatalogJson(raw, "codex");
  const models = object(parsed).models;
  if (!Array.isArray(models)) return [];
  const out: ExternalModelInfo[] = [];
  for (const item of models) {
    const model = codexModelFromRow(item);
    if (model) out.push(model);
  }
  return out;
}

export function antigravityModelsFromJson(raw: string): ExternalModelInfo[] {
  const parsed = parseCatalogJson(raw, "agy");
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

function validateOllamaSelection(
  deps: ModelSelectionValidatorDeps,
  exactId: string,
): Promise<ModelSelectionValidation> {
  return deps.probeOllama(exactId).then((probe) => probe.ok
    ? { selectable: true, reason: null }
    : {
        selectable: false,
        reason: `Ollama could not validate the exact model ID “${exactId}”. ${probe.detail ?? "Refresh the model list and try again."}`,
      });
}

async function openrouterModelKnown(
  deps: ModelSelectionValidatorDeps,
  exactId: string,
): Promise<boolean> {
  if (deps.providerModelKnown(`openrouter::${exactId}`)) return true;
  const rows = await deps.listProviderModels("openrouter");
  return rows.some((row) => row.slug === exactId);
}

async function validateOpenrouterSelection(
  deps: ModelSelectionValidatorDeps,
  exactId: string,
): Promise<ModelSelectionValidation> {
  if (!await openrouterModelKnown(deps, exactId)) {
    return {
      selectable: false,
      reason: `OpenRouter does not offer the exact model ID “${exactId}” for this account. Refresh the catalog or choose another model.`,
    };
  }
  const probe = await deps.probeProviderModel?.(exactId) ?? { ok: true, detail: null };
  return probe.ok
    ? { selectable: true, reason: null }
    : {
        selectable: false,
        reason: `OpenRouter could not run the exact model ID “${exactId}”. ${probe.detail ?? "Choose another model."}`,
      };
}

function validateNativeSelection(): ModelSelectionValidation {
  return { selectable: true, reason: null };
}

function validateSelection(
  deps: ModelSelectionValidatorDeps,
  engine: string,
  exactId: string,
): Promise<ModelSelectionValidation> {
  if (engine === "ollama-local" || engine === "ollama-cloud") return validateOllamaSelection(deps, exactId);
  if (engine === "openrouter") return validateOpenrouterSelection(deps, exactId);
  return Promise.resolve(validateNativeSelection());
}

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

    const result = await validateSelection(deps, engine, exactId);
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

type CreateCatalogDeps = {
  ensureMediaLimits(key: string): Promise<void>;
  limitsFor(slug: string): ReturnType<typeof limitsFor>;
  listProviderModels(provider: string): Promise<ExternalModelInfo[]>;
  mediaTableLoaded(): boolean;
  openrouterKey(): string | null;
  providerConnected(provider: string): boolean;
};

const createCatalogDeps: CreateCatalogDeps = {
  ensureMediaLimits,
  limitsFor,
  listProviderModels,
  mediaTableLoaded,
  openrouterKey,
  providerConnected,
};

type ProviderCreateCatalog = {
  error: string | null;
  models: CreateModel[];
  scanned: number;
  textOnly: string[];
};

function asCreateModel(model: ExternalModelInfo, deps: CreateCatalogDeps): CreateModel {
  return {
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
    limits: deps.limitsFor(model.slug) ?? null,
  };
}

function splitProviderCreateModels(
  catalog: readonly ExternalModelInfo[],
  deps: CreateCatalogDeps,
): Pick<ProviderCreateCatalog, "models" | "textOnly"> {
  const models: CreateModel[] = [];
  const textOnly: string[] = [];
  for (const model of catalog) {
    if (!model.imageOutput && !model.videoOutput) textOnly.push(model.slug);
    else models.push(asCreateModel(model, deps));
  }
  return { models, textOnly };
}

async function providerCreateCatalog(deps: CreateCatalogDeps): Promise<ProviderCreateCatalog> {
  const key = deps.openrouterKey();
  if (key) await deps.ensureMediaLimits(key);
  try {
    const catalog = await deps.listProviderModels("openrouter");
    return { ...splitProviderCreateModels(catalog, deps), scanned: catalog.length, error: null };
  } catch (cause) {
    return { models: [], textOnly: [], scanned: 0, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function nativeCreateReason(engine: string): string {
  if (engine === "claude-cli" || engine === "codex-cli" || engine === "antigravity-cli") {
    return "Reads pictures, cannot make them — vision in, no image out.";
  }
  return "Serves chat models. A drawing model is not reachable over its chat API at all, so nothing local can make a picture yet.";
}

function nativeCreateExclusions(): { excluded: CreateExclusion[]; scanned: number } {
  const excluded: CreateExclusion[] = [];
  let scanned = 0;
  for (const decl of DECLARED) {
    if (decl.id === "openrouter") continue;
    scanned += 1;
    excluded.push(exclusion(decl.id, nativeCreateReason(decl.id), [decl.label])!);
  }
  return { excluded, scanned };
}

function removeUnreachableMediaModels(
  models: readonly CreateModel[],
  deps: CreateCatalogDeps,
): { models: CreateModel[]; unreachable: string[] } {
  const remaining = [...models];
  const unreachable: string[] = [];
  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    if (deps.limitsFor(remaining[index]!.slug) !== undefined) continue;
    unreachable.push(remaining.splice(index, 1)[0]!.label);
  }
  return { models: remaining, unreachable };
}

function compareCreateModels(left: CreateModel, right: CreateModel): number {
  const autoDifference = Number(left.slug.startsWith("openrouter/auto")) - Number(right.slug.startsWith("openrouter/auto"));
  if (autoDifference !== 0) return autoDifference;
  return left.label.toLowerCase() < right.label.toLowerCase() ? -1 : 1;
}

export async function listCreateModels(): Promise<CreateCatalog> {
  const anyProvider = createCatalogDeps.providerConnected("openrouter");
  const provider = anyProvider
    ? await providerCreateCatalog(createCatalogDeps)
    : { models: [], textOnly: [], scanned: 0, error: null };
  const excluded: CreateExclusion[] = [];
  const textRow = exclusion("openrouter", "Text output only, per the provider's own catalog.", provider.textOnly);
  if (textRow) excluded.push(textRow);
  const native = nativeCreateExclusions();
  excluded.push(...native.excluded);
  const supported = createCatalogDeps.mediaTableLoaded()
    ? removeUnreachableMediaModels(provider.models, createCatalogDeps)
    : { models: provider.models, unreachable: [] };
  const unreachableRow = exclusion(
      "openrouter",
      "Declares pictures on the chat API, but the provider's own picture and video endpoints do not serve it — a call would return no endpoint found.",
      supported.unreachable,
    );
  if (unreachableRow) excluded.push(unreachableRow);
  supported.models.sort(compareCreateModels);
  return {
    models: supported.models,
    scanned: provider.scanned + native.scanned,
    excluded,
    anyProvider,
    error: provider.error,
  };
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
