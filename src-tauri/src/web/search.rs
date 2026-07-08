use super::*;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        // A generic UA, no cookies: pages get fetched, not browsed.
        .user_agent("Mozilla/5.0 (Macintosh) PrivateRoom/0.1")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn clean_fragment(html: &str) -> String {
    extraction::strip_html(html)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse DuckDuckGo's HTML results page: title anchors carry
/// class="result__a" and a redirect href whose `uddg` param is the real URL.
fn parse_duckduckgo_html(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut pos = 0;
    while hits.len() < 5 {
        let Some(rel) = html[pos..].find("class=\"result__a\"") else { break };
        let cls = pos + rel;
        let tag_start = html[..cls].rfind("<a").unwrap_or(cls);
        let Some(gt_rel) = html[tag_start..].find('>') else { break };
        let tag_end = tag_start + gt_rel;
        let tag = &html[tag_start..tag_end];
        let href = tag
            .split("href=\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .unwrap_or("");
        let Some(close_rel) = html[tag_end..].find("</a>") else { break };
        let title = clean_fragment(&html[tag_end + 1..tag_end + close_rel]);
        pos = tag_end + close_rel + 4;
        let url = if let Some(uddg) = href.split("uddg=").nth(1) {
            percent_decode(uddg.split('&').next().unwrap_or(""))
        } else if let Some(rest) = href.strip_prefix("//") {
            format!("https://{rest}")
        } else {
            href.to_string()
        };
        // y.js redirects are sponsored results.
        if url.is_empty() || url.contains("duckduckgo.com/y.js") {
            continue;
        }
        let snippet = html[pos..]
            .find("result__snippet")
            .map(|srel| {
                let s = pos + srel;
                let body = html[s..].find('>').map(|g| s + g + 1).unwrap_or(s);
                let end = html[body..]
                    .find("</a>")
                    .or_else(|| html[body..].find("</td>"))
                    .or_else(|| html[body..].find("</div>"))
                    .map(|e| body + e)
                    .unwrap_or(body);
                clean_fragment(&html[body..end])
            })
            .unwrap_or_default();
        hits.push(SearchHit { title, url, snippet });
    }
    hits
}

/// Free web search with no account or API key: DuckDuckGo's plain-HTML
/// results page. Unofficial — occasional rate limits are surfaced clearly.
pub async fn search_duckduckgo(query: &str) -> Result<Vec<SearchHit>, String> {
    let resp = client()?
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query)])
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| format!("DuckDuckGo request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "DuckDuckGo returned HTTP {} — it rate-limits occasionally; try again in a minute.",
            resp.status()
        ));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let hits = parse_duckduckgo_html(&html);
    if hits.is_empty() && (html.contains("anomaly") || html.contains("challenge")) {
        return Err(
            "DuckDuckGo is asking for a human check right now — try again in a few minutes."
                .into(),
        );
    }
    Ok(hits)
}

pub async fn search_searxng(endpoint: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    let base = endpoint.trim_end_matches('/');
    let resp = client()?
        .get(format!("{base}/search"))
        .query(&[("q", query), ("format", "json")])
        .send()
        .await
        .map_err(|e| format!("SearXNG request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!(
            "SearXNG error ({status}). The instance must allow the json format \
             (settings.yml: search.formats includes json)."
        ));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let hits = v["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(5)
                .map(|r| SearchHit {
                    title: r["title"].as_str().unwrap_or("(untitled)").to_string(),
                    url: r["url"].as_str().unwrap_or_default().to_string(),
                    snippet: r["content"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_duckduckgo_results() {
        let html = r##"
        <div class="result">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Title</b></a>
          <a class="result__snippet" href="#">A short <b>snippet</b> here.</a>
        </div>
        <div class="result">
          <a rel="nofollow" class="result__a" href="https://plain.example.org/x">Second</a>
          <td class="result__snippet">Other snippet</td>
        </div>"##;
        let hits = parse_duckduckgo_html(html);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://example.com/page");
        assert!(hits[0].title.contains("Example Title"), "{}", hits[0].title);
        assert!(hits[0].snippet.contains("A short snippet"), "{}", hits[0].snippet);
        assert_eq!(hits[1].url, "https://plain.example.org/x");
    }

    #[test]
    fn percent_decodes() {
        assert_eq!(percent_decode("https%3A%2F%2Fa.b%2Fc+d"), "https://a.b/c d");
    }
}
