//! First-party web access for the agent's web_search / fetch_page tools.
//! Only reached when the user has picked a provider in Settings — the tools
//! are not even offered to the model otherwise.

use crate::extraction;
use std::time::Duration;

pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

const MAX_PAGE_CHARS: usize = 12_000;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        // A generic UA, no cookies: pages get fetched, not browsed.
        .user_agent("Mozilla/5.0 (Macintosh) PrivateRoom/0.1")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast())
        }
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80) // link local fe80::/10
        }
    }
}

/// The fetch tool takes model-supplied URLs; keep it away from this Mac and
/// the local network (Ollama, routers, .local devices).
pub fn check_public_http_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("Invalid URL: {url}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http(s) URLs can be fetched.".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Invalid URL: no host.".to_string())?
        .to_lowercase();
    let local = host == "localhost"
        || host.ends_with(".local")
        || host
            .parse::<std::net::IpAddr>()
            .map_or(false, |ip| !is_public_ip(ip));
    if local {
        return Err("Local and private-network addresses cannot be fetched.".into());
    }
    Ok(parsed)
}

pub async fn search_brave(api_key: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    let resp = client()?
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", "5")])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|e| format!("Brave Search request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!(
            "Brave Search error ({status}). Check the API key in Settings → Online features."
        ));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let hits = v["web"]["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(5)
                .map(|r| SearchHit {
                    title: r["title"].as_str().unwrap_or("(untitled)").to_string(),
                    url: r["url"].as_str().unwrap_or_default().to_string(),
                    snippet: extraction::strip_html(r["description"].as_str().unwrap_or_default()),
                })
                .collect()
        })
        .unwrap_or_default();
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

fn html_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let open = start + lower[start..].find('>')?;
    let end = open + lower[open..].find("</title>")?;
    let title = extraction::strip_html(&html[open + 1..end]).trim().to_string();
    (!title.is_empty()).then_some(title)
}

/// Fetch one page and return (title, readable text). HTML is reduced to
/// plain text; anything else comes back as-is if it's textual.
pub async fn fetch_page(url: &str) -> Result<(String, String), String> {
    let parsed = check_public_http_url(url)?;
    let resp = client()?
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("Could not fetch the page: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The page returned HTTP {}.", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !(content_type.contains("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.is_empty())
    {
        return Err(format!(
            "The URL is not a text page (content-type: {content_type})."
        ));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let title = html_title(&body).unwrap_or_else(|| url.to_string());
    let mut text = if content_type.contains("html") || body.trim_start().starts_with('<') {
        extraction::strip_html(&body)
    } else {
        body
    };
    if text.chars().count() > MAX_PAGE_CHARS {
        text = text.chars().take(MAX_PAGE_CHARS).collect();
        text.push_str("\n… (truncated)");
    }
    Ok((title, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_local_and_private_urls() {
        for url in [
            "http://localhost:11434/api",
            "http://127.0.0.1/x",
            "https://192.168.1.1/admin",
            "http://10.0.0.5/",
            "http://printer.local/",
            "ftp://example.com/",
            "file:///etc/passwd",
        ] {
            assert!(check_public_http_url(url).is_err(), "should block {url}");
        }
        assert!(check_public_http_url("https://example.com/page").is_ok());
    }

    #[test]
    fn extracts_html_title() {
        assert_eq!(
            html_title("<html><head><TITLE>Hello &amp; more</TITLE></head>"),
            Some("Hello & more".to_string())
        );
    }
}
