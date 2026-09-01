"""Tests for `arcelle_sidecar.docs.article` (port of `ArticleBody`/
`PageCapture`/`MIN_ARTICLE_CHARS`/`read_page`/`read_page_inner`/
`strip_event_handlers`/`read_page_bytes`, `src-tauri/src/extraction/
article.rs` lines 74-201).

This is the FINAL, judged merge of two independent candidate ports (see
`article.py`'s module docstring for the full comparison). The four
Readability-scoring-dependent Rust tests are ported here, against the SAME
`NEWS`/bare/shell fixtures the sibling `test_docs_article_meta.py` module
already uses (`article.rs` lines 483-505, 561-570):

* `keeps_the_article_and_drops_the_chrome` -> `test_keeps_the_article_and_drops_the_chrome`
* `a_page_with_no_article_says_so` -> `test_a_page_with_no_article_says_so`
* `a_legacy_encoded_page_survives_saving` -> `test_a_legacy_encoded_page_survives_saving`
* `the_pages_scripts_do_not_come_with_the_article` ->
  `test_the_pages_scripts_do_not_come_with_the_article`

Assertions preserve every ported test's actual INTENT and safety property
(chrome dropped, prose survives, relative refs resolve absolute, a
no-article page returns `None` rather than presenting chrome as a body,
inline event handlers never reach the saved copy) even where
`readability-lxml`'s specific wording/whitespace differs from
`dom_smoothie`'s.

Beyond the ported four, this file also locks in the two concrete defects
found and fixed during the candidate judging (see `article.py`'s
docstring, points 2 and 3): no `<body id="readabilityBody">` bookkeeping
marker ever survives into `article.html`, and a video-embed `<iframe>`
sitting in otherwise-real prose does not survive into the saved copy
either -- both verified failing against the candidate that lacked the
corresponding fix, before this merge.
"""

from __future__ import annotations

from bs4 import BeautifulSoup
import pytest

from arcelle_sidecar.docs import article as article_module
from arcelle_sidecar.docs.article import (
    MIN_ARTICLE_CHARS,
    ArticleBody,
    PageCapture,
    _article_text,
    _strip_event_handlers,
    read_page,
    read_page_bytes,
)
from arcelle_sidecar.docs.article_meta import PageMeta

# A page shaped like the ones this feature exists for: real article body,
# wrapped in the site's furniture, with its metadata declared in `<meta>`
# tags. Ported verbatim from the Rust `NEWS` fixture (lines 485-505 of
# src-tauri/src/extraction/article.rs) -- the same fixture
# test_docs_article_meta.py uses.
NEWS = """<!doctype html><html lang="en"><head>
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
    </body></html>"""


# --------------------------------------------------------------- ported


def test_keeps_the_article_and_drops_the_chrome() -> None:
    cap = read_page(NEWS, "https://marshreview.example/heron")
    assert cap.article is not None, "a news page has an article"
    article = cap.article
    for kept in [
        "After eleven years of absence",
        "What the counts show",
        "Eleven nests counted",
        "The lower marsh in March",
    ]:
        assert kept in article.markdown, f"lost {kept!r}: {article.markdown}"
    for chrome in ["Subscribe now", "Sections", "newsletter", "Privacy policy"]:
        assert chrome not in article.markdown, f"kept chrome {chrome!r}: {article.markdown}"
        assert chrome not in article.html, f"kept chrome {chrome!r} in html: {article.html}"
    # Structure survives the round trip, not just the words.
    assert "## What the counts show" in article.markdown
    assert "- Eleven nests counted" in article.markdown
    # Relative references are resolved against the page, so the saved copy
    # points at something.
    assert (
        "![A grey heron in shallow water](https://marshreview.example/img/heron.jpg)" in article.markdown
    ), article.markdown
    assert "[marsh history](https://marshreview.example/marsh/history)" in article.markdown, article.markdown
    # And the plain-text copy the index chunks is the article too.
    assert "After eleven years" in article.text
    assert "Privacy policy" not in article.text


def test_a_page_with_no_article_says_so() -> None:
    # A shell with nothing to read: `article` is None, and the caller has
    # to fall back rather than present chrome as a body.
    shell = '<html><head><title>Results</title></head><body><nav>a b c</nav><div id="app"></div></body></html>'
    cap = read_page(shell, "https://example.com/search?q=x")
    assert cap.article is None, "there is no article on this page"
    assert cap.meta.title == "Results"


def test_a_legacy_encoded_page_survives_saving() -> None:
    # A windows-1255 Hebrew page: the bytes are decoded BEFORE any tag is
    # read, so the article and the declared metadata come back as Hebrew
    # rather than as replacement characters. This is the whole reason the
    # bytes entry point exists instead of callers doing a raw utf-8-lossy
    # decode. `cp1255` is Python's codec for the same encoding the Rust
    # fixture uses (`encoding_rs::WINDOWS_1255`) -- verified below by
    # round-tripping through `codecs`.
    title = "כותרת"
    author = "דנה"
    nav_text = "תפריט ניווט"
    para1 = "שלום עולם. זהו מאמר בעברית שנשמר מן הדפדפן הפרטי של החדר, והוא ארוך מספיק כדי שהמנוע יזהה אותו כגוף הטקסט."
    para2 = "פסקה שנייה, כדי שיהיה למנוע יותר מצומת אחד לשקול כשהוא מחליט מה הוא המאמר עצמו."
    page = (
        f'<html><head><meta charset="windows-1255"><title>{title}</title>'
        f'<meta name="author" content="{author}"></head><body><nav>{nav_text}</nav>'
        f"<article><p>{para1}</p><p>{para2}</p></article></body></html>"
    )

    encoded = page.encode("cp1255")
    # ...and really not UTF-8.
    try:
        encoded.decode("utf-8")
        raise AssertionError("the fixture must really not be valid UTF-8")
    except UnicodeDecodeError:
        pass
    # The fixture must really round-trip as windows-1255/cp1255.
    assert encoded.decode("cp1255") == page

    cap = read_page_bytes(encoded, "https://example.co.il/a")
    assert cap.meta.byline == author
    assert cap.meta.title == title
    assert cap.article is not None, "the Hebrew body is an article"
    article = cap.article
    assert para1 in article.markdown, article.markdown
    assert "�" not in article.markdown, "no replacement characters"
    assert nav_text not in article.markdown, "chrome still dropped"


def test_the_pages_scripts_do_not_come_with_the_article() -> None:
    # The saved HTML copy opens in a viewer that runs a page's OWN inline JS
    # (network blocked, cross-origin, but it runs). The article that lands
    # in the room must therefore be the prose, not the site's code.
    page = (
        "<html><body><article>"
        "<script>window.__owned = 1;</script>"
        '<p onclick="steal()">A body long enough to be scored as the article on this page, '
        "with a script tag sitting inside it exactly where a real site would put one.</p>"
        '<img src="/a.png" alt="a" onerror="alert(1)" ONLOAD="alert(2)">'
        "<p>And a second paragraph, so the scorer has more than one node to weigh "
        "when it decides which part of this page the article actually is.</p>"
        '<script src="/tracker.js"></script></article></body></html>'
    )
    cap = read_page(page, "https://example.com/a")
    assert cap.article is not None
    article = cap.article
    assert "<script" not in article.html, article.html
    assert "window.__owned" not in article.html, article.html
    assert "window.__owned" not in article.markdown, article.markdown
    for handler in ["onclick", "onerror", "onload", "steal()", "alert(1)", "alert(2)"]:
        assert handler not in article.html.lower(), article.html
    # The content those attributes were sitting on is untouched.
    assert "A body long enough" in article.markdown
    assert 'src="https://example.com/a.png"' in article.html, article.html
    assert 'alt="a"' in article.html, article.html


# --------------------------------------------------------- supplementary


def test_dataclass_shapes() -> None:
    body = ArticleBody(html="<p>x</p>", markdown="x", text="x")
    cap = PageCapture(meta=PageMeta(), article=body)
    assert cap.article is body


def test_min_article_chars_matches_rust_constant() -> None:
    assert MIN_ARTICLE_CHARS == 140


def test_a_short_stub_falls_back_to_no_article() -> None:
    # A caption-length "article" -- real markup, real <article> tag, but
    # under MIN_ARTICLE_CHARS of actual prose. The caller falls back to the
    # whole page rather than presenting a caption as the body.
    page = "<html><body><article><p>Too short to count as a real article body.</p></article></body></html>"
    cap = read_page(page, "https://example.com/stub")
    assert cap.article is None


def test_relative_refs_stay_relative_without_a_url() -> None:
    # No URL known for the capture: relative references must not be
    # invented into absolute ones out of nowhere.
    cap = read_page(NEWS, None)
    assert cap.article is not None
    article = cap.article
    assert "![A grey heron in shallow water](/img/heron.jpg)" in article.markdown, article.markdown
    assert "[marsh history](/marsh/history)" in article.markdown, article.markdown


def test_a_non_absolute_url_costs_only_the_url_not_the_extraction() -> None:
    # A bare/malformed url (not http(s)) must not crash the extraction --
    # it just means relative refs are not resolved, matching the Rust
    # source's `abs` filter.
    cap = read_page(NEWS, "not-a-url")
    assert cap.article is not None
    assert cap.meta.source_url == "not-a-url", "meta still records what the caller said"
    assert "![A grey heron in shallow water](/img/heron.jpg)" in cap.article.markdown


def test_malformed_html_does_not_raise() -> None:
    # A broad exception catch stands in for the Rust source's
    # catch_unwind: whatever a third-party parser does with adversarial
    # input, this function itself never raises.
    cap = read_page("<html><body><article><p>unterminated", "https://example.com/x")
    assert isinstance(cap, PageCapture)


def test_read_page_keeps_declared_metadata_when_readability_rejects_a_real_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingDocument:
        def __init__(self, *_: object, **__: object) -> None:
            raise RuntimeError("readability parser rejected the page")

    monkeypatch.setattr(article_module.readability, "Document", FailingDocument)

    cap = read_page(NEWS, "https://marshreview.example/heron")
    assert cap.article is None
    assert cap.meta.title == "The Heron Returns — The Marsh Review"
    assert cap.meta.byline == "Dana Okafor"
    assert cap.meta.source_url == "https://marshreview.example/heron"


def test_read_page_fails_closed_when_the_metadata_parser_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def failing_metadata_parser(html: str, url: str | None) -> PageMeta:
        assert html == NEWS
        assert url == "https://marshreview.example/heron"
        raise RuntimeError("metadata parser rejected the page")

    monkeypatch.setattr(article_module, "extract_page_meta", failing_metadata_parser)

    cap = read_page(NEWS, "https://marshreview.example/heron")
    assert cap == PageCapture(meta=PageMeta(), article=None)


def test_completely_malformed_input_never_raises() -> None:
    cap = read_page("<<<not html at all >>>", "https://example.com/x")
    assert isinstance(cap, PageCapture)
    assert cap.article is None or isinstance(cap.article, ArticleBody)


def test_empty_input_returns_no_article() -> None:
    cap = read_page("", None)
    assert cap.article is None
    assert cap.meta.is_undeclared()


# ------------------------------------------------ judge-found regressions


def test_no_readability_bookkeeping_marker_leaks_into_the_article() -> None:
    # readability-lxml marks the document's own <body> with
    # id="readabilityBody" before scoring. When <body> (or, after chrome
    # pruning, the sole remaining top-level element) ends up as the winning
    # candidate, that marker's wrapper can appear verbatim in
    # Document.summary()'s output. It must never survive into the room's
    # saved article HTML -- confirmed to leak through the candidate that
    # lacked the unwrap fix, on this exact fixture.
    page = (
        "<html><body>"
        "<nav>menu</nav>"
        "<article><h1>A plain article</h1>"
        "<p>A single real paragraph, long enough on its own to be scored as "
        "the article body on this otherwise very plain page with nothing "
        "else around it to compete with for the scorer's attention.</p>"
        "</article>"
        "<footer>footer junk</footer>"
        "</body></html>"
    )
    cap = read_page(page, "https://example.com/plain")
    assert cap.article is not None
    assert "readabilityBody" not in cap.article.html, cap.article.html
    assert "<body" not in cap.article.html.lower(), cap.article.html


def test_a_video_embed_iframe_does_not_survive_into_the_article() -> None:
    # readability-lxml's own sanitizer special-cases an <iframe> whose src
    # looks like a video embed: instead of dropping it like every other
    # iframe, it KEEPS the element (replacing only its text with the
    # literal string "VIDEO"), src attribute intact. A saved article
    # carrying a live third-party <iframe src=...> into a same-origin-
    # scripts viewer means that URL gets a real network request every time
    # the page is reopened for reading -- outside any browsing context the
    # user chose. This must not survive, matching the Rust source's own
    # stated guarantee that the extractor "removes <script> and <iframe>
    # elements." Confirmed to survive through the candidate that pruned
    # only nav/footer/aside, on this exact fixture.
    page = (
        "<html><body><article>"
        "<h1>A post with an embed</h1>"
        "<p>Here is a video I liked, embedded right in the middle of the "
        "post so you can watch it without leaving, which is exactly why I "
        "am linking it here in the first place.</p>"
        '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>'
        "<p>And after the video, a second real paragraph so the scorer has "
        "enough text to treat this whole thing as an article.</p>"
        "</article></body></html>"
    )
    cap = read_page(page, "https://example.com/post")
    assert cap.article is not None
    assert "<iframe" not in cap.article.html.lower(), cap.article.html
    assert "youtube.com" not in cap.article.html, cap.article.html
    # The real prose around the embed is untouched.
    assert "Here is a video I liked" in cap.article.markdown
    assert "second real paragraph" in cap.article.markdown


def test_a_form_and_a_noscript_block_do_not_survive_into_the_article() -> None:
    # A comment form and a <noscript> fallback sitting directly in the
    # winning candidate's content: neither is the article, and a
    # <noscript> block's inert markup would otherwise be walked as if it
    # were ordinary prose by this module's own text/markdown tree-walks.
    page = (
        "<html><body><article>"
        "<h1>A post with widgets</h1>"
        "<p>A first real paragraph of prose, long enough on its own to give "
        "the scorer something substantial to weigh as the article here.</p>"
        '<form action="/comment"><textarea name="c"></textarea><button>Post comment</button></form>'
        "<noscript>Enable JavaScript to see extra content.</noscript>"
        "<p>And a second real paragraph, so the scorer has more than one "
        "node of substance to weigh when deciding what the article is.</p>"
        "</article></body></html>"
    )
    cap = read_page(page, "https://example.com/widgets")
    assert cap.article is not None
    assert "<form" not in cap.article.html.lower(), cap.article.html
    assert "<noscript" not in cap.article.html.lower(), cap.article.html
    assert "Enable JavaScript" not in cap.article.markdown
    assert "Enable JavaScript" not in cap.article.text


def test_article_text_preserves_block_boundaries_without_inline_or_chrome_noise() -> None:
    # The text copy feeds search indexing, so nested block elements each
    # need their own paragraph while inline markup remains within its
    # surrounding prose. This calls the tree walk directly to cover the
    # branches that a readability-selected article shape need not expose.
    html = """
    <article>
      Introductory prose before the nested blocks.
      <div>
        <p>One paragraph with an <a href="/detail">inline link</a>.</p>
        <script>window.tracker = true</script>
        <style>.hidden { display: none; }</style>
        <ul><li>First listed fact</li><li>Second listed fact</li></ul>
      </div>
      <!-- A comment is never article prose. -->
      <span>Trailing inline prose.</span>
    </article>
    """

    assert _article_text(html) == (
        "Introductory prose before the nested blocks.\n\n"
        "One paragraph with an inline link .\n\n"
        "First listed fact\n\n"
        "Second listed fact\n\n"
        "Trailing inline prose."
    )


# -------------------------------------------- adversarial: _strip_event_handlers
#
# IMPORTANT CONTEXT for why these call `_strip_event_handlers` DIRECTLY rather
# than only through `read_page`: verified empirically (by temporarily replacing
# the function's body with `return html` and re-running the full suite) that
# EVERY existing end-to-end test above still passes with `_strip_event_handlers`
# reduced to a no-op. `readability.Document.summary()` already strips `on*`
# attributes itself first, via `lxml_html_clean.Cleaner(javascript=True)`'s own
# `aname.startswith('on')` pass (readability-lxml's `Cleaner` is constructed
# with `safe_attrs_only=False`, which is what makes that pass actually run --
# confirmed by reading `readability/cleaners.py`), on every one of this file's
# fixtures. So the end-to-end tests genuinely exercise the SAFETY PROPERTY
# ("no handler reaches the saved copy") but do not, on their own, prove
# `_strip_event_handlers` ITSELF does anything -- the module's own docstring
# says this pass "runs unconditionally regardless of what the vendor library
# already did" and is meant to be "an explicit, tested, independent guarantee
# that does not depend on which of the vendor's two mechanisms is doing the
# work this month" (readability-lxml, or a future replacement of it, could
# start relying on `safe_attrs_only=True` -- at which point the upstream pass
# would stop covering this at all). These tests call the function in
# isolation, on markup readability has never touched, so a regression to a
# no-op fails HERE regardless of what the vendor library still happens to do.


def test_strip_event_handlers_removes_mixed_case_handlers() -> None:
    # HTML attribute names are case-insensitive and both `html.parser` (used
    # here) and lxml's HTML parser (used upstream by readability) lowercase
    # them during parsing -- so "mixed case" survives only up to the parse,
    # never into the attribute dict either implementation inspects. Still
    # worth asserting directly: this is exactly the kind of "works by
    # accident of case" claim that should be checked, not assumed.
    html = '<p OnMouseOver="steal()" ONBLUR="steal2()" oNcLiCk="steal3()">real text</p>'
    out = _strip_event_handlers(html)
    assert "onmouseover" not in out.lower(), out
    assert "onblur" not in out.lower(), out
    assert "onclick" not in out.lower(), out
    assert "steal" not in out, out
    assert "real text" in out, out


def test_strip_event_handlers_removes_a_namespaced_looking_attribute() -> None:
    # `on:click` (the Vue/Alpine/Svelte directive shape) is not a bare
    # "onclick" attribute name, but it still starts with the two characters
    # "on" -- and both the Rust source (`n[..2].eq_ignore_ascii_case("on")`)
    # and this port key on exactly that prefix, deliberately not on an
    # allowlist of known event names, so this is stripped too. That is
    # correct: a framework directive attribute is still "the page's own code
    # attached to this element" and has no more business surviving into a
    # same-origin-scripts viewer than a bare `onclick` does.
    html = '<button on:click="doThing()" data-role="cta">Subscribe</button>'
    out = _strip_event_handlers(html)
    assert "on:click" not in out, out
    assert "doThing" not in out, out
    # Everything else on the element is untouched.
    assert 'data-role="cta"' in out, out
    assert "Subscribe" in out, out


def test_strip_event_handlers_leaves_a_two_character_on_attribute_alone() -> None:
    # Matches the Rust `n.len() > 2` check exactly: a hypothetical bare
    # two-character "on" attribute (no real HTML attribute is named this)
    # is deliberately NOT touched, only strictly-longer "on"-prefixed names
    # are. Documents the boundary rather than assuming it.
    html = '<div on="x" onn="y">body</div>'
    out = _strip_event_handlers(html)
    assert 'on="x"' in out, out
    assert "onn" not in out, out  # length 3, over the boundary, still stripped
    assert "body" in out, out


def test_strip_event_handlers_has_no_realistic_false_positive() -> None:
    # The task this test exists to answer: is there a LEGITIMATE HTML
    # attribute that merely starts with "on" as a coincidence of English,
    # which this safety pass would wrongly strip? Checked against the
    # standard global attribute set, every attribute of the elements the
    # room actually saves articles from (headings, p, a, img, figure, list,
    # table, blockquote, video/audio, meter, ol), and the ARIA/data-*
    # families: NONE of them start with "on" except the event-handler
    # attributes themselves (`onclick`, `onload`, `onerror`, ...) and the
    # rarer SMIL ones (`onbegin`/`onend`/`onrepeat`), which ARE handlers.
    # `data-*` and `aria-*` attributes never collide because they start
    # with "data-"/"aria-", not "on". So there is no known real false
    # positive to guard against today.
    #
    # A genuinely custom, non-standard attribute NAME that happens to start
    # with "on" (e.g. a hypothetical `online` boolean flag on a custom
    # element) WOULD still be stripped by this pass -- demonstrated below,
    # not glossed over. That is intentional over-inclusion, not a bug: it is
    # bit-for-bit what the Rust source's own identical prefix-only check
    # does (`n.len() > 2 && starts_with("on")`, no allowlist there either),
    # and for a safety-critical pass like this one, refusing to guess which
    # "on"-prefixed names are "really" handlers is the correct call --  a
    # false positive costs one custom attribute; a false negative costs a
    # live `onclick` reaching the saved copy.
    html = '<user-badge online data-online="true" aria-live="polite">Ben</user-badge>'
    out = _strip_event_handlers(html)
    # Parse the result rather than substring-match: "online" is also a
    # substring of the perfectly legitimate `data-online`, so a naive
    # `"online" not in out` check would be fooled by the very attribute this
    # test exists to prove survives.
    tag = BeautifulSoup(out, "html.parser").find("user-badge")
    assert tag is not None, out
    assert "online" not in tag.attrs, out  # the custom "on"-prefixed attribute: stripped (matches Rust)
    assert tag.attrs.get("data-online") == "true", out  # NOT "on"-prefixed: untouched
    assert tag.attrs.get("aria-live") == "polite", out  # NOT "on"-prefixed: untouched
    assert "Ben" in out, out


def test_strip_event_handlers_is_not_inert() -> None:
    # A direct regression guard for the exact failure mode found while
    # writing the tests above: temporarily replacing this function's body
    # with `return html` left every OTHER test in this file green, because
    # readability-lxml's own Cleaner already strips these attributes before
    # `_strip_event_handlers` ever runs on the fixtures used elsewhere in
    # this file (see the section docstring above). This test's input never
    # goes near `readability.Document` at all, so it fails on a no-op
    # regression regardless of what the vendor library does.
    html = '<img src="/a.png" onerror="alert(1)">'
    out = _strip_event_handlers(html)
    assert "onerror" not in out, out
    assert out != html, "a no-op implementation must not pass this test"


# --------------------------------- adversarial: no url means relative stays relative


def test_no_url_leaves_the_image_tag_itself_intact_not_just_the_markdown() -> None:
    # `test_relative_refs_stay_relative_without_a_url` above already checks
    # the markdown; this checks the underlying article HTML directly, so a
    # bug that silently dropped the `<img>`/`<a>` element entirely (rather
    # than merely leaving its `src`/`href` relative) would be caught even if
    # it happened to still produce non-crashing markdown output.
    cap = read_page(NEWS, None)
    assert cap.article is not None
    assert 'src="/img/heron.jpg"' in cap.article.html, cap.article.html
    assert 'href="/marsh/history"' in cap.article.html, cap.article.html
    # And no base was ever invented out of a missing URL (e.g. a stray
    # "None/img/heron.jpg" from a careless `f"{url}{src}"` join).
    assert "None" not in cap.article.html, cap.article.html


def test_read_page_bytes_with_no_url_does_not_crash_and_stays_relative() -> None:
    # The bytes entry point, with url=None, all the way through decode ->
    # chrome-pruning -> readability -> unwrap -> strip -> markdown/text --
    # confirms the no-url path holds end to end, not just at `read_page`.
    cap = read_page_bytes(NEWS.encode("utf-8"), None)
    assert cap.article is not None
    assert "![A grey heron in shallow water](/img/heron.jpg)" in cap.article.markdown
    assert "[marsh history](/marsh/history)" in cap.article.markdown
