use super::*;

/// ADD-25: the agent↔UI bridge. The agent loop runs in Rust, but four of its
/// tools need the live webview — the numbered element snapshot, clicking or
/// typing into a control, grabbing a video frame, compositing the viewer pane.
/// Each request is one round-trip: emit an `agent-ui-request` event carrying a
/// request id, park the tool on a oneshot receiver, and let the frontend
/// driver answer through the `resolve_agent_ui` command (mirrors the SEC-1b
/// per-call MCP consent channel).
#[derive(Default)]
pub struct AgentUi {
    pub pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
}

/// How long a UI request may wait for the webview. Generous because a frame
/// grab has to stage the media and seek a `<video>` first; the driver itself
/// answers in milliseconds.
const UI_REQUEST_TIMEOUT_SECS: u64 = 20;

/// How long a request that needs a PERSON may wait.
///
/// THE BUG THIS EXISTS FOR (BROWSE-1, 2026-07-30): `browse_consent` — the
/// outbound-typing door — rides this same channel, but it is not answered by
/// the DOM driver in milliseconds. It renders a card and waits for the user to
/// read what is about to be typed into a web page and decide. On the machine
/// budget above, any hesitation past 20 seconds failed `browse_do` with "the
/// app's interface didn't answer" and left the user clicking Approve on a card
/// whose oneshot was already dead — a consent prompt that punished reading it.
const UI_CONSENT_TIMEOUT_SECS: u64 = 600;

/// Request kinds answered by a HUMAN rather than by the DOM driver.
fn needs_a_person(kind: &str) -> bool {
    kind == "browse_consent"
}

/// Ask the frontend driver to perform `kind` with `args`; returns its JSON
/// reply. Times out (with the pending entry cleaned up) if the webview never
/// answers — the tool then reports a plain error the model can react to.
pub(crate) async fn request_ui(
    window: &tauri::Window,
    ui: &AgentUi,
    kind: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
    ui.pending.lock().unwrap().insert(id.clone(), tx);
    let _ = window.emit(
        "agent-ui-request",
        serde_json::json!({ "id": id, "kind": kind, "args": args }),
    );
    let budget = if needs_a_person(kind) {
        UI_CONSENT_TIMEOUT_SECS
    } else {
        UI_REQUEST_TIMEOUT_SECS
    };
    match tokio::time::timeout(std::time::Duration::from_secs(budget), rx).await {
        Ok(Ok(v)) => {
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                Err(err.to_string())
            } else {
                Ok(v)
            }
        }
        _ => {
            ui.pending.lock().unwrap().remove(&id);
            // A human timeout is not a malfunction, and must not be reported as
            // one: the truthful reading is "nobody approved it", which is a
            // refusal the model has to respect rather than retry.
            if needs_a_person(kind) {
                Err(
                    "The user did not answer the approval request, so nothing was typed. \
                     Tell them it is still waiting rather than trying again."
                        .into(),
                )
            } else {
                Err(format!(
                    "The app's interface didn't answer the {kind} request in time."
                ))
            }
        }
    }
}

/// The frontend driver's answer to an `agent-ui-request`. `payload` may carry
/// an `error` field when the driver refused (e.g. a consent-protected control).
#[tauri::command]
pub fn resolve_agent_ui(
    ui: State<'_, AgentUi>,
    id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    if let Some(tx) = ui.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(payload);
    }
    Ok(())
}
