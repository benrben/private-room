/**
 * Tests for `providers.ts`, ported from `src-tauri/src/commands/providers.rs`.
 *
 * All nine of the Rust source's own `#[cfg(test)]` fixtures are ported below
 * (each keeps its Rust test name in the `it` title so the two can be diffed),
 * and past those this suite adds the real-behavior coverage the Rust file's
 * tests never reach:
 *
 *   - the network paths through the injected {@link ProviderDeps} seam, and
 *     once end-to-end against a REAL `node:http` server (this repo's
 *     convention — see `engineRouting.test.ts`) with the real global `fetch`;
 *   - a REAL macOS Keychain round trip, always under a throwaway service name
 *     so the shipped app's own `"Arcelle LLM Providers"` entry is never read,
 *     written or deleted.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_RETRY_AFTER_MS,
  KEYCHAIN_SERVICE,
  MEDIA_MODALITIES,
  OPENROUTER_BASE_URL,
  OPENROUTER_ID,
  catalogRetryDue,
  clearKeyRejected,
  connectAiProvider,
  deleteKey,
  defaultProviderDeps,
  disconnectAiProvider,
  ensureProviderCatalog,
  injectProviderRuntime,
  isApiProviderModel,
  keyRejected,
  listAiProviders,
  listProviderModels,
  mediaCatalogPath,
  noteKeyRejected,
  openrouterKey,
  parseOpenrouterModels,
  providerConnected,
  providerModelFacts,
  providerModelSelectable,
  providerModelVision,
  providerRuntimeConfig,
  providerRuntimeConfigWire,
  readKey,
  readProviderKeyOnce,
  resetProviderStateForTests,
  storeKey,
  type HttpJsonResponseLike,
  type ProviderDeps,
} from "./providers.js";

beforeEach(() => {
  resetProviderStateForTests();
});

/** A service name distinct from the real `"Arcelle LLM Providers"` the shipped
 * app uses, so nothing here can collide with (or delete) a real saved
 * OpenRouter key. Every real-Keychain call below passes it explicitly. */
const TEST_SERVICE = "ArcelleProvidersPortTest";

/** A provider/account id no real installation ever stores, so a lookup against
 * the REAL default deps is genuinely harmless. */
function fakeProvider(): string {
  return `provider-under-test-${randomUUID()}`;
}

function jsonResponse(status: number, body: unknown): HttpJsonResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Deps whose every member throws, so a test can prove a code path reached
 * neither the Keychain nor the network. Override only what it should reach. */
function forbiddenDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  const forbid = (what: string) => () => {
    throw new Error(`${what} must not be called`);
  };
  return {
    readKey: forbid("readKey"),
    storeKey: forbid("storeKey"),
    deleteKey: forbid("deleteKey"),
    fetchJson: forbid("fetchJson"),
    ...overrides,
  };
}

it("installed E2E reviews isolate provider credentials from the login Keychain", () => {
  const previous = process.env.ARCELLE_E2E;
  process.env.ARCELLE_E2E = "1";
  try {
    defaultProviderDeps.storeKey("review-provider", "temporary-review-key");
    expect(defaultProviderDeps.readKey("review-provider")).toBe("temporary-review-key");
    defaultProviderDeps.deleteKey("review-provider");
    expect(() => defaultProviderDeps.readKey("review-provider")).toThrow(/No API key is saved/);
  } finally {
    if (previous === undefined) delete process.env.ARCELLE_E2E;
    else process.env.ARCELLE_E2E = previous;
  }
});

it("reads or rejects one provider Keychain item only once per app session", () => {
  let successfulReads = 0;
  expect(readProviderKeyOnce("cached-success", () => {
    successfulReads += 1;
    return "session-key";
  })).toBe("session-key");
  expect(readProviderKeyOnce("cached-success", () => {
    successfulReads += 1;
    return "different-key";
  })).toBe("session-key");
  expect(successfulReads).toBe(1);

  let deniedReads = 0;
  const denied = () => readProviderKeyOnce("cached-denial", () => {
    deniedReads += 1;
    throw new Error("Keychain access was denied.");
  });
  expect(denied).toThrow("Keychain access was denied.");
  expect(denied).toThrow("Keychain access was denied.");
  expect(deniedReads).toBe(1);
});

// ===========================================================================
// Ported Rust fixtures
// ===========================================================================

describe("parseOpenrouterModels", () => {
  it("openrouter_catalog_metadata_drives_capabilities", () => {
    const models = parseOpenrouterModels({
      data: [
        {
          id: "vendor/vision-agent",
          name: "Vision Agent",
          description: "A live catalog entry",
          context_length: 262144,
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: ["tools", "reasoning", "structured_outputs"],
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });
    expect(models).toHaveLength(1);
    const model = models[0]!;
    expect(model.slug).toBe("vendor/vision-agent");
    expect(model.contextWindow).toBe(262_144);
    expect(model.tools).toBe(true);
    expect(model.vision).toBe(true);
    expect(model.reasoning).toBe(true);
    expect(model.structuredOutputs).toBe(true);
    expect(model.inputPrice).toBe("0.000001");
    expect(model.outputPrice).toBe("0.000002");
    expect(model.description).toBe("A live catalog entry");
    // Reads pictures, does not make them. The Create page's whole shelf turns
    // on these two staying apart from `vision`.
    expect(model.imageOutput).toBe(false);
    expect(model.videoOutput).toBe(false);
  });

  it("output_modalities_are_what_says_a_model_can_draw", () => {
    const models = parseOpenrouterModels({
      data: [
        { id: "vendor/painter", name: "Painter", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
        {
          id: "vendor/mover",
          name: "Mover",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["video"] },
        },
        {
          // The trap a name test falls into: "image" and "vision" in the slug,
          // image INPUT, and no ability to draw whatsoever.
          id: "vendor/qwen-image-vision",
          name: "Image Reader",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        },
        {
          // A catalog entry that declares no modalities at all. Silence is not
          // permission — this must not read as "can draw".
          id: "vendor/silent",
          name: "Silent",
        },
      ],
    });
    const by = (slug: string) => {
      const found = models.find((m) => m.slug === slug);
      if (!found) throw new Error(`model ${slug} not present`);
      return found;
    };

    const painter = by("vendor/painter");
    expect(painter.imageOutput && !painter.videoOutput).toBe(true);
    expect(painter.vision, "text-in: it draws, it does not read pictures").toBe(false);

    const mover = by("vendor/mover");
    expect(mover.videoOutput && !mover.imageOutput).toBe(true);
    expect(mover.vision, "takes a source still").toBe(true);

    const reader = by("vendor/qwen-image-vision");
    expect(reader.vision, "it does read pictures").toBe(true);
    expect(
      !reader.imageOutput && !reader.videoOutput,
      "a slug saying 'image' must never be mistaken for the ability to make one",
    ).toBe(true);

    const silent = by("vendor/silent");
    expect(silent.outputModalities).toEqual([]);
    expect(silent.imageOutput || silent.videoOutput).toBe(false);
  });

  it("a_media_model_parses_from_the_shape_the_filtered_catalog_returns", () => {
    // Verbatim shape of `GET /models?output_modalities=video`, captured live
    // 2026-08-08. Media entries differ from chat entries in three ways that
    // all have to survive: `context_length` is 0, there are no
    // `supported_parameters` at all, and per-token pricing is "0" because
    // these are billed per second. None of that may cause a drop.
    const models = parseOpenrouterModels({
      data: [
        {
          id: "black-forest-labs/flux-3-video",
          name: "Black Forest Labs: FLUX.3 Video",
          description: "A video generation model.",
          context_length: 0,
          architecture: {
            modality: "text+image+video->video",
            input_modalities: ["text", "image", "video"],
            output_modalities: ["video"],
            tokenizer: "Media",
          },
          supported_parameters: [],
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    });
    expect(models, "a media entry must not be dropped").toHaveLength(1);
    const model = models[0]!;
    expect(model.slug).toBe("black-forest-labs/flux-3-video");
    expect(model.videoOutput, "this is the whole reason it is listed").toBe(true);
    expect(model.imageOutput, "it makes clips, not stills").toBe(false);
    // It takes a source still/clip, which is image INPUT — the axis that must
    // never be confused with the ability to produce one.
    expect(model.vision).toBe(true);
    expect(model.tools || model.structuredOutputs).toBe(false);
    // `context_length: 0` is a real zero, not "the catalog said nothing".
    expect(model.contextWindow).toBe(0);
  });
});

describe("mediaCatalogPath", () => {
  it("the_media_catalog_is_asked_of_the_endpoint_that_actually_filters", () => {
    // This shipped wrong once and the symptom was silent: the Create page read
    // "Video 0" while OpenRouter served 21 video models. The cause was asking
    // `/models/user`, which IGNORES an unsupported query parameter and answers
    // with the ordinary chat catalogue — so the merge found no new slugs and
    // nothing anywhere reported a failure.
    for (const modality of MEDIA_MODALITIES) {
      const path = mediaCatalogPath(modality);
      expect(
        path.startsWith("/models?"),
        `media catalogues must come from the PUBLIC /models, which honours the filter — ` +
          `/models/user silently does not: ${path}`,
      ).toBe(true);
      expect(path.includes("/models/user"), `got: ${path}`).toBe(false);
      expect(path.endsWith(`output_modalities=${modality}`), `got: ${path}`).toBe(true);
    }
    expect(mediaCatalogPath("video")).toBe("/models?output_modalities=video");
  });
});

describe("isApiProviderModel", () => {
  it("provider_model_detection_requires_the_composite_prefix", () => {
    expect(isApiProviderModel("openrouter::anthropic/claude")).toBe(true);
    expect(isApiProviderModel("openrouter-ish")).toBe(false);
    expect(isApiProviderModel("qwen3.5:4b")).toBe(false);
  });
});

describe("rejected keys / providerConnected", () => {
  it("a_rejected_key_stops_reading_as_connected", () => {
    // The badge used to mean only "a key is saved on this Mac", so a cancelled
    // or expired key left Settings looking healthy until a question failed.
    // A provider id no installation stores, exactly like the Rust source's own
    // "provider-under-test", so this runs against the REAL default deps (a
    // real Keychain miss) with no risk to a real saved key.
    const p = fakeProvider();
    clearKeyRejected(p);
    expect(keyRejected(p)).toBe(false);
    expect(providerConnected(p), "no key saved for a fake provider").toBe(false);
    noteKeyRejected(p);
    expect(keyRejected(p)).toBe(true);
    expect(providerConnected(p)).toBe(false);
    clearKeyRejected(p);
    expect(keyRejected(p)).toBe(false);
  });
});

describe("catalogRetryDue", () => {
  it("a_failed_catalog_fetch_is_not_retried_in_front_of_every_ai_call", () => {
    // `catalogLoaded` is set only on SUCCESS, so the guard never
    // short-circuits after a failure: offline, the full `/models/user` request
    // (30s timeout) was re-issued ahead of each AI call, and with an expired
    // key each one 401'd again.
    expect(catalogRetryDue(null), "the first attempt is always due").toBe(true);
    expect(catalogRetryDue(0)).toBe(false);
    expect(catalogRetryDue(CATALOG_RETRY_AFTER_MS - 1)).toBe(false);
    // …but a transient failure is not permanent either: after the window, the
    // next call tries again.
    expect(catalogRetryDue(CATALOG_RETRY_AFTER_MS)).toBe(true);
    expect(catalogRetryDue(CATALOG_RETRY_AFTER_MS * 2)).toBe(true);
  });

  it("the window is the five minutes the Rust source sets", () => {
    // Pinned as a literal: an assertion written against the exported constant
    // it is checking could never fail.
    expect(CATALOG_RETRY_AFTER_MS).toBe(5 * 60 * 1000);
  });
});

describe("ensureProviderCatalog", () => {
  it("ensure_provider_catalog_ignores_non_provider_models", async () => {
    // `capabilities.ts` calls this on the ask path for EVERY model, including
    // the local ones `visionSupport` loops over when picking a describe pass —
    // so a local name must never reach the network or the Keychain.
    //
    // Asserting only that the call RESOLVES cannot prove that, and deps that
    // THROW prove even less: `ensureProviderCatalog` swallows every error by
    // design (the Rust source's `let _ = list_provider_models(…).await;`), so
    // both spellings resolve to `undefined` whether the guard held or not.
    // Verified by mutation — deleting the `isApiProviderModel` guard outright
    // left the old form of this test green. The proof has to be that the deps
    // were never ENTERED, so they succeed here and are counted instead.
    const cases = [
      "qwen3.5:4b",
      "claude-cli::opus",
      // A provider prefix with no model chosen has nothing to look up either.
      "openrouter::",
      "openrouter::   ",
      "openrouter",
    ];
    for (const model of cases) {
      // Per case, not once for the list: a leaked guard would stamp the
      // retry timestamp on the first model and then short-circuit every later
      // one inside the 5-minute window, so a single shared counter would only
      // ever test the first name here.
      resetProviderStateForTests();
      const touched: string[] = [];
      const deps: ProviderDeps = {
        readKey: () => {
          touched.push("readKey");
          return "a-key";
        },
        storeKey: () => {
          touched.push("storeKey");
        },
        deleteKey: () => {
          touched.push("deleteKey");
        },
        fetchJson: async () => {
          touched.push("fetchJson");
          return jsonResponse(200, { data: [] });
        },
      };
      await expect(ensureProviderCatalog(model, deps)).resolves.toBeUndefined();
      expect(touched, `"${model}" must reach neither the Keychain nor the network`).toEqual([]);
    }
  });
});

describe("providerRuntimeConfigWire", () => {
  it("runtime_config_uses_the_python_sidecar_field_names", () => {
    // Rust's `ProviderRuntimeConfig` has NO `rename_all = "camelCase"` (its
    // sibling `ProviderStatus` does), and the sidecar's `ProviderConfig` reads
    // these snake_case names with `extra="ignore"` — so a camelCase object
    // would have every field silently dropped and then fail validation on the
    // required `api_key` that never arrived.
    const wire = providerRuntimeConfigWire({
      id: "openrouter",
      apiKey: "secret",
      baseUrl: OPENROUTER_BASE_URL,
      model: "vendor/model",
      contextWindow: 128_000,
      supportsTools: true,
    });
    expect(wire.api_key).toBe("secret");
    expect(wire.base_url).toBe(OPENROUTER_BASE_URL);
    expect(wire.context_window).toBe(128_000);
    expect(wire.supports_tools).toBe(true);
    expect(wire).not.toHaveProperty("apiKey");
    expect(wire).not.toHaveProperty("baseUrl");
    expect(wire).not.toHaveProperty("contextWindow");
    expect(wire).not.toHaveProperty("supportsTools");
  });
});

// ===========================================================================
// Beyond the Rust fixtures — parsing edge cases
// ===========================================================================

describe("parseOpenrouterModels (edge cases)", () => {
  it("skips an entry with no id rather than throwing, matching Rust's filter_map", () => {
    const models = parseOpenrouterModels({ data: [{ name: "No id here" }, { id: "vendor/ok", name: "Ok" }] });
    expect(models.map((m) => m.slug)).toEqual(["vendor/ok"]);
  });

  it("falls back to the slug as the label when name is absent", () => {
    expect(parseOpenrouterModels({ data: [{ id: "vendor/unnamed" }] })[0]!.label).toBe("vendor/unnamed");
  });

  it("tolerates a completely malformed payload", () => {
    expect(parseOpenrouterModels(null)).toEqual([]);
    expect(parseOpenrouterModels("a string")).toEqual([]);
    expect(parseOpenrouterModels({})).toEqual([]);
    expect(parseOpenrouterModels({ data: "not an array" })).toEqual([]);
  });

  it("sorts case-insensitively by label, by code point rather than by locale", () => {
    const models = parseOpenrouterModels({
      data: [
        { id: "a", name: "zebra" },
        { id: "b", name: "Apple" },
        { id: "c", name: "mango" },
      ],
    });
    expect(models.map((m) => m.label)).toEqual(["Apple", "mango", "zebra"]);
  });

  it("reads context_length only when it really is an unsigned integer, like Rust's as_u64", () => {
    const window = (contextLength: unknown) =>
      parseOpenrouterModels({ data: [{ id: "x", context_length: contextLength }] })[0]!.contextWindow;
    expect(window(128_000)).toBe(128_000);
    expect(window(0)).toBe(0);
    // A negative, fractional or non-numeric value is "the catalog said
    // nothing", never a rounded guess.
    expect(window(-1)).toBeNull();
    expect(window(1.5)).toBeNull();
    expect(window("128000")).toBeNull();
    expect(window(undefined)).toBeNull();
  });
});

// ===========================================================================
// The catalog fetch, through the injected deps seam
// ===========================================================================

describe("listProviderModels (fetchOpenrouterModels)", () => {
  it("merges the chat catalogue with both media catalogues, de-duplicated by slug", async () => {
    const requestedPaths: string[] = [];
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async (url, init) => {
        expect(init.headers.Authorization).toBe("Bearer a-key");
        expect(init.headers["HTTP-Referer"]).toBe("https://arcelle.app");
        expect(init.headers["X-OpenRouter-Title"]).toBe("Arcelle");
        const path = url.replace(OPENROUTER_BASE_URL, "");
        requestedPaths.push(path);
        if (path === "/models/user") {
          return jsonResponse(200, {
            data: [
              { id: "vendor/chat", name: "Chat Model" },
              // Also present in the video catalogue below — the merge must not
              // duplicate it.
              { id: "vendor/dual", name: "Dual Purpose" },
            ],
          });
        }
        if (path === mediaCatalogPath("image")) {
          return jsonResponse(200, { data: [{ id: "vendor/painter", name: "Painter" }] });
        }
        if (path === mediaCatalogPath("video")) {
          return jsonResponse(200, {
            data: [
              { id: "vendor/dual", name: "Dual Purpose" },
              { id: "vendor/mover", name: "Mover" },
            ],
          });
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });
    const models = await listProviderModels(OPENROUTER_ID, deps);
    expect(requestedPaths).toEqual(["/models/user", mediaCatalogPath("image"), mediaCatalogPath("video")]);
    // Sorted by lowercased label across all three batches, not merely
    // concatenated in arrival order.
    expect(models.map((m) => m.label)).toEqual(["Chat Model", "Dual Purpose", "Mover", "Painter"]);
    expect(models.filter((m) => m.slug === "vendor/dual")).toHaveLength(1);
  });

  it("a failed media catalogue is non-fatal: the chat catalogue's models still come back", async () => {
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async (url) => {
        if (url.endsWith("/models/user")) {
          return jsonResponse(200, { data: [{ id: "vendor/chat", name: "Chat Model" }] });
        }
        return jsonResponse(500, { error: { message: "media catalogue down" } });
      },
    });
    expect((await listProviderModels(OPENROUTER_ID, deps)).map((m) => m.slug)).toEqual(["vendor/chat"]);
  });

  it("a 401 on the primary catalogue marks the key rejected and refuses with a clear message", async () => {
    const deps = forbiddenDeps({
      readKey: () => "bad-key",
      fetchJson: async () => jsonResponse(401, { error: { message: "Invalid API key" } }),
    });
    expect(keyRejected(OPENROUTER_ID)).toBe(false);
    await expect(listProviderModels(OPENROUTER_ID, deps)).rejects.toThrow("OpenRouter rejected this API key.");
    expect(keyRejected(OPENROUTER_ID)).toBe(true);
    // …and that alone is enough to stop the badge claiming a connection, even
    // though a key IS still saved.
    expect(providerConnected(OPENROUTER_ID, { ...deps, readKey: () => "bad-key" })).toBe(false);
  });

  it("a catalogue that now succeeds clears an earlier rejection, with no reconnect", async () => {
    // Credit runs out → 401 → the badge goes red. Credit is added back, and
    // the very next catalogue refresh (opening the model picker) has to turn
    // it green again: `fetchOpenrouterModels` clears the flag itself, so
    // recovery does not require pasting the same working key in a second time.
    //
    // Deliberately NOT via `connectAiProvider`, which clears the flag again on
    // its own line — routing through it would test that call instead of this
    // one, and leave this path unpinned (it was: deleting the clear here left
    // the suite green).
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async (url) =>
        url.endsWith("/models/user")
          ? jsonResponse(200, { data: [{ id: "vendor/ok", name: "Ok" }] })
          : jsonResponse(200, { data: [] }),
    });
    noteKeyRejected(OPENROUTER_ID);
    expect(providerConnected(OPENROUTER_ID, deps)).toBe(false);
    await listProviderModels(OPENROUTER_ID, deps);
    expect(keyRejected(OPENROUTER_ID), "the successful refresh IS the proof the key works").toBe(false);
    expect(providerConnected(OPENROUTER_ID, deps)).toBe(true);
  });

  it("a non-401 error surfaces OpenRouter's own error message", async () => {
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async () => jsonResponse(500, { error: { message: "boom" } }),
    });
    await expect(listProviderModels(OPENROUTER_ID, deps)).rejects.toThrow("OpenRouter error (500): boom");
  });

  it("falls back to a generic message when the error body carries none", async () => {
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async () => jsonResponse(503, "not even json-shaped"),
    });
    await expect(listProviderModels(OPENROUTER_ID, deps)).rejects.toThrow(
      "OpenRouter error (503): OpenRouter rejected the request",
    );
  });

  it("a network failure is wrapped in a friendly message", async () => {
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    await expect(listProviderModels(OPENROUTER_ID, deps)).rejects.toThrow("Could not reach OpenRouter");
  });

  it("rejects an unknown provider before ever touching the Keychain or the network", async () => {
    await expect(listProviderModels("not-a-real-provider", forbiddenDeps())).rejects.toThrow(
      "Unknown AI provider: not-a-real-provider",
    );
  });
});

describe("providerModelFacts / providerModelVision", () => {
  it("is undefined for a model the catalog has never reported on", () => {
    expect(providerModelFacts("openrouter::vendor/never-seen")).toBeUndefined();
    expect(providerModelVision("openrouter::vendor/never-seen")).toBeUndefined();
  });

  it("is undefined for a bare model with no composite selection", () => {
    expect(providerModelFacts("qwen3.5:4b")).toBeUndefined();
    expect(providerModelVision("qwen3.5:4b")).toBeUndefined();
  });

  it("reflects the catalog once the model has been fetched", async () => {
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async (url) =>
        url.endsWith("/models/user")
          ? jsonResponse(200, {
              data: [
                {
                  id: "vendor/vision-agent",
                  name: "Vision Agent",
                  context_length: 200_000,
                  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
                  supported_parameters: ["tools", "response_format"],
                },
              ],
            })
          : jsonResponse(200, { data: [] }),
    });
    await listProviderModels(OPENROUTER_ID, deps);
    expect(providerModelFacts("openrouter::vendor/vision-agent")).toEqual({
      contextWindow: 200_000,
      tools: true,
      vision: true,
      structuredOutputs: true,
      imageOutput: false,
      videoOutput: false,
    });
    expect(providerModelVision("openrouter::vendor/vision-agent")).toBe(true);
    // An effort suffix still names the same slug.
    expect(providerModelVision("openrouter::vendor/vision-agent::high")).toBe(true);
  });
});

// ===========================================================================
// ensureProviderCatalog's single-flight + retry policy, with a real clock
// ===========================================================================

describe("ensureProviderCatalog (fetch policy)", () => {
  it("does nothing once the model is already known in the cache", async () => {
    let calls = 0;
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async () => {
        calls += 1;
        return jsonResponse(200, { data: [{ id: "vendor/known", name: "Known" }] });
      },
    });
    // Prime the cache through the same path the app uses. One
    // `listProviderModels` makes three requests: the chat catalogue plus the
    // two media catalogues.
    await listProviderModels(OPENROUTER_ID, deps);
    expect(calls).toBe(3);
    await ensureProviderCatalog("openrouter::vendor/known", deps);
    expect(calls, "the model was already cached").toBe(3);
  });

  it("single-flights concurrent callers into one attempt, and never refetches after a success", async () => {
    let chatRequests = 0;
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async (url) => {
        if (url.endsWith("/models/user")) chatRequests += 1;
        return jsonResponse(200, { data: [{ id: "vendor/solo", name: "Solo" }] });
      },
    });
    await Promise.all([
      ensureProviderCatalog("openrouter::vendor/solo", deps),
      ensureProviderCatalog("openrouter::vendor/solo", deps),
      ensureProviderCatalog("openrouter::vendor/solo", deps),
    ]);
    expect(chatRequests).toBe(1);
    // The catalog is loaded now, so even an UNKNOWN slug must not trigger
    // another fetch for the rest of the process's life.
    await ensureProviderCatalog("openrouter::vendor/unknown-slug", deps);
    expect(chatRequests).toBe(1);
  });

  it("never refetches after a SUCCESS, even once the retry window has elapsed", async () => {
    // `catalogLoaded` and the retry window are two DIFFERENT guards, and the
    // window hides the latch: inside those five minutes a missing
    // `catalogLoaded = true` is indistinguishable from a working one, so a
    // same-tick assertion passes either way (verified by mutation — deleting
    // the latch left the rest of this suite green). Only a clock past the
    // window separates them.
    let chatRequests = 0;
    const deps = forbiddenDeps({
      readKey: () => "a-key",
      fetchJson: async (url) => {
        if (url.endsWith("/models/user")) chatRequests += 1;
        return jsonResponse(200, { data: [{ id: "vendor/solo", name: "Solo" }] });
      },
    });
    await ensureProviderCatalog("openrouter::vendor/solo", deps);
    expect(chatRequests).toBe(1);

    // A SUCCESSFUL fetch is final for the process. Without the latch, any slug
    // the catalogue never listed would re-fetch the whole thing every five
    // minutes forever — the retry window exists for FAILURES only.
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + CATALOG_RETRY_AFTER_MS * 10);
    try {
      await ensureProviderCatalog("openrouter::vendor/never-listed", deps);
    } finally {
      spy.mockRestore();
    }
    expect(chatRequests, "a successful catalog fetch is never repeated").toBe(1);
  });

  it("does not repeat a FAILED attempt inside the retry window", async () => {
    let readAttempts = 0;
    const deps = forbiddenDeps({
      readKey: () => {
        readAttempts += 1;
        throw new Error("no key saved");
      },
    });
    await ensureProviderCatalog("openrouter::vendor/unknown", deps);
    expect(readAttempts).toBe(1);
    await ensureProviderCatalog("openrouter::vendor/unknown", deps);
    expect(readAttempts, "still inside the 5-minute retry window").toBe(1);
  });
});

// ===========================================================================
// connect / disconnect / list
// ===========================================================================

describe("connectAiProvider", () => {
  it("rejects an unknown provider", async () => {
    await expect(connectAiProvider("not-a-real-provider", "sk-x", forbiddenDeps())).rejects.toThrow(
      "Unknown AI provider: not-a-real-provider",
    );
  });

  it("rejects a blank API key without ever calling the network", async () => {
    await expect(connectAiProvider(OPENROUTER_ID, "   ", forbiddenDeps())).rejects.toThrow("Enter an API key.");
  });

  it("on success, stores the TRIMMED key, clears any rejection, and returns the model count", async () => {
    let stored: [string, string] | undefined;
    const deps = forbiddenDeps({
      storeKey: (provider, key) => {
        stored = [provider, key];
      },
      fetchJson: async (url, init) => {
        expect(init.headers.Authorization, "the trimmed key is what gets tested").toBe("Bearer sk-live-123");
        return url.endsWith("/models/user")
          ? jsonResponse(200, {
              data: [
                { id: "vendor/a", name: "A" },
                { id: "vendor/b", name: "B" },
              ],
            })
          : jsonResponse(200, { data: [] });
      },
    });
    noteKeyRejected(OPENROUTER_ID);
    expect(await connectAiProvider(OPENROUTER_ID, "  sk-live-123  ", deps)).toBe(2);
    expect(stored, "the key is stored trimmed, and only after the catalog accepted it").toEqual([
      OPENROUTER_ID,
      "sk-live-123",
    ]);
    // A freshly accepted key clears any earlier rejection, so the badge is
    // green again the moment the user pastes a working one.
    expect(keyRejected(OPENROUTER_ID)).toBe(false);
  });

  it("does not store the key when the catalog fetch fails", async () => {
    let storeCalled = false;
    const deps = forbiddenDeps({
      storeKey: () => {
        storeCalled = true;
      },
      fetchJson: async () => jsonResponse(401, {}),
    });
    await expect(connectAiProvider(OPENROUTER_ID, "sk-bad", deps)).rejects.toThrow("OpenRouter rejected this API key.");
    expect(storeCalled, "a key the provider refused must never be saved").toBe(false);
  });
});

describe("disconnectAiProvider", () => {
  it("clears the rejection flag and deletes the stored key", () => {
    let deletedFor: string | undefined;
    const deps = forbiddenDeps({
      deleteKey: (provider) => {
        deletedFor = provider;
      },
    });
    noteKeyRejected(OPENROUTER_ID);
    disconnectAiProvider(OPENROUTER_ID, deps);
    expect(deletedFor).toBe(OPENROUTER_ID);
    expect(keyRejected(OPENROUTER_ID)).toBe(false);
  });

  it("rejects an unknown provider before touching the Keychain", () => {
    expect(() => disconnectAiProvider("not-a-real-provider", forbiddenDeps())).toThrow("Unknown AI provider");
  });
});

describe("listAiProviders", () => {
  it("reports OpenRouter's connected state from the injected deps", () => {
    expect(listAiProviders(forbiddenDeps({ readKey: () => "sk-real" }))).toEqual([
      { id: "openrouter", label: "OpenRouter", connected: true },
    ]);
    expect(listAiProviders(forbiddenDeps({ readKey: () => "   " }))).toEqual([
      { id: "openrouter", label: "OpenRouter", connected: false },
    ]);
    expect(listAiProviders(forbiddenDeps())).toEqual([{ id: "openrouter", label: "OpenRouter", connected: false }]);
  });
});

describe("openrouterKey", () => {
  it("is the saved key verbatim, or null when it is missing or blank", () => {
    expect(openrouterKey(forbiddenDeps({ readKey: () => " sk-padded " }))).toBe(" sk-padded ");
    expect(openrouterKey(forbiddenDeps({ readKey: () => "   " }))).toBeNull();
    expect(openrouterKey(forbiddenDeps())).toBeNull();
  });
});

// ===========================================================================
// providerRuntimeConfig / injectProviderRuntime
// ===========================================================================

describe("providerRuntimeConfig", () => {
  it("returns null for a non-OpenRouter (local, or external-CLI) model", () => {
    expect(providerRuntimeConfig("qwen3.5:4b", forbiddenDeps())).toBeNull();
    expect(providerRuntimeConfig("claude-cli::opus", forbiddenDeps())).toBeNull();
  });

  it("throws when no specific model was chosen", () => {
    const deps = forbiddenDeps();
    expect(() => providerRuntimeConfig("openrouter", deps)).toThrow("Choose a specific OpenRouter model first.");
    expect(() => providerRuntimeConfig("openrouter::", deps)).toThrow("Choose a specific OpenRouter model first.");
    expect(() => providerRuntimeConfig("openrouter::   ", deps)).toThrow("Choose a specific OpenRouter model first.");
  });

  it("throws a room-facing message naming Settings when the key is no longer saved", () => {
    // The generic Keychain error used to be replaced upstream by "AI engine
    // unavailable — the agent sidecar could not start", which blames the wrong
    // thing entirely.
    expect(() => providerRuntimeConfig("openrouter::vendor/model", forbiddenDeps())).toThrow(
      /no OpenRouter API key is saved on this Mac[\s\S]*Settings → Cloud AI/,
    );
  });

  it("builds a full config, reading declared facts from the cache when present", async () => {
    const deps = forbiddenDeps({
      readKey: () => "sk-real",
      fetchJson: async (url) =>
        url.endsWith("/models/user")
          ? jsonResponse(200, {
              data: [{ id: "vendor/tooly", name: "Tooly", context_length: 128_000, supported_parameters: ["tools"] }],
            })
          : jsonResponse(200, { data: [] }),
    });
    await listProviderModels(OPENROUTER_ID, deps);
    expect(providerRuntimeConfig("openrouter::vendor/tooly", deps)).toEqual({
      id: "openrouter",
      apiKey: "sk-real",
      baseUrl: OPENROUTER_BASE_URL,
      model: "vendor/tooly",
      contextWindow: 128_000,
      supportsTools: true,
    });
  });

  it("sends the exact OpenRouter catalog ID and refuses its display label", async () => {
    const deps = forbiddenDeps({
      readKey: () => "sk-real",
      fetchJson: async (url) =>
        url.endsWith("/models/user")
          ? jsonResponse(200, {
              data: [{
                id: "openai/gpt-oss-20b",
                name: "OpenAI: gpt-oss-20b",
                context_length: 131_072,
                supported_parameters: ["tools"],
              }],
            })
          : jsonResponse(200, { data: [] }),
    });

    const catalog = await listProviderModels(OPENROUTER_ID, deps);
    expect(catalog[0]).toMatchObject({
      slug: "openai/gpt-oss-20b",
      label: "OpenAI: gpt-oss-20b",
    });
    expect(providerRuntimeConfig("openrouter::openai/gpt-oss-20b", deps)?.model)
      .toBe("openai/gpt-oss-20b");
    expect(() => providerRuntimeConfig("openrouter::OpenAI: gpt-oss-20b", deps)).toThrow(
      /display name, not a model ID[\s\S]*Settings → Model/,
    );
  });

  it("defaults to supportsTools=true and contextWindow=null when the model is not in the cache", () => {
    const config = providerRuntimeConfig("openrouter::vendor/never-fetched", forbiddenDeps({ readKey: () => "sk" }));
    expect(config?.contextWindow).toBeNull();
    expect(config?.supportsTools).toBe(true);
  });

  it("removes only surrounding whitespace and keeps the exact catalog slug", async () => {
    const deps = forbiddenDeps({
      readKey: () => "sk-real",
      fetchJson: async (url) =>
        url.endsWith("/models/user")
          ? jsonResponse(200, {
              data: [{ id: "vendor/padded", name: "Padded", context_length: 42, supported_parameters: [] }],
            })
          : jsonResponse(200, { data: [] }),
    });
    await listProviderModels(OPENROUTER_ID, deps);

    const config = providerRuntimeConfig("openrouter::  vendor/padded  ", deps);
    expect(config?.model).toBe("vendor/padded");
    expect(config?.contextWindow).toBe(42);
    expect(config?.supportsTools).toBe(false);
    expect(providerModelFacts("openrouter::  vendor/padded  ")?.contextWindow).toBe(42);
  });
});

describe("injectProviderRuntime", () => {
  it("passes a non-provider model's body through unchanged", () => {
    const body = { messages: [] };
    expect(injectProviderRuntime(body, "qwen3.5:4b", forbiddenDeps())).toBe(body);
  });

  it("attaches the SNAKE_CASE wire config for a provider model, leaving the rest of the body alone", () => {
    const body = { model: "openrouter::vendor/model", messages: [{ role: "user", content: "hi" }] };
    const out = injectProviderRuntime(body, "openrouter::vendor/model", forbiddenDeps({ readKey: () => "sk-real" })) as
      Record<string, unknown>;
    expect(out.messages).toEqual(body.messages);
    expect(out.model).toBe("openrouter::vendor/model");
    expect(out.provider).toEqual({
      id: "openrouter",
      api_key: "sk-real",
      base_url: OPENROUTER_BASE_URL,
      model: "vendor/model",
      context_window: null,
      supports_tools: true,
    });
    // The input is not mutated — the Rust source clones before inserting.
    expect(body).not.toHaveProperty("provider");
  });

  it("refuses a non-object body for a provider model", () => {
    const deps = forbiddenDeps({ readKey: () => "sk-real" });
    expect(() => injectProviderRuntime([1, 2, 3], "openrouter::vendor/model", deps)).toThrow(
      "Sidecar request body must be an object",
    );
    expect(() => injectProviderRuntime("a string", "openrouter::vendor/model", deps)).toThrow(
      "Sidecar request body must be an object",
    );
  });
});

// ===========================================================================
// End-to-end against a REAL local HTTP server, through the REAL global fetch.
//
// The deps seam only rewrites the host: `fetchJson` still calls the real
// `fetch` with the real headers and the real abort signal the module built,
// so this exercises the actual HTTP round trip (status codes, JSON body
// parsing, 401 handling) rather than a hand-made response object.
// ===========================================================================

describe("catalog fetch over real HTTP", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  async function startServer(
    handler: (url: string) => { status: number; body: unknown },
  ): Promise<ProviderDeps> {
    const server = http.createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise((r) => server.close(() => r()));
    const base = `http://127.0.0.1:${port}`;
    return forbiddenDeps({
      readKey: () => "sk-live",
      fetchJson: (url, init) =>
        fetch(url.replace(OPENROUTER_BASE_URL, base), init) as unknown as Promise<HttpJsonResponseLike>,
    });
  }

  it("merges all three catalogues off the wire and fills the capability cache", async () => {
    const deps = await startServer((url) => {
      if (url === "/models/user") return { status: 200, body: { data: [{ id: "vendor/zeta", name: "Zeta Chat" }] } };
      if (url === "/models?output_modalities=image") {
        return {
          status: 200,
          body: { data: [{ id: "vendor/alpha", name: "Alpha Painter", architecture: { output_modalities: ["image"] } }] },
        };
      }
      if (url === "/models?output_modalities=video") {
        return {
          status: 200,
          body: {
            data: [
              {
                id: "vendor/beta",
                name: "Beta Mover",
                architecture: { input_modalities: ["text"], output_modalities: ["video"] },
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });

    const models = await listProviderModels(OPENROUTER_ID, deps);
    expect(models.map((m) => m.slug)).toEqual(["vendor/alpha", "vendor/beta", "vendor/zeta"]);
    expect(providerModelFacts("openrouter::vendor/alpha")?.imageOutput).toBe(true);
    expect(providerModelFacts("openrouter::vendor/beta")?.videoOutput).toBe(true);
    expect(providerModelVision("openrouter::vendor/beta")).toBe(false);
    expect(providerModelSelectable("openrouter::vendor/zeta")).toBe(true);
    // Supplementary public media rows are capability metadata, not proof that
    // this account may select the ID for a chat/agent run.
    expect(providerModelSelectable("openrouter::vendor/alpha")).toBe(false);
    expect(providerModelSelectable("openrouter::vendor/beta")).toBe(false);
  });

  it("a real 401 response rejects the key and turns providerConnected false", async () => {
    const deps = await startServer(() => ({ status: 401, body: { error: { message: "invalid api key" } } }));
    await expect(listProviderModels(OPENROUTER_ID, deps)).rejects.toThrow("OpenRouter rejected this API key.");
    expect(providerConnected(OPENROUTER_ID, deps)).toBe(false);
  });

  it("connectAiProvider counts the models a live catalogue returned", async () => {
    let storedKey: string | undefined;
    const base = await startServer((url) =>
      url === "/models/user"
        ? {
            status: 200,
            body: {
              data: [
                { id: "vendor/one", name: "One" },
                { id: "vendor/two", name: "Two" },
              ],
            },
          }
        : { status: 200, body: { data: [] } },
    );
    const deps: ProviderDeps = {
      ...base,
      storeKey: (_provider, key) => {
        storedKey = key;
      },
    };
    expect(await connectAiProvider(OPENROUTER_ID, "  sk-fresh  ", deps)).toBe(2);
    expect(storedKey).toBe("sk-fresh");
    expect(listAiProviders({ ...deps, readKey: () => "sk-fresh" })).toEqual([
      { id: "openrouter", label: "OpenRouter", connected: true },
    ]);
  });
});

// ===========================================================================
// readKey / storeKey / deleteKey — the REAL macOS Keychain, plain generic
// password, against TEST_SERVICE only. Skipped off macOS, matching the
// platform guard in the source itself.
// ===========================================================================

describe.skipIf(process.platform !== "darwin")("readKey / storeKey / deleteKey (real Keychain, plain item)", () => {
  const account = () => `account-${randomUUID()}`;

  it("the production service name is the literal the shipped app uses", () => {
    expect(KEYCHAIN_SERVICE).toBe("Arcelle LLM Providers");
    expect(TEST_SERVICE).not.toBe(KEYCHAIN_SERVICE);
  });

  it("reading a never-stored key throws a 'no key saved' message", () => {
    const a = account();
    expect(() => readKey(a, TEST_SERVICE)).toThrow(`No API key is saved for ${a}.`);
  });

  it("store then read round-trips the exact bytes", () => {
    const a = account();
    try {
      storeKey(a, "s3cret-api-key", TEST_SERVICE);
      expect(readKey(a, TEST_SERVICE)).toBe("s3cret-api-key");
    } finally {
      deleteKey(a, TEST_SERVICE);
    }
  });

  it("storing twice for the same account replaces rather than erroring (duplicate-item fallback)", () => {
    const a = account();
    try {
      storeKey(a, "first-key", TEST_SERVICE);
      expect(() => storeKey(a, "second-key", TEST_SERVICE)).not.toThrow();
      expect(readKey(a, TEST_SERVICE)).toBe("second-key");
    } finally {
      deleteKey(a, TEST_SERVICE);
    }
  });

  it("delete is idempotent: a never-stored or already-deleted entry does not throw", () => {
    const a = account();
    expect(() => deleteKey(a, TEST_SERVICE)).not.toThrow();
    storeKey(a, "some-key", TEST_SERVICE);
    deleteKey(a, TEST_SERVICE);
    expect(() => deleteKey(a, TEST_SERVICE)).not.toThrow();
    expect(() => readKey(a, TEST_SERVICE)).toThrow();
  });

  it("reads an EMPTY stored value back as \"\", the way Rust's String::from_utf8(vec![]) does", () => {
    // The zero-length path is its own branch: `CFDataGetBytePtr` answers NULL
    // for an empty CFData and `koffi.decode` refuses a zero-length array, so
    // without the short-circuit this threw a JS error that `readKey` then
    // reported as "No API key is saved … [code -1]" — a key IS saved, and
    // there is no such OSStatus. `security_framework` returns `Ok("")` here,
    // and the blank check in `providerConnected` is what decides it is
    // unusable.
    const a = account();
    try {
      storeKey(a, "", TEST_SERVICE);
      expect(readKey(a, TEST_SERVICE)).toBe("");
      // …and an empty key is still not a connection.
      expect(providerConnected(a, { ...forbiddenDeps(), readKey: (p) => readKey(p, TEST_SERVICE) })).toBe(false);
    } finally {
      deleteKey(a, TEST_SERVICE);
    }
  });

  it("round-trips a UTF-8 string with multi-byte characters", () => {
    const a = account();
    const value = "sk-🔥-日本語-קוד";
    try {
      storeKey(a, value, TEST_SERVICE);
      expect(readKey(a, TEST_SERVICE)).toBe(value);
    } finally {
      deleteKey(a, TEST_SERVICE);
    }
  });

  it("the default deps read the REAL service, which has nothing under a fake provider id", () => {
    expect(providerConnected(fakeProvider())).toBe(false);
  });
});
