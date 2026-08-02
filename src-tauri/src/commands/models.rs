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

/// A chat-capable model that runs ON THIS MAC — not an embedding model, not an
/// external CLI, not an Ollama `:cloud` model. The tool-driving agent loop and
/// on-device structured side-calls must run here, because `:cloud` models leak
/// tool calls inline (see is_cloud_model) and can't be trusted to drive the app.
/// Prefers the tuned default; falls back to the first eligible installed model,
/// then to the default name (so an Ollama error names the missing model).
pub(crate) fn best_local_default(models: &[String]) -> String {
    if models.iter().any(|m| m.starts_with(DEFAULT_MODEL)) {
        return DEFAULT_MODEL.to_string();
    }
    models
        .iter()
        .find(|m| !is_embedding_model(m) && !is_external_engine(m) && !is_cloud_model(m))
        .cloned()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// ADD-25: can this chat model READ an image (screenshot / video frame) fed
/// into its context? Distinct from grounding accuracy (vision_model below) —
/// gemma3 describes fine even though it aims boxes badly, and the default
/// qwen3.5 is multimodal. Text-only chat models get a vision-model describe
/// pass instead of an attached image.
///
/// NAME MATCHING ONLY, and therefore the fallback rather than the answer — see
/// [`chat_model_sees_images`], which asks the engine. Kept for the moments the
/// engine says nothing at all (a stopped sidecar must not turn a
/// known-multimodal model blind mid-session) and for the remaining synchronous
/// call site in `commands::vision`.
pub(crate) fn is_vision_chat_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    !is_embedding_model(&m)
        && ["vl", "llava", "vision", "moondream", "minicpm-v", "gemma3", "qwen3.5"]
            .iter()
            .any(|k| m.contains(k))
}

/// ADD-25: can this chat model read an image — ASKED, not guessed.
///
/// Ollama already reports a `vision` capability through `/api/show` (metadata
/// only, no model load), and an OpenRouter model's input modalities ride the
/// catalog the picker fetches. Deciding this by matching seven substrings in the
/// name meant a newly installed multimodal model with an unfamiliar name was
/// treated as blind: its images were described to it second-hand by another
/// model, and "mark this image" refused with "no vision model installed".
///
/// Order of truth: an API provider's catalog → Ollama's own capability list →
/// [`is_vision_chat_model`] only when neither answered.
pub(crate) async fn chat_model_sees_images(model: &str) -> bool {
    if is_embedding_model(model) {
        return false;
    }
    // A cloud CLI is a separate subprocess with no image channel from here —
    // its perception tools go through a local vision model instead.
    if is_cli_engine(model) {
        return false;
    }
    if is_api_provider_model(model) {
        // The provider capability cache is in-memory and filled only by a
        // catalog fetch, and the gateways that trigger one all run LATER in the
        // turn than this call. So the first ask after every launch decided
        // vision by matching substrings in the slug: a capable model whose name
        // lacks vl/vision/llava/gemma3/qwen3.5 read as blind for exactly one
        // turn (its screenshot routed through a local describe pass, or refused
        // outright), and the second ask was right — the shape of a bug.
        ensure_provider_catalog(model).await;
        return provider_model_vision(model).unwrap_or_else(|| is_vision_chat_model(model));
    }
    let caps = ollama::capabilities(model).await;
    if caps.is_empty() {
        return is_vision_chat_model(model);
    }
    caps.iter().any(|c| c == "vision")
}

/// Grounding ("where is X") routes to a Qwen-VL model: measured on a known
/// target, gemma3 puts boxes in the wrong place while qwen2.5vl is accurate
/// without qwen3's slow thinking pass.
pub(crate) fn vision_model(models: &[String], chat_model: &str) -> String {
    grounding_model(models).unwrap_or_else(|| chat_model.to_string())
}

/// The installed Qwen-VL grounding model, or None when there isn't one.
///
/// Split out from `vision_model` because the fallback is a LIE at the grounding
/// call site: `vision_model` hands back the chat model, and a text-only chat
/// model asked to outline a region answers `[]` — which the image viewer renders
/// as "The AI could not locate that in this image." So a machine with no VL
/// model installed was told, over and over, that its image did not contain the
/// thing it plainly contained. Callers that need real grounding must ask THIS
/// and say something true when it returns None; callers that only need to READ
/// an image (describe/attach) can keep using `vision_model`, because
/// `is_vision_chat_model` covers that case.
pub(crate) fn grounding_model(models: &[String]) -> Option<String> {
    models
        .iter()
        .find(|m| m.contains("qwen2.5vl") || m.contains("qwen2.5-vl"))
        .or_else(|| models.iter().find(|m| m.contains("qwen3-vl")))
        .cloned()
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
    // Advisors are CLI subprocesses today. Keep this cache CLI-only while the
    // user-facing engine list below also includes connected API providers.
    *state.external_cache.lock().unwrap() = Some(external.clone());
    let mut external = external;
    if provider_connected("openrouter") {
        external.push("openrouter".into());
    }
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

/// Smallest change in a download's percentage worth repainting the bar for.
const PULL_PROGRESS_STEP: f64 = 0.5;

/// The cancel-registry key a running download is filed under, so Stop reaches
/// it. One download per model, keyed by the model's own name — the frontend
/// already knows that name (it is what it asked to pull), so no new id has to be
/// invented, handed out or kept in sync.
pub(crate) fn pull_cancel_key(name: &str) -> String {
    format!("pull:{name}")
}

/// Download a model, reporting progress on `pull-progress`.
///
/// Cancellable FROM HERE DOWN: the flag is registered in the SAME registry
/// chat's Stop uses, so `cancel_ask("pull:<model name>")` abandons a running
/// download, which returns [`ollama::PULL_CANCELLED`].
///
/// The symptom this exists for — a 3 GB vision helper is unstoppable once
/// started, with no Cancel, no Pause and no effect from leaving the screen — is
/// NOT fixed yet: no download surface calls `cancel_ask` with a `pull:` key, so
/// nothing can reach this. Wiring one Stop button to
/// `api.cancelAsk('pull:' + name)` on each of the three (Settings → model
/// download, Settings → helpers, the image viewer's vision-helper offer)
/// completes it; the Rust half is done and tested.
#[tauri::command]
pub async fn pull_model(
    window: tauri::Window,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let cancel = Arc::new(AtomicBool::new(false));
    let key = pull_cancel_key(&name);
    state
        .cancels
        .lock()
        .unwrap()
        .insert(key.clone(), cancel.clone());
    // Removes the registry entry on every return path, including the `?` ones.
    let _cancel_guard = CancelGuard {
        state: state.inner(),
        ask_id: key,
    };
    // A multi-gigabyte pull emits a progress line per chunk — hundreds a second,
    // each one a separate IPC message and a React render, for a bar that cannot
    // show more than about 200 distinct positions. Forward only what actually
    // changes something the user can see: a new phase, half a percent of
    // progress, or the final 100%.
    let mut last_status = String::new();
    let mut last_percent: Option<f64> = None;
    ollama::pull_cancellable(&name, &cancel, |status, percent| {
        let phase_changed = status != last_status;
        let moved = match (percent, last_percent) {
            (Some(now), Some(before)) => (now - before).abs() >= PULL_PROGRESS_STEP || now >= 100.0,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if !phase_changed && !moved {
            return;
        }
        last_status = status.to_string();
        if percent.is_some() {
            last_percent = percent;
        }
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
    fn a_download_is_filed_under_a_key_the_caller_can_rebuild() {
        // The Stop button has only the model name to work with, so the key must
        // be derivable from it alone — `cancel_ask("pull:" + model)`. Pinned
        // because the frontend rebuilds this string rather than being handed it.
        assert_eq!(pull_cancel_key("qwen2.5vl"), "pull:qwen2.5vl");
        assert_eq!(pull_cancel_key("qwen2.5vl:7b"), "pull:qwen2.5vl:7b");
        // Two different downloads never share an entry.
        assert_ne!(pull_cancel_key("a"), pull_cancel_key("b"));
    }

    #[test]
    fn grounding_model_admits_when_nothing_can_aim() {
        // Live bug 2026-07-27: `vision_model` falls back to the CHAT model, so a
        // machine with no VL model installed grounded with a text-only model,
        // got `[]`, and the viewer told the user "The AI could not locate that
        // in this image" — a false claim about their picture. `grounding_model`
        // returns None instead, and locate_in_image turns that into the
        // NO_VISION_MODEL sentinel + the one-click pull.
        let none_installed = vec!["qwen3.5:4b".to_string(), "llama3:8b".to_string()];
        assert_eq!(grounding_model(&none_installed), None);
        // ...while `vision_model` still (correctly, for READING an image) hands
        // back the chat model — the two call sites want different answers.
        assert_eq!(vision_model(&none_installed, "qwen3.5:4b"), "qwen3.5:4b");

        // A real VL model is picked, and qwen2.5vl wins over qwen3-vl (measured:
        // qwen3 aims no better and pays for a thinking pass).
        let both = vec!["qwen3-vl:8b".to_string(), "qwen2.5vl:7b".to_string()];
        assert_eq!(grounding_model(&both), Some("qwen2.5vl:7b".to_string()));
        let only_q3 = vec!["qwen3-vl:8b".to_string()];
        assert_eq!(grounding_model(&only_q3), Some("qwen3-vl:8b".to_string()));
        assert_eq!(grounding_model(&[]), None);
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

    #[test]
    fn best_local_default_skips_cloud_embedding_and_external() {
        assert!(is_cloud_model("minimax-m3:cloud"));
        assert!(!is_cloud_model("qwen3.5:9b"));
        // The failing QA env: a cloud model + embeddings + a local chat model.
        // The tool loop must land on the local chat model, never the cloud one.
        let models = vec![
            "minimax-m3:cloud".to_string(),
            "nomic-embed-text:latest".to_string(),
            "qwen3.5:9b".to_string(),
        ];
        assert_eq!(best_local_default(&models), "qwen3.5:9b");
        // Only a cloud model + embeddings installed → fall back to the default
        // name so Ollama surfaces a clear "model not found" rather than driving
        // the app with a cloud model that leaks tool calls.
        let no_local = vec![
            "minimax-m3:cloud".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert_eq!(best_local_default(&no_local), DEFAULT_MODEL);
    }
}
