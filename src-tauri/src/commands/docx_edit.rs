use super::*;

/// Rewrite a Word file from edited text, paragraph by paragraph.
///
/// THE GAP THIS CLOSES: the AI could already edit a `.docx` in place —
/// `edit_file` has a run-split OOXML matcher that rewrites `word/document.xml`
/// while preserving every style, table and image. The USER could not. The Edit
/// button on a Word file offered "Edit as text", which edited the EXTRACTED
/// text and saved a separate `.md` copy, leaving the original untouched. The
/// person who owns the document had strictly less power over it than the model
/// working on their behalf.
///
/// The rewrite is per-paragraph on purpose. Replacing `word/document.xml`
/// wholesale from plain text would throw away everything that makes it a Word
/// file. Instead the paragraphs of the stored text are lined up against the
/// paragraphs of the edited text, and only the ones that actually differ are
/// pushed through the SAME matcher `edit_file` uses. An untouched paragraph is
/// not rewritten at all, so its runs, fonts and fields survive byte for byte.
///
/// Adding or removing paragraphs is refused rather than guessed at: with no
/// anchor to hang a new `<w:p>` on, "insert here" is not a question the text
/// alone can answer, and quietly dropping the change would be worse than
/// saying so.
#[tauri::command]
pub fn update_docx_text(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<FileMeta, String> {
    let meta = state.with_room(|room| {
        let (name, _mime, bytes, extracted) = db::get_file_full(&room.conn, &id)?;
        let bytes = bytes.unwrap_or_default();
        if extraction::extension_of(&name) != "docx" {
            return Err(format!("\"{name}\" is not a Word document."));
        }
        let before = extracted.ok_or_else(|| {
            format!("\"{name}\" has no readable text, so there is nothing to edit.")
        })?;
        let patched = apply_paragraph_edits(&bytes, &before, &content)?;
        // The new searchable text is re-derived from the PATCHED FILE, never
        // taken from the editor's buffer: the two can legitimately differ (the
        // reader shows headers, footnotes and comments, which live in parts
        // this rewrite doesn't touch), and storing the buffer would quietly
        // delete them from the index.
        let text = extraction::extract_text(&name, &patched);
        store_file_bytes(&room.conn, &id, &patched, text.as_deref(), "You edited the document")?;
        db::get_file_meta(&room.conn, &id)
    })?;
    use tauri::Emitter;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

/// Paragraphs, as the reader sees them: non-empty lines, trimmed of the
/// trailing whitespace an editor adds.
fn paragraphs(text: &str) -> Vec<&str> {
    text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect()
}

/// The core, split out so it is testable without a room.
pub(crate) fn apply_paragraph_edits(
    bytes: &[u8],
    before: &str,
    after: &str,
) -> Result<Vec<u8>, String> {
    let old_paras = paragraphs(before);
    let new_paras = paragraphs(after);
    if old_paras.len() != new_paras.len() {
        return Err(format!(
            "This editor can change the wording of a Word file's paragraphs, but not add or \
             remove them — the document has {} and the edited text has {}. Undo the added or \
             deleted line, or use \"Save as a copy\" to keep this version as a separate note.",
            old_paras.len(),
            new_paras.len()
        ));
    }
    let mut patched = bytes.to_vec();
    let mut changed = 0usize;
    for (old, new) in old_paras.iter().zip(new_paras.iter()) {
        if old == new {
            continue;
        }
        // The extracted text of a header, a footnote or a comment reaches the
        // editor too, but only `word/document.xml` is rewritten — so a
        // paragraph that lives elsewhere simply won't match. Say which one
        // rather than reporting a bare failure.
        let (next, count) = extraction::docx_replace_text(&patched, old, new).map_err(|e| {
            format!(
                "One paragraph could not be written back into the Word file, so nothing was \
                 saved. This happens when the changed line comes from a header, a footer, a \
                 footnote or a comment — those are shown in the reader but live outside the \
                 document body. Paragraph: \"{}\"\n\n{e}",
                snippet(old)
            )
        })?;
        // A paragraph repeated verbatim elsewhere in the document would be
        // rewritten in both places. Refuse instead of silently changing a line
        // the user never looked at.
        if count > 1 {
            return Err(format!(
                "\"{}\" appears {count} times in this document, so saving would change all of \
                 them. Edit it in a way that makes the line unique, or use \"Save as a copy\".",
                snippet(old)
            ));
        }
        patched = next;
        changed += 1;
    }
    if changed == 0 {
        return Err("Nothing changed.".into());
    }
    Ok(patched)
}

fn snippet(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= 60 {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(60).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extraction::fake_office_zip;

    fn doc(paras: &[&str]) -> Vec<u8> {
        let body: String =
            paras.iter().map(|p| format!("<w:p><w:r><w:t>{p}</w:t></w:r></w:p>")).collect();
        fake_office_zip("word/document.xml", &format!("<w:document>{body}</w:document>"))
    }

    #[test]
    fn one_edited_paragraph_is_written_back_and_the_rest_untouched() {
        let bytes = doc(&["The fee is 5%.", "Payable monthly.", "Signed in Tel Aviv."]);
        let before = crate::extraction::extract_text("c.docx", &bytes).unwrap();
        let after = before.replace("The fee is 5%.", "The fee is 7%.");
        let patched = apply_paragraph_edits(&bytes, &before, &after).expect("edit refused");
        let text = crate::extraction::extract_text("c.docx", &patched).unwrap();
        assert!(text.contains("The fee is 7%."), "the edit did not land: {text}");
        assert!(text.contains("Payable monthly."), "an untouched paragraph was lost");
        assert!(text.contains("Signed in Tel Aviv."), "an untouched paragraph was lost");
        assert!(!text.contains("5%"), "the old wording survived: {text}");
    }

    #[test]
    fn several_paragraphs_can_change_in_one_save() {
        let bytes = doc(&["Alpha", "Beta", "Gamma"]);
        let before = crate::extraction::extract_text("c.docx", &bytes).unwrap();
        let after = before.replace("Alpha", "Alpha!").replace("Gamma", "Gamma!");
        let patched = apply_paragraph_edits(&bytes, &before, &after).unwrap();
        let text = crate::extraction::extract_text("c.docx", &patched).unwrap();
        assert!(text.contains("Alpha!") && text.contains("Gamma!"), "{text}");
        assert!(text.contains("Beta"), "the middle paragraph was disturbed: {text}");
    }

    #[test]
    fn adding_or_removing_a_paragraph_is_refused_in_plain_language() {
        let bytes = doc(&["One", "Two"]);
        let before = crate::extraction::extract_text("c.docx", &bytes).unwrap();
        let err = apply_paragraph_edits(&bytes, &before, &format!("{before}\nThree"))
            .expect_err("adding a paragraph should be refused");
        assert!(err.contains("not add or remove"), "unhelpful message: {err}");
        // …and the count is named, so the person can find what they added.
        assert!(err.contains('2') && err.contains('3'), "counts missing: {err}");
    }

    #[test]
    fn a_paragraph_repeated_verbatim_is_refused_rather_than_changed_twice() {
        // Editing one of two identical lines would silently rewrite BOTH — the
        // classic destructive find-and-replace.
        let bytes = doc(&["Confidential", "Body text", "Confidential"]);
        let before = crate::extraction::extract_text("c.docx", &bytes).unwrap();
        let after = before.replacen("Confidential", "Public", 1);
        let err = apply_paragraph_edits(&bytes, &before, &after)
            .expect_err("an ambiguous rewrite should be refused");
        assert!(err.contains("appears 2 times"), "unhelpful message: {err}");
        // Nothing was written: the caller only stores what this returns.
    }

    #[test]
    fn an_unchanged_save_is_not_treated_as_an_edit() {
        let bytes = doc(&["Same", "Same again"]);
        let before = crate::extraction::extract_text("c.docx", &bytes).unwrap();
        let err = apply_paragraph_edits(&bytes, &before, &before).expect_err("no-op accepted");
        assert_eq!(err, "Nothing changed.");
    }

    #[test]
    fn trailing_whitespace_and_blank_lines_are_not_edits() {
        // An editor adds a trailing newline on save; that must not be read as
        // "a paragraph was added".
        let bytes = doc(&["Alpha", "Beta"]);
        let before = crate::extraction::extract_text("c.docx", &bytes).unwrap();
        let after = format!("{}   \n\n", before.replace("Beta", "Beta!"));
        let patched = apply_paragraph_edits(&bytes, &before, &after).unwrap();
        let text = crate::extraction::extract_text("c.docx", &patched).unwrap();
        assert!(text.contains("Beta!"), "{text}");
    }
}
