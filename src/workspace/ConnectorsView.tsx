import { useEffect, useState } from "react";
import { api } from "../api";
import { useMcpConfig } from "../settings/useMcpConfig";
import McpMarketplace from "../settings/McpMarketplace";
import { AlertIcon, TrashIcon } from "../icons";

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

/** The Connectors area (activity rail → "connectors"): manage installed MCP
 * connectors — enable/disable and remove — and browse the marketplace to add
 * more. Moved out of Settings so connectors are a first-class product area. */
export default function ConnectorsView() {
  const {
    mcpConfig,
    setMcpConfig,
    mcpStatuses,
    mcpError,
    applyMcp,
    installServer,
    setServerEnabled,
    removeServer,
    autoApprove,
    setAutoApprove,
    outboundUnmask,
    setOutboundUnmask,
    connectorPowers,
    setConnectorPower,
    installedNames,
  } = useMcpConfig();

  // Per-connector tool opt-outs: { server: [disabled tool names] }.
  const [toolPrefs, setToolPrefs] = useState<Record<string, string[]>>({});
  // AUDIT 84: both halves of this used to swallow every error. A read that
  // failed answered "nothing is turned off", which redrew every switched-off
  // tool as ON while the file on disk still said otherwise, and a failed write
  // said nothing at all — the screen simply lied until the page was reopened.
  // The state is now only ever replaced by an answer the backend actually gave,
  // and a failure is named on screen.
  const [toolError, setToolError] = useState("");
  // Which connector's Remove button is ARMED. One at a time: arming a second
  // disarms the first, so a stray click can never land on a primed row.
  const [confirmRemove, setConfirmRemove] = useState("");
  useEffect(() => {
    api
      .mcpGetToolPrefs()
      .then((prefs) => {
        setToolPrefs(prefs);
        setToolError("");
      })
      .catch((e) =>
        setToolError(
          `Couldn't read which connector tools are turned off (${String(e)}). The switches below may not match what is saved.`,
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
      .catch((e) =>
        setToolError(`Couldn't change ${server}'s ${tool}: ${String(e)}`),
      );

  return (
    // `data-agent-blocked` fences this WHOLE area from the UI-driving agent
    // (ADD-25), the way Settings, the approval cards and every destructive
    // confirm already are. It is not a "screen with some switches on it":
    // every control here is a permission decision — send a remote connector
    // this room's real values, run its tools without being asked, turn a
    // connector on or off, remove it and its saved sign-in, install a new
    // internet-reaching one from the marketplace. An agent that could operate
    // them could grant itself the powers the consent gates exist to withhold,
    // which is the one thing the fence is for. The attribute is on the root so
    // the embedded marketplace is covered too — `driver.ts` excludes anything
    // with a blocked ANCESTOR at the walker, so nothing inside ever gets a
    // mark the model could act on.
    <div className="connectors-page" data-agent-blocked>
      <header className="connectors-head">
        <h1>Connectors</h1>
        {/* This paragraph used to promise, flatly, that Arcelle "asks before
            either starts, and hides this room's private details" — a sentence
            that was already false whenever the old auto-approve switch was on,
            and is now false in two separate ways. It sits directly above the
            two switches that decide it, so it has to read off them rather than
            describe a fresh install; a header that contradicts the checkbox
            beside it is exactly the privacy-state confusion the rewording of
            these labels was meant to end. */}
        <p className="settings-hint">
          Give this room extra tools with the Model Context Protocol. Local
          connectors run on your Mac; remote ones reach out over the internet.
          Right now Arcelle{" "}
          {autoApprove
            ? "runs connector tools without asking you"
            : "asks before either starts"}
          , and{" "}
          {outboundUnmask
            ? "sends a remote one this room's real values"
            : "hides this room's private details in what it sends to a remote one"}
          . Both are switches, below — and each is only the <i>default</i>: every
          installed connector can answer either one for itself, and each says
          which answer is in force for it.
        </p>
        {/* Two switches, not one. These used to be a single "auto-approve"
            control that opened both gates together, so a user whose lookups
            kept coming back empty had only one way to fix it — and fixing it
            also stopped Arcelle asking permission. They are different risks:
            one is about who presses the button, the other about what the button
            sends. Both are off until asked for.

            Each says what is true NOW rather than what a fresh install does.
            The copy used to read "Off by default; while off …", which described
            a FRESH INSTALL rather than this Mac; the preference persists, so
            once it had been turned on that sentence contradicted the switch
            sitting checked beside it and live QA read the pair as a bug in the
            privacy state. The default belongs in the docs, not next to a live
            control. */}
        <label
          className="connector-switch connectors-autoapprove"
          title="Let the assistant run connector tools without stopping to ask"
        >
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => void setAutoApprove(e.target.checked)}
          />
          <span className="mkt-sw" />
          <span>
            <b>Run connector tools without asking</b> — the assistant calls them
            straight away instead of showing you each one first. This decides
            only <i>whether you are asked</i>; it does not change what the call
            carries.
            {autoApprove ? (
              <>
                {" "}
                <b>Currently ON</b> for this Mac: connector calls run unattended,
                except where a connector below says otherwise. Turn it off to
                approve each one before it runs.
              </>
            ) : (
              <>
                {" "}
                <b>Currently OFF</b>: every connector call waits for you to
                approve it, and shows you the exact arguments it would send —
                except where a connector below says otherwise.
              </>
            )}
          </span>
        </label>
        <label
          className="connector-switch connectors-unmask"
          title="Send remote connectors this room's real values instead of placeholders"
        >
          <input
            type="checkbox"
            checked={outboundUnmask}
            onChange={(e) => void setOutboundUnmask(e.target.checked)}
          />
          <span className="mkt-sw" />
          <span>
            <b>Send remote connectors real values</b> — the names, tickers and
            handles this room protects go out as themselves instead of
            placeholders. That is what makes lookups work (a connector can't
            answer about “[Person A]”), and it means this room's private details
            genuinely leave for a remote connector. Local connectors run on your
            Mac, so this never applies to them.
            {outboundUnmask ? (
              <>
                {" "}
                <b>Currently ON</b> for this Mac: remote connectors see real
                values, except where a connector below says otherwise. Turn it
                off to send placeholders again.
              </>
            ) : (
              <>
                {" "}
                <b>Currently OFF</b>: remote connectors see placeholders, so a
                lookup about something this room protects may come back empty —
                unless a connector below says otherwise.
              </>
            )}
          </span>
        </label>
      </header>

      {mcpStatuses.length > 0 && (
        <section className="connectors-installed">
          <h2 className="connectors-h2">Installed</h2>
          {toolError && (
            <p className="gate-error" role="alert">
              <AlertIcon size={14} /> {toolError}
            </p>
          )}
          <div className="mcp-list">
            {mcpStatuses.map((s) => {
              // The notice row is not a connector: no switch, no Remove, no
              // per-connector powers — every one of those acted on a name that
              // does not exist and answered with a second error.
              if (s.name === NOTICE_ROW) {
                return (
                  <div key={s.name} className="connector-item connector-notice">
                    <div className="mcp-row connector-row" role="status">
                      <AlertIcon size={15} />
                      <span className="settings-hint">
                        {s.error ??
                          "This room's connector setup could not be read."}
                      </span>
                    </div>
                  </div>
                );
              }
              const enabled = s.status !== "disabled";
              const offList = toolPrefs[s.name] ?? [];
              const onCount = s.tools.filter((t) => !offList.includes(t)).length;
              // What this connector answers, and what is therefore in force for
              // it. Computed here and STATED below rather than left as two
              // controls the user has to combine in their head: the switch at
              // the top of the page is the default, this is the override, and
              // the sentence names which one won.
              const over = connectorPowers[s.name] ?? {};
              const autoChoice = choiceOf(over.auto_approve);
              const unmaskChoice = choiceOf(over.outbound_unmask);
              const autoInForce = over.auto_approve ?? autoApprove;
              const unmaskInForce = over.outbound_unmask ?? outboundUnmask;
              return (
                <div key={s.name} className="connector-item">
                  <div className="mcp-row connector-row">
                    <span className={`mcp-dot ${s.status}`} />
                    <strong>{s.name}</strong>
                    <span
                      className={`mkt-badge ${s.remote ? "remote" : "local"}`}
                      title={
                        s.remote
                          ? "Remote — reaches the internet"
                          : "Local — runs on your Mac"
                      }
                    >
                      {s.remote ? "Remote" : "Local"}
                    </span>
                    <span className="settings-hint connector-status">
                      {s.status === "connected" &&
                        `${onCount} of ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} on`}
                      {s.status === "connecting" && "connecting…"}
                      {s.status === "disabled" && "off"}
                      {s.status === "failed" && (s.error ?? "failed")}
                    </span>
                    <div className="connector-actions">
                      <label
                        className="mkt-tgl"
                        title={enabled ? "Turn this connector off" : "Turn this connector on"}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) =>
                            void setServerEnabled(s.name, e.target.checked)
                          }
                        />
                        <span className="mkt-sw" />
                      </label>
                      {/* AUDIT 83: removing a connector erases its saved
                          sign-in with it, and there is no undo and no trash.
                          It used to go on the first click. The assistant's own
                          route through `delete_mcp` asks the same question. */}
                      {confirmRemove === s.name ? (
                        <span className="connector-confirm" role="group" aria-label={`Remove ${s.name}?`}>
                          <span className="settings-hint">
                            Remove {s.name} and its saved sign-in?
                          </span>
                          <button
                            className="danger"
                            onClick={() => {
                              setConfirmRemove("");
                              void removeServer(s.name);
                            }}
                          >
                            Remove
                          </button>
                          <button onClick={() => setConfirmRemove("")}>Keep</button>
                        </span>
                      ) : (
                        <button
                          className="connector-remove"
                          title="Remove this connector"
                          aria-label={`Remove ${s.name}`}
                          onClick={() => setConfirmRemove(s.name)}
                        >
                          <TrashIcon size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {enabled && (
                    <div className="connector-powers">
                      <label className="connector-power">
                        <span className="connector-power-name">
                          Run its tools without asking
                        </span>
                        <select
                          value={autoChoice}
                          aria-label={`Run ${s.name} tools without asking`}
                          onChange={(e) =>
                            void setConnectorPower(
                              s.name,
                              "auto_approve",
                              valueOf(e.target.value as PowerChoice),
                            )
                          }
                        >
                          <option value="follow">
                            Use the setting above (
                            {autoApprove ? "don't ask" : "ask me"})
                          </option>
                          <option value="on">Don't ask for this connector</option>
                          <option value="off">Always ask for this connector</option>
                        </select>
                        <span className="settings-hint connector-power-state">
                          In force: {autoInForce
                            ? "its calls run without asking you"
                            : "every call waits for your approval"}
                          {autoChoice === "follow"
                            ? " (from the setting above)"
                            : " (set here, so the setting above doesn't apply)"}
                          .
                        </span>
                      </label>
                      {s.remote ? (
                        <label className="connector-power">
                          <span className="connector-power-name">
                            Send it real values
                          </span>
                          <select
                            value={unmaskChoice}
                            aria-label={`Send ${s.name} real values`}
                            onChange={(e) =>
                              void setConnectorPower(
                                s.name,
                                "outbound_unmask",
                                valueOf(e.target.value as PowerChoice),
                              )
                            }
                          >
                            <option value="follow">
                              Use the setting above (
                              {outboundUnmask ? "real values" : "placeholders"})
                            </option>
                            <option value="on">Real values for this connector</option>
                            <option value="off">Placeholders for this connector</option>
                          </select>
                          <span className="settings-hint connector-power-state">
                            In force: {unmaskInForce
                              ? "this room's real names and tickers leave for it"
                              : "it sees placeholders instead of protected values"}
                            {unmaskChoice === "follow"
                              ? " (from the setting above)"
                              : " (set here, so the setting above doesn't apply)"}
                            .
                          </span>
                        </label>
                      ) : (
                        <p className="settings-hint connector-power-state">
                          Local — it runs on your Mac, so nothing it is told
                          leaves here and there is no masking to decide.
                        </p>
                      )}
                    </div>
                  )}
                  {enabled && s.tools.length > 0 && (
                    <details className="connector-tools">
                      <summary>Tools ({onCount}/{s.tools.length})</summary>
                      <p className="settings-hint connector-tools-hint">
                        Every tool you leave on is available to the assistant —
                        it searches them by name when it needs one, so a large
                        connector costs nothing until it's used. Turn off any
                        you'd rather it never reach.
                      </p>
                      <div className="connector-tool-list">
                        {s.tools.map((t) => {
                          const on = !offList.includes(t);
                          return (
                            <label key={t} className="connector-tool" title={on ? "On" : "Off"}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => toggleTool(s.name, t, e.target.checked)}
                              />
                              <span className="mkt-sw" />
                              <code>{t}</code>
                            </label>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
          {mcpError && <div className="gate-error">{mcpError}</div>}
        </section>
      )}

      <section className="connectors-marketplace">
        <h2 className="connectors-h2">
          {mcpStatuses.length > 0 ? "Add more" : "Marketplace"}
        </h2>
        <McpMarketplace
          installServer={installServer}
          installedNames={installedNames}
        />
      </section>

      <details className="mcp-advanced connectors-advanced">
        <summary>Advanced: paste or edit the raw config</summary>
        <p className="settings-hint">
          <AlertIcon size={13} className="warn-ic" /> Connected tools are separate
          programs and can reach the internet — what the AI sends them leaves
          this room. Paste the same <code>mcpServers</code> config used by Claude
          Desktop or Cursor.
        </p>
        <textarea
          className="mcp-config"
          rows={10}
          spellCheck={false}
          value={mcpConfig}
          onChange={(e) => setMcpConfig(e.target.value)}
        />
        <div className="settings-actions">
          <button className="primary" onClick={applyMcp}>
            Save & Connect
          </button>
        </div>
      </details>
    </div>
  );
}
