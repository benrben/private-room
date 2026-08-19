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

impl NormText {
    /// Two neighbouring entries carrying the SAME source span are the two halves
    /// of one ligature (`FoldOut::Pair` is the only producer that pushes a span
    /// twice). A match that begins on the second half or ends on the first
    /// covers half a character, and splicing its byte range would delete the
    /// other half — one letter more than the quote asked for, reported as a
    /// clean single replacement.
    fn splits_a_ligature(&self, first: usize, last: usize) -> bool {
        let begins_mid = first > 0 && self.spans[first - 1] == self.spans[first];
        let ends_mid = last + 1 < self.spans.len() && self.spans[last] == self.spans[last + 1];
        begins_mid || ends_mid
    }
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
        if h[i..i + n] == needle[..] && !hay.splits_a_ligature(i, i + n - 1) {
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
    Html,
}

impl EditMethod {
    pub(crate) fn outcome(self) -> &'static str {
        match self {
            EditMethod::Exact => "exact",
            EditMethod::ExactAll => "exact_all",
            EditMethod::Fuzzy => "fuzzy",
            EditMethod::Docx => "docx",
            EditMethod::Html => "html",
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

/// Extra disambiguation `edit_file` can supply beyond the bare quote: text
/// that must sit immediately before/after the match, which occurrence
/// (1-based) among several identical matches to pick, or which heading's
/// section to scope the match to. `edit_files` has none of these fields (same
/// reasoning as `all`'s `all_offered` split above).
///
/// `prefix_context`/`suffix_context`/`occurrence` are scoped to files whose
/// branch of `compute_edit_bytes` can enumerate EVERY candidate span up front
/// — today that is the exact-match text-file path. docx and HTML
/// replace-and-count in one pass without exposing per-candidate positions to
/// filter, so those three get an honest "not available for this file type"
/// there rather than being silently ignored or a fragile retrofit. `section`
/// is a narrower text-selection concern (E6) and is handled per file type
/// (HTML and Markdown), independent of that restriction.
#[derive(Default, Clone, Copy)]
pub(crate) struct EditRefinements<'a> {
    pub prefix_context: Option<&'a str>,
    pub suffix_context: Option<&'a str>,
    pub occurrence: Option<usize>,
    pub section: Option<&'a str>,
}

impl EditRefinements<'_> {
    pub(crate) fn is_empty(&self) -> bool {
        self.prefix_context.is_none()
            && self.suffix_context.is_none()
            && self.occurrence.is_none()
            && self.section.is_none()
    }

    /// The subset of refinements docx/HTML must refuse outright (E3/E4) —
    /// `section` is excluded because it IS supported there, just via a
    /// different mechanism (see the file-type-specific branches).
    fn has_positional_refinement(&self) -> bool {
        self.prefix_context.is_some() || self.suffix_context.is_some() || self.occurrence.is_some()
    }
}

/// A single edit as the diff-preview gate receives it (edit_file → one of these).
pub(crate) struct PreviewEdit {
    pub name: String,
    pub old_text: String,
    pub new_text: String,
    pub all: bool,
    pub prefix_context: Option<String>,
    pub suffix_context: Option<String>,
    pub occurrence: Option<usize>,
    pub section: Option<String>,
}

/// Preview text stays bounded so a huge file's diff can't blow the IPC payload.
const PREVIEW_CLIP: usize = 200_000;

/// Largest file the forgiving (fuzzy) fallback will scan. `normalize_with_spans`
/// builds a `Vec<char>` AND a `Range<usize>` per char — roughly 20–40× the
/// file's size in memory — and it all happens while the room lock is held, so
/// the whole app is frozen for the duration. Above this the exact match stands
/// on its own.
const MAX_FUZZY_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn hash_bytes(b: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().into()
}

/// Human-readable rendering of a file's bytes for the diff card — extracted text
/// for binary office formats, the file's own text encoding for everything else.
/// A lossy UTF-8 read turned every windows-1252/1255 byte into U+FFFD, so the
/// card described a legacy-encoded file as boxes and `write_file_summary`
/// counted its lines against that same corrupted string; `decode_text_bytes` is
/// what the viewer and the search index already read it with.
fn render_for_preview(real_name: &str, bytes: &[u8]) -> String {
    let ext = extraction::extension_of(real_name);
    match ext.as_str() {
        "docx" | "xlsx" | "xls" | "pdf" | "pptx" => {
            extraction::extract_text(real_name, bytes).unwrap_or_default()
        }
        _ => extraction::decode_text_bytes(bytes),
    }
}

/// First byte position where two renderings differ, or the shorter length when
/// one is a prefix of the other.
fn first_difference(a: &str, b: &str) -> usize {
    a.as_bytes()
        .iter()
        .zip(b.as_bytes())
        .position(|(x, y)| x != y)
        .unwrap_or_else(|| a.len().min(b.len()))
}

/// One pane clipped to `PREVIEW_CLIP` bytes from `start`. A window that doesn't
/// begin at byte 0 is marked, because `dry_run_summary` quotes this same string
/// as what the file "would start" with.
fn preview_window(s: &str, start: usize) -> String {
    let end = floor_boundary(s, start.saturating_add(PREVIEW_CLIP));
    if start == 0 {
        return s[..end].to_string();
    }
    format!("…{}", &s[start..end])
}

/// Both panes clipped to the SAME window, positioned so the first place they
/// differ falls inside it. Clipping from byte 0 drew two identical heads for
/// any change past `PREVIEW_CLIP`: the card showed no diff at all and still
/// asked for approval, so a change in a 1 MB file's last chapter was approved
/// unseen.
fn clip_to_change(before: String, after: String) -> (String, String, bool) {
    if before.len() <= PREVIEW_CLIP && after.len() <= PREVIEW_CLIP {
        return (before, after, false);
    }
    let diff_at = first_difference(&before, &after);
    // Renderings that really are identical (an office file whose extracted text
    // is unchanged) have no changed region to centre on — keep the head.
    let start = if diff_at == before.len() && diff_at == after.len() {
        0
    } else {
        // A quarter of the budget of unchanged lead-in for context. Every byte
        // before `diff_at` is shared, so a char boundary there is a boundary in
        // both strings.
        floor_boundary(&before, diff_at.saturating_sub(PREVIEW_CLIP / 4))
    };
    (preview_window(&before, start), preview_window(&after, start), true)
}

fn preview_pair(real_name: &str, before_bytes: &[u8], after_bytes: &[u8]) -> (String, String, bool) {
    let before = render_for_preview(real_name, before_bytes);
    let after = render_for_preview(real_name, after_bytes);
    clip_to_change(before, after)
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
                // Derive the searchable text with the name whose format the
                // BYTES are in — the current one — exactly as the preview does.
                // Reading them through the NEW name meant a batch that edited a
                // .docx and renamed it to .md stored the zip decoded as text, so
                // search and every retrieved context carried binary mojibake.
                let text = extraction::extract_text(&p.real_name, bytes)
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
    let refine = EditRefinements {
        prefix_context: edit.prefix_context.as_deref(),
        suffix_context: edit.suffix_context.as_deref(),
        occurrence: edit.occurrence,
        section: edit.section.as_deref(),
    };
    let (id, real_name, new_bytes, count, method) =
        compute_edit(conn, &edit.name, &edit.old_text, &edit.new_text, edit.all, refine)?;
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

/// The ambiguity error, worded for the tool that will read it.
///
/// `all_offered` is whether the CALLING TOOL actually has an `all` field.
/// `edit_file` does; `edit_files` (the batch) does not, and advising it there
/// sent the model round a retry that came back with the identical error before
/// it fell back to the advice that works. Same reason the fuzzy branch below
/// has its own message.
fn multi_occurrence_error(
    old_text: &str,
    n: usize,
    real_name: &str,
    all_offered: bool,
) -> String {
    let quote = clamp_bytes(old_text.to_string(), 80);
    if all_offered {
        format!(
            "\"{quote}\" appears {n} times in \"{real_name}\". Include more surrounding text to \
             pick one, or pass all: true to replace every occurrence."
        )
    } else {
        format!(
            "\"{quote}\" appears {n} times in \"{real_name}\". Include more surrounding text in \
             old_text so it identifies exactly one place — edit_files has no all option; use \
             edit_file for a replace-every-occurrence change."
        )
    }
}

/// E6 (2026-08-04): `section` named a heading that doesn't exist in the file.
/// Lists every real heading found — never falls back to searching the whole
/// document, which would defeat the point of scoping the edit.
fn section_not_found_error(section: &str, real_name: &str, headings: &[String]) -> String {
    if headings.is_empty() {
        format!("\"{real_name}\" has no headings to scope a section to.")
    } else {
        format!(
            "No section called \"{section}\" in \"{real_name}\". The headings there are: {}.",
            headings.iter().map(|h| format!("\"{h}\"")).collect::<Vec<_>>().join(", ")
        )
    }
}

/// One ATX (`#`-prefixed) Markdown heading: `#`-count = level (1-6), a space
/// required after the hashes (CommonMark's rule — keeps a code comment like
/// `#!/usr/bin/env` from being misread as a heading).
struct MarkdownHeading {
    level: usize,
    text: String,
    /// Byte position where this heading's own line starts — where the
    /// PRECEDING section ends.
    line_start: usize,
    /// Byte position right after this heading's line — where the section it
    /// introduces begins.
    section_start: usize,
}

/// E6's Markdown counterpart to `extraction::find_section_range`. Same
/// same-or-higher-level rule (a sub-heading doesn't end its parent's
/// section). Does NOT skip fenced code blocks — a `#` comment inside a
/// ```block``` could be misread as a heading; narrow but real limitation,
/// left for a future pass rather than adding a fence-tracking scanner now.
fn find_markdown_section_range(content: &str, section: &str) -> Result<Range<usize>, Vec<String>> {
    let mut headings = Vec::new();
    let mut pos = 0usize;
    for line in content.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        let hashes = trimmed.chars().take_while(|&c| c == '#').count();
        let has_space_after = trimmed.as_bytes().get(hashes).is_some_and(|&b| b == b' ' || b == b'\t');
        if (1..=6).contains(&hashes) && has_space_after {
            headings.push(MarkdownHeading {
                level: hashes,
                text: trimmed[hashes..].trim().to_string(),
                line_start: pos,
                section_start: pos + line.len(),
            });
        }
        pos += line.len();
    }
    let needle = normalize_needle(section);
    match headings.iter().position(|h| normalize_needle(&h.text) == needle) {
        None => Err(headings.into_iter().map(|h| h.text).collect()),
        Some(i) => {
            let level = headings[i].level;
            let start = headings[i].section_start;
            let end = headings[i + 1..]
                .iter()
                .find(|h| h.level <= level)
                .map(|h| h.line_start)
                .unwrap_or(content.len());
            Ok(start..end)
        }
    }
}

/// The file is past `MAX_FUZZY_BYTES`, so only an exact quote is offered.
fn too_large_for_fuzzy_error(real_name: &str) -> String {
    format!(
        "Could not find that exact text in \"{real_name}\". This file is too \
         large for the forgiving match, so the quote has to be exact — copy \
         it from the file, including spacing and punctuation."
    )
}

/// A1: `all: true` reached the forgiving matcher, which cannot promise "every
/// occurrence" of a quote it only matched approximately.
fn all_needs_exact_error(old_text: &str, real_name: &str) -> String {
    format!(
        "\"{}\" doesn't appear in \"{real_name}\" byte-for-byte, so all: true \
         can't be honored safely — it only matched approximately. Copy the text \
         exactly as it appears (including spacing and punctuation), or drop \
         all: true to change just the one closest match.",
        clamp_bytes(old_text.to_string(), 80)
    )
}

/// The "nothing matched" message for a refined edit, naming ONLY the
/// refinements the caller actually passed. It used to name all three
/// unconditionally, so a `section`-scoped edit was told to drop
/// prefix_context/suffix_context/occurrence it had never sent — advice that
/// changes nothing on the retry. Callers reach this only with a positional
/// refinement in play (a `section`-only miss goes to `fuzzy_in_section`).
fn refinement_not_found_error(real_name: &str, refine: &EditRefinements<'_>) -> String {
    let section_note =
        refine.section.map(|s| format!(" in the \"{s}\" section")).unwrap_or_default();
    let mut named: Vec<&str> = Vec::new();
    if refine.prefix_context.is_some() {
        named.push("prefix_context");
    }
    if refine.suffix_context.is_some() {
        named.push("suffix_context");
    }
    if refine.occurrence.is_some() {
        named.push("occurrence");
    }
    let (verb, them) = if named.len() == 1 { ("needs", "it") } else { ("need", "them") };
    format!(
        "Could not find that exact text in \"{real_name}\"{section_note}. {} {verb} old_text to \
         match EXACTLY — copy it exactly, including spacing and punctuation, or drop {them} and \
         let the forgiving match try.",
        named.join(" and ")
    )
}

/// The plain text path's fuzzy fallback, scoped to one Markdown section.
/// `section` narrows WHERE to look; it is not a claim that the quote is
/// byte-perfect, so a quote that the forgiving matcher would have found in the
/// whole file must still be found inside the section — otherwise scoping an
/// edit to a heading silently turned the tolerant matcher off. The HTML branch
/// already works this way. `fuzzy_find` reports positions relative to the
/// section, so the hit is offset by the section's start before splicing.
fn fuzzy_in_section(
    real_name: &str,
    content: &str,
    range: &Range<usize>,
    old_text: &str,
    new_text: &str,
    all: Option<bool>,
    section: &str,
) -> Result<(Vec<u8>, usize, EditMethod), EditError> {
    if content.len() > MAX_FUZZY_BYTES {
        return Err(EditError::new(too_large_for_fuzzy_error(real_name), "not_found"));
    }
    if all == Some(true) {
        return Err(EditError::new(all_needs_exact_error(old_text, real_name), "all_needs_exact"));
    }
    let scope = &content[range.clone()];
    match fuzzy_find(scope, old_text) {
        FuzzyFind::Unique(hit) => {
            let mut out = content.to_string();
            out.replace_range(range.start + hit.start..range.start + hit.end, new_text);
            Ok((out.into_bytes(), 1, EditMethod::Fuzzy))
        }
        FuzzyFind::Ambiguous(n) => Err(EditError::new(
            format!(
                "That text appears in {n} places in the \"{section}\" section of \"{real_name}\" \
                 with slightly different spacing or punctuation. Include more surrounding text \
                 so it matches exactly one place."
            ),
            "ambiguous",
        )),
        FuzzyFind::NotFound => {
            let hint = closest_snippet(scope, old_text)
                .map(|s| format!(" The closest text there is: \"{}\".", clamp_bytes(s, 200)))
                .unwrap_or_default();
            Err(EditError::new(
                format!(
                    "Could not find that text in the \"{section}\" section of \"{real_name}\". \
                     Copy it from that section, or drop section to search the whole file.{hint}"
                ),
                "not_found",
            ))
        }
    }
}

/// Resolve `old_text` against `content` using `prefix_context`/`suffix_context`/
/// `occurrence` (E3/E4, 2026-08-04) instead of the ambiguity-or-unique guard
/// the plain path uses. A POSITIONAL refinement requires an EXACT (non-fuzzy)
/// quote — it is meant to narrow candidates the model already found via
/// search_room/open_file, not to also absorb typographic drift, and combining
/// both would make a wrong-candidate pick unfalsifiable. `section` carries no
/// such claim: on its own it only says WHERE to look, so a miss there falls
/// through to `fuzzy_in_section`. Enumerates every candidate span up front
/// (`match_indices`), which is why this needs its own function rather than
/// reusing `fuzzy_find`'s Unique/Ambiguous/NotFound shape.
fn resolve_with_refinements(
    real_name: &str,
    content: &str,
    old_text: &str,
    new_text: &str,
    all: Option<bool>,
    refine: &EditRefinements<'_>,
) -> Result<(Vec<u8>, usize, EditMethod), EditError> {
    // E6: the top-level guard in compute_edit_bytes already restricted
    // `section` to html/htm/md/markdown, and the HTML branch never reaches
    // this function — so a non-empty section here always means Markdown.
    // Filter candidates to the section's range rather than slicing `content`:
    // every downstream position (context checks, the final splice) then stays
    // relative to the FULL original text, with nothing to re-index.
    let section_range = match refine.section {
        Some(section) => match find_markdown_section_range(content, section) {
            Ok(range) => Some(range),
            Err(headings) => {
                return Err(EditError::new(section_not_found_error(section, real_name, &headings), "not_found"));
            }
        },
        None => None,
    };
    let candidates: Vec<(usize, usize)> = content
        .match_indices(old_text)
        .map(|(s, m)| (s, s + m.len()))
        .filter(|&(s, e)| section_range.as_ref().map_or(true, |r| s >= r.start && e <= r.end))
        .collect();
    if candidates.is_empty() {
        // A positional refinement keeps the exact-quote rule (see above): it
        // narrows candidates the model already read, and absorbing typographic
        // drift as well would make a wrong-candidate pick unfalsifiable. A
        // `section` alone carries no such claim, so the forgiving matcher runs
        // inside it.
        if let (Some(range), Some(section), false) =
            (&section_range, refine.section, refine.has_positional_refinement())
        {
            return fuzzy_in_section(real_name, content, range, old_text, new_text, all, section);
        }
        return Err(EditError::new(refinement_not_found_error(real_name, refine), "not_found"));
    }
    let filtered: Vec<(usize, usize)> = match (refine.prefix_context, refine.suffix_context) {
        (None, None) => candidates,
        (pre, suf) => {
            let kept: Vec<(usize, usize)> = candidates
                .iter()
                .copied()
                .filter(|&(s, e)| {
                    pre.map_or(true, |p| content[..s].ends_with(p))
                        && suf.map_or(true, |sfx| content[e..].starts_with(sfx))
                })
                .collect();
            if kept.is_empty() {
                return Err(EditError::new(
                    format!(
                        "old_text matches in \"{real_name}\", but the surrounding text you gave \
                         doesn't appear next to it there. Copy prefix_context/suffix_context \
                         exactly as they appear too, or drop them."
                    ),
                    "not_found",
                ));
            }
            kept
        }
    };
    let chosen = match refine.occurrence {
        Some(n) => {
            if n == 0 || n > filtered.len() {
                return Err(EditError::new(
                    format!(
                        "old_text matches {} place(s) in \"{real_name}\"{}; occurrence must be \
                         between 1 and {}.",
                        filtered.len(),
                        if refine.prefix_context.is_some() || refine.suffix_context.is_some() {
                            " with that surrounding text"
                        } else {
                            ""
                        },
                        filtered.len()
                    ),
                    "not_found",
                ));
            }
            filtered[n - 1]
        }
        None => match filtered.len() {
            1 => filtered[0],
            n => {
                if all == Some(true) {
                    // The error below offers `all: true`; honouring it here is
                    // what makes that advice true for a refined edit. Spliced
                    // right-to-left so the spans still to come keep their
                    // offsets in the string being rewritten.
                    let mut out = content.to_string();
                    for &(s, e) in filtered.iter().rev() {
                        out.replace_range(s..e, new_text);
                    }
                    return Ok((out.into_bytes(), n, EditMethod::ExactAll));
                }
                // Only reached via edit_file (edit_files never has a non-empty
                // refine), so `all_offered=true` is always the right wording.
                return Err(EditError::new(
                    multi_occurrence_error(old_text, n, real_name, true).replace(
                        "Include more surrounding text",
                        "Add prefix_context/suffix_context, pass occurrence, or include more \
                         surrounding text",
                    ),
                    "ambiguous",
                ));
            }
        },
    };
    let mut out = content.to_string();
    out.replace_range(chosen.0..chosen.1, new_text);
    Ok((out.into_bytes(), 1, EditMethod::Exact))
}

/// Pure over bytes: compute the new bytes for one file's content, no writes. The
/// uniqueness guard fires for BOTH the text branch and the docx branch. Shared by
/// the single edit, the batch executor (over chained working bytes), and the
/// diff-preview gate (proposed bytes without writing).
/// `all` is `None` when the calling tool has NO `all` field at all (the batch
/// `edit_files`), which is different from a caller that has one and left it
/// off — only the second can be told to pass it.
pub(crate) fn compute_edit_bytes(
    real_name: &str,
    bytes: &[u8],
    old_text: &str,
    new_text: &str,
    all: Option<bool>,
    refine: EditRefinements<'_>,
) -> Result<(Vec<u8>, usize, EditMethod), EditError> {
    let ext = extraction::extension_of(real_name);
    // Context/occurrence need every candidate span enumerated up front — only
    // the exact-match text-file branch below does that today. docx and HTML
    // replace-and-count in one pass; refusing honestly here beats silently
    // ignoring a field the model was told would narrow the match. `section`
    // is excluded from this check — it's handled per file type below (E6).
    if refine.has_positional_refinement() && matches!(ext.as_str(), "docx" | "html" | "htm") {
        return Err(EditError::new(
            format!(
                "prefix_context/suffix_context/occurrence aren't available for \"{real_name}\" \
                 yet. Add more surrounding text to old_text instead, or pass all: true."
            ),
            "wrong_type",
        ));
    }
    // E6 (2026-08-04): section scoping needs a heading structure to scope TO —
    // built for HTML and Markdown; every other type refuses honestly rather
    // than silently searching the whole file.
    if refine.section.is_some() && !matches!(ext.as_str(), "html" | "htm" | "md" | "markdown") {
        return Err(EditError::new(
            format!(
                "section isn't available for \"{real_name}\" yet — it works on .html and \
                 .md/.markdown files. Add more surrounding text to old_text instead."
            ),
            "wrong_type",
        ));
    }
    match ext.as_str() {
        "docx" => {
            // docx_replace_text is pure (patched bytes + count, no write) and
            // replaces EVERY occurrence, so apply the same replace-all guard the
            // text branch has: >1 without `all` is discarded, not silently applied.
            let (new_bytes, count) = extraction::docx_replace_text(bytes, old_text, new_text)
                .map_err(|e| EditError::new(e, "not_found"))?;
            if count > 1 && all != Some(true) {
                return Err(EditError::new(
                    multi_occurrence_error(old_text, count, real_name, all.is_some()),
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
        // Wave E (2026-08-04): .html is the app's DEFAULT AI-document format, so
        // this was the one format `edit_file` refused outright — every change to
        // an agent-authored document had to go through `write_file`'s full
        // rewrite. `extraction::html_replace_text` matches against the page's
        // DECODED text (tag interiors, scripts and styles are never part of a
        // run) tolerant of the same typographic drift the plain-text branch
        // tolerates, then splices back into the raw markup by byte range — the
        // fold table was never the blocker; it just needed a position-preserving
        // scanner over HTML the way `scan_docx_text` already has one over Word
        // XML. A quote may span inline markup (`<b>`, `<span>`, `<a>`, …) but
        // never a block boundary (`</p>`, `</div>`, `</li>`, headings, table
        // rows/cells) — see `html_edit::BLOCK_CLOSE_TAGS`.
        "html" | "htm" => {
            let content = std::str::from_utf8(bytes)
                .map_err(|_| EditError::new(non_utf8_error(real_name), "wrong_type"))?;
            let escaped_new = crate::commands::docs_html::html_escape(new_text);
            // E6: scope the search to one heading's section by slicing the
            // document to its byte range first — html_replace_text itself
            // never learns about sections, it just gets a smaller haystack.
            let section_range: Option<std::ops::Range<usize>> = match refine.section {
                Some(section) => match extraction::find_section_range(content, section) {
                    Ok(range) => Some(range),
                    Err(headings) => {
                        return Err(EditError::new(section_not_found_error(section, real_name, &headings), "not_found"));
                    }
                },
                None => None,
            };
            let scope = section_range.as_ref().map_or(content, |r| &content[r.clone()]);
            let section_note = refine.section.map(|s| format!(" in the \"{s}\" section")).unwrap_or_default();
            match extraction::html_replace_text(scope, old_text, &escaped_new) {
                Ok((new_scope, count)) => {
                    if count > 1 && all != Some(true) {
                        return Err(EditError::new(
                            multi_occurrence_error(old_text, count, real_name, all.is_some()),
                            "ambiguous",
                        ));
                    }
                    let new_html = match &section_range {
                        // Splice the (possibly narrower) rewritten scope back
                        // into the full document at the same byte range.
                        Some(range) => {
                            let mut out = content.to_string();
                            out.replace_range(range.clone(), &new_scope);
                            out
                        }
                        None => new_scope,
                    };
                    Ok((new_html.into_bytes(), count, EditMethod::Html))
                }
                Err(_) => {
                    let plain = extraction::strip_html(scope);
                    let hint = closest_snippet(&plain, old_text)
                        .map(|s| format!(" The closest text on the page is: \"{}\".", clamp_bytes(s, 200)))
                        .unwrap_or_default();
                    Err(EditError::new(
                        format!(
                            "Could not find that exact text in \"{real_name}\"{section_note}. \
                             Copy it exactly, including spacing and punctuation.{hint}"
                        ),
                        "not_found",
                    ))
                }
            }
        }
        ext if extraction::is_text_extension(ext) => {
            // An edit rewrites the file's bytes. Reading non-UTF-8 bytes
            // lossily turns every unreadable byte into U+FFFD, so applying an
            // edit to a latin-1/windows-1252 file would silently replace all
            // its accented letters with boxes — for a one-word change.
            let content = std::str::from_utf8(bytes)
                .map_err(|_| EditError::new(non_utf8_error(real_name), "wrong_type"))?
                .to_string();
            if !refine.is_empty() {
                return resolve_with_refinements(real_name, &content, old_text, new_text, all, &refine);
            }
            let exact = content.matches(old_text).count();
            if exact == 1 {
                Ok((content.replace(old_text, new_text).into_bytes(), 1, EditMethod::Exact))
            } else if exact > 1 {
                if all == Some(true) {
                    Ok((
                        content.replace(old_text, new_text).into_bytes(),
                        exact,
                        EditMethod::ExactAll,
                    ))
                } else {
                    Err(EditError::new(
                        multi_occurrence_error(old_text, exact, real_name, all.is_some()),
                        "ambiguous",
                    ))
                }
            } else if content.len() > MAX_FUZZY_BYTES {
                // The forgiving matcher below materializes the whole file as a
                // `Vec<char>` plus a byte span per char — tens of times the
                // file's size in memory, all of it built under the room lock.
                // Past this size the exact match is the only one offered.
                Err(EditError::new(too_large_for_fuzzy_error(real_name), "not_found"))
            } else if all == Some(true) {
                // A1 (2026-08-04): reached only when NO byte-exact match exists
                // anywhere in the file — `all: true` asks to replace every
                // occurrence, but the fuzzy matcher tolerates typographic drift
                // the model can't see or verify, so "every occurrence" is not a
                // promise this path can honor safely. This previously fell
                // through to `fuzzy_find` below, which silently replaced ONE
                // match (when unique) with no mention that `all` went unused —
                // the model asked for every occurrence and was never told
                // whether it got one or all of them. One clean rule now covers
                // both the unique and ambiguous fuzzy cases: `all: true` always
                // needs an exact quote, full stop.
                Err(EditError::new(all_needs_exact_error(old_text, real_name), "all_needs_exact"))
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
    refine: EditRefinements<'_>,
) -> Result<(String, String, Vec<u8>, usize, EditMethod), EditError> {
    let (id, real_name) =
        db::find_file_like(conn, name).map_err(|e| EditError::new(e, "not_found"))?;
    let bytes = db::get_file_bytes(conn, &id)
        .map_err(|e| EditError::new(e, "wrong_type"))?
        .ok_or_else(|| EditError::new("File has no stored content.", "wrong_type"))?;
    let (new_bytes, count, method) =
        compute_edit_bytes(&real_name, &bytes, old_text, new_text, Some(all), refine)?;
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
    let (id, real_name, new_bytes, count, method) =
        compute_edit(conn, name, old_text, new_text, all, EditRefinements::default())?;
    let text = extraction::extract_text(&real_name, &new_bytes)
        .or_else(|| String::from_utf8(new_bytes.clone()).ok());
    store_file_bytes(conn, &id, &new_bytes, text.as_deref(), "AI edit")
        .map_err(|e| EditError::new(e, "error"))?;
    Ok(EditApplied { file_id: id, real_name, count, method })
}

/// `run_edit_file`'s sibling for E3/E4 tests: takes an `EditRefinements`
/// directly rather than growing `run_edit_file`'s own signature for every
/// existing call site.
#[cfg(test)]
pub(crate) fn run_edit_file_refined(
    conn: &Connection,
    name: &str,
    old_text: &str,
    new_text: &str,
    refine: EditRefinements<'_>,
) -> Result<EditApplied, EditError> {
    let (id, real_name, new_bytes, count, method) =
        compute_edit(conn, name, old_text, new_text, false, refine)?;
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
/// fields present (a `new_name` with no edit fields ⇒ rename).
///
/// A nameless entry is an ERROR, never a skip (2026-07-28). It used to
/// `continue`, so a batch of three where one entry lost its `name` applied the
/// other two and reported "Applied 2 change(s)" — the model had no way to learn
/// that a third of its work silently evaporated, and the tool's own headline
/// promise ("every edit is checked first, then all are applied together — if any
/// single edit can't match, none are applied") was already broken at the parse
/// step, before `plan_batch`'s atomic phase ever ran. `plan_batch` errors
/// per-index on an empty `old_text`; this is the same contract, one stage
/// earlier, in the same numbered style so a small model can act on it.
pub(crate) fn parse_batch_ops(args: &serde_json::Value) -> Result<Vec<BatchOp>, String> {
    let arr = args["edits"].as_array().ok_or(
        "Pass edits: [{name, old_text, new_text}] (or {name, new_name} to rename) — one array.",
    )?;
    let n = arr.len();
    let mut ops = Vec::new();
    for (i, e) in arr.iter().enumerate() {
        let name = e["name"].as_str().unwrap_or_default().trim().to_string();
        if name.is_empty() {
            return Err(format!(
                "Edit {} of {n}: name is required — every entry needs the file \
                 to change, e.g. {{\"name\": \"notes.md\", \"old_text\": \"…\", \
                 \"new_text\": \"…\"}}. Nothing was changed.",
                i + 1
            ));
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
                    // None, not Some(false): `edit_files` has no `all` field
                    // to pass, so the error must not tell the model to pass one.
                    // Same reasoning for refinements — `edit_files` has no
                    // context/occurrence fields either.
                    compute_edit_bytes(
                        &entry.real_name,
                        cur,
                        old_text,
                        new_text,
                        None,
                        EditRefinements::default(),
                    )
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
        if entry.dirty {
            let original = entry.original.unwrap_or_default();
            let new_bytes = entry.bytes.unwrap();
            // Render the preview with the file's CURRENT name — the bytes on
            // both sides are in the current format, and the edit was computed
            // against it. Using the new name meant a batch that renamed
            // notes.md → notes.docx drew both panes through the docx reader,
            // so the approval card was blank or gibberish for a change that
            // would then be saved perfectly correctly.
            let (before, after, clipped) = preview_pair(&entry.real_name, &original, &new_bytes);
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
    fn a_match_that_would_split_a_ligature_is_refused() {
        // Both halves of U+FB01 map back to the SAME source char, so a match
        // that starts on the `i` (or ends on the `f`) returned a span covering
        // the whole ligature: splicing it deleted a letter the quote never
        // named, reported as "Replaced 1 occurrence(s)".
        let file = "the \u{FB01}nal draft";
        assert!(matches!(fuzzy_find(file, "inal draft"), FuzzyFind::NotFound));
        assert!(matches!(fuzzy_find(file, "the f"), FuzzyFind::NotFound));
        // Covering the whole character still matches, spanning it exactly.
        match fuzzy_find(file, "the final draft") {
            FuzzyFind::Unique(range) => assert_eq!(&file[range], file),
            _ => panic!("the whole-character match must still resolve"),
        }
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
    fn a_batch_ambiguity_never_advises_an_option_edit_files_does_not_have() {
        // `edit_files` has no `all` field, so "pass all: true" is advice the
        // model cannot act on: it retries, gets the identical error, and only
        // then falls back to adding surrounding text. Steer it there first.
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "cost is 5. cost is 5. done.");
        let err = plan_batch(
            &conn,
            &[BatchOp::Edit {
                name: "n.md".into(),
                old_text: "cost is 5".into(),
                new_text: "cost is 7".into(),
            }],
        )
        .err()
        .expect("an ambiguous batch edit must not plan a write");
        assert!(!err.contains("all: true"), "must not advise all: {err}");
        assert!(err.contains("edit_file"), "must name the tool that can: {err}");
        // The single-file tool still offers it, because it still honours it.
        let single = run_edit_file(&conn, "n.md", "cost is 5", "cost is 7", false).unwrap_err();
        assert!(single.message.contains("all: true"), "{}", single.message);
    }

    #[test]
    fn fuzzy_ambiguous_match_error_does_not_advise_all_true_when_all_is_false() {
        // The `all: false` fuzzy-ambiguous path is untouched by A1: it never
        // reaches the new "all needs an exact quote" branch (all != Some(true)),
        // so it still asks for more surrounding text, not `all: true` — that
        // advice would loop a 4B model, since the fuzzy path never honors it.
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "say \u{201C}hi\u{201D} and say \u{201C}hi\u{201D}");
        let err = run_edit_file(&conn, "n.md", "say \"hi\"", "say bye", false).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        assert!(!err.message.contains("all: true"), "must not advise all: {}", err.message);
        assert!(err.message.contains("more surrounding text"));
    }

    #[test]
    fn all_true_with_only_a_fuzzy_match_is_refused_not_silently_applied() {
        // A1 (2026-08-04): previously, `all: true` with NO byte-exact match
        // anywhere silently fell through to fuzzy_find and replaced whatever
        // it found — one match if Unique, an unrelated "ambiguous" message if
        // not — never telling the model whether `all` was honored. One clean
        // rule now covers both: `all: true` always needs an exact quote.
        let conn = db::open_in_memory_schema();
        let id = seed_text_file(&conn, "n.md", "say \u{201C}hi\u{201D} once");
        // A single fuzzy-only match (curly quotes) — would have been Unique.
        let err = run_edit_file(&conn, "n.md", "say \"hi\"", "say bye", true).unwrap_err();
        assert_eq!(err.outcome, "all_needs_exact");
        assert!(err.message.contains("all: true"), "got: {}", err.message);
        assert!(err.message.contains("byte-for-byte"), "got: {}", err.message);
        // Untouched — the refusal must not write anything.
        assert_eq!(current_bytes(&conn, &id), b"say \xe2\x80\x9chi\xe2\x80\x9d once");
        // Dropping all: true still succeeds via the ordinary fuzzy path.
        let ok = run_edit_file(&conn, "n.md", "say \"hi\"", "say bye", false).unwrap();
        assert_eq!(ok.method, EditMethod::Fuzzy);
        assert_eq!(ok.count, 1);
    }

    #[test]
    fn all_true_with_a_fuzzy_ambiguous_match_gets_the_same_refusal_as_unique() {
        // Same rule applies whether the fuzzy path would have found one match
        // or several — `all: true` needs an exact quote either way, so the
        // model gets one consistent reason rather than two different messages
        // depending on how many drifted occurrences happened to exist.
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "say \u{201C}hi\u{201D} and say \u{201C}hi\u{201D}");
        let err = run_edit_file(&conn, "n.md", "say \"hi\"", "say bye", true).unwrap_err();
        assert_eq!(err.outcome, "all_needs_exact");
        assert!(err.message.contains("all: true"), "got: {}", err.message);
    }

    #[test]
    fn occurrence_selects_the_nth_and_leaves_the_rest() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "cost is 5. cost is 5. cost is 5.");
        let applied = run_edit_file_refined(
            &conn,
            "n.md",
            "cost is 5",
            "cost is 9",
            EditRefinements { occurrence: Some(2), ..Default::default() },
        )
        .unwrap();
        assert_eq!(applied.count, 1);
        let text = String::from_utf8(current_bytes(&conn, &applied.file_id)).unwrap();
        assert_eq!(text, "cost is 5. cost is 9. cost is 5.");
    }

    #[test]
    fn occurrence_out_of_range_reports_the_real_count() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "cost is 5. cost is 5.");
        let err = run_edit_file_refined(
            &conn,
            "n.md",
            "cost is 5",
            "cost is 9",
            EditRefinements { occurrence: Some(3), ..Default::default() },
        )
        .unwrap_err();
        assert!(err.message.contains("matches 2 place"), "got: {}", err.message);
        assert!(err.message.contains("between 1 and 2"), "got: {}", err.message);
    }

    #[test]
    fn context_disambiguates_a_repeated_quote() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "Q1: cost is 5. Q2: cost is 5.");
        let applied = run_edit_file_refined(
            &conn,
            "n.md",
            "cost is 5",
            "cost is 9",
            EditRefinements { prefix_context: Some("Q2: "), ..Default::default() },
        )
        .unwrap();
        let text = String::from_utf8(current_bytes(&conn, &applied.file_id)).unwrap();
        assert_eq!(text, "Q1: cost is 5. Q2: cost is 9.");
    }

    #[test]
    fn wrong_context_reports_it_rather_than_guessing() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "Q1: cost is 5. Q2: cost is 5.");
        let err = run_edit_file_refined(
            &conn,
            "n.md",
            "cost is 5",
            "cost is 9",
            EditRefinements { prefix_context: Some("Q3: "), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.outcome, "not_found");
        assert!(err.message.contains("doesn't appear next to it"), "got: {}", err.message);
    }

    #[test]
    fn occurrence_with_all_is_rejected_before_any_file_work() {
        // Exercised at the schema/dispatch layer in agent.rs; here we confirm
        // compute_edit_bytes itself never has to reconcile the two — the
        // conflict is caught before a PreviewEdit is even built. This test
        // guards the underlying resolver: occurrence still narrows correctly
        // even though `all` is a separate, file-wide concept it never sees.
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "cost is 5. cost is 5.");
        let applied = run_edit_file_refined(
            &conn,
            "n.md",
            "cost is 5",
            "cost is 9",
            EditRefinements { occurrence: Some(1), ..Default::default() },
        )
        .unwrap();
        assert_eq!(applied.count, 1);
    }

    #[test]
    fn refinements_are_not_available_for_html_or_docx_yet() {
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "note.html",
            "text/html",
            b"<p>cost is 5. cost is 5.</p>",
            Some("cost is 5. cost is 5."),
            "generated",
        )
        .unwrap();
        let err = run_edit_file_refined(
            &conn,
            "note.html",
            "cost is 5",
            "cost is 9",
            EditRefinements { occurrence: Some(1), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.outcome, "wrong_type");
        assert!(err.message.contains("aren't available"), "got: {}", err.message);
    }

    #[test]
    fn section_scopes_an_html_edit_to_one_heading() {
        let conn = db::open_in_memory_schema();
        let id = db::insert_file(
            &conn,
            "report.html",
            "text/html",
            b"<h1>Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 5</p>",
            Some("Q1 total is 5 Q2 total is 5"),
            "generated",
        )
        .unwrap()
        .id;
        // Unscoped, "total is 5" is ambiguous (appears in both sections).
        let err = run_edit_file(&conn, "report.html", "total is 5", "total is 9", false).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        // Scoped to Q2, it resolves to just that section's occurrence.
        let applied = run_edit_file_refined(
            &conn,
            "report.html",
            "total is 5",
            "total is 9",
            EditRefinements { section: Some("Q2"), ..Default::default() },
        )
        .unwrap();
        assert_eq!(applied.count, 1);
        let text = String::from_utf8(current_bytes(&conn, &id)).unwrap();
        assert_eq!(text, "<h1>Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 9</p>");
    }

    #[test]
    fn unknown_html_section_lists_the_real_headings_instead_of_searching_the_whole_page() {
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "report.html",
            "text/html",
            b"<h1>Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 5</p>",
            Some("Q1 total is 5 Q2 total is 5"),
            "generated",
        )
        .unwrap();
        let err = run_edit_file_refined(
            &conn,
            "report.html",
            "total is 5",
            "total is 9",
            EditRefinements { section: Some("Q3"), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.outcome, "not_found");
        assert!(err.message.contains("\"Q1\""), "got: {}", err.message);
        assert!(err.message.contains("\"Q2\""), "got: {}", err.message);
    }

    #[test]
    fn section_scopes_a_markdown_edit_to_one_heading() {
        let conn = db::open_in_memory_schema();
        let id = seed_text_file(
            &conn,
            "report.md",
            "# Q1\ntotal is 5\n\n# Q2\ntotal is 5\n",
        );
        let err = run_edit_file(&conn, "report.md", "total is 5", "total is 9", false).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        let applied = run_edit_file_refined(
            &conn,
            "report.md",
            "total is 5",
            "total is 9",
            EditRefinements { section: Some("Q2"), ..Default::default() },
        )
        .unwrap();
        assert_eq!(applied.count, 1);
        let text = String::from_utf8(current_bytes(&conn, &id)).unwrap();
        assert_eq!(text, "# Q1\ntotal is 5\n\n# Q2\ntotal is 9\n");
    }

    #[test]
    fn markdown_sub_section_ends_at_the_next_same_or_higher_heading() {
        let conn = db::open_in_memory_schema();
        seed_text_file(
            &conn,
            "report.md",
            "# A\nintro\n## A.1\nvalue is 5\n# B\nvalue is 5\n",
        );
        // Scoped to "A" (h1), the match inside its "A.1" sub-heading is still
        // in scope — a sub-heading doesn't end its parent's section — but the
        // sibling "B" section's occurrence is out of scope, so exactly one
        // candidate remains.
        let applied = run_edit_file_refined(
            &conn,
            "report.md",
            "value is 5",
            "value is 9",
            EditRefinements { section: Some("A"), ..Default::default() },
        )
        .unwrap();
        assert_eq!(applied.count, 1);
    }

    #[test]
    fn a_section_scoped_markdown_edit_still_gets_the_forgiving_match() {
        // `section` says WHERE to look, not "this quote is byte-perfect". It
        // used to route every refined edit through the exact-only resolver, so
        // a quote that matched fine unscoped failed the moment the model
        // scoped it to a heading — and the failure blamed prefix_context,
        // suffix_context and occurrence, none of which had been passed.
        let conn = db::open_in_memory_schema();
        let id = seed_text_file(
            &conn,
            "report.md",
            "## Q1\nnothing here\n\n## Q2\nFee is \u{201C}5%\u{201D} today\n",
        );
        let applied = run_edit_file_refined(
            &conn,
            "report.md",
            "Fee is \"5%\" today",
            "Fee is \"7%\" today",
            EditRefinements { section: Some("Q2"), ..Default::default() },
        )
        .unwrap();
        assert_eq!(applied.method, EditMethod::Fuzzy);
        let text = String::from_utf8(current_bytes(&conn, &id)).unwrap();
        assert_eq!(text, "## Q1\nnothing here\n\n## Q2\nFee is \"7%\" today\n");
    }

    #[test]
    fn a_drifted_quote_outside_the_named_section_is_still_refused() {
        // The scoping must survive the fallback: the forgiving matcher runs
        // over the SECTION, not the file, or `section` would stop narrowing
        // anything the moment the quote drifted.
        let conn = db::open_in_memory_schema();
        let id = seed_text_file(
            &conn,
            "report.md",
            "## Q1\nFee is \u{201C}5%\u{201D} today\n\n## Q2\nnothing here\n",
        );
        let err = run_edit_file_refined(
            &conn,
            "report.md",
            "Fee is \"5%\" today",
            "Fee is \"7%\" today",
            EditRefinements { section: Some("Q2"), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.outcome, "not_found");
        assert!(err.message.contains("\"Q2\" section"), "got: {}", err.message);
        assert!(!err.message.contains("occurrence"), "names a field never passed: {}", err.message);
        assert_eq!(
            String::from_utf8(current_bytes(&conn, &id)).unwrap(),
            "## Q1\nFee is \u{201C}5%\u{201D} today\n\n## Q2\nnothing here\n"
        );
    }

    #[test]
    fn a_refinement_miss_names_only_the_refinements_that_were_passed() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "n.md", "Q1: cost is 5.");
        let err = run_edit_file_refined(
            &conn,
            "n.md",
            "cost is 9",
            "cost is 7",
            EditRefinements { prefix_context: Some("Q1: "), ..Default::default() },
        )
        .unwrap_err();
        assert!(err.message.contains("prefix_context needs"), "got: {}", err.message);
        assert!(!err.message.contains("occurrence"), "got: {}", err.message);
        assert!(!err.message.contains("suffix_context"), "got: {}", err.message);
    }

    #[test]
    fn section_scoped_all_replaces_every_match_in_that_section_only() {
        // The ambiguity error offers `all: true`; the refined path dropped the
        // flag, so passing it returned the identical error — the one option
        // that path recommended was the one it could not honour.
        let content = "# Q1\ncost is 5\ncost is 5\n\n# Q2\ncost is 5\n";
        let (bytes, count, method) = compute_edit_bytes(
            "report.md",
            content.as_bytes(),
            "cost is 5",
            "cost is 7",
            Some(true),
            EditRefinements { section: Some("Q1"), ..Default::default() },
        )
        .unwrap();
        assert_eq!(count, 2);
        assert_eq!(method, EditMethod::ExactAll);
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "# Q1\ncost is 7\ncost is 7\n\n# Q2\ncost is 5\n"
        );
    }

    #[test]
    fn section_is_refused_on_a_file_type_it_does_not_support() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "notes.txt", "Q1: total is 5. Q2: total is 5.");
        let err = run_edit_file_refined(
            &conn,
            "notes.txt",
            "total is 5",
            "total is 9",
            EditRefinements { section: Some("Q2"), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.outcome, "wrong_type");
        assert!(err.message.contains("section isn't available"), "got: {}", err.message);
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
        let hits = db::search_chunks_fts_ranked(&conn, "octillion", 5).unwrap();
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
    fn html_edit_replaces_text_in_place() {
        // Wave E (2026-08-04): supersedes the old "edit_file refuses .html"
        // behavior. This was the app's DEFAULT document format and the one
        // format edit_file couldn't touch — every change was a full rewrite.
        // extraction::html_replace_text closes that gap; this is its
        // integration test through the real dispatch + snapshot + reindex path.
        let conn = db::open_in_memory_schema();
        let id = db::insert_file(
            &conn,
            "note.html",
            "text/html",
            b"<p>Q3 revenue was $4M.</p>",
            Some("Q3 revenue was $4M."),
            "generated",
        )
        .unwrap()
        .id;
        let applied = run_edit_file(&conn, "note.html", "$4M", "$5M", false).unwrap();
        assert_eq!(applied.method, EditMethod::Html);
        assert_eq!(applied.count, 1);
        let new = String::from_utf8(current_bytes(&conn, &id)).unwrap();
        assert_eq!(new, "<p>Q3 revenue was $5M.</p>");
        // Snapshotted like every other in-place edit.
        let versions = db::list_file_versions(&conn, &id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].cause, "AI edit");
    }

    #[test]
    fn html_edit_escapes_the_replacement_before_splicing() {
        // A replacement containing `<`/`&` must not inject markup into the page.
        let conn = db::open_in_memory_schema();
        let id = db::insert_file(&conn, "note.html", "text/html", b"<p>old</p>", Some("old"), "generated")
            .unwrap()
            .id;
        run_edit_file(&conn, "note.html", "old", "A & B <script>", false).unwrap();
        let new = String::from_utf8(current_bytes(&conn, &id)).unwrap();
        assert_eq!(new, "<p>A &amp; B &lt;script&gt;</p>");
    }

    #[test]
    fn html_edit_multi_occurrence_errors_without_all_and_replaces_with_all() {
        // Same replace-all guard as the text and docx branches.
        let conn = db::open_in_memory_schema();
        let id = db::insert_file(
            &conn,
            "note.html",
            "text/html",
            b"<p>cost is 5.</p><p>cost is 5.</p>",
            Some("cost is 5. cost is 5."),
            "generated",
        )
        .unwrap()
        .id;
        let err = run_edit_file(&conn, "note.html", "cost is 5", "cost is 7", false).unwrap_err();
        assert_eq!(err.outcome, "ambiguous");
        assert!(err.message.contains("appears 2 times"));
        assert!(err.message.contains("all: true"));
        assert_eq!(current_bytes(&conn, &id), b"<p>cost is 5.</p><p>cost is 5.</p>");
        let ok = run_edit_file(&conn, "note.html", "cost is 5", "cost is 7", true).unwrap();
        assert_eq!(ok.method, EditMethod::Html);
        assert_eq!(ok.count, 2);
        assert_eq!(current_bytes(&conn, &id), b"<p>cost is 7.</p><p>cost is 7.</p>");
    }

    #[test]
    fn html_edit_never_matches_across_a_paragraph_even_with_all() {
        // The block-boundary sentinel applies regardless of `all` — there is
        // no way to ask for a cross-paragraph splice, by design.
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "note.html",
            "text/html",
            b"<p>Hello</p><p>Hello</p>",
            Some("Hello Hello"),
            "generated",
        )
        .unwrap();
        let err = run_edit_file(&conn, "note.html", "HelloHello", "x", true).unwrap_err();
        assert_eq!(err.outcome, "not_found");
    }

    #[test]
    fn html_edit_not_found_carries_a_closest_hint_from_the_readable_text() {
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "note.html",
            "text/html",
            b"<p>Payment is due within thirty days of invoice.</p>",
            Some("Payment is due within thirty days of invoice."),
            "generated",
        )
        .unwrap();
        let err = run_edit_file(
            &conn,
            "note.html",
            "payment due within ninety days of invoice",
            "x",
            false,
        )
        .unwrap_err();
        assert_eq!(err.outcome, "not_found");
        assert!(err.message.contains("closest text"), "got: {}", err.message);
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
        assert!(!db::search_chunks_fts_ranked(&conn, "quux", 5).unwrap().is_empty());
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
    fn an_edit_refuses_a_file_that_is_not_utf8_instead_of_mangling_it() {
        // 0xE9 is "é" in latin-1. Read lossily every unreadable byte becomes
        // U+FFFD, so applying a one-word edit used to replace the file's
        // accented letters with boxes and write that back.
        let conn = db::open_in_memory_schema();
        let latin1 = b"Le si\xE8ge social est \xE0 Paris.";
        let id = db::insert_file(&conn, "note.txt", "text/plain", latin1, None, "upload")
            .unwrap()
            .id;
        let err = run_edit_file(&conn, "note.txt", "Paris", "Lyon", false).unwrap_err();
        assert_eq!(err.outcome, "wrong_type");
        assert!(err.message.contains("UTF-8"), "got: {}", err.message);
        assert_eq!(current_bytes(&conn, &id), latin1, "bytes untouched");
    }

    #[test]
    fn a_huge_file_skips_the_forgiving_match_but_still_edits_exactly() {
        // The fuzzy fallback costs 20–40× the file's size in memory under the
        // room lock, so past MAX_FUZZY_BYTES it is not attempted.
        let conn = db::open_in_memory_schema();
        let mut body = "filler line of ordinary prose.\n".repeat(200_000); // ~6 MB
        body.push_str("the target phrase here");
        assert!(body.len() > MAX_FUZZY_BYTES);
        let id = seed_text_file(&conn, "big.txt", &body);
        // An EXACT quote still works at any size.
        run_edit_file(&conn, "big.txt", "the target phrase here", "replaced", false).unwrap();
        assert!(String::from_utf8(current_bytes(&conn, &id)).unwrap().ends_with("replaced"));
        // A drifted quote gets an honest "has to be exact", not a freeze.
        let err = run_edit_file(&conn, "big.txt", "the  target\u{00A0}phrase", "x", false).unwrap_err();
        assert_eq!(err.outcome, "not_found");
        assert!(err.message.contains("has to be exact"), "got: {}", err.message);
    }

    #[test]
    fn a_rename_that_changes_the_type_still_previews_the_real_content() {
        // The preview used to be rendered with the NEW name, so renaming a
        // .md to a .docx in the same batch drew both panes through the docx
        // reader and the approval card came up empty.
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "notes.md", "hello world");
        let ops = vec![
            BatchOp::Edit { name: "notes.md".into(), old_text: "hello".into(), new_text: "goodbye".into() },
            BatchOp::Rename { name: "notes.md".into(), new_name: "notes.docx".into() },
        ];
        let plans = plan_batch(&conn, &ops).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(plans[0].before.contains("hello world"), "before was blank: {:?}", plans[0].before);
        assert!(plans[0].after.contains("goodbye world"), "after was blank: {:?}", plans[0].after);
        assert_eq!(plans[0].rename_to.as_deref(), Some("notes.docx"));
    }

    #[test]
    fn a_clipped_preview_shows_the_changed_region_not_the_first_page() {
        // Both panes used to be clipped from byte 0, so a change past
        // PREVIEW_CLIP produced two IDENTICAL heads: a card with no visible
        // diff that still asked for approval.
        let conn = db::open_in_memory_schema();
        let mut body = "filler line of ordinary prose.\n".repeat(20_000); // ~600 KB
        body.push_str("the closing sentence.\n");
        assert!(body.len() > PREVIEW_CLIP * 2);
        seed_text_file(&conn, "big.md", &body);
        let plans = plan_single_edit(
            &conn,
            &PreviewEdit {
                name: "big.md".into(),
                old_text: "the closing sentence.".into(),
                new_text: "the corrected sentence.".into(),
                all: false,
                prefix_context: None,
                suffix_context: None,
                occurrence: None,
                section: None,
            },
        )
        .unwrap();
        assert!(plans[0].clipped, "a 600 KB file must still report a clipped preview");
        assert!(plans[0].before.contains("the closing sentence."), "before pane missed the change");
        assert!(plans[0].after.contains("the corrected sentence."), "after pane missed the change");
        assert_ne!(plans[0].before, plans[0].after, "the card must show a diff");
        // Still bounded (the window, plus the leading ellipsis marking it).
        assert!(plans[0].after.len() <= PREVIEW_CLIP + 4);
    }

    #[test]
    fn a_small_files_preview_is_the_whole_file_unclipped() {
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "small.md", "hello world");
        let plans = plan_write_file(&conn, "small.md", "goodbye world").unwrap();
        assert!(!plans[0].clipped);
        assert_eq!(plans[0].before, "hello world");
        assert_eq!(plans[0].after, "goodbye world");
    }

    #[test]
    fn a_legacy_encoded_file_previews_as_text_not_replacement_boxes() {
        // windows-1252 bytes read lossily became U+FFFD everywhere, so the
        // approval card showed boxes for every accented letter — and
        // write_file_summary counted its lines against that same string.
        let conn = db::open_in_memory_schema();
        let latin1 = b"Le si\xE8ge social de la soci\xE9t\xE9 est \xE0 Paris, pr\xE8s de la gare.";
        db::insert_file(&conn, "note.txt", "text/plain", latin1, None, "upload").unwrap();
        let plans = plan_write_file(&conn, "note.txt", "Le siege social est a Lyon.").unwrap();
        assert!(
            !plans[0].before.contains('\u{FFFD}'),
            "before pane is mojibake: {}",
            plans[0].before
        );
        assert!(plans[0].before.contains("Paris"), "got: {}", plans[0].before);
    }

    #[test]
    fn a_batch_rename_that_changes_the_type_indexes_the_bytes_as_they_are() {
        // The searchable text used to be derived with the NEW name, so editing
        // a .docx and renaming it to .md in one batch stored the zip decoded
        // as text — search and every retrieved context got binary mojibake.
        let conn = db::open_in_memory_schema();
        let docx = crate::extraction::fake_office_zip(
            "word/document.xml",
            r#"<w:document><w:p><w:t>fee is 5%</w:t></w:p></w:document>"#,
        );
        db::insert_file(&conn, "contract.docx", "application/docx", &docx, Some("fee is 5%"), "upload")
            .unwrap();
        let ops = vec![
            BatchOp::Edit {
                name: "contract.docx".into(),
                old_text: "5%".into(),
                new_text: "7%".into(),
            },
            BatchOp::Rename { name: "contract.docx".into(), new_name: "contract.md".into() },
        ];
        let plans = plan_batch(&conn, &ops).unwrap();
        commit_plans(&conn, &plans, "AI edit").unwrap();
        let (_, name, text) = db::find_file_like_full(&conn, "contract").unwrap();
        assert_eq!(name, "contract.md");
        let text = text.expect("the file keeps searchable text");
        assert!(text.contains("fee is 7%"), "got: {text}");
        assert!(!text.contains("word/document.xml"), "indexed the raw zip: {text}");
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

    // --------------------------------------------------------------- parse
    //
    // `edit_files` promises the model: "every edit is checked first, then all
    // are applied together — if any single edit can't match, none are applied."
    // A nameless entry used to be skipped at parse time, so the batch applied
    // the REST and reported success. The model was told "Applied 2 change(s)"
    // for a three-edit plan and had no way to learn the third vanished. These
    // pin the parse stage to the same all-or-nothing contract `plan_batch`
    // already enforces.

    #[test]
    fn a_nameless_entry_fails_the_whole_batch_instead_of_being_skipped() {
        let err = parse_batch_ops(&serde_json::json!({"edits": [
            {"name": "a.md", "old_text": "x", "new_text": "y"},
            {"old_text": "p", "new_text": "q"},
            {"name": "c.md", "old_text": "m", "new_text": "n"},
        ]}))
        .unwrap_err();
        // Numbered like plan_batch's errors, and 1-based for a human/model.
        assert!(err.contains("Edit 2 of 3"), "got: {err}");
        assert!(err.contains("name is required"), "got: {err}");
        // It must say plainly that nothing landed — the whole point.
        assert!(err.contains("Nothing was changed"), "got: {err}");
    }

    #[test]
    fn a_blank_name_is_the_same_failure_as_a_missing_one() {
        // `"   "` trims to empty: a model that emitted whitespace gets the same
        // honest error, not a silent drop.
        let err = parse_batch_ops(&serde_json::json!({"edits": [
            {"name": "   ", "old_text": "x", "new_text": "y"},
        ]}))
        .unwrap_err();
        assert!(err.contains("Edit 1 of 1"), "got: {err}");
        assert!(err.contains("name is required"), "got: {err}");
    }

    #[test]
    fn well_formed_batches_still_parse_both_shapes() {
        // The tolerance that must NOT regress: the untagged form a 4B emits.
        let ops = parse_batch_ops(&serde_json::json!({"edits": [
            {"name": "a.md", "old_text": "x", "new_text": "y"},
            {"name": "old.md", "new_name": "new.md"},
        ]}))
        .unwrap();
        assert_eq!(
            ops,
            vec![
                BatchOp::Edit { name: "a.md".into(), old_text: "x".into(), new_text: "y".into() },
                BatchOp::Rename { name: "old.md".into(), new_name: "new.md".into() },
            ]
        );
    }

    #[test]
    fn an_entry_with_a_name_but_no_operation_is_caught_downstream_atomically() {
        // Parse accepts it (it looks like an edit); `plan_batch` then refuses
        // the BATCH with a numbered error, so nothing is written. Verifying the
        // two stages hand off rather than leaving a gap between them.
        let ops = parse_batch_ops(&serde_json::json!({"edits": [
            {"name": "a.md"},
        ]}))
        .unwrap();
        let conn = db::open_in_memory_schema();
        seed_text_file(&conn, "a.md", "hello");
        // `PlannedWrite` is not Debug, so match rather than unwrap_err.
        let err = match plan_batch(&conn, &ops) {
            Err(e) => e,
            Ok(_) => panic!("a nameless operation was planned instead of refused"),
        };
        assert!(err.contains("old_text is required"), "got: {err}");
    }

    #[test]
    fn an_empty_edits_array_still_says_so() {
        let err = parse_batch_ops(&serde_json::json!({"edits": []})).unwrap_err();
        assert!(err.contains("No edits given"), "got: {err}");
    }
}
