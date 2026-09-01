import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";
import { clearTokens, loadTokens } from "./mcpOauth.js";
import { parseMcpConfig, type ServerConfig, type Transport } from "./mcpClient.js";
import { isPlainObject, errMessage, hasOwn, ownEntry, setOwn, MCP_CONFIG_KEY, getMcpConfig, inventoryLine, DELETE_DECLINED } from "./mcpConfigCore.js";
import { redactAgentMcpConfig, removeAgentMcpSecrets, restoreRedactedArgs, rejectSurvivingPlaceholders, sameDestination } from "./mcpConfigSecrets.js";
import { removeServerFromConfig, forgetConnectorGrants } from "./mcpConfigPrefs.js";

export function agentMcpName(name: string): string {
  const n = name.trim();
  if (n === "" || n.length > 64 || !/^[A-Za-z0-9._-]+$/.test(n)) {
    throw new Error("Connector names use 1-64 letters, numbers, dots, dashes, or underscores.");
  }
  return n;
}

/** Ported verbatim from `agent_mcp_root`. */
export function agentMcpRoot(raw: string): Record<string, unknown> {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    throw new Error("the room's connector config isn't valid JSON");
  }
  if (!isPlainObject(root)) {
    throw new Error("the room's connector config must be a JSON object");
  }
  if (root["mcpServers"] === undefined) {
    root["mcpServers"] = {};
  }
  if (!isPlainObject(root["mcpServers"])) {
    throw new Error("the room's mcpServers value must be an object");
  }
  return root;
}

/** Inventory available to the local main agent. It deliberately describes
 * transports/statuses, never credential values. `statuses` stands in for
 * `state.mcp.lock().unwrap().statuses()` — see this module's own doc for why a
 * live Manager is out of scope; a name missing from the map degrades exactly
 * like Rust's own fallback (an enabled connector reads "configured"). Ported
 * from `agent_list_mcps`. */
export function agentListMcps(db: Database.Database, statuses: ReadonlyMap<string, string> = new Map()): string {
  const config = getMcpConfig(db);
  const servers = parseMcpConfig(config);
  if (servers.length === 0) {
    return "No MCP connectors are configured in this room.";
  }
  return servers
    .map(([name, cfg]) => {
      const state = cfg.disabled ? "disabled" : (statuses.get(name) ?? "configured");
      return `- ${name} [${state}] — ${inventoryLine(cfg.transport)}`;
    })
    .join("\n");
}

/** Read one server's editable, secret-free configuration. Ported verbatim from
 * `agent_read_mcp`. */
export function agentReadMcp(db: Database.Database, name: string): string {
  const n = agentMcpName(name);
  const root = agentMcpRoot(getMcpConfig(db));
  const servers = root["mcpServers"] as Record<string, unknown>;
  if (!hasOwn(servers, n)) {
    throw new Error(`No connector named "${n}" exists.`);
  }
  const server = servers[n];
  return `Connector ${n} (credentials redacted):\n${JSON.stringify(redactAgentMcpConfig(server), null, 2)}`;
}

/** The result of the injected {@link AgentSaveMcpDeps.forgetConnectorGrants}
 * seam — `cleared` is {@link forgetConnectorGrants}'s own return value. */
export interface ForgetGrantsResult {
  cleared: boolean;
}

export interface AgentSaveMcpDeps {
  /**
   * `forget_connector_grants` — clears this Mac's standing permissions for a
   * connector whose destination just changed. The real implementation is
   * {@link forgetConnectorGrants} in this same file; it is INJECTED rather than
   * called directly because it needs the app's `userDataDir` and the process's
   * session-grant set, neither of which an `exec_tool` arm has. A caller with
   * both wires it as
   * `(name) => ({ cleared: forgetConnectorGrants(dir, session, name) })`.
   * May throw to report a failure to clear (mirroring Rust's `Result`);
   * `undefined` skips the extra sentence a real store would add.
   */
  forgetConnectorGrants?: (server: string) => ForgetGrantsResult;
  /** `start_mcp_connections` — see the module doc. `undefined` means no live
   * Manager to refresh; harmless, since the connector is saved disabled
   * regardless. */
  reconnect?: (servers: ReadonlyArray<[string, ServerConfig]>) => void;
}

export const AGENT_MCP_CARRIED_CREDENTIALS: readonly string[] = ["headers", "env", "bearer_token_env_var"];

export interface AgentMcpDestinationChange {
  retargeted: boolean;
  hadCredentials: boolean;
}

export function agentSaveIncoming(args: Record<string, unknown>): Record<string, unknown> {
  const configArg = args["config"];
  if (!isPlainObject(configArg)) {
    throw new Error("save_mcp needs a `config` object.");
  }
  // A deep copy, like Rust's `args.get("config").cloned()`: `restoreRedactedArgs`
  // mutates `incoming.args` in place, and a shallow spread would reach through
  // into the caller's own arguments object.
  const incoming = structuredClone(configArg);
  removeAgentMcpSecrets(incoming);
  return incoming;
}

export function agentMcpDestinationChange(
  servers: Record<string, unknown>,
  name: string,
  incoming: Record<string, unknown>
): AgentMcpDestinationChange {
  const old = ownEntry(servers, name);
  if (old === undefined) {
    return { retargeted: false, hadCredentials: false };
  }
  // `read_mcp` showed `[redacted]` where a command-line key was; writing that
  // back verbatim would replace the user's real key with the placeholder (and
  // read as a retarget). Put the original back first.
  restoreRedactedArgs(old, incoming);
  const hadCredentials = AGENT_MCP_CARRIED_CREDENTIALS.some((key) => hasOwn(old, key));
  if (!sameDestination(old, incoming)) {
    return { retargeted: true, hadCredentials };
  }
  for (const key of AGENT_MCP_CARRIED_CREDENTIALS) {
    if (hasOwn(old, key)) incoming[key] = old[key];
  }
  return { retargeted: false, hadCredentials };
}

export function removeRetargetedSignin(db: Database.Database, name: string, retargeted: boolean): boolean {
  const hadSignin = loadTokens(db, name) !== null;
  if (retargeted) {
    clearTokens(db, name);
  }
  return hadSignin;
}

export function retargetedCredentialsNotice(
  retargeted: boolean,
  hadCredentials: boolean,
  hadSignin: boolean
): string {
  return retargeted && (hadCredentials || hadSignin)
    ? " Its saved credentials and sign-in were NOT carried over, because this edit changed where the connector points."
    : "";
}

export function retargetedPermissionsNotice(
  name: string,
  retargeted: boolean,
  forgetConnectorGrants: AgentSaveMcpDeps["forgetConnectorGrants"]
): string {
  if (!retargeted || forgetConnectorGrants === undefined) {
    return "";
  }
  try {
    return forgetConnectorGrants(name)?.cleared === true
      ? ' The permissions saved for it ("run without asking" / "send real values") were cleared for the same reason.'
      : "";
  } catch (e) {
    return ` ${errMessage(e)}`;
  }
}

export function agentSaveMcpResult(name: string, existed: boolean, dropped: string, permissions: string): string {
  return (
    `${existed ? "Updated" : "Saved"} connector "${name}" as disabled.${dropped}${permissions} ` +
    `Review it in Connectors, add any credentials there, then explicitly enable and approve it before it can run or reach the network.`
  );
}

/**
 * Create/update a connector without ever accepting, exposing, approving, or
 * starting credentials/programs. A changed connector remains disabled until a
 * human reviews it in Connectors and completes the existing SEC-1 approval.
 * Ported from `agent_save_mcp`.
 *
 * THE SEC-1 PROPERTY: `incoming["disabled"] = true` runs UNCONDITIONALLY, on
 * every path, new connector or edited one alike.
 */
export function agentSaveMcp(
  db: Database.Database,
  args: Record<string, unknown>,
  deps: AgentSaveMcpDeps = {}
): string {
  const name = agentMcpName(typeof args["name"] === "string" ? args["name"] : "");
  const incoming = agentSaveIncoming(args);

  const raw = getMcpConfig(db);
  const root = agentMcpRoot(raw);
  const servers = root["mcpServers"] as Record<string, unknown>;
  const existed = hasOwn(servers, name);

  // Preserve already-stored credentials while refusing new secret values from
  // model context — but ONLY while the connector still points at the same
  // place. Carrying them over an edit that changes the url (or the command)
  // would hand the user's saved key to a NEW destination, and the Connectors
  // list shows just a name and a switch, so turning it back on would send the
  // key somewhere nobody was warned about. A same-target edit must still never
  // erase a user's token.
  const { retargeted, hadCredentials } = agentMcpDestinationChange(servers, name, incoming);
  // Whatever the model did to the args, the placeholder itself is never a value
  // worth storing — including on a brand-new connector, where there is no old
  // entry to restore from.
  rejectSurvivingPlaceholders(incoming);
  incoming["disabled"] = true;
  setOwn(servers, name, incoming);
  const json = JSON.stringify(root, null, 2);
  parseMcpConfig(json); // sanity gate, matching `mcp::parse_config(&json)?`

  // A retargeted connector's stored sign-in belongs to the OLD endpoint;
  // leaving it would let the connect-time refresh re-attach it to the new one
  // behind the user's back.
  const hadSignin = removeRetargetedSignin(db, name, retargeted);
  setSetting(db, MCP_CONFIG_KEY, json);

  deps.reconnect?.(parseMcpConfig(json));

  // Same reason the credentials stay behind: "run without asking" and "send real
  // values" were granted to the place this connector used to reach, and they
  // are keyed by its NAME, so leaving them would hand both to the new
  // destination without anyone being asked.
  const dropped = retargetedCredentialsNotice(retargeted, hadCredentials, hadSignin);
  const permissions = retargetedPermissionsNotice(name, retargeted, deps.forgetConnectorGrants);
  return agentSaveMcpResult(name, existed, dropped, permissions);
}

export interface AgentDeleteMcpDeps {
  /**
   * `confirm_destructive` — the consent dialog. REQUIRED, deliberately unlike
   * every other injected seam in this file: audit #505 is the whole reason
   * `agent_delete_mcp` has its current shape (an agent could wipe a connector
   * AND its saved sign-in with nothing asking first, and a document in the room
   * saying "remove the github connector" was enough to set it off), so this
   * function must never run without a real consent gate behind it — a caller
   * with nothing to supply belongs in `execTool.ts`'s `NOT_IMPLEMENTED` stub,
   * not here with the check silently skipped. Standing consent does NOT reach
   * here: "run connector tools without asking" is permission to CALL a
   * connector, never to destroy the room's own configuration.
   */
  confirmDestructive: (what: string, name: string, detail: string) => Promise<boolean>;
  forgetConnectorGrants?: (server: string) => ForgetGrantsResult;
  reconnect?: (servers: ReadonlyArray<[string, ServerConfig]>) => void;
}

/** Ask the user, then delete one connector and its saved OAuth token. Ported
 * verbatim from `agent_delete_mcp` — the confirmation is asked BEFORE the room
 * is touched, and a failure to clear the per-Mac grants is REPORTED in the
 * reply rather than raised, since the connector really is deleted and an error
 * would have the model tell the user nothing happened. */
export async function agentDeleteMcp(
  db: Database.Database,
  args: Record<string, unknown>,
  deps: AgentDeleteMcpDeps
): Promise<string> {
  const name = agentMcpName(typeof args["name"] === "string" ? args["name"] : "");
  const approved = await deps.confirmDestructive(
    "connector",
    name,
    "Its saved sign-in (OAuth token) is erased with it. There is no undo — " +
      "you would have to add the connector and sign in again."
  );
  if (!approved) {
    throw new Error(DELETE_DECLINED);
  }

  const raw = getMcpConfig(db);
  const root = agentMcpRoot(raw);
  const servers = root["mcpServers"] as Record<string, unknown>;
  if (!hasOwn(servers, name)) {
    throw new Error(`No connector named "${name}" exists.`);
  }
  clearTokens(db, name);
  const json = removeServerFromConfig(raw, name);
  setSetting(db, MCP_CONFIG_KEY, json);

  deps.reconnect?.(parseMcpConfig(json));

  let kept = "";
  try {
    deps.forgetConnectorGrants?.(name);
  } catch (e) {
    kept = ` ${errMessage(e)}`;
  }
  return `Deleted connector "${name}" and its saved OAuth token.${kept}`;
}
