/**
 * Position-preserving HTML text scanner/editor — ported from
 * `src-tauri/src/extraction/html_edit.rs` (`scan_html_runs`,
 * `html_replace_text`, `scan_headings`, `find_section_range`), plus
 * `src-tauri/src/extraction/html.rs`'s `strip_html` (the "closest passage"
 * hint when a quote isn't found) and `commands/docs_html.rs`'s `html_escape`.
 *
 * Mirrors `docx.rs`'s scan/match/splice discipline over raw HTML markup
 * instead of Word XML runs, so a quote drawn from the page's readable text is
 * rewritten IN PLACE without disturbing surrounding tags. html/htm is the
 * app's DEFAULT AI-document format, and before this scanner existed it was
 * the one format `edit_file` refused outright.
 *
 * Deliberately NOT built on `stripHtml` — that pipeline is lossy BY DESIGN
 * for retrieval (narrows to `<main>`/`<article>`, drops
 * `<nav>`/`<header>`/`<footer>`/`<script>`/`<style>` bodies) and keeps no
 * offsets. Editing needs every character traceable back to the exact source
 * position it decoded from. `stripHtml` is still used, unmodified, for the
 * advisory "closest passage" hint — never for anything spliced back into
 * markup.
 *
 * OFFSETS here are UTF-16 code-unit positions into the JS string rather than
 * UTF-8 byte offsets; see `editMatchFuzzy.ts`'s module doc, whose reasoning
 * applies verbatim.
 *
 * EVERY lowered copy that gets INDEXED goes through `asciiLower`, never
 * `String.prototype.toLowerCase()`. The latter is Unicode-aware and NOT
 * length-preserving (Turkish `İ` U+0130 → `i` + U+0307), so an index found in
 * a Unicode-lowered copy is not a valid index into the original: a page with
 * one such character before a heading's closing tag made `scan_headings`
 * swallow the following paragraph into the heading's text, and a
 * `section`-scoped edit then landed on the wrong byte range. This is exactly
 * the trap `html.rs`'s own `ascii_lower` comment warns about.
 */

import { asciiLower, decodeBasicEntities, foldEditChar, isUnicodeWhitespace, stripTags } from "./editMatchExtraction.js";

// ============================================================ html.rs

/**
 * Narrow HTML down to its readable text: keep only `<main>`/`<article>` when
 * present, put a newline after block closes, drop non-content element bodies
 * (nav/header/footer/aside/form/script/style/noscript/svg), then strip tags.
 * Ported verbatim from `html::strip_html`.
 */
export function stripHtml(html: string): string {
  let s = html;
  for (const tag of ["<main", "<article"]) {
    const lower = asciiLower(s);
    const open = lower.indexOf(tag);
    if (open !== -1) {
      const close = `</${tag.slice(1)}>`;
      const rel = lower.lastIndexOf(close);
      // A malformed page can put the closing tag BEFORE the opening one;
      // slicing backwards would be nonsensical, so leave `s` whole.
      if (rel !== -1 && rel >= open) {
        s = s.slice(open, rel + close.length);
        break;
      }
    }
  }
  for (const tag of ["</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</tr>", "<br>", "<br/>", "<br />"]) {
    s = s.split(tag).join(`${tag}\n`);
  }
  const chromePairs: ReadonlyArray<readonly [string, string]> = [
    ["<script", "</script>"],
    ["<style", "</style>"],
    ["<nav", "</nav>"],
    ["<header", "</header>"],
    ["<footer", "</footer>"],
    ["<aside", "</aside>"],
    ["<form", "</form>"],
    ["<noscript", "</noscript>"],
    ["<svg", "</svg>"],
  ];
  for (const [openTag, closeTag] of chromePairs) {
    for (;;) {
      const lower = asciiLower(s);
      const start = lower.indexOf(openTag);
      if (start === -1) {
        break;
      }
      const relEnd = lower.indexOf(closeTag, start);
      if (relEnd === -1) {
        break;
      }
      s = s.slice(0, start) + s.slice(relEnd + closeTag.length);
    }
  }
  return stripTags(s);
}

// ============================================================ docs_html.rs

/** Escape text for safe literal inclusion in HTML. The CALLER's job before
 * handing a replacement to {@link htmlReplaceText}. Ported verbatim from
 * `docs_html::html_escape` (`&` first, or the later escapes' own ampersands
 * would be re-escaped). */
export function htmlEscape(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
}

// ============================================================ html_edit.rs

/** One matchable run of text between tags, with the range in the RAW markup
 * it decoded from. Never spans a tag; `<script>`/`<style>`/comment bodies and
 * tag interiors (including attribute values) never become a run. Ported from
 * `html_edit::HtmlTextRun`. */
export interface HtmlTextRun {
  /** Absolute `[start, end)` range in the source HTML this run occupies. */
  readonly span: readonly [number, number];
  /** Decoded characters (entities resolved). */
  readonly chars: readonly string[];
  /** Absolute range per char of `chars` — char i decoded from `charSpans[i]`
   * in the source. An entity like `&amp;` is one char mapping to a 5-unit
   * source range. */
  readonly charSpans: ReadonlyArray<readonly [number, number]>;
}

/** Tags whose CLOSE marks a boundary a match may never cross — moving between
 * block-level containers (paragraphs, headings, list items, table rows and
 * cells, lists) must never silently splice two block elements together.
 * Inline tags (`<b>`, `<i>`, `<span>`, `<a>`, `<em>`, `<strong>`, `<code>`,
 * and anything not in this list) get no boundary — a quote MAY span them.
 * Ported verbatim from `html_edit::BLOCK_CLOSE_TAGS`. */
const BLOCK_CLOSE_TAGS: ReadonlySet<string> = new Set([
  "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "ul", "ol", "table",
  "blockquote", "section", "article", "header", "footer", "nav", "aside", "figure",
  "figcaption", "pre", "body", "html",
]);

/** Unmatchable separator between runs joined by a block boundary — the same
 * NUL convention as `editMatchFuzzy.ts`'s paragraph sentinel and docx's
 * paragraph marker. `foldEditChar(NUL)` is `drop`, so a needle can never
 * contain one and therefore can never match across it. Built with
 * `String.fromCharCode` so no raw NUL sits in this source file. Ported from
 * `html_edit::BLOCK_SENTINEL`. */
const BLOCK_SENTINEL = String.fromCharCode(0);

/** Sentinel entries in the flattened map point at no real run — Rust uses
 * `usize::MAX`; a negative index is the JS equivalent. A needle can never
 * contain the sentinel character, so a real match's endpoints never land on
 * one and this is never dereferenced. */
const SENTINEL_RUN = -1;

/** The entity table the position-preserving SCANNER uses. Deliberately
 * distinct from `editMatchExtraction.ts`'s display-only `NAMED_ENTITIES`
 * (whose `nbsp` is a plain space): this one produces a real U+00A0, matching
 * `html_edit::decode_entity_body`, because the fold table then turns it into
 * a matchable space while the SOURCE span still covers the whole `&nbsp;`. */
const SCANNER_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#39", "'"],
  ["nbsp", " "],
]);

function isScalarValue(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

/** Ported verbatim from `html_edit::decode_entity_body`. */
function decodeEntityBody(body: string): string | null {
  const named = SCANNER_ENTITIES.get(body);
  if (named !== undefined) {
    return named;
  }
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const hex = body.slice(2);
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      return null;
    }
    const code = Number.parseInt(hex, 16);
    return isScalarValue(code) ? String.fromCodePoint(code) : null;
  }
  if (body.startsWith("#")) {
    const dec = body.slice(1);
    if (!/^[0-9]+$/.test(dec)) {
      return null;
    }
    const code = Number.parseInt(dec, 10);
    return isScalarValue(code) ? String.fromCodePoint(code) : null;
  }
  return null;
}

/**
 * Decode one entity or literal char starting at `html[i]`, returning the
 * decoded char and how many source code units it consumed. An unrecognized or
 * malformed `&…;` sequence is treated as a literal `&` (1 unit) — safe, and
 * the rest scans normally as text. Ported verbatim from
 * `html_edit::decode_html_unit`, INDEXING rather than re-slicing the tail on
 * every character (slicing per character would make a whole-page scan
 * quadratic).
 */
function decodeHtmlUnit(html: string, i: number): { ch: string; len: number } {
  if (html[i] === "&") {
    const restStart = i + 1;
    // Cap the lookahead (Rust: `rest.find(';').filter(|&i| i <= 32)`) so a
    // stray `&` followed by a long run of non-`;` text doesn't scan for a
    // terminator that was never coming. Bounding the SEARCH to the first 33
    // positions is behaviourally identical to finding the first `;` anywhere
    // and rejecting it past index 32.
    let semi = -1;
    for (let k = 0; k <= 32 && restStart + k < html.length; k++) {
      if (html[restStart + k] === ";") {
        semi = k;
        break;
      }
    }
    if (semi !== -1) {
      const body = html.slice(restStart, restStart + semi);
      const decoded = decodeEntityBody(body);
      if (decoded !== null) {
        return { ch: decoded, len: 1 + body.length + 1 };
      }
    }
  }
  const cp = html.codePointAt(i);
  if (cp === undefined) {
    // Unreachable from `scanHtmlRuns` (its loop guard is `i < n`); ported
    // defensively rather than assumed, exactly as the Rust source does.
    return { ch: "�", len: 1 };
  }
  const ch = String.fromCodePoint(cp);
  return { ch, len: ch.length };
}

/** Where a tag's NAME ends within its (already `<`/`/`-stripped) source: the
 * first Unicode-whitespace character or `/`, else the whole string. Ported
 * from the `.find(|c: char| c.is_whitespace() || c == '/')` expression shared
 * by `scan_html_runs` and `scan_headings`. */
function tagNameEnd(nameSrc: string): number {
  let pos = 0;
  for (const ch of nameSrc) {
    if (ch === "/" || isUnicodeWhitespace(ch)) {
      return pos;
    }
    pos += ch.length;
  }
  return nameSrc.length;
}

/** Ported from `html_edit.rs`'s use of `str::trim_start()` (Unicode
 * White_Space-aware, not just ASCII `\s`). */
function trimStartUnicode(s: string): string {
  let i = 0;
  for (const ch of s) {
    if (!isUnicodeWhitespace(ch)) {
      break;
    }
    i += ch.length;
  }
  return s.slice(i);
}

/**
 * Scan `html` into text runs plus a boundary flag between each consecutive
 * pair (`boundaries[i] === true` means a BLOCK boundary separates `runs[i]`
 * and `runs[i + 1]`; `boundaries.length === max(runs.length - 1, 0)`).
 *
 * Malformed markup (an unterminated tag, an unclosed `<script>`/`<style>`)
 * ENDS the scan at that point rather than reading past it — whatever text came
 * before is still editable; nothing after is claimed. Ported verbatim from
 * `html_edit::scan_html_runs`.
 */
export function scanHtmlRuns(html: string): { runs: HtmlTextRun[]; boundaries: boolean[] } {
  // Position-preserving lowered copy, computed once: `asciiLower` never
  // changes a string's length, so an index found in `lower` is a valid index
  // into `html`.
  const lower = asciiLower(html);
  const runs: HtmlTextRun[] = [];
  const boundaries: boolean[] = [];
  let pendingBoundary = false;
  let curStart = -1;
  let curChars: string[] = [];
  let curSpans: Array<readonly [number, number]> = [];
  const n = html.length;
  let i = 0;

  const flushRun = (): void => {
    if (curStart !== -1) {
      if (runs.length > 0) {
        boundaries.push(pendingBoundary);
      }
      pendingBoundary = false;
      runs.push({ span: [curStart, i], chars: curChars, charSpans: curSpans });
      curStart = -1;
      curChars = [];
      curSpans = [];
    }
  };

  while (i < n) {
    if (html[i] === "<") {
      flushRun();
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i);
        if (end === -1) {
          break; // unterminated comment — stop scanning safely
        }
        i = end + 3;
        continue;
      }
      const peek = lower.slice(i, i + Math.min(n - i, 8));
      if (peek.startsWith("<script") || peek.startsWith("<style")) {
        const name = peek.startsWith("<script") ? "script" : "style";
        const openGt = html.indexOf(">", i);
        if (openGt === -1) {
          break; // unterminated open tag
        }
        const afterOpen = openGt + 1;
        const closeStart = lower.indexOf(`</${name}`, afterOpen);
        if (closeStart === -1) {
          break; // no closing tag at all — nothing after is safe to claim
        }
        const gt2 = html.indexOf(">", closeStart);
        if (gt2 === -1) {
          break; // unterminated close tag
        }
        i = gt2 + 1;
        continue;
      }
      const gt = html.indexOf(">", i);
      if (gt === -1) {
        break; // unterminated tag
      }
      const tagSrc = trimStartUnicode(html.slice(i + 1, gt));
      const isClose = tagSrc.startsWith("/");
      // EVERY leading slash comes off, not just the first — Rust's
      // `tag_src.trim_start_matches('/')`. Dropping only one left `<//p>`
      // with a name of `/p`, whose name ends at the slash, so the tag name
      // came out EMPTY and the block boundary was never recorded: a quote
      // could then match straight across it and splice two block elements
      // together, which is the one thing BLOCK_CLOSE_TAGS exists to prevent.
      const nameSrc = tagSrc.replace(/^\/+/, "");
      const tagName = asciiLower(nameSrc.slice(0, tagNameEnd(nameSrc)));
      if (isClose && BLOCK_CLOSE_TAGS.has(tagName)) {
        pendingBoundary = true;
      }
      i = gt + 1;
      continue;
    }
    if (curStart === -1) {
      curStart = i;
    }
    const { ch, len } = decodeHtmlUnit(html, i);
    curSpans.push([i, i + len]);
    curChars.push(ch);
    i += len;
  }
  flushRun();
  return { runs, boundaries };
}

/**
 * Fold an `edit_file` quote the SAME way `flattenRuns` folds the document's
 * own text: `foldEditChar`, whitespace runs collapsed to one space, edge
 * spaces trimmed. Ported verbatim from `html_edit::fold_needle` — kept as its
 * own copy rather than reusing `editMatchFuzzy.ts`'s `normalizeNeedle`
 * (observationally identical, different shape), exactly as the Rust source
 * keeps `fold_needle`, `collapse_ws` and `normalize_needle` side by side.
 */
function foldNeedle(s: string): string[] {
  const out: string[] = [];
  let lastSpace = true;
  for (const c of s) {
    const fold = foldEditChar(c);
    switch (fold.kind) {
      case "space":
        if (!lastSpace) {
          out.push(" ");
          lastSpace = true;
        }
        break;
      case "drop":
        break;
      case "char":
        out.push(fold.c);
        lastSpace = false;
        break;
      case "pair":
        out.push(fold.a);
        out.push(fold.b);
        lastSpace = false;
        break;
    }
  }
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
  }
  return out;
}

/**
 * Flatten every run into one folded haystack, each entry mapped back to
 * `[runIndex, charOffsetWithinRun]`. A {@link BLOCK_SENTINEL} sits between
 * runs separated by a block boundary; runs joined only by inline markup get
 * none, so a quote may span them — exactly `scan_docx_text`'s paragraph
 * discipline, ported from Word runs to HTML tags. Ported verbatim from
 * `html_edit::flatten_runs`.
 */
function flattenRuns(
  runs: readonly HtmlTextRun[],
  boundaries: readonly boolean[]
): { hay: string[]; map: Array<[number, number]> } {
  const hay: string[] = [];
  const map: Array<[number, number]> = [];
  let lastSpace = true;
  for (let ri = 0; ri < runs.length; ri++) {
    if (ri > 0 && boundaries[ri - 1]) {
      hay.push(BLOCK_SENTINEL);
      map.push([SENTINEL_RUN, 0]);
      lastSpace = true;
    }
    const run = runs[ri]!;
    for (let ci = 0; ci < run.chars.length; ci++) {
      const fold = foldEditChar(run.chars[ci]!);
      switch (fold.kind) {
        case "space":
          if (!lastSpace) {
            hay.push(" ");
            map.push([ri, ci]);
            lastSpace = true;
          }
          break;
        case "drop":
          break;
        case "char":
          hay.push(fold.c);
          map.push([ri, ci]);
          lastSpace = false;
          break;
        case "pair":
          hay.push(fold.a);
          map.push([ri, ci]);
          hay.push(fold.b);
          map.push([ri, ci]);
          lastSpace = false;
          break;
      }
    }
  }
  while (hay.length > 0 && hay[hay.length - 1] === " ") {
    hay.pop();
    map.pop();
  }
  return { hay, map };
}

/** Ported verbatim from `html_edit::find_sub`. */
function findSub(hay: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0 || hay.length < needle.length) {
    return -1;
  }
  const limit = hay.length - needle.length;
  outer: for (let s = from; s <= limit; s++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[s + k] !== needle[k]) {
        continue outer;
      }
    }
    return s;
  }
  return -1;
}

/** `Result<(String, usize), String>` — the exact shape
 * `html_edit::html_replace_text` returns. A discriminated union rather than a
 * throw so the CALLER's "not found" branch can never accidentally swallow an
 * unrelated failure (`Err(_)` in Rust can only ever be the no-match case). */
export type HtmlReplaceResult =
  | { readonly ok: true; readonly html: string; readonly count: number }
  | { readonly ok: false; readonly error: string };

/**
 * Replace `old` with `newEscaped` across every text run in `html`, tolerant
 * of the same typographic drift `foldEditChar` corrects for text and docx
 * files. A quote may span inline markup (`<b>`, `<span>`, `<a>`, …) but never
 * a block boundary — crossing one would silently splice two block elements
 * together. `newEscaped` is spliced in LITERALLY, so the caller must
 * HTML-escape it first ({@link htmlEscape}) or a replacement containing
 * `<`/`&` would inject markup.
 *
 * Replaces EVERY non-overlapping match and returns the new markup plus the
 * count — the same pure replace-then-let-the-caller-decide shape
 * `docxReplaceText` has: `computeEditBytes`'s HTML arm applies the ambiguity/
 * `all` check, so this function never needs to know about `all` at all.
 * Fails only when nothing matched. Ported verbatim from
 * `html_edit::html_replace_text`.
 */
export function htmlReplaceText(html: string, old: string, newEscaped: string): HtmlReplaceResult {
  const needle = foldNeedle(old);
  if (needle.length === 0) {
    return { ok: false, error: "Could not find that text in the page." };
  }
  const { runs, boundaries } = scanHtmlRuns(html);
  const { hay, map } = flattenRuns(runs, boundaries);
  const matches: Array<[number, number]> = []; // [start, endInclusive] in hay
  let from = 0;
  for (;;) {
    const s = findSub(hay, needle, from);
    if (s === -1) {
      break;
    }
    const e = s + needle.length - 1;
    matches.push([s, e]);
    from = e + 1;
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: "Could not find that exact text in the page. Copy it exactly, including spacing and punctuation.",
    };
  }
  let out = html;
  // Right-to-left so earlier offsets in `out` stay valid while later
  // (higher-offset) spans are rewritten first.
  for (let mi = matches.length - 1; mi >= 0; mi--) {
    const [s, e] = matches[mi]!;
    const [r1, c1] = map[s]!;
    const [r2, c2] = map[e]!;
    if (r1 === r2) {
      const run = runs[r1]!;
      out = out.slice(0, run.charSpans[c1]![0]) + newEscaped + out.slice(run.charSpans[c2]![1]);
    } else {
      // The match is contiguous with no sentinel in between, so it covers:
      // [c1, end) of r1, ALL of every run strictly between, and [0, c2] of
      // r2. Splice right-to-left across those spans.
      const last = runs[r2]!;
      out = out.slice(0, last.span[0]) + out.slice(last.charSpans[c2]![1]);
      for (let ri = r2 - 1; ri > r1; ri--) {
        const run = runs[ri]!;
        out = out.slice(0, run.span[0]) + out.slice(run.span[1]);
      }
      const first = runs[r1]!;
      out = out.slice(0, first.charSpans[c1]![0]) + newEscaped + out.slice(first.span[1]);
    }
  }
  return { ok: true, html: out, count: matches.length };
}

// ------------------------------------------------------------------- headings

/** One `<h1>`–`<h6>` heading found in the page. Ported from
 * `html_edit::Heading`. */
export interface Heading {
  readonly level: number;
  readonly text: string;
  /** Position right after this heading's OWN closing tag — where the section
   * it introduces begins. */
  readonly sectionStart: number;
  /** Position where this heading's opening tag begins — where the PRECEDING
   * section ends. */
  readonly tagStart: number;
}

const HEADING_LEVELS: ReadonlyMap<string, number> = new Map([
  ["h1", 1], ["h2", 2], ["h3", 3], ["h4", 4], ["h5", 5], ["h6", 6],
]);

/**
 * Every heading in `html`, in document order, with its decoded text (built
 * from {@link scanHtmlRuns}'s own runs, so a heading carrying inline markup
 * like `<h2>Setup <em>and</em> Config</h2>` decodes correctly for free).
 * Ported verbatim from `html_edit::scan_headings`, including its deliberate
 * quirk of NOT special-casing `<script>`/`<style>` bodies the way
 * {@link scanHtmlRuns} does.
 */
export function scanHeadings(html: string): Heading[] {
  const { runs } = scanHtmlRuns(html);
  const lower = asciiLower(html);
  const out: Heading[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html[i] !== "<") {
      i += 1;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i);
      if (end === -1) {
        break;
      }
      i = end + 3;
      continue;
    }
    const gt = html.indexOf(">", i);
    if (gt === -1) {
      break;
    }
    const tagSrc = trimStartUnicode(html.slice(i + 1, gt));
    if (!tagSrc.startsWith("/")) {
      const tagName = asciiLower(tagSrc.slice(0, tagNameEnd(tagSrc)));
      const level = HEADING_LEVELS.get(tagName);
      if (level !== undefined) {
        const tagStart = i;
        const contentStart = gt + 1;
        const closeStart = lower.indexOf(`</${tagName}`, contentStart);
        if (closeStart !== -1) {
          const gt2 = html.indexOf(">", closeStart);
          if (gt2 !== -1) {
            const sectionStart = gt2 + 1;
            const text = runs
              .filter((r) => r.span[0] >= contentStart && r.span[1] <= closeStart)
              .flatMap((r) => [...r.chars])
              .join("")
              .trim();
            out.push({ level, text, sectionStart, tagStart });
            i = sectionStart;
            continue;
          }
        }
      }
    }
    i = gt + 1;
  }
  return out;
}

/** `Result<Range<usize>, Vec<String>>` — a found range, or every heading the
 * page actually has so the caller can offer the model a real one. */
export type SectionRange =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly headings: string[] };

/**
 * The range in `html` that `section` (a heading's text, fold-tolerant) owns:
 * from right after that heading's closing tag to the next heading of the SAME
 * OR HIGHER level (h1 is higher than h2), or the end of the document. On a
 * miss it lists every heading actually found — it never falls back to
 * searching the whole document, which would defeat the point of scoping the
 * edit. Ported verbatim from `html_edit::find_section_range`.
 */
export function findSectionRangeHtml(html: string, section: string): SectionRange {
  const headings = scanHeadings(html);
  const needle = foldNeedle(section).join("");
  const idx = headings.findIndex((h) => foldNeedle(h.text).join("") === needle);
  if (idx === -1) {
    return { ok: false, headings: headings.map((h) => h.text) };
  }
  const level = headings[idx]!.level;
  const start = headings[idx]!.sectionStart;
  const next = headings.slice(idx + 1).find((h) => h.level <= level);
  return { ok: true, start, end: next !== undefined ? next.tagStart : html.length };
}
