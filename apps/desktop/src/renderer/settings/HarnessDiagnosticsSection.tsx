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
      <DiagnosticsReport report={report} />
      <DiagnosticsError error={error} />
      <DiagnosticsAction testing={testing} onTest={test} />
    </section>
  );
}

function DiagnosticsReport({ report }: { report: HarnessCapabilities | null }) {
  if (!report) return null;
  return (
    <>
      <p className="settings-hint">
        Room format: <strong>{roomFormatLabel(report.roomFormat)}</strong>
        {" · "}outside-room isolation: <strong>{report.outsideWorkspaceIsolation ? "available" : "not proven"}</strong>
      </p>
      <div className="harness-diagnostic-list">
        {Object.entries(report.providers).map(([id, provider]) => <ProviderDiagnostic key={id} id={id} provider={provider} />)}
      </div>
    </>
  );
}

function roomFormatLabel(roomFormat: HarnessCapabilities["roomFormat"]): string {
  if (roomFormat === "workspace-folder") return "normal folder";
  if (roomFormat === "sealed-db") return "legacy encrypted database";
  return "no open room";
}

function ProviderDiagnostic({
  id,
  provider,
}: {
  id: string;
  provider: HarnessCapabilities["providers"][string];
}) {
  const status = providerStatus(provider);
  return (
    <div className="settings-toggle-row">
      <span className={`nb-tape ${status.mark}`}>{status.label}</span>
      <span>
        <strong>{providerLabel(id, provider.harness)}</strong>
        {provider.reason && <> — {provider.reason}</>}
        {!provider.enabled && !provider.reason && <> — capability test failed</>}
      </span>
    </div>
  );
}

function providerStatus(provider: HarnessCapabilities["providers"][string]) {
  if (provider.enabled) return { label: "Ready", mark: "nb-sem-done" };
  if (provider.installed) return { label: "Blocked", mark: "nb-sem-pending" };
  return { label: "Missing", mark: "nb-sem-pending" };
}

function providerLabel(id: string, harness: string | null): string {
  if (harness !== "legacy-cli") return PROVIDER_LABELS[id] ?? id;
  return `${legacyCliName(id)} restricted CLI`;
}

function legacyCliName(id: string): string {
  if (id === "codex") return "Codex";
  if (id === "claude") return "Claude";
  return id;
}

function DiagnosticsError({ error }: { error: string }) {
  if (!error) return null;
  return <div className="gate-error" role="alert">{error}</div>;
}

function DiagnosticsAction({ testing, onTest }: { testing: boolean; onTest: () => void }) {
  return <button type="button" className="subtle" disabled={testing} onClick={onTest}>{testing ? "Testing agents…" : "Test agents again"}</button>;
}
