import { describe, expect, it } from "vitest";
import {
  engineModelLabel,
  modelLabel,
  splitExternalModel,
  type ExternalModelInfo,
} from "./apiTypes.js";

const CODEX_SOL: ExternalModelInfo = {
  slug: "gpt-5.6-sol",
  label: "Codex Sol",
  efforts: ["high"],
  defaultEffort: "high",
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
  reasoning: true,
  structuredOutputs: true,
};

describe("splitExternalModel", () => {
  it.each([
    ["claude-cli", ["claude-cli", null, null]],
    ["codex-cli::gpt-5.6-sol", ["codex-cli", "gpt-5.6-sol", null]],
    [
      "antigravity-cli::gemini-3.7-flash-high::high",
      ["antigravity-cli", "gemini-3.7-flash-high", "high"],
    ],
    ["openrouter::vendor/model", ["openrouter", "vendor/model", null]],
  ])("splits a recognized external engine: %s", (model, expected) => {
    expect(splitExternalModel(model)).toEqual(expected);
  });

  it("leaves a non-external model untouched", () => {
    expect(splitExternalModel("qwen3.5:4b::high")).toEqual(["qwen3.5:4b::high", null, null]);
  });

  it("renders local and cloud selections with the most specific available label", () => {
    expect(modelLabel("qwen3.5:4b")).toBe("Standard local AI (recommended)");
    expect(modelLabel("qwen2.5-vl:7b")).toBe("Vision helper (marks images)");
    expect(modelLabel("someone/else")).toBeNull();

    expect(engineModelLabel("qwen3.5:4b")).toBe("Standard local AI (recommended)");
    expect(engineModelLabel("unknown-model")).toBe("unknown-model");
    expect(engineModelLabel("codex-cli")).toBe("Codex");
    expect(engineModelLabel("codex-cli::gpt-5.6-sol", {
      "codex-cli": [CODEX_SOL],
    })).toBe("Codex — Codex Sol");
    expect(engineModelLabel("codex-cli::gpt-5.6-sol::high")).toBe(
      "Codex — gpt-5.6-sol · high",
    );
  });
});
