/* Does the README still name the file type this app actually creates?
 *
 * The rename to Arcelle changed the extension a NEW room is saved with to
 * `.arcelle` (`src/rooms/constants.ts`, and the `fileAssociations` entry in
 * tauri.conf.json); `.roomai` stayed openable for every room made before it.
 * The README went on calling a room a `.roomai` file in its opening line and
 * four other places, and never named the new one at all — so the first thing a
 * new reader learns is a file type the app no longer produces, and nothing
 * anywhere fails when that drifts again.
 *
 * Pins the two claims that matter, not the prose: the new extension is named,
 * and the legacy one is described as legacy rather than as the default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const README = read("README.md");
const CONSTANTS = read("src/rooms/constants.ts");
const TAURI_CONF = JSON.parse(read("src-tauri/tauri.conf.json"));

test("the app really does save new rooms as .arcelle", () => {
  // The premise of the test below — asserted, not assumed.
  assert.match(CONSTANTS, /extensions:\s*\["arcelle",\s*"roomai"\]/);
  const exts = JSON.stringify(TAURI_CONF).match(/"ext":\s*\[[^\]]*\]/)?.[0] ?? "";
  assert.ok(exts.includes("arcelle"), exts);
});

test("the README names the extension a new room actually gets", () => {
  assert.ok(README.includes(".arcelle"), "README never mentions .arcelle");
  // …and in the opening description, not only in a footnote.
  const about = README.slice(README.indexOf("## About the project"));
  assert.ok(
    about.slice(0, 400).includes(".arcelle"),
    "the opening paragraph still names only the old extension",
  );
});

test("the README treats .roomai as the legacy name, not the default", () => {
  // Every surviving mention has to sit next to a word that dates it, or the
  // reader cannot tell which one their own room will get.
  for (const line of README.split("\n")) {
    if (!line.includes(".roomai")) continue;
    assert.match(
      line,
      /before|legacy|older|still|previous|reads both|\.arcelle/,
      `unqualified .roomai claim: ${line}`,
    );
  }
});
