/* "The findings are about a transcript that no longer exists" — for ever, on
 * every non-ASCII recording.
 *
 * Rust stamps a reading pass with `ReadStamp::of` (src-tauri/src/recording.rs):
 * `turns` = phrase count, `chars` = `String::len`, which is a count of UTF-8
 * BYTES. RecordingView compared that against `s.text.length`, which counts
 * UTF-16 code units. The two agree only on pure ASCII, so a Hebrew (2 bytes per
 * letter) or emoji (4 bytes, 2 units) transcript could never match its own
 * stamp: `stale` was pinned true and every note, highlight and chapter was
 * flagged as belonging to a transcript that had been rewritten.
 *
 * `readingIsStale` is lifted out of `RecordingView.tsx` by source slice: the
 * file itself imports React and cannot be loaded here, but the function is
 * self-contained (its only dependency is `TextEncoder`), so the real code runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const VIEW = readFileSync(join(root, "apps/desktop/src/renderer/viewers/RecordingView.tsx"), "utf8");

/** The declaration, from `export function` to the line that closes it. */
function slice(name) {
  const at = VIEW.indexOf(`export function ${name}(`);
  assert.notEqual(at, -1, `${name} has been renamed — re-point this test`);
  const end = VIEW.indexOf("\n}\n", at);
  assert.notEqual(end, -1, `${name} has no closing brace at column 0`);
  return VIEW.slice(at, end + 2);
}

const js = transformSync(slice("readingIsStale"), {
  loader: "ts",
  format: "esm",
  target: "es2022",
}).code;
const { readingIsStale } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

/** What `ReadStamp::of` writes for these phrases, in Rust's units. */
function rustStamp(texts) {
  return {
    turns: texts.length,
    chars: texts.reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0),
  };
}

const segs = (texts) => texts.map((text) => ({ text }));

test("a recording nobody has read is never stale", () => {
  assert.equal(readingIsStale(undefined, segs(["anything"])), false);
});

test("an untouched ASCII transcript matches the stamp it was read from", () => {
  const texts = ["Good morning everyone.", "Shall we start?"];
  assert.equal(readingIsStale(rustStamp(texts), segs(texts)), false);
});

test("an untouched HEBREW transcript matches the stamp it was read from", () => {
  // THE DEFECT: 12 UTF-8 bytes, 6 UTF-16 units. Compared in the wrong unit the
  // reading looked rewritten the instant it was made.
  const texts = ["בוקר טוב", "נתחיל?"];
  assert.equal(
    readingIsStale(rustStamp(texts), segs(texts)),
    false,
    "a Hebrew transcript is reported as rewritten the moment it is read",
  );
});

test("...and so does one carrying emoji, where UTF-16 also disagrees with itself", () => {
  // 4 UTF-8 bytes but 2 UTF-16 units, so a surrogate pair moves the count the
  // other way from Hebrew — a fix that merely scaled the number would pass one
  // of these two and fail the other.
  const texts = ["ship it 🚀"];
  assert.equal(readingIsStale(rustStamp(texts), segs(texts)), false);
});

test("an edited transcript IS stale — the honest half of the same check", () => {
  const read = rustStamp(["בוקר טוב", "נתחיל?"]);
  assert.equal(readingIsStale(read, segs(["בוקר טוב", "נתחיל עכשיו?"])), true);
});

test("a phrase split in two is stale even when not one letter changed", () => {
  const read = rustStamp(["בוקר טוב נתחיל"]);
  assert.equal(readingIsStale(read, segs(["בוקר טוב", " נתחיל"])), true);
});

test("the panel's staleness comes from this function and nowhere else", () => {
  assert.match(
    VIEW,
    /const stale = readingIsStale\(meta\?\.readOf, meta\?\.segments \?\? \[\]\)/,
    "ReadPanel no longer asks readingIsStale whether the words moved",
  );
  assert.equal(
    /readOf!\.chars/.test(VIEW),
    false,
    "the stamp is still being compared inline, in whatever unit that call site uses",
  );
});
