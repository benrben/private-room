use super::*;

// ADD-28: send feedback as a GitHub issue — drafted locally, sent by the
// USER's browser, never by the app. The only network hop is the user opening
// github.com themselves with the title/body prefilled in the URL, which keeps
// the privacy pledge intact: the app itself still talks to nothing but Ollama.

/// Where feedback lands. Single source of truth for the frontend too.
pub(crate) const FEEDBACK_REPO: &str = "benrben/private-room";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDraft {
    pub title: String,
    pub body: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppDiag {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub repo: String,
}

/// Version + platform facts for the issue footer (shown to the user first,
/// included only when they leave the checkbox on).
#[tauri::command]
pub fn app_diag(app: tauri::AppHandle) -> AppDiag {
    AppDiag {
        version: app.package_info().version.to_string(),
        os: sysinfo::System::long_os_version().unwrap_or_else(|| "macOS".into()),
        arch: std::env::consts::ARCH.into(),
        repo: FEEDBACK_REPO.into(),
    }
}

/// Shape raw feedback into a GitHub-ready title + Markdown body on the LOCAL
/// model (like dictation shaping, feedback text never goes to a cloud engine).
/// Writing by hand stays first-class — this is optional help, and any model
/// failure returns a plain fallback instead of blocking the user.
#[tauri::command]
pub async fn feedback_draft(
    state: State<'_, AppState>,
    text: String,
) -> Result<FeedbackDraft, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Write a few words about what happened first.".into());
    }
    // The empty-text guard and model resolution stay in Rust (DB work); the prompt,
    // schema, model call, parse and the words-survive-any-misfire fallback now live
    // in the sidecar's /feedback_draft. It returns the finished {title, body}; a
    // genuine engine failure comes back as a 502 we map to the same sentinel
    // chat_structured produced (so the "Ollama isn't running" surface is unchanged).
    let model = resolve_structured_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — you can still write the issue yourself.")?;
    let body = serde_json::json!({
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "text": text,
    });
    let v = crate::sidecar::sidecar_json("/feedback_draft", &body)
        .await
        .map_err(|e| e.sentinel(Some(&model)))?;
    let title = v["title"].as_str().unwrap_or_default().to_string();
    let body = v["body"].as_str().unwrap_or_default().to_string();
    Ok(FeedbackDraft { title, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diag_has_the_basics() {
        // No AppHandle in unit tests; check the parts that don't need one.
        assert!(!FEEDBACK_REPO.is_empty());
        assert!(FEEDBACK_REPO.contains('/'));
        let arch = std::env::consts::ARCH;
        assert!(!arch.is_empty());
    }
}
