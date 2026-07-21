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
    if engine != "claude-cli" && engine != "codex-cli" && engine != "openrouter" {
        return (model, None, None);
    }
    (engine, parts.next(), parts.next())
}

pub fn is_external_engine(model: &str) -> bool {
    let base = split_external_model(model).0;
    base == "claude-cli" || base == "codex-cli" || base == "openrouter"
}

/// CLI-backed engines are executed directly by Rust. API-backed providers are
/// external/non-local too, but run through the provider-aware Python sidecar.
pub fn is_cli_engine(model: &str) -> bool {
    matches!(split_external_model(model).0, "claude-cli" | "codex-cli")
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
    /// Codex only (`context_window` in `codex debug models`'s catalog JSON,
    /// confirmed present live 2026-07-21) — the real per-slug context window,
    /// for a future model-picker display. Claude Code has no catalog to read
    /// this from; the token-budget bar's own max-context sizing does NOT read
    /// this field (see `model_limits.rs` for why: re-fetching the catalog on
    /// every chat turn just for this number isn't worth the subprocess cost).
    pub context_window: Option<u32>,
    pub description: Option<String>,
    pub input_price: Option<String>,
    pub output_price: Option<String>,
    pub input_modalities: Vec<String>,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub structured_outputs: bool,
}

/// Claude Code's `--effort` flag accepts this fixed set (from `claude --help`),
/// the same for every Claude model — like the model aliases, it's the CLI's own
/// documented values, not a catalog we invented.
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Arcelle owns the workspace and tool boundary for an embedded Codex turn.
/// Keep the one-shot CLI ephemeral and read-only, ignore unrelated personal
/// plugins/MCP servers, and disable Codex's own web/shell tools so room access
/// can happen only through the scoped `room` bridge below. Standard MCP safety
/// annotations let Arcelle's non-destructive tools run with approvals disabled.
const CODEX_ARCELLE_FLAGS: &str = " --ignore-user-config --ephemeral --skip-git-repo-check \
    --sandbox read-only -c 'approval_policy=\"never\"' --disable shell_tool \
    --disable unified_exec -c 'web_search=\"disabled\"'";

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
        let err: String = String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(400)
            .collect();
        return Err(format!("codex debug models failed: {err}"));
    }
    parse_codex_catalog(&out.stdout)
}

/// Cached for the process lifetime — the catalog rarely changes, and
/// re-spawning `codex debug models` on every chat turn just to read one
/// model's context window isn't worth the subprocess cost. Retries the fetch
/// (rather than caching a failure) if it hasn't succeeded yet.
static CODEX_CATALOG: tokio::sync::Mutex<Option<Vec<ExternalModelInfo>>> =
    tokio::sync::Mutex::const_new(None);

/// The real per-slug context window for a Codex model, read from the CLI's
/// own catalog — bare "codex-cli" (no explicit model chosen) has no slug to
/// look up, and a model missing from the catalog also falls through, both as
/// `None`: the caller falls back to `model_limits::CODEX_MAX_CONTEXT`.
/// Confirmed live 2026-07-21 that different Codex models have WILDLY
/// different real windows (e.g. one model's catalog entry reported
/// 1,050,000 vs another's 272,000) — a single hardcoded constant for every
/// Codex model materially misrepresents the token-budget bar.
pub(crate) async fn codex_context_window(submodel: Option<&str>) -> Option<u32> {
    let slug = submodel?;
    let mut guard = CODEX_CATALOG.lock().await;
    if guard.is_none() {
        if let Ok(models) = list_codex_models().await {
            *guard = Some(models);
        }
    }
    guard
        .as_ref()?
        .iter()
        .find(|m| m.slug == slug)
        .and_then(|m| m.context_window)
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
            let efforts: Vec<String> = m
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
            let context_window = m
                .get("context_window")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let reasoning = !efforts.is_empty();
            Some(ExternalModelInfo {
                slug,
                label,
                efforts,
                default_effort,
                context_window,
                description: None,
                input_price: None,
                output_price: None,
                input_modalities: vec!["text".into()],
                tools: true,
                vision: false,
                reasoning,
                structured_outputs: true,
            })
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
        context_window: None,
        description: None,
        input_price: None,
        output_price: None,
        input_modalities: vec!["text".into()],
        tools: true,
        vision: false,
        reasoning: true,
        structured_outputs: true,
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
        "openrouter" => super::list_provider_models("openrouter").await,
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
    // localhost MCP bridge.
    bridge: Option<&crate::room_mcp::Bridge>,
    // PRIV-1: "send real details this once" — skip the door for this one turn.
    privacy_bypass: bool,
) -> Result<(String, Option<ExternalUsage>), String> {
    use std::io::Write;

    // The caller passes either a bare engine id ("claude-cli"/"codex-cli") or
    // a composite one carrying the specific model and/or reasoning effort the
    // Cloud picker chose ("codex-cli::gpt-5.6-sol::high").
    let (engine, submodel, effort) = split_external_model(engine);

    // PRIV-1: the door, inside the leaf — EVERY caller of this function ships
    // content to a cloud CLI, so the policy engages here regardless of which
    // feature composed the messages. Protected strings become placeholders,
    // attached images stay on the Mac (pixels can't be redacted), and the
    // reply is restored below before anyone sees it.
    let policy = if privacy_bypass {
        None
    } else {
        crate::commands::active_policy()
    };
    let mut privacy_report = crate::commands::PrivacyReport::default();
    let guarded: Vec<ollama::ChatMessage>;
    let messages: &[ollama::ChatMessage] = match &policy {
        Some(p) => {
            guarded = messages
                .iter()
                .map(|m| {
                    let mut mm = m.clone();
                    mm.content = p.redactor.redact(&m.content, &mut privacy_report);
                    if let Some(images) = &mm.images {
                        privacy_report.images_blocked += images.len();
                        mm.images = None;
                    }
                    mm
                })
                .collect();
            &guarded
        }
        None => messages,
    };

    let tmp_dir = std::env::temp_dir().join(format!("arcelle-cli-{}", Uuid::new_v4()));
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
            "You are connected to the user's Arcelle through the MCP \
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
    // Token-budget bar: `--output-format json`/`--json` swap plain-text stdout
    // for a machine-readable envelope carrying real usage alongside the
    // answer — confirmed live 2026-07-21 (see parse_claude_json_result /
    // parse_codex_json_stream below), including with the MCP-bridge flags
    // active. Both parsers fall back to raw stdout as plain text if the
    // envelope doesn't parse, so a future CLI change can't turn a successful
    // answer into a hard failure — only into a plain-text, usage-less one.
    let cmdline = match (engine, &mcp_config_path) {
        ("claude-cli", Some(p)) => format!(
            "claude -p --output-format json --mcp-config '{}' --strict-mcp-config --allowedTools 'mcp__room__*'{model_flag}{effort_flag}",
            p.to_string_lossy()
        ),
        ("claude-cli", None) => format!("claude -p --output-format json{model_flag}{effort_flag}"),
        ("codex-cli", _) => format!(
            "codex exec --json{CODEX_ARCELLE_FLAGS}{codex_mcp_flags}{model_flag}{effort_flag} -"
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
            let err: String = String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(400)
                .collect();
            return Err(format!("{engine_name} failed: {err}"));
        }
        Ok(match engine_name.as_str() {
            "claude-cli" => {
                let (text, usage) = parse_claude_json_result(&out.stdout);
                (text, Some(usage))
            }
            "codex-cli" => {
                let (text, usage) = parse_codex_json_stream(&out.stdout);
                (text, Some(usage))
            }
            _ => (String::from_utf8_lossy(&out.stdout).trim().to_string(), None),
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    // Decrypted content must not linger on disk.
    let _ = std::fs::remove_dir_all(&tmp_dir);
    // PRIV-1: put the real values back into the reply — the cloud only ever
    // saw the placeholders; the user reads a normal answer. Usage numbers
    // carry no room content, so they ride through untouched.
    match (&policy, result) {
        (Some(p), Ok((text, usage))) => Ok((p.redactor.restore(&text), usage)),
        (_, r) => r,
    }
}

/// Real usage for one external-CLI turn, when the CLI's own JSON envelope
/// parsed. `input_tokens` is the round's real PROMPT/context token count
/// (Claude: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
/// all three count toward context; Codex: `input_tokens`, already inclusive
/// of any cached subset) — the same thing the char-based breakdown describes,
/// so the token-budget bar can scale its estimate to it.
#[derive(Debug, Clone, Default)]
pub(crate) struct ExternalUsage {
    pub(crate) input_tokens: Option<u64>,
    pub(crate) output_tokens: Option<u64>,
    /// Claude only: the real context window read live off `modelUsage` in the
    /// CLI's own response. `None` → caller falls back to
    /// `model_limits::external_max_context`.
    pub(crate) max_context_hint: Option<u32>,
}

/// `claude -p --output-format json`'s single JSON result object. Confirmed
/// live 2026-07-21: `{"result": "<answer>", "usage": {"input_tokens",
/// "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
/// ...}, "modelUsage": {"<model>": {"inputTokens", "outputTokens",
/// "cacheCreationInputTokens", "cacheReadInputTokens", "contextWindow", ...}}}`.
/// Falls back to treating the whole stdout as plain answer text (no usage) if
/// the envelope doesn't parse as expected — a future CLI change degrades this
/// to a plain-text, usage-less answer, never a hard failure.
fn parse_claude_json_result(stdout: &[u8]) -> (String, ExternalUsage) {
    let fallback_text = || String::from_utf8_lossy(stdout).trim().to_string();
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return (fallback_text(), ExternalUsage::default());
    };
    let text = v
        .get("result")
        .and_then(|r| r.as_str())
        .map(str::to_string)
        .unwrap_or_else(fallback_text);

    let u64_field = |obj: &serde_json::Value, k: &str| obj.get(k).and_then(|x| x.as_u64());
    let usage_obj = v.get("usage");
    let input_tokens = usage_obj.map(|u| {
        u64_field(u, "input_tokens").unwrap_or(0)
            + u64_field(u, "cache_creation_input_tokens").unwrap_or(0)
            + u64_field(u, "cache_read_input_tokens").unwrap_or(0)
    });
    let output_tokens = usage_obj.and_then(|u| u64_field(u, "output_tokens"));
    // Pick whichever model did the most work this turn — a turn can span more
    // than one model (haiku + sonnet observed in one call during a live smoke
    // test), and its context window is the one that actually matters.
    let max_context_hint = v.get("modelUsage").and_then(|m| m.as_object()).and_then(|obj| {
        obj.values()
            .filter_map(|entry| {
                let w = |k: &str| entry.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let weight = w("inputTokens")
                    + w("outputTokens")
                    + w("cacheCreationInputTokens")
                    + w("cacheReadInputTokens");
                entry
                    .get("contextWindow")
                    .and_then(|x| x.as_u64())
                    .map(|c| (weight, c as u32))
            })
            .max_by_key(|(weight, _)| *weight)
            .map(|(_, c)| c)
    });

    (
        text,
        ExternalUsage {
            input_tokens,
            output_tokens,
            max_context_hint,
        },
    )
}

/// `codex exec --json`'s JSONL event stream. Confirmed live 2026-07-21: the
/// answer rides an `{"type":"item.completed","item":{"type":"agent_message",
/// "text":"..."}}` event (last one wins), and usage rides a final
/// `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens",
/// "output_tokens","reasoning_output_tokens"}}` event. No context-window
/// field is reported here at all (see `model_limits.rs`). Falls back to the
/// raw stdout as plain text only if NOT ONE line parsed as JSON (a genuine
/// schema-drift case) — an answer that's merely empty is trusted as-is.
fn parse_codex_json_stream(stdout: &[u8]) -> (String, ExternalUsage) {
    let mut text = String::new();
    let mut usage = ExternalUsage::default();
    let mut parsed_any = false;
    for line in stdout.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        parsed_any = true;
        match ev.get("type").and_then(|t| t.as_str()) {
            Some("item.completed") => {
                let is_agent_message = ev
                    .get("item")
                    .and_then(|i| i.get("type"))
                    .and_then(|t| t.as_str())
                    == Some("agent_message");
                if is_agent_message {
                    if let Some(t) = ev.get("item").and_then(|i| i.get("text")).and_then(|t| t.as_str())
                    {
                        text = t.to_string();
                    }
                }
            }
            Some("turn.completed") => {
                if let Some(u) = ev.get("usage") {
                    usage.input_tokens = u.get("input_tokens").and_then(|x| x.as_u64());
                    usage.output_tokens = u.get("output_tokens").and_then(|x| x.as_u64());
                }
            }
            _ => {}
        }
    }
    if !parsed_any {
        text = String::from_utf8_lossy(stdout).trim().to_string();
    }
    (text, usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_external_model_handles_bare_model_and_effort() {
        assert_eq!(split_external_model("codex-cli"), ("codex-cli", None, None));
        assert_eq!(
            split_external_model("claude-cli"),
            ("claude-cli", None, None)
        );
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
        assert_eq!(
            split_external_model("qwen3.5:4b"),
            ("qwen3.5:4b", None, None)
        );
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
    fn embedded_codex_is_ephemeral_read_only_and_room_scoped() {
        for required in [
            "--ignore-user-config",
            "--ephemeral",
            "--sandbox read-only",
            "approval_policy=\"never\"",
            "--disable shell_tool",
            "--disable unified_exec",
            "web_search=\"disabled\"",
        ] {
            assert!(CODEX_ARCELLE_FLAGS.contains(required), "missing {required}");
        }
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
        assert_eq!(
            models[0].efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
    }

    // --- token-budget bar: real fixtures captured from live smoke calls, --
    // --- 2026-07-21 (see model_limits.rs / token_usage.rs doc comments)   --

    #[test]
    fn parse_claude_json_result_reads_text_usage_and_dominant_context_window() {
        // Captured verbatim from `claude -p --output-format json` (trimmed of
        // fields this parser doesn't read).
        let stdout = br#"{"type":"result","subtype":"success","is_error":false,"result":"pong","usage":{"input_tokens":1,"cache_creation_input_tokens":39383,"cache_read_input_tokens":0,"output_tokens":18},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":522,"outputTokens":14,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"contextWindow":200000},"claude-sonnet-5":{"inputTokens":1,"outputTokens":18,"cacheReadInputTokens":0,"cacheCreationInputTokens":39383,"contextWindow":1000000}}}"#;
        let (text, usage) = parse_claude_json_result(stdout);
        assert_eq!(text, "pong");
        // 1 + 39383 + 0 — all three count toward context.
        assert_eq!(usage.input_tokens, Some(39384));
        assert_eq!(usage.output_tokens, Some(18));
        // claude-sonnet-5 did the most work (39384 vs haiku's 536) — its
        // window wins, not the first entry or the smallest.
        assert_eq!(usage.max_context_hint, Some(1_000_000));
    }

    #[test]
    fn parse_claude_json_result_falls_back_to_plain_text_on_bad_json() {
        let (text, usage) = parse_claude_json_result(b"not json at all");
        assert_eq!(text, "not json at all");
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.max_context_hint, None);
    }

    #[test]
    fn parse_codex_json_stream_reads_last_agent_message_and_turn_usage() {
        // Captured verbatim from `codex exec --json`.
        let stdout = b"{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n\
{\"type\":\"turn.started\"}\n\
{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"pong\"}}\n\
{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":14365,\"cached_input_tokens\":9984,\"output_tokens\":5,\"reasoning_output_tokens\":0}}\n";
        let (text, usage) = parse_codex_json_stream(stdout);
        assert_eq!(text, "pong");
        assert_eq!(usage.input_tokens, Some(14365));
        assert_eq!(usage.output_tokens, Some(5));
        // Codex reports no context-window field anywhere in the stream.
        assert_eq!(usage.max_context_hint, None);
    }

    #[test]
    fn parse_codex_json_stream_falls_back_to_raw_text_when_nothing_parses() {
        let (text, usage) = parse_codex_json_stream(b"garbage, not jsonl");
        assert_eq!(text, "garbage, not jsonl");
        assert_eq!(usage.input_tokens, None);
    }

    #[test]
    fn parse_codex_json_stream_keeps_last_agent_message_when_several_appear() {
        let stdout = b"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"first\"}}\n\
{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"thinking...\"}}\n\
{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"final answer\"}}\n";
        let (text, _usage) = parse_codex_json_stream(stdout);
        assert_eq!(text, "final answer");
    }
}
