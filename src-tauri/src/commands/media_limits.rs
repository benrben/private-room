//! What each picture/video model will actually accept — read, never guessed.
//!
//! The ordinary model catalogue says a model makes video. It does not say that
//! Veo will take only 4, 6 or 8 seconds, that Kling wants 3–15, or that Runway
//! Aleph 2 has a **56-cent minimum** however short the clip. Two dedicated
//! endpoints do:
//!
//!   * `GET /videos/models` — durations, resolutions, aspect ratios, which
//!     frame slots the model accepts, whether it can make sound.
//!   * `GET /images/models` — the same shape for stills, plus how many
//!     reference pictures it will look at (`input_references.max`).
//!
//! This matters because the alternative is a UI that offers a number the model
//! rejects. Sending an illegal duration does not produce a shorter clip; it
//! produces a 400 after the user has waited, or — worse on the models billed
//! with a floor — a charge for nothing. Reading the limits is free, so a
//! guessed one is never worth it.
//!
//! And it is what makes "make a video from this picture" honest. Two of the 21
//! video models (Runway Aleph 2, Sora 2 Pro) accept no starting frame at all.
//! Without `supported_frame_images` the page would offer a picture slot that
//! silently does nothing on those two.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use super::providers::OPENROUTER_BASE_URL;

/// How long a fetched limits table is trusted before another attempt is
/// allowed. Model line-ups change on the order of weeks, and a room open for a
/// fortnight should notice a new model without a restart.
const REFRESH_AFTER: Duration = Duration::from_secs(60 * 60);

/// What one media model accepts.
///
/// Empty vectors mean "the provider published none", which is NOT the same as
/// "anything goes" — it is the provider declining to say, and every caller
/// here treats it as "send nothing and let the model default". That is the
/// safe reading: an omitted parameter is honoured by every provider, while a
/// guessed one can be refused.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaLimits {
    /// Legal lengths in seconds, exactly as published.
    pub durations: Vec<u32>,
    pub resolutions: Vec<String>,
    pub aspect_ratios: Vec<String>,
    /// `first_frame` / `last_frame` — which ends of the clip a picture may be
    /// pinned to. Empty means this model animates from words alone.
    pub frame_images: Vec<String>,
    /// How many guiding pictures the model will look at. `None` = unpublished.
    pub max_references: Option<u32>,
    /// Whether the model can produce sound with the picture.
    pub generate_audio: bool,
}

impl MediaLimits {
    /// Is `seconds` a length this model actually accepts?
    ///
    /// An unpublished list accepts anything, because the alternative is
    /// refusing a legal request on the strength of a table we never got.
    pub fn allows_seconds(&self, seconds: u32) -> bool {
        self.durations.is_empty() || self.durations.contains(&seconds)
    }

    /// The length to use when the caller named none, or named an illegal one:
    /// the shortest published, which is also the cheapest.
    pub fn default_seconds(&self) -> Option<u32> {
        self.durations.iter().copied().min()
    }

    pub fn takes_first_frame(&self) -> bool {
        self.frame_images.iter().any(|f| f == "first_frame")
    }
}

fn cache() -> &'static RwLock<HashMap<String, MediaLimits>> {
    static CACHE: OnceLock<RwLock<HashMap<String, MediaLimits>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn fetched_at() -> &'static std::sync::Mutex<Option<Instant>> {
    static AT: OnceLock<std::sync::Mutex<Option<Instant>>> = OnceLock::new();
    AT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Everything known about one model, by bare slug (no engine prefix).
pub fn limits_for(slug: &str) -> Option<MediaLimits> {
    cache().read().ok()?.get(slug).cloned()
}

/// Did the media catalogues load at all?
///
/// This is the difference between "that model has no picture endpoint" and
/// "we could not check", and the two must never be confused. `/videos/models`
/// and `/images/models` ARE the list of models those endpoints serve, so a
/// slug missing from a table that loaded is a settled answer. A slug missing
/// from a table that never arrived is nothing at all, and excluding models on
/// the strength of it would empty the Create page every time the network
/// hiccuped.
pub fn media_table_loaded() -> bool {
    cache().read().map(|c| !c.is_empty()).unwrap_or(false)
}

/// Load both limit tables if they are missing or stale.
///
/// Never fatal. A room with no limits table still generates — the UI simply
/// offers no seconds picker and the provider applies its own defaults, which
/// is a smaller loss than refusing to show the page.
pub async fn ensure_media_limits(key: &str) {
    {
        let stale = fetched_at()
            .lock()
            .ok()
            .and_then(|at| *at)
            .is_none_or(|at| at.elapsed() > REFRESH_AFTER);
        if !stale {
            return;
        }
    }
    // Stamped BEFORE the calls, not after: two Create-page opens in quick
    // succession would otherwise both see "stale" and fetch twice.
    if let Ok(mut at) = fetched_at().lock() {
        *at = Some(Instant::now());
    }

    let mut found: HashMap<String, MediaLimits> = HashMap::new();
    if let Some(value) = get_json(key, "/videos/models").await {
        parse_video_models(&value, &mut found);
    }
    if let Some(value) = get_json(key, "/images/models").await {
        parse_image_models(&value, &mut found);
    }
    if found.is_empty() {
        // Nothing arrived — let the next caller try again rather than sitting
        // on an empty table for an hour.
        if let Ok(mut at) = fetched_at().lock() {
            *at = None;
        }
        return;
    }
    if let Ok(mut cache) = cache().write() {
        cache.extend(found);
    }
}

async fn get_json(key: &str, path: &str) -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()?;
    let response = client
        .get(format!("{OPENROUTER_BASE_URL}{path}"))
        .bearer_auth(key)
        .header("HTTP-Referer", "https://arcelle.app")
        .header("X-OpenRouter-Title", "Arcelle")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        eprintln!("media limits: {path} answered {}", response.status());
        return None;
    }
    response.json::<serde_json::Value>().await.ok()
}

fn strings(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn parse_video_models(value: &serde_json::Value, into: &mut HashMap<String, MediaLimits>) {
    for model in value["data"].as_array().into_iter().flatten() {
        let Some(id) = model["id"].as_str() else { continue };
        into.insert(
            id.to_string(),
            MediaLimits {
                durations: model["supported_durations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_u64().map(|n| n as u32))
                    .collect(),
                resolutions: strings(&model["supported_resolutions"]),
                aspect_ratios: strings(&model["supported_aspect_ratios"]),
                frame_images: strings(&model["supported_frame_images"]),
                // Video reference counts are not published per model; the
                // request schema caps nothing either, so no number is invented.
                max_references: None,
                generate_audio: model["generate_audio"].as_bool().unwrap_or(false),
            },
        );
    }
}

/// The images endpoint publishes a *shape*, not flat lists: each parameter is
/// an object that is either an enum of values or a numeric range.
fn parse_image_models(value: &serde_json::Value, into: &mut HashMap<String, MediaLimits>) {
    for model in value["data"].as_array().into_iter().flatten() {
        let Some(id) = model["id"].as_str() else { continue };
        let params = &model["supported_parameters"];
        into.insert(
            id.to_string(),
            MediaLimits {
                durations: Vec::new(),
                resolutions: strings(&params["resolution"]["values"]),
                aspect_ratios: strings(&params["aspect_ratio"]["values"]),
                frame_images: Vec::new(),
                max_references: params["input_references"]["max"]
                    .as_u64()
                    .map(|n| n as u32),
                generate_audio: false,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_limits_are_read_off_the_endpoints_own_field_names() {
        // Verbatim from the live `/videos/models` payload for Veo 3.1 —
        // whose durations are the reason this module exists: 4, 6 and 8 only,
        // so a "5 second" clip is a 400 rather than a shorter video.
        let value = serde_json::json!({"data": [{
            "id": "google/veo-3.1",
            "supported_durations": [4, 6, 8],
            "supported_resolutions": ["720p", "1080p", "4K"],
            "supported_aspect_ratios": ["16:9", "9:16"],
            "supported_frame_images": ["first_frame", "last_frame"],
            "generate_audio": true
        }]});
        let mut found = HashMap::new();
        parse_video_models(&value, &mut found);
        let veo = found.get("google/veo-3.1").expect("parsed");
        assert_eq!(veo.durations, vec![4, 6, 8]);
        assert!(veo.allows_seconds(6));
        assert!(!veo.allows_seconds(5), "5s is not on Veo's list");
        assert_eq!(veo.default_seconds(), Some(4), "cheapest legal length");
        assert!(veo.takes_first_frame());
        assert!(veo.generate_audio);
    }

    #[test]
    fn a_model_that_takes_no_starting_picture_says_so() {
        // Sora 2 Pro and Runway Aleph 2 publish no frame slots at all. The
        // page must not offer a picture that would be silently ignored.
        let value = serde_json::json!({"data": [{
            "id": "openai/sora-2-pro",
            "supported_durations": [4, 8, 12, 16, 20],
            "supported_frame_images": null
        }]});
        let mut found = HashMap::new();
        parse_video_models(&value, &mut found);
        let sora = found.get("openai/sora-2-pro").expect("parsed");
        assert!(sora.frame_images.is_empty());
        assert!(!sora.takes_first_frame());
    }

    #[test]
    fn image_limits_come_out_of_the_nested_parameter_shape() {
        // `/images/models` nests each parameter as enum-or-range rather than
        // publishing flat lists like the video endpoint does.
        let value = serde_json::json!({"data": [{
            "id": "qwen/qwen-image-3-pro",
            "supported_parameters": {
                "resolution": {"type": "enum", "values": ["1K", "2K"]},
                "aspect_ratio": {"type": "enum", "values": ["1:1", "16:9"]},
                "n": {"type": "range", "min": 1, "max": 6},
                "input_references": {"type": "range", "min": 0, "max": 4}
            }
        }]});
        let mut found = HashMap::new();
        parse_image_models(&value, &mut found);
        let qwen = found.get("qwen/qwen-image-3-pro").expect("parsed");
        assert_eq!(qwen.resolutions, vec!["1K", "2K"]);
        // The number the cast strip needs: four heroes in one picture, not five.
        assert_eq!(qwen.max_references, Some(4));
        assert!(qwen.durations.is_empty(), "a still has no length");
    }

    #[test]
    fn an_unpublished_duration_list_refuses_nothing() {
        // The whole table failing to load must not make every generation
        // illegal — an empty list means "we were not told", so the provider's
        // own default decides.
        let silent = MediaLimits::default();
        assert!(silent.allows_seconds(7));
        assert_eq!(silent.default_seconds(), None);
    }
}
