/* Connector-marketplace text over UNTRUSTED registry data.
 *
 * Runs under `npm run test:page` (node --test) and exercises the REAL
 * `src/settings/marketplaceText.ts`, type-stripped with the `typescript` dev
 * dependency and imported from memory — same trick as localModel.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../src/settings/marketplaceText.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { initials, hostOf, isUsableEndpoint } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

test("a non-Latin connector name still gets a monogram", () => {
  // The bug: everything outside [A-Za-z0-9 ] was stripped first, so each of
  // these produced "" and the card drew a blank coloured square.
  assert.equal(initials("北京地图"), "北");
  assert.equal(initials("地図 サービス"), "地サ");
  assert.equal(initials("מפת ישראל"), "מי");
  assert.equal(initials("خرائط العالم"), "خا");
  assert.equal(initials("Карта Мира"), "КМ");
});

test("Latin names keep the initials they always had", () => {
  assert.equal(initials("GitHub"), "G");
  assert.equal(initials("Brave Search"), "BS");
  assert.equal(initials("postgres-mcp server"), "PS");
  // Only the first two words are used, as before.
  assert.equal(initials("one two three"), "OT");
});

test("a name with no letters or digits never yields an empty tile", () => {
  assert.equal(initials("🚀"), "🚀");
  assert.equal(initials("***"), "*");
  assert.equal(initials("   "), "?");
  assert.equal(initials(""), "?");
});

test("a malformed registry address does not throw", () => {
  // The bug: the drawer called `new URL(spec.url).host` during render, so a
  // catalogue entry missing its scheme blanked the whole app window.
  assert.equal(hostOf("mcp.example.com/sse"), "");
  assert.equal(hostOf(""), "");
  assert.equal(hostOf("://nope"), "");
  assert.equal(hostOf("https://mcp.example.com/sse"), "mcp.example.com");
  assert.equal(hostOf("https://mcp.example.com:8443/sse"), "mcp.example.com:8443");
});

test("only an http(s) endpoint with a host is offered for install", () => {
  assert.equal(isUsableEndpoint("https://mcp.example.com/sse"), true);
  assert.equal(isUsableEndpoint("http://127.0.0.1:9000/mcp"), true);
  assert.equal(isUsableEndpoint("mcp.example.com/sse"), false);
  assert.equal(isUsableEndpoint("file:///etc/passwd"), false);
  assert.equal(isUsableEndpoint("javascript:alert(1)"), false);
  assert.equal(isUsableEndpoint(""), false);
});
