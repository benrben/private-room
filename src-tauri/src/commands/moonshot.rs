use super::*;

mod ai_actions;
mod discovery;
mod front_page;
mod graph;
mod roles;
mod server;

pub use ai_actions::*;
pub(crate) use discovery::*;
pub use front_page::*;
pub use graph::*;
pub use roles::*;
pub use server::*;

/// Resolve the chat model for a structured side-call (studios, AI actions,
/// front page, feedback drafts), honoring the room's explicit `model` setting.
/// ADD-29 parity: a selected `:cloud` model IS used — current cloud models honor
/// the `format` grammar and emit structured tool_calls, and the UI labels them
/// "Cloud · leaves this Mac". Only external CLI engines (claude-cli/codex-cli),
/// which don't speak the Ollama API at all, are swapped for a local model.
/// Returns None when Ollama is unreachable or has no models, so callers can
/// degrade to empty/partial output.
pub(crate) async fn resolve_structured_model(state: &State<'_, AppState>) -> Option<String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.ok()?;
    if models.is_empty() {
        return None;
    }
    let model = explicit.unwrap_or_else(|| best_default(&models));
    let model = if is_external_engine(&model) {
        best_local_default(&models)
    } else {
        model
    };
    Some(model)
}

// ---- D1: recommended models -------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedModels {
    pub chat: Vec<String>,
    pub embed: String,
    pub vision: String,
}

/// D1: the curated model set the first-run chooser and Settings drive pulls
/// from. Pure/static — `chat` mirrors the frontend RECOMMENDED_MODELS, `vision`
/// matches the grounding router's Qwen-VL pick, `embed` is the shared constant.
#[tauri::command]
pub fn recommended_models() -> RecommendedModels {
    RecommendedModels {
        chat: vec!["qwen3.5:4b".into(), "qwen3.5:9b".into(), "gemma3:4b".into()],
        embed: ollama::EMBED_MODEL.to_string(),
        vision: "qwen2.5vl".to_string(),
    }
}

// ---- D2: ensure the embed model --------------------------------------------

/// D2: make sure the embedding model is present so semantic retrieval and the
/// room graph work, then kick the background backfill. Best-effort: if Ollama is
/// down or the pull fails it still returns Ok — keyword retrieval keeps working.
/// Emits the shared `pull-progress` events during a pull, and stamps `meta` once
/// the model is available so a room records what indexed it.
#[tauri::command]
pub async fn ensure_embed_model(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use tauri::Emitter;
    let models = ollama::list_models().await.unwrap_or_default();
    let present = models.iter().any(|m| m.starts_with(ollama::EMBED_MODEL));
    let available = if present {
        true
    } else {
        ollama::pull(ollama::EMBED_MODEL, |status, percent| {
            let _ = window.emit(
                "pull-progress",
                serde_json::json!({ "status": status, "percent": percent }),
            );
        })
        .await
        .is_ok()
    };
    // nomic-embed-text is 768-dimensional; stamp it once the model is available
    // (the vectors themselves follow via the backfill below).
    if available {
        if let Some(room) = state.room.lock().unwrap().as_ref() {
            let _ = db::set_meta(&room.conn, "embed_model", ollama::EMBED_MODEL);
            let _ = db::set_meta(&room.conn, "embed_dim", "768");
        }
    }
    spawn_embedding_backfill(&app);
    Ok(())
}

// ---- self-contained HTML templates (studios) --------------------------------


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommended_models_are_populated() {
        // D1: the frontend pulls this to drive first-run downloads.
        let r = recommended_models();
        assert!(r.chat.iter().any(|m| m == "qwen3.5:4b"), "chat list has the default");
        assert_eq!(r.embed, ollama::EMBED_MODEL);
        assert_eq!(r.vision, "qwen2.5vl");
    }
}
