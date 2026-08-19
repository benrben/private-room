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

/// The `{title, body}` the sidecar's `/feedback_draft` promised — or the
/// sentence to show when it answered with something else. Split out so the
/// contract can be exercised without a room, a model or a sidecar.
fn read_draft(v: &serde_json::Value) -> Result<FeedbackDraft, String> {
    let field = |key: &str| -> Result<String, String> {
        v[key].as_str().map(str::to_string).ok_or_else(|| {
            format!("The draft came back without a {key} — this version cannot read it. Your own words are still in the box.")
        })
    };
    Ok(FeedbackDraft {
        title: field("title")?,
        body: field("body")?,
    })
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
    // The model is picked the way dictation shaping picks one, and for the same
    // reason: a bug report is a description of what the user was doing in a
    // private room. `resolve_structured_model` honours the room's chosen engine,
    // so with a `:cloud` or CLI model selected the raw text went off the Mac —
    // while the comment above promised it never does. The room's own model still
    // wins whenever it runs here; only a non-local pick is swapped out.
    let models = ollama::list_models()
        .await
        .map_err(|_| "The local AI (Ollama) isn't running — you can still write the issue yourself.".to_string())?;
    if models.is_empty() {
        return Err("No local AI model is installed — you can still write the issue yourself.".into());
    }
    let mut model = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .and_then(|room| model_setting(&room.conn))
            .unwrap_or_else(|| best_local_default(&models))
    };
    if !runs_on_this_mac(&model) {
        model = best_local_default(&models);
    }
    let body = serde_json::json!({
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "text": text,
    });
    let v = crate::sidecar::sidecar_json("/feedback_draft", &body)
        .await
        .map_err(|e| e.sentinel(Some(&model)))?;
    // REQUIRED, not defaulted. The sidecar always answers with both fields (it
    // falls back to the user's own words on any model misfire), so a missing or
    // renamed one is a broken contract between host and sidecar — and defaulting
    // it to "" handed the modal two empty boxes with no error, which reads as
    // "the AI had nothing to say" and quietly wipes what the user typed there.
    let draft = read_draft(&v)?;
    Ok(draft)
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

    #[test]
    fn a_draft_in_an_unreadable_shape_says_so_instead_of_coming_back_blank() {
        let good = serde_json::json!({ "title": "Recording stops at 3 h", "body": "## What happened" });
        let d = read_draft(&good).expect("the shape the sidecar promises");
        assert_eq!(d.title, "Recording stops at 3 h");
        assert_eq!(d.body, "## What happened");

        // A rename on the sidecar side used to arrive as two empty strings: the
        // modal wrote them straight into its boxes, showed no error, and left
        // Open-issue disabled with nothing saying why.
        let renamed = serde_json::json!({ "issue_title": "x", "issue_body": "y" });
        let err = read_draft(&renamed)
            .err()
            .expect("a shape drift must not read as an empty draft");
        assert!(err.contains("title"), "the error must name what was missing: {err}");
        // Half a contract is still a broken one.
        let half = serde_json::json!({ "title": "x" });
        assert!(read_draft(&half).is_err());
        // …and a field that is present but not text.
        let wrong_type = serde_json::json!({ "title": "x", "body": ["y"] });
        assert!(read_draft(&wrong_type).is_err());
    }
}
