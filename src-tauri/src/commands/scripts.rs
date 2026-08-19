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

/// The room files this run would decrypt into the workspace: the ones the
/// script DECLARES, plus every room file whose exact name appears in its text
/// (the auto-materialize rule in `script_run`). The card used to list only the
/// declared ones, so it could show none while twenty documents were copied out
/// of the room — the whole point of the card is that it describes what happens.
fn readable_room_files(conn: &Connection, declared: &[String], text: &str) -> Vec<String> {
    let mut out = declared.to_vec();
    let Ok(files) = db::list_files(conn) else {
        return out;
    };
    let names: Vec<String> = files.into_iter().map(|f| f.name).collect();
    for name in referenced_room_files(text, &names, MAX_AUTO_MATERIALIZE) {
        // A declared input is matched fuzzily by name, so compare loosely.
        if !out.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
            out.push(name);
        }
    }
    out
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

/// Reuse the exact content-addressed consent gate for a script bundled in an
/// Agent Skill. The caller supplies the bytes and then runs the returned
/// interpreter in an isolated, materialized skill workspace.
pub(crate) async fn approve_script_bytes(
    window: &tauri::Window,
    state: &AppState,
    display_name: &str,
    bytes: &[u8],
) -> Result<(Runner, ScriptManifest), String> {
    use tauri::Manager as _;
    if script_lang_of(display_name).is_none() {
        return Err("Only .py or .js skill scripts can be run.".into());
    }
    let text = String::from_utf8_lossy(bytes).into_owned();
    let manifest = parse_script_manifest(display_name, &text);
    let runner = resolve_interpreter(&manifest)?;
    let sha = script_fingerprint(bytes);
    let app = window.app_handle().clone();
    if !read_script_approvals(&app).iter().any(|f| f == &sha) {
        // Skill scripts do not receive room-file inputs/outputs. Keep the card
        // honest even if a copied room-script header happens to declare them.
        let mut shown_manifest = manifest.clone();
        shown_manifest.inputs.clear();
        shown_manifest.outputs.clear();
        let brief = ScriptBrief {
            name: display_name.to_string(),
            sha,
            interpreter_line: interpreter_line(&runner, display_name),
            manifest: shown_manifest,
        };
        if !script_run_approved(&app, state, window, &brief).await {
            return Err("This skill script was not approved to run.".into());
        }
    }
    Ok((runner, manifest))
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
        // The ONE resolver, shared with the consent-stamping + executor.
        let resolved: Option<(String, Vec<u8>)> = state.with_room(|room| {
            Ok(resolve_script_file(&room.conn, file)
                .ok()
                .map(|(_id, name, bytes)| (name, bytes)))
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
        let mut manifest = parse_script_manifest(&name, &text);
        let runner = resolve_interpreter(&manifest)?;
        manifest.inputs =
            state.with_room(|room| Ok(readable_room_files(&room.conn, &manifest.inputs, &text)))?;
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
    /// True when the script has been run (so an auto-workflow exists) but its
    /// CURRENT content is not remembered on this Mac — an "Allow once" run and
    /// an edit after "Always allow" both land here, and this flag cannot tell
    /// them apart. It drives the "Needs review" ribbon, which is honest for
    /// both; the ribbon's tooltip must therefore NOT claim the script changed.
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
            // 'error' is the only failure status a run row is ever given
            // (running | done | error) — there is no separate "failed".
            for r in &runs {
                if r.status != "error" {
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
            // The room files this script would actually decrypt into its
            // workspace — declared inputs PLUS the auto-materialized ones the
            // run adds — so the row and the consent card describe one run.
            // Listing only the header's `room-inputs` showed nothing for a
            // script that reads twenty room files by name.
            let inputs = readable_room_files(&room.conn, &manifest.inputs, &text);
            out.push(ScriptInfo {
                file_id: f.id,
                name: f.name,
                lang: lang_str(lang),
                deps: manifest.deps,
                inputs,
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

// --------------------------------------------------------------------------- #
// Agent seam (2026-07-24). Scripts were a whole product area with no agent
// reach: the base prompt teaches the model to AUTHOR a runnable script
// (PEP-723 dependency block and all), and it then had no way to see one or run
// it. These mirror the Tauri commands above but take `&AppState`/`&Window`,
// the shapes `exec_tool` holds — same pattern as `agent_save_skill`.
//
// Running stays gated: `run_script` fingerprints the file's exact bytes and
// shows the consent card unless that SHA was already approved on this Mac. A
// script the agent just wrote is by definition a new fingerprint, so
// agent-authored code ALWAYS reaches the user before it executes.
// --------------------------------------------------------------------------- #

/// The room's runnable scripts, one line each, for the agent.
pub(crate) fn agent_list_scripts(app: &tauri::AppHandle, state: &AppState) -> Result<String, String> {
    let approved: HashSet<String> = read_script_approvals(app).into_iter().collect();
    let lines = state.with_room(|room| {
        let mut out: Vec<String> = Vec::new();
        for f in db::list_files(&room.conn)? {
            let Some(lang) = script_lang_of(&f.name) else {
                continue;
            };
            let bytes = db::get_file_bytes(&room.conn, &f.id)
                .ok()
                .flatten()
                .unwrap_or_default();
            let manifest = parse_script_manifest(&f.name, &String::from_utf8_lossy(&bytes));
            let ok = approved.contains(&script_fingerprint(&bytes));
            let deps = if manifest.deps.is_empty() {
                String::new()
            } else {
                format!(", needs {}", manifest.deps.join(" "))
            };
            out.push(format!(
                "- {} ({}{}) — {}",
                f.name,
                lang_str(lang),
                deps,
                if ok { "approved to run" } else { "needs the user's approval on first run" }
            ));
        }
        Ok(out)
    })?;
    if lines.is_empty() {
        return Ok("This room has no .py or .js scripts yet.".into());
    }
    Ok(lines.join("\n"))
}

/// Run one script by file NAME (the agent never handles file ids).
pub(crate) async fn agent_run_script(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
    // The ask's Stop flag. The wait below is up to 150s inside one tool call,
    // which is long enough that a user who presses Stop expects the turn to end
    // — not to sit here until the timeout. The RUN itself keeps going (it is a
    // durable job the user asked for, watchable in the Scripts view); what Stop
    // ends is our waiting for it.
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<String, String> {
    let wanted = args["name"].as_str().unwrap_or_default().trim().to_string();
    if wanted.is_empty() {
        return Err("Say which script to run, by file name.".into());
    }
    let (file_id, name) = state.with_room(|room| db::find_file_like(&room.conn, &wanted))?;
    if script_lang_of(&name).is_none() {
        return Err(format!("\"{name}\" is not a .py or .js script."));
    }
    let job_id = run_script_inner(window, state, file_id).await?;

    // Live QA 2026-07-25: "run it on book.md and tell me the count" ran the
    // script perfectly — exit 0, STDOUT `book.md: 1715 words` — and the agent
    // answered "I don't have the number yet, sorry", because this tool used to
    // return the moment the run STARTED. The answer sat in the run log a minute
    // before the model wrote that. A script the user asked to run IS the
    // question, so wait for it and hand back what it printed.
    const RUN_TIMEOUT_SECS: u64 = 150;
    let start = std::time::Instant::now();
    loop {
        if let Ok(job) = state.with_room(|room| db::get_job(&room.conn, &job_id)) {
            match job.status.as_str() {
                "done" => return Ok(clamp_script_output(&name, &script_output(state, &job_id))),
                "error" => {
                    let why = job.error.unwrap_or_else(|| "it failed".into());
                    let out = script_output(state, &job_id);
                    return Ok(if out.is_empty() {
                        format!("Ran {name}, but it failed: {why}")
                    } else {
                        format!("Ran {name}, but it failed: {why}\nOutput before it stopped:\n{out}")
                    });
                }
                // A script step parks when its code is not approved on this Mac.
                "paused" => {
                    return Ok(format!(
                        "{name} is waiting for the user's approval before it can run — \
                         the agent cannot approve code. Ask them to approve it on the \
                         Scripts page, then run it again."
                    ))
                }
                _ => {}
            }
        }
        // Stop ends the WAIT, not the run — same words as the timeout, because
        // from the model's side the situation is identical: the script is
        // underway and its output is not available here.
        let stopped = cancel.is_some_and(|c| c.load(Ordering::SeqCst));
        if stopped || start.elapsed().as_secs() >= RUN_TIMEOUT_SECS {
            // NOT a failure: the user asked for this run. Say plainly that the
            // wait ended, never that the script failed.
            return Ok(format!(
                "Started {name}. It is still running, so its output isn't available \
                 yet — tell the user it is underway and that they can watch it finish \
                 in the Scripts view. Do not guess at its result."
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
}

/// Everything the script PRINTED, read back from the run's stored artifacts.
/// A script auto-workflow is one `script_run` node, so step 0 holds it; the
/// loop keeps working if that ever grows a second step.
///
/// An import-mode `script_run` stores the whole run RECORD as its result — exit
/// code, every imported file, and only then the printed output. Handing that
/// blob to a model told to "quote these values exactly" is wrong twice over:
/// it isn't the answer, and the clamp can cut the answer off the end entirely.
/// Pull the stdout tail out of the record instead.
fn script_output(state: &AppState, job_id: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for step in 0..4 {
        let Ok(Some(raw)) = state.with_room(|room| Ok(db::get_job_artifact(&room.conn, job_id, step)))
        else {
            break;
        };
        let text = printed_output(&raw);
        if !text.trim().is_empty() {
            parts.push(text.trim().to_string());
        }
    }
    parts.join("\n")
}

/// What one stored step artifact means by "output". An import-mode `script_run`
/// records the whole run REPORT as its result, so the printed text is the
/// report's `stdoutTail`; a transform-mode step's result already IS the stdout.
///
/// The stdout is not the WHOLE answer, though: an import-mode script's point is
/// the files it wrote. Quoting the raw report JSON at the model was wrong, but
/// so was dropping it — a script that writes chart.png and prints nothing came
/// back as "it finished successfully and printed nothing", so the assistant
/// could neither name what it produced nor relay why an output was skipped. The
/// printed text leads; the record's short, human parts follow it.
fn printed_output(raw_artifact: &str) -> String {
    let result = serde_json::from_str::<serde_json::Value>(raw_artifact)
        .ok()
        .and_then(|v| v["result"].as_str().map(str::to_string))
        .unwrap_or_default();
    let Some(report) = serde_json::from_str::<serde_json::Value>(&result)
        .ok()
        .filter(|r| r.get("stdoutTail").and_then(|s| s.as_str()).is_some())
    else {
        // Not a run record — a transform step's result already IS the stdout.
        return result;
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(tail) = report["stdoutTail"].as_str().map(str::trim) {
        if !tail.is_empty() {
            parts.push(tail.to_string());
        }
    }
    let created: Vec<&str> = report["imported"]
        .as_array()
        .map(|a| a.iter().filter_map(|f| f["name"].as_str()).collect())
        .unwrap_or_default();
    if !created.is_empty() {
        parts.push(format!("Created: {}", created.join(", ")));
    }
    // Why a declared output did NOT arrive (not written, over the size cap, the
    // new-file import cap) — the user needs to hear these.
    let notes: Vec<&str> = report["skipped"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str()).collect())
        .unwrap_or_default();
    for n in notes {
        parts.push(format!("Note: {n}"));
    }
    if report["exitCode"].as_i64().unwrap_or(0) != 0 {
        parts.push(format!("Exit code: {}", report["exitCode"]));
    }
    parts.join("\n")
}

/// The model reads this; a runaway `print` loop must not eat the turn.
fn clamp_script_output(name: &str, out: &str) -> String {
    const MAX: usize = 4000;
    if out.trim().is_empty() {
        return format!("Ran {name}. It finished successfully and printed nothing.");
    }
    let mut body = out.to_string();
    if body.len() > MAX {
        let cut = body
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|i| *i <= MAX)
            .last()
            .unwrap_or(0);
        body.truncate(cut);
        body.push_str("\n… (output truncated)");
    }
    format!(
        "Ran {name}. It finished successfully. Its output — quote these values \
         exactly, they are the answer:\n{body}"
    )
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
    run_script_inner(&window, state.inner(), file_id).await
}

/// `run_script`'s body against the shapes `exec_tool` holds (`&AppState`,
/// `&Window`) so the agent seam and the UI command share one implementation —
/// including the consent gate, which must never have a second code path.
pub(crate) async fn run_script_inner(
    window: &tauri::Window,
    state: &AppState,
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
        // The card must name every room file this run would decrypt into the
        // workspace, not just the declared ones.
        let mut shown = manifest.clone();
        shown.inputs =
            state.with_room(|room| Ok(readable_room_files(&room.conn, &shown.inputs, &text)))?;
        let brief = ScriptBrief {
            name: name.clone(),
            sha: sha.clone(),
            interpreter_line: interpreter_line(&runner, &name),
            manifest: shown,
        };
        if !script_run_approved(&app, state, window, &brief).await {
            return Err("This script was not approved to run.".into());
        }
    }

    let wf_id = state.with_room(|room| ensure_script_workflow(&room.conn, &file_id, &name))?;
    let extra: HashSet<String> = [sha].into_iter().collect();
    start_workflow_run(window, state, &wf_id, "manual", None, &extra).await
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
    fn a_finished_script_hands_its_output_back_as_the_answer() {
        // Live QA 2026-07-25: "run it on book.md and tell me the count" ran the
        // script (exit 0, STDOUT `book.md: 1715 words`) and the agent replied
        // "I don't have the number yet, sorry" — the tool returned at START, so
        // the answer never reached the model.
        let out = clamp_script_output("Word Counter.py", "book.md: 1715 words");
        assert!(out.contains("book.md: 1715 words"));
        assert!(out.contains("quote these values"), "the model must not paraphrase a number");
        assert!(!out.contains("Started"), "a finished run must not read as merely started");

        // A silent script is a success, not a missing answer to apologise for.
        let quiet = clamp_script_output("quiet.py", "   \n ");
        assert!(quiet.contains("printed nothing"));
        assert!(!quiet.contains("quote these values"));

        // A runaway print loop cannot eat the turn.
        let huge = clamp_script_output("loud.py", &"x".repeat(20_000));
        assert!(huge.len() < 5_000);
        assert!(huge.ends_with("(output truncated)"));
    }

    #[test]
    fn the_agent_gets_what_the_script_printed_not_the_run_record() {
        // An import-mode script_run stores the whole run REPORT as its result —
        // exit code, every imported file, and the printed output LAST. Handing
        // that to a model told to "quote these values exactly" is wrong twice:
        // it isn't the answer, and the 4000-char clamp can cut the answer off
        // the end entirely.
        let report = serde_json::json!({
            "exitCode": 0,
            "imported": [{ "id": "f1", "name": "out.csv" }],
            "skipped": [],
            "stdoutTail": "book.md: 1715 words\n",
            "stderrTail": "",
        });
        let artifact =
            serde_json::json!({ "result": serde_json::to_string(&report).unwrap() }).to_string();
        let out = printed_output(&artifact);
        assert!(out.starts_with("book.md: 1715 words"), "{out}");
        assert!(!out.contains("exitCode"), "{out}");
        assert!(!out.contains("stdoutTail"), "{out}");

        // A transform-mode step's result already IS the stdout.
        let piped = serde_json::json!({ "result": "just the output" }).to_string();
        assert_eq!(printed_output(&piped), "just the output");
        // Anything unreadable yields nothing rather than a blob.
        assert_eq!(printed_output("not json"), "");
    }

    #[test]
    fn the_assistant_is_told_which_files_the_script_created() {
        // Narrowing the tool result to the stdout was right — the raw report
        // JSON was the wrong thing to quote — but it went one step too far. An
        // import-mode run's POINT is the files it wrote: a script that writes
        // chart.png and prints nothing came back as "it finished successfully
        // and printed nothing", so the assistant could not name what it made
        // and never relayed why a declared output was dropped.
        let report = serde_json::json!({
            "exitCode": 0,
            "imported": [{ "id": "f1", "name": "chart.png" }, { "id": "f2", "name": "data.csv" }],
            "skipped": ["notes.txt: the script did not write this declared output"],
            "stdoutTail": "",
            "stderrTail": "",
        });
        let artifact =
            serde_json::json!({ "result": serde_json::to_string(&report).unwrap() }).to_string();
        let out = printed_output(&artifact);
        assert!(out.contains("chart.png") && out.contains("data.csv"), "{out}");
        assert!(out.contains("did not write this declared output"), "{out}");
        // A silent, file-producing run is no longer "printed nothing".
        let told = clamp_script_output("make-chart.py", &out);
        assert!(!told.contains("printed nothing"), "{told}");
        assert!(told.contains("chart.png"), "{told}");

        // Printed text still LEADS — it is the answer when there is one.
        let with_stdout = serde_json::json!({
            "exitCode": 2,
            "imported": [{ "id": "f1", "name": "out.csv" }],
            "skipped": [],
            "stdoutTail": "42 rows\n",
            "stderrTail": "",
        });
        let out = printed_output(
            &serde_json::json!({ "result": serde_json::to_string(&with_stdout).unwrap() })
                .to_string(),
        );
        assert!(out.starts_with("42 rows"), "{out}");
        assert!(out.contains("Created: out.csv"), "{out}");
        // A non-zero exit is visible; a clean one is not worth a line.
        assert!(out.contains("Exit code: 2"), "{out}");
    }

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
