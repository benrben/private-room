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
    // Every reader below parses UNTRUSTED bytes with a third-party crate
    // (pdf-extract, umya-spreadsheet, zip). Import runs these on
    // `spawn_blocking` with the room mutex HELD, so a panic on one malformed
    // file used to cost far more than that file: the panic became an opaque
    // JoinError ("The import could not be started"), and it left the room lock
    // poisoned, so every later room operation panicked too on a message that
    // pointed at nothing. A bad file must only cost its own text.
    contain_parser_panic(|| match ext.as_str() {
        "pdf" => extract_pdf(bytes),
        "docx" => extract_docx(bytes),
        "xlsx" => extract_xlsx(bytes),
        "pptx" => extract_pptx(bytes),
        "html" | "htm" => Some(strip_html(&String::from_utf8_lossy(bytes))),
        // Two formats that used to import fine and then be unreadable to both
        // search and the assistant unless the optional MarkItDown CLI happened
        // to be installed. Both are cheap to read natively: an EPUB is a zip of
        // XHTML, and RTF is plain ASCII with control words.
        "epub" => extract_epub(bytes),
        "rtf" => extract_rtf(&String::from_utf8_lossy(bytes)),
        _ => None,
    })
    .map(|t| normalize_whitespace(&t))
    .filter(|t| !t.trim().is_empty())
}

/// Run one document reader, turning a panic inside it into "no text".
/// `AssertUnwindSafe` is honest here: the closure borrows only the caller's
/// `&[u8]`/`&str`, so an aborted read leaves nothing half-written behind.
fn contain_parser_panic(read: impl FnOnce() -> Option<String>) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(read)).unwrap_or(None)
}

/// Hard ceiling on the decompressed size of a single Office zip entry
/// (document.xml, slideN.xml, …). Real Office parts are a few MB at most; a
/// tiny archive that inflates past this is a decompression bomb, not a doc.
const MAX_ZIP_ENTRY_BYTES: u64 = 100 * 1024 * 1024;

/// Every entry name in an Office archive, in archive order. Empty for bytes
/// that aren't a readable zip — callers treat "no such part" the same way.
pub(crate) fn zip_entry_names(bytes: &[u8]) -> Vec<String> {
    zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map(|archive| archive.file_names().map(String::from).collect())
        .unwrap_or_default()
}

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

/// An e-book is a zip of XHTML documents, so the HTML reader already knows how
/// to read one. Chapters are taken in the book's own reading order (the OPF
/// spine) when that can be read, and in name order otherwise — which is what
/// the conventional `chapter001.xhtml` naming produces anyway.
pub(crate) fn extract_epub(bytes: &[u8]) -> Option<String> {
    let names = zip_entry_names(bytes);
    let mut docs: Vec<String> = names
        .iter()
        .filter(|n| {
            let lower = n.to_ascii_lowercase();
            (lower.ends_with(".xhtml") || lower.ends_with(".html") || lower.ends_with(".htm"))
                && !lower.starts_with("meta-inf/")
        })
        .cloned()
        .collect();
    docs.sort();
    let spine = epub_spine_order(bytes, &names);
    docs.sort_by_key(|n| spine.iter().position(|s| s == n).unwrap_or(usize::MAX));
    let mut out = String::new();
    for entry in docs {
        let remaining = MAX_ZIP_ENTRY_BYTES.saturating_sub(out.len() as u64);
        if remaining == 0 {
            break;
        }
        let Some(xml) = read_zip_entry_capped(bytes, &entry, remaining) else { continue };
        let text = strip_html(&xml);
        if text.trim().is_empty() {
            continue;
        }
        out.push_str(&text);
        out.push('\n');
    }
    (!out.trim().is_empty()).then_some(out)
}

/// Reading order from the book's OPF package: `<itemref idref="…">` in the
/// spine, resolved through `<item id="…" href="…">` in the manifest and made
/// archive-relative. Best-effort — an unreadable package just means name order.
fn epub_spine_order(bytes: &[u8], names: &[String]) -> Vec<String> {
    let Some(opf_name) = names.iter().find(|n| n.to_ascii_lowercase().ends_with(".opf")) else {
        return Vec::new();
    };
    let Some(opf) = read_zip_entry(bytes, opf_name) else { return Vec::new() };
    let base = opf_name.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut manifest: Vec<(String, String)> = Vec::new();
    for tag in opf.split("<item ").skip(1) {
        if let (Some(id), Some(href)) = (xml_attr(tag, "id"), xml_attr(tag, "href")) {
            let full = if base.is_empty() { href } else { format!("{base}/{href}") };
            manifest.push((id, full));
        }
    }
    opf.split("<itemref")
        .skip(1)
        .filter_map(|tag| xml_attr(tag, "idref"))
        .filter_map(|idref| manifest.iter().find(|(id, _)| *id == idref).map(|(_, h)| h.clone()))
        .collect()
}

/// The value of `name="…"` (or `name='…'`) inside an XML tag body.
fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let head = &tag[..tag.find('>').unwrap_or(tag.len())];
    let at = head.find(&format!("{name}="))?;
    let rest = &head[at + name.len() + 1..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &rest[quote.len_utf8()..];
    let end = body.find(quote)?;
    Some(decode_basic_entities(&body[..end]))
}

/// Windows-1252 — the code page `\ansi` RTF means by default, and the one Word
/// and TextEdit actually write. 0x00–0x7F is ASCII and 0xA0–0xFF is Latin-1
/// (so the byte IS the code point); only 0x80–0x9F differ, and five of those
/// are undefined (`None`).
fn cp1252_char(b: u8) -> Option<char> {
    const HIGH: [u16; 32] = [
        0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
        0x2039, 0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013,
        0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
    ];
    if (0x80..0xA0).contains(&b) {
        return char::from_u32(HIGH[(b - 0x80) as usize] as u32).filter(|c| *c != '\0');
    }
    Some(b as char)
}

/// Plain text out of an RTF document: RTF is ASCII with backslash control
/// words, `\'xx` hex escapes and brace groups. Groups whose control word marks
/// them as metadata (fonts, colours, stylesheets, generator info) are skipped
/// whole — otherwise their font names land in the search index as prose.
///
/// Both escape forms for non-ASCII text are decoded, and that is load-bearing:
/// they used to become a space, so "Le siège social" reached the search index
/// and the model as "Le si ge social" — the word split in two — and because the
/// reader still returned text for the ASCII around it, the MarkItDown fallback
/// in `import_files` (empty-text only) never ran to do better.
pub(crate) fn extract_rtf(rtf: &str) -> Option<String> {
    const SKIP_GROUPS: &[&str] = &[
        "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata",
        "generator", "listtable", "listoverridetable", "rsidtbl", "xmlnstbl", "datastore",
    ];
    let mut out = String::new();
    let mut chars = rtf.chars().peekable();
    let mut depth = 0usize;
    // Depth of the group currently being skipped, if any.
    let mut skipping: Option<usize> = None;
    // `\ansicpg N` — the code page `\'xx` bytes are written in. Absent means
    // the `\ansi` default, 1252. Anything else is left as a space rather than
    // guessed at: the wrong letters would be worse in the index than a gap.
    let mut codepage: u32 = 1252;
    // `\ucN` — how many characters of ANSI fallback follow each `\uN` escape
    // for readers that can't do Unicode. Default 1 per the spec.
    let mut uc: usize = 1;
    while let Some(c) = chars.next() {
        match c {
            '{' => depth += 1,
            '}' => {
                if skipping == Some(depth) {
                    skipping = None;
                }
                depth = depth.saturating_sub(1);
            }
            '\\' => {
                let Some(&next) = chars.peek() else { break };
                if next == '\'' {
                    chars.next();
                    let hex: String = (0..2).filter_map(|_| chars.next()).collect();
                    if let Ok(b) = u8::from_str_radix(&hex, 16) {
                        if skipping.is_none() {
                            let decoded = if b.is_ascii() {
                                Some(b as char)
                            } else if codepage == 1252 {
                                cp1252_char(b)
                            } else {
                                None
                            };
                            // A space still keeps the word boundary for a code
                            // page we can't decode.
                            out.push(decoded.unwrap_or(' '));
                        }
                    }
                    continue;
                }
                if !next.is_ascii_alphabetic() {
                    // An escaped literal: \\ \{ \} and friends.
                    chars.next();
                    if skipping.is_none() && matches!(next, '\\' | '{' | '}') {
                        out.push(next);
                    }
                    continue;
                }
                let mut word = String::new();
                while chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
                    word.push(chars.next().unwrap());
                }
                // A numeric parameter, then one optional space delimiter.
                let mut num = String::new();
                while chars.peek().is_some_and(|c| c.is_ascii_digit() || *c == '-') {
                    num.push(chars.next().unwrap());
                }
                if chars.peek() == Some(&' ') {
                    chars.next();
                }
                match word.as_str() {
                    "ansicpg" => {
                        codepage = num.parse().unwrap_or(1252);
                        continue;
                    }
                    "uc" => {
                        // Clamped: real documents use 0, 1 or 2, and a crafted
                        // oversized count would otherwise swallow the rest of a group.
                        uc = num.parse().unwrap_or(1).min(16);
                        continue;
                    }
                    "u" => {
                        // The fallback characters are swallowed whether or not
                        // we are inside a skipped group — they are not text.
                        skip_rtf_fallback(&mut chars, uc);
                        // A negative parameter is the code unit written as a
                        // signed 16-bit integer. Widened before the shift so a
                        // malformed `\u-2147483648` can't overflow.
                        if skipping.is_none() {
                            if let Ok(n) = num.parse::<i64>() {
                                let cp = if n < 0 { n + 65536 } else { n };
                                if let Some(ch) = u32::try_from(cp).ok().and_then(char::from_u32) {
                                    out.push(ch);
                                }
                            }
                        }
                        continue;
                    }
                    _ => {}
                }
                if skipping.is_some() {
                    continue;
                }
                if SKIP_GROUPS.contains(&word.as_str()) {
                    skipping = Some(depth);
                } else if matches!(word.as_str(), "par" | "line" | "pard" | "sect" | "page") {
                    out.push('\n');
                } else if word == "tab" {
                    out.push(' ');
                }
            }
            '\r' | '\n' => {}
            _ if skipping.is_none() => out.push(c),
            _ => {}
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

/// Consume the `\ucN` characters of ANSI fallback that follow a `\uN` escape.
/// A `\'xx` escape or a control word each count as ONE character; a group
/// boundary ends the run early (the fallback never crosses one).
fn skip_rtf_fallback(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, count: usize) {
    for _ in 0..count {
        match chars.peek() {
            Some('\\') => {
                chars.next();
                match chars.peek().copied() {
                    Some('\'') => {
                        chars.next();
                        chars.next();
                        chars.next();
                    }
                    Some(c) if !c.is_ascii_alphabetic() => {
                        chars.next();
                    }
                    Some(_) => {
                        while chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
                            chars.next();
                        }
                        while chars.peek().is_some_and(|c| c.is_ascii_digit() || *c == '-') {
                            chars.next();
                        }
                        if chars.peek() == Some(&' ') {
                            chars.next();
                        }
                    }
                    None => return,
                }
            }
            Some('{') | Some('}') | None => return,
            Some(_) => {
                chars.next();
            }
        }
    }
}

/// Hard ceiling on one MarkItDown conversion. The tool is optional and
/// third-party, and it used to be awaited with no limit at all: a converter
/// that hung took the whole import — and the window with it — down to a force
/// quit. Generous enough for a large book, short enough to stay an import.
const MARKITDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// What one attempt at a MarkItDown binary produced.
enum MarkItDown {
    /// Couldn't be started at all (not installed at this path) — try the next.
    NotRunnable,
    /// Ran and exited non-zero — try the next candidate path.
    Failed,
    /// Still running when the deadline passed; the child was killed.
    TimedOut,
    Text(String),
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
        match run_markitdown(bin, path, MARKITDOWN_TIMEOUT) {
            MarkItDown::NotRunnable | MarkItDown::Failed => continue,
            // Every candidate is almost always the SAME binary, so re-running a
            // hang three more times would only spend three more timeouts.
            MarkItDown::TimedOut => return None,
            MarkItDown::Text(text) => {
                let text = normalize_whitespace(&text);
                if !text.trim().is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// Run one converter with a deadline. `std::process::Command::output()` waits
/// forever, so the child is spawned and polled instead — with stdout drained on
/// a helper thread, because a converter that fills the pipe buffer would block
/// on its own write while we polled, and the deadline would never be reached.
fn run_markitdown(bin: &str, path: &str, timeout: std::time::Duration) -> MarkItDown {
    let child = std::process::Command::new(bin)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return MarkItDown::NotRunnable };
    let Some(mut stdout) = child.stdout.take() else { return MarkItDown::Failed };
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let buf = reader.join().unwrap_or_default();
                return if status.success() {
                    MarkItDown::Text(String::from_utf8_lossy(&buf).into_owned())
                } else {
                    MarkItDown::Failed
                };
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return MarkItDown::TimedOut;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return MarkItDown::Failed,
        }
    }
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

/// Decode the handful of entities every extractor needs.
///
/// `&amp;` is decoded LAST, and that ordering is load-bearing: decoding it
/// first turns `&amp;lt;` into `&lt;` and then into `<`, stripping one layer
/// too many from any document that quotes HTML as an example.
pub(crate) fn decode_basic_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// Collapse whitespace runs per line and squeeze blank-line runs to one.
///
/// NOTE for extractors: this runs over EVERY extractor's output, and it
/// collapses tabs along with spaces. An extractor that wants column structure
/// to survive into the search index and the model's view must emit a visible
/// separator (`extract_xlsx` uses " | "), never a tab.
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
    fn a_panicking_parser_costs_only_that_files_text() {
        // Regression: import runs the readers on `spawn_blocking` with the room
        // mutex held, and only extract_pdf contained its own panics. A panic in
        // umya-spreadsheet or the zip reader over a malformed file therefore
        // came back as an opaque JoinError ("The import could not be started")
        // AND left the room lock poisoned, so the next room operation panicked
        // too. `extract_text` now contains them.
        let quiet = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let contained = contain_parser_panic(|| panic!("third-party parser exploded"));
        std::panic::set_hook(quiet);
        assert_eq!(contained, None, "a parser panic must not escape extract_text");
        // Ordinary readers still return their text through the same wrapper.
        assert_eq!(contain_parser_panic(|| Some("ok".into())).as_deref(), Some("ok"));
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

    #[test]
    fn reads_an_epub_in_reading_order() {
        // E-books imported fine and were then unreadable to both search and
        // the assistant unless the optional MarkItDown CLI happened to exist.
        use std::io::Write;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                (
                    "OEBPS/content.opf",
                    r#"<package><manifest>
                         <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
                         <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
                       </manifest><spine>
                         <itemref idref="c1"/><itemref idref="c2"/>
                       </spine></package>"#,
                ),
                ("OEBPS/two.xhtml", "<html><body><p>Chapter two body.</p></body></html>"),
                ("OEBPS/one.xhtml", "<html><body><p>Chapter one body.</p></body></html>"),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        let text = extract_text("book.epub", &cursor.into_inner()).expect("epub text");
        let one = text.find("Chapter one body").expect("chapter one missing");
        let two = text.find("Chapter two body").expect("chapter two missing");
        assert!(one < two, "spine order ignored: {text}");
    }

    #[test]
    fn reads_rtf_prose_without_its_font_table() {
        let rtf = r"{\rtf1\ansi{\fonttbl{\f0\fswiss Helvetica;}}\f0\fs24 \
                    The rent is 1,200 \'80 per month.\par Signed \{today\}.}";
        let text = extract_text("lease.rtf", rtf.as_bytes()).expect("rtf text");
        assert!(text.contains("The rent is 1,200"), "got: {text}");
        assert!(text.contains("per month."), "got: {text}");
        assert!(text.contains("Signed {today}."), "escaped braces lost: {text}");
        assert!(!text.contains("Helvetica"), "font table leaked: {text}");
    }

    #[test]
    fn rtf_keeps_its_accented_and_non_latin_characters() {
        // Regression: every non-ASCII character became a space, so "Le siège
        // social" indexed — and reached the model — as "Le si ge social", the
        // word split in two. `\uNNNN` (what Word and TextEdit actually emit for
        // anything outside the code page) was eaten by the generic control-word
        // branch and pushed nothing at all, while its `\'3f` fallback leaked a
        // literal "?" into the text.
        let rtf = r"{\rtf1\ansi\ansicpg1252\uc1 Le si\'e8ge social \u233\'e9tage \u1500\'3f}";
        let text = extract_text("bail.rtf", rtf.as_bytes()).expect("rtf text");
        assert!(text.contains("siège"), "cp1252 escape lost: {text}");
        assert!(text.contains("étage"), "\\u escape lost: {text}");
        assert!(text.contains('ל'), "non-Latin \\u escape lost: {text}");
        assert!(!text.contains('?'), "unicode fallback leaked: {text}");
        // The 0x80–0x9F band is NOT Latin-1: \'92 is a curly apostrophe.
        let punct = extract_rtf(r"{\rtf1\ansi it\'92s \'93quoted\'94}").expect("rtf text");
        assert!(punct.contains('\u{2019}'), "cp1252 high band wrong: {punct}");
        assert!(punct.contains('\u{201C}'), "cp1252 high band wrong: {punct}");
    }

    #[test]
    fn ampersand_is_decoded_last_so_escaped_markup_survives() {
        // Regression: decoding `&amp;` first turned "&amp;lt;" into "&lt;" and
        // then into "<", so a document showing an HTML example came out with a
        // layer of escaping silently stripped.
        assert_eq!(decode_basic_entities("&amp;lt;div&amp;gt;"), "&lt;div&gt;");
        assert_eq!(decode_basic_entities("&amp;amp;"), "&amp;");
        // The ordinary single-layer cases are unchanged.
        assert_eq!(decode_basic_entities("a &amp; b"), "a & b");
        assert_eq!(
            decode_basic_entities("&lt;p&gt;&quot;hi&quot;&#39;&nbsp;"),
            "<p>\"hi\"' "
        );
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
