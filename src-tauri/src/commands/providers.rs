use super::*;
use std::sync::atomic::Ordering;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

const OPENROUTER_ID: &str = "openrouter";
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
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

/// What the live catalog says a provider model can do: (context window,
/// tool-calling, image input), keyed by the provider's own model slug.
type ModelRuntimeFacts = (Option<u32>, bool, bool);

fn model_runtime_cache() -> &'static RwLock<HashMap<String, ModelRuntimeFacts>> {
    static CACHE: OnceLock<RwLock<HashMap<String, ModelRuntimeFacts>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Does the catalog say this provider model accepts image input? `None` when
/// the catalog has nothing for it, so the caller can decide what "unknown"
/// means rather than being handed a guess.
pub(crate) fn provider_model_vision(model: &str) -> Option<bool> {
    let selected = model.splitn(3, "::").nth(1)?.trim();
    model_runtime_cache()
        .read()
        .ok()?
        .get(selected)
        .map(|(_, _, vision)| *vision)
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

async fn fetch_openrouter_models(key: &str) -> Result<Vec<ExternalModelInfo>, String> {
    let response = provider_client()?
        // The user-scoped catalog respects their provider preferences, privacy
        // settings, and guardrails. It is also an authenticated key check.
        .get(format!("{OPENROUTER_BASE_URL}/models/user"))
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
    clear_key_rejected(OPENROUTER_ID);

    let models = parse_openrouter_models(&value);
    if let Ok(mut cache) = model_runtime_cache().write() {
        for model in &models {
            cache.insert(
                model.slug.clone(),
                (model.context_window, model.tools, model.vision),
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
    let (context_window, supports_tools, _vision) = model_runtime_cache()
        .read()
        .ok()
        .and_then(|cache| cache.get(selected).copied())
        .unwrap_or((None, true, false));
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
