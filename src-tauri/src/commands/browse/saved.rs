//! BROWSE-2 (D21): what "save this page" actually saves.
//!
//! The owner's ruling is that a saved page is a FULL READABLE ARTICLE with its
//! METADATA PRESERVED, and both halves of that were missing:
//!
//! * The Markdown copy was the browser's own `readMarkdown`, which keeps a
//!   page's article only when the page used `<main>`/`<article>` to say where
//!   it was — and the HTML twin was `document.documentElement.outerHTML`, the
//!   entire live DOM. Opened later in the room's sandboxed viewer, with every
//!   network request blocked, that twin is the site's furniture with none of
//!   its stylesheets: nav, cookie bar, share rail, ad slots, unstyled.
//! * The only metadata was two lines of prose at the top of the Markdown
//!   ("Source:", "Saved:"). The page's own author and publication date — which
//!   it declares in `<meta>` and JSON-LD — were thrown away at capture.
//!
//! So the page now goes through [`extraction::read_page`] (Readability
//! scoring), and what lands in the room is:
//!
//! * `Title.md` — the article as Markdown, under a header of the fields the
//!   page actually declared. This is the searchable copy; it carries the chunks.
//! * `Title.html` — the same article as a self-contained, styled document that
//!   renders in the viewer with no network at all.
//! * `files.web_meta` — those same fields as real columns-worth of JSON, so the
//!   metadata is queryable rather than only readable.
//!
//! Nothing here invents a field. A page that declares no author has no author
//! line, no `byline` key, and the viewer's strip shows none — and a page with
//! no extractable article says so in the reply instead of presenting its
//! navigation as a body.

use super::*;
use crate::extraction::PageMeta;

/// Capture the live page (or the user's selection) and save it into the room.
/// Shared by the agent's `browse_save` tool and the toolbar's Save menu (D22,
/// one code path).
pub(crate) async fn capture_and_save(
    app: &tauri::AppHandle,
    what: &str,
) -> Result<String, String> {
    let v = browser::call(app, "capture", serde_json::json!({ "what": what })).await?;
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let html = v.get("html").and_then(|h| h.as_str()).unwrap_or("").to_string();
    // `capture` clips the live DOM at 4 MB of markup (and the text at 800 KB)
    // and says so. Nothing used to read that flag, which was survivable while
    // the HTML twin was only a fidelity copy — but the ARTICLE is now parsed
    // out of exactly that clipped markup, so on a huge page the reader gets a
    // body that stops partway under a sentence that calls it "the readable
    // article". A page we could not capture whole has to say so.
    let clipped = v.get("truncated").and_then(|t| t.as_bool()) == Some(true);
    if text.trim().is_empty() && html.trim().is_empty() {
        return Err("The page returned nothing to save — it may still be loading.".into());
    }

    // A selection is the user's own excerpt, and `capture` sends no markup for
    // one — so there is no article to extract and no metadata to read. A whole
    // page goes through Readability: that scores every node in a DOM which can
    // be four megabytes of single-page-app markup, which is CPU work on the
    // same runtime that is driving the browser's IPC.
    let (meta, article) = if what == "page" && !html.trim().is_empty() {
        let (page_html, page_url) = (html.clone(), url.clone());
        tokio::task::spawn_blocking(move || {
            let cap = extraction::read_page(&page_html, Some(page_url.as_str()));
            (cap.meta, cap.article.map(|a| (a.html, a.markdown)))
        })
        .await
        .map_err(|e| format!("The page could not be read: {e}"))?
    } else {
        (PageMeta::default(), None)
    };

    let saved_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let meta = PageMeta {
        // `document.title` is the page's own title; keep it when Readability
        // found nothing better, and never fall back to the URL here — the URL
        // is a separate field and pretending it is a title loses that.
        title: meta.title.clone().or_else(|| non_empty(&title)),
        source_url: non_empty(&url),
        captured_at: Some(saved_at),
        ..meta
    };

    let state = app.state::<AppState>();
    let (saved_names, room_path) = state.with_room(|room| {
        let saved = db::current_date(&room.conn);
        let display_title = meta.title.clone().unwrap_or_else(|| url.clone());
        let base_title = if what == "selection" {
            format!("{display_title} (selection)")
        } else {
            display_title.clone()
        };
        // Saving the same page twice (a news front page revisited an hour later
        // is the common case) produced a second "Google News.md" sitting beside
        // the first, with no date, domain or run to tell them apart — live QA
        // 2026-08-03 finished with several. Resolve the free name BEFORE the
        // twin is derived from it, so the pair stays name-matched.
        let md_name = db::available_name(&room.conn, &link_file_name(&base_title, &url))?;
        let body = match &article {
            Some((_, markdown)) => markdown.as_str(),
            // No article: the page's own text, whole. Worse than an article and
            // never dressed up as one — see the reply this builds below.
            None => text.as_str(),
        };
        let content = markdown_page(&display_title, &meta, &saved, body);
        let md = db::insert_file_from_url(
            &room.conn,
            &md_name,
            "text/markdown",
            content.as_bytes(),
            Some(&content),
            "web",
            Some(&url),
        )?;
        write_web_meta(&room.conn, &md.id, &meta);
        let mut names = vec![md.name];
        if what == "page" && !html.trim().is_empty() {
            let html_name = db::available_name(
                &room.conn,
                &format!("{}.html", md_name.trim_end_matches(".md")),
            )?;
            let doc = match &article {
                Some((article_html, _)) => article_document(&display_title, &meta, article_html),
                // Nothing was extractable, so the capture itself is all there
                // is. Kept verbatim rather than replaced by a prettier lie.
                None => html.clone(),
            };
            let twin = db::insert_file_from_url(
                &room.conn,
                &html_name,
                "text/html",
                doc.as_bytes(),
                // No chunks of its own: the Markdown copy carries the search
                // text, and indexing both would find the same page twice.
                None,
                "web",
                Some(&url),
            )?;
            write_web_meta(&room.conn, &twin.id, &meta);
            names.push(twin.name);
        }
        Ok((names, room.path.clone()))
    })?;
    // Every other web import (`save_web_markdown`, `import_download`) starts
    // these two after the file lands; this one started neither, so a page saved
    // from the browser was searchable immediately, had no AI description, and
    // sat outside the privacy scan until some unrelated import happened to
    // schedule one.
    schedule_auto_index(app, room_path);
    schedule_privacy_scan(app.clone());
    browser::journal(app, "save", &url, &format!("Saved {}", saved_names.join(" and ")));
    let _ = tauri::Emitter::emit(app, "room-files-changed", ());
    Ok(saved_reply(what, article.is_some(), clipped, &saved_names, &meta))
}

/// Store the page's declared metadata on a saved file. Best-effort: the file is
/// already in the room and losing the strip is not worth losing the page, so a
/// failure here is not turned into a failed save.
fn write_web_meta(conn: &rusqlite::Connection, id: &str, meta: &PageMeta) {
    if let Ok(json) = serde_json::to_string(meta) {
        let _ = db::set_web_meta(conn, id, &json);
    }
}

/// What the reply says — and it may only say what happened.
///
/// "Saved the article" and "saved the page's text" are different claims, and
/// the second is what a page with no extractable article got. The metadata
/// line names the fields that are really on the file, so "author kept" is never
/// said about a page that named no author.
fn saved_reply(
    what: &str,
    has_article: bool,
    clipped: bool,
    names: &[String],
    meta: &PageMeta,
) -> String {
    let subject = match (what, has_article) {
        ("selection", _) => "the selected text",
        (_, true) => "the readable article",
        (_, false) => "this page's text (it has no article to extract)",
    };
    let files = match names {
        [md, html] => format!("\"{md}\" (searchable) and \"{html}\" (formatted)"),
        [only] => format!("\"{only}\""),
        _ => "the room".to_string(),
    };
    let mut out = format!("Saved {subject} as {files}.");
    let kept: Vec<String> = [
        meta.site_name.as_deref().map(|s| s.to_string()),
        meta.byline.as_deref().map(|b| format!("by {b}")),
        meta.published.as_deref().map(|p| format!("published {p}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !kept.is_empty() {
        out.push_str(&format!(" Kept from the page: {}.", kept.join(" · ")));
    }
    if clipped {
        out.push_str(
            " The page was too big to capture whole, so this copy stops partway \
             through it.",
        );
    }
    out
}

/// The Markdown copy: a header of the fields the page declared, then the
/// article. Only declared fields get a line — an absent author is an absent
/// line, not "Author: unknown".
///
/// The fields are a LIST, not bare lines. `MarkdownView` renders with
/// react-markdown + remark-gfm and nothing else: a single newline is a soft
/// break, so `Source: …\nSite: …\nAuthor: …` renders as one run-on paragraph —
/// "Source: https://… Site: The Marsh Review Author: Dana Okafor Published: …".
/// That was survivable when the header was two lines; with six it is the first
/// thing the reader sees, and the packet's requirement is that a saved page
/// READS well in the viewer afterwards.
fn markdown_page(title: &str, meta: &PageMeta, saved_date: &str, body: &str) -> String {
    let mut out = format!("# {title}\n\n");
    let mut field = |label: &str, value: Option<&str>| {
        if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
            out.push_str(&format!("- {label}: {v}\n"));
        }
    };
    field("Source", meta.source_url.as_deref());
    field("Site", meta.site_name.as_deref());
    field("Author", meta.byline.as_deref());
    field("Published", meta.published.as_deref());
    field("Updated", meta.modified.as_deref());
    field("Saved", Some(saved_date));
    out.push('\n');
    out.push_str(body.trim());
    out.push('\n');
    out
}

/// The HTML copy: the article inside the app's own document shell, so it opens
/// in the viewer looking like a page instead of like a stripped one.
///
/// Self-contained on purpose — `DOC_STYLE` is inline and the viewer blocks the
/// network, so the only thing that can fail to load is a remote image, which
/// keeps its `alt` text and its absolute URL either way.
fn article_document(title: &str, meta: &PageMeta, article_html: &str) -> String {
    let mut body = doc_hero(
        meta.site_name.as_deref().unwrap_or_default(),
        title,
        &meta.excerpt.as_deref().map(html_escape).unwrap_or_default(),
    );
    let chips: Vec<String> = [
        meta.byline.as_deref().map(|b| format!("By {b}")),
        meta.published.as_deref().map(|p| format!("Published {p}")),
        meta.modified.as_deref().map(|m| format!("Updated {m}")),
        meta.captured_at.as_deref().map(|c| format!("Saved {c}")),
    ]
    .into_iter()
    .flatten()
    .map(|c| format!("<span class=\"chip\">{}</span>", html_escape(&c)))
    .collect();
    if !chips.is_empty() {
        body.push_str(&format!("<div class=\"chips\">{}</div>\n", chips.join("")));
    }
    if let Some(url) = meta.source_url.as_deref() {
        body.push_str(&format!(
            "<p class=\"note\">Source: <a href=\"{0}\">{0}</a></p>\n",
            html_escape(url)
        ));
    }
    body.push_str("<hr>\n");
    body.push_str(article_html);
    // The page's declared language, honoured. `html_document`'s shell is
    // `<html lang="en">` with no direction at all, so a Hebrew or Arabic
    // article — captured correctly, decoded correctly, `lang` stored correctly
    // in `web_meta` — still opened left-to-right with its punctuation on the
    // wrong side. The direction is derived only from a language the page
    // ACTUALLY declared; a page that declared none is left exactly as it was
    // rather than guessed at.
    let body = match meta.lang.as_deref() {
        Some(lang) => {
            let dir = if is_rtl_lang(lang) { " dir=\"rtl\"" } else { "" };
            format!("<div lang=\"{}\"{dir}>\n{body}</div>\n", html_escape(lang))
        }
        // No declared language, no wrapper: unchanged output for every page
        // that never said what it was written in.
        None => body,
    };
    html_document(title, &body)
}

/// True for the scripts that read right to left, matched on the language
/// SUBTAG only (`he`, `he-IL`, `ar-EG`…). `iw` is the retired code for Hebrew
/// that plenty of pages still declare.
fn is_rtl_lang(lang: &str) -> bool {
    let base = lang
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "ar" | "arc" | "ckb" | "dv" | "fa" | "he" | "iw" | "ku" | "ps" | "sd" | "ug" | "ur" | "yi"
    )
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> PageMeta {
        PageMeta {
            title: Some("The Heron Returns".into()),
            byline: Some("Dana Okafor".into()),
            site_name: Some("The Marsh Review".into()),
            published: Some("2026-03-04T09:12:00Z".into()),
            source_url: Some("https://marshreview.example/heron".into()),
            captured_at: Some("2026-08-03T10:00:00Z".into()),
            ..Default::default()
        }
    }

    #[test]
    fn markdown_header_carries_only_declared_fields() {
        let md = markdown_page("The Heron Returns", &meta(), "2026-08-03", "Body text.");
        assert!(md.starts_with("# The Heron Returns\n"));
        // Every field is its OWN list item. Bare `Source:\nSite:\nAuthor:`
        // lines are a single soft-broken paragraph to react-markdown, so the
        // header rendered as one run-on sentence in the viewer.
        for line in ["- Source: ", "- Site: ", "- Author: ", "- Published: ", "- Saved: "] {
            assert!(md.contains(line), "header collapses to prose, missing {line:?}: {md}");
        }
        assert!(md.contains("Source: https://marshreview.example/heron\n"));
        assert!(md.contains("Site: The Marsh Review\n"));
        assert!(md.contains("Author: Dana Okafor\n"));
        assert!(md.contains("Published: 2026-03-04T09:12:00Z\n"));
        assert!(md.contains("Saved: 2026-08-03\n"));
        assert!(md.ends_with("Body text.\n"));
        // The page declared no modified date, so there is no "Updated" line —
        // not an empty one, and certainly not the published date reused.
        assert!(!md.contains("Updated"));

        // A page that declared nothing gets a header of exactly what the room
        // itself knows, and no invented author or date.
        let bare = PageMeta {
            source_url: Some("https://example.com/p".into()),
            ..Default::default()
        };
        let md = markdown_page("Plain page", &bare, "2026-08-03", "Body.");
        assert!(md.contains("Source: https://example.com/p\n"));
        assert!(md.contains("Saved: 2026-08-03\n"));
        for absent in ["Author", "Published", "Site", "Updated"] {
            assert!(!md.contains(absent), "invented {absent}: {md}");
        }
    }

    #[test]
    fn article_document_is_self_contained_and_shows_the_metadata() {
        let doc = article_document("The Heron Returns", &meta(), "<p>Body text.</p>");
        assert!(doc.starts_with("<!doctype html>"));
        // The viewer blocks the network: every style must be in the file.
        assert!(doc.contains("<style>"));
        assert!(!doc.contains("<link rel=\"stylesheet\""));
        assert!(doc.contains("<h1>The Heron Returns</h1>"));
        assert!(doc.contains("The Marsh Review"));
        assert!(doc.contains("By Dana Okafor"));
        assert!(doc.contains("Published 2026-03-04T09:12:00Z"));
        assert!(doc.contains("Saved 2026-08-03T10:00:00Z"));
        assert!(doc.contains("href=\"https://marshreview.example/heron\""));
        assert!(doc.contains("<p>Body text.</p>"));
        // A field the page never declared draws no chip at all.
        assert!(!doc.contains("Updated"));

        let bare = PageMeta { captured_at: Some("2026-08-03T10:00:00Z".into()), ..Default::default() };
        let doc = article_document("Plain page", &bare, "<p>Body.</p>");
        assert!(!doc.contains("By "), "invented a byline: {doc}");
        assert!(!doc.contains("Published"), "invented a date: {doc}");
        assert!(doc.contains("Saved 2026-08-03T10:00:00Z"), "the room's own fact stays");
    }

    #[test]
    fn a_right_to_left_article_opens_right_to_left() {
        // The shell `html_document` writes is `<html lang="en">` with no
        // direction, so a Hebrew article — decoded correctly, `lang` captured
        // correctly — still opened left-to-right in the viewer.
        let he = PageMeta { lang: Some("he-IL".into()), ..meta() };
        let doc = article_document("כותרת", &he, "<p>שלום</p>");
        assert!(doc.contains("lang=\"he-IL\""), "{doc}");
        assert!(doc.contains("dir=\"rtl\""), "{doc}");

        // A left-to-right page keeps its language and gains no direction.
        let en = PageMeta { lang: Some("en".into()), ..meta() };
        let doc = article_document("T", &en, "<p>ok</p>");
        assert!(doc.contains("lang=\"en\""));
        assert!(!doc.contains("dir=\"rtl\""), "{doc}");

        // A page that declared no language is not guessed at.
        let doc = article_document("T", &meta(), "<p>ok</p>");
        assert!(!doc.contains("dir=\"rtl\""), "{doc}");
        assert!(!doc.contains("<div lang="), "no wrapper for an undeclared language: {doc}");

        assert!(is_rtl_lang("ar") && is_rtl_lang("fa-IR") && is_rtl_lang("iw"));
        assert!(!is_rtl_lang("en-GB") && !is_rtl_lang("") && !is_rtl_lang("hebrewish"));
    }

    #[test]
    fn a_metadata_value_cannot_close_the_document() {
        // Every declared field is page-controlled text. A byline of
        // `</style><script>` must land as characters, not as markup.
        let hostile = PageMeta {
            byline: Some("</span><script>alert(1)</script>".into()),
            site_name: Some("<img src=x onerror=alert(2)>".into()),
            source_url: Some("https://x.test/\"><script>".into()),
            ..Default::default()
        };
        let doc = article_document("T", &hostile, "<p>ok</p>");
        // The characters survive; the MARKUP does not. (`onerror=alert(2)` is
        // still in the file as text — inside an escaped `&lt;img …&gt;`, where
        // it is a word rather than an attribute.)
        assert!(!doc.contains("<script"), "{doc}");
        assert!(!doc.contains("<img src=x"), "{doc}");
        assert!(doc.contains("&lt;script&gt;"));
        assert!(doc.contains("&lt;img src=x onerror=alert(2)&gt;"));
    }

    #[test]
    fn the_reply_says_what_was_actually_saved() {
        let names = vec!["Heron.md".to_string(), "Heron.html".to_string()];
        let said = saved_reply("page", true, false, &names, &meta());
        assert!(said.contains("the readable article"), "{said}");
        assert!(said.contains("\"Heron.md\" (searchable)"), "{said}");
        assert!(said.contains("Kept from the page: The Marsh Review · by Dana Okafor · published 2026-03-04T09:12:00Z."), "{said}");
        assert!(!said.contains("too big"), "a whole capture must not warn: {said}");

        // No article extracted: the reply must NOT claim one.
        let said = saved_reply("page", false, false, &names, &PageMeta::default());
        assert!(said.contains("no article to extract"), "{said}");
        assert!(!said.contains("readable article"), "{said}");
        // And with nothing declared, it claims to have kept nothing.
        assert!(!said.contains("Kept from the page"), "{said}");

        let said =
            saved_reply("selection", false, false, &["Sel.md".to_string()], &PageMeta::default());
        assert!(said.contains("the selected text") && said.contains("\"Sel.md\""), "{said}");
    }

    #[test]
    fn a_page_clipped_at_the_capture_cap_is_not_called_whole() {
        // `capture` stops at 4 MB of markup, and the article is now parsed out
        // of that clipped markup — so on a huge page the body stops partway.
        // Saying "the readable article" and nothing else would be a claim the
        // room cannot support.
        let names = vec!["Big.md".to_string(), "Big.html".to_string()];
        let said = saved_reply("page", true, true, &names, &meta());
        assert!(said.contains("the readable article"), "{said}");
        assert!(said.contains("too big to capture whole"), "{said}");
        assert!(said.contains("stops partway"), "{said}");
    }
}
