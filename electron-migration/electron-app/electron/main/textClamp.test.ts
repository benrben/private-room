import { describe, expect, it } from "vitest";
import {
  clampBytes,
  clampBytesMarked,
  clampChars,
  clampMarked,
  clampWords,
  excerpt,
  floorBoundary,
  normalizeForMatch,
  tailBytes,
} from "./textClamp.js";

describe("normalizeForMatch", () => {
  it("lower-cases and collapses whitespace", () => {
    expect(normalizeForMatch("  Hello   World  ")).toBe("hello world");
  });
  it("folds curly quotes to straight ones", () => {
    expect(normalizeForMatch("“it’s”")).toBe('"it\'s"');
  });
  it("folds en/em dash and Hebrew maqaf to a hyphen", () => {
    expect(normalizeForMatch("2020–2021")).toBe("2020-2021");
    expect(normalizeForMatch("2020—2021")).toBe("2020-2021");
    expect(normalizeForMatch("בן־דוד")).toBe("בן-דוד");
  });
  it("expands the fi/fl ligatures", () => {
    expect(normalizeForMatch("ﬁle ﬂow")).toBe("file flow");
  });
  it("strips Hebrew nikud so pointed and unpointed text match", () => {
    const pointed = "שָׁלוֹם";
    const plain = "שלום";
    expect(normalizeForMatch(pointed)).toBe(normalizeForMatch(plain));
  });
});

describe("floorBoundary", () => {
  it("returns the string's full byte length when max is past the end", () => {
    expect(floorBoundary("hello", 100)).toBe(Buffer.byteLength("hello", "utf8"));
  });
  it("never lands mid-codepoint for multi-byte UTF-8", () => {
    const s = "aבb"; // ב is 2 UTF-8 bytes
    // Cutting at byte 2 would land inside ב's 2-byte encoding.
    const cut = floorBoundary(s, 2);
    expect(cut).toBe(1); // backs up to just after "a"
  });
});

describe("clampBytes", () => {
  it("returns the string unchanged when it already fits", () => {
    expect(clampBytes("hello", 100)).toBe("hello");
  });
  it("cuts at a byte boundary without splitting a multi-byte char", () => {
    const s = "aבב"; // a(1) + ב(2) + ב(2) = 5 bytes
    const cut = clampBytes(s, 3);
    expect(cut).toBe("aב");
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(3);
  });
});

describe("clampBytesMarked", () => {
  it("appends the marker only when a cut actually happened", () => {
    expect(clampBytesMarked("short", 100, "…")).toBe("short");
  });
  it("appends the marker and still fits within max", () => {
    const out = clampBytesMarked("a".repeat(20), 10, "[cut]");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(10);
    expect(out.endsWith("[cut]")).toBe(true);
  });
});

describe("tailBytes", () => {
  it("is empty when the string already fits", () => {
    expect(tailBytes("hello", 100)).toBe("");
  });
  it("returns the LAST max bytes without splitting a char", () => {
    const s = "aבבcd"; // a(1) ב(2) ב(2) c(1) d(1) = 7 bytes total
    const tail = tailBytes(s, 3);
    expect(tail).toBe("cd"); // last 3 bytes would split ב, so it backs off to 2 ("cd")
  });
});

describe("clampMarked", () => {
  it("returns the string unchanged when it fits, counting CODE POINTS", () => {
    const hebrew = "א".repeat(50);
    expect(clampMarked(hebrew, 50)).toBe(hebrew);
  });
  it("marks a cut and strips a dangling separator before the marker", () => {
    const out = clampMarked("one, two, three, four, five", 12);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[,;:\-(]…$/);
  });
});

describe("clampChars", () => {
  it("cuts by CODE POINT, not UTF-16 unit, so Hebrew is not double-counted", () => {
    const hebrew = "א".repeat(500);
    expect(clampChars(hebrew, 500)).toHaveLength(500);
    const over = "א".repeat(510);
    const cut = clampChars(over, 500);
    expect([...cut]).toHaveLength(500);
  });
  it("returns short strings untouched", () => {
    expect(clampChars("hello", 500)).toBe("hello");
  });
});

describe("clampWords", () => {
  it("returns the string unchanged when it fits", () => {
    expect(clampWords("hello world", 50)).toBe("hello world");
  });
  it("cuts at a trailing word boundary when one exists past the midpoint", () => {
    const out = clampWords("the quick brown fox jumps", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("jum…"); // should have backed up to a word boundary
  });
  it("never splits a character even with no good word boundary", () => {
    const out = clampWords("a".repeat(30), 10);
    expect(out.endsWith("…")).toBe(true);
    expect([...out.slice(0, -1)]).toHaveLength(10);
  });
});

describe("excerpt", () => {
  it("returns a char-safe prefix with an ellipsis when nothing matches", () => {
    const out = excerpt("hello world, nothing to find here", "zzz", 10);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns the whole text with no trailing ellipsis when it fits and nothing needed cutting", () => {
    expect(excerpt("short text", "zzz", 100)).toBe("short text");
  });
  it("centers the excerpt on the query match", () => {
    const text = "before ".repeat(20) + "TARGET" + " after".repeat(20);
    const out = excerpt(text, "target", 30);
    expect(out.toLowerCase()).toContain("target");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
  it("falls back to the first query WORD when the whole query doesn't match verbatim", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const out = excerpt(text, "brown zzz-not-there", 40);
    expect(out.toLowerCase()).toContain("brown");
  });
  it("is case-insensitive", () => {
    const text = "The Quick Brown Fox";
    expect(excerpt(text, "quick", 40)).toContain("Quick");
  });
});
