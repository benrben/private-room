use super::*;
use std::sync::{OnceLock, RwLock};

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

fn model_runtime_cache() -> &'static RwLock<HashMap<String, (Option<u32>, bool)>> {
    static CACHE: OnceLock<RwLock<HashMap<String, (Option<u32>, bool)>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
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
        return Err(if status == reqwest::StatusCode::UNAUTHORIZED {
            "OpenRouter rejected this API key.".into()
        } else {
            format!("OpenRouter error ({status}): {message}")
        });
    }

    let models = parse_openrouter_models(&value);
    if let Ok(mut cache) = model_runtime_cache().write() {
        for model in &models {
            cache.insert(model.slug.clone(), (model.context_window, model.tools));
        }
    }
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

pub(crate) fn provider_connected(provider: &str) -> bool {
    read_key(provider).is_ok_and(|key| !key.trim().is_empty())
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
    let (_, base_url) = provider_spec(provider)?;
    let (context_window, supports_tools) = model_runtime_cache()
        .read()
        .ok()
        .and_then(|cache| cache.get(selected).copied())
        .unwrap_or((None, true));
    Ok(Some(ProviderRuntimeConfig {
        id: provider.into(),
        api_key: read_key(provider)?,
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
    Ok(models.len())
}

#[tauri::command]
pub fn disconnect_ai_provider(provider: String) -> Result<(), String> {
    provider_spec(&provider)?;
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
