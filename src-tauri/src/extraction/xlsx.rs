pub(crate) fn extract_xlsx(bytes: &[u8]) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extraction::extract_text;

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
}
