/**
 * MCP connector CONFIG: storage, credential masking, the SEC-1 approval gate,
 * the per-Mac consent files, and the agent-facing CRUD verbs
 * (`list_mcps`/`read_mcp`/`save_mcp`/`delete_mcp`). Ported from
 * `src-tauri/src/commands/mcp_cmds.rs` (2715 lines).
 *
 * This is the THIRD of three files in this port (with `mcpClient.ts` — the
 * transport — and `mcpOauth.ts` — the sign-in flow). What lands here is
 * everything `mcp_cmds.rs` does with a room's STORED config text: reading and
 * writing it under `MCP_CONFIG_KEY` via `db-host/settings.ts`, the
 * credential-redaction rules that keep secrets out of the model's context, the
 * SEC-1 gate's pure decision function ({@link mcpGate}), the per-Mac consent
 * files, and the four `agent_*` functions that back this batch's `exec_tool`
 * arms.
 *
 * CRITICAL PROPERTIES PRESERVED, with no seam that can weaken them:
 * 1. {@link agentSaveMcp} ALWAYS force-writes `disabled: true` — the model can
 *    propose a connector, but a human must review it in Connectors and pass the
 *    SEC-1 fingerprint gate before it can run or reach the network. The
 *    unconditional line IS the security property, and it is asserted directly
 *    in this file's own tests rather than left to be inferred from prose.
 * 2. A connector edit that changes WHERE a call goes ({@link sameDestination}
 *    false) clears its stored OAuth token — in {@link agentSaveMcp} (the
 *    agent's path) and in {@link applyMcpConfig} via {@link resignedServers}
 *    (the Advanced-editor/marketplace path). This is the bug class documented
 *    inline in Rust's own `mcp_apply_config`: a stored sign-in belongs to an
 *    ENDPOINT but is filed under the connector's NAME, so re-pointing `fetch`
 *    left `oauth:fetch` in place and the connect-time renewal merged a fresh
 *    token for the OLD provider into an entry now reaching the new one — while
 *    the drawer reported the new connector as "Signed in". Both callers route
 *    through {@link sameDestination}, so they cannot disagree.
 * 3. `list_mcps`/`read_mcp` never expose a credential: the named secret fields
 *    ({@link AGENT_SECRET_KEYS}) AND a key typed onto a local connector's
 *    command line ({@link redactCliArgs}) are both masked.
 * 4. A save can never store the literal `[redacted]` placeholder over a real
 *    credential ({@link rejectSurvivingPlaceholders}) — the one failure mode
 *    that would silently erase a user's key for good.
 *
 * PER-MAC FILES (approvals, the two global on/off flags, the per-connector
 * overrides) live outside any room, for the SEC-1 reason the Rust source gives:
 * the room's author is the attacker, so a consent decision must never travel
 * inside a `.roomai`. Every function here that touches one takes a
 * `userDataDir` string parameter — this migration's established convention (see
 * `keychain.ts`, `windowGeometry.ts`) — rather than reaching for
 * `app.getPath('userData')` itself, so this module stays a plain, testable Node
 * module with no Electron import.
 *
 * NOT PORTED (documented, not silently dropped) — the LIVE side of the
 * marketplace, which needs a running connection manager wired into a persistent
 * app-state object that this migration has not built:
 * `start_mcp_connections`/`refresh_mcp`/`mcp_status`/`approve_mcp` and the
 * `mcp-status` event stream. {@link AgentSaveMcpDeps.reconnect} is the injected
 * seam where `start_mcp_connections` goes; `undefined` means "no live Manager
 * to refresh yet", which is harmless here because every connector the agent
 * writes is saved DISABLED regardless. The consent-card round trip to a
 * renderer (`mcp_call_approved`) is likewise the caller's: its pure decision
 * primitive ({@link skipsConsentCard}) and the card payload shapes
 * ({@link previewArgs}, {@link destructiveRequest}) are ported here.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";
import { clearTokens, loadTokens } from "./mcpOauth.js";
import { parseMcpConfig, type ServerConfig, type Transport } from "./mcpClient.js";
import { redactCliArgs, resignedServers } from "./mcpConfigSecrets.js";
import { asRecord, errMessage, hasOwn, isPlainObject, ownEntry, setOwn } from "./mcpConfigPrimitives.js";

export { asRecord, errMessage, hasOwn, isPlainObject, ownEntry, ownMap, setOwn } from "./mcpConfigPrimitives.js";

// ------------------------------------------- connector names as ORDINARY keys

/**
 * A connector NAME is just a key to Rust's `serde_json::Map`/`BTreeMap`. In
 * JavaScript an object literal inherits from `Object.prototype`, so a name that
 * spells one of its members — `__proto__`, `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty` — resolves to something that was never in the
 * config, and `agentMcpName` accepts every one of them (they are all letters
 * and underscores). The helpers below are what keeps a connector name a key.
 *
 * `__proto__` is the dangerous one, because it reads back as `Object.prototype`
 * — a plain object by every duck-type test in this file — and WRITING it
 * reaches the prototype of every object in the process. The exploit is
 * concrete: a room ships a remote connector named `__proto__`, the user clicks
 * "Connect account", and {@link mergeBearer} files their fresh OAuth bearer
 * under `Object.prototype.headers`. From there `mcpClient.ts`'s `parseMcpConfig`
 * reads it as EVERY connector's own `Authorization` header — including the
 * attacker's — so the next call to any of them carries the user's token off the
 * Mac. {@link setServerDisabled} was the same shape pointed at
 * `Object.prototype.disabled`, which silently stops every connector in the room.
 *
 * The room's author is the attacker (the premise SEC-1 is built on), and a
 * connector name travels inside the `.roomai`, so this is reachable from the
 * threat model this whole subsystem exists for.
 */
/** One server's OWN entry in a config's `mcpServers` map, `undefined` when the
 * config genuinely does not have it. Never an inherited member — see
 * {@link hasOwn}. */
/** Store a value under a connector's name as an OWN data property. A plain
 * `map[name] = value` invokes `Object.prototype`'s `__proto__` SETTER for that
 * one name, which sets the map's prototype and stores nothing — so the
 * connector silently vanished while the caller reported success. */
/** An accumulator keyed by connector name, with no prototype to collide with.
 * `Object.create(null)` is the JS spelling of Rust's `BTreeMap<String, _>`:
 * every key is a key, and nothing is inherited. */
// ------------------------------------------------------------------ storage

export const MCP_CONFIG_KEY = "mcp_config";
/** Per-connector tool opt-outs: `{ "<server>": ["<tool>", …] }`. Kept SEPARATE
 * from `mcp_config` on purpose — toggling a tool must not change the config
 * fingerprint and re-trigger the SEC-1 approval dialog. */
export const MCP_TOOL_PREFS_KEY = "mcp_tool_prefs";
/** The starting config: an empty scaffold, ported character for character from
 * the Rust `r#"…"#` literal. */
export const DEFAULT_MCP_CONFIG = `{
  "mcpServers": {}
}`;

/** Ported from `mcp_get_config`'s DB-read half (the `#[tauri::command]`
 * wrapper's room lookup is the caller's job — see `execTool.ts`'s
 * `requireRoom`, the same split every other real arm in this migration uses). */
export function getMcpConfig(db: Database.Database): string {
  return getSetting(db, MCP_CONFIG_KEY) ?? DEFAULT_MCP_CONFIG;
}

/**
 * Persist a human-edited config (the Advanced editor / a marketplace install),
 * clearing the stored OAuth token of every connector the edit retargeted or
 * dropped. Ported from `mcp_apply_config`'s config-write + retarget fix, MINUS
 * the SEC-1 approval recording and the live reconnect — both belong to the
 * (unported) app-level wiring, which still has to call {@link mcpFingerprint} +
 * {@link addMcpApproval} itself. Refuses an unreadable config before anything
 * is written.
 */
export function applyMcpConfig(db: Database.Database, json: string): { clearedTokensFor: string[] } {
  parseMcpConfig(json);
  const previous = getSetting(db, MCP_CONFIG_KEY) ?? "";
  const resigned = resignedServers(previous, json);
  for (const name of resigned) {
    if (loadTokens(db, name) !== null) clearTokens(db, name);
  }
  setSetting(db, MCP_CONFIG_KEY, json);
  return { clearedTokensFor: resigned };
}

// -------------------------------------------------------------------- SEC-1

/** SEC-1: SHA-256 of the room's mcp_config JSON, hex-encoded. Any change to the
 * config text changes the fingerprint, so an old approval no longer counts.
 * Ported verbatim from `mcp_fingerprint`. */
export function mcpFingerprint(configJson: string): string {
  return createHash("sha256").update(configJson, "utf8").digest("hex");
}

/** SEC-1: what a server would do, shown in the approval dialog so the user sees
 * exactly what they're allowing. Local: the full command line. Remote: the
 * endpoint it would reach, flagged so the dialog can distinguish "start a
 * program" from "reach a service". Ported verbatim from `render_command_line`. */
export function renderCommandLine(cfg: ServerConfig): string {
  if (cfg.transport.kind === "stdio") {
    return [cfg.transport.command, ...cfg.transport.args].join(" ");
  }
  return `${cfg.transport.url}  (remote — reaches the internet)`;
}

/** How one connector reads in the agent's INVENTORY: the same information, with
 * a command-line credential masked and the local/remote word in front. Ported
 * from `agent_list_mcps`'s own `match &cfg.transport` arm. */
export function inventoryLine(t: Transport): string {
  if (t.kind === "stdio") {
    const args = redactCliArgs(t.args);
    return `local: ${t.command}${args.length === 0 ? "" : ` ${args.join(" ")}`}`;
  }
  return `remote: ${t.url}`;
}

/**
 * SEC-1: the spawn/approval decision for a room's MCP config, decided PURELY
 * from the config text and the set of already-approved fingerprints — no I/O,
 * so it is unit-testable. The spawner and the dialog both route through this,
 * so they can never disagree about whether a config is allowed to run. Ported
 * from `McpGate`/`mcp_gate` as a discriminated union.
 */
export type McpGate =
  | { kind: "nothing"; servers: Array<[string, ServerConfig]> }
  | { kind: "unreadable"; why: string }
  | { kind: "start"; servers: Array<[string, ServerConfig]> }
  | { kind: "needsApproval"; fingerprint: string; servers: Array<[string, ServerConfig]> };

export function mcpGate(configJson: string, approved: ReadonlySet<string>): McpGate {
  let servers: Array<[string, ServerConfig]>;
  try {
    servers = parseMcpConfig(configJson);
  } catch (e) {
    return { kind: "unreadable", why: errMessage(e) };
  }
  if (!servers.some(([, c]) => !c.disabled)) {
    return { kind: "nothing", servers };
  }
  const fingerprint = mcpFingerprint(configJson);
  if (approved.has(fingerprint)) {
    return { kind: "start", servers };
  }
  return { kind: "needsApproval", fingerprint, servers: servers.filter(([, c]) => !c.disabled) };
}

/** The name of the notice row that stands in for the connector list when the
 * room's stored config can't be parsed. Not a connector — {@link agentMcpName}
 * rejects the space, so no real connector can ever be called this. Ported
 * verbatim from `UNREADABLE_CONFIG_ROW`. */
export const UNREADABLE_CONFIG_ROW = "connector setup";

/** The ONE explanation given for a room whose stored connector setup can't be
 * read — used both for the notice row and for anything the user tries to do
 * while it is showing, so the same problem never produces a second, vaguer
 * message. Ported verbatim from `unreadable_config_message`. */
export function unreadableConfigMessage(why: string): string {
  return (
    `This room's connector setup could not be read (${why}). ` +
    `No connectors were started — fix the JSON under Advanced, then Save & Connect.`
  );
}

/** Throws when the room's stored connector config can't be parsed. Nothing on
 * the Connectors page is a real connector in that state — the single row is a
 * notice — so enable/remove must refuse with the explanation rather than act.
 * {@link removeServerFromConfig} in particular SUCCEEDS on a config that merely
 * lacks `mcpServers`, which rewrote it, approved its fingerprint and left the
 * list silently empty again. Ported verbatim from `require_readable_config`. */
export function requireReadableConfig(config: string): void {
  if (config.trim() === "") return;
  try {
    parseMcpConfig(config);
  } catch (e) {
    throw new Error(unreadableConfigMessage(errMessage(e)));
  }
}

// ------------------------------------------------------- consent-card shapes

/** How much of a connector call's arguments the consent card shows. The card
 * scrolls, so this can be generous. Ported from `MCP_ARG_PREVIEW_MAX`. */
export const MCP_ARG_PREVIEW_MAX = 2000;

/** What the consent card shows for a connector call's arguments. Truncation is
 * MARKED and counted: an unmarked slice makes a call carrying a whole document
 * look identical to a trivial one, so "Allow" could approve material that was
 * never on screen. Ported verbatim from `preview_args`. Counts CODE POINTS
 * (`Array.from`), matching Rust's `.chars().count()` rather than UTF-16 units. */
export function previewArgs(args: unknown, max: number): string {
  // `JSON.stringify(undefined)` is `undefined`, not a string; Rust's
  // `Value::to_string()` on the same absence is "null", and the card must
  // render something either way rather than throwing on the way to a consent
  // prompt.
  const raw = JSON.stringify(args) ?? "null";
  const chars = Array.from(raw);
  if (chars.length <= max) return raw;
  const shown = chars.slice(0, max).join("");
  return `${shown}\n\n… showing the first ${max} of ${chars.length} characters. Allowing sends ALL of it.`;
}

/**
 * Whether one connector call may skip its consent card.
 *
 * Pure, and it takes ONLY the two things that may ever excuse the card: the
 * user's standing "don't ask me" preference, and their "always allow" for this
 * connector earlier in the session. The outbound-unmasking preference is
 * deliberately not a parameter — that was the bug the 2026-08-03 split fixed,
 * where asking for real arguments also silently stopped asking permission. Its
 * counterpart `masks_outbound_args` is already ported in `toolSpecs.ts` and is
 * reused rather than duplicated. Ported verbatim from `skips_consent_card`.
 */
export function skipsConsentCard(autoApprove: boolean, rememberedThisSession: boolean): boolean {
  return autoApprove || rememberedThisSession;
}

/** The consent-card payload for an agent-initiated DELETION. Deliberately a
 * different shape from the tool-call card: `confirm` carries the one sentence
 * naming what goes with the thing being deleted, and its presence is what makes
 * the frontend render the destructive card instead of "Allow a connected tool
 * to run?" — copy that would be a lie here, since nothing is being *run*.
 * Ported verbatim from `destructive_request`. */
export function destructiveRequest(id: string, what: string, name: string, detail: string): Record<string, unknown> {
  return { id, server: name, tool: what, args: "", confirm: detail };
}

/** What the agent is told when the user says no. Its own sentence, so the model
 * reports a refusal instead of inventing a reason or trying again. Ported
 * verbatim from `DELETE_DECLINED`. */
export const DELETE_DECLINED = "Not deleted — the confirmation was declined. Nothing was changed.";

// ---------------------------------------------------------------- OAuth glue

/**
 * Merge an `Authorization: Bearer <token>` header into one server's entry in an
 * mcpServers config JSON, preserving everything else. Ported from
 * `merge_bearer`.
 *
 * DEVIATION (deliberate): an entry whose `headers` is present but NOT an object
 * (a hand-edited config with `"headers": "Bearer x"`) has it replaced with a
 * real one carrying the bearer. Rust's `entry("headers").or_insert_with(…)`
 * hands back the existing non-object, its `as_object_mut()` answers `None`, and
 * the bearer is silently dropped while the sign-in still reports success — so
 * the connector keeps failing to authenticate with no way to see why.
 */
export function mergeBearer(config: string, server: string, token: string): string {
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
  const headers = hasOwn(entry, "headers") && isPlainObject(entry["headers"]) ? entry["headers"] : {};
  setOwn(headers, "Authorization", `Bearer ${token}`);
  setOwn(entry, "headers", headers);
  return JSON.stringify(root, null, 2);
}

/** Remove the Authorization header from one server's config entry, leaving the
 * rest intact. Ported verbatim from `strip_bearer`. */
export function stripBearer(config: string, server: string): string {
  const root: unknown = JSON.parse(config); // Rust: bare `.map_err(|e| e.to_string())?`
  const entry = ownEntry(asRecord(asRecord(root)["mcpServers"]), server);
  if (entry !== undefined && hasOwn(entry, "headers") && isPlainObject(entry["headers"])) {
    delete entry["headers"]["Authorization"];
  }
  return JSON.stringify(root, null, 2);
}

// --------------------------------------------------------- secret redaction

/** Keys never shown to (or accepted from) the model. Ported verbatim from
 * `AGENT_SECRET_KEYS`. */
