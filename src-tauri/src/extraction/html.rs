use super::*;

pub fn strip_html(html: &str) -> String {
    let mut s = html.to_string();
    // CHG-28: when the page has a <main> or <article>, keep only that region so
    // the limited tool-result budget is spent on body text, not site chrome.
    for tag in ["<main", "<article"] {
        let lower = s.to_lowercase();
        if let Some(open) = lower.find(tag) {
            let close = format!("</{}>", &tag[1..]);
            if let Some(rel) = lower.rfind(&close) {
                s = s[open..rel + close.len()].to_string();
                break;
            }
        }
    }
    for tag in ["</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</tr>", "<br>", "<br/>", "<br />"] {
        s = s.replace(tag, &format!("{tag}\n"));
    }
    // CHG-28: drop non-content element bodies (nav, chrome, forms, inline SVG)
    // in addition to scripts/styles, so their link text and boilerplate don't
    // crowd out the article.
    for pair in [
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<nav", "</nav>"),
        ("<header", "</header>"),
        ("<footer", "</footer>"),
        ("<aside", "</aside>"),
        ("<form", "</form>"),
        ("<noscript", "</noscript>"),
        ("<svg", "</svg>"),
    ] {
        while let Some(start) = s.to_lowercase().find(pair.0) {
            let lower = s.to_lowercase();
            let end = lower[start..].find(pair.1).map(|i| start + i + pair.1.len());
            match end {
                Some(end) => s.replace_range(start..end, ""),
                None => break,
            }
        }
    }
    strip_tags(&s)
}
