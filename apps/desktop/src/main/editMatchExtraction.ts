/**
 * The subset of `src-tauri/src/extraction.rs` that `commands/edit_match.rs`
 * (and the docx/HTML scanners it calls) needs directly: the text-extension
 * registry, the ONE fold table every matcher shares (`fold_edit_char` /
 * `FoldOut`), the encoding-aware text decoder, and the small entity/tag
 * string helpers.
 *
 * SCOPE LINE, drawn deliberately. `extraction.rs` and its submodules
 * (`pdf.rs`, `xlsx.rs`, `pptx.rs`, `legacy.rs`, `article.rs`, `data.rs`,
 * `window.rs`, `chunking.rs`) are a large, separate module that is NOT this
 * batch's target. What is ported here is exactly what the edit engine calls,
 * and each narrowing is named in the function's own doc rather than left to
 * be discovered. A future `extraction.rs` batch extends this file (the same
 * convention `db-host/versions.ts` documents for its own partial port).
 *
 * A NOTE ON HOW THE FOLD TABLE IS WRITTEN BELOW: every special-cased
 * character is matched by its NUMERIC code point, never by a literal
 * character in a `case "…":` label. Several of the characters this table
 * folds — a zero-width space, a BOM, NUL, half a dozen near-identical dashes
 * and quotes — are visually indistinguishable from each other or from
 * nothing at all, so a source literal cannot be verified by reading it, and a
 * raw NUL byte in a source file is a hazard in its own right. A numeric
 * comparison can be checked against the Unicode table by the number alone.
 */

// ------------------------------------------------------------ extension registry

import {
  isTextExtension as isSharedTextExtension,
  sharedTextExtensions,
} from "../shared/fileExtensions.js";

/** The text extensions, for anything that wants the whole registry. Ported
 * from `extraction::text_extensions`. */
export function textExtensions(): readonly string[] {
  return sharedTextExtensions();
}

/**
 * The text after the LAST `.` in the file's NAME (not its directory part),
 * lower-cased — `""` when there is none. Ported from
 * `extraction::extension_of` (`Path::new(name).extension()`), including its
 * rule that a name which BEGINS with a dot and has no other one has no
 * extension (`.gitignore` → `""`, which is why the table above's
 * "gitignore"/"env"/"dockerfile" rows only ever match the DOTTED spelling,
 * e.g. `web.dockerfile`).
 */
export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return base.slice(lastDot + 1).toLowerCase();
}

/** Ported from `extraction::is_image`. */
export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Ported from `extraction::is_text_extension`. */
export function isTextExtension(ext: string): boolean {
  return isSharedTextExtension(ext);
}

// ------------------------------------------------------------------- fold table

/**
 * Mirrors `extraction::FoldOut` — how one character folds when matching an
 * edit's `old_text` against a file's raw text. This is the ONE normalization
 * table shared by the plain-text fuzzy matcher (`editMatchFuzzy.ts`), the
 * docx run-split matcher (`editMatchDocx.ts`) and the HTML run-split matcher
 * (`editMatchHtml.ts`), so all three tolerate the same typographic drift a
 * model introduces (curly quotes, NBSP/narrow-NBSP/CRLF, dash variants,
 * ligatures).
 *
 * Deliberately NOT `normalizeForMatch` (`textClamp.ts`): that one lowercases
 * and strips Hebrew nikud for ANNOTATION lookup, which is safe because it
 * only highlights. Edits rewrite bytes, so case must stay exact — a fuzzy hit
 * must never land on a case-variant of a different passage. No lowercasing,
 * no nikud stripping here.
 */
export type FoldOut =
  /** Any whitespace (space, tab, CR, LF, NBSP U+00A0, narrow-NBSP U+202F,
   * U+2000–U+200A, U+3000, …). Collapsed to a single space by the matchers. */
  | { readonly kind: "space" }
  /** Zero-widths (and NUL) — dropped entirely so they never block a match,
   * and so no needle can ever carry a paragraph/block sentinel. */
  | { readonly kind: "drop" }
  /** A 1:1 fold to the given char (or the char unchanged). */
  | { readonly kind: "char"; readonly c: string }
  /** A boundary-safe 1→2 expansion (ligatures). Both halves map to the
   * ORIGINAL char's source span, so span math stays character-safe either
   * side of a match. */
  | { readonly kind: "pair"; readonly a: string; readonly b: string };

const FOLD_SPACE: FoldOut = { kind: "space" };
const FOLD_DROP: FoldOut = { kind: "drop" };

function foldChar(c: string): FoldOut {
  return { kind: "char", c };
}

function foldPair(a: string, b: string): FoldOut {
  return { kind: "pair", a, b };
}

/** Unicode's `White_Space` property — the same property Rust's
 * `char::is_whitespace()` reads. Deliberately NOT JS's `\s`, which both
 * misses U+0085 (NEL) and adds U+FEFF (a BOM, which this table drops rather
 * than treats as a space) — the same divergence `fileTools.ts` documents for
 * its own copy of this predicate. */
const WHITE_SPACE_RE = /^\p{White_Space}$/u;

/** True when `c` (one character) is Unicode whitespace. Exported because
 * `editMatchHtml.ts` needs the same predicate for its `str::trim_start()`
 * and tag-name-end scans (Rust duplicates it there too, inline, via
 * `char::is_whitespace()`). */
export function isUnicodeWhitespace(c: string): boolean {
  return WHITE_SPACE_RE.test(c);
}

/** Ported verbatim from `extraction::fold_edit_char`. See the module doc for
 * why this switches on the NUMERIC code point rather than a literal
 * character in a `case` label. */
export function foldEditChar(c: string): FoldOut {
  switch (c.codePointAt(0)) {
    // Zero-widths: must precede the whitespace guard (U+200B is NOT
    // White_Space in Unicode, and U+FEFF is a BOM/no-break marker).
    case 0x200b: // ZERO WIDTH SPACE
    case 0x200c: // ZERO WIDTH NON-JOINER
    case 0x200d: // ZERO WIDTH JOINER
    case 0xfeff: // ZERO WIDTH NO-BREAK SPACE / BOM
      return FOLD_DROP;
    // NUL is never document content, and the docx/HTML/text matchers all use
    // it as their PARAGRAPH/block separator — a sentinel that must never be
    // matchable. NUL is not whitespace in Rust (nor under `White_Space`), so
    // without this explicit guard a needle carrying one would survive
    // normalization intact and could match a separator.
    case 0x0000: // NUL
      return FOLD_DROP;
    // Curly / modifier apostrophes -> straight single quote.
    case 0x2018: // LEFT SINGLE QUOTATION MARK
    case 0x2019: // RIGHT SINGLE QUOTATION MARK
    case 0x02bc: // MODIFIER LETTER APOSTROPHE
      return foldChar("'");
    // Curly double quotes -> straight double quote.
    case 0x201c: // LEFT DOUBLE QUOTATION MARK
    case 0x201d: // RIGHT DOUBLE QUOTATION MARK
      return foldChar('"');
    // Hyphen/dash/minus/maqaf family -> ASCII hyphen.
    case 0x2010: // HYPHEN
    case 0x2011: // NON-BREAKING HYPHEN
    case 0x2012: // FIGURE DASH
    case 0x2013: // EN DASH
    case 0x2014: // EM DASH
    case 0x2212: // MINUS SIGN
    case 0x05be: // HEBREW PUNCTUATION MAQAF
      return foldChar("-");
    // fi/fl ligatures — boundary-safe expansion. Extracted PDF/docx text
    // often carries these while the model types ASCII.
    case 0xfb01: // LATIN SMALL LIGATURE FI
      return foldPair("f", "i");
    case 0xfb02: // LATIN SMALL LIGATURE FL
      return foldPair("f", "l");
    default:
      return isUnicodeWhitespace(c) ? FOLD_SPACE : foldChar(c);
  }
}

// ------------------------------------------------------------------ text decode

/** Byte-order marks this decoder recognizes, longest first so UTF-8's 3-byte
 * mark isn't shadowed by a shorter false match. Mirrors the marks
 * `encoding_rs::Encoding::for_bom` recognizes. */
const BOMS: ReadonlyArray<{ readonly bytes: readonly number[]; readonly encoding: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
];

/**
 * The WHATWG windows-1252 index for the 0x80-0x9F range. 0xA0-0xFF match
 * ISO-8859-1 one for one and 0x00-0x7F is ASCII either way, so both are
 * handled by the code-point passthrough below. The five bytes the standard
 * leaves unassigned (0x81, 0x8D, 0x8F, 0x90, 0x9D) are omitted and fall
 * through to that passthrough, exactly as the standard specifies.
 *
 * SPELLED OUT rather than delegated to `new TextDecoder("windows-1252")`:
 * Node lists `windows-1252` as an ALIAS OF LATIN-1, so that decoder maps
 * 0x80-0x9F to C1 control characters. Those bytes are precisely the ones a
 * Word- or Excel-exported legacy file uses for its curly quotes, en/em dashes
 * and ellipsis — the single most common thing a windows-1252 document
 * contains that Latin-1 gets wrong — so the alias would quietly turn every
 * one of them into an invisible control character in the diff preview and in
 * the search index.
 */
const WINDOWS_1252_HIGH: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

function decodeWindows1252(buf: Buffer): string {
  let out = "";
  for (const b of buf) {
    out += String.fromCodePoint(WINDOWS_1252_HIGH.get(b) ?? b);
  }
  return out;
}

/**
 * Decode a text file's bytes into a string, honouring its encoding.
 *
 * Order is the Rust source's, and it matters: (1) a byte-order mark is a FACT
 * about the bytes, so it wins outright; (2) valid UTF-8 is next and is
 * near-certain (arbitrary legacy bytes almost never form valid UTF-8 by
 * accident); (3) only when both fail is a legacy encoding used.
 *
 * NARROWING, deliberate and named: Rust's third step is `chardetng`
 * (Firefox's language-aware statistical detector), which can tell a Turkish
 * file from a Czech one by which single-byte encoding's letter frequencies
 * fit best — reproducing that means porting a language model, not a function.
 * This port falls back to ONE fixed encoding: windows-1252, the most common
 * legacy encoding for Western European text (and a superset of ISO-8859-1
 * over the printable range). A file in a different legacy encoding
 * (Cyrillic, Greek, Turkish-specific glyphs, CJK) decodes as windows-1252
 * mojibake rather than being correctly detected — a known, narrower result
 * than the Rust source's, not a silent bug. It is exactly enough for what
 * `edit_match.rs` uses this for: rendering a legacy-encoded file's DIFF
 * PREVIEW as readable text rather than as `U+FFFD` boxes.
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const bom of BOMS) {
    if (buf.length >= bom.bytes.length && bom.bytes.every((b, i) => buf[i] === b)) {
      return new TextDecoder(bom.encoding).decode(buf.subarray(bom.bytes.length));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // Fall through to the single-fallback legacy decode below.
  }
  return decodeWindows1252(buf);
}

// -------------------------------------------------------------- XML/HTML text

/** The named entities worth carrying: the five XML ones plus the typographic
 * punctuation real prose is full of. Anything outside this table and outside
 * the numeric forms is left exactly as written — a literal `&foo;` is visibly
 * not decoded, where a guess would be silently wrong. Ported verbatim from
 * `extraction::NAMED_ENTITIES` (note `nbsp` maps to a PLAIN ASCII space here,
 * matching the Rust table; `editMatchHtml.ts`'s own position-preserving
 * scanner has a SEPARATE table whose `nbsp` is a real U+00A0, matching
 * `html_edit::decode_entity_body`). */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["amp", "&"],
  ["nbsp", " "],
  ["mdash", "—"],
  ["ndash", "–"],
  ["hellip", "…"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bull", "•"],
  ["middot", "·"],
  ["times", "×"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["deg", "°"],
  ["euro", "€"],
  ["pound", "£"],
  ["laquo", "«"],
  ["raquo", "»"],
]);

/** The longest `&…;` this will look at. Long enough for every name above and
 * for a hex reference; short enough that a bare `&` in prose scans a few
 * characters and gives up rather than swallowing half a paragraph looking for
 * a `;`. Ported from `extraction::MAX_ENTITY_LEN`. */
const MAX_ENTITY_LEN = 12;

/** ASCII-only case fold — `String.prototype.toLowerCase()` is Unicode-aware
 * and NOT length-preserving (Turkish `İ` U+0130 folds to `i` + U+0307), which
 * shifts every offset found in the folded copy out of alignment with the
 * original. Ported from `extraction/html.rs`'s `ascii_lower`, and used
 * wherever a lowered copy is INDEXED rather than merely compared. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** True when `code` is a code point `String.fromCodePoint` can produce (and
 * `char::from_u32` would accept) — surrogates are not scalar values. */
function isScalarValue(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

/**
 * Decode HTML entities in extracted text, in a SINGLE pass — ported from
 * `extraction::decode_basic_entities`. Each `&…;` is examined in the ORIGINAL
 * text and replaced exactly once, so double-decoding (`&amp;lt;` collapsing
 * all the way to `<`) is structurally impossible and ordering stops mattering.
 * Handles numeric references (`&#8212;`, `&#x2014;`) and the named table
 * above; anything else is left exactly as written, `&` and `;` included.
 */
export function decodeBasicEntities(s: string): string {
  if (!s.includes("&")) {
    return s;
  }
  let out = "";
  let rest = s;
  for (;;) {
    const amp = rest.indexOf("&");
    if (amp === -1) {
      return out + rest;
    }
    out += rest.slice(0, amp);
    const after = rest.slice(amp + 1);
    let semi = -1;
    for (let i = 0; i < after.length && i <= MAX_ENTITY_LEN; i++) {
      if (after[i] === ";") {
        semi = i;
        break;
      }
    }
    if (semi === -1) {
      // A bare `&` — emit it and carry on from just after it, so the next
      // search cannot rediscover this same one and loop forever.
      out += "&";
      rest = after;
      continue;
    }
    const body = after.slice(0, semi);
    const decoded = decodeEntityBodyLoose(body);
    out += decoded ?? `&${body};`;
    rest = after.slice(semi + 1);
  }
}

function decodeEntityBodyLoose(body: string): string | null {
  if (body.startsWith("#")) {
    const digits = body.slice(1);
    let code: number | null = null;
    if (digits.startsWith("x") || digits.startsWith("X")) {
      const hex = digits.slice(1);
      code = /^[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : null;
    } else if (/^[0-9]+$/.test(digits)) {
      code = Number.parseInt(digits, 10);
    }
    return code !== null && isScalarValue(code) ? String.fromCodePoint(code) : null;
  }
  return NAMED_ENTITIES.get(asciiLower(body)) ?? null;
}

/**
 * Strip every `<…>` tag, replacing each with a single space (so adjacent
 * words never fuse), then decode entities. Quote-aware so a `>` inside a
 * quoted attribute value doesn't end the tag early — Parsoid-rendered
 * Wikipedia carries whole template wikitext inside a `data-mw='{…}'`
 * attribute whose JSON holds literal `<ref>`/`>` markup, and a quote-naive
 * scanner dumped that raw JSON into the text. Ported from
 * `extraction::strip_tags`.
 */
export function stripTags(input: string): string {
  let out = "";
  let inTag = false;
  let quote: string | null = null;
  for (const c of input) {
    if (inTag) {
      if (quote !== null) {
        if (c === quote) {
          quote = null;
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        inTag = false;
        out += " ";
      }
    } else if (c === "<") {
      inTag = true;
    } else {
      out += c;
    }
  }
  return decodeBasicEntities(out);
}

/** Text of an OOXML part, keeping its paragraph structure: the paragraph
 * close tag (`</w:p>` in Word, `</a:p>` in PowerPoint) becomes a newline
 * before the markup is stripped, so paragraphs don't collapse into one
 * run-on line. Ported from `extraction::xml_paras_to_text`. */
export function xmlParasToText(xml: string, paraClose: string): string {
  return stripTags(xml.split(paraClose).join(`${paraClose}\n`));
}

/**
 * Collapse whitespace runs per line and squeeze blank-line runs to one.
 * Ported verbatim from `extraction::normalize_whitespace`, including its
 * shape: every non-blank line is emitted trimmed and followed by `\n`, and a
 * run of blank lines contributes exactly one `\n` — there is no final trim.
 *
 * This runs over every BINARY extractor's output in the Rust source but NOT
 * over the plain-text branch, which returns the file's own decoded text
 * verbatim. `extractText` in `editMatch.ts` preserves that split exactly.
 */
export function normalizeWhitespace(s: string): string {
  let out = "";
  let blankLines = 0;
  for (const rawLine of linesOf(s)) {
    // `\p{White_Space}`, not `\s` — the same property Rust's
    // `str::split_whitespace()` reads, and the same divergence
    // {@link isUnicodeWhitespace} documents: `\s` MISSES U+0085 (NEL, which
    // Rust splits on) and ADDS U+FEFF (a BOM, which Rust keeps as a
    // character). Both show up in real extracted Office text.
    const trimmed = rawLine.split(/\p{White_Space}+/u).filter((w) => w !== "").join(" ");
    if (trimmed === "") {
      blankLines += 1;
      if (blankLines <= 1) {
        out += "\n";
      }
    } else {
      blankLines = 0;
      out += `${trimmed}\n`;
    }
  }
  return out;
}

/** Rust's `str::lines()`: split on `\n`, drop a trailing `\r` from each line,
 * and produce NO final empty line for a string that ends in `\n`. */
function linesOf(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
