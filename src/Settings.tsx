import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AiStatus, api, ENGINE_LABELS, McpServerStatus, modelLabel } from "./api";
import { CloseIcon, DownloadIcon, TrashIcon } from "./icons";

interface Props {
  ai: AiStatus | null;
  model: string;
  onModelChange: (model: string) => void;
  onModelsChanged: () => void;
  onClose: () => void;
}

interface PullProgress {
  status: string;
  percent: number | null;
}

export default function Settings({
  ai,
  model,
  onModelChange,
  onModelsChanged,
  onClose,
}: Props) {
  const [temperature, setTemperature] = useState(0.7);
  const [instructions, setInstructions] = useState("");
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [mcpConfig, setMcpConfig] = useState("");
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpError, setMcpError] = useState("");
  const [webProvider, setWebProvider] = useState("off");
  const [webEndpoint, setWebEndpoint] = useState("");
  const [webSaved, setWebSaved] = useState(false);
  const [webTesting, setWebTesting] = useState(false);
  const [webTestResult, setWebTestResult] = useState("");

  // ---- Privacy section (Wave 2) ----
  // SEC-3: per-room auto-lock choice (Workspace enforces it; here we only persist).
  const [autolock, setAutolock] = useState("15");
  // SEC-4: change password.
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwRepeat, setPwRepeat] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSaved, setPwSaved] = useState(false);

  // ADD-11: Touch ID unlock. Needs the open room's path (from room_info).
  const [roomPath, setRoomPath] = useState("");
  const [touchIdOn, setTouchIdOn] = useState(false);
  const [touchIdErr, setTouchIdErr] = useState("");
  // ADD-4: duplicate room.
  const [dupDest, setDupDest] = useState("");
  const [dupPassword, setDupPassword] = useState("");
  const [dupRepeat, setDupRepeat] = useState("");
  const [dupError, setDupError] = useState("");
  const [dupDone, setDupDone] = useState(false);
  // SEC-7: compact room.
  const [compacting, setCompacting] = useState(false);
  const [compactMsg, setCompactMsg] = useState("");
  const [compactErr, setCompactErr] = useState("");
  // ADD-3: two-step confirm for deleting a model.
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);

  useEffect(() => {
    api.getSetting("temperature").then((v) => {
      if (v != null) {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) {
          // The slider now caps at 1.0 (higher makes a small model ramble).
          // Clamp legacy saves above 1.0 once and persist the clamp (CHG-8).
          if (n > 1) {
            setTemperature(1);
            api.setSetting("temperature", "1.00");
          } else {
            setTemperature(n);
          }
        }
      }
    });
    api.getSetting("custom_instructions").then((v) => {
      if (v) setInstructions(v);
    });
    api.mcpGetConfig().then(setMcpConfig).catch(() => {});
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
    api.getSetting("web_provider").then((v) => {
      // "brave" was removed (needed an API key); those rooms now run on the
      // free DuckDuckGo provider.
      setWebProvider(v === "brave" ? "duckduckgo" : v || "off");
    });
    api.getSetting("web_endpoint").then((v) => setWebEndpoint(v || ""));
    api.getSetting("autolock_minutes").then((v) => {
      if (v) setAutolock(v);
    });
    // ADD-11: learn the open room's path, then whether Touch ID is enabled.
    api
      .roomInfo()
      .then((info) => {
        if (!info) return;
        setRoomPath(info.path);
        api.touchIdHas(info.path).then(setTouchIdOn).catch(() => {});
      })
      .catch(() => {});
    const unlisten = listen<PullProgress>("pull-progress", (e) => {
      setPullStatus(e.payload.status);
      setPullPercent(e.payload.percent);
    });
    const unlistenMcp = listen<McpServerStatus[]>("mcp-status", (e) => {
      setMcpStatuses(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
    };
  }, []);

  async function applyMcp() {
    setMcpError("");
    try {
      setMcpStatuses(await api.mcpApplyConfig(mcpConfig));
    } catch (e) {
      setMcpError(String(e));
    }
  }

  async function saveWebAccess() {
    await api.setSetting("web_provider", webProvider);
    await api.setSetting("web_endpoint", webEndpoint.trim());
    setWebSaved(true);
    window.setTimeout(() => setWebSaved(false), 1600);
  }

  /** Saves first (so what's tested is what's active), then runs one real
   * search through the backend — the model is not involved. */
  async function testWebSearch() {
    setWebTesting(true);
    setWebTestResult("");
    try {
      await saveWebAccess();
      setWebTestResult(await api.webSearchTest());
    } catch (e) {
      setWebTestResult(`✗ ${String(e)}`);
    } finally {
      setWebTesting(false);
    }
  }

  async function saveTuning() {
    setError("");
    await api.setSetting("temperature", temperature.toFixed(2));
    await api.setSetting("custom_instructions", instructions.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  async function pull() {
    const name = pullName.trim();
    if (!name || pulling) return;
    setPulling(true);
    setError("");
    setPullStatus("starting…");
    setPullPercent(null);
    try {
      await api.pullModel(name);
      setPullStatus("downloaded ✓");
      setPullName("");
      onModelsChanged();
    } catch (e) {
      setPullStatus("");
      setError(String(e));
    } finally {
      setPulling(false);
      setPullPercent(null);
    }
  }

  async function removeModel(name: string) {
    setError("");
    try {
      await api.deleteModel(name);
      onModelsChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  // ADD-3: first click arms the confirm; ✓ deletes, ✕ or a 3s timeout reverts.
  function askRemoveModel(name: string) {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setConfirmModel(name);
    confirmTimer.current = window.setTimeout(() => setConfirmModel(null), 3000);
  }

  function cancelRemoveModel() {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirmModel(null);
  }

  function confirmRemoveModel(name: string) {
    cancelRemoveModel();
    removeModel(name);
  }

  // SEC-3: persist the auto-lock choice; the Workspace timer reads it.
  function changeAutolock(value: string) {
    setAutolock(value);
    api.setSetting("autolock_minutes", value);
  }

  // SEC-4: verify + rekey via the existing command.
  async function changePassword() {
    setPwError("");
    if (pwNew !== pwRepeat) {
      setPwError("The new passwords do not match.");
      return;
    }
    if (pwNew.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    try {
      await api.changePassword(pwCurrent, pwNew);
      setPwCurrent("");
      setPwNew("");
      setPwRepeat("");
      setPwSaved(true);
      window.setTimeout(() => setPwSaved(false), 2400);
    } catch (e) {
      setPwError(String(e));
    }
  }

  // ADD-11: flip Touch ID unlock for this room. On = store the open room's
  // password in the Keychain behind biometrics; off = delete the entry.
  async function toggleTouchId() {
    setTouchIdErr("");
    try {
      if (touchIdOn) {
        await api.touchIdDisable(roomPath);
        setTouchIdOn(false);
      } else {
        await api.touchIdEnable();
        setTouchIdOn(true);
      }
    } catch (e) {
      setTouchIdErr(String(e));
    }
  }

  // ADD-4: pick a destination file for the copy.
  async function chooseDupDest() {
    const p = await api.chooseSavePath({
      defaultPath: "Copy of room.roomai",
      filters: [{ name: "Private Room Project", extensions: ["roomai"] }],
    });
    if (p) setDupDest(p);
  }

  async function duplicate() {
    setDupError("");
    if (!dupDest) {
      setDupError("Choose where to save the copy first.");
      return;
    }
    let newPassword: string | null = null;
    if (dupPassword) {
      if (dupPassword !== dupRepeat) {
        setDupError("The new passwords do not match.");
        return;
      }
      if (dupPassword.length < 8) {
        setDupError("New password must be at least 8 characters.");
        return;
      }
      newPassword = dupPassword;
    }
    try {
      await api.duplicateRoom(dupDest, newPassword);
      setDupDest("");
      setDupPassword("");
      setDupRepeat("");
      setDupDone(true);
      window.setTimeout(() => setDupDone(false), 2400);
    } catch (e) {
      setDupError(String(e));
    }
  }

  // SEC-7: reclaim space left by deleted files.
  async function compact() {
    setCompacting(true);
    setCompactMsg("");
    setCompactErr("");
    try {
      setCompactMsg(await api.compactRoom());
    } catch (e) {
      setCompactErr(String(e));
    } finally {
      setCompacting(false);
    }
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>Settings</span>
          <button className="subtle btn-ic" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="settings-body">
          <section>
            <h3>Model</h3>
            <p className="settings-hint">
              The AI that lives in this room. Everything runs locally through
              Ollama.
            </p>
            {ai?.running ? (
              <div className="model-list">
                {ai.models.map((m) => (
                  <div key={m} className={`model-row ${m === model ? "active" : ""}`}>
                    <label>
                      <input
                        type="radio"
                        name="model"
                        checked={m === model}
                        onChange={() => onModelChange(m)}
                      />
                      {modelLabel(m) ? (
                        <span className="model-label">
                          {modelLabel(m)} <span className="model-id">{m}</span>
                        </span>
                      ) : (
                        m
                      )}
                    </label>
                    {confirmModel === m ? (
                      <span className="model-confirm">
                        <span className="settings-hint">Delete?</span>
                        <button
                          className="subtle btn-ic confirm-yes"
                          title="Confirm delete"
                          onClick={() => confirmRemoveModel(m)}
                        >
                          ✓
                        </button>
                        <button
                          className="subtle btn-ic confirm-no"
                          title="Keep model"
                          onClick={cancelRemoveModel}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        className="subtle btn-ic"
                        title={m === model ? "Can't delete the active model" : "Delete model from disk"}
                        disabled={m === model}
                        onClick={() => askRemoveModel(m)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </div>
                ))}
                {ai.models.length === 0 && (
                  <div className="settings-hint">No models installed yet.</div>
                )}
              </div>
            ) : (
              <div className="settings-hint">
                Ollama is not running — start it to manage models.
              </div>
            )}
            {ai && ai.external.length > 0 && (
              <>
                <label className="settings-label">Cloud engines on this Mac</label>
                <div className="model-list">
                  {ai.external.map((e) => (
                    <div key={e} className={`model-row ${e === model ? "active" : ""}`}>
                      <label>
                        <input
                          type="radio"
                          name="model"
                          checked={e === model}
                          onChange={() => onModelChange(e)}
                        />
                        {ENGINE_LABELS[e] ?? e}
                      </label>
                    </div>
                  ))}
                </div>
                <p className="settings-hint">
                  ⚠️ Cloud engines send your questions and room context to your
                  Claude/OpenAI account — content leaves this Mac. Images stay
                  local (vision and image marking always use the local model).
                </p>
              </>
            )}
            <div className="pull-row">
              <input
                placeholder="Download a model… e.g. qwen3.5:9b, gemma3:4b"
                value={pullName}
                disabled={pulling}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pull()}
              />
              <button className="btn-ic" onClick={pull} disabled={pulling || !pullName.trim()}>
                <DownloadIcon size={14} /> {pulling ? "Downloading…" : "Download"}
              </button>
            </div>
            {(pullStatus || pullPercent != null) && (
              <div className="pull-progress">
                {pullPercent != null && (
                  <div className="pull-bar">
                    <div className="pull-bar-fill" style={{ width: `${pullPercent}%` }} />
                  </div>
                )}
                <span>
                  {pullStatus}
                  {pullPercent != null && ` — ${pullPercent.toFixed(0)}%`}
                </span>
              </div>
            )}
            <p className="settings-hint">
              Tip: on a 16 GB Mac keep one model around 4B parameters — larger
              models are smarter but slower and heavier.
            </p>
          </section>

          <section>
            <h3>Behavior</h3>
            <label className="settings-label">
              Creativity (temperature): <strong>{temperature.toFixed(2)}</strong>
            </label>
            <div className="temp-row">
              <span className="settings-hint">focused</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
              />
              <span className="settings-hint">imaginative</span>
            </div>
            <label className="settings-label">Custom instructions</label>
            <textarea
              rows={4}
              dir="auto"
              placeholder='Shape the AI&apos;s tone, e.g. "Answer briefly and formally, in Hebrew when I write Hebrew."'
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="settings-actions">
              <button className="primary" onClick={saveTuning}>
                {saved ? "Saved ✓" : "Save"}
              </button>
            </div>
          </section>

          <section>
            <h3>Privacy</h3>

            {/* SEC-3 — auto-lock */}
            <label className="settings-label">Lock automatically after</label>
            <select
              value={autolock}
              onChange={(e) => changeAutolock(e.target.value)}
            >
              <option value="off">Off — never lock by itself</option>
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="60">60 minutes</option>
            </select>
            <p className="settings-hint">
              An idle room locks itself and returns to the password screen.
            </p>

            {/* SEC-4 — change password */}
            <label className="settings-label">Change password</label>
            <div className="settings-form">
              <input
                type="password"
                placeholder="Current password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
              />
              <input
                type="password"
                placeholder="New password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
              />
              <input
                type="password"
                placeholder="Repeat new password"
                value={pwRepeat}
                onChange={(e) => setPwRepeat(e.target.value)}
              />
            </div>
            <p className="settings-hint">
              There is no recovery if you forget it.
            </p>
            {pwError && <div className="gate-error">{pwError}</div>}
            <div className="settings-actions">
              <button className="primary" onClick={changePassword}>
                {pwSaved ? "Password changed ✓" : "Change password"}
              </button>
            </div>

            {/* ADD-11 — Touch ID unlock */}
            <label className="settings-label">Touch ID unlock</label>
            <div className="settings-toggle-row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={touchIdOn}
                  onChange={toggleTouchId}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </label>
              <span>
                {touchIdOn
                  ? "This room can be unlocked with Touch ID."
                  : "Unlock this room with a fingerprint."}
              </span>
            </div>
            <p className="settings-hint">
              Your password is stored in the macOS Keychain, guarded by
              biometrics — never in the room file. Changing your password
              updates it automatically.
            </p>
            {touchIdErr && <div className="gate-error">{touchIdErr}</div>}

            {/* ADD-4 — duplicate room */}
            <label className="settings-label">Duplicate room</label>
            <p className="settings-hint">
              A full copy of this room as it is right now.
            </p>
            <div className="settings-form">
              <div className="settings-actions dup-dest-row">
                <button className="btn-ic" onClick={chooseDupDest}>
                  Choose destination…
                </button>
                {dupDest && (
                  <span className="dup-dest">{dupDest.split("/").pop()}</span>
                )}
              </div>
              <input
                type="password"
                placeholder="New password for the copy (optional)"
                value={dupPassword}
                onChange={(e) => setDupPassword(e.target.value)}
              />
              <input
                type="password"
                placeholder="Repeat new password"
                value={dupRepeat}
                onChange={(e) => setDupRepeat(e.target.value)}
              />
            </div>
            {dupError && <div className="gate-error">{dupError}</div>}
            <div className="settings-actions">
              <button className="primary" onClick={duplicate}>
                {dupDone ? "Duplicated ✓" : "Duplicate"}
              </button>
            </div>

            {/* SEC-7 — compact room */}
            <label className="settings-label">Compact room</label>
            <p className="settings-hint">
              Reclaims space left by deleted files.
            </p>
            <div className="settings-actions">
              {compactMsg && (
                <span className="settings-confirm">{compactMsg}</span>
              )}
              <button onClick={compact} disabled={compacting}>
                {compacting ? "Compacting…" : "Compact room now"}
              </button>
            </div>
            {compactErr && <div className="gate-error">{compactErr}</div>}
          </section>

          <section>
            <h3>Online features</h3>
            <p className="settings-hint">
              Give the AI two extra tools — <code>web_search</code> and{" "}
              <code>fetch_page</code> — for questions that need current or
              outside information. Off by default: while off, the tools are
              not even offered to the model.
            </p>
            <p className="settings-hint">
              ⚠️ When on, search queries and fetched pages leave this Mac (to
              the provider you pick). Your files never do.
            </p>
            <label className="settings-label">Search provider</label>
            <select
              value={webProvider}
              onChange={(e) => setWebProvider(e.target.value)}
            >
              <option value="off">Off — room stays offline</option>
              <option value="duckduckgo">DuckDuckGo — free, no key or account</option>
              <option value="searxng">SearXNG (your own instance)</option>
            </select>
            {webProvider === "duckduckgo" && (
              <p className="settings-hint">
                Uses the public duckduckgo.com results page directly — nothing
                to sign up for. Heavy use can hit a temporary rate limit; the
                AI will say so and you can just retry.
              </p>
            )}
            {webProvider === "searxng" && (
              <>
                <label className="settings-label">SearXNG instance URL</label>
                <input
                  placeholder="http://127.0.0.1:8888 or https://searx.example.org"
                  value={webEndpoint}
                  onChange={(e) => setWebEndpoint(e.target.value)}
                />
                <p className="settings-hint">
                  The instance must allow JSON results (settings.yml:{" "}
                  <code>search.formats</code> includes <code>json</code>).
                </p>
              </>
            )}
            <div className="settings-actions">
              <button
                className="subtle"
                disabled={webTesting}
                onClick={testWebSearch}
              >
                {webTesting ? "Testing…" : "Test search"}
              </button>
              <button className="primary" onClick={saveWebAccess}>
                {webSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
            {webTestResult && (
              <p className="settings-hint">{webTestResult}</p>
            )}
          </section>

          <section>
            <h3>Connections (MCP)</h3>
            <p className="settings-hint">
              Advanced: connect external tool programs with the Model Context
              Protocol — paste the same <code>mcpServers</code> config used by
              Claude Desktop or Cursor. For web search you don't need this — use{" "}
              <strong>Online features</strong> above, the one built-in search
              path. A "Could not start …" error means that server's program
              isn't installed on this Mac.
            </p>
            <p className="settings-hint">
              ⚠️ Connected tools are separate programs and can reach the
              internet — what the AI sends them leaves this room. They stay
              off unless you turn them on here, per room.
            </p>
            <textarea
              className="mcp-config"
              rows={9}
              spellCheck={false}
              value={mcpConfig}
              onChange={(e) => setMcpConfig(e.target.value)}
            />
            <div className="settings-actions">
              <button className="primary" onClick={applyMcp}>
                Save & Connect
              </button>
            </div>
            {mcpStatuses.length > 0 && (
              <div className="mcp-list">
                {mcpStatuses.map((s) => (
                  <div key={s.name} className="mcp-row">
                    <span className={`mcp-dot ${s.status}`} />
                    <strong>{s.name}</strong>
                    <span className="settings-hint">
                      {s.status === "connected" &&
                        `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}: ${s.tools.join(", ")}`}
                      {s.status === "connecting" && "connecting…"}
                      {s.status === "disabled" && "off (\"disabled\": true)"}
                      {s.status === "failed" && (s.error ?? "failed")}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {mcpError && <div className="gate-error">{mcpError}</div>}
          </section>

          {error && <div className="gate-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
