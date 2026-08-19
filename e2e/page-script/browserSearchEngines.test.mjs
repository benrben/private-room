/* ONE VOCABULARY FOR THE SEVEN ENGINES.
 *
 * The sidecar reports an engine that could not answer by its FUNCTION name
 * (`websearch.DEFAULT_ENGINES`), and Rust hands that list to the results page
 * untouched. The page names engines by their `source` — the fixed dial slots in
 * `ENGINE_SLOTS`. When the two disagreed, one screen called one engine two
 * things: the header said "duckduckgo_ia, google_news unavailable" while the
 * dial and the footer beneath it said "ddg-ia" and "news".
 *
 * So: every engine the sidecar can name as failed must, after the page's own
 * alias table, be one of the slots the page draws. Both sides are read from
 * source here — nothing in this file restates either list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const PY = readFileSync(join(root, "sidecar/arcelle_sidecar/websearch.py"), "utf8");
const TSX = readFileSync(join(root, "src/workspace/BrowserSearch.tsx"), "utf8");

/** The engine callables in `DEFAULT_ENGINES` — the names `_fuse` puts in
 * 'failed', since it reports `engine.__name__`. */
function sidecarEngineNames() {
  const m = PY.match(/DEFAULT_ENGINES:[^=]*=\s*\(([^)]*)\)/);
  assert.ok(m, "DEFAULT_ENGINES not found in websearch.py");
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The page's fixed dial slots. */
function slots() {
  const m = TSX.match(/const ENGINE_SLOTS = \[([^\]]*)\]/);
  assert.ok(m, "ENGINE_SLOTS not found in BrowserSearch.tsx");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** The page's translation from a sidecar function name to a slot name. */
function aliases() {
  const m = TSX.match(/const ENGINE_ALIASES: Record<string, string> = \{([^}]*)\}/);
  assert.ok(m, "ENGINE_ALIASES not found in BrowserSearch.tsx");
  const out = {};
  for (const row of m[1].matchAll(/([A-Za-z0-9_]+):\s*"([^"]+)"/g)) out[row[1]] = row[2];
  return out;
}

test("every engine the sidecar can report as failed has a name the page draws", () => {
  const alias = aliases();
  const slot = slots();
  const engines = sidecarEngineNames();
  assert.equal(
    engines.length,
    slot.length,
    `the sidecar fans out to ${engines.length} engines but the page draws ${slot.length} slots`,
  );
  for (const name of engines) {
    const shown = alias[name] ?? name;
    assert.ok(
      slot.includes(shown),
      `the sidecar can report "${name}" as unavailable, but the page has no slot called ` +
        `"${shown}" — the header would name an engine the dial and footer call something else`,
    );
  }
});
