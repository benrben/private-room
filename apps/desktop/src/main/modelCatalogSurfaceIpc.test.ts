import { describe, expect, it } from "vitest";

import {
  antigravityModelsFromJson,
  createModelSelectionValidator,
} from "./modelCatalogSurfaceIpc.js";
import type { ExternalModelInfo } from "../shared/apiTypes.js";

function catalogModel(slug: string, label: string): ExternalModelInfo {
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
});
