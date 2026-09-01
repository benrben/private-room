/**
 * Vitest port of `src-tauri/src/commands/privacy.rs`'s `#[cfg(test)] mod
 * tests` — the policy-cell/seam/command/scan-runner half (the `Redactor`
 * engine's own cases live in `privacyRedact.test.ts`, the entity-map/scan
 * bookkeeping CRUD's in `db-host/privacy.test.ts`):
 *
 *   - remote_seam_survives_the_switch_but_active_policy_does_not
 *   - web_seam_masks_a_restored_name_before_it_reaches_a_search_engine
 *   - an_encoded_name_in_a_url_is_still_caught
 *   - connector_args_masked_reports_what_the_seam_actually_does
 *   - the_masking_note_follows_the_connectors_not_the_mac_wide_switch
 *   - topics_past_the_cap_are_refused_rather_than_dropped
 *   - an_unreadable_entity_map_never_opens_the_door
 *   - rules_sha_changes_with_concepts_only
 *   - the_payload_tells_the_sidecar_whether_the_transport_is_relayed
 *   - inject_policy_needs_nonlocal_model_and_active_policy
 *   - a_relayed_ollama_gets_the_policy_even_with_a_local_model_name
 *   - an_empty_entity_map_still_arms_the_door (minus its `image_reaches_model`
 *     assertion — the capability catalog is out of this batch's scope)
 *
 * PLUS, since this port turns the `#[tauri::command]` wrappers into ordinary
 * directly-callable functions rather than leaving them behind an IPC boundary:
 * end-to-end coverage of every command against a REAL fixture room, and the
 * scan runner's own state machine (door-off no-op, idempotence, the happy path,
 * both stopping error codes, a transient failure, room abandonment, pausing
 * while the user chats, and the scan-row write failure that used to spin).
 *
 * `policy_test_lock` (the Rust suite's guard against cargo's PARALLEL runner
 * racing on a process-global cell) has no port: vitest runs the cases in one
 * file sequentially, and `afterEach` clears both process-wide cells.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { addPrivacyEntity, listPrivacyEntities } from "./db-host/privacy.js";
import { setSetting } from "./db-host/settings.js";
import { resetBaseUrlOverrideForTests, setBaseUrlOverride } from "./engineRouting.js";
import { ollamaRunsHere } from "./capabilities.js";
import { DEFAULT_MODEL } from "./turnContext.js";
import { emptyPrivacyReport, Redactor } from "./privacyRedact.js";
import type { ConnectorOverride } from "./mcpConfig.js";
import type { ServerStatus } from "./mcpClient.js";
import type { PrivacyScanProgress } from "../shared/apiTypes.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  MAX_PRIVACY_CONCEPTS,
  NO_CONNECTORS,
  SCAN_DOOR_OFF,
  activePolicy,
  addPrivacyBlock,
  cleanConcepts,
  clearPolicy,
  computePolicy,
  connectorArgsMasked,
  doorIsActive,
  everyConnectorMasked,
  globalDefaultOn,
  globalDefaultPath,
  injectPolicy,
  installPolicy,
  lastScanError,
  maskOutboundWeb,
  outboundUnmaskFor,
  outboundUrlHides,
  percentDecode,
  policyPayload,
  privacyPreview,
  privacyStatus,
  refreshPolicy,
  remoteSeamRedactor,
  removePrivacyEntity,
  resetScannerStateForTests,
  rulesSha,
  runPrivacyScan,
  scanRunning,
  schedulePrivacyScan,
  setActivePolicyForTests,
  setGlobalDefault,
  setPolicyForTests,
  setPolicyRulesForTests,
  setPrivacyConcepts,
  setPrivacyGlobal,
  setPrivacyRoom,
  startPrivacyScan,
  webMaskNote,
  type ConnectorMaskInputs,
  type PolicyDeps,
  type PolicyState,
  type PrivacyScanDeps,
} from "./privacy.js";

// ---------------------------------------------------------------- fixtures

let tmpDir = "";

afterEach(() => {
  clearPolicy();
  resetScannerStateForTests();
  resetBaseUrlOverrideForTests();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

function freshRoomDb(): Database.Database {
  if (!tmpDir) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "privacy-"));
  }
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function userDataDir(): string {
  if (!tmpDir) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "privacy-"));
  }
  return path.join(tmpDir, "userdata");
}

/** A mutable {@link RoomSource} + room-pin double: swappable room, bumpable
 * epoch — everything the policy and the scan runner need from the not-yet
 * ported `AppState`. */
function makeRoomFixture(initial: RoomHandle | null) {
  let current = initial;
  let epoch = 1;
  return {
    room: { current: () => current } satisfies RoomSource,
    roomEpoch: () => epoch,
    swap(next: RoomHandle | null): void {
      current = next;
      epoch += 1;
    },
  };
}

function policyDeps(fixture: ReturnType<typeof makeRoomFixture>): PolicyDeps {
  return { room: fixture.room, userDataDir: userDataDir() };
}

/** A model name `capabilities.ts` declares NON-local whatever the transport
 * says — the "a cloud model is being asked" side of every seam below. */
const CLOUD_MODEL = "m:cloud";

function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

function connector(name: string, remote: boolean, status: ServerStatus["status"] = "connected"): ServerStatus {
  return { name, status, error: null, tools: [], remote };
}

function policyState(over: Partial<PolicyState> = {}): PolicyState {
  const rules = over.rules ?? [];
  return {
    active: true,
    rules,
    concepts: [],
    guardModel: DEFAULT_MODEL,
    redactor: new Redactor(rules),
    ...over,
  };
}

// ------------------------------------------------------ policy cell / seams

describe("activePolicy / remoteSeamRedactor", () => {
  it("the active-policy test fixture installs the canonical protected identity", () => {
    setActivePolicyForTests();

    const policy = activePolicy();
    const report = emptyPrivacyReport();
    expect(policy?.active).toBe(true);
    expect(policy?.redactor.redact("Ben Reich", report)).toBe("[Person A]");
    expect(report.entitiesHidden).toBe(1);
  });

  it("remote_seam_survives_the_switch_but_active_policy_does_not", () => {
    // The documented asymmetry: the model seams follow `active`, the outbound
    // connector seam does not. Aligning them silently would either weaken the
    // door or re-open the model leak.
    clearPolicy();
    expect(remoteSeamRedactor(), "no room open: nothing to mask").toBeNull();
    setPolicyForTests(false);
    expect(activePolicy(), "switch off: cloud models get the raw text the panel promises").toBeNull();
    const seam = remoteSeamRedactor();
    expect(seam, "connector seam ignores the switch").not.toBeNull();
    expect(seam!.active).toBe(false);
    const report = emptyPrivacyReport();
    const sent = seam!.redactor.redactValue({ q: "mail from Ben Reich" }, report) as { q: string };
    expect(sent.q).toBe("mail from [Person A]");
    expect(report.entitiesHidden).toBe(1);
  });

  it("an_empty_entity_map_still_arms_the_door", () => {
    // THE FRESH-ROOM HOLE: the door used to need at least one known entity
    // before it engaged at all, so in a new room the panel said "on" while the
    // user's topic rules were never sent and photographs went out in full.
    clearPolicy();
    setPolicyRulesForTests(true, []);
    const policy = activePolicy();
    expect(policy, "switch on: the door is armed with no entities").not.toBeNull();
    expect(policy!.redactor.isEmpty()).toBe(true);

    const injected = injectPolicy({ model: CLOUD_MODEL, text: "x" });
    expect(injected, "a cloud call carries the policy").not.toBeNull();
    const wire = injected!["privacy"] as Record<string, unknown>;
    expect(wire["active"]).toBe(true);
    expect(typeof wire["guard_model"]).toBe("string");

    // The connector seam is the documented exception: with no entity map there
    // is genuinely nothing to mask.
    expect(remoteSeamRedactor()).toBeNull();
  });
});

describe("PRIV-4 — the web seam", () => {
  it("web_seam_masks_a_restored_name_before_it_reaches_a_search_engine", () => {
    clearPolicy();
    expect(maskOutboundWeb("Ben Reich CV"), "no room open: nothing to mask, no note to invent").toBeNull();
    setPolicyForTests(true);
    const hit = maskOutboundWeb("Ben Reich CV");
    expect(hit, "a protected name must not leave").not.toBeNull();
    expect(hit!.masked).toBe("[Person A] CV");
    expect(hit!.hidden).toBe(1);
    // Silence is only allowed when nothing changed.
    expect(maskOutboundWeb("weather in Haifa")).toBeNull();
    expect(webMaskNote(hit!.hidden)).toContain("1");
    // Switch OFF: real names already go to cloud models, so masking here would
    // break lookups while protecting nothing the user has not accepted.
    setPolicyForTests(false);
    expect(maskOutboundWeb("Ben Reich CV")).toBeNull();
  });

  it("an_encoded_name_in_a_url_is_still_caught", () => {
    clearPolicy();
    expect(outboundUrlHides("https://x.test/?q=Ben%20Reich")).toBeNull();

    setPolicyForTests(true);
    for (const url of [
      "https://x.test/?q=Ben Reich",
      "https://x.test/?q=Ben%20Reich",
      "https://x.test/?q=Ben+Reich",
      "https://x.test/?q=ben%20reich",
      "https://x.test/Ben%20Reich/cv",
    ]) {
      expect(outboundUrlHides(url), `leaked: ${url}`).not.toBeNull();
    }
    // A URL with nothing protected in it is not refused — the door must not
    // break ordinary browsing.
    expect(outboundUrlHides("https://x.test/weather?q=Haifa")).toBeNull();
    // A malformed escape is left alone rather than mangled into a match.
    expect(outboundUrlHides("https://x.test/?q=100%ZZ")).toBeNull();

    setPolicyForTests(false);
    expect(outboundUrlHides("https://x.test/?q=Ben%20Reich")).toBeNull();
  });

  it("percentDecode works on UTF-8 bytes, so a multi-byte escape rebuilds one character", () => {
    expect(percentDecode("caf%C3%A9")).toBe("café");
    expect(percentDecode("Ben+Reich")).toBe("Ben Reich");
    expect(percentDecode("100%ZZ")).toBe("100%ZZ");
    expect(percentDecode("trailing%4")).toBe("trailing%4");
  });
});

// -------------------------------------------------------- connector seam

describe("connectorArgsMasked / everyConnectorMasked / outboundUnmaskFor", () => {
  it("connector_args_masked_reports_what_the_seam_actually_does", () => {
    // The user-visible signal must equal the behaviour in every state,
    // INCLUDING switch-off — the combination the panel used to describe as
    // "real names and details".
    clearPolicy();
    expect(connectorArgsMasked(false)).toBe(false); // no entity map: nothing masked
    for (const active of [true, false]) {
      setPolicyForTests(active);
      expect(connectorArgsMasked(false), `door ${active}: args are masked`).toBe(true);
      expect(connectorArgsMasked(true), `door ${active}: unmasked connector sends real values`).toBe(false);
    }
  });

  it("the_masking_note_follows_the_connectors_not_the_mac_wide_switch", () => {
    clearPolicy();
    setPolicyForTests(false); // the seam is switch-blind; the entity map is what counts
    const statuses = [connector("fetch", true), connector("files", false)];

    expect(
      everyConnectorMasked({ statuses, outboundUnmaskGlobal: false, connectorPowers: {} }),
      "both follow the Mac-wide switch, which is off: everything is masked"
    ).toBe(true);

    expect(
      everyConnectorMasked({
        statuses,
        outboundUnmaskGlobal: false,
        connectorPowers: { fetch: { outboundUnmask: true } },
      }),
      "one remote connector is sent real values — the note may not claim otherwise"
    ).toBe(false);

    // The mirror case: the switch says real values, one connector says no.
    expect(everyConnectorMasked({ statuses, outboundUnmaskGlobal: true, connectorPowers: {} })).toBe(false);
    expect(
      everyConnectorMasked({
        statuses,
        outboundUnmaskGlobal: true,
        connectorPowers: { fetch: { outboundUnmask: false } },
      }),
      "the only remote connector is masked, so the leak warning would be wrong"
    ).toBe(true);

    // A LOCAL connector's override is about a seam that does not leave the Mac,
    // so it may not decide this note either way.
    expect(
      everyConnectorMasked({
        statuses,
        outboundUnmaskGlobal: false,
        connectorPowers: { files: { outboundUnmask: true } },
      })
    ).toBe(true);

    // Nor may a connector that is switched off: nothing can be sent to it.
    expect(
      everyConnectorMasked({
        statuses: [connector("fetch", true, "disabled"), connector("files", false)],
        outboundUnmaskGlobal: false,
        connectorPowers: { fetch: { outboundUnmask: true } },
      }),
      "a disabled connector receives nothing, so it cannot be the exception"
    ).toBe(true);
  });

  /**
   * The prototype-pollution class the MCP marketplace batch just fixed next
   * door, at this seam: a connector NAME travels inside the `.roomai`, and
   * `powers[name]` for a connector called `constructor`/`toString`/`valueOf`
   * answers with something off `Object.prototype` rather than with this room's
   * setting — so the user's explicit "mask this one" is silently dropped and
   * the Mac-wide switch (here: send REAL values) decides instead.
   */
  it("a connector named after an Object.prototype member still gets ITS OWN override", () => {
    clearPolicy();
    setPolicyForTests(true);
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const powers: Record<string, ConnectorOverride> = { [name]: { outboundUnmask: false } };
      expect(outboundUnmaskFor(true, powers, name), `${name}: its own override must win`).toBe(false);
      expect(
        everyConnectorMasked({
          statuses: [connector(name, true)],
          outboundUnmaskGlobal: true,
          connectorPowers: powers,
        }),
        `${name}: the panel must report the masking that is actually happening`
      ).toBe(true);
    }
  });

  it("an INHERITED member is never read as an override", () => {
    clearPolicy();
    setPolicyForTests(true);
    const powers = Object.create({ fetch: { outboundUnmask: true } }) as Record<string, ConnectorOverride>;
    expect(outboundUnmaskFor(false, powers, "fetch"), "not this room's setting").toBe(false);
    expect(outboundUnmaskFor(false, {}, "fetch")).toBe(false);
    expect(outboundUnmaskFor(true, {}, "fetch")).toBe(true);
  });

  /**
   * The composed version of the same class, and the reason the guard is worth
   * its two lines: a prototype-pollution bug ANYWHERE in this process (the one
   * `privacyRedact.ts`'s JSON walk just closed was in the very next room) would
   * otherwise reach in here and turn masking off for a connector this room
   * never gave an override to — silently, and for every room afterwards.
   */
  it("a polluted Object.prototype cannot switch masking off for a connector", () => {
    clearPolicy();
    setPolicyForTests(true);
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "fetch", {
      value: { outboundUnmask: true },
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      expect(outboundUnmaskFor(false, {}, "fetch"), "this room said nothing about fetch").toBe(false);
      expect(
        everyConnectorMasked({
          statuses: [connector("fetch", true)],
          outboundUnmaskGlobal: false,
          connectorPowers: {},
        })
      ).toBe(true);
    } finally {
      delete proto["fetch"];
    }
  });

  it("with no remote connector at all, the Mac-wide switch is the room-wide answer", () => {
    clearPolicy();
    setPolicyForTests(true);
    expect(everyConnectorMasked(NO_CONNECTORS)).toBe(true);
    expect(everyConnectorMasked({ ...NO_CONNECTORS, outboundUnmaskGlobal: true })).toBe(false);
    expect(
      everyConnectorMasked({
        statuses: [connector("files", false)],
        outboundUnmaskGlobal: true,
        connectorPowers: {},
      }),
      "a local connector is not a remote seam"
    ).toBe(false);
  });
});

// ---------------------------------------------------------- inject_policy

describe("injectPolicy", () => {
  it("inject_policy_needs_nonlocal_model_and_active_policy", () => {
    clearPolicy();
    resetBaseUrlOverrideForTests();
    const body = { model: CLOUD_MODEL, text: "x" };
    expect(injectPolicy(body)).toBeNull(); // no policy cached

    setPolicyForTests(true);
    const injected = injectPolicy(body);
    expect(injected).not.toBeNull();
    const wire = injected!["privacy"] as { active: boolean; rules: Array<{ real: string }> };
    expect(wire.active).toBe(true);
    expect(wire.rules[0]?.real).toBe("Ben Reich");
    expect(injected!["text"], "the rest of the body rides through untouched").toBe("x");

    expect(injectPolicy({ model: DEFAULT_MODEL }), "on this Mac: no door needed").toBeNull();
    expect(injectPolicy({ base_url: "http://127.0.0.1:11434" }), "no model named").toBeNull();
  });

  it("catches Ollama's <size>-cloud spelling, which an exact :cloud test misses", () => {
    // The record `capabilities.ts` keeps is what answers this, and it is the
    // reason `runsOnThisMac` replaced the pair of name tests: `gpt-oss:120b-cloud`
    // used to reach the sidecar with NO policy attached at all.
    clearPolicy();
    resetBaseUrlOverrideForTests();
    setPolicyForTests(true);
    expect(injectPolicy({ model: "gpt-oss:120b-cloud", text: "x" })).not.toBeNull();
  });

  it("does not overwrite a decision the caller already made", () => {
    clearPolicy();
    setPolicyForTests(true);
    expect(injectPolicy({ model: CLOUD_MODEL, privacy: null })).toBeNull();
    // …but `privacy: undefined` is NOT a decision: JSON.stringify drops the
    // key, so the sidecar would see no policy at all. The door engages.
    expect(injectPolicy({ model: CLOUD_MODEL, privacy: undefined })).not.toBeNull();
  });

  /**
   * The prototype-pollution class this batch's siblings each guard their own
   * half of (`mcpConfig.ts`'s `ownMap`, `privacyRedact.ts`'s `setOwn`,
   * `outboundUnmaskFor`'s own case below), at THE valve: `body["privacy"]` is a
   * lookup up the prototype chain, so an inherited `privacy` member reads as
   * "the caller already decided" and the whole request goes to a cloud model
   * with NO policy attached — no redaction, no topic rules, no image stripping.
   * `serde_json::Map::get`, which this line ports, has no chain to walk.
   */
  it("an INHERITED privacy/model member cannot switch the door off", () => {
    clearPolicy();
    resetBaseUrlOverrideForTests();
    setPolicyForTests(true);
    const proto = Object.prototype as unknown as Record<string, unknown>;
    const poison = (key: string, value: unknown): void => {
      Object.defineProperty(proto, key, { value, configurable: true, enumerable: false, writable: true });
    };
    poison("privacy", { active: false });
    poison("model", DEFAULT_MODEL);
    try {
      expect(
        injectPolicy({ model: CLOUD_MODEL, text: "x" }),
        "this body decided nothing about privacy — the door engages"
      ).not.toBeNull();
      expect(
        injectPolicy({ text: "x" }),
        "and a body naming no model is still not a request this door can read"
      ).toBeNull();
    } finally {
      delete proto["privacy"];
      delete proto["model"];
    }
  });

  it("a_relayed_ollama_gets_the_policy_even_with_a_local_model_name", () => {
    // THE CLOSET HOLE: the door asked the model NAME whether content was
    // leaving. Point the room at another computer's Ollama (`set_ollama_url`)
    // and the same `qwen3.5:4b` still read as local, so NO policy rode along —
    // real names, whole documents and transcripts went to that box in the clear
    // while the trust chip said "Local only".
    clearPolicy();
    resetBaseUrlOverrideForTests();
    setPolicyForTests(true);
    const body = { model: DEFAULT_MODEL, text: "x" };
    expect(injectPolicy(body), "on this Mac: no door needed").toBeNull();

    setBaseUrlOverride("http://192.168.1.20:11434");
    const injected = injectPolicy(body);
    expect(injected, "a relayed request must carry the rules").not.toBeNull();
    const wire = injected!["privacy"] as { rules: Array<{ real: string }> };
    expect(wire.rules[0]?.real).toBe("Ben Reich");
  });

  it("the_payload_tells_the_sidecar_whether_the_transport_is_relayed", () => {
    resetBaseUrlOverrideForTests();
    expect(policyPayload(policyState())["relayed"]).toBe(false);
    setBaseUrlOverride("http://192.168.1.20:11434");
    expect(policyPayload(policyState())["relayed"]).toBe(true);
    expect(policyPayload(policyState())["relayed"]).toBe(!ollamaRunsHere());
  });

  it("withholds the guard model only while a scan is running", () => {
    resetScannerStateForTests();
    expect(policyPayload(policyState({ guardModel: "qwen3.5:4b" }))["guard_model"]).toBe("qwen3.5:4b");
  });
});

// ---------------------------------------------------------------- rulesSha

describe("rulesSha", () => {
  it("rules_sha_changes_with_concepts_only", () => {
    const a = rulesSha(["my health"]);
    const b = rulesSha(["my health", "my kids"]);
    const c = rulesSha(["my kids", "my health"]);
    expect(a).not.toBe(b);
    expect(b).toBe(c); // order-independent
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a separator keeps two different lists from hashing alike", () => {
    expect(rulesSha(["ab", "c"])).not.toBe(rulesSha(["a", "bc"]));
  });

  it("sorts by UTF-8 bytes, the way the Rust build that wrote these rows does", () => {
    // `Array.prototype.sort` compares UTF-16 code units, where an astral
    // character (a surrogate pair) sorts BEFORE U+E000..U+FFFF; in UTF-8 its
    // 4-byte sequence sorts after. The digest is persisted in
    // `privacy_scans.rules_sha256`, so a disagreement re-scans a whole library.
    const astral = "🎯 targets";
    const bmp = " private";
    const jsOrder = [astral, bmp].sort();
    const utf8Order = [astral, bmp].sort((x, y) =>
      Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"))
    );
    expect(jsOrder, "the two orders really do disagree for this pair").not.toEqual(utf8Order);
    // Whichever order the caller hands them in, the digest is the same one.
    expect(rulesSha([astral, bmp])).toBe(rulesSha([bmp, astral]));
  });
});

// -------------------------------------------------- computePolicy / install

describe("installPolicy / computePolicy", () => {
  it("an_unreadable_entity_map_never_opens_the_door", () => {
    // The reported failure: `list_privacy_entities` returning Err made
    // `compute_policy` answer None, which CLEARED the cell — and a cleared cell
    // is every seam open at once (no policy on the request, no image stripping,
    // no outbound masking, no scan) while Settings kept saying "On".
    clearPolicy();
    const partial = (): PolicyState => policyState({ concepts: ["my health"] });
    installPolicy({ kind: "partial", policy: partial() });
    const policy = activePolicy();
    expect(policy, "a read failure must not disarm the door").not.toBeNull();
    expect(policy!.concepts).toEqual(["my health"]);

    // With rules already in force, they stay in force — they are the only copy
    // of the entity map this Mac has until a read succeeds.
    installPolicy({ kind: "policy", policy: policyState({ rules: [["Ben Reich", "[Person A]"]] }) });
    installPolicy({ kind: "partial", policy: partial() });
    const kept = activePolicy();
    expect(kept, "still armed").not.toBeNull();
    expect(kept!.rules.length, "the known entities must survive a failed read").toBe(1);
    const report = emptyPrivacyReport();
    expect(kept!.redactor.redact("from Ben Reich", report)).toBe("from [Person A]");

    // A closed room is the one case that empties the cell (teardown).
    installPolicy({ kind: "noRoom" });
    expect(activePolicy()).toBeNull();
    expect(remoteSeamRedactor()).toBeNull();
  });

  it("a partial install does not mutate the recomputation it was handed", () => {
    clearPolicy();
    installPolicy({ kind: "policy", policy: policyState({ rules: [["Ben Reich", "[Person A]"]] }) });
    const fresh = policyState({ concepts: ["my health"] });
    installPolicy({ kind: "partial", policy: fresh });
    expect(fresh.rules, "the caller's object is theirs").toEqual([]);
    expect(activePolicy()!.rules.length).toBe(1);
  });

  it("a failed entity-map read (a real DB error) degrades to partial, not to nothing", () => {
    const db = freshRoomDb();
    db.exec("DROP TABLE privacy_entities");
    const fixture = makeRoomFixture({ db, path: "room-a" });
    expect(computePolicy(policyDeps(fixture)).kind).toBe("partial");
    db.close();
  });

  it("no room open means no policy — the teardown invariant", () => {
    const fixture = makeRoomFixture(null);
    setPolicyForTests(true);
    refreshPolicy(policyDeps(fixture));
    expect(activePolicy()).toBeNull();
  });

  it("the guard model is the room's own only when it runs here and is not an embedding model", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    const guardOf = (c: ReturnType<typeof computePolicy>) => (c as { policy: PolicyState }).policy.guardModel;
    resetBaseUrlOverrideForTests();

    db.prepare("INSERT INTO settings(key, value) VALUES ('model', 'nomic-embed-text')").run();
    expect(guardOf(computePolicy(deps)), "an embedding model can never be the guard").toBe(DEFAULT_MODEL);

    db.prepare("UPDATE settings SET value = 'llama4:8b' WHERE key = 'model'").run();
    expect(guardOf(computePolicy(deps)), "a local room model is the guard").toBe("llama4:8b");

    db.prepare("UPDATE settings SET value = 'gpt-oss:120b-cloud' WHERE key = 'model'").run();
    expect(
      guardOf(computePolicy(deps)),
      "a HOSTED model may never be the guard for the privacy door itself"
    ).toBe(DEFAULT_MODEL);

    // …and neither may a local-NAMED model aimed at another computer.
    db.prepare("UPDATE settings SET value = 'llama4:8b' WHERE key = 'model'").run();
    setBaseUrlOverride("http://192.168.1.20:11434");
    expect(guardOf(computePolicy(deps)), "the Closet is not this Mac").toBe(DEFAULT_MODEL);
    db.close();
  });

  it("dismissed entities are not rules", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    const e = addPrivacyEntity(db, "Dana Levi", "person", "scan");
    refreshPolicy(deps);
    expect(activePolicy()!.rules.some(([real]) => real === "Dana Levi")).toBe(true);
    removePrivacyEntity(deps, e.id); // a scan row is tombstoned, not deleted
    expect(activePolicy()!.rules.some(([real]) => real === "Dana Levi")).toBe(false);
    db.close();
  });
});

// ------------------------------------------------------- the global default

describe("the global default file", () => {
  it("defaults to ON when absent, and reads back what was written", () => {
    const dir = userDataDir();
    expect(globalDefaultOn(dir), "absent file = ON: privacy is the default").toBe(true);
    setGlobalDefault(dir, false);
    expect(globalDefaultOn(dir)).toBe(false);
    setGlobalDefault(dir, true);
    expect(globalDefaultOn(dir)).toBe(true);
  });

  it("an INHERITED defaultOn is not this Mac's answer — a file that says nothing means ON", () => {
    const dir = userDataDir();
    mkdirSync(dir, { recursive: true });
    // A `{}` on disk is "not set", and the app-wide default for "not set" is
    // ON. Read through the prototype chain it would be whatever some other
    // bug in this process left on `Object.prototype` — which at this seam
    // turns cloud privacy OFF for every room that never set its own switch.
    writeFileSync(globalDefaultPath(dir), "{}");
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "defaultOn", {
      value: false,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      expect(globalDefaultOn(dir)).toBe(true);
    } finally {
      delete proto["defaultOn"];
    }
    // …and a `__proto__` key in the file is data, never the object's prototype.
    writeFileSync(globalDefaultPath(dir), '{"__proto__":{"defaultOn":false}}');
    expect(globalDefaultOn(dir)).toBe(true);
  });

  it("fails closed on malformed global and room concept JSON", () => {
    const dir = userDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(globalDefaultPath(dir), "not-json");
    expect(globalDefaultOn(dir)).toBe(true);

    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setSetting(db, "cloud_privacy_concepts", "not-json");
    expect(computePolicy(policyDeps(fixture))).toMatchObject({
      kind: "policy",
      policy: { concepts: [] },
    });
    setSetting(db, "cloud_privacy_concepts", '{"topic":"not-an-array"}');
    expect(computePolicy(policyDeps(fixture))).toMatchObject({
      kind: "policy",
      policy: { concepts: [] },
    });
    db.close();
  });
});

// ---------------------------------------------------------------- commands

describe("commands, against a real fixture room", () => {
  it("the room switch overrides the global default, and 'default' drops the override", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);

    let status = privacyStatus(deps);
    expect(status.roomSetting).toBeNull();
    expect(status.effectiveOn, "absent global-default file = ON").toBe(true);

    setPrivacyGlobal(deps, false);
    expect(privacyStatus(deps).effectiveOn, "no room override: follows the global").toBe(false);
    expect(doorIsActive(deps)).toBe(false);

    setPrivacyRoom(deps, "on");
    status = privacyStatus(deps);
    expect(status.roomSetting).toBe("on");
    expect(status.effectiveOn, "the room override beats the global default").toBe(true);
    expect(doorIsActive(deps)).toBe(true);

    setPrivacyRoom(deps, "default");
    expect(privacyStatus(deps).roomSetting).toBeNull();
    expect(doorIsActive(deps)).toBe(false);

    expect(() => setPrivacyRoom(deps, "sideways")).toThrow(/unknown privacy mode/);
    const noRoom = { ...deps, room: { current: () => null } };
    expect(() => setPrivacyRoom(noRoom, "on")).toThrow("No room is open.");
    expect(() => privacyStatus(noRoom)).toThrow("No room is open.");
    db.close();
  });

  it("privacyStatus reports entities, concepts, the pending count and connector masking", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addPrivacyBlock(deps, "Ben Reich", "person");
    setPrivacyConcepts(deps, ["my health"]);
    addFile(db, "a.txt", "Ben Reich's lease");

    const status = privacyStatus(deps, {
      statuses: [connector("fetch", true)],
      outboundUnmaskGlobal: false,
      connectorPowers: {},
    });
    expect(status.entities).toHaveLength(1);
    expect(status.concepts).toEqual(["my health"]);
    expect(status.pendingFiles).toBe(1);
    expect(status.scanning).toBe(false);
    expect(status.lastScanError).toBeNull();
    expect(status.connectorArgsMasked).toBe(true);
    db.close();
  });

  it("addPrivacyBlock refuses an item under the floor, folds unknown categories, and refreshes the cache", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");

    expect(() => addPrivacyBlock(deps, "B", "person")).toThrow(/at least 2 characters/);
    expect(() => addPrivacyBlock(deps, " a ", "person")).toThrow();

    const entity = addPrivacyBlock(deps, "Ben Reich", "person");
    expect(entity.placeholder).toBe("[Person A]");
    expect(activePolicy()!.rules.some(([real]) => real === "Ben Reich")).toBe(true);
    expect(addPrivacyBlock(deps, "my health", "not-a-real-category").category).toBe("concept");

    expect(() => addPrivacyBlock({ ...deps, room: { current: () => null } }, "Dana Levi", "person")).toThrow(
      "No room is open."
    );
    db.close();
  });

  it("removePrivacyEntity deletes a user row outright and tombstones a scan row", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);

    const user = addPrivacyEntity(db, "Ben Reich", "person", "user");
    removePrivacyEntity(deps, user.id);
    expect(listPrivacyEntities(db)).toHaveLength(0);

    const scanned = addPrivacyEntity(db, "Dana Levi", "person", "scan");
    removePrivacyEntity(deps, scanned.id);
    const all = listPrivacyEntities(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.source).toBe("dismissed");
    db.close();
  });

  it("topics_past_the_cap_are_refused_rather_than_dropped", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `topic ${i}`);
    expect(cleanConcepts([])).toEqual([]);
    expect(cleanConcepts(lines(1))).toHaveLength(1);
    expect(cleanConcepts(lines(MAX_PRIVACY_CONCEPTS)), "the cap itself must still save").toHaveLength(
      MAX_PRIVACY_CONCEPTS
    );
    expect(() => cleanConcepts(lines(MAX_PRIVACY_CONCEPTS + 1))).toThrow(
      new RegExp(`${MAX_PRIVACY_CONCEPTS}[\\s\\S]*Nothing was saved`)
    );
    // Blank/whitespace-only lines are not topics, so a list that only exceeds
    // the cap by way of them is still saved whole.
    expect(cleanConcepts([...lines(MAX_PRIVACY_CONCEPTS), "", "   "])).toHaveLength(MAX_PRIVACY_CONCEPTS);
  });

  it("setPrivacyConcepts stores the cleaned list, and a refusal leaves the previous one in force", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    setPrivacyConcepts(deps, [" my health ", "", "my kids"]);
    expect(activePolicy()!.concepts).toEqual(["my health", "my kids"]);
    expect(privacyStatus(deps).concepts).toEqual(["my health", "my kids"]);

    const tooMany = Array.from({ length: MAX_PRIVACY_CONCEPTS + 1 }, (_, i) => `t${i}`);
    expect(() => setPrivacyConcepts(deps, tooMany)).toThrow();
    expect(activePolicy()!.concepts, "nothing was saved, so nothing was lost").toEqual([
      "my health",
      "my kids",
    ]);
    db.close();
  });

  /**
   * `privacyRedact.test.ts` pins a protected entity named after an
   * `Object.prototype` member through the ENGINE. This walks the same name
   * through everything the engine is wired into — the entity map's
   * case-insensitive dedupe and placeholder minting, the cached policy, the web
   * and URL seams, and the reader's cloud view — because those are separate
   * tables, and a name that is ordinary text to the trie is worth nothing if the
   * row that carries it, or the map that dedupes it, resolves against a
   * prototype instead.
   */
  it("an entity whose real text is an Object.prototype member name works end to end", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    const fid = addFile(db, "a.txt", "the __proto__ of constructor");

    expect(addPrivacyBlock(deps, "__proto__", "id").placeholder).toBe("[ID A]");
    expect(addPrivacyBlock(deps, "constructor", "org").placeholder).toBe("[Org A]");
    // The case-insensitive dedupe is a lookup keyed by the same text.
    expect(addPrivacyBlock(deps, "__PROTO__", "id").placeholder).toBe("[ID A]");
    expect(listPrivacyEntities(db)).toHaveLength(2);

    expect(activePolicy()!.rules.map(([real]) => real).sort()).toEqual(["__proto__", "constructor"]);
    expect(maskOutboundWeb("about __proto__")?.masked).toBe("about [ID A]");
    expect(outboundUrlHides("https://x.test/?q=__proto__")).toBe(1);
    const preview = privacyPreview(deps, fid);
    expect(preview.text).toBe("the [ID A] of [Org A]");
    expect([...preview.present].sort()).toEqual(["[ID A]", "[Org A]"]);
    db.close();
  });

  it("privacyPreview shows the file through the door regardless of the switch", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "off"); // the preview answers "what WOULD the cloud see"
    const fid = addFile(db, "lease.txt", "Ben Reich signed on 12 Herzl St.");
    addPrivacyBlock(deps, "Ben Reich", "person");
    addPrivacyBlock(deps, "12 Herzl St", "address");

    const preview = privacyPreview(deps, fid);
    expect(preview.text).toBe("[Person A] signed on [Address A].");
    expect(preview.entitiesHidden).toBe(2);
    expect(preview.replacements).toBe(2);
    expect([...preview.present].sort()).toEqual(["[Address A]", "[Person A]"]);
    expect(() => privacyPreview(deps, "no-such-file")).toThrow();
    db.close();
  });
});

// ------------------------------------------------------------- scan runner

interface Recorder extends PrivacyScanDeps {
  emitted: PrivacyScanProgress[];
}

function scanDeps(
  fixture: ReturnType<typeof makeRoomFixture>,
  overrides: Partial<PrivacyScanDeps> = {}
): Recorder {
  const emitted: PrivacyScanProgress[] = [];
  return {
    ...policyDeps(fixture),
    roomEpoch: fixture.roomEpoch,
    emit: { emit: (p) => emitted.push(p) },
    isChatBusy: () => false,
    privacyScanCall: async () => ({ entities: [], complete: true }),
    sleepMs: async () => {
      /* no real delay in tests */
    },
    emitted,
    ...overrides,
  };
}

/** Let the fire-and-forget run settle. */
async function flushScan(): Promise<void> {
  for (let i = 0; i < 50 && scanRunning(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("runPrivacyScan", () => {
  it("scans a pending file, files its findings, and marks it scanned", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich's phone is 5551234");

    const calls: Array<Record<string, unknown>> = [];
    const scan = scanDeps(fixture, {
      privacyScanCall: async (body) => {
        calls.push(body);
        return { entities: [{ text: "Ben Reich", category: "person" }], complete: true };
      },
    });
    const end = await runPrivacyScan(scan);

    expect(end).toEqual({ error: null, roomChanged: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!["text"]).toBe("Ben Reich's phone is 5551234");
    expect(calls[0]!["model"]).toBe(DEFAULT_MODEL);
    expect(listPrivacyEntities(db).some((e) => e.realText === "Ben Reich" && e.source === "scan")).toBe(true);
    expect(privacyStatus(deps).pendingFiles, "no longer pending under the same rules").toBe(0);
    expect(scan.emitted.some((e) => e.label === "Starting…")).toBe(true);
    db.close();
  });

  it("resolves an uninstalled default tag once and scans every file with the installed local build", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich");
    addFile(db, "b.txt", "Dana Levi");
    const resolved: string[] = [];
    const calledModels: string[] = [];

    const end = await runPrivacyScan(scanDeps(fixture, {
      resolveGuardModel: async (preferred) => {
        resolved.push(preferred);
        return "qwen3.5:4b-mlx";
      },
      privacyScanCall: async (body) => {
        calledModels.push(String(body.model));
        return { entities: [], complete: true };
      },
    }));

    expect(end.error).toBeNull();
    expect(resolved).toEqual([DEFAULT_MODEL]);
    expect(calledModels).toEqual(["qwen3.5:4b-mlx", "qwen3.5:4b-mlx"]);
    expect(privacyStatus(deps).pendingFiles).toBe(0);
    db.close();
  });

  it("a finding under the character floor is skipped, not filed as protected", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "B lives here");
    await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => ({
          entities: [{ text: "B", category: "person" }, { text: "  ", category: "person" }],
          complete: true,
        }),
      })
    );
    expect(listPrivacyEntities(db)).toHaveLength(0);
    db.close();
  });

  it("an INCOMPLETE scan keeps its findings but does not claim the file is protected", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich's lease");
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => ({
          entities: [{ text: "Ben Reich", category: "person" }],
          complete: false,
        }),
      })
    );
    expect(listPrivacyEntities(db).some((e) => e.realText === "Ben Reich")).toBe(true);
    expect(privacyStatus(deps).pendingFiles, "the unread tail would still go out in full").toBe(1);
    expect(end.error).toContain("1 file couldn't be scanned");
    db.close();
  });

  it("finishes quietly when there is no pending work, and when no room is open", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    expect(await runPrivacyScan(scanDeps(fixture))).toEqual({ error: null, roomChanged: false });
    expect(await runPrivacyScan(scanDeps(makeRoomFixture(null)))).toEqual({
      error: null,
      roomChanged: false,
    });
    db.close();
  });

  it("abandons the run — no user-facing error — when the room changes mid-scan", async () => {
    const db = freshRoomDb();
    const other = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");

    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          // Another room opens while this sidecar call is in flight.
          fixture.swap({ db: other, path: "room-b" });
          return { entities: [{ text: "Ben Reich", category: "person" }], complete: true };
        },
      })
    );
    expect(end).toEqual({ error: null, roomChanged: true });
    // Nothing from room A was filed into room B.
    expect(listPrivacyEntities(other)).toHaveLength(0);
    db.close();
    other.close();
  });

  it("the same path REOPENED is a different room too (the epoch half of the pin)", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          fixture.swap({ db, path: "room-a" }); // same file, new open
          return { entities: [{ text: "Ben Reich", category: "person" }], complete: true };
        },
      })
    );
    expect(end.roomChanged).toBe(true);
    expect(listPrivacyEntities(db)).toHaveLength(0);
    db.close();
  });

  it("stops the whole run with a clear message on OLLAMA_DOWN, without touching later files", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    addFile(db, "b.txt", "Dana Levi");

    let calls = 0;
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          calls += 1;
          throw Object.assign(new Error("connection refused"), { code: "OLLAMA_DOWN" });
        },
      })
    );
    expect(calls).toBe(1);
    expect(end.error).toContain("local AI engine isn't reachable");
    expect(end.roomChanged).toBe(false);
    db.close();
  });

  it("names the missing model on MODEL_MISSING", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          throw { code: "MODEL_MISSING" };
        },
      })
    );
    expect(end.error).toContain(DEFAULT_MODEL);
    expect(end.error).toContain("isn't downloaded");
    db.close();
  });

  it("wakeDaemon rejecting stops the run before any file is read", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    let calls = 0;
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        wakeDaemon: async () => {
          throw new Error("connection refused");
        },
        privacyScanCall: async () => {
          calls += 1;
          return { entities: [], complete: true };
        },
      })
    );
    expect(calls).toBe(0);
    expect(end.error).toContain("isn't available");
    db.close();
  });

  it("reports a synchronously thrown daemon wake failure as the same scan error", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        wakeDaemon: (() => {
          throw new Error("sync wake failure");
        }) as () => Promise<void>,
      })
    );
    expect(end.error).toContain("sync wake failure");
    db.close();
  });

  it("uses the preferred model when resolving it throws synchronously", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    const calledModels: string[] = [];
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        resolveGuardModel: (() => {
          throw new Error("resolver unavailable");
        }) as (preferred: string) => Promise<string>,
        privacyScanCall: async (body) => {
          calledModels.push(String(body.model));
          return { entities: [], complete: true };
        },
      })
    );
    expect(end.error).toBeNull();
    expect(calledModels).toEqual([DEFAULT_MODEL]);
    db.close();
  });

  it("finishes cleanly when the room disappears before it can build the first work list", async () => {
    const db = freshRoomDb();
    const handle = { db, path: "room-a" };
    let reads = 0;
    const source: RoomSource = {
      current: () => {
        reads += 1;
        return reads === 1 ? handle : null;
      },
    };
    const scan = scanDeps(makeRoomFixture(handle), { room: source });
    expect(await runPrivacyScan(scan)).toEqual({ error: null, roomChanged: false });
    db.close();
  });

  it("reports a work-list read failure without calling the scanner", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    db.exec("DROP TABLE privacy_scans");
    let calls = 0;
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          calls += 1;
          return { entities: [], complete: true };
        },
      })
    );
    expect(calls).toBe(0);
    expect(end.error).toContain("privacy_scans");
    db.close();
  });

  it("continues a scan without its known-entity hint when that read fails", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    db.exec("DROP TABLE privacy_entities");
    const end = await runPrivacyScan(scanDeps(fixture));
    expect(end.error).toBeNull();
    db.close();
  });

  it("rebuilds a pass after its resolver changes the scan generation", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich");
    let calls = 0;
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        resolveGuardModel: async (preferred) => {
          setPrivacyConcepts(deps, ["health"]);
          return preferred;
        },
        privacyScanCall: async () => {
          calls += 1;
          return { entities: [], complete: true };
        },
      })
    );
    expect(end.error).toBeNull();
    expect(calls).toBe(1);
    db.close();
  });

  it("skips malformed findings and carries on when saving a valid finding fails", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    db.exec(
      "CREATE TRIGGER refuse_entity BEFORE INSERT ON privacy_entities BEGIN SELECT RAISE(ABORT, 'no entity write'); END"
    );
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => ({
          entities: [null as never, { text: "Ben Reich" }],
          complete: true,
        }),
      })
    );
    expect(end.error).toBeNull();
    expect(listPrivacyEntities(db)).toHaveLength(0);
    db.close();
  });

  it("a transient per-file failure is retried LATER, not in this run, and the run reports the count", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich");
    addFile(db, "b.txt", "Dana Levi");

    let calls = 0;
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          calls += 1;
          throw new Error("some unclassified engine failure");
        },
      })
    );
    expect(calls, "each file tried once, then the run ends rather than spinning").toBe(2);
    expect(end.roomChanged).toBe(false);
    expect(end.error).toContain("2 files couldn't be scanned");
    expect(end.error).toContain("Scan now");
    // Nothing was marked scanned — a later run must retry them.
    expect(privacyStatus(deps).pendingFiles).toBe(2);
    db.close();
  });

  /**
   * The one fix on top of the Rust source. `let _ = db::set_privacy_scan(...)`
   * swallows a failed write, and a file whose scan ROW cannot be written stays
   * in the work list, is not in the `failed` set, and comes straight back on the
   * next pass — the exact forever-spin the `failed` set exists to prevent,
   * reached through the one path that never fed it.
   */
  it("a scan-row write that fails ends the run instead of spinning on that file forever", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich's lease");
    // Every WRITE of the scan row now fails while every read still works — the
    // shape of a locked/full disk, not of a broken schema.
    db.exec("CREATE TRIGGER no_scan_row BEFORE INSERT ON privacy_scans BEGIN SELECT RAISE(ABORT, 'nope'); END");

    let calls = 0;
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          calls += 1;
          if (calls > 5) {
            throw new Error("the loop is spinning");
          }
          return { entities: [{ text: "Ben Reich", category: "person" }], complete: true };
        },
      })
    );
    expect(calls, "the file is tried once, not forever").toBe(1);
    expect(end.error).toContain("1 file couldn't be scanned");
    // The findings it DID make are kept — every one of them is a real protection.
    expect(listPrivacyEntities(db).some((e) => e.realText === "Ben Reich")).toBe(true);
    db.close();
  });

  it("steps aside while the user is chatting, then resumes", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");

    let polls = 0;
    let sleeps = 0;
    const scan = scanDeps(fixture, {
      isChatBusy: () => {
        polls += 1;
        return polls <= 2; // chatting for the first two polls, then done
      },
      sleepMs: async () => {
        sleeps += 1;
      },
    });
    const end = await runPrivacyScan(scan);
    expect(end.error).toBeNull();
    expect(sleeps).toBeGreaterThanOrEqual(1);
    expect(scan.emitted.some((e) => e.label === "Paused while you chat")).toBe(true);
    db.close();
  });

  it("a room closed mid-run finishes quietly rather than reporting an error", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          fixture.swap(null);
          return { entities: [], complete: true };
        },
      })
    );
    expect(end).toEqual({ error: null, roomChanged: false });
    db.close();
  });
});

describe("schedulePrivacyScan / startPrivacyScan", () => {
  it("schedules when the global switch is turned on and tolerates a closed progress sink", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyGlobal(deps, false);
    addFile(db, "a.txt", "Ben Reich");
    let calls = 0;
    const scan = scanDeps(fixture, {
      emit: { emit: () => { throw new Error("fabricated closed window"); } },
      privacyScanCall: async () => {
        calls += 1;
        return { entities: [], complete: true };
      },
    });

    setPrivacyGlobal(deps, true, scan);
    await flushScan();
    expect(calls).toBe(1);
    expect(scanRunning()).toBe(false);
    db.close();
  });

  it("uses the default pause timer when chat work is briefly busy", async () => {
    vi.useFakeTimers();
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    let busy = true;
    const scan = scanDeps(fixture, {
      isChatBusy: () => busy,
      sleepMs: undefined,
    });
    try {
      const pending = runPrivacyScan(scan);
      await Promise.resolve();
      busy = false;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ error: null, roomChanged: false });
      expect(scan.emitted.some((event) => event.label === "Paused while you chat")).toBe(true);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("restarts once for a replacement room after the scheduled run abandons the old one", async () => {
    const first = freshRoomDb();
    const second = freshRoomDb();
    const fixture = makeRoomFixture({ db: first, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(first, "a.txt", "Ben Reich");
    let calls = 0;
    const scan = scanDeps(fixture, {
      privacyScanCall: async () => {
        calls += 1;
        setPrivacyRoom({ room: { current: () => ({ db: second, path: "room-b" }) }, userDataDir: userDataDir() }, "on");
        fixture.swap({ db: second, path: "room-b" });
        return { entities: [], complete: true };
      },
    });

    schedulePrivacyScan(scan);
    await flushScan();
    expect(calls).toBe(1);
    expect(scanRunning()).toBe(false);
    first.close();
    second.close();
  });

  it("still emits a terminal result when the completed room can no longer refresh", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");
    const scan = scanDeps(fixture, {
      privacyScanCall: async () => {
        db.close();
        return { entities: [], complete: true };
      },
    });
    schedulePrivacyScan(scan);
    await flushScan();
    expect(scan.emitted.some((event) => event.running === false)).toBe(true);
    expect(scanRunning()).toBe(false);
  });

  it("is a no-op while the door is off, and startPrivacyScan says why", () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "off");
    addFile(db, "a.txt", "Ben Reich");

    let called = false;
    const scan = scanDeps(fixture, {
      privacyScanCall: async () => {
        called = true;
        return { entities: [], complete: true };
      },
    });
    schedulePrivacyScan(scan);
    expect(scanRunning()).toBe(false);
    expect(called).toBe(false);
    expect(scan.emitted).toEqual([]);
    expect(() => startPrivacyScan(scan)).toThrow(SCAN_DOOR_OFF);
    db.close();
  });

  it("runs once, clears the flag, and emits exactly ONE terminal event", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich's lease");

    const scan = scanDeps(fixture, {
      privacyScanCall: async () => ({ entities: [{ text: "Ben Reich", category: "person" }], complete: true }),
    });
    startPrivacyScan(scan);
    expect(scanRunning()).toBe(true);
    await flushScan();

    expect(scanRunning()).toBe(false);
    expect(lastScanError()).toBeNull();
    expect(listPrivacyEntities(db).some((e) => e.realText === "Ben Reich")).toBe(true);
    const terminal = scan.emitted.filter((e) => e.running === false);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.error).toBeNull();
    db.close();
  });

  it("is idempotent while a run is already in flight", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const scan = scanDeps(fixture, {
      privacyScanCall: async () => {
        calls += 1;
        await gate;
        return { entities: [], complete: true };
      },
    });

    schedulePrivacyScan(scan);
    expect(scanRunning()).toBe(true);
    schedulePrivacyScan(scan); // swallowed by the flag
    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    await flushScan();
    expect(scanRunning()).toBe(false);
    db.close();
  });

  it("a failed run parks its reason for a window that had not mounted its listener yet", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich");

    schedulePrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          throw { code: "OLLAMA_DOWN" };
        },
      })
    );
    await flushScan();
    expect(lastScanError()).toContain("isn't reachable");
    expect(privacyStatus(deps).lastScanError, "still there for the mount-time read").toContain(
      "isn't reachable"
    );

    // A new attempt supersedes whatever the last one had to say.
    schedulePrivacyScan(scanDeps(fixture));
    await flushScan();
    expect(lastScanError()).toBeNull();
    db.close();
  });

  /**
   * The SECOND fix on top of the Rust source. Rust reports every scan failure
   * as a value and swallows its two per-pass DB reads into
   * `Option`/`unwrap_or_default`; this port's `db-host` helpers THROW by
   * design, and the loop also calls three injected host functions that may.
   * With `scanFlag = false` after an unguarded `await`, one throw pinned the
   * flag TRUE for the life of the process — which is not a stuck spinner:
   * `policyPayload` withholds the guard model while a scan is "running", so
   * the sidecar's live guard (the half that enforces the user's TOPIC rules)
   * would never run again on any cloud turn, in any room, and no later import
   * would ever be scanned either.
   */
  it("a run that THROWS releases the flag, reports why, and emits its terminal event", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    setPrivacyRoom(deps, "on");
    addFile(db, "a.txt", "Ben Reich's lease");

    const scan = scanDeps(fixture, {
      isChatBusy: () => {
        throw new Error("host state exploded");
      },
    });
    schedulePrivacyScan(scan);
    await flushScan();

    expect(scanRunning(), "holding this flag is worse than any failure it hides").toBe(false);
    expect(lastScanError()).toContain("stopped unexpectedly");
    expect(lastScanError()).toContain("Scan now");
    expect(privacyStatus(deps).scanning).toBe(false);
    const terminal = scan.emitted.filter((e) => e.running === false);
    expect(terminal, "the panel's progress bar has nothing else to clear it").toHaveLength(1);
    expect(terminal[0]?.error).toContain("stopped unexpectedly");
    // And the withheld-guard-model consequence is really gone.
    expect(policyPayload(policyState({ guardModel: "qwen3.5:4b" }))["guard_model"]).toBe("qwen3.5:4b");
    // A later scan can still run: the idempotence check no longer refuses.
    expect(() => startPrivacyScan(scanDeps(fixture))).not.toThrow();
    await flushScan();
    db.close();
  });

  it("a room whose DB is closed mid-run ends the run rather than escaping as a rejection", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    setPrivacyRoom(policyDeps(fixture), "on");
    addFile(db, "a.txt", "Ben Reich's lease");
    // Teardown closed the handle while the sidecar call was in flight — the
    // next `getSetting` throws "The database connection is not open".
    const end = await runPrivacyScan(
      scanDeps(fixture, {
        privacyScanCall: async () => {
          db.close();
          return { entities: [], complete: true };
        },
      })
    ).catch((e: unknown) => e);
    expect(end, "reported as a value, not thrown past the runner").not.toBeInstanceOf(Error);
  });

  it("settings commands only schedule when they should", async () => {
    const db = freshRoomDb();
    const fixture = makeRoomFixture({ db, path: "room-a" });
    const deps = policyDeps(fixture);
    let calls = 0;
    const scan = scanDeps(fixture, {
      privacyScanCall: async () => {
        calls += 1;
        return { entities: [], complete: true };
      },
    });
    addFile(db, "a.txt", "Ben Reich's lease");

    setPrivacyRoom(deps, "off", scan);
    await flushScan();
    expect(calls, "door off: nothing to do").toBe(0);

    setPrivacyRoom(deps, "on", scan);
    await flushScan();
    expect(calls).toBe(1);

    setPrivacyGlobal(deps, false, scan);
    await flushScan();
    expect(calls, "turning the global default OFF never schedules").toBe(1);

    // A concepts change bumps the generation, so the same file is stale again.
    setPrivacyConcepts(deps, ["my health"], scan);
    await flushScan();
    expect(calls).toBe(2);
    db.close();
  });
});
