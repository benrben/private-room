use super::*;

#[tauri::command]
pub fn mcp_get_config(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
    })
}

#[tauri::command]
pub fn mcp_apply_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    json: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let servers = mcp::parse_config(&json)?;
    state.with_room(|room| db::set_setting(&room.conn, MCP_CONFIG_KEY, &json))?;
    // SEC-1: the user just typed and saved this config, which counts as
    // approval — remember its fingerprint so reopening the room won't re-ask.
    add_mcp_approval(&app, &mcp_fingerprint(&json));
    start_mcp_connections(app, servers);
    Ok(state.mcp.lock().unwrap().statuses())
}

/// SEC-1: SHA-256 of the room's mcp_config JSON, hex-encoded. Any change to the
/// config text changes the fingerprint, so an old approval no longer counts.
pub(crate) fn mcp_fingerprint(config_json: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(config_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// SEC-1: what a server would do, shown in the approval dialog so the user sees
/// exactly what they're allowing. Local: the full command line, e.g.
/// "uvx duckduckgo-mcp-server". Remote: the endpoint it would reach, flagged so
/// the dialog can distinguish "start a program" from "reach a service".
pub(crate) fn render_command_line(cfg: &mcp::ServerConfig) -> String {
    match &cfg.transport {
        mcp::Transport::Stdio { command, args, .. } => {
            let mut parts = Vec::with_capacity(1 + args.len());
            parts.push(command.clone());
            parts.extend(args.iter().cloned());
            parts.join(" ")
        }
        mcp::Transport::Http { url, .. } => format!("{url}  (remote — reaches the internet)"),
    }
}

/// Approved MCP fingerprints live OUTSIDE any room, in the app's own data
/// folder — the room's author is the attacker, so approvals are per-Mac and
/// never travel inside the `.roomai` file (SEC-1).
pub(crate) fn mcp_approvals_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp_approvals.json"))
}

pub(crate) fn read_mcp_approvals(app: &tauri::AppHandle) -> Vec<String> {
    mcp_approvals_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn add_mcp_approval(app: &tauri::AppHandle, fingerprint: &str) {
    let mut list = read_mcp_approvals(app);
    if list.iter().any(|f| f == fingerprint) {
        return;
    }
    list.push(fingerprint.to_string());
    if let Ok(path) = mcp_approvals_file(app) {
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// The connector preference files live per-Mac next to the fingerprint
/// approvals — one JSON bool each, outside any room (the room's author is the
/// attacker; a blanket-consent flag must never travel inside a `.roomai`).
fn mcp_flag_file(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

pub(crate) fn mcp_auto_approve_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    mcp_flag_file(app, "mcp_auto_approve.json")
}

/// The unmasking preference is a SEPARATE file, deliberately. It has no legacy
/// value to inherit, so an install that had the old combined "auto mode" on
/// keeps its unattended calls and goes back to sending placeholders until the
/// user asks for real values. That is the fail-closed direction, and the
/// Connectors copy states the live state rather than the default, so the user
/// reads what is true on this Mac instead of being told nothing changed.
pub(crate) fn mcp_outbound_unmask_file(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    mcp_flag_file(app, "mcp_outbound_unmask.json")
}

/// The persisted "run connector tools without asking" preference. **Absent
/// file = OFF.** Reading is resilient — any parse failure falls back to the
/// default rather than erroring.
pub(crate) fn read_mcp_auto_approve(app: &tauri::AppHandle) -> bool {
    read_mcp_flag(mcp_auto_approve_file(app))
}

/// The persisted "send remote connectors real values" preference. **Absent
/// file = OFF** — this is the flag that decides whether the room's private
/// details leave the Mac intact, so it never defaults on.
pub(crate) fn read_mcp_outbound_unmask(app: &tauri::AppHandle) -> bool {
    read_mcp_flag(mcp_outbound_unmask_file(app))
}

fn read_mcp_flag(path: Result<std::path::PathBuf, String>) -> bool {
    let raw = path.ok().and_then(|p| std::fs::read_to_string(p).ok());
    parse_connector_flag(raw.as_deref())
}

/// The pure half of the two readers above, so the DEFAULT is unit-testable
/// without an `AppHandle`. Only an explicit `true` on disk turns a connector
/// power on; a missing, empty or corrupt file fails closed.
pub(crate) fn parse_connector_flag(raw: Option<&str>) -> bool {
    raw.and_then(|s| serde_json::from_str::<bool>(s.trim()).ok())
        .unwrap_or(false)
}

fn write_mcp_flag(path: Result<std::path::PathBuf, String>, on: bool) {
    if let Ok(path) = path {
        let _ = std::fs::write(path, if on { "true" } else { "false" });
    }
}

// ------------------------------------------------- per-connector overrides

/// One connector's answer to each of the two powers, or `None` for "whatever
/// the switch above says". Optional rather than `bool` on purpose: a connector
/// nobody has touched must be indistinguishable from one set back to the
/// default, because that is what lets the Mac-wide switch keep meaning
/// something after this became per-connector — and it is what makes the
/// upgrade grant nothing. An install arriving from the single global pair has
/// no entries at all, so every connector simply inherits the value that
/// install already had.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConnectorOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_approve: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbound_unmask: Option<bool>,
}

/// Which of the two powers a per-connector edit is about. An enum, so the
/// stringly-typed name from the UI is validated ONCE, at the command boundary —
/// a typo there must be an error the user can see, never a silently-ignored
/// write that leaves the switch showing a value the backend never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConnectorPower {
    AutoApprove,
    OutboundUnmask,
}

impl ConnectorPower {
    pub(crate) fn parse(name: &str) -> Result<Self, String> {
        match name {
            "auto_approve" => Ok(Self::AutoApprove),
            "outbound_unmask" => Ok(Self::OutboundUnmask),
            other => Err(format!(
                "unknown connector power \"{other}\" (expected auto_approve or outbound_unmask)"
            )),
        }
    }
}

/// Read the per-connector overrides (`{server: {auto_approve?, outbound_unmask?}}`).
/// Missing/invalid → empty, which means every connector follows the Mac-wide
/// switch. Pure over the stored string, mirroring `parse_tool_prefs`.
pub(crate) fn parse_connector_powers(
    raw: &str,
) -> std::collections::BTreeMap<String, ConnectorOverride> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// Set (or clear, with `value: None`) one power for one connector and return the
/// new JSON. Pure — unit-tested, mirroring `set_tool_pref`. An entry that ends
/// up saying nothing is dropped, so "back to following the switch" leaves no
/// residue that a later reading of the file could mistake for a choice.
pub(crate) fn set_connector_power(
    raw: &str,
    server: &str,
    power: ConnectorPower,
    value: Option<bool>,
) -> Result<String, String> {
    let mut map = parse_connector_powers(raw);
    let entry = map.entry(server.to_string()).or_default();
    match power {
        ConnectorPower::AutoApprove => entry.auto_approve = value,
        ConnectorPower::OutboundUnmask => entry.outbound_unmask = value,
    }
    if *entry == ConnectorOverride::default() {
        map.remove(server);
    }
    serde_json::to_string(&map).map_err(|e| e.to_string())
}

/// What is actually in force for one connector: its own answer when it has one,
/// otherwise the Mac-wide switch. Pure, and the ONLY place the two levels are
/// combined — the UI states the result of this, so a user never has to work out
/// which level wins.
pub(crate) fn effective_power(global: bool, over: Option<bool>) -> bool {
    over.unwrap_or(global)
}

/// The overrides live per-Mac beside the two global flags, for the same SEC-1
/// reason: the room's author is the attacker, so a consent decision must never
/// travel inside a `.roomai`.
pub(crate) fn mcp_connector_powers_file(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    mcp_flag_file(app, "mcp_connector_powers.json")
}

pub(crate) fn read_mcp_connector_powers(
    app: &tauri::AppHandle,
) -> std::collections::BTreeMap<String, ConnectorOverride> {
    let raw = mcp_connector_powers_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok());
    parse_connector_powers(raw.as_deref().unwrap_or("{}"))
}

/// The override this connector has recorded, if any. Split out so the two
/// accessors below each name exactly one power.
fn override_for(state: &AppState, server: &str) -> ConnectorOverride {
    state
        .mcp_connector_powers
        .lock()
        .unwrap()
        .get(server)
        .copied()
        .unwrap_or_default()
}

/// "Run connector tools without asking", as it applies to ONE connector.
/// Touches the auto-approve level only: unmasking is not a way to stop being
/// asked, at either level.
pub(crate) fn auto_approve_for(state: &AppState, server: &str) -> bool {
    effective_power(
        state
            .mcp_auto_approve
            .load(std::sync::atomic::Ordering::SeqCst),
        override_for(state, server).auto_approve,
    )
}

/// "Send remote connectors real values", as it applies to ONE connector.
/// Touches the unmasking level only: standing consent to run is not a way to
/// unmask, at either level.
pub(crate) fn outbound_unmask_for(state: &AppState, server: &str) -> bool {
    effective_power(
        state
            .mcp_outbound_unmask
            .load(std::sync::atomic::Ordering::SeqCst),
        override_for(state, server).outbound_unmask,
    )
}

/// Connectors → per-connector overrides, as JSON for the UI. Empty object when
/// every connector follows the two switches above.
#[tauri::command]
pub fn get_mcp_connector_powers(state: State<'_, AppState>) -> String {
    let map = state.mcp_connector_powers.lock().unwrap();
    serde_json::to_string(&*map).unwrap_or_else(|_| "{}".to_string())
}

/// Connectors → set one connector's answer for one power, or clear it back to
/// the switch above (`value: None`). Persists per-Mac and takes effect on the
/// next connector call — both seams read the live state. Returns the new map so
/// the UI shows what was actually stored rather than what it hoped for.
#[tauri::command]
pub fn set_mcp_connector_power(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
    power: String,
    value: Option<bool>,
) -> Result<String, String> {
    let which = ConnectorPower::parse(&power)?;
    let mut map = state.mcp_connector_powers.lock().unwrap();
    let raw = serde_json::to_string(&*map).unwrap_or_else(|_| "{}".to_string());
    let next = set_connector_power(&raw, &server, which, value)?;
    *map = parse_connector_powers(&next);
    drop(map);
    if let Ok(path) = mcp_connector_powers_file(&app) {
        let _ = std::fs::write(path, &next);
    }
    Ok(next)
}

/// Whether one connector call may skip its consent card.
///
/// Pure, and it takes ONLY the two things that may ever excuse the card: the
/// user's standing "don't ask me" preference, and their "always allow" for this
/// connector earlier in the session. The outbound-unmasking preference is
/// deliberately not a parameter — that was the bug the 2026-08-03 split fixes,
/// where asking for real arguments also silently stopped asking permission.
pub(crate) fn skips_consent_card(auto_approve: bool, remembered_this_session: bool) -> bool {
    auto_approve || remembered_this_session
}

/// Connectors → "Run connector tools without asking": read the live state for
/// the UI toggle.
#[tauri::command]
pub fn get_mcp_auto_approve(state: State<'_, AppState>) -> bool {
    state
        .mcp_auto_approve
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// Connectors → "Run connector tools without asking": flip it and persist it
/// per-Mac. Takes effect immediately for the next connector call (the flag is
/// read live in `mcp_call_approved`); the file makes it survive a restart.
/// Does NOT touch masking — that is `set_mcp_outbound_unmask`.
#[tauri::command]
pub fn set_mcp_auto_approve(app: tauri::AppHandle, state: State<'_, AppState>, on: bool) {
    state
        .mcp_auto_approve
        .store(on, std::sync::atomic::Ordering::SeqCst);
    write_mcp_flag(mcp_auto_approve_file(&app), on);
}

/// Connectors → "Send remote connectors real values": read the live state for
/// the UI toggle.
#[tauri::command]
pub fn get_mcp_outbound_unmask(state: State<'_, AppState>) -> bool {
    state
        .mcp_outbound_unmask
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// Connectors → "Send remote connectors real values": flip it and persist it
/// per-Mac. Read live at the outbound seam (`exec_tool`), so the next call
/// carries whatever this says. Does NOT grant consent — with the card still on,
/// the user sees the real arguments and approves them before they leave.
#[tauri::command]
pub fn set_mcp_outbound_unmask(app: tauri::AppHandle, state: State<'_, AppState>, on: bool) {
    state
        .mcp_outbound_unmask
        .store(on, std::sync::atomic::Ordering::SeqCst);
    write_mcp_flag(mcp_outbound_unmask_file(&app), on);
}

/// SEC-1: the spawn/approval decision for a room's MCP config, decided PURELY
/// from the config text and the set of already-approved fingerprints — no I/O,
/// so it is unit-testable. `refresh_mcp` (the spawner) and `pending_mcp_for`
/// (the dialog) both route through this, so they can never disagree about
/// whether a config is allowed to run.
pub(crate) enum McpGate {
    /// Nothing to start — no enabled servers. `servers` still carries whatever
    /// parsed (disabled entries), so the list can be registered as Disabled
    /// without parsing the config a second time.
    Nothing(Vec<(String, mcp::ServerConfig)>),
    /// The stored config could not be read at all. NOT the same as "there is
    /// nothing here": treating a hand-edited or half-written config as empty
    /// left the Connectors page blank with no warning, so this is surfaced.
    Unreadable(String),
    /// Enabled servers whose exact config is already approved — start them.
    Start(Vec<(String, mcp::ServerConfig)>),
    /// Enabled servers whose fingerprint is NOT approved — spawn nothing and
    /// ask the user first. `servers` are the enabled ones, for the dialog.
    NeedsApproval {
        fingerprint: String,
        servers: Vec<(String, mcp::ServerConfig)>,
    },
}

pub(crate) fn mcp_gate(config_json: &str, approved: &std::collections::HashSet<String>) -> McpGate {
    let servers = match mcp::parse_config(config_json) {
        Ok(s) => s,
        Err(e) => return McpGate::Unreadable(e),
    };
    if !servers.iter().any(|(_, c)| !c.disabled) {
        return McpGate::Nothing(servers);
    }
    let fingerprint = mcp_fingerprint(config_json);
    if approved.contains(&fingerprint) {
        return McpGate::Start(servers);
    }
    let enabled = servers.into_iter().filter(|(_, c)| !c.disabled).collect();
    McpGate::NeedsApproval {
        fingerprint,
        servers: enabled,
    }
}

/// SEC-1: if the open room's config has ENABLED servers whose fingerprint isn't
/// approved on this Mac, describe them for the approval dialog. None otherwise
/// (no enabled servers, or already approved).
pub(crate) fn pending_mcp_for(app: &tauri::AppHandle, conn: &Connection) -> Option<McpApproval> {
    let config = db::get_setting(conn, MCP_CONFIG_KEY)?;
    let approved: std::collections::HashSet<String> = read_mcp_approvals(app).into_iter().collect();
    match mcp_gate(&config, &approved) {
        McpGate::NeedsApproval {
            fingerprint,
            servers,
        } => Some(McpApproval {
            fingerprint,
            servers: servers
                .iter()
                .map(|(name, cfg)| McpServerBrief {
                    name: name.clone(),
                    command: render_command_line(cfg),
                })
                .collect(),
        }),
        McpGate::Start(_) | McpGate::Nothing(_) | McpGate::Unreadable(_) => None,
    }
}

/// SEC-1: approve the currently open room's plug-in config on this Mac, then
/// start its servers and return their statuses. Declining is simply never
/// calling this — the servers stay stopped.
#[tauri::command]
pub fn approve_mcp(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    fingerprint: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    add_mcp_approval(&app, &fingerprint);
    refresh_mcp(&app);
    Ok(state.mcp.lock().unwrap().statuses())
}

#[tauri::command]
pub fn mcp_status(state: State<'_, AppState>) -> Result<Vec<mcp::ServerStatus>, String> {
    Ok(state.mcp.lock().unwrap().statuses())
}

/// (Re)connect servers from the open room's saved config. Runs in the
/// background — opening a room must not wait on `uvx` downloads.
pub(crate) fn refresh_mcp(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    let config_json: Option<String> = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .and_then(|room| db::get_setting(&room.conn, MCP_CONFIG_KEY))
    };
    // SEC-1: never auto-spawn a room's plug-ins without a per-Mac approval of
    // this exact config. If the gate says NeedsApproval, start NOTHING — the UI
    // surfaces the approval dialog via RoomInfo.pendingMcp and calls approve_mcp
    // on "Allow". This is the SAME decision pending_mcp_for shows the user.
    let approved: std::collections::HashSet<String> = read_mcp_approvals(app).into_iter().collect();
    // The gate already parsed the config; reuse ITS list instead of parsing the
    // same JSON a second time on every room open.
    let servers = match config_json.as_deref().map(|j| mcp_gate(j, &approved)) {
        Some(McpGate::NeedsApproval { .. }) => return,
        // Approved, or only-disabled: register the parsed servers (disabled ones
        // simply show as Disabled; enabled+approved ones connect).
        Some(McpGate::Start(servers)) | Some(McpGate::Nothing(servers)) => servers,
        // An unreadable config is NOT an empty one. Surface it as a failed row
        // so the Connectors page says why it looks empty instead of pretending
        // the room has no connectors at all.
        Some(McpGate::Unreadable(why)) => {
            show_unreadable_mcp_config(app, &why);
            return;
        }
        None => Vec::new(),
    };
    start_mcp_connections(app.clone(), servers);
}

/// The name of the notice row that stands in for the connector list when the
/// room's stored config can't be parsed. Not a connector — `agent_mcp_name`
/// rejects the space, so no real connector can ever be called this.
pub(crate) const UNREADABLE_CONFIG_ROW: &str = "connector setup";

/// The ONE explanation given for a room whose stored connector setup can't be
/// read — used both for the notice row and for anything the user tries to do
/// while it is showing, so the same problem never produces a second, vaguer
/// message.
pub(crate) fn unreadable_config_message(why: &str) -> String {
    format!(
        "This room's connector setup could not be read ({why}). \
         No connectors were started — fix the JSON under Advanced, then Save & Connect."
    )
}

/// Err when the room's stored connector config can't be parsed. Nothing on the
/// Connectors page is a real connector in that state — the single row is a
/// notice — so enable/remove must refuse with the explanation rather than act.
/// `remove_server_from_config` in particular SUCCEEDS on a config that merely
/// lacks `mcpServers`, which rewrote it, approved its fingerprint and left the
/// list silently empty again: the exact failure the notice row was added for.
fn require_readable_config(config: &str) -> Result<(), String> {
    if config.trim().is_empty() {
        return Ok(());
    }
    mcp::parse_config(config)
        .map(|_| ())
        .map_err(|why| unreadable_config_message(&why))
}

/// Replace the connector list with ONE failed row explaining that the room's
/// stored connector setup could not be read. The Connectors page renders a
/// failed row's `error`, so this is the warning the silent-empty case never gave.
fn show_unreadable_mcp_config(app: &tauri::AppHandle, why: &str) {
    use tauri::{Emitter, Manager as _};
    let state = app.state::<AppState>();
    {
        let mut mgr = state.mcp.lock().unwrap();
        mgr.generation += 1;
        mgr.servers = vec![mcp::Server {
            name: UNREADABLE_CONFIG_ROW.into(),
            status: mcp::Status::Failed,
            error: Some(unreadable_config_message(why)),
            tools: Vec::new(),
            remote: false,
            client: None,
            config_key: String::new(),
        }];
    }
    let _ = app.emit("mcp-status", state.mcp.lock().unwrap().statuses());
}

pub(crate) fn start_mcp_connections(
    app: tauri::AppHandle,
    servers: Vec<(String, mcp::ServerConfig)>,
) {
    use tauri::{Emitter, Manager as _};
    // Only servers that actually need dialling are (re)connected. An enabled
    // server whose transport config is identical to a LIVE connection is
    // carried over untouched — flipping one connector's switch (or adding,
    // removing or signing into another) used to tear down and restart every
    // connector in the room: seconds of everything reading "connecting…", and
    // each one losing whatever session it held.
    let (generation, to_connect) = {
        let state = app.state::<AppState>();
        let mut mgr = state.mcp.lock().unwrap();
        mgr.generation += 1;
        // Anything left in `previous` at the end of this block is dropped, which
        // is what stops a removed or retargeted server's child process.
        let mut previous: std::collections::HashMap<String, mcp::Server> =
            std::mem::take(&mut mgr.servers)
                .into_iter()
                .map(|s| (s.name.clone(), s))
                .collect();
        let mut to_connect: Vec<(String, mcp::ServerConfig)> = Vec::new();
        mgr.servers = servers
            .iter()
            .map(|(name, cfg)| {
                let key = mcp::config_key(cfg);
                if !cfg.disabled {
                    let live = previous.remove(name).filter(|p| {
                        p.status == mcp::Status::Connected
                            && p.client.is_some()
                            && p.config_key == key
                    });
                    if let Some(live) = live {
                        return live;
                    }
                    to_connect.push((name.clone(), cfg.clone()));
                }
                mcp::Server {
                    name: name.clone(),
                    status: if cfg.disabled {
                        mcp::Status::Disabled
                    } else {
                        mcp::Status::Connecting
                    },
                    error: None,
                    tools: Vec::new(),
                    remote: cfg.transport.is_remote(),
                    client: None,
                    config_key: key,
                }
            })
            .collect();
        (mgr.generation, to_connect)
    };
    let _ = app.emit(
        "mcp-status",
        app.state::<AppState>().mcp.lock().unwrap().statuses(),
    );
    for (name, cfg) in to_connect {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // A stored OAuth token expires — often within the hour. Renew it
            // before dialling, so a connector the user signed into keeps
            // working instead of presenting a dead pass forever.
            let cfg = refreshed_oauth_config(&app, &name, cfg).await;
            let result = mcp::Client::connect(&cfg).await;
            let state = app.state::<AppState>();
            {
                let mut mgr = state.mcp.lock().unwrap();
                // A newer config was applied while we were connecting.
                if mgr.generation != generation {
                    return;
                }
                if let Some(entry) = mgr.servers.iter_mut().find(|s| s.name == name) {
                    // Record what we ACTUALLY dialled — a renewed bearer makes
                    // the live config differ from the one we were handed, and a
                    // stale key here would force a needless reconnect next time.
                    entry.config_key = mcp::config_key(&cfg);
                    match result {
                        Ok((client, tools)) => {
                            entry.status = mcp::Status::Connected;
                            entry.tools = tools;
                            entry.client = Some(Arc::new(tokio::sync::Mutex::new(client)));
                        }
                        Err(e) => {
                            entry.status = mcp::Status::Failed;
                            entry.error = Some(e);
                        }
                    }
                }
            }
            let _ = app.emit(
                "mcp-status",
                app.state::<AppState>().mcp.lock().unwrap().statuses(),
            );
        });
    }
}

// ---------------------------------------------------------------- chat / AI

/// How much of a connector call's arguments the consent card shows. The card
/// scrolls (`.approve-args`), so this can be generous — 400 characters cut a
/// document-sized call down to its opening line.
const MCP_ARG_PREVIEW_MAX: usize = 2000;

/// What the consent card shows for a connector call's arguments. Truncation is
/// MARKED and counted: an unmarked slice makes a call carrying a whole document
/// look identical to a trivial one, so "Allow" could approve material that was
/// never on screen. Pure — unit-tested.
pub(crate) fn preview_args(args: &serde_json::Value, max: usize) -> String {
    let raw = args.to_string();
    let total = raw.chars().count();
    if total <= max {
        return raw;
    }
    let shown: String = raw.chars().take(max).collect();
    format!(
        "{shown}\n\n… showing the first {max} of {total} characters. Allowing sends ALL of it."
    )
}

#[allow(clippy::too_many_arguments)]
/// SEC-1b: prompt the frontend to approve one MCP tool call, tying consent to
/// the moment data actually leaves the room. Returns true when the user allows
/// it — or already chose "always allow" for this connector this session. A
/// timeout or a closed window counts as a decline, never a silent yes.
pub(crate) async fn mcp_call_approved(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    route: &McpRoute,
    args: &serde_json::Value,
) -> bool {
    use tauri::Emitter;
    // Connectors → "Run connector tools without asking": the user granted
    // standing consent to RUN connector tools, so the agent's calls never stall
    // on a card nobody is watching. That is ALL it grants. Whether the arguments
    // on that call are the room's real values is `mcp_outbound_unmask`, read
    // separately at the outbound seam in `exec_tool` — the two were one switch
    // until 2026-08-03, which meant a user who only wanted their lookups to stop
    // returning nothing also stopped being asked. `args` here is already the
    // copy that will leave, so the card shows what is actually sent either way.
    //
    // Read PER CONNECTOR (owner's decision, per connector, 2026-08-03): a user
    // who trusts one local connector enough to stop being asked has said
    // nothing about the remote one that reaches the internet. The Mac-wide
    // switch is only the default a connector inherits when it has no answer of
    // its own.
    let remembered = state
        .mcp_session_ok
        .lock()
        .unwrap()
        .contains(&route.server_name);
    if skips_consent_card(auto_approve_for(state, &route.server_name), remembered) {
        return true;
    }
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<McpDecision>();
    state.mcp_pending.lock().unwrap().insert(id.clone(), tx);
    let preview = preview_args(args, MCP_ARG_PREVIEW_MAX);
    let _ = window.emit(
        "mcp-approve-request",
        serde_json::json!({
            "id": id,
            "server": route.server_name,
            "tool": route.tool_name,
            "args": preview,
        }),
    );
    let decision = match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.mcp_pending.lock().unwrap().remove(&id);
            McpDecision {
                approved: false,
                remember: false,
            }
        }
    };
    if decision.approved && decision.remember {
        state
            .mcp_session_ok
            .lock()
            .unwrap()
            .insert(route.server_name.clone());
    }
    decision.approved
}

// ------------------------------------------------- agent-initiated deletions

/// The consent-card payload for an agent-initiated DELETION.
///
/// Deliberately a different shape from the tool-call card: `confirm` carries
/// the one sentence naming what goes with the thing being deleted, and its
/// presence is what makes the frontend render the destructive card instead of
/// "Allow a connected tool to run?" — copy that would be a lie here, since
/// nothing is being *run*. Pure, so the shape is unit-tested.
pub(crate) fn destructive_request(
    id: &str,
    what: &str,
    name: &str,
    detail: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "server": name,
        "tool": what,
        "args": "",
        "confirm": detail,
    })
}

/// Ask the user before the agent deletes something it cannot put back.
///
/// One command wiped a connector AND its saved sign-in with nothing asking
/// first — and because the agent reads the room's documents, a file containing
/// "remove the github connector" was enough to set it off (audit #505). There
/// is no trash for connectors, skills or workflows, so the card IS the undo.
///
/// Standing consent does NOT reach here. "Run connector tools without asking"
/// is permission to CALL a connector; it has never been permission to destroy
/// the room's own configuration, and `mcp_session_ok` is likewise not consulted
/// or written. A timeout or a closed window is a decline, never a silent yes.
pub(crate) async fn confirm_destructive(
    state: &AppState,
    window: &tauri::Window,
    what: &str,
    name: &str,
    detail: &str,
) -> bool {
    use tauri::Emitter;
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<McpDecision>();
    state.mcp_pending.lock().unwrap().insert(id.clone(), tx);
    let _ = window.emit(
        "mcp-approve-request",
        destructive_request(&id, what, name, detail),
    );
    match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
        Ok(Ok(d)) => d.approved,
        _ => {
            state.mcp_pending.lock().unwrap().remove(&id);
            false
        }
    }
}

/// What the agent is told when the user says no. Its own sentence, so the model
/// reports a refusal instead of inventing a reason or trying again.
pub(crate) const DELETE_DECLINED: &str =
    "Not deleted — the confirmation was declined. Nothing was changed.";

// ---------------------------------------------------------------- OAuth

/// Merge an `Authorization: Bearer <token>` header into one server's entry in an
/// mcpServers config JSON, preserving everything else. Pure — unit-tested.
pub(crate) fn merge_bearer(config: &str, server: &str, token: &str) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    let entry = root
        .get_mut("mcpServers")
        .and_then(|m| m.get_mut(server))
        .and_then(|e| e.as_object_mut())
        .ok_or_else(|| format!("\"{server}\" is not in the connector config"))?;
    let headers = entry
        .entry("headers")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(obj) = headers.as_object_mut() {
        obj.insert(
            "Authorization".to_string(),
            serde_json::Value::String(format!("Bearer {token}")),
        );
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Run the OAuth sign-in for one remote connector: discover, register, PKCE
/// browser flow, store the token, merge the bearer into the room config, and
/// reconnect. The interactive step opens the system browser.
#[tauri::command]
pub async fn mcp_oauth_authorize(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let config = state
        .with_room(|room| Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default()))?;
    let url = mcp::parse_config(&config)?
        .into_iter()
        .find(|(n, _)| n == &server)
        .and_then(|(_, c)| match c.transport {
            mcp::Transport::Http { url, .. } => Some(url),
            _ => None,
        })
        .ok_or_else(|| format!("\"{server}\" is not a remote connector in this room."))?;

    // Interactive authorization — opens the browser via the opener plugin. We
    // also emit the URL first so the UI can offer a manual "open / copy the
    // sign-in link" fallback when the system browser doesn't come up on its own.
    let app_open = app.clone();
    let server_ev = server.clone();
    let open = move |u: &str| -> Result<(), String> {
        use tauri::Emitter;
        let _ = app_open.emit(
            "mcp-oauth-url",
            serde_json::json!({ "server": server_ev, "url": u }),
        );
        use tauri_plugin_opener::OpenerExt;
        app_open
            .opener()
            .open_url(u.to_string(), None::<&str>)
            .map_err(|e| e.to_string())
    };
    let www = super::mcp_oauth::probe_www_authenticate(&url).await;
    let token = super::mcp_oauth::authorize(&url, www.as_deref(), open).await?;

    // Persist the token + merge the bearer into the config, then reconnect. The
    // config change is a deliberate user action (they just signed in), so its
    // new fingerprint is approved like a saved config (SEC-1).
    let merged = state.with_room(|room| {
        super::mcp_oauth::save_tokens(&room.conn, &server, &token)?;
        let json = merge_bearer(&config, &server, &token.access_token)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    add_mcp_approval(&app, &mcp_fingerprint(&merged));
    start_mcp_connections(app, mcp::parse_config(&merged)?);
    Ok(state.mcp.lock().unwrap().statuses())
}

/// Whether a remote connector's account is still connected — drives the
/// "Signed in" vs "Connect account" state in the marketplace drawer. An expiring
/// token still counts as signed in when it can be renewed silently
/// (`refreshed_oauth_config` does that on the next connect); only a token that
/// is gone or unrenewable sends the user back through the browser.
#[tauri::command]
pub fn mcp_oauth_status(state: State<'_, AppState>, server: String) -> Result<bool, String> {
    state.with_room(|room| {
        Ok(super::mcp_oauth::load_tokens(&room.conn, &server)
            .map(|t| !super::mcp_oauth::needs_refresh(&t) || super::mcp_oauth::can_refresh(&t))
            .unwrap_or(false))
    })
}

/// Renew this connector's stored OAuth token when it is at (or near) expiry,
/// persist it, merge the fresh bearer into the room's connector config, and
/// return the config the connect should actually use.
///
/// The renewal step existed but nothing ran it, so roughly an hour after signing
/// in a connector kept presenting a dead pass and every call failed until the
/// user signed in again by hand. Re-approving the rewritten config matches what
/// signing in already does (the user's own sign-in authorized this connector —
/// SEC-1). On any problem the original config is returned unchanged: a failed
/// renewal must not stop a connect that may still work.
async fn refreshed_oauth_config(
    app: &tauri::AppHandle,
    name: &str,
    cfg: mcp::ServerConfig,
) -> mcp::ServerConfig {
    use tauri::Manager as _;
    if !cfg.transport.is_remote() {
        return cfg;
    }
    // Pin the room this token belongs to. The renewal below is a network call
    // that can run to the OAuth client's 30 s timeout, and this whole function
    // runs on a background connect task — lock this room and unlock another in
    // that window and a bare `with_room` would resolve to the NEW room, filing
    // room A's access AND refresh token in room B's settings. Same room-path +
    // epoch convention `AppState::room_epoch` documents.
    let (room_path, epoch, stored) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let Some(room) = guard.as_ref() else { return cfg };
        (
            room.path.clone(),
            state.room_epoch(),
            super::mcp_oauth::load_tokens(&room.conn, name),
        )
    };
    let Some(stored) = stored else { return cfg };
    let Some(outcome) = super::mcp_oauth::refresh_if_expiring(&stored).await else {
        return cfg;
    };
    let fresh = match outcome {
        Ok(fresh) => fresh,
        // Offline, or the auth server was unreachable: the sign-in may be fine.
        // Leave it alone and try again on the next connect.
        Err(e) if !e.is_rejected() => return cfg,
        Err(_) => {
            // The provider REFUSED the refresh token — revoked, or expired. No
            // later connect can renew it, so record that instead of letting the
            // drawer keep reporting a greyed-out "Signed in": that button is the
            // only way to re-authorize, and without this the user's only way out
            // was removing the connector and adding it again.
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            if let Some(room) = guard.as_ref() {
                if room.path == room_path && state.room_epoch() == epoch {
                    let dead = super::mcp_oauth::mark_refresh_rejected(&stored);
                    let _ = super::mcp_oauth::save_tokens(&room.conn, name, &dead);
                }
            }
            return cfg;
        }
    };
    let merged = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let Some(room) = guard.as_ref() else { return cfg };
        // The room moved while we were renewing: this token is not this room's
        // to write. Drop it and let the connect proceed on the config we were
        // handed — the old room renews again the next time it is opened.
        if room.path != room_path || state.room_epoch() != epoch {
            return cfg;
        }
        // The token is saved BEFORE the config merge on purpose: a refresh often
        // rotates the refresh token, so the old one may already be dead and
        // dropping the fresh set would force the user back through the browser.
        // A merge that then fails (the connector was removed mid-refresh) just
        // leaves an unused token behind, which `mcp_oauth_sign_out` clears.
        (|| {
            super::mcp_oauth::save_tokens(&room.conn, name, &fresh)?;
            let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
            let json = merge_bearer(&config, name, &fresh.access_token)?;
            db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
            Ok::<String, String>(json)
        })()
    };
    let Ok(merged) = merged else { return cfg };
    add_mcp_approval(app, &mcp_fingerprint(&merged));
    mcp::parse_config(&merged)
        .ok()
        .and_then(|servers| {
            servers
                .into_iter()
                .find(|(n, _)| n == name)
                .map(|(_, c)| c)
        })
        .unwrap_or(cfg)
}

/// Forget a remote connector's OAuth token and strip its bearer header.
#[tauri::command]
pub fn mcp_oauth_sign_out(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let merged = state.with_room(|room| {
        super::mcp_oauth::clear_tokens(&room.conn, &server)?;
        let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
        // Drop the Authorization header if present, leaving the rest intact.
        let json = strip_bearer(&config, &server).unwrap_or(config);
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    add_mcp_approval(&app, &mcp_fingerprint(&merged));
    start_mcp_connections(app, mcp::parse_config(&merged).unwrap_or_default());
    Ok(state.mcp.lock().unwrap().statuses())
}

// ------------------------------------------------ agent CRUD (local-only)

const AGENT_SECRET_KEYS: &[&str] = &[
    "headers",
    "env",
    "bearer_token_env_var",
    "authorization",
    "token",
    "oauth",
];

/// What the agent-facing views print where a credential would otherwise be.
const REDACTED_ARG: &str = "[redacted]";

/// Words that mark a command-line flag as carrying a credential, so the value
/// it introduces is masked too: `--api-key sk-…`, `--token=…`, `API_KEY=…`.
const CREDENTIAL_WORDS: &[&str] = &[
    "key",
    "apikey",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "credential",
    "credentials",
    "auth",
    "bearer",
];

/// Does this flag name promise a credential value? Kebab, snake and camel all
/// spell the same words (`--api-key`, `API_KEY`, `--apiKey`, `--accessToken`).
fn is_credential_flag(name: &str) -> bool {
    let name = name.trim_start_matches('-').to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| CREDENTIAL_WORDS.contains(&word))
        || CREDENTIAL_WORDS.iter().any(|word| name.ends_with(word))
}

/// A bare value that reads like a credential even with nothing naming it: a
/// known vendor prefix, a JWT, or a long opaque run of token characters. Paths,
/// URLs and package specs are deliberately excluded — they carry no secret and
/// they are how the model recognises a connector.
fn looks_like_secret(value: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "sk-",
        "sk_",
        "pk_",
        "rk_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xapp-",
        "AKIA",
        "ASIA",
        "AIza",
        "hf_",
        "shpat_",
        "glpat-",
        "npm_",
        "dop_v1_",
    ];
    let value = value.trim();
    if value.len() >= 12 && PREFIXES.iter().any(|p| value.starts_with(p)) {
        return true;
    }
    // A JWT: three dotted base64url segments, always starts `eyJ`.
    if value.starts_with("eyJ") && value.split('.').count() == 3 {
        return true;
    }
    value.len() >= 24
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '='))
        && value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic())
}

/// Mask credentials typed straight into a local connector's command line. The
/// named secret FIELDS were covered, but a key given as `--api-key sk-…` went to
/// the model word for word — and in a cloud room that leaves the Mac.
fn redact_cli_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for arg in args {
        if mask_next {
            mask_next = false;
            out.push(REDACTED_ARG.to_string());
            continue;
        }
        match arg.split_once('=') {
            // `--api-key=…` / `API_KEY=…`, and any `name=<opaque token>`.
            Some((name, value))
                if !value.is_empty() && (is_credential_flag(name) || looks_like_secret(value)) =>
            {
                out.push(format!("{name}={REDACTED_ARG}"));
            }
            // `--api-key` on its own: the credential is the NEXT argument.
            _ if arg.starts_with('-') && !arg.contains('=') && is_credential_flag(arg) => {
                mask_next = true;
                out.push(arg.clone());
            }
            _ if looks_like_secret(arg) => out.push(REDACTED_ARG.to_string()),
            _ => out.push(arg.clone()),
        }
    }
    out
}

/// The same masking over an `args` array as it sits in the config JSON.
/// Non-string entries (a config written elsewhere) pass through untouched.
fn redact_json_args(args: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let flat: Vec<String> = args
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    redact_cli_args(&flat)
        .into_iter()
        .zip(args)
        .map(|(masked, original)| match original.as_str() {
            Some(_) => serde_json::Value::String(masked),
            None => original.clone(),
        })
        .collect()
}

/// Undo the read-side masking on a write: an argument the model echoed back as
/// `[redacted]` is restored from the stored connector, so saving a connector the
/// model merely read can never overwrite the user's real key with the
/// placeholder text (and the destination still compares equal, so
/// `same_destination` keeps the sign-in).
///
/// Paired by VALUE, not by position. `agent_read_mcp` shows the masked args, so
/// read → tweak → save is the natural flow and the model may insert, drop or
/// reorder an argument on the way back; matching by index then either stored the
/// literal `[redacted]` (past the end of the old array) or substituted an
/// unrelated old argument. Re-masking the stored args reproduces exactly what
/// the model was shown, and each placeholder takes an as-yet-unused old argument
/// that masked to the same text — preferring the one whose PRECEDING argument
/// matches (`--api-key` vs `--token`), then the same index. A placeholder that
/// pairs with nothing is left alone for `reject_surviving_placeholders`.
fn restore_redacted_args(
    old: &serde_json::Map<String, serde_json::Value>,
    incoming: &mut serde_json::Value,
) {
    let Some(previous) = old.get("args").and_then(serde_json::Value::as_array) else {
        return;
    };
    let previous = previous.clone();
    let masked = redact_json_args(&previous);
    let Some(args) = incoming
        .get_mut("args")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    // What the model handed back, before any restoring — the tie-break reads the
    // argument BEFORE a placeholder, which must be the incoming one.
    let handed_back: Vec<Option<String>> = args
        .iter()
        .map(|a| a.as_str().map(str::to_string))
        .collect();
    let mut used = vec![false; masked.len()];
    for i in 0..args.len() {
        let Some(placeholder) = args[i]
            .as_str()
            .filter(|s| s.ends_with(REDACTED_ARG))
            .map(str::to_string)
        else {
            continue;
        };
        let candidates: Vec<usize> = (0..masked.len())
            .filter(|&j| !used[j] && masked[j].as_str() == Some(placeholder.as_str()))
            .collect();
        let pick = if candidates.len() < 2 {
            candidates.first().copied()
        } else {
            let before = i.checked_sub(1).and_then(|p| handed_back[p].clone());
            candidates
                .iter()
                .copied()
                .find(|&j| {
                    before.is_some()
                        && j > 0
                        && masked[j - 1].as_str().map(str::to_string) == before
                })
                .or_else(|| candidates.iter().copied().find(|&j| j == i))
                .or_else(|| candidates.first().copied())
        };
        if let Some(j) = pick {
            used[j] = true;
            args[i] = previous[j].clone();
        }
    }
}

/// Refuse a save whose `args` still contain the masking placeholder. It stands
/// for a credential the room hides from the assistant, so storing it verbatim
/// would erase the user's real key — irrecoverably, and while also reading as a
/// retarget (which drops the connector's env/headers and its sign-in). Reached
/// when the model invented a placeholder for a connector that never had one, or
/// mangled the args badly enough that nothing stored pairs with it.
fn reject_surviving_placeholders(incoming: &serde_json::Value) -> Result<(), String> {
    let Some(args) = incoming.get("args").and_then(serde_json::Value::as_array) else {
        return Ok(());
    };
    if args
        .iter()
        .any(|a| a.as_str().is_some_and(|s| s.ends_with(REDACTED_ARG)))
    {
        return Err(format!(
            "One argument is still \"{REDACTED_ARG}\" and no stored value matches it. That \
             placeholder stands for a credential hidden from you, and saving it would erase the \
             real one — re-read the connector and save it with its arguments in the same order, \
             or ask the user to set the credential in Connectors."
        ));
    }
    Ok(())
}

fn agent_mcp_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(
            "Connector names use 1-64 letters, numbers, dots, dashes, or underscores.".into(),
        );
    }
    Ok(name)
}

fn agent_mcp_root(raw: &str) -> Result<serde_json::Value, String> {
    let mut root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    if !root.is_object() {
        return Err("the room's connector config must be a JSON object".into());
    }
    if root.get("mcpServers").is_none() {
        root["mcpServers"] = serde_json::json!({});
    }
    if !root["mcpServers"].is_object() {
        return Err("the room's mcpServers value must be an object".into());
    }
    Ok(root)
}

fn redact_agent_mcp_config(config: &serde_json::Value) -> serde_json::Value {
    let mut safe = config.clone();
    if let Some(map) = safe.as_object_mut() {
        for key in AGENT_SECRET_KEYS {
            if map.remove(*key).is_some() {
                map.insert(
                    (*key).to_string(),
                    serde_json::Value::String(REDACTED_ARG.into()),
                );
            }
        }
        // A key typed into the command line is as much a credential as one in
        // `env`, and `args` is not one of the named fields.
        if let Some(args) = map.get("args").and_then(serde_json::Value::as_array) {
            let masked = redact_json_args(args);
            map.insert("args".to_string(), serde_json::Value::Array(masked));
        }
    }
    safe
}

fn remove_agent_mcp_secrets(config: &mut serde_json::Value) {
    if let Some(map) = config.as_object_mut() {
        for key in AGENT_SECRET_KEYS {
            map.remove(*key);
        }
    }
}

/// Inventory available to the local main agent. It deliberately describes
/// transports/statuses, never credential values.
pub(crate) fn agent_list_mcps(state: &AppState) -> Result<String, String> {
    let config = state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
    })?;
    let servers = mcp::parse_config(&config)?;
    if servers.is_empty() {
        return Ok("No MCP connectors are configured in this room.".into());
    }
    let statuses: std::collections::HashMap<String, String> = state
        .mcp
        .lock()
        .unwrap()
        .statuses()
        .into_iter()
        .map(|status| (status.name, format!("{:?}", status.status).to_lowercase()))
        .collect();
    let lines = servers
        .iter()
        .map(|(name, cfg)| {
            let transport = match &cfg.transport {
                mcp::Transport::Stdio { command, args, .. } => {
                    // Same rule as read_mcp: describe what it runs, never the
                    // key someone typed onto the end of it.
                    let args = redact_cli_args(args);
                    let args = if args.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", args.join(" "))
                    };
                    format!("local: {command}{args}")
                }
                mcp::Transport::Http { url, .. } => format!("remote: {url}"),
            };
            let state = if cfg.disabled {
                "disabled".to_string()
            } else {
                statuses
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| "configured".into())
            };
            format!("- {name} [{state}] — {transport}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(lines)
}

/// Read one server's editable, secret-free configuration.
pub(crate) fn agent_read_mcp(state: &AppState, name: &str) -> Result<String, String> {
    let name = agent_mcp_name(name)?;
    let config = state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
    })?;
    let root = agent_mcp_root(&config)?;
    let server = root["mcpServers"]
        .get(name)
        .ok_or_else(|| format!("No connector named \"{name}\" exists."))?;
    let safe = redact_agent_mcp_config(server);
    Ok(format!(
        "Connector {name} (credentials redacted):\n{}",
        serde_json::to_string_pretty(&safe).map_err(|e| e.to_string())?
    ))
}

/// Create/update a connector without ever accepting, exposing, approving, or
/// starting credentials/programs. A changed connector remains disabled until a
/// human reviews it in Connectors and completes the existing SEC-1 approval.
pub(crate) fn agent_save_mcp(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    use tauri::Manager as _;

    let name = agent_mcp_name(args["name"].as_str().unwrap_or_default())?.to_string();
    let mut incoming = args
        .get("config")
        .cloned()
        .filter(serde_json::Value::is_object)
        .ok_or("save_mcp needs a `config` object.")?;
    remove_agent_mcp_secrets(&mut incoming);
    let json = state.with_room(|room| {
        let raw = db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string());
        let mut root = agent_mcp_root(&raw)?;
        let servers = root["mcpServers"].as_object_mut().expect("checked above");
        let existed = servers.get(&name).is_some();
        // Preserve already-stored credentials while refusing new secret values
        // from model context — but ONLY while the connector still points at the
        // same place. Carrying them over an edit that changes the url (or the
        // command) would hand the user's saved key to a NEW destination, and
        // the Connectors list shows just a name and a switch, so turning it back
        // on would send the key somewhere nobody was warned about. A same-target
        // edit must still never erase a user's token.
        const CARRIED: [&str; 3] = ["headers", "env", "bearer_token_env_var"];
        let mut retargeted = false;
        let mut had_credentials = false;
        if let Some(old) = servers.get(&name).and_then(serde_json::Value::as_object) {
            // read_mcp showed `[redacted]` where a command-line key was; writing
            // that back verbatim would replace the user's real key with the
            // placeholder (and read as a retarget). Put the original back first.
            restore_redacted_args(old, &mut incoming);
            had_credentials = CARRIED.iter().any(|k| old.contains_key(*k));
            let same = incoming
                .as_object()
                .is_some_and(|new| same_destination(old, new));
            retargeted = !same;
            if same {
                if let Some(new) = incoming.as_object_mut() {
                    for key in CARRIED {
                        if let Some(value) = old.get(key) {
                            new.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
        }
        // Whatever the model did to the args, the placeholder itself is never a
        // value worth storing — including on a brand-new connector, where there
        // is no old entry to restore from.
        reject_surviving_placeholders(&incoming)?;
        incoming["disabled"] = serde_json::Value::Bool(true);
        servers.insert(name.clone(), incoming);
        let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        mcp::parse_config(&json)?;
        // A retargeted connector's stored sign-in belongs to the OLD endpoint;
        // leaving it would let the connect-time refresh re-attach it to the new
        // one behind the user's back.
        let had_signin = super::mcp_oauth::load_tokens(&room.conn, &name).is_some();
        if retargeted {
            super::mcp_oauth::clear_tokens(&room.conn, &name)?;
        }
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok((json, existed, retargeted && (had_credentials || had_signin)))
    })?;
    let (json, existed, dropped_credentials) = json;
    let servers = mcp::parse_config(&json)?;
    start_mcp_connections(window.app_handle().clone(), servers);
    let dropped = if dropped_credentials {
        " Its saved credentials and sign-in were NOT carried over, because this edit changed where the connector points."
    } else {
        ""
    };
    Ok(format!(
        "{} connector \"{}\" as disabled.{dropped} Review it in Connectors, add any credentials there, then explicitly enable and approve it before it can run or reach the network.",
        if existed { "Updated" } else { "Saved" },
        name
    ))
}

/// Does an edited connector still reach the same place? Compares only the fields
/// that decide WHERE a call goes: the endpoint (`url`, and the `type` that marks
/// it remote) for a remote connector, the `command` and `args` for a local one.
/// Pure — unit-tested.
fn same_destination(
    old: &serde_json::Map<String, serde_json::Value>,
    new: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    ["url", "type", "command", "args"]
        .iter()
        .all(|k| old.get(*k) == new.get(*k))
}

pub(crate) async fn agent_delete_mcp(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    use tauri::Manager as _;

    let name = agent_mcp_name(args["name"].as_str().unwrap_or_default())?.to_string();
    // Unrecoverable and reachable from anything the agent READ, so it is the
    // user's click, not the model's (audit #505).
    if !confirm_destructive(
        state,
        window,
        "connector",
        &name,
        "Its saved sign-in (OAuth token) is erased with it. There is no undo — \
         you would have to add the connector and sign in again.",
    )
    .await
    {
        return Err(DELETE_DECLINED.into());
    }
    let json = state.with_room(|room| {
        let raw = db::get_setting(&room.conn, MCP_CONFIG_KEY)
            .unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string());
        let root = agent_mcp_root(&raw)?;
        if root["mcpServers"].get(&name).is_none() {
            return Err(format!("No connector named \"{name}\" exists."));
        }
        super::mcp_oauth::clear_tokens(&room.conn, &name)?;
        let json = remove_server_from_config(&raw, &name)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    start_mcp_connections(window.app_handle().clone(), mcp::parse_config(&json)?);
    Ok(format!(
        "Deleted connector \"{name}\" and its saved OAuth token."
    ))
}

// ------------------------------------------------------------ enable/remove

/// Set or clear `"disabled"` on one server in an mcpServers config. Pure —
/// unit-tested. Disabling keeps the connector in the config but stops it.
pub(crate) fn set_server_disabled(
    config: &str,
    server: &str,
    disabled: bool,
) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    let entry = root
        .get_mut("mcpServers")
        .and_then(|m| m.get_mut(server))
        .and_then(|e| e.as_object_mut())
        .ok_or_else(|| format!("\"{server}\" is not in the connector config"))?;
    if disabled {
        entry.insert("disabled".to_string(), serde_json::Value::Bool(true));
    } else {
        entry.remove("disabled");
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Remove one server from an mcpServers config entirely. Pure — unit-tested.
pub(crate) fn remove_server_from_config(config: &str, server: &str) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config)
        .map_err(|_| "the room's connector config isn't valid JSON".to_string())?;
    if let Some(map) = root.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
        map.remove(server);
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Persist an edited config, re-approve it (the edit is a deliberate user
/// action so its new fingerprint counts as approved — SEC-1), and reconnect.
fn apply_edited_config(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    json: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    add_mcp_approval(app, &mcp_fingerprint(&json));
    start_mcp_connections(app.clone(), mcp::parse_config(&json).unwrap_or_default());
    Ok(state.mcp.lock().unwrap().statuses())
}

/// Turn one connector on or off without removing it (writes `"disabled"`).
#[tauri::command]
pub fn mcp_set_server_enabled(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
    enabled: bool,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let json = state.with_room(|room| {
        let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
        require_readable_config(&config)?;
        let json = set_server_disabled(&config, &server, !enabled)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    apply_edited_config(&app, &state, json)
}

/// Remove one connector from the room entirely (also forgets its OAuth token).
#[tauri::command]
pub fn mcp_remove_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let json = state.with_room(|room| {
        let config = db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_default();
        // Before touching anything: an unreadable config has no connectors to
        // remove, and removing "nothing" from it would still rewrite it, approve
        // it and erase the warning row — as well as clearing a real connector's
        // saved sign-in on the way past.
        require_readable_config(&config)?;
        let _ = super::mcp_oauth::clear_tokens(&room.conn, &server);
        let json = remove_server_from_config(&config, &server)?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
        Ok(json)
    })?;
    apply_edited_config(&app, &state, json)
}

/// Remove the Authorization header from one server's config entry. Pure.
fn strip_bearer(config: &str, server: &str) -> Result<String, String> {
    let mut root: serde_json::Value = serde_json::from_str(config).map_err(|e| e.to_string())?;
    if let Some(h) = root
        .get_mut("mcpServers")
        .and_then(|m| m.get_mut(server))
        .and_then(|e| e.get_mut("headers"))
        .and_then(|h| h.as_object_mut())
    {
        h.remove("Authorization");
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

// ------------------------------------------------------- per-tool whitelist

/// Read the per-connector tool opt-outs (`{server: [disabled tool names]}`).
/// Missing/invalid → empty (everything on). Pure over the stored string.
pub(crate) fn parse_tool_prefs(
    raw: &str,
) -> std::collections::HashMap<String, std::collections::HashSet<String>> {
    serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(raw)
        .map(|m| {
            m.into_iter()
                .map(|(k, v)| (k, v.into_iter().collect()))
                .collect()
        })
        .unwrap_or_default()
}

/// Update one server's disabled-tools list and return the new prefs JSON. Pure —
/// unit-tested. `enabled=false` adds the tool to the off-list; `true` removes it.
pub(crate) fn set_tool_pref(
    raw: &str,
    server: &str,
    tool: &str,
    enabled: bool,
) -> Result<String, String> {
    let mut map: std::collections::BTreeMap<String, Vec<String>> =
        serde_json::from_str(raw).unwrap_or_default();
    let list = map.entry(server.to_string()).or_default();
    list.retain(|t| t != tool);
    if !enabled {
        list.push(tool.to_string());
    }
    if list.is_empty() {
        map.remove(server);
    }
    serde_json::to_string(&map).map_err(|e| e.to_string())
}

/// The room's tool opt-outs as `{server: [disabled tools]}` — drives the per-tool
/// toggles in the Connectors page. Empty object when nothing is turned off.
#[tauri::command]
pub fn mcp_get_tool_prefs(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        Ok(db::get_setting(&room.conn, MCP_TOOL_PREFS_KEY).unwrap_or_else(|| "{}".to_string()))
    })
}

/// Turn one connector tool on or off for this room. No reconnect needed — the
/// change takes effect on the next turn, when `mcp_routes` re-reads the prefs.
#[tauri::command]
pub fn mcp_set_tool_enabled(
    state: State<'_, AppState>,
    server: String,
    tool: String,
    enabled: bool,
) -> Result<String, String> {
    state.with_room(|room| {
        let raw =
            db::get_setting(&room.conn, MCP_TOOL_PREFS_KEY).unwrap_or_else(|| "{}".to_string());
        let next = set_tool_pref(&raw, &server, &tool, enabled)?;
        db::set_setting(&room.conn, MCP_TOOL_PREFS_KEY, &next)?;
        Ok(next)
    })
}

/// The frontend's answer to an `mcp-approve-request` — "once", "always", or
/// anything else (declined).
#[tauri::command]
pub fn resolve_mcp_call(
    state: State<'_, AppState>,
    id: String,
    decision: String,
) -> Result<(), String> {
    let d = match decision.as_str() {
        "once" => McpDecision {
            approved: true,
            remember: false,
        },
        "always" => McpDecision {
            approved: true,
            remember: true,
        },
        _ => McpDecision {
            approved: false,
            remember: false,
        },
    };
    if let Some(tx) = state.mcp_pending.lock().unwrap().remove(&id) {
        let _ = tx.send(d);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Audit #505: the agent could delete a connector and its saved sign-in
    /// with nothing asking first. The card is the undo, so its payload must be
    /// recognisably a DELETION — the frontend renders the tool-call card
    /// ("Allow a connected tool to run?", "Always allow this connector") for
    /// anything without `confirm`, which would be the wrong question and would
    /// offer standing consent to destruction.
    #[test]
    fn a_deletion_card_is_never_mistaken_for_a_tool_call_card() {
        let v = destructive_request("id-1", "connector", "github", "Its sign-in goes too.");
        assert_eq!(v["confirm"], "Its sign-in goes too.");
        assert_eq!(v["tool"], "connector");
        assert_eq!(v["server"], "github");
        assert_eq!(v["id"], "id-1");
        // No arguments to preview: nothing is being SENT anywhere.
        assert_eq!(v["args"], "");
    }

    /// Declining must read as a refusal, not as a done deed — the model
    /// otherwise reports the deletion it was stopped from making.
    #[test]
    fn a_declined_deletion_says_nothing_was_changed() {
        assert!(DELETE_DECLINED.contains("Not deleted"));
        assert!(DELETE_DECLINED.contains("Nothing was changed"));
    }

    #[test]
    fn both_connector_powers_are_off_until_the_user_turns_them_on() {
        // Each power now has its OWN file, and both are read through here. A
        // fresh install must not arrive with either open, so anything other than
        // an explicit `true` on disk fails closed. (An install that had the old
        // combined "auto mode" on has no unmasking file at all — None — which is
        // why this row is the one that decides the upgrade lands masked.)
        assert!(
            !parse_connector_flag(None),
            "a fresh install must default OFF"
        );
        assert!(!parse_connector_flag(Some("")));
        assert!(!parse_connector_flag(Some("garbage")));
        assert!(!parse_connector_flag(Some("false")));
        // Only the user's own explicit choice turns one on, whitespace and all.
        assert!(parse_connector_flag(Some("true")));
        assert!(parse_connector_flag(Some(" true\n")));
    }

    /// All four (auto-approve, unmask) combinations for ONE connector, stated
    /// over the real deciders. The per-connector layer only earns its keep if
    /// every combination is reachable for a single connector, so this walks the
    /// truth table with the two GLOBAL switches held OFF and only the
    /// connector's own answers moving — which is also the case an upgraded
    /// install starts from.
    #[test]
    fn one_connector_can_reach_all_four_combinations() {
        let mut raw = "{}".to_string();
        let mut seen = std::collections::HashSet::new();
        for auto in [false, true] {
            for unmask in [false, true] {
                raw = set_connector_power(&raw, "linear", ConnectorPower::AutoApprove, Some(auto))
                    .unwrap();
                raw = set_connector_power(
                    &raw,
                    "linear",
                    ConnectorPower::OutboundUnmask,
                    Some(unmask),
                )
                .unwrap();
                let over = parse_connector_powers(&raw)["linear"];
                // The globals are OFF; what is in force is the connector's own
                // answer, and each power reads only its own field.
                let skips = skips_consent_card(effective_power(false, over.auto_approve), false);
                let masks = super::super::masks_outbound_args(
                    true,
                    effective_power(false, over.outbound_unmask),
                );
                assert_eq!(skips, auto, "auto={auto} unmask={unmask}: wrong consent");
                assert_eq!(masks, !unmask, "auto={auto} unmask={unmask}: wrong masking");
                seen.insert((skips, masks));
            }
        }
        assert_eq!(seen.len(), 4, "a connector's two powers must not collapse");
    }

    #[test]
    fn two_connectors_do_not_affect_each_other() {
        // The reason the global-only pair was the wrong granularity: trusting
        // the connector that runs on this Mac must say nothing about the one
        // that reaches the internet.
        let raw =
            set_connector_power("{}", "filesystem", ConnectorPower::AutoApprove, Some(true))
                .unwrap();
        let raw =
            set_connector_power(&raw, "linear", ConnectorPower::OutboundUnmask, Some(true))
                .unwrap();
        let map = parse_connector_powers(&raw);
        // Each connector holds exactly the one answer it was given…
        assert_eq!(map["filesystem"].auto_approve, Some(true));
        assert_eq!(map["filesystem"].outbound_unmask, None);
        assert_eq!(map["linear"].outbound_unmask, Some(true));
        assert_eq!(map["linear"].auto_approve, None);
        // …so with both globals OFF, filesystem skips its card while linear
        // still gets one, and linear unmasks while filesystem's untouched
        // power stays masked.
        assert!(skips_consent_card(
            effective_power(false, map["filesystem"].auto_approve),
            false
        ));
        assert!(!skips_consent_card(
            effective_power(false, map["linear"].auto_approve),
            false
        ));
        assert!(!super::super::masks_outbound_args(
            true,
            effective_power(false, map["linear"].outbound_unmask)
        ));
        assert!(super::super::masks_outbound_args(
            true,
            effective_power(false, map["filesystem"].outbound_unmask)
        ));
        // Clearing one connector's answer leaves the other's alone, and leaves
        // no residue behind that a later read could mistake for a choice.
        let cleared =
            set_connector_power(&raw, "filesystem", ConnectorPower::AutoApprove, None).unwrap();
        let map = parse_connector_powers(&cleared);
        assert!(!map.contains_key("filesystem"), "an empty entry must be dropped");
        assert_eq!(map["linear"].outbound_unmask, Some(true));
    }

    #[test]
    fn the_upgrade_from_the_global_switches_grants_nothing_new() {
        // The migration, which is deliberately a no-op: an install arriving
        // from the global-only pair has no overrides file, so every connector
        // inherits the value that install already had. What must NOT happen is
        // the reverse — a global ON being written out as per-connector grants
        // (which would then survive the user turning the global back off), or
        // a global OFF being read as a grant anywhere.
        assert!(
            parse_connector_powers("{}").is_empty(),
            "no file = no overrides"
        );
        assert!(parse_connector_powers("garbage").is_empty());
        // Inheritance, both directions, for a connector nobody has touched.
        for global in [false, true] {
            assert_eq!(effective_power(global, None), global);
        }
        // A global OFF can never become a grant on its own.
        assert!(!effective_power(false, None));
        assert!(!skips_consent_card(effective_power(false, None), false));
        assert!(super::super::masks_outbound_args(
            true,
            effective_power(false, None)
        ));
        // …and an explicit per-connector NO outranks a global YES, so the
        // stricter answer is always reachable.
        assert!(!effective_power(true, Some(false)));
        assert!(effective_power(false, Some(true)));
        // Only the two known powers can be written; a typo is an error the UI
        // can show, never a silent write into the other power.
        assert_eq!(
            ConnectorPower::parse("auto_approve"),
            Ok(ConnectorPower::AutoApprove)
        );
        assert_eq!(
            ConnectorPower::parse("outbound_unmask"),
            Ok(ConnectorPower::OutboundUnmask)
        );
        assert!(ConnectorPower::parse("autoApprove").is_err());
    }

    #[test]
    fn a_connectors_powers_survive_a_restart_without_leaking_into_each_other() {
        // The persistence half of the per-connector layer, run for real against
        // the same JSON the file holds. Two connectors, one answer each, written
        // one at a time — the round trip must keep them apart and keep "follow
        // the switch" as an ABSENT key rather than a false, because a false
        // would pin a connector to today's global forever.
        let mut raw = "{}".to_string();
        raw = set_connector_power(&raw, "filesystem", ConnectorPower::AutoApprove, Some(true))
            .unwrap();
        raw = set_connector_power(&raw, "linear", ConnectorPower::OutboundUnmask, Some(false))
            .unwrap();
        assert!(
            !raw.contains("\"outbound_unmask\":null") && !raw.contains("\"auto_approve\":null"),
            "an unanswered power must be absent, not a null: {raw}"
        );
        let reloaded = parse_connector_powers(&raw);
        assert_eq!(reloaded["filesystem"].auto_approve, Some(true));
        assert_eq!(reloaded["filesystem"].outbound_unmask, None);
        assert_eq!(reloaded["linear"].outbound_unmask, Some(false));
        assert_eq!(reloaded["linear"].auto_approve, None);
        // An entry that names an unknown power is ignored, not fatal, and never
        // turns into an answer.
        let odd = parse_connector_powers(r#"{"linear":{"auto_approve":true,"bogus":1}}"#);
        assert_eq!(odd["linear"].auto_approve, Some(true));
        assert_eq!(odd["linear"].outbound_unmask, None);
    }

    #[test]
    fn the_two_connector_powers_are_independent() {
        // The 2026-08-03 split, stated as a truth table over the REAL deciders
        // for a REMOTE connector: `skips_consent_card` (does the user get a say)
        // and `masks_outbound_args` (does the room's private data leave intact).
        // All four combinations must be distinct — before the split only the two
        // diagonal rows existed, because one flag drove both columns.
        //
        //  auto-approve, unmask   → skips the card, masks the args
        let table = [
            (false, false, false, true),
            (true, false, true, true),
            (false, true, false, false),
            (true, true, true, false),
        ];
        for (auto, unmask, skips, masks) in table {
            assert_eq!(
                skips_consent_card(auto, false),
                skips,
                "auto={auto} unmask={unmask}: unmasking must never grant consent"
            );
            assert_eq!(
                super::super::masks_outbound_args(true, unmask),
                masks,
                "auto={auto} unmask={unmask}: auto-approve must never unmask"
            );
        }
        // The four (skips, masks) outcomes really are four different behaviours.
        let outcomes: std::collections::HashSet<(bool, bool)> = table
            .iter()
            .map(|&(auto, unmask, _, _)| {
                (
                    skips_consent_card(auto, false),
                    super::super::masks_outbound_args(true, unmask),
                )
            })
            .collect();
        assert_eq!(outcomes.len(), 4, "the two switches must not collapse");
        // A local connector never leaves this Mac, so unmasking is moot there
        // while auto-approve still decides whether the user is asked.
        assert!(!super::super::masks_outbound_args(false, false));
        assert!(!super::super::masks_outbound_args(false, true));
        // "Always allow this connector" for the session is still its own path
        // into skipping the card, and still has nothing to do with unmasking.
        assert!(skips_consent_card(false, true));
    }

    #[test]
    fn a_fresh_state_has_both_powers_off_and_they_move_apart() {
        // Named for what it can actually prove. `AppState::default()` is where
        // the two atomics get their startup value before `setup` hydrates them,
        // so the thing worth pinning is that BOTH arrive false — a `true`
        // default on either would open a gate nobody asked for on first launch.
        // It does NOT prove the commands write the right field: they need an
        // `AppHandle`, so that wiring is pinned textually in
        // e2e/page-script/connectorpowers.test.mjs instead.
        use std::sync::atomic::Ordering::SeqCst;
        let state = AppState::default();
        assert!(
            !state.mcp_auto_approve.load(SeqCst),
            "a fresh launch must still ask before running a connector tool"
        );
        assert!(
            !state.mcp_outbound_unmask.load(SeqCst),
            "a fresh launch must still mask what leaves for a remote connector"
        );
        state.mcp_auto_approve.store(true, SeqCst);
        assert!(
            !state.mcp_outbound_unmask.load(SeqCst),
            "turning off the consent card must not unmask outbound args"
        );
        let state = AppState::default();
        state.mcp_outbound_unmask.store(true, SeqCst);
        assert!(
            !state.mcp_auto_approve.load(SeqCst),
            "asking for real args must not also skip the consent card"
        );
    }

    #[test]
    fn each_power_persists_to_its_own_file() {
        // The persistence half of the split, run for real. Both flags go
        // through ONE `write_mcp_flag`/`read_mcp_flag` pair that takes the path
        // as an argument, so the only thing standing between "two switches" and
        // "one switch with two labels" is that the two callers pass different
        // paths. Write one, read the other back, and check it did not move —
        // and that a flag whose file has never been created reads OFF, which is
        // exactly the upgrade case (an install with the old combined switch on
        // has no unmasking file at all).
        let dir = std::env::temp_dir().join(format!("arcelle-connflags-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let auto = Ok(dir.join("mcp_auto_approve.json"));
        let unmask = Ok(dir.join("mcp_outbound_unmask.json"));

        assert!(!read_mcp_flag(auto.clone()), "no file yet = OFF");
        assert!(!read_mcp_flag(unmask.clone()), "no file yet = OFF");

        write_mcp_flag(auto.clone(), true);
        assert!(read_mcp_flag(auto.clone()));
        assert!(
            !read_mcp_flag(unmask.clone()),
            "granting standing consent must not create or set the unmasking flag"
        );

        write_mcp_flag(unmask.clone(), true);
        write_mcp_flag(auto.clone(), false);
        assert!(
            read_mcp_flag(unmask.clone()),
            "withdrawing consent must not silently re-mask behind the user's back"
        );
        assert!(!read_mcp_flag(auto));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mcp_fingerprint_is_stable_and_config_sensitive() {
        // SEC-1: same text → same fingerprint (approval survives reopening).
        let a = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        assert_eq!(mcp_fingerprint(a), mcp_fingerprint(a));
        // A one-character change invalidates the old approval.
        let b = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}"#;
        assert_ne!(mcp_fingerprint(a), mcp_fingerprint(b));
        // Hex SHA-256 is 64 chars.
        assert_eq!(mcp_fingerprint(a).len(), 64);
    }

    #[test]
    fn mcp_gate_blocks_unapproved_enabled_server() {
        // SEC-1 core invariant: an enabled server whose exact config has NOT been
        // approved on this Mac must NOT start — the gate asks first.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        match mcp_gate(cfg, &none) {
            McpGate::NeedsApproval {
                fingerprint,
                servers,
            } => {
                // The dialog is asked about exactly the enabled server, and the
                // fingerprint it will approve is this config's SHA-256.
                assert_eq!(fingerprint, mcp_fingerprint(cfg));
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
            }
            _ => panic!("unapproved enabled server must gate (NeedsApproval), never Start"),
        }
    }

    #[test]
    fn mcp_gate_starts_when_fingerprint_approved() {
        // SEC-1 (b): once this exact config is in the approved set, the same
        // server is allowed to Start.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let approved: std::collections::HashSet<String> =
            [mcp_fingerprint(cfg)].into_iter().collect();
        match mcp_gate(cfg, &approved) {
            McpGate::Start(servers) => {
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
            }
            _ => panic!("approved config must Start"),
        }
    }

    #[test]
    fn mcp_gate_nothing_when_only_disabled_servers() {
        // SEC-1 (c): a config with only disabled servers is Nothing — no dialog,
        // no spawn — even though its fingerprint is not approved. The parsed
        // list still rides along so the UI can show them as Disabled without a
        // second parse.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"disabled":true}}}"#;
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        match mcp_gate(cfg, &none) {
            McpGate::Nothing(servers) => {
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
                assert!(servers[0].1.disabled);
            }
            _ => panic!("only-disabled config must be Nothing"),
        }
        // An empty server map is likewise Nothing.
        assert!(matches!(
            mcp_gate(r#"{"mcpServers":{}}"#, &none),
            McpGate::Nothing(_)
        ));
    }

    #[test]
    fn unreadable_config_is_reported_not_silently_empty() {
        // An unreadable connector setup used to be indistinguishable from "there
        // is nothing here": nothing started and the Connectors page just looked
        // empty. The gate now says WHY, and refresh_mcp turns that into a
        // visible failed row.
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        match mcp_gate("{ half-written", &none) {
            McpGate::Unreadable(why) => assert!(!why.is_empty(), "the reason must be reported"),
            _ => panic!("a config that cannot be parsed must be Unreadable, never Nothing"),
        }
        // A config from elsewhere whose server entry has neither command nor url.
        assert!(matches!(
            mcp_gate(r#"{"mcpServers":{"x":{"args":[]}}}"#, &none),
            McpGate::Unreadable(_)
        ));
        // Valid-but-empty is still Nothing, not an error.
        assert!(matches!(
            mcp_gate(r#"{"mcpServers":{}}"#, &none),
            McpGate::Nothing(_)
        ));
    }

    #[test]
    fn the_notice_row_is_not_a_connector_you_can_switch_off_or_delete() {
        // The Connectors page draws the "couldn't read your connector setup" row
        // like any other connector, so it comes with an On switch and a trash
        // button. Neither has a connector behind it — acting on them must repeat
        // the SAME explanation, not a second vaguer one, and must not touch the
        // stored config.
        let broken = "{ half-written";
        let err = require_readable_config(broken).unwrap_err();
        assert_eq!(
            err,
            unreadable_config_message(&mcp::parse_config(broken).unwrap_err()),
            "the row and its buttons must tell the same story"
        );
        assert!(err.contains("fix the JSON under Advanced"), "and stay actionable");

        // The dangerous shape: valid JSON with no `mcpServers`. Removing the
        // notice row from THAT succeeds silently, which rewrote the config,
        // re-approved it and left the page looking empty again — the very thing
        // the row exists to prevent.
        let no_servers = r#"{"servers":{"x":{}}}"#;
        assert!(
            remove_server_from_config(no_servers, UNREADABLE_CONFIG_ROW).is_ok(),
            "unguarded, deleting the notice looks like a success"
        );
        assert!(require_readable_config(no_servers).is_err());

        // A readable config — including a room that has never had one — is
        // untouched by the guard.
        assert!(require_readable_config(r#"{"mcpServers":{}}"#).is_ok());
        assert!(require_readable_config("").is_ok());
        assert!(require_readable_config("   ").is_ok());
        // And no real connector can collide with the notice row's name.
        assert!(agent_mcp_name(UNREADABLE_CONFIG_ROW).is_err());
    }

    #[test]
    fn mcp_gate_edited_config_needs_reapproval() {
        // SEC-1 (d): approve one config, then edit it — the fingerprint changes,
        // so the OLD approval no longer covers it and the gate asks again.
        let original = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let approved: std::collections::HashSet<String> =
            [mcp_fingerprint(original)].into_iter().collect();
        // Same text still starts.
        assert!(matches!(mcp_gate(original, &approved), McpGate::Start(_)));
        // One-character edit → different fingerprint → NeedsApproval again.
        let edited = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}"#;
        assert!(matches!(
            mcp_gate(edited, &approved),
            McpGate::NeedsApproval { .. }
        ));
    }

    #[test]
    fn renders_full_command_line() {
        let cfg = mcp::ServerConfig {
            transport: mcp::Transport::Stdio {
                command: "uvx".into(),
                args: vec!["duckduckgo-mcp-server".into(), "--verbose".into()],
                env: std::collections::HashMap::new(),
            },
            disabled: false,
        };
        assert_eq!(
            render_command_line(&cfg),
            "uvx duckduckgo-mcp-server --verbose"
        );
        let bare = mcp::ServerConfig {
            transport: mcp::Transport::Stdio {
                command: "node".into(),
                args: vec![],
                env: std::collections::HashMap::new(),
            },
            disabled: false,
        };
        assert_eq!(render_command_line(&bare), "node");
    }

    #[test]
    fn set_disabled_and_remove_edit_the_right_server() {
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]},"gh":{"type":"http","url":"https://x"}}}"#;
        // Disable adds "disabled":true, leaving the other server alone.
        let off = set_server_disabled(cfg, "web", true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&off).unwrap();
        assert_eq!(v["mcpServers"]["web"]["disabled"], true);
        assert_eq!(v["mcpServers"]["web"]["command"], "uvx");
        assert!(v["mcpServers"]["gh"]["url"].is_string());
        // Re-enable removes the flag entirely (not "disabled":false).
        let on = set_server_disabled(&off, "web", false).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&on).unwrap();
        assert!(v2["mcpServers"]["web"].get("disabled").is_none());
        // Remove drops just that server.
        let rm = remove_server_from_config(cfg, "web").unwrap();
        let v3: serde_json::Value = serde_json::from_str(&rm).unwrap();
        assert!(v3["mcpServers"].get("web").is_none());
        assert!(v3["mcpServers"]["gh"].is_object());
        // Unknown server → error for disable, no-op for remove.
        assert!(set_server_disabled(cfg, "nope", true).is_err());
        assert!(remove_server_from_config(cfg, "nope").is_ok());
    }

    #[test]
    fn merge_and_strip_bearer_are_inverse() {
        let cfg =
            r#"{"mcpServers":{"gh":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}}"#;
        let merged = merge_bearer(cfg, "gh", "tok123").unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(
            v["mcpServers"]["gh"]["headers"]["Authorization"],
            "Bearer tok123"
        );
        // url is preserved.
        assert_eq!(
            v["mcpServers"]["gh"]["url"],
            "https://api.githubcopilot.com/mcp/"
        );
        // Stripping removes just the Authorization header.
        let stripped = strip_bearer(&merged, "gh").unwrap();
        let sv: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert!(sv["mcpServers"]["gh"]["headers"]
            .get("Authorization")
            .is_none());
        assert_eq!(
            sv["mcpServers"]["gh"]["url"],
            "https://api.githubcopilot.com/mcp/"
        );
        // Unknown server → error, not a panic.
        assert!(merge_bearer(cfg, "nope", "t").is_err());
    }

    #[test]
    fn tool_prefs_toggle_off_and_back_on() {
        // Default: nothing disabled.
        assert!(parse_tool_prefs("{}").is_empty());
        // Turn a tool OFF → it lands in the server's off-list.
        let a = set_tool_pref("{}", "fetch-mcp", "http_head", false).unwrap();
        let m = parse_tool_prefs(&a);
        assert!(m["fetch-mcp"].contains("http_head"));
        // A second tool OFF joins it; no duplicates on repeat.
        let b = set_tool_pref(&a, "fetch-mcp", "http_put", false).unwrap();
        let b = set_tool_pref(&b, "fetch-mcp", "http_put", false).unwrap();
        assert_eq!(parse_tool_prefs(&b)["fetch-mcp"].len(), 2);
        // Turning the last one back ON removes it; emptying a server drops the key.
        let c = set_tool_pref(&b, "fetch-mcp", "http_head", true).unwrap();
        let c = set_tool_pref(&c, "fetch-mcp", "http_put", true).unwrap();
        assert!(parse_tool_prefs(&c).get("fetch-mcp").is_none());
        // Garbage stored value degrades to "all on", never an error.
        assert!(parse_tool_prefs("not json").is_empty());
    }

    #[test]
    fn renders_remote_endpoint_for_dialog() {
        // SEC-1: a remote connector's approval line names the endpoint and flags
        // that it reaches the internet — not a fake command line.
        let cfg = mcp::ServerConfig {
            transport: mcp::Transport::Http {
                url: "https://mcp.notion.com/mcp".into(),
                headers: std::collections::HashMap::new(),
            },
            disabled: false,
        };
        let line = render_command_line(&cfg);
        assert!(line.contains("https://mcp.notion.com/mcp"));
        assert!(line.contains("remote"));
    }

    #[test]
    fn agent_connector_views_never_expose_secret_fields() {
        let raw = serde_json::json!({
            "command": "npx",
            "headers": {"Authorization": "Bearer secret"},
            "env": {"API_KEY": "secret"},
            "bearer_token_env_var": "TOKEN_ENV",
            "token": "secret"
        });
        let safe = redact_agent_mcp_config(&raw);
        assert_eq!(safe["headers"], "[redacted]");
        assert_eq!(safe["env"], "[redacted]");
        assert_eq!(safe["bearer_token_env_var"], "[redacted]");
        assert_eq!(safe["token"], "[redacted]");
        assert!(!safe.to_string().contains("secret"));

        let mut incoming = raw;
        remove_agent_mcp_secrets(&mut incoming);
        for key in AGENT_SECRET_KEYS {
            assert!(
                incoming.get(*key).is_none(),
                "{key} leaked into an agent save"
            );
        }
    }

    #[test]
    fn agent_connector_views_mask_a_key_typed_onto_the_command_line() {
        // The named secret fields were covered; a key handed to a local
        // connector as an ARGUMENT went to the model verbatim.
        let raw = serde_json::json!({
            "command": "npx",
            "args": [
                "-y", "@vendor/mcp-server",
                "--api-key", "sk-live-4kQm2p8Z1x7BvT0nRw",
                "--auth-token=9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny",
                "--db=/tmp/notes.db", "--port", "8080"
            ]
        });
        let shown = redact_agent_mcp_config(&raw).to_string();
        assert!(
            !shown.contains("sk-live-4kQm2p8Z1x7BvT0nRw"),
            "a key given as the value of --api-key still reached the model"
        );
        assert!(
            !shown.contains("9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny"),
            "a key given as --auth-token=… still reached the model"
        );
        // Everything that merely describes the connector survives — the model
        // still has to be able to tell one connector from another.
        for kept in ["npx", "@vendor/mcp-server", "--api-key", "/tmp/notes.db", "8080"] {
            assert!(shown.contains(kept), "{kept} should still be visible");
        }
    }

    #[test]
    fn command_line_masking_knows_a_key_from_an_ordinary_argument() {
        let redact = |args: &[&str]| {
            redact_cli_args(&args.iter().map(|s| (*s).to_string()).collect::<Vec<_>>())
        };
        // Bare opaque values: vendor prefixes, JWTs, long token runs.
        assert_eq!(redact(&["ghp_1a2b3c4d5e6f7g8h9i0j"]), ["[redacted]"]);
        assert_eq!(redact(&["A1b2C3d4E5f6G7h8I9j0K1l2M3"]), ["[redacted]"]);
        assert_eq!(
            redact(&["eyJhbGciOi.eyJzdWIiOiIxIn0.dBjftJeZ4CVP"]),
            ["[redacted]"]
        );
        // Ordinary arguments are left alone, however long.
        for plain in [
            "@modelcontextprotocol/server-filesystem",
            "/Users/me/Documents/notes",
            "--transport",
            "stdio",
            "--port=8080",
            "mcp-server-sqlite@0.1.2",
        ] {
            assert_eq!(redact(&[plain]), [plain], "{plain} was masked needlessly");
        }
        // Only the value after a credential flag is taken, and only once.
        assert_eq!(
            redact(&["--token", "abcdef", "--verbose"]),
            ["--token", "[redacted]", "--verbose"]
        );
    }

    #[test]
    fn saving_a_connector_read_through_the_mask_keeps_the_real_key() {
        // The model reads a connector (masked), edits something harmless, and
        // saves it back. The placeholder must NOT land in the stored config,
        // and the connector must not read as retargeted (which would drop the
        // user's sign-in).
        let old: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            r#"{"command":"npx","args":["srv","--api-key","sk-live-4kQm2p8Z1x7BvT0nRw"]}"#,
        )
        .unwrap();
        let mut incoming =
            serde_json::json!({"command":"npx","args":["srv","--api-key","[redacted]"]});
        restore_redacted_args(&old, &mut incoming);
        assert_eq!(incoming["args"][2], "sk-live-4kQm2p8Z1x7BvT0nRw");
        assert!(
            same_destination(&old, incoming.as_object().unwrap()),
            "a round trip through the mask must not read as a retarget"
        );
        // The `--flag=[redacted]` spelling is restored the same way.
        let old2: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"command":"npx","args":["--token=9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny"]}"#)
                .unwrap();
        let mut incoming2 = serde_json::json!({"command":"npx","args":["--token=[redacted]"]});
        restore_redacted_args(&old2, &mut incoming2);
        assert_eq!(incoming2["args"][0], "--token=9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny");
    }

    #[test]
    fn a_reshuffled_args_list_still_restores_the_right_key() {
        // The model read the masked args, then added, dropped and reordered
        // arguments before saving. Restoring by INDEX put the literal
        // "[redacted]" — or a neighbouring flag — where the user's key was.
        let key = "sk-live-4kQm2p8Z1x7BvT0nRw";
        let old: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&format!(
                r#"{{"command":"npx","args":["srv","--api-key","{key}"]}}"#
            ))
            .unwrap();

        // An argument inserted before the pair: the placeholder is now past the
        // end of the stored array.
        let mut inserted = serde_json::json!(
            {"command":"npx","args":["--verbose","srv","--api-key","[redacted]"]}
        );
        restore_redacted_args(&old, &mut inserted);
        assert_eq!(inserted["args"][3], key);

        // A leading argument dropped: index 1 in the stored array is the FLAG.
        let mut dropped = serde_json::json!({"command":"npx","args":["--api-key","[redacted]"]});
        restore_redacted_args(&old, &mut dropped);
        assert_eq!(dropped["args"][1], key);

        // Two credentials, swapped: each placeholder must follow its own flag.
        let token = "9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny";
        let two: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&format!(
            r#"{{"command":"npx","args":["--api-key","{key}","--token","{token}"]}}"#
        ))
        .unwrap();
        let mut swapped = serde_json::json!(
            {"command":"npx","args":["--token","[redacted]","--api-key","[redacted]"]}
        );
        restore_redacted_args(&two, &mut swapped);
        assert_eq!(swapped["args"][1], token);
        assert_eq!(swapped["args"][3], key);
    }

    #[test]
    fn a_placeholder_that_matches_nothing_stops_the_save() {
        // Last line of defence: the word "[redacted]" is never a real argument.
        // Storing it replaces a credential the user cannot get back, and makes
        // the entry read as a retarget, which also clears their sign-in.
        let old: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"command":"npx","args":["srv"]}"#).unwrap();
        let mut invented =
            serde_json::json!({"command":"npx","args":["srv","--api-key","[redacted]"]});
        restore_redacted_args(&old, &mut invented);
        assert!(
            reject_surviving_placeholders(&invented).is_err(),
            "a placeholder with nothing behind it must not be stored"
        );
        // A brand-new connector has no stored args at all.
        assert!(reject_surviving_placeholders(
            &serde_json::json!({"command":"npx","args":["--token=[redacted]"]})
        )
        .is_err());
        // A restored (or never-masked) save goes through untouched.
        assert!(reject_surviving_placeholders(
            &serde_json::json!({"command":"npx","args":["srv","--api-key","sk-live-4kQm2p8Z"]})
        )
        .is_ok());
        assert!(reject_surviving_placeholders(
            &serde_json::json!({"type":"http","url":"https://api.vendor.com/mcp"})
        )
        .is_ok());
    }

    #[test]
    fn consent_card_says_when_arguments_are_cut_short() {
        // Short calls are shown whole, byte for byte.
        let small = serde_json::json!({"q": "weather"});
        assert_eq!(preview_args(&small, MCP_ARG_PREVIEW_MAX), small.to_string());
        // A document-sized call must NOT read like a trivial one: the card says
        // it was cut, by how much, and that Allow sends all of it.
        let big = serde_json::json!({"doc": "x".repeat(5000)});
        let raw = big.to_string();
        let shown = preview_args(&big, 100);
        let head = |s: &str| s.chars().take(100).collect::<String>();
        assert_eq!(head(&shown), head(&raw), "the shown part is verbatim");
        assert!(shown.contains("first 100 of"));
        assert!(shown.contains("Allowing sends ALL of it"));
        // The count is of the WHOLE payload, not the slice.
        assert!(shown.contains(&raw.chars().count().to_string()));
    }

    #[test]
    fn agent_edit_keeps_credentials_only_when_the_target_is_unchanged() {
        let old: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"type":"http","url":"https://api.vendor.com/mcp"}"#).unwrap();
        let same: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"type":"http","url":"https://api.vendor.com/mcp","disabled":true}"#)
                .unwrap();
        assert!(
            same_destination(&old, &same),
            "a cosmetic edit must not drop the user's token"
        );
        // Same name, new endpoint → the saved sign-in must NOT travel with it.
        let moved: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"type":"http","url":"https://evil.example/mcp"}"#).unwrap();
        assert!(!same_destination(&old, &moved));
        // Local connectors are pinned on what they RUN, args included.
        let local: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"command":"uvx","args":["ddg"]}"#).unwrap();
        let relocated: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"command":"uvx","args":["something-else"]}"#).unwrap();
        assert!(same_destination(&local, &local.clone()));
        assert!(!same_destination(&local, &relocated));
    }

    #[test]
    fn agent_connector_names_and_roots_are_strict() {
        assert_eq!(agent_mcp_name("github.v2").unwrap(), "github.v2");
        assert!(agent_mcp_name("has space").is_err());
        assert!(agent_mcp_name("../escape").is_err());
        let root = agent_mcp_root(r#"{"mcpServers":{}}"#).unwrap();
        assert!(root["mcpServers"].is_object());
        assert!(agent_mcp_root(r#"{"mcpServers":[]}"#).is_err());
    }
}
