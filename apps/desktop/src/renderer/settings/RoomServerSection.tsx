import type { IconComponent, RoomServerStatus } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  leash: RoomServerStatus;
  leashBusy: boolean;
  toggleLeash: () => void;
  allowCloud: boolean;
  toggleAllowCloud: (next: boolean) => void;
  scope: "files" | "full";
  changeScope: (next: "files" | "full") => void;
  regenerateToken: () => void;
  copyLeashConfig: () => void;
  leashCopied: boolean;
  leashErr: string;
  AlertIcon: IconComponent;
}

export default function RoomServerSection({
  leash,
  leashBusy,
  toggleLeash,
  allowCloud,
  toggleAllowCloud,
  scope,
  changeScope,
  regenerateToken,
  copyLeashConfig,
  leashCopied,
  leashErr,
  AlertIcon,
}: Props) {
  return (
    // THE LEASH — expose the unlocked room as an MCP server.
    <section id="set-leash">
      <h3>Room as a tool (MCP server)</h3>
            <p className="settings-hint">
              Turn this on to let apps on this Mac reach the unlocked room as a
              Model Context Protocol server — so Claude Desktop, Cursor and
              similar tools can read and search it while it's open.
            </p>
            <div className="settings-toggle-row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={leash.running}
                  disabled={leashBusy}
                  onChange={toggleLeash}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </label>
              <span>
                {leash.running
                  ? "The room is reachable as a tool."
                  : "The room is not shared."}
              </span>
            </div>
            {leash.running && (
              <>
                <ScopeOptions
                  scope={scope}
                  leashBusy={leashBusy}
                  changeScope={changeScope}
                />
                {/* The full tier maps to ToolScope::ExternalAgent, which has no
                    allow_cloud sub-option — so the switch below is not merely
                    hidden, it does not exist here. Said out loud because a user
                    who deliberately left it off would otherwise cross that line
                    by picking a tier and see nothing about it. */}
                <FullScopeWarning scope={scope} AlertIcon={AlertIcon} />
                <ConnectionConfig
                  leash={leash}
                  leashCopied={leashCopied}
                  copyLeashConfig={copyLeashConfig}
                  scope={scope}
                  leashBusy={leashBusy}
                  regenerateToken={regenerateToken}
                />
                <ScopeDetails scope={scope} leash={leash} AlertIcon={AlertIcon} />
                <CloudClientControl
                  scope={scope}
                  allowCloud={allowCloud}
                  leashBusy={leashBusy}
                  toggleAllowCloud={toggleAllowCloud}
                  AlertIcon={AlertIcon}
                />
              </>
            )}
            {leashErr && <div className="gate-error">{leashErr}</div>}
    </section>
  );
}

const scopeOptions = [
  ["files", "Files only", "Read, search and edit files."],
  [
    "full",
    "Full agent",
    "Files + background jobs + local AI (for Claude Code, Codex…).",
  ],
] as const;

interface ScopeOptionsProps {
  scope: Props["scope"];
  leashBusy: boolean;
  changeScope: Props["changeScope"];
}

function ScopeOptions({ scope, leashBusy, changeScope }: ScopeOptionsProps) {
  return (
    <>
      <label className="settings-label">Access level</label>
      {scopeOptions.map(([id, name, blurb]) => (
        <label
          key={id}
          className={`model-row ${scope === id ? "active" : ""}`}
          style={{ alignItems: "flex-start", gap: 8, cursor: "pointer" }}
        >
          <input
            type="radio"
            name="leash-scope"
            checked={scope === id}
            disabled={leashBusy}
            onChange={() => changeScope(id)}
            style={{ marginTop: 3 }}
          />
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              flex: 1,
            }}
          >
            <span className="model-label">{name}</span>
            <span className="settings-hint" style={{ margin: 0 }}>
              {blurb}
            </span>
          </span>
        </label>
      ))}
    </>
  );
}

interface FullScopeWarningProps {
  scope: Props["scope"];
  AlertIcon: IconComponent;
}

function FullScopeWarning({ scope, AlertIcon }: FullScopeWarningProps) {
  if (scope !== "full") return null;

  return (
    <p className="set-note set-note--flag nb-sem-pending">
      <AlertIcon size={16} className="warn-ic" /> An external agent at this
      level can start hours of local compute and run the local model. It still
      can't see your screen or drive the app. This level has no local-only
      restriction — the cloud CLIs named above are exactly who it is for, so
      “Allow cloud AI clients” does not apply here and is hidden.
    </p>
  );
}

interface ConnectionConfigProps {
  leash: RoomServerStatus;
  leashCopied: boolean;
  copyLeashConfig: Props["copyLeashConfig"];
  scope: Props["scope"];
  leashBusy: boolean;
  regenerateToken: Props["regenerateToken"];
}

function ConnectionConfig({
  leash,
  leashCopied,
  copyLeashConfig,
  scope,
  leashBusy,
  regenerateToken,
}: ConnectionConfigProps) {
  return (
    <>
      <label className="settings-label">Address</label>
      <input
        readOnly
        value={leash.url}
        onFocus={(event) => event.target.select()}
      />
      <label className="settings-label">Config for Claude Desktop / Cursor</label>
      <textarea
        className="mcp-config"
        rows={8}
        readOnly
        spellCheck={false}
        value={leash.config}
        onFocus={(event) => event.target.select()}
      />
      <div className="settings-actions">
        <button className="btn-ic" onClick={copyLeashConfig}>
          {leashCopied ? (
            <>
              <CircleCheckIcon size={14} /> Copied
            </>
          ) : (
            "Copy config"
          )}
        </button>
        {scope === "full" && (
          <button
            className="btn-ic"
            disabled={leashBusy}
            onClick={regenerateToken}
          >
            Regenerate token
          </button>
        )}
      </div>
    </>
  );
}

interface ScopeDetailsProps {
  scope: Props["scope"];
  leash: RoomServerStatus;
  AlertIcon: IconComponent;
}

function ScopeDetails({ scope, leash, AlertIcon }: ScopeDetailsProps) {
  if (scope !== "full") {
    return (
      <p className="set-note">
        Only apps you paste this into can reach the unlocked room; it dies when
        you lock.
      </p>
    );
  }

  return (
    <>
      {!leash.stable && (
        <p className="set-note set-note--flag nb-sem-pending">
          <AlertIcon size={16} className="warn-ic" /> The fixed Leash port
          (17872) was already in use, so this address is temporary and will
          change on the next restart — re-paste the config, or free that port
          for a stable address.
        </p>
      )}
      <details className="set-more">
        <summary>About this address</summary>
        <p className="settings-hint">
          {leash.stable ? "This address and config survive restarts. " : ""}
          Agents can also self-configure from{" ~/.arcelle/leash.json"} (written
          only while the room is open). Regenerate the token to revoke every
          pasted config at once.
        </p>
      </details>
    </>
  );
}

interface CloudClientControlProps {
  scope: Props["scope"];
  allowCloud: boolean;
  leashBusy: boolean;
  toggleAllowCloud: Props["toggleAllowCloud"];
  AlertIcon: IconComponent;
}

function CloudClientControl({
  scope,
  allowCloud,
  leashBusy,
  toggleAllowCloud,
  AlertIcon,
}: CloudClientControlProps) {
  if (scope === "full") return null;

  return (
    <>
      <label className="settings-label">Allow cloud AI clients</label>
      <div className="settings-toggle-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={allowCloud}
            disabled={leashBusy}
            onChange={(event) => toggleAllowCloud(event.target.checked)}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </label>
        <span>
          {allowCloud ? "Cloud AI clients may connect." : "Local apps only."}
        </span>
      </div>
      <p className="set-note set-note--flag set-note--lead nb-sem-urgent">
        <AlertIcon size={16} className="warn-ic" /> With this on, a cloud AI
        can read this room through the bridge — and what they retrieve, they
        keep. Leave it off unless you mean it.
      </p>
    </>
  );
}
