use super::*;

/// Chat default: `DEFAULT_MODEL` (qwen3.5:4b) — text + vision + tool calling,
/// no hidden "thinking" pass. Falls back to the first installed model when the
/// default isn't present.
/// True for embedding-only models (nomic-embed-text, bge-*, mxbai-embed-*, …).
/// They answer `/api/embed` but NOT `/api/chat`, so they must never be picked as
/// the chat model — doing so returns "does not support chat" and broke
/// flashcards, image marking, and file-context chat turns once `nomic-embed-text`
/// was pulled for semantic search.
pub(crate) fn is_embedding_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.starts_with(ollama::EMBED_MODEL) || m.contains("embed") || m.contains("bge-")
}

/// The installed tag that IS the default, if one of them is.
///
/// Recognised by prefix, because `qwen3.5:4b-mlx` and `qwen3.5:4b-q4_K_M` are
/// builds of the default and picking them is the whole point — but the tag
/// RETURNED has to be the one Ollama was listed as holding. Returning the bare
/// constant instead meant a Mac with only the MLX build asked for a model that
/// does not exist there, and every caller falling back to the default got
/// `model 'qwen3.5:4b' not found` with nothing to say why.
///
/// Exact first: with several builds installed, the plain tag is the one the
/// app's own defaults were tuned against.
fn installed_default(models: &[String]) -> Option<&String> {
    models
        .iter()
        .find(|m| *m == DEFAULT_MODEL)
        .or_else(|| models.iter().find(|m| m.starts_with(DEFAULT_MODEL)))
}

pub(crate) fn best_default(models: &[String]) -> String {
    if models.is_empty() {
        return DEFAULT_MODEL.to_string();
    }
    if let Some(installed) = installed_default(models) {
        return installed.clone();
    }
    // Fall back to the first *chat-capable* model — never an embedding model.
    models
        .iter()
        .find(|m| !is_embedding_model(m))
        .cloned()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// A chat-capable model that runs ON THIS MAC — not an embedding model, not an
/// external CLI, not an Ollama `:cloud` model. The tool-driving agent loop and
/// on-device structured side-calls must run here, because `:cloud` models leak
/// tool calls inline (see is_cloud_model) and can't be trusted to drive the app.
/// Prefers the tuned default; falls back to the first eligible installed model,
/// then to the default name (so an Ollama error names the missing model).
pub(crate) fn best_local_default(models: &[String]) -> String {
    // The tag that is actually installed, never the canonical name — see
    // [`installed_default`]. This picker feeds the privacy scan, so a name
    // Ollama refuses is a scan that fails on every file with nothing to show.
    if let Some(installed) = installed_default(models) {
        return installed.clone();
    }
    models
        .iter()
        // The MODEL question ("an ordinary Ollama tag, not a relay"), not the
        // privacy one: with the Closet pointed at another computer every tag
        // fails `runs_on_this_mac`, and this would have no model left to name.
        .find(|m| !is_embedding_model(m) && served_by_ollama_engine(m))
        .cloned()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// ADD-25: can this model READ an image (screenshot, video frame, room picture)
/// fed into its context? Text-only models get a describe pass from a model that
/// can see, instead of an attached image.
///
/// ASKED, NEVER GUESSED FROM THE NAME. Every engine we speak to publishes this:
/// Ollama reports a `vision` capability through `/api/show` (metadata only, no
/// model load), and an API provider's image input rides the same live catalog
/// the model picker fetches. This used to fall back to matching substrings
/// ("vl", "llava", "gemma3", …) in the model name, which is a list of the
/// models that existed when the list was written — so anything newer or simply
/// named differently read as blind: its images were described to it second-hand
/// by another model, and "mark this image" refused with "no vision model
/// installed" while a perfectly capable model was selected.
///
/// An engine that answers nothing is UNKNOWN, and unknown is not "yes": in
/// practice it means the sidecar or Ollama is unreachable, in which case the
/// vision call this gates was going to fail anyway, and failing on the engine
/// is a truer message than a guess from a name.
///
/// The per-engine facts this used to spell out inline — a cloud CLI having no
/// image channel at all, a provider model's image input living in the live
/// catalog — are now DECLARED once in `capabilities.rs` and read from there, so
/// this and the published support matrix cannot say different things about the
/// same engine. The collapse of `Support::Unknown` to `false` stays HERE, at
/// the caller, because that is a decision about this particular question ("may
/// we hand it pixels?") and not a fact about the engine.
pub(crate) async fn chat_model_sees_images(model: &str) -> bool {
    crate::commands::vision_support(model).await.is_yes()
}

/// Which model draws the boxes for this room's image — ASKED, not guessed.
///
/// This is the pick the whole "it insists on downloading a vision helper" bug
/// lived in. It used to be a search for three hard-coded Qwen-VL name patterns
/// inside the LOCAL Ollama list, with a fallback that refused any external
/// engine outright. So both of these were invisible to it:
///
///   * the room's own cloud model — Claude, Gemini, GPT through an API provider
///     — whose image input is declared in the very catalog the model picker
///     already fetched; and
///   * any local multimodal build that isn't one of those three names.
///
/// Either way the user was told "no vision model is installed" and shown a
/// Download button, while a more capable model sat right there, already
/// selected. Nothing but this pick was missing: the sidecar's `/vision_locate`
/// has always accepted a `provider`, `sidecar_json`/`sidecar_post` inject one
/// for any API-provider model, and `provider_api` attaches the image to the
/// outgoing turn.
///
/// Order of truth, capability only:
///   1. the room's OWN chosen model, when its engine says it takes images AND
///      an image can actually reach it ([`image_reaches_model`]) — the user
///      picked it, so it wins;
///   2. any installed model that REPORTS vision — on-Mac ones only, because by
///      here the user has expressed no preference and pixels should not leave
///      the machine on a pick they never made;
///   3. `None` — and only then is "nothing here can see images" a true thing to
///      say.
pub(crate) async fn grounding_pick(models: &[String], chat_model: &str) -> Option<String> {
    if image_reaches_model(chat_model) && chat_model_sees_images(chat_model).await {
        return Some(chat_model.to_string());
    }
    for m in models {
        if m == chat_model || !runs_on_this_mac(m) {
            continue;
        }
        if chat_model_sees_images(m).await {
            return Some(m.clone());
        }
    }
    None
}

/// Will the PIXELS actually arrive at this model, or does something between
/// here and it drop them?
///
/// Capability is not the whole question. The room's privacy door
/// (`privacy.guard_outbound`) strips every image out of a request bound for a
/// non-local model and only COUNTS what it blocked — it does not fail the call.
/// So a cloud model that genuinely can see, in a room with the door on, gets a
/// grounding prompt and no picture, answers with nothing, and the viewer renders
/// that empty answer as "The AI could not locate that in this image" — a false
/// statement about the user's photograph caused by a setting three screens away.
///
/// Picking such a model is therefore wrong even though it is capable: fall
/// through to a local one, whose pixels the door has no reason to touch, and if
/// there is none say so plainly. Naming the rule here rather than inside the
/// pick keeps it findable from the seam it mirrors.
pub(crate) fn image_reaches_model(model: &str) -> bool {
    !(!runs_on_this_mac(model) && active_policy().is_some())
}

/// Which model would mark an image for the OPEN room, or `None` when nothing
/// can. The viewer's vision offer and Settings → AI helpers both used to
/// re-derive this in TypeScript from the Ollama model list alone, so a room
/// running a cloud vision model was told to download a local one it had no use
/// for. They ask this instead — one answer, the same one the grounding call
/// itself will use.
#[tauri::command]
pub async fn grounding_model_for_room(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let chat_model = explicit.unwrap_or_else(|| best_default(&models));
    Ok(grounding_pick(&models, &chat_model).await)
}

/// HLT-5: keep the chat model resident this long so follow-up questions are
/// snappy. Vision/grounding calls may override this (see `vision_keep_alive`).
pub(crate) const KEEP_ALIVE_WARM: &str = "30m";
/// HLT-5: release a distinct vision model quickly on low-RAM machines.
pub(crate) const KEEP_ALIVE_SHORT: &str = "2m";
/// HLT-5: machines at or above this stay warm even for a second model.
pub(crate) const HIGH_RAM_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// Total physical RAM in bytes, read once (sysinfo). Cached — the value doesn't
/// change while the app runs, and refreshing memory info is not free.
pub(crate) fn total_ram_bytes() -> u64 {
    static RAM: OnceLock<u64> = OnceLock::new();
    *RAM.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.total_memory()
    })
}

/// HLT-5: how long a vision/grounding call should keep its model resident.
///
/// When the vision model IS the chat model, only one model is ever loaded, so
/// keeping it warm costs nothing — use the warm value. When they differ, holding
/// BOTH resident for 30 minutes has overwhelmed and crashed Ollama on 16 GB
/// Macs. So on machines under 32 GB we release the vision model right after the
/// grounding call (a short keep_alive): repeated marking pays a reload, which is
/// the right tradeoff for stability. Machines with >= 32 GB have the headroom to
/// keep it warm for snappier repeated marking. The chat model always stays warm.
pub(crate) fn vision_keep_alive(total_ram: u64, vision_model: &str, chat_model: &str) -> &'static str {
    if vision_model == chat_model || total_ram >= HIGH_RAM_THRESHOLD_BYTES {
        KEEP_ALIVE_WARM
    } else {
        KEEP_ALIVE_SHORT
    }
}

pub(crate) fn model_setting(conn: &Connection) -> Option<String> {
    db::get_setting(conn, "model")
}

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    // Probe ONCE per session. Detecting the cloud CLIs forks an interactive
    // login shell that sources the whole `.zshrc`, and `ai_status` runs on every
    // image open and every status refresh — re-probing each time paid that cost
    // repeatedly for an answer that cannot change without a reinstall. Advisors
    // are CLI subprocesses today, so this cache stays CLI-only while the
    // user-facing list below also folds in connected API providers.
    // The lock is taken, cloned and released around the await, never across it.
    let cached = state.external_cache.lock().unwrap().clone();
    let external = match cached {
        Some(hit) => hit,
        None => {
            let probed = tauri::async_runtime::spawn_blocking(detect_external_blocking)
                .await
                .unwrap_or_default();
            *state.external_cache.lock().unwrap() = Some(probed.clone());
            probed
        }
    };
    let mut external = external;
    if provider_connected("openrouter") {
        external.push("openrouter".into());
    }
    let installed = tauri::async_runtime::spawn_blocking(ollama_installed_blocking)
        .await
        .unwrap_or(false);
    match ollama::list_models().await {
        Ok(models) => {
            let default_model = explicit.unwrap_or_else(|| best_default(&models));
            Ok(AiStatus {
                running: true,
                // Reachable means installed, regardless of the app-path check.
                installed: true,
                models,
                default_model,
                external,
                remote_relay: !ollama_runs_here(),
            })
        }
        Err(_) => Ok(AiStatus {
            running: false,
            installed,
            models: vec![],
            default_model: explicit.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            external,
            remote_relay: !ollama_runs_here(),
        }),
    }
}

/// ADD-22: a model's tool/vision capabilities, so Settings can badge each model
/// and warn when the chosen one can't drive the app. `/api/show` is metadata
/// only (no model load); an unreachable Ollama yields an empty list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    pub name: String,
    pub tools: bool,
    pub vision: bool,
}

#[tauri::command]
pub async fn model_capabilities() -> Result<Vec<ModelCaps>, String> {
    let models = ollama::list_models().await.unwrap_or_default();
    let mut out = Vec::with_capacity(models.len());
    for m in models {
        let caps = ollama::capabilities(&m).await;
        out.push(ModelCaps {
            tools: caps.iter().any(|c| c == "tools"),
            vision: caps.iter().any(|c| c == "vision"),
            name: m,
        });
    }
    Ok(out)
}

/// ADD-10: launch the Ollama app so a first-time user never touches a terminal.
///
/// WAITS for `open` to report, instead of `spawn`ing and calling that success.
/// `spawn` only fails when `open` itself cannot be executed — which never
/// happens on macOS — so "Unable to find application named 'Ollama'" was
/// reported to the user as a launch that worked. For anyone with a
/// command-line-only Ollama there IS no app to open, and the button quietly did
/// nothing while the "not running" banner stayed up: exactly the unevidenced
/// success this app doesn't do. `open` returns as soon as it has handed the
/// launch off, so waiting costs nothing.
#[tauri::command]
pub async fn open_ollama() -> Result<(), String> {
    let out = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("open")
            .args(["-a", "Ollama"])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not open Ollama: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(open_ollama_failure(&out.stderr))
}

/// The sentence for a failed launch. `open`'s own reason when it gave one —
/// never invented — plus the one thing that actually helps, because the common
/// case is a real, working Ollama installed without its .app.
fn open_ollama_failure(stderr: &[u8]) -> String {
    let detail: String = String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(200)
        .collect();
    let head = if detail.is_empty() {
        "Couldn't open the Ollama app.".to_string()
    } else {
        format!("Couldn't open the Ollama app: {detail}")
    };
    format!(
        "{head} If you installed Ollama from the command line there is no app to open — \
         start it with `ollama serve` in Terminal."
    )
}

#[tauri::command]
pub async fn warm_model(state: State<'_, AppState>) -> Result<(), String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let mut chat_model = explicit.unwrap_or_else(|| best_default(&models));
    // Cloud CLIs need no warm-up; pre-load the local model instead so
    // vision/marking stays fast.
    if is_external_engine(&chat_model) {
        if models.is_empty() {
            return Ok(());
        }
        chat_model = best_default(&models);
    }
    // Warm ONLY one model: keeping two resident overwhelms 16 GB machines
    // and takes Ollama down.
    ollama::warm(&chat_model).await
}

/// Smallest change in a download's percentage worth repainting the bar for.
const PULL_PROGRESS_STEP: f64 = 0.5;

/// The cancel-registry key a running download is filed under, so Stop reaches
/// it. One download per model, keyed by the model's own name — the frontend
/// already knows that name (it is what it asked to pull), so no new id has to be
/// invented, handed out or kept in sync.
pub(crate) fn pull_cancel_key(name: &str) -> String {
    format!("pull:{name}")
}

/// What Ollama will actually be asked for, from what the user typed.
///
/// Ollama files a pulled model under the exact string it was given, and only
/// its own library is case-insensitive about finding one. A name with a host or
/// a namespace in it (`hf.co/Owner/Repo`, `someone/Model`) is that host's to
/// spell, and lowercasing it would break the pull outright; a bare `name:tag`
/// belongs to ollama.com, which is lowercase throughout.
///
/// See `a_typed_model_name_is_normalised_to_the_registry_that_will_serve_it`
/// for what a stray capital did to a hosted model.
fn registry_name(typed: &str) -> String {
    let typed = typed.trim();
    if typed.contains('/') {
        typed.to_string()
    } else {
        typed.to_lowercase()
    }
}

/// Download a model, reporting progress on `pull-progress`.
///
/// Cancellable FROM HERE DOWN: the flag is registered in the SAME registry
/// chat's Stop uses, so `cancel_ask("pull:<model name>")` abandons a running
/// download, which returns [`ollama::PULL_CANCELLED`].
///
/// The symptom this exists for — a 3 GB vision helper is unstoppable once
/// started, with no Cancel, no Pause and no effect from leaving the screen — is
/// fixed: every surface that starts a pull now offers a Stop that calls
/// `api.cancelAsk('pull:' + name)` (Settings → model download, Settings →
/// helpers, the image viewer's vision-helper offer, and the chat pane's
/// first-run "Pick a model to download" card). Each keeps the name it started
/// with in a ref, because the name on screen can change under a running pull;
/// each also reads [`ollama::PULL_CANCELLED`] as "stopped", never as an error.
#[tauri::command]
pub async fn pull_model(
    window: tauri::Window,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let cancel = Arc::new(AtomicBool::new(false));
    // Keyed on what the CALLER typed, not on the normalised name: the frontend
    // stops a download with `cancelAsk('pull:' + <the name it asked for>)`, and
    // a key it cannot reproduce is a Stop button that does nothing.
    let key = pull_cancel_key(&name);
    state
        .cancels
        .lock()
        .unwrap()
        .insert(key.clone(), cancel.clone());
    // Removes the registry entry on every return path, including the `?` ones.
    let _cancel_guard = CancelGuard {
        state: state.inner(),
        ask_id: key,
    };
    // A multi-gigabyte pull emits a progress line per chunk — hundreds a second,
    // each one a separate IPC message and a React render, for a bar that cannot
    // show more than about 200 distinct positions. Forward only what actually
    // changes something the user can see: a new phase, half a percent of
    // progress, or the final 100%.
    let mut last_status = String::new();
    let mut last_percent: Option<f64> = None;
    ollama::pull_cancellable(&registry_name(&name), &cancel, |status, percent| {
        let phase_changed = status != last_status;
        let moved = match (percent, last_percent) {
            (Some(now), Some(before)) => (now - before).abs() >= PULL_PROGRESS_STEP || now >= 100.0,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if !phase_changed && !moved {
            return;
        }
        last_status = status.to_string();
        if percent.is_some() {
            last_percent = percent;
        }
        let _ = window.emit(
            "pull-progress",
            serde_json::json!({ "status": status, "percent": percent }),
        );
    })
    .await
}

#[tauri::command]
pub async fn delete_model(name: String) -> Result<(), String> {
    ollama::delete_model(&name).await
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A CAPITAL LETTER IN THE DOWNLOAD FIELD USED TO BREAK THE MODEL FOREVER.
    ///
    /// Reproduced against the live daemon (2026-08-19): Ollama's registry is
    /// lowercase, but `/api/pull` accepts any casing and then FILES the model
    /// under the literal string it was handed. For a local model that is only
    /// cosmetic. For a hosted one it is fatal — `/api/chat` strips the `-cloud`
    /// suffix and proxies the rest of the name to ollama.com verbatim, so
    ///
    ///     POST /api/chat {"model":"Gpt-oss:120b-cloud"}
    ///       → {"error": "model 'Gpt-oss:120b' not found"}
    ///
    /// on every request, for a model the Settings list shows as installed.
    /// Live QA lost a whole privacy check to it.
    #[test]
    fn a_typed_model_name_is_normalised_to_the_registry_that_will_serve_it() {
        assert_eq!(registry_name("  Gpt-oss:120b-cloud "), "gpt-oss:120b-cloud");
        assert_eq!(registry_name("Qwen3.5:4B"), "qwen3.5:4b");
        assert_eq!(registry_name("qwen3.5:4b"), "qwen3.5:4b");
        // NOT lowercased: everything with a host or a namespace in it belongs
        // to somebody else's case-SENSITIVE registry. Hugging Face serves
        // `hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF` and 404s on the
        // lowercase spelling, which is the same bug pointed the other way.
        assert_eq!(
            registry_name("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF"),
            "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF"
        );
        assert_eq!(registry_name("  library/Gemma3  "), "library/Gemma3");
    }

    #[test]
    fn vision_keep_alive_by_ram_and_model() {
        let gb = 1024 * 1024 * 1024;
        // Distinct vision model on a 16 GB Mac → released quickly.
        assert_eq!(vision_keep_alive(16 * gb, "qwen2.5vl", "qwen3.5:4b"), "2m");
        // Same 16 GB Mac, but vision == chat model → only one model loaded, warm.
        assert_eq!(vision_keep_alive(16 * gb, "qwen3.5:4b", "qwen3.5:4b"), "30m");
        // 32 GB Mac keeps a distinct vision model warm too.
        assert_eq!(vision_keep_alive(32 * gb, "qwen2.5vl", "qwen3.5:4b"), "30m");
        assert_eq!(vision_keep_alive(64 * gb, "qwen2.5vl", "qwen3.5:4b"), "30m");
    }

    /// Detecting the cloud CLIs forks an INTERACTIVE login shell, which sources
    /// the user's whole `.zshrc` — that is why the result is cached in
    /// `external_cache`. `ai_status` runs on every image open and every status
    /// refresh, and it used to re-probe every time and then overwrite the cache
    /// with its own answer, so the cache saved nothing here.
    ///
    /// The sentinel proves the cached answer is USED: a fresh probe on this Mac
    /// can only return engine ids this app knows about.
    #[tokio::test]
    async fn ai_status_answers_from_the_cached_engine_probe() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = app.state::<AppState>();
        *state.external_cache.lock().unwrap() = Some(vec!["sentinel-cli".to_string()]);

        let status = ai_status(state.clone()).await.unwrap();

        assert!(
            status.external.contains(&"sentinel-cli".to_string()),
            "the cached probe should be the answer, got {:?}",
            status.external
        );
        // …and the cache is left as it was, rather than replaced by a re-probe.
        assert_eq!(
            *state.external_cache.lock().unwrap(),
            Some(vec!["sentinel-cli".to_string()])
        );
    }

    #[test]
    fn a_download_is_filed_under_a_key_the_caller_can_rebuild() {
        // The Stop button has only the model name to work with, so the key must
        // be derivable from it alone — `cancel_ask("pull:" + model)`. Pinned
        // because the frontend rebuilds this string rather than being handed it.
        assert_eq!(pull_cancel_key("qwen2.5vl"), "pull:qwen2.5vl");
        assert_eq!(pull_cancel_key("qwen2.5vl:7b"), "pull:qwen2.5vl:7b");
        // Two different downloads never share an entry.
        assert_ne!(pull_cancel_key("a"), pull_cancel_key("b"));
    }

    /// Who may look at an image is decided by CAPABILITY, never by the model's
    /// name. The old code matched substrings ("vl", "llava", "gemma3", …), which
    /// is a snapshot of the models that existed when the list was written — so
    /// anything newer, anything from another vendor, and every cloud model the
    /// user selected themselves read as blind, and the app answered by demanding
    /// a download of the one name it did know.
    ///
    /// The three answers reachable without an engine are pinned here; the rest
    /// come from `/api/show` and the provider catalog, which is the whole point.
    #[tokio::test]
    async fn vision_is_a_capability_question_not_a_name_question() {
        // An embedding model never sees, whatever it is called.
        assert!(!chat_model_sees_images("nomic-embed-text:latest").await);
        // A cloud CLI is a subprocess with no image channel — regardless of how
        // capable the model behind it is, we cannot hand it pixels, so a room on
        // one still needs a local model that can see.
        assert!(!chat_model_sees_images("claude-cli").await);
        assert!(!chat_model_sees_images("codex-cli::some-model::high").await);
        // ...and with nothing installed to fall back to, the pick is None rather
        // than a name we hope is multimodal.
        assert_eq!(grounding_pick(&[], "claude-cli").await, None);
    }

    /// Capability is not the whole question: the privacy door strips images out
    /// of any non-local request and only counts them, so a capable cloud model
    /// in a door-on room would be handed a grounding prompt with no picture and
    /// answer with no boxes — which the viewer renders as "could not locate that
    /// in this image", a false claim about the user's photo. Such a model must
    /// not be picked at all.
    #[test]
    fn a_model_the_door_would_blind_is_not_eligible() {
        let _guard = policy_test_lock();
        clear_policy();
        // Door off: every model can be reached with pixels.
        assert!(image_reaches_model("openrouter::vendor/sees"));
        assert!(image_reaches_model("vendor-vl:cloud"));
        assert!(image_reaches_model("some-local-model"));

        set_active_policy_for_test();
        // Door on: the two ways out of the Mac are now blind...
        assert!(!image_reaches_model("openrouter::vendor/sees"));
        assert!(!image_reaches_model("vendor-vl:cloud"));
        assert!(!image_reaches_model("claude-cli::x"));
        // ...while a model running here is untouched by it.
        assert!(image_reaches_model("some-local-model"));
        clear_policy();
    }

    #[test]
    fn best_default_never_returns_an_embedding_model() {
        // Regression: pulling nomic-embed-text for semantic search must not make
        // it the fallback CHAT model — it can't answer /api/chat, which broke
        // flashcards, image marking, and file-context chat turns.
        assert!(is_embedding_model("nomic-embed-text:latest"));
        assert!(is_embedding_model("mxbai-embed-large"));
        assert!(!is_embedding_model("qwen3.5:9b"));
        // Embed model listed first, no default installed → still pick the chat model.
        let models = vec!["nomic-embed-text:latest".to_string(), "qwen3.5:9b".to_string()];
        assert_eq!(best_default(&models), "qwen3.5:9b");
        // The preferred default still wins when present.
        let with_default = vec![
            "nomic-embed-text:latest".to_string(),
            format!("{DEFAULT_MODEL}:latest"),
        ];
        assert!(best_default(&with_default).starts_with(DEFAULT_MODEL));
    }

    #[test]
    fn best_local_default_skips_cloud_embedding_and_external() {
        assert!(is_cloud_model("minimax-m3:cloud"));
        assert!(!is_cloud_model("qwen3.5:9b"));
        // The failing QA env: a cloud model + embeddings + a local chat model.
        // The tool loop must land on the local chat model, never the cloud one.
        let models = vec![
            "minimax-m3:cloud".to_string(),
            "nomic-embed-text:latest".to_string(),
            "qwen3.5:9b".to_string(),
        ];
        assert_eq!(best_local_default(&models), "qwen3.5:9b");
        // Only a cloud model + embeddings installed → fall back to the default
        // name so Ollama surfaces a clear "model not found" rather than driving
        // the app with a cloud model that leaks tool calls.
        let no_local = vec![
            "minimax-m3:cloud".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert_eq!(best_local_default(&no_local), DEFAULT_MODEL);
    }

    /// THE DEFAULT MUST BE A TAG OLLAMA WILL ANSWER TO.
    ///
    /// Both pickers recognised the default by PREFIX — so an MLX or quantised
    /// build counts, which is right — and then returned the bare constant,
    /// which Ollama has never heard of. On a Mac holding `qwen3.5:4b-mlx` and
    /// nothing else local, every caller that falls back to the local default
    /// asked for `qwen3.5:4b`:
    ///
    ///     {"error":"model 'qwen3.5:4b' not found"}
    ///
    /// Live QA saw it as the privacy scan failing on all 20 files, every time,
    /// with no reason given — the scan's own model is exactly that fallback.
    #[test]
    fn the_default_model_picked_is_the_variant_actually_installed() {
        let mlx = vec![
            "qwen3.5:4b-mlx".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert_eq!(best_default(&mlx), "qwen3.5:4b-mlx");
        assert_eq!(best_local_default(&mlx), "qwen3.5:4b-mlx");
        // An exact match wins over a variant, whatever order Ollama lists them.
        let both = vec![
            "qwen3.5:4b-mlx".to_string(),
            DEFAULT_MODEL.to_string(),
            "qwen3.5:4b-q4_K_M".to_string(),
        ];
        assert_eq!(best_default(&both), DEFAULT_MODEL);
        assert_eq!(best_local_default(&both), DEFAULT_MODEL);
        // Nothing installed at all still names the default, so the error the
        // user reads is "install this", not "install something".
        assert_eq!(best_default(&[]), DEFAULT_MODEL);
        assert_eq!(best_local_default(&[]), DEFAULT_MODEL);
        // The local picker still refuses a variant it must not drive the app
        // with: a relayed tag is not a model running on this Mac.
        let embed_only = vec!["nomic-embed-text:latest".to_string()];
        assert_eq!(best_local_default(&embed_only), DEFAULT_MODEL);
    }

    #[test]
    fn a_failed_ollama_launch_says_so_and_names_the_command_line_case() {
        // `spawn` succeeded whatever `open` then reported, so "Unable to find
        // application named 'Ollama'" reached the user as a working launch and
        // the "not running" banner just stayed up with nothing to explain it.
        let msg = open_ollama_failure(b"Unable to find application named 'Ollama'\n");
        assert!(msg.contains("Unable to find application named 'Ollama'"), "{msg}");
        assert!(msg.contains("ollama serve"), "the one thing that helps is missing: {msg}");
        // No reason from `open` is still a failure, and still not silence.
        let bare = open_ollama_failure(b"");
        assert!(bare.starts_with("Couldn't open the Ollama app."), "{bare}");
        assert!(bare.contains("ollama serve"));
    }
}
