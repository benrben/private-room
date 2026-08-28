/**
 * The slice of `src-tauri/src/commands/bulk.rs` (436 lines, read in full) that
 * `organize.ts`'s own module doc flags as NOT yet ported and that
 * `execTool.ts`'s `trash_files` arm needs: `BulkReport::changed_anything` and
 * `BulkReport::sentence`.
 *
 * `organize.ts` already ports the OTHER things it needs out of `bulk.rs`
 * (`MAX_BULK_FILES`, and `take_capped`/`each_file`/`trash_files_in` fused into
 * its private `trashFilesIn`) — see that file's module doc for why. This file
 * is the rest, and its own header says so explicitly: "NOTE for the wiring
 * batch: `execTool.ts`'s `trash_files` arm also needs
 * `BulkReport::changed_anything` and `BulkReport::sentence('moved to the
 * trash')`, which live in `bulk.rs` and are NOT here."
 *
 * Rust's `impl BulkReport { fn …(&self) }` becomes a plain function taking the
 * report as its first argument — the same translation `organize.ts` already
 * uses for `OrganizeReport`'s own `sentence` method (its exported
 * `organizeSentence`), and the reason both names are prefixed rather than bare
 * `sentence`: two different report types have a `sentence`, and a call site
 * that imports both must be able to say which one it means.
 *
 * `BulkReport`/`BulkFailure` are NOT redeclared. They already exist,
 * camelCased and field-for-field, in `shared/apiTypes.ts` — the same choice
 * `organize.ts` made — so a report produced by `trashNamed` or `merge` works
 * with these helpers without any conversion. `MAX_BULK_FILES` is likewise NOT
 * a second literal `200`: it is imported from `organize.ts`, which is the copy
 * the batch this sentence describes was actually capped at, so the receipt can
 * never claim a different ceiling from the one really enforced.
 *
 * NOT PORTED, deliberately: `bulk.rs`'s other three verbs (`move_files_in`,
 * `restore_files_in`, `destroy_files_in`), its four `#[tauri::command]`
 * wrappers, and the Library's multi-select wiring. Nothing here needs them,
 * and porting them without a caller is coverage nobody exercises. Whoever
 * ports the rest of `bulk.rs` for real should reuse the two functions below
 * AND fold `organize.ts`'s `trashFilesIn`/`MAX_BULK_FILES` into that module,
 * per that file's own note.
 */

import type { BulkReport } from "../shared/apiTypes.js";
import { MAX_BULK_FILES } from "./organize.js";

/**
 * `BulkReport::changed_anything` — did anything at all change?
 *
 * Callers use this to decide whether a batch counts as a WRITE: an all-failed
 * batch must not tell the UI to re-read a room nothing happened to, and must
 * not arm the turn's `effects.wrote` flag for work it did not do.
 */
export function bulkReportChangedAnything(report: BulkReport): boolean {
  return report.ok.length > 0;
}

/**
 * `BulkReport::sentence` — a one-line receipt: what happened, in the words the
 * user gets. `verbPast` completes `"<n> files <verbPast>"` (e.g. "moved to the
 * trash").
 */
export function bulkReportSentence(report: BulkReport, verbPast: string): string {
  let out: string;
  if (report.ok.length === 0) {
    out = `Nothing was ${verbPast}.`;
  } else if (report.ok.length === 1) {
    out = `"${report.ok[0]}" ${verbPast}.`;
  } else {
    out = `${report.ok.length} files ${verbPast}.`;
  }
  if (report.failed.length > 0) {
    // Name them. "3 files could not be moved" with no names leaves the user to
    // diff two lists by eye to find out which.
    const detail = report.failed.slice(0, 10).map((f) => `"${f.name}" (${f.error})`);
    out += ` ${report.failed.length} could not be: ${detail.join("; ")}`;
    if (report.failed.length > 10) {
      out += ` …and ${report.failed.length - 10} more`;
    }
    out += ".";
  }
  if (report.capped > 0) {
    out += ` ${report.capped} more were not attempted — one batch handles at most ${MAX_BULK_FILES} files.`;
  }
  return out;
}
