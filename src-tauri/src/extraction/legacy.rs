//! The pre-2007 Office formats: `.doc`, `.xls`, `.ppt`.
//!
//! THE GAP THIS CLOSES: these three used to be readable only if the user had
//! separately installed Microsoft's MarkItDown CLI (`pipx install markitdown`).
//! For a shipped Mac app that means "not readable at all" twice over — almost
//! nobody has it, and a GUI app doesn't inherit a login shell's PATH, so even
//! an installed copy is usually invisible. A `.doc` dropped into a room
//! therefore imported with no text: invisible to search, invisible to RAG, and
//! invisible to the model, with nothing on screen saying why.
//!
//! Read natively here instead, with pure-Rust crates and no bundled native
//! libraries — deliberately not Extractous (Apache Tika compiled through
//! GraalVM) or office_oxide (0.1.x), because a signed and notarized Mac app
//! should not gain a multi-megabyte binary blob for three legacy formats.
//!
//! MarkItDown is still consulted afterwards for anything these can't read; it
//! went from being the only path to being the last one.

use super::*;

/// `.xls` and `.ods`, through calamine — the same crate the Rust ecosystem
/// uses for spreadsheets generally. Every sheet, every cell, in the layout the
/// xlsx reader already produces so search behaves identically across both.
pub(crate) fn extract_legacy_spreadsheet(bytes: &[u8], ext: &str) -> Option<String> {
    use calamine::{Data, Reader};
    let cursor = std::io::Cursor::new(bytes.to_vec());
    // The two container formats are different enough to need their own reader;
    // calamine exposes one per format rather than sniffing.
    let sheets: Vec<(String, calamine::Range<Data>)> = match ext {
        "xls" => {
            let mut wb = calamine::Xls::new(cursor).ok()?;
            wb.worksheets()
        }
        "ods" => {
            let mut wb = calamine::Ods::new(cursor).ok()?;
            wb.worksheets()
        }
        _ => return None,
    };
    let mut out = String::new();
    for (name, range) in sheets {
        if range.is_empty() {
            continue;
        }
        out.push_str(&format!("--- {name} ---\n"));
        for row in range.rows() {
            let line: Vec<String> = row
                .iter()
                .map(|cell| match cell {
                    Data::Empty => String::new(),
                    Data::String(s) => s.clone(),
                    Data::Float(f) => trim_float(*f),
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => b.to_string(),
                    Data::DateTime(d) => d.to_string(),
                    Data::DateTimeIso(s) => s.clone(),
                    Data::DurationIso(s) => s.clone(),
                    Data::Error(e) => format!("{e:?}"),
                })
                .collect();
            // A row of nothing but empty cells contributes nothing.
            if line.iter().all(|c| c.trim().is_empty()) {
                continue;
            }
            out.push_str(&line.join("\t"));
            out.push('\n');
            if out.len() > MAX_LEGACY_CHARS {
                out.push_str("\n… (truncated)\n");
                return Some(out);
            }
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

/// `12.0` reads as `12`, `12.5` stays `12.5` — a spreadsheet of integers must
/// not fill the search index with trailing zeros.
fn trim_float(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        f.to_string()
    }
}

const MAX_LEGACY_CHARS: usize = 8 * 1024 * 1024;

/// Text out of a Word 97–2003 `.doc`.
///
/// macOS's own Word importer reads these properly, so it goes first. What it
/// returns is the document's real text — paragraphs, tables, the lot — and it
/// is the SAME importer that draws the preview, so the words on screen and the
/// words in the search index finally come from one source.
///
/// WHAT THIS REPLACED, and why it had to: the fallback below used to be the
/// only path. It sweeps the `WordDocument` stream for runs of printable
/// characters, which on the synthetic streams its tests build looks perfect and
/// on a REAL `.doc` returns the font table and binary noise — live QA opened
/// one and got `Times New Roman / Arial / Droid Sans Fallback / WenQuanYi Zen
/// Hei` followed by mojibake. That text was not merely shown in the editor: it
/// was the file's indexed content, so search and the model saw it too.
///
/// The sweep is kept for the case textutil declines (a corrupt file, a
/// non-macOS build), where fragments beat nothing.
pub(crate) fn extract_legacy_doc(name: &str, bytes: &[u8]) -> Option<String> {
    // TWO STRUCTURAL GATES, because `textutil` applies none of its own. Handed
    // arbitrary bytes in a file named `.doc` it echoes them straight back as
    // "text" and exits 0 — so without these, any file renamed `.doc` would put
    // its raw bytes into the room's search index as the document's prose.
    if !is_ole_compound(bytes) {
        return None;
    }
    // textutil answers even when it has NOT understood the file: handed a
    // compound file whose WordDocument stream is not a real Word FIB, it
    // returns the file's own bytes transcoded, cheerfully, with exit status 0.
    // A genuine import is prose; the echo is riddled with NULs. That is the
    // difference, and it is a far more reliable one than "which looks longer"
    // or "which scores better" — the echo contains the real text too, so any
    // score comparison can be won by the wrong answer.
    let imported = crate::textutil::convert(name, bytes, "txt")
        .filter(|t| is_clean_import(t))
        .map(|t| crate::textutil::resolve_field_codes(&t, false))
        .filter(|t| !t.trim().is_empty());
    if let Some(text) = imported {
        return Some(text);
    }
    // The sweep, for a file macOS declined. Requiring the `WordDocument` stream
    // keeps "is this really a .doc" a structural question — an OLE file that is
    // something else entirely reads as nothing rather than as its own innards.
    let stream = read_ole_stream(bytes, &["WordDocument"])?;
    let text = harvest_runs(&stream);
    (!text.trim().is_empty()).then_some(text)
}

/// The OLE Compound File magic — the first eight bytes of every `.doc`, `.xls`
/// and `.ppt` written before the 2007 XML formats.
fn is_ole_compound(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

/// True when textutil's answer reads as an imported DOCUMENT rather than as the
/// input file's raw bytes handed back.
///
/// A real conversion never contains a NUL, and essentially no other control
/// characters either. A raw-byte echo of a compound file is mostly NUL padding
/// with the document's text threaded through it — which is why it can look
/// convincing in a terminal that strips control characters, and why this check
/// exists rather than an eyeball comparison.
fn is_clean_import(s: &str) -> bool {
    if s.is_empty() || s.contains('\0') {
        return false;
    }
    let total = s.chars().count();
    let control =
        s.chars().filter(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')).count();
    control * 100 < total
}

/// Text out of a PowerPoint 97–2003 `.ppt`.
///
/// A `.ppt` is an OLE compound file whose `PowerPoint Document` stream is a
/// tree of length-prefixed RECORDS. Walking that tree and taking only the text
/// atoms is barely more work than sweeping the stream for printable runs, and
/// it is the difference between the deck's words and the deck's file format:
/// the sweep returned the font table, the placeholder prompts baked into the
/// slide master ("Click to edit the title text format", "Second Outline
/// Level"), and long stretches of mojibake.
///
/// Slide masters are skipped whole — their text is boilerplate the deck's
/// author never wrote — and slides are numbered, so `[slide 3]` in the
/// extracted text means the third slide here exactly as it does for a `.pptx`.
pub(crate) fn extract_legacy_ppt(bytes: &[u8]) -> Option<String> {
    let stream = read_ole_stream(bytes, &["PowerPoint Document", "PP97_DUALSTORAGE"])?;
    let text = ppt_records_to_text(&stream);
    if !text.trim().is_empty() {
        return Some(text);
    }
    // A deck whose records don't parse still beats nothing.
    let text = harvest_runs(&stream);
    (!text.trim().is_empty()).then_some(text)
}

// ---------------------------------------------------------- .ppt record tree

/// Record types in the PowerPoint 97 binary format that this reader cares about.
const RT_TEXT_CHARS: u16 = 0x0FA0; // UTF-16LE run
const RT_TEXT_BYTES: u16 = 0x0FA8; // single-byte (CP1252) run
const RT_SLIDE: u16 = 0x03EE;
const RT_NOTES: u16 = 0x03F0;
const RT_MAIN_MASTER: u16 = 0x03F8;

/// Containers nest, and a malformed file can claim to nest forever.
const MAX_RECORD_DEPTH: usize = 24;

/// One slide's (or one notes page's) text, in the order the records give it.
struct PptChunk {
    is_notes: bool,
    lines: Vec<String>,
}

fn ppt_records_to_text(stream: &[u8]) -> String {
    let mut chunks: Vec<PptChunk> = Vec::new();
    walk_ppt_records(stream, &mut chunks, None, 0);

    let mut out = String::new();
    let mut slide_no = 0usize;
    for chunk in &chunks {
        let body = chunk.lines.join("\n");
        // A notes page with nothing but the slide-number placeholder ("*"), and
        // any bucket with no actual words in it, is not content.
        if !body.chars().any(char::is_alphanumeric) {
            continue;
        }
        if chunk.is_notes {
            // Notes belong to a slide; one arriving before any slide is the
            // notes MASTER, which is boilerplate like the slide master.
            if slide_no == 0 {
                continue;
            }
            out.push_str(&format!("[slide {slide_no} notes]\n"));
        } else {
            slide_no += 1;
            out.push_str(&format!("[slide {slide_no}]\n"));
        }
        out.push_str(&body);
        out.push('\n');
        if out.len() > MAX_LEGACY_CHARS {
            out.push_str("\n… (truncated)\n");
            break;
        }
    }
    out
}

/// Walk the record tree, collecting text atoms into the slide/notes container
/// they belong to. `into` is the chunk currently being filled — text outside any
/// slide (the document summary, the master's placeholders) has nowhere to go and
/// is dropped, which is the entire point.
fn walk_ppt_records(
    buf: &[u8],
    chunks: &mut Vec<PptChunk>,
    into: Option<usize>,
    depth: usize,
) {
    if depth > MAX_RECORD_DEPTH {
        return;
    }
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let ver_inst = u16::from_le_bytes([buf[i], buf[i + 1]]);
        let rec_type = u16::from_le_bytes([buf[i + 2], buf[i + 3]]);
        let rec_len = u32::from_le_bytes([buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]]) as usize;
        i += 8;
        // A length past the end of the buffer means the tree is not what it
        // claims; stop rather than reinterpret the rest as records.
        if rec_len > buf.len() - i {
            return;
        }
        let body = &buf[i..i + rec_len];
        i += rec_len;

        match rec_type {
            // Boilerplate the deck's author never wrote: skip the whole subtree.
            RT_MAIN_MASTER => {}
            RT_SLIDE | RT_NOTES => {
                chunks.push(PptChunk { is_notes: rec_type == RT_NOTES, lines: Vec::new() });
                let idx = chunks.len() - 1;
                walk_ppt_records(body, chunks, Some(idx), depth + 1);
            }
            RT_TEXT_CHARS | RT_TEXT_BYTES => {
                let Some(idx) = into else { continue };
                let raw = if rec_type == RT_TEXT_CHARS {
                    let units: Vec<u16> =
                        body.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
                    String::from_utf16_lossy(&units)
                } else {
                    body.iter().filter_map(|&b| cp1252_char(b)).collect()
                };
                let text = ppt_clean(&raw);
                if !text.trim().is_empty() {
                    chunks[idx].lines.push(text);
                }
            }
            // 0xF in the low nibble marks a container; anything else is an atom
            // whose payload is not text.
            _ if ver_inst & 0x0F == 0x0F => walk_ppt_records(body, chunks, into, depth + 1),
            _ => {}
        }
    }
}

/// PowerPoint's in-text control characters, as a reader sees them: \r ends a
/// paragraph, \v a line, and \x0b/\x0d appear interchangeably.
fn ppt_clean(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\r' | '\u{0b}' => Some('\n'),
            '\u{0}' | '\u{fffd}' => None,
            c if c.is_control() && c != '\n' && c != '\t' => None,
            c => Some(c),
        })
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Read the first of `names` that exists in the compound file.
fn read_ole_stream(bytes: &[u8], names: &[&str]) -> Option<Vec<u8>> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(bytes);
    let mut comp = cfb::CompoundFile::open(cursor).ok()?;
    for name in names {
        let path = format!("/{name}");
        if !comp.exists(&path) {
            continue;
        }
        let mut buf = Vec::new();
        if comp.open_stream(&path).ok()?.take(200 * 1024 * 1024).read_to_end(&mut buf).is_ok() {
            return Some(buf);
        }
    }
    None
}

/// A run has to be at least this many characters to count as prose. Below it,
/// binary noise decodes into stray letter pairs that would pollute the index.
const MIN_RUN: usize = 4;

/// Pull readable runs out of a stream that is mostly binary.
///
/// Both encodings are tried because both appear: Word stores text as UTF-16LE
/// (so ASCII letters alternate with NUL bytes) while PowerPoint's older text
/// atoms are single-byte. The reading that looks more like PROSE wins.
///
/// Scoring by length would be wrong, and wrong in a way that is easy to miss:
/// ASCII read as UTF-16LE pairs each two letters into one CJK codepoint, and
/// those encode to THREE UTF-8 bytes each — so the garbage reading of
/// "This deck was written…" ("桔獩搠捥…") is longer in bytes than the correct
/// one, and a length comparison picks the garbage every time. A test pins this.
fn harvest_runs(stream: &[u8]) -> String {
    let utf16 = harvest_utf16(stream);
    let ascii = harvest_ascii(stream);
    if prose_score(&utf16) >= prose_score(&ascii) {
        utf16
    } else {
        ascii
    }
}

/// The longest run of letters that can still be a word. Beyond this it is an
/// alphabet sweep, a base64 blob or a GUID — the shapes binary regions of an
/// Office file decode into.
const MAX_WORD_LEN: usize = 20;

/// How much a candidate reading looks like written language.
///
/// Scores WORD STRUCTURE, not character volume, and the difference matters:
/// a binary region decoded byte-wise yields long unbroken sweeps
/// (`ABCDEFGHIJKLMNOPQRSTUVWXYZ`, accented-letter ranges, base64) that beat a
/// real sentence on any count-the-characters metric. Only runs short enough to
/// be words score at all, and the whitespace BETWEEN them is weighted heavily,
/// because separated words are the one thing every failure mode destroys:
/// ASCII misread as UTF-16 pairs letters into single ideographs, and UTF-16
/// misread as single bytes interleaves letters with control bytes.
///
/// Scoped honestly to scripts that separate their words — Latin, Hebrew,
/// Greek, Cyrillic, Arabic, the same set the OCR requests. A legacy `.doc`
/// written in Chinese or Japanese may pick the wrong reading; that is a known
/// limit of this heuristic, not a silent one.
fn prose_score(s: &str) -> usize {
    let mut score = 0usize;
    let mut word = 0usize;
    for c in s.chars() {
        if c.is_alphanumeric() {
            word += 1;
            continue;
        }
        if word <= MAX_WORD_LEN {
            score += word;
        }
        word = 0;
        if c.is_whitespace() {
            score += 4;
        }
    }
    if word <= MAX_WORD_LEN {
        score += word;
    }
    score
}

fn harvest_utf16(stream: &[u8]) -> String {
    let units: Vec<u16> = stream
        .chunks_exact(2)
        .map(|p| u16::from_le_bytes([p[0], p[1]]))
        .collect();
    let mut out = String::new();
    let mut run = String::new();
    for ch in char::decode_utf16(units) {
        match ch.ok().filter(|c| is_document_char(*c)) {
            Some(c) => run.push(normalize_control(c)),
            None => flush_run(&mut run, &mut out),
        }
        if out.len() > MAX_LEGACY_CHARS {
            break;
        }
    }
    flush_run(&mut run, &mut out);
    out
}

fn harvest_ascii(stream: &[u8]) -> String {
    let mut out = String::new();
    let mut run = String::new();
    for &b in stream {
        // Windows-1252 covers the accented letters these files actually carry;
        // the shared decoder already exists for RTF.
        match cp1252_char(b).filter(|c| is_document_char(*c)) {
            Some(c) => run.push(normalize_control(c)),
            None => flush_run(&mut run, &mut out),
        }
        if out.len() > MAX_LEGACY_CHARS {
            break;
        }
    }
    flush_run(&mut run, &mut out);
    out
}

fn flush_run(run: &mut String, out: &mut String) {
    // Count CHARACTERS, not bytes: a four-word Hebrew or accented run is well
    // over MIN_RUN bytes but must be measured the way a reader sees it.
    if run.chars().count() >= MIN_RUN && run.chars().any(|c| c.is_alphanumeric()) {
        out.push_str(run.trim());
        out.push('\n');
    }
    run.clear();
}

/// Characters that belong to a document's text. Word uses \r for a paragraph
/// break and \x07 for a cell/row end; \x0b is a soft line break.
fn is_document_char(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\t' | '\u{0b}' | '\u{07}')
        || (!c.is_control() && c != '\u{fffd}' && c != '\u{0}')
}

fn normalize_control(c: char) -> char {
    match c {
        '\r' | '\u{0b}' | '\u{07}' => '\n',
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an OLE compound file with one named stream — the shape a real
    /// .doc/.ppt has, without needing a fixture binary in the repo.
    fn ole_with(name: &str, payload: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut comp =
            cfb::CompoundFile::create(std::io::Cursor::new(Vec::new())).expect("create cfb");
        comp.create_stream(format!("/{name}")).unwrap().write_all(payload).unwrap();
        comp.flush().unwrap();
        comp.into_inner().into_inner()
    }

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// A PowerPoint record: 2-byte ver/instance, 2-byte type, 4-byte length.
    fn rec(ver_inst: u16, rec_type: u16, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(ver_inst.to_le_bytes());
        out.extend(rec_type.to_le_bytes());
        out.extend((body.len() as u32).to_le_bytes());
        out.extend(body);
        out
    }
    fn container(rec_type: u16, body: &[u8]) -> Vec<u8> {
        rec(0x000F, rec_type, body)
    }
    fn text_chars(s: &str) -> Vec<u8> {
        rec(0, RT_TEXT_CHARS, &utf16le(s))
    }

    #[test]
    fn a_word_97_document_gives_up_its_prose() {
        // The fallback sweep, exercised directly: textutil declines a stream
        // that is not really a .doc, so this is the path that answers.
        let mut payload = vec![0xEC, 0xA5, 0xC1, 0x00, 0x00, 0x00];
        payload.extend(utf16le("The lease fee is 5% per annum.\rSigned in Tel Aviv.\r"));
        payload.extend([0x00, 0x01, 0x02, 0x03]);
        let bytes = ole_with("WordDocument", &payload);
        let text = extract_legacy_doc("lease.doc", &bytes).expect("no text from .doc");
        assert!(text.contains("The lease fee is 5% per annum."), "{text}");
        assert!(text.contains("Signed in Tel Aviv."), "{text}");
    }

    #[test]
    fn accented_and_hebrew_text_survives() {
        // The whole point of preferring the UTF-16 harvest: these are the
        // characters a byte-wise reader mangles.
        let bytes = ole_with("WordDocument", &utf16le("Le siège social\rחוזה שכירות\r"));
        let text = extract_legacy_doc("x.doc", &bytes).expect("no text");
        assert!(text.contains("Le siège social"), "{text}");
        assert!(text.contains("חוזה שכירות"), "{text}");
    }

    #[test]
    fn binary_noise_does_not_reach_the_index() {
        // Short accidental runs are what make a naive strings() dump useless.
        let mut payload: Vec<u8> = (0u8..=255).collect();
        payload.extend(utf16le("Genuine sentence of prose here."));
        let bytes = ole_with("WordDocument", &payload);
        let text = extract_legacy_doc("x.doc", &bytes).expect("no text");
        assert!(text.contains("Genuine sentence of prose here."), "{text}");
        // The 0..255 sweep contains no 4+ character alphanumeric run in UTF-16.
        for junk in ["abcdefgh", "!\"#$%&'"] {
            assert!(!text.contains(junk), "binary noise leaked: {text}");
        }
    }

    #[test]
    fn a_genuine_word_97_file_reads_as_prose_not_as_its_font_table() {
        // THE REGRESSION THIS PINS: live QA opened a real Word 97 file and the
        // editor showed "Times New Roman / Arial / Droid Sans Fallback /
        // WenQuanYi Zen Hei" and then mojibake — the font table and binary
        // noise, indexed and shown as if they were the document.
        //
        // The fixture is a REAL .doc rather than a hand-built stream, which is
        // the whole point: every test above passes on a synthetic stream, and
        // the bug only ever appeared on a file Word actually wrote. macOS can
        // author one, so no 1 MB binary has to live in the repo.
        let rtf = br#"{\rtf1\ansi{\fonttbl\f0\froman Times New Roman;}\f0\fs24 Lorem ipsum dolor sit amet, consectetur adipiscing elit.\par Second paragraph of ordinary prose.\par}"#;
        let Some(doc) = make_doc(rtf) else {
            eprintln!("skipping: textutil could not author a .doc here");
            return;
        };
        let text = extract_legacy_doc("authored.doc", &doc).expect("no text from a real .doc");
        assert!(text.contains("Lorem ipsum dolor sit amet"), "prose missing: {text:?}");
        assert!(text.contains("Second paragraph of ordinary prose."), "prose missing: {text:?}");
        for junk in ["Times New Roman", "froman", "fonttbl"] {
            assert!(!text.contains(junk), "the font table reached the index: {text:?}");
        }
    }

    #[test]
    fn a_hyperlink_field_in_a_real_doc_does_not_reach_the_index_as_a_field_code() {
        // Live QA: the reader showed `HYPERLINK "https://products.office.com/…"`
        // as literal prose, and the same string was the file's indexed text.
        let rtf = br#"{\rtf1\ansi\f0\fs24 See {\field{\*\fldinst{HYPERLINK "https://example.com/page"}}{\fldrslt{the page}}} for details.\par}"#;
        let Some(doc) = make_doc(rtf) else { return };
        let text = extract_legacy_doc("linked.doc", &doc).expect("no text");
        assert!(!text.contains("HYPERLINK"), "the field code leaked: {text:?}");
        assert!(text.contains("for details"), "prose was eaten: {text:?}");
    }

    /// Author a genuine Word 97 file from RTF using macOS's own converter.
    fn make_doc(rtf: &[u8]) -> Option<Vec<u8>> {
        let stem = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir();
        let src = dir.join(format!("arcelle-test-{stem}.rtf"));
        let dst = dir.join(format!("arcelle-test-{stem}.doc"));
        std::fs::write(&src, rtf).ok()?;
        let ok = std::process::Command::new("/usr/bin/textutil")
            .args(["-convert", "doc", "-output"])
            .arg(&dst)
            .arg(&src)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let out = if ok { std::fs::read(&dst).ok() } else { None };
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
        out
    }

    #[test]
    fn a_non_word_file_renamed_doc_never_imports_its_own_bytes_as_text() {
        // `textutil` does not validate its input: handed arbitrary bytes in a
        // file named `.doc` it echoes them back and exits 0. Without the
        // compound-file gate, renaming ANY file to `.doc` would put its raw
        // bytes into the room's search index as the document's prose.
        let disguised = b"\x7fELF\x02\x01\x01\x00 this is a binary, not a document".to_vec();
        assert!(extract_legacy_doc("trojan.doc", &disguised).is_none());
        // A text file renamed .doc is the same mistake, quieter.
        assert!(extract_legacy_doc("notes.doc", b"just some plain text here").is_none());
    }

    #[test]
    fn a_powerpoint_97_deck_gives_up_its_slide_text_numbered() {
        let slide = container(RT_SLIDE, &text_chars("Quarterly review\rRevenue is up 12%.\r"));
        let bytes = ole_with("PowerPoint Document", &slide);
        let text = extract_legacy_ppt(&bytes).expect("no text from .ppt");
        assert!(text.contains("Quarterly review"), "{text}");
        assert!(text.contains("Revenue is up 12%."), "{text}");
        // Numbered exactly as a .pptx is, so a citation means the same thing.
        assert!(text.contains("[slide 1]"), "slides are not numbered: {text}");
    }

    #[test]
    fn the_slide_master_boilerplate_never_reaches_the_text() {
        // A real deck's master carries the placeholder prompts PowerPoint shows
        // in its own editor. The sweep this replaced returned them as content —
        // live QA saw "Click to edit the title text format" above the deck.
        let master = container(RT_MAIN_MASTER, &text_chars("Click to edit the title text format"));
        let slide = container(RT_SLIDE, &text_chars("The actual headline"));
        let mut stream = master;
        stream.extend(slide);
        let text = extract_legacy_ppt(&ole_with("PowerPoint Document", &stream)).expect("no text");
        assert!(text.contains("The actual headline"), "{text}");
        assert!(!text.contains("Click to edit"), "master boilerplate leaked: {text}");
    }

    #[test]
    fn speaker_notes_are_labelled_and_attached_to_their_slide() {
        let mut stream = container(RT_SLIDE, &text_chars("Headline one"));
        stream.extend(container(RT_NOTES, &text_chars("Say the number out loud.")));
        stream.extend(container(RT_SLIDE, &text_chars("Headline two")));
        let text = extract_legacy_ppt(&ole_with("PowerPoint Document", &stream)).expect("no text");
        assert!(text.contains("[slide 1 notes]"), "notes unlabelled: {text}");
        assert!(text.contains("Say the number out loud."), "{text}");
        assert!(text.contains("[slide 2]"), "numbering broke after notes: {text}");
    }

    #[test]
    fn a_notes_master_arriving_before_any_slide_is_dropped() {
        // The notes MASTER is a Notes container with nothing but the slide
        // number placeholder in it; it belongs to no slide.
        let mut stream = container(RT_NOTES, &text_chars("*\r*\r*\r"));
        stream.extend(container(RT_SLIDE, &text_chars("Real content")));
        let text = extract_legacy_ppt(&ole_with("PowerPoint Document", &stream)).expect("no text");
        assert!(!text.contains("notes]"), "the notes master was kept: {text}");
        assert!(text.contains("Real content"), "{text}");
    }

    #[test]
    fn single_byte_text_atoms_are_read_as_single_bytes() {
        // Older decks store runs as CP1252, not UTF-16.
        let atom = rec(0, RT_TEXT_BYTES, b"Single byte text atoms throughout.");
        let bytes = ole_with("PowerPoint Document", &container(RT_SLIDE, &atom));
        let text = extract_legacy_ppt(&bytes).expect("no text");
        assert!(text.contains("Single byte text atoms throughout."), "{text}");
    }

    #[test]
    fn a_record_claiming_a_length_past_the_buffer_stops_the_walk() {
        // A malformed or truncated deck must not be reinterpreted as records.
        let mut stream = container(RT_SLIDE, &text_chars("Good slide"));
        stream.extend([0x00, 0x00, 0xEE, 0x03, 0xFF, 0xFF, 0xFF, 0x7F]);
        let text = extract_legacy_ppt(&ole_with("PowerPoint Document", &stream)).expect("no text");
        assert!(text.contains("Good slide"), "{text}");
    }

    #[test]
    fn deeply_nested_containers_cannot_run_away_with_the_stack() {
        let mut body = text_chars("deep");
        for _ in 0..200 {
            body = container(0x0FF0, &body);
        }
        // Must return rather than overflow; the text is past the depth limit.
        let _ = extract_legacy_ppt(&ole_with("PowerPoint Document", &body));
    }

    #[test]
    fn single_byte_text_wins_over_its_own_utf16_garbage() {
        // Older PowerPoint text atoms are single-byte. Read as UTF-16LE the
        // same bytes decode to CJK ideographs ("桔獩搠捥⁫…"), each THREE UTF-8
        // bytes — so the garbage reading is LONGER than the correct one and a
        // length comparison picks it. This pins the fallback sweep's scoring.
        let payload = b"This deck was written with single byte text atoms throughout.".to_vec();
        let bytes = ole_with("PowerPoint Document", &payload);
        let text = extract_legacy_ppt(&bytes).expect("no text");
        assert!(text.contains("single byte text atoms"), "{text}");
    }

    #[test]
    fn prose_outscores_its_own_misdecoding_in_both_directions() {
        let ascii = "This deck was written with single byte text atoms throughout.";
        let as_utf16_garbage = harvest_utf16(ascii.as_bytes());
        assert!(
            prose_score(ascii) > prose_score(&as_utf16_garbage),
            "ASCII lost to its CJK misreading: {as_utf16_garbage:?}"
        );
        // …and the other way: real UTF-16 text read byte-wise is fragments.
        let utf16 = utf16le("A properly encoded sentence of ordinary prose.");
        assert!(
            prose_score(&harvest_utf16(&utf16)) > prose_score(&harvest_ascii(&utf16)),
            "UTF-16 lost to its byte-wise misreading"
        );
    }

    #[test]
    fn whitespace_is_what_separates_prose_from_noise() {
        // The signal the score rests on, asserted directly.
        assert!(prose_score("the quick brown fox") > prose_score("thequickbrownfox"));
    }

    #[test]
    fn a_file_that_is_not_a_compound_file_reads_as_nothing() {
        assert!(extract_legacy_doc("x.doc", b"not an OLE file at all").is_none());
        assert!(extract_legacy_ppt(&[0u8; 64]).is_none());
    }

    #[test]
    fn an_ole_file_without_the_expected_stream_reads_as_nothing() {
        let bytes = ole_with("SomethingElse", &utf16le("text that is not in WordDocument"));
        assert!(extract_legacy_doc("x.doc", &bytes).is_none());
    }

    #[test]
    fn whole_number_cells_do_not_gain_a_decimal_tail() {
        // A sheet of integers rendered as "12.0" pollutes both the index and
        // anything the model reads back.
        assert_eq!(trim_float(12.0), "12");
        assert_eq!(trim_float(12.5), "12.5");
        assert_eq!(trim_float(-3.0), "-3");
    }
}
