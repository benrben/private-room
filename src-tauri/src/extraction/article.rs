//! The readable article inside a web page, and the metadata the page declares
//! about itself.
//!
//! A saved page is worth keeping only if it is the ARTICLE — the body, its
//! headings, lists, images and links — with the site's furniture gone, and only
//! if it still says who wrote it and when. Both halves are here:
//!
//! * [`read_page`] runs Mozilla's Readability scoring (via `dom_smoothie`) over
//!   the page and hands back the article as HTML, as Markdown, and as text.
//! * [`PageMeta`] carries what the page ITSELF declares — `<meta>` tags, the
//!   `article:` and `og:` families, JSON-LD, `<html lang>`. Every field is an
//!   `Option`, and a field the page never declared stays `None`. Nothing here
//!   guesses an author or a date: an invented byline on a saved article is a
//!   lie the room would then repeat forever.
//!
//! The article body is separate from the metadata on purpose: a page with no
//! extractable article still has a title and a source, and a page with no
//! declared author still has a body.

use super::*;
use dom_query::NodeRef;
use dom_smoothie::{Config, Readability, TextMode};

/// What a page says about itself. Serialized into `files.web_meta`, so the
/// field names are the room's, not the extractor crate's.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    /// The page's own title (`og:title`, JSON-LD `headline`, or `<title>`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The declared author. `None` means the page named nobody.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    /// The publication this page belongs to (`og:site_name`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    /// Publication date, exactly as the page wrote it — usually ISO-8601, but
    /// never reformatted here, because a date we reformat is a date we can get
    /// wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    /// The page's own summary (`meta description` / `og:description`). NOT the
    /// first paragraph: a lede lifted out of the body and labelled "summary" is
    /// something the page never said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    /// Language, from `<html lang>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Where it was read from — the room's fact, not the page's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// When the room saved it — also the room's fact.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

impl PageMeta {
    /// True when the page declared nothing beyond what the room already knew.
    pub fn is_undeclared(&self) -> bool {
        self.title.is_none()
            && self.byline.is_none()
            && self.site_name.is_none()
            && self.published.is_none()
            && self.modified.is_none()
            && self.excerpt.is_none()
            && self.lang.is_none()
    }
}

/// The readable article: the same content in the three shapes the room stores
/// it in — HTML for the viewer, Markdown for the file, plain text for search.
pub struct ArticleBody {
    /// Article markup with the site's chrome removed and relative `src`/`href`
    /// resolved against the page URL.
    pub html: String,
    pub markdown: String,
    pub text: String,
}

/// A page read apart: what it declares, and the article inside it.
pub struct PageCapture {
    pub meta: PageMeta,
    /// `None` when there is no article to extract — a search-results page, an
    /// app shell, a page that never loaded. The caller must say so rather than
    /// present the chrome as an article.
    pub article: Option<ArticleBody>,
}

/// Below this, "the article" is a caption or a paywall stub, not a body. The
/// caller falls back to the whole page instead, which at least keeps the words.
const MIN_ARTICLE_CHARS: usize = 140;

/// Read a page's declared metadata and its readable article.
///
/// `url` is the page's own address when it is known: Readability needs it to
/// turn relative `src`/`href` into absolute ones, so the saved copy's images
/// and links still point somewhere. It is never invented — a capture with no
/// URL simply keeps the page's relative references.
pub fn read_page(html: &str, url: Option<&str>) -> PageCapture {
    // Untrusted markup through a third-party parser, so a panic inside it must
    // cost this extraction and nothing else — the same containment
    // `extract_text` puts around every other document reader. The caller then
    // sees "no article", which it already has to handle.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_page_inner(html, url)))
        .unwrap_or_else(|_| PageCapture { meta: PageMeta::default(), article: None })
}

fn read_page_inner(html: &str, url: Option<&str>) -> PageCapture {
    // An absolute URL is a hard requirement of `Readability::new`; a bare or
    // malformed one must cost the URL, not the whole extraction.
    let abs = url.filter(|u| u.starts_with("http://") || u.starts_with("https://"));
    let cfg = Config {
        // The plain-text shape keeps paragraph breaks, which is what the search
        // index and any later model pass want to read.
        text_mode: TextMode::Formatted,
        // The crate's default is 0 — no ceiling at all. Scoring is per-node, so
        // a runaway single-page-app DOM would be paid for in full on the thread
        // that captured it. Far above any real article (a heavy news page is a
        // few thousand elements), and hitting it returns "no article", which
        // the caller already handles honestly.
        max_elements_to_parse: 50_000,
        ..Default::default()
    };
    let Ok(mut r) = Readability::new(html, abs, Some(cfg)) else {
        return PageCapture { meta: PageMeta::default(), article: None };
    };

    // Metadata FIRST: `parse` consumes the document, and a page whose article
    // cannot be scored still declares a title, an author and a date.
    let declared = r.get_article_metadata(r.parse_json_ld());
    let meta = PageMeta {
        title: some_text(&declared.title),
        byline: declared.byline.as_deref().and_then(some_text),
        site_name: declared.site_name.as_deref().and_then(some_text),
        published: declared.published_time.as_deref().and_then(some_text),
        modified: declared.modified_time.as_deref().and_then(some_text),
        excerpt: declared.excerpt.as_deref().and_then(some_text),
        lang: declared.lang.as_deref().and_then(some_text),
        source_url: url.and_then(some_text),
        captured_at: None,
    };

    let article = r.parse().ok().filter(|a| a.length >= MIN_ARTICLE_CHARS).map(|a| {
        let html = strip_event_handlers(&a.content);
        ArticleBody { markdown: html_to_markdown(&html), text: a.text_content.to_string(), html }
    });
    PageCapture { meta, article }
}

/// Drop `on*` attributes from extracted article markup.
///
/// Readability is a CONTENT extractor, not a sanitizer: it removes `<script>`
/// and `<iframe>` elements, and Mozilla says in as many words that its output
/// still has to be sanitized. It leaves inline handlers alone, so
/// `<p onclick="…">` and `<img src=… onerror="…">` come through untouched — and
/// the saved article is written to a room file that opens in `HtmlView`, whose
/// iframe is `sandbox="allow-scripts allow-modals"`. The sandbox denies the
/// page an origin and the network, so this is not a way out of the room; but a
/// stored reading copy has no business running the site's code at all, and the
/// only thing standing between the two was that the extractor happened to
/// delete the `<script>` tags.
fn strip_event_handlers(html: &str) -> String {
    let doc = dom_query::Document::from(html);
    let Some(body) = doc.body() else { return html.to_string() };
    for node in body.descendants().iter() {
        if !node.is_element() {
            continue;
        }
        let handlers: Vec<String> = node
            .attrs()
            .iter()
            .map(|a| a.name.local.to_string())
            .filter(|n| n.len() > 2 && n[..2].eq_ignore_ascii_case("on"))
            .collect();
        if !handlers.is_empty() {
            node.remove_attrs(&handlers.iter().map(String::as_str).collect::<Vec<_>>());
        }
    }
    body.inner_html().to_string()
}

/// [`read_page`] over raw bytes — the shape every fetched or imported page
/// arrives in. The decode is `decode_text_bytes` (BOM → strict UTF-8 →
/// detection), the same one every other text format in the app goes through:
/// a page served as windows-1255 has to become Hebrew BEFORE any tag is looked
/// at, because no HTML pass can recover a character already replaced.
pub fn read_page_bytes(bytes: &[u8], url: Option<&str>) -> PageCapture {
    read_page(&decode_text_bytes(bytes), url)
}

/// A trimmed value, or `None` when the page left the field empty. `Some("")`
/// and `Some("  ")` both mean "not declared" and must not survive as a field
/// the room can print.
fn some_text(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

// ---------------------------------------------------------------------------
// Article markup -> Markdown
// ---------------------------------------------------------------------------

/// Serialize extracted article markup as Markdown — headings, lists, block
/// quotes, code, tables, links and images kept.
///
/// Written here rather than taken from `dom_query::md()` because that
/// serializer escapes `.`, `"`, `(`, `)` and `#` inside ordinary prose. It is
/// correct CommonMark and it renders fine, but the escaped string is ALSO what
/// the search index chunks and what the model reads back out of the file, and
/// `disbelief\.` is not the word the page printed. The browser's own
/// `readMarkdown` (page.js) makes the same choice for the same reason.
pub fn html_to_markdown(html: &str) -> String {
    // A full-document parse, not `Document::fragment`: the fragment sink has no
    // `<body>` to walk, and article markup is a body's worth of content anyway.
    let doc = dom_query::Document::from(html);
    let mut out = String::new();
    if let Some(body) = doc.body() {
        for child in body.children() {
            write_block(&child, &mut out, 0);
        }
    }
    // Blocks each end with their own blank line; collapse the runs that nesting
    // produces so the file does not read as double-spaced.
    let mut text = String::new();
    let mut blanks = 0usize;
    for line in out.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            continue;
        }
        if !text.is_empty() && blanks > 0 {
            text.push_str("\n\n");
        }
        blanks = 0;
        // A line inside a list or a code fence keeps its neighbours: only the
        // blank-run counter above separates blocks.
        text.push_str(line.trim_end());
        text.push('\n');
    }
    text
}

/// Emit one block-level node. `depth` is the list nesting level.
fn write_block(node: &NodeRef, out: &mut String, depth: usize) {
    if node.is_text() {
        let t = collapse(&node.text());
        if !t.is_empty() {
            push_block(out, &t);
        }
        return;
    }
    if !node.is_element() {
        return;
    }
    let name = node.node_name().unwrap_or_default().to_lowercase();
    match name.as_str() {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = name[1..].parse::<usize>().unwrap_or(1);
            let text = inline(node);
            if !text.is_empty() {
                push_block(out, &format!("{} {}", "#".repeat(level), text));
            }
        }
        "p" | "figcaption" => {
            let text = inline(node);
            if !text.is_empty() {
                push_block(out, &text);
            }
        }
        "blockquote" => {
            let mut inner = String::new();
            for child in node.children() {
                write_block(&child, &mut inner, depth);
            }
            let quoted: Vec<String> = inner
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| format!("> {l}"))
                .collect();
            if !quoted.is_empty() {
                push_block(out, &quoted.join("\n"));
            }
        }
        "ul" | "ol" => {
            let ordered = name == "ol";
            let indent = "  ".repeat(depth);
            let mut n = 0usize;
            let mut items = String::new();
            for li in node.children() {
                if li.node_name().unwrap_or_default().to_lowercase() != "li" {
                    continue;
                }
                n += 1;
                let marker = if ordered { format!("{n}. ") } else { "- ".to_string() };
                let text = inline(&li);
                if !text.is_empty() {
                    items.push_str(&format!("{indent}{marker}{text}\n"));
                }
                // A nested list is a block inside the item, not inline text.
                for child in li.children() {
                    let child_name = child.node_name().unwrap_or_default().to_lowercase();
                    if child_name == "ul" || child_name == "ol" {
                        write_block(&child, &mut items, depth + 1);
                    }
                }
            }
            if !items.trim().is_empty() {
                push_block(out, items.trim_end_matches('\n'));
            }
        }
        "pre" => {
            let code = node.text();
            if !code.trim().is_empty() {
                push_block(out, &format!("```\n{}\n```", code.trim_end()));
            }
        }
        "hr" => push_block(out, "---"),
        "table" => {
            let table = write_table(node);
            if !table.is_empty() {
                push_block(out, &table);
            }
        }
        "img" => {
            let text = inline(node);
            if !text.is_empty() {
                push_block(out, &text);
            }
        }
        // Anything else (div, section, article, figure, aside kept by the
        // scorer…) is a container: recurse when it holds blocks, otherwise
        // treat its inline content as one paragraph. Without the second half a
        // `<div>bare text</div>` would vanish.
        _ => {
            if node.children().iter().any(is_block) {
                for child in node.children() {
                    write_block(&child, out, depth);
                }
            } else {
                let text = inline(node);
                if !text.is_empty() {
                    push_block(out, &text);
                }
            }
        }
    }
}

/// Element names that start a block of their own — the test for whether a
/// container should be recursed into or flattened into one paragraph.
fn is_block(node: &NodeRef) -> bool {
    const BLOCKS: &[&str] = &[
        "address", "article", "aside", "blockquote", "div", "dl", "figcaption", "figure",
        "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "ol", "p", "pre",
        "section", "table", "ul",
    ];
    node.is_element()
        && BLOCKS.contains(&node.node_name().unwrap_or_default().to_lowercase().as_str())
}

/// Markdown rows for one table. Headerless tables get an empty header row, so
/// the result is still a table every renderer accepts.
fn write_table(table: &NodeRef) -> String {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for tr in table.descendants().iter() {
        if tr.node_name().unwrap_or_default().to_lowercase() != "tr" {
            continue;
        }
        let cells: Vec<String> = tr
            .children()
            .iter()
            .filter(|c| {
                matches!(c.node_name().unwrap_or_default().to_lowercase().as_str(), "td" | "th")
            })
            .map(|c| inline(c).replace('|', "\\|"))
            .collect();
        if !cells.is_empty() {
            rows.push(cells);
        }
    }
    if rows.is_empty() {
        return String::new();
    }
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        let mut cells = row.clone();
        cells.resize(width, String::new());
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
        if i == 0 {
            out.push_str(&format!("|{}\n", " --- |".repeat(width)));
        }
    }
    out.trim_end().to_string()
}

/// A node's inline content: text with links, images and emphasis kept.
fn inline(node: &NodeRef) -> String {
    let mut out = String::new();
    inline_into(node, &mut out);
    collapse(&out)
}

fn inline_into(node: &NodeRef, out: &mut String) {
    if node.is_text() {
        out.push_str(&node.text());
        return;
    }
    if !node.is_element() {
        return;
    }
    match node.node_name().unwrap_or_default().to_lowercase().as_str() {
        "a" => {
            let text = collapse(&node.text());
            let href = node.attr("href").map(|h| h.to_string()).unwrap_or_default();
            // A link with no text is furniture (an icon, an anchor); a
            // `javascript:` href is not somewhere the reader can go.
            if text.is_empty() {
                return;
            }
            if href.is_empty() || href.starts_with("javascript:") {
                out.push_str(&text);
            } else {
                out.push_str(&format!("[{text}]({href})"));
            }
        }
        "img" => {
            let src = node.attr("src").map(|s| s.to_string()).unwrap_or_default();
            if !src.is_empty() {
                let alt = node.attr("alt").map(|a| collapse(&a)).unwrap_or_default();
                out.push_str(&format!("![{alt}]({src})"));
            }
        }
        "br" => out.push(' '),
        "code" | "kbd" | "samp" => {
            let text = collapse(&node.text());
            if !text.is_empty() {
                out.push_str(&format!("`{text}`"));
            }
        }
        "strong" | "b" => wrap_children(node, out, "**"),
        "em" | "i" => wrap_children(node, out, "*"),
        _ => {
            for child in node.children() {
                inline_into(&child, out);
            }
        }
    }
}

fn wrap_children(node: &NodeRef, out: &mut String, marker: &str) {
    let mut inner = String::new();
    for child in node.children() {
        inline_into(&child, &mut inner);
    }
    let inner = collapse(&inner);
    if inner.is_empty() {
        return;
    }
    out.push_str(marker);
    out.push_str(&inner);
    out.push_str(marker);
}

/// HTML whitespace rules: any run of spaces, tabs and newlines is one space.
fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_block(out: &mut String, block: &str) {
    out.push_str(block);
    out.push_str("\n\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page shaped like the ones this feature exists for: real article body,
    /// wrapped in the site's furniture, with its metadata declared in `<meta>`.
    const NEWS: &str = r#"<!doctype html><html lang="en"><head>
        <title>The Heron Returns — The Marsh Review</title>
        <meta property="og:site_name" content="The Marsh Review">
        <meta name="author" content="Dana Okafor">
        <meta property="article:published_time" content="2026-03-04T09:12:00Z">
        <meta name="description" content="A bird came back.">
        </head><body>
        <nav><a href="/subscribe">Subscribe now</a><a href="/sections">Sections</a></nav>
        <article>
        <h1>The Heron Returns</h1>
        <p>After eleven years of absence the grey heron has come back to the lower marsh, and the wardens who counted its going are counting its return with something close to disbelief.</p>
        <p>The first sighting was on a Tuesday, in poor light, by a volunteer who had been told not to expect anything at all. She wrote it down anyway, because that is what the record demands.</p>
        <h2>What the counts show</h2>
        <p>Three nests, then five, then eleven by the end of the season — a curve nobody on the committee had modelled.</p>
        <figure><img src="/img/heron.jpg" alt="A grey heron in shallow water"><figcaption>The lower marsh in March.</figcaption></figure>
        <p>Read the <a href="/marsh/history">marsh history</a> for the long version.</p>
        <ul><li>Eleven nests counted</li><li>Two ringed adults</li></ul>
        </article>
        <aside class="promo">Sign up for our newsletter! Ten birds you will not believe.</aside>
        <footer>&copy; 2026 The Marsh Review. All rights reserved. Privacy policy.</footer>
        </body></html>"#;

    #[test]
    fn keeps_the_article_and_drops_the_chrome() {
        let cap = read_page(NEWS, Some("https://marshreview.example/heron"));
        let article = cap.article.expect("a news page has an article");
        for kept in [
            "After eleven years of absence",
            "What the counts show",
            "Eleven nests counted",
            "The lower marsh in March",
        ] {
            assert!(article.markdown.contains(kept), "lost {kept:?}: {}", article.markdown);
        }
        for chrome in ["Subscribe now", "Sections", "newsletter", "Privacy policy"] {
            assert!(
                !article.markdown.contains(chrome),
                "kept chrome {chrome:?}: {}",
                article.markdown
            );
            assert!(!article.html.contains(chrome), "kept chrome {chrome:?} in html");
        }
        // Structure survives the round trip, not just the words.
        assert!(article.markdown.contains("## What the counts show"));
        assert!(article.markdown.contains("- Eleven nests counted"));
        // Relative references are resolved against the page, so the saved copy
        // points at something.
        assert!(
            article.markdown.contains("![A grey heron in shallow water](https://marshreview.example/img/heron.jpg)"),
            "{}",
            article.markdown
        );
        assert!(
            article.markdown.contains("[marsh history](https://marshreview.example/marsh/history)"),
            "{}",
            article.markdown
        );
        // And the plain-text copy the index chunks is the article too.
        assert!(article.text.contains("After eleven years"));
        assert!(!article.text.contains("Privacy policy"));
    }

    #[test]
    fn declared_metadata_is_captured() {
        let cap = read_page(NEWS, Some("https://marshreview.example/heron"));
        assert_eq!(cap.meta.byline.as_deref(), Some("Dana Okafor"));
        assert_eq!(cap.meta.published.as_deref(), Some("2026-03-04T09:12:00Z"));
        assert_eq!(cap.meta.site_name.as_deref(), Some("The Marsh Review"));
        assert_eq!(cap.meta.excerpt.as_deref(), Some("A bird came back."));
        assert_eq!(cap.meta.lang.as_deref(), Some("en"));
        assert_eq!(cap.meta.source_url.as_deref(), Some("https://marshreview.example/heron"));
        assert!(cap.meta.title.as_deref().unwrap_or_default().contains("The Heron Returns"));
        assert!(!cap.meta.is_undeclared());
    }

    #[test]
    fn metadata_a_page_never_declared_reads_as_absent() {
        // Same body, no meta tags at all — and an empty `author` meta, which is
        // a page declaring nothing, not a page declaring "".
        let bare = r#"<!doctype html><html><head><title>Plain page</title>
            <meta name="author" content="   "></head><body>
            <nav>menu</nav>
            <div id="content">
            <p>A short page with no author and no date declared anywhere in it, just words enough that the scorer treats this as a real body of text rather than a caption.</p>
            <p>A second paragraph so the candidate has some weight, and the scorer has more than one node to weigh when it decides what the article is.</p>
            </div><footer>footer junk</footer></body></html>"#;
        let cap = read_page(bare, Some("https://example.com/plain"));
        assert_eq!(cap.meta.byline, None, "an empty author meta is not an author");
        assert_eq!(cap.meta.published, None);
        assert_eq!(cap.meta.modified, None);
        assert_eq!(cap.meta.site_name, None);
        assert_eq!(cap.meta.lang, None);
        // Readability's own `Article::excerpt` falls back to the first
        // paragraph. That is the page's PROSE, not its declared summary, and
        // presenting it as one would be the room inventing metadata.
        assert_eq!(cap.meta.excerpt, None);
        // The body is still extracted — missing metadata costs only metadata.
        let article = cap.article.expect("no metadata does not mean no article");
        assert!(article.markdown.contains("A short page with no author"));
        assert!(!article.markdown.contains("footer junk"));
    }

    #[test]
    fn a_page_with_no_article_says_so() {
        // A shell with nothing to read: `article` is None, and the caller has
        // to fall back rather than present chrome as a body.
        let shell = "<html><head><title>Results</title></head><body><nav>a b c</nav>\
                     <div id=\"app\"></div></body></html>";
        let cap = read_page(shell, Some("https://example.com/search?q=x"));
        assert!(cap.article.is_none(), "there is no article on this page");
        assert_eq!(cap.meta.title.as_deref(), Some("Results"));
    }

    #[test]
    fn a_legacy_encoded_page_survives_saving() {
        // A windows-1255 Hebrew page: the bytes are decoded BEFORE any tag is
        // read, so the article and the declared metadata come back as Hebrew
        // rather than as U+FFFD. This is the whole reason the bytes entry point
        // exists instead of callers doing `String::from_utf8_lossy`.
        let page = format!(
            "<html><head><meta charset=\"windows-1255\"><title>{}</title>\
             <meta name=\"author\" content=\"{}\"></head><body><nav>{}</nav><article><p>{}</p>\
             <p>{}</p></article></body></html>",
            "כותרת",
            "דנה",
            "תפריט ניווט",
            "שלום עולם. זהו מאמר בעברית שנשמר מן הדפדפן הפרטי של החדר, והוא ארוך מספיק כדי שהמנוע יזהה אותו כגוף הטקסט.",
            "פסקה שנייה, כדי שיהיה למנוע יותר מצומת אחד לשקול כשהוא מחליט מה הוא המאמר עצמו.",
        );
        let (bytes, _, unmappable) = encoding_rs::WINDOWS_1255.encode(&page);
        assert!(!unmappable, "the fixture must really be windows-1255");
        assert!(std::str::from_utf8(&bytes).is_err(), "…and really not UTF-8");

        let cap = read_page_bytes(&bytes, Some("https://example.co.il/a"));
        assert_eq!(cap.meta.byline.as_deref(), Some("דנה"));
        assert_eq!(cap.meta.title.as_deref(), Some("כותרת"));
        let article = cap.article.expect("the Hebrew body is an article");
        assert!(article.markdown.contains("שלום עולם"), "{}", article.markdown);
        assert!(!article.markdown.contains('\u{fffd}'), "no replacement characters");
        assert!(!article.markdown.contains("תפריט ניווט"), "chrome still dropped");
    }

    #[test]
    fn the_pages_scripts_do_not_come_with_the_article() {
        // The saved HTML copy opens in `HtmlView`, which runs a page's OWN
        // inline JS (network blocked, cross-origin, but it runs). The article
        // that lands in the room must therefore be the prose, not the site's
        // code — pinned here because it is a property of the extractor, and
        // the extractor is a dependency that can be upgraded.
        let page = "<html><body><article>\
            <script>window.__owned = 1;</script>\
            <p onclick=\"steal()\">A body long enough to be scored as the article on this page, \
            with a script tag sitting inside it exactly where a real site would put one.</p>\
            <img src=\"/a.png\" alt=\"a\" onerror=\"alert(1)\" ONLOAD=\"alert(2)\">\
            <p>And a second paragraph, so the scorer has more than one node to weigh \
            when it decides which part of this page the article actually is.</p>\
            <script src=\"/tracker.js\"></script></article></body></html>";
        let article = read_page(page, Some("https://example.com/a")).article.expect("article");
        assert!(!article.html.contains("<script"), "{}", article.html);
        assert!(!article.html.contains("window.__owned"), "{}", article.html);
        assert!(!article.markdown.contains("window.__owned"), "{}", article.markdown);
        // Readability drops <script> ELEMENTS and nothing else — it is an
        // extractor, not a sanitizer, and these three rode straight through it
        // into the file the viewer opens with `allow-scripts`.
        for handler in ["onclick", "onerror", "onload", "steal()", "alert(1)", "alert(2)"] {
            assert!(!article.html.to_lowercase().contains(handler), "{}", article.html);
        }
        // The content those attributes were sitting on is untouched.
        assert!(article.markdown.contains("A body long enough"));
        assert!(article.html.contains("src=\"https://example.com/a.png\""), "{}", article.html);
        assert!(article.html.contains("alt=\"a\""), "{}", article.html);
    }

    #[test]
    fn markdown_keeps_structure() {
        let md = html_to_markdown(
            "<div><h2>Title</h2><p>Some <strong>bold</strong> and <em>soft</em> text with \
             <code>x = 1</code>.</p><blockquote><p>Quoted line</p></blockquote>\
             <ol><li>first</li><li>second</li></ol><pre>fn main() {}</pre>\
             <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>\
             <p><a href=\"https://x.test/\">link</a> and <a href=\"javascript:void(0)\">js</a></p>\
             <hr></div>",
        );
        assert!(md.contains("## Title"), "{md}");
        assert!(md.contains("Some **bold** and *soft* text with `x = 1`."), "{md}");
        assert!(md.contains("> Quoted line"), "{md}");
        assert!(md.contains("1. first") && md.contains("2. second"), "{md}");
        assert!(md.contains("```\nfn main() {}\n```"), "{md}");
        assert!(md.contains("| A | B |") && md.contains("| 1 | 2 |"), "{md}");
        assert!(md.contains("[link](https://x.test/)"), "{md}");
        // A javascript: href goes nowhere, so it stays as plain words.
        assert!(md.contains("js") && !md.contains("javascript:"), "{md}");
        assert!(md.contains("---"), "{md}");
        // Ordinary prose is NOT escaped: this string is what search indexes and
        // what the model reads back.
        assert!(!md.contains('\\'), "prose must not be escaped: {md}");
    }

    #[test]
    fn markdown_keeps_bare_container_text() {
        // A `<div>` with no block children is a paragraph; without that case it
        // used to serialize to nothing at all.
        let md = html_to_markdown("<div>bare words</div><section><div>nested</div></section>");
        assert!(md.contains("bare words"), "{md}");
        assert!(md.contains("nested"), "{md}");
    }
}

