use std::io::Read;

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

fn extract_pdf(bytes: &[u8]) -> Option<String> {
    // pdf-extract can panic on malformed files; contain it.
    let bytes = bytes.to_vec();
    std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&bytes).ok())
        .ok()
        .flatten()
}

fn read_zip_entry(bytes: &[u8], entry: &str) -> Option<String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut file = archive.by_name(entry).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    Some(content)
}

fn extract_docx(bytes: &[u8]) -> Option<String> {
    let xml = read_zip_entry(bytes, "word/document.xml")?;
    // Paragraph ends become newlines so the text keeps its structure.
    let xml = xml.replace("</w:p>", "</w:p>\n");
    Some(strip_tags(&xml))
}

fn encode_xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Replace `old` with `new` inside every <w:t> text node of a document.xml
/// string. Word splits sentences into runs mid-word, so only matches that
/// land inside a single node are found. Returns (patched xml, match count).
fn replace_in_text_nodes(xml: &str, old: &str, new: &str) -> (String, usize) {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    let mut count = 0;
    while let Some(open) = rest.find("<w:t") {
        // "<w:t>" or "<w:t xml:space=…>", but not "<w:tab/>" etc.
        let after_tag = &rest[open + 4..];
        if !after_tag.starts_with('>') && !after_tag.starts_with(' ') {
            out.push_str(&rest[..open + 4]);
            rest = after_tag;
            continue;
        }
        let Some(gt) = after_tag.find('>') else { break };
        let body_start = open + 4 + gt + 1;
        let Some(close) = rest[body_start..].find("</w:t>") else { break };
        out.push_str(&rest[..body_start]);
        let body = &rest[body_start..body_start + close];
        let text = decode_basic_entities(body);
        if text.contains(old) {
            count += text.matches(old).count();
            out.push_str(&encode_xml_text(&text.replace(old, new)));
        } else {
            out.push_str(body);
        }
        rest = &rest[body_start + close..];
    }
    out.push_str(rest);
    (out, count)
}

/// Edit a .docx in place: replace text within word/document.xml, keeping
/// every other zip entry byte-identical. Errors carry guidance the model
/// can act on.
pub fn docx_replace_text(bytes: &[u8], old: &str, new: &str) -> Result<(Vec<u8>, usize), String> {
    use std::io::Write;
    let xml = read_zip_entry(bytes, "word/document.xml")
        .ok_or("This file is not a readable .docx document.")?;
    let (patched, count) = replace_in_text_nodes(&xml, old, new);
    if count == 0 {
        return Err(format!(
            "Could not find that exact text in the document. It must match a single \
             formatting run — try a shorter snippet copied exactly from the file, \
             without line breaks. Searched for: \"{old}\""
        ));
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut out = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut out);
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        if entry.name() == "word/document.xml" {
            drop(entry);
            writer
                .start_file("word/document.xml", zip::write::SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            writer.write_all(patched.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            writer.raw_copy_file(entry).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok((out.into_inner(), count))
}

fn extract_xlsx(bytes: &[u8]) -> Option<String> {
    // Shared strings hold most cell text; good enough for search/RAG.
    let xml = read_zip_entry(bytes, "xl/sharedStrings.xml")?;
    let xml = xml.replace("</si>", "</si>\n");
    Some(strip_tags(&xml))
}

fn extract_pptx(bytes: &[u8]) -> Option<String> {
    let cursor = std::io::Cursor::new(bytes);
    let archive = zip::ZipArchive::new(cursor).ok()?;
    let mut slides: Vec<String> = archive
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .map(String::from)
        .collect();
    slides.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });
    let mut out = String::new();
    for (i, entry) in slides.iter().enumerate() {
        if let Some(xml) = read_zip_entry(bytes, entry) {
            let xml = xml.replace("</a:p>", "</a:p>\n");
            out.push_str(&format!("[slide {}]\n", i + 1));
            out.push_str(&strip_tags(&xml));
            out.push('\n');
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
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

pub fn strip_html(html: &str) -> String {
    let mut s = html.to_string();
    for tag in ["</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</tr>", "<br>", "<br/>", "<br />"] {
        s = s.replace(tag, &format!("{tag}\n"));
    }
    // Drop script/style bodies.
    for pair in [("<script", "</script>"), ("<style", "</style>")] {
        while let Some(start) = s.to_lowercase().find(pair.0) {
            let lower = s.to_lowercase();
            let end = lower[start..].find(pair.1).map(|i| start + i + pair.1.len());
            match end {
                Some(end) => s.replace_range(start..end, ""),
                None => break,
            }
        }
    }
    strip_tags(&s)
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_basic_entities(&out)
}

fn decode_basic_entities(s: &str) -> String {
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

/// Split text into ~target_chars chunks along paragraph boundaries.
pub fn chunk_text(text: &str, target_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if !current.is_empty() && current.len() + para.len() > target_chars {
            chunks.push(std::mem::take(&mut current));
        }
        // A single huge paragraph still needs to be cut somewhere.
        if para.len() > target_chars * 2 {
            for piece in split_by_len(para, target_chars) {
                chunks.push(piece);
            }
        } else {
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(para);
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

fn split_by_len(s: &str, target: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for word in s.split_whitespace() {
        if !current.is_empty() && current.len() + word.len() + 1 > target {
            out.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fake_office_zip(entry: &str, xml: &str) -> Vec<u8> {
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

    #[test]
    fn extracts_pptx_slide_text() {
        let bytes = fake_office_zip(
            "ppt/slides/slide1.xml",
            r#"<p:sld><a:t>Quarterly revenue plan</a:t><a:p></a:p></p:sld>"#,
        );
        let text = extract_text("deck.pptx", &bytes).expect("pptx text");
        assert!(text.contains("Quarterly revenue plan"));
        assert!(text.contains("[slide 1]"));
    }

    #[test]
    fn extracts_docx_paragraphs() {
        let bytes = fake_office_zip(
            "word/document.xml",
            r#"<w:document><w:p><w:t>Hello contract</w:t></w:p></w:document>"#,
        );
        let text = extract_text("contract.docx", &bytes).expect("docx text");
        assert!(text.contains("Hello contract"));
    }

    #[test]
    fn docx_replace_edits_text_and_round_trips() {
        let bytes = fake_office_zip(
            "word/document.xml",
            r#"<w:document><w:p><w:t xml:space="preserve">Fee: 5% &amp; costs</w:t></w:p></w:document>"#,
        );
        let (patched, n) = docx_replace_text(&bytes, "5% & costs", "7% & costs").expect("replace");
        assert_eq!(n, 1);
        let text = extract_text("contract.docx", &patched).expect("docx text");
        assert!(text.contains("7% & costs"), "got: {text}");
        assert!(!text.contains("5%"));
    }

    #[test]
    fn docx_replace_rejects_missing_text() {
        let bytes = fake_office_zip(
            "word/document.xml",
            r#"<w:document><w:p><w:t>Hello</w:t></w:p></w:document>"#,
        );
        assert!(docx_replace_text(&bytes, "Goodbye", "x").is_err());
    }

    #[test]
    fn text_node_replace_skips_tags_and_counts() {
        let xml = r#"<w:p><w:tab/><w:t>alpha beta</w:t><w:t>beta</w:t></w:p>"#;
        let (out, n) = replace_in_text_nodes(xml, "beta", "gamma");
        assert_eq!(n, 2);
        assert!(out.contains("alpha gamma"));
        assert!(out.contains("<w:tab/>"));
    }
}
