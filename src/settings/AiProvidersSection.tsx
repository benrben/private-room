import { useEffect, useState } from "react";
import { api, type AiProviderStatus } from "../api";
import { CheckIcon, CloseIcon } from "../icons";

export default function AiProvidersSection({
  model,
  fallbackModel,
  onModelChange,
  onChanged,
}: {
  model: string;
  fallbackModel: string;
  onModelChange: (model: string) => void;
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderStatus[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"good" | "error">("good");
  const openrouter = providers.find((provider) => provider.id === "openrouter");

  const refresh = () => api.listAiProviders().then(setProviders).catch(() => setProviders([]));

  useEffect(() => {
    refresh();
  }, []);

  async function connect() {
    if (!key.trim() || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const count = await api.connectAiProvider("openrouter", key);
      setKey("");
      setMessageKind("good");
      setMessage(`Connected — ${count.toLocaleString()} models available.`);
      refresh();
      onChanged();
    } catch (error) {
      setMessageKind("error");
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await api.disconnectAiProvider("openrouter");
      if (model.startsWith("openrouter::")) onModelChange(fallbackModel);
      setMessageKind("good");
      setMessage("OpenRouter disconnected. The API key was removed from Keychain.");
      refresh();
      onChanged();
    } catch (error) {
      setMessageKind("error");
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="set-ai-providers">
      <h3>AI providers</h3>
      <p className="settings-hint">
        Connect a model API with your own key. Keys are stored in macOS Keychain,
        never in the room file. Model catalogs and capabilities are read live from
        the provider.
      </p>
      <div className={`provider-card${openrouter?.connected ? " connected" : ""}`}>
        <div className="provider-card-head">
          <div>
            <strong>OpenRouter</strong>
            <div className="settings-hint">Hundreds of models through one OpenAI-compatible API.</div>
          </div>
          <span className={`provider-state${openrouter?.connected ? " connected" : ""}`}>
            {openrouter?.connected ? <><CheckIcon size={12} /> Connected</> : "Not connected"}
          </span>
        </div>
        {openrouter?.connected ? (
          <button type="button" className="subtle btn-ic" onClick={disconnect} disabled={busy}>
            <CloseIcon size={13} /> Disconnect
          </button>
        ) : (
          <div className="provider-key-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="OpenRouter API key"
              aria-label="OpenRouter API key"
              value={key}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && connect()}
            />
            <button type="button" onClick={connect} disabled={busy || !key.trim()}>
              {busy ? "Checking…" : "Connect"}
            </button>
          </div>
        )}
        {message && (
          <div className={`provider-message${messageKind === "good" ? " good" : ""}`}>
            {message}
          </div>
        )}
      </div>
      <p className="settings-hint">
        Connecting validates the key and loads the models allowed by your OpenRouter
        preferences, privacy settings, and guardrails.
      </p>
    </section>
  );
}
