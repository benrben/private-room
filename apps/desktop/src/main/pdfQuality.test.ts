/**
 * Tests for `pdfQuality.ts`. The first eleven are
 * `src-tauri/src/extraction/pdf_quality.rs`'s own `#[cfg(test)] mod tests`,
 * ported one for one: same `#[test]` names, same fixtures, same assertions.
 * The rest pin behaviour the Rust has but never tested, where a natural JS
 * translation silently diverges from it.
 *
 * Any character that would be invisible or confusable on the page is written
 * as an explicit `\u` escape, never typed as a literal — the same rule
 * `editMatchExtraction.test.ts` states for itself.
 */

import { describe, expect, it } from "vitest";
import { choose, faultIn, MIN_SAMPLE, shouldRereadWithOcr } from "./pdfQuality.js";

const GOOD =
  "The lease commences on the first of March and continues for a term of " +
  "twenty-four months. Rent is payable monthly in advance. The tenant shall keep the " +
  "premises in good repair and shall not sublet without written consent from the landlord.";

const HEBREW =
  "חוזה השכירות מתחיל בראשון למרץ וממשיך לתקופה של עשרים וארבעה חודשים. " +
  "דמי השכירות משולמים מדי חודש מראש והשוכר ישמור על הנכס במצב תקין.";

describe("faultIn / shouldRereadWithOcr", () => {
  it("ordinary_prose_passes", () => {
    expect(faultIn(GOOD)).toBeNull();
    expect(shouldRereadWithOcr(GOOD)).toBe(false);
  });

  it("an_empty_reading_is_the_scan_case", () => {
    expect(faultIn("")).toBe("empty");
    expect(faultIn("   \n\n  ")).toBe("empty");
    expect(shouldRereadWithOcr("")).toBe(true);
  });

  it("words_run_together_are_caught", () => {
    // The ToUnicode/width failure: every glyph arrives, no spaces do. The old
    // code indexed this happily and search could never match a word.
    const jammed = GOOD.repeat(2).replaceAll(" ", "");
    expect(faultIn(jammed)).toBe("no_word_breaks");
  });

  it("a_reading_under_the_sample_floor_is_only_judged_on_emptiness", () => {
    // The floor is load-bearing in both directions, so it is pinned here
    // rather than left as an implementation detail: a short cover page must
    // pass, and a short jammed one is NOT enough evidence to re-OCR a whole
    // document over.
    const shortJammed = "Thisisashortline".repeat(2);
    expect(shortJammed.length).toBeLessThan(MIN_SAMPLE);
    expect(faultIn(shortJammed)).toBeNull();
  });

  it("an_unmapped_font_is_caught", () => {
    const broken = "\u{fffd}".repeat(120) + GOOD;
    expect(faultIn(broken)).toBe("undecodable");
  });

  it("symbol_soup_is_caught", () => {
    // A font with no usable character map often emits private-use glyphs.
    const soup = "\u{e000}".repeat(400);
    expect(faultIn(soup)).toBe("not_language");
  });

  it("a_short_cover_page_is_not_judged_on_ratios", () => {
    // "Annual Report 2026" is a legitimate whole-page reading; measuring space
    // ratios over 18 characters would reject real documents.
    expect(faultIn("Annual Report 2026")).toBeNull();
    expect(faultIn("Title")).toBeNull();
  });

  it("hebrew_and_accented_prose_are_language", () => {
    // `is_ascii_punctuation` alone would fail these; the readable test has to
    // be Unicode-aware or every non-English PDF gets re-OCR'd.
    const hebrew = HEBREW.repeat(2);
    expect(faultIn(hebrew), "Hebrew prose was judged unreadable").toBeNull();
    const french = (
      "Le siège social de la société est établi à Paris. " +
      "Les présentes conditions générales régissent l'utilisation du service."
    ).repeat(3);
    expect(faultIn(french), "accented prose was judged unreadable").toBeNull();
  });
});

describe("choose", () => {
  it("clean_extracted_text_is_never_replaced_by_ocr", () => {
    // Vision can misread a ligature or a digit; the embedded text of a
    // well-encoded PDF is exact. Faultless extraction always wins.
    const ocr =
      "The leaso commences on the flrst of Marcb and continues for a term of " +
      "twenty-four montbs. Rent is payable montbly in advance. The tenant shall keep " +
      "the premises in good repair and shall not sublet without consent.";
    expect(choose(GOOD, ocr)).toBe(GOOD);
  });

  it("faulty_extraction_yields_to_a_clean_ocr", () => {
    const jammed = GOOD.repeat(2).replaceAll(" ", "");
    expect(choose(jammed, GOOD)).toBe(GOOD);
  });

  it("a_blank_ocr_never_erases_real_text", () => {
    // The regression this guards: "OCR ran, so use OCR" would replace a
    // faulty-but-present reading with nothing at all.
    const jammed = GOOD.repeat(2).replaceAll(" ", "");
    expect(choose(jammed, "   ")).toBe(jammed);
    expect(choose(GOOD, null)).toBe(GOOD);
    expect(choose(null, null)).toBeNull();
  });
});

describe("fidelity to Rust's character and length semantics", () => {
  it("vocalized hebrew is language, not symbol soup", () => {
    // Rust's `is_alphabetic()` is the Unicode ALPHABETIC PROPERTY, not the
    // `\p{L}` category: niqqud are combining marks (Mn) that the property
    // covers and the category does not. Scored as `\p{L}` this fixture reads
    // ~0.54 readable and every vocalized Hebrew PDF — a siddur, a Torah text,
    // pointed poetry — is re-OCR'd on import.
    const vocalized = [...HEBREW.repeat(2)]
      .map((c) => (/^[\u{05d0}-\u{05ea}]$/u.test(c) ? c + "\u{05b8}" : c))
      .join("");
    expect(faultIn(vocalized)).toBeNull();
  });

  it("a byte-order mark is not whitespace, the way Rust counts it", () => {
    // `String.prototype.trim()` eats U+FEFF; Rust's `str::trim()` does not,
    // because U+FEFF has no `White_Space` property. Trimming it away would
    // report a BOM-only extraction as the empty scan case and queue an OCR
    // pass the Rust never queues.
    expect(faultIn("\u{feff}")).toBeNull();
  });

  it("a reading of nothing but next-line separators is the scan case", () => {
    // The mirror image: U+0085 IS `White_Space` in Rust and is NOT trimmed by
    // JS, so a page whose extraction is only separators would read as content.
    expect(faultIn("\u{0085}".repeat(10))).toBe("empty");
    expect(shouldRereadWithOcr("\u{0085}".repeat(10))).toBe(true);
  });

  it("the both-are-poor tiebreak measures utf-8 bytes, not utf-16 units", () => {
    // Rust compares `str::len()`, i.e. UTF-8 bytes. Hebrew letters cost two
    // bytes each and one UTF-16 unit each, so a shorter Hebrew reading still
    // outweighs a longer ASCII one — and `.length` would hand the document to
    // the OCR instead.
    const hebrewJammed = "א".repeat(250);
    const asciiJammed = "a".repeat(300);
    expect(faultIn(hebrewJammed)).toBe("no_word_breaks");
    expect(faultIn(asciiJammed)).toBe("no_word_breaks");
    expect(choose(hebrewJammed, asciiJammed)).toBe(hebrewJammed);
    // The other tiebreak direction remains available for an ordinary longer
    // OCR reading; `choose` must not always preserve extraction once both
    // readings are faulty.
    expect(choose("x".repeat(250), "y".repeat(300))).toBe("y".repeat(300));
  });

  it("word breaks are any Unicode whitespace, not the ASCII space", () => {
    // The Rust says so in a comment — "a reader that emits one glyph per line
    // still separates its words" — and never tests it. Counting only U+0020
    // sends every line-broken extraction, the commonest shape a no-layout
    // reader produces, back through Vision.
    const perLine = GOOD.repeat(2).replaceAll(" ", "\n");
    expect(faultIn(perLine)).toBeNull();
  });

  it("only ASCII punctuation is readable — typographic punctuation is not", () => {
    // `is_ascii_punctuation` is exactly the 32 ASCII marks. Scoring `\p{P}`
    // instead would call a page of stray quote and dash glyphs language and
    // index it, which is the symbol-soup case this guard exists for.
    const typographic = "\u{2018}\u{2019}\u{201c}\u{201d}\u{2014}".repeat(60);
    expect(faultIn(typographic)).toBe("not_language");
  });

  it("the replacement-character ratio is strictly greater, never equal", () => {
    // 4 in 200 is exactly MAX_REPLACEMENT_RATIO and Rust's `>` lets it pass; a
    // fifth is 0.025 and does not. A `>=` here re-OCRs clean documents that
    // carry a couple of bad glyphs.
    expect(faultIn("\u{fffd}".repeat(4) + GOOD.slice(0, 196))).toBeNull();
    expect(faultIn("\u{fffd}".repeat(5) + GOOD.slice(0, 195))).toBe("undecodable");
  });

  it("the sample floor is strictly less — 200 characters ARE judged", () => {
    // The other side of `a_reading_under_the_sample_floor…`, which only pins a
    // 32-character reading: MIN_SAMPLE itself is inside the judged range.
    expect(faultIn("x".repeat(199))).toBeNull();
    expect(faultIn("x".repeat(200))).toBe("no_word_breaks");
  });

  it("the readable ratio is strictly less, never equal", () => {
    // MIN_READABLE_RATIO exactly is language; a fortieth of a point below it is
    // not. Every fixture above sits far from the line, so the operator itself
    // would otherwise be free to drift.
    expect(faultIn(GOOD.slice(0, 160) + "\u{e000}".repeat(40))).toBeNull();
    expect(faultIn(GOOD.slice(0, 159) + "\u{e000}".repeat(41))).toBe("not_language");
  });

  it("the space ratio is strictly less, never equal", () => {
    // 12 breaks in 200 characters is exactly MIN_SPACE_RATIO and passes; 11 is
    // 0.055 and does not.
    expect(faultIn(("x".repeat(15) + " ").repeat(12) + "x".repeat(8))).toBeNull();
    expect(faultIn(("x".repeat(15) + " ").repeat(11) + "x".repeat(24))).toBe("no_word_breaks");
  });

  it("digits are readable — a page of figures is language", () => {
    // `is_alphanumeric()` is `is_alphabetic() || is_numeric()`, and no digit is
    // Alphabetic. Dropping the numeric half sends every financial table and
    // numeric appendix — pages where the extraction is usually perfect — back
    // through Vision.
    const figures = "1 240 000 3 500 12 75 480 9 000 ".repeat(9);
    expect(faultIn(figures)).toBeNull();
  });

  it("page-break padding is trimmed off BOTH ends before anything is measured", () => {
    // A no-layout reader pads page joins with runs of newlines. Rust measures
    // `text.trim()`, so the padding is gone before the ratios are taken; count
    // it at either end and a jammed reading's space ratio is dominated by the
    // padding and the document is indexed as prose.
    const jammed = GOOD.repeat(2).replaceAll(" ", "");
    expect(faultIn("\n".repeat(200) + jammed)).toBe("no_word_breaks");
    expect(faultIn(jammed + "\n".repeat(200))).toBe("no_word_breaks");
  });

  it("astral characters are sampled as scalar values, not as surrogate halves", () => {
    // A maths PDF extracts as U+1D400-block letters. Walking UTF-16 units
    // instead of `chars()` scores each one as two unreadable halves, so the
    // page reads 0.11 readable and is re-OCR'd — and the 20,000 cap would
    // silently become a 20,000-unit cap at the same time.
    const mathBold = "\u{1d400}\u{1d401}\u{1d402}\u{1d403} ".repeat(50);
    expect(faultIn(mathBold)).toBeNull();
  });

  it("only the first 20,000 characters are sampled", () => {
    // `chars().take(20_000)`: the failure modes are properties of the fonts
    // and the layout, so a clean head is the whole answer. Without the cap
    // this reading scores 0.4 readable and a 900-page book with a garbled
    // appendix would be re-OCR'd end to end.
    const head = GOOD.repeat(120).slice(0, 20_000);
    expect(head.length).toBe(20_000);
    expect(faultIn(head + "\u{e000}".repeat(30_000))).toBeNull();
  });
});
