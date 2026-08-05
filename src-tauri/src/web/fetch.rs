use super::*;

/// Hard cap on the readable text one `fetch_page` yields.
///
/// Was 12,000 — which silently disabled the pagination protocol it sits behind:
/// `agent::fetch_page_window` windows 40,000 characters and tells the model to
/// call again with the next `start`, but text truncated at 12,000 can never
/// reach a second window, so `end < total` was unreachable and the "read the
/// rest" instruction was never true. Raised well past one window so long pages
/// (a 69 KB finance page was the motivating example) can actually be paged
/// through. The 8 MiB byte cap upstream still bounds the fetch itself.
const MAX_PAGE_CHARS: usize = 200_000;

/// Hard cap on how much of any response body gets buffered. Generous, because
/// #research pages and YouTube watch pages legitimately run to multiple MB —
/// but a hostile server can no longer stream gigabytes into memory.
const MAX_FETCH_BYTES: usize = 8 * 1024 * 1024;

const TOO_LARGE: &str = "The page is too large to fetch.";

/// Read a body into memory without trusting the server about its size: reject
/// on a declared oversize Content-Length, then stream chunks and stop at
/// `limit`. With `truncate` the first `limit` bytes are kept (for callers that
/// window the text anyway); otherwise an oversized body errors with
/// `too_large`.
///
/// The limit is a PARAMETER because the callers want very different amounts.
/// A preview needs the `<head>` and an `og:image` needs a card-sized picture —
/// both used to stream up to the whole 8 MiB page cap and then throw away
/// almost all of it, which is real bandwidth on a metered connection, eight
/// results at a time.
async fn body_capped_to(
    mut resp: reqwest::Response,
    limit: usize,
    truncate: bool,
    too_large: &str,
) -> Result<Vec<u8>, String> {
    if !truncate
        && resp
            .content_length()
            .map_or(false, |len| len > limit as u64)
    {
        return Err(too_large.into());
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > limit {
            if !truncate {
                return Err(too_large.into());
            }
            buf.extend_from_slice(&chunk[..limit - buf.len()]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// The whole-page read: everything up to [`MAX_FETCH_BYTES`].
async fn body_capped(resp: reqwest::Response, truncate: bool) -> Result<Vec<u8>, String> {
    body_capped_to(resp, MAX_FETCH_BYTES, truncate, TOO_LARGE).await
}

/// Decode capped body bytes per the Content-Type charset — what `resp.text()`
/// did before body capping. Legacy pages (old Hebrew sites are commonly
/// `charset=windows-1255`) would otherwise turn to mojibake; absent/unknown
/// charsets fall back to lossy UTF-8. `content_type` arrives lowercased.
fn decode_body(raw: &[u8], content_type: &str) -> String {
    content_type
        .split(';')
        .filter_map(|p| p.trim().strip_prefix("charset="))
        .next()
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim_matches('"').as_bytes()))
        .map(|enc| enc.decode(raw).0.into_owned())
        .unwrap_or_else(|| String::from_utf8_lossy(raw).into_owned())
}

/// How many redirect hops one fetch may take before it gives up.
const MAX_REDIRECTS: usize = 5;

/// A client dedicated to ONE HOP of a guarded fetch: DNS for `host` is pinned
/// to the already-checked `addr` (closing the check-vs-fetch rebinding window)
/// and redirects are NOT followed here — [`guarded_get`] follows them itself so
/// every hop gets the same pinning the first one got.
fn fetch_client(host: &str, addr: SocketAddr) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Macintosh) Arcelle/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, addr)
        .build()
        .map_err(|e| e.to_string())
}

/// Where a response says to go next, absolutized against the URL it came from.
///
/// `None` for anything that is not a redirect, and for a redirect with no
/// usable `Location` — which then falls through to the normal status handling
/// rather than being followed to nowhere.
fn redirect_target(status: u16, location: Option<&str>, from: &reqwest::Url) -> Option<String> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let location = location?.trim();
    if location.is_empty() {
        return None;
    }
    from.join(location).ok().map(|u| u.to_string())
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
///
/// Redirects are followed HERE rather than by reqwest, because reqwest's
/// redirect policy is the wrong shape for this guard. It is synchronous, so it
/// could only resolve the next hop with the blocking resolver — and then
/// reqwest resolved that host AGAIN, unpinned, to actually connect. A hostile
/// server could answer the check with a public address and the connection with
/// a private one, which is the exact rebinding window the pinning exists to
/// close. Following the chain by hand means every hop gets the whole guard:
/// literal check, DNS resolve of ALL addresses, and a client pinned to the one
/// that was checked.
async fn guarded_get(url: &str) -> Result<reqwest::Response, String> {
    let mut next = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let parsed = check_public_http_url(&next)?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "Invalid URL: no host.".to_string())?
            .to_string();
        let port = parsed.port_or_known_default().unwrap_or(80);
        let addr = resolve_public_addr(&host, port).await?;
        let resp = fetch_client(&host, addr)?
            .get(parsed.clone())
            .send()
            .await
            .map_err(|e| format!("Could not fetch the page: {e}"))?;
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(target) = redirect_target(resp.status().as_u16(), location.as_deref(), &parsed)
        {
            next = target;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("The page returned HTTP {}.", resp.status()));
        }
        return Ok(resp);
    }
    Err("Too many redirects.".into())
}

/// D2 (2026-08-04): `fetch_page`'s result, now carrying where the request
/// actually landed. `guarded_get` follows redirects itself (reqwest's own
/// policy is `none`, see `fetch_client`), so without this the model asking
/// for one URL and silently reading the text of a DIFFERENT one — a
/// redirect it never saw — was invisible. `status` is always a 2xx: anything
/// else already became an `Err` inside `guarded_get` before this is built.
pub struct FetchedPage {
    pub title: String,
    pub text: String,
    pub final_url: String,
    pub status: u16,
}

pub async fn fetch_page(url: &str) -> Result<FetchedPage, String> {
    let resp = guarded_get(url).await?;
    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();
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
    let raw = body_capped(resp, true).await?;
    let body = decode_body(&raw, &content_type);
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
    Ok(FetchedPage { title, text, final_url, status })
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
    let raw = body_capped(resp, false).await?;
    let body = decode_body(&raw, &content_type);
    let title = html_title(&body).unwrap_or_else(|| url.to_string());
    let text = if content_type.contains("html") || body.trim_start().starts_with('<') {
        // The article, when the page has one — the same Readability pass the
        // browser's Save uses, so a page saved from a link and the same page
        // saved from the browser produce the same reading. `strip_html` stays
        // the fallback for everything with no scorable article (a link list, a
        // form, a feed), which is exactly what it was always good at.
        match extraction::read_page(&body, Some(url)).article {
            Some(article) => article.text,
            None => extraction::strip_html(&body),
        }
    } else {
        body
    };
    Ok((title, text, raw))
}

// ---------------------------------------------------------------- binary downloads (BROWSE-2)

/// D15: hard per-file cap for anything downloaded into the room. A room file is
/// one SQLite blob with a practical ceiling of ~1 GB — refuse before storage
/// does, with a message that names the real limit.
pub const MAX_DOWNLOAD_BYTES: u64 = 800 * 1024 * 1024;

/// D18: how much `download_url` fetches inline (within one tool call). Anything
/// bigger belongs on the durable-job tier, not in a chat round.
pub const INLINE_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// A file staged to the app's temp area by [`download_to_temp`], ready for
/// `import_download` to move into the room.
pub struct Downloaded {
    pub path: std::path::PathBuf,
    pub file_name: String,
    pub mime: String,
    pub size_bytes: u64,
}

/// Outcome of a capped download. `TooLarge` is an OUTCOME, not an error,
/// because the caller chooses what it means: at the inline cap it promotes the
/// download to a background job (D18); at the hard cap it is a truthful
/// refusal (D15).
pub enum DownloadOutcome {
    Done(Downloaded),
    TooLarge,
}

/// Keep a network-supplied filename honest: alphanumerics plus `. - _`, at
/// most 80 chars, never empty. Callers always prefix a UUID before using it as
/// a path component, so traversal sequences die here AND can't escape there.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    if cleaned.trim_matches(['.', '_']).is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}

/// The server's suggested filename from a Content-Disposition header, if any.
/// Reads `filename*=charset''value` (kept raw — percent escapes fall to
/// `safe_file_name`) and quoted or bare `filename=`.
fn disposition_file_name(value: &str) -> Option<String> {
    for part in value.split(';').map(str::trim) {
        let ext = part.strip_prefix("filename*=");
        let plain = part.strip_prefix("filename=");
        let raw = match (ext, plain) {
            (Some(v), _) => v.rsplit("''").next().unwrap_or(v),
            (None, Some(v)) => v,
            _ => continue,
        };
        let name = raw.trim_matches('"').trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// Download any URL — binary included — to a staged temp file, streaming and
/// size-capped. Same SSRF posture as every other fetch (public-URL check,
/// SEC-5 DNS pinning, hop-by-hop redirect re-checks); unlike `fetch_page` it
/// accepts every content type. The caller owns the staged file: import it into
/// the room, then delete it.
///
/// `cancel` is polled per chunk (a set flag aborts with "Stopped." and removes
/// the partial file); `progress` receives (bytes so far, declared total).
pub async fn download_to_temp(
    url: &str,
    cap: u64,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<DownloadOutcome, String> {
    use std::io::Write;

    let mut resp = guarded_get(url).await?;
    if resp.content_length().is_some_and(|len| len > cap) {
        return Ok(DownloadOutcome::TooLarge);
    }
    let declared = resp.content_length();
    let suggested = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(disposition_file_name)
        .or_else(|| {
            reqwest::Url::parse(url).ok().and_then(|u| {
                u.path_segments()
                    .and_then(|s| s.filter(|p| !p.is_empty()).next_back().map(str::to_string))
            })
        })
        .unwrap_or_else(|| "download".to_string());
    let file_name = safe_file_name(&suggested);
    let header_mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_lowercase())
        .filter(|m| !m.is_empty() && m != "application/octet-stream");
    let mime = header_mime.unwrap_or_else(|| {
        mime_guess::from_path(&file_name)
            .first_or_octet_stream()
            .essence_str()
            .to_string()
    });

    let dir = std::env::temp_dir().join("arcelle-downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not stage the download: {e}"))?;
    let path = dir.join(format!("{}-{}", uuid::Uuid::new_v4(), file_name));
    let mut out = std::io::BufWriter::new(
        std::fs::File::create(&path).map_err(|e| format!("Could not stage the download: {e}"))?,
    );
    let mut total: u64 = 0;
    loop {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst)) {
            drop(out);
            let _ = std::fs::remove_file(&path);
            return Err("Stopped.".into());
        }
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                total += chunk.len() as u64;
                if total > cap {
                    drop(out);
                    let _ = std::fs::remove_file(&path);
                    return Ok(DownloadOutcome::TooLarge);
                }
                if let Err(e) = out.write_all(&chunk) {
                    drop(out);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Could not stage the download: {e}"));
                }
                progress(total, declared);
            }
            Ok(None) => break,
            Err(e) => {
                drop(out);
                let _ = std::fs::remove_file(&path);
                return Err(format!("The download failed partway: {e}"));
            }
        }
    }
    out.flush().map_err(|e| format!("Could not stage the download: {e}"))?;
    Ok(DownloadOutcome::Done(Downloaded { path, file_name, mime, size_bytes: total }))
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
    let raw = body_capped(guarded_get(url).await?, true).await?;
    // YouTube serves UTF-8 unconditionally; no charset sniffing needed here.
    let body = String::from_utf8_lossy(&raw).into_owned();
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
    let raw = body_capped(guarded_get(&format!("{base}{sep}fmt=json3")).await?, false).await?;
    let timedtext = String::from_utf8_lossy(&raw).into_owned();
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
    fn body_decodes_per_content_type_charset() {
        // "שלום" in windows-1255 — the legacy-Hebrew-page case.
        let heb = [0xf9, 0xec, 0xe5, 0xed];
        assert_eq!(decode_body(&heb, "text/html; charset=windows-1255"), "שלום");
        assert_eq!(decode_body(&heb, "text/html; charset=\"windows-1255\""), "שלום");
        // Absent or unknown charset falls back to lossy UTF-8.
        assert_eq!(decode_body("שלום".as_bytes(), "text/html"), "שלום");
        assert_eq!(decode_body(b"plain", "text/plain; charset=bogus"), "plain");
    }

    #[test]
    fn download_names_are_sanitized_into_a_safe_filename() {
        assert_eq!(safe_file_name("report.pdf"), "report.pdf");
        assert_eq!(safe_file_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_file_name("a b;rm -rf /"), "a_b_rm_-rf__");
        assert!(safe_file_name(&"x".repeat(500)).len() <= 80);
        // A name that sanitizes to nothing meaningful must not become a path
        // component like "" or "..".
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(safe_file_name(".."), "download");
        assert_eq!(safe_file_name("///"), "download");
    }

    #[test]
    fn content_disposition_filenames_are_read_in_both_forms() {
        assert_eq!(
            disposition_file_name(r#"attachment; filename="report q3.pdf""#).as_deref(),
            Some("report q3.pdf")
        );
        assert_eq!(
            disposition_file_name("attachment; filename*=UTF-8''data.csv").as_deref(),
            Some("data.csv")
        );
        assert_eq!(disposition_file_name("inline"), None);
    }

    /// Redirects are followed by hand so every hop gets the same guard the
    /// first one got — which means this is where the chain is decided.
    #[test]
    fn redirect_targets_are_recognised_and_absolutized() {
        let from = reqwest::Url::parse("https://example.com/a/b").unwrap();
        // Relative Location resolves against the URL it came from.
        assert_eq!(
            redirect_target(302, Some("/next"), &from).as_deref(),
            Some("https://example.com/next")
        );
        // Absolute, including a cross-origin hop — the one the guard must
        // re-check rather than trust.
        assert_eq!(
            redirect_target(301, Some("http://127.0.0.1:11434/api"), &from).as_deref(),
            Some("http://127.0.0.1:11434/api")
        );
        for status in [303, 307, 308] {
            assert!(redirect_target(status, Some("/x"), &from).is_some(), "{status}");
        }
        // Not a redirect, or a redirect with nothing usable to follow: fall
        // through to the normal status handling instead of chasing nowhere.
        assert_eq!(redirect_target(200, Some("/x"), &from), None);
        assert_eq!(redirect_target(404, Some("/x"), &from), None);
        assert_eq!(redirect_target(302, None, &from), None);
        assert_eq!(redirect_target(302, Some("   "), &from), None);
    }

    /// A redirect chain must terminate. `guarded_get` resolves DNS and opens a
    /// connection per hop, so an unbounded chain is an unbounded fetch.
    #[test]
    fn the_redirect_chain_is_bounded() {
        assert!(MAX_REDIRECTS > 0 && MAX_REDIRECTS <= 10);
        let src = include_str!("fetch.rs");
        assert!(
            src.contains("redirect(reqwest::redirect::Policy::none())"),
            "reqwest must not follow redirects itself — an auto-followed hop is \
             resolved a second time, unpinned"
        );
    }

    #[test]
    fn extracts_html_title() {
        assert_eq!(
            html_title("<html><head><TITLE>Hello &amp; more</TITLE></head>"),
            Some("Hello & more".to_string())
        );
    }
}

// ---------------------------------------------------------------- result previews (BROWSE-3b)

/// How much of a result page to read while enriching it. Everything we want —
/// `og:image`, `meta description`, `<title>`, the icon link — lives in `<head>`,
/// so a quarter-megabyte is generous; the readable text we keep is a bonus from
/// bytes already in hand, not a reason to read further.
const MAX_PREVIEW_HTML_BYTES: usize = 256 * 1024;

/// Hard cap per preview image. Real `og:image` files are 20–150 KB; anything
/// larger is a full-resolution hero shot we have no use for at card size.
pub const MAX_PREVIEW_IMAGE_BYTES: usize = 200 * 1024;

/// What an oversized preview image says. Distinct from [`TOO_LARGE`]: this is
/// a thumbnail, and telling the user "the page is too large to fetch" when a
/// picture was too big explains nothing.
const IMAGE_TOO_LARGE: &str = "Preview image is too large.";

/// What one enrich pass learns about a result page (BROWSE-3b).
pub struct PagePreview {
    /// Absolute URL of the page's own preview image, if it declares one.
    pub image_url: Option<String>,
    /// Absolute URL of the page's favicon, if it declares one.
    pub icon_url: Option<String>,
    /// The page's own `meta description` — first-party and usually better
    /// written than the engine's snippet.
    pub description: Option<String>,
    pub title: Option<String>,
    /// Readable text, so a later Peek is already paid for.
    pub text: String,
}

/// Read one `<meta>` value by property/name, case-insensitively. A deliberately
/// small scanner rather than a DOM parse: we are reading four known keys out of
/// a `<head>`, and pulling in a full HTML parser for that would be the tail
/// wagging the dog.
fn meta_content(html: &str, keys: &[&str]) -> Option<String> {
    let lower = html.to_lowercase();
    for key in keys {
        // Both quote styles: `property="og:image"` and `property='og:image'`
        // are equally legal, and a page that uses single quotes is not a page
        // without a preview image. (attr_value already handled both; this
        // needle did not, so single-quoted pages silently lost their image.)
        for quote in ['"', '\''] {
            let needle = format!("{quote}{key}{quote}");
            let mut from = 0;
            while let Some(at) = lower[from..].find(&needle) {
                let at = from + at;
                // Walk back to the opening tag, then forward to its end. A
                // fragment with no opening tag is skipped, never fatal: one
                // malformed match must not abandon the remaining keys.
                let Some(tag_start) = lower[..at].rfind('<') else {
                    from = at + needle.len();
                    continue;
                };
                let tag_end = at + lower[at..].find('>').unwrap_or(0);
                if tag_end <= tag_start {
                    from = at + needle.len();
                    continue;
                }
                let tag = &html[tag_start..tag_end];
                if let Some(value) = attr_value(tag, "content") {
                    let value = value.trim();
                    if !value.is_empty() {
                        return Some(html_unescape(value));
                    }
                }
                from = at + needle.len();
            }
        }
    }
    None
}

/// Pull one attribute's value out of a single tag. Handles both quote styles;
/// unquoted values are rare enough in real `<head>` markup to skip.
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let at = lower.find(&format!("{attr}="))?;
    let rest = &tag[at + attr.len() + 1..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = rest[1..].find(quote)?;
    Some(rest[1..1 + end].to_string())
}

/// The `href` of the page's icon link, if it declares one.
fn icon_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("<link") {
        let at = from + at;
        let end = at + lower[at..].find('>').unwrap_or(0);
        if end <= at {
            break;
        }
        let tag = &html[at..end];
        let rel = attr_value(tag, "rel").unwrap_or_default().to_lowercase();
        if rel.split_whitespace().any(|r| r == "icon" || r == "shortcut") {
            if let Some(href) = attr_value(tag, "href").filter(|h| !h.trim().is_empty()) {
                return Some(html_unescape(href.trim()));
            }
        }
        from = end;
    }
    None
}

/// Entities in a `content=`/`href=` attribute value, decoded by the SAME
/// single-pass reader the page body uses.
///
/// This was a private five-entity `.replace()` chain, and it was wrong in both
/// directions. It undid `&amp;` FIRST, so `&amp;lt;` became `&lt;` and then `<`
/// — one layer too many, silently, on any card whose title quotes markup. And
/// it knew no numeric references at all, so a browser result card showed a raw
/// `&#8212;` while the very same page's body (which goes through
/// `decode_basic_entities`) read fine. One decoder means the card and the page
/// can no longer disagree about the same characters.
fn html_unescape(s: &str) -> String {
    crate::extraction::decode_basic_entities(s)
}

/// Resolve a possibly-relative asset URL against the page it came from, and
/// refuse anything that isn't plain http(s) — a `data:` or `javascript:` URL in
/// an `og:image` must never reach the fetcher.
fn absolutize(base: &str, href: &str) -> Option<String> {
    let joined = reqwest::Url::parse(base).ok()?.join(href.trim()).ok()?;
    matches!(joined.scheme(), "http" | "https").then(|| joined.to_string())
}

/// Read one result page for its preview metadata (BROWSE-3b).
///
/// This is the enrich pass: the same guarded GET as every other fetch — public
/// URL check, SEC-5 DNS pinning, hop-by-hop redirect re-checks — reading at most
/// [`MAX_PREVIEW_HTML_BYTES`]. It is `reqwest`, not a browser: no cookie jar, no
/// script execution, no referrer, no storage. That is what lets the results page
/// show real thumbnails without any origin ever seeing a browser fingerprint.
pub async fn fetch_preview(url: &str) -> Result<PagePreview, String> {
    let resp = guarded_get(url).await?;
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !(content_type.contains("html") || content_type.is_empty()) {
        return Err(format!("Not an HTML page (content-type: {content_type})."));
    }
    // Stop READING at the preview cap, rather than streaming the whole page in
    // and then throwing 97% of it away: eight results at up to 8 MiB each is
    // 64 MB of download for four `<head>` tags apiece.
    let raw = body_capped_to(resp, MAX_PREVIEW_HTML_BYTES, true, TOO_LARGE).await?;
    let html = decode_body(&raw, &content_type);
    Ok(preview_from_html(url, &html))
}

/// The parsing half of [`fetch_preview`], split out so it can be tested without
/// a network.
fn preview_from_html(url: &str, html: &str) -> PagePreview {
    let image = meta_content(html, &["og:image", "twitter:image", "og:image:url"])
        .and_then(|href| absolutize(url, &href));
    let icon = icon_href(html)
        .and_then(|href| absolutize(url, &href))
        // Every site serves /favicon.ico whether or not it says so.
        .or_else(|| absolutize(url, "/favicon.ico"));
    PagePreview {
        image_url: image,
        icon_url: icon,
        description: meta_content(html, &["og:description", "description", "twitter:description"])
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
        title: meta_content(html, &["og:title"]).or_else(|| html_title(html)),
        text: extraction::strip_html(html),
    }
}

/// Fetch one image through the same guard, refusing anything that isn't an
/// image or is bigger than a card needs. Returns (mime, bytes).
pub async fn fetch_image(url: &str) -> Result<(String, Vec<u8>), String> {
    let resp = guarded_get(url).await?;
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !mime.starts_with("image/") {
        return Err(format!("Not an image (content-type: {mime})."));
    }
    // Capped at the CARD's budget, not the page budget. A server that declares
    // no Content-Length used to stream up to 8 MiB before the size was checked
    // — and then reported "The page is too large to fetch", which says nothing
    // about an image.
    let bytes = body_capped_to(resp, MAX_PREVIEW_IMAGE_BYTES, false, IMAGE_TOO_LARGE).await?;
    Ok((mime, bytes))
}

#[cfg(test)]
mod preview_tests {
    use super::*;

    const PAGE: &str = r#"<html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="Speaker diarisation">
        <meta property="og:image" content="/img/hero.png">
        <meta name="description" content="Who spoke &amp; when.">
        <link rel="shortcut icon" href="https://cdn.example.com/i.png">
      </head><body><main>Body text here.</main></body></html>"#;

    #[test]
    fn reads_og_image_description_and_icon() {
        let p = preview_from_html("https://example.com/a/b", PAGE);
        assert_eq!(p.image_url.as_deref(), Some("https://example.com/img/hero.png"));
        assert_eq!(p.icon_url.as_deref(), Some("https://cdn.example.com/i.png"));
        assert_eq!(p.description.as_deref(), Some("Who spoke & when."));
        assert_eq!(p.title.as_deref(), Some("Speaker diarisation"));
        assert!(p.text.contains("Body text here."));
    }

    #[test]
    fn a_result_card_decodes_the_same_entities_the_page_body_does() {
        // Regression: the card had its own five-entity `.replace()` chain that
        // undid `&amp;` FIRST — so `&amp;lt;` lost a layer and became `<` — and
        // knew no numeric references, so a card showed a literal `&#8212;`
        // while the same page's body read fine.
        let page = r#"<html><head>
            <meta property="og:title" content="Python 3.13 &#8212; what&#8217;s new">
            <meta name="description" content="Escaping &amp;lt;div&amp;gt; in prose">
          </head><body>x</body></html>"#;
        let p = preview_from_html("https://example.com/", page);
        assert_eq!(p.title.as_deref(), Some("Python 3.13 — what’s new"));
        assert_eq!(p.description.as_deref(), Some("Escaping &lt;div&gt; in prose"));
    }

    /// A page with no og:title still gets a title — the results page would
    /// otherwise show the engine's, which is often worse.
    #[test]
    fn falls_back_to_the_title_tag() {
        let p = preview_from_html("https://example.com/", "<html><head><title>Plain</title></head></html>");
        assert_eq!(p.title.as_deref(), Some("Plain"));
        assert!(p.image_url.is_none());
    }

    /// The designed fallback: no og:image means a monogram tile, not a broken
    /// image slot.
    #[test]
    fn a_page_without_a_preview_image_reports_none() {
        let p = preview_from_html("https://example.com/", "<html><head></head><body>x</body></html>");
        assert!(p.image_url.is_none());
        // …but every site still gets the conventional icon path.
        assert_eq!(p.icon_url.as_deref(), Some("https://example.com/favicon.ico"));
    }

    /// A `data:` URL in an og:image must never reach the fetcher.
    #[test]
    fn refuses_non_http_asset_urls() {
        let html = r#"<meta property="og:image" content="data:image/png;base64,AAA">"#;
        assert!(preview_from_html("https://example.com/", html).image_url.is_none());
    }

    #[test]
    fn resolves_protocol_relative_and_absolute_images() {
        let html = r#"<meta property="og:image" content="//cdn.example.com/a.jpg">"#;
        assert_eq!(
            preview_from_html("https://example.com/p", html).image_url.as_deref(),
            Some("https://cdn.example.com/a.jpg")
        );
    }

    #[test]
    fn single_quoted_attributes_parse() {
        let html = "<meta property='og:image' content='https://a.com/x.png'>";
        assert_eq!(
            preview_from_html("https://a.com/", html).image_url.as_deref(),
            Some("https://a.com/x.png")
        );
    }
}
