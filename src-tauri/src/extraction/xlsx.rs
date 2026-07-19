use std::io::Read;

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
    // umya fully decompresses the workbook into an object model BEFORE the
    // row/col bounds below apply, so a small zip bomb could balloon memory.
    // Declared sizes can lie (and umya's zip does not bound inflate output by
    // them), so the declared-size check is only a fast path for honest
    // oversized files; the streaming re-count of ACTUAL inflated bytes below
    // is the real guard. Generous on purpose — a genuinely huge all-numeric
    // sheet must still extract (see the comment above).
    const MAX_XLSX_DECOMPRESSED: u64 = 512 * 1024 * 1024;
    if !zip_declared_size_within(bytes, MAX_XLSX_DECOMPRESSED) {
        return None;
    }
    if !zip_inflated_size_within(bytes, MAX_XLSX_DECOMPRESSED) {
        return None;
    }
    let book =
        umya_spreadsheet::reader::xlsx::read_reader(std::io::Cursor::new(bytes), true).ok()?;
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

/// True when the sum of the archive's declared decompressed entry sizes stays
/// within `cap` (and the bytes parse as a zip at all).
fn zip_declared_size_within(bytes: &[u8], cap: u64) -> bool {
    let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else {
        return false;
    };
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index_raw(i) {
            total = total.saturating_add(entry.size());
            if total > cap {
                return false;
            }
        }
    }
    true
}

/// True when the sum of the archive's ACTUAL inflated entry sizes stays
/// within `cap`. Each entry is streamed through `take` into a counting sink
/// (no buffering), so a bomb costs at most `cap + 1` bytes of decompression
/// work and O(1) memory before it is refused. Entries that cannot be read
/// (encrypted, unsupported method) refuse the workbook too — umya must only
/// ever see bytes that verified within bounds.
fn zip_inflated_size_within(bytes: &[u8], cap: u64) -> bool {
    let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else {
        return false;
    };
    let mut remaining = cap;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            return false;
        };
        let Ok(n) = std::io::copy(&mut entry.take(remaining + 1), &mut std::io::sink()) else {
            return false;
        };
        if n > remaining {
            return false;
        }
        remaining -= n;
    }
    true
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

    #[test]
    fn refuses_workbook_declaring_more_than_cap() {
        // Decompression-bomb guard: a workbook whose entries declare more
        // decompressed bytes than the cap is refused before umya inflates it.
        let bytes = crate::extraction::fake_office_zip("xl/worksheets/sheet1.xml", "<x/>");
        assert!(zip_declared_size_within(&bytes, 1024));
        assert!(!zip_declared_size_within(&bytes, 1)); // 5-byte entry > 1-byte cap
        assert!(!zip_declared_size_within(b"not a zip", 1024));
    }

    #[test]
    fn refuses_workbook_inflating_more_than_cap() {
        // The streaming guard counts ACTUAL inflated bytes, not headers.
        let content = "x".repeat(100);
        let bytes = crate::extraction::fake_office_zip("xl/worksheets/sheet1.xml", &content);
        assert!(zip_inflated_size_within(&bytes, 1024));
        assert!(!zip_inflated_size_within(&bytes, 99));
        assert!(!zip_inflated_size_within(b"not a zip", 1024));
    }

    #[test]
    fn refuses_workbook_with_lying_declared_sizes() {
        // A crafted bomb declares tiny uncompressed sizes but inflates far
        // past them; the declared-size fast path passes, so the streaming
        // re-count must be the one that refuses it.
        let content = "x".repeat(100);
        let mut bytes = crate::extraction::fake_office_zip("xl/worksheets/sheet1.xml", &content);
        // Patch the declared uncompressed size to 1 in both the local file
        // header (offset 22 past PK\x03\x04) and the central directory record
        // (offset 24 past PK\x01\x02).
        let local = bytes
            .windows(4)
            .position(|w| w == b"PK\x03\x04")
            .expect("local header");
        bytes[local + 22..local + 26].copy_from_slice(&1u32.to_le_bytes());
        let central = bytes
            .windows(4)
            .position(|w| w == b"PK\x01\x02")
            .expect("central directory");
        bytes[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
        assert!(zip_declared_size_within(&bytes, 64), "fast path should pass");
        assert!(!zip_inflated_size_within(&bytes, 64), "real guard must catch it");
    }
}
