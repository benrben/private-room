mod biometrics;
pub mod browser;
pub mod cancel;
mod commands;
pub mod db;
pub mod extraction;
pub mod formats;
pub mod mcp;
pub mod media_probe;
mod model_limits;
pub mod obs;
mod ocr;
mod ollama;
mod ollama_lifecycle;
pub mod quicklook;
pub mod recording;
mod room_mcp;
mod sidecar;
mod sidecar_lifecycle;
pub(crate) mod snapshot;
pub mod stt;
pub mod textutil;
mod token_usage;
pub mod turn;
pub mod web;

use commands::AppState;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

/// The app's one and only window label.
pub(crate) const MAIN_WINDOW: &str = "main";

/// The main WINDOW — never `get_webview_window`.
///
/// THE BUG THIS EXISTS FOR (BROWSE-1, 2026-07-30): tauri's
/// `AppHandle::get_webview_window(label)` returns `Some` only while
/// `Window::is_webview_window()` holds, and that is
/// `self.webviews().iter().all(|w| w.label() == self.label())` — i.e. "this
/// window hosts exactly one webview, and it shares the window's label".
///
/// The private browser is a CHILD webview (`browser::BROWSER_LABEL`) added to
/// this very window. From the moment a page opens, the main window hosts two
/// webviews, `is_webview_window()` goes false, and EVERY
/// `get_webview_window("main")` in the codebase starts returning `None` —
/// until the browser is closed. That silently took out the room MCP bridge's
/// tool dispatch ("main window is gone" for every tool the agent called), the
/// job/workflow progress events, and the scheduler.
///
/// `get_window` has no such predicate: a window is a window however many
/// webviews it hosts. Every caller that only needs to `emit` or to hand a
/// `&Window` to a command must use THIS.
pub(crate) fn main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<tauri::Window<R>> {
    tauri::Manager::get_window(app, MAIN_WINDOW)
}

/// The main window's own WEBVIEW — for the few callers that need the platform
/// webview itself (screenshots) rather than the window. Also immune to the
/// child-webview trap above: it is a direct label lookup.
pub(crate) fn main_webview<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::Webview<R>> {
    tauri::Manager::webviews(app).get(MAIN_WINDOW).cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIRST, before anything can make a decision worth recording: the host's own
    // event log (`obs`). It writes beside the sidecar's stderr mirror so "the
    // logs" is one folder, and it is quiet by default — `ARCELLE_LOG` turns the
    // detail up.
    obs::init(env!("CARGO_PKG_VERSION"));
    // Sweep decrypted "Open in browser" previews left behind by a crashed or
    // force-quit session before anything else runs.
    commands::cleanup_browser_previews();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(commands::HtmlPreviews::default())
        .manage(commands::MediaStreams::default())
        .manage(commands::PeakCache::default())
        .manage(commands::SlideCache::default())
        .manage(commands::AgentUi::default())
        // BROWSE-1: the private browser area's state (takeover flag, last
        // bounds, this session's agent journal).
        .manage(browser::BrowserState::default())
        .manage(commands::RecState::default())
        .manage(commands::DictState::default())
        // ADD-24: stream staged room media (audio/video) with HTTP Range
        // support — WKWebView's media elements need 206 responses to seek, and
        // large videos must never ride through IPC as base64. Bytes come from
        // the in-memory MediaStreams map (decrypted, capped, cleared on lock).
        .register_uri_scheme_protocol("roommedia", |ctx, request| {
            use tauri::http::Response;
            use tauri::Manager;
            let streams = ctx.app_handle().state::<commands::MediaStreams>();
            let range = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok());
            let (status, headers, body) =
                commands::media_response(&streams, request.uri().path(), range);
            let mut builder = Response::builder().status(status);
            for (k, v) in headers {
                builder = builder.header(k, v);
            }
            builder.body(body).unwrap()
        })
        // THE SANDBOX: serve staged HTML pages from an isolated origin so their
        // own JS/CSS runs (like a real browser) while a strict per-response CSP
        // blocks every network request — the page can't phone home or reach the
        // app/room. The frontend loads roomdoc://localhost/<token>.
        .register_uri_scheme_protocol("roomdoc", |ctx, request| {
            use tauri::http::Response;
            use tauri::Manager;
            const CSP: &str = "default-src 'none'; \
                script-src 'unsafe-inline' 'unsafe-eval'; \
                style-src 'unsafe-inline'; img-src data: blob:; \
                media-src data: blob:; font-src data:; connect-src 'none'; \
                form-action 'none'; base-uri 'none'; frame-src 'none'";
            let token = request.uri().path().trim_start_matches('/').to_string();
            let html = ctx
                .app_handle()
                .state::<commands::HtmlPreviews>()
                .map
                .lock()
                .unwrap()
                .get(&token)
                .cloned();
            match html {
                Some(body) => Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .header("Content-Security-Policy", CSP)
                    .body(body.into_bytes())
                    .unwrap(),
                None => Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .body(b"preview not found".to_vec())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_room,
            commands::open_room,
            commands::write_recovery_key,
            commands::has_recovery_key,
            commands::open_room_with_recovery,
            commands::touchid_has,
            commands::touchid_enable,
            commands::touchid_disable,
            commands::touchid_open,
            commands::close_room,
            commands::room_info,
            commands::rename_room,
            commands::take_rec_recovery_error,
            commands::take_pending_open,
            commands::import_files,
            commands::list_files,
            commands::get_file_content,
            commands::decode_file_text,
            commands::audio_peaks,
            commands::probe_video_meta,
            commands::video_trim,
            commands::save_video_frame,
            commands::quicklook_preview,
            commands::slide_preview,
            commands::office_html,
            commands::update_file_content,
            commands::update_docx_text,
            commands::set_cell,
            commands::trash_file,
            commands::list_trashed_files,
            commands::restore_file,
            commands::delete_file_permanently,
            commands::empty_trash,
            // The batch twins of the four above (commands::bulk) — the Library's
            // multi-selection. Each hands back a BulkReport rather than (), so a
            // partial failure can be named instead of inferred.
            commands::trash_files,
            commands::move_files_to_folder,
            commands::restore_files,
            commands::delete_files_permanently,
            // Podcast voices: read a script's cast, re-cast it, preview one
            // host, and record the whole episode as a background job.
            commands::get_podcast,
            commands::set_podcast_cast,
            commands::preview_podcast_voice,
            commands::start_podcast_audio_job,
            commands::save_generated_file,
            commands::open_scratch_pad,
            commands::import_link,
            commands::list_file_versions,
            commands::file_versions_kept,
            commands::pin_file_version,
            commands::delete_file_version,
            commands::get_file_provenance,
            commands::restore_file_version,
            commands::get_file_version,
            commands::export_file,
            commands::export_all,
            commands::change_password,
            commands::duplicate_room,
            commands::compact_room,
            commands::create_room_checkpoint,
            commands::list_room_checkpoints,
            commands::delete_room_checkpoint,
            commands::rollback_room_checkpoint,
            commands::list_stranded_checkpoints,
            commands::list_recent,
            commands::remove_recent,
            commands::clear_recent,
            commands::add_memory,
            commands::list_memories,
            commands::update_memory,
            commands::delete_memory,
            commands::restore_memory,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::rename_file,
            commands::move_file_to_folder,
            commands::search_all,
            commands::get_setting,
            commands::set_setting,
            commands::privacy_status,
            commands::set_privacy_room,
            commands::set_privacy_global,
            commands::add_privacy_block,
            commands::remove_privacy_entity,
            commands::set_privacy_concepts,
            commands::privacy_preview,
            commands::start_privacy_scan,
            commands::web_search_test,
            commands::mcp_get_config,
            commands::mcp_apply_config,
            commands::mcp_status,
            commands::approve_mcp,
            commands::resolve_mcp_call,
            // Download-on-first-use runtimes (uv / node) for local connectors.
            commands::mcp_runtime_for_command,
            commands::mcp_provision_runtime,
            commands::mcp_registry_search,
            commands::mcp_registry_optin_status,
            commands::set_mcp_registry_optin,
            commands::mcp_oauth_authorize,
            commands::mcp_oauth_status,
            commands::mcp_oauth_sign_out,
            commands::mcp_set_server_enabled,
            commands::mcp_remove_server,
            commands::mcp_get_tool_prefs,
            commands::mcp_set_tool_enabled,
            commands::get_mcp_auto_approve,
            commands::set_mcp_auto_approve,
            commands::get_mcp_outbound_unmask,
            commands::set_mcp_outbound_unmask,
            commands::get_mcp_connector_powers,
            commands::set_mcp_connector_power,
            commands::resolve_edit_approval,
            commands::ai_status,
            commands::model_capabilities,
            commands::engine_capabilities,
            commands::engine_preflight,
            commands::engine_support_matrix,
            commands::grounding_model_for_room,
            commands::list_engine_models,
            commands::list_ai_providers,
            commands::connect_ai_provider,
            commands::disconnect_ai_provider,
            commands::open_ollama,
            commands::warm_model,
            commands::pull_model,
            commands::delete_model,
            commands::list_chats,
            commands::create_chat,
            commands::delete_chat,
            commands::rename_chat,
            commands::delete_message,
            commands::get_messages,
            commands::import_image_bytes,
            commands::import_audio_bytes,
            commands::ask,
            commands::cancel_ask,
            commands::list_specialists,
            commands::handoff_chat,
            commands::run_command,
            commands::list_chat_commands,
            commands::locate_in_image,
            commands::stt_status,
            commands::stt_download_model,
            commands::stt_cancel_download,
            commands::stt_delete_model,
            commands::transcribe_audio,
            commands::retranscribe_file,
            commands::shape_text,
            commands::dict_start,
            commands::dict_push_audio,
            commands::dict_stop,
            commands::dict_cancel,
            // Moonshot (Section D)
            commands::recommended_models,
            commands::ensure_embed_model,
            commands::room_graph,
            commands::front_page,
            commands::front_page_suggestions,
            commands::studio_prompts,
            commands::ai_action_prompts,
            commands::ai_action,
            commands::open_html_in_browser,
            commands::stage_preview_html,
            commands::studio_flashcards,
            commands::studio_mindmap,
            commands::generate_podcast_script,
            commands::memory_suggestion,
            commands::suggest_file_meta,
            commands::generate_ui_text,
            commands::room_server_status,
            commands::set_room_server,
            commands::regenerate_leash_token,
            commands::set_ollama_url,
            commands::test_ollama_url,
            commands::get_ollama_url,
            commands::list_roles,
            // ADD-23..26: plain-text effects + media streaming + agent UI
            // bridge + YouTube video import.
            commands::resolve_agent_ui,
            commands::import_youtube_video,
            commands::import_media_url,
            commands::cancel_media_download,
            commands::start_download_job,
            // ADD-27: live Recording file (streaming transcription, editing,
            // translate). ADD-28: feedback → GitHub issue.
            commands::rec_start,
            commands::rec_push_audio,
            commands::rec_pause,
            commands::rec_resume,
            commands::rec_stop,
            commands::rec_live_status,
            commands::rec_set_live_translate,
            commands::rec_set_live_stt,
            commands::rec_get,
            commands::rec_delete_range,
            commands::rec_correct_range,
            commands::rec_set_speaker_name,
            commands::rec_read_start,
            commands::rec_note_add,
            commands::rec_note_set,
            commands::rec_chapter_add,
            commands::rec_chapter_set,
            commands::rec_highlight_add,
            commands::rec_item_delete,
            commands::voices_list,
            commands::voice_forget,
            commands::rec_export_clean,
            commands::rec_translate,
            commands::rec_retranscribe,
            commands::app_diag,
            commands::feedback_draft,
            // ADD-30: durable background job runner.
            commands::list_jobs,
            commands::cancel_job,
            commands::delete_job,
            commands::resume_job,
            commands::start_deep_summary,
            commands::start_studio_job,
            // ADD-32: whole-file pass — exhaustive windowed reading of one file.
            commands::start_file_pass,
            // Wave 4a (Idea 2): LLM graph workflows + scheduler + shortcuts.
            commands::save_workflow,
            commands::update_workflow,
            commands::delete_workflow,
            commands::list_workflows,
            commands::get_workflow,
            commands::get_workflow_schedule,
            commands::workflow_templates,
            commands::run_workflow,
            commands::set_workflow_schedule,
            commands::set_workflow_status,
            commands::set_workflow_pinned,
            commands::validate_workflow,
            commands::compose_workflow,
            commands::get_workflow_runs,
            commands::get_job_step_artifact,
            // Wave 5 (Idea 13): runnable & schedulable scripts.
            commands::list_scripts,
            commands::get_script_manifest,
            commands::run_script,
            commands::set_script_schedule,
            commands::resolve_script_run,
            // Portable Agent Skills — encrypted folder trees, separate from files.
            commands::list_skills,
            commands::get_skill,
            commands::create_skill,
            commands::update_skill,
            commands::set_skill_enabled,
            commands::delete_skill,
            commands::get_skill_resource,
            commands::save_skill_resource,
            commands::delete_skill_resource,
            commands::import_skill_folder,
            commands::skill_import_conflict,
            commands::skill_agent_ids,
            commands::export_skill_folder,
            commands::compose_skill,
            // Idea 3: supernatural voice — neural synthesis via the sidecar.
            commands::speak_text_neural,
            commands::list_neural_voices,
            // BROWSE-1: the private browser area.
            commands::browser_navigate,
            commands::browser_close,
            commands::browser_new_tab,
            commands::browser_select_tab,
            commands::browser_close_tab,
            commands::browser_tabs,
            commands::browser_set_bounds,
            commands::browser_info,
            commands::browser_go,
            commands::browser_set_takeover,
            commands::browser_journal,
            commands::browser_clear_journal,
            commands::browser_verify_private,
            commands::browser_save_page,
            // Item #18: the reading view, and the keyboard's way back out.
            commands::browser_page_text,
            commands::browser_focus_app,
            // BROWSE-3: the address bar's search half.
            commands::browser_search,
            commands::browser_preview,
            commands::browser_peek,
            commands::browser_search_summary,
            commands::import_search_result,
            // Owner replacement #1: point the user at the log folder.
            obs::reveal_logs,
            commands::set_unsaved_edits,
        ])
        // Where the window was, and how big. Noted from the event rather than
        // written per event: dragging emits hundreds, and the file is written
        // once on the way out (see RunEvent::Exit).
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) && window.label() == MAIN_WINDOW
            {
                commands::note_geometry(window);
            }
        })
        .setup(|app| {
            // …and put it back, unless the screen it was on has gone away —
            // restoring onto an unplugged monitor opens the window where it
            // cannot be seen, dragged or closed.
            commands::restore_geometry(app.handle());
            // Wave 5 (Idea 13): sweep orphaned script-run workspaces left by a
            // crash before anything runs (the quiesce_stale_jobs spirit).
            commands::sweep_script_workspaces(app.handle());
            // Publish the downloaded-runtime PATH prefix for the connector
            // launcher, which has no AppHandle to work it out for itself. Do it
            // BEFORE any connector can start, or a runtime downloaded in an
            // earlier session is on no PATH this session's children see.
            commands::refresh_path_prefix(app.handle());
            // Connectors: hydrate the two independent connector powers from
            // their per-Mac files so each choice survives a restart. Both
            // default OFF — a missing file is a NO, never an assumed yes.
            {
                let state = app.state::<AppState>();
                state.mcp_auto_approve.store(
                    commands::read_mcp_auto_approve(app.handle()),
                    std::sync::atomic::Ordering::SeqCst,
                );
                state.mcp_outbound_unmask.store(
                    commands::read_mcp_outbound_unmask(app.handle()),
                    std::sync::atomic::Ordering::SeqCst,
                );
                // …and the per-connector answers that override them. Absent
                // file = empty map = every connector follows the two switches,
                // which is exactly what an install upgrading from the
                // global-only pair should do: it keeps what it had and gains
                // nothing.
                *state.mcp_connector_powers.lock().unwrap() =
                    commands::read_mcp_connector_powers(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // ⌘Q is the one exit that raises no window CLOSE request, so the
            // window's own unsaved-edits guard (Workspace.tsx) never sees it and
            // an open Monaco buffer used to go out with the process. This is the
            // only hook that does see it. Held ONCE — `hold_quit_for_unsaved`
            // latches — so a window that cannot answer still quits on the second
            // press, and the window finishes the quit itself with `exit()`
            // (which carries a code, and is therefore never re-held).
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &_event {
                if commands::hold_quit_for_unsaved(*code) {
                    api.prevent_exit();
                    if let Some(window) = main_window(_app) {
                        let _ = window.emit("quit-requested", ());
                    }
                }
            }
            // ADD-29: never leak a background `ollama serve` WE started — stop it
            // (and only it) as the app exits. A no-op for an external daemon.
            if let tauri::RunEvent::Exit = _event {
                // Where the window ended up. Best-effort and first: it must
                // never be able to fail a quit, and it must not depend on the
                // window still existing by the time teardown gets here.
                commands::save_geometry(_app);
                // Metal wave: the warm Whisper context must drop BEFORE ggml's
                // atexit teardown, or its resident GPU buffers turn Quit into
                // a ggml_metal_device_free assert (a crash report).
                stt::unload_ctx();
                ollama_lifecycle::stop_if_ours();
                // ADD-33: never leak the Python agent sidecar we spawned.
                sidecar_lifecycle::stop_if_ours();
                // Decrypted "Open in browser" previews must not outlive the app.
                commands::cleanup_browser_previews();
                // BROWSE-1: Cmd-Q skips teardown_open_room, so the private
                // browser is closed here too. Its store is non-persistent, so
                // this is what actually discards the session's cookies/cache.
                let _ = browser::close(_app);
                // Wave 1a: Cmd-Q skips teardown_open_room, so drop the Leash
                // discovery file here too — it must exist exactly while the
                // Leash runs, never advertising a dead endpoint.
                commands::remove_discovery(_app);
            }
            // Finder double-click on a .roomai file lands here on macOS.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let path = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .next();
                if let Some(path) = path {
                    let state = _app.state::<AppState>();
                    *state.pending_open.lock().unwrap() = Some(path.clone());
                    if let Some(window) = main_window(_app) {
                        let _ = window.emit("open-room-file", path);
                    }
                }
            }
        });
}
