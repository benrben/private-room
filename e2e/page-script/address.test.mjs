/* BROWSE-3: what the address bar decides, from the text alone.
 *
 * These run under `npm run test:page` (node --test), alongside the page-script
 * tests. They exercise the REAL `src/workspace/address.ts` — an earlier version
 * of this file restated the regexes, so the address bar could break without a
 * single test going red. The module is TypeScript and these tests are plain
 * Node, so the source is type-stripped with the `typescript` dev dependency
 * (already installed for `npm run build`) and imported from memory. No compiled
 * output, no build step, nothing to keep in sync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/workspace/address.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { classifyAddress } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

test("empty input does nothing", () => {
  assert.equal(classifyAddress(""), null);
  assert.equal(classifyAddress("   "), null);
});

test("anything with a space is a search — the case that used to error", () => {
  // Before BROWSE-3 this produced `Invalid URL: https://best pizza nyc`.
  assert.deepEqual(classifyAddress("best pizza nyc"), {
    kind: "search",
    query: "best pizza nyc",
  });
  assert.deepEqual(classifyAddress("speaker diarization benchmarks"), {
    kind: "search",
    query: "speaker diarization benchmarks",
  });
});

test("a bare word is a search, not a hostname guess", () => {
  // `weather` used to become https://weather and fail DNS resolution.
  assert.deepEqual(classifyAddress("weather"), { kind: "search", query: "weather" });
});

test("non-Latin queries search", () => {
  assert.deepEqual(classifyAddress("בנק ישראל"), {
    kind: "search",
    query: "בנק ישראל",
  });
});

test("an explicit scheme is always a URL, verbatim", () => {
  assert.deepEqual(classifyAddress("https://example.com/x?y=1"), {
    kind: "url",
    url: "https://example.com/x?y=1",
  });
  assert.deepEqual(classifyAddress("http://localhost:3000"), {
    kind: "url",
    url: "http://localhost:3000",
  });
});

test("host-shaped text navigates, with https:// filled in", () => {
  assert.deepEqual(classifyAddress("example.com"), {
    kind: "url",
    url: "https://example.com",
  });
  assert.deepEqual(classifyAddress("x.co/path"), {
    kind: "url",
    url: "https://x.co/path",
  });
  assert.deepEqual(classifyAddress("en.wikipedia.org/wiki/Diarisation"), {
    kind: "url",
    url: "https://en.wikipedia.org/wiki/Diarisation",
  });
});

test("host:port and IP literals navigate — the guard refuses them by name", () => {
  // Classifying is not permitting: these reach browse_guard_url, which is
  // what actually refuses private addresses with an honest message.
  assert.deepEqual(classifyAddress("localhost:3000"), {
    kind: "url",
    url: "https://localhost:3000",
  });
  assert.deepEqual(classifyAddress("192.168.1.1"), {
    kind: "url",
    url: "https://192.168.1.1",
  });
});

test("`?` forces a search for text that looks like a host", () => {
  assert.deepEqual(classifyAddress("?example.com"), {
    kind: "search",
    query: "example.com",
  });
  // A lone "?" is not a query.
  assert.equal(classifyAddress("?"), null);
});

test("a trailing slash keeps host-shaped text a URL", () => {
  assert.deepEqual(classifyAddress("arcelle.app/"), {
    kind: "url",
    url: "https://arcelle.app/",
  });
});

test("a sentence with a dot in it is still a search", () => {
  // The space rule fires before the host rule, which is what keeps
  // "who wrote hamlet.txt" from becoming a navigation.
  assert.deepEqual(classifyAddress("who wrote hamlet.txt"), {
    kind: "search",
    query: "who wrote hamlet.txt",
  });
});

test("a single-label dotted token with a 1-char TLD is a search", () => {
  // "node.js" is a topic, not a host: the TLD rule needs 2+ characters.
  assert.deepEqual(classifyAddress("node.j"), { kind: "search", query: "node.j" });
});
