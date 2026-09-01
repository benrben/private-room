/**
 * BROWSE-3: the address bar's second half — the results page, the enrich pass,
 * and the ＋ that turns a result into a room source. Port of
 * `src-tauri/src/commands/browse/search.rs`.
 *
 * Typing something that isn't a URL used to produce `Invalid URL:
 * https://best pizza nyc`. It now runs a real search and renders an
 * Arcelle-native results page — the same fused engines the assistant uses, so
 * the user and the model are looking at the same web.
 *
 * Five functions, in the order the page uses them:
 *
 *  1. {@link runSearch} — the hits, structured, sharing the assistant's own
 *     15-minute cache (so a search typed here makes the model's next
 *     `web_search` free, and vice versa).
 *  2. {@link browserPreview} — the enrich pass: read a result page for its own
 *     preview image, description and text. Progressive, never blocking, and
 *     switchable off per room.
 *  3. {@link importSearchResult} — the ＋ button.
 *  4. {@link browserPeek} — one result's readable text, inline.
 *  5. {@link browserSearchSummary} — an optional one-paragraph answer written
 *     by the room's own engine from the fetched sources, cited by number.
 *
 * What the results page never does is make a network request of its own: every
 * byte, including image bytes, arrives through the guard and reaches the view
 * as a data URL. Nothing renders from an origin, so no origin sees a browser.
 *
 * WHAT IS INJECTED, AND WHY. `crate::web` (the fused seven-engine search, the
 * guarded page/preview/image fetches), `commands::models` + `crate::ollama`
 * (the room's chat model), and `commands::files::import_web_source` have no
 * counterpart anywhere in this Electron tree yet. Porting a networking layer
 * as a side effect of the search command layer would be exactly the scope
 * creep this migration's own rules warn against, so each of those is a
 * function on the deps object — the same seam shape `BrowserDeps.createPage`
 * established for the one piece of the browser core that needs a live process.
 * Everything else here — cache-first, guard before fetch, journal only a real
 * miss, degrade a failed preview to "no preview" rather than failing a search,
 * ONE cache key shared by lookup and save — is real, ported logic, tested
 * against the real `webCache.ts`.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { BrowserSearchResult, ResultPreview, WebHit } from "../../shared/apiTypes.js";
import type { FileMeta } from "../db-host/files.js";
import { getSetting } from "../db-host/settings.js";
import {
  getFreshWebImage,
  getFreshWebPage,
  getFreshWebSearch,
  putWebSearch,
  saveWebImage,
  saveWebPage,
} from "../db-host/webCache.js";
import { browseGuardUrl } from "./browseGuard.js";
import { cacheKey, clip, stripThinkSpans } from "./searchText.js";
import { requireWebEnabled } from "./webAccess.js";

export { cacheKey, clip, stripThinkSpans } from "./searchText.js";

/** How many results the enrich pass will read per search. The page shows a
 *  dozen; reading the top eight covers the feature card, the two-up row and
 *  the first few rows — the ones a user actually looks at before scrolling. */
const MAX_PREVIEWS = 8;

/** How many previews may be in flight at once. Four keeps the pass under a
 *  couple of seconds on a normal connection without opening a dozen sockets to
 *  a dozen strangers at once. */
const PREVIEW_CONCURRENCY = 4;

/** Sources the summary is allowed to read. Three keeps the model's context
 *  small and the wait short; the summary is an orientation, not a report. */
const SUMMARY_SOURCES = 3;

/** How much readable text an inline Peek shows. Enough to judge whether a
 *  result is worth opening, not enough to be a reader. */
const PEEK_CHARS = 1_400;

/** How much of each source's text the summary call sees. */
const SUMMARY_CHARS_PER_SOURCE = 3_000;

/** How many results the Browser agent is shown. The page draws a dozen; the
 *  agent is choosing ONE address to open, and a list it has to scroll past is
 *  context spent on options it will not take. */
const AGENT_HITS = 6;

/** How much of a result's snippet the agent reads. Enough to tell two results
 *  apart, not enough to answer from — the answer comes from the page. */
const AGENT_SNIPPET_CHARS = 180;

/**
 * Result previews are ON unless the room says otherwise (BROWSE-3b).
 *
 * Absent means on, matching every other room setting here — and matching the
 * precedent `#research` already set, where a user-initiated action fetches the
 * top results' pages. With this off, no result origin is contacted until the
 * user opens, peeks or adds one.
 */
export function resultPreviewsEnabled(db: Database.Database): boolean {
  return getSetting(db, "web_result_previews") !== "off";
}

// ---------------------------------------------------------------------------
// 1. The search itself
// ---------------------------------------------------------------------------

/** What `crate::web::search_for_browser` answers with — the piece this port
 *  injects rather than reimplements. */
export interface FusedSearchPage {
  hits: WebHit[];
  /** Raw hits collected across all engines before dedup — the honest
   *  denominator behind "31 merged into 12". */
  merged: number;
  tookMs: number;
  /** Engines that could not answer: blocked, rate limited or too slow. */
  failed: string[];
}

export interface RunSearchDeps {
  /** `null` when no room is open — Rust reaches this through
   *  `state.room.lock()...ok_or("No room is open.")`, and that refusal is a
   *  different fact from "the switch is off". */
  db: Database.Database | null;
  /** The room's seven engines, fused. Not ported — see this file's header. */
  searchForBrowser(query: string): Promise<FusedSearchPage>;
  /** Whether a chat model is configured for this room
   *  (`model_setting(...).is_some()`), which is what decides whether the view
   *  offers an AI summary at all. A room with no engine must not show a button
   *  that can only fail. */
  hasModelConfigured(db: Database.Database): boolean;
  /** `Browser.journal`'s own signature, so a real caller passes the live
   *  instance's method and gets the real sitting id for free. */
  journal(kind: string, url: string, detail: string): void;
}

/**
 * Run one search for the browser's results page.
 *
 * Gated on the room's master internet switch exactly like `browserNavigate` —
 * this is the same address bar, and a room that reads "offline" must not reach
 * seven engines because the text had a space in it.
 *
 * Split out from any command wrapper for `browse_open`: the Browser agent
 * searches through THIS, so a query the agent types and a query the user types
 * share one gate, one cache and one set of engines. Anything else would mean
 * the agent looking at a different web than the person watching it.
 */
export async function runSearch(deps: RunSearchDeps, query: string): Promise<BrowserSearchResult> {
  const db = requireWebEnabled(deps.db);
  const q = query.trim();
  if (q === "") {
    throw new Error("Type something to search for.");
  }
  const previewsEnabled = resultPreviewsEnabled(db);
  const summaryAvailable = deps.hasModelConfigured(db);

  // Serve a recent search from this Mac without touching the network. Shared
  // with the assistant's `web_search` cache on purpose: searching here warms
  // the model's next lookup, which is the whole point of one search path.
  const cached = getFreshWebSearch(db, q);
  const page: BrowserSearchResult = cached
    ? {
        query: q,
        hits: cached,
        merged: cached.length,
        tookMs: 0,
        cached: true,
        // A cache hit replays hits that were actually found; whichever engines
        // were blocked when it was stored is not news about this search.
        failed: [],
        previewsEnabled,
        summaryAvailable,
      }
    : await (async () => {
        const fused = await deps.searchForBrowser(q);
        // Rust's `let _ = db::put_web_search(...)`, like every other cache write
        // in this file: the seven engines have already answered and the caller
        // is owed those hits, so a row that would not write costs the NEXT
        // search its free cache hit and nothing more. Unwrapped, a locked or
        // older room threw a completed search away at the last step.
        bestEffort(() => putWebSearch(db, q, fused.hits));
        return {
          query: q,
          hits: fused.hits,
          merged: fused.merged,
          tookMs: fused.tookMs,
          cached: false,
          failed: fused.failed,
          previewsEnabled,
          summaryAvailable,
        };
      })();

  // The journal is the browser's audit surface and the user can clear it. A
  // search belongs in the same ledger as an opened page: it is the moment a
  // query left this Mac.
  if (!page.cached) {
    deps.journal("search", "", `Searched for "${q}"`);
  }
  return page;
}

/**
 * The results as the Browser agent reads them (BROWSE-3c).
 *
 * Deliberately shaped as a NEXT STEP rather than as an answer. A model handed
 * a list of snippets will answer from the snippets — which is how a browser
 * agent ends up reporting a search engine's summary of a page as if it had
 * read the page. So each line leads with the address to open, and the closing
 * line names the tool that opens it.
 *
 * Carried here rather than left to the agent-tool batch because `run_search`
 * and this are one pair in Rust: the two phrases below are load-bearing ACROSS
 * the language boundary — the sidecar's `chat.browse` spec gates
 * `Flow.probe_unless` on them, so a reword silently breaks a probe on the
 * Python side.
 */
export function formatHitsForAgent(result: Pick<BrowserSearchResult, "query" | "hits">): string {
  if (result.hits.length === 0) {
    return (
      `No results across seven engines for "${result.query}". Try different words — ` +
      "do NOT open a search engine to try again by hand."
    );
  }
  let out = `Searched the room's own engines for "${result.query}":\n`;
  result.hits.slice(0, AGENT_HITS).forEach((hit, i) => {
    out += `${i + 1}. ${hit.title.trim()} — ${hit.url}\n`;
    const snippet = hit.snippet?.trim();
    if (snippet) {
      out += `   ${clip(snippet, AGENT_SNIPPET_CHARS)}\n`;
    }
  });
  out +=
    "Pick the one that answers the task and browse_open its URL, then browse_read it. " +
    "These snippets are the engines' words, not the page's — never report them as what a page says.";
  return out;
}

// ---------------------------------------------------------------------------
// 2. The enrich pass
// ---------------------------------------------------------------------------

/** One page's own preview metadata, as `crate::web::fetch_preview` answers
 *  it. */
export interface PreviewFetch {
  title?: string | null;
  description?: string | null;
  text: string;
  imageUrl?: string | null;
  iconUrl?: string | null;
}

export interface PreviewDeps {
  db: Database.Database | null;
  /** Reads one result page's own preview image/description/text. Not ported
   *  (`crate::web::fetch_preview`). `null` — or a rejection — on ANY failure:
   *  a page that 404s, blocks us, or has no `<head>` worth reading simply
   *  yields an empty preview. */
  fetchPreview(url: string): Promise<PreviewFetch | null>;
  /** One image's bytes, through the guard. Not ported
   *  (`crate::web::fetch_image`). */
  fetchImage(url: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
}

/**
 * The enrich pass: read up to {@link MAX_PREVIEWS} result pages for their own
 * preview image, description and readable text (BROWSE-3b).
 *
 * Never fails as a whole — a page that 404s, blocks us, or has no `<head>`
 * worth reading simply yields an empty preview, and its card keeps the
 * monogram tile it painted with. Runs after the results are on screen, so the
 * page is complete before this returns.
 */
export async function browserPreview(
  deps: PreviewDeps,
  urls: readonly string[],
): Promise<ResultPreview[]> {
  const db = requireWebEnabled(deps.db);
  if (!resultPreviewsEnabled(db)) {
    // Not an error: the room turned previews off, so every card keeps its
    // monogram tile and no origin is contacted.
    return [];
  }
  const targets = urls.slice(0, MAX_PREVIEWS);
  const out: ResultPreview[] = [];
  for (let i = 0; i < targets.length; i += PREVIEW_CONCURRENCY) {
    const batch = targets.slice(i, i + PREVIEW_CONCURRENCY);
    out.push(...(await Promise.all(batch.map((url) => previewOne(db, deps, url)))));
  }
  return out;
}

/** Read one page and fetch its preview image. Every failure degrades to "no
 *  preview" — this runs for eight strangers' pages at once and must not be
 *  able to fail a search. */
async function previewOne(
  db: Database.Database,
  deps: PreviewDeps,
  url: string,
): Promise<ResultPreview> {
  const preview = emptyPreview(url);
  const page = await deps.fetchPreview(url).catch(() => null);
  if (!page) return preview;
  return fillPreview(db, deps, preview, page);
}

function emptyPreview(url: string): ResultPreview {
  // Every field spelled out, matching Rust's `..Default::default()` + serde:
  // a preview that failed says `image: null` rather than omitting the key, so
  // the card can tell "read it, no image" from "never answered".
  return {
    url,
    image: null,
    icon: null,
    description: null,
    title: null,
    done: true,
  };
}

function cachePreviewText(db: Database.Database, url: string, page: PreviewFetch): void {
  if (page.text.trim() === "") return;
  bestEffort(() => saveWebPage(db, cacheKey(url), page.title ?? "", page.text));
}

async function fillPreview(
  db: Database.Database,
  deps: PreviewDeps,
  preview: ResultPreview,
  page: PreviewFetch,
): Promise<ResultPreview> {
  preview.description = page.description ?? null;
  preview.title = page.title ?? null;
  // The readable text is already in hand — cache it so a later Peek, or the AI
  // summary, costs nothing.
  cachePreviewText(db, preview.url, page);
  await fillPreviewImages(db, deps, preview, page);
  return preview;
}

async function fillPreviewImages(
  db: Database.Database,
  deps: PreviewDeps,
  preview: ResultPreview,
  page: PreviewFetch,
): Promise<void> {
  if (page.imageUrl) preview.image = await cachedDataUrl(db, deps, page.imageUrl);
  if (page.iconUrl) preview.icon = await cachedDataUrl(db, deps, page.iconUrl);
}

/** Fetch one image through the guard (or read it from the 24h cache) and
 *  encode it for the view. `null` on any failure — a missing thumbnail is a
 *  monogram tile, never an error message. */
async function cachedDataUrl(
  db: Database.Database,
  deps: PreviewDeps,
  url: string,
): Promise<string | null> {
  const cached = getFreshWebImage(db, url);
  if (cached) {
    return dataUrl(cached.mime, cached.bytes);
  }
  const fetched = await deps.fetchImage(url).catch(() => null);
  if (!fetched) {
    return null;
  }
  bestEffort(() => saveWebImage(db, url, fetched.mime, fetched.bytes));
  return dataUrl(fetched.mime, fetched.bytes);
}

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// 3. The ＋ button
// ---------------------------------------------------------------------------

export interface ImportSearchResultDeps {
  db: Database.Database | null;
  /** `commands::files::import_web_source` — a YouTube link saves its captions,
   *  an ordinary page saves a readable Markdown copy, and anything that isn't
   *  text goes through the binary download funnel with its room-file cap.
   *  Every branch records `origin_url`. A whole separate subsystem, not ported
   *  here. */
  importWebSource(checkedUrl: string, title: string): Promise<FileMeta>;
  journal(kind: string, url: string, detail: string): void;
}

/**
 * Add one search result to the room as a source (BROWSE-3). Port of
 * `import_search_result`.
 */
export async function importSearchResult(
  deps: ImportSearchResultDeps,
  url: string,
  title: string,
): Promise<FileMeta> {
  requireWebEnabled(deps.db);
  const checked = await browseGuardUrl(url);
  const meta = await deps.importWebSource(checked, title);
  deps.journal("save", checked, `Saved "${meta.name}" into the room`);
  return meta;
}

// ---------------------------------------------------------------------------
// 4. The inline Peek
// ---------------------------------------------------------------------------

export interface PeekDeps {
  db: Database.Database | null;
  /** One guarded fetch of a page's readable text. Not ported
   *  (`crate::web::fetch_page`). */
  fetchPage(url: string): Promise<{ title: string; text: string }>;
}

/**
 * Read one result's text for the inline Peek (BROWSE-3).
 *
 * Usually free: the enrich pass has already cached this page, so expanding a
 * result costs nothing. On a miss it is one guarded fetch — and Peek is an
 * explicit act by the user, which is exactly the bar for contacting an origin.
 */
export async function browserPeek(deps: PeekDeps, url: string): Promise<string> {
  const db = requireWebEnabled(deps.db);
  const cached = getFreshWebPage(db, cacheKey(url));
  if (cached && cached.text.trim() !== "") {
    return clip(cached.text, PEEK_CHARS);
  }
  const checked = await browseGuardUrl(url);
  const { title, text } = await deps.fetchPage(checked);
  if (text.trim() === "") {
    throw new Error("That page has no readable text to preview.");
  }
  bestEffort(() => saveWebPage(db, cacheKey(checked), title, text));
  return clip(text, PEEK_CHARS);
}

// ---------------------------------------------------------------------------
// 5. The AI summary
// ---------------------------------------------------------------------------

/** The summary's whole job is to be grounded: it sits directly above the real
 *  results, so a confident sentence the sources don't support is worse than an
 *  empty space. Citations are mandatory and hedging is explicitly allowed. */
export const SUMMARY_PROMPT =
  "You summarize web search results for someone who has not read them yet. Write ONE short " +
  "paragraph (2-4 sentences) answering their question using ONLY the numbered sources given. " +
  "Cite every claim with its source number in brackets, like [1] or [2]. If the sources " +
  "disagree, say so. If they do not answer the question, say plainly that they do not — never " +
  "fill the gap from your own knowledge. No preamble, no headings, no list: just the paragraph.";

export interface SummaryDeps extends PeekDeps {
  /** The room's chat-model setting, or `null` when none is set. Not ported
   *  (`commands::models::model_setting`). */
  modelSetting(db: Database.Database): string | null;
  /** `crate::ollama::generate`, RAW — a `<think>` preamble included, because
   *  stripping it is this function's own job. */
  generate(model: string, systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * The AI summary above the results (owner request 2026-08-01).
 *
 * Reads the top few results — from the page cache the enrich pass already
 * filled, so this is usually zero network — and asks the room's own engine for
 * one grounded paragraph. A source that will not load is SKIPPED rather than
 * failing the summary; every source failing is a refusal, not an empty answer.
 */
export async function browserSearchSummary(deps: SummaryDeps, query: string): Promise<string> {
  const db = requireWebEnabled(deps.db);
  const hits = summaryHits(db, query);
  const model = summaryModel(deps, db);
  const sources = await summarySources(db, deps, hits);
  if (sources.length === 0) throw new Error("None of these results could be read, so there is nothing to summarize.");
  const context = formatSummarySources(sources);
  const raw = await deps.generate(
    model,
    SUMMARY_PROMPT,
    `Question: ${query}\n\nSources:\n\n${context}`,
  );
  return summaryText(raw);
}

type SummarySource = [number, string, string];

function summaryHits(db: Database.Database, query: string): WebHit[] {
  const hits = getFreshWebSearch(db, query.trim());
  if (!hits) throw new Error("Those results have expired — search again to summarize them.");
  return hits;
}

function summaryModel(deps: SummaryDeps, db: Database.Database): string {
  const model = deps.modelSetting(db);
  if (!model) throw new Error("No AI engine is set for this room.");
  return model;
}

async function summarySource(
  db: Database.Database,
  deps: SummaryDeps,
  hit: WebHit,
  index: number,
): Promise<SummarySource | null> {
  const key = cacheKey(hit.url);
  const cached = getFreshWebPage(db, key);
  const text = cached && cached.text.trim() !== "" ? cached.text : await fetchedSummaryText(db, deps, hit.url, key);
  return text === null ? null : [index + 1, hit.title, clip(text, SUMMARY_CHARS_PER_SOURCE)];
}

async function fetchedSummaryText(
  db: Database.Database,
  deps: SummaryDeps,
  url: string,
  key: string,
): Promise<string | null> {
  const fetched = await deps.fetchPage(url).catch(() => null);
  if (!fetched) return null;
  bestEffort(() => saveWebPage(db, key, fetched.title, fetched.text));
  return fetched.text;
}

async function summarySources(
  db: Database.Database,
  deps: SummaryDeps,
  hits: WebHit[],
): Promise<SummarySource[]> {
  const sources: SummarySource[] = [];
  for (let index = 0; index < hits.length && sources.length < SUMMARY_SOURCES; index += 1) {
    const hit = hits[index];
    if (!hit) continue;
    const source = await summarySource(db, deps, hit, index);
    if (source) sources.push(source);
  }
  return sources;
}

function formatSummarySources(sources: SummarySource[]): string {
  return sources.map(([number, title, text]) => `[${number}] ${title}\n${text}`).join("\n\n---\n\n");
}

function summaryText(raw: string): string {
  // A thinking model puts its private reasoning in `<think>…</think>` before
  // the answer, and `generate` hands the raw text back. Unstripped, the
  // monologue was rendered as the summary paragraph sitting above the real
  // results — the one place on the page that has to be trustworthy.
  const text = stripThinkSpans(raw).trim();
  if (text === "") throw new Error("The engine returned nothing for this summary.");
  return text;
}

/** A cache write, which Rust spells `let _ = db::save_web_page(...)`: the
 *  fetch already succeeded and the caller owes its answer either way, so a
 *  failed write must not become a failed search. */
function bestEffort(write: () => void): void {
  try {
    write();
  } catch {
    // deliberately ignored — see above
  }
}
