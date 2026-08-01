# Arcelle Search — the address bar's second half (BROWSE-3)

**Date:** 2026-08-01 · **Status:** ✅ BUILT (uncommitted on main) — green-lit and implemented same day
**One line:** typing a non-URL in the browser address bar opens an Arcelle-native results page — fused-engine hits rendered by the app itself, each one openable, peekable, and one click from becoming a source the chat agent can actually read.

Interactive UI mockup: published as the "Arcelle Search — results page" artifact (single-file HTML, both themes, keyboard-drivable).

---

## 0b. What shipped (2026-08-01)

Built end to end, all suites green: **Rust 564 lib tests**, **sidecar 36 websearch tests**, **frontend tsc + vite build**, **39 page-script tests** (12 new address-classifier cases).

| Layer | Landed |
|---|---|
| Sidecar | `snippet` on every engine's hits; `engines` consensus list through fusion; `merged`/`tookMs` on `/web_search` |
| Rust | `WebHit`/`SearchPage` structured shape; `browser_search` (shared 15-min cache with the agent, journals a `search` row); `browser_preview` (enrich pass, 8 pages, concurrency 4, data-URL images, `web_images` cache); `browser_peek`; `browser_search_summary`; `import_search_result`; `web_result_previews` room setting |
| Frontend | `classifyAddress` + tests; `BrowserSearch` view (feature/duo/row tiers, consensus dials, progressive previews, peek, ＋, AI summary with clickable citations); `browser.css` search block; 7 engine hues in `tokens.css` both themes; BrowserView wiring (parking predicate, ◂ Results row, "Search instead" recovery button); qa-mock fixtures |

**Bug found and fixed by the new tests:** `meta_content` hardcoded double quotes in its needle, so a page using `property='og:image'` silently lost its preview image even though `attr_value` handled both quote styles. Also made a malformed fragment skip rather than abandon the remaining meta keys.

**Deviation from the plan, deliberate:** the AI summary is **on demand**, not automatic — it costs a model call plus three page reads, and an unrequested summary above results the user can already read is noise. One click, then a grounded paragraph whose every `[n]` is a button that scrolls to the result it cites.

**Not built (deferred as planned):** per-page `SearchSession` keyed by tab id (the session is per browser area, matching how `blank` already works), tab-title sync from queries, Settings UI toggle for `web_result_previews` (the setting is read and honored; it has no switch yet).

---

## 0. TL;DR

- The address bar placeholder already promises "**Search** or enter a web address" ([BrowserView.tsx:263](../src/workspace/BrowserView.tsx)); the code delivers `Invalid URL: https://best pizza nyc`. This plan closes that gap.
- The results page is a **React view shown while the native WKWebView is parked at 1×1** — the exact mechanism the start screen and consent modals already use. Nothing new is invented; the page is the start screen grown up.
- Search data comes from the existing fused 7-engine sidecar stack via one new Tauri command returning **structured hits**. Two upgrades to the sidecar make the UI worth building: keep the **snippet** (engines return it; we currently throw it away) and keep the **list of engines that agreed** on each URL (we currently keep only the first). Cross-engine consensus is the thing Google can't show — it becomes the page's signature visual.
- The **+ button** on each card fetches the page through the existing guarded fetch, seals it into the room as a `source="web"` Markdown file (`origin_url` set), and **pins it to the composer as an attachment** — so the text is in the very next turn's context verbatim, and durably reachable forever after via RAG / `search_room` / the file inventory.
- **Every result carries its page's own preview image (§6):** a guarded enrich pass fetches the top hits' `og:image` + description + text — cookie-less, script-less, capped, cached, disclosed in the header, toggleable per room. Thumbnails like Google's, minus the crawl and minus the fingerprint.
- **The layout encodes the ranking (§5):** a relevance-tiered page — full-width feature card for the top hit, a two-up row, then compact rows — instead of Google's undifferentiated list.
- Privacy stance is load-bearing and visible in the UI: *the query is the only thing that leaves this Mac*. No result URL is contacted until the user opens, peeks, or adds it. No third-party favicon service, ever. No auto-search on failed navigation (that would silently leak internal hostnames to seven engines).

---

## 1. What exists today (verified 2026-08-01)

| Fact | Where |
|---|---|
| Address bar submit → `go()` → `api.browserNavigate`; only parsing is `.trim()` | BrowserView.tsx:152-167 |
| Rust normalizer: `contains("://") ? verbatim : "https://" + input`, then the SSRF guard | browse.rs:707-716, guard.rs:35-75 |
| Non-URL input today: red banner `Invalid URL: https://eiffel tower` / `Could not resolve the address for weather.` | guard.rs:36,66 → BrowserView.tsx:350-357 |
| Start screen = React div shown when `!info.open \|\| blank`; webview parked to 1×1 when `parked \|\| blank` | BrowserView.tsx:48-65, 359-375; browser.rs:487-495 |
| Fused search: 7 engines, RRF + lexical, dedup by URL; **no snippet in the result shape**; only the *first* engine kept per hit | websearch.py:81-88, 391-453 |
| Sidecar route `POST /web_search` → `{hits:[{title,url,source,date,score}]}` | server.py:740-762 |
| Rust `SearchHit{title,url,snippet}` — snippet is a *synthesized* provenance string; engines/date/score discarded at this boundary | web.rs:21-25, search.rs:25-32 |
| Frontend has **no** search API — only `webSearchTest` (diagnostic string) | api.ts:183 |
| Search cache `web_searches` stores the *pre-rendered numbered list*, 15-min TTL | web_cache.rs:9-33 |
| `#research` = closest prior art: search → fetch top 4 readable → save as `source="web"` md files → answer from only those | generate.rs:328-447 |
| Message sources are **name-only strings**; `files.origin_url` is written but never SELECTed | apiTypes.ts:107-121, db.rs:73-75 |
| Page-path imports (`save_link`/`browse_save`/`#research`) skip `schedule_auto_index` + `schedule_privacy_scan`; `import_link_impl` also drops `origin_url` | files.rs:644-678 vs files.rs:196-197 |
| User's address bar is gated by the master web switch only; lanes gate the agent (owner decision 2026-07-30) | commands.rs:648-651, browse.rs:335-343 |
| No favicon support anywhere; tab icons are a static globe | (repo-wide grep) |

---

## 2. Decision: where the page lives

**The results page is React, rendered in the host, while the webview is parked.** Same mechanism as the start screen (`blank`) and the consent card (`parked`): extend the parking predicate in `pushBounds` to `parked || blank || resultsVisible`.

Why not HTML loaded into the WKWebView (custom `arcelle://search` scheme)? Rejected:
- Every interactive element (+, peek, ask-the-room) would need a JS↔Rust↔React bridge; in the host it's a function call.
- The webview is the *private* surface — injecting app state (room files, attach status) into a web page context muddies the "browser keeps nothing" claim.
- Theme tokens, focus management, a11y, and the no-popover discipline all come free in the host.
- Precedent: the start screen already proves the parked-webview pattern works and self-heals (vanishing-page fix, 2026-08-01).

One consequence to embrace: **while results are visible the webview is at 1×1, so the "nothing draws over the native page" constraint doesn't bind inside the results view.** We keep the no-popover discipline anyway (consistency, and the view un-parks at any moment), with one allowed exception: engine-dot tooltips, which are pure CSS hover titles.

### State model

```ts
/** One search per browser page (tab). Never persisted — a stored list of
 *  queries is a search history, which this browser promises not to keep
 *  (same doctrine as tabs.ts isDurable). */
interface SearchSession {
  pageId: string;          // ref of the "page" tab this search belongs to
  query: string;
  status: "loading" | "ready" | "error" | "offline";
  hits: WebHit[];
  visible: boolean;        // false once a result is opened; toggled back by "◂ Results"
  startedAt: number;
  tookMs?: number;
  merged?: number;         // raw hit count before dedup, for the consensus line
  peeks: Record<string, PeekState>;   // url → collapsed | loading | {text} | error
  added: Record<string, AddState>;    // url → importing | {fileId, attached} | error
  error?: string;
}
// workspace state: searches: Record<pageId, SearchSession>
```

Owned by workspace state (not BrowserView local state) because the tab strip and composer both need it. Dies with the page tab (`prune` hook), never written to disk.

---

## 3. The omnibox classifier

Pure function, frontend, unit-tested. Runs in `go()` before anything is sent to Rust; `browser_navigate` stays exactly as it is (the agent's `browse_open` keeps its current semantics — the agent already has a real `web_search` tool and must not fall into search-by-typo).

```
classifyAddress(input) → { kind: "url", url } | { kind: "search", query }
```

Rules, in order:
1. Empty → no-op (existing behavior).
2. Starts with `?` → **search** for the rest (explicit force; Chrome convention).
3. Contains `://` → **url** verbatim.
4. Contains whitespace → **search**.
5. Single token that looks like a host: has a dot (`example.com`, `x.co/path`), or is `host:port`, or is an IP literal → **url** (prefix `https://`). The guard still rejects private/localhost with its existing honest message.
6. Everything else (`weather`, `בנק ישראל`) → **search**.

**Never auto-search on a failed navigation.** `intranet-wiki` or a typo'd internal hostname must not be silently broadcast to seven engines. Instead the existing error banner grows one button: **"Search the web for “{input}” instead"** — recovery is one click, and it's the user's click.

Escape hatches both ways: `?site.com` forces a search; `site.com/` or `https://…` forces navigation.

---

## 4. Data plumbing

### 4.1 Sidecar (websearch.py) — two shape upgrades

1. **Keep the snippet.** DDG-html, Brave, Mojeek, and Marginalia scrapes all contain result snippets today; `_hit` drops them. Add `"snippet": str | None` to `_hit`, populate in the four scrapers (+ Wikipedia's OpenSearch description, + news RSS description), and in `_fuse` keep the **first non-empty snippet** for a deduped URL.
2. **Keep the consensus.** `_fuse` currently keeps one `source` string. Change the fused hit to carry `"engines": ["duckduckgo","brave",…]` (ordered by engine priority, deduped — the per-engine `counted` set already prevents fake agreement). Keep `"source"` as `engines[0]` for back-compat with existing tests, or migrate the tests.

Route response becomes `{hits:[{title,url,engines,source,date,snippet,score}], merged:int, tookMs:int}` — `merged` and `tookMs` cost nothing and feed the page's consensus line ("7 engines · 31 hits merged into 12 · 1.8s"). Fail-soft per engine is unchanged; queries still never appear in logs.

### 4.2 Rust — one new query command, one new import command

```rust
/// Structured web hit for the UI. The agent keeps its flattened text
/// rendering; this struct is the source of truth both derive from.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebHit {
    pub title: String,
    pub url: String,
    pub engines: Vec<String>,
    pub date: Option<String>,
    pub snippet: Option<String>,
    pub score: f32,
}

#[tauri::command]  // require_web_enabled (master switch only — user action)
async fn browser_search(query: String) -> Result<SearchPage, String>
// SearchPage { hits: Vec<WebHit>, merged: u32, took_ms: u32, cached: bool }
```

- **Cache becomes structured.** `web_searches.results_text` starts storing the JSON `Vec<WebHit>`; the agent's `web_search` arm renders its numbered list *from* the JSON at read time (same output text, one cache). Shared 15-min TTL means: user searches in the address bar, then asks the assistant → the agent's `web_search` is a cache hit with the *"from this Mac's cache"* step chip. That continuity is free and delightful.
- **Journal.** New kind `search` in the browse journal (`journal(app, "search", "", query)`)— the journal is already the explicit, user-clearable audit surface that records opened URLs; searches belong in the same ledger.
- Keep `WEB_SEARCH_LIMIT` at 10 for the agent; the UI asks for 12 (schema default).

```rust
#[tauri::command]  // require_web_enabled
async fn import_search_result(app: AppHandle, url: String, title: String)
    -> Result<FileMeta, String>
```

One funnel, three branches (all existing machinery):
1. **YouTube URL** → `web::youtube_transcript` (captions), as `import_link_impl` does today.
2. **Readable page** → `web::fetch_readable` (guarded, un-truncated, charset-correct) → Markdown `# {title}\n\nSource: {url}\nSaved: {date}\n\n{text}` → `insert_file_from_url(…, source="web", origin_url=Some(url))`.
3. **Non-text content type** (PDF, media) → `web::download_to_temp` → `import_download` (existing 800 MB cap, extraction + MarkItDown, OCR/STT lanes, `origin_url` set). The + button therefore works on a result that points at a PDF.

Then — closing three latent gaps the exploration found, for *all* page-path imports (this command, `import_link_impl`, `capture_and_save`, `#research`):
- call `schedule_auto_index` + `schedule_privacy_scan` (today only `import_download` does);
- `import_link_impl` switches `insert_file` → `insert_file_from_url` so `save_link` files get `origin_url` too;
- add `origin_url` to `FILE_META_COLS` + `FileMeta` (+ apiTypes) — the column is populated and never read; the UI needs it for provenance chips ("from boi.org.il") on file rows and future source chips.

Emit `room-files-changed`; journal `save`.

### 4.3 What "available to the agent" means (two layers)

1. **Guaranteed, this turn:** on import success the frontend calls the existing `toggleAttach(meta)` — the file becomes a composer attachment chip, and `ask` injects its text verbatim (`[attached file: name]…`) into the next turn. The + button's promise — "the text found at the link is available to the agent" — is literal.
2. **Durable, every later turn:** the file is chunked into FTS + embeddings like any room file → surfaces via the system-prompt inventory, the 6 RAG excerpts, `search_room`, `open_file`, `start_file_pass`. The `Source: {url}` line in the body lets the model cite the origin.

No new agent tools. No sidecar catalog changes. `MAX_BOX_TOOLS` untouched.

---

## 5. The page itself — UX spec

Full visual spec is the mockup; this is the behavioral contract. Everything below is in normal flow (chrome rows and flex siblings — the Save-strip pattern), nothing overlays the stage.

### Zones, top to bottom

1. **Query header.** The query in display type; under it the *consensus line*: `7 engines · 31 hits merged into 12 · 1.8s · only your query left this Mac`. The privacy clause is part of the header, not a footnote — it is the product.
2. **Ask-the-room card.** One slim card: *"Ask the assistant about this"* — prefills the composer with the query, reveals chat, focuses it. (v1 = prefill only; the shared search cache makes the agent's follow-up `web_search` free.)
3. **Result cards** (the mockup's centerpiece). **Layout is a relevance bento, not a list** — the fusion score sets the card tier: hit #1 is a full-width feature card with a large preview image; hits #2–3 are a two-up row of medium image-topped cards; the rest are compact rows with square thumbs. Google renders every hit at identical weight; here the layout itself encodes the ranking. Each card:
   - **preview image** from the enrich pass (§6), monogram tile as the designed fallback,
   - rank ordinal (faint, tabular-nums),
   - title (the link), readable breadcrumb URL (`boi.org.il › en › markets`),
   - snippet when present (2-line clamp),
   - meta row: **engine dots** — one dot per engine that returned this URL, colored per engine, `title` tooltip names them ("duckduckgo · brave · wikipedia"). Date chip when known (news hits). Thin relevance bar (score, relative to the page's max).
   - actions (visible on hover *and* on keyboard selection, always visible on the selected card): **Open** (whole card is the click target), **⧉ New tab**, **Peek**, **＋ Add to chat**.
4. **Footer strip.** `Searched privately · no account, no profile, no click tracking · engines: duckduckgo brave mojeek marginalia wikipedia ddg-ia news`.

### Keyboard (page is fully drivable without the mouse)

| Key | Action |
|---|---|
| `↓/↑` or `j/k` | move selection |
| `Enter` | open selected (same tab) |
| `⌘Enter` | open in new tab (respects MAX_TABS=8 refusal honestly) |
| `p` | toggle peek |
| `a` or `+` | add to chat |
| `/` | focus the address bar |
| `Esc` | back to the page under the results (if one is loaded) |

### Peek (on-demand reader preview)

Expanding a card fetches the page through the guarded Rust fetch into the existing `web_pages` 24-h cache and shows the first ~1,200 chars of readable text inline, with an explicit one-time marker: *"fetched just now — this URL left this Mac"*. **No auto-prefetch of result pages, ever** — contacting ten sites the user never chose contradicts the header's privacy claim. Peek state lives in the session; re-peek is a cache hit.

(Adjacent fix worth taking while in there: `MAX_PAGE_CHARS`=12,000 makes the agent's `FETCH_PAGE_WINDOW`=40,000 pagination unreachable — raise the cap to 40k so the declared protocol can actually fire. Pre-existing, found during this exploration.)

### Add-to-chat micro-states

`＋` → spinner ("Sealing into the room…", the download job's vocabulary) → ✓ flip, card gains an **`In room · attached to chat`** chip; the composer chip appears simultaneously (same `room-files-changed` + `toggleAttach` moment). Error → honest inline message on the card (e.g. the 800 MB refusal text verbatim), never a toast the user can miss.

### States

- **Loading:** header renders immediately with the query + skeleton cards (no spinner-only screen); engines that have already answered tick up the consensus line.
- **Empty:** "No results across 7 engines." + suggestions (retry, edit query, open as URL if it was host-ish).
- **Error:** sidecar down → the existing honest message ("The local AI engine isn't running…").
- **Offline room:** the search submit path shows the existing offline error; the start screen already explains the switch.
- **Reduced motion:** stagger/entrance animations collapse to opacity only.

### Motion (one orchestrated moment, quiet elsewhere)

Cards enter with a 30 ms stagger, translate-y 4px + fade; the relevance bars fill once on entry. Peek expands with height auto-animation; the ＋→✓ flip is a 200 ms rotation. Everything honors `prefers-reduced-motion`.

---

## 6. Per-result preview images — the enrich pass (BROWSE-3b, v2)

> Owner direction 2026-08-01: results should carry **the page's own preview image**, the way Google's results do. A separate image-search vertical (strip / Images mode / entity card) was proposed and **rejected** — don't rebuild it.

Google's thumbnails come from its crawl. Arcelle has no crawl — so the thumbnails come from a **guarded enrich pass** that runs right after the hits render:

1. For the top **8** hits (concurrency 4), Rust fetches the result page through the existing guarded client — SSRF-checked, DNS-pinned, **HTML only, first 256 KB**, and structurally cookie-less/script-less/referrer-less (it's `reqwest`, not a browser: nothing executes, nothing identifies).
2. From that HTML it extracts: `og:image` / `twitter:image` (falling back to the first large `<img>`), `<link rel="icon">`, `<meta name="description">`, and the readable text.
3. The preview image (and favicon) are fetched through the same guard — content-type `image/*`, **200 KB cap** — and handed to React as **data URLs**. The webview itself performs zero network requests; no origin ever sees a browser fingerprint from rendering results.
4. Caching: page text/HTML into the existing `web_pages` (24 h — its unused `raw_html` column finally earns its keep); image bytes into a new `web_images(url PK, bytes, mime, saved_at)` table, 24 h TTL.

What the one pass buys beyond thumbnails:
- **Snippet upgrade** — the page's own `meta description` replaces the engine snippet when present (first-party, better written).
- **Peek becomes instant** — the readable text is already cached when the user expands.
- **Favicons solved as a by-product** — real icons for enriched hits, monogram tiles for the rest.

**Progressive, never blocking:** cards paint immediately with monogram tiles and engine snippets; images fade in as enrichment lands, into fixed slots (no layout shift). Roughly 20–40 % of pages have no usable `og:image` — the monogram tile is the designed fallback state, not an error.

**Disclosure + control:** the header carries *"previews fetched privately — no cookies, no scripts"*, and a per-room setting `web_result_previews` turns the pass off. Default **ON** — precedent: `#research` already auto-fetches the top 4 result pages as part of a user-initiated action, with step-chip disclosure. With previews OFF: monogram tiles, engine snippets, on-demand Peek, and no origin is contacted until the user explicitly acts.

**Rejected paths:** third-party thumbnail/favicon services (leak the result list to a new party); putting raw `<img src="https://…">` into the view (the webview would hit origins with full browser fingerprints — every byte goes through the Rust client instead).

**＋ on a preview image** is not a separate feature — the card's ＋ imports the *page*; if the user wants the image itself in the room, that's the existing `download_url` path from the opened page.

---

## 7. Navigation mechanics

- **Opening a result (same tab):** `session.visible = false`, then `browserNavigate(url)`. The webview un-parks on the next `pushBounds` tick (≤250 ms; `go()`-style forced `refresh()` makes it immediate).
- **◂ Back to results:** whenever the active page has a session with `visible=false`, the chrome shows a slim normal-flow row (Save-strip pattern): `◂ Results — “{query}”`. Clicking sets `visible=true` → predicate parks the webview → React shows the still-warm session (scroll preserved — it never unmounted, it was `display`-gated). No navigation, no re-fetch, no history entry. This sidesteps the `about:blank`/`is_recordable_url` recording subtleties entirely — we never navigate back to blank.
- **New search over results:** address bar submit re-runs the classifier; a search replaces the session for that page (the previous query is gone — no history, by doctrine).
- **Tab title:** the Workspace reconciler (the 1200 ms sync that retitles page tabs from Rust) consults `searches`: if the Rust page is blank and a session exists → title = query (`🔍`-less, plain). The moment a real URL is recorded, host-title wins as today. Address bar shows the query while results are visible.
- **Start screen upgrade:** the start screen gains a centered search field (same classifier) under the existing identity copy — it currently *tells* the user to go type in the address bar; now it can just be the box.
- **Session lifetime:** dies with its page tab (`prune`), on room switch, and on app quit. Never serialized. The browse journal (`search` kind) is the only trace, and it is the user's explicit, clearable audit surface.

---

## 8. Privacy invariants (the checklist for review)

1. At search time, outbound traffic goes only to the engines. The query is the only payload. (Unchanged sidecar property; `resolve_dates=False` stays pinned.)
2. With previews **ON** (default), the top-N result pages are fetched at render time **through the guard** — cookie-less, script-less, referrer-less, size-capped, cached, disclosed in the header, and toggleable per room (`web_result_previews`). This is the same class of user-initiated fetching `#research` already performs. With previews **OFF**, no origin host is contacted until an explicit act (open / peek / add).
3. No third-party thumbnail or favicon service, ever — that would hand the result list to a new party. Every image byte enters through the Rust guarded client (`image/*` only, 200 KB cap) and reaches the view as a data URL: the results page itself performs zero network requests, so no origin ever sees a browser fingerprint from a render. (Optional later: guarded first-party `/favicon.ico` fetch *only for hosts the user has visited or peeked*, new `web_icons(host, bytes, mime, saved_at)` table.)
4. Failed navigation never auto-converts to a search — recovery is a labeled button.
5. Queries are never persisted outside the 15-min cache + the user-clearable journal; sessions are memory-only.
6. Queries never appear in sidecar logs (existing SPEC §6 invariant, unchanged).
7. The redaction door is not in this path by design: the user typed the query themselves; no room content is being composed by a model. (Same reasoning as the owner's address-bar/lanes decision, 2026-07-30.)

---

## 9. Implementation plan

**Stage A — sidecar (½ day):** snippet capture in 6 engines; `engines` list + `merged`/`tookMs` in fusion + route; tests (`test_websearch.py` shape tests, snippet-survives-dedup, consensus-ordering).

**Stage B — Rust (1–1½ days):** the enrich pass — `browser_enrich(urls)` (guarded HTML fetch 256 KB + og:image/description/icon extraction) + `browser_thumb` (guarded, image/*-only, 200 KB cap, concurrency 4) + `web_images` cache table + `web_result_previews` setting; `WebHit`/`SearchPage`; `browser_search` cmd + JSON cache migration (render agent text from JSON; idempotent migration for old `results_text` rows = just let them expire — 15-min TTL); `import_search_result` funnel + the three page-path gap fixes (`schedule_auto_index`/`schedule_privacy_scan`, `origin_url` in `import_link_impl`, `FILE_META_COLS`+`FileMeta`); journal `search` kind; register commands; raise `MAX_PAGE_CHARS` 12k→40k. Tests: funnel branches (readable / PDF / YouTube / oversize), cache round-trip, gating.

**Stage C — frontend (2 days):** the relevance-bento layout (feature / two-up / compact tiers) + progressive image fade-in with fixed slots + previews toggle in Settings; `classifyAddress` + unit tests; `SearchSession` state + actions; results view component + `browser.css` additions (all tokens, both themes); parking-predicate extension; ◂ Results row; error-banner "Search instead" button; tab-title consult; start-screen search field; composer auto-attach; `api.ts` (`browserSearch`, `importSearchResult`) + `apiTypes.ts`.

**Stage D — QA:** UA-FEATURE-CHECKLIST additions (classifier table, keyboard map, +-button states, back-to-results, offline/error rows); `qa-mock.js` handlers for the two new commands; e2e_live smoke (`ARCELLE_E2E=1`): real search → peek → add → file exists with `origin_url` → attachment chip present.

**Deferred, explicitly:** favicon fetch + `web_icons`; structured `Message.sources` (URL-carrying chips — `origin_url` in `FileMeta` is the stepping stone); search-as-you-type suggestions (would need a keystroke-level outbound stream — privacy review first); image/news search verticals (proposed 2026-08-01, owner rejected — revisit only on demand); agent-facing image tooling.

---

## 10. Risks & open questions

- **og:image coverage is partial** (roughly 60–80 % of real pages) — the monogram fallback must read as designed, not broken; the mockup demonstrates a fallback card on purpose. The enrich pass adds ~1–2 s of trailing network after first paint — progressive fade-in, never blocking, fixed image slots so nothing shifts.

- **Engine snippet quality varies** (Marginalia's are odd, news RSS descriptions are long) — clamp to 2 lines, treat as optional; the page must look complete snippet-less (cards degrade to title+URL+consensus, which the mockup demonstrates).
- **Blank-page bounds stickiness:** a page created while results are parked reads 1×1 bounds for ≤250 ms (`browser.rs:415` cache) — same latent behavior the start screen has today; the forced `refresh()` on open makes it invisible in practice. No new work, just noting it's understood.
- **8-tab cap vs ⌘Enter:** refusal must surface honestly on the card ("8 pages open — close one first"), not silently no-op.
- **Hebrew/RTL queries:** header and cards must set `dir="auto"`; snippets from Hebrew pages already decode correctly (`windows-1255` handling exists in fetch).
