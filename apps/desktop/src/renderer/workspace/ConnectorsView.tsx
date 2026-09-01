import { ReactNode, useEffect, useId, useState } from "react";
import { api } from "../api";
import { useMcpConfig } from "../settings/useMcpConfig";
import McpMarketplace from "../settings/McpMarketplace";
import { AlertIcon } from "../icons";
import { InstalledConnectors, type ConnectorActions } from "./connectorInstalled";

/** One of the two Mac-wide powers, drawn as a card: the switch and its name,
 * the explanation, and — attached under it — the sentence saying what is in
 * force right now.
 *
 * The card's marker meaning tracks the STATE, not the control: green while
 * the protective default holds, and `riskMark` (yellow for "runs unattended",
 * red for "real values leave this Mac") the moment the door is open. The
 * switch, the note's edge and the wash all read that one custom property, so
 * a risky state cannot end up drawn in a reassuring colour.
 *
 * The <label> wraps the switch and its NAME only. It used to wrap the whole
 * 80-word explanation, which meant two things: a click anywhere in the
 * paragraph flipped a privacy switch, and the checkbox's accessible name was
 * the entire paragraph read aloud. The explanation and the state sentence are
 * now attached with `aria-describedby`, so a screen-reader user still hears
 * every word of the consequence — after the control's actual name. */
function PowerCard({
  on,
  onChange,
  title,
  hint,
  copy,
  whenOn,
  whenOff,
  riskMark,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  title: string;
  hint: string;
  copy: ReactNode;
  /** The rest of the "Currently ON …" sentence — the label itself is the tape. */
  whenOn: string;
  whenOff: string;
  /** The marker meaning while this power is ON. */
  riskMark: string;
}) {
  const id = useId();
  return (
    <div className={`conn-power nb-card ${on ? riskMark : "nb-sem-done"}`}>
      <label className="conn-power-head" title={hint}>
        <input
          type="checkbox"
          className="mkt-switch"
          checked={on}
          aria-describedby={`${id}-copy ${id}-state`}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="conn-power-title">{title}</span>
      </label>
      <p className="conn-power-copy" id={`${id}-copy`}>
        {copy}
      </p>
      <p
        className={`mkt-note${on ? " mkt-note--flag" : ""}`}
        id={`${id}-state`}
      >
        <span className="nb-tape mkt-note-tag">
          {on ? "Currently ON" : "Currently OFF"}
        </span>
        {on ? whenOn : whenOff}
      </p>
    </div>
  );
}

function ConnectorLead({ autoApprove, outboundUnmask }: { autoApprove: boolean; outboundUnmask: boolean }) {
  return (
    <p className="conn-lead">
      Give this room extra tools with the Model Context Protocol. Local connectors
      run on your Mac; remote ones reach out over the internet. Right now Arcelle{" "}
      {autoApprove
        ? "runs connector tools without asking you"
        : "asks before either starts"}
      , and{" "}
      {outboundUnmask
        ? "sends a remote one this room's real values"
        : "hides this room's private details in what it sends to a remote one"}
      . Both are switches, below — and each is only the <i>default</i>: every
      installed connector can answer either one for itself, and each says which
      answer is in force for it.
    </p>
  );
}

function ConnectorDefaults({ autoApprove, setAutoApprove, outboundUnmask, setOutboundUnmask }: {
  autoApprove: boolean;
  setAutoApprove: (value: boolean) => Promise<void>;
  outboundUnmask: boolean;
  setOutboundUnmask: (value: boolean) => Promise<void>;
}) {
  return (
    <section className="conn-section">
      <div className="conn-section-head">
        <h2>Permissions</h2>
        <span className="conn-section-note">defaults for this Mac</span>
      </div>
      <div className="conn-powers nb-frame-set">
        <PowerCard
          on={autoApprove}
          onChange={(value) => void setAutoApprove(value)}
          title="Run connector tools without asking"
          hint="Let the assistant run connector tools without stopping to ask"
          riskMark="nb-sem-pending"
          copy={
            <>
              The assistant calls them straight away instead of showing you each
              one first. This decides only <i>whether you are asked</i>; it does
              not change what the call carries.
            </>
          }
          whenOn=" for this Mac: connector calls run unattended, except where a connector below says otherwise. Turn it off to approve each one before it runs."
          whenOff=": every connector call waits for you to approve it, and shows you the exact arguments it would send — except where a connector below says otherwise."
        />
        <PowerCard
          on={outboundUnmask}
          onChange={(value) => void setOutboundUnmask(value)}
          title="Send remote connectors real values"
          hint="Send remote connectors this room's real values instead of placeholders"
          riskMark="nb-sem-urgent"
          copy={
            <>
              The names, tickers and handles this room protects go out as
              themselves instead of placeholders. That is what makes lookups work
              (a connector can't answer about “[Person A]”), and it means this
              room's private details genuinely leave for a remote connector. Local
              connectors run on your Mac, so this never applies to them.
            </>
          }
          whenOn=" for this Mac: remote connectors see real values, except where a connector below says otherwise. Turn it off to send placeholders again."
          whenOff=": remote connectors see placeholders, so a lookup about something this room protects may come back empty — unless a connector below says otherwise."
        />
      </div>
    </section>
  );
}

function MarketplaceSection({ hasInstalled, installServer, installedNames }: {
  hasInstalled: boolean;
  installServer: ReturnType<typeof useMcpConfig>["installServer"];
  installedNames: string[];
}) {
  return (
    <section className="conn-section connectors-marketplace">
      <div className="conn-section-head">
        <h2>{hasInstalled ? "Add more" : "Marketplace"}</h2>
      </div>
      <McpMarketplace installServer={installServer} installedNames={installedNames} />
    </section>
  );
}

function AdvancedConfig({ value, onChange, onApply }: {
  value: string;
  onChange: (value: string) => void;
  onApply: () => Promise<void>;
}) {
  return (
    <details className="conn-advanced">
      <summary>Advanced: paste or edit the raw config</summary>
      <div className="conn-advanced-body">
        <p className="mkt-note mkt-note--flag nb-sem-pending">
          <AlertIcon size={14} /> Connected tools are separate programs and can
          reach the internet — what the AI sends them leaves this room. This box
          also shows every key a connector holds, in clear text — including a
          sign-in token you never typed, which is written into this config for
          you. Paste the same <code>mcpServers</code> config used by Claude
          Desktop or Cursor.
        </p>
        <textarea
          className="mcp-config"
          rows={10}
          spellCheck={false}
          aria-label="Raw mcpServers config"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="conn-advanced-actions">
          <button className="primary" onClick={onApply}>Save & Connect</button>
        </div>
      </div>
    </details>
  );
}

/** The Connectors area (activity rail → "connectors"): manage installed MCP
 * connectors — enable/disable and remove — and browse the marketplace to add
 * more. Moved out of Settings so connectors are a first-class product area. */
export default function ConnectorsView() {
  const config = useMcpConfig();
  const [toolPrefs, setToolPrefs] = useState<Record<string, string[]>>({});
  const [toolError, setToolError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  useEffect(() => {
    api
      .mcpGetToolPrefs()
      .then((prefs) => {
        setToolPrefs(prefs);
        setToolError("");
      })
      .catch((error) =>
        setToolError(
          `Couldn't read which connector tools are turned off (${String(error)}). The switches below may not match what is saved.`,
        ),
      );
  }, []);
  const toggleTool = (server: string, tool: string, enabled: boolean) =>
    void api
      .mcpSetToolEnabled(server, tool, enabled)
      .then((prefs) => {
        setToolPrefs(prefs);
        setToolError("");
      })
      .catch((error) =>
        setToolError(`Couldn't change ${server}'s ${tool}: ${String(error)}`),
      );
  const actions: ConnectorActions = {
    setServerEnabled: config.setServerEnabled,
    removeServer: config.removeServer,
    setConnectorPower: config.setConnectorPower,
    toggleTool,
  };
  return (
    <div className="connectors-page" data-agent-blocked>
      <div className="conn-inner">
        <header className="conn-masthead">
          <h1 className="conn-title">Connectors</h1>
          <ConnectorLead
            autoApprove={config.autoApprove}
            outboundUnmask={config.outboundUnmask}
          />
        </header>
        <ConnectorDefaults
          autoApprove={config.autoApprove}
          setAutoApprove={config.setAutoApprove}
          outboundUnmask={config.outboundUnmask}
          setOutboundUnmask={config.setOutboundUnmask}
        />
        <InstalledConnectors
          statuses={config.mcpStatuses}
          toolPrefs={toolPrefs}
          autoApprove={config.autoApprove}
          outboundUnmask={config.outboundUnmask}
          connectorPowers={config.connectorPowers}
          confirmRemove={confirmRemove}
          setConfirmRemove={setConfirmRemove}
          actions={actions}
          error={config.mcpError}
          toolError={toolError}
        />
        <MarketplaceSection
          hasInstalled={config.mcpStatuses.length > 0}
          installServer={config.installServer}
          installedNames={config.installedNames}
        />
        <AdvancedConfig
          value={config.mcpConfig}
          onChange={config.setMcpConfig}
          onApply={config.applyMcp}
        />
      </div>
    </div>
  );
}
