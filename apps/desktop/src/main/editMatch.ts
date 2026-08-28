/**
 * Ported from `src-tauri/src/commands/edit_match.rs` (2,422 lines) — the
 * reliable, byte-safe file-edit engine behind `exec_tool`'s `edit_file`,
 * `edit_files`, `write_file` and `set_cells` arms.
 *
 * Idea 4 — `edit_file`'s matcher tolerates the typographic drift a model
 * introduces (curly quotes, NBSP/CRLF, dash and ligature variants) via the ONE
 * fold table in `editMatchExtraction.ts`, but only ever rewrites the exact
 * span of a UNIQUELY identified passage: a multi-match FAILS with a count and
 * a `closest_snippet` hint instead of silently editing everything.
 *
 * Idea 7 — `edit_files` batches several edits (and renames) and applies them
 * in ONE transaction (validate-all-then-write, like `set_cells`): either the
 * whole refactor lands or none of it does, with every snapshot sharing an
 * `AI edit (batch …)` cause tag for group visibility/undo.
 *
 * FILE SPLIT (the Rust source's own section structure, plus the out-of-module
 * dependencies it calls into):
 *  - `editMatchFuzzy.ts` — the fuzzy matcher itself (`normalize_with_spans`,
 *    `normalize_needle`, the ligature-split guard, the paragraph sentinel,
 *    `fuzzy_find`). The algorithmic core, kept apart so it can be reviewed
 *    and tested in isolation.
 *  - `editMatchExtraction.ts` — the `extraction.rs` subset: the shared fold
 *    table, the extension registry, `decode_text_bytes`, `strip_tags`,
 *    `decode_basic_entities`, `normalize_whitespace`.
 *  - `editMatchHtml.ts` — `extraction/html_edit.rs` + `extraction/html.rs`
 *    (`html_replace_text`, `find_section_range`, `strip_html`) and
 *    `docs_html::html_escape`.
 *  - `editMatchDocx.ts` + `editMatchZip.ts` — `extraction/docx.rs`, over a
 *    hand-rolled ZIP reader/writer (this project has no `zip` dependency).
 *  - `editMatchCells.ts` — `spreadsheet::set_cell_in_bytes` (CSV/TSV; see
 *    that file for the one `.xlsx` gap).
 *  - THIS FILE — everything else: the write-plan types, the diff-preview
 *    clipping machinery, `compute_edit_bytes`'s file-type dispatch, the
 *    single-edit/batch planners, `commit_plans`, batch-op parsing, and the
 *    `runEditFile`/`runEditFileRefined`/`runEditFiles` reference entry points
 *    the Rust source's own tests drive (Rust gates those `#[cfg(test)]`;
 *    TypeScript has no equivalent, so they are ordinary exports used only by
 *    this module's test file — production goes through `plan*` + the
 *    diff-preview gate + `commitPlans`, which is the same code path).
 *
 * ERROR CONVENTION. Rust's `Result<T, EditError>` becomes a THROWN
 * {@link EditError} here, matching this port's established db-host convention
 * (`db-host/util.ts`'s own module doc). The helpers this module calls that
 * return `Result<_, String>` in Rust for a genuinely expected outcome
 * (`html_replace_text`, `docx_replace_text`, `set_cell_in_bytes`,
 * `find_section_range`) keep a discriminated-union return instead of throwing,
 * so a "not found" branch here can never accidentally swallow an unrelated
 * failure the way a blanket `catch` would.
 *
 * NOT PORTED: `edit_gate.rs` (the diff-preview APPROVAL gate, "Idea 6") and
 * `agent.rs`'s `gated_write`/`dry_run_summary`/`write_file_summary`
 * presentation helpers. Those wrap `plan*`'s output with a user-facing
 * approval step and format the model-facing success string; nothing in
 * `edit_match.rs` itself depends on them.
 *
 * POSITION UNITS: see `editMatchFuzzy.ts`'s module doc. Every offset in this
 * module is a JS-string (UTF-16 code-unit) position, consistently produced
 * and consumed, which is behaviour-identical to Rust's byte offsets. The one
 * place a BYTE count is genuinely meant — {@link MAX_FUZZY_BYTES}, a memory
 * ceiling on `normalize_with_spans`'s allocation — is measured in real UTF-8
 * bytes, exactly as `content.len()` does in Rust.
 */

import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { findFileLike, getFileBytes, inTransaction, renameFile, updateFileContent } from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { closestSnippet } from "./fileTools.js";
import { clampBytes } from "./textClamp.js";
import {
  decodeTextBytes,
  extensionOf,
  isTextExtension,
  normalizeWhitespace,
} from "./editMatchExtraction.js";
import { fuzzyFind, normalizeNeedle } from "./editMatchFuzzy.js";
import { docxReplaceText, extractDocx } from "./editMatchDocx.js";
import { findSectionRangeHtml, htmlEscape, htmlReplaceText, stripHtml } from "./editMatchHtml.js";
import { setCellInBytes } from "./editMatchCells.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

// ---------------------------------------------------------------- result plumbing

/**
 * An edit failure carrying both the model-facing message and a content-free
 * `outcome` tag for the `messages.effects` telemetry (never `old_text`/
 * `new_text`). Ported from `edit_match::EditError`.
 */
export class EditError extends Error {
  readonly outcome: string;

  constructor(message: string, outcome: string) {
    super(message);
    this.name = "EditError";
    this.outcome = outcome;
    Object.setPrototypeOf(this, EditError.prototype);
  }

  /** Wrap a batch validation message (already prefixed "Edit N of M …") as a
   * content-free failure outcome for the telemetry. Ported from
   * `EditError::batch_failure`. */
  static batchFailure(message: string): EditError {
    return new EditError(message, "failed");
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How a successful edit found its span — surfaced in the success string
 * (`fuzzy` tells the model its quote was typographically off) and in the
 * content-free outcome telemetry. Rust keeps an `EditMethod` enum plus an
 * `.outcome()` mapping onto these five strings; the two collapse into one
 * type here with no loss of information. Ported from
 * `edit_match::EditMethod`. */
export type EditMethod = "exact" | "exact_all" | "fuzzy" | "docx" | "html";

/** Ported verbatim from `commands/files.rs`'s `non_utf8_error`. */
function nonUtf8Error(name: string): string {
  return (
    `"${name}" is not saved as UTF-8 text, so editing it here would replace its ` +
    "accented characters with □. Re-save it as UTF-8 first, or save a corrected " +
    "copy as a new file."
  );
}

/** Strict UTF-8 decode, `null` on invalid bytes — the JS analogue of Rust's
 * `std::str::from_utf8(bytes).ok()`. NEVER the lossy decode, which would turn
 * every unreadable byte into U+FFFD and write those replacement characters
 * back over a legacy-encoded file's accented letters. */
function strictUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- extract_text

/**
 * Extract readable text from a file's bytes, best-effort — the dispatcher
 * `render_for_preview` and `store_file_bytes`/`commit_plans` call. Ported
 * (narrowed) from `extraction::extract_text`.
 *
 * NOTE THE SPLIT, which the Rust source has and which is easy to lose: the
 * plain-text branch returns EARLY with the file's own decoded text, verbatim.
 * Only the BINARY/markup readers below it run their output through
 * `normalize_whitespace` and the "empty means no text" filter. Collapsing a
 * `.md` file's indentation and blank lines into the search index — which is
 * what applying the normalizer to every branch does — silently rewrites what
 * the model later reads back as the file's content.
 *
 * NARROWED from the Rust source, which also reads pdf/xlsx/pptx/legacy-Office/
 * epub/rtf/iWork/ipynb/eml/subtitle/svg/sketch, and which sniffs an
 * EXTENSION-LESS file's bytes. Each of those needs its own extractor module
 * that is out of scope for an `edit_match.rs` port, and none is reachable
 * from this module's own paths: every branch of `computeEditBytes` /
 * `planWriteFile` / `planSetCells` refuses a file whose extension isn't
 * text/html/docx/csv/tsv long before any plan reaches `commitPlans`.
 */
export function extractText(name: string, bytes: Uint8Array): string | null {
  const ext = extensionOf(name);
  if (isTextExtension(ext)) {
    return decodeTextBytes(bytes);
  }
  let raw: string | null;
  if (ext === "docx") {
    raw = extractDocx(bytes);
  } else if (ext === "html" || ext === "htm") {
    // The Rust source scores a Readability article first and falls back to
    // `strip_html` only for a page with no scorable article; that scorer
    // (`extraction/article.rs`) is a separate module this port does not have,
    // so every page takes the fallback path. This affects only the text an
    // HTML file is INDEXED/PREVIEWED with — never the edit algorithm, whose
    // HTML branch reads the raw markup directly.
    raw = stripHtml(decodeTextBytes(bytes));
  } else {
    raw = null;
  }
  if (raw === null) {
    return null;
  }
  const normalized = normalizeWhitespace(raw);
  return normalized.trim() === "" ? null : normalized;
}

// ---------------------------------------------------------- write plans (Ideas 6/7)

/**
 * One computed-but-not-yet-written change to a file, produced under the room
 * lock and either applied immediately (gate off) or after diff-preview
 * approval. `newBytes: null` is a rename-only op (no byte change, no
 * snapshot). Ported from `edit_match::PlannedWrite`.
 */
export interface PlannedWrite {
  readonly fileId: string;
  readonly realName: string;
  readonly newBytes: Buffer | null;
  readonly renameTo: string | null;
  readonly method: EditMethod | null;
  readonly count: number;
  /** SHA-256 of the bytes this plan was computed against, re-checked before a
   * gated apply so a file that changed under a pending approval card is never
   * overwritten with stale bytes. `null` for a rename-only plan, matching
   * Rust's `Option<[u8; 32]>`. */
  readonly staleness: Buffer | null;
  readonly before: string;
  readonly after: string;
  readonly clipped: boolean;
}

/**
 * Extra disambiguation `edit_file` can supply beyond the bare quote: text that
 * must sit immediately before/after the match, which occurrence (1-based)
 * among several identical matches to pick, or which heading's section to scope
 * the match to. `edit_files` (the batch) has none of these fields.
 *
 * `prefixContext`/`suffixContext`/`occurrence` are scoped to files whose
 * branch of `computeEditBytes` can enumerate EVERY candidate span up front —
 * today that is the exact-match text-file path. docx and HTML replace-and-count
 * in one pass without exposing per-candidate positions to filter, so those
 * three get an honest "not available for this file type" there rather than
 * being silently ignored. `section` is a narrower text-selection concern and is
 * handled per file type (HTML and Markdown), independent of that restriction.
 *
 * Ported from `edit_match::EditRefinements`; `undefined` is this port's `None`.
 */
export interface EditRefinements {
  readonly prefixContext?: string;
  readonly suffixContext?: string;
  readonly occurrence?: number;
  readonly section?: string;
}

const NO_REFINEMENTS: EditRefinements = {};

function refinementsEmpty(r: EditRefinements): boolean {
  return (
    r.prefixContext === undefined && r.suffixContext === undefined && r.occurrence === undefined && r.section === undefined
  );
}

/** The subset of refinements docx/HTML must refuse outright — `section` is
 * excluded because it IS supported there, just via a different mechanism.
 * Ported from `EditRefinements::has_positional_refinement`. */
function hasPositionalRefinement(r: EditRefinements): boolean {
  return r.prefixContext !== undefined || r.suffixContext !== undefined || r.occurrence !== undefined;
}

/** A single edit as the diff-preview gate receives it (`edit_file` → one of
 * these). Ported from `edit_match::PreviewEdit`. */
export interface PreviewEdit {
  readonly name: string;
  readonly oldText: string;
  readonly newText: string;
  readonly all: boolean;
  readonly prefixContext?: string;
  readonly suffixContext?: string;
  readonly occurrence?: number;
  readonly section?: string;
}

/**
 * Preview text stays bounded so a huge file's diff can't blow the IPC
 * payload. Ported from `edit_match::PREVIEW_CLIP`. Measured in JS string
 * positions here rather than Rust's UTF-8 bytes: the panes are SLICED with
 * this number, and a byte offset cannot slice a JS string. Both sides of every
 * comparison use the same unit, so the clipping behaviour is identical for
 * ASCII and merely more generous for multi-byte text.
 */
export const PREVIEW_CLIP = 200_000;

/**
 * Largest file the forgiving (fuzzy) fallback will scan.
 * `normalizeWithSpans` builds one array entry AND one span per character —
 * roughly 20–40× the file's size in memory — and in the Rust source it all
 * happens while the room lock is held, so the whole app is frozen for the
 * duration. Above this the exact match stands on its own. Ported from
 * `edit_match::MAX_FUZZY_BYTES`, and compared against a real UTF-8 byte count
 * because that is what the constant names and what Rust's `content.len()` is.
 */
export const MAX_FUZZY_BYTES = 4 * 1024 * 1024;

/** Ported from `edit_match::hash_bytes`. */
export function hashBytes(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/**
 * Human-readable rendering of a file's bytes for the diff card — extracted
 * text for binary office formats, the file's own text encoding for everything
 * else. A lossy UTF-8 read turned every windows-1252/1255 byte into U+FFFD, so
 * the card described a legacy-encoded file as boxes; `decodeTextBytes` is what
 * the viewer and the search index already read it with. Ported from
 * `edit_match::render_for_preview`.
 */
function renderForPreview(realName: string, bytes: Uint8Array): string {
  const ext = extensionOf(realName);
  if (ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "pdf" || ext === "pptx") {
    return extractText(realName, bytes) ?? "";
  }
  return decodeTextBytes(bytes);
}

/** First position where two renderings differ, or the shorter length when one
 * is a prefix of the other. Ported from `edit_match::first_difference`. */
function firstDifference(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return len;
}

/** The largest position `<= max` that does not split a UTF-16 surrogate pair —
 * this port's analogue of Rust's (byte-oriented) `floor_boundary`. */
function floorToCharBoundary(s: string, max: number): number {
  if (max >= s.length) {
    return s.length;
  }
  if (max <= 0) {
    return 0;
  }
  const code = s.charCodeAt(max);
  if (code >= 0xdc00 && code <= 0xdfff) {
    const prev = s.charCodeAt(max - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      return max - 1;
    }
  }
  return max;
}

/** One pane clipped to {@link PREVIEW_CLIP} from `start`. A window that
 * doesn't begin at position 0 is MARKED, because `dry_run_summary` quotes this
 * same string as what the file "would start" with. Ported from
 * `edit_match::preview_window`. */
function previewWindow(s: string, start: number): string {
  const end = floorToCharBoundary(s, start + PREVIEW_CLIP);
  if (start === 0) {
    return s.slice(0, end);
  }
  return `…${s.slice(start, end)}`;
}

/**
 * Both panes clipped to the SAME window, positioned so the first place they
 * differ falls inside it. Clipping from 0 drew two identical heads for any
 * change past `PREVIEW_CLIP`: the card showed no diff at all and still asked
 * for approval, so a change in a 1 MB file's last chapter was approved unseen.
 * Ported from `edit_match::clip_to_change`.
 */
function clipToChange(before: string, after: string): { before: string; after: string; clipped: boolean } {
  if (before.length <= PREVIEW_CLIP && after.length <= PREVIEW_CLIP) {
    return { before, after, clipped: false };
  }
  const diffAt = firstDifference(before, after);
  // Renderings that really are identical (an office file whose extracted text
  // is unchanged) have no changed region to centre on — keep the head.
  // Otherwise leave a quarter of the budget of unchanged lead-in for context.
  const start =
    diffAt === before.length && diffAt === after.length
      ? 0
      : floorToCharBoundary(before, Math.max(0, diffAt - Math.floor(PREVIEW_CLIP / 4)));
  return { before: previewWindow(before, start), after: previewWindow(after, start), clipped: true };
}

/** Ported from `edit_match::preview_pair`. */
function previewPair(
  realName: string,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array
): { before: string; after: string; clipped: boolean } {
  return clipToChange(renderForPreview(realName, beforeBytes), renderForPreview(realName, afterBytes));
}

/**
 * The single write path for changing an existing file's bytes: snapshot the
 * current state into version history, then overwrite and rebuild the search
 * index — one transaction, so a snapshot can never be forgotten on one call
 * site but not another. Ported from `commands/files.rs`'s `store_file_bytes`.
 */
export function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Uint8Array,
  text: string | null,
  cause: string
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/**
 * Commit already-computed plans in ONE transaction: any error rolls all of
 * them back. `inTransaction` already skips a nested `BEGIN` when the caller
 * opened one, which is what lets `storeFileBytes` call it again per plan —
 * mirroring Rust's `db::in_transaction` doing the same inside
 * `commit_plans`'s own `BEGIN IMMEDIATE`. Ported from
 * `edit_match::commit_plans`.
 */
export function commitPlans(db: Database.Database, plans: readonly PlannedWrite[], cause: string): void {
  inTransaction(db, () => {
    for (const p of plans) {
      if (p.newBytes !== null) {
        // Derive the searchable text with the name whose FORMAT the bytes are
        // in — the CURRENT one — exactly as the preview does. Reading them
        // through the NEW name meant a batch that edited a .docx and renamed
        // it to .md stored the zip decoded as text, so search and every
        // retrieved context carried binary mojibake.
        const text = extractText(p.realName, p.newBytes) ?? strictUtf8OrNull(p.newBytes);
        storeFileBytes(db, p.fileId, p.newBytes, text, cause);
      }
      if (p.renameTo !== null) {
        renameFile(db, p.fileId, p.renameTo);
      }
    }
  });
}

// ---------------------------------------------------------------- error messages

/**
 * The ambiguity error, worded for the tool that will read it. `allOffered` is
 * whether the CALLING TOOL actually has an `all` field: `edit_file` does;
 * `edit_files` does not, and advising it there sent the model round a retry
 * that came back with the identical error before it fell back to the advice
 * that works. Ported from `edit_match::multi_occurrence_error`.
 */
function multiOccurrenceError(oldText: string, n: number, realName: string, allOffered: boolean): string {
  const quote = clampBytes(oldText, 80);
  if (allOffered) {
    return (
      `"${quote}" appears ${n} times in "${realName}". Include more surrounding text to ` +
      `pick one, or pass all: true to replace every occurrence.`
    );
  }
  return (
    `"${quote}" appears ${n} times in "${realName}". Include more surrounding text in ` +
    `old_text so it identifies exactly one place — edit_files has no all option; use ` +
    `edit_file for a replace-every-occurrence change.`
  );
}

/** `section` named a heading that doesn't exist. Lists every real heading
 * found — never falls back to searching the whole document, which would defeat
 * the point of scoping the edit. Ported from
 * `edit_match::section_not_found_error`. */
function sectionNotFoundError(section: string, realName: string, headings: readonly string[]): string {
  if (headings.length === 0) {
    return `"${realName}" has no headings to scope a section to.`;
  }
  return (
    `No section called "${section}" in "${realName}". The headings there are: ` +
    `${headings.map((h) => `"${h}"`).join(", ")}.`
  );
}

/** The file is past {@link MAX_FUZZY_BYTES}, so only an exact quote is
 * offered. Ported from `edit_match::too_large_for_fuzzy_error`. */
function tooLargeForFuzzyError(realName: string): string {
  return (
    `Could not find that exact text in "${realName}". This file is too ` +
    `large for the forgiving match, so the quote has to be exact — copy ` +
    `it from the file, including spacing and punctuation.`
  );
}

/** `all: true` reached the forgiving matcher, which cannot promise "every
 * occurrence" of a quote it only matched approximately. Ported from
 * `edit_match::all_needs_exact_error`. */
function allNeedsExactError(oldText: string, realName: string): string {
  return (
    `"${clampBytes(oldText, 80)}" doesn't appear in "${realName}" byte-for-byte, so all: true ` +
    `can't be honored safely — it only matched approximately. Copy the text ` +
    `exactly as it appears (including spacing and punctuation), or drop ` +
    `all: true to change just the one closest match.`
  );
}

/**
 * The "nothing matched" message for a refined edit, naming ONLY the
 * refinements the caller actually passed. It used to name all three
 * unconditionally, so a `section`-scoped edit was told to drop
 * prefix_context/suffix_context/occurrence it had never sent — advice that
 * changes nothing on the retry. Ported from
 * `edit_match::refinement_not_found_error`.
 */
function refinementNotFoundError(realName: string, refine: EditRefinements): string {
  const sectionNote = refine.section !== undefined ? ` in the "${refine.section}" section` : "";
  const named: string[] = [];
  if (refine.prefixContext !== undefined) {
    named.push("prefix_context");
  }
  if (refine.suffixContext !== undefined) {
    named.push("suffix_context");
  }
  if (refine.occurrence !== undefined) {
    named.push("occurrence");
  }
  const verb = named.length === 1 ? "needs" : "need";
  const them = named.length === 1 ? "it" : "them";
  return (
    `Could not find that exact text in "${realName}"${sectionNote}. ${named.join(" and ")} ${verb} old_text to ` +
    `match EXACTLY — copy it exactly, including spacing and punctuation, or drop ${them} and ` +
    `let the forgiving match try.`
  );
}

// ---------------------------------------------------------- literal string helpers

/**
 * `String::replace` in Rust replaces EVERY non-overlapping occurrence and
 * treats both arguments as literal text. JS's `String.prototype.replace` with
 * a string pattern replaces only the FIRST — and, far worse, interprets `$&`,
 * `` $` ``, `$'`, `$1` and `$$` inside the REPLACEMENT. A `new_text` of
 * `"$&"` therefore silently expanded to the matched text instead of being
 * written literally, corrupting the file for any replacement that happened to
 * contain a dollar sign followed by one of those characters. `split`/`join` is
 * the literal-safe idiom for both halves at once.
 */
function replaceAllLiteral(content: string, oldText: string, newText: string): string {
  return content.split(oldText).join(newText);
}

/** `content.matches(needle).count()` — non-overlapping literal occurrences.
 * An empty needle counts as zero here (Rust would report one match per
 * character boundary); every caller guards `old_text` non-empty first, and
 * zero is the answer that routes an empty quote to the honest "not found"
 * message rather than a nonsensical ambiguity count. */
function countLiteralOccurrences(content: string, needle: string): number {
  return needle === "" ? 0 : content.split(needle).length - 1;
}

/** `content.match_indices(needle)` — every non-overlapping literal
 * occurrence's `[start, endExclusive)`. */
function matchIndicesLiteral(content: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (needle === "") {
    return out;
  }
  let idx = 0;
  for (;;) {
    const found = content.indexOf(needle, idx);
    if (found === -1) {
      return out;
    }
    out.push([found, found + needle.length]);
    idx = found + needle.length;
  }
}

/** Real UTF-8 byte length — what Rust's `str::len()` reports, and the unit
 * {@link MAX_FUZZY_BYTES} is expressed in. */
function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// ------------------------------------------------------------- markdown sections

/** One ATX (`#`-prefixed) Markdown heading: `#`-count = level (1-6), a space
 * required after the hashes (CommonMark's rule — keeps a code comment like
 * `#!/usr/bin/env` from being misread as a heading). Ported from
 * `edit_match::MarkdownHeading`. */
interface MarkdownHeading {
  readonly level: number;
  readonly text: string;
  /** Where this heading's own line starts — where the PRECEDING section
   * ends. */
  readonly lineStart: number;
  /** Right after this heading's line — where the section it introduces
   * begins. */
  readonly sectionStart: number;
}

/** `content.split_inclusive('\n')` — each piece keeps its own trailing `\n`;
 * the last piece has none if the string doesn't end with one, and there is no
 * empty final piece for a string that does. */
function splitInclusiveByNewline(content: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const idx = content.indexOf("\n", start);
    if (idx === -1) {
      if (start < content.length) {
        lines.push(content.slice(start));
      }
      return lines;
    }
    lines.push(content.slice(start, idx + 1));
    start = idx + 1;
  }
}

type SectionRangeResult =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly headings: string[] };

/**
 * The Markdown counterpart to `html_edit::find_section_range`. Same
 * same-or-higher-level rule (a sub-heading doesn't end its parent's section).
 * Does NOT skip fenced code blocks — a `#` comment inside a fence could be
 * misread as a heading; a narrow but real limitation carried over from the
 * Rust source rather than silently "fixed" in the port. Ported from
 * `edit_match::find_markdown_section_range`.
 */
function findMarkdownSectionRange(content: string, section: string): SectionRangeResult {
  const headings: MarkdownHeading[] = [];
  let pos = 0;
  for (const line of splitInclusiveByNewline(content)) {
    const trimmed = line.replace(/[\r\n]+$/, "");
    let hashes = 0;
    while (hashes < trimmed.length && trimmed[hashes] === "#") {
      hashes += 1;
    }
    const after = trimmed[hashes];
    if (hashes >= 1 && hashes <= 6 && (after === " " || after === "\t")) {
      headings.push({
        level: hashes,
        text: trimmed.slice(hashes).trim(),
        lineStart: pos,
        sectionStart: pos + line.length,
      });
    }
    pos += line.length;
  }
  const needle = normalizeNeedle(section).join("");
  const idx = headings.findIndex((h) => normalizeNeedle(h.text).join("") === needle);
  if (idx === -1) {
    return { ok: false, headings: headings.map((h) => h.text) };
  }
  const level = headings[idx]!.level;
  const next = headings.slice(idx + 1).find((h) => h.level <= level);
  return { ok: true, start: headings[idx]!.sectionStart, end: next !== undefined ? next.lineStart : content.length };
}

// ------------------------------------------------------------ refined resolution

/** What every `computeEditBytes` branch produces. */
export interface ComputedEdit {
  readonly bytes: Buffer;
  readonly count: number;
  readonly method: EditMethod;
}

/**
 * The plain text path's fuzzy fallback, scoped to one Markdown section.
 * `section` narrows WHERE to look; it is not a claim that the quote is
 * byte-perfect, so a quote the forgiving matcher would have found in the whole
 * file must still be found inside the section — otherwise scoping an edit to a
 * heading silently turned the tolerant matcher off. `fuzzyFind` reports
 * positions relative to the section, so the hit is offset by the section's
 * start before splicing. Ported from `edit_match::fuzzy_in_section`.
 */
function fuzzyInSection(
  realName: string,
  content: string,
  range: { start: number; end: number },
  oldText: string,
  newText: string,
  all: boolean | undefined,
  section: string
): ComputedEdit {
  if (utf8Length(content) > MAX_FUZZY_BYTES) {
    throw new EditError(tooLargeForFuzzyError(realName), "not_found");
  }
  if (all === true) {
    throw new EditError(allNeedsExactError(oldText, realName), "all_needs_exact");
  }
  const scope = content.slice(range.start, range.end);
  const found = fuzzyFind(scope, oldText);
  if (found.kind === "unique") {
    const out = content.slice(0, range.start + found.start) + newText + content.slice(range.start + found.end);
    return { bytes: Buffer.from(out, "utf8"), count: 1, method: "fuzzy" };
  }
  if (found.kind === "ambiguous") {
    throw new EditError(
      `That text appears in ${found.count} places in the "${section}" section of "${realName}" ` +
        `with slightly different spacing or punctuation. Include more surrounding text ` +
        `so it matches exactly one place.`,
      "ambiguous"
    );
  }
  const hint = closestSnippet(scope, oldText);
  const hintNote = hint !== null ? ` The closest text there is: "${clampBytes(hint, 200)}".` : "";
  throw new EditError(
    `Could not find that text in the "${section}" section of "${realName}". ` +
      `Copy it from that section, or drop section to search the whole file.${hintNote}`,
    "not_found"
  );
}

/**
 * Resolve `old_text` against `content` using `prefixContext`/`suffixContext`/
 * `occurrence` instead of the ambiguity-or-unique guard the plain path uses. A
 * POSITIONAL refinement requires an EXACT (non-fuzzy) quote — it is meant to
 * narrow candidates the model already found via search_room/open_file, not to
 * also absorb typographic drift, and combining both would make a
 * wrong-candidate pick unfalsifiable. `section` carries no such claim: on its
 * own it only says WHERE to look, so a miss there falls through to
 * {@link fuzzyInSection}. Enumerates every candidate span up front, which is
 * why this needs its own function rather than reusing `fuzzyFind`'s
 * unique/ambiguous/not-found shape. Ported from
 * `edit_match::resolve_with_refinements`.
 */
function resolveWithRefinements(
  realName: string,
  content: string,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  // The top-level guard in `computeEditBytes` already restricted `section` to
  // html/htm/md/markdown, and the HTML branch never reaches this function — so
  // a non-empty section here always means Markdown. Candidates are FILTERED to
  // the section's range rather than slicing `content`: every downstream
  // position (context checks, the final splice) then stays relative to the
  // FULL original text, with nothing to re-index.
  let sectionRange: { start: number; end: number } | null = null;
  if (refine.section !== undefined) {
    const found = findMarkdownSectionRange(content, refine.section);
    if (!found.ok) {
      throw new EditError(sectionNotFoundError(refine.section, realName, found.headings), "not_found");
    }
    sectionRange = { start: found.start, end: found.end };
  }
  const scoped = sectionRange;
  const candidates = matchIndicesLiteral(content, oldText).filter(
    ([s, e]) => scoped === null || (s >= scoped.start && e <= scoped.end)
  );
  if (candidates.length === 0) {
    // A positional refinement keeps the exact-quote rule (see above). A
    // `section` alone carries no such claim, so the forgiving matcher runs
    // inside it.
    if (scoped !== null && refine.section !== undefined && !hasPositionalRefinement(refine)) {
      return fuzzyInSection(realName, content, scoped, oldText, newText, all, refine.section);
    }
    throw new EditError(refinementNotFoundError(realName, refine), "not_found");
  }
  let filtered = candidates;
  if (refine.prefixContext !== undefined || refine.suffixContext !== undefined) {
    const pre = refine.prefixContext;
    const suf = refine.suffixContext;
    filtered = candidates.filter(
      ([s, e]) =>
        (pre === undefined || content.slice(0, s).endsWith(pre)) && (suf === undefined || content.slice(e).startsWith(suf))
    );
    if (filtered.length === 0) {
      throw new EditError(
        `old_text matches in "${realName}", but the surrounding text you gave ` +
          `doesn't appear next to it there. Copy prefix_context/suffix_context ` +
          `exactly as they appear too, or drop them.`,
        "not_found"
      );
    }
  }
  let chosen: [number, number];
  if (refine.occurrence !== undefined) {
    const n = refine.occurrence;
    // Rust's `occurrence` is an `Option<usize>`, so `n == 0 || n > len` is a
    // COMPLETE range check there — a negative or fractional value cannot exist.
    // A JS `number` can, and `filtered[-1]`/`filtered[0.5]` is `undefined`,
    // which destructured below threw a TypeError straight past every
    // `instanceof EditError` handler (`planBatch`'s rethrows it verbatim).
    // Anything that is not a whole number ≥ 1 is out of range, and says so in
    // the same words — for every value Rust CAN represent this is unchanged.
    if (!Number.isInteger(n) || n < 1 || n > filtered.length) {
      const withContext =
        refine.prefixContext !== undefined || refine.suffixContext !== undefined ? " with that surrounding text" : "";
      throw new EditError(
        `old_text matches ${filtered.length} place(s) in "${realName}"${withContext}; occurrence must be ` +
          `between 1 and ${filtered.length}.`,
        "not_found"
      );
    }
    chosen = filtered[n - 1]!;
  } else if (filtered.length === 1) {
    chosen = filtered[0]!;
  } else {
    const n = filtered.length;
    if (all === true) {
      // The error below offers `all: true`; honouring it here is what makes
      // that advice true for a refined edit. Spliced right-to-left so the
      // spans still to come keep their offsets in the string being rewritten.
      let out = content;
      for (let k = filtered.length - 1; k >= 0; k--) {
        const [s, e] = filtered[k]!;
        out = out.slice(0, s) + newText + out.slice(e);
      }
      return { bytes: Buffer.from(out, "utf8"), count: n, method: "exact_all" };
    }
    // Only reached via edit_file (edit_files never has a non-empty refine), so
    // allOffered=true is always the right wording.
    throw new EditError(
      multiOccurrenceError(oldText, n, realName, true).replace(
        "Include more surrounding text",
        "Add prefix_context/suffix_context, pass occurrence, or include more surrounding text"
      ),
      "ambiguous"
    );
  }
  const [s, e] = chosen;
  return { bytes: Buffer.from(content.slice(0, s) + newText + content.slice(e), "utf8"), count: 1, method: "exact" };
}

// ------------------------------------------------------------- compute_edit_bytes

/** The HTML branch of `computeEditBytes`, ported verbatim. */
function computeEditBytesHtml(
  realName: string,
  bytes: Uint8Array,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  const content = strictUtf8OrNull(bytes);
  if (content === null) {
    throw new EditError(nonUtf8Error(realName), "wrong_type");
  }
  const escapedNew = htmlEscape(newText);
  // Scope the search to one heading's section by slicing the document to its
  // range first — `htmlReplaceText` itself never learns about sections, it
  // just gets a smaller haystack.
  let sectionRange: { start: number; end: number } | null = null;
  if (refine.section !== undefined) {
    const found = findSectionRangeHtml(content, refine.section);
    if (!found.ok) {
      throw new EditError(sectionNotFoundError(refine.section, realName, found.headings), "not_found");
    }
    sectionRange = { start: found.start, end: found.end };
  }
  const scope = sectionRange !== null ? content.slice(sectionRange.start, sectionRange.end) : content;
  const sectionNote = refine.section !== undefined ? ` in the "${refine.section}" section` : "";
  const replaced = htmlReplaceText(scope, oldText, escapedNew);
  if (!replaced.ok) {
    const hint = closestSnippet(stripHtml(scope), oldText);
    const hintNote = hint !== null ? ` The closest text on the page is: "${clampBytes(hint, 200)}".` : "";
    throw new EditError(
      `Could not find that exact text in "${realName}"${sectionNote}. ` +
        `Copy it exactly, including spacing and punctuation.${hintNote}`,
      "not_found"
    );
  }
  if (replaced.count > 1 && all !== true) {
    throw new EditError(multiOccurrenceError(oldText, replaced.count, realName, all !== undefined), "ambiguous");
  }
  // Splice the (possibly narrower) rewritten scope back into the full
  // document at the same range.
  const newHtml =
    sectionRange !== null
      ? content.slice(0, sectionRange.start) + replaced.html + content.slice(sectionRange.end)
      : replaced.html;
  return { bytes: Buffer.from(newHtml, "utf8"), count: replaced.count, method: "html" };
}

/** The plain-text-extension branch of `computeEditBytes`, ported verbatim. */
function computeEditBytesText(
  realName: string,
  bytes: Uint8Array,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  // An edit rewrites the file's bytes. Reading non-UTF-8 bytes lossily turns
  // every unreadable byte into U+FFFD, so applying an edit to a
  // latin-1/windows-1252 file would silently replace all its accented letters
  // with boxes — for a one-word change.
  const content = strictUtf8OrNull(bytes);
  if (content === null) {
    throw new EditError(nonUtf8Error(realName), "wrong_type");
  }
  if (!refinementsEmpty(refine)) {
    return resolveWithRefinements(realName, content, oldText, newText, all, refine);
  }
  const exact = countLiteralOccurrences(content, oldText);
  if (exact === 1) {
    return { bytes: Buffer.from(replaceAllLiteral(content, oldText, newText), "utf8"), count: 1, method: "exact" };
  }
  if (exact > 1) {
    if (all === true) {
      return { bytes: Buffer.from(replaceAllLiteral(content, oldText, newText), "utf8"), count: exact, method: "exact_all" };
    }
    throw new EditError(multiOccurrenceError(oldText, exact, realName, all !== undefined), "ambiguous");
  }
  if (utf8Length(content) > MAX_FUZZY_BYTES) {
    // The forgiving matcher materializes the whole file as an array of
    // characters plus a span each — tens of times the file's size in memory.
    // Past this size the exact match is the only one offered.
    throw new EditError(tooLargeForFuzzyError(realName), "not_found");
  }
  if (all === true) {
    // Reached only when NO byte-exact match exists anywhere in the file.
    // `all: true` asks to replace every occurrence, but the fuzzy matcher
    // tolerates typographic drift the model can't see or verify, so "every
    // occurrence" is not a promise this path can honor safely. This used to
    // fall through to `fuzzyFind`, which silently replaced ONE match (when
    // unique) with no mention that `all` went unused.
    throw new EditError(allNeedsExactError(oldText, realName), "all_needs_exact");
  }
  const found = fuzzyFind(content, oldText);
  if (found.kind === "unique") {
    const out = content.slice(0, found.start) + newText + content.slice(found.end);
    return { bytes: Buffer.from(out, "utf8"), count: 1, method: "fuzzy" };
  }
  if (found.kind === "ambiguous") {
    // A fuzzy multi-match must NOT advise `all: true`: the fuzzy path doesn't
    // honor it, so that advice would loop a 4B model. A distinct message asks
    // for more context instead.
    throw new EditError(
      `That text appears in ${found.count} places in "${realName}" with slightly ` +
        `different spacing or punctuation. Include more surrounding text ` +
        `so it matches exactly one place.`,
      "ambiguous"
    );
  }
  const hint = closestSnippet(content, oldText);
  const hintNote = hint !== null ? ` The closest text in the file is: "${clampBytes(hint, 200)}".` : "";
  throw new EditError(
    `Could not find that exact text in "${realName}". Copy it ` + `exactly, including spacing and punctuation.${hintNote}`,
    "not_found"
  );
}

/**
 * Pure over bytes: compute the new bytes for one file's content, no writes.
 * The uniqueness guard fires for the text, docx AND HTML branches. Shared by
 * the single edit, the batch executor (over chained working bytes), and the
 * diff-preview gate.
 *
 * `all` is `undefined` when the calling tool has NO `all` field at all (the
 * batch `edit_files`), which is different from a caller that has one and left
 * it off — only the second can be told to pass it. Mirrors Rust's
 * `Option<bool>` exactly. Ported from `edit_match::compute_edit_bytes`.
 */
export function computeEditBytes(
  realName: string,
  bytes: Uint8Array,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  const ext = extensionOf(realName);
  // Context/occurrence need every candidate span enumerated up front — only
  // the exact-match text-file branch below does that today. docx and HTML
  // replace-and-count in one pass; refusing honestly here beats silently
  // ignoring a field the model was told would narrow the match. `section` is
  // excluded from this check — it's handled per file type below.
  if (hasPositionalRefinement(refine) && (ext === "docx" || ext === "html" || ext === "htm")) {
    throw new EditError(
      `prefix_context/suffix_context/occurrence aren't available for "${realName}" ` +
        `yet. Add more surrounding text to old_text instead, or pass all: true.`,
      "wrong_type"
    );
  }
  // Section scoping needs a heading structure to scope TO — built for HTML and
  // Markdown; every other type refuses honestly rather than silently searching
  // the whole file.
  if (refine.section !== undefined && !(ext === "html" || ext === "htm" || ext === "md" || ext === "markdown")) {
    throw new EditError(
      `section isn't available for "${realName}" yet — it works on .html and ` +
        `.md/.markdown files. Add more surrounding text to old_text instead.`,
      "wrong_type"
    );
  }
  if (ext === "docx") {
    // `docxReplaceText` is pure (patched bytes + count, no write) and replaces
    // EVERY occurrence, so apply the same replace-all guard the text branch
    // has: >1 without `all` is discarded, not silently applied.
    const replaced = docxReplaceText(bytes, oldText, newText);
    if (!replaced.ok) {
      throw new EditError(replaced.error, "not_found");
    }
    if (replaced.count > 1 && all !== true) {
      throw new EditError(multiOccurrenceError(oldText, replaced.count, realName, all !== undefined), "ambiguous");
    }
    return { bytes: replaced.bytes, count: replaced.count, method: "docx" };
  }
  if (ext === "xlsx" || ext === "xls") {
    throw new EditError("Spreadsheet cells are edited with set_cells (e.g. cell B7), not edit_file.", "wrong_type");
  }
  if (ext === "pdf") {
    throw new EditError(
      "PDF text cannot be edited in place. Use annotate_file to highlight, or " +
        "create_file to save a corrected copy of its text.",
      "wrong_type"
    );
  }
  // `.html` is the app's DEFAULT AI-document format, so this was the one
  // format `edit_file` refused outright. `htmlReplaceText` matches against the
  // page's DECODED text (tag interiors, scripts and styles are never part of a
  // run) tolerant of the same typographic drift the plain-text branch
  // tolerates, then splices back into the raw markup by range. A quote may
  // span inline markup (`<b>`, `<span>`, `<a>`, …) but never a block boundary.
  if (ext === "html" || ext === "htm") {
    return computeEditBytesHtml(realName, bytes, oldText, newText, all, refine);
  }
  if (isTextExtension(ext)) {
    return computeEditBytesText(realName, bytes, oldText, newText, all, refine);
  }
  throw new EditError(
    "This file type cannot be edited in place. Use create_file to save an edited copy of its text instead.",
    "wrong_type"
  );
}

/** Compute the proposed bytes for a named file WITHOUT writing — resolves the
 * file and loads its current bytes, then defers to {@link computeEditBytes}.
 * Ported from `edit_match::compute_edit`. */
export function computeEdit(
  db: Database.Database,
  name: string,
  oldText: string,
  newText: string,
  all: boolean,
  refine: EditRefinements
): { id: string; realName: string; newBytes: Buffer; count: number; method: EditMethod } {
  let id: string;
  let realName: string;
  try {
    [id, realName] = findFileLike(db, name);
  } catch (e) {
    throw new EditError(errMessage(e), "not_found");
  }
  let bytes: Buffer | null;
  try {
    bytes = getFileBytes(db, id);
  } catch (e) {
    throw new EditError(errMessage(e), "wrong_type");
  }
  if (bytes === null) {
    throw new EditError("File has no stored content.", "wrong_type");
  }
  const computed = computeEditBytes(realName, bytes, oldText, newText, all, refine);
  return { id, realName, newBytes: computed.bytes, count: computed.count, method: computed.method };
}

// ---------------------------------------------------------------------- planners

/** Load a file's current bytes, treating "no row"/"no bytes" as empty —
 * Rust's `.unwrap_or_default()` on the `Option<Vec<u8>>`. */
function loadOriginalOrEmpty(db: Database.Database, id: string): Buffer {
  try {
    return getFileBytes(db, id) ?? Buffer.alloc(0);
  } catch (e) {
    throw new EditError(errMessage(e), "error");
  }
}

/**
 * Plan a `write_file` whole-file rewrite. html/htm are accepted here — their
 * bytes are UTF-8 text and the write path re-derives the searchable text via
 * `strip_html`, so the AI can revise the app's default `.html` documents
 * (which `edit_file` couldn't reliably match before the HTML branch existed).
 * Ported from `edit_match::plan_write_file`.
 */
export function planWriteFile(db: Database.Database, name: string, content: string): PlannedWrite[] {
  let id: string;
  let realName: string;
  try {
    [id, realName] = findFileLike(db, name);
  } catch (e) {
    throw new EditError(errMessage(e), "not_found");
  }
  const ext = extensionOf(realName);
  const isHtml = ext === "html" || ext === "htm";
  if (!isTextExtension(ext) && !isHtml) {
    throw new EditError(
      `"${realName}" is not a plain-text file — write_file only rewrites text or ` +
        `HTML files. Use edit_file (docx), set_cells (spreadsheets), or create_file.`,
      "wrong_type"
    );
  }
  const original = loadOriginalOrEmpty(db, id);
  const newBytes = Buffer.from(content, "utf8");
  const { before, after, clipped } = previewPair(realName, original, newBytes);
  return [
    {
      fileId: id,
      realName,
      newBytes,
      renameTo: null,
      method: null,
      count: [...content].length,
      staleness: hashBytes(original),
      before,
      after,
      clipped,
    },
  ];
}

/**
 * Plan a `set_cells` change. The before/after preview is synthesized from
 * `extractText` of the current vs. proposed bytes — no new cell reader. Ported
 * from `edit_match::plan_set_cells`.
 */
export function planSetCells(
  db: Database.Database,
  name: string,
  sheet: string | null,
  updates: ReadonlyArray<readonly [string, string]>
): PlannedWrite[] {
  let id: string;
  let realName: string;
  try {
    [id, realName] = findFileLike(db, name);
  } catch (e) {
    throw new EditError(errMessage(e), "not_found");
  }
  let original: Buffer | null;
  try {
    original = getFileBytes(db, id);
  } catch (e) {
    throw new EditError(errMessage(e), "error");
  }
  if (original === null) {
    throw new EditError("File has no stored content.", "wrong_type");
  }
  let bytes: Buffer = original;
  for (const [cell, value] of updates) {
    const set = setCellInBytes(realName, bytes, sheet, cell, value);
    if (!set.ok) {
      throw new EditError(set.error, "error");
    }
    bytes = set.bytes;
  }
  const { before, after, clipped } = previewPair(realName, original, bytes);
  return [
    {
      fileId: id,
      realName,
      newBytes: bytes,
      renameTo: null,
      method: null,
      count: updates.length,
      staleness: hashBytes(original),
      before,
      after,
      clipped,
    },
  ];
}

/** Plan one `edit_file` — compute proposed bytes + preview + staleness, no
 * write. Ported from `edit_match::plan_single_edit`. */
export function planSingleEdit(db: Database.Database, edit: PreviewEdit): PlannedWrite[] {
  if (edit.oldText === "") {
    throw new EditError("old_text is required — copy the exact text to replace.", "not_found");
  }
  const refine: EditRefinements = {
    prefixContext: edit.prefixContext,
    suffixContext: edit.suffixContext,
    occurrence: edit.occurrence,
    section: edit.section,
  };
  const { id, realName, newBytes, count, method } = computeEdit(db, edit.name, edit.oldText, edit.newText, edit.all, refine);
  const original = loadOriginalOrEmpty(db, id);
  const { before, after, clipped } = previewPair(realName, original, newBytes);
  return [
    {
      fileId: id,
      realName,
      newBytes,
      renameTo: null,
      method,
      count,
      staleness: hashBytes(original),
      before,
      after,
      clipped,
    },
  ];
}

/** Workspace form of `planSingleEdit`: metadata/name resolution stays in the
 * encrypted DB, while current bytes are streamed from the normal file. */
export async function planSingleEditWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  edit: PreviewEdit,
): Promise<PlannedWrite[]> {
  if (edit.oldText === "") {
    throw new EditError("old_text is required — copy the exact text to replace.", "not_found");
  }
  let id: string;
  let realName: string;
  try { [id, realName] = findFileLike(db, edit.name); }
  catch (error) { throw new EditError(errMessage(error), "not_found"); }
  const original = await workspace.readBuffer(id);
  const computed = computeEditBytes(realName, original, edit.oldText, edit.newText, edit.all, {
    prefixContext: edit.prefixContext,
    suffixContext: edit.suffixContext,
    occurrence: edit.occurrence,
    section: edit.section,
  });
  const preview = previewPair(realName, original, computed.bytes);
  return [{
    fileId: id, realName, newBytes: computed.bytes, renameTo: null,
    method: computed.method, count: computed.count, staleness: hashBytes(original),
    ...preview,
  }];
}

export async function planWriteFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  name: string,
  content: string,
): Promise<PlannedWrite[]> {
  let id: string;
  let realName: string;
  try { [id, realName] = findFileLike(db, name); }
  catch (error) { throw new EditError(errMessage(error), "not_found"); }
  const ext = extensionOf(realName);
  if (!isTextExtension(ext) && ext !== "html" && ext !== "htm") {
    throw new EditError(
      `"${realName}" is not a plain-text file — write_file only rewrites text or HTML files. ` +
        "Use edit_file (docx), set_cells (spreadsheets), or create_file.",
      "wrong_type",
    );
  }
  const original = await workspace.readBuffer(id);
  const newBytes = Buffer.from(content, "utf8");
  return [{
    fileId: id, realName, newBytes, renameTo: null, method: null,
    count: [...content].length, staleness: hashBytes(original),
    ...previewPair(realName, original, newBytes),
  }];
}

export async function planSetCellsWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  name: string,
  sheet: string | null,
  updates: ReadonlyArray<readonly [string, string]>,
): Promise<PlannedWrite[]> {
  let id: string;
  let realName: string;
  try { [id, realName] = findFileLike(db, name); }
  catch (error) { throw new EditError(errMessage(error), "not_found"); }
  const original = await workspace.readBuffer(id);
  let bytes = original;
  for (const [cell, value] of updates) {
    const changed = setCellInBytes(realName, bytes, sheet, cell, value);
    if (!changed.ok) throw new EditError(changed.error, "error");
    bytes = changed.bytes;
  }
  return [{
    fileId: id, realName, newBytes: bytes, renameTo: null, method: null,
    count: updates.length, staleness: hashBytes(original),
    ...previewPair(realName, original, bytes),
  }];
}

// ------------------------------------------------------------------ batch (Idea 7)

/** Ported from `edit_match::MAX_BATCH_EDITS`. */
export const MAX_BATCH_EDITS = 20;

/** One operation in an atomic batch — a rename rides the same transaction as
 * the content edits, so "rename + update every reference" is a single atomic
 * unit. Ported from `edit_match::BatchOp` (a discriminated union rather than
 * Rust's `#[serde(tag = "op")]` enum: this port's parsing is
 * {@link parseBatchOps}, not `serde`). */
export type BatchOp =
  | { readonly op: "edit"; readonly name: string; readonly oldText: string; readonly newText: string }
  | { readonly op: "rename"; readonly name: string; readonly newName: string };

/** Ported from `edit_match::BatchApplied`. */
export interface BatchApplied {
  readonly batchId: string;
  readonly edits: number;
  readonly renames: number;
  /** (fileId, displayName) for each touched file, in first-touch order — the
   * tool arm emits `file-updated` per id so the per-answer Undo chip reverts
   * the whole batch. */
  readonly files: ReadonlyArray<readonly [string, string]>;
}

/** Keep the current extension when the model dropped it (parity with the
 * `rename_file` tool arm). Ported from `edit_match::keep_ext`. */
function keepExt(current: string, newName: string): string {
  if (extensionOf(newName) === "") {
    const ext = extensionOf(current);
    return ext === "" ? newName : `${newName}.${ext}`;
  }
  return newName;
}

interface FileWork {
  realName: string;
  /** The ORIGINAL DB bytes, loaded lazily the first time this file is edited
   * (a rename-only file never loads them, so we never overwrite it with an
   * empty buffer). Kept for the diff-preview `before` and the staleness
   * token. */
  original: Buffer | null;
  bytes: Buffer | null;
  dirty: boolean;
  newName: string | null;
}

/** Count how many ops are edits vs. renames (for the success string /
 * telemetry). Ported from `edit_match::count_batch_ops`. */
export function countBatchOps(ops: readonly BatchOp[]): { edits: number; renames: number } {
  let edits = 0;
  let renames = 0;
  for (const op of ops) {
    if (op.op === "edit") {
      edits += 1;
    } else {
      renames += 1;
    }
  }
  return { edits, renames };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse the tool's `edits` array into typed ops. The tagged form is what the
 * tool spec documents, but a 4B model may omit the tag, so the variant is
 * inferred from the fields present (a `new_name` with no edit fields ⇒
 * rename).
 *
 * A nameless entry is an ERROR, never a skip. It used to be skipped, so a
 * batch of three where one entry lost its `name` applied the other two and
 * reported "Applied 2 change(s)" — the model had no way to learn that a third
 * of its work silently evaporated, and the tool's own headline promise ("every
 * edit is checked first, then all are applied together") was already broken at
 * the parse step. Ported from `edit_match::parse_batch_ops`; throws a plain
 * `Error` where Rust returns `Result<_, String>`.
 */
export function parseBatchOps(args: Record<string, unknown>): BatchOp[] {
  const raw = args["edits"];
  if (!Array.isArray(raw)) {
    throw new Error("Pass edits: [{name, old_text, new_text}] (or {name, new_name} to rename) — one array.");
  }
  const n = raw.length;
  const ops: BatchOp[] = [];
  for (let i = 0; i < n; i++) {
    const e = asRecord(raw[i]);
    const name = asStr(e["name"]).trim();
    if (name === "") {
      throw new Error(
        `Edit ${i + 1} of ${n}: name is required — every entry needs the file ` +
          `to change, e.g. {"name": "notes.md", "old_text": "…", ` +
          `"new_text": "…"}. Nothing was changed.`
      );
    }
    const op = asStr(e["op"]);
    const hasNewName = asStr(e["new_name"]).trim() !== "";
    const isRename = op.toLowerCase() === "rename" || (op === "" && hasNewName);
    if (isRename) {
      ops.push({ op: "rename", name, newName: asStr(e["new_name"]) });
    } else {
      ops.push({ op: "edit", name, oldText: asStr(e["old_text"]), newText: asStr(e["new_text"]) });
    }
  }
  if (ops.length === 0) {
    throw new Error("No edits given — pass edits: [{name, old_text, new_text} | {name, new_name}].");
  }
  return ops;
}

/**
 * Phase A of the batch: validate every op against chained working state and
 * build one {@link PlannedWrite} per touched file — NO writes. A single
 * failure names WHICH op broke (keeping the ambiguity/closest-snippet hint) so
 * the model can fix just that one. Repeated edits to the same file compose over
 * working bytes, exactly like `set_cells` chains `setCellInBytes`. Ported from
 * `edit_match::plan_batch`; throws a plain `Error` where Rust returns
 * `Result<_, String>`.
 */
function planBatchWithLoader(
  db: Database.Database,
  ops: readonly BatchOp[],
  loadBytes: (id: string) => Buffer | null,
): PlannedWrite[] {
  const n = ops.length;
  if (n === 0) {
    throw new Error("No edits given — pass edits: [{name, old_text, new_text} | {name, new_name}].");
  }
  if (n > MAX_BATCH_EDITS) {
    throw new Error(
      `Too many operations in one batch (${n}). Split into batches of at most ` +
        `${MAX_BATCH_EDITS} so each stays reviewable and the transaction stays short.`
    );
  }

  const working = new Map<string, FileWork>();
  const order: string[] = [];

  for (let i = 0; i < n; i++) {
    const op = ops[i]!;
    const label = op.op === "edit" ? "Edit" : "Rename";
    if (op.op === "edit" && op.oldText === "") {
      throw new Error(`Edit ${i + 1} of ${n}: old_text is required.`);
    }
    if (op.op === "rename" && op.newName.trim() === "") {
      throw new Error(`Rename ${i + 1} of ${n}: new_name is required.`);
    }
    let id: string;
    let realName: string;
    try {
      [id, realName] = findFileLike(db, op.name);
    } catch (e) {
      throw new Error(`${label} ${i + 1} of ${n} (${op.name}): ${errMessage(e)}`);
    }
    if (!working.has(id)) {
      working.set(id, { realName, original: null, bytes: null, dirty: false, newName: null });
      order.push(id);
    }
    const entry = working.get(id)!;
    if (op.op === "rename") {
      entry.newName = keepExt(entry.realName, op.newName.trim());
      continue;
    }
    if (entry.bytes === null) {
      let loaded: Buffer | null;
      try {
        loaded = loadBytes(id);
      } catch (e) {
        throw new Error(`Edit ${i + 1} of ${n} (${entry.realName}): ${errMessage(e)}`);
      }
      if (loaded === null) {
        throw new Error(`Edit ${i + 1} of ${n} (${entry.realName}): file has no stored content.`);
      }
      entry.original = loaded;
      entry.bytes = loaded;
    }
    let computed: ComputedEdit;
    try {
      // `undefined`, not `false`: `edit_files` has no `all` field to pass, so
      // the error must not tell the model to pass one. Same reasoning for
      // refinements — `edit_files` has no context/occurrence fields either.
      computed = computeEditBytes(entry.realName, entry.bytes, op.oldText, op.newText, undefined, NO_REFINEMENTS);
    } catch (e) {
      if (!(e instanceof EditError)) {
        throw e;
      }
      throw new Error(`Edit ${i + 1} of ${n} (${entry.realName}): ${e.message}`);
    }
    entry.bytes = computed.bytes;
    entry.dirty = true;
  }

  // Build one plan per touched file, in first-touch order.
  const plans: PlannedWrite[] = [];
  for (const id of order) {
    const entry = working.get(id)!;
    if (entry.dirty) {
      const original = entry.original ?? Buffer.alloc(0);
      const newBytes = entry.bytes!;
      // Render the preview with the file's CURRENT name — the bytes on both
      // sides are in the current format, and the edit was computed against it.
      // Using the new name meant a batch that renamed notes.md → notes.docx
      // drew both panes through the docx reader, so the approval card came up
      // empty for a change that would then be saved perfectly correctly.
      const { before, after, clipped } = previewPair(entry.realName, original, newBytes);
      plans.push({
        fileId: id,
        realName: entry.realName,
        newBytes,
        renameTo: entry.newName,
        method: null,
        count: 1,
        staleness: hashBytes(original),
        before,
        after,
        clipped,
      });
    } else {
      // Rename-only: no byte change, no snapshot. The preview shows the name
      // change so the approval card still explains it.
      plans.push({
        fileId: id,
        realName: entry.realName,
        newBytes: null,
        renameTo: entry.newName,
        method: null,
        count: 0,
        staleness: null,
        before: `name: ${entry.realName}`,
        after: `name: ${entry.newName ?? ""}`,
        clipped: false,
      });
    }
  }
  return plans;
}

export function planBatch(db: Database.Database, ops: readonly BatchOp[]): PlannedWrite[] {
  return planBatchWithLoader(db, ops, (id) => getFileBytes(db, id));
}

export async function planBatchWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  ops: readonly BatchOp[],
): Promise<PlannedWrite[]> {
  const bytes = new Map<string, Buffer>();
  for (const op of ops) {
    if (op.op !== "edit") continue;
    let id: string;
    try { [id] = findFileLike(db, op.name); }
    catch (error) { throw new Error(errMessage(error)); }
    if (!bytes.has(id)) bytes.set(id, await workspace.readBuffer(id));
  }
  return planBatchWithLoader(db, ops, (id) => bytes.get(id) ?? null);
}

// ------------------------------------------------- reference entry points (tests)

/** Ported from `edit_match::EditApplied` (Rust: `#[cfg(test)]`). */
export interface EditApplied {
  readonly fileId: string;
  readonly realName: string;
  readonly count: number;
  readonly method: EditMethod;
}

function finishRunEdit(
  db: Database.Database,
  computed: { id: string; realName: string; newBytes: Buffer; count: number; method: EditMethod }
): EditApplied {
  const text = extractText(computed.realName, computed.newBytes) ?? strictUtf8OrNull(computed.newBytes);
  try {
    storeFileBytes(db, computed.id, computed.newBytes, text, "AI edit");
  } catch (e) {
    throw new EditError(errMessage(e), "error");
  }
  return { fileId: computed.id, realName: computed.realName, count: computed.count, method: computed.method };
}

/** Connection-level single edit: compute, then snapshot + overwrite + reindex
 * via the one write path. The tests' end-to-end reference path (production
 * `edit_file` goes through {@link planSingleEdit} + the gate). Ported from
 * `edit_match::run_edit_file`. */
export function runEditFile(
  db: Database.Database,
  name: string,
  oldText: string,
  newText: string,
  all: boolean
): EditApplied {
  return finishRunEdit(db, computeEdit(db, name, oldText, newText, all, NO_REFINEMENTS));
}

/** {@link runEditFile}'s sibling for the refinement tests: takes an
 * {@link EditRefinements} directly. Ported from
 * `edit_match::run_edit_file_refined`. */
export function runEditFileRefined(
  db: Database.Database,
  name: string,
  oldText: string,
  newText: string,
  refine: EditRefinements
): EditApplied {
  return finishRunEdit(db, computeEdit(db, name, oldText, newText, false, refine));
}

/**
 * Validate every op then apply all of them in one transaction: a five-file
 * refactor (or a rename + reference edits) either fully lands or fully
 * doesn't, every snapshot sharing one `AI edit (batch …)` cause. The tests'
 * reference path; the tool arm goes through {@link planBatch} + the
 * diff-preview gate + {@link commitPlans}, which is the same code path. Ported
 * from `edit_match::run_edit_files`.
 */
export function runEditFiles(db: Database.Database, ops: readonly BatchOp[]): BatchApplied {
  const plans = planBatch(db, ops);
  // Rust takes the first 8 characters of a UUID v4's `8-4-4-4-12` string form:
  // the first hyphen sits at index 8, so those are always the whole first
  // group, hyphen-free — `randomUUID().slice(0, 8)` is the same slice.
  const batchId = randomUUID().slice(0, 8);
  commitPlans(db, plans, `AI edit (batch ${batchId})`);
  const { edits, renames } = countBatchOps(ops);
  const files: Array<[string, string]> = plans.map((p) => [p.fileId, p.renameTo ?? p.realName]);
  return { batchId, edits, renames, files };
}
