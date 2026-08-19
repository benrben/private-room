/* The capability record, as Rust serializes it against as TypeScript declares it.
 *
 * `Capability` and `EngineCapabilities` are two halves of one wire contract:
 * the host answers `engine_preflight` for a closed enum of questions and
 * `engine_capabilities` with a fixed record. Both halves are hand-written twice
 * — once in `src-tauri/src/commands/capabilities.rs`, once in
 * `src/apiTypes.ts` — and nothing compared them, so the Create page's two
 * questions (can this room draw / can it make a clip) rode the wire with real
 * answers for months while TypeScript rejected every attempt to read them.
 *
 * A type-level gap is invisible to every other gate here: the JSON is correct,
 * the app runs, and the only symptom is that a component CANNOT ask.
 *
 * This reads the Rust file and the TypeScript file and compares them, so
 * neither can satisfy the assertion on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const RUST = readFileSync(join(root, "src-tauri/src/commands/capabilities.rs"), "utf8");
const TS = readFileSync(join(root, "src/apiTypes.ts"), "utf8");

/** The body of a braced Rust/TS block opened by `head`, comments stripped. */
function body(src, head) {
  const at = src.indexOf(head);
  assert.notEqual(at, -1, `${head} is gone — this test is reading the wrong file`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      return src
        .slice(open + 1, i)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    }
  }
  throw new Error(`unterminated block after ${head}`);
}

/** The right-hand side of a TS type alias, up to its terminating semicolon. */
function alias(src, head) {
  const at = src.indexOf(head);
  assert.notEqual(at, -1, `${head} is gone — this test is reading the wrong file`);
  const end = src.indexOf(";", at);
  assert.notEqual(end, -1, `unterminated type alias after ${head}`);
  return src.slice(at + head.length, end);
}

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const sorted = (names) => [...new Set(names)].sort();

test("every Capability the host answers is one the UI may ask for", () => {
  const variants = sorted(
    [...body(RUST, "pub enum Capability").matchAll(/^\s*([A-Z]\w*)\s*,/gm)].map((m) =>
      snake(m[1][0].toLowerCase() + m[1].slice(1)),
    ),
  );
  assert.ok(variants.length >= 5, `only ${variants.length} variants parsed — the scan broke`);

  const union = sorted(
    [...alias(TS, "export type Capability =").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
  );
  assert.deepEqual(union, variants, "src/apiTypes.ts `Capability` has drifted from capabilities.rs");
});

test("every EngineCapabilities field the host sends is declared in TypeScript", () => {
  const fields = sorted([...body(RUST, "pub struct EngineCapabilities").matchAll(/pub (\w+):/g)].map((m) => m[1]));
  assert.ok(fields.length >= 12, `only ${fields.length} fields parsed — the scan broke`);

  const declared = sorted(
    [...body(TS, "export interface EngineCapabilities").matchAll(/^\s*(\w+)\??:/gm)].map((m) =>
      snake(m[1]),
    ),
  );
  assert.deepEqual(
    declared,
    fields,
    "src/apiTypes.ts `EngineCapabilities` has drifted from capabilities.rs",
  );
});
