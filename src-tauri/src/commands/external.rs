use super::*;

/// A picked cloud engine selection, most-specific-last:
///   `"codex-cli"`                     bare — the CLI's own default model+effort
///   `"codex-cli::gpt-5.6-sol"`        a specific model, CLI-default effort
///   `"codex-cli::gpt-5.6-sol::high"`  a specific model AND reasoning effort
/// Splits into `(engine_id, Some(model), Some(effort))` with trailing parts
/// `None` when absent. A plain local Ollama model name (no "::" / not a known
/// engine id) passes through unchanged as `(model, None, None)`.
pub fn split_external_model(model: &str) -> (&str, Option<&str>, Option<&str>) {
    let mut parts = model.splitn(3, "::");
    let engine = parts.next().unwrap_or(model);
    if engine != "claude-cli" && engine != "codex-cli" {
        return (model, None, None);
    }
    (engine, parts.next(), parts.next())
}

pub fn is_external_engine(model: &str) -> bool {
    let base = split_external_model(model).0;
    base == "claude-cli" || base == "codex-cli"
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExternalModelInfo {
    pub slug: String,
    pub label: String,
    /// Reasoning-effort levels this model accepts (low..ultra), or empty if the
    /// engine has no effort knob. The picker shows these as inline chips.
    pub efforts: Vec<String>,
    /// The model's own default effort, if the engine reports one (Codex does;
    /// Claude Code's flag has no per-model default we can read).
    pub default_effort: Option<String>,
}

/// Claude Code's `--effort` flag accepts this fixed set (from `claude --help`),
/// the same for every Claude model — like the model aliases, it's the CLI's own
/// documented values, not a catalog we invented.
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Codex ships a real, live model catalog — no hardcoding needed. `codex debug
/// models` (read-only, no git-repo-trust requirement, confirmed to work from
/// any directory) prints the CLI's full catalog as JSON; `visibility=="list"`
/// is exactly the set Codex itself considers user-facing (excludes internal
/// entries like `codex-auto-review`).
async fn list_codex_models() -> Result<Vec<ExternalModelInfo>, String> {
    let out = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("zsh")
            .args(["-ilc", "codex debug models"])
            .output()
            .map_err(|e| format!("Could not run codex: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    if !out.status.success() {
        let err: String = String::from_utf8_lossy(&out.stderr).chars().take(400).collect();
        return Err(format!("codex debug models failed: {err}"));
    }
    parse_codex_catalog(&out.stdout)
}

/// Pure JSON→list mapping, split out from `list_codex_models` so it's testable
/// without a live `codex` subprocess.
fn parse_codex_catalog(json: &[u8]) -> Result<Vec<ExternalModelInfo>, String> {
    let parsed: serde_json::Value =
        serde_json::from_slice(json).map_err(|e| format!("bad JSON from codex: {e}"))?;
    let models = parsed
        .get("models")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(models
        .into_iter()
        .filter(|m| m.get("visibility").and_then(|v| v.as_str()) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug")?.as_str()?.to_string();
            let label = m
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(&slug)
                .to_string();
            // Each model carries its own supported reasoning levels + default.
            let efforts = m
                .get("supported_reasoning_levels")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|l| l.get("effort").and_then(|e| e.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let default_effort = m
                .get("default_reasoning_level")
                .and_then(|v| v.as_str())
                .map(String::from);
            Some(ExternalModelInfo { slug, label, efforts, default_effort })
        })
        .collect())
}

/// Claude Code's CLI has no equivalent listing command (checked --help,
/// config, doctor, and the invalid-model error message — confirmed none
/// enumerate). These are the CLI's own documented, self-updating `--model`
/// ALIASES (see `claude --help`), not dated model ids, so they track whichever
/// model Anthropic currently maps each tier to — only the display label below
/// is maintained text, the smallest hardcoding surface available given the CLI
/// exposes nothing enumerable.
fn claude_known_models() -> Vec<ExternalModelInfo> {
    let efforts: Vec<String> = CLAUDE_EFFORTS.iter().map(|s| s.to_string()).collect();
    let mk = |slug: &str, label: &str| ExternalModelInfo {
        slug: slug.into(),
        label: label.into(),
        efforts: efforts.clone(),
        default_effort: None,
    };
    vec![
        mk("opus", "Opus 4.8"),
        mk("sonnet", "Sonnet 5"),
        mk("haiku", "Haiku 4.5"),
        mk("fable", "Fable 5"),
    ]
}

/// List the models available for a detected cloud engine, for the Cloud
/// picker's second level. `engine` is the bare id ("claude-cli"/"codex-cli").
#[tauri::command]
pub async fn list_engine_models(engine: String) -> Result<Vec<ExternalModelInfo>, String> {
    match engine.as_str() {
        "codex-cli" => list_codex_models().await,
        "claude-cli" => Ok(claude_known_models()),
        other => Err(format!("Unknown engine: {other}")),
    }
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

    // The caller passes either a bare engine id ("claude-cli"/"codex-cli") or
    // a composite one carrying the specific model and/or reasoning effort the
    // Cloud picker chose ("codex-cli::gpt-5.6-sol::high").
    let (engine, submodel, effort) = split_external_model(engine);

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
            "You are connected to the user's Private Room through the MCP \
             server named \"room\". Use its tools to list, search, open, edit, \
             create, or annotate the room's files whenever the question \
             involves files — do not guess file contents from memory.\n\n",
        );
    }
    prompt.push_str("Respond to the last user message. Reply with the answer only.");

    // ADD-20 / engine parity: hand the bridge to BOTH CLIs. Claude takes a
    // JSON `--mcp-config` file (written next to the temp work dir, removed
    // with it); Codex takes per-invocation `-c mcp_servers.room.*` TOML
    // overrides with the bearer token passed through a child-process env var
    // (verified against codex-cli 0.144.5: `codex mcp add --url/--bearer-
    // token-env-var` documents exactly these config fields).
    let mut mcp_config_path: Option<std::path::PathBuf> = None;
    let mut codex_bridge_env: Option<String> = None;
    let mut codex_mcp_flags = String::new();
    if let Some(b) = bridge {
        match engine {
            "claude-cli" => {
                std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
                let p = tmp_dir.join("mcp-room.json");
                std::fs::write(&p, b.mcp_config_json()).map_err(|e| e.to_string())?;
                mcp_config_path = Some(p);
            }
            "codex-cli" => {
                codex_mcp_flags = format!(
                    " -c 'mcp_servers.room.url=\"{}\"' -c 'mcp_servers.room.bearer_token_env_var=\"PR_ROOM_MCP_TOKEN\"'",
                    b.mcp_url()
                );
                codex_bridge_env = Some(b.token.clone());
            }
            _ => {}
        }
    }
    // Single-quoted, matching the mcp_config_path quoting just above — safe
    // here because submodel/effort are always our own known slugs (a Codex
    // catalog slug + level, or a Claude Code alias + --effort value), never
    // arbitrary user text. Effort is only meaningful with a chosen model.
    let model_flag = submodel
        .map(|m| format!(" --model '{m}'"))
        .unwrap_or_default();
    // Claude takes `--effort <level>`; Codex takes `-c model_reasoning_effort=<level>`.
    let effort_flag = match (engine, effort) {
        ("claude-cli", Some(e)) => format!(" --effort '{e}'"),
        ("codex-cli", Some(e)) => format!(" -c 'model_reasoning_effort={e}'"),
        _ => String::new(),
    };
    let cmdline = match (engine, &mcp_config_path) {
        ("claude-cli", Some(p)) => format!(
            "claude -p --mcp-config '{}' --strict-mcp-config --allowedTools 'mcp__room__*'{model_flag}{effort_flag}",
            p.to_string_lossy()
        ),
        ("claude-cli", None) => format!("claude -p{model_flag}{effort_flag}"),
        ("codex-cli", _) => format!(
            "codex exec --skip-git-repo-check{codex_mcp_flags}{model_flag}{effort_flag} -"
        ),
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
        let mut command = std::process::Command::new("zsh");
        command
            .args(["-ilc", cmdline.as_str()])
            .current_dir(&work_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // The bridge token rides an env var (never argv, which `ps` can read).
        if let Some(token) = &codex_bridge_env {
            command.env("PR_ROOM_MCP_TOKEN", token);
        }
        let mut child = command
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_external_model_handles_bare_model_and_effort() {
        assert_eq!(split_external_model("codex-cli"), ("codex-cli", None, None));
        assert_eq!(split_external_model("claude-cli"), ("claude-cli", None, None));
        assert_eq!(
            split_external_model("codex-cli::gpt-5.6-sol"),
            ("codex-cli", Some("gpt-5.6-sol"), None)
        );
        assert_eq!(
            split_external_model("codex-cli::gpt-5.6-sol::high"),
            ("codex-cli", Some("gpt-5.6-sol"), Some("high"))
        );
        assert_eq!(
            split_external_model("claude-cli::opus::xhigh"),
            ("claude-cli", Some("opus"), Some("xhigh"))
        );
        // A local Ollama model name is never split, even though it contains a
        // ":" (not "::") — the engine-id guard is what matters.
        assert_eq!(split_external_model("qwen3.5:4b"), ("qwen3.5:4b", None, None));
    }

    #[test]
    fn is_external_engine_recognizes_composite_forms() {
        assert!(is_external_engine("codex-cli"));
        assert!(is_external_engine("codex-cli::gpt-5.6-sol"));
        assert!(is_external_engine("codex-cli::gpt-5.6-sol::max"));
        assert!(is_external_engine("claude-cli::opus::high"));
        assert!(!is_external_engine("qwen3.5:4b"));
        assert!(!is_external_engine("minimax-m3:cloud"));
    }

    #[test]
    fn parse_codex_catalog_filters_to_listed_models_and_reads_efforts() {
        let json = br#"{"models":[
            {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","visibility":"list",
             "default_reasoning_level":"low",
             "supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"max"}]},
            {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list"},
            {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide"}
        ]}"#;
        let models = parse_codex_catalog(json).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "gpt-5.6-sol");
        assert_eq!(models[0].label, "GPT-5.6-Sol");
        assert_eq!(models[0].efforts, vec!["low", "high", "max"]);
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));
        // A model with no reasoning fields comes back with empty efforts.
        assert!(models[1].efforts.is_empty());
        assert!(models[1].default_effort.is_none());
        assert!(models.iter().all(|m| m.slug != "codex-auto-review"));
    }

    #[test]
    fn parse_codex_catalog_falls_back_to_slug_when_display_name_missing() {
        let json = br#"{"models":[{"slug":"gpt-5.4-mini","visibility":"list"}]}"#;
        let models = parse_codex_catalog(json).unwrap();
        assert_eq!(models[0].label, "gpt-5.4-mini");
    }

    #[test]
    fn claude_known_models_are_cli_documented_aliases_with_fixed_efforts() {
        let models = claude_known_models();
        let slugs: Vec<&str> = models.iter().map(|m| m.slug.as_str()).collect();
        assert_eq!(slugs, vec!["opus", "sonnet", "haiku", "fable"]);
        // Every Claude model offers the CLI's fixed --effort set.
        assert_eq!(models[0].efforts, vec!["low", "medium", "high", "xhigh", "max"]);
    }
}
