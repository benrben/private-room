/**
 * Vitest port of the `fuzzy_find`-related tests in
 * `src-tauri/src/commands/edit_match.rs`'s `mod tests` — the five that
 * exercise the matcher directly (as opposed to through the connection-level
 * `run_edit_file`, which lives in `editMatch.test.ts` alongside its real-room
 * fixtures) — plus this port's own edge cases for the position-unit
 * adaptation and for characters the Rust tests never reach.
 *
 * A style note that matters for THIS file specifically: any character that
 * would be invisible or easily confused with another on the page (NUL, a
 * zero-width space, NBSP, one of several near-identical dashes) is spelled
 * with an explicit `\u` escape rather than typed as a literal, so every
 * assertion stays independently verifiable by the code point alone.
 */

import { describe, expect, it } from "vitest";
import { fuzzyFind, normalizeNeedle, normalizeWithSpans } from "./editMatchFuzzy.js";

describe("fuzzyFind (ported from edit_match.rs::tests)", () => {
  it("fold table covers quotes, nbsp, crlf, dashes", () => {
    // Straight/plain-space/LF needle folds to meet a curly/NBSP/CRLF/dash file.
    expect(fuzzyFind("say \u{201C}hi\u{201D} now", 'say "hi" now').kind).toBe("unique");
    expect(fuzzyFind("a\u{00A0}b\r\nc", "a b c").kind).toBe("unique");
    expect(fuzzyFind("it\u{2019}s en\u{2013}dash", "it's en-dash").kind).toBe("unique");
    // A zero-width space in the file is dropped, not a barrier.
    expect(fuzzyFind("wor\u{200B}d here", "word here").kind).toBe("unique");
    // fi ligature in the FILE, ASCII in the needle (the realistic direction).
    expect(fuzzyFind("the \u{FB01}nal draft", "the final draft").kind).toBe("unique");
  });

  it("refuses a match that would split a ligature", () => {
    // Both halves of U+FB01 map back to the SAME source char, so a match that
    // starts on the `i` (or ends on the `f`) returned a span covering the
    // whole ligature: splicing it deleted a letter the quote never named,
    // reported as "Replaced 1 occurrence(s)".
    const file = "the \u{FB01}nal draft";
    expect(fuzzyFind(file, "inal draft").kind).toBe("notFound");
    expect(fuzzyFind(file, "the f").kind).toBe("notFound");
    // Covering the whole character still matches, spanning it exactly.
    const found = fuzzyFind(file, "the final draft");
    if (found.kind !== "unique") {
      throw new Error("the whole-character match must still resolve");
    }
    expect(file.slice(found.start, found.end)).toBe(file);
  });

  it("returns an exact span on multibyte text", () => {
    // Hebrew + curly quotes: the returned range must slice the ORIGINAL cleanly.
    const content = "פתיח \u{201C}שלום עולם\u{201D} סוף";
    const found = fuzzyFind(content, '"שלום עולם"');
    if (found.kind !== "unique") {
      throw new Error("expected a unique multibyte hit");
    }
    expect(content.slice(found.start, found.end)).toBe("\u{201C}שלום עולם\u{201D}");
  });

  it("requires uniqueness", () => {
    // A needle that appears twice post-normalization is ambiguous, not unique.
    expect(fuzzyFind("the fee is 5% and the fee is 5% again", "the fee is 5%")).toEqual({
      kind: "ambiguous",
      count: 2,
    });
    // An empty / whitespace-only needle never matches.
    expect(fuzzyFind("abc", "   ").kind).toBe("notFound");
  });

  it("does not match across a blank line", () => {
    // A single-space needle must NOT splice two paragraphs into one (the docx
    // matcher refuses this too; the text side mirrors it).
    expect(fuzzyFind("end of one.\n\nStart of two.", "one. Start").kind).toBe("notFound");
    // A single newline (a wrapped line) still matches.
    expect(fuzzyFind("end of one\nStart of two", "one Start").kind).toBe("unique");
  });
});

describe("fuzzyFind — additional edge cases (not in the Rust test module)", () => {
  it("empty content never matches a non-empty needle", () => {
    expect(fuzzyFind("", "anything").kind).toBe("notFound");
  });

  it("an empty needle is always notFound, even against empty content", () => {
    expect(fuzzyFind("", "").kind).toBe("notFound");
    expect(fuzzyFind("hello", "").kind).toBe("notFound");
  });

  it("counts non-overlapping occurrences, not overlapping ones", () => {
    // "aaa" contains "aa" at 0 AND at 1 (overlapping), but a non-overlapping
    // left-to-right scan finds only one full match plus a leftover "a" that
    // can't complete a second — so this is unique, not ambiguous, exactly
    // mirroring the advance discipline `fuzzy_find`'s own doc calls out.
    expect(fuzzyFind("aaa", "aa").kind).toBe("unique");
    expect(fuzzyFind("aaaa", "aa")).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("three occurrences count as three", () => {
    expect(fuzzyFind("aaa aaa aaa", "aaa")).toEqual({ kind: "ambiguous", count: 3 });
  });

  it("a needle equal to the whole haystack is a unique match spanning it all", () => {
    const found = fuzzyFind("hello world", "hello world");
    if (found.kind !== "unique") {
      throw new Error("expected a unique whole-haystack match");
    }
    expect(found.start).toBe(0);
    expect(found.end).toBe("hello world".length);
  });

  it("a NUL in the needle is dropped — never matches literally, never crashes", () => {
    // `foldEditChar(NUL)` is `drop`, so a needle carrying one behaves exactly
    // as if the NUL were absent — the plain-text analogue of the docx guard
    // against a NUL surviving into a match and indexing the sentinel entry.
    const needleWithNul = `hello${String.fromCharCode(0)} world`;
    const found = fuzzyFind("hello world", needleWithNul);
    if (found.kind !== "unique") {
      throw new Error("a NUL in the needle must simply be dropped");
    }
    expect("hello world".slice(found.start, found.end)).toBe("hello world");
  });

  it("a NUL in the haystack never crashes and is dropped there too", () => {
    const haystackWithNul = `hello${String.fromCharCode(0)} world`;
    const found = fuzzyFind(haystackWithNul, "hello world");
    if (found.kind !== "unique") {
      throw new Error("a NUL in the haystack must simply be dropped");
    }
    expect(haystackWithNul.slice(found.start, found.end)).toBe(haystackWithNul);
  });

  it("an astral character is never split by a match boundary", () => {
    // U+1F600 is two UTF-16 code units; a needle including it whole must
    // match cleanly and the span must cover both units, never land between.
    const content = "before \u{1F600} after";
    const found = fuzzyFind(content, "before \u{1F600} after");
    if (found.kind !== "unique") {
      throw new Error("expected a unique whole-content match");
    }
    expect(content.slice(found.start, found.end)).toBe(content);
    expect(found.end - found.start).toBe(content.length);
  });

  it("a needle found AFTER an astral character still returns a correctly-offset span", () => {
    // If span tracking advanced by 1 per character instead of by `c.length`,
    // every position after the emoji would be off by one and the returned
    // span would slice one code unit short.
    const content = "\u{1F600} hello world";
    const found = fuzzyFind(content, "hello world");
    if (found.kind !== "unique") {
      throw new Error("expected a unique hit after the astral character");
    }
    expect(content.slice(found.start, found.end)).toBe("hello world");
    expect(found.start).toBe("\u{1F600} ".length); // surrogate pair + space
  });

  it("multiple whitespace kinds in a row still collapse to one space", () => {
    expect(fuzzyFind("a\t\u{0020}\u{0020}b", "a b").kind).toBe("unique");
  });

  it("three or more consecutive newlines still count as one paragraph break", () => {
    expect(fuzzyFind("one\n\n\ntwo", "one two").kind).toBe("notFound");
    expect(fuzzyFind("alpha\n\n\nbeta", "alpha beta").kind).toBe("notFound");
  });

  it("tolerates NBSP and narrow-NBSP the same as an ordinary space", () => {
    expect(fuzzyFind("caf\u{00E9}\u{202F}au lait", "café au lait").kind).toBe("unique");
  });

  it("case is never folded — a case-different match is not found", () => {
    // Edits rewrite bytes, so a fuzzy hit must never land on a case-variant
    // of a different passage.
    expect(fuzzyFind("Hello World", "hello world").kind).toBe("notFound");
  });
});

describe("normalizeNeedle", () => {
  it("collapses internal whitespace to one space and trims the edges", () => {
    expect(normalizeNeedle("  hello    world  ").join("")).toBe("hello world");
  });

  it("folds curly quotes and dashes the same way foldEditChar does", () => {
    expect(normalizeNeedle("\u{201C}hi\u{201D} \u{2013} bye").join("")).toBe('"hi" - bye');
  });

  it("never produces the paragraph sentinel, even for a multi-newline run", () => {
    const out = normalizeNeedle("a\n\n\nb").join("");
    expect(out).toBe("a b");
    expect(out).not.toContain(String.fromCharCode(0));
  });
});

describe("normalizeWithSpans", () => {
  it("maps a collapsed whitespace run's span to the WHOLE original run", () => {
    const norm = normalizeWithSpans("a   b");
    expect(norm.chars).toEqual(["a", " ", "b"]);
    expect(norm.spans[1]).toEqual([1, 4]);
  });

  it("a ligature in the source produces two entries sharing one source span", () => {
    const norm = normalizeWithSpans("x\u{FB01}y");
    expect(norm.chars).toEqual(["x", "f", "i", "y"]);
    expect(norm.spans[1]).toEqual(norm.spans[2]);
    expect(norm.spans[1]).toEqual([1, 2]);
  });

  it("a paragraph run becomes the NUL sentinel, a single newline a plain space", () => {
    expect(normalizeWithSpans("a\n\nb").chars).toEqual(["a", String.fromCharCode(0), "b"]);
    expect(normalizeWithSpans("a\nb").chars).toEqual(["a", " ", "b"]);
  });
});
