/**
 * The two PURE string helpers the `save_file` workflow node needs: a display-
 * name sanitizer and an append-into-an-existing-page splice. Ported from
 * `src-tauri/src/commands/jobs/workflow.rs`'s `clean_save_name` (~2267-2287)
 * and `append_into_html` (~2289-2314), with their own Rust unit tests
 * (`a_saved_file_name_cannot_be_a_pasted_model_reply`,
 * `appending_to_an_html_page_stays_one_document`,
 * `appending_survives_text_that_changes_length_when_lowercased`) ported
 * alongside them in `workflowSaveFile.test.ts`.
 *
 * WHY ITS OWN FILE rather than folded into `workflowEngine.ts`: both
 * functions are pure — no `RoomSource`, no DB, no `interpolate`, no sidecar —
 * so splitting them out gives `saveFileNode` (which DOES need all of that,
 * and stays in `workflowEngine.ts` alongside the rest of the node dispatcher,
 * exactly as Rust keeps `save_file_node` beside `run_workflow_node`) a
 * one-directional dependency on this file rather than a circular one.
 *
 * `html_document` itself is NOT re-ported here — `docsHtml.ts`'s already-
 * committed {@link htmlDocument} is reused as-is, per this migration's
 * established convention (see `filePass.ts`'s module doc for the identical
 * call on the same function).
 */

import { htmlDocument } from "./docsHtml.js";

/** Longest a saved file's name may be, before the extension, in Unicode
 * SCALAR VALUES (`chars().count()`, not UTF-16 code units) — the template runs
 * through `interpolate` first, so `{{input}}` can drop a whole model reply
 * into it. Ported from `MAX_SAVE_NAME_CHARS`. */
export const MAX_SAVE_NAME_CHARS = 120;

/** `char::is_control()`: Unicode category Cc — the C0 controls (0x00-0x1F),
 * DEL (0x7F), and the C1 controls (0x80-0x9F). Checked per CODE POINT (not
 * UTF-16 code unit), matching Rust's `chars()` iterating scalar values. */
function isControlCodePoint(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
}

/**
 * Rust's `str::split_whitespace()`: split on runs of Unicode whitespace,
 * yielding no empty tokens.
 *
 * `\p{White_Space}`, deliberately, NOT JS's `\s`: the two genuinely disagree
 * in BOTH directions — `\s` omits U+0085 NEL (which `char::is_whitespace()`
 * accepts) and includes U+FEFF BOM (which it does not). `db-host/files.ts`
 * carries the same reasoning for its own copy of this splitter.
 */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

function saveNameCharacter(ch: string): string {
  const codePoint = ch.codePointAt(0) ?? 0;
  return isControlCodePoint(codePoint) || ch === "/" || ch === "\\" ? " " : ch;
}

function flattenedSaveName(raw: string): string {
  let flat = "";
  for (const ch of raw) {
    flat += saveNameCharacter(ch);
  }
  return splitWhitespace(flat).join(" ");
}

function limitedSaveName(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= MAX_SAVE_NAME_CHARS) {
    return name;
  }
  // `.trim_end()` stand-in — see `workflowModel.ts`'s own documented,
  // accepted `.trim()` deviation (JS also trims U+FEFF, Rust also trims
  // U+0085); the same standing gap applies to `trimEnd()`.
  return chars.slice(0, MAX_SAVE_NAME_CHARS).join("").trimEnd();
}

function defaultSaveName(name: string): string {
  return name === "" ? "Workflow output" : name;
}

/**
 * Flatten and bound a save_file name: one line, no path separators, and short
 * enough to be a file name rather than a pasted paragraph. Ported from
 * `clean_save_name`.
 */
export function cleanSaveName(raw: string): string {
  // `.chars().count()` / `.chars().take(N)` — Unicode SCALAR VALUES, so an
  // astral-plane run (emoji, some CJK extension blocks) counts as it would in
  // Rust rather than as two UTF-16 units each.
  return defaultSaveName(limitedSaveName(flattenedSaveName(raw)));
}

/** `to_ascii_lowercase()`: rewrites ONLY the ASCII letters A-Z, one unit in,
 * one unit out — unlike `.toLowerCase()`, which can change a string's LENGTH
 * for some non-ASCII input ('İ' U+0130 grows a unit under full Unicode case
 * folding; 'ẞ' U+1E9E shrinks one). The splice point below is an offset into
 * this folded copy, so the copy must be exactly as long as the original or the
 * offset lands mid-tag in a page whose accumulated content carries either. */
function toAsciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Append `body` INSIDE an existing HTML document rather than gluing a whole
 * second page onto the end of the first — which left stranded footers mid-page
 * and the formatting restarting after a few runs. Ported from
 * `append_into_html`.
 */
export function appendIntoHtml(old: string, name: string, body: string): string {
  const fragment = `\n<hr/>\n${body.trim()}\n`;
  const folded = toAsciiLowercase(old);
  // Splice before the LAST closing marker the generated document ends with.
  for (const marker of ["</main>", "</body>"]) {
    const at = folded.lastIndexOf(marker);
    if (at !== -1) {
      return old.slice(0, at) + fragment + old.slice(at);
    }
  }
  // Not a document we recognise (an empty or hand-written file) — build one.
  return htmlDocument(name, `${old.trim()}\n${fragment}`);
}
