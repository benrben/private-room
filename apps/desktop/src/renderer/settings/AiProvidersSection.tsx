import { useEffect, useState } from "react";
import { confirm as askConfirm } from "../platform";
import { api, type AiProviderStatus } from "../api";
import { CheckIcon, CloseIcon } from "../icons";

type ProviderCardProps = {
  connected: boolean;
  keyValue: string;
  busy: boolean;
  message: string;
  messageKind: "good" | "error";
  onKeyChange: (value: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

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
  const connected = openrouter?.connected === true;

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

  /** Disconnecting DELETES the key from the Keychain and switches the room off
   * its cloud model — irreversible in one click (the key is not recoverable
   * from the app, only from OpenRouter), while every other destructive button
   * on this screen asks first. So this one asks too. */
  async function disconnect() {
    if (busy) return;
    const ok = await askConfirm(
      "This deletes your OpenRouter API key from the Keychain — the app cannot " +
        "get it back, you would have to paste it again. Any room using an " +
        "OpenRouter model switches back to the local one.",
      { title: "Disconnect OpenRouter", kind: "warning", okLabel: "Disconnect" },
    ).catch(() => false);
    if (!ok) return;
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
      <ProviderCard
        connected={connected}
        keyValue={key}
        busy={busy}
        message={message}
        messageKind={messageKind}
        onKeyChange={setKey}
        onConnect={connect}
        onDisconnect={disconnect}
      />
      {/* What "Connect" actually does, in provider terms. Detail, not a
          consequence — the sentence about where keys are stored is the
          consequence and it stays open above. */}
      <details className="set-more">
        <summary>What connecting does</summary>
        <p className="settings-hint">
          Connecting validates the key and loads the models allowed by your OpenRouter
          preferences, privacy settings, and guardrails.
        </p>
      </details>
    </section>
  );
}

function ProviderCard({
  connected,
  keyValue,
  busy,
  message,
  messageKind,
  onKeyChange,
  onConnect,
  onDisconnect,
}: ProviderCardProps) {
  return (
    <div className={`provider-card${connectedClass(connected)}`}>
      <ProviderCardHeader connected={connected} />
      <ProviderConnectionControl
        connected={connected}
        keyValue={keyValue}
        busy={busy}
        onKeyChange={onKeyChange}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />
      <ProviderMessage message={message} kind={messageKind} />
    </div>
  );
}

function ProviderCardHeader({ connected }: { connected: boolean }) {
  return (
    <div className="provider-card-head">
      <div>
        <strong>OpenRouter</strong>
        <div className="settings-hint">Hundreds of models through one OpenAI-compatible API.</div>
      </div>
      <span className={`provider-state${connectedClass(connected)}`}>
        {connected ? <><CheckIcon size={12} /> Connected</> : "Not connected"}
      </span>
    </div>
  );
}

function ProviderConnectionControl({
  connected,
  keyValue,
  busy,
  onKeyChange,
  onConnect,
  onDisconnect,
}: Pick<
  ProviderCardProps,
  "connected" | "keyValue" | "busy" | "onKeyChange" | "onConnect" | "onDisconnect"
>) {
  if (connected) {
    return (
      <button type="button" className="subtle btn-ic" onClick={onDisconnect} disabled={busy}>
        <CloseIcon size={14} /> Disconnect
      </button>
    );
  }
  return (
    <ProviderConnectControl
      keyValue={keyValue}
      busy={busy}
      onKeyChange={onKeyChange}
      onConnect={onConnect}
    />
  );
}

function ProviderConnectControl({
  keyValue,
  busy,
  onKeyChange,
  onConnect,
}: Pick<ProviderCardProps, "keyValue" | "busy" | "onKeyChange" | "onConnect">) {
  const connectDisabled = busy || !keyValue.trim();
  return (
    <div className="provider-key-row">
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="OpenRouter API key"
        aria-label="OpenRouter API key"
        value={keyValue}
        disabled={busy}
        onChange={(event) => onKeyChange(event.target.value)}
        onKeyDown={(event) => connectOnEnter(event.key, onConnect)}
      />
      <button type="button" onClick={onConnect} disabled={connectDisabled}>
        {busy ? "Checking…" : "Connect"}
      </button>
    </div>
  );
}

function ProviderMessage({ message, kind }: { message: string; kind: "good" | "error" }) {
  if (!message) return null;
  return <div className={`provider-message${kind === "good" ? " good" : ""}`}>{message}</div>;
}

function connectedClass(connected: boolean): string {
  return connected ? " connected" : "";
}

function connectOnEnter(key: string, onConnect: () => void): void {
  if (key === "Enter") onConnect();
}
