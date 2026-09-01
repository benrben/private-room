/**
 * Ported from `src-tauri/src/extraction/docx.rs` — `commands/edit_match.rs`'s
 * docx branch calls `docx_replace_text` directly, and its own tests round-trip
 * the result through `extract_text`, so `extract_docx` is ported alongside it.
 *
 * Uses `editMatchZip.ts` in place of the Rust source's `zip` crate (no such
 * dependency exists in this project) and `editMatchExtraction.ts` for the
 * shared fold table / entity decoding / paragraph-text helpers `docx.rs`
 * pulls in via `use super::*`.
 *
 * Word splits a sentence into many `<w:t>` runs (spellcheck, formatting, rsid
 * churn), so a match may span several nodes: the replacement lands in the
 * FIRST node (keeping its formatting) and the remainder of the match is
 * cleared. Paragraph boundaries are unmatchable sentinels, exactly as in the
 * plain-text and HTML matchers — a quote may never splice two paragraphs.
 */

import {
  decodeBasicEntities,
  foldEditChar,
  isUnicodeWhitespace,
  xmlParasToText,
} from "./editMatchExtraction.js";
import { buildZip, parseZip, readZipEntryText, zipEntryNames, type ZipEntry, type ZipWriteEntry } from "./editMatchZip.js";

/** The parts of a Word file that carry prose beyond the body — a clause
 * living in a footnote, header, footer or review comment used to be invisible
 * to search and to the assistant with nothing saying it had been skipped.
 * Header/footer parts are NUMBERED (`header1.xml`, …), so they are discovered
 * from the archive rather than named here. Ported from
 * `docx::DOCX_EXTRA_PARTS`. */
const DOCX_EXTRA_PARTS: ReadonlyArray<readonly [string, string]> = [
  ["word/footnotes.xml", "footnotes"],
  ["word/endnotes.xml", "endnotes"],
  ["word/comments.xml", "comments"],
];

/** Append one labelled part's text, if it exists and holds anything readable.
 * The label matters: without it the model cannot tell a footnote's small
 * print from the body clause it qualifies. Ported from
 * `docx::push_docx_part`. */
function pushDocxPart(parts: string[], bytes: Uint8Array, entry: string, label: string): void {
  const xml = readZipEntryText(bytes, entry);
  if (xml === undefined) {
    return;
  }
  const text = xmlParasToText(xml, "</w:p>");
  if (text.trim() === "") {
    return;
  }
  parts.push(`\n[${label}]\n${text}`);
}

function pushExtraDocxParts(parts: string[], bytes: Uint8Array): void {
  for (const [entry, label] of DOCX_EXTRA_PARTS) {
    pushDocxPart(parts, bytes, entry, label);
  }
}

function headerFooterLabel(name: string): string | null {
  if (name.startsWith("word/header")) return "header";
  if (name.startsWith("word/footer")) return "footer";
  return null;
}

function pushDocxHeaderFooterParts(parts: string[], bytes: Uint8Array): void {
  for (const name of zipEntryNames(bytes)) {
    const label = headerFooterLabel(name);
    if (label !== null && name.endsWith(".xml")) {
      pushDocxPart(parts, bytes, name, label);
    }
  }
}

/** Ported from `docx::extract_docx`. `null` when `word/document.xml` can't be
 * read at all. */
export function extractDocx(bytes: Uint8Array): string | null {
  const xml = readZipEntryText(bytes, "word/document.xml");
  if (xml === undefined) {
    return null;
  }
  const parts: string[] = [xmlParasToText(xml, "</w:p>")];
  pushExtraDocxParts(parts, bytes);
  // Headers and footers are per-section parts; take them in archive order.
  pushDocxHeaderFooterParts(parts, bytes);
  return parts.join("");
}

/** Ported from `docx::encode_xml_text`. */
function encodeXmlText(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

/** A `<w:t>` text node found in document.xml, positions in the RAW xml.
 * Ported from `docx::DocxTextNode`. */
interface DocxTextNode {
  readonly tagStart: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** Decoded characters, one entry per code point (Rust: `Vec<char>`). */
  readonly text: string[];
}

/** A map entry that must never resolve to a real node — Rust uses
 * `usize::MAX`. Nothing may match a needle containing NUL (the fold table
 * drops it), so this is never dereferenced. */
const PARA_SENTINEL_NODE = -1;

/** The paragraph separator in the flattened stream: NUL, never a plain space,
 * or a needle like `"one. Start"` would match straight across a paragraph
 * break the moment one node ends in `"one."` and the next begins `"Start"`.
 * Built with `String.fromCharCode` so no raw NUL sits in this source file. */
const PARA_SENTINEL = String.fromCharCode(0);

interface DocxTextScan {
  readonly nodes: DocxTextNode[];
  readonly hay: string[];
  readonly map: Array<[number, number]>;
  lastSpace: boolean;
  position: number;
}

type DocxMarkup =
  | { readonly kind: "text"; readonly tagStart: number }
  | { readonly kind: "paragraph"; readonly tagStart: number };

type DocxTextNodeScan =
  | { readonly kind: "stop" }
  | { readonly kind: "skip"; readonly nextPosition: number }
  | { readonly kind: "node"; readonly nextPosition: number; readonly node: DocxTextNode };

function textMarkupPrecedesParagraph(textStart: number, paragraphStart: number): boolean {
  return textStart !== -1 && (paragraphStart === -1 || textStart < paragraphStart);
}

function nextDocxMarkup(xml: string, position: number): DocxMarkup | null {
  const textStart = xml.indexOf("<w:t", position);
  const paragraphStart = xml.indexOf("</w:p>", position);
  if (textStart === -1 && paragraphStart === -1) {
    return null;
  }
  return textMarkupPrecedesParagraph(textStart, paragraphStart)
    ? { kind: "text", tagStart: textStart }
    : { kind: "paragraph", tagStart: paragraphStart };
}

function looksLikeDocxTextTag(afterTagName: string): boolean {
  return afterTagName.startsWith(">");
}

function looksLikeDocxTextTagWithAttributes(afterTagName: string): boolean {
  return afterTagName.startsWith(" ");
}

function isDocxTextTag(afterTagName: string): boolean {
  return looksLikeDocxTextTag(afterTagName) || looksLikeDocxTextTagWithAttributes(afterTagName);
}

function isSelfClosingDocxTextTag(afterTagName: string, tagEnd: number): boolean {
  return tagEnd >= 1 && afterTagName[tagEnd - 1] === "/";
}

function skipDocxTextTag(tagStart: number, offset: number): DocxTextNodeScan {
  return { kind: "skip", nextPosition: tagStart + offset };
}

function scanDocxTextContent(xml: string, tagStart: number, tagEnd: number): DocxTextNodeScan {
  const bodyStart = tagStart + 4 + tagEnd + 1;
  const bodyEnd = xml.indexOf("</w:t>", bodyStart);
  if (bodyEnd === -1) {
    return { kind: "stop" };
  }
  const text = [...decodeBasicEntities(xml.slice(bodyStart, bodyEnd))];
  return {
    kind: "node",
    nextPosition: bodyEnd + 6,
    node: { tagStart, bodyStart, bodyEnd, text },
  };
}

function scanDocxTextTag(xml: string, tagStart: number): DocxTextNodeScan {
  const afterTagName = xml.slice(tagStart + 4);
  if (!isDocxTextTag(afterTagName)) {
    return skipDocxTextTag(tagStart, 4);
  }
  const tagEnd = afterTagName.indexOf(">");
  if (tagEnd === -1) {
    return { kind: "stop" };
  }
  if (isSelfClosingDocxTextTag(afterTagName, tagEnd)) {
    return skipDocxTextTag(tagStart, 4 + tagEnd + 1);
  }
  return scanDocxTextContent(xml, tagStart, tagEnd);
}

function appendDocxSpace(scan: DocxTextScan, nodeIndex: number, characterIndex: number): void {
  if (!scan.lastSpace) {
    scan.hay.push(" ");
    scan.map.push([nodeIndex, characterIndex]);
    scan.lastSpace = true;
  }
}

function appendDocxCharacter(scan: DocxTextScan, nodeIndex: number, characterIndex: number, character: string): void {
  scan.hay.push(character);
  scan.map.push([nodeIndex, characterIndex]);
  scan.lastSpace = false;
}

function appendDocxCharacterPair(
  scan: DocxTextScan,
  nodeIndex: number,
  characterIndex: number,
  first: string,
  second: string,
): void {
  appendDocxCharacter(scan, nodeIndex, characterIndex, first);
  appendDocxCharacter(scan, nodeIndex, characterIndex, second);
}

function appendFoldedDocxCharacter(scan: DocxTextScan, nodeIndex: number, characterIndex: number, character: string): void {
  const fold = foldEditChar(character);
  switch (fold.kind) {
    case "space":
      appendDocxSpace(scan, nodeIndex, characterIndex);
      break;
    case "drop":
      break;
    case "char":
      appendDocxCharacter(scan, nodeIndex, characterIndex, fold.c);
      break;
    case "pair":
      appendDocxCharacterPair(scan, nodeIndex, characterIndex, fold.a, fold.b);
      break;
  }
}

function appendFoldedDocxText(scan: DocxTextScan, nodeIndex: number, text: readonly string[]): void {
  for (let characterIndex = 0; characterIndex < text.length; characterIndex++) {
    appendFoldedDocxCharacter(scan, nodeIndex, characterIndex, text[characterIndex]!);
  }
}

function appendDocxParagraphBoundary(scan: DocxTextScan, tagStart: number): void {
  scan.hay.push(PARA_SENTINEL);
  scan.map.push([PARA_SENTINEL_NODE, 0]);
  scan.lastSpace = true;
  scan.position = tagStart + 6;
}

function appendDocxTextNode(scan: DocxTextScan, node: DocxTextNode): void {
  appendFoldedDocxText(scan, scan.nodes.length, node.text);
  scan.nodes.push(node);
}

function consumeDocxTextMarkup(scan: DocxTextScan, xml: string, tagStart: number): boolean {
  const result = scanDocxTextTag(xml, tagStart);
  if (result.kind === "stop") {
    return false;
  }
  scan.position = result.nextPosition;
  if (result.kind === "skip") {
    return true;
  }
  appendDocxTextNode(scan, result.node);
  return true;
}

function advanceDocxTextScan(scan: DocxTextScan, xml: string): boolean {
  const markup = nextDocxMarkup(xml, scan.position);
  if (markup === null) {
    return false;
  }
  if (markup.kind === "paragraph") {
    appendDocxParagraphBoundary(scan, markup.tagStart);
    return true;
  }
  return consumeDocxTextMarkup(scan, xml, markup.tagStart);
}

/**
 * Scan `xml` for `<w:t>` text nodes, keeping paragraph boundaries. Returns
 * the nodes plus a "virtual text" stream (whitespace-collapsed,
 * fold-table-applied document text) where each character maps back to
 * `[nodeIndex, charOffsetWithinNode]`. Ported from `docx::scan_docx_text`.
 */
function scanDocxText(xml: string): { nodes: DocxTextNode[]; hay: string[]; map: Array<[number, number]> } {
  const scan: DocxTextScan = {
    nodes: [],
    hay: [],
    map: [],
    lastSpace: true,
    position: 0,
  };
  while (advanceDocxTextScan(scan, xml)) {
    // Each step either moves the scanner forward or stops it.
  }
  return { nodes: scan.nodes, hay: scan.hay, map: scan.map };
}

interface CollapsedWhitespace {
  readonly out: string[];
  lastSpace: boolean;
}

function appendCollapsedSpace(scan: CollapsedWhitespace): void {
  if (!scan.lastSpace) {
    scan.out.push(" ");
    scan.lastSpace = true;
  }
}

function appendCollapsedNonSpace(scan: CollapsedWhitespace, character: string): void {
  scan.out.push(character);
  scan.lastSpace = false;
}

function appendCollapsedPair(scan: CollapsedWhitespace, first: string, second: string): void {
  appendCollapsedNonSpace(scan, first);
  appendCollapsedNonSpace(scan, second);
}

function appendCollapsedCharacter(scan: CollapsedWhitespace, character: string): void {
  const fold = foldEditChar(character);
  switch (fold.kind) {
    case "space":
      appendCollapsedSpace(scan);
      break;
    case "drop":
      break;
    case "char":
      appendCollapsedNonSpace(scan, fold.c);
      break;
    case "pair":
      appendCollapsedPair(scan, fold.a, fold.b);
      break;
  }
}

/** Whitespace-collapsed, fold-table-applied needle — matching must survive
 * the different spacing the model sees in extracted text vs. what the runs
 * actually contain. Ported from `docx::collapse_ws`. */
function collapseWs(s: string): string[] {
  const scan: CollapsedWhitespace = { out: [], lastSpace: true };
  for (const ch of s) {
    appendCollapsedCharacter(scan, ch);
  }
  while (scan.out.length > 0 && scan.out[scan.out.length - 1] === " ") {
    scan.out.pop();
  }
  return scan.out;
}

/** Ported from `docx::find_sub`. */
function findSub(hay: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0 || hay.length < needle.length) {
    return -1;
  }
  outer: for (let s = from; s <= hay.length - needle.length; s++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[s + k] !== needle[k]) {
        continue outer;
      }
    }
    return s;
  }
  return -1;
}

/** True when the node's new text begins or ends with whitespace, so Word must
 * be told to keep it (`xml:space="preserve"`). Rust uses
 * `str::starts_with(char::is_whitespace)`, the Unicode property — not JS's
 * `\s`, which both misses U+0085 and adds U+FEFF. */
function hasEdgeWhitespace(s: string): boolean {
  if (s === "") {
    return false;
  }
  const chars = [...s];
  return isUnicodeWhitespace(chars[0]!) || isUnicodeWhitespace(chars[chars.length - 1]!);
}

type DocxNodeEdit = [number, number, string];
type DocxEdits = Array<DocxNodeEdit[]>;

function clearIntermediateDocxNodes(edits: DocxEdits, fromNode: number, toNode: number): void {
  for (let nodeIndex = fromNode + 1; nodeIndex < toNode; nodeIndex++) {
    edits[nodeIndex]!.push([0, Number.MAX_SAFE_INTEGER, ""]);
  }
}

function addDocxMatchEdit(
  edits: DocxEdits,
  nodes: readonly DocxTextNode[],
  map: ReadonlyArray<readonly [number, number]>,
  start: number,
  length: number,
  replacement: string,
): void {
  const [firstNode, firstOffset] = map[start]!;
  const [lastNode, lastOffset] = map[start + length - 1]!;
  if (firstNode === lastNode) {
    edits[firstNode]!.push([firstOffset, lastOffset + 1, replacement]);
    return;
  }
  edits[firstNode]!.push([firstOffset, nodes[firstNode]!.text.length, replacement]);
  clearIntermediateDocxNodes(edits, firstNode, lastNode);
  edits[lastNode]!.push([0, lastOffset + 1, ""]);
}

function collectDocxEdits(
  nodes: readonly DocxTextNode[],
  hay: readonly string[],
  map: ReadonlyArray<readonly [number, number]>,
  needle: readonly string[],
  replacement: string,
): { edits: DocxEdits; count: number } {
  const edits: DocxEdits = nodes.map(() => []);
  let count = 0;
  let from = 0;
  for (;;) {
    const start = findSub(hay, needle, from);
    if (start === -1) break;
    count += 1;
    from = start + needle.length;
    addDocxMatchEdit(edits, nodes, map, start, needle.length, replacement);
  }
  return { edits, count };
}

function applyDocxNodeEdits(text: readonly string[], edits: readonly DocxNodeEdit[]): string {
  let updated = [...text];
  const sorted = [...edits].sort((a, b) => a[0] - b[0]);
  for (let index = sorted.length - 1; index >= 0; index--) {
    const [start, endRaw, replacement] = sorted[index]!;
    const end = Math.min(endRaw, updated.length);
    updated = updated.slice(0, start).concat([...replacement], updated.slice(end));
  }
  return updated.join("");
}

function rewriteDocxNode(xml: string, node: DocxTextNode, newText: string): string {
  let out = xml.slice(0, node.bodyStart) + encodeXmlText(newText) + xml.slice(node.bodyEnd);
  const tag = out.slice(node.tagStart, node.bodyStart);
  if (hasEdgeWhitespace(newText) && !tag.includes("xml:space")) {
    out = `${out.slice(0, node.bodyStart - 1)} xml:space="preserve"${out.slice(node.bodyStart - 1)}`;
  }
  return out;
}

function applyDocxEdits(xml: string, nodes: readonly DocxTextNode[], edits: DocxEdits): string {
  let out = xml;
  for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const nodeEdits = edits[nodeIndex]!;
    if (nodeEdits.length === 0) continue;
    const node = nodes[nodeIndex]!;
    out = rewriteDocxNode(out, node, applyDocxNodeEdits(node.text, nodeEdits));
  }
  return out;
}

/**
 * Replace `old` with `newText` across the document's text nodes, tolerant of
 * whitespace and typographic drift. Returns the patched xml plus the match
 * count. Ported from `docx::replace_in_text_nodes`.
 */
export function replaceInTextNodes(xml: string, old: string, newText: string): { xml: string; count: number } {
  const needle = collapseWs(old);
  if (needle.length === 0) {
    return { xml, count: 0 };
  }
  const { nodes, hay, map } = scanDocxText(xml);
  const { edits, count } = collectDocxEdits(nodes, hay, map, needle, newText);
  if (count === 0) {
    return { xml, count: 0 };
  }
  // Rewrite changed nodes, splicing right-to-left so earlier positions stay
  // valid while later ones are rewritten first.
  return { xml: applyDocxEdits(xml, nodes, edits), count };
}

/** `Result<(Vec<u8>, usize), String>` — the exact shape
 * `docx::docx_replace_text` returns. A discriminated union rather than a
 * throw so `computeEditBytes`'s "not found" branch can never accidentally
 * swallow an unrelated failure. */
export type DocxReplaceResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly count: number }
  | { readonly ok: false; readonly error: string };

/**
 * Edit a `.docx` in place: replace text within `word/document.xml`, keeping
 * every other zip entry's content unchanged. Errors carry guidance the model
 * can act on. Ported from `docx::docx_replace_text`.
 */
export function docxReplaceText(bytes: Uint8Array, old: string, newText: string): DocxReplaceResult {
  const xml = readZipEntryText(bytes, "word/document.xml");
  if (xml === undefined) {
    return { ok: false, error: "This file is not a readable .docx document." };
  }
  const { xml: patched, count } = replaceInTextNodes(xml, old, newText);
  if (count === 0) {
    return {
      ok: false,
      error:
        `Could not find that text in the document (capitalization must match; ` +
        `it can't cross a paragraph break). Copy a snippet exactly as it ` +
        `appears in the file. Searched for: "${old}"`,
    };
  }
  const archive: ZipEntry[] = parseZip(bytes);
  const writeEntries: ZipWriteEntry[] = archive.map((entry) =>
    entry.name === "word/document.xml"
      ? { name: entry.name, data: Buffer.from(patched, "utf8") }
      : { name: entry.name, raw: entry }
  );
  return { ok: true, bytes: buildZip(writeEntries), count };
}
