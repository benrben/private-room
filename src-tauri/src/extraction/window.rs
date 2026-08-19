//! ADD-27: windowed, filtered reads over a file's extracted text, so the model
//! can page through a large file (offset / limit / find) instead of only ever
//! seeing the first snippet. Pure functions — the LLM plumbing lives in
//! `commands::summarize`.

/// Floor on a partition window's target size, so a caller can't ask
/// `partition_windows` for pathologically tiny windows.
pub const READ_WINDOW_MIN: usize = 200;

/// Drop the low-signal lines a 20 MB extraction is full of — binary/base64
/// junk, runs of blank lines, a boilerplate line repeated past all meaning —
/// so every character the model reads is worth reading. Conservative on
/// purpose: normal prose, code and tables pass through untouched, and a long
/// run that IS cut says how many lines it stood for.
pub fn smart_filter(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(1 << 22));
    let mut prev_line = "";
    let mut run = 0usize; // how many times prev_line has arrived in a row
    let mut omitted = 0usize; // lines of the current run left out of `out`
    let mut blank_run = 0usize;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            push_omitted_note(&mut out, &mut omitted);
            blank_run += 1;
            if blank_run == 1 {
                out.push('\n');
            }
            continue;
        }
        blank_run = 0;
        if trimmed == prev_line {
            run += 1;
            if run > MAX_IDENTICAL_RUN {
                omitted += 1;
                continue;
            }
        } else {
            push_omitted_note(&mut out, &mut omitted);
            run = 1;
        }
        if looks_like_noise(trimmed) {
            continue;
        }
        out.push_str(trimmed);
        out.push('\n');
        prev_line = trimmed;
    }
    push_omitted_note(&mut out, &mut omitted);
    out
}

/// How many identical lines in a row are carried through unchanged.
///
/// Collapsing every consecutive duplicate to one — which is what this used to
/// do — is not a noise rule, it is a silent edit of the data: three identical
/// rows in a ledger, a log or a spreadsheet reached the model as one, so "how
/// many zero-value cash entries are there" was answered 1 instead of 3 with
/// nothing anywhere saying rows had been dropped. A repeated line is only
/// noise once the repetition is longer than any table anyone reads row by row.
const MAX_IDENTICAL_RUN: usize = 6;

/// Close off a collapsed run by writing down what it stood for. Nothing is
/// removed silently: the count is the part that carries the meaning, so a
/// shortened block can never be read downstream as the whole block.
fn push_omitted_note(out: &mut String, omitted: &mut usize) {
    if *omitted == 0 {
        return;
    }
    let plural = if *omitted == 1 { "line" } else { "lines" };
    out.push_str(&format!("[{} more identical {plural} omitted]\n", *omitted));
    *omitted = 0;
}

/// A long line that is mostly symbols, or that IS one unbroken 80+ char run
/// (base64, hex dumps, minified blobs), is junk for a human-language summary.
///
/// Both halves are deliberately narrow, because both used to take real content
/// with them:
/// - table and box-drawing characters count as words, so a compact `| a | b |`
///   or `│ a │ b │` row survives — the promise that tables pass through was
///   only true for loosely-spaced ones;
/// - one long token no longer condemns its whole line. A reference, a citation
///   or a "data available at https://…" line is mostly prose around a single
///   long identifier, and it used to vanish from summaries with no note.
fn looks_like_noise(line: &str) -> bool {
    if line.len() < 40 {
        return false;
    }
    let total = line.chars().count().max(1);
    let wordish = line.chars().filter(|c| is_wordish(*c)).count();
    if (wordish as f32) / (total as f32) < 0.7 {
        return true;
    }
    // A web address is content, however long. Anything else only counts when
    // it is essentially the entire line.
    line.split_whitespace()
        .filter(|w| !w.contains("://"))
        .any(|w| {
            let n = w.chars().count();
            n > 80 && n * 10 >= total * 9
        })
}

/// Characters that make a line read as text rather than as a blob: letters,
/// digits, whitespace, ordinary punctuation, and the rules and pipes real
/// tables are drawn with (ASCII `|`/`+` and the box-drawing block).
fn is_wordish(c: char) -> bool {
    c.is_alphanumeric()
        || c.is_whitespace()
        || ".,;:!?'\"()-/&%$€@".contains(c)
        || matches!(c, '|' | '+')
        || ('\u{2500}'..='\u{257F}').contains(&c)
}

/// ADD-32: partition a whole text into consecutive windows of ~`target` bytes
/// for an exhaustive file pass — every byte lands in exactly one window (plus a
/// small `overlap` carried from the previous window so nothing straddling a cut
/// is lost). Cuts prefer a paragraph break, then a line break, then whitespace,
/// searched in the last 20% of the window; a boundary is never forced onto a
/// pathological wall of text — it just cuts at the byte limit (char-safe).
/// Returns (start, end) byte spans into `text`; deterministic, so a resumed job
/// re-derives the identical plan from the same text.
pub fn partition_windows(text: &str, target: usize, overlap: usize) -> Vec<(usize, usize)> {
    let total = text.len();
    if total == 0 {
        return Vec::new();
    }
    let target = target.max(READ_WINDOW_MIN);
    let overlap = overlap.min(target / 4);
    let mut spans = Vec::new();
    let mut cursor = 0usize; // where un-covered text begins
    while cursor < total {
        let start = floor_char_boundary(text, cursor.saturating_sub(overlap));
        let hard_end = ceil_char_boundary(text, (cursor + target).min(total));
        let end = if hard_end >= total {
            total
        } else {
            // Look for a natural seam in the tail 20% of the window.
            let seam_from = floor_char_boundary(text, hard_end - (target / 5).min(hard_end - cursor));
            let slice = &text[seam_from..hard_end];
            let seam = slice
                .rfind("\n\n")
                .map(|i| i + 2)
                .or_else(|| slice.rfind('\n').map(|i| i + 1))
                .or_else(|| slice.rfind(char::is_whitespace).map(|i| i + 1));
            match seam {
                // A seam only counts if it still moves the cursor forward.
                Some(i) if seam_from + i > cursor => ceil_char_boundary(text, seam_from + i),
                _ => hard_end,
            }
        };
        spans.push((start, end));
        cursor = end;
    }
    spans
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_keeps_prose_drops_junk() {
        let blob = "QmFzZTY0anVuaw".repeat(9); // 126-char unbroken run
        let text = format!(
            "A normal sentence about a lease agreement.\n{blob}\n\
             ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n\
             Another useful line."
        );
        let f = smart_filter(&text);
        assert!(f.contains("lease agreement"));
        assert!(f.contains("Another useful line"));
        assert!(!f.contains("QmFzZTY0"));
        assert!(!f.contains("~~~~"));
    }

    #[test]
    fn filter_keeps_citations_and_table_rows() {
        // Regression: one 80+ char token used to drop the whole line, so
        // reference lists and "data available at …" lines disappeared from
        // every summary with nothing saying anything had been cut.
        let cite = "Smith, J. (2020). A study of things. Journal of Things 4(2). \
                    Data available at https://example.org/datasets/2020/a-very-long-identifier-here-1234567890";
        // And compact table rows, which the symbol-ratio rule caught even
        // though the comment beside it promised tables pass through.
        let ascii_row = "| Widget A | 12 | 3.50 | In stock | Warehouse 4 | 2026-01-01 |";
        let box_row = "│ Widget A │ 12 │ 3.50 │ In stock │ Warehouse 4 │ 2026-01-01 │";
        let text = format!("{cite}\n{ascii_row}\n{box_row}");
        let f = smart_filter(&text);
        assert!(f.contains("Smith, J."), "citation dropped: {f}");
        assert!(f.contains("a-very-long-identifier"), "url dropped: {f}");
        assert!(f.contains("| Widget A |"), "ascii table row dropped: {f}");
        assert!(f.contains("│ Widget A │"), "box table row dropped: {f}");
        // A line that IS one long blob is still junk.
        assert!(looks_like_noise(&"QmFzZTY0anVuaw".repeat(9)));
    }

    #[test]
    fn filter_keeps_repeated_rows_and_collapses_only_long_runs() {
        // A ledger's repeated rows ARE the answer to "how many"; collapsing
        // consecutive duplicates to one used to delete them silently.
        let row = "Cash | 0.00 | 0.00";
        let ledger = format!("Opening balance\n{row}\n{row}\n{row}\nClosing balance");
        let f = smart_filter(&ledger);
        assert_eq!(f.matches(row).count(), 3, "ledger rows dropped: {f}");

        // Past the run cap the lines go, but the count stays — a collapsed run
        // never reads as a complete block.
        let flood = format!("Intro\n{}\nOutro", vec![row; MAX_IDENTICAL_RUN + 4].join("\n"));
        let f = smart_filter(&flood);
        assert_eq!(f.matches(row).count(), MAX_IDENTICAL_RUN, "cap ignored: {f}");
        assert!(f.contains("[4 more identical lines omitted]"), "loss unrecorded: {f}");
        assert!(f.contains("Outro"), "text after the run lost: {f}");

        // Exactly at the cap nothing is removed and nothing is claimed.
        let at_cap = vec![row; MAX_IDENTICAL_RUN].join("\n");
        assert!(!smart_filter(&at_cap).contains("omitted"), "noted a run it kept");

        // One line past the cap reads in the singular.
        let one_over = vec![row; MAX_IDENTICAL_RUN + 1].join("\n");
        assert!(smart_filter(&one_over).contains("[1 more identical line omitted]"));

        // Blank runs still collapse to a single break.
        let f = smart_filter("Body text one.\n\n\n\nBody text two.");
        assert!(!f.contains("\n\n\n"));
    }

    #[test]
    fn partition_covers_everything_without_gaps() {
        let text = "A paragraph of prose.\n\n".repeat(500); // ~11.5 KB
        let spans = partition_windows(&text, 2_000, 200);
        // Full coverage: first starts at 0, last ends at len, no gaps between
        // one window's end and the next window's coverage (overlap ≤ 200 back).
        assert_eq!(spans.first().unwrap().0, 0);
        assert_eq!(spans.last().unwrap().1, text.len());
        for w in spans.windows(2) {
            let (_, prev_end) = w[0];
            let (next_start, _) = w[1];
            assert!(next_start <= prev_end, "gap between windows");
            assert!(prev_end - next_start <= 200, "overlap exceeds the cap");
        }
        // Windows respect the target within the seam slack.
        for &(s, e) in &spans {
            assert!(e - s <= 2_000 + 200);
            assert!(text.is_char_boundary(s) && text.is_char_boundary(e));
        }
    }

    #[test]
    fn partition_prefers_paragraph_seams() {
        let text = format!("{}\n\n{}", "x".repeat(1_800), "y".repeat(3_000));
        let spans = partition_windows(&text, 2_000, 100);
        // First cut lands on the paragraph break, not mid-y.
        assert_eq!(spans[0].1, 1_802);
    }

    #[test]
    fn partition_survives_a_wall_of_text_and_multibyte() {
        // No whitespace at all: it must still advance and never split a char.
        let wall = "é".repeat(5_000); // 10 KB, 2 bytes/char
        let spans = partition_windows(&wall, 2_000, 100);
        assert!(spans.len() >= 4);
        assert_eq!(spans.last().unwrap().1, wall.len());
        for w in spans.windows(2) {
            assert!(w[1].0 < w[1].1 && w[0].1 > w[0].0);
            assert!(w[1].1 > w[0].1, "windows must make forward progress");
        }
        for &(s, e) in &spans {
            assert!(wall.is_char_boundary(s) && wall.is_char_boundary(e));
        }
        // Empty text → no windows; tiny text → one window.
        assert!(partition_windows("", 2_000, 100).is_empty());
        assert_eq!(partition_windows("short", 2_000, 100), vec![(0, 5)]);
    }
}
