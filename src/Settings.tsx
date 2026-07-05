import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AiStatus,
  api,
  ENGINE_LABELS,
  McpServerStatus,
  modelLabel,
  ModelCaps,
  SttStatus,
} from "./api";
import { AlertIcon, CloseIcon, DownloadIcon, TrashIcon } from "./icons";

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
  // Guided connector form — a friendlier path than hand-editing JSON.
  const [connName, setConnName] = useState("");
  const [connCmd, setConnCmd] = useState("");
  const [connArgs, setConnArgs] = useState("");
  const [webProvider, setWebProvider] = useState("off");
  const [webEndpoint, setWebEndpoint] = useState("");
  const [webSaved, setWebSaved] = useState(false);
  const [webTesting, setWebTesting] = useState(false);
  const [webTestResult, setWebTestResult] = useState("");
  // ADD-21: "AI advisors" — let the local model delegate a hard subtask to a
  // cloud CLI, and (sub-option) give that advisor the room's connected tools.
  const [advisorsOn, setAdvisorsOn] = useState(false);
  const [advisorToolsOn, setAdvisorToolsOn] = useState(false);

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
  const [compactArmed, setCompactArmed] = useState(false);
  // ADD-3: two-step confirm for deleting a model.
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  // ADD-18: built-in dictation/transcription model (Whisper).
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [sttPercent, setSttPercent] = useState<number | null>(null);
  const [sttErr, setSttErr] = useState("");
  // ADD-18: dictation shaping (alfred's translate/intent pipeline, run on the
  // room's local model). Persisted per room.
  const [dictTranslate, setDictTranslate] = useState(false);
  const [dictMode, setDictMode] = useState("off");
  // ADD-22: per-model tool/vision abilities (Ollama /api/show), for badges and a
  // warning when the chosen model can't drive the app.
  const [caps, setCaps] = useState<ModelCaps[]>([]);
  const modelsKey = ai?.models.join(",") ?? "";
  useEffect(() => {
    if (ai?.running && ai.models.length > 0) {
      api.modelCapabilities().then(setCaps).catch(() => setCaps([]));
    } else {
      setCaps([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai?.running, modelsKey]);

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
    api.getSetting("advisors_enabled").then((v) => setAdvisorsOn(v === "on"));
    api
      .getSetting("advisor_tools_enabled")
      .then((v) => setAdvisorToolsOn(v === "on"));
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
    // ADD-18: dictation model presence + live download progress + shaping prefs.
    api.sttStatus().then(setStt).catch(() => {});
    api.getSetting("dict_translate").then((v) => setDictTranslate(v === "on"));
    api.getSetting("dict_mode").then((v) => setDictMode(v || "off"));
    const unlistenStt = api.onSttDownloadProgress((p) =>
      setSttPercent(p.percent),
    );
    return () => {
      unlisten.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
      unlistenStt.then((fn) => fn());
    };
  }, []);

  // ADD-18: download / delete the built-in dictation model.
  async function downloadStt() {
    setSttErr("");
    setSttPercent(0);
    try {
      await api.sttDownloadModel();
      setStt(await api.sttStatus());
    } catch (e) {
      setSttErr(String(e));
    } finally {
      setSttPercent(null);
    }
  }

  async function removeStt() {
    setSttErr("");
    try {
      await api.sttDeleteModel();
      setStt(await api.sttStatus());
    } catch (e) {
      setSttErr(String(e));
    }
  }

  async function applyMcp() {
    setMcpError("");
    try {
      setMcpStatuses(await api.mcpApplyConfig(mcpConfig));
    } catch (e) {
      setMcpError(String(e));
    }
  }

  // Merge the guided form's fields into the mcpServers JSON so non-technical
  // users never have to hand-write it. The raw editor below stays available
  // for anyone pasting a config from elsewhere.
  function addConnector() {
    setMcpError("");
    const name = connName.trim();
    const command = connCmd.trim();
    if (!name || !command) {
      setMcpError("Give the connector a name and a command.");
      return;
    }
    let root: { mcpServers?: Record<string, unknown> } = {};
    if (mcpConfig.trim()) {
      try {
        root = JSON.parse(mcpConfig);
      } catch {
        setMcpError(
          "The current config isn't valid JSON — fix or clear the box below before adding.",
        );
        return;
      }
    }
    const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
    const args = connArgs.trim() ? connArgs.trim().split(/\s+/) : [];
    servers[name] = args.length ? { command, args } : { command };
    root.mcpServers = servers;
    setMcpConfig(JSON.stringify(root, null, 2));
    setConnName("");
    setConnCmd("");
    setConnArgs("");
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
        <div className="settings-main">
          <nav className="settings-nav">
            {(
              [
                ["set-model", "Model"],
                ["set-behavior", "Behavior"],
                ["set-privacy", "Privacy"],
                ["set-online", "Online"],
                ["set-advisors", "AI advisors"],
                ["set-mcp", "Connections"],
              ] as [string, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="settings-nav-item"
                onClick={() =>
                  document
                    .getElementById(id)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <section id="set-model">
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
                      {(() => {
                        const cap = caps.find((c) => c.name === m);
                        if (!cap) return null;
                        return (
                          <span className="model-badges">
                            {cap.tools && (
                              <span className="model-badge" title="Can control the app: open, edit, highlight files">
                                🔧 tools
                              </span>
                            )}
                            {cap.vision && (
                              <span className="model-badge" title="Can see and mark images">
                                👁 vision
                              </span>
                            )}
                          </span>
                        );
                      })()}
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
                {(() => {
                  const sel = caps.find((c) => c.name === model);
                  if (!sel || sel.tools) return null;
                  return (
                    <p className="settings-hint model-warn">
                      <AlertIcon size={13} className="warn-ic" /> This model can chat
                      but can't control the app (open, edit, or highlight files).
                      Pick a model badged <strong>🔧 tools</strong> for full features.
                    </p>
                  );
                })()}
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
                  <AlertIcon size={13} className="warn-ic" /> Cloud engines send your questions and room context to your
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

            <label className="settings-label">Dictation &amp; transcription</label>
            <p className="settings-hint">
              Turns speech into text fully on this Mac — voice messages, and
              imported recordings/videos become searchable transcripts. The
              engine is built in; it needs a one-time model download
              {stt ? ` (~${stt.sizeMb} MB)` : ""}.
            </p>
            {stt?.installed ? (
              <div className="model-row active">
                <span>Voice model installed ✓</span>
                <button
                  className="subtle btn-ic"
                  title="Delete the dictation model from disk"
                  onClick={removeStt}
                >
                  <TrashIcon size={13} />
                </button>
              </div>
            ) : sttPercent != null || stt?.downloading ? (
              <div className="pull-progress">
                <div className="pull-bar">
                  <div
                    className="pull-bar-fill"
                    style={{ width: `${sttPercent ?? 0}%` }}
                  />
                </div>
                <span>Downloading voice model — {sttPercent ?? 0}%</span>
              </div>
            ) : (
              <button className="btn-ic" onClick={downloadStt}>
                <DownloadIcon size={14} /> Download voice model
              </button>
            )}
            {sttErr && <div className="gate-error">{sttErr}</div>}
            {stt?.installed && (
              <>
                <label className="settings-label" style={{ marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={dictTranslate}
                    onChange={(e) => {
                      setDictTranslate(e.target.checked);
                      api.setSetting(
                        "dict_translate",
                        e.target.checked ? "on" : "off",
                      );
                    }}
                  />{" "}
                  Translate dictation to English (local AI)
                </label>
                <label className="settings-label">
                  Shape dictation as{" "}
                  <select
                    value={dictMode}
                    onChange={(e) => {
                      setDictMode(e.target.value);
                      api.setSetting("dict_mode", e.target.value);
                    }}
                  >
                    <option value="off">Exact words (no shaping)</option>
                    <option value="raw">Cleaned up (remove ums, fix grammar)</option>
                    <option value="notes">Notes / bullets</option>
                    <option value="email">Email body</option>
                    <option value="message">Chat message</option>
                    <option value="commit">Commit message</option>
                    <option value="prompt">Optimized AI prompt</option>
                  </select>
                </label>
                <p className="settings-hint">
                  Shaping and translation run on this room's local AI — dictated
                  words never reach a cloud engine. If the local AI is off, the
                  exact transcript is used instead.
                </p>
              </>
            )}
          </section>

          <section id="set-behavior">
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

          <section id="set-privacy">
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
              {compactArmed ? (
                <>
                  <button
                    className="danger"
                    onClick={() => {
                      setCompactArmed(false);
                      compact();
                    }}
                    disabled={compacting}
                  >
                    {compacting ? "Compacting…" : "Confirm compact"}
                  </button>
                  <button
                    className="subtle"
                    onClick={() => setCompactArmed(false)}
                    disabled={compacting}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    setCompactMsg("");
                    setCompactArmed(true);
                  }}
                  disabled={compacting}
                >
                  Compact room now
                </button>
              )}
            </div>
            {compactErr && <div className="gate-error">{compactErr}</div>}
          </section>

          <section id="set-online">
            <h3>Online features</h3>
            <p className="settings-hint">
              Give the AI two extra tools — <code>web_search</code> and{" "}
              <code>fetch_page</code> — for questions that need current or
              outside information. Off by default: while off, the tools are
              not even offered to the model.
            </p>
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> When on, search queries and fetched pages leave this Mac (to
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

          <section id="set-advisors">
            <h3>AI advisors (advanced)</h3>
            <p className="settings-hint">
              Let your <strong>local</strong> AI hand off one genuinely hard
              subtask — deep research, complex reasoning, difficult code — to a
              powerful cloud AI (<code>consult_advisor</code>), using the cloud
              CLIs already installed on this Mac. Off by default. While off, the
              tool is not even offered to the model, so nothing can leave this
              Mac on the model's own initiative.
            </p>
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> When on, the local AI may decide — on its own, mid-answer — to
              send the subtask it writes to Claude or Codex through your cloud
              account. That text leaves this Mac. Each consult is shown as a
              step while it happens, and it's capped at one per question.
            </p>
            {ai && ai.external.length > 0 ? (
              <>
                <label className="settings-label">
                  <input
                    type="checkbox"
                    checked={advisorsOn}
                    onChange={(e) => {
                      setAdvisorsOn(e.target.checked);
                      api.setSetting(
                        "advisors_enabled",
                        e.target.checked ? "on" : "off",
                      );
                      // Turning the feature off also disables the sub-option.
                      if (!e.target.checked && advisorToolsOn) {
                        setAdvisorToolsOn(false);
                        api.setSetting("advisor_tools_enabled", "off");
                      }
                    }}
                  />{" "}
                  Enable AI advisors ({ai.external
                    .map((e) => ENGINE_LABELS[e] ?? e)
                    .join(", ")})
                </label>
                {advisorsOn && (
                  <>
                    <label className="settings-label">
                      <input
                        type="checkbox"
                        checked={advisorToolsOn}
                        onChange={(e) => {
                          setAdvisorToolsOn(e.target.checked);
                          api.setSetting(
                            "advisor_tools_enabled",
                            e.target.checked ? "on" : "off",
                          );
                        }}
                      />{" "}
                      Let a Claude advisor use this room's tools
                    </label>
                    <p className="settings-hint">
                      When consulted, the advisor can list, search, open and
                      edit this room's files — and drive any Connected tools
                      (MCP) below — through a private, one-question-long local
                      bridge. A second, separate way for content to leave this
                      Mac.
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="settings-hint">
                No cloud AI CLIs (Claude Code, Codex) were detected on this Mac.
                Install one and reopen Settings to enable advisors.
              </p>
            )}
          </section>

          <section id="set-mcp">
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
              <AlertIcon size={13} className="warn-ic" /> Connected tools are separate programs and can reach the
              internet — what the AI sends them leaves this room. They stay
              off unless you turn them on here, per room.
            </p>
            <div className="connector-form">
              <label className="settings-label">Add a connector</label>
              <input
                type="text"
                placeholder="Name (e.g. yfinance)"
                value={connName}
                onChange={(e) => setConnName(e.target.value)}
              />
              <input
                type="text"
                placeholder="Command (e.g. uvx)"
                value={connCmd}
                onChange={(e) => setConnCmd(e.target.value)}
              />
              <input
                type="text"
                placeholder="Arguments, space-separated (e.g. yfinance-mcp)"
                value={connArgs}
                onChange={(e) => setConnArgs(e.target.value)}
              />
              <div className="settings-actions">
                <button className="btn-ic" onClick={addConnector}>
                  Add to config
                </button>
              </div>
            </div>
            <details className="mcp-advanced">
              <summary>Advanced: edit the raw JSON</summary>
              <textarea
                className="mcp-config"
                rows={9}
                spellCheck={false}
                value={mcpConfig}
                onChange={(e) => setMcpConfig(e.target.value)}
              />
            </details>
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
    </div>
  );
}
