import { useCallback, useEffect, useState } from "react";
import { api, type HarnessCapabilities } from "../api";

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex app-server",
  claude: "Claude Agent SDK",
  "ollama-local": "Ollama local Deep Harness",
  "ollama-cloud": "Ollama cloud Deep Harness",
  openrouter: "OpenRouter Deep Harness",
};

/** Live capability report from the same sandbox probe that gates native mode. */
export default function HarnessDiagnosticsSection() {
  const [report, setReport] = useState<HarnessCapabilities | null>(null);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);

  const test = useCallback(() => {
    setTesting(true);
    setError("");
    void api.harnessCapabilities().then(setReport).catch((reason) => {
      setReport(null);
      setError(String(reason));
    }).finally(() => setTesting(false));
  }, []);

  useEffect(test, [test]);

  return (
    <section id="set-agent-harness">
      <h3>Workspace agent diagnostics</h3>
      <p className="settings-hint">
        Codex and Claude require their native runtime and the macOS workspace
        sandbox to pass a live test. Ollama and OpenRouter use Arcelle's
        controlled Deep Harness backend and never receive database keys.
      </p>
      {report && (
        <>
          <p className="settings-hint">
            Room format: <strong>{report.roomFormat === "workspace-folder" ? "normal folder" : report.roomFormat === "sealed-db" ? "legacy encrypted database" : "no open room"}</strong>
            {" · "}outside-room isolation: <strong>{report.outsideWorkspaceIsolation ? "available" : "not proven"}</strong>
          </p>
          <div className="harness-diagnostic-list">
            {Object.entries(report.providers).map(([id, provider]) => (
              <div className="settings-toggle-row" key={id}>
                <span className={`nb-tape ${provider.enabled ? "nb-sem-done" : "nb-sem-pending"}`}>
                  {provider.enabled ? "Ready" : provider.installed ? "Blocked" : "Missing"}
                </span>
                <span>
                  <strong>{PROVIDER_LABELS[id] ?? id}</strong>
                  {!provider.enabled && <> — {provider.reason ?? "capability test failed"}</>}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <div className="gate-error" role="alert">{error}</div>}
      <button type="button" className="subtle" disabled={testing} onClick={test}>
        {testing ? "Testing agents…" : "Test agents again"}
      </button>
    </section>
  );
}
