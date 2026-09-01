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
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { commitPlans, EditError, type EditMethod, type EditRefinements, errMessage, extractText, NO_REFINEMENTS, storeFileBytes, strictUtf8OrNull } from "./editMatchCore.js";
import { type BatchApplied, type BatchOp, countBatchOps, type EditApplied, planBatch } from "./editMatchBatch.js";
import { computeEdit } from "./editMatchPlans.js";


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
