"""Tests for `arcelle_sidecar.docs.html` (port of `strip_html` /
`ascii_lower` in `src-tauri/src/extraction/html.rs`).

Mirrors the Rust `#[cfg(test)]` cases verbatim.
"""

from __future__ import annotations

from arcelle_sidecar.docs.html import strip_html


def test_survives_length_changing_uppercase() -> None:
    # Regression: `to_lowercase` expands Turkish `İ` (U+0130) from 2 bytes
    # to 3, so every offset past it pointed mid-character in the original.
    html = "<div>İİİİ</div><main>İstanbul body</main><footer>İ chrome</footer>"
    out = strip_html(html)
    assert "İstanbul body" in out, f"got {out!r}"
    assert "chrome" not in out, f"footer survived: {out!r}"


def test_malformed_page_with_close_before_open_is_kept_whole() -> None:
    # `</article>` before `<article` used to slice backwards and panic.
    html = "</article><p>orphan text</p><article>tail"
    out = strip_html(html)
    assert "orphan text" in out, f"got {out!r}"
    assert "tail" in out, f"got {out!r}"


def test_drops_chrome_elements_case_insensitively() -> None:
    html = "<BODY><NAV>menu</NAV><p>keep me</p><SCRIPT>var x=1;</SCRIPT></BODY>"
    out = strip_html(html)
    assert "keep me" in out, f"got {out!r}"
    assert "menu" not in out, f"got {out!r}"
    assert "var x" not in out, f"got {out!r}"


def test_multiple_length_changing_folds_before_nav_stay_aligned() -> None:
    # Several DIFFERENT characters whose Python str.lower() (Unicode-aware,
    # unlike the ASCII-only fold this module uses) would each grow the
    # string, stacked together before a <nav> block. If offsets were found
    # against a real .lower() copy instead of the ASCII-only one, they would
    # land 3 characters too late in the original string (verified below) --
    # `_ascii_lower` must stay perfectly aligned regardless.
    html = "İİİẞ preamble text <nav>menu junk</nav><p>keep me</p>"
    # Sanity: prove this input actually exercises the claim -- a real
    # Unicode `.lower()` disagrees with the ASCII-only fold on where <nav>
    # starts, so a correct implementation MUST diverge from that naive path.
    assert html.lower().find("<nav") != html.find("<nav")
    out = strip_html(html)
    assert "preamble text" in out, f"got {out!r}"
    assert "keep me" in out, f"got {out!r}"
    assert "menu junk" not in out, f"got {out!r}"


def test_main_without_any_closing_tag_passes_through_unmodified() -> None:
    # "<main" is present but "</main>" does not occur anywhere in the
    # string -- the region-narrowing step must be a no-op (not slice with a
    # not-found/sentinel index), leaving the rest of the pipeline to run on
    # the untouched string.
    html = "<div>before</div><main>body text without a closer<p>keep me</p>"
    out = strip_html(html)
    assert "before" in out, f"got {out!r}"
    assert "body text without a closer" in out, f"got {out!r}"
    assert "keep me" in out, f"got {out!r}"
