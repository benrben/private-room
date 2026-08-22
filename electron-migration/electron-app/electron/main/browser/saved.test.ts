/**
 * Port of `src-tauri/src/commands/browse/saved.rs`'s `#[cfg(test)] mod tests`
 * (the pure formatting functions), plus end-to-end coverage of
 * `captureAndSave` against a REAL fixture room (`createRoom`) and the REAL,
 * already-ported `Browser` class over the page-factory seam `browser.test.ts`
 * established — so the capture round trip and the journal line are the real
 * ones, not a hand-rolled stand-in for the browser core.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import type { BrowseJournalRow, PageMeta } from "../../shared/apiTypes.js";
import { createRoom } from "../db-host/open.js";
import { getFileMeta, getWebMeta, insertFileFromUrl, listFiles } from "../db-host/files.js";
import { Browser, type BrowserDeps } from "./browser.js";
import type { CreatePageDeps, LivePage, WindowContentView } from "./webviewManager.js";
import {
  articleDocument,
  captureAndSave,
  isRtlLang,
  linkFileName,
  markdownPage,
  savedReply,
  type CaptureAndSaveDeps,
} from "./saved.js";

function meta(overrides: PageMeta = {}): PageMeta {
  return {
    title: "The Heron Returns",
    byline: "Dana Okafor",
    siteName: "The Marsh Review",
    published: "2026-03-04T09:12:00Z",
    sourceUrl: "https://marshreview.example/heron",
    capturedAt: "2026-08-03T10:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------- pure

describe("markdownPage", () => {
  it("carries only the fields the page declared, each as its own list item", () => {
    const md = markdownPage("The Heron Returns", meta(), "2026-08-03", "Body text.");
    expect(md.startsWith("# The Heron Returns\n")).toBe(true);
    // Every field is its OWN list item. Bare `Source:\nSite:\nAuthor:` lines
    // are a single soft-broken paragraph to a GFM renderer, so the header
    // rendered as one run-on sentence in the viewer.
    for (const line of ["- Source: ", "- Site: ", "- Author: ", "- Published: ", "- Saved: "]) {
      expect(md).toContain(line);
    }
    expect(md).toContain("Source: https://marshreview.example/heron\n");
    expect(md).toContain("Site: The Marsh Review\n");
    expect(md).toContain("Author: Dana Okafor\n");
    expect(md).toContain("Published: 2026-03-04T09:12:00Z\n");
    expect(md).toContain("Saved: 2026-08-03\n");
    expect(md.endsWith("Body text.\n")).toBe(true);
    // The page declared no modified date, so there is no "Updated" line — not
    // an empty one, and certainly not the published date reused.
    expect(md).not.toContain("Updated");
  });

  it("invents nothing for a page that declared nothing", () => {
    const bare: PageMeta = { sourceUrl: "https://example.com/p" };
    const md = markdownPage("Plain page", bare, "2026-08-03", "Body.");
    expect(md).toContain("Source: https://example.com/p\n");
    expect(md).toContain("Saved: 2026-08-03\n");
    for (const absent of ["Author", "Published", "Site", "Updated"]) {
      expect(md).not.toContain(absent);
    }
  });

  it("shows an Updated line only when the page declared one", () => {
    const md = markdownPage("T", meta({ modified: "2026-03-10T00:00:00Z" }), "2026-08-03", "B.");
    expect(md).toContain("- Updated: 2026-03-10T00:00:00Z\n");
  });
});

describe("articleDocument", () => {
  it("is self-contained and shows the declared metadata", () => {
    const doc = articleDocument("The Heron Returns", meta(), "<p>Body text.</p>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    // The viewer blocks the network: every style must be in the file.
    expect(doc).toContain("<style>");
    expect(doc).not.toContain('<link rel="stylesheet"');
    expect(doc).toContain("<h1>The Heron Returns</h1>");
    expect(doc).toContain("The Marsh Review");
    expect(doc).toContain("By Dana Okafor");
    expect(doc).toContain("Published 2026-03-04T09:12:00Z");
    expect(doc).toContain("Saved 2026-08-03T10:00:00Z");
    expect(doc).toContain('href="https://marshreview.example/heron"');
    expect(doc).toContain("<p>Body text.</p>");
    // A field the page never declared draws no chip at all.
    expect(doc).not.toContain("Updated");
  });

  it("invents no byline or date for a page that declared none", () => {
    const bare: PageMeta = { capturedAt: "2026-08-03T10:00:00Z" };
    const doc = articleDocument("Plain page", bare, "<p>Body.</p>");
    expect(doc).not.toContain("By ");
    expect(doc).not.toContain("Published");
    // …and the room's OWN fact stays.
    expect(doc).toContain("Saved 2026-08-03T10:00:00Z");
  });

  it("opens a right-to-left article right to left, and guesses at nothing", () => {
    // The shell is `<html lang="en">` with no direction, so a Hebrew article —
    // decoded correctly, `lang` captured correctly — still opened
    // left-to-right in the viewer.
    const he = articleDocument("כותרת", meta({ lang: "he-IL" }), "<p>שלום</p>");
    expect(he).toContain('lang="he-IL"');
    expect(he).toContain('dir="rtl"');

    // A left-to-right page keeps its language and gains no direction.
    const en = articleDocument("T", meta({ lang: "en" }), "<p>ok</p>");
    expect(en).toContain('lang="en"');
    expect(en).not.toContain('dir="rtl"');

    // A page that declared no language is not guessed at — no wrapper at all.
    const none = articleDocument("T", meta(), "<p>ok</p>");
    expect(none).not.toContain('dir="rtl"');
    expect(none).not.toContain("<div lang=");

    expect(isRtlLang("ar")).toBe(true);
    expect(isRtlLang("fa-IR")).toBe(true);
    expect(isRtlLang("iw")).toBe(true);
    expect(isRtlLang("he_IL")).toBe(true);
    expect(isRtlLang("en-GB")).toBe(false);
    expect(isRtlLang("")).toBe(false);
    expect(isRtlLang("hebrewish")).toBe(false);
  });

  it("cannot be closed by a metadata value", () => {
    // Every declared field is page-controlled text. A byline of
    // `</style><script>` must land as characters, not as markup.
    const hostile = articleDocument(
      "T",
      {
        byline: "</span><script>alert(1)</script>",
        siteName: "<img src=x onerror=alert(2)>",
        sourceUrl: 'https://x.test/"><script>',
      },
      "<p>ok</p>",
    );
    // The characters survive; the MARKUP does not. (`onerror=alert(2)` is
    // still in the file as text — inside an escaped `&lt;img …&gt;`, where it
    // is a word rather than an attribute.)
    expect(hostile).not.toContain("<script");
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).toContain("&lt;script&gt;");
    expect(hostile).toContain("&lt;img src=x onerror=alert(2)&gt;");
    // …and a quote in the source URL cannot break out of the href either.
    expect(hostile).toContain('href="https://x.test/&quot;&gt;&lt;script&gt;"');
  });
});

describe("savedReply", () => {
  it("says what was actually saved", () => {
    const names = ["Heron.md", "Heron.html"];
    const said = savedReply("page", true, false, names, meta());
    expect(said).toContain("the readable article");
    expect(said).toContain('"Heron.md" (searchable)');
    expect(said).toContain(
      "Kept from the page: The Marsh Review · by Dana Okafor · published 2026-03-04T09:12:00Z.",
    );
    // A whole capture must not warn.
    expect(said).not.toContain("too big");
  });

  it("does not claim an article a page never had, or metadata it never declared", () => {
    const noArticle = savedReply("page", false, false, ["A.md", "A.html"], {});
    expect(noArticle).toContain("no article to extract");
    expect(noArticle).not.toContain("readable article");
    expect(noArticle).not.toContain("Kept from the page");

    const selection = savedReply("selection", false, false, ["Sel.md"], {});
    expect(selection).toContain("the selected text");
    expect(selection).toContain('"Sel.md"');
  });

  it("does not call a clipped capture whole", () => {
    // `capture` stops at 4 MB of markup, and the article is parsed out of that
    // clipped markup — so on a huge page the body stops partway. Saying "the
    // readable article" and nothing else would be a claim the room cannot
    // support.
    const said = savedReply("page", true, true, ["Big.md", "Big.html"], meta());
    expect(said).toContain("the readable article");
    expect(said).toContain("too big to capture whole");
    expect(said).toContain("stops partway");
  });
});

describe("linkFileName", () => {
  it("folds reserved characters, collapses whitespace, and falls back to the url", () => {
    expect(linkFileName("Hello World", "https://x.com")).toBe("Hello World.md");
    expect(linkFileName("A/B: c\td", "https://x.com")).toBe("A B c d.md");
    // An empty title falls back to the URL, with the SAME reserved-character
    // folding applied to it — never left empty.
    expect(linkFileName("   ", "https://ex.com/p")).toBe("https ex.com p.md");
    expect(linkFileName("", "")).toBe("Web page.md");
    // Capped at 80 characters, counted in code points.
    expect(linkFileName("x".repeat(100), "https://x/")).toBe(`${"x".repeat(80)}.md`);
    expect(linkFileName("🙂".repeat(100), "https://x/")).toBe(`${"🙂".repeat(80)}.md`);
  });
});

// ------------------------------------------------------------ captureAndSave

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "browse-saved-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** The real `Browser`, whose `capture` op answers a fixed payload and whose
 *  journal writes into the SAME room — so `captureAndSave`'s real
 *  `browser.journal(...)` call lands a real row this test can read back. */
function browserAnswering(db: Database.Database, answer: Record<string, unknown>): Browser {
  const windowContentView: WindowContentView = { addChildView() {}, removeChildView() {} };
  const createPage = (id: string, _pageDeps: CreatePageDeps): LivePage =>
    ({
      id,
      view: { setBounds() {} },
      contents: {
        isDestroyed: () => false,
        close() {},
        loadURL: async () => {},
        executeJavaScript: async () => JSON.stringify(answer),
      },
      webSession: {
        isPersistent: () => false,
        getStoragePath: () => null,
        webRequest: { onBeforeRequest() {} },
      },
      protection: { state: "unknown" },
    }) as unknown as LivePage;
  const deps: BrowserDeps = {
    windowContentView: () => windowContentView,
    journalSink: { db, emit: (_row: BrowseJournalRow) => {} },
    emit: () => {},
    stagingDir: () => "/tmp/x",
    ensureStagingDir: () => {},
    removeStagedFile: async () => {},
    removeStagingDir: async () => {},
    importFinishedDownload: async (_p, name) => ({ name }),
    createPage,
  };
  const browser = new Browser(deps);
  browser.newTab("https://marshreview.example/heron");
  return browser;
}

interface Recorded extends CaptureAndSaveDeps {
  autoIndexed: string[];
  privacyScans: number;
  filesChanged: number;
}

function recordingDeps(db: Database.Database, browser: Browser): Recorded {
  const deps: Recorded = {
    browser,
    db,
    roomPath: "/tmp/room.roomai",
    autoIndexed: [],
    privacyScans: 0,
    filesChanged: 0,
    scheduleAutoIndex: (p) => void deps.autoIndexed.push(p),
    schedulePrivacyScan: () => void (deps.privacyScans += 1),
    emitFilesChanged: () => void (deps.filesChanged += 1),
  };
  return deps;
}

/** The same article under a title of the caller's choosing — the extractor
 *  reads `<title>`, so a case about FILE NAMING has to declare the name it is
 *  about rather than inherit the fixture's. */
function articleHtmlTitled(title: string): string {
  return (
    `<html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1>` +
    "<p>After eleven years of absence the grey heron has come back to the lower marsh, and the " +
    "wardens who counted its going are counting its return with something close to disbelief.</p>" +
    "<p>A second paragraph of real body text, so the scorer has more than one node to weigh when " +
    "it decides what the article on this page actually is.</p></article></body></html>"
  );
}

const ARTICLE_HTML =
  '<html lang="en"><head><title>The Heron Returns</title>' +
  '<meta property="og:site_name" content="The Marsh Review">' +
  '<meta name="author" content="Dana Okafor">' +
  '<meta property="article:published_time" content="2026-03-04T09:12:00Z">' +
  '</head><body><nav><a href="/x">Subscribe now</a></nav><article><h1>The Heron Returns</h1>' +
  "<p>After eleven years of absence the grey heron has come back to the lower marsh, and the " +
  "wardens who counted its going are counting its return with something close to disbelief.</p>" +
  "<p>A second paragraph of real body text, so the scorer has more than one node to weigh when " +
  "it decides what the article on this page actually is.</p></article></body></html>";

describe("captureAndSave", () => {
  it("saves a whole page as a searchable Markdown file and a self-contained HTML twin", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "The Heron Returns — live",
      url: "https://marshreview.example/heron",
      text: "fallback text, unused when an article is found",
      html: ARTICLE_HTML,
      truncated: false,
    });
    const deps = recordingDeps(db, browser);

    const reply = await captureAndSave(deps, "page");

    expect(reply).toContain("the readable article");
    expect(reply).toContain('"The Heron Returns.md" (searchable)');
    expect(reply).toContain("The Marsh Review");
    expect(reply).toContain("by Dana Okafor");

    const files = listFiles(db);
    expect(files.map((f) => f.name).sort()).toEqual([
      "The Heron Returns.html",
      "The Heron Returns.md",
    ]);
    const md = files.find((f) => f.name.endsWith(".md"))!;
    const twin = files.find((f) => f.name.endsWith(".html"))!;
    expect(md.mimeType).toBe("text/markdown");
    expect(twin.mimeType).toBe("text/html");
    // The Markdown copy carries the search text; indexing both would find the
    // same page twice.
    expect(getFileMeta(db, md.id).hasText).toBe(true);
    expect(getFileMeta(db, twin.id).hasText).toBe(false);
    // The chrome did not come with the article.
    const body = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(md.id) as {
      extracted_text: string;
    };
    expect(body.extracted_text).toContain("After eleven years of absence");
    expect(body.extracted_text).not.toContain("Subscribe now");

    // The declared metadata is on BOTH files, as queryable JSON.
    for (const id of [md.id, twin.id]) {
      const webMeta = JSON.parse(getWebMeta(db, id)!) as PageMeta;
      expect(webMeta.byline).toBe("Dana Okafor");
      expect(webMeta.siteName).toBe("The Marsh Review");
      expect(webMeta.sourceUrl).toBe("https://marshreview.example/heron");
      // The room's OWN fact, always present; not something the page declared.
      expect(typeof webMeta.capturedAt).toBe("string");
      // …and a field the page never declared is an absent KEY, not a null.
      expect("modified" in webMeta).toBe(false);
    }

    expect(deps.autoIndexed).toEqual(["/tmp/room.roomai"]);
    expect(deps.privacyScans).toBe(1);
    expect(deps.filesChanged).toBe(1);

    // The save is journalled through the browser's own real journal path.
    const row = db
      .prepare("SELECT kind, url, detail FROM browse_journal ORDER BY id DESC LIMIT 1")
      .get() as { kind: string; url: string; detail: string };
    expect(row.kind).toBe("save");
    expect(row.url).toBe("https://marshreview.example/heron");
    expect(row.detail).toContain("The Heron Returns.md and The Heron Returns.html");
    db.close();
  });

  it("saves a page with no extractable article as its own text, and says so", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "Results",
      url: "https://example.com/search?q=x",
      text: "raw page text with no real article structure",
      html: '<html><head><title>Results</title></head><body><nav>a b c</nav><div id="app"></div></body></html>',
      truncated: false,
    });
    const reply = await captureAndSave(recordingDeps(db, browser), "page");
    expect(reply).toContain("no article to extract");
    expect(reply).not.toContain("readable article");
    const md = listFiles(db).find((f) => f.name.endsWith(".md"))!;
    expect(md.name).toBe("Results.md");
    const body = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(md.id) as {
      extracted_text: string;
    };
    expect(body.extracted_text).toContain("raw page text with no real article structure");
    db.close();
  });

  /**
   * A selection is the USER'S OWN EXCERPT. `capture` sends no markup for one,
   * so there is no article to extract and no metadata to read — and the
   * `what === "page"` half of that condition is doing real work, not guarding
   * an impossible case: a page script that sent markup anyway (or a future
   * capture that does) would otherwise have the extractor replace the selected
   * passage with the WHOLE ARTICLE, under a reply that still says "Saved the
   * selected text", and stamp the page's byline, site and publication date
   * onto a file the user excerpted by hand.
   */
  it("saves a selection with no HTML twin, no extraction, and no borrowed metadata", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "The Heron Returns",
      url: "https://marshreview.example/heron",
      text: "just the selected passage",
      // Markup is present on the wire — the guard must be the MODE, not the
      // absence of html.
      html: ARTICLE_HTML,
      truncated: false,
    });
    const reply = await captureAndSave(recordingDeps(db, browser), "selection");
    expect(reply).toContain("the selected text");
    const files = listFiles(db);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("The Heron Returns (selection).md");

    // The file holds the PASSAGE, not the article the page happens to contain.
    const body = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(files[0]!.id) as {
      extracted_text: string;
    };
    expect(body.extracted_text).toContain("just the selected passage");
    expect(body.extracted_text).not.toContain("After eleven years of absence");

    // …and nothing the PAGE declared about itself was stamped onto the user's
    // own excerpt.
    const stored = JSON.parse(getWebMeta(db, files[0]!.id)!) as PageMeta;
    expect(stored.byline).toBeUndefined();
    expect(stored.siteName).toBeUndefined();
    expect(stored.published).toBeUndefined();
    // The reply must not claim metadata it did not keep, either.
    expect(reply).not.toContain("Kept from the page");
    db.close();
  });

  it("names a second save of the same page distinctly, keeping the pair matched", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "The Heron Returns",
      url: "https://marshreview.example/heron",
      text: "text",
      html: ARTICLE_HTML,
      truncated: false,
    });
    await captureAndSave(recordingDeps(db, browser), "page");
    await captureAndSave(recordingDeps(db, browser), "page");
    // The free name is resolved BEFORE the twin is derived from it, so the two
    // copies of one save always share a stem.
    expect(new Set(listFiles(db).map((f) => f.name))).toEqual(
      new Set([
        "The Heron Returns.md",
        "The Heron Returns.html",
        "The Heron Returns (2).md",
        "The Heron Returns (2).html",
      ]),
    );
    db.close();
  });

  /** `md_name.trim_end_matches(".md")` strips EVERY trailing occurrence, so a
   *  page genuinely titled "notes.md" pairs as `notes.html` rather than
   *  `notes.md.html`. */
  it("pairs a page whose own title ends in .md without doubling the suffix", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "notes.md",
      url: "https://example.com/notes",
      text: "t",
      html: articleHtmlTitled("notes.md"),
      truncated: false,
    });
    await captureAndSave(recordingDeps(db, browser), "page");
    expect(new Set(listFiles(db).map((f) => f.name))).toEqual(
      new Set(["notes.md.md", "notes.html"]),
    );
    db.close();
  });

  /** The twin's name is resolved through `availableName` in its own right, not
   *  merely derived from the Markdown copy's: a room that already holds a
   *  "Report.html" from some other import must not make the save collide on
   *  the UNIQUE name index the moment "Report.md" happens to be free. */
  it("finds the twin a free name of its own, not just the markdown copy's stem", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "Report",
      url: "https://example.com/report",
      text: "t",
      html: articleHtmlTitled("Report"),
      truncated: false,
    });
    // Something else in the room already owns exactly the twin's derived name.
    insertFileFromUrl(db, "Report.html", "text/html", Buffer.from("<p>other</p>"), null, "web", "");
    await captureAndSave(recordingDeps(db, browser), "page");
    const names = new Set(listFiles(db).map((f) => f.name));
    expect(names.has("Report.md")).toBe(true);
    expect(names.has("Report (2).html")).toBe(true);
    db.close();
  });

  /** `chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ")` — SECOND resolution.
   *  `Date.toISOString()` carries milliseconds the Rust format string never
   *  had, and this value is both stored in `web_meta` and printed in the HTML
   *  twin's "Saved …" chip. */
  it("stamps capturedAt at second resolution, as the Rust format string does", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "T",
      url: "https://example.com/x",
      text: "t",
      html: "",
      truncated: false,
    });
    await captureAndSave(recordingDeps(db, browser), "page");
    const stored = JSON.parse(getWebMeta(db, listFiles(db)[0]!.id)!) as PageMeta;
    expect(stored.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    db.close();
  });

  /**
   * THE TWIN'S ONE PRODUCT PROMISE, end to end on a real page rather than on a
   * hand-written `<p>`: "a self-contained, styled document that renders in the
   * viewer with NO network at all."
   *
   * `articleDocument`'s own unit test proves the SHELL inlines its style. What
   * it cannot prove is that the ARTICLE does not drag the site's furniture in
   * with it — and that half is not this file's code at all, it is
   * `@mozilla/readability` deciding what to strip. A library upgrade that
   * stopped cleaning `<link>` inside the extracted content would put a
   * stylesheet request back into every saved page, silently, with every
   * existing test still green.
   *
   * Remote IMAGES are the documented exception and are deliberately not
   * asserted against: they keep their `alt` text and their absolute URL, and
   * the viewer blocks them.
   */
  it("saves a hostile page's article with nothing left to fetch but its images", async () => {
    const db = freshRoom();
    const hostile =
      '<html lang="en"><head><title>Hostile</title>' +
      '<link rel="stylesheet" href="https://cdn.evil.test/site.css">' +
      "</head><body><nav><a href='/x'>Subscribe</a></nav><article><h1>Hostile</h1>" +
      '<link rel="stylesheet" href="https://cdn.evil.test/inline.css">' +
      '<style>@import url("https://cdn.evil.test/imported.css");</style>' +
      '<script src="https://cdn.evil.test/track.js"></script>' +
      '<iframe src="https://cdn.evil.test/frame.html"></iframe>' +
      '<object data="https://cdn.evil.test/o.swf"></object>' +
      '<embed src="https://cdn.evil.test/e.swf">' +
      '<p onclick="alert(1)">After eleven years of absence the grey heron has come back to the ' +
      "lower marsh, and the wardens who counted its going are counting its return with something " +
      "close to disbelief.</p>" +
      '<img src="/rel/pic.png" alt="a picture">' +
      "<p>A second paragraph of real body text, so the scorer has more than one node to weigh " +
      "when it decides what the article on this page actually is.</p>" +
      "</article></body></html>";
    const browser = browserAnswering(db, {
      ok: true,
      title: "Hostile",
      url: "https://evil.test/a",
      text: "fallback",
      html: hostile,
      truncated: false,
    });
    const reply = await captureAndSave(recordingDeps(db, browser), "page");
    expect(reply).toContain("the readable article");

    const twin = listFiles(db).find((f) => f.name.endsWith(".html"))!;
    const doc = (
      db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(twin.id) as {
        original_bytes: Buffer;
      }
    ).original_bytes.toString("utf8");

    // Nothing in the saved file asks the network for anything but pictures.
    expect(doc).not.toContain("<link");
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("@import");
    expect(doc).not.toContain("<iframe");
    expect(doc).not.toContain("<object");
    expect(doc).not.toContain("<embed");
    expect(doc).not.toContain("cdn.evil.test");
    // …the style it DOES use is in the file…
    expect(doc).toContain("<style>");
    // …the site's chrome did not come along…
    expect(doc).not.toContain("Subscribe");
    // …no inline handler survived into a file the viewer runs scripts in…
    expect(doc).not.toContain("onclick");
    // …and the article itself is really there, with its relative image
    // resolved against the page it came from so it still points somewhere.
    expect(doc).toContain("After eleven years of absence");
    expect(doc).toContain('src="https://evil.test/rel/pic.png"');
    db.close();
  });

  /** The whole chain the RTL fix describes — the page declares `lang`, the
   *  extractor captures it, `web_meta` stores it, and the twin opens in that
   *  direction. `articleDocument`'s unit test only covers the last link. */
  it("carries a Hebrew page's declared language all the way into the twin", async () => {
    const db = freshRoom();
    const he =
      '<html lang="he-IL"><head><title>כותרת</title></head><body><article><h1>כותרת</h1>' +
      "<p>אחרי אחת עשרה שנות היעדרות חזרה האנפה האפורה אל הביצה התחתונה, והשומרים שספרו את " +
      "לכתה סופרים כעת את שובה בתחושה הקרובה לאי אמון גמור מכל בחינה שהיא.</p>" +
      "<p>פסקה שנייה של טקסט גוף אמיתי, כדי שיהיה למנוע הניקוד יותר מצומת אחד לשקול בבואו " +
      "להחליט מהו המאמר שבעמוד הזה.</p></article></body></html>";
    const browser = browserAnswering(db, {
      ok: true,
      title: "כותרת",
      url: "https://example.com/he",
      text: "t",
      html: he,
      truncated: false,
    });
    await captureAndSave(recordingDeps(db, browser), "page");
    const twin = listFiles(db).find((f) => f.name.endsWith(".html"))!;
    expect((JSON.parse(getWebMeta(db, twin.id)!) as PageMeta).lang).toBe("he-IL");
    const doc = (
      db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(twin.id) as {
        original_bytes: Buffer;
      }
    ).original_bytes.toString("utf8");
    expect(doc).toContain('lang="he-IL"');
    expect(doc).toContain('dir="rtl"');
    db.close();
  });

  it("warns when the capture itself was clipped", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "Big Page",
      url: "https://example.com/big",
      text: "",
      html: ARTICLE_HTML,
      truncated: true,
    });
    const reply = await captureAndSave(recordingDeps(db, browser), "page");
    expect(reply).toContain("stops partway");
    db.close();
  });

  it("refuses when the page returned nothing, before writing anything", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, { ok: true, title: "", url: "", text: "", html: "" });
    const deps = recordingDeps(db, browser);
    await expect(captureAndSave(deps, "page")).rejects.toThrow("it may still be loading");
    expect(listFiles(db)).toHaveLength(0);
    expect(deps.filesChanged).toBe(0);
    db.close();
  });

  it("keeps the page's own title when the extractor found nothing better, never the URL", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "Live Title",
      url: "https://example.com/x",
      text: "selected words",
      html: "",
      truncated: false,
    });
    await captureAndSave(recordingDeps(db, browser), "selection");
    expect(listFiles(db)[0]?.name).toBe("Live Title (selection).md");
    db.close();
  });

  it("falls back to the URL for a page with no title at all", async () => {
    const db = freshRoom();
    const browser = browserAnswering(db, {
      ok: true,
      title: "",
      url: "https://example.com/x",
      text: "selected words",
      html: "",
      truncated: false,
    });
    await captureAndSave(recordingDeps(db, browser), "selection");
    expect(listFiles(db)[0]?.name).toBe("https example.com x (selection).md");
    // …and the URL is still a SOURCE, not a title: nothing wrote it into the
    // `title` field of the stored metadata.
    const stored = JSON.parse(getWebMeta(db, listFiles(db)[0]!.id)!) as PageMeta;
    expect(stored.title).toBeUndefined();
    expect(stored.sourceUrl).toBe("https://example.com/x");
    db.close();
  });
});
