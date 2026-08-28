/* Quote anchoring — the rule behind every "here is where I got that" receipt.
 *
 * When the model cites a passage, this is what decides whether the reader is
 * shown the sentence or told nothing was found. It is the fiddliest pure logic
 * in the viewer layer — case folding, curly quotes, ligatures, soft hyphens,
 * line-end hyphenation, whitespace disagreements between extractor and
 * renderer, Hebrew nikud, and a mirrored-line fallback for visual-order Hebrew
 * PDFs — and none of it had a test: it was only ever checked by a person
 * clicking a citation and seeing whether anything lit up.
 *
 * `src/viewers/highlight.ts` imports nothing, so it is exercised here directly
 * (type-stripped) rather than through a browser. What is pinned is the CONTRACT
 * both callers depend on: the returned span is measured in ORIGINAL source
 * indices, so `source.slice(start, end + 1)` is the text that gets painted, and
 * a quote that genuinely isn't there returns null instead of a nearby guess.
 *
 * Runs under `npm run test:page` (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/viewers/highlight.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { locateQuoteHebrewAware, normalizeForMatch, parseA1Range } = await import(
  `data:text/javascript;base64,${Buffer.from(JS).toString("base64")}`
);

/** What the viewer would paint for this hit. */
function found(source, quote) {
  const hit = locateQuoteHebrewAware(source, quote);
  return hit ? source.slice(hit.start, hit.end + 1) : null;
}

test("a quote is found across the ways a renderer and an extractor disagree", () => {
  const page =
    "The tenant shall pay rent on the first\nday of each month, without\ndemand.";
  // Newlines where the model wrote spaces.
  assert.equal(
    found(page, "pay rent on the first day of each month"),
    "pay rent on the first\nday of each month",
  );
  // Case is not a difference.
  assert.equal(found(page, "PAY RENT ON THE FIRST DAY"), "pay rent on the first\nday");

  // Typographic look-alikes: curly quotes, em dash, ligature.
  const typo = "the landlord’s agent — see the ﬁnal clause";
  assert.equal(found(typo, "the landlord's agent - see the final clause"), typo);

  // Hyphenated across a line end in the document, whole in the quote.
  const wrapped = "…full infor-\nmation about the deposit…";
  assert.equal(found(wrapped, "information about the deposit"), "infor-\nmation about the deposit");

  // A soft hyphen the renderer may or may not show.
  assert.equal(found("co­operation clause", "cooperation clause"), "co­operation clause");

  // Extractor lost the space the quote has (a real PDF failure mode) — the
  // whitespace-free fallback still anchors it.
  assert.equal(found("theremaining balance is due", "the remaining balance"), "theremaining balance");
});

test("a quote that is not in the document anchors nowhere", () => {
  // The whole point of a receipt: a citation that cannot be located must fail
  // rather than land on the nearest-looking text.
  const page = "The tenant shall pay rent on the first day of each month.";
  assert.equal(locateQuoteHebrewAware(page, "the tenant may sublet the flat"), null);
  assert.equal(locateQuoteHebrewAware(page, ""), null);
  assert.equal(locateQuoteHebrewAware(page, "   \n  "), null);
  assert.equal(locateQuoteHebrewAware("", "anything"), null);
});

test("Hebrew: nikud folds away, and a visual-order line still anchors", () => {
  // The document is pointed, the quote is consonantal (or the reverse).
  const pointed = "בְּרֵאשִׁית בָּרָא אֱלֹהִים";
  assert.equal(found(pointed, "בראשית ברא"), "בְּרֵאשִׁית בָּרָא");
  // Maqaf ≡ hyphen: models type the ASCII one.
  assert.equal(found("דוד בן־גוריון", "בן-גוריון"), "בן־גוריון");

  // Visual-order Hebrew PDF: the page stores the line character-mirrored,
  // while the app's repaired extracted text (and so the model's quote) is
  // logical. The hit must come back in ORIGINAL page indices.
  const logical = "שלום עולם";
  const mirrored = [...logical].reverse().join("");
  const page = `header\n${mirrored}\nfooter`;
  const hit = locateQuoteHebrewAware(page, logical);
  assert.ok(hit, "the mirrored line must still be found");
  assert.equal(page.slice(hit.start, hit.end + 1), mirrored);
});

test("normalizeForMatch is the same rule applied to both sides", () => {
  // Needle and haystack go through one function; if they ever diverge, every
  // fold above becomes a silent miss.
  assert.equal(normalizeForMatch("  The  Landlord’s\nAgent "), "the landlord's agent");
  assert.equal(normalizeForMatch("ﬁnal"), "final");
  assert.equal(normalizeForMatch(""), "");
});

test("a spreadsheet citation resolves to a normalized rectangle", () => {
  // Same receipt, different viewer: "B2:D5" is how a sheet quote arrives.
  assert.deepEqual(parseA1Range("B7"), { r1: 6, c1: 1, r2: 6, c2: 1 });
  assert.deepEqual(parseA1Range("B2:D5"), { r1: 1, c1: 1, r2: 4, c2: 3 });
  // Given backwards, it still means the same rectangle.
  assert.deepEqual(parseA1Range("D5:B2"), { r1: 1, c1: 1, r2: 4, c2: 3 });
  // Past column Z.
  assert.deepEqual(parseA1Range("AA1"), { r1: 0, c1: 26, r2: 0, c2: 26 });
  // Nothing to point at reads as nothing.
  assert.equal(parseA1Range(undefined), null);
  assert.equal(parseA1Range("not a cell"), null);
  assert.equal(parseA1Range("B0"), null);
});
