/**
 * Real-behaviour tests for `article.ts`: the REAL `@mozilla/readability` over
 * REAL linkedom-parsed HTML, never a mock of the very library this module
 * exists to delegate to. The fixtures are `src-tauri/src/extraction/
 * article.rs`'s own (`NEWS` and its siblings), so the shape that pins the Rust
 * side's behaviour pins this side's too — even though the scorer underneath is
 * a different, real implementation of the same algorithm.
 */

import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { htmlToMarkdown, metaReaderFor, readPage } from "./article.js";

const NEWS = `<!doctype html><html lang="en"><head>
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
  </body></html>`;

describe("readPage", () => {
  it("keeps the article and drops the chrome", () => {
    const cap = readPage(NEWS, "https://marshreview.example/heron");
    expect(cap.article).not.toBeNull();
    const article = cap.article!;
    for (const kept of [
      "After eleven years of absence",
      "What the counts show",
      "Eleven nests counted",
      "The lower marsh in March",
    ]) {
      expect(article.markdown).toContain(kept);
    }
    for (const chrome of ["Subscribe now", "Sections", "newsletter", "Privacy policy"]) {
      expect(article.markdown).not.toContain(chrome);
      expect(article.html).not.toContain(chrome);
    }
    // Structure survives the round trip, not just the words.
    expect(article.markdown).toContain("## What the counts show");
    expect(article.markdown).toContain("- Eleven nests counted");
    // And the plain-text copy the index chunks is the article too.
    expect(article.text).toContain("After eleven years");
    expect(article.text).not.toContain("Privacy policy");
  });

  /** The saved copy has to point somewhere after the room is offline, so every
   * relative reference is resolved against the page's own address. `srcset` is
   * in here on purpose: it is the one a hand-written resolve pass over
   * `a`/`img`/`source`/`poster` quietly misses, and the library's own
   * `_fixRelativeUris` is what covers it (see article.ts's header). */
  it("resolves every relative reference against the page, srcset included", () => {
    const cap = readPage(NEWS, "https://marshreview.example/heron");
    const article = cap.article!;
    expect(article.markdown).toContain(
      "![A grey heron in shallow water](https://marshreview.example/img/heron.jpg)",
    );
    expect(article.markdown).toContain("[marsh history](https://marshreview.example/marsh/history)");

    const responsive =
      "<html><body><article>" +
      `<p>${"A long enough body of prose to be scored as this page's article. ".repeat(4)}</p>` +
      `<p>${"A second paragraph, so the scorer has more than one node to weigh. ".repeat(4)}</p>` +
      '<p><img src="/y.png" srcset="/y2.png 2x" alt="y"><video poster="/p.jpg"></video></p>' +
      "</article></body></html>";
    const html = readPage(responsive, "https://e.test/a/b").article!.html;
    expect(html).toContain('src="https://e.test/y.png"');
    expect(html).toContain('srcset="https://e.test/y2.png 2x"');
    expect(html).toContain('poster="https://e.test/p.jpg"');
  });

  it("a page with no url keeps its relative references rather than inventing a host", () => {
    const cap = readPage(NEWS);
    expect(cap.article).not.toBeNull();
    expect(cap.article!.markdown).toContain("![A grey heron in shallow water](/img/heron.jpg)");
    expect(cap.meta.sourceUrl).toBeUndefined();
  });

  it("captures the metadata the page declared", () => {
    const cap = readPage(NEWS, "https://marshreview.example/heron");
    expect(cap.meta.byline).toBe("Dana Okafor");
    expect(cap.meta.published).toBe("2026-03-04T09:12:00Z");
    expect(cap.meta.siteName).toBe("The Marsh Review");
    expect(cap.meta.excerpt).toBe("A bird came back.");
    expect(cap.meta.lang).toBe("en");
    expect(cap.meta.sourceUrl).toBe("https://marshreview.example/heron");
    expect(cap.meta.title).toContain("The Heron Returns");
  });

  it("reads metadata out of JSON-LD as well as out of meta tags", () => {
    // The library's own metadata pass reads both. This is the case a
    // hand-written `<meta>` scan cannot answer, and it is why this module
    // calls `_getArticleMetadata(_getJSONLD(doc))` rather than reading tags.
    const jsonLd =
      '<!doctype html><html lang="en"><head><title>Untitled</title>' +
      '<script type="application/ld+json">' +
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "The Heron Returns",
        author: { "@type": "Person", name: "Dana Okafor" },
        publisher: { "@type": "Organization", name: "The Marsh Review" },
        datePublished: "2026-03-04T09:12:00Z",
      }) +
      "</script></head><body><article>" +
      `<p>${"A long enough body of prose to be scored as this page's article. ".repeat(4)}</p>` +
      `<p>${"A second paragraph, so the scorer has more than one node to weigh. ".repeat(4)}</p>` +
      "</article></body></html>";
    const meta = readPage(jsonLd, "https://marshreview.example/heron").meta;
    expect(meta.title).toBe("The Heron Returns");
    expect(meta.byline).toBe("Dana Okafor");
    expect(meta.siteName).toBe("The Marsh Review");
    expect(meta.published).toBe("2026-03-04T09:12:00Z");
  });

  it("reads metadata a page never declared as absent, and never from the body", () => {
    // Same body, no meta tags at all — and an empty `author` meta, which is a
    // page declaring nothing, not a page declaring "".
    const bare = `<!doctype html><html><head><title>Plain page</title>
      <meta name="author" content="   "></head><body>
      <nav>menu</nav>
      <div id="content">
      <p>A short page with no author and no date declared anywhere in it, just words enough that the scorer treats this as a real body of text rather than a caption.</p>
      <p>A second paragraph so the candidate has some weight, and the scorer has more than one node to weigh when it decides what the article is.</p>
      </div><footer>footer junk</footer></body></html>`;
    const cap = readPage(bare, "https://example.com/plain");
    expect(cap.meta.byline).toBeUndefined();
    expect(cap.meta.published).toBeUndefined();
    expect(cap.meta.modified).toBeUndefined();
    expect(cap.meta.siteName).toBeUndefined();
    expect(cap.meta.lang).toBeUndefined();
    // `.parse()`'s own excerpt falls back to the article's FIRST PARAGRAPH.
    // That is the page's prose, not its declared summary, and presenting it as
    // one would be the room inventing metadata — see article.ts, point 2.
    expect(cap.meta.excerpt).toBeUndefined();
    expect(cap.article!.text).toContain("A short page with no author");
    // The body is still extracted — missing metadata costs only metadata.
    expect(cap.article!.markdown).toContain("A short page with no author");
    expect(cap.article!.markdown).not.toContain("footer junk");
  });

  it("a page with no article says so, and still reports its title", () => {
    const shell =
      "<html><head><title>Results</title></head><body><nav>a b c</nav>" +
      '<div id="app"></div></body></html>';
    const cap = readPage(shell, "https://example.com/search?q=x");
    expect(cap.article).toBeNull();
    expect(cap.meta.title).toBe("Results");
  });

  /** The metadata pass runs BEFORE `.parse()` and independently of it, which
   * is the whole reason it is not read off `.parse()`'s result: that returns a
   * bare `null` for a page with no scoreable body, taking the declared author,
   * site and date down with it. */
  it("still reports a shell page's declared author, site and date", () => {
    const shell =
      '<!doctype html><html lang="he-IL"><head><title>Results</title>' +
      '<meta property="og:site_name" content="The Marsh Review">' +
      '<meta name="author" content="Dana Okafor">' +
      '<meta property="article:published_time" content="2026-03-04T09:12:00Z">' +
      '</head><body><nav>a b c</nav><div id="app"></div></body></html>';
    const cap = readPage(shell, "https://example.com/search?q=x");
    expect(cap.article).toBeNull();
    expect(cap.meta.byline).toBe("Dana Okafor");
    expect(cap.meta.siteName).toBe("The Marsh Review");
    expect(cap.meta.published).toBe("2026-03-04T09:12:00Z");
    expect(cap.meta.lang).toBe("he-IL");
  });

  /** `modified` has no equivalent in Readability's API at all — article.ts's
   * own targeted scan (module comment, point 3), which takes the key off
   * either `property=` or `name=` because real pages use both. */
  it("reads a declared modified time from either property= or name=", () => {
    const og = NEWS.replace(
      "</head>",
      '<meta property="article:modified_time" content="2026-03-10T00:00:00Z"></head>',
    );
    expect(readPage(og, "https://marshreview.example/heron").meta.modified).toBe(
      "2026-03-10T00:00:00Z",
    );
    const dc = NEWS.replace(
      "</head>",
      '<meta name="dcterms.modified" content="2026-03-11T00:00:00Z"></head>',
    );
    expect(readPage(dc, "https://marshreview.example/heron").meta.modified).toBe(
      "2026-03-11T00:00:00Z",
    );
    // A blank value is a page declaring nothing, not a page declaring "".
    const blank = NEWS.replace(
      "</head>",
      '<meta property="article:modified_time" content="  "></head>',
    );
    expect(readPage(blank, "https://marshreview.example/heron").meta.modified).toBeUndefined();
  });

  it("keeps the page's declared language, whatever direction it reads in", () => {
    const he = NEWS.replace('lang="en"', 'lang="he-IL"');
    expect(readPage(he, "https://marshreview.example/heron").meta.lang).toBe("he-IL");
  });

  /** Readability is a content extractor, not a sanitizer — it drops `<script>`
   * ELEMENTS and leaves inline handlers alone. The article that lands in the
   * room must be the prose, not the site's code. */
  it("leaves the page's scripts and inline handlers behind", () => {
    const page =
      "<html><body><article>" +
      "<script>window.__owned = 1;</script>" +
      '<p onclick="steal()">A body long enough to be scored as the article on this page, ' +
      "with a script tag sitting inside it exactly where a real site would put one.</p>" +
      '<img src="/a.png" alt="a" onerror="alert(1)" ONLOAD="alert(2)">' +
      "<p>And a second paragraph, so the scorer has more than one node to weigh " +
      "when it decides which part of this page the article actually is.</p>" +
      '<script src="/tracker.js"></script></article></body></html>';
    const article = readPage(page, "https://example.com/a").article!;
    expect(article.html).not.toContain("<script");
    expect(article.html).not.toContain("window.__owned");
    expect(article.markdown).not.toContain("window.__owned");
    for (const handler of ["onclick", "onerror", "onload", "steal()", "alert(1)", "alert(2)"]) {
      expect(article.html.toLowerCase()).not.toContain(handler);
    }
    // The content those attributes were sitting on is untouched.
    expect(article.markdown).toContain("A body long enough");
    expect(article.html).toContain('src="https://example.com/a.png"');
    expect(article.html).toContain('alt="a"');
  });

  it("a caption-length body is not an article", () => {
    const stub =
      "<html><head><title>Paywalled</title></head><body><article>" +
      "<p>Subscribe to read the rest.</p></article></body></html>";
    expect(readPage(stub, "https://example.com/p").article).toBeNull();
  });

  it("garbage markup reads as no article rather than throwing", () => {
    expect(() => readPage("<<<not html at all", "https://example.com/x")).not.toThrow();
    expect(readPage("").article).toBeNull();
    expect(readPage("", "not a url").meta.sourceUrl).toBe("not a url");
  });
});

/**
 * TRIPWIRE. `readDeclaredMeta` calls two of Readability's own private members
 * — the exact pair `.parse()` calls before it decides whether an article
 * exists. That is deliberate (article.ts, points 1 and 2), and it is guarded
 * by a `catch` so a library upgrade cannot crash a save. The cost of that
 * `catch` is that a rename would SILENTLY strip the author, site and date off
 * every page this room ever saves again. This test is what makes it loud.
 */
describe("the extractor still exposes the metadata reader this port calls", () => {
  it("has _getJSONLD and _getArticleMetadata, and they answer for a real document", () => {
    const document = (parseHTML(NEWS) as unknown as { document: never }).document;
    const reader = metaReaderFor(document);
    expect(typeof reader._getJSONLD).toBe("function");
    expect(typeof reader._getArticleMetadata).toBe("function");
    const declared = reader._getArticleMetadata(reader._getJSONLD(document));
    expect(declared.byline).toBe("Dana Okafor");
    expect(declared.siteName).toBe("The Marsh Review");
  });
});

describe("htmlToMarkdown", () => {
  it("keeps structure", () => {
    const md = htmlToMarkdown(
      "<div><h2>Title</h2><p>Some <strong>bold</strong> and <em>soft</em> text with " +
        "<code>x = 1</code>.</p><blockquote><p>Quoted line</p></blockquote>" +
        "<ol><li>first</li><li>second</li></ol><pre>fn main() {}</pre>" +
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>" +
        '<p><a href="https://x.test/">link</a> and <a href="javascript:void(0)">js</a></p>' +
        "<hr></div>",
    );
    expect(md).toContain("## Title");
    expect(md).toContain("Some **bold** and *soft* text with `x = 1`.");
    expect(md).toContain("> Quoted line");
    expect(md).toContain("1. first");
    expect(md).toContain("2. second");
    expect(md).toContain("```\nfn main() {}\n```");
    expect(md).toContain("| A | B |");
    expect(md).toContain("| 1 | 2 |");
    expect(md).toContain("[link](https://x.test/)");
    // A javascript: href goes nowhere, so it stays as plain words.
    expect(md).toContain("js");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("---");
    // Ordinary prose is NOT escaped: this string is what the search index
    // chunks and what the model reads back out of the file.
    expect(md).not.toContain("\\");
  });

  it("keeps bare container text", () => {
    // A `<div>` with no block children is a paragraph; without that case it
    // would serialize to nothing at all.
    const md = htmlToMarkdown("<div>bare words</div><section><div>nested</div></section>");
    expect(md).toContain("bare words");
    expect(md).toContain("nested");
  });

  it("indents a nested list one level per depth", () => {
    const md = htmlToMarkdown(
      "<ul><li>top<ul><li>nested one</li><li>nested two</li></ul></li><li>second top</li></ul>",
    );
    expect(md).toContain("- top");
    expect(md).toContain("  - nested one");
    expect(md).toContain("  - nested two");
    expect(md).toContain("- second top");
  });

  it("gives a headerless table an empty header row so it still renders", () => {
    const md = htmlToMarkdown("<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>");
    expect(md).toContain("| 1 | 2 |");
    expect(md).toContain("| --- | --- |");
    // A short row is padded out to the table's width.
    expect(md).toContain("| 3 |  |");
  });

  it("escapes a pipe inside a cell so it cannot split the row", () => {
    const md = htmlToMarkdown("<table><tr><td>a|b</td><td>c</td></tr></table>");
    expect(md).toContain("| a\\|b | c |");
  });

  it("drops a link with no text and keeps an image with no alt", () => {
    const md = htmlToMarkdown(
      '<p>before <a href="https://x.test/"><i></i></a> after</p><p><img src="/a.png"></p>',
    );
    expect(md).toContain("before after");
    expect(md).not.toContain("https://x.test/");
    expect(md).toContain("![](/a.png)");
  });

  it("collapses every run of whitespace to one space, as HTML does", () => {
    expect(htmlToMarkdown("<p>a\n\t  b   c</p>")).toBe("a b c\n");
  });
});
