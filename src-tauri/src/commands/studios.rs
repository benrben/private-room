use super::*;

mod flashcards;
mod mindmap;
mod podcast;
/// Recording a podcast script as audio — many voices, one m4a room file with a
/// seekable transcript. Split from `podcast` because it is a different act with
/// a different, much larger outbound seam; see the module header.
mod podcast_audio;

pub use flashcards::*;
pub use mindmap::*;
pub use podcast::*;
pub use podcast_audio::*;

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

/// Fill a built-in page template's `__SLOT__` placeholders in ONE left-to-right
/// pass. Chained `.replace()` calls rescan what earlier ones substituted, so a
/// file named `__CARDS__` (pasted in first as the title) had the whole deck
/// spliced into its own `<title>`. Substituted text is never re-examined here.
pub(crate) fn fill_template(template: &str, slots: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    loop {
        let hit = slots
            .iter()
            .filter_map(|(key, value)| rest.find(key).map(|at| (at, *key, *value)))
            .min_by_key(|(at, _, _)| *at);
        let Some((at, key, value)) = hit else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..at]);
        out.push_str(value);
        rest = &rest[at + key.len()..];
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
    let dir = std::env::temp_dir().join("arcelle-preview");
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
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("arcelle-preview"));
}

/// The same sweep, but only for files that have had time to be read.
///
/// Room lock also has to clear this folder — waiting for the next app start
/// meant a locked room's decrypted pages sat on disk for the rest of the
/// session — but it happens mid-session, which is exactly the case the blanket
/// sweep above documents as unsafe: `/usr/bin/open` returns before the browser
/// has opened the file. `grace` is how long a page gets before it counts as
/// handed over. Best-effort, like its blanket twin: an unreadable timestamp
/// leaves the file alone rather than guessing.
pub fn cleanup_browser_previews_older_than(grace: std::time::Duration) {
    sweep_previews_older_than(&std::env::temp_dir().join("arcelle-preview"), grace);
}

/// The body of [`cleanup_browser_previews_older_than`], over an explicit
/// directory so the age rule is testable without touching the shared temp dir
/// every other test and the running app share.
pub(crate) fn sweep_previews_older_than(dir: &std::path::Path, grace: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // nothing was ever opened this session
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= grace);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// How many staged preview pages the store holds. Each is a whole HTML document
/// kept in memory, so the store stays bounded.
pub(crate) const PREVIEW_MAX: usize = 24;

/// Stage a self-contained HTML page for the isolated in-app preview and return a
/// token; the frontend loads it via `roomdoc://localhost/<token>`. Full store →
/// the OLDEST entry is evicted; clearing the whole map instead took the page the
/// user still had open down with it.
#[tauri::command]
pub fn stage_preview_html(previews: State<'_, HtmlPreviews>, html: String) -> String {
    stage_preview_html_core(previews.inner(), html)
}

/// The body of [`stage_preview_html`], over a plain `&HtmlPreviews` so the
/// eviction rule is testable without a Tauri `State`.
pub(crate) fn stage_preview_html_core(previews: &HtmlPreviews, html: String) -> String {
    let token = previews.next.fetch_add(1, Ordering::Relaxed).to_string();
    let mut map = previews.map.lock().unwrap();
    // Tokens come from a monotonic counter, so the smallest number is the oldest.
    while map.len() >= PREVIEW_MAX {
        let Some(oldest) = map
            .keys()
            .min_by_key(|k| k.parse::<u64>().unwrap_or(u64::MAX))
            .cloned()
        else {
            break;
        };
        map.remove(&oldest);
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
///
/// The theme clause is specific for two reasons that are easy to undo by
/// accident. It names `html[data-theme="dark"]` because that is the ONLY
/// signal a staged document gets: `withFrameTheme` (src/viewers/frameTheme.ts)
/// stamps that attribute, and a page keyed on `prefers-color-scheme` would
/// follow the MAC instead of the room — the exact bug the built-in templates
/// were rewritten to kill. And it names one palette, because this string used
/// to carry both: a notebook clause was appended without deleting the old
/// "dark-themed page: near-black background (#0b0b12)", so every model was
/// asked for a near-black page made of warm paper and resolved the
/// contradiction its own way.
///
/// This is the ONE prompt in the Studio pipeline allowed to talk about colour,
/// and only because on this path the model IS the template: it authors the
/// whole page and no Rust template gets to style it afterwards. The four hex
/// values are copies of `src/styles/tokens.css` (--page and --ink for both
/// themes, plus --mk-pink-ink) and have to be kept in step with it, exactly
/// like `NOTEBOOK_CSS` in docs_html.rs. The light accent was #c63a58, which is
/// not a token from anywhere and measured 4.49:1 on the ivory page — under the
/// 4.5:1 floor by a rounding error; it is tokens.css's --mk-pink-ink now.
///
/// NO OTHER PROMPT IN THESE FILES NAMES A COLOUR OR A FONT, and none should.
/// A `page_role` describes the page's STRUCTURE and BEHAVIOUR and then defers
/// to this string for the look, so the palette is stated once. A
/// `fallback_system` asks for content and nothing else — on that path the
/// model's JSON goes into a Rust template that owns every pixel, and a styling
/// instruction there is dead weight at best and a fight with the template at
/// worst. (Audited 2026-08-05; the "soft violet accent (#8b7cf6)" clause an
/// earlier pass removed was exactly this bug.)
pub(crate) const SELF_CONTAINED_HTML_RULES: &str = "Output ONE complete, self-contained HTML \
document and nothing else — no explanation, no markdown code fences. Put ALL CSS \
inside a <style> tag and ALL JavaScript inside a <script> tag in the same file. Use \
NO external resources whatsoever: no <link>, no <script src>, no CDN, no web fonts, \
no remote images, no fetch/XMLHttpRequest — the page runs offline in a sandbox and \
any network request silently fails. For images use inline SVG or a data: URI only. \
Make it a polished, responsive page: ink on warm paper, light by default \
(#f4f1e8 paper, #20221f ink) with a dark palette under the html[data-theme=\"dark\"] \
selector (#151716 paper, #f0eee5 ink) — never a prefers-color-scheme media query — \
and a muted marker accent (#be3754 light, #c87b91 dark). System font stack only. \
Add a @media print rule that puts the page back on white with black text and drops \
any background pattern, because these pages get saved and printed. Write correct \
JavaScript that runs on load with no errors.";

/// ADD-31: create this operation's cancel node and, when the frontend supplied
/// an op id, register it in the shared cancel registry — the same one chat's
/// Stop uses — so `cancel_ask(opId)` stops a Studio run too. The caller keeps a
/// `CancelGuard` so the entry is removed on every return path.
///
/// Owner replacement #3: `parent_run` is the ask that asked for this build, when
/// there is one. A Studio started by the agent's `studio_flashcards` tool used
/// to be born with NO flag at all (`run_studio(..., op_id: None)`) — Stop ended
/// the answer and the build kept going, then saved its page into the room. As a
/// CHILD of the run it inherits that Stop before it can commit.
pub(crate) fn register_studio_cancel(
    state: &State<'_, AppState>,
    op_id: &Option<String>,
    parent_run: Option<&str>,
    label: &str,
) -> Arc<crate::cancel::Node> {
    let node = crate::cancel::child_of_run(state, parent_run, label);
    if let Some(id) = op_id {
        state
            .cancels
            .lock()
            .unwrap()
            .insert(id.clone(), node.flag());
        crate::cancel::remember(state, id, &node);
    }
    node
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
    /// Run the STRUCTURED extraction as the primary path, and never author
    /// free-form HTML at all.
    ///
    /// Only the podcast sets this, and the reason is the whole point of the
    /// artifact: its turns have to be readable as DATA, because voices are
    /// assigned per speaker and synthesized per line. A page of model-authored
    /// markup is a script that cannot be spoken — and under the HTML-first
    /// pipeline that was the usual outcome, since the structured shape only
    /// ever appeared on the fallback path.
    ///
    /// It also happens to be the more reliable path on a small model: authoring
    /// a whole styled HTML page is the hardest thing this pipeline asks of a
    /// 4B, while filling a four-field schema is the easiest. What is given up
    /// is per-episode visual invention, which `render_podcast_html` (already
    /// themed from NOTEBOOK_CSS, already tested) was doing better anyway.
    pub(crate) structured_first: bool,
    /// Called after the artifact is saved, with (room, new file id, raw model
    /// JSON). Lets an artifact persist STRUCTURE alongside its page — the
    /// podcast stores its cast and turns so voices can be re-assigned and the
    /// audio re-rendered without asking the model again.
    ///
    /// Only ever `Some` together with `structured_first`: the raw string handed
    /// over is the structured JSON, and on the HTML path there is none.
    pub(crate) after_save: Option<fn(&Connection, &str, &str) -> Result<(), String>>,
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
    // Owner replacement #3: the ask that asked for this build, when one did.
    // `None` for the three Studio buttons in the UI — nobody's child.
    parent_run: Option<&str>,
) -> Result<FileMeta, String> {
    // Wave 3 (Idea 9): a Studio run writes a file at the end — don't start one
    // while a rollback is swapping the DB.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    // ADD-31: a cancellable operation with visible stages. The flag is
    // registered under the caller's op id (same registry the chat Stop uses),
    // so a foreground Stop button works mid-generation.
    let node = register_studio_cancel(state, &op_id, parent_run, spec.filename_prefix);
    let _cancel_guard = op_id.as_ref().map(|id| CancelGuard {
        state: state.inner(),
        ask_id: id.clone(),
    });
    // The node is held for the whole build (dropped here, on every return path):
    // that is what keeps the parent's `Weak` link alive, and what makes the
    // parent's Stop reach the flag `run_studio_core` is polling.
    run_studio_core(window, state, spec, scope, instructions, refs, node.flag(), None).await
}

/// Reconstruct a studio's `StudioSpec` from the durable job plan's `kind` string
/// (the spec holds fn pointers + `&'static str`, so it can't be serialized into
/// the plan). Returns None for an unknown kind.
pub(crate) fn studio_spec_for(kind: &str) -> Option<StudioSpec> {
    match kind {
        "flashcards" => Some(flashcards_spec()),
        "mindmap" => Some(mindmap_spec()),
        "podcast" => Some(podcast_spec()),
        _ => None,
    }
}

/// Human title for a studio job card (e.g. its background-job label).
pub(crate) fn studio_title(kind: &str) -> &'static str {
    match kind {
        "flashcards" => "Flashcards",
        "mindmap" => "Mind map",
        "podcast" => "Podcast script",
        _ => "Studio",
    }
}

/// Ask the model for this artifact's STRUCTURED shape (its `fallback_schema`).
///
/// Extracted because two callers now want it: the JSON fallback under the
/// HTML-authoring path, and the podcast's primary path. Keeping one function
/// means the two cannot drift into asking for the same artifact differently —
/// which would show up as a podcast whose turns parse in one code path and not
/// the other.
async fn studio_structured(
    model: &str,
    spec: &StudioSpec,
    instr: &str,
    label: &str,
    text: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let messages = vec![
        ollama::ChatMessage::new("system", spec.fallback_system),
        ollama::ChatMessage::new(
            "user",
            format!("{instr}\n\n{} \"{label}\":\n\n{text}", spec.fallback_intro),
        ),
    ];
    ollama::chat_structured(
        model,
        messages,
        Some(spec.fallback_temp),
        KEEP_ALIVE_WARM,
        &spec.fallback_schema,
        ollama::StructuredOpts::default().with_cancel(cancel),
    )
    .await
}

/// The shared Studio pipeline, driven by an explicit `cancel` flag so a
/// background job's own `job_cancels` flag can Stop it (the foreground path
/// passes its chat-registry flag instead). `room_path`, when set, pins every
/// room access: a job that runs for minutes must not gather from — or write its
/// result into — a room the user swapped away from mid-run.
pub(crate) async fn run_studio_core(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    spec: StudioSpec,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    cancel: Arc<AtomicBool>,
    room_path: Option<&str>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    let instr = studio_instruction(instructions, spec.default_prompt);
    let _ = window.emit(
        "studio-step",
        serde_json::json!({ "step": "Reading the material…", "local": true }),
    );
    let (label, text) = state.with_room(|room| {
        if room_path.is_some_and(|rp| room.path != rp) {
            return Err("the room this job belongs to was closed".to_string());
        }
        match refs.as_ref().filter(|r| !r.is_empty()) {
            Some(ids) => gather_files_text(&room.conn, ids),
            None => gather_scope_text(&room.conn, scope.as_deref(), &room.name),
        }
    })?;
    let model = resolve_structured_model(state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;
    // "Does this leave the Mac?" is the DECLARED `local` field, not a pair of
    // name tests — the pair missed Ollama's `<size>-cloud` spelling
    // (`gpt-oss:120b-cloud`), so such a room was told a local model was writing
    // while the content was already on its way out.
    //
    // The flag is EMITTED alongside the words, rather than left for the
    // frontend to recover by matching "leaves this Mac" against the string.
    // The pane styles a privacy notice differently from a progress aside — one
    // is a consequence, the other is an aside — and deciding which is which by
    // grepping English would break on the first reworded sentence or the first
    // translation, silently, in the direction that under-warns.
    let local = declared_for(&model).local;
    let _ = window.emit(
        "studio-step",
        serde_json::json!({
            "step": if local {
                format!("{} — a local model can take a few minutes…", spec.working_label)
            } else {
                format!("{} — your cloud AI is writing (content leaves this Mac)…", spec.working_label)
            },
            "local": local,
        }),
    );
    // `structured_first` artifacts (the podcast) skip HTML authoring entirely:
    // their turns must survive as DATA, and the only path that produces data is
    // the structured one. The raw JSON is kept so `after_save` can persist it.
    let mut structured_raw: Option<String> = None;
    let content = if spec.structured_first {
        let raw = studio_structured(
            &model,
            &spec,
            &instr,
            &label,
            &text,
            cancel.clone(),
        )
        .await?;
        crate::cancel::guard_commit(&cancel, "the studio page")?;
        let html = (spec.render)(&raw, &label)?;
        structured_raw = Some(raw);
        html
    } else {
        match generate_studio_html(&model, spec.page_role, &instr, &label, &text, cancel.clone())
        .await?
    {
        Some(html) if !cancel.load(Ordering::SeqCst) => html,
        _ if cancel.load(Ordering::SeqCst) => return Err("Stopped.".into()),
        _ => {
            if let Some(step) = spec.fallback_step {
                let _ = window.emit(
                    "studio-step",
                    serde_json::json!({ "step": step, "local": true }),
                );
            }
            // Fallback: extract the structured artifact and render the built-in
            // template (so the caller never hard-fails on unusable HTML).
            let raw =
                studio_structured(&model, &spec, &instr, &label, &text, cancel.clone()).await?;
            if cancel.load(Ordering::SeqCst) {
                return Err("Stopped.".into());
            }
            (spec.render)(&raw, &label)?
        }
        }
    };
    // Pin the write too: bail if the room was swapped between gather and save,
    // so the generated file can never land in the wrong room.
    if let Some(rp) = room_path {
        let ok = {
            let guard = state.room.lock().unwrap();
            guard.as_ref().is_some_and(|r| r.path == rp)
        };
        if !ok {
            return Err("the room this job belongs to was closed".into());
        }
    }
    // LAST look before the side effect. Every cancel check above guards a MODEL
    // CALL; none of them guards the WRITE, and the generate -> render -> room-pin
    // stretch between the last one and this line is where a Stop lands in
    // practice. Live QA 2026-08-03: "Studio can create files after the UI says the
    // run failed or stopped" — the run reported stopped, and a file appeared in
    // the Library anyway.
    //
    // Checking here rather than only earlier is the whole point: a side effect
    // must be gated at the moment it is committed, not at the moment it was
    // decided. The generated HTML is discarded, which is what "Stopped" already
    // told the user happened.
    //
    // Owner replacement #3: this check is now `crate::cancel`'s, named once and
    // shared, and the flag it reads belongs to a NODE — so it is also how a
    // Stop pressed on the run that asked for this build reaches it (this
    // pipeline is a child of that run when an agent started it). The message
    // names the artifact rather than saying only "Stopped.", because "was not
    // saved" is the part the user needs.
    crate::cancel::guard_commit(&cancel, "the studio page")?;
    let name = format!("{} - {}.html", spec.filename_prefix, safe_scope_name(&label));
    // ART-1: the funnel re-reads `cancel` immediately before it commits, so the
    // gap between the check above and the write is closed at the write itself —
    // and a re-run of the same Studio over the same scope becomes a new version
    // of that deck, not a "Flashcards - clean-code (2).html" twin.
    let mut art = Artifact::new(&name, "text/html", &content)
        .by(spec.filename_prefix)
        .cancel_with(&cancel);
    if let Some(ids) = refs.as_ref().filter(|r| !r.is_empty()) {
        art = art.from_files(ids);
    }
    let meta = save_and_open(window, state, art).map(|w| w.meta)?;
    // Persist the artifact's STRUCTURE beside its page (the podcast's cast and
    // turns). After the save, because the row is keyed by the file id — and
    // deliberately non-fatal: the page is already in the room and useful, so a
    // failure here degrades the extras (voices can be re-assigned only after a
    // regenerate) rather than reporting a build that visibly succeeded as
    // failed.
    if let (Some(hook), Some(raw)) = (spec.after_save, structured_raw.as_deref()) {
        let stored = state.with_room(|room| hook(&room.conn, &meta.id, raw));
        if let Err(e) = stored {
            // Classified, never the text: an error string here can carry the
            // artifact's own name (obs::err_kind's whole reason).
            crate::obs::warn(
                "studio.structure_not_stored",
                &[
                    ("artifact", crate::obs::id(spec.filename_prefix)),
                    ("error", crate::obs::err_kind(&e)),
                ],
            );
        }
    }
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_template_never_rescans_what_it_substituted() {
        // A file named after one of the template's own slots used to splice the
        // later slot's content into the title (chained `.replace()` rescans).
        let out = fill_template(
            "<title>__TITLE__</title><div>__CARDS__</div>",
            &[("__TITLE__", "__CARDS__"), ("__CARDS__", "<b>deck</b>")],
        );
        assert_eq!(out, "<title>__CARDS__</title><div><b>deck</b></div>");
    }

    #[test]
    fn fill_template_fills_every_occurrence_and_leaves_unknown_slots() {
        let out = fill_template(
            "__A__ and __A__ and __MISSING__",
            &[("__A__", "x")],
        );
        assert_eq!(out, "x and x and __MISSING__");
    }

    #[test]
    fn stage_preview_drops_the_oldest_not_the_whole_store() {
        let previews = HtmlPreviews::default();
        let tokens: Vec<String> = (0..PREVIEW_MAX + 3)
            .map(|i| stage_preview_html_core(&previews, format!("<p>{i}</p>")))
            .collect();
        let map = previews.map.lock().unwrap();
        // The store is bounded, and the NEWEST pages are the ones still in it —
        // the previous sweep cleared everything, so the page the user had open
        // vanished with the rest.
        assert_eq!(map.len(), PREVIEW_MAX);
        assert!(map.contains_key(tokens.last().unwrap()));
        assert!(!map.contains_key(&tokens[0]), "the oldest entry is the one dropped");
    }

    #[test]
    fn locking_sweeps_handed_over_previews_but_spares_the_one_just_opened() {
        // "Open in browser" is the one place room content touches unencrypted
        // disk. It used to be cleared only at the NEXT app start, so a locked
        // room (or a crash) left it readable for the rest of the session. The
        // grace period is what makes a mid-session sweep safe: `/usr/bin/open`
        // returns before the browser has read the file.
        let dir = std::env::temp_dir().join(format!("arcelle-preview-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let stale = dir.join("old-1.html");
        let fresh = dir.join("new-1.html");
        std::fs::write(&stale, "<p>room content</p>").unwrap();
        std::fs::write(&fresh, "<p>room content</p>").unwrap();
        // Age the first one past the grace period without sleeping for it.
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();

        sweep_previews_older_than(&dir, std::time::Duration::from_secs(60));

        assert!(!stale.exists(), "a handed-over preview must not survive the lock");
        assert!(
            fresh.exists(),
            "a page opened seconds ago would be pulled out from under the browser"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
