/// Split text into ~target_chars chunks along paragraph boundaries.
pub fn chunk_text(text: &str, target_chars: usize) -> Vec<String> {
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

fn split_by_len(s: &str, target: usize) -> Vec<String> {
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
