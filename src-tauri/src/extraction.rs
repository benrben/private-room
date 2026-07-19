use std::io::Read;

mod chunking;
mod docx;
mod html;
mod pdf;
mod pptx;
mod window;
mod xlsx;

pub use chunking::*;
pub use window::*;
pub use docx::*;
pub use html::*;
pub(crate) use pdf::*;
pub(crate) use pptx::*;
pub(crate) use xlsx::*;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yml", "yaml", "toml", "ini",
    "rs", "py", "js", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp", "cs", "go", "rb",
    "php", "swift", "kt", "sh", "zsh", "bash", "sql", "r", "m", "scala", "lua", "pl", "css",
    "scss", "less", "vue", "svelte", "tex", "org", "rst",
];

pub fn extension_of(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn is_image(mime: &str) -> bool {
    mime.starts_with("image/")
}

pub fn is_text_extension(ext: &str) -> bool {
    TEXT_EXTENSIONS.contains(&ext)
}

/// Wave 2 (Idea 4): how one character folds when matching an edit's `old_text`
/// against a file's raw bytes. This is the ONE normalization table shared by
/// the plain-text fuzzy matcher (`commands::edit_match`) and the docx run-split
/// matcher (`extraction::docx`), so both tolerate the same typographic drift a
/// model introduces (curly quotes, NBSP/narrow-NBSP/CRLF, dash variants, ligatures).
///
/// Deliberately NOT `normalize_for_match` (agent.rs): that one lowercases and
/// strips nikud for ANNOTATION lookup, which is safe because it only highlights.
/// Edits rewrite bytes, so case must stay exact — a fuzzy hit must never land on
/// a case-variant of a different passage. No lowercasing, no nikud stripping here.
pub(crate) enum FoldOut {
    /// Any whitespace (space, tab, CR, LF, NBSP U+00A0, narrow-NBSP U+202F,
    /// U+2000–U+200A, U+3000, …). Collapsed to a single space by the matchers.
    Space,
    /// Zero-widths — dropped entirely so they never block a match.
    Drop,
    /// A 1:1 fold to the given char (or the char unchanged).
    Char(char),
    /// A byte-safe 1→2 expansion (ligatures). Both chars map to the ORIGINAL
    /// char's byte span, so span math stays char-boundary-safe on either side.
    Pair(char, char),
}

pub(crate) fn fold_edit_char(c: char) -> FoldOut {
    match c {
        // Zero-widths: must precede the whitespace guard (U+200B is NOT
        // White_Space in Unicode, and U+FEFF is a BOM/no-break marker).
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' => FoldOut::Drop,
        // Curly / modifier apostrophes → straight single quote.
        '\u{2018}' | '\u{2019}' | '\u{02BC}' => FoldOut::Char('\''),
        // Curly double quotes → straight double quote.
        '\u{201C}' | '\u{201D}' => FoldOut::Char('"'),
        // Hyphen/dash/minus/maqaf family → ASCII hyphen.
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}'
        | '\u{05BE}' => FoldOut::Char('-'),
        // fi/fl ligatures — byte-safe expansion, parity with normalize_for_match.
        // Extracted PDF/docx text often carries these while the model types ASCII.
        '\u{FB01}' => FoldOut::Pair('f', 'i'),
        '\u{FB02}' => FoldOut::Pair('f', 'l'),
        // All remaining whitespace — Rust's is_whitespace covers NBSP, narrow
        // NBSP, en/em spaces, ideographic space, CR/LF/tab, line/para separators.
        c if c.is_whitespace() => FoldOut::Space,
        _ => FoldOut::Char(c),
    }
}

/// Extract readable text from a file's bytes, best-effort. Returns None for
/// formats we can't read (images, unknown binaries).
pub fn extract_text(name: &str, bytes: &[u8]) -> Option<String> {
    let ext = extension_of(name);
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return Some(String::from_utf8_lossy(bytes).into_owned());
    }
    match ext.as_str() {
        "pdf" => extract_pdf(bytes),
        "docx" => extract_docx(bytes),
        "xlsx" => extract_xlsx(bytes),
        "pptx" => extract_pptx(bytes),
        "html" | "htm" => Some(strip_html(&String::from_utf8_lossy(bytes))),
        _ => None,
    }
    .map(|t| normalize_whitespace(&t))
    .filter(|t| !t.trim().is_empty())
}

/// Hard ceiling on the decompressed size of a single Office zip entry
/// (document.xml, slideN.xml, …). Real Office parts are a few MB at most; a
/// tiny archive that inflates past this is a decompression bomb, not a doc.
const MAX_ZIP_ENTRY_BYTES: u64 = 100 * 1024 * 1024;

pub(crate) fn read_zip_entry(bytes: &[u8], entry: &str) -> Option<String> {
    read_zip_entry_capped(bytes, entry, MAX_ZIP_ENTRY_BYTES)
}

fn read_zip_entry_capped(bytes: &[u8], entry: &str, cap: u64) -> Option<String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let file = archive.by_name(entry).ok()?;
    // Declared sizes can lie, so the `take` below is the real guard; checking
    // the header first just skips the allocation for an honest oversized entry.
    if file.size() > cap {
        return None;
    }
    let mut content = String::new();
    file.take(cap + 1).read_to_string(&mut content).ok()?;
    if content.len() as u64 > cap {
        return None;
    }
    Some(content)
}

/// Universal fallback: Microsoft's MarkItDown CLI converts almost any format
/// (ppt, doc, xls, epub, …) to Markdown. Used only if the user has it
/// installed (`pipx install markitdown`); GUI apps don't inherit a shell
/// PATH, so common install locations are probed explicitly.
pub fn markitdown_extract(path: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "markitdown".to_string(),
        "/opt/homebrew/bin/markitdown".to_string(),
        "/usr/local/bin/markitdown".to_string(),
        format!("{home}/.local/bin/markitdown"),
    ];
    for bin in &candidates {
        match std::process::Command::new(bin).arg(path).output() {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).into_owned();
                if !text.trim().is_empty() {
                    return Some(normalize_whitespace(&text));
                }
            }
            _ => continue,
        }
    }
    None
}

pub(crate) fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    // Track the open quote while inside a tag so a `>` embedded in a quoted
    // attribute value doesn't terminate the tag early. Parsoid-rendered
    // Wikipedia pages carry whole infobox/template wikitext inside
    // `data-mw='{…}'` attributes whose JSON holds literal `<ref>`/`<br/>`
    // markup; without quote-awareness the first stray `>` flipped the scanner
    // back out of the tag and dumped that raw template JSON into the text.
    let mut quote: Option<char> = None;
    for c in input.chars() {
        if in_tag {
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None => match c {
                    '"' | '\'' => quote = Some(c),
                    '>' => {
                        in_tag = false;
                        out.push(' ');
                    }
                    _ => {}
                },
            }
        } else if c == '<' {
            in_tag = true;
        } else {
            out.push(c);
        }
    }
    decode_basic_entities(&out)
}

/// Text of an OOXML part, keeping its paragraph structure: the paragraph close
/// tag (`</w:p>` in Word, `</a:p>` in PowerPoint) becomes a newline before the
/// markup is stripped, so paragraphs don't collapse into one run-on line.
pub(crate) fn xml_paras_to_text(xml: &str, para_close: &str) -> String {
    strip_tags(&xml.replace(para_close, &format!("{para_close}\n")))
}

pub(crate) fn decode_basic_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn normalize_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_lines = 0;
    for line in s.lines() {
        let trimmed: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            blank_lines += 1;
            if blank_lines <= 1 {
                out.push('\n');
            }
        } else {
            blank_lines = 0;
            out.push_str(&trimmed);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_zip_entry_refuses_entries_over_cap() {
        // Decompression-bomb guard: an entry whose decompressed size exceeds
        // the cap must yield None instead of ballooning memory.
        let bytes = fake_office_zip("word/document.xml", "0123456789");
        assert_eq!(
            read_zip_entry_capped(&bytes, "word/document.xml", 64).as_deref(),
            Some("0123456789")
        );
        assert!(read_zip_entry_capped(&bytes, "word/document.xml", 9).is_none());
    }

    #[test]
    fn strip_tags_ignores_gt_inside_quoted_attribute() {
        // Regression: Parsoid-rendered Wikipedia carries whole template wikitext
        // inside a single-quoted `data-mw='{…}'` attribute whose JSON holds
        // literal `<ref>`/`>` markup. A quote-naive scanner treated the first
        // stray `>` as the tag close and dumped the raw JSON into the text.
        let html = r#"<div data-mw='{"wt":"{{coord|52|N}}<ref>x</ref>"}'>Berlin</div>"#;
        assert_eq!(strip_tags(html).trim(), "Berlin");
        // Both quote styles, and normal tags, still strip cleanly.
        assert_eq!(strip_tags(r#"<a href="x>y">link</a>"#).trim(), "link");
        assert_eq!(strip_tags("<b>bold</b> text").trim(), "bold  text".trim());
    }
}

/// Shared test helper: build a minimal Office-style zip with a single entry.
#[cfg(test)]
pub(crate) fn fake_office_zip(entry: &str, xml: &str) -> Vec<u8> {
    use std::io::Write;
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(entry, options).unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        writer.finish().unwrap();
    }
    cursor.into_inner()
}
