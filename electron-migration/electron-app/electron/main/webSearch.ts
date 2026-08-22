/**
 * The multi-engine web-search fusion behind the agent's `web_search` tool.
 * Ported from `src-tauri/src/web/search.rs` (371 lines, read in full).
 *
 * The room's ONE search provider lives in the sidecar
 * (`arcelle_sidecar/websearch.py`): it queries a fixed set of engines and fuses
 * them into a single relevance ranking. Nothing on this side dispatches between
 * engines — there is nothing to pick, so this file is the thin, faithful HOST
 * wrapper `search.rs` always was: one POST to `/web_search`, the fused hits
 * mapped onto `WebHit`, and the presentation strings (`renderHits`,
 * `joinNames`, `provenance`) the model and the browser's results page share.
 *
 * `WebHit` is IMPORTED from `shared/apiTypes.ts` rather than redeclared here.
 * That declaration already exists for `db-host/webCache.ts` (the 15-minute
 * search cache `exec_tool` reads and writes) and the browser's results page; a
 * second copy of the same wire shape is how the two quietly drift, and the
 * cache hands its rows straight to {@link renderHits}.
 *
 * THE SIDECAR CALL reuses the already-committed `sidecarJsonCancellable.ts`
 * (itself a port of the relevant slice of `sidecar.rs`) rather than
 * re-implementing a POST — that module owns `ensureUp`/`busy`/the auth header/
 * the `{code,error}` envelope for every sidecar feature endpoint.
 * {@link searchPage} takes the post function as an OPTIONAL parameter
 * defaulting to the real one, the same "real by default, overridable for tests"
 * shape `filePass.ts`'s `deps.post ?? sidecarJsonCancellable` established. This
 * is NOT a "refuse when unwired" seam: the helper underneath is real, committed
 * code.
 *
 * Rust's search path never cancels its own sidecar call (`sidecar_json_timeout`
 * takes no cancel token, and the `exec_tool` `"web_search"` arm has none to
 * give), so every call here passes a freshly-minted, never-triggered
 * `CancelFlag`.
 */

import { CancelFlag } from "./cancel.js";
import { sidecarJsonCancellable, type SidecarError, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import type { WebHit } from "../shared/apiTypes.js";
import type { SearchPage } from "./web.js";

/**
 * The sidecar's own overall fan-out deadline (`websearch.FANOUT_BUDGET`),
 * mirrored here because {@link WEB_SEARCH_TIMEOUT_MS} only makes sense relative
 * to it: the engines run CONCURRENTLY and everything still running when the
 * budget expires simply does not contribute, so the sidecar cannot take longer
 * than this to answer `/web_search` however many engines hang. Ported from
 * `SIDECAR_FANOUT_BUDGET`.
 */
export const SIDECAR_FANOUT_BUDGET_MS = 22_000;

/**
 * The host's own wait. Sized to cover {@link SIDECAR_FANOUT_BUDGET_MS} plus the
 * request itself and a cold sidecar wake — NOT a multiple of it. It used to be
 * 4 minutes, sized for a design where the engines ran one after another and the
 * wall clock was the SUM of seven timeouts; they have run in parallel since
 * 2026-08-01, so those 4 minutes could only ever be reached by a sidecar that
 * had stopped answering at all, and then the user watched a dead "Searching…"
 * for 218 seconds longer than there was anything to wait for. Ported from
 * `WEB_SEARCH_TIMEOUT`.
 */
export const WEB_SEARCH_TIMEOUT_MS = 60_000;

/** How many fused hits to ask for. The old single-engine scrapers took 5; the
 * fused ranking is worth a few more, since cross-engine agreement means the top
 * of the list is better sorted than any one engine's page-1 order. Ported from
 * `WEB_SEARCH_LIMIT`. */
const WEB_SEARCH_LIMIT = 10;

/** BROWSE-3: the browser's results page asks for a couple more than the model
 * does — a page of cards can show twelve without costing anyone a context
 * window, and the tail is where the long-shot sources live. Ported from
 * `BROWSER_SEARCH_LIMIT`. */
export const BROWSER_SEARCH_LIMIT = 12;

/** The engine that surfaced this hit first, for the one-line provenance the
 * model reads. Never empty — a hit with no engines is a malformed row, and
 * "web" is the honest fallback. Ported from `WebHit::source`. */
export function hitSource(hit: WebHit): string {
  return hit.engines[0] ?? "web";
}

/**
 * One line of provenance per hit: which engine surfaced it (and how many
 * agreed), the date when known, and its fused relevance. Honest about what it
 * is — the model is told (WEB_PROMPT) that a search result is not a source and
 * that it must `fetch_page` to actually read one. Ported from `provenance`.
 */
export function provenance(hit: WebHit): string {
  const parts: string[] = [];
  const n = hit.engines.length;
  parts.push(n <= 1 ? `via ${hitSource(hit)}` : `via ${hitSource(hit)} +${n - 1} more`);
  const date = hit.date?.trim();
  if (date !== undefined && date !== "") {
    parts.push(date);
  }
  parts.push(`relevance ${hit.score.toFixed(2)}`);
  return parts.join(" · ");
}

/** The numbered list the model reads for a `web_search` tool result. Lives here
 * rather than in the tool arm so a cache hit and a live search render through
 * the same code — the cache stores hits now, not pre-rendered text (BROWSE-3).
 * Ported from `render_hits`. */
export function renderHits(hits: readonly WebHit[]): string {
  return hits
    .map((h, i) => {
      const snippet = h.snippet?.trim();
      const snippetLine = snippet !== undefined && snippet !== "" ? `\n   ${snippet}` : "";
      return `${i + 1}. ${h.title}\n   ${h.url}${snippetLine}\n   ${provenance(h)}`;
    })
    .join("\n");
}

/** Join engine names for a sentence a person reads: "brave and mojeek",
 * "brave, mojeek and marginalia". Ported from `join_names`. */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) {
    return "";
  }
  if (names.length === 1) {
    return names[0]!;
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/** `sidecarJsonCancellable`'s own signature — the seam {@link searchPage}
 * accepts an override of, for tests only (see this file's module doc). */
export type SidecarPostFn = (
  path: string,
  body: unknown,
  cancel: CancelFlag,
  timeoutMs?: number
) => Promise<SidecarPostOutcome>;

/** Map the sidecar's fused hits onto `WebHit`. Tolerant by design: a missing
 * `engines` list falls back to the legacy single `source` key, so a host
 * running an older sidecar degrades to one-engine hits instead of erroring.
 * Ported from `parse_hits`. */
function parseHits(value: unknown): WebHit[] {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const rawHits = Array.isArray(record.hits) ? record.hits : [];
  const out: WebHit[] = [];
  for (const rawHit of rawHits) {
    if (typeof rawHit !== "object" || rawHit === null) {
      continue;
    }
    const hit = rawHit as Record<string, unknown>;
    const url = typeof hit.url === "string" ? hit.url : "";
    if (url === "") {
      continue;
    }
    const text = (key: string): string | null => {
      const v = hit[key];
      if (typeof v !== "string") {
        return null;
      }
      const trimmed = v.trim();
      return trimmed === "" ? null : trimmed;
    };
    let engines: string[] = Array.isArray(hit.engines)
      ? hit.engines.filter((e): e is string => typeof e === "string")
      : [];
    if (engines.length === 0) {
      const source = typeof hit.source === "string" && hit.source !== "" ? hit.source : null;
      engines = source !== null ? [source] : [];
    }
    const rawTitle = typeof hit.title === "string" ? hit.title.trim() : "";
    out.push({
      title: rawTitle === "" ? "(untitled)" : rawTitle,
      url,
      engines,
      date: text("date"),
      snippet: text("snippet"),
      score: typeof hit.score === "number" ? hit.score : 0,
    });
  }
  return out;
}

/** This endpoint has no model in it, so the generation sentinels would be
 * nonsense to whoever reads this string (the model, or a Settings toast). Say
 * what actually went wrong instead. Ported from `search_page`'s own
 * `map_err(|e| match e.code.as_str() { … })`. */
function webSearchErrorMessage(e: SidecarError): string {
  return e.code === "OLLAMA_DOWN"
    ? "The local AI engine isn't running, so web search is unavailable."
    : `Web search failed: ${e.error}`;
}

/** {@link searchWeb} keeping the fusion's own bookkeeping — how many raw hits
 * were merged and how long the whole fan-out took. The results page shows both;
 * the agent path ignores them. Ported from `search_page`. */
export async function searchPage(
  query: string,
  limit: number,
  post: SidecarPostFn = sidecarJsonCancellable
): Promise<SearchPage> {
  const outcome = await post("/web_search", { query, limit }, new CancelFlag(), WEB_SEARCH_TIMEOUT_MS);
  if (outcome.kind === "stopped") {
    // Unreachable in production — the flag passed above is never triggered by
    // anything — but the union is handled exhaustively rather than asserted
    // away, matching this port's own convention elsewhere.
    throw new Error("Web search was stopped.");
  }
  if (outcome.kind === "error") {
    throw new Error(webSearchErrorMessage(outcome.error));
  }
  const value = typeof outcome.value === "object" && outcome.value !== null
    ? (outcome.value as Record<string, unknown>)
    : {};
  return {
    hits: parseHits(value),
    merged: typeof value.merged === "number" ? value.merged : 0,
    tookMs: typeof value.tookMs === "number" ? value.tookMs : 0,
    cached: false,
    failed: Array.isArray(value.failed) ? value.failed.filter((n): n is string => typeof n === "string") : [],
  };
}

/**
 * Free multi-engine web search with no account or API key.
 *
 * Returns the whole page, not just the hits, because a caller MUST be able to
 * tell an empty web from a blocked one. This used to hand back a bare list and
 * document that an empty result meant "no results, not one scraper broke" — the
 * opposite of what the fusion actually reports. Ported from `search_web`.
 */
export async function searchWeb(query: string, post?: SidecarPostFn): Promise<SearchPage> {
  return searchPage(query, WEB_SEARCH_LIMIT, post);
}

/** The browser's results page (BROWSE-3) — a dozen hits with the fusion's own
 * counters attached. Ported from `search_for_browser`. Not wired into any
 * `exec_tool` arm (it has no arm); `browser/search.ts` takes its own
 * `searchForBrowser` as an injected dependency and a future batch can point it
 * here. */
export async function searchForBrowser(query: string, post?: SidecarPostFn): Promise<SearchPage> {
  return searchPage(query, BROWSER_SEARCH_LIMIT, post);
}
