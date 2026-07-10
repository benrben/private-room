//! ADD-27: windowed, filtered reads over a file's extracted text, so the model
//! can page through a large file (offset / limit / find) instead of only ever
//! seeing the first snippet. Pure functions — the LLM plumbing lives in
//! `commands::summarize`.

/// Window size handed out when the model doesn't ask for one.
pub const READ_WINDOW_DEFAULT: usize = 4_000;
/// Hard bounds on ONE model-requested window, so a hallucinated `limit` can
/// neither blow the context (too big) nor spin uselessly (too small). The
/// cumulative cap across a whole task is the caller's job — it derives a
/// budget from the engine's real context (`ollama::context_chars`) instead of
/// hardcoding a number here.
pub const READ_WINDOW_MIN: usize = 200;
pub const READ_WINDOW_MAX: usize = 32_000;

/// One window of a file's text. Offsets are byte positions into the (filtered)
/// text, always snapped to char boundaries so slicing can never panic.
pub struct TextWindow {
    pub text: String,
    /// Where this window actually starts (after clamping/snapping/find).
    pub offset: usize,
    /// One past the last byte included.
    pub end: usize,
    /// Total length of the searched text.
    pub total: usize,
    /// Whether `find` matched (the window then starts just before the match).
    pub found: bool,
}

/// Drop the low-signal lines a 20 MB extraction is full of — binary/base64
/// junk, repeated boilerplate lines, runs of blank lines — so every character
/// the model reads is worth reading. Conservative on purpose: normal prose,
/// code and tables pass through untouched.
pub fn smart_filter(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(1 << 22));
    let mut prev_line = "";
    let mut blank_run = 0usize;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            blank_run += 1;
            if blank_run == 1 {
                out.push('\n');
            }
            continue;
        }
        blank_run = 0;
        // Identical consecutive lines: page headers/footers repeated per page.
        if trimmed == prev_line {
            continue;
        }
        if looks_like_noise(trimmed) {
            continue;
        }
        out.push_str(trimmed);
        out.push('\n');
        prev_line = trimmed;
    }
    out
}

/// A long line that is mostly symbols, or contains an unbroken 80+ char run
/// (base64, hex dumps, minified blobs), is junk for a human-language summary.
fn looks_like_noise(line: &str) -> bool {
    if line.len() < 40 {
        return false;
    }
    let total = line.chars().count().max(1);
    let wordish = line
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || ".,;:!?'\"()-/&%$€@".contains(*c))
        .count();
    if (wordish as f32) / (total as f32) < 0.7 {
        return true;
    }
    line.split_whitespace().any(|w| w.len() > 80)
}

/// Cut one window out of `text`. `limit` is clamped to the bounds above.
/// `find`, when given, jumps the window to the first occurrence of that
/// phrase at-or-after `offset` (ASCII case-insensitive, so byte offsets stay
/// exact), starting ~200 bytes early for surrounding context; no match leaves
/// the window at `offset` with `found: false` so the model learns it missed.
pub fn read_window(text: &str, offset: usize, limit: usize, find: Option<&str>) -> TextWindow {
    let total = text.len();
    let limit = limit.clamp(READ_WINDOW_MIN, READ_WINDOW_MAX);
    let mut start = floor_char_boundary(text, offset.min(total));
    let mut found = false;
    if let Some(needle) = find.map(str::trim).filter(|s| !s.is_empty()) {
        let hay = text[start..].to_ascii_lowercase();
        if let Some(pos) = hay.find(&needle.to_ascii_lowercase()) {
            start = floor_char_boundary(text, (start + pos).saturating_sub(200));
            found = true;
        }
    }
    let end = ceil_char_boundary(text, (start + limit).min(total));
    TextWindow {
        text: text[start..end].to_string(),
        offset: start,
        end,
        total,
        found,
    }
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
    fn filter_collapses_repeats_and_blanks() {
        let text = "Page header — Annual Report\nBody text one.\n\n\n\n\
                    Page header — Annual Report\nPage header — Annual Report\nBody text two.";
        let f = smart_filter(&text);
        // Consecutive duplicate header collapses; blank run becomes one break.
        assert_eq!(f.matches("Annual Report").count(), 2);
        assert!(!f.contains("\n\n\n"));
    }

    #[test]
    fn window_clamps_and_reports_bounds() {
        let text = "abc ".repeat(3000); // 12_000 bytes
        let w = read_window(&text, 0, 50, None); // below MIN → clamped up
        assert_eq!(w.offset, 0);
        assert_eq!(w.end, READ_WINDOW_MIN);
        assert_eq!(w.total, 12_000);
        let w = read_window(&text, 11_900, 999_999, None); // beyond MAX → clamped down, hits end
        assert_eq!(w.end, 12_000);
        let w = read_window(&text, 999_999, 500, None); // offset past end → empty tail
        assert_eq!(w.offset, 12_000);
        assert!(w.text.is_empty());
    }

    #[test]
    fn window_never_splits_multibyte_chars() {
        let text = "é".repeat(2_000); // 2 bytes per char
        let w = read_window(&text, 301, 301, None); // both land mid-char
        assert!(w.text.chars().all(|c| c == 'é'));
        assert!(text.is_char_boundary(w.offset) && text.is_char_boundary(w.end));
    }

    #[test]
    fn find_jumps_case_insensitively() {
        let mut text = "x".repeat(10_000);
        text.push_str("The TERMINATION clause begins here.");
        let w = read_window(&text, 0, 300, Some("termination"));
        assert!(w.found);
        assert!(w.text.contains("TERMINATION clause"));
        assert!(w.offset >= 10_000 - 200);
        // No match: stays at the requested offset and says so.
        let w = read_window(&text, 0, 300, Some("no-such-phrase"));
        assert!(!w.found);
        assert_eq!(w.offset, 0);
    }
}
