/* What "Use local" switches a cloud room to.
 *
 * Runs under `npm run test:page` (node --test) and exercises the REAL
 * `src/workspace/localModel.ts`, type-stripped with the `typescript` dev
 * dependency and imported from memory — same trick as the address-bar tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../apps/desktop/src/renderer/workspace/localModel.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { bestLocalModel, isEmbeddingModel, isRelayedModel } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

/** Mirrors constants.ts RECOMMENDED_MODELS, tuned default first. */
const PREFERRED = ["qwen3.5:4b", "qwen3.5:9b", "gemma3:4b"];

test("the tuned default wins however Ollama happens to order its tags", () => {
  // The bug: `models.find(...)` took Ollama's raw /api/tags order, so a room
  // switched to whatever was listed first — here the grounding model, which
  // cannot drive the agent loop.
  assert.equal(
    bestLocalModel(["qwen2.5vl:7b", "llama3.2:1b", "qwen3.5:4b"], PREFERRED),
    "qwen3.5:4b",
  );
});

test("a tagged build of the default still counts as the default", () => {
  assert.equal(
    bestLocalModel(["gemma3:4b", "qwen3.5:4b-instruct-q4_K_M"], PREFERRED),
    "qwen3.5:4b-instruct-q4_K_M",
  );
});

test("without the default it walks the curated order, not the install order", () => {
  assert.equal(
    bestLocalModel(["qwen2.5vl:7b", "gemma3:4b", "qwen3.5:9b"], PREFERRED),
    "qwen3.5:9b",
  );
});

test("nothing curated installed: any chat model beats none", () => {
  assert.equal(bestLocalModel(["qwen2.5vl:7b"], PREFERRED), "qwen2.5vl:7b");
});

test("embedding models can't answer a chat turn and are never picked", () => {
  assert.equal(
    bestLocalModel(["nomic-embed-text:latest", "bge-m3", "gemma3:4b"], PREFERRED),
    "gemma3:4b",
  );
  assert.equal(bestLocalModel(["nomic-embed-text:latest"], PREFERRED), null);
});

test("an Ollama :cloud model is not local, whatever the button says", () => {
  assert.equal(bestLocalModel(["qwen3.5:4b:cloud"], PREFERRED), null);
  assert.equal(
    bestLocalModel(["qwen3.5:4b:cloud", "gemma3:4b"], PREFERRED),
    "gemma3:4b",
  );
});

test("nothing installed means nothing to offer", () => {
  assert.equal(bestLocalModel([], PREFERRED), null);
});

/* The picker (EngineModelPicker) now shares this exact predicate. It used to
 * have none, so `nomic-embed-text` — pulled by semantic search, not by the user
 * — sat in the model menu and failed every turn it was chosen for with HTTP 400
 * "does not support chat" (live QA 2026-08-03). Same rule, one copy: a model the
 * fallback refuses to pick can no longer be offered by hand. */
test("the picker's embed rule matches the fallback's, name by name", () => {
  for (const m of [
    "nomic-embed-text",
    "nomic-embed-text:latest",
    "bge-m3",
    "bge-large",
    "mxbai-embed-large",
    "snowflake-arctic-embed2",
  ]) {
    assert.equal(isEmbeddingModel(m), true, `${m} should be embed-only`);
  }
  for (const m of ["qwen3.5:4b", "gemma3:4b", "qwen2.5vl:7b", "llama3.2:1b"]) {
    assert.equal(isEmbeddingModel(m), false, `${m} should be chat-capable`);
  }
});

/* The relayed-model rule, which is also the TRUST CHIP's rule.
 *
 * `markup.isRemoteModel` — the thing that decides whether a room is labelled
 * "Local only — nothing leaves the device" — now delegates here, so this is the
 * one place the app decides what "runs on this Mac" means, mirroring the host's
 * declared capability record (src-tauri/src/commands/capabilities.rs).
 */
test("Ollama's <size>-cloud spelling is not 'local'", () => {
  // THE BUG: an exact endsWith(":cloud") test misses these entirely, so a room
  // on one was labelled "Local only" and told nothing leaves the device while
  // every prompt was already going to ollama.com.
  assert.equal(isRelayedModel("gpt-oss:120b-cloud"), true);
  assert.equal(isRelayedModel("qwen3-vl:235b-cloud"), true);
  // The plain spelling still reads as relayed...
  assert.equal(isRelayedModel("minimax-m3:cloud"), true);
  assert.equal(isRelayedModel("MiniMax-M3:CLOUD"), true);
  // ...and an ordinary installed model is untouched.
  assert.equal(isRelayedModel("qwen3.5:4b"), false);
  assert.equal(isRelayedModel("llama3.2"), false);
  assert.equal(isRelayedModel("nomic-embed-text:latest"), false);
  // A bare name that merely CONTAINS the word is not a relay — the rule reads
  // the tag, not the string.
  assert.equal(isRelayedModel("cloudy-llm"), false);
});

test("a relayed model is never the 'use local' answer", () => {
  const models = ["gpt-oss:120b-cloud", "qwen3.5:4b"];
  assert.equal(bestLocalModel(models, PREFERRED), "qwen3.5:4b");
  // Nothing on-device at all → null, never the hosted entry.
  assert.equal(bestLocalModel(["gpt-oss:120b-cloud"], PREFERRED), null);
});
