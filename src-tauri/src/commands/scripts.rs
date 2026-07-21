//! Wave 5 (Idea 13): the SCRIPT surface — consent, the manual-run gate, the
//! auto-workflow, and the Scripts-page commands. The actual runner lives in
//! `jobs::script_run`; scheduling reuses the Wave 4a queue + scheduler through a
//! per-script auto-created single-node workflow (no parallel job system).
//!
//! Consent follows the SEC-1 doctrine EXACTLY (mcp_cmds.rs): the room's author is
//! the attacker, so approvals are per-Mac, content-addressed (SHA-256 of the
//! script bytes), and NEVER inside the `.roomai`. Any edit changes the hash → the
//! old approval no longer counts → a re-prompt, for free.

use super::*;
use std::time::Duration;

// ------------------------------------------------------------ approvals (SEC-1)

/// Approved script fingerprints live OUTSIDE any room, in the app's own data
/// folder — a clone of `mcp_approvals_file` (mcp_cmds.rs), targeting
/// `script_approvals.json`.
pub(crate) fn script_approvals_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("script_approvals.json"))
}

pub(crate) fn read_script_approvals(app: &tauri::AppHandle) -> Vec<String> {
    script_approvals_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn add_script_approval(app: &tauri::AppHandle, fingerprint: &str) {
    let mut list = read_script_approvals(app);
    if list.iter().any(|f| f == fingerprint) {
        return;
    }
    list.push(fingerprint.to_string());
    if let Ok(path) = script_approvals_file(app) {
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(path, json);
        }
    }
}

// ------------------------------------------------------------ manual-run gate

/// Everything the consent card needs to describe what would run.
struct ScriptBrief {
    name: String,
    sha: String,
    interpreter_line: String,
    manifest: ScriptManifest,
}

/// The human command line the run would execute, e.g. "uv run --no-project x.py".
fn interpreter_line(runner: &Runner, script_name: &str) -> String {
    let prog = std::path::Path::new(&runner.program)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| runner.program.clone());
    let mut parts = vec![prog];
    parts.extend(runner.argv_prefix.iter().cloned());
    parts.push(script_name.to_string());
    parts.join(" ")
}

/// SEC-1b clone of `mcp_call_approved`, tied to the moment code would run.
/// Emits `script-approve-request`, awaits the frontend's answer (180 s timeout =
/// decline), and on "always" persists the fingerprint. The card is
/// `data-agent-blocked` on the frontend — the UI-driving agent must never approve
/// its own script.
async fn script_run_approved(
    app: &tauri::AppHandle,
    state: &AppState,
    window: &tauri::Window,
    brief: &ScriptBrief,
) -> bool {
    use tauri::Emitter;
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<McpDecision>();
    state.script_pending.lock().unwrap().insert(id.clone(), tx);
    let _ = window.emit(
        "script-approve-request",
        serde_json::json!({
            "id": id,
            "name": brief.name,
            "interpreterLine": brief.interpreter_line,
            "deps": brief.manifest.deps,
            "inputs": brief.manifest.inputs,
            "outputs": brief.manifest.outputs,
            "timeout": brief.manifest.timeout_secs,
        }),
    );
    let decision = match tokio::time::timeout(Duration::from_secs(180), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.script_pending.lock().unwrap().remove(&id);
            McpDecision { approved: false, remember: false }
        }
    };
    if decision.approved && decision.remember {
        add_script_approval(app, &brief.sha);
    }
    decision.approved
}

/// The frontend's answer to a `script-approve-request` — "once" | "always" |
/// anything else (declined). Clone of `resolve_mcp_call`.
#[tauri::command]
pub fn resolve_script_run(state: State<'_, AppState>, id: String, decision: String) -> Result<(), String> {
    let d = match decision.as_str() {
        "once" => McpDecision { approved: true, remember: false },
        "always" => McpDecision { approved: true, remember: true },
        _ => McpDecision { approved: false, remember: false },
    };
    if let Some(tx) = state.script_pending.lock().unwrap().remove(&id) {
        let _ = tx.send(d);
    }
    Ok(())
}

/// For a MANUAL workflow run: make every `script_run` node the workflow embeds
/// runnable by obtaining consent for any whose current content isn't already
/// approved on this Mac — surfacing the SAME consent card as the Scripts page
/// (`script-approve-request`), which the global frontend listener renders. Returns
/// the freshly-granted fingerprints to fold into the run's `extra_consents`, so
/// `stamp_script_consents` then stamps them into the plan snapshot.
///
/// This closes the gap where a workflow embedding a script (e.g. one the agent
/// drafted) parked every run with "Script changed since it was approved" even
/// though the script was never approved — the workflow runner had no consent path.
/// Scheduled/agent/catch-up triggers deliberately never call this (a cron tick
/// must not prompt, and the UI-driving agent must not approve its own code — the
/// SEC-1 doctrine); an embedded script they haven't been pre-approved for still
/// parks. A decline aborts the run with an actionable, script-named error.
pub(crate) async fn approve_workflow_scripts(
    window: &tauri::Window,
    state: &AppState,
    def: &WorkflowDef,
) -> Result<HashSet<String>, String> {
    use tauri::Manager as _;
    let app = window.app_handle().clone();
    let approved: HashSet<String> = read_script_approvals(&app).into_iter().collect();
    let mut grants: HashSet<String> = HashSet::new();
    // Dedupe by fingerprint so a workflow running the same script twice prompts once.
    let mut seen: HashSet<String> = HashSet::new();
    for node in &def.nodes {
        let NodeKind::ScriptRun { file, .. } = &node.kind else {
            continue;
        };
        // Resolve `file` (a stored id, or a name) to (name, bytes) — the same
        // resolution the consent-stamping + executor use.
        let resolved: Option<(String, Vec<u8>)> = state.with_room(|room| {
            if let Ok((name, bytes)) = db::get_file_bytes_named(&room.conn, file) {
                Ok(Some((name, bytes.unwrap_or_default())))
            } else if let Ok((id, _)) = db::find_file_like(&room.conn, file) {
                match db::get_file_bytes_named(&room.conn, &id) {
                    Ok((name, bytes)) => Ok(Some((name, bytes.unwrap_or_default()))),
                    Err(_) => Ok(None),
                }
            } else {
                Ok(None)
            }
        })?;
        // An unresolvable script (or a non-.py/.js file) is left to the executor to
        // surface honestly — no consent card for a file we can't run.
        let Some((name, bytes)) = resolved else { continue };
        if script_lang_of(&name).is_none() {
            continue;
        }
        let sha = script_fingerprint(&bytes);
        if approved.contains(&sha) || !seen.insert(sha.clone()) {
            continue;
        }
        // Resolve the runtime first — an actionable "install uv/python" error is
        // better raised before the consent card than after (mirrors `run_script`).
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let manifest = parse_script_manifest(&name, &text);
        let runner = resolve_interpreter(&manifest)?;
        let brief = ScriptBrief {
            name: name.clone(),
            sha: sha.clone(),
            interpreter_line: interpreter_line(&runner, &name),
            manifest,
        };
        if !script_run_approved(&app, state, window, &brief).await {
            return Err(format!(
                "The script “{name}” wasn't approved, so this workflow can't run."
            ));
        }
        grants.insert(sha);
    }
    Ok(grants)
}

// ------------------------------------------------------------ auto-workflow

/// True when `wf` is the auto-created single-node workflow for `file_id`.
fn wf_is_for_script(wf: &db::Workflow, file_id: &str) -> bool {
    wf.created_by == "script"
        && wf
            .definition
            .get("nodes")
            .and_then(|n| n.as_array())
            .map(|nodes| {
                nodes.iter().any(|nd| {
                    nd.get("kind").and_then(|k| k.as_str()) == Some("script_run")
                        && nd.get("file").and_then(|f| f.as_str()) == Some(file_id)
                })
            })
            .unwrap_or(false)
}

/// Find-or-create the auto-workflow for a script (a single `script_run` node,
/// `created_by='script'`, `status='active'` so the scheduler can fire it). These
/// rows are hidden from the 4a Workflow library — the Scripts page is their home.
/// Scheduling a script = a schedule on this workflow; a manual run = `run_workflow`
/// on it — so status/last-run/history all come from the same rows.
pub(crate) fn ensure_script_workflow(conn: &Connection, file_id: &str, name: &str) -> Result<String, String> {
    if let Some(wf) = db::list_workflows(conn)?.iter().find(|w| wf_is_for_script(w, file_id)) {
        return Ok(wf.id.clone());
    }
    let def = serde_json::json!({
        "version": 1,
        "nodes": [{ "id": "run", "label": format!("Run {name}"), "kind": "script_run", "file": file_id }],
        "edges": [],
    });
    let binding = serde_json::json!({ "scope": "general" });
    let id = db::create_workflow(conn, name, "", "📜", &def, "script", &binding)?;
    // Activation is implicit for a script auto-workflow (the script's own consent
    // is the gate); flip it active so the scheduler can fire it.
    db::set_workflow_status(conn, &id, "active")?;
    Ok(id)
}

// ------------------------------------------------------------ commands

/// One script row for the Scripts page.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub file_id: String,
    pub name: String,
    /// "py" | "js".
    pub lang: String,
    pub deps: Vec<String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    /// "global" | "file" | "none".
    pub shortcut: String,
    /// True when this exact content is approved on this Mac.
    pub approved: bool,
    /// True when the script ran/scheduled before but its current content is not
    /// approved (edited since) — drives the "Needs review" ribbon.
    pub changed_since_approval: bool,
    pub workflow_id: Option<String>,
    pub schedule: Option<db::Schedule>,
    pub last_run: Option<db::WorkflowRun>,
    /// How many of the most-recent runs failed with the SAME error text,
    /// counting newest-first (0 = the latest run didn't fail). Lets the UI show
    /// ONE incident card instead of N identical error rows.
    pub consecutive_failures: u32,
    /// The shared error text of that identical-failure streak (None when the
    /// script isn't currently failing).
    pub last_error: Option<String>,
}

fn lang_str(lang: ScriptLang) -> String {
    match lang {
        ScriptLang::Py => "py",
        ScriptLang::Js => "js",
    }
    .into()
}

fn shortcut_str(s: Shortcut) -> String {
    match s {
        Shortcut::Global => "global",
        Shortcut::File => "file",
        Shortcut::None => "none",
    }
    .into()
}

/// Every `.py`/`.js` room file as a script, joined with its auto-workflow's
/// latest run + schedule and its per-Mac approval state.
#[tauri::command]
pub fn list_scripts(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Vec<ScriptInfo>, String> {
    let approved: HashSet<String> = read_script_approvals(&app).into_iter().collect();
    state.with_room(|room| {
        let workflows = db::list_workflows(&room.conn)?;
        let mut out = Vec::new();
        for f in db::list_files(&room.conn)? {
            let Some(lang) = script_lang_of(&f.name) else {
                continue;
            };
            // A single unreadable blob must not error the WHOLE list (which would
            // hide every other script) — treat it as empty and keep discovering.
            let bytes = db::get_file_bytes(&room.conn, &f.id)
                .ok()
                .flatten()
                .unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let manifest = parse_script_manifest(&f.name, &text);
            let sha = script_fingerprint(&bytes);
            let is_approved = approved.contains(&sha);
            let wf = workflows.iter().find(|w| wf_is_for_script(w, &f.id));
            let workflow_id = wf.map(|w| w.id.clone());
            let schedule = wf.and_then(|w| db::get_schedule(&room.conn, &w.id).ok().flatten());
            let runs = wf
                .and_then(|w| db::list_workflow_runs(&room.conn, &w.id).ok())
                .unwrap_or_default();
            let last_run = runs.first().cloned();
            // Walk the leading run streak (newest-first) and collapse repeated
            // identical failures into a single incident: how many times, and the
            // shared error. A non-failure — or a *different* error — ends it.
            let mut consecutive_failures = 0u32;
            let mut last_error: Option<String> = None;
            for r in &runs {
                if r.status != "error" && r.status != "failed" {
                    break;
                }
                let this_err = r.error.clone().unwrap_or_default();
                match &last_error {
                    None => {
                        last_error = Some(this_err);
                        consecutive_failures = 1;
                    }
                    Some(e) if *e == this_err => consecutive_failures += 1,
                    Some(_) => break,
                }
            }
            out.push(ScriptInfo {
                file_id: f.id,
                name: f.name,
                lang: lang_str(lang),
                deps: manifest.deps,
                inputs: manifest.inputs,
                outputs: manifest.outputs,
                shortcut: shortcut_str(manifest.shortcut),
                approved: is_approved,
                changed_since_approval: !is_approved && workflow_id.is_some(),
                workflow_id,
                schedule,
                last_run,
                consecutive_failures,
                last_error,
            });
        }
        Ok(out)
    })
}

/// The parsed manifest for one script (the viewer header / consent card).
#[tauri::command]
pub fn get_script_manifest(state: State<'_, AppState>, file_id: String) -> Result<ScriptManifest, String> {
    let (name, bytes) = state.with_room(|room| db::get_file_bytes_named(&room.conn, &file_id))?;
    let text = String::from_utf8_lossy(&bytes.unwrap_or_default()).into_owned();
    Ok(parse_script_manifest(&name, &text))
}

/// Run a script now. Resolves the runtime up front (an actionable error if none),
/// obtains a grant (approvals-file hit OR the inline consent card), stamps the
/// just-approved hash into the run's plan, and enqueues the auto-workflow through
/// the 4a `run_workflow` path. Returns the job id.
#[tauri::command]
pub async fn run_script(
    window: tauri::Window,
    state: State<'_, AppState>,
    file_id: String,
) -> Result<String, String> {
    use tauri::Manager;
    let app = window.app_handle().clone();
    let (name, bytes) = state.with_room(|room| db::get_file_bytes_named(&room.conn, &file_id))?;
    let bytes = bytes.unwrap_or_default();
    if script_lang_of(&name).is_none() {
        return Err("Only .py or .js files can be run as scripts.".into());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let manifest = parse_script_manifest(&name, &text);
    // Actionable error BEFORE the consent card if no runtime can run it.
    let runner = resolve_interpreter(&manifest)?;
    let sha = script_fingerprint(&bytes);

    let already = read_script_approvals(&app).iter().any(|f| f == &sha);
    if !already {
        let brief = ScriptBrief {
            name: name.clone(),
            sha: sha.clone(),
            interpreter_line: interpreter_line(&runner, &name),
            manifest: manifest.clone(),
        };
        if !script_run_approved(&app, state.inner(), &window, &brief).await {
            return Err("This script was not approved to run.".into());
        }
    }

    let wf_id = state.with_room(|room| ensure_script_workflow(&room.conn, &file_id, &name))?;
    let extra: HashSet<String> = [sha].into_iter().collect();
    start_workflow_run(&window, state.inner(), &wf_id, "manual", None, &extra).await
}

/// Schedule (or clear, `kind=""`) a script. Server-side requires the script's
/// fingerprint to be approved on this Mac (defense in depth against a driven UI):
/// a scheduled run must never introduce new/changed code. Delegates to the 4a
/// schedule table on the script's auto-workflow.
#[tauri::command]
pub fn set_script_schedule(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_id: String,
    kind: String,
    param: String,
    enabled: bool,
) -> Result<(), String> {
    let (name, bytes) = state.with_room(|room| db::get_file_bytes_named(&room.conn, &file_id))?;
    let sha = script_fingerprint(&bytes.unwrap_or_default());
    if !kind.is_empty() && !read_script_approvals(&app).iter().any(|f| f == &sha) {
        return Err("Approve this script (run it once and choose “Always allow”) before scheduling it.".into());
    }
    state.with_room(|room| {
        let wf_id = ensure_script_workflow(&room.conn, &file_id, &name)?;
        if kind.is_empty() {
            return db::upsert_schedule(&room.conn, &wf_id, "", "", true, true, None);
        }
        // catch-up ON for daily/weekly (a missed nightly run should catch up);
        // interval runs are frequent enough that a single catch-up adds noise.
        let catch_up = kind == "daily" || kind == "weekly";
        let next = if enabled { next_run_from_now(&kind, &param) } else { None };
        if enabled && next.is_none() {
            return Err("That schedule is invalid — check the time or interval.".into());
        }
        db::upsert_schedule(&room.conn, &wf_id, &kind, &param, enabled, catch_up, next.as_deref())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wf_matches_only_its_own_script_row() {
        let conn = db::mem();
        // A user workflow (not a script) never matches.
        let user_def = serde_json::json!({
            "version": 1,
            "nodes": [{ "id": "g", "kind": "generate", "prompt": "hi" }],
            "edges": [],
        });
        db::create_workflow(&conn, "wf", "", "", &user_def, "user", &serde_json::json!({"scope":"general"})).unwrap();
        assert!(ensure_script_workflow(&conn, "file-1", "a.py").is_ok());
        let wfs = db::list_workflows(&conn).unwrap();
        let script_wf = wfs.iter().find(|w| w.created_by == "script").unwrap();
        assert!(wf_is_for_script(script_wf, "file-1"));
        assert!(!wf_is_for_script(script_wf, "file-2"));
        // A second call is idempotent — same id, no duplicate row.
        let again = ensure_script_workflow(&conn, "file-1", "a.py").unwrap();
        assert_eq!(again, script_wf.id);
        assert_eq!(db::list_workflows(&conn).unwrap().iter().filter(|w| w.created_by == "script").count(), 1);
        // The auto-workflow is active so the scheduler can fire it.
        assert_eq!(db::get_workflow(&conn, &script_wf.id).unwrap().status, "active");
    }

    #[test]
    fn stamp_script_consents_only_stamps_approved_hashes() {
        // The approval-gate decision surface: an approved hash runs; an unapproved
        // (or edited) one gets no consent entry, so the executor parks.
        let conn = db::mem();
        let bytes = b"print('run me')";
        let id = db::insert_file(&conn, "s.py", "text/x-python", bytes, Some("print('run me')"), "upload").unwrap().id;
        let def: crate::commands::WorkflowDef = serde_json::from_value(serde_json::json!({
            "version": 1,
            "nodes": [{ "id": "run", "kind": "script_run", "file": id }],
            "edges": [],
        }))
        .unwrap();
        let sha = script_fingerprint(bytes);
        // Not approved → no entry.
        let none: HashSet<String> = HashSet::new();
        assert!(crate::commands::stamp_script_consents(&conn, &def, &none).is_empty());
        // Approved → the exact hash is stamped, keyed by file id.
        let ok: HashSet<String> = [sha.clone()].into_iter().collect();
        let stamped = crate::commands::stamp_script_consents(&conn, &def, &ok);
        assert_eq!(stamped.get(&id), Some(&sha));
    }
}
