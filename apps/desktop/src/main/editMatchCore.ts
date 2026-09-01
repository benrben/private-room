/** Cohesive extraction from editMatch.ts; the facade preserves its public API. */
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
import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { inTransaction, renameFile, updateFileContent } from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { clampBytes } from "./textClamp.js";
import { decodeTextBytes, extensionOf, isTextExtension, normalizeWhitespace } from "./editMatchExtraction.js";
import { extractDocx } from "./editMatchDocx.js";
import { stripHtml } from "./editMatchHtml.js";


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


export function errMessage(e: unknown): string {
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
export function nonUtf8Error(name: string): string {
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
export function strictUtf8OrNull(bytes: Uint8Array): string | null {
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
  if (isTextExtension(ext)) return decodeTextBytes(bytes);
  return normalizedExtractedText(extractedRawText(ext, bytes));
}


function extractedRawText(ext: string, bytes: Uint8Array): string | null {
  if (ext === "docx") return extractDocx(bytes);
  if (ext === "html" || ext === "htm") return stripHtml(decodeTextBytes(bytes));
  return null;
}


function normalizedExtractedText(raw: string | null): string | null {
  if (raw === null) return null;
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


export const NO_REFINEMENTS: EditRefinements = {};


export function refinementsEmpty(r: EditRefinements): boolean {
  return (
    r.prefixContext === undefined && r.suffixContext === undefined && r.occurrence === undefined && r.section === undefined
  );
}


/** The subset of refinements docx/HTML must refuse outright — `section` is
 * excluded because it IS supported there, just via a different mechanism.
 * Ported from `EditRefinements::has_positional_refinement`. */
export function hasPositionalRefinement(r: EditRefinements): boolean {
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
  return usesExtractedPreview(ext) ? extractText(realName, bytes) ?? "" : decodeTextBytes(bytes);
}


function usesExtractedPreview(ext: string): boolean {
  return ["docx", "xlsx", "xls", "pdf", "pptx"].includes(ext);
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
  const edge = charBoundaryEdge(s, max);
  if (edge !== null) return edge;
  return beginsSurrogatePairAt(s, max) ? max - 1 : max;
}


function charBoundaryEdge(s: string, max: number): number | null {
  if (max >= s.length) return s.length;
  if (max <= 0) return 0;
  return null;
}


function beginsSurrogatePairAt(s: string, max: number): boolean {
  return lowSurrogate(s.charCodeAt(max)) && highSurrogate(s.charCodeAt(max - 1));
}


function lowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}


function highSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
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
export function previewPair(
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
export function multiOccurrenceError(oldText: string, n: number, realName: string, allOffered: boolean): string {
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
export function sectionNotFoundError(section: string, realName: string, headings: readonly string[]): string {
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
export function tooLargeForFuzzyError(realName: string): string {
  return (
    `Could not find that exact text in "${realName}". This file is too ` +
    `large for the forgiving match, so the quote has to be exact — copy ` +
    `it from the file, including spacing and punctuation.`
  );
}


/** `all: true` reached the forgiving matcher, which cannot promise "every
 * occurrence" of a quote it only matched approximately. Ported from
 * `edit_match::all_needs_exact_error`. */
export function allNeedsExactError(oldText: string, realName: string): string {
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
export function refinementNotFoundError(realName: string, refine: EditRefinements): string {
  const sectionNote = refine.section !== undefined ? ` in the "${refine.section}" section` : "";
  const named = namedRefinements(refine);
  const verb = named.length === 1 ? "needs" : "need";
  const them = named.length === 1 ? "it" : "them";
  return (
    `Could not find that exact text in "${realName}"${sectionNote}. ${named.join(" and ")} ${verb} old_text to ` +
    `match EXACTLY — copy it exactly, including spacing and punctuation, or drop ${them} and ` +
    `let the forgiving match try.`
  );
}


function namedRefinements(refine: EditRefinements): string[] {
  return [
    refinementName(refine.prefixContext, "prefix_context"),
    refinementName(refine.suffixContext, "suffix_context"),
    refinementName(refine.occurrence, "occurrence"),
  ].filter((name): name is string => name !== null);
}


function refinementName(value: unknown, name: string): string | null {
  return value === undefined ? null : name;
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
export function replaceAllLiteral(content: string, oldText: string, newText: string): string {
  return content.split(oldText).join(newText);
}
