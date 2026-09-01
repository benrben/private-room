/** Cohesive extraction from editMatch.ts; the facade preserves its public API. */
import type Database from "better-sqlite3-multiple-ciphers";
import { findFileLike, getFileBytes } from "./db-host/files.js";
import { closestSnippet } from "./fileTools.js";
import { clampBytes } from "./textClamp.js";
import { extensionOf, isTextExtension } from "./editMatchExtraction.js";
import { fuzzyFind } from "./editMatchFuzzy.js";
import { docxReplaceText } from "./editMatchDocx.js";
import { setCellInBytes } from "./editMatchCells.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { type ComputedEdit, computeEditBytesHtml, computeEditBytesText, countLiteralOccurrences, utf8Length } from "./editMatchText.js";
import { allNeedsExactError, EditError, type EditMethod, type EditRefinements, errMessage, hashBytes, hasPositionalRefinement, MAX_FUZZY_BYTES, multiOccurrenceError, type PlannedWrite, type PreviewEdit, previewPair, replaceAllLiteral, tooLargeForFuzzyError } from "./editMatchCore.js";


export function unrefinedTextEdit(realName: string, content: string, oldText: string, newText: string, all: boolean | undefined): ComputedEdit {
  const exact = exactTextEdit(realName, content, oldText, newText, all);
  return exact ?? fuzzyTextEdit(realName, content, oldText, newText, all);
}


function exactTextEdit(realName: string, content: string, oldText: string, newText: string, all: boolean | undefined): ComputedEdit | null {
  const count = countLiteralOccurrences(content, oldText);
  if (count === 0) return null;
  if (count === 1) return { bytes: Buffer.from(replaceAllLiteral(content, oldText, newText), "utf8"), count, method: "exact" };
  if (all === true) return { bytes: Buffer.from(replaceAllLiteral(content, oldText, newText), "utf8"), count, method: "exact_all" };
  throw new EditError(multiOccurrenceError(oldText, count, realName, all !== undefined), "ambiguous");
}


function fuzzyTextEdit(realName: string, content: string, oldText: string, newText: string, all: boolean | undefined): ComputedEdit {
  assertFuzzyTextAllowed(realName, content, oldText, all);
  return fuzzyTextMatchResult(realName, content, oldText, newText);
}


function assertFuzzyTextAllowed(realName: string, content: string, oldText: string, all: boolean | undefined): void {
  if (utf8Length(content) > MAX_FUZZY_BYTES) throw new EditError(tooLargeForFuzzyError(realName), "not_found");
  if (all === true) throw new EditError(allNeedsExactError(oldText, realName), "all_needs_exact");
}


function fuzzyTextMatchResult(realName: string, content: string, oldText: string, newText: string): ComputedEdit {
  const found = fuzzyFind(content, oldText);
  if (found.kind === "unique") return fuzzyReplacement(content, found.start, found.end, newText);
  if (found.kind === "ambiguous") throw fuzzyTextAmbiguity(realName, found.count);
  throw fuzzyTextNotFound(realName, content, oldText);
}


function fuzzyReplacement(content: string, start: number, end: number, newText: string): ComputedEdit {
  return { bytes: Buffer.from(content.slice(0, start) + newText + content.slice(end), "utf8"), count: 1, method: "fuzzy" };
}


function fuzzyTextAmbiguity(realName: string, count: number): EditError {
  return new EditError(`That text appears in ${count} places in "${realName}" with slightly different spacing or punctuation. Include more surrounding text so it matches exactly one place.`, "ambiguous");
}


function fuzzyTextNotFound(realName: string, content: string, oldText: string): EditError {
  const hint = closestSnippet(content, oldText);
  const hintNote = hint === null ? "" : ` The closest text in the file is: "${clampBytes(hint, 200)}".`;
  return new EditError(`Could not find that exact text in "${realName}". Copy it exactly, including spacing and punctuation.${hintNote}`, "not_found");
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
  validateEditRefinements(realName, ext, refine);
  return editBytesForExtension(realName, ext, bytes, oldText, newText, all, refine);
}


function validateEditRefinements(realName: string, ext: string, refine: EditRefinements): void {
  rejectUnsupportedPositionalRefinement(realName, ext, refine);
  rejectUnsupportedSectionRefinement(realName, ext, refine);
}


function rejectUnsupportedPositionalRefinement(realName: string, ext: string, refine: EditRefinements): void {
  if (!hasPositionalRefinement(refine) || !positionalRefinementUnsupported(ext)) return;
  throw new EditError(`prefix_context/suffix_context/occurrence aren't available for "${realName}" yet. Add more surrounding text to old_text instead, or pass all: true.`, "wrong_type");
}


function positionalRefinementUnsupported(ext: string): boolean {
  return ext === "docx" || htmlExtension(ext);
}


function rejectUnsupportedSectionRefinement(realName: string, ext: string, refine: EditRefinements): void {
  if (refine.section === undefined || sectionRefinementSupported(ext)) return;
  throw new EditError(`section isn't available for "${realName}" yet — it works on .html and .md/.markdown files. Add more surrounding text to old_text instead.`, "wrong_type");
}


function sectionRefinementSupported(ext: string): boolean {
  return htmlExtension(ext) || ext === "md" || ext === "markdown";
}


function htmlExtension(ext: string): boolean {
  return ext === "html" || ext === "htm";
}


function editBytesForExtension(
  realName: string, ext: string, bytes: Uint8Array, oldText: string, newText: string, all: boolean | undefined, refine: EditRefinements,
): ComputedEdit {
  if (ext === "docx") return computeDocxEdit(realName, bytes, oldText, newText, all);
  if (spreadsheetExtension(ext)) throw new EditError("Spreadsheet cells are edited with set_cells (e.g. cell B7), not edit_file.", "wrong_type");
  if (ext === "pdf") throw new EditError("PDF text cannot be edited in place. Use annotate_file to highlight, or create_file to save a corrected copy of its text.", "wrong_type");
  if (htmlExtension(ext)) return computeEditBytesHtml(realName, bytes, oldText, newText, all, refine);
  if (isTextExtension(ext)) return computeEditBytesText(realName, bytes, oldText, newText, all, refine);
  throw new EditError("This file type cannot be edited in place. Use create_file to save an edited copy of its text instead.", "wrong_type");
}


function spreadsheetExtension(ext: string): boolean {
  return ext === "xlsx" || ext === "xls";
}


function computeDocxEdit(realName: string, bytes: Uint8Array, oldText: string, newText: string, all: boolean | undefined): ComputedEdit {
  const replaced = docxReplaceText(bytes, oldText, newText);
  if (!replaced.ok) throw new EditError(replaced.error, "not_found");
  if (replaced.count > 1 && all !== true) throw new EditError(multiOccurrenceError(oldText, replaced.count, realName, all !== undefined), "ambiguous");
  return { bytes: replaced.bytes, count: replaced.count, method: "docx" };
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
