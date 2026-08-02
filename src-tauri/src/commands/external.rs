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

/// Claude Code's CLI still has no listing command — re-verified 2026-07-24
/// against CLI 2.1.201 and 2.1.219: no `models` subcommand, `--help` names
/// only three aliases as examples (it omits `haiku`), `auto-mode` prints
/// classifier rules only, and an invalid `--model` reports a generic error
/// with no valid-value list. But the CLI's own `/model` picker data IS
/// embedded in the installed executable's JavaScriptCore string table, so read
/// the catalog out of whichever CLI version the user actually has rather than
/// maintaining one here. Nothing about the tiers or their versions is
/// hardcoded below; only the display ORDER is, and unknown tiers still appear
/// (see `CLAUDE_TIER_ORDER`).
///
/// Scrape the executable that will be RUN — `run_external` invokes plain
/// `claude` through `zsh -ilc`, so the catalog must come from what is on PATH.
/// Resist reading a newer copy found elsewhere (a VSCode extension bundles
/// one): the picker would advertise models the CLI we actually execute cannot
/// run. A stale PATH install showing older tiers is the honest outcome, and
/// `claude update` is the fix.
///
/// Verified across a real upgrade: on 2.1.201 this yielded `opus -> Opus 4.8`
/// and on 2.1.219 `opus -> Opus 5`, with no code change — and in each case
/// `claude --model opus -p … --output-format json` reported that exact model
/// id back in `modelUsage`, so the label matches what the CLI really runs.
///
/// The string table has no record structure tying an alias to its label, so
/// parsing is content-based rather than positional: picker entries read
/// "<Family> <version> - <description>" and each is trusted only if its own
/// model id (`Opus 4.8` -> `claude-opus-4-8`) also appears in the executable.
/// That cross-check is what separates catalog entries from unrelated strings
/// that happen to read the same way (a live scan turned up exactly one such
/// impostor, "Phase 2 - …", and the check rejects it).
#[derive(Default)]
struct ClaudeCatalogScan {
    /// ("Opus", "4.8") -> "best for everyday, complex tasks"
    labels: HashMap<(String, String), String>,
    /// Every `claude-…` id seen, for the cross-check above.
    ids: HashSet<String>,
}

/// Display order for the Claude tiers in the picker. Presentation only — a
/// tier missing from this list still appears (appended, then alphabetical), so
/// a newly launched family shows up without a code change here.
const CLAUDE_TIER_ORDER: &[&str] = &["opus", "sonnet", "haiku", "fable"];

/// Refuse to believe a scan that found almost nothing: a garbled or partial
/// read should leave the fallback in place rather than empty the picker.
const CLAUDE_MIN_TIERS: usize = 2;

/// Bound on a picker description, and on how many distinct label candidates a
/// scan will hold — a live executable yields a handful, so anything near these
/// means we are reading noise, not a catalog.
const CLAUDE_DESC_MAX: usize = 240;
const CLAUDE_LABEL_MAX: usize = 256;

fn claude_version_parts(version: &str) -> Option<Vec<u32>> {
    if !version.starts_with(|c: char| c.is_ascii_digit())
        || !version.ends_with(|c: char| c.is_ascii_digit())
    {
        return None;
    }
    version.split('.').map(|p| p.parse().ok()).collect()
}

fn claude_model_id(family: &str, version: &str) -> String {
    format!("claude-{}-{}", family.to_lowercase(), version.replace('.', "-"))
}

/// True when the executable carries this exact model id, or a dated form of it
/// (`claude-opus-4-8-20260501`). Deliberately not a bare substring test, which
/// would also accept an unrelated `claude-opus-4-80`.
fn claude_catalog_has_id(ids: &HashSet<String>, expected: &str) -> bool {
    ids.iter().any(|id| {
        id == expected || id.strip_prefix(expected).is_some_and(|r| r.starts_with('-'))
    })
}

/// Parse backwards from the byte before a " - " separator to recover the
/// "<Family> <version>" head of a picker label. Returns None for anything that
/// isn't shaped like one, which is the overwhelming majority of hits.
fn claude_label_head(before: &[u8]) -> Option<(String, String)> {
    let mut v = before.len();
    while v > 0 && (before[v - 1].is_ascii_digit() || before[v - 1] == b'.') {
        v -= 1;
    }
    let version = std::str::from_utf8(&before[v..]).ok()?;
    claude_version_parts(version)?;
    if v == 0 || before[v - 1] != b' ' {
        return None;
    }
    let mut f = v - 1;
    while f > 0 && before[f - 1].is_ascii_alphabetic() {
        f -= 1;
    }
    let family = std::str::from_utf8(&before[f..v - 1]).ok()?;
    if family.len() < 2
        || family.len() > 16
        || !family.starts_with(|c: char| c.is_ascii_uppercase())
        || !family.chars().skip(1).all(|c| c.is_ascii_lowercase())
    {
        return None;
    }
    Some((family.to_string(), version.to_string()))
}

/// The description following " - ". The executable carries the picker text
/// twice: once in the length-prefixed bytecode string table (where the string
/// ends at the first non-printable byte) and once in the plain JS source it was
/// compiled from (where it ends at the closing quote). Stop at either, or the
/// prose runs on into the surrounding code — quotes and backslashes never
/// appear inside a picker description.
fn claude_label_desc(after: &[u8]) -> String {
    let end = after
        .iter()
        .take(CLAUDE_DESC_MAX)
        .position(|b| !(0x20..=0x7e).contains(b) || matches!(b, b'"' | b'`' | b'\\'))
        .unwrap_or(after.len().min(CLAUDE_DESC_MAX));
    String::from_utf8_lossy(&after[..end]).trim().to_string()
}

fn scan_claude_chunk(buf: &[u8], scan: &mut ClaudeCatalogScan) {
    // Anchor on the '-' of " - ": one byte compare per position, short-circuited
    // to its neighbours only on a hit, instead of a bounds-checked 3-byte slice
    // compare at every offset. This walks a ~230 MB executable on the first
    // model-picker open, so the inner test is the whole cost of the scan.
    //
    // `i` is bounded to `1..len-1`, so `buf[i - 1]`, `buf[i + 1]` and the
    // `sep + 3` slice below (at worst `&buf[len..]`, an empty slice) are all in
    // range; a buffer shorter than 2 bytes yields an empty range.
    for i in 1..buf.len().saturating_sub(1) {
        if buf[i] != b'-' || buf[i - 1] != b' ' || buf[i + 1] != b' ' {
            continue;
        }
        let sep = i - 1; // index of the leading space, as before
        let Some(head) = claude_label_head(&buf[..sep]) else {
            continue;
        };
        let desc = claude_label_desc(&buf[sep + 3..]);
        // A chunk boundary can cut a description short; the overlap re-reads it
        // intact, so keep whichever copy is longer.
        if desc.is_empty() || scan.labels.len() >= CLAUDE_LABEL_MAX {
            continue;
        }
        let slot = scan.labels.entry(head).or_default();
        if desc.len() > slot.len() {
            *slot = desc;
        }
    }

    let mut i = 0usize;
    while i + 7 <= buf.len() {
        if &buf[i..i + 7] != b"claude-" {
            i += 1;
            continue;
        }
        let mut j = i + 7;
        while j < buf.len()
            && j - i < 48
            && (buf[j].is_ascii_lowercase() || buf[j].is_ascii_digit() || buf[j] == b'-')
        {
            j += 1;
        }
        if let Ok(id) = std::str::from_utf8(&buf[i..j]) {
            scan.ids.insert(id.to_string());
        }
        i = j.max(i + 1);
    }
}

fn claude_models_from_scan(scan: &ClaudeCatalogScan) -> Vec<ExternalModelInfo> {
    let efforts: Vec<String> = CLAUDE_EFFORTS.iter().map(|s| s.to_string()).collect();
    // Newest version wins per family — that is what the CLI's bare alias
    // resolves to, and it needs no dependence on the English wording the
    // picker uses to mark older entries ("legacy", "previous … version").
    let mut newest: HashMap<&str, (Vec<u32>, &str, &str)> = HashMap::new();
    for ((family, version), description) in &scan.labels {
        let Some(parts) = claude_version_parts(version) else {
            continue;
        };
        if !claude_catalog_has_id(&scan.ids, &claude_model_id(family, version)) {
            continue;
        }
        match newest.get(family.as_str()) {
            Some((best, _, _)) if *best >= parts => {}
            _ => {
                newest.insert(family, (parts, version, description));
            }
        }
    }

    let mut models: Vec<(usize, ExternalModelInfo)> = newest
        .into_iter()
        .map(|(family, (_, version, description))| {
            let slug = family.to_lowercase();
            let rank = CLAUDE_TIER_ORDER
                .iter()
                .position(|t| *t == slug)
                .unwrap_or(CLAUDE_TIER_ORDER.len());
            (
                rank,
                ExternalModelInfo {
                    slug,
                    label: format!("{family} {version}"),
                    efforts: efforts.clone(),
                    default_effort: None,
                    context_window: None,
                    description: Some(description.to_string()),
                    input_price: None,
                    output_price: None,
                    // Claude Code takes image input — `run_external` writes
                    // attached images out for the CLI to open. This field is
                    // load-bearing now: a scraped catalog is a "rich" one to
                    // the picker, so its Vision filter chip acts on it.
                    input_modalities: vec!["text".into(), "image".into()],
                    tools: true,
                    vision: true,
                    reasoning: true,
                    structured_outputs: true,
                },
            )
        })
        .collect();
    models.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.label.cmp(&b.1.label)));
    models.into_iter().map(|(_, m)| m).collect()
}

/// The installed executable is ~230 MB, so stream it instead of loading it
/// whole. Successive chunks overlap so a label straddling a boundary is still
/// seen intact.
const CLAUDE_SCAN_CHUNK: usize = 8 << 20;
const CLAUDE_SCAN_OVERLAP: usize = 1 << 10;

fn read_fully(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut n = 0;
    while n < buf.len() {
        match file.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

fn scan_claude_executable(path: &std::path::Path) -> std::io::Result<ClaudeCatalogScan> {
    let mut file = std::fs::File::open(path)?;
    let mut scan = ClaudeCatalogScan::default();
    let mut buf = vec![0u8; CLAUDE_SCAN_CHUNK + CLAUDE_SCAN_OVERLAP];
    let mut carry = 0usize;
    loop {
        let read = read_fully(&mut file, &mut buf[carry..])?;
        if read == 0 {
            break;
        }
        let filled = carry + read;
        scan_claude_chunk(&buf[..filled], &mut scan);
        if filled <= CLAUDE_SCAN_OVERLAP {
            break;
        }
        buf.copy_within(filled - CLAUDE_SCAN_OVERLAP..filled, 0);
        carry = CLAUDE_SCAN_OVERLAP;
    }
    Ok(scan)
}

/// Where the `claude` binary actually lives. What is on PATH is a symlink into
/// the versioned install (`~/.local/share/claude/versions/<v>`), so canonicalize
/// first — the catalog is in the real executable, not the link. Same
/// interactive-login-shell trick as `detect_external_blocking`.
fn claude_executable_path() -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("zsh")
        .args(["-ilc", "command -v claude"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    std::fs::canonicalize(line).ok()
}

/// Cached for the process lifetime, like `CODEX_CATALOG` — the installed CLI
/// can't change under us without a restart of it. Unlike Codex's, this cache
/// also holds onto a FAILED scan: Codex retries a cheap subprocess, whereas
/// retrying here would re-read 230 MB on every picker open. A pinned fallback
/// only costs the version numbers and descriptions — its aliases still select
/// the right model — so that is the better trade than a repeated scan, and the
/// next app launch tries again.
static CLAUDE_CATALOG: tokio::sync::Mutex<Option<Vec<ExternalModelInfo>>> =
    tokio::sync::Mutex::const_new(None);

async fn list_claude_models() -> Vec<ExternalModelInfo> {
    let mut guard = CLAUDE_CATALOG.lock().await;
    if guard.is_none() {
        let scanned = tauri::async_runtime::spawn_blocking(|| {
            let path = claude_executable_path()?;
            let scan = scan_claude_executable(&path).ok()?;
            let models = claude_models_from_scan(&scan);
            (models.len() >= CLAUDE_MIN_TIERS).then_some(models)
        })
        .await
        .ok()
        .flatten();
        *guard = Some(scanned.unwrap_or_else(claude_fallback_models));
    }
    guard.clone().unwrap_or_else(claude_fallback_models)
}

/// Used only when the installed executable can't be read or its catalog does
/// not parse. The slugs are the CLI's own self-updating `--model` aliases, and
/// the labels deliberately carry NO version number — an unversioned fallback
/// cannot go stale the way a maintained "Opus 4.8" does.
fn claude_fallback_models() -> Vec<ExternalModelInfo> {
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
        input_modalities: vec!["text".into(), "image".into()],
        tools: true,
        vision: true,
        reasoning: true,
        structured_outputs: true,
    };
    CLAUDE_TIER_ORDER
        .iter()
        .map(|slug| {
            let mut label = slug.to_string();
            label[..1].make_ascii_uppercase();
            mk(slug, &label)
        })
        .collect()
}

/// List the models available for a detected cloud engine, for the Cloud
/// picker's second level. `engine` is the bare id ("claude-cli"/"codex-cli").
#[tauri::command]
pub async fn list_engine_models(engine: String) -> Result<Vec<ExternalModelInfo>, String> {
    match engine.as_str() {
        "codex-cli" => list_codex_models().await,
        "claude-cli" => Ok(list_claude_models().await),
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
    // Removed on EVERY exit from here, not just the happy one. The single
    // cleanup line at the end of the success path was skipped by each `?`
    // between here and it — a failed `--mcp-config` write, an unknown engine, a
    // panicking blocking task — leaving decrypted attachment images and the
    // room bridge's bearer token sitting in a shared temp folder indefinitely.
    let _work_dir_guard = TempWorkDir(tmp_dir.clone());
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
    // arbitrary user text. The Claude alias is scraped from the installed CLI
    // rather than hardcoded, so what upholds that is `claude_label_head`'s
    // charset: a slug can only ever be 2-16 lowercase ASCII letters, and no
    // quote or metacharacter can reach one. Effort is only meaningful with a
    // chosen model.
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

    // Decrypted content must not linger on disk — `_work_dir_guard` removes the
    // directory as this function returns, however it returns.
    // PRIV-1: put the real values back into the reply — the cloud only ever
    // saw the placeholders; the user reads a normal answer. Usage numbers
    // carry no room content, so they ride through untouched.
    match (&policy, result) {
        (Some(p), Ok((text, usage))) => Ok((p.redactor.restore(&text), usage)),
        (_, r) => r,
    }
}

/// The cloud CLI's scratch directory, removed when it goes out of scope.
///
/// It holds DECRYPTED attachment images and, for Claude, the `--mcp-config`
/// file carrying the room bridge's bearer token, so "clean it up if nothing
/// went wrong" is not good enough: `Drop` runs on every `?`, on the unknown-
/// engine return and on a panic. The removal is also CHECKED — a failure used
/// to be swallowed by `let _ =`, so a directory that could not be removed left
/// no trace anywhere that it was still there.
struct TempWorkDir(std::path::PathBuf);

impl Drop for TempWorkDir {
    fn drop(&mut self) {
        if !self.0.exists() {
            return; // nothing was ever written (no images, no bridge config)
        }
        let removed = std::fs::remove_dir_all(&self.0).is_ok() && !self.0.exists();
        if !removed {
            eprintln!(
                "[external] could NOT remove the cloud-CLI scratch directory {} — it may still \
                 hold decrypted attachments and the room bridge token",
                self.0.display()
            );
        }
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
    // NOTE: `modelUsage[*].contextWindow` also rides this envelope — the real
    // window, per model. The CHAT path reads it in the sidecar's twin of this
    // parser (`external_llm.parse_claude_json_result`), which is where the
    // token bar's denominator is now decided; nothing here consumes it.
    (text, ExternalUsage { input_tokens, output_tokens })
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

    // --- Claude catalog scraped from the installed CLI executable ---------
    // The fixtures below are NUL-joined strings in the shape the real
    // JavaScriptCore string table stores them, copied from a live scan of
    // Claude Code 2.1.201 (including the "Phase 2" impostor it really
    // contains). See `ClaudeCatalogScan` for why parsing is content-based.

    fn string_table(strings: &[&str]) -> Vec<u8> {
        strings.join("\0").into_bytes()
    }

    fn scan_fixture(strings: &[&str]) -> Vec<ExternalModelInfo> {
        let mut scan = ClaudeCatalogScan::default();
        scan_claude_chunk(&string_table(strings), &mut scan);
        claude_models_from_scan(&scan)
    }

    const CLAUDE_FIXTURE: &[&str] = &[
        "sonnet",
        "Custom Sonnet model",
        " (1M context)",
        "Sonnet 5 - efficient for routine tasks. Generally recommended for most coding tasks",
        "claude-sonnet-5",
        "Sonnet 4.6 - previous Sonnet version",
        "claude-sonnet-4-6",
        "Opus 4.8 - best for everyday, complex tasks",
        "claude-opus-4-8",
        "Opus 4.7 - previous Opus version",
        "claude-opus-4-7",
        "Opus 4.8 with 1M context window - for long sessions with large codebases",
        // Haiku appears only in its dated form here — the id cross-check has
        // to accept that, since the picker label carries no date.
        "Haiku 4.5 - fastest for quick answers. Lower cost but less capable",
        "claude-haiku-4-5-20251001",
        "Fable 5 - most capable for your hardest and longest-running tasks",
        "claude-fable-5",
        // Reads exactly like a picker label but has no `claude-phase-2` id.
        "Phase 2 - rollout begins next week",
    ];

    #[test]
    fn claude_catalog_scrapes_current_tier_per_family_from_the_executable() {
        let models = scan_fixture(CLAUDE_FIXTURE);
        let seen: Vec<(&str, &str)> = models
            .iter()
            .map(|m| (m.slug.as_str(), m.label.as_str()))
            .collect();
        // Newest version per family wins; display order is CLAUDE_TIER_ORDER.
        assert_eq!(
            seen,
            vec![
                ("opus", "Opus 4.8"),
                ("sonnet", "Sonnet 5"),
                ("haiku", "Haiku 4.5"),
                ("fable", "Fable 5"),
            ]
        );
        assert_eq!(
            models[0].description.as_deref(),
            Some("best for everyday, complex tasks")
        );
        // The " with 1M context window - " variant is not a second tier entry.
        assert_eq!(models.iter().filter(|m| m.slug == "opus").count(), 1);
        // A scraped catalog is "rich" to the picker, so these drive its
        // capability filter chips — Claude Code takes images and tools.
        assert!(models.iter().all(|m| m.vision && m.tools));
        // Every Claude model offers the CLI's fixed --effort set.
        assert_eq!(
            models[0].efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
    }

    #[test]
    fn claude_catalog_rejects_labels_with_no_matching_model_id() {
        // "Phase 2 - …" parses as a label but owns no `claude-phase-2` id.
        assert!(scan_fixture(CLAUDE_FIXTURE)
            .iter()
            .all(|m| m.slug != "phase"));
    }

    #[test]
    fn claude_catalog_description_stops_at_the_end_of_the_js_string_literal() {
        // The native install embeds the plain JS source next to the compiled
        // string table, so a printable run does not end at the description —
        // it continues into the surrounding code. Verbatim shape from a live
        // scan of 2.1.201.
        let js = br#"descriptionForModel:"Opus 4.8 - best for everyday, complex tasks"}}function WBa(){let e=process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;"claude-opus-4-8""#;
        let mut scan = ClaudeCatalogScan::default();
        scan_claude_chunk(js, &mut scan);
        let models = claude_models_from_scan(&scan);
        assert_eq!(
            models[0].description.as_deref(),
            Some("best for everyday, complex tasks")
        );
    }

    #[test]
    fn claude_catalog_slugs_are_shell_safe_lowercase_aliases() {
        // Both command builders interpolate the slug into a single-quoted
        // `--model '<slug>'` on the stated assumption that it is one of "our
        // own known slugs". It is scraped now, so the parser's charset is what
        // upholds that assumption — pin it here.
        let models = scan_fixture(&[
            "Opus 4.8 - best for everyday, complex tasks",
            "claude-opus-4-8",
            // Metacharacters butted against a real label must not reach a slug.
            "'; rm -rf ~; echo 'Sonnet 5 - efficient for routine tasks",
            "claude-sonnet-5",
        ]);
        assert_eq!(models.len(), 2);
        for m in &models {
            assert!(
                (2..=16).contains(&m.slug.len())
                    && m.slug.chars().all(|c| c.is_ascii_lowercase()),
                "unsafe slug reached the CLI command: {:?}",
                m.slug
            );
        }
    }

    #[test]
    fn claude_catalog_orders_versions_numerically_not_lexically() {
        let models = scan_fixture(&[
            "Opus 4.9 - previous Opus version",
            "claude-opus-4-9",
            "Opus 4.10 - best for everyday, complex tasks",
            "claude-opus-4-10",
        ]);
        // Lexically "4.10" < "4.9"; numerically 4.10 is the newer tier.
        assert_eq!(models[0].label, "Opus 4.10");
    }

    #[test]
    fn claude_catalog_id_check_accepts_dated_ids_but_not_longer_versions() {
        let ids: HashSet<String> = ["claude-opus-4-8-20260501", "claude-opus-4-80"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(claude_catalog_has_id(&ids, "claude-opus-4-8"));
        assert!(!claude_catalog_has_id(&ids, "claude-opus-4-7"));
        // `claude-opus-4-80` must not vouch for a "Opus 4.8" label.
        let only_longer: HashSet<String> =
            std::iter::once("claude-opus-4-80".to_string()).collect();
        assert!(!claude_catalog_has_id(&only_longer, "claude-opus-4-8"));
    }

    #[test]
    fn claude_catalog_survives_a_label_split_across_scan_chunks() {
        let table = string_table(CLAUDE_FIXTURE);
        // Cut mid-description of the Opus entry, then rescan with the same
        // overlap the streaming reader uses.
        let cut = table
            .windows(9)
            .position(|w| w == b"best for ")
            .expect("fixture contains the Opus description")
            + 4;
        let overlap = cut.saturating_sub(CLAUDE_SCAN_OVERLAP);
        let mut scan = ClaudeCatalogScan::default();
        scan_claude_chunk(&table[..cut], &mut scan);
        scan_claude_chunk(&table[overlap..], &mut scan);
        let models = claude_models_from_scan(&scan);
        // The truncated copy must not win over the intact one.
        assert_eq!(
            models[0].description.as_deref(),
            Some("best for everyday, complex tasks")
        );
    }

    /// Live check against whatever Claude Code is installed on this machine.
    /// Ignored by default so the suite never depends on a local CLI — run with
    /// `cargo test -- --ignored claude_catalog_scan_of_the_installed_cli` after
    /// a CLI upgrade to confirm the string table still parses.
    #[test]
    #[ignore]
    fn claude_catalog_scan_of_the_installed_cli() {
        let path = claude_executable_path().expect("claude is installed");
        let scan = scan_claude_executable(&path).expect("executable is readable");
        let models = claude_models_from_scan(&scan);
        eprintln!("scanned {}:", path.display());
        for m in &models {
            eprintln!("  {:8} {:12} {:?}", m.slug, m.label, m.description);
        }
        assert!(models.len() >= CLAUDE_MIN_TIERS, "catalog looks empty");
        assert!(models.iter().any(|m| m.slug == "opus"));
        assert!(models.iter().all(|m| m.label.contains(char::is_numeric)));
    }

    #[test]
    fn claude_fallback_is_unversioned_cli_aliases_with_fixed_efforts() {
        let models = claude_fallback_models();
        let slugs: Vec<&str> = models.iter().map(|m| m.slug.as_str()).collect();
        assert_eq!(slugs, vec!["opus", "sonnet", "haiku", "fable"]);
        // No version number in a fallback label — nothing here can go stale.
        assert_eq!(models[0].label, "Opus");
        assert!(models.iter().all(|m| !m.label.contains(char::is_numeric)));
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
    }

    #[test]
    fn parse_claude_json_result_falls_back_to_plain_text_on_bad_json() {
        let (text, usage) = parse_claude_json_result(b"not json at all");
        assert_eq!(text, "not json at all");
        assert_eq!(usage.input_tokens, None);
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
