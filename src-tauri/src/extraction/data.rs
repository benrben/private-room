//! Readers for the formats the registry newly claims: notebooks, saved mail,
//! subtitles, SVG and zip archives.
//!
//! Every one of these used to import as "no text at all" (so it was invisible
//! to search, to RAG and to the model) or as raw source pasted into the index
//! (so it polluted both). They are all cheap to read natively — a notebook is
//! JSON, an .eml is RFC-822 with two transfer encodings worth caring about, a
//! subtitle file is cue text between timestamps, an SVG is XML, and a zip's
//! central directory is already parsed by the crate the Office readers use.
//!
//! Best-effort by design, like every other reader here: any failure returns
//! `None` and import falls back to "no text", exactly as before.

use super::*;

/// Bound on how much text one of these files contributes to the index. Well
/// above any real document; a pathological generated file stops here rather
/// than ballooning the room.
const MAX_DERIVED_CHARS: usize = 8 * 1024 * 1024;

fn push_capped(out: &mut String, s: &str) {
    let room = MAX_DERIVED_CHARS.saturating_sub(out.len());
    if room == 0 {
        return;
    }
    if s.len() <= room {
        out.push_str(s);
    } else {
        let mut cut = room;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        out.push_str(&s[..cut]);
    }
}

// ------------------------------------------------------------- notebooks

/// Prose, code and printed output from a Jupyter notebook, in cell order.
///
/// The raw `.ipynb` is JSON, so before this the file either imported with no
/// text at all or (had it been treated as a text extension) contributed its
/// own escaped source to the index — `"cell_type": "markdown"` and
/// `\n`-riddled string arrays instead of the sentences a reader wrote.
pub(crate) fn extract_ipynb(bytes: &[u8]) -> Option<String> {
    let nb: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let cells = nb.get("cells")?.as_array()?;
    let mut out = String::new();
    for (i, cell) in cells.iter().enumerate() {
        let kind = cell.get("cell_type").and_then(|v| v.as_str()).unwrap_or("");
        let source = joined_source(cell.get("source"));
        if !source.trim().is_empty() {
            match kind {
                // Markdown cells are the notebook's prose — the part a search
                // for a sentence should actually hit.
                "markdown" | "raw" => push_capped(&mut out, &source),
                _ => {
                    push_capped(&mut out, &format!("[cell {}]\n", i + 1));
                    push_capped(&mut out, &source);
                }
            }
            push_capped(&mut out, "\n\n");
        }
        for output in cell.get("outputs").and_then(|v| v.as_array()).into_iter().flatten() {
            let text = output_text(output);
            if !text.trim().is_empty() {
                push_capped(&mut out, &text);
                push_capped(&mut out, "\n");
            }
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

/// `source` and `text` are either a string or an array of line-strings
/// (nbformat allows both, and real notebooks contain both).
fn joined_source(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(lines)) => {
            lines.iter().filter_map(|l| l.as_str()).collect::<Vec<_>>().join("")
        }
        _ => String::new(),
    }
}

/// The readable part of one cell output: stream text, or the `text/plain`
/// representation of a rich display value. Images and widget JSON are skipped.
fn output_text(output: &serde_json::Value) -> String {
    if let Some(text) = output.get("text") {
        return joined_source(Some(text));
    }
    output
        .get("data")
        .and_then(|d| d.get("text/plain"))
        .map(|t| joined_source(Some(t)))
        .unwrap_or_default()
}

// ------------------------------------------------------------------ mail

/// Headers worth indexing plus the readable body of a saved message.
///
/// Handles the two transfer encodings that actually appear in saved mail
/// (quoted-printable and base64) and prefers the `text/plain` alternative of a
/// multipart message, falling back to stripping the HTML one. Without this an
/// .eml indexed as either nothing or as raw MIME — base64 blobs and all.
pub(crate) fn extract_eml(raw: &str) -> Option<String> {
    let (headers, body) = split_headers(raw);
    let mut out = String::new();
    for name in ["From", "To", "Cc", "Date", "Subject"] {
        if let Some(value) = header(&headers, name) {
            push_capped(&mut out, &format!("{name}: {value}\n"));
        }
    }
    push_capped(&mut out, "\n");
    push_capped(&mut out, &eml_body_text(&headers, body));
    (!out.trim().is_empty()).then_some(out)
}

/// Split at the first blank line. A message with no body is still valid.
fn split_headers(raw: &str) -> (String, &str) {
    let raw = raw.trim_start_matches('\u{feff}');
    let end = raw.find("\r\n\r\n").map(|i| (i, i + 4)).or_else(|| raw.find("\n\n").map(|i| (i, i + 2)));
    match end {
        Some((head_end, body_start)) => (unfold(&raw[..head_end]), &raw[body_start..]),
        None => (unfold(raw), ""),
    }
}

/// RFC 5322 folding: a header line continued on the next line by leading
/// whitespace. Unfolded first so a wrapped Subject reads as one value.
fn unfold(headers: &str) -> String {
    let mut out = String::new();
    for line in headers.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            out.push(' ');
            out.push_str(line.trim());
        } else {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(line.trim_end());
        }
    }
    out
}

fn header(headers: &str, name: &str) -> Option<String> {
    let want = format!("{}:", name.to_ascii_lowercase());
    headers
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with(&want))
        .map(|l| decode_mime_words(l[want.len()..].trim()))
        .filter(|v| !v.is_empty())
}

/// The body, decoded and — for multipart — reduced to its readable part.
fn eml_body_text(headers: &str, body: &str) -> String {
    let content_type = header(headers, "Content-Type").unwrap_or_default().to_ascii_lowercase();
    if let Some(boundary) = mime_boundary(&content_type) {
        let mut html_fallback = String::new();
        for part in body.split(&format!("--{boundary}")).skip(1) {
            let part = part.trim_start_matches("--");
            if part.trim().is_empty() {
                continue;
            }
            let (part_headers, part_body) = split_headers(part);
            let part_type =
                header(&part_headers, "Content-Type").unwrap_or_default().to_ascii_lowercase();
            // Nested multipart (the common multipart/mixed → multipart/alternative
            // shape) recurses rather than being skipped as an unknown part.
            if part_type.starts_with("multipart/") {
                let nested = eml_body_text(&part_headers, part_body);
                if !nested.trim().is_empty() {
                    return nested;
                }
                continue;
            }
            let decoded = decode_transfer(&part_headers, part_body);
            if part_type.starts_with("text/plain") {
                return decoded;
            }
            if part_type.starts_with("text/html") && html_fallback.is_empty() {
                html_fallback = strip_html(&decoded);
            }
        }
        return html_fallback;
    }
    let decoded = decode_transfer(headers, body);
    if content_type.starts_with("text/html") {
        strip_html(&decoded)
    } else {
        decoded
    }
}

fn mime_boundary(content_type: &str) -> Option<String> {
    if !content_type.starts_with("multipart/") {
        return None;
    }
    let at = content_type.find("boundary=")?;
    let rest = content_type[at + "boundary=".len()..].trim();
    let value = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next().unwrap_or(""),
        None => rest.split(&[';', ' ', '\r', '\n'][..]).next().unwrap_or(""),
    };
    (!value.is_empty()).then(|| value.to_string())
}

fn decode_transfer(headers: &str, body: &str) -> String {
    match header(headers, "Content-Transfer-Encoding")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "quoted-printable" => decode_quoted_printable(body),
        "base64" => decode_base64_text(body),
        _ => body.to_string(),
    }
}

/// `=XX` hex escapes and `=` soft line breaks. Bytes are collected first and
/// decoded as UTF-8 at the end, so a multi-byte character split across two
/// escapes survives.
fn decode_quoted_printable(s: &str) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    let mut lines = s.lines().peekable();
    while let Some(line) = lines.next() {
        let (content, soft_break) = match line.strip_suffix('=') {
            Some(head) => (head, true),
            None => (line, false),
        };
        let raw = content.as_bytes();
        let mut i = 0;
        while i < raw.len() {
            if raw[i] == b'=' && i + 2 < raw.len() {
                let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok();
                if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    bytes.push(b);
                    i += 3;
                    continue;
                }
            }
            bytes.push(raw[i]);
            i += 1;
        }
        if !soft_break && lines.peek().is_some() {
            bytes.push(b'\n');
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn decode_base64_text(s: &str) -> String {
    use base64::Engine;
    let packed: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(packed)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_else(|_| s.to_string())
}

/// RFC 2047 `=?utf-8?B?…?=` / `=?utf-8?Q?…?=` encoded words, which is how a
/// non-ASCII Subject or display name reaches the file. Left as-is when the
/// charset isn't one we can decode, which is still better than dropping it.
fn decode_mime_words(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("?=") else { break };
        let word = &after[..end];
        let parts: Vec<&str> = word.splitn(3, '?').collect();
        if parts.len() == 3 {
            let charset = parts[0].to_ascii_lowercase();
            let decoded = match parts[1].to_ascii_uppercase().as_str() {
                "B" => decode_base64_text(parts[2]),
                // In an encoded word, `_` means space.
                "Q" => decode_quoted_printable(&parts[2].replace('_', " ")),
                _ => word.to_string(),
            };
            if charset.starts_with("utf-8") || charset.starts_with("us-ascii") {
                out.push_str(&decoded);
            } else {
                out.push_str(&decoded);
            }
        } else {
            out.push_str(word);
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

// ------------------------------------------------------------- subtitles

/// The spoken text of a subtitle file, without cue numbers or timestamps.
///
/// Indexing the raw file made every search for a phrase compete with a wall of
/// `00:01:23,456 --> 00:01:25,780`, and the model reading a transcript got
/// timing noise between every line.
pub(crate) fn extract_subtitles(raw: &str) -> Option<String> {
    let mut out = String::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty()
            || line == "WEBVTT"
            || line.contains("-->")
            || line.starts_with("NOTE ")
            || line.starts_with("STYLE")
            // A bare cue number ("42") carries nothing.
            || line.chars().all(|c| c.is_ascii_digit())
        {
            continue;
        }
        push_capped(&mut out, line);
        push_capped(&mut out, "\n");
    }
    (!out.trim().is_empty()).then_some(out)
}

// -------------------------------------------------------------- graphics

/// The words inside an SVG: `<title>`, `<desc>`, `<text>` and `<tspan>`
/// content. A diagram's labels are usually the only searchable thing in it.
///
/// Deliberately NOT `strip_html`: that reader DELETES `<svg>…</svg>` whole, on
/// purpose — inline SVG in a web page is chrome whose stray path data would
/// crowd out the article. Pointed at a standalone .svg it therefore returns
/// nothing at all, which is exactly the bug this function exists to avoid.
/// Only text-bearing elements are read, so `d="M0 0 L12 8"` never lands in the
/// index as if it were prose.
pub(crate) fn extract_svg(raw: &str) -> Option<String> {
    const TEXT_ELEMENTS: &[&str] = &["title", "desc", "text", "tspan", "textPath"];
    let mut out = String::new();
    for element in TEXT_ELEMENTS {
        let open = format!("<{element}");
        let close = format!("</{element}>");
        let lower = raw.to_ascii_lowercase();
        let close_lower = close.to_ascii_lowercase();
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(&open.to_ascii_lowercase()) {
            let start = from + rel;
            // Skip a longer element that merely starts with this name
            // (`<textPath>` when looking for `<text>`): the character after the
            // name must end the tag name.
            let after_name = start + open.len();
            let boundary = lower[after_name..].chars().next();
            if !matches!(boundary, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
                from = after_name;
                continue;
            }
            let Some(body_at) = lower[start..].find('>').map(|i| start + i + 1) else { break };
            let Some(end) = lower[body_at..].find(&close_lower).map(|i| body_at + i) else {
                break;
            };
            // Nested markup inside a <text> (a <tspan> per line) is read by the
            // tspan pass; here just take the characters between the tags.
            let inner: String = strip_inner_tags(&raw[body_at..end]);
            let inner = inner.trim();
            if !inner.is_empty() {
                push_capped(&mut out, inner);
                push_capped(&mut out, "\n");
            }
            from = end + close.len();
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

/// Drop any tags inside an element body, keeping the characters between them.
fn strip_inner_tags(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    decode_basic_entities(&out)
}

// -------------------------------------------------------------- archives

/// A zip's table of contents, one entry per line with its uncompressed size.
///
/// An archive had no preview and no text whatsoever, so a room full of
/// downloaded bundles was a room full of opaque rows. The listing alone makes
/// them searchable by the names of the files inside.
pub(crate) fn extract_zip_listing(bytes: &[u8]) -> Option<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut out = String::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else { continue };
        if entry.is_dir() {
            continue;
        }
        push_capped(&mut out, &format!("{}\t{}\n", entry.name(), entry.size()));
    }
    (!out.trim().is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notebook_gives_up_its_prose_code_and_output() {
        let nb = serde_json::json!({
            "cells": [
                {"cell_type": "markdown", "source": ["# Findings\n", "The rate is 4.2%.\n"]},
                {"cell_type": "code", "source": "print(total)", "outputs": [
                    {"output_type": "stream", "text": ["4.2\n"]}
                ]},
                {"cell_type": "code", "source": "df", "outputs": [
                    {"output_type": "execute_result", "data": {
                        "text/plain": "   a  b\n0  1  2",
                        "image/png": "iVBORw0KGgo="
                    }}
                ]}
            ]
        });
        let text = extract_ipynb(nb.to_string().as_bytes()).expect("no text");
        assert!(text.contains("The rate is 4.2%"), "markdown prose missing: {text}");
        assert!(text.contains("print(total)"), "code missing: {text}");
        assert!(text.contains("4.2"), "stream output missing: {text}");
        assert!(text.contains("0  1  2"), "text/plain result missing: {text}");
        // The base64 PNG must NOT reach the index.
        assert!(!text.contains("iVBORw0KGgo"), "an image blob leaked into the text");
    }

    #[test]
    fn a_notebook_that_is_not_a_notebook_reads_as_nothing() {
        assert!(extract_ipynb(b"not json").is_none());
        assert!(extract_ipynb(br#"{"nope": 1}"#).is_none());
        assert!(extract_ipynb(br#"{"cells": []}"#).is_none());
    }

    #[test]
    fn a_plain_message_keeps_its_headers_and_body() {
        let eml = "From: a@example.com\r\nTo: b@example.com\r\nSubject: Rent\r\n\r\nThe fee is 5%.\r\n";
        let text = extract_eml(eml).expect("no text");
        assert!(text.contains("Subject: Rent"));
        assert!(text.contains("The fee is 5%."));
    }

    #[test]
    fn a_folded_subject_and_an_encoded_word_are_read_as_one_value() {
        let eml = "Subject: =?utf-8?B?15fXqdeR15XXn8Kg15HXmdeq?=\r\n \
                   =?utf-8?Q?_more?=\r\nFrom: a@example.com\r\n\r\nbody\r\n";
        let text = extract_eml(eml).expect("no text");
        assert!(text.contains("חשבון"), "encoded word not decoded: {text}");
        assert!(text.contains("more"), "the folded continuation was dropped: {text}");
    }

    #[test]
    fn multipart_prefers_the_plain_alternative_and_decodes_it() {
        // quoted-printable body with a soft break and an escaped é.
        let eml = "Subject: Hi\r\nContent-Type: multipart/alternative; boundary=\"xyz\"\r\n\r\n\
                   --xyz\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n\
                   Le si=C3=A8ge so=\r\ncial\r\n\
                   --xyz\r\nContent-Type: text/html\r\n\r\n<p>ignored</p>\r\n--xyz--\r\n";
        let text = extract_eml(eml).expect("no text");
        assert!(text.contains("Le siège social"), "qp decode or soft break failed: {text}");
        assert!(!text.contains("ignored"), "the HTML alternative won over text/plain");
    }

    #[test]
    fn an_html_only_message_is_stripped_not_indexed_as_markup() {
        let eml = "Subject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n";
        let text = extract_eml(eml).expect("no text");
        assert!(text.contains("Hello"), "{text}");
        assert!(!text.contains("<b>"), "markup reached the index: {text}");
    }

    #[test]
    fn a_base64_body_is_decoded() {
        let eml = "Subject: Hi\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gd29ybGQ=\r\n";
        let text = extract_eml(eml).expect("no text");
        assert!(text.contains("Hello world"), "{text}");
    }

    #[test]
    fn subtitles_lose_their_timing_and_keep_their_words() {
        let srt = "1\n00:00:01,000 --> 00:00:04,000\nGood morning everyone.\n\n\
                   2\n00:00:04,500 --> 00:00:06,000\nLet's begin.\n";
        let text = extract_subtitles(srt).expect("no text");
        assert_eq!(text.trim(), "Good morning everyone.\nLet's begin.");
    }

    #[test]
    fn webvtt_headers_and_notes_are_dropped_too() {
        let vtt = "WEBVTT\n\nNOTE recorded live\n\n00:01.000 --> 00:02.000\nHello.\n";
        let text = extract_subtitles(vtt).expect("no text");
        assert_eq!(text.trim(), "Hello.");
    }

    #[test]
    fn an_svg_gives_up_its_labels() {
        let svg = r#"<svg><title>Revenue</title><text x="1">Q1 2026</text><path d="M0 0"/></svg>"#;
        let text = extract_svg(svg).expect("no text");
        assert!(text.contains("Revenue"), "{text}");
        assert!(text.contains("Q1 2026"), "{text}");
        assert!(!text.contains("M0 0"), "path data reached the index: {text}");
    }

    #[test]
    fn a_zip_lists_the_names_inside_it() {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for name in ["reports/q1.txt", "reports/q2.txt"] {
            w.start_file(name, opts).unwrap();
            w.write_all(b"ignored").unwrap();
        }
        let zipped = w.finish().unwrap().into_inner();
        let text = extract_zip_listing(&zipped).expect("no listing");
        assert!(text.contains("reports/q1.txt"), "{text}");
        assert!(text.contains("reports/q2.txt"), "{text}");
    }

    #[test]
    fn unreadable_bytes_read_as_nothing_rather_than_panicking() {
        assert!(extract_zip_listing(b"not a zip").is_none());
        assert!(extract_subtitles("   \n\n").is_none());
        assert!(extract_svg("<svg></svg>").is_none());
    }
}
