/**
 * ONE declared capability record per engine/provider — the single place the app
 * answers "what can this AI actually do?". Ported from
 * `src-tauri/src/commands/capabilities.rs` (1019 lines).
 *
 * Two layers, because only two layers are honest:
 *
 * - {@link EngineDecl} — what is true of the TRANSPORT, whatever model rides
 *   it. A cloud CLI is a one-shot subprocess: it cannot stream and there is no
 *   channel to hand it pixels, no matter how multimodal the model behind it is.
 *   That is a property of how we talk to it, so it is DECLARED here.
 * - {@link EngineCapabilities} — that declaration refined by what the live
 *   catalog says about the SPECIFIC model (Ollama's `/api/show`, the OpenRouter
 *   catalog, Codex's own `codex debug models`). Whether a given Ollama build can
 *   see or emit tool calls is not knowable from its name and never was.
 *
 * {@link Support}'s `"unknown"` arm is the reason this module can be trusted: an
 * engine we could not reach must not be reported as capable OR as incapable.
 * {@link preflight} refuses only on a declared/observed `"no"`; `"unknown"` is
 * passed through as a caveat, never as a verdict.
 *
 * THIS MODULE DECIDES SECURITY-RELEVANT BEHAVIOUR: which tools a model is
 * trusted with, whether content is claimed to stay on this Mac, and whether the
 * privacy door's image-stripping is reported honestly. The Rust source names two
 * real incidents the record exists to end — `gpt-oss:120b-cloud` (the
 * `<size>-cloud` spelling an exact `:cloud` suffix test misses) being told it
 * "runs on this Mac" while the document was already on its way to ollama.com,
 * and a door-blinded vision call returning `[]` that the viewer then reported as
 * a fact about the user's photograph.
 *
 * REUSED, not re-declared — these landed unsuffixed and committed, so this file
 * imports them rather than growing a second copy:
 *   - {@link ToolScope} (`mcpBridge.ts`) and `tierToolNames`
 *     (`bridgeDispatcher.ts`) — `room_mcp.rs`'s port.
 *   - `resolvedBaseUrl` (`engineRouting.ts`) — `ollama::resolved_base_url`.
 *   - `splitExternalModel`/`isEmbeddingModel`/`bestDefault` (`turnContext.ts`) —
 *     `external.rs`/`models.rs`'s already-ported pure helpers.
 *   - `baseIsLocal` (`ollamaLifecycle.ts`) — `ollama_lifecycle::base_is_local`.
 *     Duplicating the host-parsing rules that decide "did this leave the Mac" is
 *     exactly the drift this module exists to prevent, so it is imported, never
 *     copied; that port also hardens the Rust's `starts_with("127.")` prefix
 *     test, which this module's locality answers inherit.
 *   - `externalMaxContext` (`modelLimits.ts`) — `model_limits::external_max_context`.
 *     Read directly rather than injected: it is pure, synchronous, and two
 *     constants, so a seam would only create somewhere for the real numbers to
 *     drift away from.
 *   - {@link ModelRuntimeFacts} (`providers.ts`) — `providers::ModelRuntimeFacts`,
 *     re-exported here for callers rather than re-declared, so the six fields
 *     `capabilitiesFor` reads cannot fall out of step with the catalog that
 *     fills them.
 *
 * DUPLICATED, deliberately and in one line each, because the owning Rust module
 * has no unsuffixed TS port yet and the predicate is too small to inject:
 *   - {@link isCloudModel} (`external.rs`) — the exact `:cloud` suffix test.
 *   - {@link primaryCliScope} (`agent.rs:1253`) — a `const fn` returning one
 *     enum arm, which `capabilities.rs` names directly.
 *   - {@link runsOnThisMac} (`agent.rs:5066`) — ported here for real rather than
 *     left as an injected stub the way its CONSUMERS (`turnContext.ts`,
 *     `turnEngine.ts`, `privacy_a.ts`) currently carry it, because its own Rust
 *     doc says the rule "now lives in the engine capability record", i.e. in
 *     this exact module. Those call sites can be rewired to this in a later
 *     batch; the real implementation now exists to wire in.
 *
 * INJECTED as documented seams, one field per Rust call. Every one of these is
 * impure — a network fetch, a Keychain read, a subprocess, or room state — and
 * that is the whole reason it is a seam: this module's answers decide whether
 * content leaves the Mac, so they have to be provable without one. Each seam's
 * doc names the exact function it stands in for, including the ones whose real
 * TS port has now landed (`providers.ts`'s `ensureProviderCatalog`/
 * `providerModelFacts`/`providerModelVision`/`providerConnected`), so wiring is
 * a 1:1 lookup: Ollama's per-model `/api/show` and `/context_length`
 * (`ollama.rs::capabilities`/`native_context_length`, no TS port yet), the
 * OpenRouter catalog, Codex's own catalog (`external.rs::codex_context_window`
 * — `externalAdvisor.ts` landed but explicitly does NOT port this function), the
 * room's privacy-door state (`privacy.rs::active_policy().is_some()`, reduced to
 * the one boolean this file needs), the detected-CLI cache
 * (`agent.rs::detected_advisors`), the installed model list
 * (`ollama::list_models`), and the sidecar's `/agent_support` POST
 * (`sidecar::sidecar_json` — a generic inject-policy-then-POST helper with no
 * committed TS equivalent; every batch that needed one call site of it injected
 * the ONE POST it needed, and this file does the same).
 */

import type { ToolScope } from "./mcpBridge.js";
import { tierToolNames } from "./bridgeDispatcher.js";
import { baseIsLocal } from "./ollamaLifecycle.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { externalMaxContext } from "./modelLimits.js";
import type { ModelRuntimeFacts } from "./providers.js";
import { bestDefault, isEmbeddingModel, splitExternalModel } from "./turnContext.js";

export type { ModelRuntimeFacts };

// ------------------------------------------------------------------ Support

/**
 * What one capability question can honestly be answered with. Ported from
 * `Support` (`#[serde(rename_all = "lowercase")]` — the three arms are exactly
 * `"yes"`/`"no"`/`"unknown"` on the wire, so a plain string-literal union
 * carries the same JSON shape with no encode step).
 *
 * The third arm is the load-bearing one. "The sidecar is down so `/api/show`
 * returned nothing" and "this model reports no vision capability" are different
 * facts, and collapsing them into `"no"` is how a broken engine used to read as
 * a deliberate product limit.
 */
export type Support = "yes" | "no" | "unknown";

/** Ported from `Support::yes`. */
export function supportYes(value: boolean): Support {
  return value ? "yes" : "no";
}

/** True only for a definite yes. Ported from `Support::is_yes` — the honest
 * collapse of "unknown" for a *permission* question is "not proven". */
export function isYes(support: Support): boolean {
  return support === "yes";
}

// --------------------------------------------------------------- Capability

/**
 * The capability questions anything in the app is allowed to ask. Ported from
 * `Capability` (`#[serde(rename_all = "snake_case")]`). A closed union on
 * purpose: a new question has to be added here, to {@link DECLARED}, and to
 * {@link capsSupports} together, so a caller cannot invent a capability nothing
 * declares an answer for.
 */
export type Capability =
  | "streaming"
  | "tool_calling"
  | "vision"
  | "structured_output"
  | "chat"
  | "image_generation"
  | "video_generation";

/**
 * A capability nobody declares an answer for is an ERROR, not a pass.
 *
 * Rust gets this for free: `engine_preflight` takes the `Capability` ENUM, so
 * serde refuses an unrecognised string at the command boundary and the renderer
 * is handed an error before the body runs. A TS string union is erased at
 * runtime, and an exhaustive `switch` with no `default` falls off the end and
 * yields `undefined` — so the pre-run gate returned a non-{@link Verdict} and a
 * caller written defensively (`verdict?.status === "blocked"`) read that as "not
 * blocked" and ran. THE FAILURE DIRECTION OF A GATE HAS TO BE A REFUSAL.
 *
 * Thrown rather than answered with a `"blocked"` verdict on purpose: a `Verdict`
 * is prose to show the user about a real capability, and there is nothing honest
 * to say about one that does not exist. `ipcMain.handle` turns this into a
 * rejected `invoke()`, which is exactly what serde's rejection produced.
 */
function unknownCapability(capability: never): never {
  throw new Error(`Unknown capability: ${String(capability)}`);
}

const CAPABILITY_PHRASES: ReadonlyMap<Capability, string> = new Map([
  ["streaming", "show its answer as it is written"],
  ["tool_calling", "use tools (open files, search, run jobs)"],
  ["vision", "look at an image"],
  ["structured_output", "return a strictly-shaped result"],
  ["chat", "hold a conversation"],
  ["image_generation", "make a picture"],
  ["video_generation", "make a video"],
]);

/**
 * Plain words for the thing the user was trying to do, used in preflight
 * messages. Ported verbatim from `Capability::phrase` — kept beside the union so
 * a new capability cannot ship without a sentence a person can read.
 */
export function capabilityPhrase(capability: Capability): string {
  const phrase = CAPABILITY_PHRASES.get(capability);
  return phrase ?? unknownCapability(capability as never);
}

// -------------------------------------------------------------- external.rs

/** An Ollama `:cloud` tag (e.g. `minimax-m3:cloud`) is relayed off this Mac.
 * Ported verbatim from `commands/external.rs::is_cloud_model` — the EXACT
 * suffix test, which is why {@link engineIdOf} needs a second rule beside it. */
export function isCloudModel(model: string): boolean {
  return model.endsWith(":cloud");
}

// --------------------------------------------------------------- EngineDecl

/**
 * What is true of an ENGINE's transport, whatever model rides it. Ported from
 * `EngineDecl`. Every `"unknown"` below means "this varies per model — ask the
 * catalog", and {@link capabilitiesFor} is the only thing allowed to resolve it.
 */
export interface EngineDecl {
  /** Stable id, also the key the UI matrix is grouped by. */
  readonly id: string;
  readonly label: string;
  /** Runs ON THIS MAC — nothing leaves the device. */
  readonly local: boolean;
  readonly streaming: Support;
  /** Is there a channel to hand this engine PIXELS at all? Distinct from
   * whether the model can see: Antigravity's print mode takes no images, so it
   * is blind to us even when the model behind it is not. (Claude and Codex
   * gained real channels 2026-08-27 — stream-json blocks and `-i` files.) */
  readonly imageChannel: boolean;
  readonly toolCalling: Support;
  readonly structuredOutput: Support;
  /** The bridge tier this engine is served at (`room_mcp::ToolScope`), i.e.
   * which tools it may ever be offered. Declared here so the provider × agent
   * matrix and the bridge's own scope lookup read the same field. */
  readonly tier: ToolScope;
}

/**
 * The bridge tier for a cloud CLI (or OpenRouter) selected as the ROOM'S OWN
 * engine. Ported verbatim from `commands::agent::primary_cli_scope`
 * (`agent.rs:1253`) — a `const fn` there, a plain function here. Owner decision
 * 2026-07-25 ("claude and codex should be able to do the same as local"): before
 * it, this returned the lesser consulted-advisor tier, so a cloud-CLI room lost
 * the job/workflow/script/studio/transcription tools entirely.
 */
export function primaryCliScope(): ToolScope {
  return { kind: "CloudEngine" };
}

/** A local Ollama build. The most capable tier and the only one whose pixels
 * never leave; what it can *do* is entirely per-model, so almost everything here
 * is answered by `/api/show`. */
export const OLLAMA: EngineDecl = {
  id: "ollama",
  label: "Ollama (this Mac)",
  local: true,
  streaming: "yes",
  imageChannel: true,
  toolCalling: "unknown",
  structuredOutput: "yes",
  tier: { kind: "LocalEngine" },
};

/** An Ollama tag relayed to ollama.com (`name:cloud`, and the `<size>-cloud`
 * spelling {@link engineIdOf} also catches). Two hard limits, both observed live
 * and both previously encoded as a `:cloud` string test scattered across the
 * codebase: it leaks tool calls inline as `<tool_call>…` text the stream parser
 * never sees, and it ignores the `format` grammar. */
export const OLLAMA_CLOUD: EngineDecl = {
  id: "ollama-cloud",
  label: "Ollama cloud relay",
  local: false,
  streaming: "yes",
  imageChannel: true,
  toolCalling: "no",
  structuredOutput: "no",
  tier: primaryCliScope(),
};

/** Claude Code as the room's engine. A `claude -p` subprocess in its streamed
 * NDJSON envelope: `--include-partial-messages` carries live text deltas the
 * sidecar forwards as they arrive (2026-08-27), and images ride
 * `--input-format stream-json` as base64 content blocks — the pixel channel a
 * tool-less CLI has (live-verified: a staged red PNG answered "Red"). Its
 * structured replies are still recovered rather than constrained. It DOES call
 * tools — through the room's MCP bridge, which is why it is a `CloudEngine`
 * and not an advisor. */
export const CLAUDE_CLI: EngineDecl = {
  id: "claude-cli",
  label: "Claude Code",
  local: false,
  streaming: "yes",
  imageChannel: true,
  toolCalling: "yes",
  structuredOutput: "no",
  tier: primaryCliScope(),
};

/** Codex as the room's engine. Its exec stream has no token deltas, but each
 * completed agent message is forwarded live as one delta (message-granular
 * streaming), and images ride staged temp files via `-i` — verified live under
 * the exact sandbox flags the chat path pins. */
export const CODEX_CLI: EngineDecl = {
  id: "codex-cli",
  label: "Codex",
  local: false,
  streaming: "yes",
  imageChannel: true,
  toolCalling: "yes",
  structuredOutput: "no",
  tier: primaryCliScope(),
};

/** Antigravity CLI as the room's engine. Its headless stream-json output carries
 * `text_delta` events the sidecar forwards live, but its print mode documents
 * no image input — so it streams, and stays the one blind engine (its turns
 * carry the honest "images were NOT sent" note instead). */
export const ANTIGRAVITY_CLI: EngineDecl = {
  id: "antigravity-cli",
  label: "Antigravity CLI",
  local: false,
  streaming: "yes",
  imageChannel: false,
  toolCalling: "yes",
  structuredOutput: "no",
  tier: primaryCliScope(),
};

/** An API provider (OpenRouter today). A real HTTP chat API: it streams, it
 * takes images, and tools/vision/structured output are per-model facts the live
 * catalog already carries — the same catalog the model picker fetches. */
export const OPENROUTER: EngineDecl = {
  id: "openrouter",
  label: "OpenRouter",
  local: false,
  streaming: "yes",
  imageChannel: true,
  toolCalling: "unknown",
  structuredOutput: "unknown",
  tier: primaryCliScope(),
};

/** Every engine the app can be pointed at, in the order the matrix shows them.
 * Ported verbatim from `DECLARED`. */
export const DECLARED: readonly EngineDecl[] = [OLLAMA, OLLAMA_CLOUD, CLAUDE_CLI, CODEX_CLI, ANTIGRAVITY_CLI, OPENROUTER];

const EXTERNAL_ENGINE_IDS: ReadonlyMap<string, string> = new Map([
  ["claude-cli", CLAUDE_CLI.id],
  ["codex-cli", CODEX_CLI.id],
  ["antigravity-cli", ANTIGRAVITY_CLI.id],
  ["openrouter", OPENROUTER.id],
]);

// -------------------------------------------------------- engine resolution

/**
 * Which engine a model selection belongs to. Ported verbatim from
 * `engine_id_of` — this is where the Ollama local/relayed split is DEFINED
 * ({@link runsOnThisMac} is a thin read of the record it produces).
 *
 * Strict on purpose: Ollama tags its hosted entries BOTH ways —
 * `minimax-m3:cloud` and the `<size>-cloud` form `gpt-oss:120b-cloud` — and an
 * exact `:cloud` suffix test misses the second. The pair of name tests that used
 * to stand in for this question at a dozen call sites
 * (`isCloudModel(m) || isExternalEngine(m)`) missed it too, so
 * `gpt-oss:120b-cloud` was told it ran on this Mac. The cost of a false
 * exclusion is one unnecessary "Cloud" label; the cost of a false inclusion is
 * the user's content leaving the machine under a promise that it would not.
 */
export function engineIdOf(model: string): string {
  const engine = splitExternalModel(model)[0];
  const external = EXTERNAL_ENGINE_IDS.get(engine);
  if (external !== undefined) return external;
  return ollamaEngineId(model);
}

function ollamaEngineId(model: string): string {
  // BOTH spellings, which is the whole point.
  const cloud = isCloudModel(model) || lastColonPart(model).endsWith("-cloud");
  return cloud ? OLLAMA_CLOUD.id : OLLAMA.id;
}

/** Rust's `model.rsplit(':').next()`: the part AFTER the LAST `:`, or the whole
 * string when `:` does not occur. */
function lastColonPart(model: string): string {
  const idx = model.lastIndexOf(":");
  return idx === -1 ? model : model.slice(idx + 1);
}

/**
 * The declared record for a model selection. Pure and synchronous — no engine is
 * contacted — so every caller that only needs transport facts (streaming,
 * locality, tier) stays cheap and unit-testable. Ported verbatim from
 * `declared_for`, including the fallback to {@link OLLAMA} rather than a throw:
 * unreachable by construction ({@link engineIdOf} only ever returns an id from
 * {@link DECLARED}), kept so a future engine id cannot take the app down.
 */
export function declaredFor(model: string): EngineDecl {
  const id = engineIdOf(model);
  return DECLARED.find((d) => d.id === id) ?? OLLAMA;
}

/**
 * Is the Ollama transport ACTUALLY this Mac right now? Ported verbatim from
 * `ollama_runs_here`.
 *
 * {@link engineIdOf} answers "which engine", from the model NAME. That was taken
 * to also answer "does this content leave the machine", and it does not: the
 * Closet field (a runtime base-URL override) points the same `qwen3.5:4b` at
 * another computer, and every locality decision in the app — the privacy door's
 * policy injection, whether pixels are held back, the trust badge, the vision
 * pick, the job lanes — read the name and said "local". So a room relaying to a
 * LAN box sent whole documents, transcripts and screenshots there in the clear,
 * under a chip that read "Local only — nothing leaves the device".
 *
 * Only the Ollama engines ride this transport; the rest are already declared
 * non-local, so callers can apply this unconditionally.
 */
export function ollamaRunsHere(): boolean {
  return baseIsLocal(resolvedBaseUrl());
}

/**
 * Is this tag served by the ORDINARY Ollama engine (as opposed to a relayed
 * `*-cloud` tag or an external CLI/provider)? A question about the MODEL only.
 * Ported verbatim from `served_by_ollama_engine`.
 *
 * The distinction from {@link runsOnThisMac} matters: that one also asks where
 * the transport points, which is right for "does content leave the device" and
 * WRONG for "which list entry do we pick". Filtering a model list by the privacy
 * question would, with the Closet set, reject every installed tag and leave the
 * app with no model to name.
 */
export function servedByOllamaEngine(model: string): boolean {
  return declaredFor(model).local;
}

/**
 * Will content for `model` stay on this machine? Ported verbatim from
 * `commands/agent.rs::runs_on_this_mac` (`:5066`) — the record answers for the
 * MODEL, {@link ollamaRunsHere} answers for the TRANSPORT, and both must say yes.
 */
export function runsOnThisMac(model: string): boolean {
  return declaredFor(model).local && ollamaRunsHere();
}

/**
 * Would PIXELS for `model` actually reach it, once the privacy door's stripping
 * is accounted for? Ported verbatim from `commands/models.rs::image_reaches_model`
 * (`!(!runs_on_this_mac(model) && active_policy().is_some())`), with
 * `active_policy().is_some()` reduced to the injected `privacyDoorActive`
 * predicate — privacy.rs is a concurrent batch's territory, and this is the one
 * boolean of it this file needs.
 */
export function imageReachesModel(model: string, privacyDoorActive: () => boolean): boolean {
  return !(!runsOnThisMac(model) && privacyDoorActive());
}

// ------------------------------------------------------- EngineCapabilities

/**
 * One resolved capability record: the declaration refined by whatever the live
 * catalog knows about this specific model. Ported from `EngineCapabilities`
 * (`#[serde(rename_all = "camelCase")]`), field-for-field — this shape crosses
 * IPC to the renderer, which declares the same interface in `src/apiTypes.ts`.
 */
export interface EngineCapabilities {
  engine: string;
  label: string;
  /** The full selection string this record was resolved for. */
  model: string;
  local: boolean;
  streaming: Support;
  toolCalling: Support;
  vision: Support;
  structuredOutput: Support;
  chat: Support;
  /** Can it PRODUCE a picture / a clip. Only ever `"yes"` because a live catalog
   * said so — `"unknown"` on every engine that publishes no modality list, which
   * the Create page treats as "do not offer this", since an offered model that
   * turns out not to draw fails after the user has already paid for the call. */
  imageGeneration: Support;
  videoGeneration: Support;
  /** Real max context, when the engine publishes one. `null` is "we do not
   * know", never a made-up default — the token-budget bar reads this. */
  contextWindow: number | null;
  /** The `ToolScope` tier, as a stable string for the UI. */
  tier: string;
  /** Would PIXELS actually arrive? Capability is not the whole question: the
   * room's privacy door strips images out of every non-local request and only
   * COUNTS them. Kept separate from `vision` so the two facts stay
   * distinguishable — "it cannot see" and "your privacy setting blinds it" need
   * different sentences. */
  imageReaches: boolean;
}

/** Ported verbatim from `tier_name`. */
export function tierName(scope: ToolScope): string {
  switch (scope.kind) {
    case "LocalEngine":
      return "local-engine";
    case "CloudEngine":
      return "cloud-engine";
    case "ExternalAgent":
      return "external-agent";
    case "CloudAdvisor":
      return "cloud-advisor";
  }
}

/**
 * The declaration alone, before any catalog lookup. Ported verbatim from
 * `EngineCapabilities::from_decl` — this is what a PROVIDER-level row shows:
 * everything per-model reads `"unknown"`, which is the truth for a provider
 * serving hundreds of different models.
 */
export function capsFromDecl(model: string, decl: EngineDecl): EngineCapabilities {
  // The declaration is about the ENGINE; locality is also about the transport,
  // which the Closet override can move off this Mac (see `ollamaRunsHere`). The
  // UI matrix reads this field, so without the second half it labelled a relayed
  // room "runs on this Mac".
  const local = decl.local && ollamaRunsHere();
  return {
    engine: decl.id,
    label: decl.label,
    model,
    local,
    streaming: decl.streaming,
    toolCalling: decl.toolCalling,
    // Two independent reasons a model may not see, and only one of them is
    // per-model: no image channel is a flat "no" from the transport.
    vision: decl.imageChannel ? "unknown" : "no",
    structuredOutput: decl.structuredOutput,
    chat: "unknown",
    // Same shape as `vision`.
    imageGeneration: decl.imageChannel ? "unknown" : "no",
    videoGeneration: decl.imageChannel ? "unknown" : "no",
    contextWindow: null,
    tier: tierName(decl.tier),
    imageReaches: local,
  };
}

type CapabilitySupportField =
  | "streaming"
  | "toolCalling"
  | "vision"
  | "structuredOutput"
  | "chat"
  | "imageGeneration"
  | "videoGeneration";

const CAPABILITY_SUPPORT_FIELDS: ReadonlyMap<Capability, CapabilitySupportField> = new Map([
  ["streaming", "streaming"],
  ["tool_calling", "toolCalling"],
  ["vision", "vision"],
  ["structured_output", "structuredOutput"],
  ["chat", "chat"],
  ["image_generation", "imageGeneration"],
  ["video_generation", "videoGeneration"],
]);

/** Ported verbatim from `EngineCapabilities::supports`. */
export function capsSupports(caps: EngineCapabilities, want: Capability): Support {
  const field = CAPABILITY_SUPPORT_FIELDS.get(want);
  if (field === undefined) return unknownCapability(want as never);
  return caps[field];
}

// -------------------------------------------------------------------- Verdict

/** Why a preflight blocked, as a value rather than a sentence. Ported from
 * `BlockCode` (`#[serde(rename_all = "kebab-case")]`).
 *   - `"capability"` — the engine itself cannot do this. Changing a SETTING will
 *     not help; a different model (or, for vision, installing one) will.
 *   - `"privacy-door"` — the engine can, but this room's privacy door removes
 *     what it would need. The fix is a switch the user owns, so it must not be
 *     answered with an offer to download anything. */
export type BlockCode = "capability" | "privacy-door";

/**
 * What a preflight check concluded, in a shape the UI can render verbatim.
 * Ported from `Verdict` (`#[serde(tag = "status", rename_all = "lowercase")]`).
 *
 * Three states, not two, for the same reason {@link Support} has three: an
 * engine we could not reach is not a refusal. `"blocked"` is the only state a
 * caller may turn into a failure, and it always carries the sentence to show.
 */
export type Verdict =
  | { readonly status: "ready" }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "blocked"; readonly code: BlockCode; readonly reason: string };
export { visionDoorBlock, preflight, capabilitiesFor, visionSupport, agentRows, engineAvailable, engineSupportMatrix, enginePreflight, engineCapabilities } from "./capabilitiesRuntime.js";
export type { CapabilitiesForDeps, VisionSupportDeps, AgentRow, ProviderRow, SupportMatrix, EngineSupportMatrixDeps, EngineQueryDeps } from "./capabilitiesRuntime.js";
