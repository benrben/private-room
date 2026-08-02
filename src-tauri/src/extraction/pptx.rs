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
    slides.sort_by_key(|n| slide_number(n).unwrap_or(0));
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
            out.push_str(&format!("[slide {}]\n", i + 1));
            out.push_str(&xml_paras_to_text(&xml, "</a:p>"));
            out.push('\n');
        }
        // The speaker notes belong to the slide, and in a real deck they carry
        // the argument, the numbers and the narration the headline only hints
        // at. Reading slide bodies alone left the assistant answering from
        // titles, confidently missing content plainly in the file.
        let slide_no = slide_number(entry).unwrap_or(i as u32 + 1);
        let notes_entry = format!("ppt/notesSlides/notesSlide{slide_no}.xml");
        let remaining = budget.saturating_sub(out.len() as u64);
        if remaining > 0 {
            if let Some(xml) = read_zip_entry_capped(bytes, &notes_entry, remaining) {
                let notes = xml_paras_to_text(&xml, "</a:p>");
                // The notes part of an un-annotated slide still exists and
                // still renders the slide number; only real prose is worth it.
                if notes.split_whitespace().count() > 1 {
                    out.push_str(&format!("[slide {} notes]\n", i + 1));
                    out.push_str(&notes);
                    out.push('\n');
                }
            }
        }
    }
    // Chart data and SmartArt/diagram text live in their own parts, so a deck
    // whose numbers are all in charts extracted to headings only.
    for (prefix, label) in [("ppt/charts/chart", "chart"), ("ppt/diagrams/data", "diagram")] {
        let mut parts: Vec<String> = archive
            .file_names()
            .filter(|n| n.starts_with(prefix) && n.ends_with(".xml"))
            .map(String::from)
            .collect();
        parts.sort();
        for entry in parts {
            let remaining = budget.saturating_sub(out.len() as u64);
            if remaining == 0 {
                break;
            }
            let Some(xml) = read_zip_entry_capped(bytes, &entry, remaining) else { continue };
            let text = xml_paras_to_text(&xml, "</a:p>");
            if text.split_whitespace().count() > 1 {
                out.push_str(&format!("[{label}]\n"));
                out.push_str(&text);
                out.push('\n');
            }
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The N in `ppt/slides/slideN.xml` — the notes part is numbered to match, and
/// the archive order the slides arrive in is not necessarily that numbering.
fn slide_number(entry: &str) -> Option<u32> {
    entry
        .trim_start_matches("ppt/slides/slide")
        .trim_end_matches(".xml")
        .parse()
        .ok()
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
    fn reads_speaker_notes_charts_and_diagrams() {
        // A real deck keeps its argument in the notes and its numbers in the
        // charts; reading slide bodies only left the model answering from
        // headlines. Every part must reach the extracted text, labelled.
        use std::io::Write;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                ("ppt/slides/slide1.xml", "<a:t>Q3 headline</a:t>"),
                (
                    "ppt/notesSlides/notesSlide1.xml",
                    "<a:t>Revenue fell because two contracts slipped.</a:t>",
                ),
                ("ppt/charts/chart1.xml", "<c:v>Region</c:v><c:v>41200</c:v>"),
                ("ppt/diagrams/data1.xml", "<a:t>Plan then build</a:t>"),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        let text = extract_text("deck.pptx", &cursor.into_inner()).expect("pptx text");
        assert!(text.contains("Q3 headline"), "got: {text}");
        assert!(text.contains("[slide 1 notes]"), "notes unlabelled: {text}");
        assert!(text.contains("two contracts slipped"), "notes missing: {text}");
        assert!(text.contains("41200"), "chart values missing: {text}");
        assert!(text.contains("Plan then build"), "diagram text missing: {text}");
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
