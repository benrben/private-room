use super::*;

pub(crate) fn extract_docx(bytes: &[u8]) -> Option<String> {
    let xml = read_zip_entry(bytes, "word/document.xml")?;
    Some(xml_paras_to_text(&xml, "</w:p>"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extraction::{extract_text, fake_office_zip, strip_tags};

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
