use super::*;

mod flashcards;
mod mindmap;
mod podcast;

pub use flashcards::*;
pub use mindmap::*;
pub use podcast::*;

/// Gather the text a studio command works over. `scope` = a file id (that one
/// file) or None (a slice of the whole room). Returns (label, text), or an error
/// the frontend can toast when there is nothing readable to work with.
pub(crate) fn gather_scope_text(
    conn: &Connection,
    scope: Option<&str>,
    room_name: &str,
) -> Result<(String, String), String> {
    match scope {
        Some(id) => {
            let name = db::get_file_name(conn, id)?;
            let text = db::get_file_extracted_text(conn, id).unwrap_or_default();
            if text.trim().is_empty() {
                return Err(format!("\"{name}\" has no readable text to work with."));
            }
            Ok((title_from_name(&name), clamp_bytes(text, 12_000)))
        }
        None => {
            let files = db::list_files(conn)?;
            let mut blob = String::new();
            for f in files.iter().filter(|f| !is_summary_file(&f.name, &f.source)) {
                if blob.len() >= 12_000 {
                    break;
                }
                if let Some(t) = db::get_file_extracted_text(conn, &f.id) {
                    if t.trim().is_empty() {
                        continue;
                    }
                    blob.push_str(&format!("## {}\n{}\n\n", f.name, clamp_bytes(t, 1500)));
                }
            }
            if blob.trim().is_empty() {
                return Err("This room has no readable text to work with yet.".into());
            }
            Ok((room_name.to_string(), blob))
        }
    }
}

/// Gather readable text from an explicit set of file ids — the files/folders the
/// user @-mentioned in the Studio prompt. Concatenated with per-file headers and
/// capped like the whole-room scope. Folders are expanded to file ids by the
/// caller, so this only sees files. Missing/empty files are skipped.
pub(crate) fn gather_files_text(conn: &Connection, file_ids: &[String]) -> Result<(String, String), String> {
    let mut blob = String::new();
    let mut names: Vec<String> = Vec::new();
    for id in file_ids {
        let Ok(name) = db::get_file_name(conn, id) else {
            continue;
        };
        let Some(text) = db::get_file_extracted_text(conn, id) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        if blob.len() >= 12_000 {
            break;
        }
        blob.push_str(&format!("## {}\n{}\n\n", name, clamp_bytes(text, 3000)));
        names.push(title_from_name(&name));
    }
    if blob.trim().is_empty() {
        return Err("The files you mentioned have no readable text to work with.".into());
    }
    let label = match names.as_slice() {
        [only] => only.clone(),
        _ => format!("{} files", names.len()),
    };
    Ok((label, blob))
}

/// Fold a scope label into a file-name-safe fragment (no path/reserved chars).
pub(crate) fn safe_scope_name(label: &str) -> String {
    let folded: String = label
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => ' ',
            _ => c,
        })
        .collect();
    let cleaned = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = cleaned.chars().take(60).collect();
    let name = name.trim().to_string();
    if name.is_empty() {
        "room".into()
    } else {
        name
    }
}

/// Write an HTML document to a temp file and open it in the user's real browser,
/// where interactive/JS pages render fully — the in-app WKWebView sandbox won't
/// run a page's own inline scripts. This is a deliberate, user-triggered action
/// (the viewer's "Open in browser" button), so it's the one place a page's
/// content touches unencrypted disk and may reach the network. Mac-only: opens
/// via `/usr/bin/open`, which hands the .html to the default browser.
#[tauri::command]
pub fn open_html_in_browser(name: Option<String>, html: String) -> Result<String, String> {
    use std::io::Write;
    let dir = std::env::temp_dir().join("private-room-preview");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Couldn't create the preview folder: {e}"))?;
    let base = name
        .as_deref()
        .map(|n| {
            safe_scope_name(
                n.strip_suffix(".html")
                    .or_else(|| n.strip_suffix(".htm"))
                    .unwrap_or(n),
            )
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "preview".to_string());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{base}-{stamp}.html"));
    std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(html.as_bytes()))
        .map_err(|e| format!("Couldn't write the preview file: {e}"))?;
    std::process::Command::new("/usr/bin/open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Sweep the browser-preview folder `open_html_in_browser` writes into, so the
/// decrypted HTML it leaves behind doesn't outlive the app. Called at startup
/// (files from a crashed/force-quit session) and on exit. Best-effort: only our
/// dedicated directory is touched, and a failure must never block startup/exit.
/// Not called mid-session — `/usr/bin/open` returns before the browser has read
/// the file, so an eager sweep could hand the browser a dead path.
pub fn cleanup_browser_previews() {
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("private-room-preview"));
}

/// Stage a self-contained HTML page for the isolated in-app preview and return a
/// token; the frontend loads it via `roomdoc://localhost/<token>`. Old entries
/// are dropped so the store can't grow without bound.
#[tauri::command]
pub fn stage_preview_html(previews: State<'_, HtmlPreviews>, html: String) -> String {
    let token = previews.next.fetch_add(1, Ordering::Relaxed).to_string();
    let mut map = previews.map.lock().unwrap();
    if map.len() >= 24 {
        map.clear();
    }
    map.insert(token.clone(), html);
    token
}

/// The default, user-editable instruction each Studio action runs with. The UI
/// prefills its "edit the prompt" box from these (via `studio_prompts`), and the
/// same text is used when the user doesn't change it — so the button and the
/// edited prompt take the exact same path.
pub(crate) const STUDIO_FLASHCARDS_PROMPT: &str =
    "Make up to 12 flashcards that test real understanding of this material.";
pub(crate) const STUDIO_MINDMAP_PROMPT: &str =
    "Build a mind map: one central topic and a short tree of the key ideas.";
pub(crate) const STUDIO_PODCAST_PROMPT: &str =
    "Write a two-host podcast script that discusses the key points in a natural back-and-forth.";

/// The instruction to use: the user's edited prompt if they supplied one, else
/// the default. Trimmed; an empty edit falls back to the default.
pub(crate) fn studio_instruction(supplied: Option<String>, default: &str) -> String {
    supplied
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudioPrompts {
    pub flashcards: String,
    pub mindmap: String,
    pub podcast: String,
}

/// The default prompts, so the UI can show them in an editable box before a
/// Studio action runs.
#[tauri::command]
pub fn studio_prompts() -> StudioPrompts {
    StudioPrompts {
        flashcards: STUDIO_FLASHCARDS_PROMPT.into(),
        mindmap: STUDIO_MINDMAP_PROMPT.into(),
        podcast: STUDIO_PODCAST_PROMPT.into(),
    }
}

/// Rules every model-authored Studio page must follow: ONE self-contained,
/// offline HTML file (all CSS/JS inline, no network) so it renders fully in the
/// app's `roomdoc://` sandbox. Shared by the flashcards / mind-map / podcast
/// authors below.
pub(crate) const SELF_CONTAINED_HTML_RULES: &str = "Output ONE complete, self-contained HTML \
document and nothing else — no explanation, no markdown code fences. Put ALL CSS \
inside a <style> tag and ALL JavaScript inside a <script> tag in the same file. Use \
NO external resources whatsoever: no <link>, no <script src>, no CDN, no web fonts, \
no remote images, no fetch/XMLHttpRequest — the page runs offline in a sandbox and \
any network request silently fails. For images use inline SVG or a data: URI only. \
Make it a polished, responsive, dark-themed page: near-black background (#0b0b12), \
soft violet accent (#8b7cf6), light text, system font. Write correct JavaScript that \
runs on load with no errors.";

/// ADD-31: create this operation's cancel flag and, when the frontend supplied
/// an op id, register it in the shared cancel registry — the same one chat's
/// Stop uses — so `cancel_ask(opId)` stops a Studio run too. The caller keeps a
/// `CancelGuard` so the entry is removed on every return path.
pub(crate) fn register_studio_cancel(
    state: &State<'_, AppState>,
    op_id: &Option<String>,
) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(id) = op_id {
        state
            .cancels
            .lock()
            .unwrap()
            .insert(id.clone(), cancel.clone());
    }
    cancel
}

/// Ask the model to author a complete interactive HTML page for a Studio artifact.
/// Returns cleaned HTML, or `None` when the output isn't usable HTML — the caller
/// then falls back to a built-in template so the caller never hard-fails.
pub(crate) async fn generate_studio_html(
    model: &str,
    page_role: &str,
    instr: &str,
    label: &str,
    text: &str,
    // ADD-31: the Studio's Stop flag — authoring a whole page on a local model
    // runs for minutes and must be abandonable mid-stream.
    cancel: Arc<AtomicBool>,
) -> Result<Option<String>, String> {
    let schema = serde_json::json!({
        "type": "object",
        "properties": { "html": { "type": "string" } },
        "required": ["html"]
    });
    let messages = vec![
        ollama::ChatMessage::new("system", format!("{page_role}\n\n{SELF_CONTAINED_HTML_RULES}")),
        ollama::ChatMessage::new(
            "user",
            format!("{instr}\n\nBuild it only from this material about \"{label}\":\n\n{text}"),
        ),
    ];
    let raw = ollama::chat_structured(
        model,
        messages,
        Some(0.4),
        KEEP_ALIVE_WARM,
        &schema,
        ollama::StructuredOpts::default().with_cancel(cancel),
    )
    .await?;
    Ok(clean_studio_html(json_str_field(&raw, "html").unwrap_or_default()))
}

/// Normalize model-authored HTML; return `None` if it isn't a real HTML page (so
/// the caller can fall back to the built-in template).
pub(crate) fn clean_studio_html(html: String) -> Option<String> {
    let mut h = html.trim().to_string();
    // Strip an accidental ```html … ``` fence despite the schema.
    if let Some(rest) = h.strip_prefix("```") {
        let rest = rest.strip_prefix("html").unwrap_or(rest);
        h = rest.trim_start().to_string();
        if let Some(idx) = h.rfind("```") {
            h.truncate(idx);
        }
        h = h.trim().to_string();
    }
    let low = h.to_ascii_lowercase();
    let looks_html = low.contains("<html")
        || low.contains("<!doctype")
        || low.contains("<body")
        || low.contains("<style")
        || low.contains("<div");
    if h.len() < 60 || !looks_html {
        return None;
    }
    // Ensure a document wrapper + charset so it stands alone in the viewer.
    if !low.contains("<html") {
        h = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>{h}</body></html>"
        );
    }
    Some(h)
}

// ---- the shared studio pipeline ---------------------------------------------

/// The per-artifact differences between the Studio generators (flashcards, mind
/// map, podcast script). Everything else — cancel wiring, room-locked text
/// gathering, model resolution, the HTML-authoring primary path, the JSON
/// fallback, and save/open — is identical and lives in `run_studio`.
pub(crate) struct StudioSpec {
    /// Default editable instruction used when the caller supplies none.
    pub(crate) default_prompt: &'static str,
    /// System prompt for the HTML-authoring primary path.
    pub(crate) page_role: &'static str,
    /// Leading clause of the "…is writing" step chip (the suffix is shared).
    pub(crate) working_label: &'static str,
    /// Optional step chip shown just before the JSON fallback runs.
    pub(crate) fallback_step: Option<&'static str>,
    /// JSON-fallback schema.
    pub(crate) fallback_schema: serde_json::Value,
    /// JSON-fallback system prompt.
    pub(crate) fallback_system: &'static str,
    /// JSON-fallback grounding clause, formatted as `{intro} "{label}"`.
    pub(crate) fallback_intro: &'static str,
    /// JSON-fallback sampling temperature.
    pub(crate) fallback_temp: f64,
    /// Parse the fallback JSON and render the built-in template, or Err when the
    /// model returned nothing usable. Args: (raw JSON, scope label).
    pub(crate) render: fn(&str, &str) -> Result<String, String>,
    /// Output filename prefix, e.g. "Flashcards".
    pub(crate) filename_prefix: &'static str,
}

/// The one Studio pipeline shared by flashcards, mind map and podcast script:
/// register the Stop flag, gather the scope's text under the room lock, resolve a
/// structured model, ask it to author a whole interactive HTML page, and — only
/// if that isn't usable HTML — fall back to a structured extraction rendered by
/// the artifact's built-in template. `spec` carries the only differences.
pub(crate) async fn run_studio(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    spec: StudioSpec,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    op_id: Option<String>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    // ADD-31: a cancellable operation with visible stages. The flag is
    // registered under the caller's op id (same registry the chat Stop uses),
    // so the modal's Stop button works mid-generation.
    let cancel = register_studio_cancel(state, &op_id);
    let _cancel_guard = op_id.as_ref().map(|id| CancelGuard {
        state: state.inner(),
        ask_id: id.clone(),
    });
    let instr = studio_instruction(instructions, spec.default_prompt);
    let _ = window.emit("studio-step", "Reading the material…");
    let (label, text) = state.with_room(|room| {
        match refs.as_ref().filter(|r| !r.is_empty()) {
            Some(ids) => gather_files_text(&room.conn, ids),
            None => gather_scope_text(&room.conn, scope.as_deref(), &room.name),
        }
    })?;
    let model = resolve_structured_model(state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;
    let _ = window.emit(
        "studio-step",
        if is_cloud_model(&model) {
            format!("{} — the cloud model is writing…", spec.working_label)
        } else {
            format!("{} — a local model can take a few minutes…", spec.working_label)
        },
    );
    let content = match generate_studio_html(&model, spec.page_role, &instr, &label, &text, cancel.clone())
        .await?
    {
        Some(html) if !cancel.load(Ordering::SeqCst) => html,
        _ if cancel.load(Ordering::SeqCst) => return Err("Stopped.".into()),
        _ => {
            if let Some(step) = spec.fallback_step {
                let _ = window.emit("studio-step", step);
            }
            // Fallback: extract the structured artifact and render the built-in
            // template (so the caller never hard-fails on unusable HTML).
            let messages = vec![
                ollama::ChatMessage::new("system", spec.fallback_system),
                ollama::ChatMessage::new(
                    "user",
                    format!("{instr}\n\n{} \"{label}\":\n\n{text}", spec.fallback_intro),
                ),
            ];
            let raw = ollama::chat_structured(
                &model,
                messages,
                Some(spec.fallback_temp),
                KEEP_ALIVE_WARM,
                &spec.fallback_schema,
                ollama::StructuredOpts::default().with_cancel(cancel.clone()),
            )
            .await?;
            if cancel.load(Ordering::SeqCst) {
                return Err("Stopped.".into());
            }
            (spec.render)(&raw, &label)?
        }
    };
    let name = format!("{} - {}.html", spec.filename_prefix, safe_scope_name(&label));
    save_and_open(window, state, &name, "text/html", &content, "generated")
}

// ---- AI actions -------------------------------------------------------------
//
// A generic, menu-driven cousin of the Studio commands. Same plumbing (lock the
// room, gather scope/@-ref text, resolve the local model, emit so the UI opens
// the result), but every action produces a plain Markdown file instead of a
// bespoke HTML studio. The set of actions is data, not code: each is a spec with
// its own system prompt, so adding one is a single row. File-scope actions read
// the mentioned files (or the whole room); room-scope actions synthesize across
// the room. `research` is the only action that folds in a user question.
