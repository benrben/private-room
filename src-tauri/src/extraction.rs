use std::io::Read;

mod article;
mod chunking;
mod data;
mod docx;
mod html;
mod legacy;
mod pdf;
mod pdf_quality;
mod pptx;
mod window;
mod xlsx;

pub use article::*;
pub use chunking::*;
pub(crate) use data::*;
pub use window::*;
pub use docx::*;
pub use html::*;
pub(crate) use legacy::*;
pub(crate) use pdf::*;
pub use pdf_quality::*;
pub(crate) use pptx::*;
pub(crate) use xlsx::*;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonl", "ndjson", "csv", "tsv", "log", "xml", "yml",
    "yaml", "toml", "ini", "rs", "py", "js", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp",
    "cs", "go", "rb", "php", "swift", "kt", "sh", "zsh", "bash", "sql", "r", "m", "scala", "lua",
    "pl", "css", "scss", "less", "vue", "svelte", "tex", "org", "rst", "diff", "patch",
    "dockerfile", "graphql", "gql", "proto", "properties", "env", "gitignore", "cfg", "conf",
];

/// The text extensions, for the format registry's "what can this app open?"
/// listing. Kept behind a function so the table itself stays private and there
/// is still exactly one copy of it.
pub fn text_extensions() -> &'static [&'static str] {
    TEXT_EXTENSIONS
}

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
        // NUL is never document content, and the docx matcher uses it as its
        // PARAGRAPH separator — a sentinel whose map entry is `usize::MAX`
        // precisely because nothing may ever match it. NUL is not `is_whitespace`
        // in Rust, so a needle carrying one used to survive `collapse_ws`, match
        // a separator, and index `edits[usize::MAX]`: a panic instead of the
        // plain "text not found" every other unmatched edit reports.
        '\u{0}' => FoldOut::Drop,
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

/// Decode a text file's bytes into a String, honouring its encoding.
///
/// This was `String::from_utf8_lossy`, which silently turns every byte a legacy
/// encoding uses into U+FFFD. A Turkish ISO-8859-9 file therefore imported as a
/// wall of "" — unreadable in the viewer, unsearchable in the index and
/// useless to the model, with nothing anywhere saying why (live QA 2026-08-03,
/// rated 1/5).
///
/// Order matters. A BOM is a FACT, so it wins outright. Valid UTF-8 is next and
/// is near-certain: arbitrary legacy bytes almost never form a valid UTF-8
/// sequence by accident. Only when both fail is the encoding actually detected.
///
/// Detection is `chardetng` — Firefox's detector, by the author of `encoding_rs`.
/// A hand-rolled scoring heuristic was written first and REJECTED: single-byte
/// encodings map the same byte to a different letter in each, so "is this a
/// letter sitting next to other letters" cannot separate Turkish from Central
/// European. It read the Turkish fixture as windows-1250 and produced "đ ý ţ" —
/// confidently wrong, which is worse than a visible "" because nothing on
/// screen admits it is wrong. Proper detection needs language models, not
/// character classes.
pub(crate) fn decode_text_bytes(bytes: &[u8]) -> String {
    decode_text_detail(bytes).text
}

/// How a text file's encoding was arrived at.
///
/// The viewer says this out loud, because the four cases are NOT equally
/// trustworthy: a BOM and valid UTF-8 are facts about the bytes, a detection is
/// a guess that single-byte encodings make genuinely ambiguous, and a choice is
/// the human overruling that guess. A strip that only ever said "windows-1254"
/// would present the guess as a fact.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodingSource {
    /// A byte-order mark named the encoding.
    Bom,
    /// The bytes are valid UTF-8, so nothing was guessed.
    Utf8,
    /// `chardetng` guessed it.
    Detected,
    /// The user picked it in the viewer, overruling the guess.
    Chosen,
}

/// A decoded text file, with the provenance of the encoding that produced it.
pub struct DecodedText {
    pub text: String,
    /// The encoding's WHATWG name (`UTF-8`, `windows-1254`, …) — what
    /// `encoding_rs` calls it, so it always matches a `for_label` round-trip.
    pub encoding: &'static str,
    pub source: EncodingSource,
    /// Some bytes had no meaning in this encoding and became U+FFFD. The text
    /// on screen is therefore NOT the file: saving it would write those
    /// replacement characters over the originals, so the editor stays shut.
    pub lossy: bool,
}

/// `decode_text_bytes`, keeping the encoding it settled on. See that function
/// for why the order is BOM → UTF-8 → detect.
pub(crate) fn decode_text_detail(bytes: &[u8]) -> DecodedText {
    // 1. A byte-order mark states the encoding outright.
    // `for_bom` hands back the encoding and the BOM's LENGTH — skip those bytes
    // so the mark itself never lands in the text as U+FEFF.
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, lossy) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return DecodedText {
            text: text.into_owned(),
            encoding: enc.name(),
            source: EncodingSource::Bom,
            lossy,
        };
    }
    // 2. Valid UTF-8 is taken as UTF-8, no guessing.
    if let Ok(s) = std::str::from_utf8(bytes) {
        return DecodedText {
            text: s.to_string(),
            encoding: encoding_rs::UTF_8.name(),
            source: EncodingSource::Utf8,
            lossy: false,
        };
    }
    // 3. Detect. Fed a bounded prefix — the detector wants a sample, not the
    //    whole file, and a book-length import should not be scanned twice.
    const SAMPLE: usize = 64 * 1024;
    let sample = &bytes[..bytes.len().min(SAMPLE)];
    // `Iso2022JpDetection::Deny`: ISO-2022-JP is an escape-sequence encoding, and
    // the crate's own guidance is to deny it anywhere the decoded text could be
    // treated as markup. Room text reaches an HTML viewer, so deny.
    let mut detector =
        chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(sample, sample.len() == bytes.len());
    // `Utf8Detection::Deny` — UTF-8 is already ruled out above, and letting the
    // detector answer UTF-8 here would only reinstate the lossy read.
    let enc = detector.guess(None, chardetng::Utf8Detection::Deny);
    let (text, lossy) = enc.decode_without_bom_handling(bytes);
    DecodedText {
        text: text.into_owned(),
        encoding: enc.name(),
        source: EncodingSource::Detected,
        lossy,
    }
}

/// Decode the same bytes as a NAMED encoding, for the viewer's override.
///
/// `None` when `encoding_rs` doesn't know the label — the picker is built from
/// `encoding_choices()` so that can't happen from the UI, but a label arriving
/// over IPC is still input, and answering "here is your file in some other
/// encoding" would be a lie.
///
/// BOM handling is deliberately OFF: the point of the override is that the user
/// overrules what the bytes appear to say, and `decode` would silently hand back
/// UTF-8 for a BOM'd file while we reported the chosen name.
pub(crate) fn decode_text_as(bytes: &[u8], label: &str) -> Option<DecodedText> {
    let enc = encoding_rs::Encoding::for_label(label.as_bytes())?;
    let (text, lossy) = enc.decode_without_bom_handling(bytes);
    Some(DecodedText {
        text: text.into_owned(),
        encoding: enc.name(),
        source: EncodingSource::Chosen,
        lossy,
    })
}

/// The encodings the viewer offers, as (label, human title).
///
/// Deliberately a short hand-picked list rather than every label in the
/// Encoding Standard: a menu of 200 aliases is not a choice anyone can make.
/// Every entry is resolved through `Encoding::for_label` before it is offered
/// (a test enforces that none of them is unknown or a duplicate of another),
/// so the picker can never offer an encoding this decoder cannot actually read.
const ENCODING_CHOICES: &[(&str, &str)] = &[
    ("utf-8", "Unicode (UTF-8)"),
    ("utf-16le", "Unicode (UTF-16, little-endian)"),
    ("utf-16be", "Unicode (UTF-16, big-endian)"),
    ("windows-1252", "Western European (Windows 1252)"),
    ("iso-8859-15", "Western European (ISO-8859-15)"),
    ("macintosh", "Western European (Mac Roman)"),
    ("windows-1250", "Central European (Windows 1250)"),
    ("iso-8859-2", "Central European (ISO-8859-2)"),
    // The Turkish pair are the same encoding in the Encoding Standard, which is
    // why the title names both: a file labelled ISO-8859-9 is read as
    // windows-1254 and the strip would otherwise look like it ignored the pick.
    ("windows-1254", "Turkish (Windows 1254 / ISO-8859-9)"),
    ("windows-1251", "Cyrillic (Windows 1251)"),
    ("koi8-r", "Cyrillic (KOI8-R)"),
    ("iso-8859-5", "Cyrillic (ISO-8859-5)"),
    ("windows-1253", "Greek (Windows 1253)"),
    ("windows-1255", "Hebrew (Windows 1255)"),
    ("windows-1256", "Arabic (Windows 1256)"),
    ("windows-1257", "Baltic (Windows 1257)"),
    ("windows-1258", "Vietnamese (Windows 1258)"),
    ("shift_jis", "Japanese (Shift_JIS)"),
    ("euc-jp", "Japanese (EUC-JP)"),
    ("gbk", "Simplified Chinese (GBK)"),
    ("gb18030", "Simplified Chinese (GB18030)"),
    ("big5", "Traditional Chinese (Big5)"),
    ("euc-kr", "Korean (EUC-KR)"),
];

/// The offer list, canonicalised: each entry's name is what `decode_text_as`
/// will report back for it, so the strip's "read as X" and the menu's selected
/// row are the same string.
pub(crate) fn encoding_choices() -> Vec<(&'static str, &'static str)> {
    ENCODING_CHOICES
        .iter()
        .filter_map(|(label, title)| {
            encoding_rs::Encoding::for_label(label.as_bytes()).map(|enc| (enc.name(), *title))
        })
        .collect()
}

/// Extract readable text from a file's bytes, best-effort. Returns None for
/// formats we can't read (images, unknown binaries).
pub fn extract_text(name: &str, bytes: &[u8]) -> Option<String> {
    let ext = extension_of(name);
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return Some(decode_text_bytes(bytes));
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
        // Same decoder as plain text: a legacy-encoded HTML page is exactly as
        // common as a legacy-encoded .txt, and `strip_html` cannot recover a
        // character that was already replaced before it ran.
        //
        // The ARTICLE first (Readability scoring), because a saved page is
        // indexed and read back as whatever this returns, and a page whose menu
        // and footer are in the index answers searches with its own navigation.
        // `strip_html` stays the fallback: it is what a page with no scorable
        // article — a link list, a form, a shell — still has.
        "html" | "htm" => {
            let text = decode_text_bytes(bytes);
            Some(match read_page(&text, None).article {
                Some(article) => article.text,
                None => strip_html(&text),
            })
        }
        // Two formats that used to import fine and then be unreadable to both
        // search and the assistant unless the optional MarkItDown CLI happened
        // to be installed. Both are cheap to read natively: an EPUB is a zip of
        // XHTML, and RTF is plain ASCII with control words.
        "epub" => extract_epub(bytes),
        "rtf" => extract_rtf(&String::from_utf8_lossy(bytes)),
        // The pre-2007 Office formats, read natively. Until now these were
        // reachable ONLY through an optional MarkItDown install, which for a
        // shipped Mac app meant a .doc imported with no text at all — invisible
        // to search, to RAG and to the model, with nothing saying why.
        "doc" => extract_legacy_doc(name, bytes),
        "ppt" => extract_legacy_ppt(bytes),
        "xls" | "ods" => extract_legacy_spreadsheet(bytes, &ext),
        // Apple's iWork bundles — the last of the "imports fine, then the
        // assistant cannot read a word of it" formats. Their real payload is
        // IWA (compressed protobuf), which is not worth a parser here; what IS
        // worth reading is the PDF preview iWork writes into the same bundle,
        // which the PDF reader already handles. A bundle saved without one
        // yields None — honestly nothing, not a guess.
        "pages" | "key" | "numbers" => extract_iwork(bytes),
        // Formats the registry newly claims. Each one derives READABLE text
        // rather than letting its raw source into the index: a notebook's
        // prose instead of escaped JSON, a message's body instead of base64,
        // a subtitle's words instead of its timecodes.
        "ipynb" => extract_ipynb(bytes),
        "eml" => extract_eml(&String::from_utf8_lossy(bytes)),
        "srt" | "vtt" => extract_subtitles(&String::from_utf8_lossy(bytes)),
        "svg" => extract_svg(&String::from_utf8_lossy(bytes)),
        "zip" => extract_zip_listing(bytes),
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

/// The PDF preview inside an iWork bundle (.pages/.key/.numbers), if it has one.
///
/// Modern iWork documents are a zip whose document body is IWA — Snappy-framed
/// protobuf with an undocumented schema — so there is no cheap honest way to
/// read the text itself. But "Include preview in document" (on by default for
/// anything shared or saved from iCloud) writes a full PDF rendering of the
/// document into the same zip, and that is ordinary text.
///
/// Matched by SUFFIX rather than by an exact path: the entry sits at
/// `QuickLook/Preview.pdf` in a flat bundle and at `<name>/QuickLook/Preview.pdf`
/// in a package one, and the two spellings are the same file.
fn iwork_preview_entry(names: &[String]) -> Option<&String> {
    names
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("quicklook/preview.pdf"))
}

/// Text of an iWork bundle, via its PDF preview. `None` when the bundle carries
/// no preview — there is nothing to read, and saying so is the whole point.
pub(crate) fn extract_iwork(bytes: &[u8]) -> Option<String> {
    let names = zip_entry_names(bytes);
    let entry = iwork_preview_entry(&names)?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut file = archive.by_name(entry).ok()?;
    // Same decompression-bomb ceiling every other Office part gets.
    if file.size() > MAX_ZIP_ENTRY_BYTES {
        return None;
    }
    let mut pdf = Vec::new();
    std::io::Read::take(&mut file, MAX_ZIP_ENTRY_BYTES + 1)
        .read_to_end(&mut pdf)
        .ok()?;
    if pdf.len() as u64 > MAX_ZIP_ENTRY_BYTES {
        return None;
    }
    extract_pdf(&pdf)
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

/// The named entities worth carrying: the five XML ones plus the typographic
/// punctuation real prose is full of. Anything outside this table and outside
/// the numeric forms is left exactly as written, which is the honest outcome —
/// a literal `&foo;` in the text is visibly not decoded, where a guess would be
/// silently wrong.
const NAMED_ENTITIES: &[(&str, &str)] = &[
    ("lt", "<"),
    ("gt", ">"),
    ("quot", "\""),
    ("apos", "'"),
    ("amp", "&"),
    ("nbsp", " "),
    ("mdash", "—"),
    ("ndash", "–"),
    ("hellip", "…"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("bull", "•"),
    ("middot", "·"),
    ("times", "×"),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
    ("deg", "°"),
    ("euro", "€"),
    ("pound", "£"),
    ("laquo", "«"),
    ("raquo", "»"),
];

/// The longest `&…;` we will look at. Long enough for every name above and for
/// a hex reference; short enough that a bare `&` in prose scans a few chars and
/// gives up rather than swallowing half a paragraph looking for a `;`.
const MAX_ENTITY_LEN: usize = 12;

/// Decode HTML entities in extracted text.
///
/// Single pass, deliberately. The previous version was a chain of `.replace()`
/// calls over seven entities, which had two problems. It handled no NUMERIC
/// references at all, so `&#8212;` — the em dash, which python.org and most
/// documentation generators emit for every dash in prose — survived into the
/// saved file as literal text; live QA 2026-08-03 saved a Python docs page and
/// got a wall of `&#8212;`. And chained replacement made decoding order
/// load-bearing: `&amp;` had to run LAST or `&amp;lt;` decoded twice, down to a
/// bare `<`, corrupting any document that quotes HTML as an example.
///
/// Scanning once fixes both: each `&…;` is examined in the ORIGINAL text and
/// replaced exactly once, so double-decoding is structurally impossible and
/// ordering stops mattering.
pub(crate) fn decode_basic_entities(s: &str) -> String {
    // Nothing to do, and the overwhelmingly common case for non-HTML sources.
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        // The `;` must be close by; `char_indices` so a multi-byte char in the
        // scan window can never produce a mid-character split.
        let semi = after
            .char_indices()
            .take_while(|(i, _)| *i <= MAX_ENTITY_LEN)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i);
        let Some(semi) = semi else {
            // A bare `&` — emit it and carry on from just after it, so the next
            // `find` cannot rediscover this same one and loop forever.
            out.push('&');
            rest = after;
            continue;
        };
        let body = &after[..semi];
        let decoded = if let Some(digits) = body.strip_prefix('#') {
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => digits.parse::<u32>().ok(),
            };
            code.and_then(char::from_u32).map(String::from)
        } else {
            NAMED_ENTITIES
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(body))
                .map(|(_, ch)| (*ch).to_string())
        };
        match decoded {
            Some(text) => out.push_str(&text),
            // Unrecognized: keep it verbatim, `&` and `;` included.
            None => {
                out.push('&');
                out.push_str(body);
                out.push(';');
            }
        }
        rest = &after[semi + 1..];
    }
    out.push_str(rest);
    out
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
    fn turkish_iso_8859_9_survives_import_instead_of_becoming_replacement_chars() {
        // Live QA 2026-08-03 rated this 1/5: a Turkish fixture imported as a wall
        // of U+FFFD, because `from_utf8_lossy` destroys legacy bytes before
        // anything can interpret them.
        let turkish = "Türkçe karakterler: ğ ı ş İ Ğ Ş ö ü ç";
        let (bytes, _, had_errors) = encoding_rs::WINDOWS_1254.encode(turkish);
        assert!(!had_errors, "fixture must be representable in the Turkish page");
        assert!(
            std::str::from_utf8(&bytes).is_err(),
            "fixture must NOT be valid UTF-8, or the test proves nothing"
        );

        let out = decode_text_bytes(&bytes);
        assert!(!out.contains('\u{FFFD}'), "no replacement chars: {out:?}");
        // The Turkish-specific letters are the ones windows-1252 gets wrong
        // (ğ -> ð, ı -> ý), so they are the real assertion.
        for ch in ['ğ', 'ı', 'ş', 'İ', 'Ğ', 'Ş'] {
            assert!(out.contains(ch), "lost {ch:?} in {out:?}");
        }
    }

    #[test]
    fn a_chosen_encoding_overrules_the_detector() {
        // The detector is a guess, and single-byte encodings are genuinely
        // ambiguous — the same bytes ARE Turkish and ARE Cyrillic. So the user
        // gets to say which, and the answer has to come back re-read from the
        // ORIGINAL bytes rather than re-interpreted from the guessed string.
        let turkish = "Türkçe: ğ ı ş İ";
        let (bytes, _, _) = encoding_rs::WINDOWS_1254.encode(turkish);

        let auto = decode_text_detail(&bytes);
        assert_eq!(auto.source, EncodingSource::Detected);
        assert_eq!(auto.encoding, "windows-1254");
        assert!(!auto.lossy);
        assert_eq!(auto.text, turkish);

        let cyrillic = decode_text_as(&bytes, "windows-1251").expect("a known label");
        assert_eq!(cyrillic.source, EncodingSource::Chosen);
        assert_eq!(cyrillic.encoding, "windows-1251");
        assert_ne!(cyrillic.text, auto.text, "the override must change the reading");
        assert!(
            cyrillic.text.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "expected Cyrillic letters: {:?}",
            cyrillic.text
        );

        // Choosing back is the escape hatch from a wrong pick.
        let back = decode_text_as(&bytes, "iso-8859-9").expect("an alias of windows-1254");
        assert_eq!(back.encoding, "windows-1254", "the label is canonicalised");
        assert_eq!(back.text, turkish);
    }

    #[test]
    fn an_encoding_the_decoder_does_not_know_is_refused() {
        // Never "here is your file in some other encoding": the label arrives
        // over IPC, so it is input, not a promise.
        assert!(decode_text_as(b"hello", "klingon-1").is_none());
    }

    #[test]
    fn every_offered_encoding_is_one_the_decoder_can_actually_use() {
        let offered = encoding_choices();
        assert_eq!(offered.len(), ENCODING_CHOICES.len(), "a label was dropped as unknown");
        let mut seen: Vec<&str> = Vec::new();
        for (name, title) in &offered {
            assert!(
                !seen.contains(name),
                "{name} is offered twice (two labels for one encoding): {title}"
            );
            seen.push(name);
            // What the picker offers must be exactly what a decode reports back,
            // or the strip and the menu disagree about the same file.
            let round = decode_text_as(b"abc", name).expect("offered labels must decode");
            assert_eq!(round.encoding, *name);
        }
        assert!(seen.contains(&"UTF-8"), "UTF-8 must always be offerable");
    }

    #[test]
    fn bytes_that_do_not_fit_the_encoding_are_reported_as_lossy() {
        // A truncated multi-byte sequence has no meaning in UTF-8, so it decodes
        // to U+FFFD. Saving that string would write the replacement over the
        // real bytes — the viewer needs to know, so `lossy` is carried out
        // rather than silently swallowed.
        let hit = decode_text_as(&[b'a', 0xC3, b'(', b'b'], "utf-8").expect("a known label");
        assert!(hit.lossy);
        assert!(hit.text.contains('\u{FFFD}'));
        let clean = decode_text_as(b"plain", "windows-1252").expect("a known label");
        assert!(!clean.lossy);
    }

    #[test]
    fn utf8_and_boms_are_never_guessed_at() {
        // Valid UTF-8 must pass through untouched — the guesser only ever runs
        // once UTF-8 has already failed.
        let utf8 = "Ünicode — ümlauts, em-dash, ✓ and 日本語";
        assert_eq!(decode_text_bytes(utf8.as_bytes()), utf8);

        // A BOM is a fact, not a hint.
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("héllo".as_bytes());
        assert_eq!(decode_text_bytes(&with_bom), "héllo");

        // Built byte-by-byte on purpose: `encoding_rs` cannot ENCODE to UTF-16
        // (per the Encoding Standard its `encode` emits UTF-8 for those), so
        // asking it for UTF-16LE bytes silently hands back UTF-8 and the test
        // would be checking that a UTF-8 payload mislabelled by a BOM decodes to
        // mojibake — which it correctly does.
        let mut le = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for unit in "héllo".encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&le), "héllo");

        // Plain ASCII is unambiguous and must not be disturbed.
        assert_eq!(decode_text_bytes(b"plain ascii"), "plain ascii");
        assert_eq!(decode_text_bytes(b""), "");
    }

    #[test]
    fn an_imported_html_page_is_indexed_as_its_article() {
        // What lands in `extracted_text` is what search finds and what the
        // model reads back, so a saved page whose menu and footer were indexed
        // answered searches with its own navigation.
        let page = "<html><head><title>T</title></head><body>\
            <nav>Subscribe now Sections Newsletter</nav>\
            <article><p>The wardens counted eleven nests in the lower marsh this season, \
            eleven more than the year the herons left, and the trust has not yet decided \
            what to say about it in public.</p>\
            <p>A second paragraph, so the scorer has more than one node to weigh before \
            it decides which part of this page is the article.</p></article>\
            <footer>Privacy policy. All rights reserved.</footer></body></html>";
        let text = extract_text("saved.html", page.as_bytes()).expect("html has text");
        assert!(text.contains("eleven nests"), "{text}");
        assert!(!text.contains("Subscribe now"), "chrome reached the index: {text}");
        assert!(!text.contains("Privacy policy"), "chrome reached the index: {text}");

        // A page with no article to score still yields its text — the fallback
        // is `strip_html`, not silence.
        let list = "<html><body><nav>menu</nav><ul><li><a href=\"/a\">Alpha</a></li>\
                    <li><a href=\"/b\">Beta</a></li></ul></body></html>";
        let text = extract_text("links.htm", list.as_bytes()).expect("still has text");
        assert!(text.contains("Alpha") && text.contains("Beta"), "{text}");
    }

    #[test]
    fn csv_text_reaches_search_exactly_as_written() {
        // The grid had a quoted `"=SUM(A1:A2)"` read as a formula because
        // SheetJS unquotes before it classifies. Search and RAG take a
        // different route — the raw text, with no CSV parse at all — and this
        // pins that: no unquoting, no whitespace normalization, no reflow. A
        // reader searching for the literal cell must be able to find it.
        let csv = "label,note\r\ntotal,\"=SUM(A1:A2)\"\r\nx,\"he said \"\"hi\"\", ok\"\r\n";
        assert_eq!(extract_text("t.csv", csv.as_bytes()).unwrap(), csv);
        assert_eq!(extract_text("t.tsv", csv.as_bytes()).unwrap(), csv);
    }

    #[test]
    fn numeric_entities_decode_instead_of_reaching_the_reader() {
        // Live QA 2026-08-03: a saved python.org docs page rendered as a wall of
        // literal `&#8212;`. Documentation generators emit numeric references for
        // ordinary punctuation, and the old chained-`replace` decoder knew none
        // of them.
        assert_eq!(decode_basic_entities("a &#8212; b"), "a — b");
        assert_eq!(decode_basic_entities("it&#8217;s"), "it’s");
        assert_eq!(decode_basic_entities("hex &#x2014; dash"), "hex — dash");
        assert_eq!(decode_basic_entities("&#X2014;"), "—");
        // Named typographic entities too.
        assert_eq!(decode_basic_entities("a &mdash; b &hellip;"), "a — b …");
    }

    #[test]
    fn one_pass_decoding_cannot_strip_a_layer_too_many() {
        // The ordering hazard the old chain documented: decoding `&amp;` before
        // `&lt;` turned `&amp;lt;` into `<`, silently corrupting any document
        // that quotes HTML as an example. Scanning once makes it impossible.
        assert_eq!(decode_basic_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_basic_entities("&amp;amp;"), "&amp;");
        assert_eq!(decode_basic_entities("&lt;div&gt;"), "<div>");
    }

    #[test]
    fn unknown_and_malformed_entities_are_left_exactly_as_written() {
        // Guessing would be silently wrong; leaving it is visibly not decoded.
        assert_eq!(decode_basic_entities("&notareal;"), "&notareal;");
        assert_eq!(decode_basic_entities("&#99999999;"), "&#99999999;");
        // A bare ampersand in prose, including one followed much later by a
        // semicolon — the scan window must give up rather than swallow the gap.
        assert_eq!(decode_basic_entities("Tom & Jerry"), "Tom & Jerry");
        assert_eq!(
            decode_basic_entities("a & b, then something long; done"),
            "a & b, then something long; done"
        );
        // Trailing ampersand: must terminate, not spin.
        assert_eq!(decode_basic_entities("ends with &"), "ends with &");
        // Multi-byte text inside the scan window must not split a character.
        assert_eq!(decode_basic_entities("& — é ; ok"), "& — é ; ok");
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
    fn an_iwork_bundle_is_read_through_its_pdf_preview_or_not_at_all() {
        use std::io::Write;
        fn bundle(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut cursor = std::io::Cursor::new(Vec::new());
            {
                let mut writer = zip::ZipWriter::new(&mut cursor);
                let options = zip::write::SimpleFileOptions::default();
                for (name, body) in entries {
                    writer.start_file(*name, options).unwrap();
                    writer.write_all(body).unwrap();
                }
                writer.finish().unwrap();
            }
            cursor.into_inner()
        }

        // Both bundle spellings name the same file, and neither the IWA payload
        // nor the thumbnail may be mistaken for it.
        let flat = bundle(&[
            ("Index/Document.iwa", b"\x00binary"),
            ("preview.jpg", b"\xff\xd8jpeg"),
            ("QuickLook/Preview.pdf", b"%PDF-1.4 stub"),
        ]);
        let names = zip_entry_names(&flat);
        assert_eq!(iwork_preview_entry(&names).map(String::as_str), Some("QuickLook/Preview.pdf"));
        let packaged = bundle(&[("Lease.pages/QuickLook/Preview.pdf", b"%PDF-1.4 stub")]);
        let names = zip_entry_names(&packaged);
        assert_eq!(
            iwork_preview_entry(&names).map(String::as_str),
            Some("Lease.pages/QuickLook/Preview.pdf")
        );

        // A bundle saved WITHOUT a preview has nothing readable in it, and the
        // honest answer is None — never the raw IWA bytes, which would put
        // compressed protobuf into the search index as if it were prose.
        let no_preview = bundle(&[("Index/Document.iwa", b"\x00binary")]);
        assert!(iwork_preview_entry(&zip_entry_names(&no_preview)).is_none());
        assert_eq!(extract_text("Lease.pages", &no_preview), None);
        assert_eq!(extract_text("Deck.key", &no_preview), None);
        assert_eq!(extract_text("Budget.numbers", &no_preview), None);
        // …and so does a preview that is not a readable PDF: no text is no text.
        assert_eq!(extract_text("Lease.pages", &flat), None);
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
