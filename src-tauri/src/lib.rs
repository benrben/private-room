mod biometrics;
mod commands;
pub mod db;
pub mod extraction;
pub mod mcp;
mod ocr;
mod ollama;
mod ollama_lifecycle;
pub mod recording;
mod room_mcp;
mod sidecar;
mod sidecar_lifecycle;
pub(crate) mod snapshot;
pub mod speech;
pub mod stt;
pub mod web;

use commands::AppState;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .manage(commands::AgentUi::default())
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
            commands::take_pending_open,
            commands::import_files,
            commands::list_files,
            commands::get_file_content,
            commands::update_file_content,
            commands::set_cell,
            commands::delete_file,
            commands::save_generated_file,
            commands::open_scratch_pad,
            commands::import_link,
            commands::list_file_versions,
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
            commands::list_recent,
            commands::remove_recent,
            commands::clear_recent,
            commands::add_memory,
            commands::list_memories,
            commands::update_memory,
            commands::delete_memory,
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
            commands::mcp_get_uncapped,
            commands::mcp_set_server_uncapped,
            commands::resolve_edit_approval,
            commands::ai_status,
            commands::model_capabilities,
            commands::list_engine_models,
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
            commands::run_command,
            commands::list_chat_commands,
            commands::locate_in_image,
            commands::stt_status,
            commands::stt_download_model,
            commands::stt_delete_model,
            commands::transcribe_audio,
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
            commands::room_server_status,
            commands::set_room_server,
            commands::regenerate_leash_token,
            commands::set_ollama_url,
            commands::get_ollama_url,
            commands::list_roles,
            // ADD-23..26: plain-text effects + media streaming + agent UI
            // bridge + YouTube video import.
            commands::resolve_agent_ui,
            commands::import_youtube_video,
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
            // Idea 3: supernatural voice — on-device speech synthesis.
            commands::speak_text,
            commands::speak_text_neural,
            commands::list_speech_voices,
        ])
        .setup(|app| {
            // Wave 5 (Idea 13): sweep orphaned script-run workspaces left by a
            // crash before anything runs (the quiesce_stale_jobs spirit).
            commands::sweep_script_workspaces(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // ADD-29: never leak a background `ollama serve` WE started — stop it
            // (and only it) as the app exits. A no-op for an external daemon.
            if let tauri::RunEvent::Exit = _event {
                // Metal wave: the warm Whisper context must drop BEFORE ggml's
                // atexit teardown, or its resident GPU buffers turn Quit into
                // a ggml_metal_device_free assert (a crash report).
                stt::unload_ctx();
                ollama_lifecycle::stop_if_ours();
                // ADD-33: never leak the Python agent sidecar we spawned.
                sidecar_lifecycle::stop_if_ours();
                // Decrypted "Open in browser" previews must not outlive the app.
                commands::cleanup_browser_previews();
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
                    if let Some(window) = _app.get_webview_window("main") {
                        let _ = window.emit("open-room-file", path);
                    }
                }
            }
        });
}
