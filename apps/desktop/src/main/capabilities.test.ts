/**
 * Tests for `capabilities.ts`.
 *
 * Section 1 ports every `#[cfg(test)]` fixture from
 * `src-tauri/src/commands/capabilities.rs` (same names, same assertions) against
 * the pure/synchronous surface. The rest covers what the Rust suite could not:
 * the dependency-injected async orchestration (`capabilitiesFor`,
 * `visionSupport`, `engineSupportMatrix`, the two room-facing commands), which
 * in Rust reaches live catalogs and therefore has no unit tests at all.
 *
 * This module decides security-relevant behaviour — which tools a model is
 * trusted with, whether content is claimed to stay on this Mac, and whether the
 * privacy door's image-stripping is reported honestly — so the DECLARED-vs-LIVE
 * mismatch guards get direct coverage: a `:cloud` relay's catalog claiming
 * `tools` must not overturn its declared `"no"`, an embedding model must never
 * be handed chat/vision/tools, and an unreachable engine must never be reported
 * as either capable or incapable.
 *
 * Every case pins the base URL explicitly rather than relying on the unset
 * default, so a developer machine with `ARCELLE_OLLAMA_URL` pointed at a LAN box
 * cannot silently flip the locality assertions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBaseUrlOverrideForTests, setBaseUrlOverride } from "./engineRouting.js";
import { CLAUDE_FALLBACK_MAX_CONTEXT, CODEX_MAX_CONTEXT } from "./modelLimits.js";
import { isExternalEngine } from "./turnContext.js";
import {
  agentRows,
  capabilitiesFor,
  ANTIGRAVITY_CLI,
  capabilityPhrase,
  capsFromDecl,
  capsSupports,
  CLAUDE_CLI,
  CODEX_CLI,
  DECLARED,
  declaredFor,
  engineAvailable,
  engineCapabilities,
  engineIdOf,
  enginePreflight,
  engineSupportMatrix,
  imageReachesModel,
  isCloudModel,
  isYes,
  OLLAMA,
  OLLAMA_CLOUD,
  ollamaRunsHere,
  OPENROUTER,
  preflight,
  primaryCliScope,
  runsOnThisMac,
  servedByOllamaEngine,
  supportYes,
  tierName,
  visionDoorBlock,
  visionSupport,
  type Capability,
  type CapabilitiesForDeps,
  type EngineCapabilities,
  type EngineSupportMatrixDeps,
  type ModelRuntimeFacts,
  type VisionSupportDeps,
} from "./capabilities.js";

/** A loopback base URL, so `ollamaRunsHere()` is `true` for reasons the test
 * states rather than for whatever the ambient environment happens to be. */
const THIS_MAC = "http://127.0.0.1:11434";

beforeEach(() => {
  setBaseUrlOverride(THIS_MAC);
});

afterEach(() => {
  resetBaseUrlOverrideForTests();
});

function localCaps(): EngineCapabilities {
  return capsFromDecl("qwen3.5:4b", OLLAMA);
}

const EVERY_CAPABILITY: readonly Capability[] = [
  "streaming",
  "tool_calling",
  "vision",
  "structured_output",
  "chat",
  "image_generation",
  "video_generation",
];

// ============================================================================
// 1. Ported from capabilities.rs's own `#[cfg(test)] mod tests`
// ============================================================================

describe("ported from capabilities.rs", () => {
  /** The record is ONE table, and every engine the app can be pointed at has a
   * row in it. Pinned because `declaredFor` silently falls back to the local
   * record rather than throwing on an unknown id — that fallback must never be
   * the thing that answers a real selection. */
  it("every_selection_shape_resolves_to_a_declared_engine", () => {
    expect(engineIdOf("qwen3.5:4b")).toBe("ollama");
    expect(engineIdOf("minimax-m3:cloud")).toBe("ollama-cloud");
    // The `<size>-cloud` spelling an exact `:cloud` suffix test misses.
    expect(engineIdOf("gpt-oss:120b-cloud")).toBe("ollama-cloud");
    expect(engineIdOf("qwen3-vl:235b-cloud")).toBe("ollama-cloud");
    expect(engineIdOf("claude-cli")).toBe("claude-cli");
    expect(engineIdOf("codex-cli::gpt-5.6-sol::high")).toBe("codex-cli");
    expect(engineIdOf("antigravity-cli::gemini-3.7-flash-high")).toBe("antigravity-cli");
    expect(engineIdOf("openrouter::vendor/model")).toBe("openrouter");
    for (const model of ["qwen3.5:4b", "minimax-m3:cloud", "claude-cli", "codex-cli", "antigravity-cli", "openrouter::vendor/model"]) {
      expect(declaredFor(model).id, model).toBe(engineIdOf(model));
    }
  });

  it("keeps a recognized external engine ahead of a cloud-looking submodel suffix", () => {
    // Engine selection is based on the external prefix. A provider slug can
    // legitimately contain `:cloud`; only an Ollama tag uses that suffix to
    // select the relay transport.
    expect(engineIdOf("openrouter::vendor/model:cloud")).toBe("openrouter");
    expect(declaredFor("openrouter::vendor/model:cloud")).toBe(OPENROUTER);
  });

  /** THE CONVERSION THIS PACKET EXISTS FOR: "can it stream?" is a declared
   * field, not a name sniff. Since 2026-08-27 every engine streams — the CLIs
   * through their NDJSON envelopes (token deltas for Claude/Antigravity, one
   * delta per completed message for Codex). */
  it("streaming_is_declared_not_sniffed_from_the_name", () => {
    expect(declaredFor("claude-cli").streaming).toBe("yes");
    expect(declaredFor("codex-cli::gpt-5.6-sol::high").streaming).toBe("yes");
    expect(declaredFor("antigravity-cli::gemini-3.7-flash-high").streaming).toBe("yes");
    expect(declaredFor("qwen3.5:4b").streaming).toBe("yes");
    expect(declaredFor("minimax-m3:cloud").streaming).toBe("yes");
    expect(declaredFor("openrouter::vendor/model").streaming).toBe("yes");
  });

  /** The `:cloud` relay's two real limits were encoded as a string test at every
   * site that cared. They are declared once now. */
  it("the_cloud_relays_limits_are_declared_once", () => {
    const relay = declaredFor("minimax-m3:cloud");
    expect(relay.toolCalling).toBe("no");
    expect(relay.structuredOutput).toBe("no");
    // ...and a LOCAL model's tool calling is not guessed at all: it is the
    // per-model question `/api/show` answers.
    expect(declaredFor("qwen3.5:4b").toolCalling).toBe("unknown");
  });

  /** The tier a model is served at is part of the record, so the bridge and the
   * published matrix cannot disagree about it. */
  it("the_tier_is_part_of_the_record", () => {
    expect(declaredFor("qwen3.5:4b").tier).toEqual({ kind: "LocalEngine" });
    for (const hosted of [
      "minimax-m3:cloud",
      "gpt-oss:120b-cloud",
      "claude-cli",
      "codex-cli",
      "antigravity-cli",
      "openrouter::vendor/model",
    ]) {
      expect(declaredFor(hosted).tier, hosted).toEqual({ kind: "CloudEngine" });
    }
  });

  /**
   * A DIFFERENTIAL test against the name-matching this replaced.
   *
   * "Does this content leave the Mac?" was written at each site as
   * `isCloudModel(m) || isExternalEngine(m)`. Both are false for
   * `gpt-oss:120b-cloud` — Ollama's `<size>-cloud` spelling — so the Studio's
   * progress line told the user "a local model can take a few minutes" while
   * their document was already on its way to ollama.com. Asserting the OLD
   * predicates here is deliberate: the test fails the moment anyone reverts a
   * call site to them.
   */
  it("locality_is_declared_where_the_old_name_tests_were_wrong", () => {
    for (const hosted of ["gpt-oss:120b-cloud", "qwen3-vl:235b-cloud"]) {
      expect(isCloudModel(hosted) || isExternalEngine(hosted), `${hosted}: the old pair is supposed to MISS this`).toBe(
        false
      );
      expect(declaredFor(hosted).local, `${hosted}: the record must know this runs off the Mac`).toBe(false);
    }
    // ...and the spellings the old pair did catch still read as non-local.
    expect(declaredFor("minimax-m3:cloud").local).toBe(false);
    expect(declaredFor("claude-cli").local).toBe(false);
    expect(declaredFor("openrouter::vendor/model").local).toBe(false);
    expect(declaredFor("qwen3.5:4b").local).toBe(true);
  });

  /** PREFLIGHT: an incapable provider is caught before the run, with a sentence
   * naming the engine and what it cannot do. */
  it("preflight_blocks_an_incapable_provider_before_the_run", () => {
    // Antigravity is the one engine still without an image channel.
    const cli = capsFromDecl("antigravity-cli", ANTIGRAVITY_CLI);
    const verdict = preflight(cli, "vision");
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.reason).toContain("Antigravity CLI");
      expect(verdict.reason).toContain("look at an image");
      // The engine is the obstacle, not a setting — so a caller may still offer
      // "install/choose a model that can see".
      expect(verdict.code).toBe("capability");
    }
    // The same engine CAN call tools, so preflight must not refuse that.
    expect(preflight(cli, "tool_calling")).toEqual({ status: "ready" });
  });

  /** An engine that answered nothing is NOT reported as incapable. This is the
   * difference between "your model cannot do this" and "we could not reach the
   * engine", and collapsing them is how a broken sidecar used to read as a
   * product limit. */
  it("unknown_is_never_turned_into_a_refusal", () => {
    const verdict = preflight(localCaps(), "tool_calling");
    expect(verdict.status).toBe("unknown");
    if (verdict.status === "unknown") {
      expect(verdict.reason).toContain("not readable");
    }
  });

  /** A capable cloud model behind a closed privacy door gets the SPECIFIC
   * sentence, because the fix is a switch the user owns. */
  it("the_door_gets_its_own_sentence_not_a_generic_refusal", () => {
    const caps = capsFromDecl("openrouter::vendor/sees", OPENROUTER);
    caps.vision = "yes";
    caps.imageReaches = false;
    const verdict = preflight(caps, "vision");
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.reason).toContain("privacy door");
      expect(verdict.reason).toContain("never received");
      // THE DISTINCTION THE UI RESTS ON. Both arms are `blocked` and both carry
      // prose; only the code says which offer is honest. Settings hides the
      // "download a vision helper" button on this one and keeps it on
      // `capability`.
      expect(verdict.code).toBe("privacy-door");
    }
    // ...and a plain "this engine is blind" block is NOT the door: same status,
    // different code, different offer.
    const blind = preflight(capsFromDecl("antigravity-cli", ANTIGRAVITY_CLI), "vision");
    expect(blind.status).toBe("blocked");
    if (blind.status === "blocked") {
      expect(blind.code).toBe("capability");
      expect(blind.reason).not.toContain("privacy door");
    }
    // Door open → the declared capability answers, unblocked.
    caps.imageReaches = true;
    expect(preflight(caps, "vision")).toEqual({ status: "ready" });
  });

  /** UNKNOWN IS NOT A YES. The door sentence asserts the engine can see; with
   * the provider catalog unreadable nothing established that, and claiming it
   * about an engine we could not reach is precisely what this module prevents. */
  it("an_unconfirmed_vision_model_behind_the_door_is_not_told_it_can_see", () => {
    const caps = capsFromDecl("openrouter::vendor/anything", OPENROUTER);
    caps.vision = "unknown";
    caps.imageReaches = false;
    expect(visionDoorBlock(caps)).toBeNull();
    const verdict = preflight(caps, "vision");
    expect(verdict.status).toBe("unknown");
    if (verdict.status === "unknown") {
      expect(verdict.reason).toContain("unreachable");
    }
  });

  /** A sidecar that answered is REACHABLE, whatever it said. Reading "reached"
   * off the length of the list made an empty answer — and an answer in a shape
   * this version cannot decode — read as a network failure, with no reason shown
   * beside the half-drawn table. */
  it("an_undecodable_agent_list_is_a_shape_problem_not_a_silence", () => {
    const [rows, err] = agentRows({ agents: [{ id: "web", label: "Web" }] });
    expect(rows).toEqual([{ id: "web", label: "Web" }]);
    expect(err).toBeNull();
    // No agents at all is still an answer, and must not be reported as one.
    expect(agentRows({ agents: [] })[1]).toBeNull();
    const [emptyRows, shapeErr] = agentRows({ agents: { a: "b" } });
    expect(emptyRows).toEqual([]);
    expect(shapeErr ?? "").toContain("does not understand");
    // A missing field is the same failure, not a crash.
    expect(agentRows({})[1]).not.toBeNull();
  });

  /** A provider row is only "available" when this Mac really has it. The matrix
   * is published to the user, so a row that claims readiness it cannot evidence
   * is exactly the fabrication the release was about. */
  it("availability_comes_from_real_state", () => {
    const local = ["qwen3.5:4b"];
    const hosted = ["gpt-oss:120b-cloud"];
    const never = (): boolean => false;
    expect(engineAvailable("ollama", local, [], never)).toBe(true);
    expect(engineAvailable("ollama-cloud", local, [], never)).toBe(false);
    expect(engineAvailable("ollama-cloud", hosted, [], never)).toBe(true);
    expect(engineAvailable("ollama", hosted, [], never)).toBe(false);
    expect(engineAvailable("claude-cli", local, [], never)).toBe(false);
    expect(engineAvailable("claude-cli", local, ["claude-cli"], never)).toBe(true);
    expect(engineAvailable("codex-cli", local, ["claude-cli"], never)).toBe(false);
  });
});

// ============================================================================
// 2. The small value types
// ============================================================================

describe("Support / Capability", () => {
  it("supportYes collapses a bool, and isYes never promotes unknown", () => {
    expect(supportYes(true)).toBe("yes");
    expect(supportYes(false)).toBe("no");
    expect(isYes("yes")).toBe(true);
    expect(isYes("no")).toBe(false);
    // The honest collapse of "unknown" for a PERMISSION question is "not
    // proven" — never a yes.
    expect(isYes("unknown")).toBe(false);
  });

  it("every capability has a sentence a person can read", () => {
    for (const capability of EVERY_CAPABILITY) {
      expect(capabilityPhrase(capability).length, capability).toBeGreaterThan(0);
    }
    expect(capabilityPhrase("vision")).toBe("look at an image");
    expect(capabilityPhrase("image_generation")).toBe("make a picture");
    expect(capabilityPhrase("video_generation")).toBe("make a video");
  });

  it("capsSupports routes every capability to its own field — no two share one answer", () => {
    const caps: EngineCapabilities = {
      ...localCaps(),
      streaming: "yes",
      toolCalling: "no",
      vision: "unknown",
      structuredOutput: "yes",
      chat: "no",
      imageGeneration: "unknown",
      videoGeneration: "no",
    };
    expect(EVERY_CAPABILITY.map((c) => capsSupports(caps, c))).toEqual([
      "yes",
      "no",
      "unknown",
      "yes",
      "no",
      "unknown",
      "no",
    ]);
  });

  it("tierName covers every scope, including the two no declared engine uses", () => {
    expect(tierName({ kind: "LocalEngine" })).toBe("local-engine");
    expect(tierName({ kind: "CloudEngine" })).toBe("cloud-engine");
    expect(tierName({ kind: "ExternalAgent" })).toBe("external-agent");
    expect(tierName({ kind: "CloudAdvisor", includeMcp: true })).toBe("cloud-advisor");
    expect(tierName({ kind: "CloudAdvisor", includeMcp: false })).toBe("cloud-advisor");
  });

  it("primaryCliScope is the ENGINE tier, not the lesser advisor tier", () => {
    // Owner decision 2026-07-25: the room's own cloud CLI is the main agent, so
    // it gets the engine tier. Sharing the consulted-advisor tier cost it jobs,
    // workflows, scripts, studio and transcription.
    expect(primaryCliScope()).toEqual({ kind: "CloudEngine" });
    for (const decl of [OLLAMA_CLOUD, CLAUDE_CLI, CODEX_CLI, OPENROUTER]) {
      expect(decl.tier, decl.id).toEqual({ kind: "CloudEngine" });
    }
  });

  /**
   * A CAPABILITY NOBODY DECLARES IS AN ERROR, NOT A PASS.
   *
   * In Rust `engine_preflight` takes a `Capability` enum, so serde rejects an
   * unrecognised string at the command boundary and the renderer gets an error.
   * A TS string union is erased at runtime: an exhaustive `switch` with no
   * `default` simply falls off the end and yields `undefined`, so the gate
   * returned a non-`Verdict` and a caller written defensively
   * (`verdict?.status === "blocked"`) read that as "not blocked" and ran. This
   * is the pre-run gate for vision and tool calling, so its failure direction
   * has to be a refusal, not a silent pass.
   */
  it("SECURITY: an invented capability is refused outright, never answered with a non-Verdict", async () => {
    const invented = "root_shell" as Capability;
    expect(() => capsSupports(localCaps(), invented)).toThrow(/root_shell/);
    expect(() => capabilityPhrase(invented)).toThrow(/root_shell/);
    expect(() => preflight(localCaps(), invented)).toThrow(/root_shell/);
    // ...and through the room-facing command, where it arrives off IPC: a
    // rejected `invoke()`, which is what serde's rejection produced in Rust.
    await expect(enginePreflight("qwen3.5:4b", invented, queryDeps([]))).rejects.toThrow(/root_shell/);
  });

  it("preflight never turns an all-unknown record into a refusal, for any capability", () => {
    const caps: EngineCapabilities = {
      ...localCaps(),
      streaming: "unknown",
      toolCalling: "unknown",
      vision: "unknown",
      structuredOutput: "unknown",
      chat: "unknown",
      imageGeneration: "unknown",
      videoGeneration: "unknown",
      imageReaches: true,
    };
    for (const capability of EVERY_CAPABILITY) {
      expect(preflight(caps, capability).status, capability).toBe("unknown");
    }
  });
});

// ============================================================================
// 3. Locality: the record, the transport, and the privacy door
// ============================================================================

describe("runsOnThisMac / ollamaRunsHere / servedByOllamaEngine", () => {
  it("only a locally-served tag on a local transport runs here", () => {
    expect(runsOnThisMac("qwen2.5vl:7b")).toBe(true);
    expect(runsOnThisMac("gemma3:12b")).toBe(true);
    // Served from Ollama's machines — BOTH spellings count.
    expect(runsOnThisMac("minimax-m3:cloud")).toBe(false);
    expect(runsOnThisMac("qwen3-vl:235b-cloud")).toBe(false);
    expect(runsOnThisMac("gpt-oss:120b-cloud")).toBe(false);
    // ...as would an external engine.
    expect(runsOnThisMac("claude-cli::opus")).toBe(false);
    expect(runsOnThisMac("openrouter::vendor/vision-agent")).toBe(false);
  });

  it("a LOCAL-shaped model relayed via the Closet override is NOT this Mac", () => {
    setBaseUrlOverride("http://192.168.1.20:11434");
    expect(ollamaRunsHere()).toBe(false);
    expect(runsOnThisMac("qwen3.5:4b")).toBe(false);
    // servedByOllamaEngine answers for the MODEL only — unaffected by the
    // override, which is exactly why it must never stand in for the privacy
    // question: filtering the model list by locality would reject every
    // installed tag and leave the app with no model to name.
    expect(servedByOllamaEngine("qwen3.5:4b")).toBe(true);
    expect(servedByOllamaEngine("minimax-m3:cloud")).toBe(false);

    // A loopback override is still this Mac.
    setBaseUrlOverride("http://127.0.0.1:11500");
    expect(runsOnThisMac("qwen3.5:4b")).toBe(true);
  });

  it("the published record carries the transport half too, so a relayed room is not labelled local", () => {
    setBaseUrlOverride("http://192.168.1.20:11434");
    const relayed = capsFromDecl("qwen3.5:4b", OLLAMA);
    // The UI matrix reads `local`; without the transport half it labelled a
    // relayed room "runs on this Mac" and the trust chip said nothing leaves.
    expect(relayed.local).toBe(false);
    expect(relayed.imageReaches).toBe(false);
  });
});

describe("imageReachesModel", () => {
  it("a local model's pixels always reach it, door or no door", () => {
    expect(imageReachesModel("qwen3.5:4b", () => true)).toBe(true);
    expect(imageReachesModel("qwen3.5:4b", () => false)).toBe(true);
  });

  it("a non-local model's pixels are stripped only when the door is active", () => {
    expect(imageReachesModel("openrouter::vendor/model", () => true)).toBe(false);
    expect(imageReachesModel("openrouter::vendor/model", () => false)).toBe(true);
    expect(imageReachesModel("gpt-oss:120b-cloud", () => true)).toBe(false);
  });

  it("a relayed 'local' model is subject to the door like any other remote engine", () => {
    setBaseUrlOverride("http://192.168.1.20:11434");
    expect(imageReachesModel("qwen3.5:4b", () => true)).toBe(false);
    expect(imageReachesModel("qwen3.5:4b", () => false)).toBe(true);
  });
});

// ============================================================================
// 4. capabilitiesFor — the DECLARED-vs-LIVE seam this module exists to police
// ============================================================================

function facts(overrides: Partial<ModelRuntimeFacts> = {}): ModelRuntimeFacts {
  return {
    contextWindow: null,
    tools: false,
    vision: false,
    structuredOutputs: false,
    imageOutput: false,
    videoOutput: false,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<CapabilitiesForDeps> = {}): CapabilitiesForDeps {
  return {
    ollamaCapabilities: async () => [],
    ollamaNativeContextLength: async () => null,
    ensureProviderCatalog: async () => {
      /* no-op */
    },
    providerModelFacts: () => undefined,
    codexContextWindow: async () => undefined,
    privacyDoorActive: () => false,
    ...overrides,
  };
}

describe("capabilitiesFor", () => {
  it("SECURITY: an embedding-only model is never handed chat, vision, or tools — and no round trip is made", async () => {
    let asked = false;
    const caps = await capabilitiesFor(
      "nomic-embed-text",
      fakeDeps({
        ollamaCapabilities: async () => {
          asked = true;
          return ["completion", "vision", "tools"];
        },
      })
    );
    expect(caps.chat).toBe("no");
    expect(caps.vision).toBe("no");
    expect(caps.toolCalling).toBe("no");
    // Even though the fake catalog would claim everything, it must not be
    // consulted at all: the name test is the floor that holds with the sidecar
    // down, and picking an embedding model as the chat model fails with HTTP 400.
    expect(asked).toBe(false);
  });

  it("a local model's live catalog refines chat/vision/tools out of Unknown", async () => {
    const caps = await capabilitiesFor(
      "qwen2.5vl:7b",
      fakeDeps({
        ollamaCapabilities: async () => ["completion", "vision", "tools"],
        ollamaNativeContextLength: async () => 32_768,
      })
    );
    expect(caps.chat).toBe("yes");
    expect(caps.vision).toBe("yes");
    expect(caps.toolCalling).toBe("yes");
    // Ollama's vocabulary has no term for PRODUCING a picture, so a listed local
    // model is a definite no — the Create page can say why the shelf is empty.
    expect(caps.imageGeneration).toBe("no");
    expect(caps.videoGeneration).toBe("no");
    expect(caps.contextWindow).toBe(32_768);
    expect(caps.local).toBe(true);
    expect(caps.tier).toBe("local-engine");
  });

  it("SECURITY: a `:cloud` relay's catalog claiming `tools` does not overturn its declared `no`", async () => {
    // The relay leaks tool calls as inline `<tool_call>…` text the stream parser
    // never sees. A live catalog saying "tools" must not grant it the
    // tool-calling tier anyway — only what the declaration left OPEN is refined.
    const caps = await capabilitiesFor(
      "minimax-m3:cloud",
      fakeDeps({ ollamaCapabilities: async () => ["completion", "vision", "tools"] })
    );
    expect(caps.toolCalling).toBe("no");
    // ...while the genuinely per-model columns still refine.
    expect(caps.vision).toBe("yes");
    expect(caps.chat).toBe("yes");
    expect(caps.local).toBe(false);
    expect(caps.tier).toBe("cloud-engine");
  });

  it("SECURITY: the same refusal holds for the `<size>-cloud` spelling", async () => {
    const caps = await capabilitiesFor(
      "gpt-oss:120b-cloud",
      fakeDeps({ ollamaCapabilities: async () => ["completion", "tools"] })
    );
    expect(caps.engine).toBe("ollama-cloud");
    expect(caps.local).toBe(false);
    expect(caps.toolCalling).toBe("no");
    expect(caps.structuredOutput).toBe("no");
  });

  it("an empty (unreachable) catalog leaves every open field Unknown rather than guessing", async () => {
    const caps = await capabilitiesFor("qwen3.5:4b", fakeDeps());
    expect(caps.chat).toBe("unknown");
    expect(caps.vision).toBe("unknown");
    expect(caps.toolCalling).toBe("unknown");
    expect(caps.contextWindow).toBeNull();
    // The DECLARED columns are still answered — they never needed the engine.
    expect(caps.streaming).toBe("yes");
    expect(caps.structuredOutput).toBe("yes");
  });

  it("an openrouter model with no catalog entry stays Unknown, not a guessed Yes", async () => {
    const caps = await capabilitiesFor("openrouter::vendor/mystery", fakeDeps());
    expect(caps.chat).toBe("unknown");
    expect(caps.vision).toBe("unknown");
    expect(caps.toolCalling).toBe("unknown");
    expect(caps.contextWindow).toBeNull();
  });

  it("an openrouter model's catalog facts populate every field, and the catalog is primed first", async () => {
    let primedBeforeRead = false;
    let primed = false;
    const caps = await capabilitiesFor(
      "openrouter::vendor/sees",
      fakeDeps({
        ensureProviderCatalog: async () => {
          primed = true;
        },
        providerModelFacts: (model) => {
          primedBeforeRead = primed;
          return model === "openrouter::vendor/sees"
            ? facts({ contextWindow: 128_000, tools: true, vision: true, structuredOutputs: true, imageOutput: true })
            : undefined;
        },
      })
    );
    // The cache is in-memory and filled only by a fetch, so without the prime
    // the first ask after every launch had nothing to read.
    expect(primedBeforeRead).toBe(true);
    expect(caps.chat).toBe("yes");
    expect(caps.toolCalling).toBe("yes");
    expect(caps.vision).toBe("yes");
    expect(caps.structuredOutput).toBe("yes");
    expect(caps.imageGeneration).toBe("yes");
    expect(caps.videoGeneration).toBe("no");
    expect(caps.contextWindow).toBe(128_000);
  });

  it("codex-cli prefers the live per-slug context window over the flat fallback", async () => {
    const caps = await capabilitiesFor(
      "codex-cli::gpt-5.6-sol::high",
      fakeDeps({ codexContextWindow: async (submodel) => (submodel === "gpt-5.6-sol" ? 1_050_000 : undefined) })
    );
    expect(caps.chat).toBe("yes");
    expect(caps.contextWindow).toBe(1_050_000);
  });

  it("codex-cli falls back to modelLimits' real constant for its OWN engine id", async () => {
    // The fallback is read from the landed `modelLimits.ts`, not injected, so
    // this pins the real number a Codex room's token-budget bar will show when
    // the live catalog cannot be read — not a number the test itself supplied.
    const caps = await capabilitiesFor("codex-cli::unknown-slug", fakeDeps({ codexContextWindow: async () => undefined }));
    expect(caps.contextWindow).toBe(CODEX_MAX_CONTEXT);
    expect(caps.contextWindow).toBe(272_000);
  });

  it("claude-cli streams, sees images, and keeps the flat context fallback", async () => {
    const caps = await capabilitiesFor("claude-cli", fakeDeps());
    expect(caps.chat).toBe("yes");
    expect(caps.contextWindow).toBe(CLAUDE_FALLBACK_MAX_CONTEXT);
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.streaming).toBe("yes");
    // The stream-json block channel is real and every catalog model reads
    // images; only GENERATION stays impossible over a chat CLI.
    expect(caps.vision).toBe("yes");
    expect(caps.imageGeneration).toBe("no");
    expect(caps.videoGeneration).toBe("no");
  });

  it("codex-cli reports vision through its -i channel", async () => {
    const caps = await capabilitiesFor("codex-cli::gpt-5.6-sol::high", fakeDeps());
    expect(caps.vision).toBe("yes");
    expect(caps.streaming).toBe("yes");
    expect(caps.imageGeneration).toBe("no");
  });

  it("antigravity-cli (the default arm) stays the one blind engine", async () => {
    const caps = await capabilitiesFor("antigravity-cli::gemini-3.7-flash-high", fakeDeps());
    expect(caps.chat).toBe("yes");
    expect(caps.streaming).toBe("yes");
    // No image channel is a flat no from the TRANSPORT, whatever the model
    // behind the CLI can do — its print mode has nowhere to put pixels.
    expect(caps.vision).toBe("no");
    expect(caps.imageGeneration).toBe("no");
    expect(caps.videoGeneration).toBe("no");
  });

  it("imageReaches reflects the privacy door, and stays independent of `vision`", async () => {
    const closed = await capabilitiesFor(
      "openrouter::vendor/sees",
      fakeDeps({ privacyDoorActive: () => true, providerModelFacts: () => facts({ vision: true }) })
    );
    // "It can see" and "it will receive the picture" are two different facts.
    expect(closed.vision).toBe("yes");
    expect(closed.imageReaches).toBe(false);
    expect(preflight(closed, "vision")).toEqual({
      status: "blocked",
      code: "privacy-door",
      reason: visionDoorBlock(closed),
    });

    const open = await capabilitiesFor(
      "openrouter::vendor/sees",
      fakeDeps({ privacyDoorActive: () => false, providerModelFacts: () => facts({ vision: true }) })
    );
    expect(open.imageReaches).toBe(true);
    expect(preflight(open, "vision")).toEqual({ status: "ready" });
  });
});

// ============================================================================
// 5. visionSupport — the cheap column `grounding_pick` asks per model
// ============================================================================

function visionDeps(overrides: Partial<VisionSupportDeps> = {}): VisionSupportDeps {
  return {
    ollamaCapabilities: async () => [],
    ensureProviderCatalog: async () => {
      /* no-op */
    },
    providerModelVision: () => undefined,
    ...overrides,
  };
}

describe("visionSupport", () => {
  it("no image channel is a flat No, without consulting any catalog", async () => {
    let asked = false;
    const noisyDeps = visionDeps({
      ollamaCapabilities: async () => {
        asked = true;
        return ["vision"];
      },
      ensureProviderCatalog: async () => {
        asked = true;
      },
      providerModelVision: () => true,
    });
    // Antigravity is the engine still without an image channel.
    expect(await visionSupport("antigravity-cli::gemini-3.7-flash-high", noisyDeps)).toBe("no");
    // Claude/Codex answer a flat Yes the same catalog-free way — their pixel
    // channels are transport facts, live-verified.
    expect(await visionSupport("claude-cli::opus", noisyDeps)).toBe("yes");
    expect(await visionSupport("codex-cli::gpt-5.6-sol", noisyDeps)).toBe("yes");
    expect(asked).toBe(false);
  });

  it("an embedding model is a flat No even though its engine has an image channel", async () => {
    expect(
      await visionSupport("nomic-embed-text", visionDeps({ ollamaCapabilities: async () => ["vision"] }))
    ).toBe("no");
  });

  it("openrouter asks the catalog after priming it, and reports Unknown absent an entry", async () => {
    let primed = false;
    expect(
      await visionSupport(
        "openrouter::vendor/model",
        visionDeps({
          ensureProviderCatalog: async () => {
            primed = true;
          },
          providerModelVision: () => true,
        })
      )
    ).toBe("yes");
    expect(primed).toBe(true);
    expect(await visionSupport("openrouter::vendor/model", visionDeps({ providerModelVision: () => false }))).toBe("no");
    expect(await visionSupport("openrouter::vendor/unheard-of", visionDeps())).toBe("unknown");
  });

  it("ollama asks its own catalog; an empty answer is Unknown, never No", async () => {
    expect(
      await visionSupport("qwen2.5vl:7b", visionDeps({ ollamaCapabilities: async () => ["vision", "completion"] }))
    ).toBe("yes");
    expect(await visionSupport("qwen3.5:4b", visionDeps({ ollamaCapabilities: async () => ["completion"] }))).toBe("no");
    // The whole point: an unreachable engine is not a blind one.
    expect(await visionSupport("qwen3.5:4b", visionDeps())).toBe("unknown");
  });

  it("a `:cloud` relay still rides the ollama catalog arm, not the provider one", async () => {
    expect(
      await visionSupport("qwen3-vl:235b-cloud", visionDeps({ ollamaCapabilities: async () => ["vision"] }))
    ).toBe("yes");
  });
});

// ============================================================================
// 6. engineSupportMatrix
// ============================================================================

function matrixDeps(overrides: Partial<EngineSupportMatrixDeps> = {}): EngineSupportMatrixDeps {
  return {
    listModels: async () => [],
    detectedAdvisors: async () => [],
    providerConnected: () => false,
    fetchAgentSupport: async () => ({ agents: [], tiers: {} }),
    ...overrides,
  };
}

describe("engineSupportMatrix", () => {
  it("publishes one row per declared engine, with the capability fields FLATTENED onto the row", async () => {
    // The renderer's `ProviderRow extends EngineCapabilities` and
    // `SupportMatrixSection.tsx` reads `p.label`/`p.local`/`p.streaming`/
    // `p.toolCalling`/`p.vision`/`p.structuredOutput` directly off the row —
    // matching the Rust `#[serde(flatten)]`. Nesting them under a `caps` key
    // would blank every column of the published matrix.
    const matrix = await engineSupportMatrix(matrixDeps());
    expect(matrix.providers).toHaveLength(DECLARED.length);
    expect(matrix.providers.map((p) => p.engine)).toEqual(DECLARED.map((d) => d.id));
    const claude = matrix.providers.find((p) => p.engine === "claude-cli");
    expect(claude).toBeDefined();
    expect(claude?.label).toBe("Claude Code");
    expect(claude?.streaming).toBe("yes");
    expect(claude?.toolCalling).toBe("yes");
    // Provider-level rows stay per-model-agnostic where the decl says
    // "unknown"; vision is now a transport-level yes for Claude.
    expect(claude?.vision).toBe("unknown");
    expect(claude?.structuredOutput).toBe("no");
    expect(claude?.tier).toBe("cloud-engine");
    expect(claude?.available).toBe(false);
    expect(claude?.agents).toEqual([]);
    expect(Object.keys(claude ?? {})).not.toContain("caps");
    // A provider-level row is not about one model, so every per-model column
    // reads Unknown and the model string is empty.
    const openrouter = matrix.providers.find((p) => p.engine === "openrouter");
    expect(openrouter?.model).toBe("");
    expect(openrouter?.chat).toBe("unknown");
  });

  it("a sidecar that answers is REACHABLE and populates each tier's agents", async () => {
    let sent: { tiers: Record<string, string[]>; web_enabled: boolean } | null = null;
    const matrix = await engineSupportMatrix(
      matrixDeps({
        listModels: async () => ["qwen3.5:4b", "gpt-oss:120b-cloud"],
        detectedAdvisors: async () => ["claude-cli"],
        providerConnected: (p) => p === "openrouter",
        fetchAgentSupport: async (body) => {
          sent = body;
          return {
            agents: [
              { id: "web", label: "Web" },
              { id: "jobs", label: "Jobs" },
            ],
            tiers: { "local-engine": ["web", "jobs"], "cloud-engine": ["web"] },
          };
        },
      })
    );
    // One request carrying every DISTINCT tier, so the sidecar is asked once —
    // and `web_enabled` matches the flag the tool names were derived under.
    expect(sent).not.toBeNull();
    expect(Object.keys(sent!.tiers).sort()).toEqual(["cloud-engine", "local-engine"]);
    expect(sent!.web_enabled).toBe(true);
    expect(sent!.tiers["local-engine"]!.length).toBeGreaterThan(0);

    expect(matrix.agentsKnown).toBe(true);
    expect(matrix.agentsError).toBeNull();
    expect(matrix.agents).toHaveLength(2);
    expect(matrix.providers.find((p) => p.engine === "ollama")?.agents).toEqual(["web", "jobs"]);
    expect(matrix.providers.find((p) => p.engine === "ollama-cloud")?.agents).toEqual(["web"]);
    expect(matrix.providers.find((p) => p.engine === "claude-cli")?.agents).toEqual(["web"]);
    // Availability is read from real state, per engine.
    expect(matrix.providers.find((p) => p.engine === "ollama")?.available).toBe(true);
    expect(matrix.providers.find((p) => p.engine === "ollama-cloud")?.available).toBe(true);
    expect(matrix.providers.find((p) => p.engine === "claude-cli")?.available).toBe(true);
    expect(matrix.providers.find((p) => p.engine === "codex-cli")?.available).toBe(false);
    expect(matrix.providers.find((p) => p.engine === "openrouter")?.available).toBe(true);
  });

  it("a sidecar that cannot be reached says WHY, and the capability half is still published", async () => {
    const matrix = await engineSupportMatrix(
      matrixDeps({
        fetchAgentSupport: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    );
    expect(matrix.agentsKnown).toBe(false);
    expect(matrix.agentsError).toBe("ECONNREFUSED");
    expect(matrix.agents).toEqual([]);
    expect(matrix.providers).toHaveLength(DECLARED.length);
    expect(matrix.providers.every((p) => p.agents.length === 0)).toBe(true);
  });

  it("a reachable sidecar naming ZERO agents is KNOWN — an empty answer is a real answer", async () => {
    const matrix = await engineSupportMatrix(matrixDeps({ fetchAgentSupport: async () => ({ agents: [], tiers: {} }) }));
    expect(matrix.agentsKnown).toBe(true);
    expect(matrix.agentsError).toBeNull();
    expect(matrix.agents).toEqual([]);
  });

  it("an undecodable agent answer is a shape problem, not reported as unreachable silence", async () => {
    const matrix = await engineSupportMatrix(
      matrixDeps({ fetchAgentSupport: async () => ({ agents: { not: "a list" }, tiers: {} }) })
    );
    expect(matrix.agentsKnown).toBe(false);
    expect(matrix.agentsError).toContain("does not understand");
    // ...and so is a well-shaped list with one malformed entry.
    const partial = await engineSupportMatrix(
      matrixDeps({ fetchAgentSupport: async () => ({ agents: [{ id: "web", label: "Web" }, { id: "jobs" }] }) })
    );
    expect(partial.agentsKnown).toBe(false);
    expect(partial.agents).toEqual([]);
  });

  it("one malformed tier value defaults the WHOLE tier map, matching serde's all-or-nothing decode", async () => {
    const matrix = await engineSupportMatrix(
      matrixDeps({
        fetchAgentSupport: async () => ({
          agents: [{ id: "web", label: "Web" }],
          tiers: { "local-engine": ["web"], "cloud-engine": "not-a-list" },
        }),
      })
    );
    // The sidecar still ANSWERED, so the agent list is known...
    expect(matrix.agentsKnown).toBe(true);
    // ...but a half-decoded tier map would publish a table that is partly a
    // guess, so serde defaults the whole thing and so do we.
    expect(matrix.providers.every((p) => p.agents.length === 0)).toBe(true);
  });

  it("a listModels failure is 'nothing installed', not a failed matrix", async () => {
    const matrix = await engineSupportMatrix(
      matrixDeps({
        listModels: async () => {
          throw new Error("sidecar down");
        },
      })
    );
    expect(matrix.providers.find((p) => p.engine === "ollama")?.available).toBe(false);
    expect(matrix.providers).toHaveLength(DECLARED.length);
  });
});

// ============================================================================
// 7. enginePreflight / engineCapabilities — the room's model resolution
// ============================================================================

function queryDeps(models: string[], overrides: Partial<CapabilitiesForDeps> = {}) {
  return { ...fakeDeps(overrides), listModels: async () => models };
}

describe("enginePreflight / engineCapabilities", () => {
  it("an explicit model is used as-is, never overridden by the installed list", async () => {
    let listed = false;
    const caps = await engineCapabilities("qwen3.5:4b", {
      ...fakeDeps(),
      listModels: async () => {
        listed = true;
        return ["some-other:model"];
      },
    });
    expect(caps.model).toBe("qwen3.5:4b");
    expect(caps.engine).toBe("ollama");
    // The list is only fetched when it will actually be read.
    expect(listed).toBe(false);
  });

  it("no explicit model falls back to bestDefault over the installed list", async () => {
    // The tuned default in whatever build form it is actually installed as —
    // returning the bare constant is what asked Ollama for a tag that does not
    // exist on a Mac holding only the MLX build.
    const caps = await engineCapabilities(null, queryDeps(["qwen3.5:4b-mlx"]));
    expect(caps.model).toBe("qwen3.5:4b-mlx");
    expect(caps.engine).toBe("ollama");
  });

  it("a listModels failure still resolves a model rather than throwing", async () => {
    const caps = await engineCapabilities(null, {
      ...fakeDeps(),
      listModels: async () => {
        throw new Error("sidecar down");
      },
    });
    expect(caps.model.length).toBeGreaterThan(0);
    expect(caps.engine).toBe("ollama");
  });

  it("preflight composes capabilitiesFor with the resolved model", async () => {
    const verdict = await enginePreflight("antigravity-cli", "vision", queryDeps([]));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.code).toBe("capability");
      expect(verdict.reason).toContain("Antigravity CLI");
    }
    // Claude's stream-json image channel makes the same question pass now.
    expect(await enginePreflight("claude-cli", "vision", queryDeps([]))).toEqual({ status: "ready" });
    expect(await enginePreflight("claude-cli", "tool_calling", queryDeps([]))).toEqual({ status: "ready" });
  });

  it("preflight of an unreachable local engine is Unknown, never a refusal", async () => {
    const verdict = await enginePreflight(null, "tool_calling", queryDeps(["qwen3.5:4b"]));
    expect(verdict.status).toBe("unknown");
  });
});
