/**
 * Tests for `editMatchExtraction.ts` — the `extraction.rs` subset the edit
 * engine stands on: the extension registry, the ONE shared fold table, the
 * encoding-aware decoder, and the entity/tag string helpers. The fold table
 * is the single most load-bearing piece: `editMatchFuzzy.test.ts`,
 * `editMatchDocx.test.ts` and `editMatchHtml.test.ts` all exercise it
 * indirectly through their matchers; these pin it directly.
 *
 * Any character that would be invisible or confusable on the page is written
 * as an explicit `\u` escape, never typed as a literal.
 */

import { describe, expect, it } from "vitest";
import {
  asciiLower,
  decodeBasicEntities,
  decodeTextBytes,
  extensionOf,
  foldEditChar,
  isTextExtension,
  normalizeWhitespace,
  stripTags,
  textExtensions,
  xmlParasToText,
} from "./editMatchExtraction.js";

describe("extensionOf", () => {
  it("returns the lower-cased text after the last dot", () => {
    expect(extensionOf("notes.MD")).toBe("md");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("has no extension for a dotless name, a dotfile, or a trailing dot", () => {
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("README")).toBe("");
    // `Path::extension()`'s own rule: a leading dot is a file STEM.
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("weird.")).toBe("");
  });

  it("still matches the DOTTED spelling of a leading-dot extension", () => {
    expect(extensionOf("web.dockerfile")).toBe("dockerfile");
  });

  it("reads only the file's own name, not its directory path", () => {
    expect(extensionOf("folder/notes.txt")).toBe("txt");
    expect(extensionOf("dir.d/README")).toBe("");
  });
});

describe("isTextExtension / textExtensions", () => {
  it("accepts the common source/text extensions", () => {
    for (const ext of ["txt", "md", "json", "py", "ts", "rs", "yaml", "csv"]) {
      expect(isTextExtension(ext)).toBe(true);
    }
  });

  it("rejects binary/office extensions and the empty extension", () => {
    for (const ext of ["docx", "xlsx", "pdf", "png", "html", ""]) {
      expect(isTextExtension(ext)).toBe(false);
    }
  });

  it("exposes the whole registry, and every entry classifies as text", () => {
    const all = textExtensions();
    expect(all.length).toBeGreaterThan(50);
    expect(all.every((e) => isTextExtension(e))).toBe(true);
  });
});

describe("foldEditChar", () => {
  it("drops zero-widths and NUL", () => {
    for (const cp of [0x200b, 0x200c, 0x200d, 0xfeff, 0x0000]) {
      expect(foldEditChar(String.fromCodePoint(cp))).toEqual({ kind: "drop" });
    }
  });

  it("folds curly and modifier apostrophes to a straight single quote", () => {
    for (const cp of [0x2018, 0x2019, 0x02bc]) {
      expect(foldEditChar(String.fromCodePoint(cp))).toEqual({ kind: "char", c: "'" });
    }
  });

  it("folds curly double quotes to a straight double quote", () => {
    for (const cp of [0x201c, 0x201d]) {
      expect(foldEditChar(String.fromCodePoint(cp))).toEqual({ kind: "char", c: '"' });
    }
  });

  it("folds the dash/minus/maqaf family to an ASCII hyphen", () => {
    for (const cp of [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212, 0x05be]) {
      expect(foldEditChar(String.fromCodePoint(cp))).toEqual({ kind: "char", c: "-" });
    }
  });

  it("expands the fi/fl ligatures into a boundary-safe pair", () => {
    expect(foldEditChar("\u{FB01}")).toEqual({ kind: "pair", a: "f", b: "i" });
    expect(foldEditChar("\u{FB02}")).toEqual({ kind: "pair", a: "f", b: "l" });
  });

  it("classifies Unicode whitespace as space — including NEL, which JS's \\s misses", () => {
    for (const cp of [0x0020, 0x0009, 0x000a, 0x000d, 0x00a0, 0x0085, 0x2003, 0x202f, 0x3000]) {
      expect(foldEditChar(String.fromCodePoint(cp)).kind).toBe("space");
    }
  });

  it("passes an ordinary character through unchanged, case intact", () => {
    expect(foldEditChar("q")).toEqual({ kind: "char", c: "q" });
    expect(foldEditChar("Q")).toEqual({ kind: "char", c: "Q" });
    expect(foldEditChar("5")).toEqual({ kind: "char", c: "5" });
  });
});

describe("asciiLower", () => {
  it("folds only A-Z, and never changes the string's length", () => {
    // `String.prototype.toLowerCase()` expands Turkish dotted-I (U+0130) to
    // TWO code units, which shifts every offset found in the folded copy.
    const s = "<DIV>\u{0130}\u{0130}</DIV>";
    expect(asciiLower(s).length).toBe(s.length);
    expect(asciiLower(s)).toBe("<div>\u{0130}\u{0130}</div>");
    expect(s.toLowerCase().length).not.toBe(s.length);
  });
});

describe("decodeTextBytes", () => {
  it("decodes a UTF-8 BOM'd file, stripping the mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]);
    expect(decodeTextBytes(bytes)).toBe("hello");
  });

  it("decodes a UTF-16LE BOM'd file", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]);
    expect(decodeTextBytes(bytes)).toBe("hi");
  });

  it("decodes a UTF-16BE BOM'd file", () => {
    const le = Buffer.from("hi", "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    expect(decodeTextBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe("hi");
  });

  it("takes valid UTF-8 as a fact, never guessing at it", () => {
    const text = "café — déjà vu";
    expect(decodeTextBytes(Buffer.from(text, "utf8"))).toBe(text);
  });

  it("falls back to windows-1252 for bytes that are not valid UTF-8", () => {
    const latin1 = Buffer.from([0x4c, 0x65, 0x20, 0x73, 0x69, 0xe8, 0x67, 0x65]); // "Le si\xE8ge"
    expect(decodeTextBytes(latin1)).toBe("Le siège");
  });

  it("decodes windows-1252-specific characters outside the Latin-1 range", () => {
    // REGRESSION: Node lists `windows-1252` as an ALIAS OF LATIN-1, so
    // `new TextDecoder("windows-1252")` maps 0x80-0x9F to C1 CONTROL
    // characters. Those bytes are exactly what a Word/Excel-exported legacy
    // file uses for its curly quotes, dashes and ellipsis, so the alias turned
    // the most common windows-1252 punctuation into invisible controls.
    expect(decodeTextBytes(Buffer.from([0x93, 0x68, 0x69, 0x94]))).toBe("\u{201C}hi\u{201D}");
    expect(decodeTextBytes(Buffer.from([0x41, 0x96, 0x42, 0x97, 0x43, 0x85]))).toBe("A\u{2013}B\u{2014}C\u{2026}");
    expect(decodeTextBytes(Buffer.from([0x92]))).toBe("\u{2019}");
    // The five unassigned bytes fall through to their own code point.
    expect(decodeTextBytes(Buffer.from([0x81, 0xe8]))).toBe("\u{0081}è");
  });
});

describe("decodeBasicEntities", () => {
  it("decodes named and numeric entities in one pass", () => {
    expect(decodeBasicEntities("Terms &amp; Conditions")).toBe("Terms & Conditions");
    expect(decodeBasicEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeBasicEntities("&lt;p&gt;&quot;hi&quot;")).toBe('<p>"hi"');
  });

  it("maps &nbsp; to a PLAIN space in this display-only table", () => {
    // The position-preserving scanner in `editMatchHtml.ts` has its OWN table
    // whose `nbsp` is a real U+00A0; this one mirrors `extraction.rs`'s.
    expect(decodeBasicEntities("a&nbsp;b")).toBe("a b");
    expect(decodeBasicEntities("a&nbsp;b")).not.toContain("\u{00A0}");
  });

  it("leaves an unrecognized or malformed entity verbatim", () => {
    expect(decodeBasicEntities("a &notreal; b")).toBe("a &notreal; b");
    expect(decodeBasicEntities("&foo;")).toBe("&foo;");
    expect(decodeBasicEntities("a & b")).toBe("a & b");
    expect(decodeBasicEntities("A & B")).toBe("A & B");
  });

  it("does not double-decode &amp;lt; into a bare <", () => {
    expect(decodeBasicEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves a malformed numeric reference alone rather than guessing", () => {
    expect(decodeBasicEntities("&#12g;")).toBe("&#12g;");
    expect(decodeBasicEntities("&#xzz;")).toBe("&#xzz;");
  });
});

describe("stripTags / xmlParasToText", () => {
  it("strips tags and decodes entities, leaving a space per closed tag", () => {
    expect(stripTags("<p>Hello &amp; welcome</p>")).toBe(" Hello & welcome ");
  });

  it("does not end a tag early on a > inside a quoted attribute", () => {
    // Parsoid-rendered Wikipedia carries whole template wikitext inside a
    // `data-mw='{…}'` attribute whose JSON holds literal markup.
    expect(stripTags(`<div data-x="a > b">text</div>`).trim()).toBe("text");
    expect(stripTags(`<a href="x>y">link</a>`).trim()).toBe("link");
  });

  it("inserts a newline at each paragraph close before stripping", () => {
    const text = xmlParasToText("<w:p>one</w:p><w:p>two</w:p>", "</w:p>");
    expect(
      text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    ).toEqual(["one", "two"]);
  });
});

describe("normalizeWhitespace", () => {
  it("collapses runs per line and squeezes blank-line runs to one", () => {
    expect(normalizeWhitespace("a   b\n\n\n\nc\td\n")).toBe("a b\n\nc d\n");
  });

  it("emits a trailing newline per non-blank line and does not trim the result", () => {
    // Rust's version pushes '\n' after every line and never trims — mirrored
    // here so the searchable text a docx/html read produces matches.
    expect(normalizeWhitespace("only")).toBe("only\n");
  });

  it("drops a trailing CR the way str::lines() does", () => {
    expect(normalizeWhitespace("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeWhitespace("")).toBe("");
  });

  it("REGRESSION: splits on the Unicode White_Space property, not on JS's `\\s`", () => {
    // Rust's `split_whitespace()` reads the White_Space property. JS's `\s`
    // differs at exactly two code points, and both turn up in extracted Office
    // text: U+0085 (NEL) IS White_Space and must separate words; U+FEFF (a BOM)
    // is NOT, and must survive as a character rather than splitting the line.
    expect(normalizeWhitespace("a\u{0085}b")).toBe("a b\n");
    expect(normalizeWhitespace("a\u{FEFF}b")).toBe("a\u{FEFF}b\n");
  });
});
