//! Wave 2 (Idea 6): an opt-in diff-preview approval gate for file-mutating tool
//! calls, modeled line-for-line on the SEC-1b MCP gate (`mcp_call_approved`):
//! oneshot + 180s timeout, decline-by-default, `data-agent-blocked` self-approval
//! guard on the frontend. Default OFF — the instant-apply + auto-snapshot +
//! one-click Undo model already covers regret post-hoc.
//!
//! The hard part is the lock discipline: the room lock is a `std::sync::Mutex`
//! whose guard is not `Send`, so it can NEVER be held across the approval await.
//! Every gated arm runs lock-read (compute proposed bytes + staleness token) →
//! drop → await approval → re-lock (staleness re-check) → apply.

use super::*;

/// What the frontend renders as a diff card. One `FilePreview` per touched file.
pub(crate) struct EditPreview {
    pub tool: &'static str,
    /// Whether the "Apply for the rest of this answer" button is offered — only
    /// when the cadence is "turn" AND this is the run-scoped LocalEngine sink.
    pub allow_turn: bool,
    pub files: Vec<FilePreview>,
}

pub(crate) struct FilePreview {
    pub name: String,
    pub before: String,
    pub after: String,
    pub clipped: bool,
}

/// The result of running a mutation through the gate.
pub(crate) enum GateOutcome {
    Applied(Vec<PlannedWrite>),
    /// The user declined (or timed out) — an Ok-not-Err message the model can
    /// recover from, mirroring the MCP decline path.
    Declined(String),
    Error(EditError),
}

/// Cadence: does THIS mutating call need approval? `off`/absent/unknown ⇒ never.
/// `edit` ⇒ every call. `turn` ⇒ once per answer (skipped after the user chose
/// "rest of this answer", which only sticks on the run-scoped sink).
pub(crate) fn approval_needed(setting: Option<&str>, effects: &ToolEffects) -> bool {
    match setting {
        Some("edit") => true,
        Some("turn") => !(effects.run_scoped && effects.edit_approved_this_turn),
        _ => false,
    }
}

/// Map the frontend's decision string. Factored out so it is unit-testable.
pub(crate) fn decision_from_str(decision: &str) -> EditDecision {
    match decision {
        "once" => EditDecision { approved: true, rest_of_turn: false },
        "turn" => EditDecision { approved: true, rest_of_turn: true },
        _ => EditDecision { approved: false, rest_of_turn: false },
    }
}

/// The frontend's answer to an `edit-approve-request` — "once", "turn", or
/// anything else (declined). Registered in `lib.rs` next to `resolve_mcp_call`.
#[tauri::command]
pub fn resolve_edit_approval(
    state: State<'_, AppState>,
    id: String,
    decision: String,
) -> Result<(), String> {
    let d = decision_from_str(&decision);
    if let Some(tx) = state.edit_pending.lock().unwrap().remove(&id) {
        let _ = tx.send(d);
    }
    Ok(())
}

/// SEC-1b-shaped: emit the diff, await a decision, decline on timeout/closed
/// window. On "rest of this answer" set the turn flag — but only on the
/// run-scoped sink, where it actually persists for the answer.
async fn edit_call_approved(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    effects: &mut ToolEffects,
    preview: &EditPreview,
) -> bool {
    use tauri::Emitter;
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<EditDecision>();
    state.edit_pending.lock().unwrap().insert(id.clone(), tx);
    let files: Vec<serde_json::Value> = preview
        .files
        .iter()
        .map(|f| {
            serde_json::json!({
                "name": f.name, "before": f.before, "after": f.after, "clipped": f.clipped
            })
        })
        .collect();
    let _ = window.emit(
        "edit-approve-request",
        serde_json::json!({
            "id": id,
            "tool": preview.tool,
            "allowTurn": preview.allow_turn,
            "files": files,
        }),
    );
    let decision = match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.edit_pending.lock().unwrap().remove(&id);
            EditDecision { approved: false, rest_of_turn: false }
        }
    };
    if decision.approved && decision.rest_of_turn && effects.run_scoped {
        effects.edit_approved_this_turn = true;
    }
    decision.approved
}

/// Emit the post-write events and set the anti-fabrication `wrote` flag.
fn finish(window: &tauri::Window, effects: &mut ToolEffects, plans: &[PlannedWrite]) {
    use tauri::Emitter;
    effects.wrote = true;
    let _ = window.emit("room-files-changed", ());
    for p in plans {
        let _ = window.emit("file-updated", &p.file_id);
    }
}

fn build_preview(tool: &'static str, plans: &[PlannedWrite], allow_turn: bool) -> EditPreview {
    EditPreview {
        tool,
        allow_turn,
        files: plans
            .iter()
            .map(|p| FilePreview {
                name: p.rename_to.clone().unwrap_or_else(|| p.real_name.clone()),
                before: p.before.clone(),
                after: p.after.clone(),
                clipped: p.clipped,
            })
            .collect(),
    }
}

/// Phase 3 core: re-check each plan's staleness token against the file's CURRENT
/// bytes (strict-fail — the user approved specific bytes; a concurrent change
/// means the preview lied), then commit all plans in one transaction. Extracted
/// so the staleness behavior is unit-testable without a window.
pub(crate) fn apply_with_staleness(
    conn: &Connection,
    plans: &[PlannedWrite],
    cause: &str,
) -> Result<(), EditError> {
    for p in plans {
        if let Some(token) = &p.staleness {
            let current = db::get_file_bytes(conn, &p.file_id).ok().flatten().unwrap_or_default();
            if &hash_bytes(&current) != token {
                return Err(EditError::new(
                    format!(
                        "\"{}\" changed while the approval was pending; nothing was applied. \
                         Read it again and retry.",
                        p.real_name
                    ),
                    "stale",
                ));
            }
        }
    }
    commit_plans(conn, plans, cause).map_err(|e| EditError::new(e, "error"))
}

/// Run a file mutation through the diff-preview gate. `compute` produces the
/// proposed writes under the room lock (no writes). With the gate off (default),
/// the writes commit inside that same lock — byte-identical to the pre-Wave-2
/// path. With it on, the lock is dropped, the diff is shown, and on consent the
/// ALREADY-COMPUTED bytes are re-checked for staleness and applied under a fresh
/// lock. The room mutex is NEVER held across the await.
pub(crate) async fn gated_write(
    tool: &'static str,
    cause: &str,
    state: &State<'_, AppState>,
    window: &tauri::Window,
    effects: &mut ToolEffects,
    compute: impl FnOnce(&Connection) -> Result<Vec<PlannedWrite>, EditError>,
) -> GateOutcome {
    // Phase 1 (locked, sync): compute proposed writes, decide whether to gate.
    let (plans, allow_turn) = {
        let guard = state.room.lock().unwrap();
        let room = match guard.as_ref() {
            Some(r) => r,
            None => return GateOutcome::Error(EditError::new("No room is open.", "error")),
        };
        let plans = match compute(&room.conn) {
            Ok(p) => p,
            Err(e) => return GateOutcome::Error(e),
        };
        if plans.is_empty() {
            return GateOutcome::Error(EditError::new("Nothing to change.", "error"));
        }
        let setting = db::get_setting(&room.conn, "edit_approval");
        let allow_turn = setting.as_deref() == Some("turn") && effects.run_scoped;
        if !approval_needed(setting.as_deref(), effects) {
            // Gate off (or "turn" already granted): apply under THIS lock.
            if let Err(e) = commit_plans(&room.conn, &plans, cause) {
                return GateOutcome::Error(EditError::new(e, "error"));
            }
            drop(guard);
            finish(window, effects, &plans);
            return GateOutcome::Applied(plans);
        }
        (plans, allow_turn)
    };

    // Phase 2 (unlocked): show the diff and await consent.
    let preview = build_preview(tool, &plans, allow_turn);
    if !edit_call_approved(state, window, effects, &preview).await {
        return GateOutcome::Declined(
            "The user declined the proposed change after seeing the preview, so nothing was \
             modified. Ask what they'd like instead."
                .into(),
        );
    }

    // Phase 3 (locked, sync): staleness re-check, then apply the computed bytes.
    {
        let guard = state.room.lock().unwrap();
        match guard.as_ref() {
            Some(room) => {
                if let Err(e) = apply_with_staleness(&room.conn, &plans, cause) {
                    return GateOutcome::Error(e);
                }
            }
            None => return GateOutcome::Error(EditError::new("No room is open.", "error")),
        }
    }
    finish(window, effects, &plans);
    GateOutcome::Applied(plans)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effects_with(run_scoped: bool, granted: bool) -> ToolEffects {
        ToolEffects { run_scoped, edit_approved_this_turn: granted, ..Default::default() }
    }

    #[test]
    fn approval_needed_follows_cadence() {
        // Off / absent / unknown → never prompt.
        for s in [None, Some("off"), Some("whatever")] {
            assert!(!approval_needed(s, &effects_with(true, false)));
        }
        // Every-edit → always prompt.
        assert!(approval_needed(Some("edit"), &effects_with(true, false)));
        assert!(approval_needed(Some("edit"), &effects_with(true, true)));
        // Once-per-answer on the run-scoped sink: prompt until granted.
        assert!(approval_needed(Some("turn"), &effects_with(true, false)));
        assert!(!approval_needed(Some("turn"), &effects_with(true, true)));
        // Sink-less (cloud/external) scope: the turn flag can't persist, so
        // "turn" degrades to per-edit prompting — always prompt.
        assert!(approval_needed(Some("turn"), &effects_with(false, true)));
    }

    #[test]
    fn decision_string_maps_once_turn_deny() {
        let once = decision_from_str("once");
        assert!(once.approved && !once.rest_of_turn);
        let turn = decision_from_str("turn");
        assert!(turn.approved && turn.rest_of_turn);
        let deny = decision_from_str("deny");
        assert!(!deny.approved && !deny.rest_of_turn);
        // Any unknown string is a decline, never a silent yes.
        assert!(!decision_from_str("").approved);
        assert!(!decision_from_str("garbage").approved);
    }

    #[test]
    fn stale_apply_refuses_and_leaves_file_untouched() {
        let conn = db::open_in_memory_schema();
        let id = db::insert_file(&conn, "n.md", "text/plain", b"before edits", Some("before edits"), "upload")
            .unwrap()
            .id;
        // Phase 1: compute the plan (against the current bytes + hash).
        let edit = PreviewEdit {
            name: "n.md".into(),
            old_text: "before".into(),
            new_text: "AFTER".into(),
            all: false,
        };
        let plans = plan_single_edit(&conn, &edit).unwrap();
        // A concurrent change lands while the approval card is open.
        store_file_bytes(&conn, &id, b"before edits (touched)", Some("before edits (touched)"), "You saved")
            .unwrap();
        let before_versions = db::list_file_versions(&conn, &id).unwrap().len();
        // Phase 3: the staleness token no longer matches → strict refusal.
        let err = apply_with_staleness(&conn, &plans, "AI edit").unwrap_err();
        assert_eq!(err.outcome, "stale");
        // The concurrent bytes are intact; no new snapshot from the refused apply.
        assert_eq!(db::get_file_bytes(&conn, &id).unwrap().unwrap(), b"before edits (touched)");
        assert_eq!(db::list_file_versions(&conn, &id).unwrap().len(), before_versions);
    }

    #[test]
    fn preview_builds_content_for_docx_and_cells() {
        let conn = db::open_in_memory_schema();
        // docx: before/after are EXTRACTED text, not raw XML.
        let docx = crate::extraction::fake_office_zip(
            "word/document.xml",
            r#"<w:document><w:p><w:t>Fee is 5% today</w:t></w:p></w:document>"#,
        );
        db::insert_file(&conn, "c.docx", "application/vnd.openxmlformats", &docx, Some("Fee is 5% today"), "upload")
            .unwrap();
        let edit = PreviewEdit {
            name: "c.docx".into(),
            old_text: "5%".into(),
            new_text: "7%".into(),
            all: false,
        };
        let plans = plan_single_edit(&conn, &edit).unwrap();
        assert!(plans[0].before.contains("Fee is 5%"), "before is extracted text");
        assert!(plans[0].after.contains("7%"), "after reflects the edit");
        assert!(!plans[0].before.contains("<w:t>"), "no raw markup leaks into the preview");

        // csv cells: before/after synthesized from the file text (no cell reader).
        db::insert_file(&conn, "b.csv", "text/csv", b"a,1\nb,2\n", Some("a,1\nb,2\n"), "upload").unwrap();
        let cells = plan_set_cells(&conn, "b.csv", None, &[("B1".into(), "9".into())]).unwrap();
        assert!(cells[0].before.contains("a,1"), "before shows current cells");
        assert!(cells[0].after.contains("a,9"), "after shows the changed cell");
    }
}
