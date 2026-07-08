use super::*;

/// Chat default: `DEFAULT_MODEL` (qwen3.5:4b) — text + vision + tool calling,
/// no hidden "thinking" pass. Falls back to the first installed model when the
/// default isn't present.
/// True for embedding-only models (nomic-embed-text, bge-*, mxbai-embed-*, …).
/// They answer `/api/embed` but NOT `/api/chat`, so they must never be picked as
/// the chat model — doing so returns "does not support chat" and broke
/// flashcards, image marking, and file-context chat turns once `nomic-embed-text`
/// was pulled for semantic search.
pub(crate) fn is_embedding_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.starts_with(ollama::EMBED_MODEL) || m.contains("embed") || m.contains("bge-")
}

pub(crate) fn best_default(models: &[String]) -> String {
    if models.is_empty() || models.iter().any(|m| m.starts_with(DEFAULT_MODEL)) {
        return DEFAULT_MODEL.to_string();
    }
    // Fall back to the first *chat-capable* model — never an embedding model.
    models
        .iter()
        .find(|m| !is_embedding_model(m))
        .cloned()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// Grounding ("where is X") routes to a Qwen-VL model: measured on a known
/// target, gemma3 puts boxes in the wrong place while qwen2.5vl is accurate
/// without qwen3's slow thinking pass.
pub(crate) fn vision_model(models: &[String], chat_model: &str) -> String {
    models
        .iter()
        .find(|m| m.contains("qwen2.5vl") || m.contains("qwen2.5-vl"))
        .or_else(|| models.iter().find(|m| m.contains("qwen3-vl")))
        .cloned()
        .unwrap_or_else(|| chat_model.to_string())
}

/// HLT-5: keep the chat model resident this long so follow-up questions are
/// snappy. Vision/grounding calls may override this (see `vision_keep_alive`).
pub(crate) const KEEP_ALIVE_WARM: &str = "30m";
/// HLT-5: release a distinct vision model quickly on low-RAM machines.
pub(crate) const KEEP_ALIVE_SHORT: &str = "2m";
/// HLT-5: machines at or above this stay warm even for a second model.
pub(crate) const HIGH_RAM_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// Total physical RAM in bytes, read once (sysinfo). Cached — the value doesn't
/// change while the app runs, and refreshing memory info is not free.
pub(crate) fn total_ram_bytes() -> u64 {
    static RAM: OnceLock<u64> = OnceLock::new();
    *RAM.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.total_memory()
    })
}

/// HLT-5: how long a vision/grounding call should keep its model resident.
///
/// When the vision model IS the chat model, only one model is ever loaded, so
/// keeping it warm costs nothing — use the warm value. When they differ, holding
/// BOTH resident for 30 minutes has overwhelmed and crashed Ollama on 16 GB
/// Macs. So on machines under 32 GB we release the vision model right after the
/// grounding call (a short keep_alive): repeated marking pays a reload, which is
/// the right tradeoff for stability. Machines with >= 32 GB have the headroom to
/// keep it warm for snappier repeated marking. The chat model always stays warm.
pub(crate) fn vision_keep_alive(total_ram: u64, vision_model: &str, chat_model: &str) -> &'static str {
    if vision_model == chat_model || total_ram >= HIGH_RAM_THRESHOLD_BYTES {
        KEEP_ALIVE_WARM
    } else {
        KEEP_ALIVE_SHORT
    }
}

pub(crate) fn model_setting(conn: &Connection) -> Option<String> {
    db::get_setting(conn, "model")
}

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let external = tauri::async_runtime::spawn_blocking(detect_external_blocking)
        .await
        .unwrap_or_default();
    // ADD-21: keep the advisor gate's cache current with what Settings shows.
    *state.external_cache.lock().unwrap() = Some(external.clone());
    let installed = tauri::async_runtime::spawn_blocking(ollama_installed_blocking)
        .await
        .unwrap_or(false);
    match ollama::list_models().await {
        Ok(models) => {
            let default_model = explicit.unwrap_or_else(|| best_default(&models));
            Ok(AiStatus {
                running: true,
                // Reachable means installed, regardless of the app-path check.
                installed: true,
                models,
                default_model,
                external,
            })
        }
        Err(_) => Ok(AiStatus {
            running: false,
            installed,
            models: vec![],
            default_model: explicit.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            external,
        }),
    }
}

/// ADD-22: a model's tool/vision capabilities, so Settings can badge each model
/// and warn when the chosen one can't drive the app. `/api/show` is metadata
/// only (no model load); an unreachable Ollama yields an empty list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    pub name: String,
    pub tools: bool,
    pub vision: bool,
}

#[tauri::command]
pub async fn model_capabilities() -> Result<Vec<ModelCaps>, String> {
    let models = ollama::list_models().await.unwrap_or_default();
    let mut out = Vec::with_capacity(models.len());
    for m in models {
        let caps = ollama::capabilities(&m).await;
        out.push(ModelCaps {
            tools: caps.iter().any(|c| c == "tools"),
            vision: caps.iter().any(|c| c == "vision"),
            name: m,
        });
    }
    Ok(out)
}

/// ADD-10: launch the Ollama app so a first-time user never touches a terminal.
#[tauri::command]
pub fn open_ollama() -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Ollama"])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Ollama: {e}"))
}

#[tauri::command]
pub async fn warm_model(state: State<'_, AppState>) -> Result<(), String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let mut chat_model = explicit.unwrap_or_else(|| best_default(&models));
    // Cloud CLIs need no warm-up; pre-load the local model instead so
    // vision/marking stays fast.
    if is_external_engine(&chat_model) {
        if models.is_empty() {
            return Ok(());
        }
        chat_model = best_default(&models);
    }
    // Warm ONLY one model: keeping two resident overwhelms 16 GB machines
    // and takes Ollama down.
    ollama::warm(&chat_model).await
}

#[tauri::command]
pub async fn pull_model(window: tauri::Window, name: String) -> Result<(), String> {
    use tauri::Emitter;
    ollama::pull(&name, |status, percent| {
        let _ = window.emit(
            "pull-progress",
            serde_json::json!({ "status": status, "percent": percent }),
        );
    })
    .await
}

#[tauri::command]
pub async fn delete_model(name: String) -> Result<(), String> {
    ollama::delete_model(&name).await
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vision_keep_alive_by_ram_and_model() {
        let gb = 1024 * 1024 * 1024;
        // Distinct vision model on a 16 GB Mac → released quickly.
        assert_eq!(vision_keep_alive(16 * gb, "qwen2.5vl", "qwen3.5:4b"), "2m");
        // Same 16 GB Mac, but vision == chat model → only one model loaded, warm.
        assert_eq!(vision_keep_alive(16 * gb, "qwen3.5:4b", "qwen3.5:4b"), "30m");
        // 32 GB Mac keeps a distinct vision model warm too.
        assert_eq!(vision_keep_alive(32 * gb, "qwen2.5vl", "qwen3.5:4b"), "30m");
        assert_eq!(vision_keep_alive(64 * gb, "qwen2.5vl", "qwen3.5:4b"), "30m");
    }

    #[test]
    fn best_default_never_returns_an_embedding_model() {
        // Regression: pulling nomic-embed-text for semantic search must not make
        // it the fallback CHAT model — it can't answer /api/chat, which broke
        // flashcards, image marking, and file-context chat turns.
        assert!(is_embedding_model("nomic-embed-text:latest"));
        assert!(is_embedding_model("mxbai-embed-large"));
        assert!(!is_embedding_model("qwen3.5:9b"));
        // Embed model listed first, no default installed → still pick the chat model.
        let models = vec!["nomic-embed-text:latest".to_string(), "qwen3.5:9b".to_string()];
        assert_eq!(best_default(&models), "qwen3.5:9b");
        // The preferred default still wins when present.
        let with_default = vec![
            "nomic-embed-text:latest".to_string(),
            format!("{DEFAULT_MODEL}:latest"),
        ];
        assert!(best_default(&with_default).starts_with(DEFAULT_MODEL));
    }

}
