pub(crate) fn extract_pdf(bytes: &[u8]) -> Option<String> {
    // pdf-extract can panic on malformed files; contain it.
    let bytes = bytes.to_vec();
    std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&bytes).ok())
        .ok()
        .flatten()
        .map(|t| fix_visual_hebrew(&t))
}

// ---------------------------------------------------------------- RTL repair
//
// Many Hebrew PDFs carry their text in VISUAL order (left-to-right glyph
// order, i.e. each line is character-reversed) because that's how the page
// was typeset. pdf-extract reads glyphs in page order, so a Hebrew Bible
// comes out mirrored — "׃םֽ ֶכיֵלְל" instead of "לְלֵיכֶֽם׃" — with a space
// between glyph clusters inside words and a wider gap between real words.
// A model reading that sees gibberish, and search can never match it.

fn is_heb_letter(c: char) -> bool {
    ('\u{05D0}'..='\u{05EA}').contains(&c)
}

/// Hebrew combining marks: cantillation (0591–05AF) + points (05B0–05C7),
/// excluding the punctuation characters inside that block (maqaf, paseq,
/// sof pasuq, nun hafukha).
pub(crate) fn is_heb_mark(c: char) -> bool {
    ('\u{0591}'..='\u{05C7}').contains(&c)
        && !matches!(c, '\u{05BE}' | '\u{05C0}' | '\u{05C3}' | '\u{05C6}')
}

/// Drop nikud + cantillation. The FTS tokenizer (unicode61) treats these
/// combining marks as SEPARATORS, so a pointed word like קֹהֶלֶת indexes as
/// meaningless single-letter fragments and a plain קהלת query can never
/// match — search text must be consonantal.
pub(crate) fn strip_hebrew_marks(text: &str) -> String {
    if !text.chars().any(is_heb_mark) {
        return text.to_string();
    }
    text.chars().filter(|c| !is_heb_mark(*c)).collect()
}

/// Detect visual-order Hebrew from its signature artifact: clusters emitted
/// as `space + mark(s) + base`, i.e. combining marks that FOLLOW a space. In
/// logical Hebrew a mark virtually never follows a space (it always follows
/// its base letter); in this extractor's visual output most clusters do.
fn looks_visual_hebrew(text: &str) -> bool {
    let mut letters = 0usize;
    let mut orphan_marks = 0usize;
    let mut prev_space = false;
    for c in text.chars().take(400_000) {
        if is_heb_letter(c) {
            letters += 1;
        } else if is_heb_mark(c) && prev_space {
            orphan_marks += 1;
        }
        prev_space = c.is_whitespace();
    }
    letters > 200 && orphan_marks > 50 && orphan_marks * 20 > letters
}

/// Restore logical order for visual-order Hebrew text, line by line:
/// reverse the line, un-mirror embedded digit/Latin runs, re-attach
/// combining marks that ended up before their base, and collapse the
/// glyph-cluster spaces (single space inside a word; 2+ spaces was the real
/// word gap). Lines without Hebrew pass through untouched. No-op unless the
/// document as a whole looks visual-order.
pub(crate) fn fix_visual_hebrew(text: &str) -> String {
    if !looks_visual_hebrew(text) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let heb = line.chars().filter(|c| is_heb_letter(*c)).count();
        if heb < 2 {
            out.push_str(line);
            continue;
        }
        // 1. Mirror the line back to logical order.
        let mut chars: Vec<char> = line.chars().rev().collect();
        // 2. Digit/Latin runs got mirrored too ("13" → "31") — flip them back.
        let mut j = 0;
        while j < chars.len() {
            if chars[j].is_ascii_alphanumeric() {
                let start = j;
                while j < chars.len() && chars[j].is_ascii_alphanumeric() {
                    j += 1;
                }
                chars[start..j].reverse();
            } else {
                j += 1;
            }
        }
        // 3. Clusters the extractor emitted as (base, mark) are now
        //    (mark, base) — move any mark-run that sits after a space/start
        //    and directly before a letter back behind that letter.
        let mut fixed: Vec<char> = Vec::with_capacity(chars.len());
        let mut j = 0;
        while j < chars.len() {
            let at_boundary = fixed.last().is_none_or(|c| !is_heb_letter(*c) && !is_heb_mark(*c));
            if at_boundary && is_heb_mark(chars[j]) {
                let start = j;
                while j < chars.len() && is_heb_mark(chars[j]) {
                    j += 1;
                }
                if j < chars.len() && is_heb_letter(chars[j]) {
                    fixed.push(chars[j]);
                    fixed.extend(&chars[start..j]);
                    j += 1;
                } else {
                    fixed.extend(&chars[start..j]);
                }
            } else {
                fixed.push(chars[j]);
                j += 1;
            }
        }
        // 4. Spaces: a single space was a glyph-cluster gap INSIDE a word —
        //    drop it when it sits between Hebrew text on both sides; runs of
        //    2+ spaces were the real word separators.
        let mut cleaned = String::with_capacity(fixed.len());
        let mut j = 0;
        while j < fixed.len() {
            if fixed[j] == ' ' {
                let start = j;
                while j < fixed.len() && fixed[j] == ' ' {
                    j += 1;
                }
                let run = j - start;
                let prev_heb = cleaned
                    .chars()
                    .last()
                    .is_some_and(|c| is_heb_letter(c) || is_heb_mark(c));
                let next_heb = fixed
                    .get(j)
                    .is_some_and(|c| is_heb_letter(*c) || is_heb_mark(*c));
                if run >= 2 || !(prev_heb && next_heb) {
                    cleaned.push(' ');
                }
                // else: intra-word cluster gap — dropped.
            } else {
                cleaned.push(fixed[j]);
                j += 1;
            }
        }
        out.push_str(&cleaned);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consonants(s: &str) -> String {
        s.chars().filter(|c| !is_heb_mark(*c)).collect()
    }

    #[test]
    fn visual_hebrew_is_mirrored_back_to_logical() {
        // A REAL line from pdf-extract on a visual-order Hebrew Bible PDF
        // (מִפְּנֵי רֹעַ מַעַלְלֵיכֶם׃ — mirrored, cluster-spaced), repeated so
        // the document-level detector has enough signal.
        let line = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ";
        let doc = format!("{line}\n").repeat(60);
        let fixed = fix_visual_hebrew(&doc);
        let first = fixed.lines().next().unwrap();
        // Letter order restored: the verse now STARTS with mem and ENDS with
        // sof pasuq, and the long word reads forward.
        let cons = consonants(first);
        assert!(cons.starts_with('מ'), "got: {cons}");
        assert!(cons.ends_with('׃'), "got: {cons}");
        assert!(cons.contains("מעלליכם"), "got: {cons}");
        // No combining mark is left dangling after a space.
        let chars: Vec<char> = first.chars().collect();
        for w in chars.windows(2) {
            assert!(
                !(w[0] == ' ' && is_heb_mark(w[1])),
                "orphan mark after space in: {first}"
            );
        }
    }

    #[test]
    fn logical_hebrew_and_english_pass_through_untouched() {
        // Properly-extracted (logical) Hebrew has no space+mark clusters, so
        // the detector must not fire — even for a large document.
        let logical = "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ׃\n".repeat(200);
        assert_eq!(fix_visual_hebrew(&logical), logical);
        let english = "The quick brown fox jumps over the lazy dog.\n".repeat(200);
        assert_eq!(fix_visual_hebrew(&english), english);
    }

    #[test]
    fn digit_runs_survive_the_mirror() {
        // Verse/page numbers inside a reversed Hebrew line must not come out
        // as mirrored numbers ("13" → "31").
        let line = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ 13";
        let doc = format!("{line}\n").repeat(60);
        let fixed = fix_visual_hebrew(&doc);
        let first = fixed.lines().next().unwrap();
        assert!(first.contains("13"), "digits mirrored: {first}");
        assert!(!first.contains("31"), "digits mirrored: {first}");
    }

    /// Manual probe: run the app's EXACT extraction on a real PDF and report
    /// timing + text quality. Usage:
    ///   PR_PDF=/path/to/file.pdf cargo test --lib real_pdf_extraction -- --ignored --nocapture
    #[test]
    #[ignore = "manual probe on a real PDF; set PR_PDF"]
    fn real_pdf_extraction_probe() {
        let Ok(path) = std::env::var("PR_PDF") else {
            eprintln!("SKIP: set PR_PDF=/path/to/file.pdf");
            return;
        };
        let bytes = std::fs::read(&path).expect("readable file");
        eprintln!("file: {path} ({} bytes)", bytes.len());
        let t = std::time::Instant::now();
        let text = extract_pdf(&bytes);
        let secs = t.elapsed().as_secs_f32();
        match text {
            None => eprintln!("EXTRACTION FAILED after {secs:.1}s (panic or parse error)"),
            Some(t) => {
                let total = t.chars().count();
                let alnum = t.chars().filter(|c| c.is_alphanumeric()).count();
                let hebrew = t.chars().filter(|c| ('\u{0590}'..='\u{05FF}').contains(c)).count();
                eprintln!(
                    "extracted {total} chars in {secs:.1}s — {alnum} alphanumeric, {hebrew} hebrew"
                );
                let sample: String = t.chars().skip(total / 2).take(400).collect();
                eprintln!("--- sample from the middle ---\n{sample}\n---");
                // PR_FIND: report occurrences of a term, marks-stripped, with
                // context — verifies a word is actually reachable by search.
                if let Ok(term) = std::env::var("PR_FIND") {
                    let stripped: String = t.chars().filter(|c| !is_heb_mark(*c)).collect();
                    let hits: Vec<usize> =
                        stripped.match_indices(&term).map(|(i, _)| i).take(10).collect();
                    eprintln!("\"{term}\": {} occurrence(s) (marks stripped)", hits.len());
                    for i in hits.iter().take(3) {
                        let s = stripped[..*i].chars().rev().take(30).collect::<String>();
                        let pre: String = s.chars().rev().collect();
                        let post: String = stripped[*i..].chars().take(40).collect();
                        eprintln!("  …{pre}⟨{post}⟩…");
                    }
                }
            }
        }
    }
}
