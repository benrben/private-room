//! Wave 2 (Ideas 4 & 7): reliable, byte-safe file edits.
//!
//! Idea 4 — `edit_file`'s matcher tolerates the typographic drift a model
//! introduces (curly quotes, NBSP/CRLF, dash and ligature variants) via the ONE
//! fold table in `extraction::fold_edit_char`, but only ever rewrites the exact
//! byte span of a UNIQUELY identified passage — a multi-match fails with a count
//! and a `closest_snippet` hint instead of silently editing everything.
//!
//! Idea 7 — `edit_files` batches several edits (and renames) and applies them in
//! ONE `BEGIN IMMEDIATE` transaction (validate-all-then-write, like `set_cells`):
//! either the whole refactor lands or none of it does, with every snapshot
//! sharing an `AI edit (batch …)` cause tag for group visibility/undo.

use super::*;
use crate::extraction::{fold_edit_char, FoldOut};
use std::collections::HashMap;
use std::ops::Range;

// ---------------------------------------------------------------- normalization

/// A collapsed whitespace run that spans a paragraph break (2+ newlines) becomes
/// this sentinel. It can never appear in a normalized NEEDLE (needle whitespace
/// always collapses to a plain space), so a fuzzy needle can never match across a
/// blank line — mirroring the docx matcher's `'\u{0}'` paragraph discipline (a
/// single-space needle silently splicing two paragraphs into one is exactly the
/// footgun that guard prevents).
const PARA_SENTINEL: char = '\u{0}';

/// The haystack, folded to comparison chars, each carrying the byte range in the
/// ORIGINAL text it came from — so a match's char range slices the original in a
/// UTF-8-safe way (same span-tracking discipline as `words_with_byte_spans`).
struct NormText {
    chars: Vec<char>,
    spans: Vec<Range<usize>>,
}

/// Flush a pending whitespace run into the normalized stream: a run with 2+
/// newlines becomes the unmatchable paragraph sentinel, otherwise one space.
fn flush_ws(
    chars: &mut Vec<char>,
    spans: &mut Vec<Range<usize>>,
    ws: &mut Option<(usize, usize, usize)>,
) {
    if let Some((start, end, newlines)) = ws.take() {
        chars.push(if newlines >= 2 { PARA_SENTINEL } else { ' ' });
        spans.push(start..end);
    }
}

fn normalize_with_spans(text: &str) -> NormText {
    let mut chars: Vec<char> = Vec::new();
    let mut spans: Vec<Range<usize>> = Vec::new();
    // Pending whitespace run: (byte start, byte end exclusive, newline count).
    let mut ws: Option<(usize, usize, usize)> = None;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        match fold_edit_char(c) {
            FoldOut::Space => {
                let nl = usize::from(c == '\n');
                match &mut ws {
                    Some((_, e, n)) => {
                        *e = end;
                        *n += nl;
                    }
                    None => ws = Some((i, end, nl)),
                }
            }
            FoldOut::Drop => {}
            FoldOut::Char(fc) => {
                flush_ws(&mut chars, &mut spans, &mut ws);
                chars.push(fc);
                spans.push(i..end);
            }
            FoldOut::Pair(a, b) => {
                flush_ws(&mut chars, &mut spans, &mut ws);
                // Both halves map back to the SAME source char span.
                chars.push(a);
                spans.push(i..end);
                chars.push(b);
                spans.push(i..end);
            }
        }
    }
    flush_ws(&mut chars, &mut spans, &mut ws);
    NormText { chars, spans }
}

/// The needle folded to comparison chars, whitespace collapsed to single spaces
/// (never the paragraph sentinel) and trimmed of edge spaces.
fn normalize_needle(s: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    let mut pending_space = false;
    for c in s.chars() {
        match fold_edit_char(c) {
            FoldOut::Space => pending_space = !out.is_empty(),
            FoldOut::Drop => {}
            FoldOut::Char(fc) => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push(fc);
            }
            FoldOut::Pair(a, b) => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push(a);
                out.push(b);
            }
        }
    }
    out
}

/// Result of hunting a typographically-drifted needle in the file's raw bytes.
pub(crate) enum FuzzyFind {
    /// Exactly one normalized occurrence — the byte range to rewrite.
    Unique(Range<usize>),
    /// Multiple occurrences post-normalization — ambiguous, carries the count.
    Ambiguous(usize),
    /// No occurrence (or an empty needle).
    NotFound,
}

/// Scan `content` for `old_text` tolerant of the fold table, requiring a UNIQUE
/// hit. Counts non-overlapping matches (same advance discipline as the docx
/// `find_sub`), so its uniqueness verdict matches `content.matches(...).count()`.
pub(crate) fn fuzzy_find(content: &str, old_text: &str) -> FuzzyFind {
    let needle = normalize_needle(old_text);
    if needle.is_empty() {
        return FuzzyFind::NotFound;
    }
    let hay = normalize_with_spans(content);
    let h = &hay.chars;
    let n = needle.len();
    if h.len() < n {
        return FuzzyFind::NotFound;
    }
    let mut first: Option<usize> = None;
    let mut count = 0usize;
    let mut i = 0;
    while i + n <= h.len() {
        if h[i..i + n] == needle[..] {
            count += 1;
            if first.is_none() {
                first = Some(i);
            }
            i += n; // non-overlapping
        } else {
            i += 1;
        }
    }
    match (count, first) {
        (1, Some(i)) => FuzzyFind::Unique(hay.spans[i].start..hay.spans[i + n - 1].end),
        (0, _) => FuzzyFind::NotFound,
        _ => FuzzyFind::Ambiguous(count),
    }
}

// ---------------------------------------------------------------- single edit

/// How a successful edit found its span — surfaced in the success string (Fuzzy
/// tells the model its quote was typographically off) and the content-free
/// outcome telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EditMethod {
    Exact,
    ExactAll,
    Fuzzy,
    Docx,
}

impl EditMethod {
    pub(crate) fn outcome(self) -> &'static str {
        match self {
            EditMethod::Exact => "exact",
            EditMethod::ExactAll => "exact_all",
            EditMethod::Fuzzy => "fuzzy",
            EditMethod::Docx => "docx",
        }
    }
}

/// An edit failure carrying both the model-facing message and a content-free
/// outcome tag for the `messages.effects` telemetry (never `old_text`/`new_text`).
#[derive(Debug)]
pub(crate) struct EditError {
    pub message: String,
    pub outcome: &'static str,
}

impl EditError {
    pub(crate) fn new(message: impl Into<String>, outcome: &'static str) -> Self {
        Self { message: message.into(), outcome }
    }
}

// The reference connection-level entry points below (`run_edit_file` /
// `run_edit_files`) are what the tests drive end to end; production goes through
// `plan_*` + the diff-preview gate + `commit_plans` (the same code path).
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct EditApplied {
    pub file_id: String,
    pub real_name: String,
    pub count: usize,
    pub method: EditMethod,
}

impl EditError {
    /// Wrap a batch validation message (already prefixed "Edit N of M …") as a
    /// content-free failure outcome for the telemetry.
    pub(crate) fn batch_failure(message: String) -> Self {
        Self { message, outcome: "failed" }
    }
}

// ---------------------------------------------------------------- write plans (Ideas 6/7)

/// One computed-but-not-yet-written change to a file, produced under the room
/// lock and either applied immediately (gate off) or after diff-preview approval
/// (Idea 6). `new_bytes: None` is a rename-only op (no byte change, no snapshot).
pub(crate) struct PlannedWrite {
    pub file_id: String,
    pub real_name: String,
    pub new_bytes: Option<Vec<u8>>,
    pub rename_to: Option<String>,
    pub method: Option<EditMethod>,
    pub count: usize,
    /// SHA-256 of the bytes this plan was computed against, re-checked before a
    /// gated apply so a file that changed under a pending approval card is never
    /// overwritten with stale bytes.
    pub staleness: Option<[u8; 32]>,
    pub before: String,
    pub after: String,
    pub clipped: bool,
}

/// A single edit as the diff-preview gate receives it (edit_file → one of these).
pub(crate) struct PreviewEdit {
    pub name: String,
    pub old_text: String,
    pub new_text: String,
    pub all: bool,
}

/// Preview text stays bounded so a huge file's diff can't blow the IPC payload.
const PREVIEW_CLIP: usize = 200_000;

pub(crate) fn hash_bytes(b: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().into()
}

/// Human-readable rendering of a file's bytes for the diff card — extracted text
/// for binary office formats, raw UTF-8 for everything else.
fn render_for_preview(real_name: &str, bytes: &[u8]) -> String {
    let ext = extraction::extension_of(real_name);
    match ext.as_str() {
        "docx" | "xlsx" | "xls" | "pdf" | "pptx" => {
            extraction::extract_text(real_name, bytes).unwrap_or_default()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn preview_pair(real_name: &str, before_bytes: &[u8], after_bytes: &[u8]) -> (String, String, bool) {
    let before = render_for_preview(real_name, before_bytes);
    let after = render_for_preview(real_name, after_bytes);
    let clipped = before.len() > PREVIEW_CLIP || after.len() > PREVIEW_CLIP;
    (clamp_bytes(before, PREVIEW_CLIP), clamp_bytes(after, PREVIEW_CLIP), clipped)
}

/// Commit already-computed plans in ONE transaction: any error rolls all of them
/// back (byte-for-byte the shape of `restore_file_version`). Pure SQL end to end —
/// `store_file_bytes` and `rename_file` do no non-SQL side effects, so events are
/// the caller's job, after this returns.
pub(crate) fn commit_plans(conn: &Connection, plans: &[PlannedWrite], cause: &str) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let applied: Result<(), String> = (|| {
        for p in plans {
            if let Some(bytes) = &p.new_bytes {
                let name_for_text = p.rename_to.as_deref().unwrap_or(&p.real_name);
                let text = extraction::extract_text(name_for_text, bytes)
                    .or_else(|| String::from_utf8(bytes.clone()).ok());
                store_file_bytes(conn, &p.file_id, bytes, text.as_deref(), cause)?;
            }
            if let Some(new_name) = &p.rename_to {
                db::rename_file(conn, &p.file_id, new_name)?;
            }
        }
        Ok(())
    })();
    match applied {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Plan a `write_file` whole-file rewrite (Idea 6 gates it too). Idea 4 decision:
/// html/htm are accepted here — their bytes are UTF-8 text and `store_file_bytes`
/// re-derives the searchable text via `strip_html`, so the AI can revise the
/// app's default `.html` documents (which `edit_file` can't reliably match).
pub(crate) fn plan_write_file(
    conn: &Connection,
    name: &str,
    content: &str,
) -> Result<Vec<PlannedWrite>, EditError> {
    let (id, real_name) =
        db::find_file_like(conn, name).map_err(|e| EditError::new(e, "not_found"))?;
    let ext = extraction::extension_of(&real_name);
    let is_html = ext == "html" || ext == "htm";
    if !extraction::is_text_extension(&ext) && !is_html {
        return Err(EditError::new(
            format!(
                "\"{real_name}\" is not a plain-text file — write_file only rewrites text or \
                 HTML files. Use edit_file (docx), set_cells (spreadsheets), or create_file."
            ),
            "wrong_type",
        ));
    }
    let original = db::get_file_bytes(conn, &id)
        .map_err(|e| EditError::new(e, "error"))?
        .unwrap_or_default();
    let new_bytes = content.as_bytes().to_vec();
    let (before, after, clipped) = preview_pair(&real_name, &original, &new_bytes);
    Ok(vec![PlannedWrite {
        file_id: id,
        real_name,
        new_bytes: Some(new_bytes),
        rename_to: None,
        method: None,
        count: content.chars().count(),
        staleness: Some(hash_bytes(&original)),
        before,
        after,
        clipped,
    }])
}

/// Plan a `set_cells` change (Idea 6 gate). The before/after preview is
/// synthesized from `extract_text` of the current vs proposed bytes — no new cell
/// reader (Idea 6 review amendment 3).
pub(crate) fn plan_set_cells(
    conn: &Connection,
    name: &str,
    sheet: Option<&str>,
    updates: &[(String, String)],
) -> Result<Vec<PlannedWrite>, EditError> {
    let (id, real_name) =
        db::find_file_like(conn, name).map_err(|e| EditError::new(e, "not_found"))?;
    let original = db::get_file_bytes(conn, &id)
        .map_err(|e| EditError::new(e, "error"))?
        .ok_or_else(|| EditError::new("File has no stored content.", "wrong_type"))?;
    let mut bytes = original.clone();
    for (cell, value) in updates {
        let (nb, _t) = set_cell_in_bytes(&real_name, &bytes, sheet, cell, value)
            .map_err(|e| EditError::new(e, "error"))?;
        bytes = nb;
    }
    let (before, after, clipped) = preview_pair(&real_name, &original, &bytes);
    Ok(vec![PlannedWrite {
        file_id: id,
        real_name,
        new_bytes: Some(bytes),
        rename_to: None,
        method: None,
        count: updates.len(),
        staleness: Some(hash_bytes(&original)),
        before,
        after,
        clipped,
    }])
}

/// Plan one `edit_file` — compute proposed bytes + preview + staleness, no write.
pub(crate) fn plan_single_edit(
    conn: &Connection,
    edit: &PreviewEdit,
) -> Result<Vec<PlannedWrite>, EditError> {
    if edit.old_text.is_empty() {
        return Err(EditError::new(
            "old_text is required — copy the exact text to replace.",
            "not_found",
        ));
    }
    let (id, real_name, new_bytes, count, method) =
        compute_edit(conn, &edit.name, &edit.old_text, &edit.new_text, edit.all)?;
    let original = db::get_file_bytes(conn, &id)
        .map_err(|e| EditError::new(e, "error"))?
        .unwrap_or_default();
    let (before, after, clipped) = preview_pair(&real_name, &original, &new_bytes);
    Ok(vec![PlannedWrite {
        file_id: id,
        real_name,
        new_bytes: Some(new_bytes),
        rename_to: None,
        method: Some(method),
        count,
        staleness: Some(hash_bytes(&original)),
        before,
        after,
        clipped,
    }])
}

fn multi_occurrence_error(old_text: &str, n: usize, real_name: &str) -> String {
    format!(
        "\"{}\" appears {n} times in \"{real_name}\". Include more surrounding text to \
         pick one, or pass all: true to replace every occurrence.",
        clamp_bytes(old_text.to_string(), 80)
    )
}

/// Pure over bytes: compute the new bytes for one file's content, no writes. The
/// uniqueness guard fires for BOTH the text branch and the docx branch. Shared by
/// the single edit, the batch executor (over chained working bytes), and the
/// diff-preview gate (proposed bytes without writing).
pub(crate) fn compute_edit_bytes(
    real_name: &str,
    bytes: &[u8],
    old_text: &str,
    new_text: &str,
    all: bool,
) -> Result<(Vec<u8>, usize, EditMethod), EditError> {
    let ext = extraction::extension_of(real_name);
    match ext.as_str() {
        "docx" => {
            // docx_replace_text is pure (patched bytes + count, no write) and
            // replaces EVERY occurrence, so apply the same replace-all guard the
            // text branch has: >1 without `all` is discarded, not silently applied.
            let (new_bytes, count) = extraction::docx_replace_text(bytes, old_text, new_text)
                .map_err(|e| EditError::new(e, "not_found"))?;
            if count > 1 && !all {
                return Err(EditError::new(
                    multi_occurrence_error(old_text, count, real_name),
                    "ambiguous",
                ));
            }
            Ok((new_bytes, count, EditMethod::Docx))
        }
        "xlsx" | "xls" => Err(EditError::new(
            "Spreadsheet cells are edited with set_cells (e.g. cell B7), not edit_file.",
            "wrong_type",
        )),
        "pdf" => Err(EditError::new(
            "PDF text cannot be edited in place. Use annotate_file to highlight, or \
             create_file to save a corrected copy of its text.",
            "wrong_type",
        )),
        // Idea 4 scope decision: .html is the app's DEFAULT AI-document format,
        // but its stored bytes are tag-bearing markup while the model quotes from
        // strip_html-extracted text — the fold table cannot bridge that, so an
        // in-place quote match is unreliable. Steer to the whole-file paths, which
        // DO work on html (write_file now accepts it; create_file makes a version).
        "html" | "htm" => Err(EditError::new(
            format!(
                "\"{real_name}\" is an HTML page — edit_file can't reliably match a quote \
                 against its raw markup. Rewrite it with write_file (pass the full updated \
                 HTML), or create_file to save a new version."
            ),
            "wrong_type",
        )),
        ext if extraction::is_text_extension(ext) => {
            let content = String::from_utf8_lossy(bytes).into_owned();
            let exact = content.matches(old_text).count();
            if exact == 1 {
                Ok((content.replace(old_text, new_text).into_bytes(), 1, EditMethod::Exact))
            } else if exact > 1 {
                if all {
                    Ok((
                        content.replace(old_text, new_text).into_bytes(),
                        exact,
                        EditMethod::ExactAll,
                    ))
                } else {
                    Err(EditError::new(
                        multi_occurrence_error(old_text, exact, real_name),
                        "ambiguous",
                    ))
                }
            } else {
                match fuzzy_find(&content, old_text) {
                    FuzzyFind::Unique(range) => {
                        let mut c = content;
                        c.replace_range(range, new_text);
                        Ok((c.into_bytes(), 1, EditMethod::Fuzzy))
                    }
                    // A fuzzy multi-match must NOT advise `all: true`: the fuzzy
                    // path doesn't honor it, so that advice would loop a 4B model.
                    // A distinct message asks for more context instead.
                    FuzzyFind::Ambiguous(n) => Err(EditError::new(
                        format!(
                            "That text appears in {n} places in \"{real_name}\" with slightly \
                             different spacing or punctuation. Include more surrounding text \
                             so it matches exactly one place."
                        ),
                        "ambiguous",
                    )),
                    FuzzyFind::NotFound => {
                        let hint = closest_snippet(&content, old_text)
                            .map(|s| {
                                format!(" The closest text in the file is: \"{}\".", clamp_bytes(s, 200))
                            })
                            .unwrap_or_default();
                        Err(EditError::new(
                            format!(
                                "Could not find that exact text in \"{real_name}\". Copy it \
                                 exactly, including spacing and punctuation.{hint}"
                            ),
                            "not_found",
                        ))
                    }
                }
            }
        }
        _ => Err(EditError::new(
            "This file type cannot be edited in place. Use create_file to save an edited \
             copy of its text instead.",
            "wrong_type",
        )),
    }
}

/// Compute the proposed bytes for a named file WITHOUT writing — resolves the
/// file and loads its current bytes, then defers to `compute_edit_bytes`. Ideas 6
/// (preview) and 7 (batch first-file load) reuse this.
pub(crate) fn compute_edit(
    conn: &Connection,
    name: &str,
    old_text: &str,
    new_text: &str,
    all: bool,
) -> Result<(String, String, Vec<u8>, usize, EditMethod), EditError> {
    let (id, real_name) =
        db::find_file_like(conn, name).map_err(|e| EditError::new(e, "not_found"))?;
    let bytes = db::get_file_bytes(conn, &id)
        .map_err(|e| EditError::new(e, "wrong_type"))?
        .ok_or_else(|| EditError::new("File has no stored content.", "wrong_type"))?;
    let (new_bytes, count, method) = compute_edit_bytes(&real_name, &bytes, old_text, new_text, all)?;
    Ok((id, real_name, new_bytes, count, method))
}

/// Connection-level single edit: compute, then snapshot + overwrite + reindex via
/// the one write path (`store_file_bytes`). The tests' end-to-end reference path
/// (production `edit_file` goes through `plan_single_edit` + the gate).
#[cfg(test)]
pub(crate) fn run_edit_file(
    conn: &Connection,
    name: &str,
    old_text: &str,
    new_text: &str,
    all: bool,
) -> Result<EditApplied, EditError> {
    let (id, real_name, new_bytes, count, method) = compute_edit(conn, name, old_text, new_text, all)?;
    let text = extraction::extract_text(&real_name, &new_bytes)
        .or_else(|| String::from_utf8(new_bytes.clone()).ok());
    store_file_bytes(conn, &id, &new_bytes, text.as_deref(), "AI edit")
        .map_err(|e| EditError::new(e, "error"))?;
    Ok(EditApplied { file_id: id, real_name, count, method })
}

// ---------------------------------------------------------------- batch (Idea 7)

pub(crate) const MAX_BATCH_EDITS: usize = 20;

/// One operation in an atomic batch — a serde-tagged op enum so "rename + update
/// every reference" is a single atomic unit. `db::rename_file` is a single UPDATE
/// (db/files.rs), so a rename rides the same transaction as the content edits.
#[derive(serde::Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub(crate) enum BatchOp {
    Edit { name: String, old_text: String, new_text: String },
    Rename { name: String, new_name: String },
}

#[cfg(test)]
#[derive(Debug)]
pub(crate) struct BatchApplied {
    pub batch_id: String,
    pub edits: usize,
    pub renames: usize,
    /// (file_id, display_name) for each touched file, in first-touch order — the
    /// arm emits `file-updated` per id so the per-answer Undo chip reverts the batch.
    pub files: Vec<(String, String)>,
}

/// Keep the current extension when the model dropped it (parity with the
/// `rename_file` tool arm).
fn keep_ext(current: &str, new_name: &str) -> String {
    if extraction::extension_of(new_name).is_empty() {
        let ext = extraction::extension_of(current);
        if ext.is_empty() {
            new_name.to_string()
        } else {
            format!("{new_name}.{ext}")
        }
    } else {
        new_name.to_string()
    }
}

struct FileWork {
    real_name: String,
    /// The ORIGINAL DB bytes, loaded lazily the first time this file is edited
    /// (a rename-only file never loads them, so we never overwrite it with an
    /// empty buffer). Kept for the diff-preview `before` and the staleness token.
    original: Option<Vec<u8>>,
    bytes: Option<Vec<u8>>,
    dirty: bool,
    new_name: Option<String>,
}

/// Count how many ops are edits vs renames (for the success string / telemetry).
pub(crate) fn count_batch_ops(ops: &[BatchOp]) -> (usize, usize) {
    let mut edits = 0;
    let mut renames = 0;
    for op in ops {
        match op {
            BatchOp::Edit { .. } => edits += 1,
            BatchOp::Rename { .. } => renames += 1,
        }
    }
    (edits, renames)
}

/// Parse the tool's `edits` array into typed ops. Serde-tagged is the documented
/// form, but a 4B model may omit the tag, so the variant is inferred from the
/// fields present (a `new_name` with no edit fields ⇒ rename). Empty entries are
/// skipped, exactly as `set_cells` skips empty cells.
pub(crate) fn parse_batch_ops(args: &serde_json::Value) -> Result<Vec<BatchOp>, String> {
    let arr = args["edits"].as_array().ok_or(
        "Pass edits: [{name, old_text, new_text}] (or {name, new_name} to rename) — one array.",
    )?;
    let mut ops = Vec::new();
    for e in arr {
        let name = e["name"].as_str().unwrap_or_default().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let op = e["op"].as_str().unwrap_or_default();
        let has_new_name = !e["new_name"].as_str().unwrap_or_default().trim().is_empty();
        let is_rename = op.eq_ignore_ascii_case("rename") || (op.is_empty() && has_new_name);
        if is_rename {
            ops.push(BatchOp::Rename {
                name,
                new_name: e["new_name"].as_str().unwrap_or_default().to_string(),
            });
        } else {
            ops.push(BatchOp::Edit {
                name,
                old_text: e["old_text"].as_str().unwrap_or_default().to_string(),
                new_text: e["new_text"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    if ops.is_empty() {
        return Err(
            "No edits given — pass edits: [{name, old_text, new_text} | {name, new_name}].".into(),
        );
    }
    Ok(ops)
}

/// Phase A of the batch: validate every op against chained working state and
/// build one `PlannedWrite` per touched file — NO writes. A single failure names
/// which op broke (keeping the ambiguity/closest-snippet hint) so the model can
/// fix just that one. Repeated edits to the same file compose over working bytes,
/// exactly like `set_cells` chains `set_cell_in_bytes`.
pub(crate) fn plan_batch(conn: &Connection, ops: &[BatchOp]) -> Result<Vec<PlannedWrite>, String> {
    let n = ops.len();
    if n == 0 {
        return Err("No edits given — pass edits: [{name, old_text, new_text} | {name, new_name}].".into());
    }
    if n > MAX_BATCH_EDITS {
        return Err(format!(
            "Too many operations in one batch ({n}). Split into batches of at most \
             {MAX_BATCH_EDITS} so each stays reviewable and the transaction stays short."
        ));
    }

    let mut working: HashMap<String, FileWork> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        match op {
            BatchOp::Edit { name, old_text, new_text } => {
                if old_text.is_empty() {
                    return Err(format!("Edit {} of {n}: old_text is required.", i + 1));
                }
                let (id, real_name) = db::find_file_like(conn, name)
                    .map_err(|e| format!("Edit {} of {n} ({name}): {e}", i + 1))?;
                if !working.contains_key(&id) {
                    working.insert(
                        id.clone(),
                        FileWork { real_name, original: None, bytes: None, dirty: false, new_name: None },
                    );
                    order.push(id.clone());
                }
                let entry = working.get_mut(&id).unwrap();
                if entry.bytes.is_none() {
                    let loaded = db::get_file_bytes(conn, &id)
                        .map_err(|e| format!("Edit {} of {n} ({}): {e}", i + 1, entry.real_name))?
                        .ok_or_else(|| {
                            format!("Edit {} of {n} ({}): file has no stored content.", i + 1, entry.real_name)
                        })?;
                    entry.original = Some(loaded.clone());
                    entry.bytes = Some(loaded);
                }
                let cur = entry.bytes.as_deref().unwrap();
                let (new_bytes, _count, _method) =
                    compute_edit_bytes(&entry.real_name, cur, old_text, new_text, false)
                        .map_err(|e| format!("Edit {} of {n} ({}): {}", i + 1, entry.real_name, e.message))?;
                entry.bytes = Some(new_bytes);
                entry.dirty = true;
            }
            BatchOp::Rename { name, new_name } => {
                let new_name = new_name.trim();
                if new_name.is_empty() {
                    return Err(format!("Rename {} of {n}: new_name is required.", i + 1));
                }
                let (id, real_name) = db::find_file_like(conn, name)
                    .map_err(|e| format!("Rename {} of {n} ({name}): {e}", i + 1))?;
                if !working.contains_key(&id) {
                    working.insert(
                        id.clone(),
                        FileWork { real_name: real_name.clone(), original: None, bytes: None, dirty: false, new_name: None },
                    );
                    order.push(id.clone());
                }
                let entry = working.get_mut(&id).unwrap();
                entry.new_name = Some(keep_ext(&entry.real_name, new_name));
            }
        }
    }

    // Build one plan per touched file, in first-touch order.
    let mut plans = Vec::with_capacity(order.len());
    for id in order {
        let entry = working.remove(&id).unwrap();
        let name_for_text = entry.new_name.clone().unwrap_or_else(|| entry.real_name.clone());
        if entry.dirty {
            let original = entry.original.unwrap_or_default();
            let new_bytes = entry.bytes.unwrap();
            let (before, after, clipped) = preview_pair(&name_for_text, &original, &new_bytes);
            plans.push(PlannedWrite {
                file_id: id,
                real_name: entry.real_name,
                new_bytes: Some(new_bytes),
                rename_to: entry.new_name,
                method: None,
                count: 1,
                staleness: Some(hash_bytes(&original)),
                before,
                after,
                clipped,
            });
        } else {
            // Rename-only: no byte change, no snapshot. The preview shows the
            // name change so the approval card still explains it.
            let new_name = entry.new_name.clone().unwrap_or_default();
            plans.push(PlannedWrite {
                file_id: id,
                before: format!("name: {}", entry.real_name),
                after: format!("name: {new_name}"),
                real_name: entry.real_name,
                new_bytes: None,
                rename_to: entry.new_name,
                method: None,
                count: 0,
                staleness: None,
                clipped: false,
            });
        }
    }
    Ok(plans)
}

/// Validate every op then apply all of them in one `BEGIN IMMEDIATE` transaction:
/// a five-file refactor (or a rename + reference edits) either fully lands or
/// fully doesn't, every snapshot sharing one `AI edit (batch …)` cause. The tests'
/// reference path; the tool arm goes through `plan_batch` + the diff-preview gate
/// + `commit_plans`, which is the same code path.
#[cfg(test)]
pub(crate) fn run_edit_files(conn: &Connection, ops: &[BatchOp]) -> Result<BatchApplied, String> {
    let plans = plan_batch(conn, ops)?;
    let batch_id: String = Uuid::new_v4().to_string().chars().take(8).collect();
    let cause = format!("AI edit (batch {batch_id})");
    commit_plans(conn, &plans, &cause)?;
    let (edits, renames) = count_batch_ops(ops);
    let files = plans
        .iter()
        .map(|p| (p.file_id.clone(), p.rename_to.clone().unwrap_or_else(|| p.real_name.clone())))
        .collect();
    Ok(BatchApplied { batch_id, edits, renames, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed a text file with exact bytes and return its id.
    fn seed_text_file(conn: &Connection, name: &str, content: &str) -> String {
        db::insert_file(conn, name, "text/plain", content.as_bytes(), Some(content), "upload")
            .unwrap()
            .id
    }

    fn current_bytes(conn: &Connection, id: &str) -> Vec<u8> {
        db::get_file_bytes(conn, id).unwrap().unwrap()
    }

    #[test]
    fn fold_table_covers_quotes_nbsp_crlf_dashes() {
        // Straight/plain-space/LF needle folds to meet a curly/NBSP/CRLF/dash file.
        assert!(matches!(
            fuzzy_find("say \u{201C}hi\u{201D} now", "say \"hi\" now"),
            FuzzyFind::Unique(_)
        ));
        assert!(matches!(
            fuzzy_find("a\u{00A0}b\r\nc", "a b c"),
            FuzzyFind::Unique(_)
        ));
        assert!(matches!(
            fuzzy_find("it\u{2019}s en\u{2013}dash", "it's en-dash"),
            FuzzyFind::Unique(_)
        ));
        // A zero-width joiner in the file is dropped, not a barrier.
        assert!(matches!(
            fuzzy_find("wor\u{200B}d here", "word here"),
            FuzzyFind::Unique(_)
        ));
        // fi ligature in the FILE, ASCII in the needle (the realistic direction).
        assert!(matches!(
            fuzzy_find("the \u{FB01}nal draft", "the final draft"),
            FuzzyFind::Unique(_)
        ));
    }

    #[test]
    fn fuzzy_find_returns_exact_byte_span_on_multibyte_text() {
        // Hebrew + curly quotes: the returned range must slice the ORIGINAL cleanly.
        let content = "פתיח \u{201C}שלום עולם\u{201D} סוף";
        match fuzzy_find(content, "\"שלום עולם\"") {
            FuzzyFind::Unique(range) => {
                let hit = &content[range];
                assert_eq!(hit, "\u{201C}שלום עולם\u{201D}");
            }
            _ => panic!("expected a unique multibyte hit"),
        }
    }

    #[test]
    fn fuzzy_requires_uniqueness() {
        // A needle that appears twice post-normalization is Ambiguous, not Unique.
        match fuzzy_find("the fee is 5% and the fee is 5% again", "the fee is 5%") {
            FuzzyFind::Ambiguous(n) => assert_eq!(n, 2),
            _ => panic!("expected ambiguous"),
        }
        // An empty / whitespace-only needle never matches.
        assert!(matches!(fuzzy_find("abc", "   "), FuzzyFind::NotFound));
    }

    #[test]
    fn fuzzy_does_not_match_across_a_blank_line() {
        // A single-space needle must NOT splice two paragraphs into one (the docx
        // matcher refuses this too; the text side now mirrors it).
        assert!(matches!(
            fuzzy_find("end of one.\n\nStart of two.", "one. Start"),
            FuzzyFind::NotFound
        ));
        // A single newline (wrapped line) still matches.
        assert!(matches!(
            fuzzy_find("end of one\nStart of two", "one Start"),
            FuzzyFind::Unique(_)
        ));
    }

    #[test]
    fn exact_multi_occurrence_errors_without_all_and_replaces_with_all() {
        let conn = db::open_in_memory_schema();
        let id = seed_text_file(&conn, "notes.md", "cost is 5. cost is 5. done.");
        // Without `all`, a doubly-present exact needle errors (no write).
        let err = run_edit_file(&conn, "notes.md", "cost is 5", "cost is 7", false).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        assert!(err.message.contains("appears 2 times"));
        assert!(err.message.contains("all: true"));
        assert_eq!(current_bytes(&conn, &id), b"cost is 5. cost is 5. done.");
        // With `all`, both are replaced.
        let ok = run_edit_file(&conn, "notes.md", "cost is 5", "cost is 7", true).unwrap();
        assert_eq!(ok.method, EditMethod::ExactAll);
        assert_eq!(ok.count, 2);
        assert_eq!(current_bytes(&conn, &id), b"cost is 7. cost is 7. done.");
    }

    #[test]
    fn fuzzy_multi_match_error_does_not_advise_all_true() {
        // Second-pass addendum: the fuzzy path cannot honor `all`, so its
        // ambiguity error must not advise it — even when `all: true` is passed.
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "say \u{201C}hi\u{201D} and say \u{201C}hi\u{201D}");
        let err = run_edit_file(&conn, "n.md", "say \"hi\"", "say bye", true).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        assert!(!err.message.contains("all: true"), "must not advise all: {}", err.message);
        assert!(err.message.contains("more surrounding text"));
    }

    #[test]
    fn run_edit_file_end_to_end_snapshots_and_reindexes() {
        let conn = db::open_in_memory_schema();
        let id = seed_text_file(
            &conn,
            "memo.md",
            "The \u{201C}smart quotes\u{201D} and\u{00A0}the septillion figure.\r\n",
        );
        // Straight quotes, plain space, LF — all drifted from the file.
        let applied = run_edit_file(
            &conn,
            "memo.md",
            "\"smart quotes\" and the septillion figure.",
            "the corrected octillion figure.",
            false,
        )
        .unwrap();
        assert_eq!(applied.method, EditMethod::Fuzzy);
        assert_eq!(applied.file_id, id);
        assert_eq!(applied.real_name, "memo.md");
        let new = String::from_utf8(current_bytes(&conn, &id)).unwrap();
        assert!(new.contains("octillion"), "bytes updated: {new}");
        assert!(!new.contains("septillion"));
        // One snapshot with the AI-edit cause.
        let versions = db::list_file_versions(&conn, &id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].cause, "AI edit");
        // FTS finds the new text.
        let hits = db::search_chunks_fts(&conn, "octillion", 5).unwrap();
        assert!(!hits.is_empty(), "reindexed text should be searchable");
    }

    #[test]
    fn docx_multi_occurrence_errors_without_all_and_replaces_with_all() {
        // Idea 4 review amendment: the replace-all kill applies to .docx too.
        let conn = db::open_in_memory_schema();
        let docx = crate::extraction::fake_office_zip(
            "word/document.xml",
            r#"<w:document><w:p><w:t>fee is 5% and fee is 5%</w:t></w:p></w:document>"#,
        );
        let id = db::insert_file(&conn, "c.docx", "application/docx", &docx, Some("fee is 5% and fee is 5%"), "upload")
            .unwrap()
            .id;
        let err = run_edit_file(&conn, "c.docx", "fee is 5%", "fee is 7%", false).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        assert!(err.message.contains("all: true"));
        // Untouched.
        assert_eq!(current_bytes(&conn, &id), docx);
        // With all → both replaced, round-trips through extract_text.
        let ok = run_edit_file(&conn, "c.docx", "fee is 5%", "fee is 7%", true).unwrap();
        assert_eq!(ok.method, EditMethod::Docx);
        let text = crate::extraction::extract_text("c.docx", &current_bytes(&conn, &id)).unwrap();
        assert!(text.contains("fee is 7% and fee is 7%"), "got: {text}");
    }

    #[test]
    fn html_edit_steers_to_write_file() {
        // Idea 4 scope decision: edit_file refuses .html with a targeted message.
        let conn = db::open_in_memory_schema();
        db::insert_file(&conn, "note.html", "text/html", b"<p>hi</p>", Some("hi"), "generated").unwrap();
        let err = run_edit_file(&conn, "note.html", "hi", "bye", false).unwrap_err();
        assert_eq!(err.outcome, "wrong_type");
        assert!(err.message.contains("write_file"), "got: {}", err.message);
    }

    #[test]
    fn run_edit_file_not_found_carries_closest_hint() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "terms.txt", "Payment is due within thirty days of invoice.");
        let err = run_edit_file(
            &conn,
            "terms.txt",
            "payment due within ninety days of invoice",
            "x",
            false,
        )
        .unwrap_err();
        assert_eq!(err.outcome, "not_found");
        assert!(err.message.contains("closest text"), "got: {}", err.message);
    }

    #[test]
    fn edit_files_is_atomic_on_late_failure() {
        let conn = db::open_in_memory_schema();
        let a = seed_text_file(&conn, "a.md", "alpha here");
        let b = seed_text_file(&conn, "b.md", "beta here");
        let ops = vec![
            BatchOp::Edit { name: "a.md".into(), old_text: "alpha".into(), new_text: "ALPHA".into() },
            BatchOp::Edit { name: "b.md".into(), old_text: "nonexistent".into(), new_text: "x".into() },
        ];
        let err = run_edit_files(&conn, &ops).unwrap_err();
        assert!(err.starts_with("Edit 2 of 2"), "names the failing edit: {err}");
        // Neither file changed; zero version rows.
        assert_eq!(current_bytes(&conn, &a), b"alpha here");
        assert_eq!(current_bytes(&conn, &b), b"beta here");
        assert!(db::list_file_versions(&conn, &a).unwrap().is_empty());
        assert!(db::list_file_versions(&conn, &b).unwrap().is_empty());
    }

    #[test]
    fn edit_files_applies_all_and_tags_shared_cause() {
        let conn = db::open_in_memory_schema();
        let a = seed_text_file(&conn, "a.md", "the wibble value");
        let b = seed_text_file(&conn, "b.md", "another wobble value");
        let ops = vec![
            BatchOp::Edit { name: "a.md".into(), old_text: "wibble".into(), new_text: "quux".into() },
            BatchOp::Edit { name: "b.md".into(), old_text: "wobble".into(), new_text: "quux".into() },
        ];
        let applied = run_edit_files(&conn, &ops).unwrap();
        assert_eq!(applied.edits, 2);
        assert_eq!(applied.files.len(), 2);
        assert!(String::from_utf8(current_bytes(&conn, &a)).unwrap().contains("quux"));
        assert!(String::from_utf8(current_bytes(&conn, &b)).unwrap().contains("quux"));
        let va = db::list_file_versions(&conn, &a).unwrap();
        let vb = db::list_file_versions(&conn, &b).unwrap();
        assert_eq!(va[0].cause, vb[0].cause);
        assert!(va[0].cause.contains(&format!("batch {}", applied.batch_id)));
        assert!(!db::search_chunks_fts(&conn, "quux", 5).unwrap().is_empty());
    }

    #[test]
    fn edit_files_chains_edits_to_same_file_into_one_snapshot() {
        let conn = db::open_in_memory_schema();
        let a = seed_text_file(&conn, "a.md", "one two three");
        let ops = vec![
            BatchOp::Edit { name: "a.md".into(), old_text: "one".into(), new_text: "1".into() },
            BatchOp::Edit { name: "a.md".into(), old_text: "three".into(), new_text: "3".into() },
        ];
        run_edit_files(&conn, &ops).unwrap();
        assert_eq!(current_bytes(&conn, &a), b"1 two 3");
        // Two edits to one file → exactly one snapshot.
        assert_eq!(db::list_file_versions(&conn, &a).unwrap().len(), 1);
    }

    #[test]
    fn edit_files_rename_and_edit_are_atomic_together() {
        // Coverage-sweep (Idea 7): rename + edit in one batch either both land or
        // neither does. Here they both land, in one transaction.
        let conn = db::open_in_memory_schema();
        let a = seed_text_file(&conn, "draft.md", "hello world");
        let ops = vec![
            BatchOp::Rename { name: "draft.md".into(), new_name: "final".into() },
            BatchOp::Edit { name: "draft.md".into(), old_text: "hello".into(), new_text: "goodbye".into() },
        ];
        let applied = run_edit_files(&conn, &ops).unwrap();
        assert_eq!(applied.renames, 1);
        assert_eq!(applied.edits, 1);
        // One touched file (same id resolved for both ops), renamed + edited.
        assert_eq!(applied.files.len(), 1);
        assert_eq!(applied.files[0].1, "final.md"); // extension kept
        assert_eq!(current_bytes(&conn, &a), b"goodbye world");
        assert_eq!(db::get_file_name(&conn, &a).unwrap(), "final.md");
        // Still one snapshot for the byte change.
        assert_eq!(db::list_file_versions(&conn, &a).unwrap().len(), 1);
    }

    #[test]
    fn edit_files_rolls_back_a_failing_rename_with_a_valid_edit() {
        let conn = db::open_in_memory_schema();
        let a = seed_text_file(&conn, "a.md", "keep me");
        let ops = vec![
            BatchOp::Edit { name: "a.md".into(), old_text: "keep".into(), new_text: "drop".into() },
            BatchOp::Rename { name: "does-not-exist".into(), new_name: "x".into() },
        ];
        let err = run_edit_files(&conn, &ops).unwrap_err();
        assert!(err.starts_with("Rename 2 of 2"), "got: {err}");
        // The valid edit rolled back with the invalid rename.
        assert_eq!(current_bytes(&conn, &a), b"keep me");
        assert!(db::list_file_versions(&conn, &a).unwrap().is_empty());
    }

    #[test]
    fn edit_files_rejects_oversize_batch() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "a.md", "x");
        let ops: Vec<BatchOp> = (0..MAX_BATCH_EDITS + 1)
            .map(|_| BatchOp::Edit { name: "a.md".into(), old_text: "x".into(), new_text: "y".into() })
            .collect();
        let err = run_edit_files(&conn, &ops).unwrap_err();
        assert!(err.contains("Too many"), "got: {err}");
    }

    #[test]
    fn batch_op_deserializes_serde_tagged() {
        // The serde-tagged form the tool spec documents round-trips.
        let e: BatchOp =
            serde_json::from_value(serde_json::json!({"op":"edit","name":"a","old_text":"x","new_text":"y"}))
                .unwrap();
        assert_eq!(e, BatchOp::Edit { name: "a".into(), old_text: "x".into(), new_text: "y".into() });
        let r: BatchOp =
            serde_json::from_value(serde_json::json!({"op":"rename","name":"a","new_name":"b"})).unwrap();
        assert_eq!(r, BatchOp::Rename { name: "a".into(), new_name: "b".into() });
    }
}
