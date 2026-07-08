use super::*;

pub(crate) fn extract_pptx(bytes: &[u8]) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extraction::{extract_text, fake_office_zip};

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
}
