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

/**
 * Plain words for the thing the user was trying to do, used in preflight
 * messages. Ported verbatim from `Capability::phrase` — kept beside the union so
 * a new capability cannot ship without a sentence a person can read.
 */
export function capabilityPhrase(capability: Capability): string {
  switch (capability) {
    case "streaming":
      return "show its answer as it is written";
    case "tool_calling":
      return "use tools (open files, search, run jobs)";
    case "vision":
      return "look at an image";
    case "structured_output":
      return "return a strictly-shaped result";
    case "chat":
      return "hold a conversation";
    case "image_generation":
      return "make a picture";
    case "video_generation":
      return "make a video";
    default:
      return unknownCapability(capability);
  }
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
   * whether the model can see: `generate_external` takes no images, so a cloud
   * CLI is blind to us even when the model behind it is not. */
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

/** Claude Code as the room's engine. A one-shot `claude -p` subprocess: the
 * sidecar hands its whole reply back as ONE delta at the end, there is no image
 * channel, and its structured replies are recovered rather than constrained. It
 * DOES call tools — through the room's MCP bridge, which is why it is a
 * `CloudEngine` and not an advisor. */
export const CLAUDE_CLI: EngineDecl = {
  id: "claude-cli",
  label: "Claude Code",
  local: false,
  streaming: "no",
  imageChannel: false,
  toolCalling: "yes",
  structuredOutput: "no",
  tier: primaryCliScope(),
};

/** Codex as the room's engine — same transport shape as {@link CLAUDE_CLI}. */
export const CODEX_CLI: EngineDecl = {
  id: "codex-cli",
  label: "Codex",
  local: false,
  streaming: "no",
  imageChannel: false,
  toolCalling: "yes",
  structuredOutput: "no",
  tier: primaryCliScope(),
};

/** Antigravity CLI as the room's engine. Arcelle uses its headless JSON stream and
 * the same scoped text tool protocol as Codex, so transport capabilities match
 * the other CLI-backed engines. */
export const ANTIGRAVITY_CLI: EngineDecl = {
  id: "antigravity-cli",
  label: "Antigravity CLI",
  local: false,
  streaming: "no",
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
  if (engine === "claude-cli") {
    return CLAUDE_CLI.id;
  }
  if (engine === "codex-cli") {
    return CODEX_CLI.id;
  }
  if (engine === "antigravity-cli") {
    return ANTIGRAVITY_CLI.id;
  }
  if (engine === "openrouter") {
    return OPENROUTER.id;
  }
  // BOTH spellings, which is the whole point.
  if (isCloudModel(model)) {
    return OLLAMA_CLOUD.id;
  }
  if (lastColonPart(model).endsWith("-cloud")) {
    return OLLAMA_CLOUD.id;
  }
  return OLLAMA.id;
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

/** Ported verbatim from `EngineCapabilities::supports`. */
export function capsSupports(caps: EngineCapabilities, want: Capability): Support {
  switch (want) {
    case "streaming":
      return caps.streaming;
    case "tool_calling":
      return caps.toolCalling;
    case "vision":
      return caps.vision;
    case "structured_output":
      return caps.structuredOutput;
    case "chat":
      return caps.chat;
    case "image_generation":
      return caps.imageGeneration;
    case "video_generation":
      return caps.videoGeneration;
    // The gate's own boundary check — see {@link unknownCapability}. `preflight`
    // funnels every question through here, so guarding this one switch is what
    // stops an invented capability from resolving to an `undefined` verdict.
    default:
      return unknownCapability(want);
  }
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
  switch (decl.id) {
    case "ollama":
    case "ollama-cloud": {
      // An embedding-only model is answered WITHOUT a round trip, because this
      // is also the answer when nothing is reachable: picking one as the chat
      // model fails the turn with HTTP 400, and a name test is the only signal
      // available with the sidecar down. It is a floor, not the source of
      // truth — a reachable engine overwrites `chat` below from what it reports.
      if (isEmbeddingModel(model)) {
        caps.chat = "no";
        caps.vision = "no";
        caps.toolCalling = "no";
        return caps;
      }
      const listed = await deps.ollamaCapabilities(model);
      if (listed.length > 0) {
        const has = (name: string): boolean => listed.includes(name);
        caps.vision = supportYes(has("vision"));
        caps.chat = supportYes(has("completion"));
        // Ollama's capability vocabulary has no term for producing an image — it
        // serves chat models, and a diffusion checkpoint is not reachable over
        // /api/chat at all. So a LISTED local model is a definite "no" here
        // rather than an "unknown": the Create page can then say WHY nothing
        // local is on offer instead of silently showing an empty shelf.
        caps.imageGeneration = "no";
        caps.videoGeneration = "no";
        // Only refine what the declaration left open: a `:cloud` relay reports
        // `tools` in its catalog and still leaks the calls inline, so its
        // declared "no" must survive the live answer.
        if (decl.toolCalling === "unknown") {
          caps.toolCalling = supportYes(has("tools"));
        }
      }
      caps.contextWindow = await deps.ollamaNativeContextLength(model);
      return caps;
    }
    case "openrouter": {
      await deps.ensureProviderCatalog(model);
      const facts = deps.providerModelFacts(model);
      if (facts !== undefined) {
        caps.contextWindow = facts.contextWindow;
        caps.toolCalling = supportYes(facts.tools);
        caps.vision = supportYes(facts.vision);
        caps.structuredOutput = supportYes(facts.structuredOutputs);
        caps.chat = "yes";
        caps.imageGeneration = supportYes(facts.imageOutput);
        caps.videoGeneration = supportYes(facts.videoOutput);
      }
      return caps;
    }
    case "codex-cli": {
      // Rust reads the fallback engine off `split_external_model(model).0`; that
      // is the same string as `decl.id` in this arm by construction, since
      // `engineIdOf` only returns "codex-cli" when the split's head is it.
      const submodel = splitExternalModel(model)[1];
      caps.chat = "yes";
      caps.contextWindow = (await deps.codexContextWindow(submodel)) ?? externalMaxContext(decl.id);
      return caps;
    }
    default: {
      caps.chat = "yes";
      caps.contextWindow = externalMaxContext(decl.id);
      return caps;
    }
  }
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
  if (!decl.imageChannel || isEmbeddingModel(model)) {
    return "no";
  }
  if (decl.id === "openrouter") {
    await deps.ensureProviderCatalog(model);
    const vision = deps.providerModelVision(model);
    return vision === undefined ? "unknown" : supportYes(vision);
  }
  const listed = await deps.ollamaCapabilities(model);
  if (listed.length === 0) {
    return "unknown";
  }
  return supportYes(listed.includes("vision"));
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeAgentRow(v: unknown): AgentRow | null {
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
