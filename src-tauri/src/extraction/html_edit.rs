use super::*;
use std::ops::Range;

/// Position-preserving text scanner for `edit_file`'s HTML branch. Mirrors
/// `docx.rs`'s scan/match/splice discipline (`scan_docx_text` /
/// `replace_in_text_nodes`) over raw HTML markup instead of Word XML runs, so
/// a quote drawn from the page's readable text can be rewritten IN PLACE
/// without disturbing surrounding tags.
///
/// Deliberately NOT built on `strip_html` (html.rs) — that pipeline is lossy
/// BY DESIGN for retrieval (narrows to `<main>`/`<article>`, drops
/// `<nav>`/`<header>`/`<footer>`/`<script>`/`<style>` bodies) and keeps no
/// byte offsets. Editing needs every character traceable back to the exact
/// bytes it decoded from. `strip_html` is still used, unmodified, for the
/// "closest passage" hint when a quote isn't found — that's advisory text,
/// not something spliced back into the markup.

/// One matchable run of text between tags, with the byte range in the RAW
/// markup it decoded from. Never spans a tag; `<script>`/`<style>`/comment
/// bodies and tag interiors (including attribute values) never become a run.
pub(crate) struct HtmlTextRun {
    /// Absolute byte range in the source HTML this run occupies.
    span: Range<usize>,
    /// Decoded characters (entities resolved).
    chars: Vec<char>,
    /// Absolute byte range per char of `chars` — char i decoded from
    /// `char_spans[i]` in the source. An entity like `&amp;` is one char
    /// mapping to a 5-byte source range.
    char_spans: Vec<Range<usize>>,
}

/// Tags whose CLOSE marks a boundary a match may never cross — moving between
/// block-level containers (paragraphs, headings, list items, table rows and
/// cells, lists) must never silently splice two block elements together.
/// Covers the markup `create_file`'s own HTML-first output uses (h2/p/ul/table).
/// Inline tags (`<b>`, `<i>`, `<span>`, `<a>`, `<em>`, `<strong>`, `<code>`, and
/// anything not in this list) get no boundary — a quote MAY span them.
const BLOCK_CLOSE_TAGS: &[&str] = &[
    "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "ul", "ol", "table",
    "blockquote", "section", "article", "header", "footer", "nav", "aside", "figure",
    "figcaption", "pre", "body", "html",
];

/// Unmatchable separator between runs joined by a block boundary — same
/// convention as `edit_match::PARA_SENTINEL` and docx's `'\u{0}'` paragraph
/// marker. `fold_edit_char('\u{0}') == FoldOut::Drop`, so a needle can never
/// contain one and therefore can never match across it.
const BLOCK_SENTINEL: char = '\u{0}';

/// Decode one entity or literal char starting at `s`, returning the decoded
/// char and how many source bytes it consumed. An unrecognized or malformed
/// `&…;` sequence is treated as a literal `&` (1 byte) — safe, and the rest
/// scans normally as text.
fn decode_html_unit(s: &str) -> (char, usize) {
    if let Some(rest) = s.strip_prefix('&') {
        // Cap the lookahead so a stray `&` followed by a long run of
        // non-`;` text doesn't scan for a terminator that was never coming.
        if let Some(scolon) = rest.find(';').filter(|&i| i <= 32) {
            let body = &rest[..scolon];
            if let Some(c) = decode_entity_body(body) {
                return (c, 1 + body.len() + 1);
            }
        }
    }
    let c = s.chars().next().unwrap_or('\u{FFFD}');
    (c, c.len_utf8())
}

fn decode_entity_body(body: &str) -> Option<char> {
    match body {
        "amp" => return Some('&'),
        "lt" => return Some('<'),
        "gt" => return Some('>'),
        "quot" => return Some('"'),
        "apos" | "#39" => return Some('\''),
        "nbsp" => return Some('\u{00A0}'),
        _ => {}
    }
    if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
        return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32);
    }
    if let Some(dec) = body.strip_prefix('#') {
        return dec.parse::<u32>().ok().and_then(char::from_u32);
    }
    None
}

/// Scan `html` into text runs plus a boundary flag between each consecutive
/// pair (`boundaries[i]` = true means a BLOCK boundary separates `runs[i]`
/// and `runs[i + 1]`; `boundaries.len() == runs.len().saturating_sub(1)`).
///
/// Malformed markup (an unterminated tag, an unclosed `<script>`/`<style>`)
/// ends the scan at that point rather than panicking or reading past it —
/// whatever text came before is still editable; nothing after is claimed.
#[allow(unused_assignments)] // the final flush_run!() reset is provably dead, not a bug
pub(crate) fn scan_html_runs(html: &str) -> (Vec<HtmlTextRun>, Vec<bool>) {
    let mut runs: Vec<HtmlTextRun> = Vec::new();
    let mut boundaries: Vec<bool> = Vec::new();
    let mut pending_boundary = false;
    let mut cur_start: Option<usize> = None;
    let mut cur_chars: Vec<char> = Vec::new();
    let mut cur_spans: Vec<Range<usize>> = Vec::new();
    let mut i = 0usize;
    let n = html.len();

    macro_rules! flush_run {
        () => {
            if let Some(start) = cur_start.take() {
                if !runs.is_empty() {
                    boundaries.push(pending_boundary);
                }
                pending_boundary = false;
                runs.push(HtmlTextRun {
                    span: start..i,
                    chars: std::mem::take(&mut cur_chars),
                    char_spans: std::mem::take(&mut cur_spans),
                });
            }
        };
    }

    while i < n {
        if html.as_bytes()[i] == b'<' {
            flush_run!();
            if html[i..].starts_with("<!--") {
                match html[i..].find("-->") {
                    Some(end) => i += end + 3,
                    None => break, // unterminated comment — stop scanning safely
                }
                continue;
            }
            let peek_len = html[i..].len().min(8);
            let peek = html[i..i + peek_len].to_ascii_lowercase();
            if peek.starts_with("<script") || peek.starts_with("<style") {
                let name = if peek.starts_with("<script") { "script" } else { "style" };
                let Some(open_gt) = html[i..].find('>') else { break }; // unterminated open tag
                let after_open = i + open_gt + 1;
                let close = format!("</{name}");
                match html[after_open..].to_ascii_lowercase().find(&close) {
                    Some(rel) => {
                        let close_start = after_open + rel;
                        match html[close_start..].find('>') {
                            Some(gt2) => i = close_start + gt2 + 1,
                            None => break, // unterminated close tag
                        }
                    }
                    None => break, // no closing tag at all — nothing after is safe to claim
                }
                continue;
            }
            let Some(gt) = html[i..].find('>') else { break }; // unterminated tag
            let tag_src = html[i + 1..i + gt].trim_start();
            let is_close = tag_src.starts_with('/');
            let name_src = tag_src.trim_start_matches('/');
            let name_end = name_src.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(name_src.len());
            let tag_name = name_src[..name_end].to_ascii_lowercase();
            if is_close && BLOCK_CLOSE_TAGS.contains(&tag_name.as_str()) {
                pending_boundary = true;
            }
            i += gt + 1;
            continue;
        }
        if cur_start.is_none() {
            cur_start = Some(i);
        }
        let (decoded, consumed) = decode_html_unit(&html[i..]);
        cur_spans.push(i..i + consumed);
        cur_chars.push(decoded);
        i += consumed;
    }
    flush_run!();
    (runs, boundaries)
}

/// Fold an `edit_file` quote the SAME way `flatten_runs` folds the document's
/// own text: `fold_edit_char`, whitespace runs collapsed to one space, edge
/// spaces trimmed. Mirrors `edit_match::collapse_ws` — duplicated rather than
/// shared across the extraction/commands boundary, same as docx.rs already
/// keeps its own copy.
fn fold_needle(s: &str) -> Vec<char> {
    let mut out = Vec::new();
    let mut last_space = true;
    for c in s.chars() {
        match fold_edit_char(c) {
            FoldOut::Space => {
                if !last_space {
                    out.push(' ');
                    last_space = true;
                }
            }
            FoldOut::Drop => {}
            FoldOut::Char(fc) => {
                out.push(fc);
                last_space = false;
            }
            FoldOut::Pair(a, b) => {
                out.push(a);
                out.push(b);
                last_space = false;
            }
        }
    }
    while out.last() == Some(&' ') {
        out.pop();
    }
    out
}

/// Flatten every run into one folded haystack, each entry mapped back to
/// (run_index, char_offset_within_run). A `BLOCK_SENTINEL` sits between runs
/// separated by a block boundary; runs joined only by inline markup get none,
/// so a quote may span them — exactly `scan_docx_text`'s paragraph discipline,
/// ported from Word runs to HTML tags.
fn flatten_runs(runs: &[HtmlTextRun], boundaries: &[bool]) -> (Vec<char>, Vec<(usize, usize)>) {
    let mut hay: Vec<char> = Vec::new();
    let mut map: Vec<(usize, usize)> = Vec::new();
    let mut last_space = true;
    for (ri, run) in runs.iter().enumerate() {
        if ri > 0 && boundaries[ri - 1] {
            hay.push(BLOCK_SENTINEL);
            map.push((usize::MAX, 0));
            last_space = true;
        }
        for (ci, &c) in run.chars.iter().enumerate() {
            match fold_edit_char(c) {
                FoldOut::Space => {
                    if !last_space {
                        hay.push(' ');
                        map.push((ri, ci));
                        last_space = true;
                    }
                }
                FoldOut::Drop => {}
                FoldOut::Char(fc) => {
                    hay.push(fc);
                    map.push((ri, ci));
                    last_space = false;
                }
                FoldOut::Pair(a, b) => {
                    hay.push(a);
                    map.push((ri, ci));
                    hay.push(b);
                    map.push((ri, ci));
                    last_space = false;
                }
            }
        }
    }
    while hay.last() == Some(&' ') {
        hay.pop();
        map.pop();
    }
    (hay, map)
}

fn find_sub(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&s| hay[s..s + needle.len()] == *needle)
}

/// Replace `old` with `new_escaped` across every text run in `html`, tolerant
/// of the same typographic drift `fold_edit_char` corrects for text and docx
/// files. A quote may span inline markup (`<b>`, `<span>`, `<a>`, …) but never
/// a block boundary — crossing one would silently splice two block elements
/// together. `new_escaped` is spliced in literally, so the CALLER must
/// HTML-escape it first (`docs_html::html_escape`) or a replacement containing
/// `<`/`&` would inject markup.
///
/// Replaces EVERY non-overlapping match and returns the new markup plus the
/// match count — mirrors `docx_replace_text`'s pure replace-then-let-the-
/// caller-decide shape: `compute_edit_bytes`'s HTML arm applies the same
/// ambiguity/`all` check the docx arm already applies, so this function never
/// needs to know about `all` at all. `Err` only when nothing matched.
pub fn html_replace_text(html: &str, old: &str, new_escaped: &str) -> Result<(String, usize), String> {
    let needle = fold_needle(old);
    if needle.is_empty() {
        return Err("Could not find that text in the page.".into());
    }
    let (runs, boundaries) = scan_html_runs(html);
    let (hay, map) = flatten_runs(&runs, &boundaries);
    let mut matches: Vec<(usize, usize)> = Vec::new(); // (start, end_inclusive) in hay
    let mut from = 0;
    while let Some(s) = find_sub(&hay, &needle, from) {
        let e = s + needle.len() - 1;
        matches.push((s, e));
        from = e + 1;
    }
    if matches.is_empty() {
        return Err(
            "Could not find that exact text in the page. Copy it exactly, including spacing \
             and punctuation."
                .into(),
        );
    }
    let mut out = html.to_string();
    // Right-to-left so earlier byte offsets in `out` stay valid while later
    // (higher-offset) spans are rewritten first — same discipline as
    // `replace_in_text_nodes`.
    for &(s, e) in matches.iter().rev() {
        let (r1, c1) = map[s];
        let (r2, c2) = map[e];
        if r1 == r2 {
            let run = &runs[r1];
            let start = run.char_spans[c1].start;
            let end = run.char_spans[c2].end;
            out.replace_range(start..end, new_escaped);
        } else {
            // The match is contiguous with no sentinel in between, so it
            // covers: [c1, end) of r1, ALL of every run strictly between,
            // and [0, c2] of r2. Splice right-to-left across those spans.
            let last = &runs[r2];
            let last_end = last.char_spans[c2].end;
            out.replace_range(last.span.start..last_end, "");
            for ri in (r1 + 1..r2).rev() {
                out.replace_range(runs[ri].span.clone(), "");
            }
            let first = &runs[r1];
            let first_start = first.char_spans[c1].start;
            out.replace_range(first_start..first.span.end, new_escaped);
        }
    }
    Ok((out, matches.len()))
}

/// One `<h1>`-`<h6>` heading found in the page.
pub(crate) struct Heading {
    pub level: u8,
    pub text: String,
    /// Byte position right after this heading's OWN closing tag — where the
    /// section it introduces begins.
    pub section_start: usize,
    /// Byte position where this heading's opening tag begins — where the
    /// PRECEDING section ends.
    pub tag_start: usize,
}

fn heading_level(tag_name: &str) -> Option<u8> {
    match tag_name {
        "h1" => Some(1),
        "h2" => Some(2),
        "h3" => Some(3),
        "h4" => Some(4),
        "h5" => Some(5),
        "h6" => Some(6),
        _ => None,
    }
}

/// Every heading in `html`, in document order, with its decoded text (built
/// from `scan_html_runs`'s own runs, so a heading with inline markup like
/// `<h2>Setup <em>and</em> Config</h2>` decodes correctly for free).
pub(crate) fn scan_headings(html: &str) -> Vec<Heading> {
    let (runs, _) = scan_html_runs(html);
    let mut out = Vec::new();
    let n = html.len();
    let mut i = 0usize;
    while i < n {
        if html.as_bytes()[i] != b'<' {
            i += 1;
            continue;
        }
        if html[i..].starts_with("<!--") {
            match html[i..].find("-->") {
                Some(end) => i += end + 3,
                None => break,
            }
            continue;
        }
        let Some(gt) = html[i..].find('>') else { break };
        let tag_src = html[i + 1..i + gt].trim_start();
        if !tag_src.starts_with('/') {
            let name_end = tag_src.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(tag_src.len());
            let tag_name = tag_src[..name_end].to_ascii_lowercase();
            if let Some(level) = heading_level(&tag_name) {
                let tag_start = i;
                let content_start = i + gt + 1;
                let close = format!("</{tag_name}");
                if let Some(rel) = html[content_start..].to_ascii_lowercase().find(&close) {
                    let close_start = content_start + rel;
                    if let Some(gt2) = html[close_start..].find('>') {
                        let section_start = close_start + gt2 + 1;
                        let text: String = runs
                            .iter()
                            .filter(|r| r.span.start >= content_start && r.span.end <= close_start)
                            .flat_map(|r| r.chars.iter())
                            .collect::<String>()
                            .trim()
                            .to_string();
                        out.push(Heading { level, text, section_start, tag_start });
                        i = section_start;
                        continue;
                    }
                }
            }
        }
        i += gt + 1;
    }
    out
}

/// The byte range in `html` that `section` (a heading's text, fold-tolerant)
/// owns: from right after that heading's closing tag to the next heading of
/// the SAME OR HIGHER level (h1 is higher than h2), or the end of the
/// document. `Err` lists every heading actually found, so the model can pick
/// a real one — never falls back to searching the whole document, which
/// would defeat the point of scoping the edit.
pub fn find_section_range(html: &str, section: &str) -> Result<Range<usize>, Vec<String>> {
    let headings = scan_headings(html);
    let needle = fold_needle(section);
    match headings.iter().position(|h| fold_needle(&h.text) == needle) {
        None => Err(headings.into_iter().map(|h| h.text).collect()),
        Some(i) => {
            let level = headings[i].level;
            let start = headings[i].section_start;
            let end = headings[i + 1..]
                .iter()
                .find(|h| h.level <= level)
                .map(|h| h.tag_start)
                .unwrap_or(html.len());
            Ok(start..end)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `html_replace_text`'s `new_escaped` is always ALREADY escaped by the
    // caller (`compute_edit_bytes` uses `docs_html::html_escape`); these
    // tests pass pre-escaped literals directly, exactly as production does.

    #[test]
    fn replaces_text_in_a_single_run() {
        let html = "<p>Q3 revenue was $4M this year.</p>";
        let (out, n) = html_replace_text(html, "$4M", "$5M").unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, "<p>Q3 revenue was $5M this year.</p>");
    }

    #[test]
    fn never_matches_inside_script_or_style() {
        let html = "<html><head><style>p { color: $4M; }</style></head><body>\
                     <script>var x = '$4M';</script><p>The real $4M is here.</p></body></html>";
        let (out, n) = html_replace_text(html, "$4M", "$5M").unwrap();
        assert_eq!(n, 1, "only the real body text should match: {out}");
        assert!(out.contains("color: $4M"), "style body must survive untouched");
        assert!(out.contains("var x = '$4M'"), "script body must survive untouched");
        assert!(out.contains("The real $5M is here"));
    }

    #[test]
    fn never_matches_attribute_text() {
        let html = r#"<img src="a.png" alt="Q3 revenue was $4M"><p>Q3 revenue was $4M.</p>"#;
        let (out, n) = html_replace_text(html, "$4M", "$5M").unwrap();
        assert_eq!(n, 1);
        assert!(out.contains(r#"alt="Q3 revenue was $4M""#), "attribute text must survive");
        assert!(out.contains("Q3 revenue was $5M."));
    }

    #[test]
    fn splices_in_the_replacement_literally_escaping_is_the_callers_job() {
        // The caller HTML-escapes before calling; this function must never
        // do it a second time, or a legitimately escaped replacement would
        // come out double-escaped (`&amp;amp;`).
        let (out, n) = html_replace_text("<p>old</p>", "old", "&lt;b&gt;new&lt;/b&gt;").unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, "<p>&lt;b&gt;new&lt;/b&gt;</p>");
    }

    #[test]
    fn matches_across_entities() {
        let html = "<p>Terms &amp; Conditions apply.</p>";
        // The needle is plain text; the source's `&amp;` decodes to `&` for
        // matching purposes. The replacement is pre-escaped by the caller.
        let (out, n) =
            html_replace_text(html, "Terms & Conditions", "Rules &amp; Guidelines").unwrap();
        assert_eq!(n, 1);
        assert!(out.contains("Rules &amp; Guidelines"), "got: {out}");
    }

    #[test]
    fn replaces_a_match_spanning_inline_bold() {
        // "was $4M this" spans run0's suffix, all of the <strong> run, and
        // run2's prefix. The whole replacement lands in run0 (first run wins,
        // same as docx); <strong></strong> survives, emptied.
        let html = "<p>Q3 revenue was <strong>$4M</strong> this year.</p>";
        let (out, n) = html_replace_text(html, "was $4M this", "was $5M this").unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, "<p>Q3 revenue was $5M this<strong></strong> year.</p>");
    }

    #[test]
    fn never_matches_across_a_paragraph_boundary() {
        // Same word on both sides, back to back, with NOTHING between the
        // closing and opening tags — if the boundary sentinel were missing,
        // "HelloHello" would read as one contiguous match. It must not.
        let html = "<p>Hello</p><p>Hello</p>";
        let err = html_replace_text(html, "HelloHello", "x").unwrap_err();
        assert!(err.contains("Could not find"));
        // Each paragraph's own "Hello" is still independently editable.
        let (out, n) = html_replace_text(html, "Hello", "Hi").unwrap();
        assert_eq!(n, 2);
        assert_eq!(out, "<p>Hi</p><p>Hi</p>");
    }

    #[test]
    fn a_cross_run_match_lands_in_the_first_run_and_clears_the_rest() {
        // "total up" spans three runs joined by inline tags: all of <b>total</b>,
        // the bare space between the tags, and all of <i>up</i>. Same discipline
        // as `replace_in_text_nodes`: the whole replacement lands in the FIRST
        // run (keeping its <b> formatting); the matched remainder in later runs
        // is cleared, leaving <i></i> empty rather than deleting the tag itself.
        let html = "<p>Revenue: <b>total</b> <i>up</i> this year.</p>";
        let (out, n) = html_replace_text(html, "total up", "sum higher").unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, "<p>Revenue: <b>sum higher</b><i></i> this year.</p>");
    }

    #[test]
    fn replaces_every_occurrence_unconditionally_ambiguity_is_the_callers_job() {
        // html_replace_text always replaces every match — the ambiguity/`all`
        // decision belongs to compute_edit_bytes, mirroring docx_replace_text.
        let html = "<p>total is $4M</p><p>total is $4M</p>";
        let (out, n) = html_replace_text(html, "$4M", "$5M").unwrap();
        assert_eq!(n, 2);
        assert_eq!(out.matches("$5M").count(), 2);
    }

    #[test]
    fn survives_malformed_markup() {
        let html = "<p>Hello <b>world";
        // Unterminated <b> tag: the scanner must stop safely, not panic.
        let result = html_replace_text(html, "Hello", "Hi");
        assert!(result.is_ok());
    }

    #[test]
    fn survives_an_unterminated_script_tag() {
        let html = "<p>Keep me.</p><script>var x = 1;";
        let result = html_replace_text(html, "Keep me", "Kept");
        assert!(result.is_ok());
        assert_eq!(result.unwrap().0, "<p>Kept.</p><script>var x = 1;");
    }

    #[test]
    fn is_idempotent_edit_then_revert_is_byte_identical() {
        let html = "<p>Q3 revenue was $4M this year.</p>";
        let (once, _) = html_replace_text(html, "$4M", "$5M").unwrap();
        let (back, _) = html_replace_text(&once, "$5M", "$4M").unwrap();
        assert_eq!(back, html);
    }

    #[test]
    fn tolerates_curly_quotes_like_the_text_and_docx_matchers() {
        let html = "<p>She said \u{201C}hello\u{201D} to me.</p>";
        let (out, n) = html_replace_text(html, "\"hello\"", "\"goodbye\"").unwrap();
        assert_eq!(n, 1);
        assert!(out.contains("goodbye"), "got: {out}");
    }

    #[test]
    fn scan_headings_reads_level_and_decoded_text_including_inline_markup() {
        let html = "<h1>Intro</h1><p>a</p><h2>Setup <em>and</em> Config</h2><p>b</p>";
        let headings = scan_headings(html);
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[0].text, "Intro");
        assert_eq!(headings[1].level, 2);
        assert_eq!(headings[1].text, "Setup and Config");
    }

    #[test]
    fn section_range_runs_to_the_next_same_or_higher_heading() {
        let html = "<h1>A</h1><p>a-body</p><h2>A.1</h2><p>a1-body</p><h1>B</h1><p>b-body</p>";
        // Section "A" (h1) ends at the next h1 ("B"), so it swallows the h2
        // sub-section "A.1" too — a sub-heading doesn't end its parent's section.
        let range = find_section_range(html, "A").unwrap();
        let section = &html[range];
        assert!(section.contains("a-body"));
        assert!(section.contains("A.1"));
        assert!(section.contains("a1-body"));
        assert!(!section.contains("b-body"), "must stop before the next h1: {section}");

        // The h2 sub-section ends at the next heading of same-or-higher level,
        // i.e. right at the following h1.
        let sub = find_section_range(html, "A.1").unwrap();
        let sub_text = &html[sub];
        assert!(sub_text.contains("a1-body"));
        assert!(!sub_text.contains("b-body"));
    }

    #[test]
    fn unknown_section_lists_the_real_headings_found() {
        let html = "<h1>Intro</h1><p>a</p><h2>Setup</h2><p>b</p>";
        let err = find_section_range(html, "Nonexistent").unwrap_err();
        assert_eq!(err, vec!["Intro".to_string(), "Setup".to_string()]);
    }

    #[test]
    fn last_section_runs_to_the_end_of_the_document() {
        let html = "<h1>Only</h1><p>only-body</p>";
        let range = find_section_range(html, "Only").unwrap();
        assert_eq!(&html[range], "<p>only-body</p>");
    }
}
