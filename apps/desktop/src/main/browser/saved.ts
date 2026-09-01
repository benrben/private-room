/**
 * BROWSE-2 (D21): what "save this page" actually saves. Port of
 * `src-tauri/src/commands/browse/saved.rs`.
 *
 * The owner's ruling is that a saved page is a FULL READABLE ARTICLE with its
 * METADATA PRESERVED, and both halves used to be missing: the Markdown copy
 * was the browser's own `readMarkdown` (which keeps a page's article only when
 * the page used `<main>`/`<article>` to say where it was), the HTML twin was
 * the entire live DOM unstyled, and the only metadata was two lines of prose.
 *
 * So the page goes through `article.ts`'s `readPage`, and what lands in the
 * room is:
 *
 *  - `Title.md` — the article as Markdown, under a header of the fields the
 *    page actually declared. This is the searchable copy; it carries the
 *    chunks.
 *  - `Title.html` — the same article as a self-contained, styled document that
 *    renders in the viewer with NO network at all.
 *  - the file's `web_meta` — those same fields as real JSON, so the metadata
 *    is queryable rather than only readable.
 *
 * Nothing here invents a field. A page that declares no author has no author
 * line, no `byline` key, and the viewer's strip shows none — and a page with
 * no extractable article says so in the reply instead of presenting its
 * navigation as a body.
 *
 * SCOPE NOTE — the styled HTML document's CSS. `article_document` builds on
 * `docs_html.rs`'s `html_document`/`doc_hero`/`DOC_STYLE`/`NOTEBOOK_CSS`: the
 * app's ONE shared document shell, also used by every Studio template, which
 * inlines a copy of the whole design-token palette kept in lockstep with
 * `src/styles/tokens.css` by hand. That file is not ported anywhere in this
 * Electron tree yet, and porting the palette as a side effect of the browser
 * command layer would both be scope creep and create a SECOND drifting copy of
 * a file whose own doc comment says copies are already its biggest risk. So
 * {@link htmlDocument}/{@link docHero} below are a small, self-contained,
 * honestly-labelled STAND-IN: it satisfies the real product requirement the
 * Rust doc comment cites (inline `<style>`, no `<link>`, no network, RTL
 * honoured) without claiming to be the shared notebook look. Whoever ports
 * `docs_html.rs` for real replaces these two functions and nothing else.
 *
 * DEVIATION — no worker-thread offload. Rust runs the extraction through
 * `tokio::task::spawn_blocking` because Readability's scoring is CPU work on
 * the same runtime that drives the browser's IPC. This port has no
 * worker_threads convention anywhere yet, so `readPage` runs inline —
 * a simplification, not a behaviour change, flagged here for whoever looks at
 * main-process responsiveness under a four-megabyte page.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { Readable } from "node:stream";
import type { PageMeta } from "../../shared/apiTypes.js";
import {
  availableName,
  currentDate,
  getFileMeta,
  insertFileFromUrl,
  setFileExtractedText,
  setWebMeta,
} from "../db-host/files.js";
import type { WorkspaceService } from "../workspace/workspaceService.js";
import { readPage } from "./article.js";

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

/**
 * The slice of `Browser` (browser.ts) a save needs: the page-script transport,
 * and the journal it writes its own line into. Structural, like `reader.ts`'s
 * `ReaderBrowser` — the real class satisfies it directly.
 */
export interface SaveCaptureBrowser {
  call(op: string, args?: unknown): Promise<unknown>;
  journal(kind: string, url: string, detail: string): void;
}

/**
 * Everything beyond the page capture and the room's file table that a real
 * save owes the room.
 *
 * The two schedulers and the event are REQUIRED, not optional. Rust always
 * runs all three, and an optional hook that silently does nothing is exactly
 * how a saved page ends up unsearchable, undescribed and outside the privacy
 * scan without anyone noticing — the defect `capture_and_save`'s own comment
 * records. A caller with nothing to wire yet passes an explicit no-op, which
 * is visible at the call site.
 */
export interface CaptureAndSaveDeps {
  browser: SaveCaptureBrowser;
  db: Database.Database;
  /** Present for folder rooms. Current bytes must be written here, never to SQLCipher. */
  workspace?: WorkspaceService;
  /** The open room's path on disk — Rust's `room.path.clone()`, which is
   *  `schedule_auto_index`'s own argument. */
  roomPath: string;
  scheduleAutoIndex(roomPath: string): void;
  schedulePrivacyScan(): void;
  emitFilesChanged(): void;
}

interface CapturedPage {
  title: string;
  url: string;
  text: string;
  html: string;
  clipped: boolean;
}

type ExtractedPage = ReturnType<typeof readPage> | null;

interface SavedMarkdown {
  mdName: string;
  name: string;
}

type CaptureStore = (
  name: string,
  mime: string,
  bytes: Buffer,
  text: string | null,
) => Promise<{ id: string; name: string }>;

/**
 * Capture the live page (or the user's selection) and save it into the room.
 * ONE code path, shared by the agent's `browse_save` tool and the toolbar's
 * Save menu (D22). Port of `capture_and_save`.
 */
export async function captureAndSave(
  deps: CaptureAndSaveDeps,
  what: "page" | "selection",
): Promise<string> {
  const captured = await capturePage(deps.browser, what);
  const extracted = extractPage(what, captured.html, captured.url);
  const meta = capturedMeta(extracted, captured.title, captured.url);
  const names = await saveCapturedFiles(deps, what, captured, extracted, meta);
  announceSavedCapture(deps, captured.url, names);
  return savedReply(what, extracted?.article != null, captured.clipped, names, meta);
}

async function capturePage(browser: SaveCaptureBrowser, what: "page" | "selection"): Promise<CapturedPage> {
  const value = (await browser.call("capture", { what })) as Record<string, unknown>;
  const captured = capturedPage(value);
  requireCapturedContent(captured);
  return captured;
}

function capturedPage(value: Record<string, unknown>): CapturedPage {
  return {
    title: capturedString(value.title),
    url: capturedString(value.url),
    text: capturedString(value.text),
    html: capturedString(value.html),
    // `capture` clips the live DOM at 4 MB of markup (and the text at 800 KB)
    // and says so. Nothing used to read that flag, which was survivable while
    // the HTML twin was only a fidelity copy — but the ARTICLE is now parsed out
    // of exactly that clipped markup, so on a huge page the reader gets a body
    // that stops partway under a sentence calling it "the readable article". A
    // page we could not capture whole has to say so.
    clipped: value.truncated === true,
  };
}

function capturedString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireCapturedContent(captured: CapturedPage): void {
  if (captured.text.trim() === "" && captured.html.trim() === "") {
    throw new Error("The page returned nothing to save — it may still be loading.");
  }
}

/** A selection is the user's own excerpt, so it must not borrow page metadata. */
function extractPage(what: "page" | "selection", html: string, url: string): ExtractedPage {
  if (what !== "page" || html.trim() === "") return null;
  return readPage(html, url);
}

function capturedMeta(extracted: ExtractedPage, title: string, url: string): PageMeta {
  return {
    ...(extracted?.meta ?? {}),
    // `document.title` is the page's own title; keep it when the extractor
    // found nothing better, and never fall back to the URL here — the URL is a
    // separate field and pretending it is a title loses that.
    title: extracted?.meta.title ?? nonEmpty(title),
    sourceUrl: nonEmpty(url),
    capturedAt: nowIso(),
  };
}

async function saveCapturedFiles(
  deps: CaptureAndSaveDeps,
  what: "page" | "selection",
  captured: CapturedPage,
  extracted: ExtractedPage,
  meta: PageMeta,
): Promise<string[]> {
  const store = captureStore(deps, captured.url);
  const markdown = await saveMarkdownCopy(deps.db, store, what, captured, extracted, meta);
  const twinName = await saveHtmlTwin(
    deps.db,
    store,
    what,
    markdown.mdName,
    captured.html,
    captured.url,
    extracted,
    meta,
  );
  return savedNames(markdown.name, twinName);
}

function captureStore(deps: CaptureAndSaveDeps, url: string): CaptureStore {
  const { db } = deps;
  return async (name, mime, bytes, text) => {
    if (deps.workspace === undefined) {
      return insertFileFromUrl(db, name, mime, bytes, text, "web", url);
    }
    const entry = await deps.workspace.createFile(name, Readable.from([bytes]), "web");
    db.prepare("UPDATE files SET mime_type = ?, origin_url = ? WHERE id = ?")
      .run(mime, url, entry.fileId);
    if (text !== null) setFileExtractedText(db, entry.fileId, text);
    return getFileMeta(db, entry.fileId);
  };
}

async function saveMarkdownCopy(
  db: Database.Database,
  store: CaptureStore,
  what: "page" | "selection",
  captured: CapturedPage,
  extracted: ExtractedPage,
  meta: PageMeta,
): Promise<SavedMarkdown> {
  const saved = currentDate(db);
  const displayTitle = meta.title ?? captured.url;
  const baseTitle = what === "selection" ? `${displayTitle} (selection)` : displayTitle;
  // Saving the same page twice (a news front page revisited an hour later is
  // the common case) produced a second "Google News.md" sitting beside the
  // first, with no date, domain or run to tell them apart. Resolve the free
  // name BEFORE the twin is derived from it, so the pair stays name-matched.
  const mdName = availableName(db, linkFileName(baseTitle, captured.url));
  // No article: the page's own text, whole. Worse than an article and never
  // dressed up as one — see the reply this builds below.
  const body = extracted?.article ? extracted.article.markdown : captured.text;
  const content = markdownPage(displayTitle, meta, saved, body);
  const md = await store(mdName, "text/markdown", Buffer.from(content, "utf8"), content);
  writeWebMeta(db, md.id, meta);
  return { mdName, name: md.name };
}

async function saveHtmlTwin(
  db: Database.Database,
  store: CaptureStore,
  what: "page" | "selection",
  mdName: string,
  html: string,
  url: string,
  extracted: ExtractedPage,
  meta: PageMeta,
): Promise<string | undefined> {
  if (what !== "page" || html.trim() === "") return undefined;
  const htmlName = availableName(db, `${stripMdSuffix(mdName)}.html`);
  const doc = extracted?.article
    ? articleDocument(meta.title ?? url, meta, extracted.article.html)
    : // Nothing was extractable, so the capture itself is all there is — kept
      // verbatim rather than replaced by a prettier lie.
      html;
  const twin = await store(htmlName, "text/html", Buffer.from(doc, "utf8"), null);
  writeWebMeta(db, twin.id, meta);
  return twin.name;
}

function savedNames(markdownName: string, twinName: string | undefined): string[] {
  return twinName === undefined ? [markdownName] : [markdownName, twinName];
}

function announceSavedCapture(deps: CaptureAndSaveDeps, url: string, names: readonly string[]): void {
  // Every other web import starts these two after the file lands; this one
  // started neither, so a page saved from the browser was searchable
  // immediately, had no AI description, and sat outside the privacy scan until
  // some unrelated import happened to schedule one.
  deps.scheduleAutoIndex(deps.roomPath);
  deps.schedulePrivacyScan();
  deps.browser.journal("save", url, `Saved ${names.join(" and ")}`);
  deps.emitFilesChanged();
}

/** `chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ")` — second resolution,
 *  dropping the milliseconds `Date.toISOString()` carries and the Rust format
 *  string never had. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Rust's `md_name.trim_end_matches(".md")`, which strips EVERY trailing
 *  occurrence — so a page genuinely titled "notes.md" pairs as `notes.html`
 *  rather than `notes.md.html`. */
function stripMdSuffix(name: string): string {
  return name.replace(/(\.md)+$/, "");
}

/** Store the page's declared metadata on a saved file.
 *
 * `JSON.stringify` drops an `undefined` value's KEY entirely, which is exactly
 * Rust's `#[serde(skip_serializing_if = "Option::is_none")]`: a page that
 * declared no author has no `byline` key at all, so the viewer's strip can
 * tell "not declared" from "declared as empty".
 *
 * Best-effort: the file is already in the room and losing the strip is not
 * worth losing the page, so a failure here is not turned into a failed save. */
function writeWebMeta(db: Database.Database, id: string, meta: PageMeta): void {
  try {
    setWebMeta(db, id, JSON.stringify(meta));
  } catch {
    // best-effort — see above
  }
}

/**
 * A safe, readable Markdown filename derived from a page title (or its URL
 * when the title is empty). Port of `link_file_name`
 * (`src-tauri/src/commands/files.rs`) — a small, self-contained dependency of
 * `capture_and_save`, kept local rather than pulling the rest of that
 * (unported) module in for one function. Pure, so it is unit-tested directly.
 */
export function linkFileName(title: string, url: string): string {
  const trimmed = title.trim();
  const base = trimmed === "" ? url : trimmed;
  // Fold path/reserved characters and collapse whitespace to keep one clean
  // line that is valid as a file name on macOS.
  const RESERVED = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\n", "\r", "\t"]);
  const folded = Array.from(base)
    .map((c) => (RESERVED.has(c) ? " " : c))
    .join("");
  const cleaned = folded
    .split(/\s+/)
    .filter((t) => t !== "")
    .join(" ");
  const name = Array.from(cleaned).slice(0, 80).join("").trim();
  return `${name === "" ? "Web page" : name}.md`;
}

/**
 * What the reply says — and it may only say what happened.
 *
 * "Saved the article" and "saved the page's text" are different claims, and
 * the second is what a page with no extractable article got. The metadata line
 * names the fields that are really on the file, so "author kept" is never said
 * about a page that named no author.
 */
export function savedReply(
  what: string,
  hasArticle: boolean,
  clipped: boolean,
  names: readonly string[],
  meta: PageMeta,
): string {
  let out = `Saved ${savedSubject(what, hasArticle)} as ${savedFiles(names)}.`;
  const kept = savedMetadata(meta);
  if (kept !== "") {
    out += ` Kept from the page: ${kept}.`;
  }
  if (clipped) {
    out += " The page was too big to capture whole, so this copy stops partway through it.";
  }
  return out;
}

function savedSubject(what: string, hasArticle: boolean): string {
  if (what === "selection") {
    return "the selected text";
  }
  return hasArticle ? "the readable article" : "this page's text (it has no article to extract)";
}

function savedFiles(names: readonly string[]): string {
  if (names.length === 2) {
    return `"${names[0]}" (searchable) and "${names[1]}" (formatted)`;
  }
  return names.length === 1 ? `"${names[0]}"` : "the room";
}

function savedMetadata(meta: PageMeta): string {
  const kept: string[] = [];
  if (meta.siteName) kept.push(meta.siteName);
  if (meta.byline) kept.push(`by ${meta.byline}`);
  if (meta.published) kept.push(`published ${meta.published}`);
  return kept.join(" · ");
}

/**
 * The Markdown copy: a header of the fields the page declared, then the
 * article. Only declared fields get a line — an absent author is an absent
 * line, not "Author: unknown".
 *
 * The fields are a LIST, not bare lines. The viewer renders Markdown with GFM
 * and nothing else, where a single newline is a soft break: `Source: …\nSite:
 * …\nAuthor: …` renders as one run-on paragraph. That was survivable when the
 * header was two lines; with six it is the first thing the reader sees.
 * Port of `markdown_page`.
 */
export function markdownPage(
  title: string,
  meta: PageMeta,
  savedDate: string,
  body: string,
): string {
  let out = `# ${title}\n\n`;
  const field = (label: string, value: string | undefined): void => {
    const v = value?.trim();
    if (v) out += `- ${label}: ${v}\n`;
  };
  field("Source", meta.sourceUrl);
  field("Site", meta.siteName);
  field("Author", meta.byline);
  field("Published", meta.published);
  field("Updated", meta.modified);
  field("Saved", savedDate);
  out += "\n";
  out += body.trim();
  out += "\n";
  return out;
}

/**
 * The HTML copy: the article inside a document shell, so it opens in the
 * viewer looking like a page instead of like a stripped one.
 *
 * Self-contained on purpose — the style is inline and the viewer blocks the
 * network, so the only thing that can fail to load is a remote image, which
 * keeps its `alt` text and its absolute URL either way. Port of
 * `article_document`; see this file's SCOPE NOTE for why the shell itself is a
 * stand-in rather than the app's shared one.
 */
export function articleDocument(title: string, meta: PageMeta, articleHtml: string): string {
  let body = docHero(meta.siteName ?? "", title, meta.excerpt ? htmlEscape(meta.excerpt) : "");
  body += articleChips(meta);
  body += articleSourceNote(meta.sourceUrl);
  body += "<hr>\n";
  body += articleHtml;
  // The page's declared language, honoured. The shell is `<html lang="en">`
  // with no direction at all, so a Hebrew or Arabic article — captured
  // correctly, decoded correctly, `lang` stored correctly in `web_meta` —
  // still opened left-to-right with its punctuation on the wrong side. The
  // direction is derived only from a language the page ACTUALLY declared; a
  // page that declared none is left exactly as it was rather than guessed at.
  return htmlDocument(title, articleLanguageWrapper(meta.lang, body));
}

function articleChips(meta: PageMeta): string {
  const labels: Array<[string, string | undefined]> = [
    ["By", meta.byline],
    ["Published", meta.published],
    ["Updated", meta.modified],
    ["Saved", meta.capturedAt],
  ];
  const chips = labels
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `<span class="chip">${htmlEscape(`${label} ${value}`)}</span>`)
    .join("");
  return chips === "" ? "" : `<div class="chips">${chips}</div>\n`;
}

function articleSourceNote(sourceUrl: string | undefined): string {
  if (!sourceUrl) {
    return "";
  }
  const escaped = htmlEscape(sourceUrl);
  return `<p class="note">Source: <a href="${escaped}">${escaped}</a></p>\n`;
}

function articleLanguageWrapper(lang: string | undefined, body: string): string {
  if (!lang) {
    return body;
  }
  const dir = isRtlLang(lang) ? ' dir="rtl"' : "";
  return `<div lang="${htmlEscape(lang)}"${dir}>\n${body}</div>\n`;
}

/** True for the scripts that read right to left, matched on the language
 *  SUBTAG only (`he`, `he-IL`, `ar-EG`…). `iw` is the retired code for Hebrew
 *  that plenty of pages still declare. Port of `is_rtl_lang`. */
export function isRtlLang(lang: string): boolean {
  const base = (lang.split(/[-_]/)[0] ?? "").trim().toLowerCase();
  return ["ar", "arc", "ckb", "dv", "fa", "he", "iw", "ku", "ps", "sd", "ug", "ur", "yi"].includes(
    base,
  );
}

/** A trimmed value, or `undefined` when the page left the field empty. */
function nonEmpty(s: string): string | undefined {
  const t = s.trim();
  return t === "" ? undefined : t;
}

// --------------------------------------------------------------- doc shell
// See the module comment's SCOPE NOTE: a deliberately small, honestly
// self-contained placeholder, NOT the app's design system.

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PLACEHOLDER_DOC_STYLE = `
body{margin:0;background:#f4f1e8;color:#20221f;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.doc{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.hero .eyebrow{display:block;font-size:.75rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a5a44;margin-bottom:.4rem}
.hero h1{margin:.1em 0 .3em;font-size:1.9rem;line-height:1.2}
.hero .sub{color:#5a5d54;margin:0}
.hero .rule{height:3px;width:56px;background:#8a5a44;border-radius:2px;margin-top:1rem}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 0}
.chip{display:inline-block;border:1px solid #c8c6ba;border-radius:999px;padding:.2rem .7rem;font-size:.85rem}
.note{color:#5a5d54;font-size:.9rem}
a{color:#8a5a44}
img{max-width:100%}
table{border-collapse:collapse}
td,th{border:1px solid #c8c6ba;padding:.25rem .5rem}
hr{border:0;border-top:1px solid #c8c6ba;margin:1.5rem 0}
`;

function htmlDocument(title: string, body: string): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${htmlEscape(title)}</title>\n<style>\n${PLACEHOLDER_DOC_STYLE}\n</style>\n</head>\n<body>\n` +
    `<main class="doc">\n${body.trim()}\n</main>\n</body>\n</html>\n`
  );
}

function docHero(eyebrow: string, title: string, subHtml: string): string {
  let h = '<header class="hero">\n';
  if (eyebrow !== "") {
    h += `<div class="eyebrow">${htmlEscape(eyebrow)}</div>\n`;
  }
  h += `<h1>${htmlEscape(title)}</h1>\n`;
  if (subHtml.trim() !== "") {
    h += `<p class="sub">${subHtml}</p>\n`;
  }
  h += '<div class="rule"></div>\n</header>\n';
  return h;
}
