/** Cohesive extraction from privacy.ts; the facade preserves its public API. */
import { queryOne, executeOne } from "./db-host/util.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import { addPrivacyEntity, deletePrivacyEntity, dismissPrivacyEntity, entitySource, filesNeedingPrivacyScan, listPrivacyEntities, type PrivacyEntity } from "./db-host/privacy.js";
import { emptyPrivacyReport, isProtectable, MIN_PROTECTED_CHARS, Redactor } from "./privacyRedact.js";
import { effectivePower, type ConnectorOverride } from "./mcpConfig.js";
import { masksOutboundArgs } from "./toolSpecs.js";
import type { ServerStatus } from "./mcpClient.js";
import type { RoomSource } from "./jobs.js";
import type { PrivacyPreview, PrivacyStatus } from "../shared/apiTypes.js";
import { activePolicy, globalDefaultOn, KEY_CONCEPTS, KEY_SWITCH, MAX_PRIVACY_CONCEPTS, parseConcepts, type PolicyDeps, refreshPolicy, remoteSeamRedactor, requireRoom, rulesSha, setGlobalDefault } from "./privacyPolicy.js";
import { bumpScanGeneration, lastScanError, type PrivacyScanDeps, scanRunning, schedulePrivacyScan } from "./privacyScanControl.js";


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
    const decoded = decodedPercentByte(bytes, i);
    if (decoded !== null) {
      out.push(decoded);
      i += 3;
      continue;
    }
    // `+` is a space in a query string, and "Ben+Reich" is the single most
    // likely spelling of a name a model puts in a search URL.
    out.push(queryByte(bytes[i]!));
    i += 1;
  }
  return Buffer.from(out).toString("utf8");
}


function decodedPercentByte(bytes: Uint8Array, index: number): number | null {
  if (!hasPercentPair(bytes, index)) {
    return null;
  }
  return decodedHexByte(bytes[index + 1]!, bytes[index + 2]!);
}


function hasPercentPair(bytes: Uint8Array, index: number): boolean {
  return bytes[index] === 0x25 /* % */ && index + 2 < bytes.length;
}


function decodedHexByte(high: number, low: number): number | null {
  const highDigit = hexDigit(high);
  if (highDigit === null) {
    return null;
  }
  const lowDigit = hexDigit(low);
  return lowDigit === null ? null : highDigit * 16 + lowDigit;
}


function queryByte(byte: number): number {
  return byte === 0x2b /* + */ ? 0x20 : byte;
}


function hexDigit(byte: number): number | null {
  return hexDigitInRange(byte, 0x30, 0x39, 0) ?? hexDigitInRange(byte, 0x41, 0x46, 10) ?? hexDigitInRange(byte, 0x61, 0x66, 10);
}


function hexDigitInRange(byte: number, first: number, last: number, offset: number): number | null {
  return byte >= first && byte <= last ? byte - first + offset : null;
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
