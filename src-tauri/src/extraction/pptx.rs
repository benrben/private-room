use super::*;

pub(crate) fn extract_pptx(bytes: &[u8]) -> Option<String> {
    extract_pptx_budgeted(bytes, MAX_ZIP_ENTRY_BYTES)
}

fn extract_pptx_budgeted(bytes: &[u8], budget: u64) -> Option<String> {
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
        // The per-slide cap alone lets hundreds of near-cap slides balloon
        // the total, so all slides share one aggregate budget; downstream
        // truncates extracted text anyway, so stopping early loses nothing.
        let remaining = budget.saturating_sub(out.len() as u64);
        if remaining == 0 {
            break;
        }
        if let Some(xml) = read_zip_entry_capped(bytes, entry, remaining) {
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

    #[test]
    fn stops_appending_slides_once_budget_is_spent() {
        // Aggregate-budget guard: each slide is within the per-entry cap, but
        // the total across slides must not exceed the shared budget.
        use std::io::Write;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            for n in 1..=3 {
                writer
                    .start_file(format!("ppt/slides/slide{n}.xml"), options)
                    .unwrap();
                writer
                    .write_all(format!("<a:t>slide {n} body text</a:t>").as_bytes())
                    .unwrap();
            }
            writer.finish().unwrap();
        }
        let bytes = cursor.into_inner();
        let all = extract_pptx_budgeted(&bytes, 10_000).expect("all slides");
        assert!(all.contains("slide 3 body text"), "got: {all}");
        let capped = extract_pptx_budgeted(&bytes, 40).expect("first slide");
        assert!(capped.contains("slide 1 body text"), "got: {capped}");
        assert!(!capped.contains("slide 3 body text"), "budget ignored: {capped}");
    }
}
