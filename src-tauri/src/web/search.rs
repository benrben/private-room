use super::*;

/// The room's ONE search provider lives in the sidecar
/// (`arcelle_sidecar/websearch.py`): it queries a fixed set of engines and fuses
/// them into a single relevance ranking. Rust holds no scraper of its own any
/// more — there is nothing to pick between, so nothing here dispatches.
///
/// The sidecar's own overall fan-out deadline (`websearch.FANOUT_BUDGET`),
/// mirrored here because this timeout only makes sense relative to it. Keep the
/// two in step: the engines run CONCURRENTLY and everything still running when
/// this expires simply does not contribute, so the sidecar cannot take longer
/// than this to answer /web_search however many engines hang.
const SIDECAR_FANOUT_BUDGET: Duration = Duration::from_secs(22);

/// Budget: the sidecar answers within [`SIDECAR_FANOUT_BUDGET`] by construction,
/// so this only has to cover that plus the request itself and a cold sidecar
/// wake. It used to be 4 minutes, sized for a design where the engines ran one
/// after another and the wall clock was the SUM of seven timeouts. They have run
/// in parallel since 2026-08-01, so those 4 minutes could only ever be reached
/// by a sidecar that had stopped answering at all — and then the user watched a
/// dead "Searching…" for 218 seconds longer than there was anything to wait for.
const WEB_SEARCH_TIMEOUT: Duration = Duration::from_secs(60);

/// How many fused hits to ask for. The old single-engine scrapers took 5; the
/// fused ranking is worth a few more, since cross-engine agreement means the top
/// of the list is better sorted than any one engine's page-1 order.
const WEB_SEARCH_LIMIT: u32 = 10;

/// BROWSE-3: the browser's results page asks for a couple more than the model
/// does — a page of cards can show twelve without costing anyone a context
/// window, and the tail is where the long-shot sources live.
const BROWSER_SEARCH_LIMIT: u32 = 12;

/// One line of provenance per hit: which engine surfaced it (and how many
/// agreed), the date when known, and its fused relevance. Honest about what it
/// is — the model is told (WEB_PROMPT) that a search result is not a source and
/// that it must `fetch_page` to actually read one, which is literally true.
fn provenance(hit: &WebHit) -> String {
    let mut parts = vec![match hit.engines.len() {
        0 | 1 => format!("via {}", hit.source()),
        n => format!("via {} +{} more", hit.source(), n - 1),
    }];
    if let Some(date) = hit.date.as_deref().filter(|d| !d.is_empty()) {
        parts.push(date.to_string());
    }
    parts.push(format!("relevance {:.2}", hit.score));
    parts.join(" · ")
}

/// The numbered list the model reads for a `web_search` tool result. Lives here
/// rather than in the tool arm so a cache hit and a live search render through
/// the same code — the cache stores hits now, not pre-rendered text (BROWSE-3).
pub fn render_hits(hits: &[WebHit]) -> String {
    hits.iter()
        .enumerate()
        .map(|(i, h)| {
            let snippet = h
                .snippet
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| format!("\n   {s}"))
                .unwrap_or_default();
            format!(
                "{}. {}\n   {}{snippet}\n   {}",
                i + 1,
                h.title,
                h.url,
                provenance(h)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Join engine names for a sentence a person reads: "brave and mojeek",
/// "brave, mojeek and marginalia".
pub fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Free multi-engine web search with no account or API key.
///
/// Returns the whole page, not just the hits, because a caller MUST be able to
/// tell an empty web from a blocked one. This used to hand back a bare
/// `Vec<WebHit>` and document that an empty result meant "no results, not one
/// scraper broke" — the opposite of what the fusion actually reports, and a
/// claim contradicted by any day on which two engines answer 403 and 429.
pub async fn search_web(query: &str) -> Result<SearchPage, String> {
    search_page(query, WEB_SEARCH_LIMIT).await
}

/// The browser's results page (BROWSE-3) — a dozen hits with the fusion's own
/// counters attached.
pub async fn search_for_browser(query: &str) -> Result<SearchPage, String> {
    search_page(query, BROWSER_SEARCH_LIMIT).await
}

/// [`search_web`] keeping the fusion's own bookkeeping — how many raw hits were
/// merged and how long the whole fan-out took. The results page shows both; the
/// agent path ignores them.
pub async fn search_page(query: &str, limit: u32) -> Result<SearchPage, String> {
    let body = serde_json::json!({ "query": query, "limit": limit });
    let value = crate::sidecar::sidecar_json_timeout("/web_search", &body, WEB_SEARCH_TIMEOUT)
        .await
        .map_err(|e| match e.code.as_str() {
            // This endpoint has no model in it, so the generation sentinels would
            // be nonsense to whoever reads this string (the model, or a Settings
            // toast). Say what actually went wrong instead.
            "OLLAMA_DOWN" => {
                "The local AI engine isn't running, so web search is unavailable.".to_string()
            }
            _ => format!("Web search failed: {}", e.error),
        })?;
    Ok(SearchPage {
        hits: parse_hits(&value),
        merged: value["merged"].as_u64().unwrap_or(0) as u32,
        took_ms: value["tookMs"].as_u64().unwrap_or(0) as u32,
        cached: false,
        failed: value["failed"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(|n| n.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Map the sidecar's fused hits onto [`WebHit`]. Tolerant by design: a missing
/// `engines` list falls back to the legacy single `source` key, so a host
/// running an older sidecar degrades to one-engine hits instead of erroring.
fn parse_hits(value: &serde_json::Value) -> Vec<WebHit> {
    value["hits"]
        .as_array()
        .map(|hits| {
            hits.iter()
                .map(|hit| {
                    let engines: Vec<String> = hit["engines"]
                        .as_array()
                        .map(|list| {
                            list.iter()
                                .filter_map(|e| e.as_str())
                                .map(str::to_string)
                                .collect()
                        })
                        .filter(|list: &Vec<String>| !list.is_empty())
                        .unwrap_or_else(|| {
                            hit["source"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .map(|s| vec![s.to_string()])
                                .unwrap_or_default()
                        });
                    let text = |key: &str| {
                        hit[key]
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    };
                    WebHit {
                        title: match hit["title"].as_str().unwrap_or_default().trim() {
                            "" => "(untitled)".to_string(),
                            title => title.to_string(),
                        },
                        url: hit["url"].as_str().unwrap_or_default().to_string(),
                        engines,
                        date: text("date"),
                        snippet: text("snippet"),
                        score: hit["score"].as_f64().unwrap_or(0.0),
                    }
                })
                .filter(|hit| !hit.url.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_timeout_tracks_the_sidecar_fan_out_budget() {
        // The host's wait described a design that no longer exists (seven
        // engines in sequence) and was 11x the deadline the sidecar actually
        // enforces, so a wedged sidecar showed "Searching…" for four minutes.
        // Room for the request, a cold sidecar wake and slack — not a multiple.
        assert!(
            WEB_SEARCH_TIMEOUT > SIDECAR_FANOUT_BUDGET,
            "the host must outwait the fan-out it is waiting for"
        );
        assert!(
            WEB_SEARCH_TIMEOUT <= SIDECAR_FANOUT_BUDGET * 3,
            "waiting past ~3x the sidecar's own deadline is waiting for nothing"
        );
    }

    fn hit(engines: &[&str], date: Option<&str>, score: f64) -> WebHit {
        WebHit {
            title: "T".into(),
            url: "https://example.com/a".into(),
            engines: engines.iter().map(|e| e.to_string()).collect(),
            date: date.map(str::to_string),
            snippet: None,
            score,
        }
    }

    #[test]
    fn provenance_names_the_engine_and_relevance() {
        assert_eq!(
            provenance(&hit(&["mojeek"], None, 0.874)),
            "via mojeek · relevance 0.87"
        );
    }

    #[test]
    fn provenance_includes_a_date_when_the_engine_knows_one() {
        assert_eq!(
            provenance(&hit(&["news"], Some("2026-07-06"), 0.9)),
            "via news · 2026-07-06 · relevance 0.90"
        );
    }

    #[test]
    fn provenance_skips_an_empty_date() {
        assert_eq!(
            provenance(&hit(&["brave"], Some(""), 0.5)),
            "via brave · relevance 0.50"
        );
    }

    /// Cross-engine agreement is the fusion's best signal, so the model is told
    /// about it too — not only the browser's consensus dial.
    #[test]
    fn provenance_counts_the_agreeing_engines() {
        assert_eq!(
            provenance(&hit(&["duckduckgo", "brave", "mojeek"], None, 0.8)),
            "via duckduckgo +2 more · relevance 0.80"
        );
    }

    #[test]
    fn a_hit_with_no_engines_still_names_a_source() {
        assert_eq!(hit(&[], None, 0.1).source(), "web");
    }

    #[test]
    fn parse_reads_the_fused_shape() {
        let v = serde_json::json!({"hits": [{
            "title": " Bank ", "url": "https://boi.org.il/",
            "engines": ["wikipedia", "brave"], "date": "2026-07-06",
            "snippet": " the central bank ", "score": 0.91,
        }]});
        let hits = parse_hits(&v);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Bank");
        assert_eq!(hits[0].engines, vec!["wikipedia", "brave"]);
        assert_eq!(hits[0].snippet.as_deref(), Some("the central bank"));
    }

    /// An older sidecar has no `engines` key — the hit must still carry its one
    /// engine rather than arriving anonymous.
    #[test]
    fn parse_falls_back_to_the_legacy_source_key() {
        let v = serde_json::json!({"hits": [{
            "title": "T", "url": "https://a.com/", "source": "mojeek", "score": 0.4,
        }]});
        assert_eq!(parse_hits(&v)[0].engines, vec!["mojeek"]);
    }

    #[test]
    fn parse_drops_hits_with_no_url() {
        let v = serde_json::json!({"hits": [
            {"title": "T", "url": "", "source": "brave"},
            {"title": "U", "url": "https://a.com/", "source": "brave"},
        ]});
        assert_eq!(parse_hits(&v).len(), 1);
    }

    #[test]
    fn parse_blanks_an_empty_snippet_rather_than_keeping_it() {
        let v = serde_json::json!({"hits": [{
            "title": "T", "url": "https://a.com/", "source": "brave", "snippet": "   ",
        }]});
        assert!(parse_hits(&v)[0].snippet.is_none());
    }

    /// The model's list carries the snippet when one exists — a title and a URL
    /// alone make every result look equally plausible.
    #[test]
    fn render_puts_the_snippet_between_url_and_provenance() {
        let mut h = hit(&["brave"], None, 0.5);
        h.snippet = Some("A short description.".into());
        assert_eq!(
            render_hits(&[h]),
            "1. T\n   https://example.com/a\n   A short description.\n   via brave · relevance 0.50"
        );
    }

    #[test]
    fn render_omits_the_snippet_line_when_there_is_none() {
        assert_eq!(
            render_hits(&[hit(&["brave"], None, 0.5)]),
            "1. T\n   https://example.com/a\n   via brave · relevance 0.50"
        );
    }

    // --- Which engines could not answer -----------------------------------
    //
    // The fan-out has always reported this and this boundary used to drop it,
    // so a day on which mojeek returns 403 and brave returns 429 (an observed
    // day, in the sidecar log) was indistinguishable from a quiet web.

    fn page(hits: Vec<WebHit>, failed: &[&str]) -> SearchPage {
        SearchPage {
            merged: hits.len() as u32,
            hits,
            took_ms: 5,
            cached: false,
            failed: failed.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn the_engines_that_could_not_answer_survive_the_boundary() {
        let v = serde_json::json!({
            "hits": [], "merged": 0, "tookMs": 12, "failed": ["mojeek", "brave"],
        });
        // parse_hits covers the hits; this is the field that had no reader at all.
        let failed: Vec<String> = v["failed"]
            .as_array()
            .map(|n| n.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        assert_eq!(failed, vec!["mojeek", "brave"]);
    }

    #[test]
    fn a_fully_healthy_search_says_nothing_about_engines() {
        assert!(page(vec![hit(&["brave"], None, 0.5)], &[]).blocked_note().is_none());
    }

    #[test]
    fn a_partial_search_warns_that_the_results_are_incomplete() {
        let note = page(vec![hit(&["brave"], None, 0.5)], &["mojeek", "marginalia"])
            .blocked_note()
            .expect("engines were blocked");
        assert!(note.contains("mojeek and marginalia"), "{note}");
        assert!(note.contains("only part of the web"), "{note}");
    }

    #[test]
    fn engine_names_read_as_a_sentence_not_a_debug_list() {
        assert_eq!(join_names(&[]), "");
        assert_eq!(join_names(&["brave".into()]), "brave");
        assert_eq!(join_names(&["brave".into(), "mojeek".into()]), "brave and mojeek");
        assert_eq!(
            join_names(&["brave".into(), "mojeek".into(), "ddg".into()]),
            "brave, mojeek and ddg"
        );
    }
}
