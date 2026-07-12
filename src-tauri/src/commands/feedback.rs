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
    let model = resolve_structured_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — you can still write the issue yourself.")?;
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "body": {"type": "string"}
        },
        "required": ["title", "body"]
    });
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You turn a user's raw feedback about the Private Room desktop app into a clear \
             GitHub issue. Title: one short, specific English summary line (under 70 \
             characters, no trailing period). Body: GitHub Markdown with '## What happened' \
             and, only when the feedback implies them, '## Expected' and '## Steps to \
             reproduce'. Preserve the user's meaning exactly — never invent details. If the \
             feedback is not in English, keep the original text quoted in the body and add \
             an English summary above it.",
        ),
        ollama::ChatMessage::new("user", text.clone()),
    ];
    let raw = ollama::chat_structured(&model, messages, Some(0.3), KEEP_ALIVE_SHORT, &schema).await?;
    let parsed: Option<(String, String)> = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| {
            let title = v.get("title")?.as_str()?.trim().to_string();
            let body = v.get("body")?.as_str()?.trim().to_string();
            (!title.is_empty() && !body.is_empty()).then_some((title, body))
        });
    // Resilience: the words survive any model misfire.
    let (title, body) = parsed.unwrap_or_else(|| {
        let title: String = text.lines().next().unwrap_or("Feedback").chars().take(70).collect();
        (title, format!("## What happened\n\n{text}"))
    });
    Ok(FeedbackDraft { title: title.chars().take(120).collect(), body })
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
