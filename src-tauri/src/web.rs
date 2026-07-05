//! First-party web access for the agent's web_search / fetch_page tools.
//! Only reached when the user has picked a provider in Settings — the tools
//! are not even offered to the model otherwise.

use crate::extraction;
use std::net::{SocketAddr, ToSocketAddrs};
use std::time::Duration;

/// Shown whenever a fetch target (or a redirect hop) resolves onto this Mac
/// or the home network. Actionable and safe to surface to the model/UI.
const PRIVATE_BLOCKED: &str = "This address points to a private network and was blocked.";

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

/// SEC-5: `check_public_http_url` only blocks *literal* private IPs and known
/// local names — a normal-looking hostname can still resolve to 192.168.x.x
/// (DNS rebinding). Resolve the host and confirm EVERY returned address is
/// public, returning one checked address to pin the connection to.
async fn resolve_public_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| format!("Could not resolve the address for {host}."))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("Could not resolve the address for {host}."));
    }
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(PRIVATE_BLOCKED.into());
    }
    Ok(addrs[0])
}

/// Re-check one redirect hop's host. Runs inside reqwest's *synchronous*
/// redirect policy, so DNS is resolved with the blocking resolver — fine for a
/// desktop app and the only option the policy API allows. `false` = block.
fn hop_host_is_public(url: &reqwest::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|h| h.to_lowercase()) else {
        return false;
    };
    if host == "localhost" || host.ends_with(".local") {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return is_public_ip(ip);
    }
    let port = url.port_or_known_default().unwrap_or(80);
    match (host.as_str(), port).to_socket_addrs() {
        Ok(addrs) => {
            let mut any = false;
            for a in addrs {
                any = true;
                if !is_public_ip(a.ip()) {
                    return false;
                }
            }
            any
        }
        Err(_) => false,
    }
}

/// Redirect policy for `fetch_page`: cap the hops and refuse any that lands on
/// a private/loopback address (search keeps the plain policy in `client()`).
fn guarded_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("Too many redirects.");
        }
        if hop_host_is_public(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error(PRIVATE_BLOCKED)
        }
    })
}

/// A client dedicated to `fetch_page`: DNS for `host` is pinned to the
/// already-checked `addr` (closing the check-vs-fetch rebinding window) and
/// redirects are re-checked hop by hop.
fn fetch_client(host: &str, addr: SocketAddr) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Macintosh) PrivateRoom/0.1")
        .redirect(guarded_redirect_policy())
        .resolve(host, addr)
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
/// The one guarded GET every page/transcript fetch goes through: public-URL
/// check, then SEC-5 pinning — resolve the host, confirm every address is
/// public, and pin the connection to the checked address so it can't be
/// swapped for a private one between here and the actual fetch.
async fn guarded_get(url: &str) -> Result<reqwest::Response, String> {
    let parsed = check_public_http_url(url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Invalid URL: no host.".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addr = resolve_public_addr(&host, port).await?;
    let resp = fetch_client(&host, addr)?
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("Could not fetch the page: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The page returned HTTP {}.", resp.status()));
    }
    Ok(resp)
}

pub async fn fetch_page(url: &str) -> Result<(String, String), String> {
    let resp = guarded_get(url).await?;
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

// ---------------------------------------------------------------- YouTube transcripts (ADD-19)

/// Video id when `url` is a YouTube watch/short/embed/youtu.be link, else None
/// — the switch `import_link` uses to route to the transcript path.
pub fn youtube_video_id(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.trim_start_matches("www.").trim_start_matches("m.");
    let is_id = |s: &str| {
        (8..=16).contains(&s.len())
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    match host {
        "youtu.be" => parsed
            .path_segments()
            .and_then(|mut s| s.next().map(str::to_string))
            .filter(|s| is_id(s)),
        "youtube.com" | "youtube-nocookie.com" => {
            let path: Vec<_> = parsed.path_segments().map(|s| s.collect()).unwrap_or_default();
            match path.as_slice() {
                ["watch", ..] | [] => parsed
                    .query_pairs()
                    .find(|(k, _)| k == "v")
                    .map(|(_, v)| v.into_owned())
                    .filter(|s| is_id(s)),
                ["shorts", id, ..] | ["embed", id, ..] | ["live", id, ..] if is_id(id) => {
                    Some((*id).to_string())
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Slice the `"captionTracks":[...]` array out of a watch page. The page is a
/// JS soup, so this walks the array with string/escape awareness rather than
/// trusting a regex, then hands the exact slice to serde_json.
fn extract_caption_tracks(html: &str) -> Option<Vec<serde_json::Value>> {
    let key = "\"captionTracks\":";
    let at = html.find(key)?;
    let rest = &html[at + key.len()..];
    let start = rest.find('[')?;
    let bytes = rest.as_bytes();
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    let mut end = None;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    serde_json::from_str(&rest[start..=end?]).ok()
}

fn ts_ms(ms: u64) -> String {
    let s = ms / 1000;
    let (h, rem) = (s / 3600, s % 3600);
    let (m, sec) = (rem / 60, rem % 60);
    if h > 0 {
        format!("[{h}:{m:02}:{sec:02}]")
    } else {
        format!("[{m}:{sec:02}]")
    }
}

/// Turn a timedtext `fmt=json3` payload into "[m:ss] line" text — the same
/// timestamp contract the on-device transcriber (stt) writes.
fn timedtext_json3_to_lines(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut lines: Vec<String> = Vec::new();
    for ev in v.get("events")?.as_array()? {
        // aAppend events re-send text already emitted; skip them.
        if ev.get("aAppend").is_some() {
            continue;
        }
        let Some(segs) = ev.get("segs").and_then(|s| s.as_array()) else { continue };
        let text = segs
            .iter()
            .filter_map(|s| s.get("utf8").and_then(|u| u.as_str()))
            .collect::<String>()
            .replace('\n', " ")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let ms = ev.get("tStartMs").and_then(|t| t.as_u64()).unwrap_or(0);
        lines.push(format!("{} {text}", ts_ms(ms)));
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

/// Fetch a YouTube video's own caption track as a timestamped transcript —
/// no video download, no extra tools. Returns (title, transcript). Manual
/// captions win over auto-generated ("asr") ones when both exist.
pub async fn youtube_transcript(url: &str) -> Result<(String, String), String> {
    let body = guarded_get(url)
        .await?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let title = html_title(&body)
        .map(|t| t.trim_end_matches(" - YouTube").to_string())
        .unwrap_or_else(|| url.to_string());
    let tracks = extract_caption_tracks(&body)
        .ok_or("This video has no captions/transcript to import.")?;
    let track = tracks
        .iter()
        .find(|t| t.get("kind").and_then(|k| k.as_str()) != Some("asr"))
        .or_else(|| tracks.first())
        .ok_or("This video has no captions/transcript to import.")?;
    let base = track
        .get("baseUrl")
        .and_then(|u| u.as_str())
        .ok_or("This video's captions could not be read.")?;
    let sep = if base.contains('?') { '&' } else { '?' };
    let timedtext = guarded_get(&format!("{base}{sep}fmt=json3"))
        .await?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let transcript = timedtext_json3_to_lines(&timedtext)
        .ok_or("This video's captions came back empty.")?;
    Ok((title, transcript))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_ids_from_url_shapes() {
        for (url, want) in [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", Some("dQw4w9WgXcQ")),
            ("https://youtu.be/dQw4w9WgXcQ?t=42", Some("dQw4w9WgXcQ")),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x", Some("dQw4w9WgXcQ")),
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", Some("dQw4w9WgXcQ")),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", Some("dQw4w9WgXcQ")),
            ("https://example.com/watch?v=dQw4w9WgXcQ", None),
            ("https://www.youtube.com/feed/history", None),
            ("not a url", None),
        ] {
            assert_eq!(youtube_video_id(url).as_deref(), want, "for {url}");
        }
    }

    #[test]
    fn caption_tracks_sliced_out_of_page_soup() {
        let html = r#"junk"captionTracks":[{"baseUrl":"https://yt/api?x=1&lang=en","kind":"asr","languageCode":"en"},{"baseUrl":"https://yt/api?x=2","languageCode":"he"}],"other":1 junk"#;
        let tracks = extract_caption_tracks(html).expect("tracks");
        assert_eq!(tracks.len(), 2);
        // & arrives decoded, and the manual (non-asr) track is detectable.
        assert_eq!(
            tracks[0]["baseUrl"].as_str().unwrap(),
            "https://yt/api?x=1&lang=en"
        );
        assert_eq!(tracks[1].get("kind"), None);
        assert!(extract_caption_tracks("no captions here").is_none());
    }

    #[test]
    fn timedtext_json3_becomes_timestamped_lines() {
        let json = r#"{"events":[
            {"tStartMs":0,"segs":[{"utf8":"Hello "},{"utf8":"world"}]},
            {"tStartMs":65000,"aAppend":1,"segs":[{"utf8":"repeat"}]},
            {"tStartMs":65000,"segs":[{"utf8":"\n"}]},
            {"tStartMs":75400,"segs":[{"utf8":"Second line"}]}
        ]}"#;
        assert_eq!(
            timedtext_json3_to_lines(json).unwrap(),
            "[0:00] Hello world\n[1:15] Second line"
        );
        assert_eq!(timedtext_json3_to_lines(r#"{"events":[]}"#), None);
    }

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
    fn hop_host_check_blocks_private_and_local() {
        for url in [
            "http://192.168.0.1/",
            "http://10.1.2.3/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://localhost/",
            "http://printer.local/",
            "ftp://example.com/",
        ] {
            let u = reqwest::Url::parse(url).unwrap();
            assert!(!hop_host_is_public(&u), "hop should block {url}");
        }
        // Literal public IPs pass without touching the network.
        assert!(hop_host_is_public(&reqwest::Url::parse("http://8.8.8.8/").unwrap()));
        assert!(hop_host_is_public(&reqwest::Url::parse("https://1.1.1.1/").unwrap()));
    }

    #[tokio::test]
    async fn resolve_rejects_private_literal_hosts() {
        // These resolve locally (no real DNS) to loopback/private ranges.
        assert!(resolve_public_addr("127.0.0.1", 80).await.is_err());
        assert!(resolve_public_addr("192.168.1.1", 80).await.is_err());
        assert!(resolve_public_addr("::1", 80).await.is_err());
        // A literal public IP resolves to itself and is accepted.
        assert!(resolve_public_addr("8.8.8.8", 443).await.is_ok());
    }

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

    #[test]
    fn extracts_html_title() {
        assert_eq!(
            html_title("<html><head><TITLE>Hello &amp; more</TITLE></head>"),
            Some("Hello & more".to_string())
        );
    }
}
