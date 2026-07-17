use super::*;

pub fn is_external_engine(model: &str) -> bool {
    model == "claude-cli" || model == "codex-cli"
}

/// An Ollama `:cloud` model (e.g. `minimax-m3:cloud`) runs remotely. Unlike
/// local models it does NOT reliably emit tool calls in Ollama's structured
/// `tool_calls` field — it leaks them inline as text (`<tool_call>…`), which the
/// stream parser never sees, so the call silently never runs. It also ignores
/// the `format` grammar constraint (see recover_json). Such models are unfit for
/// the tool-driving agent loop and for on-device structured side-calls.
pub fn is_cloud_model(model: &str) -> bool {
    model.ends_with(":cloud")
}

/// Find cloud coding CLIs on this Mac. GUI apps launched from Finder/Dock get a
/// bare launchd PATH, so ask an INTERACTIVE login shell (`-ilc`) for the user's
/// real environment. Interactive matters: installers for these CLIs (and tools
/// like uv/rustup) commonly add their bin dir — e.g. `~/.local/bin` — only in
/// `.zshrc`, which a non-interactive `-lc` shell never sources, so `-lc` finds
/// nothing and the engine silently never appears.
pub(crate) fn detect_external_blocking() -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(out) = std::process::Command::new("zsh")
        .args(["-ilc", "command -v claude; command -v codex"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            if line.ends_with("/claude") || line == "claude" {
                found.push("claude-cli".to_string());
            }
            if line.ends_with("/codex") || line == "codex" {
                found.push("codex-cli".to_string());
            }
        }
    }
    found
}

/// ADD-10: is Ollama installed on this Mac at all? Distinct from "running".
/// Matches the interactive-login-shell PATH trick used for the cloud CLIs.
pub(crate) fn ollama_installed_blocking() -> bool {
    if std::path::Path::new("/Applications/Ollama.app").exists() {
        return true;
    }
    std::process::Command::new("zsh")
        .args(["-ilc", "command -v ollama"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Run one prompt through a cloud CLI (Claude Code / Codex). The content
/// leaves the machine via the user's own account — surfaced in the UI.
///
/// These CLIs are agents with file access, so attached images are written to
/// a private temp folder for the CLI to open itself, then deleted.
///
/// `cancel` (ADD-7): a watcher thread kills the child process if the user
/// presses Stop, so a runaway cloud answer ends promptly.
pub(crate) async fn run_external(
    engine: &str,
    messages: &[ollama::ChatMessage],
    cancel: Option<Arc<AtomicBool>>,
    // ADD-20: when present, the CLI is given the room's tools over a scoped
    // localhost MCP bridge (claude-cli only for now).
    bridge: Option<&crate::room_mcp::Bridge>,
) -> Result<String, String> {
    use std::io::Write;

    let tmp_dir =
        std::env::temp_dir().join(format!("private-room-cli-{}", Uuid::new_v4()));
    let mut image_paths: Vec<String> = Vec::new();
    for m in messages {
        if let Some(images) = &m.images {
            for b64 in images.iter().take(3) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                    if image_paths.is_empty() {
                        std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
                    }
                    let path = tmp_dir.join(format!("attachment-{}.png", image_paths.len() + 1));
                    if std::fs::write(&path, bytes).is_ok() {
                        image_paths.push(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    let mut prompt = String::new();
    for m in messages {
        match m.role.as_str() {
            "system" => prompt.push_str(&format!("Instructions:\n{}\n\n", m.content)),
            "user" => prompt.push_str(&format!("User: {}\n\n", m.content)),
            "assistant" => prompt.push_str(&format!("Assistant: {}\n\n", m.content)),
            _ => {}
        }
    }
    if !image_paths.is_empty() {
        prompt.push_str(&format!(
            "The user attached {} image(s), saved for you at:\n{}\nOpen and view them before answering.\n\n",
            image_paths.len(),
            image_paths.join("\n")
        ));
    }
    if bridge.is_some() {
        prompt.push_str(
            "You are connected to the user's Private Room through MCP tools \
             (mcp__room__*). Use them to list, search, open, edit, create, or \
             annotate the room's files whenever the question involves files — \
             do not guess file contents from memory.\n\n",
        );
    }
    prompt.push_str("Respond to the last user message. Reply with the answer only.");

    // ADD-20: hand the bridge to claude via --mcp-config. The config JSON is
    // written next to the (temp) work dir and removed with it.
    let mut mcp_config_path: Option<std::path::PathBuf> = None;
    if let Some(b) = bridge {
        if engine == "claude-cli" {
            std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
            let p = tmp_dir.join("mcp-room.json");
            std::fs::write(&p, b.mcp_config_json()).map_err(|e| e.to_string())?;
            mcp_config_path = Some(p);
        }
    }
    let cmdline = match (engine, &mcp_config_path) {
        ("claude-cli", Some(p)) => format!(
            "claude -p --mcp-config '{}' --strict-mcp-config --allowedTools 'mcp__room__*'",
            p.to_string_lossy()
        ),
        ("claude-cli", None) => "claude -p".to_string(),
        ("codex-cli", _) => "codex exec -".to_string(),
        _ => return Err("Unknown engine".into()),
    };
    let engine_name = engine.to_string();
    let work_dir = if image_paths.is_empty() {
        std::env::temp_dir()
    } else {
        tmp_dir.clone()
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Interactive login shell (`-ilc`), same as detection: from a GUI launch
        // the CLI is only on PATH via `.zshrc`, and the CLI also needs the user's
        // full env to reach its own subtools (git, node, …).
        let mut child = std::process::Command::new("zsh")
            .args(["-ilc", cmdline.as_str()])
            .current_dir(&work_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start {engine_name}: {e}"))?;
        let pid = child.id();
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(prompt.as_bytes())
            .map_err(|e| e.to_string())?;
        // ADD-7: watcher kills the child on Stop. `wait_with_output` keeps
        // draining stdout on this thread, so the pipe never deadlocks.
        let done = Arc::new(AtomicBool::new(false));
        let done_w = done.clone();
        let watcher = std::thread::spawn(move || loop {
            if done_w.load(Ordering::SeqCst) {
                break;
            }
            match &cancel {
                Some(flag) if flag.load(Ordering::SeqCst) => {
                    let _ = std::process::Command::new("kill")
                        .arg(pid.to_string())
                        .status();
                    break;
                }
                Some(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
                None => break,
            }
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        done.store(true, Ordering::SeqCst);
        let _ = watcher.join();
        if !out.status.success() {
            let err: String = String::from_utf8_lossy(&out.stderr).chars().take(400).collect();
            return Err(format!("{engine_name} failed: {err}"));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    // Decrypted content must not linger on disk.
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

