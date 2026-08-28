import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstalledOllamaModel } from "../helpers/installedAgentModel.mjs";

const status = {
  running: true,
  models: [
    "qwen3.5:4b",
    "Gpt-oss:120b-cloud",
    "nomic-embed-text:latest",
  ],
  defaultModel: "qwen3.5:4b",
};

test("installed review follows the app's exact live default instead of assuming an MLX suffix", () => {
  assert.equal(resolveInstalledOllamaModel(status), "qwen3.5:4b");
});

test("explicit overrides preserve the exact installed provider ID and match casing safely", () => {
  assert.equal(resolveInstalledOllamaModel(status, "QWEN3.5:4B"), "qwen3.5:4b");
});

test("a stale explicit build suffix fails before an agent run with the available IDs", () => {
  assert.throws(
    () => resolveInstalledOllamaModel(status, "qwen3.5:4b-mlx"),
    /not installed.*qwen3\.5:4b/s,
  );
});

test("cloud relay and embedding-only entries are never chosen for local harness review", () => {
  assert.throws(
    () => resolveInstalledOllamaModel({
      models: ["gpt-oss:120b-cloud", "nomic-embed-text:latest"],
      defaultModel: "gpt-oss:120b-cloud",
    }),
    /No installed local Ollama chat model/,
  );
});
