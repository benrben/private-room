/* The frontend half of the generic "adaptive UI text" service
 * (src/workspace/adaptiveText.ts, src/api.ts's `generateUiText`).
 *
 * `adaptiveTextCacheKey`/`canonicalize` are pure and side-effect-free, so
 * they're sliced out of the real source and executed for real, same trick as
 * localModel.test.mjs. `useAdaptiveText` itself imports "react" and "../api"
 * — bare specifiers a data: URL module can't resolve (no parent file to
 * resolve node_modules against) — and this repo has no react-test-renderer /
 * @testing-library/react-hooks dependency to mount it with, so, matching the
 * multiSelect.test.mjs / approveCardFocus.test.mjs convention for exactly
 * this situation, its behavioral contract (400ms swap window, cache-always-
 * written, no setState after unmount, no per-render generation storm) is
 * pinned as a textual scan of the shipped source instead of a render test.
 * That gap — nothing here actually MOUNTS the hook and fast-forwards a
 * clock — is real; see the report that shipped this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const HOOK_SOURCE = read("src/workspace/adaptiveText.ts");
const API_SOURCE = read("src/api.ts");

// ---- real execution: the pure cache-key logic ------------------------------

const pureStart = HOOK_SOURCE.indexOf("function canonicalize");
const pureEnd = HOOK_SOURCE.indexOf("/** Module-level cache");
assert.ok(pureStart > 0 && pureEnd > pureStart, "expected canonicalize()/adaptiveTextCacheKey() between their usual markers — did the file get reshuffled?");
const pureSnippet = HOOK_SOURCE.slice(pureStart, pureEnd) + "\nexport { canonicalize };\n";
const pureJS = ts.transpileModule(pureSnippet, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { adaptiveTextCacheKey, canonicalize } = await import(
  `data:text/javascript,${encodeURIComponent(pureJS)}`
);

test("the cache key is stable across facts-object key order (canonicalization)", () => {
  const a = adaptiveTextCacheKey("room1", "dek", "Write one sentence", {
    count: 3, largestMb: 110,
  });
  const b = adaptiveTextCacheKey("room1", "dek", "Write one sentence", {
    largestMb: 110, count: 3,
  });
  assert.equal(a, b, "same facts content in a different key order must hit the same cache slot");
});

test("the cache key changes with roomId, kind, prompt, or facts individually", () => {
  const base = adaptiveTextCacheKey("room1", "dek", "Write one sentence", { count: 3 });
  assert.notEqual(base, adaptiveTextCacheKey("room2", "dek", "Write one sentence", { count: 3 }),
    "switching rooms must never hit another room's cached text");
  assert.notEqual(base, adaptiveTextCacheKey("room1", "tab_title", "Write one sentence", { count: 3 }));
  assert.notEqual(base, adaptiveTextCacheKey("room1", "dek", "Write two sentences", { count: 3 }));
  assert.notEqual(base, adaptiveTextCacheKey("room1", "dek", "Write one sentence", { count: 4 }));
});

test("array order inside facts is preserved, not sorted (order can be meaningful)", () => {
  const a = adaptiveTextCacheKey("room1", "k", "p", { items: [1, 2, 3] });
  const b = adaptiveTextCacheKey("room1", "k", "p", { items: [3, 2, 1] });
  assert.notEqual(a, b);
});

test("canonicalize sorts nested object keys recursively, not just top-level", () => {
  const x = canonicalize({ b: { z: 1, y: 2 }, a: 1 });
  const y = canonicalize({ a: 1, b: { y: 2, z: 1 } });
  assert.equal(JSON.stringify(x), JSON.stringify(y));
});

// ---- api.ts: the invoke() wrapper (source scan — invoke() itself talks to
// a real Tauri backend that doesn't exist under `node --test`) --------------

test("api.ts's generateUiText matches the sidecar/Rust contract's field names", () => {
  assert.match(
    API_SOURCE,
    /export const generateUiText = \(\s*kind: string,\s*prompt: string,\s*facts: unknown,\s*maxWords: number,\s*\) =>/,
  );
  assert.match(
    API_SOURCE,
    /invoke<string \| null>\("generate_ui_text", \{ kind, prompt, facts, maxWords \}\)/,
    "camelCase maxWords must reach Tauri as-is — it maps to the Rust command's max_words param by convention",
  );
});

// ---- useAdaptiveText: behavioral contract, pinned textually ----------------

const hookBody = HOOK_SOURCE.slice(HOOK_SOURCE.indexOf("export function useAdaptiveText"));

test("a cache miss never shows a loading state — undefined/null only, no spinner value", () => {
  assert.doesNotMatch(hookBody, /loading|pending|isLoading/i);
});

test("the background call is bounded by a 400ms swap window, and the cache write is unconditional", () => {
  assert.match(HOOK_SOURCE, /const SWAP_WINDOW_MS = 400;/);
  const thenBlock = hookBody.slice(hookBody.indexOf(".then((result)"));
  const cacheSetIdx = thenBlock.indexOf("cache.set(key, result)");
  const swapCheckIdx = thenBlock.indexOf("Date.now() - startedAt <= SWAP_WINDOW_MS");
  const setTextIdx = thenBlock.indexOf("setText(result)");
  assert.ok(cacheSetIdx > -1 && swapCheckIdx > -1 && setTextIdx > -1, "expected all three in the resolve handler");
  assert.ok(cacheSetIdx < swapCheckIdx, "cache.set must run BEFORE the 400ms check, not only on the fast branch — a late resolve must still be cached for next time");
  assert.ok(swapCheckIdx < setTextIdx, "setText(result) must be gated behind the 400ms check, never called unconditionally (that's the mid-read-swap bug this hook exists to prevent)");
});

test("no state update fires after unmount", () => {
  assert.match(hookBody, /let cancelled = false;/);
  assert.match(hookBody, /if \(cancelled\)\s*\n?\s*return;/, "the resolve handler must bail before touching cache/state once cancelled");
  assert.match(hookBody, /return \(\) => \{\s*cancelled = true;\s*\};/);
});

test("a cache hit renders synchronously — no useEffect/async gate before returning a hit", () => {
  // The synchronous "adjusting state during render" reset must run in the
  // hook body itself, not inside useEffect (which would always cost a frame).
  const beforeEffect = hookBody.slice(0, hookBody.indexOf("useEffect(()"));
  assert.match(beforeEffect, /if \(identity !== appliedIdentity\)/);
  assert.match(beforeEffect, /setText\(active \? cache\.get\(key\) : null\)/);
});

test("the effect does not re-fire on every referentially-new facts object — only key/active/maxWords are deps", () => {
  const depsMatch = hookBody.match(/\}, \[([^\]]*)\]\);/);
  assert.ok(depsMatch, "expected the effect's dependency array");
  const deps = depsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(deps.sort(), ["active", "key", "maxWords"].sort());
});

test("the master flag follows the auto_index convention: absent = on, \"0\" = off", () => {
  assert.match(HOOK_SOURCE, /const MASTER_FLAG_SETTING_KEY = "adaptive_text_enabled";/);
  assert.match(HOOK_SOURCE, /masterFlagOn = v !== "0";/);
  assert.match(HOOK_SOURCE, /let masterFlagOn = true;/, "default ON");
});
