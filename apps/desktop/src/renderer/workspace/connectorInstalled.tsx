import type { McpServerStatus } from "../api";
import { AlertIcon, CloudIcon, TrashIcon } from "../icons";
import { RemoteOauthControls } from "./connectorOauth";

/* The three states of one connector's answer to one power. "follow" is a real
 * state, not a missing value: it is what every connector says until someone
 * chooses otherwise, and it is what keeps the two switches at the top of this
 * page meaning something after the settings became per-connector. */
type PowerChoice = "follow" | "on" | "off";

const choiceOf = (v: boolean | undefined): PowerChoice =>
  v === undefined ? "follow" : v ? "on" : "off";

/** The wire value for a choice — `null` clears the override. */
const valueOf = (c: PowerChoice): boolean | null =>
  c === "follow" ? null : c === "on";

/** AUDIT defect 60: the stand-in row the backend shows when a room's stored
 * connector setup cannot be parsed (`UNREADABLE_CONFIG_ROW` in mcp_cmds.rs).
 *
 * It is a NOTICE, not a connector. It arrived as a fabricated `mcp::Server`
 * and this page drew every row the same way, so the explanation came with an
 * On switch (a `failed` status counts as enabled) and a Remove button — and
 * since no connector is actually called this, pressing either just re-parsed
 * the same broken config and produced a second, vaguer error under the list.
 * The name carries a SPACE, which `agent_mcp_name` rejects, so no real
 * connector can ever collide with it. */
const NOTICE_ROW = "connector setup";

type ConnectorPower = "auto_approve" | "outbound_unmask";

export type ConnectorActions = {
  setServerEnabled: (name: string, enabled: boolean) => Promise<void>;
  removeServer: (name: string) => Promise<void>;
  setConnectorPower: (
    server: string,
    power: ConnectorPower,
    value: boolean | null,
  ) => Promise<void>;
  toggleTool: (server: string, tool: string, enabled: boolean) => void;
};

function ServerKindBadge({ remote }: { remote: boolean }) {
  const kind = remote
    ? {
        className: "nb-sem-pending",
        title: "Remote — reaches the internet",
        label: "Remote",
      }
    : {
        className: "nb-sem-done",
        title: "Local — runs on your Mac",
        label: "Local",
      };
  return (
    <span className="conn-badges">
      <span className={`nb-tape mkt-badge ${kind.className}`} title={kind.title}>
        {remote && <CloudIcon size={12} />}
        {kind.label}
      </span>
    </span>
  );
}

function ConnectionState({ status, error, onCount, toolCount }: {
  status: McpServerStatus["status"];
  error: string | null;
  onCount: number;
  toolCount: number;
}) {
  if (status === "connected") {
    return (
      <span className="conn-state">
        {onCount} of {toolCount} tool{toolCount === 1 ? "" : "s"} on
      </span>
    );
  }
  if (status === "connecting") return <span className="conn-state">connecting…</span>;
  if (status === "disabled") return <span className="conn-state">off</span>;
  return <span className="conn-state">{error ?? "failed"}</span>;
}

function serverSwitchCopy(name: string, enabled: boolean) {
  return enabled
    ? { label: `Turn ${name} off`, title: "Turn this connector off" }
    : { label: `Turn ${name} on`, title: "Turn this connector on" };
}

function ServerEnableSwitch({ name, enabled, onChange }: {
  name: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const copy = serverSwitchCopy(name, enabled);
  return (
    <input
      type="checkbox"
      className="mkt-switch"
      checked={enabled}
      title={copy.title}
      aria-label={copy.label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function ConnectorRemoval({ name, confirming, onArm, onKeep, onRemove }: {
  name: string;
  confirming: boolean;
  onArm: () => void;
  onKeep: () => void;
  onRemove: () => void;
}) {
  if (!confirming) {
    return (
      <button
        className="conn-remove"
        title="Remove this connector"
        aria-label={`Remove ${name}`}
        onClick={onArm}
      >
        <TrashIcon size={14} />
      </button>
    );
  }
  return (
    <span className="conn-confirm" role="group" aria-label={`Remove ${name}?`}>
      <span className="conn-confirm-q">Remove {name} and its saved sign-in?</span>
      <button className="danger" onClick={onRemove}>Remove</button>
      <button onClick={onKeep}>Keep</button>
    </span>
  );
}

function ConnectorCardHeader({ server, enabled, onCount, confirming, onSetEnabled, onArmRemove, onKeepRemove, onRemove }: {
  server: McpServerStatus;
  enabled: boolean;
  onCount: number;
  confirming: boolean;
  onSetEnabled: (enabled: boolean) => void;
  onArmRemove: () => void;
  onKeepRemove: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="conn-card-head">
      <span className={`conn-dot is-${server.status}`} aria-hidden="true" />
      <h3 className="conn-name">{server.name}</h3>
      <ServerKindBadge remote={server.remote} />
      <ConnectionState
        status={server.status}
        error={server.error}
        onCount={onCount}
        toolCount={server.tools.length}
      />
      <div className="conn-actions">
        <ServerEnableSwitch
          name={server.name}
          enabled={enabled}
          onChange={onSetEnabled}
        />
        <ConnectorRemoval
          name={server.name}
          confirming={confirming}
          onArm={onArmRemove}
          onKeep={onKeepRemove}
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

function FailedConnectionHelp({ status }: { status: McpServerStatus["status"] }) {
  if (status !== "failed") return null;
  return (
    <p className="mkt-note nb-sem-pending">
      <span className="nb-tape mkt-note-tag">Retry</span>
      {" — turn it off and on again to try connecting once more, or fix its entry under Advanced."}
    </p>
  );
}

function PowerInForceNote({ description, source, className }: { description: string; source: string; className: string }) {
  return (
    <p className={`mkt-note ${className}`}>
      <span className="nb-tape mkt-note-tag">In force</span>
      {": "}
      {description}
      {source}.
    </p>
  );
}

function autoPowerDetails(choice: PowerChoice, inForce: boolean) {
  return {
    className: inForce ? "mkt-note--flag nb-sem-pending" : "nb-sem-done",
    description: inForce ? "its calls run without asking you" : "every call waits for your approval",
    source: choice === "follow" ? " (from the setting above)" : " (set here, so the setting above doesn't apply)",
  };
}

function unmaskPowerDetails(choice: PowerChoice, inForce: boolean) {
  return {
    className: inForce ? "mkt-note--flag nb-sem-urgent" : "nb-sem-done",
    description: inForce ? "this room's real names and tickers leave for it" : "it sees placeholders instead of protected values",
    source: choice === "follow" ? " (from the setting above)" : " (set here, so the setting above doesn't apply)",
  };
}

function AutoApprovePermission({ server, autoApprove, choice, inForce, onChange }: {
  server: string;
  autoApprove: boolean;
  choice: PowerChoice;
  inForce: boolean;
  onChange: (choice: PowerChoice) => void;
}) {
  const detail = autoPowerDetails(choice, inForce);
  return (
    <div className="conn-perm">
      <label className="conn-perm-row">
        <span className="conn-perm-name">Run its tools without asking</span>
        <select
          value={choice}
          aria-label={`Run ${server} tools without asking`}
          onChange={(e) => onChange(e.target.value as PowerChoice)}
        >
          <option value="follow">
            Use the setting above ({autoApprove ? "don't ask" : "ask me"})
          </option>
          <option value="on">Don't ask for this connector</option>
          <option value="off">Always ask for this connector</option>
        </select>
      </label>
      <PowerInForceNote {...detail} />
    </div>
  );
}

function RemoteValuePermission({ server, outboundUnmask, choice, inForce, onChange }: {
  server: string;
  outboundUnmask: boolean;
  choice: PowerChoice;
  inForce: boolean;
  onChange: (choice: PowerChoice) => void;
}) {
  const detail = unmaskPowerDetails(choice, inForce);
  return (
    <div className="conn-perm">
      <label className="conn-perm-row">
        <span className="conn-perm-name">Send it real values</span>
        <select
          value={choice}
          aria-label={`Send ${server} real values`}
          onChange={(e) => onChange(e.target.value as PowerChoice)}
        >
          <option value="follow">
            Use the setting above ({outboundUnmask ? "real values" : "placeholders"})
          </option>
          <option value="on">Real values for this connector</option>
          <option value="off">Placeholders for this connector</option>
        </select>
      </label>
      <PowerInForceNote {...detail} />
    </div>
  );
}

function OutboundPermission({ remote, server, outboundUnmask, choice, inForce, onChange }: {
  remote: boolean;
  server: string;
  outboundUnmask: boolean;
  choice: PowerChoice;
  inForce: boolean;
  onChange: (choice: PowerChoice) => void;
}) {
  if (!remote) {
    return (
      <p className="mkt-note nb-sem-done">
        <span className="nb-tape mkt-note-tag">Local</span>
        {" — it runs on your Mac, so nothing it is told leaves here and there is no masking to decide."}
      </p>
    );
  }
  return (
    <RemoteValuePermission
      server={server}
      outboundUnmask={outboundUnmask}
      choice={choice}
      inForce={inForce}
      onChange={onChange}
    />
  );
}

function ConnectorPermissions({ enabled, server, remote, autoApprove, outboundUnmask, autoChoice, unmaskChoice, autoInForce, unmaskInForce, onSetPower }: {
  enabled: boolean;
  server: string;
  remote: boolean;
  autoApprove: boolean;
  outboundUnmask: boolean;
  autoChoice: PowerChoice;
  unmaskChoice: PowerChoice;
  autoInForce: boolean;
  unmaskInForce: boolean;
  onSetPower: (power: ConnectorPower, choice: PowerChoice) => void;
}) {
  if (!enabled) return null;
  return (
    <div className="conn-perms">
      <AutoApprovePermission
        server={server}
        autoApprove={autoApprove}
        choice={autoChoice}
        inForce={autoInForce}
        onChange={(choice) => onSetPower("auto_approve", choice)}
      />
      <OutboundPermission
        remote={remote}
        server={server}
        outboundUnmask={outboundUnmask}
        choice={unmaskChoice}
        inForce={unmaskInForce}
        onChange={(choice) => onSetPower("outbound_unmask", choice)}
      />
    </div>
  );
}

function ConnectorTool({ server, tool, disabledTools, onToggle }: {
  server: string;
  tool: string;
  disabledTools: string[];
  onToggle: (server: string, tool: string, enabled: boolean) => void;
}) {
  const enabled = !disabledTools.includes(tool);
  return (
    <label className="conn-tool" title={enabled ? "On" : "Off"}>
      <input
        type="checkbox"
        className="mkt-switch"
        checked={enabled}
        onChange={(e) => onToggle(server, tool, e.target.checked)}
      />
      <code>{tool}</code>
    </label>
  );
}

function ConnectorTools({ enabled, server, tools, disabledTools, onCount, onToggle }: {
  enabled: boolean;
  server: string;
  tools: string[];
  disabledTools: string[];
  onCount: number;
  onToggle: (server: string, tool: string, enabled: boolean) => void;
}) {
  if (!enabled || !tools.length) return null;
  return (
    <details className="conn-tools">
      <summary>Tools ({onCount}/{tools.length})</summary>
      <p className="conn-tools-hint">
        Every tool you leave on is available to the assistant — it searches them
        by name when it needs one, so a large connector costs nothing until it&apos;s
        used. Turn off any you&apos;d rather it never reach.
      </p>
      <div className="conn-tool-list">
        {tools.map((tool) => (
          <ConnectorTool
            key={tool}
            server={server}
            tool={tool}
            disabledTools={disabledTools}
            onToggle={onToggle}
          />
        ))}
      </div>
    </details>
  );
}

function ConnectorNotice({ error }: { error: string | null }) {
  return (
    <div className="conn-card conn-notice nb-card nb-sem-urgent" role="status">
      <AlertIcon size={16} />
      <p className="conn-notice-text">
        {error ?? "This room's connector setup could not be read."}
      </p>
    </div>
  );
}

function InstalledConnector({ server, disabledTools, autoApprove, outboundUnmask, connectorPowers, confirmRemove, setConfirmRemove, actions }: {
  server: McpServerStatus;
  disabledTools: string[];
  autoApprove: boolean;
  outboundUnmask: boolean;
  connectorPowers: Record<string, { auto_approve?: boolean; outbound_unmask?: boolean }>;
  confirmRemove: string;
  setConfirmRemove: (name: string) => void;
  actions: ConnectorActions;
}) {
  const enabled = server.status !== "disabled";
  const override = connectorPowers[server.name] ?? {};
  const autoChoice = choiceOf(override.auto_approve);
  const unmaskChoice = choiceOf(override.outbound_unmask);
  const autoInForce = override.auto_approve ?? autoApprove;
  const unmaskInForce = override.outbound_unmask ?? outboundUnmask;
  const onCount = server.tools.filter((tool) => !disabledTools.includes(tool)).length;
  const setPower = (power: ConnectorPower, choice: PowerChoice) =>
    void actions.setConnectorPower(server.name, power, valueOf(choice));
  return (
    <article className="conn-card nb-card">
      <ConnectorCardHeader
        server={server}
        enabled={enabled}
        onCount={onCount}
        confirming={confirmRemove === server.name}
        onSetEnabled={(next) => void actions.setServerEnabled(server.name, next)}
        onArmRemove={() => setConfirmRemove(server.name)}
        onKeepRemove={() => setConfirmRemove("")}
        onRemove={() => {
          setConfirmRemove("");
          void actions.removeServer(server.name);
        }}
      />
      <FailedConnectionHelp status={server.status} />
      {server.remote && <RemoteOauthControls server={server.name} />}
      <ConnectorPermissions
        enabled={enabled}
        server={server.name}
        remote={server.remote}
        autoApprove={autoApprove}
        outboundUnmask={outboundUnmask}
        autoChoice={autoChoice}
        unmaskChoice={unmaskChoice}
        autoInForce={autoInForce}
        unmaskInForce={unmaskInForce}
        onSetPower={setPower}
      />
      <ConnectorTools
        enabled={enabled}
        server={server.name}
        tools={server.tools}
        disabledTools={disabledTools}
        onCount={onCount}
        onToggle={actions.toggleTool}
      />
    </article>
  );
}

function ConnectorRow({ server, disabledTools, autoApprove, outboundUnmask, connectorPowers, confirmRemove, setConfirmRemove, actions }: {
  server: McpServerStatus;
  disabledTools: string[];
  autoApprove: boolean;
  outboundUnmask: boolean;
  connectorPowers: Record<string, { auto_approve?: boolean; outbound_unmask?: boolean }>;
  confirmRemove: string;
  setConfirmRemove: (name: string) => void;
  actions: ConnectorActions;
}) {
  if (server.name === NOTICE_ROW) return <ConnectorNotice error={server.error} />;
  return (
    <InstalledConnector
      server={server}
      disabledTools={disabledTools}
      autoApprove={autoApprove}
      outboundUnmask={outboundUnmask}
      connectorPowers={connectorPowers}
      confirmRemove={confirmRemove}
      setConfirmRemove={setConfirmRemove}
      actions={actions}
    />
  );
}

function ToolPreferenceError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p className="gate-error" role="alert">
      <AlertIcon size={14} /> {error}
    </p>
  );
}

function McpError({ error }: { error: string }) {
  if (!error) return null;
  return <div className="gate-error">{error}</div>;
}

export function InstalledConnectors({ statuses, toolPrefs, autoApprove, outboundUnmask, connectorPowers, confirmRemove, setConfirmRemove, actions, error, toolError }: {
  statuses: McpServerStatus[];
  toolPrefs: Record<string, string[]>;
  autoApprove: boolean;
  outboundUnmask: boolean;
  connectorPowers: Record<string, { auto_approve?: boolean; outbound_unmask?: boolean }>;
  confirmRemove: string;
  setConfirmRemove: (name: string) => void;
  actions: ConnectorActions;
  error: string;
  toolError: string;
}) {
  if (!statuses.length) return null;
  const count = statuses.filter((server) => server.name !== NOTICE_ROW).length;
  return (
    <section className="conn-section connectors-installed">
      <div className="conn-section-head">
        <h2>Installed</h2>
        <span className="conn-section-note">
          {count} connector{count === 1 ? "" : "s"}
        </span>
      </div>
      <ToolPreferenceError error={toolError} />
      <div className="conn-list nb-frame-set">
        {statuses.map((server) => (
          <ConnectorRow
            key={server.name}
            server={server}
            disabledTools={toolPrefs[server.name] ?? []}
            autoApprove={autoApprove}
            outboundUnmask={outboundUnmask}
            connectorPowers={connectorPowers}
            confirmRemove={confirmRemove}
            setConfirmRemove={setConfirmRemove}
            actions={actions}
          />
        ))}
      </div>
      <McpError error={error} />
    </section>
  );
}
