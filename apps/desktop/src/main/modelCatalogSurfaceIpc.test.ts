import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogMocks = vi.hoisted(() => ({
  ensureMediaLimits: vi.fn(),
  limitsFor: vi.fn(),
  listProviderModels: vi.fn(),
  mediaTableLoaded: vi.fn(),
  openrouterKey: vi.fn(),
  providerConnected: vi.fn(),
}));
const commandMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: commandMocks.execFile }));
vi.mock("./providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers.js")>();
  return {
    ...actual,
    listProviderModels: catalogMocks.listProviderModels,
    openrouterKey: catalogMocks.openrouterKey,
    probeOpenrouterModelSelection: vi.fn(),
    providerModelSelectable: vi.fn(),
    providerConnected: catalogMocks.providerConnected,
  };
});

vi.mock("./mediaLimits.js", () => ({
  ensureMediaLimits: catalogMocks.ensureMediaLimits,
  limitsFor: catalogMocks.limitsFor,
  mediaTableLoaded: catalogMocks.mediaTableLoaded,
}));

import {
  antigravityModelsFromJson,
  codexModelsFromJson,
  createModelSelectionValidator,
  listEngineModels,
  listCreateModels,
  registerModelCatalogSurfaceIpc,
} from "./modelCatalogSurfaceIpc.js";
import type { ExternalModelInfo } from "../shared/apiTypes.js";

function catalogModel(
  slug: string,
  label: string,
  overrides: Partial<ExternalModelInfo> = {},
): ExternalModelInfo {
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
    ...overrides,
  };
}

function fakeCatalogCommand(raw: string) {
  const end = vi.fn();
  commandMocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, raw, "");
    return { stdin: { end } };
  });
  return end;
}

beforeEach(() => {
  catalogMocks.ensureMediaLimits.mockReset();
  catalogMocks.limitsFor.mockReset();
  catalogMocks.listProviderModels.mockReset();
  catalogMocks.mediaTableLoaded.mockReset();
  catalogMocks.openrouterKey.mockReset();
  catalogMocks.providerConnected.mockReset();
  commandMocks.execFile.mockReset();
  catalogMocks.ensureMediaLimits.mockResolvedValue(undefined);
  catalogMocks.limitsFor.mockReturnValue(undefined);
  catalogMocks.listProviderModels.mockResolvedValue([]);
  catalogMocks.mediaTableLoaded.mockReturnValue(false);
  catalogMocks.openrouterKey.mockReturnValue(null);
  catalogMocks.providerConnected.mockReturnValue(false);
});

describe("Antigravity live model catalog", () => {
  it("maps the machine-readable agy catalog without hard-coding model names", () => {
    const raw = JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "models",
        data: {
          models: [
            { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
            { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
          ],
        },
      },
    });

    expect(antigravityModelsFromJson(raw).map(({ slug, label }) => ({ slug, label }))).toEqual([
      { slug: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { slug: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    ]);
  });

  it("fails closed on malformed JSON and ignores malformed rows", () => {
    expect(() => antigravityModelsFromJson("not json")).toThrow("bad JSON from agy");
    expect(antigravityModelsFromJson(JSON.stringify({ command: { data: { models: [{ label: "missing id" }] } } }))).toEqual([]);
  });
});

describe("Codex live model catalog", () => {
  it("keeps only listed model rows and preserves their optional runtime details", () => {
    const raw = JSON.stringify({
      models: [
        {
          visibility: "list",
          slug: "gpt-5.6",
          display_name: "GPT 5.6",
          supported_reasoning_levels: [{ effort: "low" }, { effort: 3 }, { effort: "high" }],
          default_reasoning_level: "high",
          context_window: 400_000,
        },
        { visibility: "hidden", slug: "hidden" },
        { visibility: "list", display_name: "No slug" },
      ],
    });

    expect(codexModelsFromJson(raw)).toMatchObject([{
      slug: "gpt-5.6",
      label: "GPT 5.6",
      efforts: ["low", "high"],
      defaultEffort: "high",
      contextWindow: 400_000,
      reasoning: true,
    }]);
    expect(codexModelsFromJson(JSON.stringify({ models: {} }))).toEqual([]);
    expect(() => codexModelsFromJson("not json")).toThrow("bad JSON from codex");
  });
});

describe("engine model catalogs", () => {
  it("returns the fabricated OpenRouter catalog without running a local command", async () => {
    const expected = [catalogModel("vendor/fake", "Fake provider model")];
    catalogMocks.listProviderModels.mockResolvedValue(expected);

    await expect(listEngineModels("openrouter")).resolves.toEqual(expected);
    expect(catalogMocks.listProviderModels).toHaveBeenCalledWith("openrouter");
    expect(commandMocks.execFile).not.toHaveBeenCalled();
  });

  it("returns the declared Claude CLI catalog without running a local command", async () => {
    await expect(listEngineModels("claude-cli")).resolves.toMatchObject([
      { slug: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { slug: "sonnet", label: "Sonnet" },
      { slug: "haiku", label: "Haiku" },
      { slug: "fable", label: "Fable" },
    ]);
    expect(commandMocks.execFile).not.toHaveBeenCalled();
  });

  it("parses a fabricated Codex command catalog and closes its synthetic stdin", async () => {
    const end = fakeCatalogCommand(JSON.stringify({
      models: [{ visibility: "list", slug: "gpt-fake", display_name: "GPT fake" }],
    }));

    await expect(listEngineModels("codex-cli")).resolves.toMatchObject([
      { slug: "gpt-fake", label: "GPT fake" },
    ]);
    expect(commandMocks.execFile).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", "codex debug models"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("surfaces the fabricated Codex command failure without running a local CLI", async () => {
    const end = vi.fn();
    commandMocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error("synthetic exit"), "", "catalog unavailable");
      return { stdin: { end } };
    });

    await expect(listEngineModels("codex-cli")).rejects.toThrow(
      "codex debug models failed: catalog unavailable",
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("parses a fabricated Antigravity command catalog and closes its synthetic stdin", async () => {
    const end = fakeCatalogCommand(JSON.stringify({
      command: { data: { models: [{ id: "agy-fake", label: "Agy fake" }] } },
    }));

    await expect(listEngineModels("antigravity-cli")).resolves.toMatchObject([
      { slug: "agy-fake", label: "Agy fake", contextWindow: 1_048_576 },
    ]);
    expect(commandMocks.execFile).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", "agy --output-format json models"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("rejects an unknown engine without consulting a command or provider", async () => {
    await expect(listEngineModels("not-an-engine")).rejects.toThrow("Unknown engine: not-an-engine");
    expect(catalogMocks.listProviderModels).not.toHaveBeenCalled();
    expect(commandMocks.execFile).not.toHaveBeenCalled();
  });
});

describe("exact model selection validation", () => {
  it("probes an Ollama tag once and caches the successful exact ID", async () => {
    const seen: string[] = [];
    const validate = createModelSelectionValidator({
      probeOllama: async (model) => {
        seen.push(model);
        return { ok: true, detail: null };
      },
      listProviderModels: async () => [],
      providerModelKnown: () => false,
      now: () => 1,
    });

    await expect(validate("ollama-cloud", "gpt-oss:120b-cloud")).resolves.toEqual({
      selectable: true,
      reason: null,
    });
    await validate("ollama-cloud", "gpt-oss:120b-cloud");
    expect(seen).toEqual(["gpt-oss:120b-cloud"]);
  });

  it("disables an Ollama ID that its metadata endpoint rejects with a clear reason", async () => {
    const validate = createModelSelectionValidator({
      probeOllama: async () => ({ ok: false, detail: "MODEL_MISSING:Gpt-oss:120b-cloud" }),
      listProviderModels: async () => [],
      providerModelKnown: () => false,
      now: () => 1,
    });
    const result = await validate("ollama-cloud", "Gpt-oss:120b-cloud");
    expect(result.selectable).toBe(false);
    expect(result.reason).toContain("exact model ID “Gpt-oss:120b-cloud”");
    expect(result.reason).toContain("MODEL_MISSING");
  });

  it("validates only the chosen OpenRouter slug and never substitutes its display label", async () => {
    let calls = 0;
    const validate = createModelSelectionValidator({
      probeOllama: async () => ({ ok: true, detail: null }),
      listProviderModels: async () => {
        calls += 1;
        return [catalogModel("vendor/exact-id", "Friendly Model Name")];
      },
      providerModelKnown: () => false,
      now: () => 1,
    });

    await expect(validate("openrouter", "vendor/exact-id")).resolves.toEqual({ selectable: true, reason: null });
    await expect(validate("openrouter", "Friendly Model Name")).resolves.toMatchObject({ selectable: false });
    expect(calls).toBe(2);
  });

  it("uses the populated OpenRouter capability cache without another catalog request", async () => {
    const validate = createModelSelectionValidator({
      probeOllama: async () => ({ ok: true, detail: null }),
      listProviderModels: async () => { throw new Error("must stay lazy"); },
      providerModelKnown: (selection) => selection === "openrouter::vendor/already-listed",
      now: () => 1,
    });
    await expect(validate("openrouter", "vendor/already-listed")).resolves.toEqual({
      selectable: true,
      reason: null,
    });
  });

  it("runs one low-token capability probe before enabling a chosen OpenRouter ID", async () => {
    const seen: string[] = [];
    const validate = createModelSelectionValidator({
      probeOllama: async () => ({ ok: true, detail: null }),
      listProviderModels: async () => [catalogModel("vendor/runtime-id", "Runtime")],
      providerModelKnown: () => true,
      probeProviderModel: async (model) => {
        seen.push(model);
        return { ok: false, detail: "HTTP 400: invalid model name" };
      },
      now: () => 1,
    });
    await expect(validate("openrouter", "vendor/runtime-id")).resolves.toMatchObject({
      selectable: false,
      reason: expect.stringContaining("invalid model name"),
    });
    expect(seen).toEqual(["vendor/runtime-id"]);
  });

  it("accepts native catalog IDs without probing a provider", async () => {
    const validate = createModelSelectionValidator({
      probeOllama: async () => ({ ok: false, detail: "must not run" }),
      listProviderModels: async () => { throw new Error("must not run"); },
      providerModelKnown: () => false,
      now: () => 1,
    });

    await expect(validate("codex-cli", "gpt-5.6")).resolves.toEqual({ selectable: true, reason: null });
  });
});

describe("Create shelf model catalog", () => {
  it("skips disconnected providers while retaining every native exclusion in declaration order", async () => {
    await expect(listCreateModels()).resolves.toMatchObject({
      models: [],
      scanned: 5,
      anyProvider: false,
      error: null,
      excluded: [
        { engineLabel: "Ollama (this Mac)", count: 1, examples: ["Ollama (this Mac)"] },
        { engineLabel: "Ollama cloud relay", count: 1, examples: ["Ollama cloud relay"] },
        {
          engineLabel: "Claude Code",
          reason: "Reads pictures, cannot make them — vision in, no image out.",
          count: 1,
          examples: ["Claude Code"],
        },
        {
          engineLabel: "Codex",
          reason: "Reads pictures, cannot make them — vision in, no image out.",
          count: 1,
          examples: ["Codex"],
        },
        {
          engineLabel: "Antigravity CLI",
          reason: "Reads pictures, cannot make them — vision in, no image out.",
          count: 1,
          examples: ["Antigravity CLI"],
        },
      ],
    });
    expect(catalogMocks.openrouterKey).not.toHaveBeenCalled();
    expect(catalogMocks.ensureMediaLimits).not.toHaveBeenCalled();
    expect(catalogMocks.listProviderModels).not.toHaveBeenCalled();
  });

  it("preloads limits, maps supported media, and keeps text-only and unreachable exclusions ordered", async () => {
    const imageLimits = { durations: [], resolutions: [], aspectRatios: [], frameImages: [], maxReferences: null, generateAudio: false };
    const videoLimits = { ...imageLimits, durations: [5] };
    const calls: string[] = [];
    catalogMocks.providerConnected.mockReturnValue(true);
    catalogMocks.openrouterKey.mockReturnValue("openrouter-key");
    catalogMocks.ensureMediaLimits.mockImplementation(async (key: string) => { calls.push(`limits:${key}`); });
    catalogMocks.listProviderModels.mockImplementation(async () => {
      calls.push("catalog");
      return [
        catalogModel("openrouter/auto", "Auto", { videoOutput: true }),
        catalogModel("vendor/zebra", "Zebra", { imageOutput: true, description: "Paints", outputPrice: 0.3 }),
        catalogModel("vendor/missing", "Missing", { videoOutput: true }),
        catalogModel("vendor/text", "Text only"),
      ];
    });
    catalogMocks.mediaTableLoaded.mockReturnValue(true);
    catalogMocks.limitsFor.mockImplementation((slug: string) => {
      if (slug === "openrouter/auto") return videoLimits;
      if (slug === "vendor/zebra") return imageLimits;
      return undefined;
    });

    const result = await listCreateModels();

    expect(calls).toEqual(["limits:openrouter-key", "catalog"]);
    expect(result).toMatchObject({
      scanned: 9,
      anyProvider: true,
      error: null,
      models: [
        {
          model: "openrouter::vendor/zebra",
          slug: "vendor/zebra",
          label: "Zebra",
          engine: "openrouter",
          engineLabel: "OpenRouter",
          local: false,
          description: "Paints",
          image: true,
          video: false,
          outputPrice: 0.3,
          limits: imageLimits,
        },
        { model: "openrouter::openrouter/auto", slug: "openrouter/auto", limits: videoLimits },
      ],
    });
    expect(result.excluded[0]).toEqual({
      engineLabel: "OpenRouter",
      reason: "Text output only, per the provider's own catalog.",
      count: 1,
      examples: ["vendor/text"],
    });
    expect(result.excluded.at(-1)).toEqual({
      engineLabel: "OpenRouter",
      reason: "Declares pictures on the chat API, but the provider's own picture and video endpoints do not serve it — a call would return no endpoint found.",
      count: 1,
      examples: ["Missing"],
    });
  });

  it("reports a provider catalog failure but keeps the native entries available", async () => {
    catalogMocks.providerConnected.mockReturnValue(true);
    catalogMocks.listProviderModels.mockRejectedValue("catalog unavailable");

    const result = await listCreateModels();
    expect(result).toMatchObject({
      models: [],
      scanned: 5,
      anyProvider: true,
      error: "catalog unavailable",
    });
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ engineLabel: "Ollama (this Mac)" }),
      expect.objectContaining({ engineLabel: "Antigravity CLI" }),
    ]));
    expect(catalogMocks.ensureMediaLimits).not.toHaveBeenCalled();
  });

  it("does not hide a media-limit preload failure behind a catalog error", async () => {
    catalogMocks.providerConnected.mockReturnValue(true);
    catalogMocks.openrouterKey.mockReturnValue("openrouter-key");
    catalogMocks.ensureMediaLimits.mockRejectedValue(new Error("limits unavailable"));

    await expect(listCreateModels()).rejects.toThrow("limits unavailable");
    expect(catalogMocks.listProviderModels).not.toHaveBeenCalled();
  });
});

describe("model catalog IPC registration", () => {
  it("normalizes malformed validation payloads before calling the real validator", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerModelCatalogSurfaceIpc({
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    });

    expect([...handlers.keys()]).toEqual([
      "list_engine_models",
      "list_create_models",
      "validate_engine_model",
    ]);
    await expect(handlers.get("validate_engine_model")?.({}, null)).resolves.toEqual({
      selectable: false,
      reason: "Choose a specific model first.",
    });
  });
});
