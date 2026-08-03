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

/// What the caller is told when the request it is answering is no longer
/// waiting. The frontend matches on nothing here — it shows the sentence — but
/// it must stay a sentence a person can act on.
pub(crate) const NO_LONGER_WAITING: &str =
    "That request had already been given up on, so answering it now did nothing. \
     Ask again if you still want it.";

/// The frontend driver's answer to an `agent-ui-request`. `payload` may carry
/// an `error` field when the driver refused (e.g. a consent-protected control).
///
/// Answering an id that is NOT pending is an ERROR, not a no-op. A consent card
/// stays on screen forever while the tool call behind it gives up on its own
/// budget (`UI_CONSENT_TIMEOUT_SECS`) and is told "nobody approved it". Pressing
/// Allow afterwards used to return `Ok(())`: the card vanished, the user had
/// every reason to believe the typing was approved, and nothing ran. Reporting
/// the truth is the only way the card can say so.
#[tauri::command]
pub fn resolve_agent_ui(
    ui: State<'_, AgentUi>,
    id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    deliver_ui_answer(&ui, &id, payload)
}

/// The command's body, without the Tauri wrapper, so the expired case is
/// testable.
pub(crate) fn deliver_ui_answer(
    ui: &AgentUi,
    id: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let Some(tx) = ui.pending.lock().unwrap().remove(id) else {
        return Err(NO_LONGER_WAITING.into());
    };
    // The receiver can also be gone between the timeout arm and this line — the
    // same fact, told the same way rather than swallowed.
    tx.send(payload).map_err(|_| NO_LONGER_WAITING.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answering_a_request_that_gave_up_reports_it() {
        let ui = AgentUi::default();
        // A live request is delivered and reported as delivered.
        let (tx, mut rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
        ui.pending.lock().unwrap().insert("live".into(), tx);
        assert!(deliver_ui_answer(&ui, "live", serde_json::json!({"approved": true})).is_ok());
        assert_eq!(rx.try_recv().unwrap()["approved"], true);

        // The same id again: the tool call has moved on, and an Ok here is the
        // lie the consent card used to tell.
        let err = deliver_ui_answer(&ui, "live", serde_json::json!({"approved": true}))
            .expect_err("a spent id must not read as delivered");
        assert_eq!(err, NO_LONGER_WAITING);

        // Timed out: the pending entry is gone, so Allow reports the truth.
        assert!(deliver_ui_answer(&ui, "expired", serde_json::json!({"approved": true})).is_err());

        // Receiver dropped without the entry being removed (the tool task died).
        let (tx2, rx2) = tokio::sync::oneshot::channel::<serde_json::Value>();
        ui.pending.lock().unwrap().insert("orphan".into(), tx2);
        drop(rx2);
        assert!(deliver_ui_answer(&ui, "orphan", serde_json::json!({})).is_err());
    }
}
