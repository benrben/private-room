use std::io::Read;

pub(crate) fn extract_xlsx(bytes: &[u8]) -> Option<String> {
    // Read every cell — string AND numeric. The old approach read only
    // xl/sharedStrings.xml, which interns *string* cells; numbers live inline
    // in each worksheet's XML, so an all-numeric sheet extracted to nothing
    // and never made it into search/RAG (the model then saw the file as empty).
    // umya parses the full workbook, so numbers, dates and formula results all
    // land in the extracted text. Bounds keep a pathological sheet from
    // ballooning the index.
    // Bounds on how much of a workbook becomes searchable text. Deliberately
    // wide — a real export has to land WHOLE, and the old 5 000×100 cut silently
    // hid most of a big sheet from search and from the model while the viewer
    // still showed every row. Whatever these do cut is ANNOUNCED in the text.
    const MAX_ROWS: u32 = 100_000;
    const MAX_COLS: u32 = 1_000;
    // A second, absolute ceiling: 100 000 × 1 000 cells would be a multi-GB
    // string. Whichever bound bites first, the truncation is reported.
    const MAX_TEXT_CHARS: usize = 16 * 1024 * 1024;
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
        let rows_total = ws.highest_row();
        let cols_total = ws.highest_column();
        let max_row = rows_total.min(MAX_ROWS);
        let max_col = cols_total.min(MAX_COLS);
        if max_row == 0 || max_col == 0 {
            continue;
        }
        out.push_str(&format!("[sheet: {}]\n", ws.name()));
        // Walk the POPULATED cells (already ordered row-then-column), NOT the
        // whole rows × columns rectangle. A sheet holding two values whose
        // highest cell sits at row 100 000 / column 1 000 spans a hundred
        // million coordinates: asking umya for every one of them — and
        // allocating a 1 000-element Vec<String> per row — cost seconds with
        // the room mutex held, and the MAX_TEXT_CHARS brake never fired
        // because empty cells add nothing to the output. Same text out, work
        // proportional to what the workbook actually contains.
        let mut last_row = max_row;
        let mut cells: Vec<String> = Vec::new();
        let mut row_no = 0u32;
        for cell in ws.cells_sorted() {
            let coord = cell.coordinate();
            let (col, row) = (coord.col_num(), coord.row_num());
            if row == 0 || col == 0 || row > max_row || col > max_col {
                continue;
            }
            let value = cell.value();
            if value.is_empty() {
                continue;
            }
            if row != row_no {
                if !cells.is_empty() {
                    // " | ", not a tab: `normalize_whitespace` runs over every
                    // extractor's output and collapses tabs, which flattened the
                    // grid into a run of words and made empty cells vanish
                    // entirely — so the model read "Name Total" for
                    // "Name | (blank) | Total" and could line the columns up wrong.
                    out.push_str(&cells.join(" | "));
                    out.push('\n');
                    cells.clear();
                }
                if out.len() >= MAX_TEXT_CHARS {
                    last_row = row_no;
                    break;
                }
                row_no = row;
            }
            if cells.len() < col as usize {
                cells.resize(col as usize, String::new());
            }
            cells[col as usize - 1] = value.into_owned();
        }
        if !cells.is_empty() {
            out.push_str(&cells.join(" | "));
            out.push('\n');
        }
        // Say so when anything was left out — a silently half-read export is
        // worse than a short one, because nothing downstream can tell.
        if last_row < rows_total || cols_total > max_col {
            out.push_str(&format!(
                "[sheet \"{}\" truncated: read rows 1–{last_row} of {rows_total}, \
                 columns 1–{max_col} of {cols_total}]\n",
                ws.name()
            ));
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
    fn columns_stay_separated_and_blank_cells_keep_their_place() {
        // Regression: cells were joined with a tab, and `normalize_whitespace`
        // collapses tabs — so the grid reached the model as a flat run of words
        // with empty cells gone entirely ("Name | (blank) | Total" → "Name
        // Total"), which is exactly how a column gets misread.
        let mut book = umya_spreadsheet::new_file();
        let ws = book.sheet_mut(0).unwrap();
        ws.cell_mut("A1").set_value("Name");
        ws.cell_mut("C1").set_value("Total"); // B1 deliberately blank
        let mut bytes: Vec<u8> = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();
        let text = extract_text("grid.xlsx", &bytes).expect("xlsx text");
        assert!(text.contains("Name | | Total"), "columns collapsed: {text}");
    }

    #[test]
    fn a_sparse_sheet_costs_its_cells_not_its_bounding_rectangle() {
        // Regression: extraction walked every coordinate in the
        // rows × columns rectangle, so a workbook holding two values whose
        // highest cell sits far out spanned tens of millions of lookups (and
        // one Vec<String> per row) — seconds of work with the room mutex held,
        // on a few hundred bytes of XML. The MAX_TEXT_CHARS brake cannot catch
        // it, because empty cells add nothing to the output.
        let mut book = umya_spreadsheet::new_file();
        let ws = book.sheet_mut(0).unwrap();
        ws.cell_mut("A1").set_value("Alpha");
        ws.cell_mut((1000u32, 40_000u32)).set_value("Omega");
        let mut bytes: Vec<u8> = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();
        let started = std::time::Instant::now();
        let text = extract_text("sparse.xlsx", &bytes).expect("xlsx text");
        let elapsed = started.elapsed();
        // Both values still land — the cheap walk reads the same cells.
        assert!(text.contains("Alpha"), "got: {text}");
        assert!(text.contains("Omega"), "got: {text}");
        // 40 000 × 1 000 = 40 million coordinates; the rectangle walk took ~8s
        // here and this walk takes ~20ms. Generous enough not to flake on a
        // loaded machine, tight enough that the old behaviour can't sneak back.
        assert!(
            elapsed < std::time::Duration::from_secs(3),
            "sparse sheet took {elapsed:?} — the bounding-rectangle walk is back"
        );
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
