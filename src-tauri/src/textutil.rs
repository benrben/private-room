//! macOS's own Word/RTF importer — the one behind TextEdit — at `/usr/bin/textutil`.
//!
//! WHY THIS EXISTS AS A SHARED MODULE: the legacy `.doc` path needs the same
//! converter twice, for two different outputs. The PREVIEW wants HTML (fonts,
//! weights, colours, lists); the EXTRACTED TEXT — what search, RAG and the
//! editor all read — wants plain text. Those used to come from two unrelated
//! places, and only the preview was any good: the text came from a `strings(1)`
//! style sweep of the OLE compound file that returned the font table and binary
//! noise. One document, two answers that disagreed.
//!
//! textutil ships with every Mac at a fixed path, works offline, and is nothing
//! to bundle, sign or notarize.

/// The formats `textutil` can import. `.docx` is deliberately absent from the
/// PREVIEW path (docx-preview renders more) but it can still be converted, so
/// this list is about what the importer understands, not about who uses it.
pub fn can_read(ext: &str) -> bool {
    matches!(ext, "doc" | "rtf" | "rtfd" | "odt" | "wordml" | "webarchive")
}

/// Convert `bytes` to `to` ("txt" or "html"). `None` when the format isn't
/// importable, the converter fails, or the result is empty.
///
/// Same bargain as the Quick Look bridge and the audio decoder: a system
/// converter takes a path, so the decrypted bytes touch the disk for the moment
/// it runs — owner-only, created exclusively — and are removed straight after.
pub fn convert(name: &str, bytes: &[u8], to: &str) -> Option<String> {
    let ext = crate::extraction::extension_of(name);
    if !can_read(&ext) {
        return None;
    }
    let stem = uuid::Uuid::new_v4();
    let dir = std::env::temp_dir();
    // Both paths are removed by Drop, so an early return, a panic in the
    // converter or a read failure can't leave decrypted bytes on disk.
    let src = TempPath(dir.join(format!("arcelle-tu-{stem}.{ext}")));
    let dst = TempPath(dir.join(format!("arcelle-tu-{stem}.{to}")));
    write_private(&src.0, bytes).ok()?;
    let run = std::process::Command::new("/usr/bin/textutil")
        .arg("-convert")
        .arg(to)
        .arg("-output")
        .arg(&dst.0)
        .arg(&src.0)
        .output();
    let out = match run {
        Ok(o) if o.status.success() => std::fs::read_to_string(&dst.0).ok(),
        _ => None,
    };
    out.filter(|h| !h.trim().is_empty())
}

/// A path that deletes itself. The decrypted copy this module writes must not
/// outlive the conversion, on any exit path.
struct TempPath(std::path::PathBuf);

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

/// Turn Word FIELD CODES that survived the import into what they mean.
///
/// A `.doc` stores a hyperlink as a field: the instruction `HYPERLINK "url"`
/// followed by the display text. textutil imports the instruction as literal
/// characters, so the reader saw
/// `HYPERLINK "https://products.office.com/en-us/word"Mauris id ex erat.`
/// — the machinery of the document leaking into its prose, and the actual link
/// not a link at all.
///
/// Only the codes that carry user-visible meaning are handled. Everything else
/// is left exactly as it came, because guessing at an unknown field is how a
/// converter starts eating real text.
pub fn resolve_field_codes(text: &str, as_html: bool) -> String {
    // ` HYPERLINK "target" ` — optionally preceded by the field-start char and
    // followed by switches like \l "anchor" or \o "tooltip".
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("HYPERLINK") {
        let (before, tail) = rest.split_at(at);
        let after = &tail["HYPERLINK".len()..];
        // The target is the first quoted string after the keyword.
        let Some(q1) = after.find('"') else {
            out.push_str(before);
            out.push_str("HYPERLINK");
            rest = after;
            continue;
        };
        let Some(q2rel) = after[q1 + 1..].find('"') else {
            out.push_str(before);
            out.push_str("HYPERLINK");
            rest = after;
            continue;
        };
        // Only treat it as a field if nothing but whitespace/switches sit
        // between the keyword and the quote — otherwise the word "HYPERLINK"
        // is just a word someone wrote.
        let gap = &after[..q1];
        if !gap.chars().all(|c| c.is_whitespace() || c == '\\' || c.is_alphanumeric()) {
            out.push_str(before);
            out.push_str("HYPERLINK");
            rest = after;
            continue;
        }
        let target = &after[q1 + 1..q1 + 1 + q2rel];
        out.push_str(before);
        // Trailing whitespace before the field belongs to the prose, not the link.
        if as_html && looks_like_url(target) {
            out.push_str(&format!(
                "<a href=\"{}\">{}</a>",
                escape_attr(target),
                escape_text(target)
            ));
        } else if !as_html {
            out.push_str(target);
        } else {
            out.push_str(&escape_text(target));
        }
        rest = &after[q1 + 1 + q2rel + 1..];
    }
    out.push_str(rest);
    out
}

/// Conservative: only schemes a document viewer should ever make clickable.
/// `javascript:` and friends must never become an `href`.
fn looks_like_url(s: &str) -> bool {
    let lower = s.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_formats_macos_can_import_are_offered() {
        assert!(can_read("doc"));
        assert!(can_read("rtf"));
        // .docx is deliberately absent: it renders through docx-preview with
        // page breaks, headers, footers and images, which is more than this
        // importer gives.
        assert!(!can_read("docx"));
        assert!(!can_read("pptx"));
        assert!(!can_read("pdf"));
    }

    #[test]
    fn a_real_rtf_converts_to_text() {
        let rtf = br"{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}";
        let txt = convert("sample.rtf", rtf, "txt").expect("no text from textutil");
        assert!(txt.contains("Hello bold world."), "{txt}");
    }

    #[test]
    fn the_decrypted_temp_copy_deletes_itself_on_every_exit_path() {
        // Asserted on the guard rather than by counting `arcelle-tu-*` files in
        // the shared temp dir: the tests run in parallel, so that count is
        // whatever the OTHER tests happen to be doing at the time.
        let path = std::env::temp_dir().join(format!("arcelle-tu-{}.probe", uuid::Uuid::new_v4()));
        {
            let guard = TempPath(path.clone());
            write_private(&guard.0, b"decrypted bytes").expect("write");
            assert!(path.exists(), "the guard did not create its file");
        }
        assert!(!path.exists(), "a decrypted temp copy outlived the conversion");
    }

    #[test]
    fn the_temp_copy_is_owner_only() {
        // These bytes are the plaintext of an encrypted room; no other account
        // on the Mac may read them while the converter runs.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path =
                std::env::temp_dir().join(format!("arcelle-tu-{}.probe", uuid::Uuid::new_v4()));
            let guard = TempPath(path.clone());
            write_private(&guard.0, b"secret").expect("write");
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "temp copy readable by others: {mode:o}");
        }
    }

    #[test]
    fn a_real_rtf_converts_to_html_with_its_formatting() {
        let rtf = br"{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}";
        let html = convert("sample.rtf", rtf, "html").expect("no html");
        assert!(html.to_lowercase().contains("<b>"), "bold was lost: {html}");
    }

    #[test]
    fn a_hyperlink_field_becomes_the_link_and_stops_being_prose() {
        // The exact shape live QA found in a real .doc.
        let src = " HYPERLINK \"https://products.office.com/en-us/word\"Mauris id ex erat.";
        let text = resolve_field_codes(src, false);
        assert!(!text.contains("HYPERLINK"), "the field code leaked: {text}");
        assert!(text.contains("Mauris id ex erat."), "prose was eaten: {text}");
        assert!(text.contains("https://products.office.com"), "target lost: {text}");

        let html = resolve_field_codes(src, true);
        assert!(html.contains("<a href=\"https://products.office.com/en-us/word\">"), "{html}");
        assert!(html.contains("Mauris id ex erat."), "prose was eaten: {html}");
    }

    #[test]
    fn several_hyperlinks_in_one_document_all_resolve() {
        let src = "a HYPERLINK \"https://one.example\"one b HYPERLINK \"https://two.example\"two";
        let text = resolve_field_codes(src, false);
        assert!(!text.contains("HYPERLINK"), "{text}");
        assert!(text.contains("one.example") && text.contains("two.example"), "{text}");
        assert!(text.contains(" b "), "prose between the fields was lost: {text}");
    }

    #[test]
    fn a_non_http_target_never_becomes_a_clickable_href() {
        // A document must not be able to smuggle script into the reader.
        let html = resolve_field_codes("HYPERLINK \"javascript:alert(1)\"click", true);
        assert!(!html.contains("<a href"), "a script URL became a link: {html}");
        assert!(!html.contains("javascript:alert(1)\""), "unescaped: {html}");
        assert!(html.contains("click"), "prose was eaten: {html}");
    }

    #[test]
    fn the_word_hyperlink_in_ordinary_prose_is_left_alone() {
        let src = "The HYPERLINK, as it is called, points elsewhere.";
        assert_eq!(resolve_field_codes(src, false), src);
    }

    #[test]
    fn text_with_no_fields_is_returned_unchanged() {
        let src = "Ordinary prose with \"quotes\" and no fields at all.";
        assert_eq!(resolve_field_codes(src, false), src);
    }
}
