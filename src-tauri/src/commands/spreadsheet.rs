use super::*;

/// A spreadsheet's own ceilings: columns run A..XFD (three letters, 16 384) and
/// rows stop at 1 048 576. Enforced BEFORE the accumulator runs — a long run of
/// letters used to multiply its way past `usize`, producing a meaningless index
/// that then took the app down when the grid was resized to reach it.
const MAX_A1_COL_LETTERS: usize = 3;
const MAX_A1_ROW: usize = 1_048_576;

/// "B7" → zero-based (row, col). None when it isn't A1 notation.
pub(crate) fn parse_a1(cell: &str) -> Option<(usize, usize)> {
    let cell = cell.trim().to_uppercase();
    let letters: String = cell.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits = &cell[letters.len()..];
    if letters.is_empty() || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if letters.len() > MAX_A1_COL_LETTERS {
        return None;
    }
    let col = letters
        .chars()
        .fold(0usize, |acc, c| acc * 26 + (c as usize - 'A' as usize + 1))
        - 1;
    // `parse` already refuses a number too large for `usize`; the row ceiling
    // refuses one that merely LOOKS valid but would grow the grid until the
    // app runs out of memory.
    let row: usize = digits.parse().ok()?;
    if row == 0 || row > MAX_A1_ROW {
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

/// One field of a delimited file, plus whether the SOURCE wrote it quoted.
///
/// RFC 4180 quoting is meaning, not decoration: `"=SUM(A1:A2)"` is the literal
/// string `=SUM(A1:A2)`, while the bare spelling is a formula. Dropping the
/// quotes on the way back out — which is what editing any OTHER cell used to
/// do — silently turns a label into a sum, so the flag rides along through an
/// edit and is written back exactly as it was found.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct DelimField {
    pub value: String,
    pub quoted: bool,
}

/// S2 (2026-08-04): the leading characters a spreadsheet reader can take as
/// "this cell is a formula, not text" — this app's own sheet viewer reacts
/// only to `=`, but a CSV exported for real use may be opened in Excel/Sheets/
/// Numbers, whose CSV import heuristics are the OWASP-documented broader set.
/// A value pasted verbatim from a web page (a phone number starting `+`, a
/// negative figure, an email-style handle starting `@`) must not silently
/// become live once it round-trips through set_cells.
const FORMULA_TRIGGER_CHARS: [char; 4] = ['=', '+', '-', '@'];

impl DelimField {
    /// A field being WRITTEN rather than read back. Quoted when the bare
    /// spelling would come back as something else — a leading formula-trigger
    /// character, which some reader (this app's viewer for `=`, or a real
    /// spreadsheet app's CSV import for the rest) would read as a formula.
    fn written(value: &str) -> Self {
        let quoted = value.starts_with(FORMULA_TRIGGER_CHARS);
        Self { value: value.to_string(), quoted }
    }
}

/// Minimal CSV/TSV parser — quoted fields, embedded delimiters and newlines.
pub(crate) fn parse_delim(text: &str, delim: char) -> Vec<Vec<String>> {
    parse_delim_quoted(text, delim)
        .into_iter()
        .map(|row| row.into_iter().map(|f| f.value).collect())
        .collect()
}

/// The same parse, keeping each field's original quoting for a writer.
pub(crate) fn parse_delim_quoted(text: &str, delim: char) -> Vec<Vec<DelimField>> {
    let mut rows = Vec::new();
    let mut row: Vec<DelimField> = Vec::new();
    let mut field = DelimField::default();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.value.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.value.push(c);
            }
        } else {
            match c {
                '"' if field.value.is_empty() => {
                    in_quotes = true;
                    field.quoted = true;
                }
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                c if c == delim => row.push(std::mem::take(&mut field)),
                _ => field.value.push(c),
            }
        }
    }
    if !field.value.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

pub(crate) fn serialize_delim(rows: &[Vec<String>], delim: char) -> String {
    serialize_delim_styled(rows, delim, DelimStyle::default())
}

/// The line-ending conventions of an existing delimited file, so editing one
/// cell doesn't rewrite every other line.
///
/// Re-serializing a CRLF file as LF, or adding a newline the file never had,
/// changes literally every line as far as a colleague or a version-control tool
/// is concerned — for a one-cell edit.
#[derive(Clone, Copy)]
pub(crate) struct DelimStyle {
    newline: &'static str,
    trailing_newline: bool,
}

impl Default for DelimStyle {
    fn default() -> Self {
        Self { newline: "\n", trailing_newline: true }
    }
}

/// Read the conventions off the file we are about to rewrite.
pub(crate) fn delim_style(text: &str) -> DelimStyle {
    DelimStyle {
        newline: if text.contains("\r\n") { "\r\n" } else { "\n" },
        // An empty file gets the usual trailing newline; otherwise match it.
        trailing_newline: text.is_empty() || text.ends_with('\n'),
    }
}

pub(crate) fn serialize_delim_styled(
    rows: &[Vec<String>],
    delim: char,
    style: DelimStyle,
) -> String {
    let fields: Vec<Vec<DelimField>> = rows
        .iter()
        .map(|row| row.iter().map(|f| DelimField::written(f)).collect())
        .collect();
    serialize_fields_styled(&fields, delim, style)
}

/// Quoting a field is not optional when the bare spelling would parse back as
/// something else: an embedded delimiter, quote or newline.
fn must_quote(value: &str, delim: char) -> bool {
    value.contains(delim) || value.contains('"') || value.contains('\n')
}

/// Write rows that came from `parse_delim_quoted`, keeping each field's own
/// quoting. Only the field the caller replaced changes shape.
fn serialize_fields_styled(
    rows: &[Vec<DelimField>],
    delim: char,
    style: DelimStyle,
) -> String {
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            out.push_str(style.newline);
        }
        let line: Vec<String> = row
            .iter()
            .map(|f| {
                if f.quoted || must_quote(&f.value, delim) {
                    format!("\"{}\"", f.value.replace('"', "\"\""))
                } else {
                    f.value.clone()
                }
            })
            .collect();
        out.push_str(&line.join(&delim.to_string()));
    }
    if style.trailing_newline && !rows.is_empty() {
        out.push_str(style.newline);
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
            // Bytes that aren't UTF-8 read back as replacement characters, and
            // writing them out would destroy the file's accented letters for
            // good. Refuse rather than corrupt (Wave: encoding safety).
            let text = std::str::from_utf8(bytes).map_err(|_| non_utf8_error(name))?;
            // Quoting is read along with the values: rewriting a quoted
            // `"=SUM(A1:A2)"` bare would turn a cell of literal text into a
            // formula, in a file the caller only meant to change one cell of.
            let mut rows = parse_delim_quoted(text, delim);
            if rows.len() <= row {
                rows.resize(row + 1, Vec::new());
            }
            if rows[row].len() <= col {
                rows[row].resize(col + 1, DelimField::default());
            }
            rows[row][col] = DelimField::written(value);
            // Keep the file's own line endings and final-newline convention, so
            // a one-cell edit reads as a one-line change everywhere else.
            let out = serialize_fields_styled(&rows, delim, delim_style(text));
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
    state.with_room(|room| {
        let (name, bytes) = db::get_file_bytes_named(&room.conn, &id)?;
        let bytes = bytes.ok_or("File has no stored content.")?;
        let (new_bytes, text) = set_cell_in_bytes(&name, &bytes, sheet.as_deref(), &cell, &value)?;
        store_file_bytes(&room.conn, &id, &new_bytes, text.as_deref(), "You edited")?;
        let _ = window.emit("room-files-changed", ());
        let _ = window.emit("file-updated", &id);
        Ok(())
    })
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
        // Excel's real ceilings: XFD1 is the last column, one more letter is
        // not a cell. It used to overflow the accumulator into a huge index
        // and take the app down instead of being refused.
        assert_eq!(parse_a1("XFD1"), Some((0, 16_383)));
        assert_eq!(parse_a1("AAAA1"), None);
        assert_eq!(parse_a1(&format!("{}1", "A".repeat(200))), None);
        // …and the row ceiling, for a number that parses but can't be a row.
        assert_eq!(parse_a1("A1048576"), Some((1_048_575, 0)));
        assert_eq!(parse_a1("A1048577"), None);
        assert_eq!(parse_a1("A99999999999999999999999"), None);
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
    fn csv_edit_leaves_a_quoted_literal_quoted() {
        // RFC 4180: the quoted field IS the string "=SUM(A1:A2)". Re-writing it
        // bare while editing a different cell handed the next reader a formula
        // — the same defect live QA hit in the grid, arriving by the back door.
        let src = "label,note\ntotal,\"=SUM(A1:A2)\"\n";
        let (bytes, text) = set_cell_in_bytes("t.csv", src.as_bytes(), None, "A2", "sum").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "label,note\nsum,\"=SUM(A1:A2)\"\n");
        assert_eq!(text.unwrap(), "label,note\nsum,\"=SUM(A1:A2)\"\n");

        // An UNQUOTED formula field is left exactly as unquoted as it was:
        // that spelling means "formula" and this edit is not the place to
        // decide otherwise.
        let src = "label,note\ntotal,=SUM(A1:A2)\n";
        let (bytes, _) = set_cell_in_bytes("t.csv", src.as_bytes(), None, "A2", "sum").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "label,note\nsum,=SUM(A1:A2)\n");
    }

    #[test]
    fn a_written_value_that_starts_with_equals_is_stored_as_text() {
        // The writer stores VALUES — the grid editor refuses formulas outright.
        // So a value beginning with "=" is data, and writing it bare would hand
        // it back as a formula nobody asked for.
        let (bytes, _) =
            set_cell_in_bytes("t.csv", b"a,b\n1,2\n", None, "B2", "=SUM(A1:A2)").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "a,b\n1,\"=SUM(A1:A2)\"\n");
        // …and the same rule for a whole file built from values.
        let rows = vec![vec!["label".to_string(), "=SUM(A1:A2)".to_string()]];
        assert_eq!(serialize_delim(&rows, ','), "label,\"=SUM(A1:A2)\"\n");
    }

    #[test]
    fn a_value_starting_with_plus_minus_or_at_is_also_quoted() {
        // S2: `=` is what THIS app's viewer reads as a formula, but a CSV
        // exported for real use can open in Excel/Sheets/Numbers, whose CSV
        // import heuristics react to the fuller OWASP set too — a value
        // pasted verbatim from elsewhere (a phone number, a negative figure,
        // a handle) must not silently become live on round-trip.
        for dangerous in ["+1 555 0100", "-4200000", "@handle"] {
            let quoted = DelimField::written(dangerous);
            assert!(quoted.quoted, "{dangerous:?} should be quoted");
            assert_eq!(quoted.value, dangerous);
        }
        // Ordinary values that merely CONTAIN one of these chars mid-string
        // are untouched — only a LEADING trigger char matters.
        let ordinary = DelimField::written("total = 5");
        assert!(!ordinary.quoted);
    }

    #[test]
    fn parse_delim_reports_which_fields_were_quoted() {
        let rows = parse_delim_quoted("a,\"b, c\"\n\"=X()\",d\n", ',');
        assert_eq!(rows[0][0], DelimField { value: "a".into(), quoted: false });
        assert_eq!(rows[0][1], DelimField { value: "b, c".into(), quoted: true });
        assert_eq!(rows[1][0], DelimField { value: "=X()".into(), quoted: true });
        assert_eq!(rows[1][1], DelimField { value: "d".into(), quoted: false });
        // The plain view is unchanged for every caller that only wants values.
        assert_eq!(parse_delim("a,\"b, c\"\n", ','), vec![vec!["a", "b, c"]]);
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
    fn csv_edit_keeps_the_files_own_line_endings() {
        // A one-cell edit used to convert CRLF to LF and bolt on a final
        // newline, so every line of the file read as changed.
        let crlf = "a,b\r\n1,2";
        let (bytes, _) = set_cell_in_bytes("t.csv", crlf.as_bytes(), None, "B2", "9").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "a,b\r\n1,9");
        // An LF file with a trailing newline keeps both.
        let lf = "a,b\n1,2\n";
        let (bytes, _) = set_cell_in_bytes("t.csv", lf.as_bytes(), None, "B2", "9").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "a,b\n1,9\n");
    }

    #[test]
    fn csv_edit_refuses_non_utf8_bytes_instead_of_mangling_them() {
        // 0xE9 is "é" in latin-1. Read lossily it becomes U+FFFD, and writing
        // that back would destroy the character permanently.
        let latin1 = b"nom,ville\nRen\xE9,Nancy\n";
        let err = set_cell_in_bytes("t.csv", latin1, None, "B2", "Paris").unwrap_err();
        assert!(err.contains("UTF-8"), "got: {err}");
        // Valid UTF-8 with the same character still edits fine.
        let utf8 = "nom,ville\nRené,Nancy\n";
        let (bytes, _) = set_cell_in_bytes("t.csv", utf8.as_bytes(), None, "B2", "Paris").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "nom,ville\nRené,Paris\n");
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
