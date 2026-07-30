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

/// One line of provenance per hit, in place of the result snippet the scraped
/// engines used to carry: which engine surfaced it, the date when the engine
/// knows one, and its fused relevance. Honest about what it is — the model is
/// told (WEB_PROMPT) that a search result is not a source and that it must
/// `fetch_page` to actually read one, which is now literally true.
fn provenance(source: &str, date: Option<&str>, score: f64) -> String {
    let mut parts = vec![format!("via {source}")];
    if let Some(date) = date.filter(|d| !d.is_empty()) {
        parts.push(date.to_string());
    }
    parts.push(format!("relevance {score:.2}"));
    parts.join(" · ")
}

/// Free multi-engine web search with no account or API key. Never returns a
/// partial failure: a blocked or rotted engine drops out silently on the Python
/// side and the rest of the fusion still answers, so an empty result here means
/// "no results", not "one scraper broke".
pub async fn search_web(query: &str) -> Result<Vec<SearchHit>, String> {
    let body = serde_json::json!({ "query": query, "limit": WEB_SEARCH_LIMIT });
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
    Ok(value["hits"]
        .as_array()
        .map(|hits| {
            hits.iter()
                .map(|hit| SearchHit {
                    title: match hit["title"].as_str().unwrap_or_default().trim() {
                        "" => "(untitled)".to_string(),
                        title => title.to_string(),
                    },
                    url: hit["url"].as_str().unwrap_or_default().to_string(),
                    snippet: provenance(
                        hit["source"].as_str().unwrap_or("web"),
                        hit["date"].as_str(),
                        hit["score"].as_f64().unwrap_or(0.0),
                    ),
                })
                .filter(|hit| !hit.url.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provenance_names_the_engine_and_relevance() {
        assert_eq!(
            provenance("mojeek", None, 0.874),
            "via mojeek · relevance 0.87"
        );
    }

    #[test]
    fn provenance_includes_a_date_when_the_engine_knows_one() {
        assert_eq!(
            provenance("news", Some("2026-07-06"), 0.9),
            "via news · 2026-07-06 · relevance 0.90"
        );
    }

    #[test]
    fn provenance_skips_an_empty_date() {
        assert_eq!(provenance("brave", Some(""), 0.5), "via brave · relevance 0.50");
    }
}
