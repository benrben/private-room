/// Split text into ~target_chars chunks along paragraph boundaries.
pub fn chunk_text(text: &str, target_chars: usize) -> Vec<String> {
    // CRLF first, or nothing below sees a boundary at all: a document written
    // on Windows — an Excel CSV, a Notepad .txt, an .eml body — separates its
    // paragraphs with "\r\n\r\n", so the whole file arrives as ONE paragraph
    // and is cut at arbitrary points with every row and line boundary gone.
    let text: std::borrow::Cow<str> = if text.contains("\r\n") {
        std::borrow::Cow::Owned(text.replace("\r\n", "\n"))
    } else {
        std::borrow::Cow::Borrowed(text)
    };
    let mut chunks = Vec::new();
    let mut current = String::new();
    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if !current.is_empty() && current.len() + para.len() > target_chars {
            chunks.push(std::mem::take(&mut current));
        }
        // A single huge paragraph still needs to be cut somewhere.
        if para.len() > target_chars * 2 {
            for piece in split_by_len(para, target_chars) {
                chunks.push(piece);
            }
        } else {
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(para);
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Cut a paragraph that is bigger than a chunk on its own — LINES first.
///
/// A row of a spreadsheet, a log line, a line of a table is the structure the
/// reader and the model navigate by, and it survives here for the same reason
/// the paragraph split above exists. Only a line that is itself longer than a
/// chunk falls back to words, because at that point there is no structure left
/// to keep.
fn split_by_len(s: &str, target: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.len() > target {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            out.extend(split_words(line, target));
            continue;
        }
        if !current.is_empty() && current.len() + line.len() + 1 > target {
            out.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn split_words(s: &str, target: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for word in s.split_whitespace() {
        if !current.is_empty() && current.len() + word.len() + 1 > target {
            out.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one invariant the search index depends on: chunking is a SPLIT, not
    /// a summary. Every word of the document has to survive, once, in order —
    /// a word dropped here is a sentence that can never be found again, and
    /// nothing downstream would ever notice.
    fn words(s: &str) -> Vec<&str> {
        s.split_whitespace().collect()
    }

    #[test]
    fn chunking_keeps_every_word_in_order() {
        let text = "First paragraph about the lease.\n\n\
                    Second paragraph, a little longer, about the deposit and when it is returned.\n\n\
                    \n\n\
                    Third paragraph.";
        let chunks = chunk_text(text, 60);
        assert!(chunks.len() > 1, "nothing was split at all: {chunks:?}");
        let rejoined: Vec<&str> = chunks.iter().flat_map(|c| words(c)).collect();
        assert_eq!(rejoined, words(text), "the index lost or reordered words");
        assert!(
            chunks.iter().all(|c| !c.trim().is_empty()),
            "an empty chunk is a row in the index that can never match anything",
        );
    }

    /// One wall of text with no paragraph breaks — a scanned PDF, a pasted
    /// transcript — must still be cut. Leaving it whole hands the model (and
    /// the embedder, which truncates) a single chunk the size of the document.
    #[test]
    fn a_single_huge_paragraph_is_still_cut_up() {
        let para = "alpha bravo charlie delta ".repeat(200);
        let chunks = chunk_text(&para, 100);
        assert!(chunks.len() > 1, "a wall of text came back as one chunk");
        // Counted per chunk: joining them back with no separator would glue the
        // last word of one to the first of the next and hide a real loss.
        assert_eq!(chunks.iter().flat_map(|c| words(c)).count(), 800);
        // Cut on word boundaries: a chunk that ends mid-word matches nothing.
        assert!(
            chunks.iter().all(|c| !c.starts_with(' ') && !c.ends_with(' ')),
            "chunks were cut mid-whitespace",
        );
    }

    /// Text that is smaller than one chunk, and text that is nothing at all.
    /// An empty document must produce NO chunks rather than one blank row.
    #[test]
    fn short_and_empty_documents_behave() {
        assert_eq!(chunk_text("just a note", 500), ["just a note"]);
        assert!(chunk_text("", 500).is_empty());
        assert!(chunk_text("\n\n   \n\n", 500).is_empty());
    }

    /// A Windows-authored document has CRLF line endings, so it holds no
    /// "\n\n" at all: it used to be indexed as one wall of space-joined words
    /// with every row and paragraph boundary gone.
    #[test]
    fn a_crlf_document_keeps_its_rows_and_paragraphs() {
        let csv: String = (0..80).map(|i| format!("row{i},alpha,bravo,charlie\r\n")).collect();
        let chunks = chunk_text(&csv, 200);
        assert!(chunks.len() > 1, "a 2KB CSV came back as {} chunk(s)", chunks.len());
        assert!(
            chunks.iter().all(|c| !c.contains('\r')),
            "a carriage return reached the index: {chunks:?}",
        );
        let rows: Vec<&str> = chunks.iter().flat_map(|c| c.lines()).collect();
        assert_eq!(rows.len(), 80, "rows were merged into runs of words: {rows:?}");
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(*row, format!("row{i},alpha,bravo,charlie"), "a row was cut apart");
        }

        let doc = "First paragraph about the lease.\r\n\r\nSecond paragraph about the deposit.";
        assert_eq!(
            chunk_text(doc, 40),
            ["First paragraph about the lease.", "Second paragraph about the deposit."],
        );
    }

    /// Non-ASCII text is the normal case here (Hebrew rooms, accented names).
    /// The size checks count BYTES while the text is measured in characters, so
    /// this is where an off-by-one becomes a panic on a character boundary.
    #[test]
    fn multibyte_text_does_not_split_inside_a_character() {
        let text = "שלום עולם וברוכים הבאים ".repeat(60);
        let chunks = chunk_text(&text, 80);
        assert!(chunks.len() > 1);
        assert_eq!(
            chunks.iter().flat_map(|c| words(c)).count(),
            text.split_whitespace().count(),
        );
    }
}
