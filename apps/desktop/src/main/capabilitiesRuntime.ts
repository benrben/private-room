import { tierToolNames } from "./bridgeDispatcher.js";
import { externalMaxContext } from "./modelLimits.js";
import type { ModelRuntimeFacts } from "./providers.js";
import { bestDefault, isEmbeddingModel, splitExternalModel } from "./turnContext.js";
import { CLAUDE_CLI, CODEX_CLI, Capability, DECLARED, EngineCapabilities, EngineDecl, OLLAMA, OLLAMA_CLOUD, OPENROUTER, Support, Verdict, capabilityPhrase, capsFromDecl, capsSupports, declaredFor, imageReachesModel, servedByOllamaEngine, supportYes, tierName } from "./capabilities.js";



/**
 * The privacy door's own answer to "could this model see the picture?", separate
 * from {@link preflight} so a caller can tell "this engine is blind" from "your
 * setting removes the pixels" WITHOUT matching on prose. Ported verbatim from
 * `vision_door_block`.
 *
 * The door strips every image out of a request bound off this Mac and only
 * COUNTS what it blocked — it does not fail the call. So a capable cloud model
 * in a door-on room is handed a grounding prompt and no picture, answers with
 * nothing, and the viewer renders that empty answer as "The AI could not locate
 * that in this image": a false statement about the user's photograph, caused by
 * a switch three screens away. Naming the switch is the fix.
 */
export function visionDoorBlock(caps: EngineCapabilities): string | null {
  // Only a CONFIRMED yes earns this sentence. With the catalog unreadable the
  // record says `"unknown"`, and answering that with "it can look at images"
  // asserts a capability of an engine we could not reach — the one thing this
  // module exists to stop. `preflight` then falls through to the unknown arm,
  // which says what is actually true.
  if (caps.imageReaches || caps.vision !== "yes") {
    return null;
  }
  return (
    `${caps.label} can look at images, but this room's privacy door removes them from anything ` +
    "sent off this Mac — so it would be answering about a picture it never received. " +
    "Use a model that runs on this Mac, or turn the door off for this room."
  );
}


/**
 * PREFLIGHT: can this engine do what is about to be asked of it? Ported verbatim
 * from `preflight`. Pure — it reads a record and returns prose, so every test
 * drives it directly.
 *
 * The point of declaring capability is that this question is answerable BEFORE a
 * run, so the user gets one plain sentence instead of a stream that dies halfway
 * or — worse — an empty result rendered as a fact about their data.
 */
export function preflight(caps: EngineCapabilities, want: Capability): Verdict {
  // The door is checked first for vision because it is the more specific and
  // more actionable answer: "it can see, but your setting removes the pixels"
  // points at a switch the user owns, where "it cannot see" points nowhere.
  if (want === "vision") {
    const reason = visionDoorBlock(caps);
    if (reason !== null) {
      return { status: "blocked", code: "privacy-door", reason };
    }
  }
  switch (capsSupports(caps, want)) {
    case "yes":
      return { status: "ready" };
    case "no":
      return {
        status: "blocked",
        code: "capability",
        reason:
          `${caps.label} cannot ${capabilityPhrase(want)} — the room is set to ${caps.model}. ` +
          "Choose a different model in Settings → Model.",
      };
    case "unknown":
      return {
        status: "unknown",
        reason:
          `Could not confirm that ${caps.label} can ${capabilityPhrase(want)} — its capabilities ` +
          "were not readable (the AI engine may be unreachable).",
      };
  }
}


// ------------------------------------------------ capabilities_for seams

/** Everything {@link capabilitiesFor} needs beyond the pure declaration table —
 * see the module doc for why each is injected rather than ported. */
export interface CapabilitiesForDeps {
  /** `ollama::capabilities(model)` — the sidecar's per-model metadata call
   * (Ollama's `/api/show` underneath). EMPTY on any failure, matching the Rust
   * source's own contract: the collapse of "the sidecar is down" into "nothing
   * listed" is the Rust source's too, and `capabilitiesFor` turns an empty
   * answer into `"unknown"` rather than into `"no"`. */
  ollamaCapabilities(model: string): Promise<readonly string[]>;
  /** `ollama::native_context_length(model)` — `null` on any failure. */
  ollamaNativeContextLength(model: string): Promise<number | null>;
  /** `providers::ensure_provider_catalog(model)` — a no-op for a non-provider
   * model; fills the in-memory cache at most once per process. The cache is
   * filled only by a catalog fetch, so without this the first ask after every
   * launch had nothing to read. */
  ensureProviderCatalog(model: string): Promise<void>;
  /** `providers.ts`'s `providerModelFacts(model)` — `undefined` when the catalog
   * has no entry (unreached, or an unrecognised model). */
  providerModelFacts(model: string): ModelRuntimeFacts | undefined;
  /** `external::codex_context_window(submodel)` — `undefined` when Codex's own
   * catalog has nothing for this slug (or no submodel was given), mirroring the
   * Rust `Option<u32>`. Still a seam with no landed implementation:
   * `externalAdvisor.ts` ports the rest of `external.rs` but names this function
   * among the ones it does not. */
  codexContextWindow(submodel: string | undefined): Promise<number | undefined>;
  /** `privacy::active_policy().is_some()` — is this room's privacy door on? */
  privacyDoorActive(): boolean;
}
export function isOllamaEngine(engine: string): boolean {
  return engine === OLLAMA.id || engine === OLLAMA_CLOUD.id;
}
export function applyEmbeddingLimits(caps: EngineCapabilities): void {
  caps.chat = "no";
  caps.vision = "no";
  caps.toolCalling = "no";
}
export function applyOllamaModelFacts(
  caps: EngineCapabilities,
  decl: EngineDecl,
  listed: readonly string[],
): void {
  const has = (name: string): boolean => listed.includes(name);
  caps.vision = supportYes(has("vision"));
  caps.chat = supportYes(has("completion"));
  // Ollama's capability vocabulary has no term for producing an image — it
  // serves chat models, and a diffusion checkpoint is not reachable over
  // /api/chat at all. A listed model is therefore a definite no here.
  caps.imageGeneration = "no";
  caps.videoGeneration = "no";
  if (decl.toolCalling === "unknown") caps.toolCalling = supportYes(has("tools"));
}
export async function refineOllamaCapabilities(
  model: string,
  decl: EngineDecl,
  caps: EngineCapabilities,
  deps: CapabilitiesForDeps,
): Promise<EngineCapabilities> {
  if (isEmbeddingModel(model)) {
    applyEmbeddingLimits(caps);
    return caps;
  }
  const listed = await deps.ollamaCapabilities(model);
  if (listed.length > 0) applyOllamaModelFacts(caps, decl, listed);
  caps.contextWindow = await deps.ollamaNativeContextLength(model);
  return caps;
}
export function applyProviderModelFacts(caps: EngineCapabilities, facts: ModelRuntimeFacts): void {
  caps.contextWindow = facts.contextWindow;
  caps.toolCalling = supportYes(facts.tools);
  caps.vision = supportYes(facts.vision);
  caps.structuredOutput = supportYes(facts.structuredOutputs);
  caps.chat = "yes";
  caps.imageGeneration = supportYes(facts.imageOutput);
  caps.videoGeneration = supportYes(facts.videoOutput);
}
export async function refineOpenRouterCapabilities(
  model: string,
  caps: EngineCapabilities,
  deps: CapabilitiesForDeps,
): Promise<EngineCapabilities> {
  await deps.ensureProviderCatalog(model);
  const facts = deps.providerModelFacts(model);
  if (facts !== undefined) applyProviderModelFacts(caps, facts);
  return caps;
}
export async function refineCodexCapabilities(
  model: string,
  decl: EngineDecl,
  caps: EngineCapabilities,
  deps: CapabilitiesForDeps,
): Promise<EngineCapabilities> {
  const submodel = splitExternalModel(model)[1];
  caps.chat = "yes";
  caps.vision = "yes";
  caps.imageGeneration = "no";
  caps.videoGeneration = "no";
  caps.contextWindow = (await deps.codexContextWindow(submodel)) ?? externalMaxContext(decl.id);
  return caps;
}
export function refineClaudeCapabilities(decl: EngineDecl, caps: EngineCapabilities): EngineCapabilities {
  caps.chat = "yes";
  caps.vision = "yes";
  caps.imageGeneration = "no";
  caps.videoGeneration = "no";
  caps.contextWindow = externalMaxContext(decl.id);
  return caps;
}
export function refineDefaultCliCapabilities(decl: EngineDecl, caps: EngineCapabilities): EngineCapabilities {
  caps.chat = "yes";
  caps.contextWindow = externalMaxContext(decl.id);
  return caps;
}
export async function refineCapabilities(
  model: string,
  decl: EngineDecl,
  caps: EngineCapabilities,
  deps: CapabilitiesForDeps,
): Promise<EngineCapabilities> {
  if (isOllamaEngine(decl.id)) return refineOllamaCapabilities(model, decl, caps, deps);
  if (decl.id === OPENROUTER.id) return refineOpenRouterCapabilities(model, caps, deps);
  if (decl.id === CODEX_CLI.id) return refineCodexCapabilities(model, decl, caps, deps);
  if (decl.id === CLAUDE_CLI.id) return refineClaudeCapabilities(decl, caps);
  return refineDefaultCliCapabilities(decl, caps);
}


/**
 * The resolved record for a model — the declaration plus every live fact we can
 * get without loading the model. Ported verbatim from `capabilities_for`.
 *
 * Costs at most one metadata round trip per engine family, and never loads a
 * model into memory.
 */
export async function capabilitiesFor(model: string, deps: CapabilitiesForDeps): Promise<EngineCapabilities> {
  const decl = declaredFor(model);
  const caps = capsFromDecl(model, decl);
  caps.imageReaches = imageReachesModel(model, deps.privacyDoorActive);
  return refineCapabilities(model, decl, caps, deps);
}


/** Everything {@link visionSupport} needs — a strict subset of
 * {@link CapabilitiesForDeps}'s catalog seams, so a caller asking only about
 * vision does not have to wire the rest. */
export interface VisionSupportDeps {
  ollamaCapabilities(model: string): Promise<readonly string[]>;
  ensureProviderCatalog(model: string): Promise<void>;
  /** `providers.ts`'s `providerModelVision(model)` — `undefined` when the
   * catalog has no entry for it. (In Rust this is literally
   * `provider_model_facts(model).map(|f| f.vision)`; kept as its own seam so the
   * wiring to `providers.ts` stays 1:1 with the Rust call.) */
  providerModelVision(model: string): boolean | undefined;
}
export function declaredVisionSupport(model: string, decl: EngineDecl): Support | null {
  if (!decl.imageChannel || isEmbeddingModel(model)) return "no";
  if (decl.id === CLAUDE_CLI.id || decl.id === CODEX_CLI.id) return "yes";
  return null;
}
export async function providerVisionSupport(model: string, deps: VisionSupportDeps): Promise<Support> {
  await deps.ensureProviderCatalog(model);
  const vision = deps.providerModelVision(model);
  return vision === undefined ? "unknown" : supportYes(vision);
}
export async function ollamaVisionSupport(model: string, deps: VisionSupportDeps): Promise<Support> {
  const listed = await deps.ollamaCapabilities(model);
  if (listed.length === 0) return "unknown";
  return supportYes(listed.includes("vision"));
}


/**
 * Just the vision column of the record, without the context-window round trip
 * the full {@link capabilitiesFor} also makes. Ported verbatim from
 * `vision_support`.
 *
 * Split out because `grounding_pick` asks this of EVERY installed model in turn:
 * resolving a whole record per candidate would add one `/context_length` call
 * per model to a question that never reads the answer.
 */
export async function visionSupport(model: string, deps: VisionSupportDeps): Promise<Support> {
  const decl = declaredFor(model);
  const declared = declaredVisionSupport(model, decl);
  if (declared !== null) return declared;
  if (decl.id === OPENROUTER.id) return providerVisionSupport(model, deps);
  return ollamaVisionSupport(model, deps);
}


// ---------------------------------------------- the provider × agent matrix

/** One agent the sidecar's own registry knows about. Ported from `AgentRow`. */
export interface AgentRow {
  id: string;
  label: string;
}


/**
 * One provider's row in the published matrix. Ported from `ProviderRow`,
 * INCLUDING its `#[serde(flatten)] caps` — the capability fields sit directly on
 * the row, not under a nested `caps` key. That is not cosmetic: the renderer's
 * `src/apiTypes.ts` declares `ProviderRow extends EngineCapabilities` and
 * `src/settings/SupportMatrixSection.tsx` reads `p.engine`/`p.label`/`p.local`/
 * `p.streaming`/`p.toolCalling`/`p.vision`/`p.structuredOutput` off the row, so
 * nesting them would silently blank every column of the published matrix.
 */
export interface ProviderRow extends EngineCapabilities {
  /** Is this engine usable on THIS Mac right now (installed / connected)? A row
   * is shown either way — the matrix is a reference, not a menu — but an
   * unavailable provider must not read as one the user could pick. */
  available: boolean;
  /** Agent ids this provider's tier can actually reach, derived from the
   * sidecar's own registry. Empty here means "the sidecar did not answer", which
   * `agentsKnown` distinguishes from "reaches nothing". */
  agents: string[];
}


/** The published provider × agent matrix (owner decision #3). Ported from
 * `SupportMatrix`. */
export interface SupportMatrix {
  /** Every agent, id + label, straight from the sidecar registry. */
  agents: AgentRow[];
  providers: ProviderRow[];
  /** False when the sidecar could not be reached, or answered in a shape this
   * version cannot read: the capability half of the matrix is still true (it is
   * declared here), the agent half is simply not known, and the UI says so
   * rather than drawing an empty grid that reads as "no agent works anywhere". A
   * sidecar that answered with no agents at all is KNOWN — that is a real
   * answer, and `agentsError` says why when it is not. */
  agentsKnown: boolean;
  /** Why the agent half is missing, when it is. */
  agentsError: string | null;
}
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function decodeAgentRow(v: unknown): AgentRow | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.label !== "string") {
    return null;
  }
  return { id: v.id, label: v.label };
}


/**
 * The agent list out of a `/agent_support` answer, and — when the answer carried
 * a shape this version cannot read — the sentence that says so. Ported verbatim
 * from `agent_rows`.
 *
 * Decoding into an empty array loses the distinction the matrix rests on: a
 * sidecar that answered `{"agents": {…}}` is REACHABLE, and telling the user it
 * could not be reached sends them looking at the network for a bug in here.
 */
export function agentRows(answer: unknown): readonly [AgentRow[], string | null] {
  const raw = isRecord(answer) ? answer.agents : undefined;
  if (!Array.isArray(raw)) {
    return [[], "The AI engine answered in a shape this version does not understand (no agent list)."];
  }
  const rows: AgentRow[] = [];
  for (const item of raw) {
    const row = decodeAgentRow(item);
    if (row === null) {
      return [[], "The AI engine answered in a shape this version does not understand (a malformed agent entry)."];
    }
    rows.push(row);
  }
  return [rows, null];
}
export

/** `serde_json::from_value::<HashMap<String, Vec<String>>>(v["tiers"])
 * .unwrap_or_default()` — a WHOLE-MAP decode: one malformed value defaults the
 * ENTIRE map, it does not drop just that key. */
function decodePerTier(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
      return {};
    }
    out[key] = value as string[];
  }
  return out;
}


/**
 * Is this engine usable on this Mac right now? Ported verbatim from
 * `engine_available` — read from real state only (installed Ollama models,
 * detected CLIs, a saved provider key) so the matrix never claims an engine is
 * ready when it is not.
 *
 * `providerConnected` (`providers::provider_connected`, a Keychain read) is a
 * REQUIRED parameter rather than a defaulted one: an omitted default of `false`
 * would quietly publish "OpenRouter is not set up on this Mac" to a user who has
 * connected it.
 */
export function engineAvailable(
  id: string,
  installed: readonly string[],
  detected: readonly string[],
  providerConnected: (provider: string) => boolean
): boolean {
  switch (id) {
    // Which ENGINE the tag belongs to — not where the transport points.
    // `runsOnThisMac` would call the whole Ollama row unavailable the moment the
    // room used a remote Ollama, which is when it is most in use.
    case "ollama":
      return installed.some((m) => servedByOllamaEngine(m));
    case "ollama-cloud":
      return installed.some((m) => !servedByOllamaEngine(m));
    case "openrouter":
      return providerConnected("openrouter");
    default:
      return detected.some((d) => d === id);
  }
}


/** What {@link engineSupportMatrix} needs from modules out of scope here. */
export interface EngineSupportMatrixDeps {
  /** `ollama::list_models()`. The Rust reads this as `.unwrap_or_default()`, so
   * a rejection here is treated as "no models installed", never as a failure of
   * the whole matrix. */
  listModels(): Promise<string[]>;
  /** `commands/agent.rs::detected_advisors(&state)` — the cached/probed
   * cloud-CLI detection. */
  detectedAdvisors(): Promise<string[]>;
  /** `providers::provider_connected`. */
  providerConnected(provider: string): boolean;
  /** `sidecar::sidecar_json("/agent_support", &body)`. Rejects on failure,
   * mirroring the Rust `Err` arm — the message becomes `agentsError`. */
  fetchAgentSupport(body: { tiers: Record<string, string[]>; web_enabled: boolean }): Promise<unknown>;
}


/**
 * Publish the matrix (owner decision #3: "surface it, do not hand-maintain it").
 * Ported verbatim from `engine_support_matrix`.
 *
 * DERIVED end to end, which is the whole requirement. The capability columns
 * come from {@link DECLARED}. The agent columns come from asking the sidecar
 * which workers its own registry considers reachable given the tool names each
 * tier actually serves ({@link tierToolNames}) — so adding an agent, changing a
 * tier's tool list, or changing an engine's declaration all move this table with
 * no second copy to update.
 *
 * `web_enabled` is `true` on both halves, exactly as the Rust hardcodes it: the
 * matrix is a reference showing what each tier COULD serve, not this room's
 * current toggle, and asking for the tool names under one flag while telling the
 * sidecar another would publish a table of a configuration that does not exist.
 */
export async function engineSupportMatrix(deps: EngineSupportMatrixDeps): Promise<SupportMatrix> {
  const installed = await deps.listModels().catch(() => [] as string[]);
  const detected = await deps.detectedAdvisors();

  // One request carrying every distinct tier, so the sidecar is asked once.
  const tiers: Record<string, string[]> = {};
  for (const decl of DECLARED) {
    const key = tierName(decl.tier);
    if (!(key in tiers)) {
      tiers[key] = tierToolNames(true, decl.tier);
    }
  }

  // `agentsKnown` is "did the sidecar answer", NOT "did it name any agent". Read
  // off the length of the list, an answer of `[]` — or one this version could
  // not decode — was reported as "the sidecar could not be reached", with no
  // reason beside it: a shape bug presented as a network problem.
  let agents: AgentRow[] = [];
  let perTier: Record<string, string[]> = {};
  let agentsKnown = false;
  let agentsError: string | null = null;
  try {
    const answer = await deps.fetchAgentSupport({ tiers, web_enabled: true });
    perTier = decodePerTier(isRecord(answer) ? answer.tiers : undefined);
    const [rows, decodeError] = agentRows(answer);
    agents = rows;
    agentsKnown = decodeError === null;
    agentsError = decodeError;
  } catch (e) {
    // The error's own message, not a sentinel token: this string is shown next
    // to a half-drawn table, so it has to read as "why the agent columns are
    // missing", not as an `OLLAMA_DOWN` token the matrix UI has no reason to
    // know how to translate.
    agents = [];
    perTier = {};
    agentsKnown = false;
    agentsError = e instanceof Error ? e.message : String(e);
  }

  const providers: ProviderRow[] = DECLARED.map((decl) => ({
    // Flattened, matching the Rust `#[serde(flatten)]` and the renderer's
    // `ProviderRow extends EngineCapabilities`.
    ...capsFromDecl("", decl),
    available: engineAvailable(decl.id, installed, detected, deps.providerConnected),
    agents: perTier[tierName(decl.tier)] ?? [],
  }));

  return { agents, providers, agentsKnown, agentsError };
}


// -------------------------------------------------------- the two IPC commands

/**
 * What {@link enginePreflight}/{@link engineCapabilities} need on top of
 * {@link CapabilitiesForDeps}: `ollama::list_models()`, read as
 * `.unwrap_or_default()` in Rust and so caught here.
 */
export interface EngineQueryDeps extends CapabilitiesForDeps {
  listModels(): Promise<string[]>;
}
export

/**
 * The room's engine: its explicit `model` setting when it has one, else
 * `best_default` over the installed list. `explicitModel` is
 * `model_setting(&room.conn)` — a DB read under the room lock, which the Rust
 * takes in a block BEFORE any await, so the caller resolves it and passes it in
 * (`null` when the room has no explicit setting).
 *
 * One deliberate difference from the Rust, with no observable effect: Rust calls
 * `list_models()` unconditionally and only then discards the result if an
 * explicit model was set. Here the list is fetched only when it will be read,
 * saving a sidecar round trip per preflight on every room that has picked a
 * model.
 */
async function resolveRoomModel(explicitModel: string | null, deps: EngineQueryDeps): Promise<string> {
  if (explicitModel !== null) {
    return explicitModel;
  }
  return bestDefault(await deps.listModels().catch(() => [] as string[]));
}


/** PREFLIGHT for the OPEN room's engine, so any surface can ask before it starts
 * a run instead of failing mid-stream. Ported from `engine_preflight`. */
export async function enginePreflight(
  explicitModel: string | null,
  capability: Capability,
  deps: EngineQueryDeps
): Promise<Verdict> {
  const model = await resolveRoomModel(explicitModel, deps);
  return preflight(await capabilitiesFor(model, deps), capability);
}


/** The OPEN room's resolved capability record — one call, so no surface has to
 * re-derive what its engine can do. Ported from `engine_capabilities`. */
export async function engineCapabilities(
  explicitModel: string | null,
  deps: EngineQueryDeps
): Promise<EngineCapabilities> {
  return capabilitiesFor(await resolveRoomModel(explicitModel, deps), deps);
}
