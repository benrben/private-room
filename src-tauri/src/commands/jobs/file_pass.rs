//! ADD-32: the whole-file pass — an exhaustive, durable map/fold/reduce job
//! that guarantees EVERY character of a file passes through the model, no
//! matter how large the file is. The chat agent and the deep summary sample;
//! this covers.
//!
//! Shape (all control flow is deterministic code — the model only fills the
//! fuzzy nodes):
//!   1. `partition_windows` splits the filtered text into N consecutive
//!      windows (plan-time, pure).
//!   2. N chained `map` steps walk the file IN ORDER, each receiving its
//!      window plus a short `thread` carried from the previous step — the
//!      long, monotonic read. Each writes an artifact row.
//!   3. `merge` steps fold artifacts together in groups of `PASS_MERGE_GROUP`,
//!      level by level, until one remains (merge mode), then `compose` turns
//!      the final notes into the deliverable. Stitch mode skips both — its
//!      deliverable is the ordered concatenation of the map outputs.
//!   4. A `publish` step (no model) writes the result into the room as a new
//!      file, with an honest coverage line.
//!
//! Every step is checkpointed via the ADD-30 job runner, so a pass survives
//! Stop, app quit, and crashes, and resumes from its cursor. The plan (the
//! window list) is IMMUTABLE in the jobs row — artifacts align with step ids,
//! so a resume must never re-derive different windows.

use super::*;

/// One window of file text per map call (~5.3K tokens) — small enough that a
/// step finishes in well under a minute on a 16 GB Mac (responsive Stop, cheap
/// crash recovery, and a 4B model attends better over short contexts), big
/// enough that a book is hundreds of steps, not thousands.
pub(crate) const PASS_WINDOW_CHARS: usize = 16_000;
/// Carried back from the previous window so nothing straddling a cut is lost.
pub(crate) const PASS_WINDOW_OVERLAP: usize = 400;
/// Artifacts folded per merge call: 6 × notes cap + prompt fits the Job tier.
pub(crate) const PASS_MERGE_GROUP: usize = 6;
/// Per-window notes cap (merge mode) — sized so merge groups always fit.
const PASS_NOTES_MAX: usize = 2_400;
/// The running thread handed from window to window.
const PASS_THREAD_MAX: usize = 1_200;
/// A merged notes section may grow past a single window's cap.
const PASS_MERGE_MAX: usize = 8_000;
/// The composed final document.
const PASS_COMPOSE_MAX: usize = 120_000;

/// The immutable plan stored on the jobs row. `windows` are byte spans into
/// the `smart_filter`ed text; `text_len` and `text_sha256` let a resume detect
/// that the file changed underneath the plan instead of silently mis-slicing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassPlan {
    pub file_id: String,
    pub file_name: String,
    pub instruction: String,
    /// "merge" (notes → folded → composed document) or "stitch" (each window
    /// transformed; outputs concatenated in order — translation, rewriting).
    pub mode: String,
    pub text_len: usize,
    /// SHA-256 (hex) of the filtered text — catches a same-length content
    /// swap that `text_len` misses. Optional so plans persisted before the
    /// digest existed still deserialize (those keep the length check only).
    #[serde(default)]
    pub text_sha256: Option<String>,
    pub windows: Vec<(usize, usize)>,
}

/// Build the full step DAG for a pass — pure and deterministic, so start and
/// resume derive the identical plan from the same inputs. Ids are topological
/// (every dependency has a lower id), which is what makes the job runner's
/// `0..cursor` resume seeding valid.
pub fn build_pass_steps(n_windows: usize, mode: &str, model_lane: Lane) -> Vec<Step> {
    let mut steps: Vec<Step> = (0..n_windows)
        .map(|i| Step {
            id: i,
            lane: model_lane,
            kind: "map".into(),
            params: serde_json::json!({ "window": i }),
            // The chain: window i waits for i-1, receiving its thread — the
            // monotonic read that walks the whole file in order.
            depends_on: if i == 0 { vec![] } else { vec![i - 1] },
        })
        .collect();
    let mut next_id = n_windows;
    if mode == "stitch" {
        // The chain already orders everything; publish rides on the last map.
        steps.push(Step {
            id: next_id,
            lane: Lane::Cpu,
            kind: "publish".into(),
            params: serde_json::json!({ "inputs": (0..n_windows).collect::<Vec<usize>>() }),
            depends_on: vec![n_windows - 1],
        });
        return steps;
    }
    // Merge tree: fold artifact ids level by level until one remains. A
    // leftover group of one passes through untouched — no wasted model call.
    let mut level: Vec<usize> = (0..n_windows).collect();
    while level.len() > 1 {
        let mut next = Vec::new();
        for group in level.chunks(PASS_MERGE_GROUP) {
            if group.len() == 1 {
                next.push(group[0]);
                continue;
            }
            steps.push(Step {
                id: next_id,
                lane: model_lane,
                kind: "merge".into(),
                params: serde_json::json!({ "inputs": group }),
                depends_on: group.to_vec(),
            });
            next.push(next_id);
            next_id += 1;
        }
        level = next;
    }
    let top = level[0];
    steps.push(Step {
        id: next_id,
        lane: model_lane,
        kind: "compose".into(),
        params: serde_json::json!({ "input": top }),
        depends_on: vec![top],
    });
    let compose_id = next_id;
    next_id += 1;
    steps.push(Step {
        id: next_id,
        lane: Lane::Cpu,
        kind: "publish".into(),
        params: serde_json::json!({ "input": compose_id }),
        depends_on: vec![compose_id],
    });
    steps
}

/// The artifact one step leaves for later steps: the window's output plus the
/// thread handed to the next window. `skipped` marks a window the model could
/// not process (after a retry) — publish counts these honestly.
#[derive(Debug, Default, Serialize, Deserialize)]
struct PassArtifact {
    #[serde(default)]
    result: String,
    #[serde(default)]
    thread: String,
    #[serde(default)]
    skipped: bool,
}

fn load_artifact(conn: &Connection, job_id: &str, step_id: usize) -> Option<PassArtifact> {
    db::get_job_artifact(conn, job_id, step_id)
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn store_artifact(
    conn: &Connection,
    job_id: &str,
    step_id: usize,
    artifact: &PassArtifact,
) -> Result<(), String> {
    db::put_job_artifact(
        conn,
        job_id,
        step_id,
        &serde_json::to_string(artifact).map_err(|e| e.to_string())?,
    )
}

/// A hard engine failure parks the job for Resume; anything else is a one-off
/// the pass survives (the window is marked skipped, coverage stays honest).
fn is_fatal(e: &str) -> bool {
    e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING")
}

/// Run one structured model call with a single retry on transient failure.
async fn model_call(
    model: &str,
    messages: Vec<ollama::ChatMessage>,
    schema: &serde_json::Value,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<serde_json::Value>, String> {
    for attempt in 0..2 {
        if cancel.load(Ordering::SeqCst) {
            return Err("STOPPED".into());
        }
        match ollama::chat_structured_job_cancel(
            model,
            messages.clone(),
            Some(0.2),
            KEEP_ALIVE_WARM,
            schema,
            cancel.clone(),
        )
        .await
        {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(raw.trim()) {
                Ok(v) => return Ok(Some(v)),
                Err(_) if attempt == 0 => continue,
                Err(_) => return Ok(None),
            },
            Err(e) if is_fatal(&e) => return Err(e),
            Err(_) if cancel.load(Ordering::SeqCst) => return Err("STOPPED".into()),
            Err(_) if attempt == 0 => continue,
            Err(_) => return Ok(None),
        }
    }
    Ok(None)
}

/// Execute one pass step. `filtered` is the smart-filtered file text the plan's
/// windows index into, fetched once per run and shared across steps. Generic
/// over the runtime so the mock-app harness can drive the real thing in tests
/// (the same pattern as `recording::start_engine`). `room_path` pins the step
/// to the room the pass was started in: every room access re-checks the
/// CURRENT room against it and errs on a mismatch, so a room closed or swapped
/// mid-run parks the job instead of receiving another room's artifacts.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_pass_step<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    plan: &PassPlan,
    model: &str,
    filtered: &str,
    step: &Step,
    cancel: &Arc<AtomicBool>,
    published: &std::sync::Mutex<Option<FileMeta>>,
) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let n = plan.windows.len();
    match step.kind.as_str() {
        "map" => {
            let i = step.params["window"].as_u64().unwrap_or(0) as usize;
            let (start, end) = *plan
                .windows
                .get(i)
                .ok_or_else(|| format!("window {i} is not in the plan"))?;
            let window_text = filtered
                .get(start..end)
                .ok_or("the file's text no longer matches this pass — start a new pass")?;
            // The thread from the previous window keeps the read continuous.
            let thread = if i == 0 {
                String::new()
            } else {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                load_artifact(&room.conn, job_id, i - 1)
                    .map(|a| a.thread)
                    .unwrap_or_default()
            };
            let stitch = plan.mode == "stitch";
            let system = if stitch {
                "You transform one long file part by part, in order, following the instruction \
                 exactly. Output ONLY the transformed text for the given part — the parts are \
                 joined afterward, so no headers, no preamble, no commentary. Also keep a short \
                 thread of notes (names, terminology, tone decisions) so the next part stays \
                 consistent."
            } else {
                "You are reading one long file part by part, in order, so that together your \
                 notes cover the ENTIRE file. For the given part, write dense factual notes — \
                 every important fact, number, name, date, decision, obligation or plot point — \
                 serving the stated goal. Also keep a short running thread that connects the \
                 parts (where the text is going, open questions, running totals)."
            };
            let thread_block = if thread.is_empty() {
                String::from("(this is the first part)")
            } else {
                thread.clone()
            };
            let user = format!(
                "File: {}\nGoal: {}\nThis is part {} of {} — characters {}-{} of {}.\n\n\
                 Thread from the earlier parts:\n{}\n\nText of THIS part:\n{}",
                plan.file_name,
                plan.instruction,
                i + 1,
                n,
                start,
                end,
                plan.text_len,
                thread_block,
                window_text,
            );
            let (result_key, result_cap) = if stitch {
                ("result", window_text.len().saturating_mul(3).max(PASS_NOTES_MAX))
            } else {
                ("notes", PASS_NOTES_MAX)
            };
            let schema = serde_json::json!({
                "type": "object",
                "properties": {
                    result_key: {"type": "string"},
                    "thread": {"type": "string"}
                },
                "required": [result_key, "thread"]
            });
            let messages = vec![
                ollama::ChatMessage::new("system", system),
                ollama::ChatMessage::new("user", user),
            ];
            let artifact = match model_call(model, messages, &schema, cancel).await? {
                Some(v) => PassArtifact {
                    result: clamp_bytes(
                        v[result_key].as_str().unwrap_or_default().trim().to_string(),
                        result_cap,
                    ),
                    thread: clamp_bytes(
                        v["thread"].as_str().unwrap_or_default().trim().to_string(),
                        PASS_THREAD_MAX,
                    ),
                    skipped: false,
                },
                // Transient double-failure: keep the thread flowing so the
                // NEXT window still reads in context; mark this one skipped.
                None => PassArtifact {
                    result: String::new(),
                    thread,
                    skipped: true,
                },
            };
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            store_artifact(&room.conn, job_id, step.id, &artifact)
        }
        "merge" => {
            let inputs: Vec<usize> = step.params["inputs"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).collect())
                .unwrap_or_default();
            let (sections, missing) = {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                let mut sections: Vec<String> = Vec::new();
                let mut missing = 0usize;
                for &sid in &inputs {
                    match load_artifact(&room.conn, job_id, sid) {
                        Some(a) if !a.skipped && !a.result.trim().is_empty() => {
                            sections.push(a.result)
                        }
                        _ => missing += 1,
                    }
                }
                (sections, missing)
            };
            if sections.is_empty() {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                return store_artifact(
                    &room.conn,
                    job_id,
                    step.id,
                    &PassArtifact { skipped: true, ..Default::default() },
                );
            }
            let mut user = format!(
                "Goal: {}\n\nThese are consecutive sections of notes taken over one long file, \
                 in order. Combine them into ONE continuous set of notes. Preserve every \
                 important specific — numbers, names, dates, obligations, sequence of events. \
                 Remove only repetition. Never invent anything.\n",
                plan.instruction
            );
            if missing > 0 {
                user.push_str(&format!("({missing} section(s) were unreadable and are absent.)\n"));
            }
            for (k, s) in sections.iter().enumerate() {
                user.push_str(&format!("\n--- Section {} ---\n{}\n", k + 1, s));
            }
            let schema = serde_json::json!({
                "type": "object",
                "properties": {"notes": {"type": "string"}},
                "required": ["notes"]
            });
            let messages = vec![
                ollama::ChatMessage::new(
                    "system",
                    "You merge sequential note sections into one, losslessly and faithfully.",
                ),
                ollama::ChatMessage::new("user", user),
            ];
            let artifact = match model_call(model, messages, &schema, cancel).await? {
                Some(v) => PassArtifact {
                    result: clamp_bytes(
                        v["notes"].as_str().unwrap_or_default().trim().to_string(),
                        PASS_MERGE_MAX,
                    ),
                    thread: String::new(),
                    skipped: false,
                },
                // Merge failed twice: fall back to verbatim concatenation so
                // nothing already read is ever lost to a bad fold.
                None => PassArtifact {
                    result: clamp_bytes(sections.join("\n\n"), PASS_MERGE_MAX),
                    thread: String::new(),
                    skipped: false,
                },
            };
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            store_artifact(&room.conn, job_id, step.id, &artifact)
        }
        "compose" => {
            let input = step.params["input"].as_u64().unwrap_or(0) as usize;
            let notes = {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                load_artifact(&room.conn, job_id, input)
                    .map(|a| a.result)
                    .unwrap_or_default()
            };
            if notes.trim().is_empty() {
                return Err("the pass produced no readable notes to compose from".into());
            }
            let user = format!(
                "Goal: {}\nFile: {} ({} characters, read completely in {} parts).\n\n\
                 Complete notes covering the ENTIRE file:\n{}\n\n\
                 Produce the final deliverable for the goal as clean, simple HTML body markup \
                 (<h2>, <p>, <ul>, <table> — no <html> or <head>). Be thorough and specific; \
                 the reader has not seen the file.",
                plan.instruction, plan.file_name, plan.text_len, n, notes
            );
            let schema = serde_json::json!({
                "type": "object",
                "properties": {"html": {"type": "string"}},
                "required": ["html"]
            });
            let messages = vec![
                ollama::ChatMessage::new(
                    "system",
                    "You write the final document for a completed whole-file reading job.",
                ),
                ollama::ChatMessage::new("user", user),
            ];
            let artifact = match model_call(model, messages, &schema, cancel).await? {
                Some(v) => PassArtifact {
                    result: clamp_bytes(
                        v["html"].as_str().unwrap_or_default().trim().to_string(),
                        PASS_COMPOSE_MAX,
                    ),
                    thread: String::new(),
                    skipped: false,
                },
                // Composing failed: publish the raw merged notes rather than
                // nothing — the reading work is preserved either way.
                None => PassArtifact { result: notes, thread: String::new(), skipped: false },
            };
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            store_artifact(&room.conn, job_id, step.id, &artifact)
        }
        "publish" => {
            use tauri::Emitter;
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            // Honest coverage: count skipped map windows straight from the rows.
            let skipped: usize = (0..n)
                .filter(|&i| load_artifact(&room.conn, job_id, i).is_none_or(|a| a.skipped))
                .count();
            let coverage = if skipped == 0 {
                format!(
                    "Read all {} parts of “{}” — {} characters, complete coverage.",
                    n, plan.file_name, plan.text_len
                )
            } else {
                format!(
                    "Read {} of {} parts of “{}” ({} characters); {} part(s) could not be \
                     processed and are marked in place.",
                    n - skipped,
                    n,
                    plan.file_name,
                    plan.text_len,
                    skipped
                )
            };
            let meta = if plan.mode == "stitch" {
                let inputs: Vec<usize> = step.params["inputs"]
                    .as_array()
                    .map(|a| {
                        a.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).collect()
                    })
                    .unwrap_or_else(|| (0..n).collect());
                let mut body = String::new();
                for &i in &inputs {
                    match load_artifact(&room.conn, job_id, i) {
                        Some(a) if !a.skipped && !a.result.trim().is_empty() => {
                            body.push_str(a.result.trim());
                            body.push_str("\n\n");
                        }
                        _ => body.push_str(&format!("[part {} could not be processed]\n\n", i + 1)),
                    }
                }
                body.push_str(&format!("---\n\n_{coverage}_\n"));
                let name = format!("Full pass — {}.md", plan.file_name);
                db::insert_file(
                    &room.conn,
                    &name,
                    "text/markdown",
                    body.as_bytes(),
                    Some(&body),
                    "generated",
                )?
            } else {
                let input = step.params["input"].as_u64().unwrap_or(0) as usize;
                let html_body = load_artifact(&room.conn, job_id, input)
                    .map(|a| a.result)
                    .filter(|r| !r.trim().is_empty())
                    .ok_or("the composed document is missing")?;
                let name = format!("Full pass — {}.html", plan.file_name);
                let body = format!(
                    "{html_body}\n<hr/>\n<p><em>{coverage}</em></p>"
                );
                let content = html_document(&name, &body);
                db::insert_file(
                    &room.conn,
                    &name,
                    "text/html",
                    content.as_bytes(),
                    Some(&content),
                    "generated",
                )?
            };
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit("room-files-changed", ());
            }
            *published.lock().unwrap() = Some(meta);
            Ok(())
        }
        other => Err(format!("unknown pass step kind: {other}")),
    }
}

/// The human label for the progress card at `done` finished steps — names the
/// exact part being read (with its character span) so the pass is watchable.
pub(crate) fn pass_progress_label(plan: &PassPlan, steps: &[Step], done: usize) -> String {
    let n = plan.windows.len();
    if done < n {
        let (start, end) = plan.windows[done];
        format!(
            "Reading part {} of {} — characters {}–{}",
            done + 1,
            n,
            start,
            end
        )
    } else if done < steps.len() {
        match steps[done].kind.as_str() {
            "merge" => "Weaving the part-notes into one thread…".to_string(),
            "compose" => "Composing the final document…".to_string(),
            _ => "Saving the result into the room…".to_string(),
        }
    } else {
        "Finishing…".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stitch_plan_is_a_chain_plus_publish() {
        let steps = build_pass_steps(4, "stitch", Lane::LocalLlm);
        assert_eq!(steps.len(), 5);
        // Maps chain: 1←0, 2←1, 3←2.
        assert!(steps[0].depends_on.is_empty());
        assert_eq!(steps[2].depends_on, vec![1]);
        // Publish is CPU work riding on the last map.
        let publish = steps.last().unwrap();
        assert_eq!(publish.kind, "publish");
        assert_eq!(publish.lane, Lane::Cpu);
        assert_eq!(publish.depends_on, vec![3]);
    }

    #[test]
    fn merge_plan_folds_to_one_then_composes_and_publishes() {
        // 50 windows, groups of 6 → 9 merges → 2 merges → 1 merge, compose, publish.
        let steps = build_pass_steps(50, "merge", Lane::LocalLlm);
        let merges = steps.iter().filter(|s| s.kind == "merge").count();
        assert_eq!(merges, 9 + 2 + 1);
        let compose = steps.iter().find(|s| s.kind == "compose").unwrap();
        let publish = steps.iter().find(|s| s.kind == "publish").unwrap();
        assert_eq!(publish.depends_on, vec![compose.id]);
        // Topological ids: every dependency is lower than its step (this is
        // what makes cursor-based resume valid).
        for s in &steps {
            for d in &s.depends_on {
                assert!(*d < s.id, "step {} depends on later step {}", s.id, d);
            }
        }
        // Ids are dense and ordered.
        for (i, s) in steps.iter().enumerate() {
            assert_eq!(s.id, i);
        }
    }

    #[test]
    fn merge_plan_single_window_skips_merging() {
        let steps = build_pass_steps(1, "merge", Lane::Cloud);
        let kinds: Vec<&str> = steps.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds, vec!["map", "compose", "publish"]);
        // A leftover group of one is passed through, never "merged" alone.
        let steps = build_pass_steps(7, "merge", Lane::Cloud);
        // 7 → one merge of 6 + a pass-through, then a merge of [merge, 6].
        let merges: Vec<&Step> = steps.iter().filter(|s| s.kind == "merge").collect();
        assert_eq!(merges.len(), 2);
        assert_eq!(merges[0].depends_on.len(), 6);
        assert_eq!(merges[1].depends_on, vec![merges[0].id, 6]);
    }

    #[test]
    fn plan_without_digest_still_deserializes() {
        // Plans persisted before `textSha256` existed must keep loading — a
        // paused pass from an older build resumes on the length check alone.
        let v = serde_json::json!({
            "fileId": "f", "fileName": "book.txt", "instruction": "summarize",
            "mode": "merge", "textLen": 10, "windows": [[0, 10]]
        });
        let plan: PassPlan = serde_json::from_value(v).unwrap();
        assert!(plan.text_sha256.is_none());
    }

    /// REAL end-to-end: a temp encrypted room, a multi-window document, and the
    /// actual local Ollama model running the full map → merge → compose →
    /// publish pipeline — including a mid-run Stop and a resume from the
    /// checkpoint. Gated behind --ignored because it needs a running Ollama.
    /// Run: cargo test --lib file_pass_end_to_end -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a running Ollama with a local model"]
    async fn file_pass_end_to_end_with_real_model() {
        use tauri::Manager;
        let models = ollama::list_models().await.unwrap_or_default();
        let Some(model) = models
            .iter()
            .find(|m| {
                !is_external_engine(m) && !is_cloud_model(m) && !m.contains("embed")
            })
            .cloned()
        else {
            eprintln!("SKIP: no local Ollama model available");
            return;
        };
        eprintln!("using model {model}");

        // A three-act document with one distinctive fact per act, long enough
        // to need several windows at the small test target.
        let mut text = String::new();
        text.push_str(&format!(
            "EXPEDITION LOG — OPENING.\nThe ship is called the Peregrine Moth.\n{}\n\n",
            "The northern route was chosen for its calm currents. ".repeat(60)
        ));
        text.push_str(&format!(
            "MIDDLE PASSAGE.\nThe navigator's name is Ilya Baruch.\n{}\n\n",
            "Supplies were counted twice each morning without fail. ".repeat(60)
        ));
        text.push_str(&format!(
            "FINAL SECTION.\nThe voyage ended at the lighthouse of Cape Venn.\n{}\n",
            "The crew kept a shared journal of small kindnesses. ".repeat(60)
        ));

        let dir = std::env::temp_dir().join(format!("pass-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let room_path = dir.join("pass.roomai").to_string_lossy().into_owned();
        let conn = db::create_room(&room_path, "pw", "pass-e2e").unwrap();
        let file = db::insert_file(
            &conn,
            "expedition.txt",
            "text/plain",
            text.as_bytes(),
            Some(&text),
            "upload",
        )
        .unwrap();

        // Small windows so the test runs in minutes, not hours; the plan
        // carries explicit spans, so any target is a valid plan.
        let filtered = extraction::smart_filter(&text);
        let windows = extraction::partition_windows(&filtered, 4_000, 200);
        assert!(windows.len() >= 3, "want a multi-window doc, got {}", windows.len());
        let plan = PassPlan {
            file_id: file.id.clone(),
            file_name: file.name.clone(),
            instruction: "Summarize this expedition log thoroughly — every named person, \
                          place and practice."
                .into(),
            mode: "merge".into(),
            text_len: filtered.len(),
            text_sha256: None,
            windows,
        };
        let n = plan.windows.len();
        let steps = build_pass_steps(n, &plan.mode, Lane::LocalLlm);

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn,
            path: room_path.clone(),
            name: "pass-e2e".into(),
            password: "pw".into(),
        });
        app.manage(state);
        let handle = app.handle().clone();

        let job_id = {
            let state = handle.state::<AppState>();
            let guard = state.room.lock().unwrap();
            db::create_job(
                &guard.as_ref().unwrap().conn,
                "file_pass",
                "Full pass — expedition.txt",
                &serde_json::to_value(&plan).unwrap(),
                steps.len() as i64,
            )
            .unwrap()
        };
        let filtered = Arc::new(filtered);
        let published: Arc<std::sync::Mutex<Option<FileMeta>>> =
            Arc::new(std::sync::Mutex::new(None));
        let cursor_store = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        // Leg 1: trip Stop after the first completed step — the pass must
        // checkpoint and pause exactly like a user pressing Stop.
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = {
            let handle = handle.clone();
            let plan = plan.clone();
            let model = model.clone();
            let job_id = job_id.clone();
            let room_path = room_path.clone();
            let cancel_in = cancel.clone();
            let filtered = filtered.clone();
            let published = published.clone();
            let cs = cursor_store.clone();
            run_plan(
                &steps,
                0,
                cancel.clone(),
                move |s| {
                    let handle = handle.clone();
                    let plan = plan.clone();
                    let model = model.clone();
                    let job_id = job_id.clone();
                    let room_path = room_path.clone();
                    let cancel = cancel_in.clone();
                    let filtered = filtered.clone();
                    let published = published.clone();
                    async move {
                        let r = execute_pass_step(
                            &handle, &job_id, &room_path, &plan, &model, &filtered, &s,
                            &cancel, &published,
                        )
                        .await;
                        cancel.store(true, Ordering::SeqCst); // Stop after one step
                        r
                    }
                },
                |c| cs.store(c, Ordering::SeqCst),
                |done, total| eprintln!("leg1 {done}/{total}"),
            )
            .await
        };
        assert_eq!(outcome, RunOutcome::Paused, "Stop must pause, not error");
        let resume_from = cursor_store.load(Ordering::SeqCst);
        assert!(resume_from >= 1, "at least one step must have checkpointed");
        eprintln!("paused at cursor {resume_from}; resuming…");

        // Leg 2: resume from the checkpoint and run to completion.
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = {
            let handle = handle.clone();
            let plan = plan.clone();
            let model = model.clone();
            let job_id = job_id.clone();
            let room_path = room_path.clone();
            let cancel_in = cancel.clone();
            let filtered = filtered.clone();
            let published = published.clone();
            let cs = cursor_store.clone();
            let label_plan = plan.clone();
            let label_steps = steps.clone();
            run_plan(
                &steps,
                resume_from,
                cancel.clone(),
                move |s| {
                    let handle = handle.clone();
                    let plan = plan.clone();
                    let model = model.clone();
                    let job_id = job_id.clone();
                    let room_path = room_path.clone();
                    let cancel = cancel_in.clone();
                    let filtered = filtered.clone();
                    let published = published.clone();
                    async move {
                        execute_pass_step(
                            &handle, &job_id, &room_path, &plan, &model, &filtered, &s,
                            &cancel, &published,
                        )
                        .await
                    }
                },
                |c| cs.store(c, Ordering::SeqCst),
                move |done, total| {
                    eprintln!(
                        "leg2 {done}/{total} — {}",
                        pass_progress_label(&label_plan, &label_steps, done)
                    )
                },
            )
            .await
        };
        assert_eq!(outcome, RunOutcome::Done, "the resumed pass must finish");

        // Every window was read (no skips), and the result landed in the room
        // with an honest full-coverage line.
        let state = handle.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let conn = &guard.as_ref().unwrap().conn;
        for i in 0..n {
            let a = load_artifact(conn, &job_id, i).expect("map artifact must exist");
            assert!(!a.skipped, "window {i} must not be skipped");
            assert!(!a.result.trim().is_empty(), "window {i} notes must be non-empty");
        }
        let meta = published.lock().unwrap().take().expect("publish must record the file");
        assert_eq!(meta.name, "Full pass — expedition.txt.html");
        let doc = db::get_file_extracted_text(conn, &meta.id).expect("published file has text");
        assert!(
            doc.contains(&format!("Read all {n} parts")),
            "coverage line must confirm completeness"
        );
        eprintln!("\n===== published document =====\n{doc}\n==============================");
    }

    #[test]
    fn progress_labels_name_the_exact_window() {
        let plan = PassPlan {
            file_id: "f".into(),
            file_name: "book.txt".into(),
            instruction: "summarize".into(),
            mode: "merge".into(),
            text_len: 40_000,
            text_sha256: None,
            windows: vec![(0, 16_000), (15_600, 31_600), (31_200, 40_000)],
        };
        let steps = build_pass_steps(3, "merge", Lane::LocalLlm);
        assert_eq!(
            pass_progress_label(&plan, &steps, 0),
            "Reading part 1 of 3 — characters 0–16000"
        );
        assert_eq!(
            pass_progress_label(&plan, &steps, 2),
            "Reading part 3 of 3 — characters 31200–40000"
        );
        // After the maps: the fold, the compose, the save.
        assert!(pass_progress_label(&plan, &steps, 3).contains("Weaving"));
        assert!(pass_progress_label(&plan, &steps, 4).contains("Composing"));
        assert!(pass_progress_label(&plan, &steps, 5).contains("Saving"));
    }
}
