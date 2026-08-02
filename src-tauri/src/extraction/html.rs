use super::*;

pub fn strip_html(html: &str) -> String {
    let mut s = html.to_string();
    // CHG-28: when the page has a <main> or <article>, keep only that region so
    // the limited tool-result budget is spent on body text, not site chrome.
    for tag in ["<main", "<article"] {
        let lower = ascii_lower(&s);
        if let Some(open) = lower.find(tag) {
            let close = format!("</{}>", &tag[1..]);
            if let Some(rel) = lower.rfind(&close) {
                // A malformed page can put the closing tag before the opening
                // one; slicing backwards would panic, so leave `s` whole.
                if rel >= open {
                    s = s[open..rel + close.len()].to_string();
                    break;
                }
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
        loop {
            let lower = ascii_lower(&s);
            let Some(start) = lower.find(pair.0) else { break };
            match lower[start..].find(pair.1).map(|i| start + i + pair.1.len()) {
                Some(end) => s.replace_range(start..end, ""),
                None => break,
            }
        }
    }
    strip_tags(&s)
}

/// Case-folded copy for locating ASCII tag names, byte-for-byte aligned with
/// the input so an offset found here is a valid offset into the original.
///
/// `str::to_lowercase` is Unicode-aware and NOT length preserving — Turkish
/// `İ` (U+0130, 2 bytes) folds to `i` + U+0307 (3 bytes), shifting every later
/// offset. Applying those offsets to the original string sliced mid-character
/// and panicked the whole window mid-import. Tag names are ASCII, so ASCII
/// folding is both sufficient and safe.
fn ascii_lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survives_length_changing_uppercase() {
        // Regression: `to_lowercase` expands Turkish `İ` (U+0130) from 2 bytes
        // to 3, so every offset past it pointed mid-character in the original.
        let html = "<div>İİİİ</div><main>İstanbul body</main><footer>İ chrome</footer>";
        let out = strip_html(html);
        assert!(out.contains("İstanbul body"), "got {out:?}");
        assert!(!out.contains("chrome"), "footer survived: {out:?}");
    }

    #[test]
    fn malformed_page_with_close_before_open_is_kept_whole() {
        // `</article>` before `<article` used to slice backwards and panic.
        let html = "</article><p>orphan text</p><article>tail";
        let out = strip_html(html);
        assert!(out.contains("orphan text"), "got {out:?}");
        assert!(out.contains("tail"), "got {out:?}");
    }

    #[test]
    fn drops_chrome_elements_case_insensitively() {
        let html = "<BODY><NAV>menu</NAV><p>keep me</p><SCRIPT>var x=1;</SCRIPT></BODY>";
        let out = strip_html(html);
        assert!(out.contains("keep me"), "got {out:?}");
        assert!(!out.contains("menu"), "got {out:?}");
        assert!(!out.contains("var x"), "got {out:?}");
    }
}
