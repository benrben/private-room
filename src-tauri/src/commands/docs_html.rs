use super::*;

mod minutes;
pub(crate) use minutes::*;

/// The mime a generated file gets from its name. `create_note` and
/// `save_and_open` must agree on it, so it lives in one place.
pub(crate) fn note_mime(name: &str) -> String {
    mime_guess::from_path(name)
        .first_or(mime_guess::mime::TEXT_PLAIN)
        .essence_str()
        .to_string()
}

/// Save a generated text file into the room (Markdown by default). Reused by
/// several commands. Emits nothing — the caller decides what to open/announce.
pub(crate) fn create_note(conn: &Connection, name: &str, content: &str) -> Result<FileMeta, String> {
    let name = if extraction::extension_of(name).is_empty() {
        format!("{name}.md")
    } else {
        name.to_string()
    };
    db::insert_file(conn, &name, &note_mime(&name), content.as_bytes(), Some(content), "generated")
}

// ---- Wave 1b (idea 10): the canonical shared scratch pad -------------------

/// The one canonical, per-room working-notes file — a convention layer over
/// ordinary `files` rows (versioning, editing, and the agent's write tools all
/// apply unchanged). Follows the `SUMMARY_FILE_NAME` pattern (summarize.rs).
pub(crate) const SCRATCH_PAD_NAME: &str = "Scratch pad.md";
/// Body a fresh pad starts with.
pub(crate) const SCRATCH_PAD_TEMPLATE: &str = "# Scratch pad\n\nShared working notes. \
    You or the AI can rewrite this file at any time; every change is kept in History.\n";

/// True when an agent-supplied file name means THE scratch pad: the exact stem
/// (any case), bare or with `.md`. Other extensions stay ordinary files, so a
/// deliberate "Scratch pad.html" is never hijacked.
pub(crate) fn is_scratch_pad_name(name: &str) -> bool {
    let ext = extraction::extension_of(name);
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
    stem.trim().eq_ignore_ascii_case("scratch pad") && (ext.is_empty() || ext == "md")
}

/// Get-or-create the room's scratch pad. Exact-name lookup first — newest
/// match, ANY source, so a user-made pad is adopted rather than duplicated —
/// else a fresh pad is created from the template.
pub(crate) fn ensure_scratch_pad(conn: &Connection) -> Result<FileMeta, String> {
    if let Some(meta) = db::file_by_exact_name(conn, SCRATCH_PAD_NAME)? {
        return Ok(meta);
    }
    create_note(conn, SCRATCH_PAD_NAME, SCRATCH_PAD_TEMPLATE)
}

/// Wave 1b (idea 10): the sidebar chip's entry point. Returns the pad's meta
/// only — the frontend opens it in the viewer itself.
#[tauri::command]
pub fn open_scratch_pad(state: State<'_, AppState>) -> Result<FileMeta, String> {
    state.with_room(|room| ensure_scratch_pad(&room.conn))
}

/// Save a file a generator just produced and put it in front of the user: insert
/// it, tell the Files list to reload, then tell the viewer to open it. Every
/// generator (studios, AI actions, #add-file, #extract) ends this way, and the
/// two events must both fire — the file appears in the sidebar AND jumps into
/// the viewer. Taking the room lock only for the insert keeps it off the await
/// paths the callers run on.
pub(crate) fn save_and_open(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    name: &str,
    mime: &str,
    content: &str,
    source: &str,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let meta = state.with_room(|room| {
        db::insert_file(&room.conn, name, mime, content.as_bytes(), Some(content), source)
    })?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(meta)
}

// ---- HTML-first output (the app defaults generated documents to HTML) ----

/// Escape text for safe literal inclusion in HTML.
pub(crate) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// True if the model already returned a whole HTML page, so we don't double-wrap.
pub(crate) fn is_full_html_doc(s: &str) -> bool {
    let low = s.trim_start().to_lowercase();
    low.starts_with("<!doctype") || low.starts_with("<html")
}

/// Wrap body markup in a clean, self-contained HTML document with inline styling.
/// It renders in the app's sandboxed, network-blocked HtmlView, so it is safe to
/// store and open. Everything draws from the shared `DOC_STYLE` design system, so
/// bare model-authored markup (h2/p/ul/table…) looks as polished as the built-in
/// templates. If `body` is already a full page, it is returned unchanged.
pub(crate) fn html_document(title: &str, body: &str) -> String {
    if is_full_html_doc(body) {
        return body.to_string();
    }
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n{}\n</head>\n<body>\n<main class=\"doc\">\n{}\n</main>\n\
         <footer class=\"doc-foot\">Arcelle · generated on this Mac</footer>\n\
         </body>\n</html>\n",
        html_escape(title),
        DOC_STYLE,
        body.trim()
    )
}

/// ADD-22 (refined): the shared design system every generated document and
/// template draws from — an editorial, theme-aware stylesheet (serif display
/// titles, an accent-violet echoing the app, cards, chips, a timeline, tidy
/// tables). Light/dark are both first-class; `html` gets an explicit background
/// so the sandboxed viewer's white iframe backdrop never shows through as
/// white-on-white in dark mode. Everything is inline — the viewer blocks the
/// network, so there are no external fonts, styles, or images.
pub(crate) const DOC_STYLE: &str = r#"<style>
:root{
  color-scheme:light dark;
  --bg:#f6f7f9; --surface:#ffffff; --surface-2:#eef0f4; --card:#eef0f4;
  --fg:#191b1f; --muted:#63697a; --faint:#9aa0b0;
  --accent:#6d5cf0; --accent-2:#8b7cf6; --accent-soft:rgba(109,92,240,.10);
  --border:#e6e7ee; --line:#e3e4ec; --ok:#12a150;
  --radius:14px;
  --shadow:0 1px 2px rgba(24,24,60,.05),0 12px 30px rgba(24,24,60,.06);
  --serif:ui-serif,"New York",Georgia,"Times New Roman",serif;
  --sans:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1014; --surface:#161a22; --surface-2:#1c212c; --card:#1c212c;
    --fg:#e8eaf0; --muted:#8b93a7; --faint:#626b7d;
    --accent:#8b7cf6; --accent-2:#a99df8; --accent-soft:rgba(139,124,246,.16);
    --border:#232a37; --line:#2a3140; --ok:#4cc38a;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 14px 36px rgba(0,0,0,.36);
  }
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.doc{max-width:52rem;margin:0 auto;padding:3.25rem 1.5rem 1rem}
h1,h2,h3{color:var(--fg);line-height:1.2}
h1{font-family:var(--serif);font-weight:600;font-size:2.5rem;letter-spacing:-.021em;margin:.15em 0 .35em}
h2{font-size:1.32rem;font-weight:650;letter-spacing:-.01em;margin:2.5rem 0 .9rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
h2 .count{font:600 .72rem/1 var(--sans);letter-spacing:0;color:var(--muted);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:.2rem .5rem;vertical-align:.14em;margin-left:.55rem}
h3{font-size:1.06rem;font-weight:650;margin:1.6rem 0 .5rem}
p{margin:.7rem 0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
strong{font-weight:650}
hr{border:0;height:1px;background:linear-gradient(90deg,var(--border),transparent);margin:2rem 0}
.note{color:var(--muted);font-size:.9rem;margin-top:.6rem}
.hero{margin:0 0 2.2rem}
.eyebrow{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.55rem}
.hero h1{margin:.05rem 0 .35rem}
.hero .sub{color:var(--muted);font-size:1.01rem;margin:.15rem 0 0}
.hero .rule{height:3px;width:66px;border-radius:3px;background:linear-gradient(90deg,var(--accent),var(--accent-2));margin-top:1.15rem}
.lead-wrap{background:var(--accent-soft);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);padding:1.05rem 1.25rem;margin:.4rem 0 0}
.lead{font-size:1.14rem;line-height:1.62;margin:0}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0 0}
.chip{display:inline-flex;align-items:center;gap:.4rem;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:.22rem .72rem;font-size:.83rem}
.chip::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent)}
.files{list-style:none;margin:.4rem 0 0;padding:0;display:grid;gap:.5rem}
.files li{display:flex;gap:.75rem;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.7rem .85rem;box-shadow:var(--shadow)}
.files .ic{flex:none;width:2rem;height:2rem;border-radius:9px;background:var(--accent-soft);display:grid;place-items:center;font-size:1.05rem;line-height:1}
.files .nm{font-weight:600}
.files .ds{color:var(--muted);font-size:.92rem;margin-top:.12rem}
.asks{list-style:none;counter-reset:a;display:grid;gap:.55rem;margin:.4rem 0 0;padding:0}
.asks li{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.78rem .95rem .78rem 3rem;box-shadow:var(--shadow)}
.asks li::before{counter-increment:a;content:counter(a);position:absolute;left:.85rem;top:.72rem;width:1.55rem;height:1.55rem;border-radius:8px;background:var(--accent);color:#fff;font-size:.82rem;font-weight:700;display:grid;place-items:center}
.tl{list-style:none;padding:0;margin:1rem 0 0;position:relative}
.tl::before{content:'';position:absolute;left:8px;top:8px;bottom:14px;width:2px;background:var(--line)}
.tl li{position:relative;padding:0 0 1.6rem 2.15rem}
.tl li:last-child{padding-bottom:.2rem}
.tl li::before{content:'';position:absolute;left:2px;top:5px;width:14px;height:14px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--bg),0 0 0 5px var(--border)}
.tl .time{font-size:.71rem;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);font-weight:700}
.tl .topic{font-weight:650;font-size:1.02rem;margin:.12rem 0 .18rem}
.tl .summary{margin:0;color:var(--muted)}
.checks{list-style:none;padding:0;margin:.4rem 0 0;display:grid;gap:.45rem}
.checks li{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.6rem .85rem .6rem 2.2rem}
.checks li::before{content:'\2713';position:absolute;left:.8rem;top:.58rem;color:var(--ok);font-weight:800}
table{border-collapse:separate;border-spacing:0;width:100%;margin:.6rem 0 0;border:1px solid var(--border);border-radius:12px;overflow:hidden}
th,td{padding:.6rem .82rem;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
tr:first-child th,thead th{background:var(--surface-2);font-size:.73rem;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:700}
table tr:last-child td{border-bottom:0}
table tr:nth-child(even) td{background:var(--surface-2)}
.actions td:first-child{white-space:nowrap;color:var(--muted);font-weight:600;width:1%}
code{background:var(--surface-2);border-radius:5px;padding:.1em .36em;font-size:.9em;font-family:var(--mono)}
pre{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:1rem;overflow-x:auto}
pre code{background:none;padding:0}
blockquote{margin:1rem 0;padding:.4rem 0 .4rem 1.1rem;border-left:3px solid var(--accent);color:var(--muted)}
ul,ol{padding-left:1.3rem}
li{margin:.28rem 0}
img{max-width:100%;border-radius:10px}
.doc-foot{max-width:52rem;margin:2.5rem auto 0;padding:1.2rem 1.5rem 2.5rem;border-top:1px solid var(--border);color:var(--faint);font-size:.8rem;text-align:center}
@media (max-width:640px){.doc{padding:2.2rem 1.15rem 1rem}h1{font-size:2rem}}
</style>"#;

/// A polished document header: an uppercase accent eyebrow, a large serif title,
/// an optional muted subline, and an accent rule. `sub_html` is inserted as-is,
/// so callers pass already-escaped content.
pub(crate) fn doc_hero(eyebrow: &str, title: &str, sub_html: &str) -> String {
    let mut h = String::from("<header class=\"hero\">\n");
    if !eyebrow.is_empty() {
        h.push_str(&format!("<div class=\"eyebrow\">{}</div>\n", html_escape(eyebrow)));
    }
    h.push_str(&format!("<h1>{}</h1>\n", html_escape(title)));
    if !sub_html.trim().is_empty() {
        h.push_str(&format!("<p class=\"sub\">{sub_html}</p>\n"));
    }
    h.push_str("<div class=\"rule\"></div>\n</header>\n");
    h
}

/// An emoji glyph for a file, chosen by extension, so each row of the summary's
/// file list reads at a glance.
pub(crate) fn file_glyph(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "📕",
        "csv" | "tsv" | "xls" | "xlsx" | "numbers" => "📊",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "heic" | "tiff" => "🖼️",
        "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg" | "aiff" => "🎧",
        "mp4" | "mov" | "mkv" | "webm" | "avi" => "🎬",
        "html" | "htm" => "🌐",
        "md" | "markdown" | "txt" | "rtf" => "📝",
        "json" | "yaml" | "yml" | "toml" | "xml" => "🗂️",
        "zip" | "tar" | "gz" | "7z" => "🗜️",
        "doc" | "docx" | "pages" => "📘",
        "ppt" | "pptx" | "key" => "📽️",
        _ => "📄",
    }
}

/// The display title for a generated document, derived from its file name with
/// the extension dropped: "Q3 report.html" -> "Q3 report".
pub(crate) fn title_from_name(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

/// Wrap a model-authored document body into a full page, giving it a serif title
/// header derived from `title` — unless the model already returned a whole HTML
/// page, in which case it passes through untouched (no double header/wrap).
pub(crate) fn html_titled_doc(name: &str, title: &str, body: &str) -> String {
    if is_full_html_doc(body) {
        html_document(name, body)
    } else {
        html_document(name, &format!("{}{}", doc_hero("", title, ""), body))
    }
}

/// Pinned-file text as context, plus the file names, under a shared char budget.
pub(crate) fn refs_context(conn: &Connection, refs: &[String], budget: usize) -> (String, Vec<String>) {
    let mut ctx = String::new();
    let mut names = Vec::new();
    let mut used = 0usize;
    for id in refs {
        if let Ok((name, _mime, _bytes, text)) = db::get_file_full(conn, id) {
            names.push(name.clone());
            if let Some(t) = text {
                let room = budget.saturating_sub(used).min(6000);
                if room < 200 {
                    continue;
                }
                let take = clamp_bytes(t, room);
                used += take.len();
                ctx.push_str(&format!("[file: {name}]\n{take}\n\n"));
            }
        }
    }
    (ctx, names)
}

/// Derive a filename from a topic — first few words, path-safe, .md.
pub(crate) fn name_from_topic(topic: &str) -> String {
    let words: Vec<&str> = topic.split_whitespace().take(8).collect();
    let base: String = words
        .join(" ")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { ' ' })
        .collect();
    let base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    let base = if base.is_empty() { "Note".to_string() } else { base };
    format!("{base}.md")
}

/// ADD-22: a topic-derived file name with an `.html` extension (generated
/// documents default to HTML).
pub(crate) fn html_note_name(topic: &str) -> String {
    let md = name_from_topic(topic);
    format!("{}.html", md.strip_suffix(".md").unwrap_or(&md))
}

// MIGRATION Phase 3: `parse_string_list` (the JSON-array-or-prose list parser used
// by #add-file's enumeration) moved into the sidecar's /knowledge_extract mode:list,
// which returns the finished `items`. It's gone from Rust.

/// Extract the LAST markdown table in `text` as rows of cells (header first).
/// "Last" so #to-sheet, scanning conversation history, picks the most recent
/// answer's table. Returns None when there is no `|`-delimited table with data.
pub(crate) fn extract_md_table(text: &str) -> Option<Vec<Vec<String>>> {
    let mut last: Option<Vec<Vec<String>>> = None;
    let mut cur: Vec<Vec<String>> = Vec::new();
    let flush = |cur: &mut Vec<Vec<String>>, last: &mut Option<Vec<Vec<String>>>| {
        if cur.len() >= 2 {
            *last = Some(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for line in text.lines() {
        let t = line.trim();
        if !t.contains('|') {
            flush(&mut cur, &mut last);
            continue;
        }
        // A separator row like |---|---| carries no data.
        if t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
            continue;
        }
        let cells: Vec<String> = t
            .trim_matches('|')
            .split('|')
            .map(|c| c.trim().to_string())
            .collect();
        cur.push(cells);
    }
    flush(&mut cur, &mut last);
    last
}

// ADD-22 (HTML-first): generated documents default to HTML. MIGRATION Phase 3: the
// DOC_SYS system prompt moved with #add-file's body generation into the sidecar's
// /generate_doc, which owns the prompt now, so it no longer lives here.

// ---- individual commands ----


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_md_table_parses_and_skips_separator() {
        let md = "intro\n\n| Name | Age |\n|------|-----|\n| Ann | 30 |\n| Bob | 25 |\n\nafter";
        let rows = extract_md_table(md).unwrap();
        assert_eq!(rows.len(), 3); // header + 2 data rows (separator dropped)
        assert_eq!(rows[0], vec!["Name", "Age"]);
        assert_eq!(rows[2], vec!["Bob", "25"]);
        // No table → None.
        assert!(extract_md_table("just prose, no pipes").is_none());
        // With two tables, the LAST one wins (most recent answer).
        let two = "| A |\n|---|\n| 1 |\n\ntext\n\n| Z |\n|---|\n| 9 |";
        let last = extract_md_table(two).unwrap();
        assert_eq!(last[0], vec!["Z"]);
    }

    #[test]
    fn name_from_topic_is_path_safe() {
        assert_eq!(name_from_topic("Q3 revenue: AAPL/MSFT!"), "Q3 revenue AAPL MSFT.md");
        assert_eq!(name_from_topic(""), "Note.md");
    }

    #[test]
    fn html_document_wraps_and_escapes() {
        let doc = html_document("Report", "<h2>Hi</h2>");
        assert!(doc.starts_with("<!doctype html>"));
        assert!(doc.contains("<title>Report</title>"));
        assert!(doc.contains("<h2>Hi</h2>"));
        // A full page passes through unchanged (no double-wrap).
        let full = "<!doctype html><html><body>x</body></html>";
        assert_eq!(html_document("t", full), full);
        assert_eq!(html_escape("a<b>&\"c"), "a&lt;b&gt;&amp;&quot;c");
    }

    #[test]
    fn html_note_name_defaults_to_html() {
        assert_eq!(html_note_name("Q3 report"), "Q3 report.html");
        assert_eq!(html_note_name(""), "Note.html");
    }

    #[test]
    fn doc_helpers_render() {
        assert_eq!(title_from_name("Q3 report.html"), "Q3 report");
        assert_eq!(title_from_name("notes"), "notes");
        assert_eq!(file_glyph("chart.pdf"), "📕");
        assert_eq!(file_glyph("clip.m4a"), "🎧");
        assert_eq!(file_glyph("mystery.zzz"), "📄");
        // A model body gets a serif title header prepended…
        let doc = html_titled_doc("Apple.html", "Apple", "<p>Hi</p>");
        assert!(doc.contains("<h1>Apple</h1>") && doc.contains("<p>Hi</p>"));
        // …but a full page the model already returned passes through untouched.
        let full = "<!doctype html><html><body>x</body></html>";
        assert_eq!(html_titled_doc("f.html", "F", full), full);
        // Hero with an eyebrow and a subline.
        let h = doc_hero("Room summary", "My Room", "Generated on 2026-07-06");
        assert!(h.contains("class=\"eyebrow\"") && h.contains("My Room"));
        assert!(h.contains("class=\"rule\""));
    }

    // ---- Section D: pure command tests --------------------------------------

    #[test]
    fn scratch_pad_get_or_create_is_idempotent() {
        let conn = db::mem();
        let first = ensure_scratch_pad(&conn).unwrap();
        assert_eq!(first.name, SCRATCH_PAD_NAME);
        let second = ensure_scratch_pad(&conn).unwrap();
        assert_eq!(first.id, second.id, "two calls must resolve to ONE pad");
        // Exactly one pad row exists.
        let pads = db::list_files(&conn)
            .unwrap()
            .into_iter()
            .filter(|f| f.name == SCRATCH_PAD_NAME)
            .count();
        assert_eq!(pads, 1);
    }

    #[test]
    fn scratch_pad_adopts_user_file() {
        let conn = db::mem();
        // A user-uploaded pad (any source) is adopted, never duplicated.
        let user = db::insert_file(
            &conn,
            SCRATCH_PAD_NAME,
            "text/markdown",
            b"my own notes",
            Some("my own notes"),
            "upload",
        )
        .unwrap();
        let got = ensure_scratch_pad(&conn).unwrap();
        assert_eq!(got.id, user.id);
    }

    #[test]
    fn scratch_pad_name_matcher_covers_variants_only() {
        // The create_file redirect fires for the pad's stem, bare or .md…
        assert!(is_scratch_pad_name("Scratch pad.md"));
        assert!(is_scratch_pad_name("scratch pad"));
        assert!(is_scratch_pad_name("SCRATCH PAD.MD"));
        // …but never for other extensions or other names.
        assert!(!is_scratch_pad_name("Scratch pad.html"));
        assert!(!is_scratch_pad_name("Scratch pads.md"));
        assert!(!is_scratch_pad_name("notes.md"));
    }
}
