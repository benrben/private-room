/**
 * BROWSE-2: the readable article inside a web page, and the metadata the page
 * declares about itself. Port of `src-tauri/src/extraction/article.rs` — but
 * NOT of its scoring algorithm.
 *
 * That file's own dependency (`dom_smoothie`) is a clone of Mozilla's
 * Readability, so this side calls the REAL `@mozilla/readability` package (the
 * algorithm dom_smoothie was cloned FROM) over a real `linkedom` DOM. Cloning
 * a clone would be drift with no upside; this is the zero-drift reference both
 * sides answer to.
 *
 * FOUR THINGS THIS FILE OWNS ON TOP OF THE LIBRARY, and why each one has to be
 * here rather than left to `.parse()`:
 *
 * 1. METADATA IS READ SEPARATELY FROM THE ARTICLE BODY. `parse()` computes the
 *    metadata internally and then THROWS IT ALL AWAY the moment article-body
 *    grabbing fails (`var articleContent = this._grabArticle(); if
 *    (!articleContent) return null;` — the `metadata` local computed one line
 *    earlier never escapes). `article.rs` requires the opposite and pins it
 *    (`a_page_with_no_article_says_so`): a shell page with no extractable
 *    article still has its declared `<title>`. So this file calls Readability's
 *    own metadata reader directly — `_getArticleMetadata(_getJSONLD(doc))`,
 *    the exact pair `.parse()` itself calls — which is also the exact shape of
 *    Rust's `r.get_article_metadata(r.parse_json_ld())`.
 * 2. THE SAME CALL SIDESTEPS A REAL BEHAVIOURAL DRIFT. `.parse()` falls an
 *    undeclared excerpt back to the article's OWN FIRST PARAGRAPH ("If we
 *    haven't found an excerpt in the article's metadata, use the article's
 *    first paragraph as the excerpt" — Readability.js, verbatim). `PageMeta`'s
 *    whole contract is that an undeclared field reads as absent, never
 *    invented from the body: "an invented byline on a saved article is a lie
 *    the room would then repeat forever". The pre-fallback call still has
 *    `excerpt` undefined for a page that never declared one.
 * 3. `modified` HAS NO EQUIVALENT IN READABILITY AT ALL — its metadata reader
 *    only ever populates `publishedTime`. {@link readModified} is this file's
 *    own targeted scan of the tags that carry it. `article.rs` carries no
 *    POSITIVE test for what its Rust dependency recognises here (only the
 *    negative "no such tag declared, stays absent"), so the key list is a
 *    judgement call, not a pinned parity claim.
 * 4. `htmlToMarkdown` is a faithful port of `article.rs`'s own hand-written
 *    serializer. Mozilla's package has no Markdown output, and the reason
 *    `article.rs` hand-wrote one rather than taking `dom_query::md()` applies
 *    identically to every npm HTML-to-Markdown package: they escape `.`, `"`,
 *    `(`, `)` and `#` inside ordinary prose. That is correct CommonMark and it
 *    renders fine — but the escaped string is ALSO what the search index
 *    chunks and what the model reads back out of the file, and `disbelief\.`
 *    is not the word the page printed.
 *
 * RELATIVE REFERENCES ARE READABILITY'S OWN JOB HERE. `_fixRelativeUris`
 * resolves `a[href]` and every media `src`/`poster`/`srcset` against
 * `document.baseURI`, which linkedom populates from the `location` handed to
 * `parseHTML`. Passing the page's URL there is the direct analogue of Rust's
 * `Readability::new(html, abs, …)`, and it covers `srcset` — which a
 * hand-written resolve pass over `a`/`img`/`source`/`poster` silently does
 * not, leaving a responsive image's candidate list pointing at a host the
 * saved copy will never reach again.
 *
 * NOT PORTED: `read_page_bytes`/`decode_text_bytes` (BOM → strict UTF-8 →
 * detection). Nothing in this batch's scope calls it — `capture_and_save`
 * hands `read_page` a string the page script already decoded — so a
 * text-decoding pass here would be a second, untested decoder.
 *
 * TYPES: this project's tsconfig carries no `dom` lib (main-process code has
 * no browser DOM of its own), and Electron's ambient declarations contribute a
 * bare-bones global `Document` that would silently typecheck against the wrong
 * shape. So `DomNode`/`DomElement`/`DomDocument` in `articleTypes.ts` are this file's own
 * minimal structural types for exactly the surface it uses — linkedom's real
 * objects satisfy them at runtime — and each boundary into a library whose
 * `.d.ts` insists on the ambient name is one explicit, narrow cast rather than
 * an implicit `any`.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { PageMeta } from "../../shared/apiTypes.js";
import type {
  ArticleBody,
  DomDocument,
  DomElement,
  DomNode,
  InternalMetaReader,
  LibDomDocument,
  PageCapture,
} from "./articleTypes.js";

export type { ArticleBody, InternalMetaReader, PageCapture } from "./articleTypes.js";

/** `parseHTML`'s own declared return type resolves against the same missing
 * `dom` lib, so the boundary is one explicit cast rather than a type this file
 * pretends to trust. `location` is what gives the document a `baseURI` for
 * Readability's relative-reference pass. */
function parseDocument(html: string, pageUrl?: string): DomDocument {
  const globals = pageUrl ? { location: { href: pageUrl } } : undefined;
  return (parseHTML(html, globals) as unknown as { document: DomDocument }).document;
}

function asLibDomDocument(document: DomDocument): LibDomDocument {
  return document as unknown as LibDomDocument;
}

/** Below this, "the article" is a caption or a paywall stub, not a body. The
 * caller falls back to the whole page instead, which at least keeps the
 * words. */
const MIN_ARTICLE_CHARS = 140;

/** Scoring is per-node, so a runaway single-page-app DOM would be paid for in
 * full on the thread that captured it. Far above any real article (a heavy
 * news page is a few thousand elements); hitting it reads the same way any
 * other extraction failure does — "no article", which the caller handles. */
const MAX_ELEMENTS_TO_PARSE = 50_000;

/**
 * Read a page's declared metadata and its readable article.
 *
 * `url` is the page's own address when it is known: it is what turns the
 * article's relative `src`/`href` into absolute ones, so the saved copy's
 * images and links still point somewhere. Never invented — a capture with no
 * URL simply keeps the page's relative references.
 *
 * Contained the way `read_page` contains a panic: untrusted markup through a
 * third-party parser must cost this extraction and nothing else. The caller
 * then sees "no article", which it already has to handle.
 */
export function readPage(html: string, url?: string | null): PageCapture {
  try {
    return readPageInner(html, url ?? undefined);
  } catch {
    return { meta: {}, article: null };
  }
}

function readPageInner(html: string, url?: string): PageCapture {
  // An absolute URL is what Readability can resolve against; a bare or
  // malformed one must cost the base URL, not the whole extraction.
  const abs = url && /^https?:\/\//i.test(url) ? url : undefined;
  const document = parseDocument(html, abs);

  // Metadata FIRST, off the untouched document: `parse()` mutates the tree it
  // walks, and a page whose article cannot be scored still declares a title,
  // an author and a date.
  const meta: PageMeta = { ...readDeclaredMeta(document), sourceUrl: nonEmpty(url) };

  let article: ArticleBody | null = null;
  try {
    const parsed = new Readability(asLibDomDocument(document), {
      maxElemsToParse: MAX_ELEMENTS_TO_PARSE,
    }).parse();
    if (parsed && parsed.length >= MIN_ARTICLE_CHARS) {
      const cleaned = stripEventHandlers(parsed.content);
      article = { html: cleaned, markdown: htmlToMarkdown(cleaned), text: parsed.textContent };
    }
  } catch {
    // A page the scorer could not get through is a page with no article, not a
    // failed capture: the metadata above still stands.
    article = null;
  }

  return { meta, article };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** The metadata reader `.parse()` itself uses, reachable without parsing.
 *  Exported only so the tripwire test can assert it exists. */
export function metaReaderFor(document: DomDocument): InternalMetaReader {
  return new Readability(asLibDomDocument(document)) as unknown as InternalMetaReader;
}

function readDeclaredMeta(document: DomDocument): Omit<PageMeta, "sourceUrl" | "capturedAt"> {
  let declared: ReturnType<InternalMetaReader["_getArticleMetadata"]> = {};
  try {
    const libDoc = asLibDomDocument(document);
    const reader = metaReaderFor(document);
    declared = reader._getArticleMetadata(reader._getJSONLD(libDoc));
  } catch {
    // A future library version without these internals: metadata comes back
    // empty rather than the whole read failing, and `article.test.ts`'s
    // tripwire is what makes that a loud change rather than a quiet one.
  }
  return {
    title: nonEmpty(declared.title),
    byline: nonEmpty(declared.byline),
    siteName: nonEmpty(declared.siteName),
    published: nonEmpty(declared.publishedTime),
    modified: readModified(document),
    excerpt: nonEmpty(declared.excerpt),
    lang: nonEmpty(document.documentElement?.getAttribute("lang")),
  };
}

/** The tags that carry a page's LAST-UPDATED time. Readability's own metadata
 * reader has no equivalent field at all (module comment, point 3), so this is
 * the one field read straight off the markup. Both `property=` (the Open Graph
 * family) and `name=` (the Dublin Core family, and the sites that spell the
 * `article:` keys as names) are accepted, because plenty of real pages use
 * one where the spec suggests the other. */
const MODIFIED_KEYS = [
  "article:modified_time",
  "og:updated_time",
  "dcterms.modified",
  "dcterms:modified",
  "last-modified",
];

function readModified(document: DomDocument): string | undefined {
  return metaContent(document, MODIFIED_KEYS);
}

/** The first non-empty `content` of a `<meta>` whose `property` or `name`
 * (case-insensitively) is one of `keys`, in the order `keys` lists them — so
 * the preferred spelling wins over a fallback that happens to appear earlier
 * in the document. */
function metaContent(document: DomDocument, keys: readonly string[]): string | undefined {
  const tags = Array.from(document.querySelectorAll("meta"));
  for (const key of keys) {
    for (const tag of tags) {
      const property = tag.getAttribute("property")?.trim().toLowerCase();
      const name = tag.getAttribute("name")?.trim().toLowerCase();
      if (property !== key && name !== key) continue;
      const content = nonEmpty(tag.getAttribute("content"));
      if (content) return content;
    }
  }
  return undefined;
}

/** A trimmed value, or `undefined` when the page left the field empty — a
 * declared-but-blank field must not survive as a field the room can print. */
function nonEmpty(s: string | null | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/**
 * Drop `on*` attributes from extracted article markup.
 *
 * Readability is a CONTENT extractor, not a sanitizer: it removes `<script>`
 * and `<iframe>` ELEMENTS, and Mozilla says in as many words that its output
 * still has to be sanitized. It leaves inline handlers alone, so `<p
 * onclick="…">` and `<img src=… onerror="…">` come through untouched — and the
 * saved article is written to a room file that opens in a
 * `sandbox="allow-scripts"` iframe. The sandbox denies the page an origin and
 * the network, so this is not a way out of the room; but a stored reading copy
 * has no business running the site's code at all, and the only thing standing
 * between the two was that the extractor happened to delete the `<script>`
 * tags. Port of `strip_event_handlers` — private there, private here: it runs
 * on exactly one thing, the article `readPage` just extracted.
 */
function stripEventHandlers(html: string): string {
  const document = parseDocument(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body;
  if (!body) return html;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    const handlers = Array.from(el.attributes)
      .map((a) => a.name)
      .filter((name) => name.length > 2 && name.slice(0, 2).toLowerCase() === "on");
    for (const name of handlers) el.removeAttribute(name);
  }
  return body.innerHTML;
}

// ---------------------------------------------------------------------------
// Article markup -> Markdown (faithful port of article.rs's own serializer)
// ---------------------------------------------------------------------------

/** Element names that start a block of their own — the test for whether a
 *  container should be recursed into or flattened into one paragraph. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "ol", "p", "pre",
  "section", "table", "ul",
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function isElement(node: DomNode): node is DomElement {
  return node.nodeType === ELEMENT_NODE;
}

function tagOf(el: DomElement): string {
  return el.tagName.toLowerCase();
}

function isBlockNode(node: DomNode): boolean {
  return isElement(node) && BLOCK_TAGS.has(tagOf(node));
}

/** HTML whitespace rules: any run of spaces, tabs and newlines is one space. */
function collapse(s: string): string {
  return s
    .split(/\s+/)
    .filter((t) => t !== "")
    .join(" ");
}

function pushBlock(out: string[], block: string): void {
  out.push(block, "\n\n");
}

/**
 * Serialize extracted article markup as Markdown — headings, lists, block
 * quotes, code, tables, links and images kept. Port of `html_to_markdown`.
 */
export function htmlToMarkdown(html: string): string {
  const document = parseDocument(`<!doctype html><html><body>${html}</body></html>`);
  const raw: string[] = [];
  for (const child of Array.from(document.body?.childNodes ?? [])) {
    writeBlock(child, raw, 0);
  }
  return normalizeBlockSpacing(raw);
}

function normalizeBlockSpacing(raw: string[]): string {
  // Blocks each end with their own blank line; collapse the runs that nesting
  // produces so the file does not read as double-spaced.
  let text = "";
  let blanks = 0;
  for (const line of rustLines(raw.join(""))) {
    if (line.trim() === "") {
      blanks += 1;
      continue;
    }
    if (text !== "" && blanks > 0) {
      text += "\n\n";
    }
    blanks = 0;
    // A line inside a list or a code fence keeps its neighbours: only the
    // blank-run counter above separates blocks.
    text += `${line.trimEnd()}\n`;
  }
  return text;
}

/** Mirrors Rust's `str::lines()`: split on `\n` (CRLF normalized first), with
 *  no trailing empty element for a final newline — unlike a bare
 *  `String.split("\n")`. */
function rustLines(s: string): string[] {
  const parts = s.replace(/\r\n/g, "\n").split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

type BlockWriter = (node: DomElement, out: string[], depth: number) => void;

const BLOCK_WRITERS: ReadonlyMap<string, BlockWriter> = new Map([
  ["h1", writeHeadingBlock],
  ["h2", writeHeadingBlock],
  ["h3", writeHeadingBlock],
  ["h4", writeHeadingBlock],
  ["h5", writeHeadingBlock],
  ["h6", writeHeadingBlock],
  ["p", writeInlineBlock],
  ["figcaption", writeInlineBlock],
  ["blockquote", writeBlockQuote],
  ["ul", writeList],
  ["ol", writeList],
  ["pre", writePreformattedBlock],
  ["hr", writeHorizontalRule],
  ["table", writeTableBlock],
  ["img", writeInlineBlock],
]);

/** Emit one block-level node. `depth` is the list nesting level. */
function writeBlock(node: DomNode, out: string[], depth: number): void {
  if (node.nodeType === TEXT_NODE) {
    writeTextBlock(node, out);
    return;
  }
  if (!isElement(node)) return;
  const writer = BLOCK_WRITERS.get(tagOf(node));
  if (writer) {
    writer(node, out, depth);
    return;
  }
  writeContainerBlock(node, out, depth);
}

function writeTextBlock(node: DomNode, out: string[]): void {
  const text = collapse(node.textContent ?? "");
  if (text !== "") pushBlock(out, text);
}

function writeHeadingBlock(node: DomElement, out: string[]): void {
  const level = Number.parseInt(tagOf(node).slice(1), 10) || 1;
  const text = inline(node);
  if (text !== "") pushBlock(out, `${"#".repeat(level)} ${text}`);
}

function writeInlineBlock(node: DomElement, out: string[]): void {
  const text = inline(node);
  if (text !== "") pushBlock(out, text);
}

function writeBlockQuote(node: DomElement, out: string[], depth: number): void {
  const inner: string[] = [];
  for (const child of Array.from(node.childNodes)) writeBlock(child, inner, depth);
  const quoted = inner
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => `> ${line}`);
  if (quoted.length > 0) pushBlock(out, quoted.join("\n"));
}

function isListItem(node: DomNode): node is DomElement {
  return isElement(node) && tagOf(node) === "li";
}

function listMarker(listName: string, index: number): string {
  return listName === "ol" ? `${index + 1}. ` : "- ";
}

function isNestedList(node: DomNode): node is DomElement {
  return isElement(node) && (tagOf(node) === "ul" || tagOf(node) === "ol");
}

function writeListItem(item: DomElement, out: string[], indent: string, marker: string, depth: number): void {
  const text = inline(item);
  if (text !== "") out.push(`${indent}${marker}${text}\n`);
  // A nested list is a block inside the item, not inline text.
  for (const child of Array.from(item.childNodes)) {
    if (isNestedList(child)) writeBlock(child, out, depth + 1);
  }
}

function writeList(node: DomElement, out: string[], depth: number): void {
  const items: string[] = [];
  const listName = tagOf(node);
  const indent = "  ".repeat(depth);
  Array.from(node.childNodes)
    .filter(isListItem)
    .forEach((item, index) => writeListItem(item, items, indent, listMarker(listName, index), depth));
  const joined = items.join("");
  if (joined.trim() !== "") pushBlock(out, joined.replace(/\n+$/, ""));
}

function writePreformattedBlock(node: DomElement, out: string[]): void {
  const code = node.textContent ?? "";
  if (code.trim() !== "") pushBlock(out, `\`\`\`\n${code.replace(/\s+$/, "")}\n\`\`\``);
}

function writeHorizontalRule(_node: DomElement, out: string[]): void {
  pushBlock(out, "---");
}

function writeTableBlock(node: DomElement, out: string[]): void {
  const table = writeTable(node);
  if (table !== "") pushBlock(out, table);
}

function writeContainerBlock(node: DomElement, out: string[], depth: number): void {
  // Anything else (div, section, article, figure, aside kept by the scorer…)
  // is a container: recurse when it holds blocks, otherwise treat its inline
  // content as one paragraph. Without the second half a `<div>bare text</div>`
  // would vanish.
  const children = Array.from(node.childNodes);
  if (children.some(isBlockNode)) {
    for (const child of children) writeBlock(child, out, depth);
    return;
  }
  writeInlineBlock(node, out);
}

/** Markdown rows for one table. Headerless tables get an empty header row, so
 *  the result is still a table every renderer accepts. */
function writeTable(table: DomElement): string {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.children)
      .filter((c) => tagOf(c) === "td" || tagOf(c) === "th")
      .map((c) => inline(c).replace(/\|/g, "\\|"));
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  let out = "";
  rows.forEach((row, i) => {
    const cells = [...row];
    while (cells.length < width) cells.push("");
    out += `| ${cells.join(" | ")} |\n`;
    if (i === 0) {
      out += `|${" --- |".repeat(width)}\n`;
    }
  });
  return out.replace(/\s+$/, "");
}

/** A node's inline content: text with links, images and emphasis kept. */
function inline(node: DomNode): string {
  const parts: string[] = [];
  inlineInto(node, parts);
  return collapse(parts.join(""));
}

type InlineWriter = (node: DomElement, out: string[]) => void;

const INLINE_WRITERS: ReadonlyMap<string, InlineWriter> = new Map([
  ["a", writeInlineLink],
  ["img", writeInlineImage],
  ["br", writeLineBreak],
  ["code", writeInlineCode],
  ["kbd", writeInlineCode],
  ["samp", writeInlineCode],
  ["strong", writeStrong],
  ["b", writeStrong],
  ["em", writeEmphasis],
  ["i", writeEmphasis],
]);

function inlineInto(node: DomNode, out: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    out.push(node.textContent ?? "");
    return;
  }
  if (!isElement(node)) return;
  const writer = INLINE_WRITERS.get(tagOf(node));
  if (writer) {
    writer(node, out);
    return;
  }
  writeInlineChildren(node, out);
}

function writeInlineLink(node: DomElement, out: string[]): void {
  const text = collapse(node.textContent ?? "");
  const href = node.getAttribute("href") ?? "";
  // A link with no text is furniture (an icon, an anchor); a `javascript:`
  // href is not somewhere the reader can go.
  if (text === "") return;
  if (href === "" || href.startsWith("javascript:")) {
    out.push(text);
    return;
  }
  out.push(`[${text}](${href})`);
}

function writeInlineImage(node: DomElement, out: string[]): void {
  const src = node.getAttribute("src") ?? "";
  if (src !== "") {
    const alt = collapse(node.getAttribute("alt") ?? "");
    out.push(`![${alt}](${src})`);
  }
}

function writeLineBreak(_node: DomElement, out: string[]): void {
  out.push(" ");
}

function writeInlineCode(node: DomElement, out: string[]): void {
  const text = collapse(node.textContent ?? "");
  if (text !== "") out.push(`\`${text}\``);
}

function writeStrong(node: DomElement, out: string[]): void {
  wrapChildren(node, out, "**");
}

function writeEmphasis(node: DomElement, out: string[]): void {
  wrapChildren(node, out, "*");
}

function writeInlineChildren(node: DomElement, out: string[]): void {
  for (const child of Array.from(node.childNodes)) inlineInto(child, out);
}

function wrapChildren(el: DomElement, out: string[], marker: string): void {
  const inner: string[] = [];
  for (const child of Array.from(el.childNodes)) inlineInto(child, inner);
  const collapsed = collapse(inner.join(""));
  if (collapsed === "") return;
  out.push(marker, collapsed, marker);
}
