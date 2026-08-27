/**
 * PRIV-1/PRIV-2: the privacy gatekeeper — Electron half. Ported from
 * `src-tauri/src/commands/privacy.rs` (1831 lines, read in full), minus the
 * mechanical redact/restore engine, which lives in `privacyRedact.ts`, and the
 * entity-map/scan bookkeeping CRUD, which lives in `db-host/privacy.ts` — the
 * same split the Rust source makes between `commands/privacy.rs` and
 * `db/privacy.rs`.
 *
 * The principle (mirrored in the sidecar's `privacy.py`): the moment content
 * leaves for a NON-LOCAL model it passes a MECHANICAL door — protected strings
 * are replaced by stable placeholders, answers are restored on the way back —
 * and the AI judgment about WHAT is private happens ahead of time, in the
 * local import-time scanner, where its findings are stored, visible and
 * fixable.
 *
 * This module owns:
 *   - the room's resolved policy, cached so every sidecar request body and the
 *     external-CLI path can consult it without re-reading the DB
 *     ({@link PolicyState}, {@link refreshPolicy}, {@link activePolicy},
 *     {@link remoteSeamRedactor});
 *   - the outbound seams: the web/URL door ({@link maskOutboundWeb},
 *     {@link outboundUrlHides}) and the remote-connector one
 *     ({@link connectorArgsMasked}, {@link everyConnectorMasked});
 *   - the commands behind the Settings section, the reader's cloud view
 *     ({@link privacyPreview}) and the chat valve ({@link injectPolicy});
 *   - the background scan runner that keeps per-file scan state fresh.
 *
 * WHAT IS INJECTED, AND WHY. `AppState`/`tauri::AppHandle` have no counterpart
 * in this rewrite yet, so — following the convention `jobs.ts`, `cancel.ts`,
 * `mcpConfig.ts`, `roomPin.ts` and `execTool.ts` already established, rather
 * than inventing a second one — each missing piece of host state is a named
 * dependency, and this module reuses the seams those files already declared
 * instead of minting new notions of the same thing:
 *
 *   1. `jobs.ts`'s {@link RoomSource}/{@link RoomHandle} for "which room is
 *      open right now" — the exact `state.room.lock()` analogue, and the one
 *      the scan runner needs anyway because it re-checks the room PATH before
 *      every write. `roomEpoch()` (`AppState::room_epoch`) is the other half
 *      of `roomPin.ts`'s pin; any `RoomPinSource` satisfies it structurally.
 *   2. {@link PrivacyScanDeps}: the sidecar `/privacy_scan` call, whether an
 *      interactive turn is in flight (`state.cancels`), the daemon wake
 *      (`crate::ollama::wake_daemon`, a gap `engineRouting.ts`'s own header
 *      already names), and the progress sink. The loop's own decision logic —
 *      generation bumps, room-epoch abandonment, the failed-file set, pausing
 *      while the user chats — is REAL and ported faithfully either way.
 *   3. Live MCP connector state for {@link everyConnectorMasked}: the manager
 *      exists (`mcpClient.ts`) but nothing holds one as app state yet, so
 *      callers pass a snapshot ({@link ConnectorMaskInputs}).
 *
 * NOT injected, because it landed for real while this was being written:
 * `capabilities.ts`'s `runsOnThisMac`/`ollamaRunsHere` — "the MODEL declares
 * itself local AND the TRANSPORT points at this Mac", the predicate that
 * decides whether a request carries the door at all. It is called directly,
 * exactly as `compute_policy`/`inject_policy` call it, rather than taken as a
 * parameter some caller could answer differently: this module and the trust
 * badge must never disagree about whether content is leaving. (The reverse
 * direction is already wired the same way — `capabilities.ts`'s
 * `imageReachesModel` takes `privacyDoorActive`, which is this file's
 * {@link activePolicy} being non-null.)
 *
 * PORTED FRESH HERE: {@link outboundUnmaskFor}
 * (`mcp_cmds::outbound_unmask_for`, over `mcpConfig.ts`'s already-ported
 * `effectivePower`).
 *
 * NOT YET WIRED: nothing in this tree calls {@link injectPolicy} yet.
 * `engineRouting.ts`/`sidecar.ts` both document it as a dropped step, and
 * wiring it means editing already-committed files — a future batch's job. The
 * Rust doc's warning applies to that batch: EVERY sidecar gateway must call
 * this, or cloud engines receive raw room content, which is exactly the leak
 * `ollama.rs::sidecar_post` had until 2026-07-25.
 *
 * VISIBILITY WIDENING: {@link computePolicy}/{@link installPolicy}/
 * {@link Computed}/{@link rulesSha}/{@link runPrivacyScan} are private items in
 * Rust, reachable from `#[cfg(test)] mod tests` only because a Rust test module
 * is a child of its file. TypeScript has no such concept, so they are exported
 * — the same mild widening `files.ts` already cites for `inTransaction`/
 * `insertChunks` — purely so the tests can pin the same behaviours as directly
 * as the Rust suite does.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { queryOne, executeOne } from "./db-host/util.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import {
  addPrivacyEntity,
  deletePrivacyEntity,
  dismissPrivacyEntity,
  entitySource,
  filesNeedingPrivacyScan,
  listPrivacyEntities,
  privacyTextSha,
  setPrivacyScan,
  type PrivacyEntity,
} from "./db-host/privacy.js";
import {
  emptyPrivacyReport,
  isProtectable,
  MIN_PROTECTED_CHARS,
  Redactor,
  type PrivacyRule,
} from "./privacyRedact.js";
import { ollamaRunsHere, runsOnThisMac } from "./capabilities.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { DEFAULT_MODEL, isEmbeddingModel } from "./turnContext.js";
import { effectivePower, type ConnectorOverride } from "./mcpConfig.js";
import { masksOutboundArgs } from "./toolSpecs.js";
import type { ServerStatus } from "./mcpClient.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import type { PrivacyPreview, PrivacyScanProgress, PrivacyStatus } from "../shared/apiTypes.js";

export type { RoomHandle, RoomSource };

/** Room settings keys. Ported verbatim from `KEY_SWITCH`/`KEY_CONCEPTS`. */
const KEY_SWITCH = "cloud_privacy"; // "on" | "off"; absent = global default
const KEY_CONCEPTS = "cloud_privacy_concepts"; // JSON array of strings

/** Bump when the scanner's behaviour changes enough that old scans are stale.
 * Part of {@link rulesSha}, so a bump re-stales every file in every room. */
const SCANNER_VERSION = "v1";

/** How many private topics one room may hold. Every one of them is sent to the
 * live guard on each cloud turn, so the list is a prompt as well as a setting. */
export const MAX_PRIVACY_CONCEPTS = 20;

/** `AppState::with_room`'s own refusal, spelled the way `execTool.ts` already
 * spells it — one sentence for one situation. */
const NO_ROOM_OPEN = "No room is open.";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Everything a policy computation needs from the not-yet-ported host state:
 * the open room, and the app-data directory `privacy.json` lives in. */
export interface PolicyDeps {
  room: RoomSource;
  userDataDir: string;
}

/** The open room, or a thrown "No room is open." — `state.with_room`'s guard,
 * in one place. */
function requireRoom(deps: { room: RoomSource }): RoomHandle {
  const room = deps.room.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return room;
}

// ---------------------------------------------------------------------------
// The cached room policy
// ---------------------------------------------------------------------------

/** Ported from `PolicyState`. */
export interface PolicyState {
  /** The switch, fully resolved (room override, else global default). */
  active: boolean;
  rules: PrivacyRule[];
  concepts: string[];
  /** A LOCAL model for the sidecar's live guard + the scanner. */
  guardModel: string;
  redactor: Redactor;
}

/** The wire payload the sidecar's `policy_from_payload` parses. A free
 * function rather than a method, since {@link PolicyState} is a plain data
 * shape. Ported from `PolicyState::payload`. */
export function policyPayload(policy: PolicyState): Record<string, unknown> {
  // While the background document scan is grinding through the library it
  // monopolizes the local model — a live-guard call would queue behind it and
  // make cloud chat feel stuck. Withholding the guard model skips the live
  // guard for those turns; the exact rules (the real protection) are enforced
  // mechanically regardless.
  const guardModel = scanRunning() ? null : policy.guardModel;
  return {
    active: policy.active,
    rules: policy.rules.map(([real, placeholder]) => ({ real, placeholder })),
    concepts: policy.concepts,
    guard_model: guardModel,
    // Only this side can see where the Ollama transport points, and the model
    // name cannot. Told, never guessed.
    relayed: !ollamaRunsHere(),
  };
}

/** The process-wide policy cell — a plain module variable, mirroring
 * `engineRouting.ts`'s `baseUrlOverride`. Node has no threads to race over it
 * the way Rust's `OnceLock<Mutex<…>>` guards against, and no `policy_test_lock`
 * is needed either: vitest runs the cases within one file sequentially. */
let policyCell: PolicyState | null = null;

/**
 * The current policy when it is ACTIVE (switch on) — the enforcement getter.
 *
 * The switch is the WHOLE condition. It used to also require a non-empty
 * entity map, on the reasonable-sounding logic that with nothing to replace
 * there is nothing to do — but the map is only ONE of three things this policy
 * carries. `concepts` (the user's topic rules) are enforced by the sidecar's
 * live guard, which never runs if the policy is not attached; and images are
 * stripped from a non-local request by that same attachment, which is the only
 * protection a photograph gets, since pixels cannot be redacted. So in a
 * brand-new room the panel said the door was ON while topic rules were never
 * applied and photographs went to the cloud in full. Ported from
 * `active_policy`, comment and all.
 */
export function activePolicy(): PolicyState | null {
  return policyCell !== null && policyCell.active ? policyCell : null;
}

/**
 * The room's redactor for the OUTBOUND remote-connector seam. Unlike
 * {@link activePolicy} this IGNORES the on/off switch: a remote connector is a
 * hard non-local destination, so the room's known entities are masked before a
 * tool call's arguments leave even when the chat-model door is off. `null`
 * when the entity map is empty — there is then nothing to mask mechanically,
 * and the SEC-1b per-call consent (which shows the user the exact args) is the
 * floor. Ported from `remote_seam_redactor`.
 *
 * ONE caller-side exception, in `exec_tool`: Connectors → "Send remote
 * connectors real values" skips this seam entirely (see
 * {@link outboundUnmaskFor}). That flag is the only thing with this power, and
 * the exception lives at the call site, where it is known — this function stays
 * switch-blind, deliberately.
 */
export function remoteSeamRedactor(): PolicyState | null {
  return policyCell !== null && !policyCell.redactor.isEmpty() ? policyCell : null;
}

/** Room closed: no policy may outlive the room (teardown invariant). Ported
 * from `clear_policy`. */
export function clearPolicy(): void {
  policyCell = null;
}

// --- test-only fixtures. TypeScript has no `#[cfg(test)]`, so these are
// ordinary exports whose NAME says so — the convention `engineRouting.ts`'s
// `resetBaseUrlOverrideForTests` established. Ported from
// `set_policy_rules_for_test`/`set_policy_for_test`/`set_active_policy_for_test`.

export function setPolicyRulesForTests(active: boolean, rules: readonly PrivacyRule[]): void {
  const owned: PrivacyRule[] = rules.map(([r, p]) => [r, p] as const);
  policyCell = { active, redactor: new Redactor(owned), rules: owned, concepts: [], guardModel: DEFAULT_MODEL };
}

export function setPolicyForTests(active: boolean): void {
  setPolicyRulesForTests(active, [["Ben Reich", "[Person A]"]]);
}

export function setActivePolicyForTests(): void {
  setPolicyForTests(true);
}

// ---------------------------------------------------------------------------
// Concepts + the global default file
// ---------------------------------------------------------------------------

/**
 * Ported from `parse_concepts`.
 *
 * ONE DELIBERATE DIFFERENCE, in the protective direction: Rust deserializes
 * `Vec<String>` whole, so a stored array with one non-string element fails the
 * parse and `unwrap_or_default()` throws away EVERY topic in it. Here the
 * non-strings are dropped and the real topics survive — these are protection
 * rules, and silently discarding a user's whole topic list because something
 * wrote a stray number into the JSON is the one direction this module does not
 * get to fail in.
 */
function parseConcepts(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

/** The global-default file: a tiny JSON in the app data dir, OUTSIDE any room
 * — it has to exist before a room is open. `userDataDir` is passed in rather
 * than read from `app.getPath('userData')` here, the convention `mcpConfig.ts`
 * documents. Ported from `global_default_path`. */
export function globalDefaultPath(userDataDir: string): string {
  return path.join(userDataDir, "privacy.json");
}

/** Absent file = ON: privacy is the default, turning it off is the explicit
 * act. Ported from `global_default_on`. */
export function globalDefaultOn(userDataDir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(globalDefaultPath(userDataDir), "utf8");
  } catch {
    return true;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (isPlainObject(v)) {
      // OWN key only (see `ownValue`): `{}` on disk must read as "not set" —
      // i.e. ON — and never as whatever an inherited `defaultOn` says.
      const flag = ownValue(v, "defaultOn");
      if (typeof flag === "boolean") {
        return flag;
      }
    }
    return true;
  } catch {
    return true;
  }
}

/** Ported from `set_global_default`. Throws on a write failure exactly as
 * Rust's `Result` propagates one — a default the user believes they changed
 * must not silently stay put. */
export function setGlobalDefault(userDataDir: string, on: boolean): void {
  const p = globalDefaultPath(userDataDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ defaultOn: on }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One key of an object, read as an OWN property — `undefined` for a key this
 * object does not itself carry, whatever `Object.prototype` may have on it.
 *
 * The stand-in for `serde_json::Map::get`, which has no prototype chain to walk
 * at all, and the reason every read in this file that decides whether the door
 * ENGAGES goes through it. A plain `obj[key]` is a lookup up the prototype
 * chain, so a prototype-pollution bug ANYWHERE in this process — the class
 * `mcpConfig.ts` and `privacyRedact.ts` each already guard their own half of,
 * and which {@link outboundUnmaskFor} has a test for — reaches in here and
 * answers for a key the caller never set. At this door the two consequences are
 * the worst ones the module has: an inherited `privacy` reads as "the caller
 * already decided", so {@link injectPolicy} attaches NO policy and the whole
 * request goes to a cloud model raw; an inherited `defaultOn: false` turns the
 * app-wide default OFF for every room that never set its own switch.
 */
function ownValue(obj: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// ---------------------------------------------------------------------------
// Recompute / install / refresh
// ---------------------------------------------------------------------------

/** What a recomputation could establish about the room's policy. Ported from
 * `Computed`. */
export type Computed =
  | { kind: "noRoom" }
  | { kind: "policy"; policy: PolicyState }
  /** The room is open but its ENTITY MAP could not be read. Everything else
   * (the switch, the topic rules, the guard model) is known; only the
   * mechanical rules are missing. */
  | { kind: "partial"; policy: PolicyState };

/** Ported from `compute_policy`. */
export function computePolicy(deps: PolicyDeps): Computed {
  const room = deps.room.current();
  if (room === null) {
    return { kind: "noRoom" };
  }
  const switchValue = getSetting(room.db, KEY_SWITCH);
  const active =
    switchValue === "off" ? false : switchValue === "on" ? true : globalDefaultOn(deps.userDataDir);

  let entities: PrivacyEntity[] = [];
  let entitiesReadOk = true;
  try {
    entities = listPrivacyEntities(room.db);
  } catch {
    entitiesReadOk = false;
  }
  const rules: PrivacyRule[] = entities
    .filter((e) => e.source !== "dismissed")
    .map((e) => [e.realText, e.placeholder] as const);
  const concepts = parseConcepts(getSetting(room.db, KEY_CONCEPTS));

  // The live guard + scanner need a model that runs ON THIS MAC. The room's
  // chosen model qualifies only when local; otherwise the tuned default.
  // `runsOnThisMac` — the ONE definition of "runs here" — rather than a pair
  // of name tests, which missed Ollama's `<size>-cloud` spelling and so would
  // have made a HOSTED model the guard for the privacy door itself.
  const roomModel = modelSetting(room.db) ?? "";
  const guardModel =
    roomModel !== "" && runsOnThisMac(roomModel) && !isEmbeddingModel(roomModel) ? roomModel : DEFAULT_MODEL;

  const policy: PolicyState = { active, redactor: new Redactor(rules), rules, concepts, guardModel };
  return entitiesReadOk ? { kind: "policy", policy } : { kind: "partial", policy };
}

/**
 * Put a recomputation into the cell — the one place the cell is written in a
 * real run, and the whole of the fail-closed rule. Ported from
 * `install_policy`.
 *
 * A failed entity-map read used to land as `None`, which CLEARED the cell — and
 * a cleared cell is the door wide open: no policy on the sidecar request (so
 * nothing redacted and images no longer stripped), no outbound masking of
 * remote-connector arguments, no masking of web queries, and the scanner
 * silently declining to run. All of that from one transient read, with the
 * panel still reading "On for this room". So a read failure keeps the rules
 * already in force and applies THIS room's switch and topics to them: the
 * switch decides whether the model seams engage, so it may never come from a
 * stale reading, while rules only ever hide more.
 */
export function installPolicy(computed: Computed): void {
  switch (computed.kind) {
    case "noRoom":
      policyCell = null;
      return;
    case "policy":
      policyCell = computed.policy;
      return;
    case "partial": {
      const previous = policyCell;
      if (previous === null) {
        policyCell = computed.policy;
        return;
      }
      // A NEW object rather than a mutation of `computed.policy`: Rust owns
      // its `Computed::Partial(mut p)`, this one belongs to the caller.
      const rules = previous.rules.slice();
      policyCell = { ...computed.policy, rules, redactor: new Redactor(rules) };
      return;
    }
  }
}

/** Recompute the cached policy from the open room + the global default. Call
 * after room open, any privacy-settings change, and any entity-map change.
 * Ported from `refresh_policy`. */
export function refreshPolicy(deps: PolicyDeps): void {
  installPolicy(computePolicy(deps));
}

// ---------------------------------------------------------------------------
// inject_policy — the chat valve
// ---------------------------------------------------------------------------

/**
 * Attach the room policy to a sidecar request body when its `model` is
 * non-local and the door is on. Ported from `inject_policy`; see this file's
 * module doc for the wiring that still has to happen around it.
 */
export function injectPolicy(body: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  // Both reads are OWN-property reads ({@link ownValue}), which is what Rust's
  // `body.get(...)` on a `serde_json::Map` is. Inheriting either key from a
  // polluted `Object.prototype` would answer this door's two questions with
  // something no caller wrote — and for `privacy` the answer is "skip".
  const model = ownValue(body, "model");
  if (typeof model !== "string") {
    return null;
  }
  // EXTENDS the door, never narrows it: `runsOnThisMac` is strictly more
  // conservative than the pair of name tests it replaced — it also catches
  // Ollama's `<size>-cloud` spelling, which used to reach the sidecar with NO
  // policy attached at all, and it asks where the TRANSPORT points, which is
  // what closes the Closet hole.
  if (runsOnThisMac(model)) {
    return null;
  }
  // `!== undefined` rather than `"privacy" in body`: a body carrying an
  // explicit `privacy: undefined` has NOT decided anything (JSON.stringify
  // drops the key, so the sidecar would see no policy at all), and the door
  // must engage for it. A real bypass sets a value — `null` included, which is
  // what Rust's `body.get("privacy").is_some()` means for a JSON null.
  if (ownValue(body, "privacy") !== undefined) {
    return null; // caller already decided (e.g. an explicit bypass)
  }
  const policy = activePolicy();
  if (policy === null) {
    return null;
  }
  return { ...body, privacy: policyPayload(policy) };
}

// ---------------------------------------------------------------------------
// rules_sha
// ---------------------------------------------------------------------------

/**
 * sha256 hex of the scan-relevant rule state: concepts + scanner version.
 * Entity-map changes deliberately do NOT stale scans — new block-list items
 * enforce mechanically without re-reading any document. Ported from
 * `rules_sha`.
 *
 * The concepts are sorted by their UTF-8 BYTES, which is what Rust's
 * `Vec<&String>::sort()` does, rather than by `Array.prototype.sort`'s UTF-16
 * code-unit order — the two disagree for astral characters (a 4-byte sequence
 * sorts after U+E000..U+FFFF in UTF-8 and before it in UTF-16). The digest is
 * PERSISTED in `privacy_scans.rules_sha256` and this app opens rooms the Rust
 * build wrote, so a digest that differs for the same topic list would silently
 * re-scan a whole library once. Joined with U+001F for the same reason Rust
 * picks it: without a separator, ["ab","c"] and ["a","bc"] would hash alike.
 */
export function rulesSha(concepts: readonly string[]): string {
  const sorted = [...concepts].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const joined = `${SCANNER_VERSION}|${sorted.join("\u001f")}`;
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// PRIV-4 — the web seam
// ---------------------------------------------------------------------------

/**
 * Mask the room's protected entities out of a string the AGENT is about to
 * send to a public web service (a `web_search` query, a `fetch_page` URL).
 * Ported from `mask_outbound_web`.
 *
 * Why this seam exists: the door redacts on the way to a cloud model, then
 * RESTORES placeholders in the tool-call arguments coming back, because a room
 * tool must see the real name to find anything. That restore is right for a
 * tool that reads the room's own database and wrong for a tool whose argument
 * leaves the Mac — a cloud model asking to search "[Person A]" had the real
 * name put back and handed to seven search engines.
 *
 * Governed by the SWITCH, unlike the remote-connector seam: a remote connector
 * is a hard non-local destination whatever the user thinks, while the web is a
 * destination the user chose by turning web access on, and with the door off
 * real names already flow to cloud models — so masking here would protect
 * against a threat the user has already accepted while quietly breaking every
 * search for a name on the block list.
 *
 * `null` when nothing changed, so a caller can stay silent unless it actually
 * has something to disclose. Never silent when it DID change: every caller
 * says so in the tool result ({@link webMaskNote}), because the model must not
 * report a search it believes was about the real name.
 */
export function maskOutboundWeb(text: string): { masked: string; hidden: number } | null {
  const policy = activePolicy();
  if (policy === null) {
    return null;
  }
  const report = emptyPrivacyReport();
  const masked = policy.redactor.redact(text, report);
  return masked === text ? null : { masked, hidden: report.entitiesHidden };
}

/** Percent-decode, permissively: a malformed `%` sequence is left alone rather
 * than dropped. Only ever used to LOOK at a URL, never to rebuild one, so being
 * generous costs nothing and being strict would open the hole below. Works on
 * the UTF-8 BYTES of `s` — the direct translation of Rust's byte-slice walk,
 * finished with a lossy decode like `String::from_utf8_lossy` — so `%C3%A9`
 * reassembles into one character instead of two mismatched halves. Ported from
 * `percent_decode`. */
export function percentDecode(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0x25 /* % */ && i + 2 < bytes.length) {
      const h = hexDigit(bytes[i + 1]!);
      const l = hexDigit(bytes[i + 2]!);
      if (h !== null && l !== null) {
        out.push(h * 16 + l);
        i += 3;
        continue;
      }
    }
    // `+` is a space in a query string, and "Ben+Reich" is the single most
    // likely spelling of a name a model puts in a search URL.
    out.push(bytes[i] === 0x2b /* + */ ? 0x20 : bytes[i]!);
    i += 1;
  }
  return Buffer.from(out).toString("utf8");
}

function hexDigit(byte: number): number | null {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // '0'-'9'
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10; // 'A'-'F'
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10; // 'a'-'f'
  return null;
}

/**
 * Does this URL carry any of the room's protected names? Returns how many.
 * Ported from `outbound_url_hides`.
 *
 * Separate from {@link maskOutboundWeb} because a URL is ENCODED: a cloud model
 * writing `https://example.com/?q=Ben%20Reich` (or `Ben+Reich`) hands over the
 * real name while the raw string contains no entity the redactor can see. The
 * callers refuse rather than mask — a URL with a placeholder in its path or
 * query only 404s — so this answers the question a refusal needs and nothing
 * more. Governed by the switch, exactly like the masking half.
 */
export function outboundUrlHides(url: string): number | null {
  const policy = activePolicy();
  if (policy === null) {
    return null;
  }
  const report = emptyPrivacyReport();
  const hits = (text: string): boolean => policy.redactor.redact(text, report) !== text;
  const decoded = percentDecode(url);
  const leaks = hits(url) || hits(decoded);
  return leaks ? Math.max(report.entitiesHidden, 1) : null;
}

/** The disclosure line that goes with {@link maskOutboundWeb}. Says what was
 * done and how to undo it, so a masked search cannot read as a failed one.
 * Ported verbatim from `web_mask_note`. */
export function webMaskNote(hidden: number): string {
  return (
    `\n\nNote: ${hidden} protected name(s) in this request were replaced with placeholders ` +
    "before it left this Mac (Settings → Cloud privacy). The results are for the masked " +
    "wording, NOT the real name — say so rather than presenting them as results for the " +
    "real name."
  );
}

// ---------------------------------------------------------------------------
// The remote-connector seam
// ---------------------------------------------------------------------------

/**
 * "Send remote connectors real values", as it applies to ONE connector. Ported
 * from `mcp_cmds::outbound_unmask_for`, over `mcpConfig.ts`'s `effectivePower`
 * (the pure two-level combinator) rather than re-spelling it.
 *
 * The override is read as an OWN property only. A connector NAME travels inside
 * the `.roomai`, whose author is the attacker SEC-1 is built on, and a plain
 * `powers[name]` for a connector called `constructor`, `toString` or `valueOf`
 * answers with something off `Object.prototype` instead of with this room's
 * setting — so an explicit "mask this one" override would be silently ignored
 * and the Mac-wide switch (possibly "send real values") would decide instead.
 * `mcpConfig.ts`'s `parseConnectorPowers` already builds its maps with
 * `Object.create(null)` for exactly this reason; this guard makes the seam
 * correct for any caller's map, not only that one.
 */
export function outboundUnmaskFor(
  globalUnmask: boolean,
  connectorPowers: Readonly<Record<string, ConnectorOverride>>,
  server: string
): boolean {
  return effectivePower(globalUnmask, ownOverride(connectorPowers, server)?.outboundUnmask);
}

function ownOverride(
  map: Readonly<Record<string, ConnectorOverride>>,
  name: string
): ConnectorOverride | undefined {
  return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
}

/**
 * Are remote-connector arguments being masked RIGHT NOW? The one fact the
 * Cloud-privacy panel cannot derive from its own switch, because
 * {@link remoteSeamRedactor} is switch-blind — so the panel's off-state
 * warning used to state the opposite of what happens ("…go to cloud models
 * with real names", full stop, while a remote connector was still being asked
 * about `[Person A]`). Reported rather than changed. Ported from
 * `connector_args_masked`.
 */
export function connectorArgsMasked(unmaskOutbound: boolean): boolean {
  return remoteSeamRedactor() !== null && masksOutboundArgs(true, unmaskOutbound);
}

/** A snapshot of the live MCP connector state {@link everyConnectorMasked}
 * needs — see the module doc's numbered list, item 4. */
export interface ConnectorMaskInputs {
  statuses: readonly ServerStatus[];
  outboundUnmaskGlobal: boolean;
  connectorPowers: Readonly<Record<string, ConnectorOverride>>;
}

/** The "no live manager wired up yet" default — also exactly what
 * `every_connector_masked` falls back to when a room has no remote connector
 * configured. */
export const NO_CONNECTORS: ConnectorMaskInputs = {
  statuses: [],
  outboundUnmaskGlobal: false,
  connectorPowers: {},
};

/**
 * The panel's version of the question, asked once per REMOTE connector this
 * room has connected. Ported from `every_connector_masked`.
 *
 * Unmasking became per-connector on 2026-08-03 and the note did not follow it:
 * reading the Mac-wide switch alone, the panel printed "a remote connector is
 * still sent placeholders" while a connector whose own override says otherwise
 * received the real names. The honest summary is the WEAKEST answer among them
 * — masking may only be claimed when EVERY remote connector is masked. A
 * DISABLED connector cannot be called at all, so its override says nothing
 * about what leaves this room; with no remote connector in the list there is no
 * seam to describe and the Mac-wide switch is the room-wide answer.
 */
export function everyConnectorMasked(mcp: ConnectorMaskInputs): boolean {
  const remote = mcp.statuses.filter((s) => s.remote && s.status !== "disabled").map((s) => s.name);
  if (remote.length === 0) {
    return connectorArgsMasked(mcp.outboundUnmaskGlobal);
  }
  return remote.every((name) =>
    connectorArgsMasked(outboundUnmaskFor(mcp.outboundUnmaskGlobal, mcp.connectorPowers, name))
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Ported from `privacy_status`. The connector answer is computed BEFORE the
 * room is required, exactly as Rust computes it outside `with_room`. */
export function privacyStatus(deps: PolicyDeps, mcp: ConnectorMaskInputs = NO_CONNECTORS): PrivacyStatus {
  const globalOn = globalDefaultOn(deps.userDataDir);
  const connectorMasked = everyConnectorMasked(mcp);
  const room = requireRoom(deps);
  const switchValue = getSetting(room.db, KEY_SWITCH);
  const effective = switchValue === "off" ? false : switchValue === "on" ? true : globalOn;
  const concepts = parseConcepts(getSetting(room.db, KEY_CONCEPTS));
  const entities = listPrivacyEntities(room.db).filter((e) => e.source !== "dismissed");
  const pending = filesNeedingPrivacyScan(room.db, rulesSha(concepts)).length;
  return {
    globalDefaultOn: globalOn,
    roomSetting: switchValue,
    effectiveOn: effective,
    entities,
    concepts,
    pendingFiles: pending,
    scanning: scanRunning(),
    lastScanError: lastScanError(),
    connectorArgsMasked: connectorMasked,
  };
}

/**
 * The room switch: "on" | "off" | "default" (drop the override). `mode` stays a
 * plain `string`, matching Rust's own runtime validation — the IPC boundary
 * narrows it, but this function states its own floor rather than trusting the
 * caller's type. Ported from `set_privacy_room`.
 */
export function setPrivacyRoom(deps: PolicyDeps, mode: string, scan?: PrivacyScanDeps): void {
  const room = requireRoom(deps);
  switch (mode) {
    case "on":
    case "off":
      setSetting(room.db, KEY_SWITCH, mode);
      break;
    case "default":
      // "Follow the app default instead" is a write like any other: a DELETE
      // that failed used to return Ok, so the panel reloaded with the override
      // still in place and nothing said why. (`executeOne`, not
      // `executeExisting`: deleting an override that was never set IS the
      // desired state, not a failure.)
      executeOne(room.db, "DELETE FROM settings WHERE key = ?", [KEY_SWITCH]);
      break;
    default:
      throw new Error(`unknown privacy mode: ${mode}`);
  }
  refreshPolicy(deps);
  if (activePolicy() !== null && scan !== undefined) {
    schedulePrivacyScan(scan);
  }
}

/** Ported from `set_privacy_global`. */
export function setPrivacyGlobal(deps: PolicyDeps, on: boolean, scan?: PrivacyScanDeps): void {
  setGlobalDefault(deps.userDataDir, on);
  refreshPolicy(deps);
  if (on && scan !== undefined) {
    schedulePrivacyScan(scan);
  }
}

const KNOWN_CATEGORIES: readonly string[] = ["person", "address", "phone", "email", "id", "org"];

/**
 * Add one explicit block-list item (source 'user' — iron-clad, enforced
 * mechanically on every outbound request from now on; no re-scan needed).
 * Ported from `add_privacy_block`.
 *
 * The door's own floor is stated at the door's own entrance: Settings used to
 * accept a single character, list it as protected, and then have the redactor
 * drop it — so the panel showed protection that was not happening, and a room
 * whose ONLY item was that character had no active policy at all (images
 * included).
 */
export function addPrivacyBlock(deps: PolicyDeps, text: string, category: string): PrivacyEntity {
  const room = requireRoom(deps);
  const cat = KNOWN_CATEGORIES.includes(category) ? category : "concept";
  if (!isProtectable(text)) {
    throw new Error(
      `A protected item needs at least ${MIN_PROTECTED_CHARS} characters — anything shorter ` +
        "would match almost every word."
    );
  }
  const entity = addPrivacyEntity(room.db, text, cat, "user");
  refreshPolicy(deps);
  return entity;
}

/** Remove an entity. A user block-list row is deleted outright; a scan finding
 * becomes a tombstone so the next re-scan can't quietly resurrect it. Ported
 * from `remove_privacy_entity`. */
export function removePrivacyEntity(deps: PolicyDeps, id: string): void {
  const room = requireRoom(deps);
  const source = entitySource(room.db, id);
  if (source === "user") {
    deletePrivacyEntity(room.db, id);
  } else {
    dismissPrivacyEntity(room.db, id);
  }
  refreshPolicy(deps);
}

/**
 * Trim the topic list, drop the blank lines, and REFUSE one over the cap.
 * Pure — unit-tested. Ported from `clean_concepts`.
 *
 * It used to `take(20)`: the extra topics were dropped, the panel's reload
 * rewrote the box from the twenty that were stored, and the rest of what the
 * user had typed vanished with nothing said — while they had every reason to
 * believe those topics were protected.
 */
export function cleanConcepts(concepts: readonly string[]): string[] {
  const cleaned = concepts.map((c) => c.trim()).filter((c) => c !== "");
  if (cleaned.length > MAX_PRIVACY_CONCEPTS) {
    throw new Error(
      `That is ${cleaned.length} private topics — this room holds at most ${MAX_PRIVACY_CONCEPTS}. ` +
        "Nothing was saved: shorten the list and save again, or add the rest as protected items below."
    );
  }
  return cleaned;
}

/** Replace the concept list ("my health", "my kids"). Changes the scan rules,
 * so stale files re-scan in the background. Ported from
 * `set_privacy_concepts`. */
export function setPrivacyConcepts(
  deps: PolicyDeps,
  concepts: readonly string[],
  scan?: PrivacyScanDeps
): void {
  const cleaned = cleanConcepts(concepts);
  const room = requireRoom(deps);
  setSetting(room.db, KEY_CONCEPTS, JSON.stringify(cleaned));
  bumpScanGeneration();
  refreshPolicy(deps);
  if (scan !== undefined) {
    schedulePrivacyScan(scan);
  }
}

/** The reader's "cloud view": this file's extracted text through the door.
 * Uses the room's rules REGARDLESS of the switch — the preview answers "what
 * WOULD the cloud see", which is exactly what the user is checking. Ported
 * from `privacy_preview`. */
export function privacyPreview(deps: { room: RoomSource }, fileId: string): PrivacyPreview {
  const room = requireRoom(deps);
  // Trash: the same rule as every other by-id content read — a deleted file is
  // not previewable, or a stale id in an open blackout view would keep
  // rendering its text.
  const text =
    queryOne(
      room.db,
      "SELECT extracted_text FROM files WHERE id = ? AND trashed_at IS NULL",
      [fileId],
      (r) => r[0] as string | null
    ) ?? "";
  const entities = listPrivacyEntities(room.db);
  const live = entities.filter((e) => e.source !== "dismissed");
  const redactor = new Redactor(live.map((e) => [e.realText, e.placeholder] as const));
  const report = emptyPrivacyReport();
  const redacted = redactor.redact(text, report);
  const present = live.filter((e) => redacted.includes(e.placeholder)).map((e) => e.placeholder);
  return {
    text: redacted,
    entitiesHidden: report.entitiesHidden,
    replacements: report.replacements,
    present,
  };
}

/** The one sentence every refusal to scan uses. It is ONE situation — Home's
 * brief and the Settings panel both offer the button — so it must not read as
 * two different problems. Ported verbatim from `SCAN_DOOR_OFF`. */
export const SCAN_DOOR_OFF =
  "Scanning is off while this room's cloud-privacy door is off. Turn the door on and the " +
  "scan starts by itself.";

/** Is the cloud-privacy door effectively ON for the open room? Refreshes the
 * cached policy first, so the answer reflects a switch flipped a moment ago.
 * Ported from `door_is_active`. */
export function doorIsActive(deps: PolicyDeps): boolean {
  refreshPolicy(deps);
  return activePolicy() !== null;
}

/**
 * The USER pressing "Scan now". Unlike {@link schedulePrivacyScan}, which is an
 * internal trigger and is right to be silent, this one answers a person — so a
 * door-off room gets a reason instead of an `Ok(())` that starts nothing (both
 * callers showed a button that did nothing and then went quiet; Settings
 * additionally painted "Starting the scan…" that no event ever cleared).
 * Ported from `start_privacy_scan`.
 *
 * `scan` is REQUIRED here, unlike on the settings commands: this command exists
 * only to make the scanner run, so a caller with nothing wired belongs at the
 * `execTool.ts`-style NOT_IMPLEMENTED layer rather than silently accepting a
 * button press that does nothing — which is the exact failure this function was
 * written to end.
 */
export function startPrivacyScan(scan: PrivacyScanDeps): void {
  if (!doorIsActive(scan)) {
    throw new Error(SCAN_DOOR_OFF);
  }
  schedulePrivacyScan(scan);
}

// ---------------------------------------------------------------------------
// The background scanner
// ---------------------------------------------------------------------------

let scanFlag = false;
let scanGeneration = 0;
/**
 * Why the LAST scan could not finish, until something reports it.
 *
 * The terminal `privacy-scan` event is emitted once and then gone, and a scan
 * scheduled at room-open can finish before the workspace has mounted its
 * listener — so the one failure this app most owes the user an explanation for
 * could vanish with nobody told. Parked here, it is still there for the
 * mount-time {@link privacyStatus} read. Cleared when the next scan starts, so
 * it only ever describes the most recent attempt.
 */
let lastScanErrorValue: string | null = null;

/** Ported from `scan_running`. Also read by {@link policyPayload}, which
 * withholds the guard model while a scan holds the local model. */
export function scanRunning(): boolean {
  return scanFlag;
}

/** Ported from `last_scan_error`. */
export function lastScanError(): string | null {
  return lastScanErrorValue;
}

function bumpScanGeneration(): void {
  scanGeneration += 1;
}

/** Test-only: put the scanner's process-wide state back to a clean slate
 * between cases (same convention as {@link setPolicyForTests}). */
export function resetScannerStateForTests(): void {
  scanFlag = false;
  scanGeneration = 0;
  lastScanErrorValue = null;
}

/** The channel name the frontend listens on (`shared/events.ts`'s
 * `"privacy-scan"`). Exported so the window adapter that eventually implements
 * {@link ScanProgressSink} does not have to re-spell it. */
export const PRIVACY_SCAN_EVENT = "privacy-scan";

/** Where `privacy-scan` events go — Rust's `app.emit("privacy-scan", …)`. The
 * same shape `jobs.ts`'s `ProgressSink` uses for the one event IT emits: no
 * `BrowserWindow` wiring exists in this rewrite yet, so a future batch's
 * implementation is a thin `webContents.send(PRIVACY_SCAN_EVENT, payload)`
 * adapter and tests use a recording stub. */
export interface ScanProgressSink {
  emit(payload: PrivacyScanProgress): void;
}

/** Rust's `let _ = app.emit(...)`: a closed window must never fail a scan. */
function emitSafely(sink: ScanProgressSink, payload: PrivacyScanProgress): void {
  try {
    sink.emit(payload);
  } catch {
    // Swallowed deliberately — see above.
  }
}

/** What the sidecar's `/privacy_scan` answered. */
export interface SidecarPrivacyScanResult {
  entities?: Array<{ text?: string; category?: string }>;
  /** A scan that stopped short (a chunk's model call failed, or the
   * 300-finding cap cut it off) never read the tail of the document. Absent —
   * an older sidecar — is assumed complete, which is the pre-existing
   * behaviour rather than a new silence. */
  complete?: boolean;
}

function errorCode(e: unknown): string | null {
  if (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return null;
}

/**
 * Everything the background scanner needs beyond {@link PolicyDeps} — see the
 * module doc's numbered list, item 3.
 */
export interface PrivacyScanDeps extends PolicyDeps {
  /** `AppState::room_epoch()` — bumped by every room open/teardown. Together
   * with `room.current().path` this is `roomPin.ts`'s pin, which any
   * `RoomPinSource` satisfies structurally. */
  roomEpoch(): number;
  emit: ScanProgressSink;
  /**
   * `crate::sidecar::sidecar_json("/privacy_scan", &body)`. Injected rather
   * than implemented here: the sidecar's `{code, error}` envelope (which is
   * where `"OLLAMA_DOWN"`/`"MODEL_MISSING"` come from, and which the loop below
   * matches on) belongs to the sidecar transport module, and a second spelling
   * of it inside the privacy door is exactly the kind of drift this file's own
   * `privacyTextSha` comment warns about. Rejecting with an object carrying a
   * `code` selects the two stopping branches; anything else is Rust's catch-all
   * `Err(_)` transient-failure branch.
   */
  privacyScanCall: (body: Record<string, unknown>) => Promise<SidecarPrivacyScanResult>;
  /** Resolve the preferred local guard to an installed tag. This matters for
   * builds such as `qwen3.5:4b-mlx`: asking Ollama for the unsuffixed default
   * makes every file look like a transient incomplete scan. */
  resolveGuardModel?: (preferred: string) => Promise<string>;
  /** `!state.cancels.lock().unwrap().is_empty()` — is an interactive ask
   * running right now? */
  isChatBusy: () => boolean;
  /**
   * `crate::ollama::wake_daemon()`. The scanner runs on the LOCAL model, so the
   * daemon must be up — and the Rust guard also keeps the idle watcher from
   * sleeping it again mid-scan. `undefined` skips the wake-and-hold rather than
   * faking it (the daemon-lifecycle port is a documented gap in
   * `engineRouting.ts`); the cost is that an asleep daemon is then discovered
   * one round-trip later, through the same `"OLLAMA_DOWN"` branch this loop
   * needs regardless. A rejection is Rust's `Err(e)` branch, verbatim.
   */
  wakeDaemon?: () => Promise<void>;
  /** `tokio::time::sleep` — the "paused while you chat" poll interval. */
  sleepMs?: (ms: number) => Promise<void>;
}

function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How a scan run ended. Ported from `ScanEnd`. */
export interface ScanEnd {
  /** The user-facing error when the scan could not run. The caller emits
   * exactly ONE terminal event, so an error is never overwritten. */
  error: string | null;
  /** The run was ABANDONED because the room it was scanning was replaced. Not
   * an error the user should read: the room they were in is closed, and its
   * findings are simply not this room's business. */
  roomChanged: boolean;
}

function scanFinished(error: string | null): ScanEnd {
  return { error, roomChanged: false };
}

function scanAbandoned(): ScanEnd {
  return { error: null, roomChanged: true };
}

/**
 * Kick the background scanner if the door is on for this room. Idempotent: a
 * second call while one runs is a no-op (the runner re-checks for stale files
 * before exiting, so nothing is missed). Silent on purpose — this is the
 * automatic trigger (an import, a rules change) and nobody asked it a question;
 * {@link startPrivacyScan} is the one that answers. Ported from
 * `schedule_privacy_scan`.
 */
export function schedulePrivacyScan(scan: PrivacyScanDeps): void {
  // Scan only when the switch is effectively ON — scanning is the half that
  // costs compute; with the door off it can wait for the flip.
  if (!doorIsActive(scan)) {
    return;
  }
  if (scanFlag) {
    return; // already running
  }
  scanFlag = true;
  // A new attempt supersedes whatever the last one had to say.
  lastScanErrorValue = null;
  // Fire-and-forget, mirroring `tauri::async_runtime::spawn` — and a spawned
  // tokio task that fails takes nothing with it, whereas an unhandled promise
  // rejection ends the process under Node's default. `runScanAndSettle` already
  // releases the flag and reports the failure in a `finally`; this `.catch` is
  // the backstop for its own tail (the `roomChanged` restart, which re-reads a
  // room that may itself be gone), so a scheduled scan can never be the thing
  // that takes the app down.
  void runScanAndSettle(scan).catch(() => {
    // Reported already, or unreportable: either way the flag is clear.
  });
}

/**
 * A run that ended by THROWING rather than by returning a {@link ScanEnd}.
 *
 * SECOND FIX ON TOP OF THE RUST SOURCE, and the more serious of the two (see
 * {@link runPrivacyScan}'s scan-row branch for the first). Rust cannot reach
 * this state: `run_privacy_scan` reports every failure as a value, and the two
 * DB reads it makes per pass (`get_setting`, `list_privacy_entities`) swallow
 * their errors into `Option`/`unwrap_or_default`. This port's do not —
 * `db-host/util.ts` THROWS by design, and `settings.ts`'s own doc calls that
 * out as a deliberate deviation ("an unset key is an answer, an unreadable
 * `settings` table is not") — and the loop also calls three INJECTED host
 * functions (`room.current`, `roomEpoch`, `isChatBusy`) that are free to throw.
 * A room torn down mid-run, closing its `better-sqlite3` handle between two
 * awaits, is enough: `getSetting(room.db, KEY_CONCEPTS)` throws
 * "The database connection is not open".
 *
 * With `scanFlag = false` sitting after an unguarded `await`, one such throw
 * left the flag TRUE for the rest of the process, which is not a stuck spinner
 * but a silent, permanent PRIVACY DEGRADATION:
 *
 *   - {@link policyPayload} withholds `guard_model` while a scan is running, so
 *     the sidecar's live guard — the half that enforces the user's TOPIC rules
 *     — would never run again on any cloud turn, in any room, for the life of
 *     the app;
 *   - every later {@link schedulePrivacyScan} is swallowed by the idempotence
 *     check, so no newly imported document is ever scanned again;
 *   - {@link privacyStatus} reports `scanning: true` forever, and no terminal
 *     `privacy-scan` event is ever emitted, so the panel agrees with none of it;
 *   - and the rejection escapes as an unhandled promise rejection, which Node
 *     terminates the process on by default.
 *
 * So the flag is released in a `finally`, and the throw is reported the way the
 * loop's own transient-failure path reports one: nothing is claimed to be
 * protected that is not, and the next import or "Scan now" retries.
 */
function scanCrashed(e: unknown): ScanEnd {
  const msg = e instanceof Error ? e.message : String(e);
  return scanFinished(
    `The privacy scan stopped unexpectedly: ${msg}. Anything found so far is protected, the rest ` +
      "is not yet — it will be retried on the next import, or when you press Scan now."
  );
}

async function runScanAndSettle(scan: PrivacyScanDeps): Promise<void> {
  let end: ScanEnd;
  try {
    end = await runPrivacyScan(scan);
  } finally {
    // Released before anything else can fail. {@link runPrivacyScan} is total
    // (see {@link scanCrashed}), so this `finally` has no known way to fire —
    // it is here because holding this flag is worse than every failure it could
    // possibly hide, and that must not depend on a promise kept elsewhere.
    scanFlag = false;
  }
  const { error, roomChanged } = end;
  lastScanErrorValue = error;
  try {
    refreshPolicy(scan);
  } catch {
    // The room whose findings this run just filed is unreadable. Keeping the
    // policy already in the cell is the fail-closed direction `installPolicy`'s
    // own `partial` branch argues for — rules only ever hide more — and it must
    // not cost the user the terminal event below, which is the only thing that
    // clears the panel's progress bar.
  }
  emitSafely(scan.emit, { running: false, done: 0, total: 0, error });
  // The room this run belonged to was replaced. Whatever room is open now asked
  // for its own scan while this one still held the flag and was turned away by
  // the idempotence check above, so it is started here — once, and only after
  // the flag is clear. A run that ends normally never lands here, so this
  // cannot loop.
  if (roomChanged) {
    schedulePrivacyScan(scan);
  }
}

/**
 * Drive one scan run to completion (or abandonment, or a stopping error).
 * Ported from `run_privacy_scan`. Exported for direct async testing —
 * {@link schedulePrivacyScan} is fire-and-forget by design and gives a test
 * nothing to await.
 *
 * TOTAL, exactly as `run_privacy_scan` is: every way a run can end arrives as a
 * {@link ScanEnd}, never as a rejection. The wrapper is what makes that true on
 * this side of the port — see {@link scanCrashed} for the throw surface Rust
 * does not have and for what one escaping throw used to cost.
 */
export async function runPrivacyScan(scan: PrivacyScanDeps): Promise<ScanEnd> {
  try {
    return await scanPasses(scan);
  } catch (e) {
    return scanCrashed(e);
  }
}

async function scanPasses(scan: PrivacyScanDeps): Promise<ScanEnd> {
  // The room these findings belong to. Every write below re-checks it: the scan
  // is a long loop around a sidecar call, so locking this room and opening
  // another mid-chunk used to file the names, addresses and phone numbers read
  // out of THIS room's documents into the next room's `privacy_entities` table,
  // where they showed up as its protected items.
  const initial = scan.room.current();
  if (initial === null) {
    return scanFinished(null);
  }
  const roomPath = initial.path;
  const epoch = scan.roomEpoch();

  // Show life immediately — waking the daemon below can take seconds, and a
  // button that does nothing for that long reads as broken.
  emitSafely(scan.emit, { running: true, done: 0, total: 0, label: "Starting…" });

  if (scan.wakeDaemon !== undefined) {
    try {
      await scan.wakeDaemon();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return scanFinished(`The local AI engine isn't available: ${msg}`);
    }
  }

  // Files this RUN could not scan. A transient failure leaves no scan row, so
  // the file comes straight back in the next work list — and with nothing
  // remembering that it just failed, one document that always fails made this
  // outer loop spin forever: the machine stayed busy, Settings said "scanning"
  // for good, and (because `policyPayload` withholds the guard model while a
  // scan is running) the live guard stayed off for every cloud chat in the
  // meantime. Cleared whenever the rules change, since a new generation is a
  // new run.
  const failed = new Set<string>();
  let failedGeneration = scanGeneration;
  let resolvedGuardModel: string | null = null;

  for (;;) {
    const generation = scanGeneration;
    if (generation !== failedGeneration) {
      failed.clear();
      failedGeneration = generation;
    }

    // Snapshot the work list + scan config for this pass. A different room (or
    // the same path reopened) is not this run's to read or write — checked
    // before the work list as well as before the findings, so nothing from room
    // A is even looked up in room B.
    const room = scan.room.current();
    if (room === null) {
      return scanFinished(null);
    }
    if (room.path !== roomPath || scan.roomEpoch() !== epoch) {
      return scanAbandoned();
    }
    const concepts = parseConcepts(getSetting(room.db, KEY_CONCEPTS));
    const sha = rulesSha(concepts);
    let work: ReadonlyArray<readonly [string, string, string]>;
    try {
      work = filesNeedingPrivacyScan(room.db, sha);
    } catch (e) {
      return scanFinished(e instanceof Error ? e.message : String(e));
    }
    // Rust: `list_privacy_entities(...).unwrap_or_default()` — a failed read
    // costs the scanner its de-duplication hint for this pass, nothing more.
    // Dismissed reals are deliberately INCLUDED, so a re-scan cannot resurrect
    // something the user rejected.
    let known: string[];
    try {
      known = listPrivacyEntities(room.db).map((e) => e.realText);
    } catch {
      known = [];
    }
    const preferredGuardModel = policyCell?.guardModel ?? DEFAULT_MODEL;
    let guardModel: string = resolvedGuardModel ?? preferredGuardModel;
    if (resolvedGuardModel === null && scan.resolveGuardModel !== undefined) {
      try {
        guardModel = await scan.resolveGuardModel(preferredGuardModel);
      } catch {
        // Keep the preferred model. The sidecar then returns the precise
        // daemon/model error instead of turning model discovery into a false
        // claim that there is nothing left to scan.
      }
    }
    resolvedGuardModel = guardModel;

    if (work.length === 0) {
      return scanFinished(null);
    }
    // Anything that already failed this run is not retried in it.
    const runnable = work.filter(([id]) => !failed.has(id));
    if (runnable.length === 0) {
      // Everything left is something we just failed on. Say so — counts only,
      // never a file name (a name is room content) — and stop, so the next
      // import or "Scan now" is what retries.
      const n = failed.size;
      return scanFinished(
        `${n} file${n === 1 ? "" : "s"} couldn't be scanned all the way through this time — ` +
          "anything found so far is protected, the rest is not yet. They'll be retried on the " +
          "next import, or when you press Scan now."
      );
    }

    const total = runnable.length;
    for (let i = 0; i < runnable.length; i++) {
      if (scanGeneration !== generation) {
        break; // rules changed mid-run — restart with a fresh list
      }
      const [fileId, name, text] = runnable[i]!;

      // Step aside while the user is chatting: an interactive ask shares the
      // local model with the scanner, and the answer always matters more than
      // the scan.
      for (;;) {
        if (!scan.isChatBusy() || scanGeneration !== generation) {
          break;
        }
        emitSafely(scan.emit, { running: true, done: i, total, label: "Paused while you chat" });
        await (scan.sleepMs ?? defaultSleepMs)(2000);
      }

      emitSafely(scan.emit, { running: true, done: i, total, label: name });

      const body: Record<string, unknown> = {
        model: guardModel,
        base_url: resolvedBaseUrl(),
        text,
        concepts,
        // A COPY: `known` keeps growing as findings are filed, and an injected
        // call that holds its argument must not see later files' findings
        // appear in the body it was handed.
        known: known.slice(),
      };

      let result: SidecarPrivacyScanResult;
      try {
        result = await scan.privacyScanCall(body);
      } catch (e) {
        const code = errorCode(e);
        if (code === "OLLAMA_DOWN" || code === "MODEL_MISSING") {
          // No engine to scan with — stop and SAY SO (a silent stop reads as a
          // dead button). The next schedule retries.
          return scanFinished(
            code === "MODEL_MISSING"
              ? `The scan model "${guardModel}" isn't downloaded — get it in Settings → Model, then scan again.`
              : "The local AI engine isn't reachable — the scan will retry on the next import or when you press Scan now."
          );
        }
        // Transient failure on this file: leave it stale (no scan row) so a
        // LATER run retries it, but remember it so THIS run does not come
        // straight back to it forever.
        failed.add(fileId);
        continue;
      }

      const findings = Array.isArray(result.entities) ? result.entities : [];
      const roomNow = scan.room.current();
      if (roomNow === null) {
        return scanFinished(null);
      }
      // These findings came out of the PINNED room's document. If the room was
      // locked and another opened while the sidecar was working, they are
      // dropped rather than filed in whichever room happens to be open now.
      if (roomNow.path !== roomPath || scan.roomEpoch() !== epoch) {
        return scanAbandoned();
      }
      for (const f of findings) {
        if (typeof f !== "object" || f === null) {
          continue;
        }
        const real = typeof f.text === "string" ? f.text : "";
        const cat = typeof f.category === "string" ? f.category : "concept";
        // Same floor as the block list: a one-character finding would be listed
        // as protected and then ignored.
        if (!isProtectable(real)) {
          continue;
        }
        try {
          known.push(addPrivacyEntity(roomNow.db, real, cat, "scan").realText);
        } catch {
          // Rust: `if let Ok(e) = ... { known.push(...) }` — a failed insert is
          // skipped, and the finding is simply not on the list this pass.
        }
      }

      // A scan that stopped short keeps its findings — every one of them is a
      // real protection — but the scan ROW is not written, because that row is
      // the claim "this file is protected" and the unread remainder would still
      // go to a cloud model in full.
      const complete = result.complete ?? true;
      if (!complete) {
        // Not marked done, so a later run continues it; remembered here so THIS
        // run doesn't come straight back to it and spin.
        failed.add(fileId);
        continue;
      }
      try {
        // The digest goes through `privacyTextSha` because the staleness reader
        // recomputes it the same way — a second spelling here would either
        // re-scan the library forever or never re-scan an edited file again.
        setPrivacyScan(roomNow.db, fileId, privacyTextSha(text), sha);
      } catch {
        // FIX ON TOP OF THE RUST SOURCE, which writes this as
        // `let _ = db::set_privacy_scan(...)`: if the row cannot be written the
        // file stays in the work list, is not in `failed`, and the outer loop
        // comes straight back to it — the exact forever-spin (busy machine,
        // "scanning" forever in Settings, live guard withheld from every cloud
        // chat) the `failed` set was added to end, reached through the one path
        // that did not feed it. Remembering it here ends the run honestly
        // instead, with the same "retried on the next import" message, and
        // leaves the file stale so a later run does retry it.
        failed.add(fileId);
      }
    }
    // Loop: if the generation changed we rebuild the work list; if not,
    // filesNeedingPrivacyScan comes back empty and we return above.
  }
}
