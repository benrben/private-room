use super::*;

/// Waveform peaks for the audio viewer.
///
/// The waveform is drawn from a downsampled envelope computed HERE rather than
/// by decoding the file in the webview. wavesurfer's default path fetches the
/// media and decodes it with the Web Audio API, which for a two-hour meeting
/// means roughly a gigabyte of Float32 in the renderer — on a machine that is
/// simultaneously running a local model. The room already knows how to decode
/// any container the Mac can read (it is the same path transcription uses), so
/// it decodes once, reduces to a few thousand buckets, and hands over a few
/// tens of kilobytes.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioPeaks {
    /// Per-bucket maximum absolute amplitude, 0.0–1.0, left to right.
    pub peaks: Vec<f32>,
    /// True length in seconds, from the decoded sample count. This is also the
    /// fix for a streamed container that reports `duration === Infinity` to
    /// the media element until it is forced to seek past the end.
    pub duration: f64,
    /// The envelope never rose above [`NOISE_FLOOR`]: the file decoded, it has
    /// a length, and there is nothing audible in it. Decided HERE because this
    /// is where the floor is defined — the viewer drawing a flat lane and the
    /// label under it must not be able to disagree about what counts as
    /// silence.
    pub silent: bool,
}

/// How many buckets to compute when the caller doesn't say. ~2000 is more than
/// a pane is ever wide in CSS pixels, so the drawing is never under-sampled,
/// and it is small enough to cross IPC without thought.
const DEFAULT_BUCKETS: usize = 2000;
const MAX_BUCKETS: usize = 8000;

/// The amplitude at or under which an envelope is silence rather than signal.
/// `envelope` refuses to normalize below it (dither must not be amplified into
/// a fake waveform), so a file that never crosses it draws as a flat lane —
/// and that flat lane is what the viewer has to explain.
const NOISE_FLOOR: f32 = 0.01;

/// Decoded envelopes, keyed by file id. Decoding shells out to the OS
/// converters and takes real seconds on a long recording, so the answer is
/// kept for as long as the room is open — reopening a meeting must not pay for
/// it twice. Cleared with the room, like every other decrypted derivative.
#[derive(Default)]
pub struct PeakCache {
    pub map: Mutex<HashMap<String, AudioPeaks>>,
}

/// Keep at most this many envelopes. Each is a few tens of KB, so this is
/// about tidiness rather than memory pressure.
const MAX_CACHED: usize = 24;

pub(crate) fn clear_peaks(cache: &PeakCache) {
    cache.map.lock().unwrap().clear();
}

/// Reduce mono samples to `buckets` maxima. Uses the maximum ABSOLUTE value in
/// each bucket, not the mean: a mean envelope of speech is nearly flat, which
/// is exactly the "featureless grey sausage" a waveform is supposed not to be.
fn envelope(samples: &[f32], buckets: usize) -> Vec<f32> {
    if samples.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(buckets);
    // Integer-free bucket walk so the last bucket can't run past the slice on
    // a length that doesn't divide evenly.
    for b in 0..buckets {
        let start = (b as u64 * samples.len() as u64 / buckets as u64) as usize;
        let end = (((b + 1) as u64 * samples.len() as u64) / buckets as u64) as usize;
        let end = end.max(start + 1).min(samples.len());
        let mut peak = 0f32;
        for s in &samples[start..end] {
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        out.push(peak.min(1.0));
    }
    // Normalize to the loudest moment so a quietly-recorded meeting still
    // fills the lane. A silent file stays silent rather than being amplified
    // into noise.
    let loudest = out.iter().copied().fold(0f32, f32::max);
    if loudest > NOISE_FLOOR {
        for v in &mut out {
            *v /= loudest;
        }
    }
    out
}

/// Did anything in this envelope get above the floor? A normalized envelope
/// peaks at exactly 1.0, so this is only ever true for the un-normalized case:
/// a track with no audible content in it.
fn is_silent(peaks: &[f32]) -> bool {
    !peaks.is_empty() && peaks.iter().copied().fold(0f32, f32::max) <= NOISE_FLOOR
}

/// What to show when the decoder refuses a file.
///
/// `avconvert` fails on a video whose audio track is missing AND on one whose
/// audio the Mac has no decoder for, and it does not say which — so the
/// sentence stops at "none this Mac can read" rather than asserting the track
/// isn't there. Every other failure keeps its own words; a generic rewrite
/// would throw away the only clue there is.
fn describe_decode_error(err: String) -> String {
    if err.starts_with("no readable audio track") {
        return "This video has no audio track this Mac can read.".into();
    }
    err
}

#[tauri::command]
pub async fn audio_peaks(
    app: tauri::AppHandle,
    id: String,
    buckets: Option<usize>,
) -> Result<AudioPeaks, String> {
    use tauri::Manager;
    let buckets = buckets.unwrap_or(DEFAULT_BUCKETS).clamp(64, MAX_BUCKETS);
    let cache_key = format!("{id}:{buckets}");
    {
        let cache = app.state::<PeakCache>();
        let hit = cache.map.lock().unwrap().get(&cache_key).cloned();
        if let Some(hit) = hit {
            return Ok(hit);
        }
    }
    // Read the bytes out of the room, then DROP the lock: decoding shells out
    // to converters and must never be holding the room mutex while it does.
    let (name, mime, bytes) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, mime, bytes, _) = db::get_file_full(&room.conn, &id)?;
        (name, mime.unwrap_or_default(), bytes.unwrap_or_default())
    };
    if bytes.is_empty() {
        return Err("This file has no audio to draw.".into());
    }
    let ext = extraction::extension_of(&name);
    let kind = stt::media_kind(&mime, &ext).ok_or("This file is not audio or video.")?;

    let computed = tauri::async_runtime::spawn_blocking(move || {
        let pcm = stt::decode_bytes_to_pcm(&bytes, &ext, kind).map_err(describe_decode_error)?;
        // decode_bytes_to_pcm always returns mono 16 kHz, which is where the
        // duration comes from — and why it is trustworthy even when the
        // container's own header is not.
        let duration = pcm.len() as f64 / 16_000.0;
        let peaks = envelope(&pcm, buckets);
        let silent = is_silent(&peaks);
        Ok::<AudioPeaks, String>(AudioPeaks { peaks, duration, silent })
    })
    .await
    .map_err(|e| format!("The waveform could not be computed: {e}"))??;

    let cache = app.state::<PeakCache>();
    let mut map = cache.map.lock().unwrap();
    if map.len() >= MAX_CACHED {
        map.clear();
    }
    map.insert(cache_key, computed.clone());
    Ok(computed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_envelope_follows_the_loud_parts() {
        // Silence, then a loud burst, then silence again.
        let mut samples = vec![0.0f32; 300];
        for s in samples.iter_mut().skip(100).take(100) {
            *s = 0.5;
        }
        let env = envelope(&samples, 3);
        assert_eq!(env.len(), 3);
        assert!(env[0] < 0.01, "the quiet opening became loud: {env:?}");
        assert!((env[1] - 1.0).abs() < 1e-6, "the burst should normalize to 1: {env:?}");
        assert!(env[2] < 0.01, "the quiet tail became loud: {env:?}");
    }

    #[test]
    fn a_mean_would_have_flattened_this_but_a_max_does_not() {
        // One loud sample in a bucket of 100 IS an audible transient.
        let mut samples = vec![0.0f32; 100];
        samples[50] = 1.0;
        assert_eq!(envelope(&samples, 1), vec![1.0]);
    }

    #[test]
    fn silence_is_not_amplified_into_noise() {
        // Normalizing by the loudest moment would turn dither into a full
        // waveform and make an empty recording look like speech.
        let env = envelope(&vec![0.0005f32; 1000], 4);
        assert!(env.iter().all(|v| *v < 0.01), "silence was amplified: {env:?}");
    }

    #[test]
    fn buckets_cover_every_sample_and_never_run_past_the_end() {
        // A length that divides badly used to be the classic off-by-one here.
        for len in [1usize, 7, 999, 1001] {
            for buckets in [1usize, 3, 64, 2000] {
                let env = envelope(&vec![0.25f32; len], buckets);
                assert_eq!(env.len(), buckets, "len={len} buckets={buckets}");
            }
        }
    }

    #[test]
    fn a_silent_track_is_reported_as_silent_and_a_quiet_one_is_not() {
        // The waveform lane draws flat for both a silent file and a file whose
        // peaks never arrived; only this flag lets the viewer tell the user
        // which one it is looking at.
        assert!(is_silent(&envelope(&vec![0.0f32; 1000], 8)), "digital silence");
        assert!(is_silent(&envelope(&vec![0.0005f32; 1000], 8)), "dither is not signal");
        // A QUIETLY recorded meeting is signal: envelope normalizes it to 1.0,
        // and calling that "silent" would be a worse lie than saying nothing.
        assert!(!is_silent(&envelope(&vec![0.03f32; 1000], 8)), "a quiet meeting is audible");
        // Nothing decoded at all is the viewer's "no readable audio" case, not
        // a claim about the content.
        assert!(!is_silent(&[]));
    }

    #[test]
    fn a_missing_audio_track_reads_as_a_sentence_not_as_converter_stderr() {
        assert_eq!(
            describe_decode_error("no readable audio track: avconvert: error: nope".into()),
            "This video has no audio track this Mac can read."
        );
        // Anything else keeps its own words — the detail is the only clue.
        assert_eq!(
            describe_decode_error("audio decode failed: bad file".into()),
            "audio decode failed: bad file"
        );
    }

    #[test]
    fn nothing_in_nothing_out() {
        assert!(envelope(&[], 10).is_empty());
        assert!(envelope(&[0.5, 0.5], 0).is_empty());
    }
}
