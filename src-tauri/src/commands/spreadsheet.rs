use super::*;

/// "B7" → zero-based (row, col). None when it isn't A1 notation.
pub(crate) fn parse_a1(cell: &str) -> Option<(usize, usize)> {
    let cell = cell.trim().to_uppercase();
    let letters: String = cell.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits = &cell[letters.len()..];
    if letters.is_empty() || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let col = letters
        .chars()
        .fold(0usize, |acc, c| acc * 26 + (c as usize - 'A' as usize + 1))
        - 1;
    let row: usize = digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col))
}

pub(crate) fn is_a1_range(range: &str) -> bool {
    let mut parts = range.splitn(2, ':');
    let first = parts.next().unwrap_or_default();
    match parts.next() {
        Some(second) => parse_a1(first).is_some() && parse_a1(second).is_some(),
        None => parse_a1(first).is_some(),
    }
}

/// Minimal CSV/TSV parser — quoted fields, embedded delimiters and newlines.
pub(crate) fn parse_delim(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' if field.is_empty() => in_quotes = true,
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                c if c == delim => row.push(std::mem::take(&mut field)),
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

pub(crate) fn serialize_delim(rows: &[Vec<String>], delim: char) -> String {
    let mut out = String::new();
    for row in rows {
        let line: Vec<String> = row
            .iter()
            .map(|f| {
                if f.contains(delim) || f.contains('"') || f.contains('\n') {
                    format!("\"{}\"", f.replace('"', "\"\""))
                } else {
                    f.clone()
                }
            })
            .collect();
        out.push_str(&line.join(&delim.to_string()));
        out.push('\n');
    }
    out
}

/// Set one cell (A1 notation) in spreadsheet bytes. Returns the new bytes
/// plus the re-extracted text for the search index. Shared by the agent's
/// set_cells tool and the viewer's grid editing.
pub(crate) fn set_cell_in_bytes(
    name: &str,
    bytes: &[u8],
    sheet: Option<&str>,
    cell: &str,
    value: &str,
) -> Result<(Vec<u8>, Option<String>), String> {
    let cell = cell.trim().to_uppercase();
    let Some((row, col)) = parse_a1(&cell) else {
        return Err(format!("\"{cell}\" is not a cell — use A1 notation like B7."));
    };
    let ext = extraction::extension_of(name);
    match ext.as_str() {
        "csv" | "tsv" => {
            let delim = if ext == "tsv" { '\t' } else { ',' };
            let mut rows = parse_delim(&String::from_utf8_lossy(bytes), delim);
            if rows.len() <= row {
                rows.resize(row + 1, Vec::new());
            }
            if rows[row].len() <= col {
                rows[row].resize(col + 1, String::new());
            }
            rows[row][col] = value.to_string();
            let out = serialize_delim(&rows, delim);
            Ok((out.clone().into_bytes(), Some(out)))
        }
        "xlsx" => {
            let new_bytes = xlsx_set_cell(bytes, sheet, &cell, value)?;
            let text = extraction::extract_text(name, &new_bytes);
            Ok((new_bytes, text))
        }
        _ => Err(format!(
            "\"{name}\" is not an editable spreadsheet — cell editing works on .xlsx and .csv files."
        )),
    }
}

pub(crate) fn xlsx_set_cell(
    bytes: &[u8],
    sheet: Option<&str>,
    cell: &str,
    value: &str,
) -> Result<Vec<u8>, String> {
    let mut book = umya_spreadsheet::reader::xlsx::read_reader(std::io::Cursor::new(bytes), true)
        .map_err(|e| format!("Could not read the spreadsheet: {e}"))?;
    {
        let ws = match sheet {
            Some(name) => book
                .sheet_by_name_mut(name)
                .map_err(|_| format!("No sheet named \"{name}\" in this workbook."))?,
            None => book
                .sheet_mut(0)
                .map_err(|_| "The workbook has no sheets.".to_string())?,
        };
        ws.cell_mut(cell).set_value(value);
    }
    let mut out: Vec<u8> = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut out)
        .map_err(|e| format!("Could not write the spreadsheet: {e}"))?;
    Ok(out)
}

/// Grid editing from the viewer: set one spreadsheet cell and re-index.
#[tauri::command]
pub fn set_cell(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    sheet: Option<String>,
    cell: String,
    value: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (name, bytes) = db::get_file_bytes_named(&room.conn, &id)?;
    let bytes = bytes.ok_or("File has no stored content.")?;
    let (new_bytes, text) = set_cell_in_bytes(&name, &bytes, sheet.as_deref(), &cell, &value)?;
    store_file_bytes(&room.conn, &id, &new_bytes, text.as_deref(), "You edited")?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("file-updated", &id);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a1_notation() {
        assert_eq!(parse_a1("A1"), Some((0, 0)));
        assert_eq!(parse_a1("b7"), Some((6, 1)));
        assert_eq!(parse_a1("AA10"), Some((9, 26)));
        assert_eq!(parse_a1("7B"), None);
        assert_eq!(parse_a1("B0"), None);
        assert_eq!(parse_a1(""), None);
        assert!(is_a1_range("B2:D5"));
        assert!(is_a1_range("B2"));
        assert!(!is_a1_range("B2:"));
        assert!(!is_a1_range("hello"));
    }

    #[test]
    fn csv_round_trip_preserves_quoting() {
        let src = "name,note\nalice,\"hi, there\"\nbob,\"say \"\"hey\"\"\"\n";
        let rows = parse_delim(src, ',');
        assert_eq!(rows[1][1], "hi, there");
        assert_eq!(rows[2][1], "say \"hey\"");
        let out = serialize_delim(&rows, ',');
        assert_eq!(parse_delim(&out, ','), rows);
    }

    #[test]
    fn csv_set_cell_grows_grid() {
        let mut rows = parse_delim("a,b\n1,2\n", ',');
        let (r, c) = parse_a1("D4").unwrap();
        if rows.len() <= r {
            rows.resize(r + 1, Vec::new());
        }
        if rows[r].len() <= c {
            rows[r].resize(c + 1, String::new());
        }
        rows[r][c] = "x".into();
        let out = serialize_delim(&rows, ',');
        assert!(out.lines().nth(3).unwrap().ends_with(",,,x"));
    }

    #[test]
    fn xlsx_set_cell_round_trips() {
        let mut book = umya_spreadsheet::new_file();
        book.sheet_mut(0).unwrap().cell_mut("A1").set_value("hello");
        let mut bytes: Vec<u8> = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();

        let edited = xlsx_set_cell(&bytes, None, "B7", "42").expect("edit xlsx");
        let reread =
            umya_spreadsheet::reader::xlsx::read_reader(std::io::Cursor::new(&edited), true)
                .unwrap();
        let sheet = reread.sheet(0).unwrap();
        assert_eq!(sheet.cell_value("B7").value(), "42");
        assert_eq!(sheet.cell_value("A1").value(), "hello");
        assert!(xlsx_set_cell(&bytes, Some("NoSuchSheet"), "B7", "x").is_err());
    }

}
