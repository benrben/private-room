/* WHAT A STALE COPY OF THE TRUTH DOES WHEN IT LANDS LATE.
 *
 * Three surfaces in this app hold a copy of something the backend also owns —
 * the connector config, the room graph, the text of a web page — and each of
 * them had a way to write that copy back, or paint it, after the real thing had
 * moved on. None of the three fails loudly: the config saves, the map draws,
 * the reader renders. They just render something untrue.
 *
 *   • useMcpConfig re-posted a config snapshot taken before an OAuth sign-in,
 *     dropping the bearer the backend had just written;
 *   • useRoomGraph never re-fetched when a memory changed, so a star for a
 *     forgotten memory stayed on the map, hoverable, with its old text;
 *   • BrowserReader appended a slow extraction to whatever page had arrived
 *     underneath it in the meantime, tiling two documents with no seam.
 *
 * `signInsDroppedBy` is pure and is imported and RUN. The other two live inside
 * React hooks that need the whole Tauri bridge before they do anything, so they
 * are source-scanned — the same technique browserTrust and connectorpowers use,
 * and what stops a helper from being correct and unused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const MCP = read("apps/desktop/src/renderer/settings/useMcpConfig.ts");
const GRAPH = read("apps/desktop/src/renderer/viewers/roomMap/useRoomGraph.ts");
const READER = read("apps/desktop/src/renderer/workspace/BrowserReader.tsx");

/* The hook's module imports React and the Tauri bridge, neither of which
 * resolves from a data: URL. The IMPORTS are dropped and the rest of the real
 * file is transpiled and evaluated, so the function under test is the shipped
 * one and not a copy of it. Nothing here calls the hook itself. */
const load = async (source) => {
  const js = ts.transpileModule(source.replace(/^import .*$/gm, ""), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const { signInsDroppedBy } = await load(MCP);

const withToken = JSON.stringify({
  mcpServers: {
    notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer abc" } },
    files: { command: "uvx", args: ["mcp-server-files"] },
  },
});
const beforeSignIn = JSON.stringify({
  mcpServers: {
    notion: { url: "https://mcp.notion.com/mcp" },
    files: { command: "uvx", args: ["mcp-server-files"] },
  },
});

// --------------------------------------------------------------------------
// The connector config
// --------------------------------------------------------------------------

test("a snapshot taken before a sign-in is caught before it wipes the bearer", () => {
  assert.deepEqual(signInsDroppedBy(withToken, beforeSignIn), ["notion"]);
});

test("nothing is claimed when no sign-in would be lost", () => {
  // The ordinary save: the box holds what the room holds.
  assert.deepEqual(signInsDroppedBy(withToken, withToken), []);
  // A connector the user is REMOVING is not a sign-in being dropped — the
  // entry is gone on purpose, and the backend clears its token with it.
  const removed = JSON.stringify({ mcpServers: { files: { command: "uvx" } } });
  assert.deepEqual(signInsDroppedBy(withToken, removed), []);
  // Nothing was signed in to begin with.
  assert.deepEqual(signInsDroppedBy(beforeSignIn, beforeSignIn), []);
});

test("an unreadable config accuses nobody", () => {
  // "I could not tell" is not "yes" — the JSON error belongs to the backend,
  // which reports it in its own words.
  assert.deepEqual(signInsDroppedBy("{not json", beforeSignIn), []);
  assert.deepEqual(signInsDroppedBy(withToken, "{not json"), []);
  assert.deepEqual(signInsDroppedBy("", ""), []);
  assert.deepEqual(signInsDroppedBy("null", "null"), []);
});

test("a marketplace install merges into the room's config, not the page's copy", () => {
  const install = MCP.slice(MCP.indexOf("async function installServer"), MCP.indexOf("async function setAutoApprove"));
  assert.match(
    install,
    /await api\.mcpGetConfig\(\)/,
    "installServer still merges into the snapshot the page loaded",
  );
  assert.ok(
    !/JSON\.parse\(mcpConfig\)/.test(install),
    "installServer still parses the page's stale copy",
  );
});

test("Save & Connect asks the room what it holds before overwriting it", () => {
  const apply = MCP.slice(MCP.indexOf("async function applyMcp"), MCP.indexOf("// Marketplace install"));
  assert.match(apply, /signInsDroppedBy\(/, "the drop check is not wired into the save");
  assert.match(apply, /await api\.mcpGetConfig\(\)/, "the check compares against nothing live");
  assert.ok(apply.indexOf("signInsDroppedBy") < apply.indexOf("mcpApplyConfig"), "the check runs after the write");
});

// --------------------------------------------------------------------------
// The room map
// --------------------------------------------------------------------------

test("the map re-fetches when a memory changes, and unsubscribes when it closes", () => {
  const effect = GRAPH.slice(GRAPH.indexOf("let alive = true"), GRAPH.indexOf("}, [reloadNonce]);"));
  assert.match(effect, /api\.onMemoriesChanged\(/, "memory stars are drawn but never refreshed");
  assert.match(effect, /api\.onRoomFilesChanged\(/, "the file subscription was lost");
  // Both listeners have to come back off, or every reopen of the map adds one.
  const cleanup = effect.slice(effect.indexOf("return () => {"));
  assert.equal((cleanup.match(/\.then\(\(fn\) => fn\(\)\)/g) ?? []).length, 2, "a listener is left attached");
});

test("the map lays out every node the backend sent", () => {
  // The backend caps the graph at GRAPH_MAX_FILES files plus the same number
  // of memories, so a second cap here could never run — and would have dropped
  // nodes while leaving their edges in the counts.
  assert.ok(!/MAX_NODES/.test(GRAPH), "the unreachable node cap is still here");
});

// --------------------------------------------------------------------------
// The reading view
// --------------------------------------------------------------------------

test("an extraction that has been superseded is dropped, not merged", () => {
  const starts = READER.match(/const run = \+\+runRef\.current;/g) ?? [];
  assert.equal(starts.length, 2, "expected both load and more to claim a run");
  // Every answer is checked before it is allowed to touch the panel.
  const answers = READER.match(/await api\.browserPageText\([^\n]*\n\s*if \(runRef\.current !== run\) return;/g) ?? [];
  assert.equal(answers.length, 2, "an extraction can still land on a page it did not come from");
  // …including the failures: a refusal from a page we have left must not blank
  // the one that is on screen.
  const catches = READER.match(/\} catch \(e\) \{[\s\S]*?setError\(String\(e\)\);/g) ?? [];
  assert.equal(catches.length, 2, "expected both extraction paths to report failure");
  for (const block of catches) {
    assert.match(block, /runRef\.current !== run/, "a stale failure can still overwrite the panel");
  }
});

test("the reader claims encryption only for a page it can read the scheme of", () => {
  // It printed a green ENCRYPTED tape for anything not literally "http://",
  // including a blank tab, six inches under a chrome that says nothing at all.
  assert.ok(!/startsWith\("http:\/\/"\)/.test(READER), "the two-valued scheme test survives");
  assert.match(READER, /const secure = scheme === "https:"/, "https is not being read as its own answer");
  assert.match(READER, /\{\(secure \|\| insecure\) && \(/, "the tape is drawn for a scheme nobody checked");
});
