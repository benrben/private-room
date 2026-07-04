import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AiStatus, api, ENGINE_LABELS, McpServerStatus } from "./api";
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

  useEffect(() => {
    api.getSetting("temperature").then((v) => {
      if (v != null) {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) setTemperature(n);
      }
    });
    api.getSetting("custom_instructions").then((v) => {
      if (v) setInstructions(v);
    });
    api.mcpGetConfig().then(setMcpConfig).catch(() => {});
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
    api.getSetting("web_provider").then((v) => {
      // "brave" was removed (needed an API key); treat it as off.
      setWebProvider(v === "brave" || !v ? "off" : v);
    });
    api.getSetting("web_endpoint").then((v) => setWebEndpoint(v || ""));
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
                      {m}
                    </label>
                    <button
                      className="subtle btn-ic"
                      title={m === model ? "Can't delete the active model" : "Delete model from disk"}
                      disabled={m === model}
                      onClick={() => removeModel(m)}
                    >
                      <TrashIcon size={13} />
                    </button>
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
              <span className="settings-hint">precise</span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
              />
              <span className="settings-hint">creative</span>
            </div>
            <label className="settings-label">Custom instructions</label>
            <textarea
              rows={4}
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
              <button className="primary" onClick={saveWebAccess}>
                {webSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
          </section>

          <section>
            <h3>Connections (MCP)</h3>
            <p className="settings-hint">
              Advanced: connect external tools with the Model Context Protocol
              — paste the same <code>mcpServers</code> config used by Claude
              Desktop or Cursor. For web search you don't need MCP — use{" "}
              <strong>Online features</strong> above instead. Keep{" "}
              <code>"disabled": true</code> on servers you don't use; a
              "Could not start …" error means that server's program isn't
              installed on this Mac.
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
