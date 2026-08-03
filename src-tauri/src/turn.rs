//! Run/chat identity for every event a chat turn emits.
//!
//! Owner replacement #4, 2026-08-03. Two live-QA symptoms shared one cause:
//! an answer streamed into whatever conversation happened to be on screen, and
//! a brand-new chat showed a 30,034-token budget bar. Neither is a bug in the
//! turn itself — the answer is filed against the right chat and the history
//! really is empty. The events were simply anonymous: `window.emit("ask-delta",
//! …)` is a broadcast, so the only way the UI could guess who an event belonged
//! to was "whatever is mounted right now".
//!
//! So every `ask-*` event now travels in an envelope naming the run that
//! produced it and the chat that owns it:
//!
//! ```json
//! { "runId": "…", "chatId": "…", "v": <the payload the listener used to get> }
//! ```
//!
//! `runId` is the ask id the FRONTEND minted and passed to `ask`/`run_command`,
//! so the chat registers the run before the first event can arrive and can then
//! reject anything that does not match — including a late event from a turn it
//! has already finished. The same id is the `/cancel` handle and the sidecar's
//! own `run_id`, so it is stable across the whole turn: tool calls over the MCP
//! bridge and sub-agent delegation inside the graph all report under it.
//!
//! IDs only. Nothing here carries room content — the envelope is two opaque
//! handles and the payload the listener already received.

use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Runtime};

/// The identity of one chat turn. Cheap to clone (two `Arc<str>`), because it
/// is threaded down every path an event can be emitted from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnId {
    run_id: Arc<str>,
    chat_id: Arc<str>,
}

impl TurnId {
    pub fn new(run_id: &str, chat_id: &str) -> Self {
        Self {
            run_id: Arc::from(run_id),
            chat_id: Arc::from(chat_id),
        }
    }

    /// The run handle — the frontend's ask id, the `/cancel` token, and the
    /// `run_id` the sidecar echoes on every NDJSON line of this run.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn chat_id(&self) -> &str {
        &self.chat_id
    }

    /// Emit one identified turn event. Failures are ignored exactly as the bare
    /// `window.emit` calls this replaced did: a closed window must never fail a
    /// running turn.
    pub fn emit<R: Runtime, E: Emitter<R>, T: Serialize + Clone>(
        &self,
        to: &E,
        event: &str,
        payload: T,
    ) {
        let _ = to.emit(event, envelope(Some(self), payload));
    }

    /// The overwhelmingly common case: one step chip.
    pub fn step<R: Runtime, E: Emitter<R>>(&self, to: &E, label: impl Into<String>) {
        self.emit(to, "ask-step", label.into());
    }
}

/// A turn event emitted by something that genuinely has no turn — today only
/// the AI-actions menu command, which runs from the file header and belongs to
/// no conversation at all.
///
/// The ids are null RATHER than borrowed from whatever is on screen, and the
/// frontend treats a null-id event as "show it only if the chat in front of me
/// is actually running something". Guessing an owner here is precisely the
/// behaviour this module exists to delete.
pub fn emit_unowned<R: Runtime, E: Emitter<R>, T: Serialize + Clone>(
    to: &E,
    event: &str,
    payload: T,
) {
    let _ = to.emit(event, envelope(None, payload));
}

/// A step chip from a caller that may not know its turn. A tool executed over
/// a PERSISTENT bridge (a Leash server, a nested advisor) genuinely has no ask
/// behind it, so it emits null ids rather than borrowing the screen's chat.
pub fn step_for<R: Runtime, E: Emitter<R>>(
    turn: Option<&TurnId>,
    to: &E,
    label: impl Into<String>,
) {
    match turn {
        Some(t) => t.step(to, label),
        None => emit_unowned(to, "ask-step", label.into()),
    }
}

/// The wire shape. `v` holds what the listener used to receive unchanged, so
/// every payload type (a bare string for `ask-delta`, an object for `ask-step`,
/// `()` for `ask-round`) keeps its meaning.
#[derive(Clone, Debug, Serialize)]
pub struct TurnEvent<T: Serialize + Clone> {
    #[serde(rename = "runId")]
    pub run_id: Option<Arc<str>>,
    #[serde(rename = "chatId")]
    pub chat_id: Option<Arc<str>>,
    pub v: T,
}

/// Wrap a payload for `turn` (or for nobody). Split out from [`TurnId::emit`]
/// so the wire shape can be asserted without a Tauri runtime.
pub fn envelope<T: Serialize + Clone>(turn: Option<&TurnId>, v: T) -> TurnEvent<T> {
    TurnEvent {
        run_id: turn.map(|t| t.run_id.clone()),
        chat_id: turn.map(|t| t.chat_id.clone()),
        v,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identified_event_names_its_run_and_its_chat() {
        let turn = TurnId::new("run-1", "chat-a");
        let wire = serde_json::to_value(envelope(Some(&turn), "half an answer")).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"runId": "run-1", "chatId": "chat-a", "v": "half an answer"})
        );
    }

    #[test]
    fn the_payload_shape_the_listener_used_to_get_is_untouched() {
        // `ask-step` carries an object, `ask-round` carries nothing. Both must
        // survive the envelope byte-identically inside `v`.
        let turn = TurnId::new("run-2", "chat-b");
        let step = serde_json::json!({"label": "Reading part 2/9", "node": "file#1"});
        let wire = serde_json::to_value(envelope(Some(&turn), step.clone())).unwrap();
        assert_eq!(wire["v"], step);
        let round = serde_json::to_value(envelope(Some(&turn), ())).unwrap();
        assert_eq!(round["v"], serde_json::Value::Null);
    }

    #[test]
    fn an_unowned_event_says_so_instead_of_borrowing_an_owner() {
        // The whole point: no turn means NULL ids, never "the chat on screen".
        let wire = serde_json::to_value(envelope(None, "Summarize")).unwrap();
        assert_eq!(wire["runId"], serde_json::Value::Null);
        assert_eq!(wire["chatId"], serde_json::Value::Null);
        assert_eq!(wire["v"], "Summarize");
    }
}
