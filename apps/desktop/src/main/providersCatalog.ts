import koffi from "koffi";
import type { AiProviderStatus, ExternalModelInfo } from "../shared/apiTypes.js";
import { OPENROUTER_ID, OPENROUTER_BASE_URL, CATALOG_RETRY_AFTER_MS, PROVIDER_FETCH_TIMEOUT_MS, MEDIA_MODALITIES, ModelRuntimeFacts, HttpJsonResponseLike, FetchJsonLike, ProviderDeps, catalogState, jget, jstr, jstrArray, jUnsignedInt, modelRuntimeCache, selectableProviderModelIds, providerModelDisplayLabels, noteKeyRejected, clearKeyRejected, keyRejected, catalogRetryDue, withFetchLock } from "./providersCore.js";
import { readKey, defaultProviderDeps } from "./providersKeychain.js";

// ─────────────────────────────────────────────────────────────── providers

export function providerSpec(provider: string): { label: string; baseUrl: string } {
  if (provider === OPENROUTER_ID) return { label: "OpenRouter", baseUrl: OPENROUTER_BASE_URL };
  throw new Error(`Unknown AI provider: ${provider}`);
}

/**
 * The model slug out of a composite `"<provider>::<slug>[::<effort>]"`
 * selection, or `undefined` when there is no second segment at all.
 *
 * The Rust source spells this `model.splitn(3, "::").nth(1)`. A plain
 * `.split("::")[1]` is exactly equivalent for index 0 or 1 — both name the
 * text between the first and second separator — and only index 2 (which
 * nothing here reads) would differ, so no `splitn` re-implementation is
 * warranted.
 */
export function selectedSlug(model: string): string | undefined {
  return model.split("::")[1];
}

/** `providers.rs::provider_model_facts` — everything the live catalog knows
 * about one provider model, or `undefined` when it has no entry for it, so
 * the caller decides what "unknown" means rather than being handed a guess.
 * `capabilities.rs` turns each field into a `Support`, where that absence
 * becomes `Support::Unknown`. */
export function providerModelFacts(model: string): ModelRuntimeFacts | undefined {
  const raw = selectedSlug(model);
  if (raw === undefined) return undefined;
  return modelRuntimeCache.get(raw.trim());
}

/** `providers.rs::provider_model_vision` — does the catalog say this provider
 * model accepts image INPUT? `undefined` when the catalog has nothing for
 * it. */
export function providerModelVision(model: string): boolean | undefined {
  return providerModelFacts(model)?.vision;
}

/** Whether the authenticated account catalog contains this exact runtime ID.
 * `undefined` means the catalog has not been loaded yet. */
export function providerModelSelectable(model: string): boolean | undefined {
  if (!catalogState.loaded) return undefined;
  const raw = selectedSlug(model);
  return raw === undefined ? false : selectableProviderModelIds.has(raw.trim());
}

/** `providers.rs::is_api_provider_model`. */
export function isApiProviderModel(model: string): boolean {
  return model.split("::")[0] === OPENROUTER_ID;
}

/**
 * `providers.rs::media_catalog_path` — where to ask for one media catalogue.
 *
 * The PUBLIC `/models`, deliberately — not the user-scoped `/models/user`
 * this module uses for everything else. `/models/user` ignores the filter
 * rather than honouring it (OpenRouter drops unknown query parameters
 * silently: `?bogus_param=1` answers 200 with the full 400-model list), so
 * asking it for the video catalogue returns the ordinary chat catalogue, the
 * merge finds nothing new, and the Create page shows a video tab reading zero
 * while twenty-one video models sit one endpoint away. That is precisely the
 * bug this comment exists to stop someone re-introducing by "tidying" these
 * two paths into one.
 */
export function mediaCatalogPath(modality: string): string {
  return `/models?output_modalities=${modality}`;
}

/** The ordering `models.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label
 * .to_lowercase()))` gives in Rust: a plain code-point comparison of the
 * lowercased label, NOT a locale-aware collation (which is what
 * `localeCompare` would give, and which orders non-ASCII labels
 * differently). */
export function byLowercaseLabel(a: ExternalModelInfo, b: ExternalModelInfo): number {
  const al = a.label.toLowerCase();
  const bl = b.label.toLowerCase();
  if (al < bl) return -1;
  if (al > bl) return 1;
  return 0;
}

export function catalogEntries(value: unknown): unknown[] {
  const data = jget(value, "data");
  return Array.isArray(data) ? data : [];
}

export function parsedOpenrouterModel(raw: unknown): ExternalModelInfo | undefined {
  const slug = jstr(jget(raw, "id"));
  if (slug === null) {
    return undefined;
  }
  const parameters = jstrArray(jget(raw, "supported_parameters"));
  const architecture = jget(raw, "architecture");
  const inputModalities = jstrArray(jget(architecture, "input_modalities"));
  const outputModalities = jstrArray(jget(architecture, "output_modalities"));
  const pricing = jget(raw, "pricing");
  return {
    slug,
    label: jstr(jget(raw, "name")) ?? slug,
    efforts: [],
    defaultEffort: null,
    contextWindow: jUnsignedInt(jget(raw, "context_length")),
    description: jstr(jget(raw, "description")),
    inputPrice: jstr(jget(pricing, "prompt")),
    outputPrice: jstr(jget(pricing, "completion")),
    inputModalities,
    outputModalities,
    tools: parameters.includes("tools"),
    vision: inputModalities.includes("image"),
    imageOutput: outputModalities.includes("image"),
    videoOutput: outputModalities.includes("video"),
    reasoning: parameters.includes("reasoning") || parameters.includes("include_reasoning"),
    structuredOutputs: parameters.includes("structured_outputs") || parameters.includes("response_format"),
  };
}

/** `providers.rs::parse_openrouter_models` — pure and network-free, exactly
 * what the Rust source's own fixture tests exercise. Every capability flag is
 * read from the catalog's own declared fields and never inferred from the
 * slug: "flux", "image" and "video" appear in the names of models that only
 * DESCRIBE pictures, and the models that do draw are not obliged to say so in
 * their id. */
export function parseOpenrouterModels(value: unknown): ExternalModelInfo[] {
  const models: ExternalModelInfo[] = [];
  for (const raw of catalogEntries(value)) {
    const model = parsedOpenrouterModel(raw);
    if (model !== undefined) {
      models.push(model);
    }
  }
  models.sort(byLowercaseLabel);
  return models;
}

export function catalogRequest(key: string): Parameters<FetchJsonLike>[1] {
  return {
    headers: {
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://arcelle.app",
      "X-OpenRouter-Title": "Arcelle",
    },
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
  };
}

export async function responseJsonOrNull(response: HttpJsonResponseLike): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function openrouterErrorMessage(value: unknown, fallback: string): string {
  return jstr(jget(jget(value, "error"), "message")) ?? jstr(jget(value, "error")) ?? fallback;
}

export async function openrouterCatalogResponse(
  key: string,
  path: string,
  fetchJson: FetchJsonLike,
): Promise<HttpJsonResponseLike> {
  try {
    return await fetchJson(`${OPENROUTER_BASE_URL}${path}`, catalogRequest(key));
  } catch (error) {
    throw new Error(`Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkedCatalogValue(response: HttpJsonResponseLike): Promise<unknown> {
  const value = await responseJsonOrNull(response);
  if (response.ok) {
    return value;
  }
  if (response.status === 401) {
    noteKeyRejected(OPENROUTER_ID);
    throw new Error("OpenRouter rejected this API key.");
  }
  throw new Error(`OpenRouter error (${response.status}): ${openrouterErrorMessage(value, "OpenRouter rejected the request")}`);
}

/** `providers.rs::fetch_openrouter_catalog` — one authenticated catalogue
 * GET, parsed. `path` is appended verbatim. */
export async function fetchOpenrouterCatalog(
  key: string,
  path: string,
  fetchJson: FetchJsonLike,
): Promise<ExternalModelInfo[]> {
  const response = await openrouterCatalogResponse(key, path, fetchJson);
  return parseOpenrouterModels(await checkedCatalogValue(response));
}

export function rememberSelectableModels(models: ExternalModelInfo[]): void {
  selectableProviderModelIds.clear();
  for (const model of models) {
    selectableProviderModelIds.add(model.slug);
  }
}

export function mergeNewModels(models: ExternalModelInfo[], extra: ExternalModelInfo[], known: Set<string>): void {
  for (const model of extra) {
    if (!known.has(model.slug)) {
      known.add(model.slug);
      models.push(model);
    }
  }
}

export async function appendMediaCatalogs(models: ExternalModelInfo[], key: string, fetchJson: FetchJsonLike): Promise<void> {
  const known = new Set(models.map((model) => model.slug));
  for (const modality of MEDIA_MODALITIES) {
    try {
      const extra = await fetchOpenrouterCatalog(key, mediaCatalogPath(modality), fetchJson);
      mergeNewModels(models, extra, known);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`OpenRouter ${modality} catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function rememberModelFacts(models: ExternalModelInfo[]): void {
  providerModelDisplayLabels.clear();
  for (const model of models) {
    providerModelDisplayLabels.add(model.label);
    modelRuntimeCache.set(model.slug, {
      contextWindow: model.contextWindow,
      tools: model.tools,
      vision: model.vision,
      structuredOutputs: model.structuredOutputs,
      imageOutput: model.imageOutput,
      videoOutput: model.videoOutput,
    });
  }
}

/** `providers.rs::fetch_openrouter_models` — the user-scoped chat catalogue
 * (which doubles as the authenticated key check), then the two media
 * catalogues merged in by slug, sorted, and folded into the capability
 * cache. */
export async function fetchOpenrouterModels(key: string, fetchJson: FetchJsonLike): Promise<ExternalModelInfo[]> {
  // The user-scoped catalog respects the account's provider preferences,
  // privacy settings and guardrails. It is also an authenticated key check —
  // so a bad key fails HERE, before the supplementary calls below.
  const models = await fetchOpenrouterCatalog(key, "/models/user", fetchJson);
  clearKeyRejected(OPENROUTER_ID);
  rememberSelectableModels(models);
  await appendMediaCatalogs(models, key, fetchJson);
  // Each batch arrives sorted, but appending three of them does not stay
  // sorted — and the picker shows this list verbatim.
  models.sort(byLowercaseLabel);

  rememberModelFacts(models);
  catalogState.loaded = true;
  return models;
}

export type ModelProbeResult = { ok: boolean; detail: string | null };

export function selectedProbeId(slug: string): string | undefined {
  const exactId = slug.trim();
  return exactId === "" ? undefined : exactId;
}

export function readOpenrouterProbeKey(deps: ProviderDeps): string | undefined {
  try {
    return deps.readKey(OPENROUTER_ID);
  } catch {
    return undefined;
  }
}

export function openrouterProbeRequest(key: string, model: string): Parameters<FetchJsonLike>[1] {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://arcelle.app",
      "X-OpenRouter-Title": "Arcelle model validation",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 1,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
  };
}

export async function probeResult(response: HttpJsonResponseLike): Promise<ModelProbeResult> {
  const value = await responseJsonOrNull(response);
  if (response.ok) {
    clearKeyRejected(OPENROUTER_ID);
    return { ok: true, detail: null };
  }
  if (response.status === 401) {
    noteKeyRejected(OPENROUTER_ID);
  }
  return {
    ok: false,
    detail: `OpenRouter HTTP ${response.status}: ${openrouterErrorMessage(value, "the provider rejected this model")}`,
  };
}

/** Execute the selected OpenRouter ID once with a one-token response budget.
 *
 * A catalog row proves only that an account can see an ID. Provider routing,
 * account policy, or a stale catalog can still make the chat endpoint reject
 * it. The picker calls this only for the chosen row and caches success, so we
 * validate the exact wire ID without probing hundreds of models. */
export async function probeOpenrouterModelSelection(
  slug: string,
  deps: ProviderDeps = defaultProviderDeps,
): Promise<ModelProbeResult> {
  const exactId = selectedProbeId(slug);
  if (exactId === undefined) {
    return { ok: false, detail: "Choose a specific OpenRouter model first." };
  }
  const key = readOpenrouterProbeKey(deps);
  if (key === undefined) {
    return { ok: false, detail: "No OpenRouter API key is saved on this Mac." };
  }
  try {
    const response = await deps.fetchJson(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      openrouterProbeRequest(key, exactId),
    );
    return probeResult(response);
  } catch (error) {
    return {
      ok: false,
      detail: `Could not validate OpenRouter model “${exactId}”: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** `providers.rs::openrouter_key` — the stored OpenRouter key when one is
 * connected and non-blank, returned verbatim (untrimmed, as the Rust
 * `.filter()` only inspects the trimmed form).
 *
 * Exposed so the media-limits tables can be fetched with the same credential
 * the catalogue uses, without a second Keychain vocabulary growing up beside
 * this one. */
export function openrouterKey(deps: ProviderDeps = defaultProviderDeps): string | null {
  try {
    const key = deps.readKey(OPENROUTER_ID);
    return key.trim() === "" ? null : key;
  } catch {
    return null;
  }
}

/** `providers.rs::provider_connected`. */
export function providerConnected(provider: string, deps: ProviderDeps = defaultProviderDeps): boolean {
  if (keyRejected(provider)) return false;
  try {
    return deps.readKey(provider).trim() !== "";
  } catch {
    return false;
  }
}

/** `providers.rs::list_provider_models`. */
export async function listProviderModels(
  provider: string,
  deps: ProviderDeps = defaultProviderDeps,
): Promise<ExternalModelInfo[]> {
  providerSpec(provider);
  const key = deps.readKey(provider);
  // `providerSpec` above already refused every provider but OpenRouter; this
  // mirrors the Rust source's own `_ => unreachable!()` arm, so a second
  // provider added to `providerSpec` cannot silently route to OpenRouter's
  // fetcher.
  if (provider !== OPENROUTER_ID) throw new Error(`Unreachable: unknown provider ${provider}`);
  return fetchOpenrouterModels(key, deps.fetchJson);
}

/**
 * `providers.rs::ensure_provider_catalog` — make sure this process has the
 * provider catalog before a model's declared capabilities are read. Cheap and
 * silent: a no-op unless `model` is a provider model whose entry is missing,
 * and it gives up (leaving the unknown default) rather than failing a turn if
 * the catalog cannot be fetched.
 *
 * Fetched at most once per process on success, and at most once per
 * {@link CATALOG_RETRY_AFTER_MS} while it keeps failing — single-flighted, so
 * concurrent AI calls share one attempt instead of each firing its own.
 */
export async function ensureProviderCatalog(model: string, deps: ProviderDeps = defaultProviderDeps): Promise<void> {
  if (!isApiProviderModel(model) || catalogState.loaded) return;
  const selected = selectedSlug(model)?.trim();
  if (selected === undefined || selected === "") return;
  if (modelRuntimeCache.has(selected)) return;
  await withFetchLock(async () => {
    // The winner of the race may have just filled it.
    if (catalogState.loaded) return;
    const sinceLastAttempt = catalogState.attemptedAtMs === null ? null : Date.now() - catalogState.attemptedAtMs;
    if (!catalogRetryDue(sinceLastAttempt)) return;
    catalogState.attemptedAtMs = Date.now();
    try {
      // `fetchOpenrouterModels` sets `catalogLoaded` itself on success, so the
      // guard above short-circuits every later call for the process's lifetime.
      await listProviderModels(OPENROUTER_ID, deps);
    } catch {
      // `let _ = list_provider_models(…).await;` — deliberately swallowed.
    }
  });
}
