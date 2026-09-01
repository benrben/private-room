"""Tests for `arcelle_sidecar.docs.article_meta` (port of the `PageMeta`
struct/`is_undeclared` and the metadata-focused Rust tests in
`src-tauri/src/extraction/article.rs`).

`test_declared_metadata_is_captured` and
`test_metadata_a_page_never_declared_reads_as_absent` are direct ports of the
Rust `declared_metadata_is_captured` and
`metadata_a_page_never_declared_reads_as_absent` tests, renamed to this
module's narrower scope (metadata only -- no article-body extraction exists
on this side of the port) but preserving every individual assertion,
against the same NEWS/bare fixtures (`article.rs` lines 485-505, 564-570).

The remaining tests are supplementary coverage for the metadata cascade this
module hand-implements in place of `dom_smoothie`'s (JSON-LD precedence
including `@graph`, multi-author joining, the og:/twitter:/tag title
fallback chain, the description/og:description fallback, and the
`_some_text` blank-reads-as-absent rule) -- none of these are ported from
Rust, since the Rust source delegates this logic to the crate entirely.
"""

from __future__ import annotations

from typing import cast

from bs4 import Tag

from arcelle_sidecar.docs.article_meta import (
    PageMeta,
    _first_article_like,
    _parsed_json_ld,
    extract_page_meta,
)

# A page shaped like the ones this feature exists for: real article body,
# wrapped in the site's furniture, with its metadata declared in `<meta>`
# tags. Ported verbatim from the Rust `NEWS` fixture (lines 485-505 of
# src-tauri/src/extraction/article.rs).
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

# Same body, no meta tags at all -- and an empty `author` meta, which is a
# page declaring nothing, not a page declaring "". Ported verbatim from the
# Rust `bare` local (lines 564-570).
BARE = """<!doctype html><html><head><title>Plain page</title>
    <meta name="author" content="   "></head><body>
    <nav>menu</nav>
    <div id="content">
    <p>A short page with no author and no date declared anywhere in it, just words enough that the scorer treats this as a real body of text rather than a caption.</p>
    <p>A second paragraph so the candidate has some weight, and the scorer has more than one node to weigh when it decides what the article is.</p>
    </div><footer>footer junk</footer></body></html>"""


# --------------------------------------------------------------- ported


def test_declared_metadata_is_captured() -> None:
    meta = extract_page_meta(NEWS, "https://marshreview.example/heron")
    assert meta.byline == "Dana Okafor"
    assert meta.published == "2026-03-04T09:12:00Z"
    assert meta.site_name == "The Marsh Review"
    assert meta.excerpt == "A bird came back."
    assert meta.lang == "en"
    assert meta.source_url == "https://marshreview.example/heron"
    assert meta.title is not None and "The Heron Returns" in meta.title
    assert not meta.is_undeclared()


def test_metadata_a_page_never_declared_reads_as_absent() -> None:
    meta = extract_page_meta(BARE, "https://example.com/plain")
    assert meta.byline is None, "an empty author meta is not an author"
    assert meta.published is None
    assert meta.modified is None
    assert meta.site_name is None
    assert meta.lang is None
    # No first-paragraph fallback exists for excerpt, even though the page
    # has real paragraph text -- see the module docstring.
    assert meta.excerpt is None


# --------------------------------------------------------- supplementary


def test_is_undeclared_ignores_source_url_and_captured_at() -> None:
    meta = PageMeta(source_url="https://example.com/x", captured_at="2026-08-22T00:00:00Z")
    assert meta.is_undeclared(), "source_url/captured_at are the room's facts, not the page's"


def test_is_undeclared_false_when_any_declared_field_is_set() -> None:
    assert not PageMeta(title="Something").is_undeclared()


def test_json_ld_headline_and_author_take_precedence_over_meta_tags() -> None:
    html = """<html lang="en"><head>
    <script type="application/ld+json">
    {"@type": "NewsArticle", "headline": "JSON-LD Headline",
     "author": [{"@type": "Person", "name": "Ada Lovelace"}, {"@type": "Person", "name": "Grace Hopper"}],
     "datePublished": "2026-01-02", "dateModified": "2026-01-03"}
    </script>
    <meta property="og:title" content="OG Title">
    <meta name="author" content="Someone Else">
    <title>Fallback Title</title>
    </head><body><p>body</p></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.title == "JSON-LD Headline"
    assert meta.byline == "Ada Lovelace, Grace Hopper"
    assert meta.published == "2026-01-02"
    assert meta.modified == "2026-01-03"


def test_json_ld_author_as_plain_string() -> None:
    html = """<html><head>
    <script type="application/ld+json">{"headline": "H", "author": "Plain Name"}</script>
    </head><body></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.byline == "Plain Name"


def test_json_ld_graph_picks_the_article_shaped_node() -> None:
    html = """<html><head><script type="application/ld+json">
        {"@graph": [
            {"@type": "WebSite", "name": "Not This"},
            {"@type": "NewsArticle", "headline": "Graph Headline", "datePublished": "2026-01-02"}
        ]}
        </script></head><body></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.title == "Graph Headline"
    assert meta.published == "2026-01-02"


def test_json_ld_node_selection_falls_back_from_article_shape_to_type_then_object() -> None:
    typed = {"@type": "WebPage"}
    plain: dict[str, object] = {}

    assert _first_article_like([42, plain, typed]) is typed
    assert _first_article_like([42, plain]) is plain
    assert _first_article_like([42]) is None


def test_malformed_json_ld_is_treated_as_absent_not_raised() -> None:
    html = """<html><head><title>Still Works</title>
        <script type="application/ld+json">{ not valid json </script>
        </head><body></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.title == "Still Works"


def test_json_ld_skips_blank_and_malformed_scripts_for_a_later_declaration() -> None:
    html = """<html><head>
        <script type="application/ld+json">  </script>
        <script type="application/ld+json">{ bad json }</script>
        <script type="application/ld+json">
        {"headline": "Later declaration", "author": {"name": "Ada Lovelace"}}
        </script>
        </head><body></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.title == "Later declaration"
    assert meta.byline == "Ada Lovelace"


def test_json_ld_parser_uses_tag_text_when_no_single_string_is_available() -> None:
    class FragmentedJsonLdTag:
        string = None

        def get_text(self) -> str:
            return '{"headline": "Fallback text"}'

    assert _parsed_json_ld(cast(Tag, FragmentedJsonLdTag())) == {"headline": "Fallback text"}


def test_json_ld_bare_list_uses_article_and_ignores_unsupported_value() -> None:
    html = """<html><head><script type="application/ld+json">
        [{"@type": "WebSite", "name": "Not this"}, {"headline": "Listed article"}]
        </script></head><body></body></html>"""
    assert extract_page_meta(html, None).title == "Listed article"

    unsupported = """<html><head><title>Fallback title</title>
        <script type="application/ld+json">42</script>
        </head><body></body></html>"""
    assert extract_page_meta(unsupported, None).title == "Fallback title"


def test_json_ld_author_list_keeps_only_declared_nonblank_names() -> None:
    html = """<html><head><script type="application/ld+json">
        {"author": [{"name": " Ada "}, "Grace", {"name": "  "}, {}, 42]}
        </script></head><body></body></html>"""
    assert extract_page_meta(html, None).byline == "Ada, Grace"


def test_og_title_beats_twitter_title_beats_title_tag() -> None:
    html = """<html><head>
        <title>Tag Title</title>
        <meta name="twitter:title" content="Twitter Title">
        <meta property="og:title" content="OG Title">
        </head><body></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.title == "OG Title"

    html_no_og = """<html><head>
        <title>Tag Title</title>
        <meta name="twitter:title" content="Twitter Title">
        </head><body></body></html>"""
    meta_no_og = extract_page_meta(html_no_og, None)
    assert meta_no_og.title == "Twitter Title"

    html_only_tag = """<html><head><title>Tag Title Only</title></head><body></body></html>"""
    meta_only_tag = extract_page_meta(html_only_tag, None)
    assert meta_only_tag.title == "Tag Title Only"


def test_modified_prefers_meta_over_json_ld() -> None:
    html = """<html><head>
        <meta property="article:modified_time" content="2026-05-01T00:00:00Z">
        <script type="application/ld+json">
        {"@type": "Article", "dateModified": "2026-06-01T00:00:00Z"}
        </script>
        </head><body></body></html>"""
    meta = extract_page_meta(html, None)
    assert meta.modified == "2026-05-01T00:00:00Z"


def test_article_author_meta_used_when_no_json_ld_or_plain_author_meta() -> None:
    html = '<html><head><meta property="article:author" content="Dana Okafor"></head><body></body></html>'
    meta = extract_page_meta(html, None)
    assert meta.byline == "Dana Okafor"


def test_og_description_used_only_when_description_meta_is_absent() -> None:
    html = """<html><head>
        <meta name="description" content="Plain summary.">
        <meta property="og:description" content="OG summary.">
        </head><body></body></html>"""
    assert extract_page_meta(html, None).excerpt == "Plain summary."

    html_no_plain = """<html><head>
        <meta property="og:description" content="OG summary.">
        </head><body></body></html>"""
    assert extract_page_meta(html_no_plain, None).excerpt == "OG summary."


def test_source_url_none_and_blank_both_read_as_absent() -> None:
    assert extract_page_meta("<html></html>", None).source_url is None
    assert extract_page_meta("<html></html>", "   ").source_url is None


def test_fragment_without_an_html_element_has_no_declared_language() -> None:
    assert extract_page_meta("<title>Loose title</title>", None).lang is None
