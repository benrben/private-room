/** Cohesive extraction from privacy.ts; the facade preserves its public API. */
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
import { getSetting } from "./db-host/settings.js";
import { listPrivacyEntities, type PrivacyEntity } from "./db-host/privacy.js";
import { Redactor, type PrivacyRule } from "./privacyRedact.js";
import { ollamaRunsHere, runsOnThisMac } from "./capabilities.js";
import { modelSetting } from "./gatherContext.js";
import { DEFAULT_MODEL, isEmbeddingModel } from "./turnContext.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { scanRunning } from "./privacyScanControl.js";


/** Room settings keys. Ported verbatim from `KEY_SWITCH`/`KEY_CONCEPTS`. */
export const KEY_SWITCH = "cloud_privacy";
 // "on" | "off"; absent = global default
export const KEY_CONCEPTS = "cloud_privacy_concepts";
 // JSON array of strings

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
export function requireRoom(deps: { room: RoomSource }): RoomHandle {
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
export let policyCell: PolicyState | null = null;


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
export function parseConcepts(raw: string | null): string[] {
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


function resolvedPrivacySwitch(room: RoomHandle, userDataDir: string): boolean {
  const switchValue = getSetting(room.db, KEY_SWITCH);
  if (switchValue === "off") return false;
  if (switchValue === "on") return true;
  return globalDefaultOn(userDataDir);
}


function readPolicyEntities(room: RoomHandle): { entities: PrivacyEntity[]; readOk: boolean } {
  try {
    return { entities: listPrivacyEntities(room.db), readOk: true };
  } catch {
    return { entities: [], readOk: false };
  }
}


function privacyRules(entities: readonly PrivacyEntity[]): PrivacyRule[] {
  return entities
    .filter((entity) => entity.source !== "dismissed")
    .map((entity) => [entity.realText, entity.placeholder] as const);
}


function guardModelForRoom(room: RoomHandle): string {
  const roomModel = modelSetting(room.db) ?? "";
  if (roomModel !== "" && runsOnThisMac(roomModel) && !isEmbeddingModel(roomModel)) return roomModel;
  return DEFAULT_MODEL;
}


function computedPolicy(readOk: boolean, policy: PolicyState): Computed {
  return readOk ? { kind: "policy", policy } : { kind: "partial", policy };
}


/** Ported from `compute_policy`. */
export function computePolicy(deps: PolicyDeps): Computed {
  const room = deps.room.current();
  if (room === null) {
    return { kind: "noRoom" };
  }
  const active = resolvedPrivacySwitch(room, deps.userDataDir);
  const { entities, readOk } = readPolicyEntities(room);
  const rules = privacyRules(entities);
  const concepts = parseConcepts(getSetting(room.db, KEY_CONCEPTS));

  // The live guard + scanner need a model that runs ON THIS MAC. The room's
  // chosen model qualifies only when local; otherwise the tuned default.
  // `runsOnThisMac` — the ONE definition of "runs here" — rather than a pair
  // of name tests, which missed Ollama's `<size>-cloud` spelling and so would
  // have made a HOSTED model the guard for the privacy door itself.
  const guardModel = guardModelForRoom(room);
  const policy: PolicyState = { active, redactor: new Redactor(rules), rules, concepts, guardModel };
  return computedPolicy(readOk, policy);
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
