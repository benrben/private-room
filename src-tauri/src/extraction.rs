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

/// A <w:t> text node found in document.xml: its byte spans plus decoded text.
struct DocxTextNode {
    tag_start: usize,
    body_start: usize,
    body_end: usize,
    text: Vec<char>,
}

/// Scan document.xml for text nodes, keeping paragraph boundaries so a
/// match never spans two paragraphs. Returns nodes plus a "virtual text"
/// stream: whitespace-collapsed document text where each char maps back to
/// (node index, char offset). Paragraph breaks appear as '\u{0}'.
fn scan_docx_text(xml: &str) -> (Vec<DocxTextNode>, Vec<char>, Vec<(usize, usize)>) {
    let mut nodes: Vec<DocxTextNode> = Vec::new();
    let mut hay: Vec<char> = Vec::new();
    let mut map: Vec<(usize, usize)> = Vec::new();
    let mut last_space = true;
    let mut i = 0;
    loop {
        let next_t = xml[i..].find("<w:t").map(|p| p + i);
        let next_p = xml[i..].find("</w:p>").map(|p| p + i);
        match (next_t, next_p) {
            (None, None) => break,
            (Some(t), p) if p.map_or(true, |p| t < p) => {
                // Only real "<w:t>" / "<w:t attr…>", not "<w:tab/>" etc.
                let after = &xml[t + 4..];
                if !(after.starts_with('>') || after.starts_with(' ')) {
                    i = t + 4;
                    continue;
                }
                let Some(gt) = after.find('>') else { break };
                // Self-closing empty node: "<w:t/>" or "<w:t …/>".
                if gt >= 1 && after.as_bytes()[gt - 1] == b'/' {
                    i = t + 4 + gt + 1;
                    continue;
                }
                let body_start = t + 4 + gt + 1;
                let Some(close) = xml[body_start..].find("</w:t>") else { break };
                let body_end = body_start + close;
                let text: Vec<char> =
                    decode_basic_entities(&xml[body_start..body_end]).chars().collect();
                let ni = nodes.len();
                for (ci, &ch) in text.iter().enumerate() {
                    if ch.is_whitespace() {
                        if !last_space {
                            hay.push(' ');
                            map.push((ni, ci));
                            last_space = true;
                        }
                    } else {
                        hay.push(ch);
                        map.push((ni, ci));
                        last_space = false;
                    }
                }
                nodes.push(DocxTextNode { tag_start: t, body_start, body_end, text });
                i = body_end + 6;
            }
            (_, Some(p)) => {
                // Paragraph boundary: an unmatchable separator.
                hay.push('\u{0}');
                map.push((usize::MAX, 0));
                last_space = true;
                i = p + 6;
            }
            // (Some, None) always satisfies the guard above.
            (Some(_), None) => unreachable!(),
        }
    }
    (nodes, hay, map)
}

/// Whitespace-collapsed needle: matching must survive the different spacing
/// the model sees in extracted text vs. what the runs actually contain.
fn collapse_ws(s: &str) -> Vec<char> {
    let mut out = Vec::new();
    let mut last_space = true;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    while out.last() == Some(&' ') {
        out.pop();
    }
    out
}

fn find_sub(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&s| &hay[s..s + needle.len()] == needle)
}

/// Replace `old` with `new` across the document's text nodes. Word splits a
/// sentence into many runs (spellcheck, formatting, rsid churn), so matches
/// may span several <w:t> nodes; the replacement lands in the first node
/// (keeping its formatting) and the remainder of the match is cleared.
/// Whitespace differences are tolerated. Returns (patched xml, match count).
fn replace_in_text_nodes(xml: &str, old: &str, new: &str) -> (String, usize) {
    let needle = collapse_ws(old);
    if needle.is_empty() {
        return (xml.to_string(), 0);
    }
    let (nodes, hay, map) = scan_docx_text(xml);

    // Collect non-overlapping matches, then per-node char-range edits.
    // edits[node] = (from_char, to_char_exclusive, replacement)
    let mut edits: Vec<Vec<(usize, usize, String)>> = vec![Vec::new(); nodes.len()];
    let mut count = 0;
    let mut from = 0;
    while let Some(s) = find_sub(&hay, &needle, from) {
        count += 1;
        from = s + needle.len();
        let (n1, off1) = map[s];
        let (n2, off2) = map[s + needle.len() - 1];
        if n1 == n2 {
            edits[n1].push((off1, off2 + 1, new.to_string()));
        } else {
            edits[n1].push((off1, nodes[n1].text.len(), new.to_string()));
            for node_edits in edits.iter_mut().take(n2).skip(n1 + 1) {
                node_edits.push((0, usize::MAX, String::new()));
            }
            edits[n2].push((0, off2 + 1, String::new()));
        }
    }
    if count == 0 {
        return (xml.to_string(), 0);
    }

    // Rewrite changed nodes, splicing right-to-left so byte spans stay valid.
    let mut out = xml.to_string();
    for ni in (0..nodes.len()).rev() {
        if edits[ni].is_empty() {
            continue;
        }
        let node = &nodes[ni];
        let mut text: Vec<char> = node.text.clone();
        let mut node_edits = edits[ni].clone();
        node_edits.sort_by_key(|e| e.0);
        for (start, end, repl) in node_edits.into_iter().rev() {
            let end = end.min(text.len());
            let tail: Vec<char> = text.split_off(end);
            text.truncate(start);
            text.extend(repl.chars());
            text.extend(tail);
        }
        let new_text: String = text.into_iter().collect();
        out.replace_range(node.body_start..node.body_end, &encode_xml_text(&new_text));
        // Word trims un-flagged edge whitespace; keep it explicit.
        let needs_preserve = new_text.starts_with(char::is_whitespace)
            || new_text.ends_with(char::is_whitespace);
        let tag = &out[node.tag_start..node.body_start];
        if needs_preserve && !tag.contains("xml:space") {
            out.insert_str(node.body_start - 1, " xml:space=\"preserve\"");
        }
    }
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
            "Could not find that text in the document (capitalization must match; \
             it can't cross a paragraph break). Copy a snippet exactly as it \
             appears in the file. Searched for: \"{old}\""
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
    // Read every cell — string AND numeric. The old approach read only
    // xl/sharedStrings.xml, which interns *string* cells; numbers live inline
    // in each worksheet's XML, so an all-numeric sheet extracted to nothing
    // and never made it into search/RAG (the model then saw the file as empty).
    // umya parses the full workbook, so numbers, dates and formula results all
    // land in the extracted text. Bounds keep a pathological sheet from
    // ballooning the index.
    const MAX_ROWS: u32 = 5000;
    const MAX_COLS: u32 = 100;
    let book = umya_spreadsheet::reader::xlsx::read_reader(
        std::io::Cursor::new(bytes.to_vec()),
        true,
    )
    .ok()?;
    let mut out = String::new();
    for ws in book.sheet_collection() {
        let max_row = ws.highest_row().min(MAX_ROWS);
        let max_col = ws.highest_column().min(MAX_COLS);
        if max_row == 0 || max_col == 0 {
            continue;
        }
        out.push_str(&format!("[sheet: {}]\n", ws.name()));
        for row in 1..=max_row {
            let mut cells: Vec<String> = (1..=max_col)
                .map(|col| ws.value((col, row)))
                .collect();
            while cells.last().map_or(false, |c| c.is_empty()) {
                cells.pop();
            }
            if !cells.is_empty() {
                out.push_str(&cells.join("\t"));
                out.push('\n');
            }
        }
        out.push('\n');
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
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
    // CHG-28: when the page has a <main> or <article>, keep only that region so
    // the limited tool-result budget is spent on body text, not site chrome.
    for tag in ["<main", "<article"] {
        let lower = s.to_lowercase();
        if let Some(open) = lower.find(tag) {
            let close = format!("</{}>", &tag[1..]);
            if let Some(rel) = lower.rfind(&close) {
                s = s[open..rel + close.len()].to_string();
                break;
            }
        }
    }
    for tag in ["</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</tr>", "<br>", "<br/>", "<br />"] {
        s = s.replace(tag, &format!("{tag}\n"));
    }
    // CHG-28: drop non-content element bodies (nav, chrome, forms, inline SVG)
    // in addition to scripts/styles, so their link text and boilerplate don't
    // crowd out the article.
    for pair in [
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<nav", "</nav>"),
        ("<header", "</header>"),
        ("<footer", "</footer>"),
        ("<aside", "</aside>"),
        ("<form", "</form>"),
        ("<noscript", "</noscript>"),
        ("<svg", "</svg>"),
    ] {
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
    fn extracts_xlsx_numeric_and_string_cells() {
        // Regression: numeric cells live inline in the worksheet XML, not in
        // sharedStrings.xml. An all-numeric sheet must still extract.
        let mut book = umya_spreadsheet::new_file();
        // new_file() ships with a default "Sheet1"; overwrite its cells.
        let ws = book.sheet_mut(0).unwrap();
        ws.cell_mut("A1").set_value("Marketing");
        ws.cell_mut("B1").set_value("12000"); // umya infers numeric type
        ws.cell_mut("A2").set_value("Engineering");
        ws.cell_mut("B2").set_value("45000");
        let mut bytes: Vec<u8> = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();
        let text = extract_text("budget.xlsx", &bytes).expect("xlsx text");
        assert!(text.contains("Marketing"), "got: {text}");
        assert!(text.contains("12000"), "numeric cell missing: {text}");
        assert!(text.contains("45000"), "numeric cell missing: {text}");
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

    #[test]
    fn text_node_replace_spans_formatting_runs() {
        // Real Word files split sentences across many runs mid-word.
        let xml = r#"<w:p><w:r><w:t>The fee is 5</w:t></w:r><w:r><w:t>% of </w:t></w:r><w:r><w:t>total revenue</w:t></w:r>.</w:p>"#;
        let (out, n) = replace_in_text_nodes(xml, "5% of total", "7% of net");
        assert_eq!(n, 1);
        let text: String = strip_tags(&out).split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(text.contains("The fee is 7% of net revenue"), "got: {text}");
    }

    #[test]
    fn text_node_replace_tolerates_whitespace_differences() {
        // The model quotes from extracted text, which has extra spaces.
        let xml = r#"<w:p><w:t>Payment due within 30 days.</w:t></w:p>"#;
        let (out, n) = replace_in_text_nodes(xml, "due  within\n30 days", "due within 45 days");
        assert_eq!(n, 1);
        assert!(out.contains("due within 45 days"));
    }

    #[test]
    fn text_node_replace_does_not_cross_paragraphs() {
        let xml = r#"<w:p><w:t>end here.</w:t></w:p><w:p><w:t>Next para</w:t></w:p>"#;
        let (_, n) = replace_in_text_nodes(xml, "here. Next", "x");
        assert_eq!(n, 0);
    }

    #[test]
    fn text_node_replace_marks_preserved_whitespace() {
        // A replacement that leaves edge whitespace in a modified node must
        // flag it, or Word trims it on open.
        let xml = r#"<w:p><w:t>ab</w:t><w:t>c</w:t></w:p>"#;
        let (out, n) = replace_in_text_nodes(xml, "b", "b and ");
        assert_eq!(n, 1);
        assert!(
            out.contains(r#"<w:t xml:space="preserve">ab and </w:t>"#),
            "got: {out}"
        );
    }
}
