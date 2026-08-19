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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use super::providers::OPENROUTER_BASE_URL;

/// How long a fetched limits table is trusted before another attempt is
/// allowed. Model line-ups change on the order of weeks, and a room open for a
/// fortnight should notice a new model without a restart.
const REFRESH_AFTER: Duration = Duration::from_secs(60 * 60);

/// How long a HALF table is trusted. When one of the two endpoints answered and
/// the other did not, an hour is far too long to sit on the gap — but retrying
/// on every Create-page open would make each one wait out the failing
/// endpoint's 30-second timeout, so the missing half is not chased that hard
/// either. Nothing is excluded while a table is missing (see
/// [`media_table_loaded`]), so the only cost of the wait is the seconds picker.
const RETRY_HALF_AFTER: Duration = Duration::from_secs(5 * 60);

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

/// Which of the two catalogues has ever arrived, tracked separately because
/// they fail separately. Set only when that endpoint answered and parsed; never
/// cleared, since the table it filled stays in the cache.
static VIDEOS_LOADED: AtomicBool = AtomicBool::new(false);
static IMAGES_LOADED: AtomicBool = AtomicBool::new(false);

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
///
/// BOTH tables, not either: the caller judges every model against one shared
/// map, so a lone video table made every image model look unserved and the
/// page said, as fact, that the provider's picture endpoint refuses them. Half
/// a table answers nothing about the other half's models.
pub fn media_table_loaded() -> bool {
    VIDEOS_LOADED.load(Ordering::Relaxed) && IMAGES_LOADED.load(Ordering::Relaxed)
}

/// Load both limit tables if they are missing or stale.
///
/// Never fatal. A room with no limits table still generates — the UI simply
/// offers no seconds picker and the provider applies its own defaults, which
/// is a smaller loss than refusing to show the page.
pub async fn ensure_media_limits(key: &str) {
    if !limits_are_stale() {
        return;
    }
    // A second Create-page open inside the (up to 60 s) fetch window used to
    // return here with the table still empty, and that page then rendered every
    // model with no legal durations, no sizes and no frame-slot knowledge until
    // it was navigated away from. A concurrent caller with nothing to serve
    // waits for the fetch in flight instead — the shape
    // `ensure_provider_catalog` uses.
    static FETCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _fetch_lock = match FETCHING.try_lock() {
        Ok(lock) => lock,
        // Someone else is already fetching. Wait for them only when there is
        // nothing to serve meanwhile: with a table in hand this call is a
        // refresh, and making the page sit through someone else's refresh is
        // the same stall the wait exists to prevent.
        Err(_) if media_table_loaded() => return,
        Err(_) => FETCHING.lock().await,
    };
    // The winner of the race may have just filled it.
    if !limits_are_stale() {
        return;
    }

    let mut found: HashMap<String, MediaLimits> = HashMap::new();
    // A catalogue counts as arrived only when it NAMED models. A 200 carrying
    // no `data` array — an outage page, a renamed field — parses to nothing,
    // and calling that "loaded" would tell `drop_unserved` the endpoint serves
    // no model at all, which empties the Create page and blames the provider
    // for it. That is the same defect the per-endpoint flags exist to prevent,
    // one step further in.
    let mut videos = false;
    let mut images = false;
    if let Some(value) = get_json(key, "/videos/models").await {
        videos = parse_video_models(&value, &mut found) > 0;
    }
    if let Some(value) = get_json(key, "/images/models").await {
        images = parse_image_models(&value, &mut found) > 0;
    }
    if !found.is_empty() {
        if let Ok(mut cache) = cache().write() {
            cache.extend(found);
        }
    }
    if videos {
        VIDEOS_LOADED.store(true, Ordering::Relaxed);
    }
    if images {
        IMAGES_LOADED.store(true, Ordering::Relaxed);
    }
    if let Ok(mut at) = fetched_at().lock() {
        // Nothing arrived — let the next caller try again rather than sitting
        // on an empty table. A half table IS stamped, but only counts as fresh
        // for `RETRY_HALF_AFTER`.
        *at = (videos || images).then(Instant::now);
    }
}

/// A full table stands for an hour; half a one for five minutes. Half used to
/// stand for the full hour, which is how a single failed fetch decided what the
/// Create page believed about the other endpoint's models until a restart.
fn limits_are_stale() -> bool {
    let good_for = if media_table_loaded() { REFRESH_AFTER } else { RETRY_HALF_AFTER };
    fetched_at()
        .lock()
        .ok()
        .and_then(|at| *at)
        .is_none_or(|at| at.elapsed() > good_for)
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

/// Returns how many models were read, which is what tells the caller whether a
/// catalogue actually arrived: zero is a body in a shape this does not
/// recognise, not a provider that serves nothing.
fn parse_video_models(value: &serde_json::Value, into: &mut HashMap<String, MediaLimits>) -> usize {
    let mut seen = 0;
    for model in value["data"].as_array().into_iter().flatten() {
        let Some(id) = model["id"].as_str() else { continue };
        seen += 1;
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
    seen
}

/// The images endpoint publishes a *shape*, not flat lists: each parameter is
/// an object that is either an enum of values or a numeric range.
///
/// Runs SECOND, into the same map the video parse filled, so a slug published
/// by both endpoints is merged rather than overwritten. An overwrite blanked
/// that model's durations (no seconds picker) and — worse — its frame slots,
/// and an empty frame list is a PUBLISHED "takes no starting picture": the
/// generate path would have refused a legal starting frame on the strength of
/// a field the images endpoint never speaks about.
///
/// Returns how many models were read — see [`parse_video_models`].
fn parse_image_models(value: &serde_json::Value, into: &mut HashMap<String, MediaLimits>) -> usize {
    let mut seen = 0;
    for model in value["data"].as_array().into_iter().flatten() {
        let Some(id) = model["id"].as_str() else { continue };
        seen += 1;
        let params = &model["supported_parameters"];
        let resolutions = strings(&params["resolution"]["values"]);
        let aspect_ratios = strings(&params["aspect_ratio"]["values"]);
        let max_references = params["input_references"]["max"].as_u64().map(|n| n as u32);
        let entry = into.entry(id.to_string()).or_default();
        // Fill what is not already there rather than replace it: on a slug the
        // video endpoint also published, its sizes are the ones the clip has to
        // honour, and the images endpoint's silence corrects nothing.
        if entry.resolutions.is_empty() {
            entry.resolutions = resolutions;
        }
        if entry.aspect_ratios.is_empty() {
            entry.aspect_ratios = aspect_ratios;
        }
        if entry.max_references.is_none() {
            entry.max_references = max_references;
        }
    }
    seen
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
    fn a_slug_on_both_endpoints_keeps_its_lengths_and_frame_slots() {
        // The image parse runs second into the SAME map. Overwriting the video
        // entry blanked `durations` (no seconds picker) and `frame_images` —
        // and an empty frame list is a PUBLISHED "takes no starting picture",
        // so `check_media_shape` refused a legal first frame on the strength of
        // a field `/images/models` never speaks about.
        let videos = serde_json::json!({"data": [{
            "id": "vendor/model-x",
            "supported_durations": [4, 6, 8],
            "supported_resolutions": ["720p"],
            "supported_frame_images": ["first_frame"],
            "generate_audio": true
        }]});
        let images = serde_json::json!({"data": [{
            "id": "vendor/model-x",
            "supported_parameters": {
                "aspect_ratio": {"type": "enum", "values": ["1:1"]},
                "input_references": {"type": "range", "min": 0, "max": 3}
            }
        }]});
        let mut found = HashMap::new();
        parse_video_models(&videos, &mut found);
        parse_image_models(&images, &mut found);
        let both = found.get("vendor/model-x").expect("parsed");
        assert_eq!(both.durations, vec![4, 6, 8], "the video lengths survive");
        assert!(both.takes_first_frame(), "the frame slot survives");
        assert!(both.generate_audio);
        assert_eq!(both.resolutions, vec!["720p"], "the clip's own sizes stand");
        // What the images endpoint alone knows is still picked up.
        assert_eq!(both.aspect_ratios, vec!["1:1"]);
        assert_eq!(both.max_references, Some(3));
    }

    #[test]
    fn one_catalogue_alone_is_not_a_loaded_table() {
        // The P1: `/videos/models` answered and `/images/models` did not, so the
        // cache held video slugs only — and a non-empty cache used to count as
        // "the media tables loaded". The Create page then dropped all 42 image
        // models behind a row saying the provider's picture endpoint refuses
        // them, a fact nothing had established.
        const VIDEO_ONLY: &str = "vendor/video-only-fixture";
        cache()
            .write()
            .expect("cache")
            .insert(VIDEO_ONLY.to_string(), MediaLimits::default());
        VIDEOS_LOADED.store(true, Ordering::Relaxed);
        IMAGES_LOADED.store(false, Ordering::Relaxed);
        assert!(
            !media_table_loaded(),
            "a video table alone settles nothing about image models"
        );
        IMAGES_LOADED.store(true, Ordering::Relaxed);
        assert!(media_table_loaded(), "both halves in, the rule applies");

        cache().write().expect("cache").remove(VIDEO_ONLY);
        VIDEOS_LOADED.store(false, Ordering::Relaxed);
        IMAGES_LOADED.store(false, Ordering::Relaxed);
    }

    #[test]
    fn a_body_that_names_no_models_is_not_a_catalogue() {
        // `ensure_media_limits` sets that endpoint's loaded flag from this
        // count, and the flag is what lets `drop_unserved` remove models. A 200
        // whose body is not the shape read here parses to nothing — and calling
        // THAT "the catalogue loaded" says the endpoint serves no model at all,
        // which takes every model off the Create page behind a row blaming the
        // provider for it.
        let mut found = HashMap::new();
        let empty = serde_json::json!({"data": []});
        assert_eq!(parse_video_models(&empty, &mut found), 0);
        let foreign = serde_json::json!({"error": {"message": "no endpoint"}});
        assert_eq!(parse_image_models(&foreign, &mut found), 0);
        assert!(found.is_empty());
        // And one real entry counts, so the guard cannot be satisfied by a
        // parser that always answers zero.
        let one = serde_json::json!({"data": [{"id": "vendor/one"}]});
        assert_eq!(parse_video_models(&one, &mut found), 1);
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
