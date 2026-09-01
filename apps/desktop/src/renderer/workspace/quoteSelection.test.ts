import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_QUOTE_CHARS,
  inExcludedSurface,
  inQuotableDocument,
  quotableText,
  searchableDocument,
  verifiedFrameQuote,
  withQuote,
} from "./quoteSelection";

const originalElement = Reflect.get(globalThis, "Element");

function documentWith(body: string) {
  const parsed = parseHTML(`<html><body>${body}</body></html>`);
  Reflect.set(globalThis, "Element", parsed.window.Element);
  return parsed.document;
}

afterEach(() => {
  if (originalElement === undefined) Reflect.deleteProperty(globalThis, "Element");
  else Reflect.set(globalThis, "Element", originalElement);
});

describe("quote selection", () => {
  it("allows only document selections outside controls that own their text", () => {
    const document = documentWith(
      "<section class='viewer-body'><p id='prose'>Useful passage</p><div class='rdr-bar'><span id='toolbar'>Page one</span></div><textarea id='edit'></textarea></section><p id='outside'>Chat text</p>",
    );
    const prose = document.getElementById("prose")!;
    const toolbar = document.getElementById("toolbar")!;
    const edit = document.getElementById("edit")!;
    const outside = document.getElementById("outside")!;

    expect(inQuotableDocument(prose.firstChild)).toBe(true);
    expect(inExcludedSurface(prose.firstChild)).toBe(false);
    expect(inQuotableDocument(toolbar.firstChild)).toBe(true);
    expect(inExcludedSurface(toolbar.firstChild)).toBe(true);
    expect(inExcludedSurface(edit)).toBe(true);
    expect(inQuotableDocument(outside)).toBe(false);
    expect(inExcludedSurface(null)).toBe(false);
  });

  it("normalizes valid reader text and rejects editing, short, or non-reader selections", () => {
    expect(quotableText("  Two\n words  ", "markdown", false)).toBe("Two words");
    expect(quotableText("x", "markdown", false)).toBeNull();
    expect(quotableText("Useful", "markdown", true)).toBeNull();
    expect(quotableText("Useful", "sheet", false)).toBeNull();
    expect(quotableText("Useful", null, false)).toBeNull();
  });

  it("clips a long selection without refusing the quoted passage", () => {
    const long = "a".repeat(MAX_QUOTE_CHARS + 20);
    const quote = quotableText(long, "text", false);

    expect(quote).toHaveLength(MAX_QUOTE_CHARS);
    expect(quote?.endsWith("…")).toBe(true);
  });

  it("accepts frame claims only when their flattened document contains them", () => {
    const document = searchableDocument("Alpha\n  beta and Gamma");
    expect(verifiedFrameQuote(" alpha beta ", document, "html", false)).toBe("alpha beta");
    expect(verifiedFrameQuote("not there", document, "html", false)).toBeNull();
    expect(verifiedFrameQuote(" ", document, "html", false)).toBeNull();
  });

  it("appends a quoted block without destroying the existing draft", () => {
    expect(withQuote("Question", "A line", "notes.md")).toBe("Question\n\n> A line\n— notes.md\n\n");
    expect(withQuote("Draft  \n", "A line", "notes.md")).toBe("Draft\n\n> A line\n— notes.md\n\n");
    expect(withQuote("", "A line", "notes.md")).toBe("> A line\n— notes.md\n\n");
  });
});
