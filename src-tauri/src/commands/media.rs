use super::*;

/// ADD-24: staged decrypted media for the `roommedia://` streaming protocol.
///
/// A recording or video stored in the room lives encrypted in SQLite; the
/// viewer needs a seekable URL, not a giant base64 IPC payload. `get_file_content`
/// stages the decrypted bytes here under a one-shot token and the protocol
/// handler serves them with HTTP Range support (WKWebView's `<video>`/`<audio>`
/// refuse to seek — and above a size, to play at all — without 206 responses).
///
/// Privacy: bytes live only in this in-process map, never on disk. The map is
/// capped (a stale entry is evicted oldest-first) and cleared when the room
/// closes, so locked rooms leave no decrypted media behind.
#[derive(Default)]
pub struct MediaStreams {
    pub map: Mutex<HashMap<String, StagedMedia>>,
    pub next: AtomicU64,
}

pub struct StagedMedia {
    pub bytes: Arc<Vec<u8>>,
    pub mime: String,
    /// Insertion order, for oldest-first eviction.
    pub seq: u64,
}

/// Keep at most this many staged media entries alive (each can be hundreds of
/// MB of decrypted video). Opening a new file evicts the oldest.
const MAX_STAGED: usize = 4;

/// Stage decrypted media bytes; returns the token the viewer plays via
/// `roommedia://localhost/<token>`.
pub(crate) fn stage_media_bytes(streams: &MediaStreams, bytes: Vec<u8>, mime: &str) -> String {
    let seq = streams.next.fetch_add(1, Ordering::Relaxed);
    let token = format!("{seq}-{}", Uuid::new_v4());
    let mut map = streams.map.lock().unwrap();
    while map.len() >= MAX_STAGED {
        let oldest = map
            .iter()
            .min_by_key(|(_, m)| m.seq)
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => map.remove(&k),
            None => break,
        };
    }
    map.insert(
        token.clone(),
        StagedMedia { bytes: Arc::new(bytes), mime: mime.to_string(), seq },
    );
    token
}

/// Drop every staged entry — called when the room closes/locks so no
/// decrypted media outlives the session.
pub(crate) fn clear_media(streams: &MediaStreams) {
    streams.map.lock().unwrap().clear();
}

/// The Content-Type WKWebView will actually play for this file. m4a-flavored
/// labels (audio/mp4a-latm etc.) are refused by `<audio>` — AAC-in-MP4 is
/// audio/mp4 — and octet-stream uploads get a type from their extension.
/// (Mirrors the viewer's old data-URL mapping; the protocol response's
/// Content-Type is what the media element trusts.)
pub(crate) fn playable_media_mime(mime: &str, ext: &str, video: bool) -> String {
    let m = mime.to_ascii_lowercase();
    if ["audio/m4a", "audio/x-m4a", "audio/mp4a-latm", "audio/aac"].contains(&m.as_str()) {
        return "audio/mp4".into();
    }
    if !m.is_empty() && m != "application/octet-stream" {
        return m;
    }
    match ext {
        "mov" => "video/quicktime".into(),
        "webm" if video => "video/webm".into(),
        "webm" => "audio/webm".into(),
        "mp3" => "audio/mpeg".into(),
        "wav" => "audio/wav".into(),
        "flac" => "audio/flac".into(),
        "ogg" | "opus" => "audio/ogg".into(),
        _ if video => "video/mp4".into(),
        _ => "audio/mp4".into(),
    }
}

/// Parse an HTTP `Range` header against a body of `len` bytes. Returns the
/// inclusive byte span to serve, or None when the header is malformed or
/// unsatisfiable (caller answers 416). Only single ranges are supported —
/// WKWebView never requests multipart ranges for media.
pub(crate) fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let (start_s, end_s) = spec.split_once('-')?;
    let start_s = start_s.trim();
    let end_s = end_s.trim();
    if start_s.is_empty() {
        // Suffix form: "bytes=-N" — the final N bytes.
        let n: u64 = end_s.parse().ok().filter(|n| *n > 0)?;
        let n = n.min(len);
        return Some((len - n, len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        end_s.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// The `roommedia://` response for a request path + optional Range header,
/// as (status, headers, body). Pure so the protocol handler in lib.rs stays
/// a two-line adapter and this logic is unit-testable.
pub(crate) fn media_response(
    streams: &MediaStreams,
    path: &str,
    range: Option<&str>,
) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let token = path.trim_start_matches('/');
    let staged = {
        let map = streams.map.lock().unwrap();
        map.get(token).map(|m| (m.bytes.clone(), m.mime.clone()))
    };
    let Some((bytes, mime)) = staged else {
        return (
            404,
            vec![("Content-Type".into(), "text/plain".into())],
            b"media not staged".to_vec(),
        );
    };
    let len = bytes.len() as u64;
    let base = vec![
        ("Content-Type".into(), mime),
        ("Accept-Ranges".into(), "bytes".into()),
        // Media never leaves this handler for the network; forbid the page
        // context from doing anything with it beyond playback.
        ("Cache-Control".into(), "no-store".into()),
        // ADD-25: a CORS-clean response so a `<video crossorigin="anonymous">`
        // frame grab (view_media_frame) doesn't taint the canvas. Without this,
        // roommedia:// is a different origin than the app and canvas.toDataURL
        // throws a SecurityError. The scheme is app-internal, so `*` is safe.
        ("Access-Control-Allow-Origin".into(), "*".into()),
    ];
    match range {
        None => {
            let mut headers = base;
            headers.push(("Content-Length".into(), len.to_string()));
            (200, headers, bytes.as_ref().clone())
        }
        Some(r) => match parse_range(r, len) {
            Some((start, end)) => {
                let body = bytes[start as usize..=end as usize].to_vec();
                let mut headers = base;
                headers.push(("Content-Length".into(), body.len().to_string()));
                headers.push((
                    "Content-Range".into(),
                    format!("bytes {start}-{end}/{len}"),
                ));
                (206, headers, body)
            }
            None => (
                416,
                vec![("Content-Range".into(), format!("bytes */{len}"))],
                Vec::new(),
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged_with(bytes: &[u8]) -> MediaStreams {
        let s = MediaStreams::default();
        stage_media_bytes(&s, bytes.to_vec(), "video/mp4");
        s
    }

    fn only_token(s: &MediaStreams) -> String {
        s.map.lock().unwrap().keys().next().unwrap().clone()
    }

    #[test]
    fn range_parsing_covers_the_grammar() {
        // Plain span, clamped end, open end, suffix, and the invalid shapes.
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(parse_range("bytes=0-500", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-500", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None); // start past end
        assert_eq!(parse_range("bytes=9-3", 100), None); // inverted
        assert_eq!(parse_range("chunks=0-9", 100), None); // wrong unit
        assert_eq!(parse_range("bytes=a-b", 100), None); // garbage
        assert_eq!(parse_range("bytes=0-0", 0), None); // empty body
    }

    #[test]
    fn full_body_when_no_range() {
        let s = staged_with(b"0123456789");
        let (status, headers, body) = media_response(&s, &only_token(&s), None);
        assert_eq!(status, 200);
        assert_eq!(body, b"0123456789");
        assert!(headers.iter().any(|(k, v)| k == "Accept-Ranges" && v == "bytes"));
        assert!(headers.iter().any(|(k, v)| k == "Content-Type" && v == "video/mp4"));
    }

    #[test]
    fn partial_body_with_content_range() {
        let s = staged_with(b"0123456789");
        let (status, headers, body) =
            media_response(&s, &only_token(&s), Some("bytes=2-5"));
        assert_eq!(status, 206);
        assert_eq!(body, b"2345");
        assert!(headers
            .iter()
            .any(|(k, v)| k == "Content-Range" && v == "bytes 2-5/10"));
    }

    #[test]
    fn unsatisfiable_range_is_416_and_unknown_token_404() {
        let s = staged_with(b"0123456789");
        let (status, headers, _) =
            media_response(&s, &only_token(&s), Some("bytes=50-60"));
        assert_eq!(status, 416);
        assert!(headers
            .iter()
            .any(|(k, v)| k == "Content-Range" && v == "bytes */10"));
        let (status, _, _) = media_response(&s, "no-such-token", None);
        assert_eq!(status, 404);
    }

    #[test]
    fn staging_evicts_oldest_and_clear_empties() {
        let s = MediaStreams::default();
        let first = stage_media_bytes(&s, vec![1], "audio/mp4");
        for _ in 0..MAX_STAGED {
            stage_media_bytes(&s, vec![2], "audio/mp4");
        }
        let map = s.map.lock().unwrap();
        assert_eq!(map.len(), MAX_STAGED);
        assert!(!map.contains_key(&first), "oldest entry evicted");
        drop(map);
        clear_media(&s);
        assert!(s.map.lock().unwrap().is_empty());
    }
}
