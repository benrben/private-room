import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";
import { clearTokens, loadTokens } from "./mcpOauth.js";
import { parseMcpConfig, type ServerConfig, type Transport } from "./mcpClient.js";
import { isPlainObject, asRecord, errMessage, hasOwn, ownEntry, setOwn, ownMap } from "./mcpConfigCore.js";
import { sameDestination } from "./mcpConfigSecrets.js";

// ------------------------------------------------------------ enable/remove

/** Set or clear `"disabled"` on one server in an mcpServers config. Disabling
 * keeps the connector in the config but stops it. Ported verbatim from
 * `set_server_disabled`. */
export function setServerDisabled(config: string, server: string, disabled: boolean): string {
  let root: unknown;
  try {
    root = JSON.parse(config);
  } catch {
    throw new Error("the room's connector config isn't valid JSON");
  }
  const entry = ownEntry(asRecord(asRecord(root)["mcpServers"]), server);
  if (entry === undefined) {
    throw new Error(`"${server}" is not in the connector config`);
  }
  if (disabled) {
    setOwn(entry, "disabled", true);
  } else {
    delete entry["disabled"];
  }
  return JSON.stringify(root, null, 2);
}

/** Remove one server from an mcpServers config entirely (no error if absent).
 * Ported verbatim from `remove_server_from_config`. */
export function removeServerFromConfig(config: string, server: string): string {
  let root: unknown;
  try {
    root = JSON.parse(config);
  } catch {
    throw new Error("the room's connector config isn't valid JSON");
  }
  const servers = asRecord(root)["mcpServers"];
  if (isPlainObject(servers)) {
    delete servers[server];
  }
  return JSON.stringify(root, null, 2);
}

// ------------------------------------------------------- per-tool whitelist

/** Read the per-connector tool opt-outs (`{server: [disabled tool names]}`).
 * Missing/invalid → empty (everything on). Ported verbatim from
 * `parse_tool_prefs`. */
export function parseToolPrefs(raw: string): Record<string, Set<string>> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(v)) return ownMap();
  const out = ownMap<Set<string>>();
  for (const [server, list] of Object.entries(v)) {
    if (Array.isArray(list)) out[server] = new Set(list.filter((x): x is string => typeof x === "string"));
  }
  return out;
}

/** Update one server's disabled-tools list and return the new prefs JSON.
 * `enabled=false` adds the tool to the off-list; `true` removes it. A stored
 * value of the wrong shape degrades to "all on" rather than throwing, the way
 * Rust's `unwrap_or_default()` on a typed `BTreeMap<String, Vec<String>>`
 * deserialize does. Ported verbatim from `set_tool_pref`. */
export function setToolPref(raw: string, server: string, tool: string, enabled: boolean): string {
  const map = parsedToolPrefLists(raw);
  const list = updatedToolPrefList(map[server] ?? [], tool, enabled);
  if (list.length === 0) delete map[server];
  else map[server] = list;
  return stringifySorted(map);
}

export function parsedToolPrefLists(raw: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ownMap();
  }
  return toolPrefListsFrom(parsed);
}

export function toolPrefListsFrom(value: unknown): Record<string, string[]> {
  const map = ownMap<string[]>();
  if (!isPlainObject(value)) return map;
  for (const [server, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    map[server] = list.filter((item): item is string => typeof item === "string");
  }
  return map;
}

export function updatedToolPrefList(list: readonly string[], tool: string, enabled: boolean): string[] {
  const updated = list.filter((item) => item !== tool);
  if (!enabled) updated.push(tool);
  return updated;
}

/** Serialize a map with its keys in sorted order — Rust writes these files from
 * a `BTreeMap`, and a stored file that reorders itself between runs is a
 * needless diff (and, for a fingerprinted document, a needless re-approval). */
export function stringifySorted<T>(map: Record<string, T>): string {
  const sorted = ownMap<T>();
  for (const key of Object.keys(map).sort()) sorted[key] = map[key]!;
  return JSON.stringify(sorted);
}

// -------------------------------------------------- per-connector overrides

/**
 * One connector's answer to each of the two powers, or absent for "whatever the
 * switch above says". Optional rather than `boolean` on purpose: a connector
 * nobody has touched must be indistinguishable from one set back to the
 * default, because that is what lets the Mac-wide switch keep meaning something
 * after this became per-connector — and it is what makes the upgrade grant
 * nothing. Ported from `ConnectorOverride`; camelCase in memory, snake_case on
 * the wire.
 */
export interface ConnectorOverride {
  autoApprove?: boolean;
  outboundUnmask?: boolean;
}

export interface WireConnectorOverride {
  auto_approve?: boolean;
  outbound_unmask?: boolean;
}

/** Which of the two powers a per-connector edit is about. An enum rather than a
 * bare string, so the stringly-typed name from the UI is validated ONCE, at the
 * command boundary — a typo there must be an error the user can see, never a
 * silently-ignored write. Ported from `ConnectorPower`. */
export type ConnectorPower = "autoApprove" | "outboundUnmask";

/** Ported verbatim from `ConnectorPower::parse`. */
export function parseConnectorPower(name: string): ConnectorPower {
  if (name === "auto_approve") return "autoApprove";
  if (name === "outbound_unmask") return "outboundUnmask";
  throw new Error(`unknown connector power "${name}" (expected auto_approve or outbound_unmask)`);
}

/** Read the per-connector overrides. Missing/invalid → empty, which means every
 * connector follows the Mac-wide switch. Ported verbatim from
 * `parse_connector_powers`. */
export function parseConnectorPowers(raw: string): Record<string, ConnectorOverride> {
  const parsed = parseJson(raw);
  if (parsed === undefined) return {};
  if (!isPlainObject(parsed)) return ownMap();
  const out = ownMap<ConnectorOverride>();
  for (const [server, entryRaw] of Object.entries(parsed)) {
    const override = connectorOverrideFrom(entryRaw);
    if (override === undefined) continue;
    out[server] = override;
  }
  return out;
}

export function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function connectorOverrideFrom(value: unknown): ConnectorOverride | undefined {
  if (!isPlainObject(value)) return undefined;
  const entry = value as WireConnectorOverride;
  const override: ConnectorOverride = {};
  copyBooleanOverride(entry.auto_approve, override, "autoApprove");
  copyBooleanOverride(entry.outbound_unmask, override, "outboundUnmask");
  return override;
}

export function copyBooleanOverride(
  value: unknown,
  override: ConnectorOverride,
  key: keyof ConnectorOverride
): void {
  if (typeof value === "boolean") override[key] = value;
}

export function stringifyConnectorPowers(map: Record<string, ConnectorOverride>): string {
  const wire = ownMap<WireConnectorOverride>();
  for (const [name, over] of Object.entries(map)) {
    const w: WireConnectorOverride = {};
    if (over.autoApprove !== undefined) w.auto_approve = over.autoApprove;
    if (over.outboundUnmask !== undefined) w.outbound_unmask = over.outboundUnmask;
    wire[name] = w;
  }
  return stringifySorted(wire);
}

/** Set (or clear, with `value: null`) one power for one connector and return
 * the new JSON. An entry that ends up saying nothing is dropped, so "back to
 * following the switch" leaves no residue that a later read could mistake for a
 * choice. Ported verbatim from `set_connector_power`. */
export function setConnectorPower(
  raw: string,
  server: string,
  power: ConnectorPower,
  value: boolean | null
): string {
  const map = parseConnectorPowers(raw);
  const entry: ConnectorOverride = { ...(map[server] ?? {}) };
  setConnectorOverride(entry, power, value);
  if (isEmptyConnectorOverride(entry)) {
    delete map[server];
  } else {
    map[server] = entry;
  }
  return stringifyConnectorPowers(map);
}

export function setConnectorOverride(entry: ConnectorOverride, power: ConnectorPower, value: boolean | null): void {
  const key: keyof ConnectorOverride = power === "autoApprove" ? "autoApprove" : "outboundUnmask";
  if (value === null) delete entry[key];
  else entry[key] = value;
}

export function isEmptyConnectorOverride(entry: ConnectorOverride): boolean {
  if (entry.autoApprove !== undefined) return false;
  return entry.outboundUnmask === undefined;
}

/** What is actually in force for one connector: its own answer when it has one,
 * otherwise the Mac-wide switch. Pure, and the ONLY place the two levels are
 * combined — the UI states the result of this, so a user never has to work out
 * which level wins. Ported verbatim from `effective_power`. */
export function effectivePower(global: boolean, over: boolean | undefined): boolean {
  return over ?? global;
}

// ------------------------------------------------------------ per-Mac files

/** The pure half of the two per-Mac flag readers (`read_mcp_auto_approve`/
 * `read_mcp_outbound_unmask`), so the fail-closed DEFAULT is testable without
 * any file I/O. Only an explicit `true` on disk turns a connector power on; a
 * missing, empty or corrupt file fails closed. Ported verbatim from
 * `parse_connector_flag`. */
export function parseConnectorFlag(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    return JSON.parse(raw.trim()) === true;
  } catch {
    return false;
  }
}

export function readFileIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function mcpApprovalsFile(userDataDir: string): string {
  return path.join(userDataDir, "mcp_approvals.json");
}
export function mcpAutoApproveFile(userDataDir: string): string {
  return path.join(userDataDir, "mcp_auto_approve.json");
}
/** The unmasking preference is a SEPARATE file, deliberately. It has no legacy
 * value to inherit, so an install that had the old combined "auto mode" on
 * keeps its unattended calls and goes back to sending placeholders until the
 * user asks for real values — the fail-closed direction. */
export function mcpOutboundUnmaskFile(userDataDir: string): string {
  return path.join(userDataDir, "mcp_outbound_unmask.json");
}
export function mcpConnectorPowersFile(userDataDir: string): string {
  return path.join(userDataDir, "mcp_connector_powers.json");
}

/** SEC-1: approved config fingerprints live OUTSIDE any room, in the app's own
 * data folder — the room's author is the attacker, so approvals are per-Mac and
 * never travel inside the `.roomai` file. Ported from `read_mcp_approvals`. */
export function readMcpApprovals(userDataDir: string): string[] {
  const raw = readFileIfExists(mcpApprovalsFile(userDataDir));
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Ported from `add_mcp_approval`. */
export function addMcpApproval(userDataDir: string, fingerprint: string): void {
  const list = readMcpApprovals(userDataDir);
  if (list.includes(fingerprint)) return;
  list.push(fingerprint);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(mcpApprovalsFile(userDataDir), JSON.stringify(list, null, 2));
}

/** Ported from `read_mcp_flag`. */
export function readMcpFlag(file: string): boolean {
  return parseConnectorFlag(readFileIfExists(file));
}

/** Persist one connector power. The failure is REPORTED: these files are the
 * only record of a consent decision, and a switch that reads "on" over a flag
 * that was never written promises a power the next launch will not have. Ported
 * from `write_mcp_flag`. */
export function writeMcpFlag(file: string, on: boolean): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, on ? "true" : "false");
  } catch (e) {
    throw new Error(`This setting could not be saved to ${file}: ${errMessage(e)}`);
  }
}

/** Ported from `read_mcp_connector_powers`. */
export function readMcpConnectorPowers(userDataDir: string): Record<string, ConnectorOverride> {
  return parseConnectorPowers(readFileIfExists(mcpConnectorPowersFile(userDataDir)) ?? "{}");
}

/** Persist one per-connector override and return its canonical wire JSON. */
export function writeMcpConnectorPower(
  userDataDir: string,
  server: string,
  power: string,
  value: boolean | null,
): string {
  const next = setConnectorPower(
    readFileIfExists(mcpConnectorPowersFile(userDataDir)) ?? "{}",
    server,
    parseConnectorPower(power),
    value,
  );
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(mcpConnectorPowersFile(userDataDir), next);
  return next;
}

/**
 * Forget every permission this Mac holds for ONE connector: its per-connector
 * overrides on disk and its "always allow" for this session.
 *
 * Both are keyed by NAME alone, and they used to outlive the connector. A later
 * connector landing on the same name — a marketplace install, a hand-written
 * entry in Advanced, a retarget — silently inherited "run without asking" and
 * "send remote connectors real values", so its very first call ran with no
 * consent card and carried the room's real entity values to an endpoint nobody
 * had granted anything.
 *
 * Called AFTER the connector is gone. Answers whether it had any saved override
 * to clear, so a caller that reports what it did can name it without inventing
 * one; THROWS when the file could not be rewritten, because a grants file still
 * holding the overrides would hand them to whatever takes the name next. Ported
 * verbatim from `forget_connector_grants`.
 */
export function forgetConnectorGrants(userDataDir: string, sessionApprovals: Set<string>, server: string): boolean {
  sessionApprovals.delete(server);
  const map = readMcpConnectorPowers(userDataDir);
  if (!hasOwn(map, server)) return false; // nothing was ever set for it
  delete map[server];
  const next = stringifyConnectorPowers(map);
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(mcpConnectorPowersFile(userDataDir), next);
    return true;
  } catch (e) {
    throw new Error(
      `"${server}" is gone, but the permissions saved for that name could not be cleared (${errMessage(e)}). ` +
        `Until ${mcpConnectorPowersFile(userDataDir)} can be written, a connector added under the same name ` +
        `would inherit them.`
    );
  }
}

// -------------------------------------------------------------- agent CRUD

/** Ported verbatim from `agent_mcp_name`. */
