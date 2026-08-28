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

/** Ported from `docx::extract_docx`. `null` when `word/document.xml` can't be
 * read at all. */
export function extractDocx(bytes: Uint8Array): string | null {
  const xml = readZipEntryText(bytes, "word/document.xml");
  if (xml === undefined) {
    return null;
  }
  const parts: string[] = [xmlParasToText(xml, "</w:p>")];
  for (const [entry, label] of DOCX_EXTRA_PARTS) {
    pushDocxPart(parts, bytes, entry, label);
  }
  // Headers and footers are per-section parts; take them in archive order.
  for (const name of zipEntryNames(bytes)) {
    const label = name.startsWith("word/header") ? "header" : name.startsWith("word/footer") ? "footer" : null;
    if (label !== null && name.endsWith(".xml")) {
      pushDocxPart(parts, bytes, name, label);
    }
  }
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

/**
 * Scan `xml` for `<w:t>` text nodes, keeping paragraph boundaries. Returns
 * the nodes plus a "virtual text" stream (whitespace-collapsed,
 * fold-table-applied document text) where each character maps back to
 * `[nodeIndex, charOffsetWithinNode]`. Ported from `docx::scan_docx_text`.
 */
function scanDocxText(xml: string): { nodes: DocxTextNode[]; hay: string[]; map: Array<[number, number]> } {
  const nodes: DocxTextNode[] = [];
  const hay: string[] = [];
  const map: Array<[number, number]> = [];
  let lastSpace = true;
  let i = 0;
  for (;;) {
    const nextT = xml.indexOf("<w:t", i);
    const nextP = xml.indexOf("</w:p>", i);
    if (nextT === -1 && nextP === -1) {
      break;
    }
    if (nextT !== -1 && (nextP === -1 || nextT < nextP)) {
      // Only a real `<w:t>` / `<w:t attr…>`, not `<w:tab/>` etc.
      const after = xml.slice(nextT + 4);
      if (!(after.startsWith(">") || after.startsWith(" "))) {
        i = nextT + 4;
        continue;
      }
      const gt = after.indexOf(">");
      if (gt === -1) {
        break;
      }
      // Self-closing empty node: `<w:t/>` or `<w:t …/>`.
      if (gt >= 1 && after[gt - 1] === "/") {
        i = nextT + 4 + gt + 1;
        continue;
      }
      const bodyStart = nextT + 4 + gt + 1;
      const bodyEnd = xml.indexOf("</w:t>", bodyStart);
      if (bodyEnd === -1) {
        break;
      }
      const text = [...decodeBasicEntities(xml.slice(bodyStart, bodyEnd))];
      const ni = nodes.length;
      // Fold each char through the shared edit table so a docx match tolerates
      // the same curly-quote/NBSP/dash/ligature drift the plain-text matcher
      // does. Paragraph bounds stay via the sentinels below.
      for (let ci = 0; ci < text.length; ci++) {
        const fold = foldEditChar(text[ci]!);
        switch (fold.kind) {
          case "space":
            if (!lastSpace) {
              hay.push(" ");
              map.push([ni, ci]);
              lastSpace = true;
            }
            break;
          case "drop":
            break;
          case "char":
            hay.push(fold.c);
            map.push([ni, ci]);
            lastSpace = false;
            break;
          case "pair":
            // Both halves map back to the SAME source char, so a match
            // spanning either replaces that whole character.
            hay.push(fold.a);
            map.push([ni, ci]);
            hay.push(fold.b);
            map.push([ni, ci]);
            lastSpace = false;
            break;
        }
      }
      nodes.push({ tagStart: nextT, bodyStart, bodyEnd, text });
      i = bodyEnd + 6;
    } else {
      // Paragraph boundary: an unmatchable separator.
      hay.push(PARA_SENTINEL);
      map.push([PARA_SENTINEL_NODE, 0]);
      lastSpace = true;
      i = nextP + 6;
    }
  }
  return { nodes, hay, map };
}

/** Whitespace-collapsed, fold-table-applied needle — matching must survive
 * the different spacing the model sees in extracted text vs. what the runs
 * actually contain. Ported from `docx::collapse_ws`. */
function collapseWs(s: string): string[] {
  const out: string[] = [];
  let lastSpace = true;
  for (const ch of s) {
    const fold = foldEditChar(ch);
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

  // edits[node] = [fromChar, toCharExclusive, replacement][]
  const edits: Array<Array<[number, number, string]>> = nodes.map(() => []);
  let count = 0;
  let from = 0;
  for (;;) {
    const s = findSub(hay, needle, from);
    if (s === -1) {
      break;
    }
    count += 1;
    from = s + needle.length;
    const [n1, off1] = map[s]!;
    const [n2, off2] = map[s + needle.length - 1]!;
    if (n1 === n2) {
      edits[n1]!.push([off1, off2 + 1, newText]);
    } else {
      edits[n1]!.push([off1, nodes[n1]!.text.length, newText]);
      for (let ni = n1 + 1; ni < n2; ni++) {
        edits[ni]!.push([0, Number.MAX_SAFE_INTEGER, ""]);
      }
      edits[n2]!.push([0, off2 + 1, ""]);
    }
  }
  if (count === 0) {
    return { xml, count: 0 };
  }

  // Rewrite changed nodes, splicing right-to-left so earlier positions stay
  // valid while later ones are rewritten first.
  let out = xml;
  for (let ni = nodes.length - 1; ni >= 0; ni--) {
    const nodeEdits = edits[ni]!;
    if (nodeEdits.length === 0) {
      continue;
    }
    const node = nodes[ni]!;
    let text = [...node.text];
    const sorted = [...nodeEdits].sort((a, b) => a[0] - b[0]);
    for (let k = sorted.length - 1; k >= 0; k--) {
      const [start, endRaw, repl] = sorted[k]!;
      const end = Math.min(endRaw, text.length);
      const tail = text.slice(end);
      text = text.slice(0, start).concat([...repl], tail);
    }
    const newNodeText = text.join("");
    out = out.slice(0, node.bodyStart) + encodeXmlText(newNodeText) + out.slice(node.bodyEnd);
    // Word trims un-flagged edge whitespace; keep it explicit.
    const tag = out.slice(node.tagStart, node.bodyStart);
    if (hasEdgeWhitespace(newNodeText) && !tag.includes("xml:space")) {
      out = `${out.slice(0, node.bodyStart - 1)} xml:space="preserve"${out.slice(node.bodyStart - 1)}`;
    }
  }
  return { xml: out, count };
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
  let archive: ZipEntry[];
  try {
    archive = parseZip(bytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const writeEntries: ZipWriteEntry[] = archive.map((entry) =>
    entry.name === "word/document.xml"
      ? { name: entry.name, data: Buffer.from(patched, "utf8") }
      : { name: entry.name, raw: entry }
  );
  return { ok: true, bytes: buildZip(writeEntries), count };
}
