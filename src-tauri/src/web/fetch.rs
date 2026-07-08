use super::*;

const MAX_PAGE_CHARS: usize = 12_000;

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

/// Like `fetch_page`, but also hands back the raw page bytes so the caller can
/// keep an offline copy of the source verbatim. Returns
/// (title, readable_text, raw_html_bytes). The airlock (#research) command saves
/// the bytes as an owned file and answers from the readable text. Goes through
/// the exact same SSRF-guarded `guarded_get` (public-URL check + SEC-5 DNS
/// pinning + hop-by-hop redirect re-checks) as every other fetch, so the
/// private-network guard is fully intact. Unlike the model-facing `fetch_page`
/// the text is left un-truncated here — it feeds the room's normal chunking.
pub async fn fetch_readable(url: &str) -> Result<(String, String, Vec<u8>), String> {
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
    let raw = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    let body = String::from_utf8_lossy(&raw).into_owned();
    let title = html_title(&body).unwrap_or_else(|| url.to_string());
    let text = if content_type.contains("html") || body.trim_start().starts_with('<') {
        extraction::strip_html(&body)
    } else {
        body
    };
    Ok((title, text, raw))
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
    fn extracts_html_title() {
        assert_eq!(
            html_title("<html><head><TITLE>Hello &amp; more</TITLE></head>"),
            Some("Hello & more".to_string())
        );
    }
}
