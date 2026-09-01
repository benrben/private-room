import koffi from "koffi";
import type { AiProviderStatus, ExternalModelInfo } from "../shared/apiTypes.js";
import { OPENROUTER_ID, ProviderRuntimeConfig, ProviderDeps, modelRuntimeCache, providerModelDisplayLabels, clearKeyRejected } from "./providersCore.js";
import { readKey, storeKey, deleteKey, defaultProviderDeps } from "./providersKeychain.js";
import { providerSpec, fetchOpenrouterModels, providerConnected, listProviderModels } from "./providersCatalog.js";

// ──────────────────────────────────────────────── runtime config (sidecar)

export function selectedOpenrouterModel(model: string): string | undefined {
  const [provider, rawSelected] = model.split("::");
  if (provider !== OPENROUTER_ID) {
    return undefined;
  }
  if (rawSelected === undefined || rawSelected.trim() === "") {
    throw new Error("Choose a specific OpenRouter model first.");
  }
  return rawSelected.trim();
}

export function rejectOpenrouterDisplayLabel(selected: string): void {
  if (!modelRuntimeCache.has(selected) && providerModelDisplayLabels.has(selected)) {
    throw new Error(
      `“${selected}” is an OpenRouter display name, not a model ID. ` +
        "Choose the model again in Settings → Model.",
    );
  }
}

export function runtimeCapabilities(selected: string): Pick<ProviderRuntimeConfig, "contextWindow" | "supportsTools" | "supportsVision"> {
  const facts = modelRuntimeCache.get(selected);
  if (facts === undefined) {
    return { contextWindow: null, supportsTools: true, supportsVision: null };
  }
  return {
    contextWindow: facts.contextWindow,
    supportsTools: facts.tools,
    supportsVision: facts.vision,
  };
}

export function runtimeProviderKey(provider: string, label: string, deps: ProviderDeps): string {
  try {
    return deps.readKey(provider);
  } catch {
    throw new Error(
      `This room is set to ${label}, but no ${label} API key is saved on this Mac ` +
        `any more. Reconnect it in Settings → Cloud AI, or choose another model in ` +
        "Settings → Model.",
    );
  }
}

/**
 * `providers.rs::provider_runtime_config`. Returns `null` for a non-OpenRouter
 * model (mirroring `Ok(None)`); throws for a missing/blank selection or for a
 * key that is no longer saved (mirroring `Err(String)`).
 */
export function providerRuntimeConfig(
  model: string,
  deps: ProviderDeps = defaultProviderDeps,
): ProviderRuntimeConfig | null {
  const selected = selectedOpenrouterModel(model);
  if (selected === undefined) {
    return null;
  }
  // The provider catalog has two distinct fields: `id` is the wire value and
  // `name` is presentation only. A pre-fix room could retain a display name
  // such as "OpenAI: gpt-oss-20b". Once the live catalog identifies that
  // value as a label, fail locally instead of sending it as an invalid model
  // ID. Do not guess a slug from a label: labels are not guaranteed unique.
  rejectOpenrouterDisplayLabel(selected);
  const { label, baseUrl } = providerSpec(OPENROUTER_ID);
  const capabilities = runtimeCapabilities(selected);

  return {
    id: OPENROUTER_ID,
    apiKey: runtimeProviderKey(OPENROUTER_ID, label, deps),
    baseUrl,
    model: selected,
    ...capabilities,
  };
}

/** The EXACT JSON object the Python sidecar's `ProviderConfig` reads —
 * snake_case field names on purpose, and the only shape that may be
 * serialized into a `/run` body. See the module doc's WIRE SHAPE section. */
export function providerRuntimeConfigWire(config: ProviderRuntimeConfig): Record<string, unknown> {
  return {
    id: config.id,
    api_key: config.apiKey,
    base_url: config.baseUrl,
    model: config.model,
    context_window: config.contextWindow,
    supports_tools: config.supportsTools,
    supports_vision: config.supportsVision,
  };
}

/**
 * `providers.rs::inject_provider_runtime`. For a non-provider model the body
 * is handed straight back (the caller still owns it, and every call site
 * serializes it immediately); for a provider model a new object carrying the
 * wire-shaped `provider` key is returned.
 *
 * `body` is `unknown` rather than a `Record` on purpose: the Rust source only
 * demands an object for the provider branch, so the "must be an object" error
 * has to stay reachable rather than being compiled away.
 */
export function injectProviderRuntime(
  body: unknown,
  model: string,
  deps: ProviderDeps = defaultProviderDeps,
): unknown {
  const config = providerRuntimeConfig(model, deps);
  if (config === null) return body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Sidecar request body must be an object");
  }
  return { ...body, provider: providerRuntimeConfigWire(config) };
}

// ─────────────────────────────────────────────── Tauri-command equivalents

/** `providers.rs::list_ai_providers`. */
export function listAiProviders(deps: ProviderDeps = defaultProviderDeps): AiProviderStatus[] {
  return [{ id: OPENROUTER_ID, label: "OpenRouter", connected: providerConnected(OPENROUTER_ID, deps) }];
}

/** `providers.rs::connect_ai_provider` — the key is only saved once the
 * catalog fetch has accepted it. */
export async function connectAiProvider(
  provider: string,
  apiKey: string,
  deps: ProviderDeps = defaultProviderDeps,
): Promise<number> {
  providerSpec(provider);
  const key = apiKey.trim();
  if (key === "") throw new Error("Enter an API key.");
  // See `listProviderModels` for why this unreachable arm is kept.
  if (provider !== OPENROUTER_ID) throw new Error(`Unreachable: unknown provider ${provider}`);
  const models = await fetchOpenrouterModels(key, deps.fetchJson);
  deps.storeKey(provider, key);
  // A freshly accepted key clears any earlier rejection, so the badge is
  // green again the moment the user pastes a working one.
  clearKeyRejected(provider);
  return models.length;
}

/** `providers.rs::disconnect_ai_provider`. */
export function disconnectAiProvider(provider: string, deps: ProviderDeps = defaultProviderDeps): void {
  providerSpec(provider);
  clearKeyRejected(provider);
  deps.deleteKey(provider);
}
