import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canRead, convert, removeQuietly, resolveFieldCodes, writePrivate } from "./textUtil.js";

const TEXTUTIL = "/usr/bin/textutil";
const hasTextutil = fs.existsSync(TEXTUTIL);

describe("canRead", () => {
  it("offers only the formats macOS textutil can import", () => {
    expect(canRead("doc")).toBe(true);
    expect(canRead("rtf")).toBe(true);
    expect(canRead("rtfd")).toBe(true);
    expect(canRead("odt")).toBe(true);
    expect(canRead("wordml")).toBe(true);
    expect(canRead("webarchive")).toBe(true);
    // .docx is deliberately absent: it renders through docx-preview with page
    // breaks, headers, footers and images, which is more than this importer
    // gives.
    expect(canRead("docx")).toBe(false);
    expect(canRead("pptx")).toBe(false);
    expect(canRead("pdf")).toBe(false);
  });
});

describe("the decrypted temp copy's hygiene (writePrivate/removeQuietly)", () => {
  // Asserted on the mechanism directly rather than by counting `arcelle-tu-*`
  // files in the shared temp dir: the suite runs in parallel, so that count is
  // whatever the OTHER tests happen to be doing at the time — same reasoning
  // the Rust source's own test gives for testing its `TempPath` guard
  // directly instead.
  it("deletes itself on every exit path", () => {
    const probe = path.join(os.tmpdir(), `arcelle-tu-test-${randomUUID()}.probe`);
    expect(writePrivate(probe, Buffer.from("decrypted bytes"))).toBe(true);
    expect(fs.existsSync(probe)).toBe(true);
    removeQuietly(probe);
    expect(fs.existsSync(probe)).toBe(false);
  });

  it("is owner-only", () => {
    // These bytes are the plaintext of an encrypted room; no other account on
    // the Mac may read them while the converter runs.
    const probe = path.join(os.tmpdir(), `arcelle-tu-test-${randomUUID()}.probe`);
    expect(writePrivate(probe, Buffer.from("secret"))).toBe(true);
    const mode = fs.statSync(probe).mode;
    expect(mode & 0o077).toBe(0);
    removeQuietly(probe);
  });

  it("removeQuietly never throws for a path that was never created", () => {
    const neverCreated = path.join(os.tmpdir(), `arcelle-tu-test-${randomUUID()}.never`);
    expect(() => removeQuietly(neverCreated)).not.toThrow();
  });

  it("writePrivate refuses to overwrite an existing file and returns false", () => {
    const probe = path.join(os.tmpdir(), `arcelle-tu-test-${randomUUID()}.probe`);
    expect(writePrivate(probe, Buffer.from("first"))).toBe(true);
    expect(writePrivate(probe, Buffer.from("second"))).toBe(false);
    expect(fs.readFileSync(probe, "utf8")).toBe("first");
    removeQuietly(probe);
  });
});

describe.skipIf(!hasTextutil)("convert, against the REAL /usr/bin/textutil", () => {
  it("converts a real rtf to text", async () => {
    const rtf = Buffer.from(
      String.raw`{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}`
    );
    const txt = await convert("sample.rtf", rtf, "txt");
    expect(txt).not.toBeNull();
    expect(txt).toContain("Hello bold world.");
  });

  it("converts a real rtf to html with its formatting", async () => {
    const rtf = Buffer.from(
      String.raw`{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}`
    );
    const html = await convert("sample.rtf", rtf, "html");
    expect(html).not.toBeNull();
    expect(html!.toLowerCase()).toContain("<b>");
  });

  it("returns null for a format textutil cannot import", async () => {
    const out = await convert("sample.pdf", Buffer.from("not really a pdf"), "txt");
    expect(out).toBeNull();
  });

  it("leaves no temp files behind after a real conversion", async () => {
    // Tests within one vitest file run sequentially (no `.concurrent` used
    // anywhere in this suite), and no other module in this tree writes the
    // `arcelle-tu-` prefix, so a before/after snapshot around a single
    // awaited call is a reliable, non-flaky way to catch a leak — unlike
    // counting files in the shared temp dir across the WHOLE parallel run,
    // which the Rust source's own test comment explicitly rejects.
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("arcelle-tu-")));
    const rtf = Buffer.from(String.raw`{\rtf1\ansi Hello world.\par}`);
    await convert("sample.rtf", rtf, "txt");
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("arcelle-tu-"));
    const leaked = after.filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  });
});

describe("resolveFieldCodes", () => {
  it("turns a hyperlink field into the link and stops it being prose", () => {
    // The exact shape live QA found in a real .doc.
    const src = ' HYPERLINK "https://products.office.com/en-us/word"Mauris id ex erat.';
    const text = resolveFieldCodes(src, false);
    expect(text).not.toContain("HYPERLINK");
    expect(text).toContain("Mauris id ex erat.");
    expect(text).toContain("https://products.office.com");

    const html = resolveFieldCodes(src, true);
    expect(html).toContain('<a href="https://products.office.com/en-us/word">');
    expect(html).toContain("Mauris id ex erat.");
  });

  it("resolves several hyperlinks in one document", () => {
    const src = 'a HYPERLINK "https://one.example"one b HYPERLINK "https://two.example"two';
    const text = resolveFieldCodes(src, false);
    expect(text).not.toContain("HYPERLINK");
    expect(text).toContain("one.example");
    expect(text).toContain("two.example");
    expect(text).toContain(" b ");
  });

  it("never turns a non-http target into a clickable href", () => {
    // A document must not be able to smuggle script into the reader.
    const html = resolveFieldCodes('HYPERLINK "javascript:alert(1)"click', true);
    expect(html).not.toContain("<a href");
    expect(html).not.toContain('javascript:alert(1)"');
    expect(html).toContain("click");
  });

  it("leaves the word HYPERLINK in ordinary prose alone", () => {
    const src = "The HYPERLINK, as it is called, points elsewhere.";
    expect(resolveFieldCodes(src, false)).toBe(src);
  });

  it("survives prose between the word and a later quote", () => {
    const src = 'We use HYPERLINK fields to link "https://x" pages.';
    expect(resolveFieldCodes(src, false)).toBe(src);

    // A switch before the target is still a field, and still resolves.
    const switched = 'HYPERLINK \\l "https://one.example"one';
    const text = resolveFieldCodes(switched, false);
    expect(text).not.toContain("HYPERLINK");
    expect(text).toContain("https://one.example");
    expect(text).toContain("one");
  });

  it("survives a quoted phrase a few words after the keyword", () => {
    for (const src of [
      'The HYPERLINK is "great", they said.',
      'A HYPERLINK to "the deposit" clause.',
    ]) {
      expect(resolveFieldCodes(src, false)).toBe(src);
      expect(resolveFieldCodes(src, true)).toBe(src);
    }
  });

  it("returns text with no fields unchanged", () => {
    const src = 'Ordinary prose with "quotes" and no fields at all.';
    expect(resolveFieldCodes(src, false)).toBe(src);
  });
});

// ==================================================== adversarial: Rust parity
//
// Every case below was written against `src-tauri/src/textutil.rs` read in
// full, and cross-checked against the second existing port of the same source,
// `services/agent-sidecar/src/arcelle_sidecar/docs/textutil.py`, so a disagreement here is a
// disagreement with BOTH of the other two implementations, not a matter of
// taste.

describe("adversarial: convert's parity with read_to_string", () => {
  it.skipIf(!hasTextutil)(
    "returns null when the converter's output is not valid UTF-8",
    async () => {
      // Rust reads the converted file with `std::fs::read_to_string`, which
      // REFUSES invalid UTF-8 outright and collapses to `None` through the
      // caller's `.ok()`. The Python port matches it explicitly
      // (`except (OSError, UnicodeDecodeError): return None`). Node's
      // `readFile(path, "utf8")` instead substitutes U+FFFD for every bad
      // byte and hands back a long, non-empty, entirely meaningless string —
      // which `convert`'s `!trim().isEmpty()` filter happily passes on to
      // search, RAG and the editor as if it were the document's text.
      //
      // `-convert doc` makes the REAL textutil emit a binary OLE Composite
      // Document File, so this exercises the divergence end to end through
      // the actual converter, with no seam and no fabricated fixture. `to`
      // is an ordinary caller-supplied parameter on both sides; the Rust
      // signature constrains it only by doc comment.
      const rtf = Buffer.from(String.raw`{\rtf1\ansi Hello world.\par}`);
      const out = await convert("sample.rtf", rtf, "doc");
      expect(out).toBeNull();
    }
  );

  it.skipIf(!hasTextutil)("preserves the converted text UNTRIMMED", async () => {
    // Rust filters on `!h.trim().is_empty()` but returns `h` itself, so the
    // trailing newline textutil writes survives into the extracted text.
    const rtf = Buffer.from(String.raw`{\rtf1\ansi Hello world.\par}`);
    const txt = await convert("sample.rtf", rtf, "txt");
    expect(txt).not.toBeNull();
    expect(txt).toBe(`${txt!.trim()}\n`);
  });

  it.skipIf(!hasTextutil)("lower-cases the extension before the allowlist check", async () => {
    // `extraction::extension_of` lowercases; a file named from a Windows
    // machine ("Memo.RTF") must still route to the importer.
    const rtf = Buffer.from(String.raw`{\rtf1\ansi Hello world.\par}`);
    const txt = await convert("Memo.RTF", rtf, "txt");
    expect(txt).toContain("Hello world.");
  });

  it("treats a dotfile as having no extension at all", async () => {
    // `Path::new(".rtf").extension()` is None, not Some("rtf") — the Python
    // port calls this out as a bug both of ITS candidates had. No subprocess
    // runs, so this is safe with or without textutil present.
    await expect(convert(".rtf", Buffer.from("x"), "txt")).resolves.toBeNull();
  });
});

describe("adversarial: the field gap is measured exactly as Rust measures it", () => {
  it("counts the gap in UTF-8 BYTES, not UTF-16 units", () => {
    // Three `\é` switches: 6 JS characters but 9 UTF-8 bytes, so Rust's
    // `gap.len() > MAX_FIELD_GAP` bails and leaves the sentence alone. A
    // port that compared `gap.length` would see 6, accept it as a field, and
    // delete the quoted phrase from the document.
    const src = 'HYPERLINK\\é\\é\\é"great", they said.';
    expect(Buffer.byteLength('\\é\\é\\é', "utf8")).toBe(9);
    expect(resolveFieldCodes(src, false)).toBe(src);
    expect(resolveFieldCodes(src, true)).toBe(src);
  });

  it("does not treat U+FEFF as a switch separator (JS `\\s` does; Rust does not)", () => {
    // U+FEFF has no Unicode White_Space property, so Rust's
    // `gap.split_whitespace()` yields it as a TOKEN, it does not start with a
    // backslash, and the whole thing stays prose. JS's `\s` character class
    // DOES match U+FEFF, so splitting on `/\s+/` produced zero tokens, the
    // vacuous `.every()` passed, and the keyword plus the quoted phrase were
    // deleted — exactly the "swallowing it would delete every word in
    // between" failure the gap check exists to prevent. A stray BOM mid-run
    // is ordinary debris in text that has been through a legacy converter.
    const src = 'HYPERLINK\uFEFF"great" and the rest of the sentence.';
    expect(resolveFieldCodes(src, false)).toBe(src);
    expect(resolveFieldCodes(src, true)).toBe(src);
  });

  it("treats U+0085 as whitespace (Rust's char::is_whitespace does; JS `\\s` does not)", () => {
    // The mirror image: NEL *is* Unicode White_Space, so Rust sees an empty
    // token list, the vacuous `.every()` passes, and this resolves as a real
    // field. JS's `\s` does not match U+0085, so it came back as a non-switch
    // token and a genuine hyperlink silently stopped resolving.
    const src = 'HYPERLINK\u0085"https://one.example"one';
    expect(resolveFieldCodes(src, false)).toBe("https://one.exampleone");
    expect(resolveFieldCodes(src, true)).toBe(
      '<a href="https://one.example">https://one.example</a>one'
    );
  });

  it("accepts a gap of exactly MAX_FIELD_GAP bytes and rejects one byte more", () => {
    // The bound is `>`, not `>=`: 8 bytes of switches still resolve.
    const eight = 'HYPERLINK\\l \\o \\p"https://one.example"one';
    expect(Buffer.byteLength('\\l \\o \\p', "utf8")).toBe(8);
    expect(resolveFieldCodes(eight, false)).toBe("https://one.exampleone");

    const nine = 'HYPERLINK\\l \\o \\pq"https://one.example"one';
    expect(Buffer.byteLength('\\l \\o \\pq', "utf8")).toBe(9);
    expect(resolveFieldCodes(nine, false)).toBe(nine);
  });
});

describe("adversarial: field-code escaping and rescanning", () => {
  it("escapes & < > in both the href and the link text", () => {
    const html = resolveFieldCodes('HYPERLINK "https://x/?a=1&b=<2>"link', true);
    expect(html).toBe('<a href="https://x/?a=1&amp;b=&lt;2&gt;">https://x/?a=1&amp;b=&lt;2&gt;</a>link');
  });

  it("resumes the scan just past the bare keyword, so a later real field still resolves", () => {
    // Rust sets `rest = after` on every bail — past "HYPERLINK" but NOT past
    // the quote — so a field further along is still found.
    const src = 'The HYPERLINK is "great". HYPERLINK "https://one.example"one';
    const out = resolveFieldCodes(src, false);
    expect(out).toBe('The HYPERLINK is "great". https://one.exampleone');
  });

  it("leaves a HYPERLINK with no quote after it, or only one quote, exactly as it came", () => {
    expect(resolveFieldCodes("HYPERLINK with no quotes at all", false)).toBe(
      "HYPERLINK with no quotes at all"
    );
    expect(resolveFieldCodes('HYPERLINK "unterminated', false)).toBe('HYPERLINK "unterminated');
  });

  it("never emits an href for a scheme outside the allowlist, upper-case included", () => {
    // `looks_like_url` trims and ASCII-lowercases first, so JAVASCRIPT: is
    // still refused and HTTPS:// is still accepted.
    expect(resolveFieldCodes('HYPERLINK " JAVASCRIPT:alert(1)"x', true)).not.toContain("<a href");
    expect(resolveFieldCodes('HYPERLINK " HTTPS://one.example"x', true)).toContain(
      '<a href=" HTTPS://one.example">'
    );
  });
});
