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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";
import { clearTokens, loadTokens } from "./mcpOauth.js";
import { parseMcpConfig, type ServerConfig, type Transport } from "./mcpClient.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asRecord(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
function hasOwn(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

/** One server's OWN entry in a config's `mcpServers` map, `undefined` when the
 * config genuinely does not have it. Never an inherited member — see
 * {@link hasOwn}. */
function ownEntry(map: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  if (!hasOwn(map, name)) return undefined;
  const entry = map[name];
  return isPlainObject(entry) ? entry : undefined;
}

/** Store a value under a connector's name as an OWN data property. A plain
 * `map[name] = value` invokes `Object.prototype`'s `__proto__` SETTER for that
 * one name, which sets the map's prototype and stores nothing — so the
 * connector silently vanished while the caller reported success. */
function setOwn(map: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(map, name, { value, writable: true, enumerable: true, configurable: true });
}

/** An accumulator keyed by connector name, with no prototype to collide with.
 * `Object.create(null)` is the JS spelling of Rust's `BTreeMap<String, _>`:
 * every key is a key, and nothing is inherited. */
function ownMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

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
function inventoryLine(t: Transport): string {
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
export const AGENT_SECRET_KEYS: readonly string[] = [
  "headers",
  "env",
  "bearer_token_env_var",
  "authorization",
  "token",
  "oauth",
];

/** What the agent-facing views print where a credential would otherwise be.
 * Ported verbatim from `REDACTED_ARG`. */
export const REDACTED_ARG = "[redacted]";

/** Words that mark a command-line flag as carrying a credential, so the value
 * it introduces is masked too: `--api-key sk-…`, `--token=…`, `API_KEY=…`.
 * Ported verbatim from `CREDENTIAL_WORDS`. */
const CREDENTIAL_WORDS: readonly string[] = [
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "auth",
  "bearer",
];

/** Does this flag name promise a credential value? Kebab, snake and camel all
 * spell the same words (`--api-key`, `API_KEY`, `--apiKey`, `--accessToken`).
 * Ported verbatim from `is_credential_flag`. */
export function isCredentialFlag(name: string): boolean {
  const n = name.replace(/^-+/, "").toLowerCase();
  if (n === "") return false;
  const words = n.split(/[^a-z0-9]+/).filter((w) => w !== "");
  if (words.some((w) => CREDENTIAL_WORDS.includes(w))) return true;
  return CREDENTIAL_WORDS.some((w) => n.endsWith(w));
}

const SECRET_PREFIXES: readonly string[] = [
  "sk-",
  "sk_",
  "pk_",
  "rk_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xapp-",
  "AKIA",
  "ASIA",
  "AIza",
  "hf_",
  "shpat_",
  "glpat-",
  "npm_",
  "dop_v1_",
];

/** A bare value that reads like a credential even with nothing naming it: a
 * known vendor prefix, a JWT, or a long opaque run of token characters. Paths,
 * URLs and package specs are deliberately excluded — they carry no secret and
 * they are how the model recognises a connector. Ported verbatim from
 * `looks_like_secret`, byte-length like Rust's `.len()`. */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  const byteLen = Buffer.byteLength(v, "utf8");
  if (byteLen >= 12 && SECRET_PREFIXES.some((p) => v.startsWith(p))) return true;
  // A JWT: three dotted base64url segments, always starts "eyJ".
  if (v.startsWith("eyJ") && v.split(".").length === 3) return true;
  return byteLen >= 24 && /^[A-Za-z0-9_=-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

/** Mask credentials typed straight into a local connector's command line. The
 * named secret FIELDS were covered, but a key given as `--api-key sk-…` went to
 * the model word for word — and in a cloud room that leaves the Mac. Ported
 * verbatim from `redact_cli_args`, arm order included (a `name=value` that
 * fails the credential check falls through to the flag check and then the
 * bare-secret check, exactly like Rust's `match` re-trying later arms against
 * the same `arg`). */
export function redactCliArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      maskNext = false;
      out.push(REDACTED_ARG);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      // `--api-key=…` / `API_KEY=…`, and any `name=<opaque token>`.
      if (value !== "" && (isCredentialFlag(name) || looksLikeSecret(value))) {
        out.push(`${name}=${REDACTED_ARG}`);
        continue;
      }
    }
    // `--api-key` on its own: the credential is the NEXT argument.
    if (arg.startsWith("-") && !arg.includes("=") && isCredentialFlag(arg)) {
      maskNext = true;
      out.push(arg);
      continue;
    }
    if (looksLikeSecret(arg)) {
      out.push(REDACTED_ARG);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** The same masking over an `args` array as it sits in the config JSON.
 * Non-string entries (a config written elsewhere) pass through untouched.
 * Ported verbatim from `redact_json_args`. */
export function redactJsonArgs(args: readonly unknown[]): unknown[] {
  const flat = args.map((v) => (typeof v === "string" ? v : ""));
  const masked = redactCliArgs(flat);
  return masked.map((m, i) => (typeof args[i] === "string" ? m : args[i]));
}

/** What the agent-facing views print in place of a connector's config secrets.
 * A value that is not an object comes back unchanged, matching Rust's
 * `if let Some(map) = safe.as_object_mut()`. Ported verbatim from
 * `redact_agent_mcp_config`. */
export function redactAgentMcpConfig(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  const safe: Record<string, unknown> = { ...config };
  for (const key of AGENT_SECRET_KEYS) {
    // OWN keys only — Rust's `map.remove(key).is_some()` never sees an
    // inherited one, and this decides whether a credential is announced.
    if (hasOwn(safe, key)) safe[key] = REDACTED_ARG;
  }
  // A key typed into the command line is as much a credential as one in `env`,
  // and `args` is not one of the named fields.
  if (Array.isArray(safe["args"])) {
    safe["args"] = redactJsonArgs(safe["args"]);
  }
  return safe;
}

/** Strips every named secret field from a config object the model just handed
 * back, in place — matches Rust's `&mut Value`. Ported verbatim from
 * `remove_agent_mcp_secrets`. */
export function removeAgentMcpSecrets(config: Record<string, unknown>): void {
  for (const key of AGENT_SECRET_KEYS) {
    delete config[key];
  }
}

/**
 * Undo the read-side masking on a write, MUTATING `incoming` in place (matching
 * Rust's `&mut Value` — the caller passes a copy it owns): an argument the
 * model echoed back as `[redacted]` is restored from the stored connector, so
 * saving a connector the model merely read can never overwrite the user's real
 * key with the placeholder text (and the destination still compares equal, so
 * {@link sameDestination} keeps the sign-in).
 *
 * Paired by VALUE, not by position. `read_mcp` shows the masked args, so
 * read → tweak → save is the natural flow and the model may insert, drop or
 * reorder an argument on the way back; matching by index then either stored the
 * literal `[redacted]` (past the end of the old array) or substituted an
 * unrelated old argument. Re-masking the stored args reproduces exactly what
 * the model was shown, and each placeholder takes an as-yet-unused old argument
 * that masked to the same text — preferring the one whose PRECEDING argument
 * matches (`--api-key` vs `--token`), then the same index. A placeholder that
 * pairs with nothing is left alone for {@link rejectSurvivingPlaceholders}.
 * Ported verbatim from `restore_redacted_args`.
 */
export function restoreRedactedArgs(old: Record<string, unknown>, incoming: Record<string, unknown>): void {
  const previousRaw = old["args"];
  if (!Array.isArray(previousRaw)) return;
  const previous = previousRaw.slice();
  const masked = redactJsonArgs(previous);
  const args = incoming["args"];
  if (!Array.isArray(args)) return;
  // What the model handed back, before any restoring — the tie-break reads the
  // argument BEFORE a placeholder, which must be the incoming one.
  const handedBack: Array<string | null> = args.map((a) => (typeof a === "string" ? a : null));
  const used = new Array<boolean>(masked.length).fill(false);
  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    if (typeof cur !== "string" || !cur.endsWith(REDACTED_ARG)) continue;
    const candidates: number[] = [];
    for (let j = 0; j < masked.length; j++) {
      if (!used[j] && masked[j] === cur) candidates.push(j);
    }
    let pick: number | undefined;
    if (candidates.length < 2) {
      pick = candidates[0];
    } else {
      const before = i > 0 ? handedBack[i - 1] : null;
      pick =
        candidates.find((j) => before !== null && j > 0 && masked[j - 1] === before) ??
        candidates.find((j) => j === i) ??
        candidates[0];
    }
    if (pick !== undefined) {
      used[pick] = true;
      args[i] = previous[pick];
    }
  }
}

/** Refuse a save whose `args` still contain the masking placeholder. It stands
 * for a credential the room hides from the assistant, so storing it would erase
 * the user's real key — irrecoverably, and while also reading as a retarget
 * (which drops the connector's env/headers and its sign-in). Ported verbatim
 * from `reject_surviving_placeholders`. */
export function rejectSurvivingPlaceholders(incoming: Record<string, unknown>): void {
  const args = incoming["args"];
  if (!Array.isArray(args)) return;
  if (args.some((a) => typeof a === "string" && a.endsWith(REDACTED_ARG))) {
    throw new Error(
      `One argument is still "${REDACTED_ARG}" and no stored value matches it. That ` +
        `placeholder stands for a credential hidden from you, and saving it would erase the ` +
        `real one — re-read the connector and save it with its arguments in the same order, ` +
        `or ask the user to set the credential in Connectors.`
    );
  }
}

// ------------------------------------------------------ destination/retarget

/** Structural equality over plain JSON values — objects compared by key SET,
 * not key order, mirroring `serde_json::Value`'s own `PartialEq`. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return (
      ak.length === bk.length &&
      ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

/** Does an edited connector still reach the same place? Compares only the
 * fields that decide WHERE a call goes: the endpoint (`url`, and the `type`
 * that marks it remote) for a remote connector, the `command` and `args` for a
 * local one. Ported verbatim from `same_destination` (a private `fn` there,
 * exercised through its own `#[cfg(test)]` module; exported here so this port's
 * tests can state the same property as directly). */
export function sameDestination(oldEntry: Record<string, unknown>, newEntry: Record<string, unknown>): boolean {
  return (["url", "type", "command", "args"] as const).every((k) => deepEqual(oldEntry[k], newEntry[k]));
}

/**
 * Which connectors' stored sign-ins no longer belong to them: every server the
 * PREVIOUS config had that the next one drops, or points somewhere else, or
 * leaves unreadable. Names only — the caller decides what to do with them.
 *
 * A config that cannot be parsed at all yields nothing: this answers "which of
 * these entries moved", and with no readable previous config nothing is known
 * to have moved. The caller has already refused an unreadable NEW config.
 * Ported verbatim from `resigned_servers`.
 */
export function resignedServers(previous: string, next: string): string[] {
  const entries = (raw: string): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(raw);
      const m = asRecord(v)["mcpServers"];
      return isPlainObject(m) ? m : {};
    } catch {
      return {};
    }
  };
  const old = entries(previous);
  const nw = entries(next);
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(old)) {
    const now = ownEntry(nw, name);
    // Dropped entirely, not an entry we can compare, or moved.
    if (!isPlainObject(cfg) || now === undefined || !sameDestination(cfg, now)) {
      out.push(name);
    }
  }
  return out;
}

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
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    v = {};
  }
  const map = ownMap<string[]>();
  if (isPlainObject(v)) {
    for (const [k, list] of Object.entries(v)) {
      if (Array.isArray(list)) map[k] = list.filter((x): x is string => typeof x === "string");
    }
  }
  const list = (map[server] ?? []).filter((t) => t !== tool);
  if (!enabled) list.push(tool);
  if (list.length === 0) delete map[server];
  else map[server] = list;
  return stringifySorted(map);
}

/** Serialize a map with its keys in sorted order — Rust writes these files from
 * a `BTreeMap`, and a stored file that reorders itself between runs is a
 * needless diff (and, for a fingerprinted document, a needless re-approval). */
function stringifySorted<T>(map: Record<string, T>): string {
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

interface WireConnectorOverride {
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
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(v)) return ownMap();
  const out = ownMap<ConnectorOverride>();
  for (const [server, entryRaw] of Object.entries(v)) {
    if (!isPlainObject(entryRaw)) continue;
    const entry = entryRaw as WireConnectorOverride;
    const over: ConnectorOverride = {};
    if (typeof entry.auto_approve === "boolean") over.autoApprove = entry.auto_approve;
    if (typeof entry.outbound_unmask === "boolean") over.outboundUnmask = entry.outbound_unmask;
    out[server] = over;
  }
  return out;
}

function stringifyConnectorPowers(map: Record<string, ConnectorOverride>): string {
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
  if (power === "autoApprove") {
    if (value === null) delete entry.autoApprove;
    else entry.autoApprove = value;
  } else {
    if (value === null) delete entry.outboundUnmask;
    else entry.outboundUnmask = value;
  }
  if (entry.autoApprove === undefined && entry.outboundUnmask === undefined) {
    delete map[server];
  } else {
    map[server] = entry;
  }
  return stringifyConnectorPowers(map);
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

function readFileIfExists(file: string): string | null {
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
  const configArg = args["config"];
  if (!isPlainObject(configArg)) {
    throw new Error("save_mcp needs a `config` object.");
  }
  // A deep copy, like Rust's `args.get("config").cloned()`: `restoreRedactedArgs`
  // mutates `incoming.args` in place, and a shallow spread would reach through
  // into the caller's own arguments object.
  const incoming = structuredClone(configArg);
  removeAgentMcpSecrets(incoming);

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
  const CARRIED: readonly string[] = ["headers", "env", "bearer_token_env_var"];
  let retargeted = false;
  let hadCredentials = false;
  const old = ownEntry(servers, name);
  if (old !== undefined) {
    // read_mcp showed `[redacted]` where a command-line key was; writing that
    // back verbatim would replace the user's real key with the placeholder (and
    // read as a retarget). Put the original back first.
    restoreRedactedArgs(old, incoming);
    hadCredentials = CARRIED.some((k) => hasOwn(old, k)); // Rust: `old.contains_key`
    const same = sameDestination(old, incoming);
    retargeted = !same;
    if (same) {
      for (const key of CARRIED) {
        if (hasOwn(old, key)) incoming[key] = old[key];
      }
    }
  }
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
  const hadSignin = loadTokens(db, name) !== null;
  if (retargeted) {
    clearTokens(db, name);
  }
  setSetting(db, MCP_CONFIG_KEY, json);

  deps.reconnect?.(parseMcpConfig(json));

  const dropped =
    retargeted && (hadCredentials || hadSignin)
      ? " Its saved credentials and sign-in were NOT carried over, because this edit changed where the connector points."
      : "";
  // Same reason the credentials stay behind: "run without asking" and "send real
  // values" were granted to the place this connector used to reach, and they
  // are keyed by its NAME, so leaving them would hand both to the new
  // destination without anyone being asked.
  let permissions = "";
  if (retargeted) {
    try {
      if (deps.forgetConnectorGrants?.(name)?.cleared === true) {
        permissions =
          ' The permissions saved for it ("run without asking" / "send real values") were cleared for the same reason.';
      }
    } catch (e) {
      permissions = ` ${errMessage(e)}`;
    }
  }

  return (
    `${existed ? "Updated" : "Saved"} connector "${name}" as disabled.${dropped}${permissions} ` +
    `Review it in Connectors, add any credentials there, then explicitly enable and approve it before it can run or reach the network.`
  );
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
