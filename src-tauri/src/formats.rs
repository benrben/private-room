//! THE FORMAT REGISTRY — one declarative table for "what is this file?".
//!
//! Before this module the answer lived in three hand-maintained places: this
//! crate's `classify_file`, the frontend's `editModeOf`, and the frontend's
//! `ViewerRouter` switch. Adding one format meant editing all three and keeping
//! them consistent by eye, and they had already drifted (comparing two versions
//! of a spreadsheet reported "nothing to compare" for exactly that reason).
//!
//! Now there is ONE row per format family here. Rust reads it for the viewer
//! payload (`get_file_content`) and the version-compare view (`content_text`);
//! the frontend reads the kind names out of `format_support()` and maps each to
//! a component in `src/viewers/registry.ts`, whose own test asserts it covers
//! every kind this table can produce. Drift becomes a failing test, not a bug
//! report.

use crate::extraction;

/// Ceiling on a file whose RAW bytes are handed over as editable text (csv,
/// markdown, html, code, …). That text crosses IPC unclipped — it has to,
/// because a clipped buffer saved back would truncate the file — so the ceiling
/// is the only guard. csv and markdown used to have none at all, which is how
/// opening a large exported spreadsheet hung the window.
pub const MAX_RAW_TEXT_BYTES: usize = 10 * 1024 * 1024;

/// Where a file's text comes from.
///
/// There is deliberately no "no text" case: classification sees only a name, a
/// MIME type and a length, so it can never know whether a file HAS text — "the
/// stored text is None" answers that, and both readers already handle it (the
/// viewer falls back to the binary card, the compare view to "no text to
/// compare"). A third variant only ever encoded a guess, and guessing it for
/// oversized images is what hid a large scan's OCR text from the viewer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TextSource {
    /// The stored bytes ARE the text (csv, markdown, html, code).
    Raw,
    /// Text was read OUT of a binary format (pdf, docx, xlsx, pptx, OCR, STT).
    Extracted,
}

/// How a viewer receives the file's raw bytes, when it needs them at all.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Delivery {
    /// The viewer works from `text` alone — no bytes cross the wire.
    None,
    /// Bytes are staged in the in-memory media map and reached over
    /// `roommedia://localhost/<token>` with HTTP Range support.
    ///
    /// This replaced base64-over-IPC, and with it the 50 MB cliff that used to
    /// make an oversized PDF, scan or workbook silently lose its real viewer
    /// and open as a plain `<pre>`. A base64 string is 4/3 the size of the file
    /// AND has to be built, copied through IPC, and parsed by JS before
    /// anything renders; a stream is none of those things, so the cap that
    /// existed to bound it is simply gone.
    Stream,
}

/// What a file looks like to the app: which viewer opens it, where its text
/// comes from, whether that text round-trips (so it can be edited in place),
/// and how the viewer gets the bytes.
#[derive(Clone, Copy, Debug)]
pub struct FileView {
    pub kind: &'static str,
    pub text: TextSource,
    pub editable: bool,
    pub delivery: Delivery,
}

impl FileView {
    pub fn needs_bytes(&self) -> bool {
        self.delivery == Delivery::Stream
    }
}

/// One row of the registry.
struct Row {
    /// Lowercase extensions, without the dot.
    exts: &'static [&'static str],
    kind: &'static str,
    text: TextSource,
    editable: bool,
    delivery: Delivery,
    /// Raw-text rows only: past this many bytes the file falls back to a
    /// clipped read-only preview instead of an editable buffer. `None` means
    /// no ceiling, which is what every streamed row wants.
    max_bytes: Option<usize>,
}

use Delivery::{None as NoBytes, Stream};
use TextSource::{Extracted, Raw};

/// The table. Order matters only in that the FIRST row matching an extension
/// wins; no extension appears twice (a test enforces that).
const FORMATS: &[Row] = &[
    // ---- rich formats: the viewer parses the real bytes ----------------
    Row { exts: &["pdf"], kind: "pdf", text: Extracted, editable: false, delivery: Stream, max_bytes: Option::None },
    Row { exts: &["docx"], kind: "docx", text: Extracted, editable: false, delivery: Stream, max_bytes: Option::None },
    Row { exts: &["xlsx", "xls", "ods"], kind: "sheet", text: Extracted, editable: false, delivery: Stream, max_bytes: Option::None },
    // NEW: presentations used to fall all the way through to the plain-text
    // card, so a deck opened as a wall of undifferentiated slide text. Both
    // generations are drawn by macOS now — .pptx slide by slide (the deck is
    // reordered so Quick Look draws the one asked for), .ppt as its first
    // slide, which is all a binary-format deck can offer.
    Row { exts: &["pptx", "ppt"], kind: "slides", text: Extracted, editable: false, delivery: Stream, max_bytes: Option::None },
    // NEW: legacy Word and RTF used to reach the plain-text card with every
    // heading, weight and colour gone. macOS's own Word importer reads them.
    Row { exts: &["doc", "rtf"], kind: "worddoc", text: Extracted, editable: false, delivery: NoBytes, max_bytes: Option::None },
    // NEW: e-books, likewise — a whole book as one `<pre>`, no chapters.
    Row { exts: &["epub"], kind: "book", text: Extracted, editable: false, delivery: Stream, max_bytes: Option::None },
    // NEW: archives had no preview at all ("No preview available for this file
    // type yet") even though listing a zip needs nothing but the central
    // directory the extractor already reads.
    Row { exts: &["zip"], kind: "archive", text: Extracted, editable: false, delivery: Stream, max_bytes: Option::None },

    // ---- raw text the viewer renders specially -------------------------
    Row { exts: &["csv", "tsv"], kind: "csv", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    Row { exts: &["md", "markdown"], kind: "markdown", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    Row { exts: &["html", "htm"], kind: "html", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    // NEW: an SVG used to render as a flat picture with its source unreachable.
    Row { exts: &["svg"], kind: "svg", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    // NEW: notebooks are JSON, so they opened in the CODE editor as a wall of
    // escaped source — in an app that already runs .py scripts.
    Row { exts: &["ipynb"], kind: "notebook", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    // NEW: same story for data dumps — a 5 MB API response in a code editor.
    Row { exts: &["json", "jsonl", "ndjson"], kind: "json", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    // NEW: subtitles pair with the media player that is already in the app.
    Row { exts: &["srt", "vtt"], kind: "subtitle", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    // NEW: saved mail. Raw source reaches the viewer (it parses MIME itself);
    // `extract_text` separately derives clean prose for search and the model.
    Row { exts: &["eml"], kind: "email", text: Raw, editable: false, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    // NEW: prose and logs used to open in a CODE EDITOR — a letter or a diary
    // entry rendered as source, with a plaintext "language".
    Row { exts: &["txt"], kind: "prose", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
    Row { exts: &["log"], kind: "log", text: Raw, editable: true, delivery: NoBytes, max_bytes: Some(MAX_RAW_TEXT_BYTES) },
];

/// The fallback rows, kept out of the table because they are not chosen by
/// extension: images (chosen by MIME), code (chosen by
/// `extraction::is_text_extension`) and the read-only text card.
const IMAGE: FileView =
    FileView { kind: "image", text: Extracted, editable: false, delivery: Stream };
const CODE: FileView = FileView { kind: "code", text: Raw, editable: true, delivery: NoBytes };
const PLAIN: FileView =
    FileView { kind: "text", text: Extracted, editable: false, delivery: NoBytes };

/// Classify a file from its name, MIME type and length.
///
/// Extension wins over MIME so `image/svg+xml` reaches the SVG source view
/// rather than the raster image viewer, and so a mislabelled octet-stream
/// upload still opens correctly.
pub fn classify_file(name: &str, mime: &str, len: usize) -> FileView {
    let ext = extraction::extension_of(name);
    if let Some(row) = FORMATS.iter().find(|r| r.exts.contains(&ext.as_str())) {
        // A raw-text row past its ceiling can't hand its bytes over as an
        // editable string; it degrades to the clipped read-only card, which is
        // exactly what it did before. Streamed rows have no ceiling at all.
        if row.max_bytes.is_none_or(|max| len <= max) {
            return FileView {
                kind: row.kind,
                text: row.text,
                editable: row.editable,
                delivery: row.delivery,
            };
        }
        return PLAIN;
    }
    // Images: the picture itself, plus whatever OCR read off it (ADD-14) — the
    // recognized text was being computed, indexed and then withheld from the
    // viewer, so it could never be seen, copied or corrected. There is no size
    // cliff any more: the bytes stream, so a 60 MB TIFF scan of a map opens in
    // the real image viewer instead of degrading to its OCR text.
    if extraction::is_image(mime) {
        return IMAGE;
    }
    // Files whose bytes ARE text: viewable and safely editable in place.
    if extraction::is_text_extension(&ext) && len <= MAX_RAW_TEXT_BYTES {
        return CODE;
    }
    // Everything else (rtf, doc/ppt via the universal extractor, an oversized
    // csv): read-only preview of whatever text we managed to extract.
    PLAIN
}

/// Every kind this table can produce. The frontend registry's test asserts it
/// has a component for each one, so a new row here fails the UI build until it
/// is given a viewer instead of silently landing on the "no preview" card.
pub fn all_kinds() -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = FORMATS.iter().map(|r| r.kind).collect();
    kinds.extend([IMAGE.kind, CODE.kind, PLAIN.kind]);
    // The media kinds are classified by `stt::media_kind` upstream of this
    // table (they are chosen by MIME family, not extension) but they are still
    // viewer kinds the frontend has to cover.
    kinds.extend(["audio", "video", "recording", "binary"]);
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

/// Every extension the registry claims by name, for the import dialog's filter
/// list and for the "what can this app open?" surfaces.
pub fn all_extensions() -> Vec<&'static str> {
    let mut exts: Vec<&'static str> = FORMATS.iter().flat_map(|r| r.exts.iter().copied()).collect();
    exts.extend(extraction::text_extensions().iter().copied());
    exts.sort_unstable();
    exts.dedup();
    exts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_extension_is_claimed_by_two_rows() {
        let mut seen: Vec<&str> = Vec::new();
        for row in FORMATS {
            for ext in row.exts {
                assert!(!seen.contains(ext), "{ext} is claimed by two registry rows");
                seen.push(ext);
            }
        }
    }

    #[test]
    fn streamed_rows_have_no_size_ceiling() {
        // The whole point of streaming: a big file keeps its real viewer.
        for row in FORMATS.iter().filter(|r| r.delivery == Stream) {
            assert!(
                row.max_bytes.is_none(),
                "{} is streamed, so it must not carry a byte ceiling",
                row.kind
            );
        }
        let huge = 400 * 1024 * 1024;
        assert_eq!(classify_file("scan.pdf", "application/pdf", huge).kind, "pdf");
        assert_eq!(classify_file("book.epub", "application/epub+zip", huge).kind, "book");
        assert_eq!(classify_file("photo.tiff", "image/tiff", huge).kind, "image");
    }

    #[test]
    fn raw_text_rows_degrade_past_their_ceiling() {
        let over = MAX_RAW_TEXT_BYTES + 1;
        assert_eq!(classify_file("a.csv", "text/csv", over).kind, "text");
        assert_eq!(classify_file("a.csv", "text/csv", 10).kind, "csv");
        assert!(!classify_file("a.csv", "text/csv", over).editable);
    }

    #[test]
    fn extension_beats_mime_for_svg() {
        // image/svg+xml is an image MIME, but the useful view is its source.
        let v = classify_file("logo.svg", "image/svg+xml", 500);
        assert_eq!(v.kind, "svg");
        assert!(v.editable);
    }

    #[test]
    fn the_new_kinds_are_reachable() {
        for (name, kind) in [
            ("deck.pptx", "slides"),
            ("novel.epub", "book"),
            ("bundle.zip", "archive"),
            ("analysis.ipynb", "notebook"),
            ("dump.json", "json"),
            ("captions.srt", "subtitle"),
            ("mail.eml", "email"),
            ("letter.txt", "prose"),
            ("server.log", "log"),
        ] {
            assert_eq!(classify_file(name, "application/octet-stream", 1000).kind, kind);
        }
    }

    #[test]
    fn prose_and_logs_no_longer_open_in_the_code_editor() {
        assert_eq!(classify_file("diary.txt", "text/plain", 100).kind, "prose");
        assert_eq!(classify_file("run.log", "text/plain", 100).kind, "log");
        // …but real source still does.
        assert_eq!(classify_file("main.rs", "text/plain", 100).kind, "code");
        assert_eq!(classify_file("conf.xml", "text/xml", 100).kind, "code");
    }

    #[test]
    fn every_kind_is_named_once() {
        let kinds = all_kinds();
        let mut sorted = kinds.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(kinds.len(), sorted.len(), "all_kinds() returned a duplicate");
        for k in ["pdf", "docx", "sheet", "slides", "book", "archive", "image", "code", "text"] {
            assert!(kinds.contains(&k), "{k} missing from all_kinds()");
        }
    }
}
