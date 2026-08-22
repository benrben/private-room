/**
 * First-party web access for the agent's `web_search`/`fetch_page` tools.
 * Ported from `src-tauri/src/web.rs` — the barrel Rust's
 * `pub use fetch::*; pub use guard::*; pub use search::*;` created, minus the
 * `guard` half: `web/guard.rs` is already ported and committed as
 * `browser/guard.ts` (reused by `ytdlp.ts`/`jobDownload.ts`/`webFetch.ts`), so
 * nothing here re-exports it — every importer reaches it at `./browser/guard.js`
 * directly.
 *
 * Only reached when the user has turned the room's internet switch on — the
 * tools are not even offered to the model otherwise.
 *
 * `WebHit` is re-exported from `shared/apiTypes.ts` rather than redeclared:
 * that declaration already backs `db-host/webCache.ts` and the browser's
 * results page, and a second copy of one wire shape is how the two drift.
 */

export type { WebHit } from "../shared/apiTypes.js";

export {
  bodyCapped,
  bodyCappedTo,
  decodeBody,
  defaultDownloadTempDir,
  dispositionFileName,
  downloadToTemp,
  extractCaptionTracks,
  fetchImage,
  fetchPage,
  fetchPreview,
  fetchReadable,
  guardedGet,
  htmlTitle,
  INLINE_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_BYTES,
  MAX_FETCH_BYTES,
  MAX_PAGE_CHARS,
  MAX_PREVIEW_IMAGE_BYTES,
  previewFromHtml,
  redirectTarget,
  safeFileName,
  timedtextJson3ToLines,
  youtubeTranscript,
  youtubeVideoId,
  type CappableResponse,
  type Downloaded,
  type DownloadOutcome,
  type FetchedPage,
  type GuardedResponse,
  type PagePreview,
} from "./webFetch.js";

export {
  BROWSER_SEARCH_LIMIT,
  hitSource,
  joinNames,
  provenance,
  renderHits,
  searchForBrowser,
  searchPage,
  searchWeb,
  SIDECAR_FANOUT_BUDGET_MS,
  WEB_SEARCH_TIMEOUT_MS,
  type SidecarPostFn,
} from "./webSearch.js";

import type { WebHit } from "../shared/apiTypes.js";
import { joinNames } from "./webSearch.js";

/**
 * Shown whenever a fetch target (or a redirect hop) resolves onto this Mac or
 * the home network. Actionable and safe to surface to the model/UI. Ported from
 * `PRIVATE_BLOCKED` — the string itself lives in `browser/guard.ts`, which is
 * what throws it; this is the barrel's copy of the constant for any caller that
 * needs to RECOGNISE the refusal.
 */
export const PRIVATE_BLOCKED = "This address points to a private network and was blocked.";

/**
 * A whole search, as the browser's results page consumes it (BROWSE-3).
 * `merged` and `tookMs` are what make the header's consensus line true
 * ("31 hits merged into 12 · 1.8s") rather than decorative. Ported from
 * `SearchPage`.
 */
export interface SearchPage {
  hits: WebHit[];
  merged: number;
  tookMs: number;
  /** Served from this Mac's 15-minute cache without touching the network. */
  cached: boolean;
  /**
   * The engines that could not answer at all — blocked (HTTP 403), rate
   * limited (429), unreachable, or slower than the fan-out budget.
   *
   * This is the difference between the two ways a search comes back empty, and
   * the sidecar has always computed it. No hits and nothing failed means the
   * web really had nothing. No hits and every engine failed means the search
   * never happened — and reporting that as "No results found." tells the model,
   * and then the user, that a subject does not exist on the web because a
   * scraper got a 429.
   */
  failed: string[];
}

/**
 * A sentence naming the engines that could not answer, or `null` when the whole
 * fan-out answered. Appended to what the model reads so a thin result set is
 * never mistaken for a thorough one. Ported from `SearchPage::blocked_note`.
 */
export function blockedNote(page: Pick<SearchPage, "failed">): string | null {
  if (page.failed.length === 0) {
    return null;
  }
  return (
    `Note: ${joinNames(page.failed)} could not be reached for this search (blocked, rate limited or too ` +
    "slow), so these results are only part of the web."
  );
}
