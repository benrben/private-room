//! BROWSE-3: the address bar's second half.
//!
//! Typing something that isn't a URL used to produce `Invalid URL:
//! https://best pizza nyc`. It now runs a real search and renders an
//! Arcelle-native results page — the same fused engines the assistant uses, so
//! the user and the model are looking at the same web.
//!
//! Three commands, in the order the page uses them:
//!
//! 1. [`browser_search`] — the hits, structured, sharing the assistant's own
//!    15-minute cache (so a search typed here makes the model's next
//!    `web_search` free, and vice versa).
//! 2. [`browser_preview`] — the enrich pass: read a result page for its own
//!    preview image, description and text. Progressive, never blocking, and
//!    switchable off per room.
//! 3. [`browser_search_summary`] — an optional one-paragraph answer written by
//!    the room's own engine from the fetched sources, with the results it used
//!    cited by number.
//!
//! What the page never does is make a network request of its own: every byte,
//! including image bytes, arrives through the Rust guard and reaches the view as
//! a data URL. Nothing renders from an origin, so no origin sees a browser.

use super::*;

/// How many results the enrich pass will read per search. The page shows a
/// dozen; reading the top eight covers the feature card, the two-up row and the
/// first few rows — the ones a user actually looks at before scrolling.
const MAX_PREVIEWS: usize = 8;

/// How many previews may be in flight at once. Four keeps the pass under a
/// couple of seconds on a normal connection without opening a dozen sockets to
/// a dozen strangers at once.
const PREVIEW_CONCURRENCY: usize = 4;

/// Sources the summary is allowed to read. Three keeps the model's context
/// small and the wait short; the summary is an orientation, not a report.
const SUMMARY_SOURCES: usize = 3;

/// How much readable text an inline Peek shows. Enough to judge whether a
/// result is worth opening, not enough to be a reader — that is what opening
/// the page, or adding it to the room, is for.
const PEEK_CHARS: usize = 1_400;

/// How much of each source's text the summary call sees.
const SUMMARY_CHARS_PER_SOURCE: usize = 3_000;

/// Result previews are ON unless the room says otherwise (BROWSE-3b).
///
/// Absent means on, matching every other room setting here — and matching the
/// precedent `#research` already set, where a user-initiated action fetches the
/// top results' pages. With this off, no result origin is contacted until the
/// user opens, peeks or adds one.
pub(crate) fn result_previews_enabled(conn: &rusqlite::Connection) -> bool {
    db::get_setting(conn, "web_result_previews").as_deref() != Some("off")
}

/// What the results page renders (BROWSE-3). `summaryAvailable` tells the view
/// whether to offer the AI summary at all — a room with no engine configured
/// should not show a button that can only fail.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSearchResult {
    #[serde(flatten)]
    pub page: crate::web::SearchPage,
    pub query: String,
    pub previews_enabled: bool,
    pub summary_available: bool,
}

/// Run one search for the browser's results page.
///
/// Gated on the room's master internet switch exactly like `browser_navigate` —
/// this is the same address bar, and a room that reads "offline" must not reach
/// seven engines because the text had a space in it.
#[tauri::command]
pub async fn browser_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<BrowserSearchResult, String> {
    run_search(&app, &state, &query).await
}

/// The search itself, without the command wrapper.
///
/// Split out for `browse_open`: the Browser agent searches through THIS, so a
/// query the agent types and a query the user types share one gate, one cache
/// and one set of engines. Anything else would mean the agent looking at a
/// different web than the person watching it.
pub(crate) async fn run_search(
    app: &tauri::AppHandle,
    state: &AppState,
    query: &str,
) -> Result<BrowserSearchResult, String> {
    require_web_enabled(state)?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Type something to search for.".into());
    }
    // Serve a recent search from this Mac without touching the network. Shared
    // with the assistant's web_search cache on purpose: searching here warms the
    // model's next lookup, which is the whole point of one search path.
    let (cached, previews, has_model) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        (
            db::get_fresh_web_search(&room.conn, &query),
            result_previews_enabled(&room.conn),
            crate::commands::models::model_setting(&room.conn).is_some(),
        )
    };
    let page = match cached {
        Some(hits) => crate::web::SearchPage {
            merged: hits.len() as u32,
            hits,
            took_ms: 0,
            cached: true,
            // A cache hit replays hits that were actually found; whichever engines
            // were blocked when it was stored is not news about this search.
            failed: Vec::new(),
        },
        None => {
            let page = crate::web::search_for_browser(&query).await?;
            let guard = state.room.lock().unwrap();
            if let Some(room) = guard.as_ref() {
                let _ = db::put_web_search(&room.conn, &query, &page.hits);
            }
            page
        }
    };
    // The journal is the browser's audit surface and the user can clear it. A
    // search belongs in the same ledger as an opened page: it is the moment a
    // query left this Mac.
    if !page.cached {
        browser::journal(app, "search", "", &format!("Searched for \"{query}\""));
    }
    Ok(BrowserSearchResult {
        query,
        previews_enabled: previews,
        summary_available: has_model,
        page,
    })
}

/// How many results the Browser agent is shown. The page draws a dozen; the
/// agent is choosing ONE address to open, and a list it has to scroll past is
/// context spent on options it will not take.
const AGENT_HITS: usize = 6;

/// How much of a result's snippet the agent reads. Enough to tell two results
/// apart, not enough to answer from — the answer comes from the page.
const AGENT_SNIPPET_CHARS: usize = 180;

/// The results as the Browser agent reads them (BROWSE-3c).
///
/// Deliberately shaped as a NEXT STEP rather than as an answer. A model handed
/// a list of snippets will answer from the snippets — which is how a browser
/// agent ends up reporting a search engine's summary of a page as if it had
/// read the page. So each line leads with the address to open, and the closing
/// line names the tool that opens it.
pub(crate) fn format_hits_for_agent(result: &BrowserSearchResult) -> String {
    if result.page.hits.is_empty() {
        return format!(
            "No results across seven engines for \"{}\". Try different words — do NOT open a search engine to try again by hand.",
            result.query
        );
    }
    let mut out = format!("Searched the room's own engines for \"{}\":\n", result.query);
    for (i, hit) in result.page.hits.iter().take(AGENT_HITS).enumerate() {
        out.push_str(&format!("{}. {} — {}\n", i + 1, hit.title.trim(), hit.url));
        if let Some(snippet) = hit.snippet.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            out.push_str(&format!("   {}\n", clip(snippet, AGENT_SNIPPET_CHARS)));
        }
    }
    out.push_str(
        "Pick the one that answers the task and browse_open its URL, then browse_read it. \
         These snippets are the engines' words, not the page's — never report them as what a page says.",
    );
    out
}

/// One result's preview, as the page consumes it. Images arrive as data URLs
/// because the view must never fetch anything itself.
#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultPreview {
    pub url: String,
    pub image: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub title: Option<String>,
    /// True when the page was read but declares no preview image — the card
    /// shows its monogram tile and stops waiting.
    pub done: bool,
}

/// The enrich pass: read up to [`MAX_PREVIEWS`] result pages for their own
/// preview image, description and readable text (BROWSE-3b).
///
/// Never fails as a whole — a page that 404s, blocks us, or has no `<head>`
/// worth reading simply yields an empty preview, and its card keeps the
/// monogram tile it painted with. Runs after the results are on screen, so the
/// page is complete before this returns.
#[tauri::command]
pub async fn browser_preview(
    state: tauri::State<'_, AppState>,
    urls: Vec<String>,
) -> Result<Vec<ResultPreview>, String> {
    require_web_enabled(&state)?;
    {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        if !result_previews_enabled(&room.conn) {
            // Not an error: the room turned previews off, so every card keeps
            // its monogram tile and no origin is contacted.
            return Ok(Vec::new());
        }
    }
    let mut out: Vec<ResultPreview> = Vec::new();
    for batch in urls.iter().take(MAX_PREVIEWS).collect::<Vec<_>>().chunks(PREVIEW_CONCURRENCY) {
        let mut tasks = Vec::new();
        for url in batch {
            tasks.push(preview_one(state.inner(), (*url).clone()));
        }
        out.extend(futures_util::future::join_all(tasks).await);
    }
    Ok(out)
}

/// Read one page and fetch its preview image. Every failure degrades to "no
/// preview" — this runs for eight strangers' pages at once and must not be able
/// to fail a search.
async fn preview_one(state: &AppState, url: String) -> ResultPreview {
    let mut preview = ResultPreview { url: url.clone(), done: true, ..Default::default() };
    let Ok(page) = crate::web::fetch_preview(&url).await else {
        return preview;
    };
    preview.description = page.description;
    preview.title = page.title.clone();
    // The readable text is already in hand — cache it so a later Peek, or the
    // AI summary, costs nothing.
    if !page.text.trim().is_empty() {
        let guard = state.room.lock().unwrap();
        if let Some(room) = guard.as_ref() {
            let _ = db::save_web_page(
                &room.conn,
                &cache_key(&url),
                page.title.as_deref().unwrap_or_default(),
                &page.text,
            );
        }
    }
    if let Some(image_url) = page.image_url {
        preview.image = cached_data_url(state, &image_url).await;
    }
    if let Some(icon_url) = page.icon_url {
        preview.icon = cached_data_url(state, &icon_url).await;
    }
    preview
}

/// Fetch one image through the guard (or read it from the 24h cache) and encode
/// it for the view. `None` on any failure — a missing thumbnail is a monogram
/// tile, never an error message.
async fn cached_data_url(state: &AppState, url: &str) -> Option<String> {
    let cached = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| db::get_fresh_web_image(&room.conn, url))
    };
    let (mime, bytes) = match cached {
        Some(hit) => hit,
        None => {
            let fetched = crate::web::fetch_image(url).await.ok()?;
            let guard = state.room.lock().unwrap();
            if let Some(room) = guard.as_ref() {
                let _ = db::save_web_image(&room.conn, url, &fetched.0, &fetched.1);
            }
            fetched
        }
    };
    Some(data_url(&mime, &bytes))
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Add one search result to the room as a source (BROWSE-3).
///
/// The ＋ button. One funnel with three branches, all of them existing
/// machinery: a YouTube link saves its captions, an ordinary page saves a
/// readable Markdown copy, and anything that isn't text (a PDF, a media file)
/// goes through the binary download funnel with its 800 MB cap. Every branch
/// records `origin_url`, so the room remembers where the source came from.
#[tauri::command]
pub async fn import_search_result(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    title: String,
) -> Result<FileMeta, String> {
    require_web_enabled(&state)?;
    let checked = browse_guard_url(&url).await?;
    let meta = crate::commands::files::import_web_source(&app, state.inner(), &checked, &title).await?;
    browser::journal(&app, "save", &checked, &format!("Saved \"{}\" into the room", meta.name));
    Ok(meta)
}

/// Read one result's text for the inline Peek (BROWSE-3).
///
/// Usually free: the enrich pass has already cached this page, so expanding a
/// result costs nothing. On a miss it is one guarded fetch — and Peek is an
/// explicit act by the user, which is exactly the bar for contacting an origin.
#[tauri::command]
pub async fn browser_peek(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    require_web_enabled(&state)?;
    let key = cache_key(&url);
    let cached = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| db::get_fresh_web_page(&room.conn, &key))
    };
    if let Some((_, text)) = cached {
        if !text.trim().is_empty() {
            return Ok(clip(&text, PEEK_CHARS));
        }
    }
    let checked = browse_guard_url(&url).await?;
    let crate::web::FetchedPage { title, text, .. } = crate::web::fetch_page(&checked).await?;
    if text.trim().is_empty() {
        return Err("That page has no readable text to preview.".into());
    }
    {
        let guard = state.room.lock().unwrap();
        if let Some(room) = guard.as_ref() {
            let _ = db::save_web_page(&room.conn, &cache_key(&checked), &title, &text);
        }
    }
    Ok(clip(&text, PEEK_CHARS))
}

/// The AI summary above the results (owner request 2026-08-01).
///
/// Reads the top few results — from the page cache the enrich pass already
/// filled, so this is usually zero network — and asks the room's own engine for
/// one grounded paragraph. The prompt requires bracketed citations and forbids
/// anything the sources don't say, because a fabricated summary sitting above
/// real results is worse than no summary at all.
#[tauri::command]
pub async fn browser_search_summary(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<String, String> {
    require_web_enabled(&state)?;
    let (hits, model) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        (
            db::get_fresh_web_search(&room.conn, query.trim()),
            crate::commands::models::model_setting(&room.conn),
        )
    };
    let hits = hits.ok_or("Those results have expired — search again to summarize them.")?;
    let model = model.ok_or("No AI engine is set for this room.")?;

    // Gather the sources. The enrich pass has usually cached these already; a
    // miss falls back to one guarded fetch, and a source that won't load is
    // skipped rather than failing the summary.
    let mut sources: Vec<(usize, String, String)> = Vec::new();
    for (i, hit) in hits.iter().enumerate() {
        if sources.len() >= SUMMARY_SOURCES {
            break;
        }
        let key = cache_key(&hit.url);
        let cached = {
            let guard = state.room.lock().unwrap();
            guard.as_ref().and_then(|room| db::get_fresh_web_page(&room.conn, &key))
        };
        let text = match cached {
            Some((_, text)) if !text.trim().is_empty() => text,
            _ => match crate::web::fetch_page(&hit.url).await {
                Ok(crate::web::FetchedPage { title, text, .. }) => {
                    let guard = state.room.lock().unwrap();
                    if let Some(room) = guard.as_ref() {
                        let _ = db::save_web_page(&room.conn, &key, &title, &text);
                    }
                    text
                }
                Err(_) => continue,
            },
        };
        sources.push((i + 1, hit.title.clone(), clip(&text, SUMMARY_CHARS_PER_SOURCE)));
    }
    if sources.is_empty() {
        return Err("None of these results could be read, so there is nothing to summarize.".into());
    }
    let context = sources
        .iter()
        .map(|(n, title, text)| format!("[{n}] {title}\n{text}"))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let messages = vec![
        crate::ollama::ChatMessage::new("system", SUMMARY_PROMPT),
        crate::ollama::ChatMessage::new("user", format!("Question: {query}\n\nSources:\n\n{context}")),
    ];
    let text = crate::ollama::generate(
        &model,
        messages,
        Some(0.2),
        crate::commands::models::KEEP_ALIVE_WARM,
        None,
    )
    .await?;
    // A thinking model puts its private reasoning in `<think>…</think>` before
    // the answer, and `generate` hands the raw text back. Unstripped, the
    // monologue was rendered as the summary paragraph sitting above the real
    // results — the one place on the page that has to be trustworthy.
    let text = crate::ollama::strip_think_spans(&text).trim().to_string();
    if text.is_empty() {
        return Err("The engine returned nothing for this summary.".into());
    }
    Ok(text)
}

/// The summary's whole job is to be grounded: it sits directly above the real
/// results, so a confident sentence the sources don't support is worse than an
/// empty space. Citations are mandatory and hedging is explicitly allowed.
const SUMMARY_PROMPT: &str = "You summarize web search results for someone who has \
    not read them yet. Write ONE short paragraph (2-4 sentences) answering their question \
    using ONLY the numbered sources given. Cite every claim with its source number in \
    brackets, like [1] or [2]. If the sources disagree, say so. If they do not answer the \
    question, say plainly that they do not — never fill the gap from your own knowledge. \
    No preamble, no headings, no list: just the paragraph.";

/// The key a fetched page is cached under.
///
/// The search engine writes a URL one way (`https://example.com`) and
/// `reqwest::Url` normalizes it another (`https://example.com/`), so looking a
/// page up under the engine's spelling while filing it under the normalized
/// one meant the two never met: for every plain domain the Peek cache could
/// not be hit, and expanding the same result re-downloaded the page every
/// single time. One key, used by everything that reads or writes the cache.
///
/// Deliberately the LITERAL check only — no DNS — because this runs on the
/// cache-hit path, which must not touch the network. The full guard still runs
/// before anything is actually fetched.
fn cache_key(url: &str) -> String {
    crate::web::check_public_http_url(url)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| url.to_string())
}

/// Clip text to a char budget on a whitespace boundary where possible, so a
/// source never ends mid-word.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max).collect();
    match clipped.rfind(char::is_whitespace) {
        Some(at) if at > max / 2 => clipped[..at].to_string(),
        _ => clipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_short_text_whole() {
        assert_eq!(clip("hello there", 40), "hello there");
    }

    #[test]
    fn clip_breaks_on_whitespace_not_mid_word() {
        assert_eq!(clip("alpha beta gamma delta", 14), "alpha beta");
    }

    /// A single unbroken token longer than the budget still has to be cut, or
    /// the budget would not be a budget.
    #[test]
    fn clip_hard_cuts_when_there_is_no_break() {
        assert_eq!(clip(&"x".repeat(50), 10).chars().count(), 10);
    }

    #[test]
    fn data_url_carries_the_mime_and_base64() {
        assert_eq!(data_url("image/png", b"hi"), "data:image/png;base64,aGk=");
    }

    /// The whole point of the Peek cache is that expanding a result is free.
    /// It never was for a plain domain: the engine's spelling and the
    /// normalized one the fetch filed it under could not match.
    #[test]
    fn one_cache_key_serves_both_the_lookup_and_the_save() {
        // A bare domain as an engine writes it, and the same address after
        // `reqwest::Url` has normalized it, must land on one key.
        assert_eq!(cache_key("https://example.com"), cache_key("https://example.com/"));
        assert_eq!(cache_key("https://example.com"), "https://example.com/");
        // Case in the host is normalized too; the path is left alone.
        assert_eq!(cache_key("https://EXAMPLE.com/A"), "https://example.com/A");
        // Something the checker refuses is still a usable key rather than a
        // panic or a silent collapse to the empty string.
        assert_eq!(cache_key("not a url"), "not a url");
    }

    fn result_of(query: &str, hits: Vec<crate::web::WebHit>) -> BrowserSearchResult {
        BrowserSearchResult {
            query: query.to_string(),
            previews_enabled: true,
            summary_available: true,
            page: crate::web::SearchPage {
                merged: hits.len() as u32,
                hits,
                took_ms: 12,
                cached: false,
                failed: Vec::new(),
            },
        }
    }

    fn hit(title: &str, url: &str, snippet: Option<&str>) -> crate::web::WebHit {
        crate::web::WebHit {
            title: title.to_string(),
            url: url.to_string(),
            engines: vec!["duckduckgo".to_string()],
            date: None,
            snippet: snippet.map(str::to_string),
            score: 1.0,
        }
    }

    /// The agent's whole next move is `browse_open <one of these>`, so every
    /// line it reads has to carry an address it can pass straight back.
    #[test]
    fn the_agents_result_names_an_address_per_line() {
        let text = format_hits_for_agent(&result_of(
            "tallest building in europe",
            vec![
                hit("Lakhta Center", "https://en.wikipedia.org/wiki/Lakhta_Center", Some("462 m")),
                hit("Tallest in Europe", "https://example.org/list", None),
            ],
        ));
        assert!(text.contains("1. Lakhta Center — https://en.wikipedia.org/wiki/Lakhta_Center"));
        assert!(text.contains("462 m"));
        // A hit with no snippet still gets its line; it just has no second one.
        assert!(text.contains("2. Tallest in Europe — https://example.org/list"));
        assert!(text.contains("browse_open"));
    }

    #[test]
    fn the_agent_is_shown_a_shortlist_not_the_whole_page() {
        let hits: Vec<_> = (0..12)
            .map(|i| hit(&format!("Result {i}"), &format!("https://example.com/{i}"), None))
            .collect();
        let text = format_hits_for_agent(&result_of("q", hits));
        assert!(text.contains("https://example.com/5"));
        assert!(!text.contains("https://example.com/6"));
    }

    /// These two phrases are load-bearing ACROSS the language boundary: the
    /// sidecar's `chat.browse` spec lists them in `Flow.probe_unless`
    /// (sidecar/arcelle_sidecar/agents.py) to know that a `browse_open` ran
    /// without leaving a page behind it, and therefore not to fire the free
    /// `browse_snapshot` that could only fail. Reword them here and the probe
    /// silently starts failing again — so this test is the tripwire.
    #[test]
    fn the_agents_result_carries_the_phrases_the_sidecar_gates_its_probe_on() {
        let found = format_hits_for_agent(&result_of("q", vec![hit("T", "https://e.com", None)]));
        assert!(found.to_lowercase().contains("searched the room's own engines"));

        let empty = format_hits_for_agent(&result_of("q", vec![]));
        assert!(empty.to_lowercase().contains("no results across seven engines"));
    }

    /// Nothing found is a dead end for the SEARCH, not an invitation to go
    /// drive google.com by hand — which is exactly what a model does next
    /// unless the result says otherwise.
    #[test]
    fn an_empty_search_tells_the_agent_not_to_go_hunting() {
        let empty = format_hits_for_agent(&result_of("asdfqwer", vec![]));
        assert!(empty.contains("asdfqwer"));
        assert!(empty.to_lowercase().contains("do not open a search engine"));
    }

    /// The summary sits directly above the real results. A thinking model's
    /// private monologue rendered there is worse than no summary at all.
    #[test]
    fn the_summary_strips_the_models_private_reasoning() {
        let raw = "<think>Let me weigh source 1 against 2.</think>\nRates held steady [1].";
        assert_eq!(
            crate::ollama::strip_think_spans(raw).trim(),
            "Rates held steady [1]."
        );
    }
}
