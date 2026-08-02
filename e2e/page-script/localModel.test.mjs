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
  join(here, "../../src/workspace/localModel.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { bestLocalModel } = await import(
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
