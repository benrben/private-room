use std::io::Read;

mod chunking;
mod docx;
mod html;
mod pdf;
mod pptx;
mod window;
mod xlsx;

pub use chunking::*;
pub use window::*;
pub use docx::*;
pub use html::*;
pub(crate) use pdf::*;
pub(crate) use pptx::*;
pub(crate) use xlsx::*;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yml", "yaml", "toml", "ini",
    "rs", "py", "js", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp", "cs", "go", "rb",
    "php", "swift", "kt", "sh", "zsh", "bash", "sql", "r", "m", "scala", "lua", "pl", "css",
    "scss", "less", "vue", "svelte", "tex", "org", "rst",
];

pub fn extension_of(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn is_image(mime: &str) -> bool {
    mime.starts_with("image/")
}

pub fn is_text_extension(ext: &str) -> bool {
    TEXT_EXTENSIONS.contains(&ext)
}

/// Extract readable text from a file's bytes, best-effort. Returns None for
/// formats we can't read (images, unknown binaries).
pub fn extract_text(name: &str, bytes: &[u8]) -> Option<String> {
    let ext = extension_of(name);
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return Some(String::from_utf8_lossy(bytes).into_owned());
    }
    match ext.as_str() {
        "pdf" => extract_pdf(bytes),
        "docx" => extract_docx(bytes),
        "xlsx" => extract_xlsx(bytes),
        "pptx" => extract_pptx(bytes),
        "html" | "htm" => Some(strip_html(&String::from_utf8_lossy(bytes))),
        _ => None,
    }
    .map(|t| normalize_whitespace(&t))
    .filter(|t| !t.trim().is_empty())
}

/// Hard ceiling on the decompressed size of a single Office zip entry
/// (document.xml, slideN.xml, …). Real Office parts are a few MB at most; a
/// tiny archive that inflates past this is a decompression bomb, not a doc.
const MAX_ZIP_ENTRY_BYTES: u64 = 100 * 1024 * 1024;

pub(crate) fn read_zip_entry(bytes: &[u8], entry: &str) -> Option<String> {
    read_zip_entry_capped(bytes, entry, MAX_ZIP_ENTRY_BYTES)
}

fn read_zip_entry_capped(bytes: &[u8], entry: &str, cap: u64) -> Option<String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let file = archive.by_name(entry).ok()?;
    // Declared sizes can lie, so the `take` below is the real guard; checking
    // the header first just skips the allocation for an honest oversized entry.
    if file.size() > cap {
        return None;
    }
    let mut content = String::new();
    file.take(cap + 1).read_to_string(&mut content).ok()?;
    if content.len() as u64 > cap {
        return None;
    }
    Some(content)
}

/// Universal fallback: Microsoft's MarkItDown CLI converts almost any format
/// (ppt, doc, xls, epub, …) to Markdown. Used only if the user has it
/// installed (`pipx install markitdown`); GUI apps don't inherit a shell
/// PATH, so common install locations are probed explicitly.
pub fn markitdown_extract(path: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "markitdown".to_string(),
        "/opt/homebrew/bin/markitdown".to_string(),
        "/usr/local/bin/markitdown".to_string(),
        format!("{home}/.local/bin/markitdown"),
    ];
    for bin in &candidates {
        match std::process::Command::new(bin).arg(path).output() {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).into_owned();
                if !text.trim().is_empty() {
                    return Some(normalize_whitespace(&text));
                }
            }
            _ => continue,
        }
    }
    None
}

pub(crate) fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_basic_entities(&out)
}

/// Text of an OOXML part, keeping its paragraph structure: the paragraph close
/// tag (`</w:p>` in Word, `</a:p>` in PowerPoint) becomes a newline before the
/// markup is stripped, so paragraphs don't collapse into one run-on line.
pub(crate) fn xml_paras_to_text(xml: &str, para_close: &str) -> String {
    strip_tags(&xml.replace(para_close, &format!("{para_close}\n")))
}

pub(crate) fn decode_basic_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn normalize_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_lines = 0;
    for line in s.lines() {
        let trimmed: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            blank_lines += 1;
            if blank_lines <= 1 {
                out.push('\n');
            }
        } else {
            blank_lines = 0;
            out.push_str(&trimmed);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_zip_entry_refuses_entries_over_cap() {
        // Decompression-bomb guard: an entry whose decompressed size exceeds
        // the cap must yield None instead of ballooning memory.
        let bytes = fake_office_zip("word/document.xml", "0123456789");
        assert_eq!(
            read_zip_entry_capped(&bytes, "word/document.xml", 64).as_deref(),
            Some("0123456789")
        );
        assert!(read_zip_entry_capped(&bytes, "word/document.xml", 9).is_none());
    }
}

/// Shared test helper: build a minimal Office-style zip with a single entry.
#[cfg(test)]
pub(crate) fn fake_office_zip(entry: &str, xml: &str) -> Vec<u8> {
    use std::io::Write;
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(entry, options).unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        writer.finish().unwrap();
    }
    cursor.into_inner()
}
