import { describe, expect, it } from "vitest";
import { bestLocalModel, isEmbeddingModel, isRelayedModel } from "./localModel";

describe("bestLocalModel", () => {
  it("selects the first preferred usable model by case-insensitive prefix", () => {
    expect(bestLocalModel(
      ["other:7b", "Qwen3.5:4B-Instruct", "qwen3.5:8b"],
      ["qwen3.5:4b", "qwen3.5:8b"],
    )).toBe("Qwen3.5:4B-Instruct");
  });

  it("skips embedding and relayed names before using the first usable fallback", () => {
    expect(bestLocalModel(
      ["nomic-embed-text:latest", "qwen3:235b-cloud", "ordinary:7b"],
      ["missing"],
    )).toBe("ordinary:7b");
  });

  it("returns null when no listed name can serve a chat", () => {
    expect(bestLocalModel(
      ["bge-small:latest", "gpt-oss:120b-cloud"],
      ["gpt-oss"],
    )).toBeNull();
  });
});

describe("model-name classifiers", () => {
  it("keeps embedding and relayed naming rules explicit", () => {
    expect(isEmbeddingModel("BGE-large:latest")).toBe(true);
    expect(isEmbeddingModel("ordinary:7b")).toBe(false);
    expect(isRelayedModel("qwen3:cloud")).toBe(true);
    expect(isRelayedModel("qwen3:235b-cloud")).toBe(true);
    expect(isRelayedModel("qwen3:7b")).toBe(false);
    expect(isRelayedModel("cloud")).toBe(false);
  });
});
