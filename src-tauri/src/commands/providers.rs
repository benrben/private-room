use super::*;
use std::sync::atomic::Ordering;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

const OPENROUTER_ID: &str = "openrouter";
pub(crate) const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const KEYCHAIN_SERVICE: &str = "Arcelle LLM Providers";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub connected: bool,
}

#[derive(Serialize, Clone)]
pub struct ProviderRuntimeConfig {
    pub id: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub context_window: Option<u32>,
    pub supports_tools: bool,
}

/// What the live catalog says a provider model can do, keyed by the provider's
/// own model slug. A named struct rather than a tuple since `capabilities.rs`
/// reads all four together to build the model's declared record — a positional
/// `(Option<u32>, bool, bool, bool)` at four call sites is a swap waiting to
/// happen, and swapping `tools` for `vision` would be silent.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelRuntimeFacts {
    pub context_window: Option<u32>,
    pub tools: bool,
    pub vision: bool,
    pub structured_outputs: bool,
    /// Kept as plain `bool`s rather than the modality `Vec` they are derived
    /// from, so this stays `Copy` — `provider_model_facts` hands it out of a
    /// read lock by `.copied()`, and a `Vec` here would make every capability
    /// lookup clone or hold the lock longer.
    pub image_output: bool,
    pub video_output: bool,
}

fn model_runtime_cache() -> &'static RwLock<HashMap<String, ModelRuntimeFacts>> {
    static CACHE: OnceLock<RwLock<HashMap<String, ModelRuntimeFacts>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Everything the live catalog knows about one provider model, or `None` when
/// it has no entry for it — so the caller decides what "unknown" means rather
/// than being handed a guess. `capabilities.rs` turns each field into a
/// `Support`, where that `None` becomes `Support::Unknown`.
pub(crate) fn provider_model_facts(model: &str) -> Option<ModelRuntimeFacts> {
    let selected = model.splitn(3, "::").nth(1)?.trim();
    model_runtime_cache().read().ok()?.get(selected).copied()
}

/// Does the catalog say this provider model accepts image input? `None` when
/// the catalog has nothing for it, so the caller can decide what "unknown"
/// means rather than being handed a guess.
pub(crate) fn provider_model_vision(model: &str) -> Option<bool> {
    provider_model_facts(model).map(|facts| facts.vision)
}

/// Whether the catalog has been fetched at least once in THIS process.
///
/// The cache above is in-memory only and used to be filled solely as a
/// side-effect of the Settings model picker fetching the list, so after every
/// restart a room already set to an OpenRouter model had NO record of what that
/// model can do: `provider_runtime_config`'s unknown-default handed tools to a
/// text-only model (raw provider error on the first tool call) and left
/// `context_window` unset, so a long chat was never compacted before being
/// billed. Opening the picker once "fixed" it, which is the shape of a bug.
fn catalog_loaded() -> &'static std::sync::atomic::AtomicBool {
    static LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &LOADED
}

/// How long a FAILED catalog fetch is remembered before another is attempted.
///
/// The flag above is only set on success, so without this a failure meant the
/// full `/models/user` request was re-issued in front of every single AI call:
/// offline, that is the provider client's 30s timeout added to each one; with an
/// expired key it is a fresh authenticated request that 401s every time.
const CATALOG_RETRY_AFTER: Duration = Duration::from_secs(5 * 60);

/// When the last catalog fetch was attempted, successful or not.
fn catalog_attempted_at() -> &'static std::sync::Mutex<Option<Instant>> {
    static AT: OnceLock<std::sync::Mutex<Option<Instant>>> = OnceLock::new();
    AT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Pure retry policy, so the window is testable without a network: the first
/// attempt is always due, a later one only once the window has passed.
fn catalog_retry_due(since_last_attempt: Option<Duration>) -> bool {
    match since_last_attempt {
        None => true,
        Some(elapsed) => elapsed >= CATALOG_RETRY_AFTER,
    }
}

/// Make sure this process has the provider catalog before a model's declared
/// capabilities are read. Cheap and silent: a no-op unless `model` is a provider
/// model whose entry is missing, and it gives up (leaving the unknown default)
/// rather than failing a turn if the catalog cannot be fetched.
///
/// Fetched at most once per process on success, and at most once per
/// [`CATALOG_RETRY_AFTER`] while it keeps failing — single-flighted, so
/// concurrent AI calls share one attempt instead of each firing its own.
pub(crate) async fn ensure_provider_catalog(model: &str) {
    if !is_api_provider_model(model) || catalog_loaded().load(Ordering::Relaxed) {
        return;
    }
    let Some(selected) = model.splitn(3, "::").nth(1).map(str::trim) else {
        return;
    };
    if selected.is_empty() {
        return;
    }
    let known = model_runtime_cache()
        .read()
        .is_ok_and(|cache| cache.contains_key(selected));
    if known {
        return;
    }
    static FETCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _fetch_lock = FETCHING.lock().await;
    // The winner of the race may have just filled it.
    if catalog_loaded().load(Ordering::Relaxed) {
        return;
    }
    {
        let Ok(mut at) = catalog_attempted_at().lock() else {
            return;
        };
        if !catalog_retry_due(at.map(|t| t.elapsed())) {
            return;
        }
        *at = Some(Instant::now());
    }
    // `fetch_openrouter_models` sets `catalog_loaded` itself on success, so the
    // guard above short-circuits every later call for the process's lifetime.
    let _ = list_provider_models(OPENROUTER_ID).await;
}

#[cfg(target_os = "macos")]
fn read_key(provider: &str) -> Result<String, String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    let bytes = generic_password(PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        provider,
    ))
    .map_err(|e| format!("No API key is saved for {provider}. [code {}]", e.code()))?;
    String::from_utf8(bytes).map_err(|_| "The saved API key is not valid UTF-8.".into())
}

#[cfg(not(target_os = "macos"))]
fn read_key(_provider: &str) -> Result<String, String> {
    Err("API-key storage currently requires macOS Keychain.".into())
}

#[cfg(target_os = "macos")]
fn store_key(provider: &str, key: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, provider, key.as_bytes())
        .map_err(|e| {
            format!(
                "Could not save the API key in Keychain. [code {}]",
                e.code()
            )
        })
}

#[cfg(not(target_os = "macos"))]
fn store_key(_provider: &str, _key: &str) -> Result<(), String> {
    Err("API-key storage currently requires macOS Keychain.".into())
}

#[cfg(target_os = "macos")]
fn delete_key(provider: &str) -> Result<(), String> {
    use security_framework::passwords::delete_generic_password;
    use security_framework_sys::base::errSecItemNotFound;
    match delete_generic_password(KEYCHAIN_SERVICE, provider) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == errSecItemNotFound => Ok(()),
        Err(e) => Err(format!("Could not remove the API key. [code {}]", e.code())),
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_key(_provider: &str) -> Result<(), String> {
    Ok(())
}

fn provider_spec(provider: &str) -> Result<(&'static str, &'static str), String> {
    match provider {
        OPENROUTER_ID => Ok(("OpenRouter", OPENROUTER_BASE_URL)),
        other => Err(format!("Unknown AI provider: {other}")),
    }
}

fn provider_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// The media catalogues OpenRouter keeps OUT of its default listing.
///
/// Verified live 2026-08-08: `/models` (and `/models/user`) return 400 entries
/// and NOT ONE of them declares `video` output, while
/// `/models?output_modalities=video` returns 21 — Veo, Sora, Kling, Seedance,
/// Aleph, FLUX.3 Video. The image side is the same shape: 11 in the default
/// listing against 42 behind the filter, so `qwen/qwen-image-3-pro`,
/// `krea/krea-2-large`, `flux.2-pro` and the whole Recraft family were
/// invisible.
///
/// So the catalogue has to be asked for these explicitly. Anything that reads
/// the default listing alone concludes, wrongly and with total confidence,
/// that this account cannot make pictures at all.
const MEDIA_MODALITIES: [&str; 2] = ["image", "video"];

/// Where to ask for one media catalogue.
///
/// The PUBLIC `/models`, deliberately — not the user-scoped `/models/user`
/// this function's caller uses for everything else. `/models/user` ignores the
/// filter rather than honouring it (OpenRouter drops unknown query parameters
/// silently: `?bogus_param=1` answers 200 with the full 400-model list), so
/// asking it for the video catalogue returns the ordinary chat catalogue, the
/// merge finds nothing new, and the Create page shows a video tab reading zero
/// while twenty-one video models sit one endpoint away. That is precisely the
/// bug this comment exists to stop someone re-introducing by "tidying" these
/// two paths into one.
fn media_catalog_path(modality: &str) -> String {
    format!("/models?output_modalities={modality}")
}

/// One authenticated catalogue GET, parsed. `query` is appended verbatim.
async fn fetch_openrouter_catalog(
    key: &str,
    path: &str,
) -> Result<Vec<ExternalModelInfo>, String> {
    let response = provider_client()?
        .get(format!("{OPENROUTER_BASE_URL}{path}"))
        .bearer_auth(key)
        .header("HTTP-Referer", "https://arcelle.app")
        .header("X-OpenRouter-Title", "Arcelle")
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {e}"))?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        let message = value["error"]["message"]
            .as_str()
            .or_else(|| value["error"].as_str())
            .unwrap_or("OpenRouter rejected the request");
        if status == reqwest::StatusCode::UNAUTHORIZED {
            note_key_rejected(OPENROUTER_ID);
            return Err("OpenRouter rejected this API key.".into());
        }
        return Err(format!("OpenRouter error ({status}): {message}"));
    }
    Ok(parse_openrouter_models(&value))
}

async fn fetch_openrouter_models(key: &str) -> Result<Vec<ExternalModelInfo>, String> {
    // The user-scoped catalog respects their provider preferences, privacy
    // settings, and guardrails. It is also an authenticated key check — so a
    // bad key fails HERE, before the supplementary calls below.
    let mut models = fetch_openrouter_catalog(key, "/models/user").await?;
    clear_key_rejected(OPENROUTER_ID);

    // Then the media catalogues, merged in by slug. A failure on one of these
    // is NOT fatal: the chat catalog above already succeeded, and losing the
    // whole model list because the picture models could not be listed would
    // be a far worse outcome than a Create page that is short a few rows.
    let mut known: std::collections::HashSet<String> =
        models.iter().map(|m| m.slug.clone()).collect();
    for modality in MEDIA_MODALITIES {
        let path = media_catalog_path(modality);
        match fetch_openrouter_catalog(key, &path).await {
            Ok(extra) => {
                for model in extra {
                    if known.insert(model.slug.clone()) {
                        models.push(model);
                    }
                }
            }
            Err(e) => eprintln!("OpenRouter {modality} catalog unavailable: {e}"),
        }
    }
    // Each batch arrives sorted, but appending three of them does not stay
    // sorted — and the picker shows this list verbatim.
    models.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

    if let Ok(mut cache) = model_runtime_cache().write() {
        for model in &models {
            cache.insert(
                model.slug.clone(),
                ModelRuntimeFacts {
                    context_window: model.context_window,
                    tools: model.tools,
                    vision: model.vision,
                    structured_outputs: model.structured_outputs,
                    image_output: model.image_output,
                    video_output: model.video_output,
                },
            );
        }
    }
    catalog_loaded().store(true, Ordering::Relaxed);
    Ok(models)
}

fn parse_openrouter_models(value: &serde_json::Value) -> Vec<ExternalModelInfo> {
    let mut models: Vec<ExternalModelInfo> = value["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let slug = model["id"].as_str()?.to_string();
            let label = model["name"].as_str().unwrap_or(&slug).to_string();
            let parameters: Vec<String> = model["supported_parameters"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            let input_modalities: Vec<String> = model["architecture"]["input_modalities"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            // The catalog's own account of what comes BACK. Read the same way
            // as the input side and never inferred from the slug: "flux",
            // "image" and "video" appear in the names of models that only
            // describe pictures, and the models that do draw are not obliged
            // to say so in their id.
            let output_modalities: Vec<String> = model["architecture"]["output_modalities"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            Some(ExternalModelInfo {
                slug,
                label,
                efforts: vec![],
                default_effort: None,
                context_window: model["context_length"].as_u64().map(|v| v as u32),
                description: model["description"].as_str().map(str::to_string),
                input_price: model["pricing"]["prompt"].as_str().map(str::to_string),
                output_price: model["pricing"]["completion"].as_str().map(str::to_string),
                input_modalities: input_modalities.clone(),
                image_output: output_modalities.iter().any(|m| m == "image"),
                video_output: output_modalities.iter().any(|m| m == "video"),
                output_modalities,
                tools: parameters.iter().any(|p| p == "tools"),
                vision: input_modalities.iter().any(|m| m == "image"),
                reasoning: parameters
                    .iter()
                    .any(|p| p == "reasoning" || p == "include_reasoning"),
                structured_outputs: parameters
                    .iter()
                    .any(|p| p == "structured_outputs" || p == "response_format"),
            })
        })
        .collect();
    models.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    models
}

/// Providers whose saved key the provider ITSELF rejected (HTTP 401) at least
/// once this session.
///
/// Settings' green "Connected" badge only ever meant "a key is saved on this
/// Mac", so a cancelled or expired key left the page looking perfectly healthy
/// until a question failed with a raw provider error. Re-testing on every render
/// is not the answer (it spends the user's rate limit and would flip the badge
/// whenever the Mac is merely offline), but the moment a real request comes back
/// "this key is not valid" the app must stop claiming it is connected.
fn rejected_keys() -> &'static RwLock<std::collections::HashSet<String>> {
    static REJECTED: OnceLock<RwLock<std::collections::HashSet<String>>> = OnceLock::new();
    REJECTED.get_or_init(|| RwLock::new(std::collections::HashSet::new()))
}

fn note_key_rejected(provider: &str) {
    if let Ok(mut set) = rejected_keys().write() {
        set.insert(provider.to_string());
    }
}

fn clear_key_rejected(provider: &str) {
    if let Ok(mut set) = rejected_keys().write() {
        set.remove(provider);
    }
}

fn key_rejected(provider: &str) -> bool {
    rejected_keys().read().is_ok_and(|set| set.contains(provider))
}

/// The stored OpenRouter key, when one is connected.
///
/// Exposed so the media-limits tables can be fetched with the same credential
/// the catalogue uses, without a second Keychain vocabulary growing up beside
/// this one.
pub(crate) fn openrouter_key() -> Option<String> {
    read_key(OPENROUTER_ID).ok().filter(|k| !k.trim().is_empty())
}

pub(crate) fn provider_connected(provider: &str) -> bool {
    !key_rejected(provider) && read_key(provider).is_ok_and(|key| !key.trim().is_empty())
}

pub(crate) fn is_api_provider_model(model: &str) -> bool {
    model.split("::").next() == Some(OPENROUTER_ID)
}

pub(crate) fn provider_runtime_config(
    model: &str,
) -> Result<Option<ProviderRuntimeConfig>, String> {
    let mut parts = model.splitn(3, "::");
    let provider = parts.next().unwrap_or_default();
    if provider != OPENROUTER_ID {
        return Ok(None);
    }
    let selected = parts
        .next()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Choose a specific OpenRouter model first.")?;
    let (label, base_url) = provider_spec(provider)?;
    let (context_window, supports_tools) = model_runtime_cache()
        .read()
        .ok()
        .and_then(|cache| cache.get(selected).copied())
        .map_or((None, true), |facts| (facts.context_window, facts.tools));
    // Disconnecting a provider only re-points the OPEN room at a local model.
    // Every other room still set to it lands here with no key, and the generic
    // Keychain error ("No API key is saved for openrouter") was logged and
    // replaced upstream by "AI engine unavailable — the agent sidecar could not
    // start", which blames the wrong thing entirely. Say what actually happened
    // and what fixes it.
    let api_key = read_key(provider).map_err(|_| {
        format!(
            "This room is set to {label}, but no {label} API key is saved on this Mac \
             any more. Reconnect it in Settings → Cloud AI, or choose another model in \
             Settings → Model."
        )
    })?;
    Ok(Some(ProviderRuntimeConfig {
        id: provider.into(),
        api_key,
        base_url: base_url.into(),
        model: selected.into(),
        context_window,
        supports_tools,
    }))
}

pub(crate) fn inject_provider_runtime(
    body: &serde_json::Value,
    model: &str,
) -> Result<serde_json::Value, String> {
    let Some(config) = provider_runtime_config(model)? else {
        return Ok(body.clone());
    };
    let mut out = body.clone();
    let object = out
        .as_object_mut()
        .ok_or("Sidecar request body must be an object")?;
    object.insert(
        "provider".into(),
        serde_json::to_value(config).map_err(|e| e.to_string())?,
    );
    Ok(out)
}

#[tauri::command]
pub fn list_ai_providers() -> Vec<ProviderStatus> {
    vec![ProviderStatus {
        id: OPENROUTER_ID.into(),
        label: "OpenRouter".into(),
        connected: provider_connected(OPENROUTER_ID),
    }]
}

#[tauri::command]
pub async fn connect_ai_provider(provider: String, api_key: String) -> Result<usize, String> {
    provider_spec(&provider)?;
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Enter an API key.".into());
    }
    let models = match provider.as_str() {
        OPENROUTER_ID => fetch_openrouter_models(key).await?,
        _ => unreachable!(),
    };
    store_key(&provider, key)?;
    // A freshly accepted key clears any earlier rejection, so the badge is
    // green again the moment the user pastes a working one.
    clear_key_rejected(&provider);
    Ok(models.len())
}

#[tauri::command]
pub fn disconnect_ai_provider(provider: String) -> Result<(), String> {
    provider_spec(&provider)?;
    clear_key_rejected(&provider);
    delete_key(&provider)
}

pub(crate) async fn list_provider_models(provider: &str) -> Result<Vec<ExternalModelInfo>, String> {
    provider_spec(provider)?;
    let key = read_key(provider)?;
    match provider {
        OPENROUTER_ID => fetch_openrouter_models(&key).await,
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_catalog_metadata_drives_capabilities() {
        let value = serde_json::json!({"data": [{
            "id": "vendor/vision-agent",
            "name": "Vision Agent",
            "description": "A live catalog entry",
            "context_length": 262144,
            "architecture": {"input_modalities": ["text", "image"]},
            "supported_parameters": ["tools", "reasoning", "structured_outputs"],
            "pricing": {"prompt": "0.000001", "completion": "0.000002"}
        }]});
        let models = parse_openrouter_models(&value);
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.slug, "vendor/vision-agent");
        assert_eq!(model.context_window, Some(262_144));
        assert!(model.tools);
        assert!(model.vision);
        assert!(model.reasoning);
        assert!(model.structured_outputs);
        assert_eq!(model.input_price.as_deref(), Some("0.000001"));
        // Reads pictures, does not make them. The Create page's whole shelf
        // turns on these two staying apart from `vision`.
        assert!(!model.image_output);
        assert!(!model.video_output);
    }

    #[test]
    fn output_modalities_are_what_says_a_model_can_draw() {
        let value = serde_json::json!({"data": [
            {
                "id": "vendor/painter",
                "name": "Painter",
                "architecture": {
                    "input_modalities": ["text"],
                    "output_modalities": ["image"]
                },
            },
            {
                "id": "vendor/mover",
                "name": "Mover",
                "architecture": {
                    "input_modalities": ["text", "image"],
                    "output_modalities": ["video"]
                },
            },
            {
                // The trap a name test falls into: "image" and "vision" in the
                // slug, image INPUT, and no ability to draw whatsoever.
                "id": "vendor/qwen-image-vision",
                "name": "Image Reader",
                "architecture": {
                    "input_modalities": ["text", "image"],
                    "output_modalities": ["text"]
                },
            },
            {
                // A catalog entry that declares no modalities at all. Silence
                // is not permission — this must not read as "can draw".
                "id": "vendor/silent",
                "name": "Silent",
            },
        ]});
        let by = |slug: &str| {
            parse_openrouter_models(&value)
                .into_iter()
                .find(|m| m.slug == slug)
                .expect("model present")
        };

        let painter = by("vendor/painter");
        assert!(painter.image_output && !painter.video_output);
        assert!(!painter.vision, "text-in: it draws, it does not read pictures");

        let mover = by("vendor/mover");
        assert!(mover.video_output && !mover.image_output);
        assert!(mover.vision, "takes a source still");

        let reader = by("vendor/qwen-image-vision");
        assert!(reader.vision, "it does read pictures");
        assert!(
            !reader.image_output && !reader.video_output,
            "a slug saying 'image' must never be mistaken for the ability to make one"
        );

        let silent = by("vendor/silent");
        assert!(silent.output_modalities.is_empty());
        assert!(!silent.image_output && !silent.video_output);
    }

    #[test]
    fn the_media_catalog_is_asked_of_the_endpoint_that_actually_filters() {
        // This shipped wrong once and the symptom was silent: the Create page
        // read "Video 0" while OpenRouter served 21 video models. The cause was
        // asking `/models/user`, which IGNORES an unsupported query parameter
        // and answers with the ordinary chat catalogue — so the merge found no
        // new slugs and nothing anywhere reported a failure.
        for modality in MEDIA_MODALITIES {
            let path = media_catalog_path(modality);
            assert!(
                path.starts_with("/models?"),
                "media catalogues must come from the PUBLIC /models, which \
                 honours the filter — /models/user silently does not: {path}"
            );
            assert!(!path.contains("/models/user"), "got: {path}");
            assert!(path.ends_with(&format!("output_modalities={modality}")), "got: {path}");
        }
        assert_eq!(media_catalog_path("video"), "/models?output_modalities=video");
    }

    #[test]
    fn a_media_model_parses_from_the_shape_the_filtered_catalog_returns() {
        // Verbatim shape of `GET /models?output_modalities=video`, captured
        // live 2026-08-08. Media entries differ from chat entries in three
        // ways that all have to survive: `context_length` is 0, there are no
        // `supported_parameters` at all, and per-token pricing is "0" because
        // these are billed per second. None of that may cause a drop.
        let value = serde_json::json!({"data": [{
            "id": "black-forest-labs/flux-3-video",
            "name": "Black Forest Labs: FLUX.3 Video",
            "description": "A video generation model.",
            "context_length": 0,
            "architecture": {
                "modality": "text+image+video->video",
                "input_modalities": ["text", "image", "video"],
                "output_modalities": ["video"],
                "tokenizer": "Media"
            },
            "supported_parameters": [],
            "pricing": {"prompt": "0", "completion": "0"}
        }]});
        let models = parse_openrouter_models(&value);
        assert_eq!(models.len(), 1, "a media entry must not be dropped");
        let model = &models[0];
        assert_eq!(model.slug, "black-forest-labs/flux-3-video");
        assert!(model.video_output, "this is the whole reason it is listed");
        assert!(!model.image_output, "it makes clips, not stills");
        // It takes a source still/clip, which is image INPUT — the axis that
        // must never be confused with the ability to produce one.
        assert!(model.vision);
        assert!(!model.tools && !model.structured_outputs);
    }

    #[test]
    fn provider_model_detection_requires_the_composite_prefix() {
        assert!(is_api_provider_model("openrouter::anthropic/claude"));
        assert!(!is_api_provider_model("openrouter-ish"));
        assert!(!is_api_provider_model("qwen3.5:4b"));
    }

    #[test]
    fn a_rejected_key_stops_reading_as_connected() {
        // The badge used to mean only "a key is saved on this Mac", so a
        // cancelled or expired key left Settings looking healthy until a
        // question failed. No Keychain access needed: the rejection alone
        // decides, and reconnecting clears it.
        const P: &str = "provider-under-test";
        clear_key_rejected(P);
        assert!(!key_rejected(P));
        assert!(!provider_connected(P), "no key saved for a fake provider");
        note_key_rejected(P);
        assert!(key_rejected(P));
        assert!(!provider_connected(P));
        clear_key_rejected(P);
        assert!(!key_rejected(P));
    }

    #[test]
    fn a_failed_catalog_fetch_is_not_retried_in_front_of_every_ai_call() {
        // `catalog_loaded` is set only on SUCCESS, so the guard never
        // short-circuits after a failure: offline, the full `/models/user`
        // request (30s client timeout) was re-issued ahead of each AI call, and
        // with an expired key each one 401'd again.
        assert!(catalog_retry_due(None), "the first attempt is always due");
        assert!(!catalog_retry_due(Some(Duration::from_secs(0))));
        assert!(!catalog_retry_due(Some(CATALOG_RETRY_AFTER - Duration::from_secs(1))));
        // …but a transient failure is not permanent either: after the window,
        // the next call tries again.
        assert!(catalog_retry_due(Some(CATALOG_RETRY_AFTER)));
        assert!(catalog_retry_due(Some(CATALOG_RETRY_AFTER * 2)));
    }

    #[tokio::test]
    async fn ensure_provider_catalog_ignores_non_provider_models() {
        // The vision check now calls this on the ask path for EVERY model,
        // including the local ones it loops over when picking a describe pass —
        // so a local name must never reach the network or the Keychain.
        ensure_provider_catalog("qwen3.5:4b").await;
        ensure_provider_catalog("claude-cli::opus").await;
        // A provider prefix with no model chosen has nothing to look up either.
        ensure_provider_catalog("openrouter::").await;
        ensure_provider_catalog("openrouter").await;
    }

    #[test]
    fn runtime_config_uses_the_python_sidecar_field_names() {
        let value = serde_json::to_value(ProviderRuntimeConfig {
            id: "openrouter".into(),
            api_key: "secret".into(),
            base_url: OPENROUTER_BASE_URL.into(),
            model: "vendor/model".into(),
            context_window: Some(128_000),
            supports_tools: true,
        })
        .unwrap();
        assert_eq!(value["api_key"], "secret");
        assert_eq!(value["base_url"], OPENROUTER_BASE_URL);
        assert_eq!(value["context_window"], 128_000);
        assert_eq!(value["supports_tools"], true);
        assert!(value.get("apiKey").is_none());
    }
}
