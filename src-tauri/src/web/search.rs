use super::*;

/// The room's ONE search provider lives in the sidecar
/// (`arcelle_sidecar/websearch.py`): it queries a fixed set of engines and fuses
/// them into a single relevance ranking. Rust holds no scraper of its own any
/// more — there is nothing to pick between, so nothing here dispatches.
///
/// Budget: a fused search is seven engines in sequence (~3-5s warm from a clean
/// IP), and every one of them can time out on its own. 4 minutes covers the
/// worst case where most of them hang, while still being far short of the
/// 10-minute generation budget — a search must not be able to hold a turn open
/// that long.
const WEB_SEARCH_TIMEOUT: Duration = Duration::from_secs(240);

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

/// Free multi-engine web search with no account or API key. Never returns a
/// partial failure: a blocked or rotted engine drops out silently on the Python
/// side and the rest of the fusion still answers, so an empty result here means
/// "no results", not "one scraper broke".
pub async fn search_web(query: &str) -> Result<Vec<WebHit>, String> {
    Ok(search_page(query, WEB_SEARCH_LIMIT).await?.hits)
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
}
