/**
 * Vitest port of `mcp_cmds.rs`'s `mod tests`, PLUS real integration tests
 * (against a real room DB via `db-host/open.ts`'s `createRoom`, and against
 * real per-Mac files in a temp dir) for the four `agent_*` functions this
 * batch's `exec_tool` wiring depends on — `mcp_cmds.rs` itself has no unit
 * tests for those four (its own `#[cfg(test)]` module tests only their
 * sub-pieces: `restore_redacted_args`, `reject_surviving_placeholders`,
 * `same_destination`, …, all ported below), so the integration coverage here is
 * this port's own addition rather than a mirror of an existing fixture.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { loadTokens, saveTokens, type TokenSet } from "./mcpOauth.js";
import { masksOutboundArgs } from "./toolSpecs.js";
import {
  addMcpApproval,
  agentDeleteMcp,
  agentListMcps,
  agentMcpName,
  agentMcpRoot,
  agentReadMcp,
  agentSaveMcp,
  AGENT_SECRET_KEYS,
  applyMcpConfig,
  destructiveRequest,
  DELETE_DECLINED,
  effectivePower,
  forgetConnectorGrants,
  getMcpConfig,
  isCredentialFlag,
  looksLikeSecret,
  MCP_ARG_PREVIEW_MAX,
  MCP_CONFIG_KEY,
  mcpFingerprint,
  mcpGate,
  mergeBearer,
  parseConnectorFlag,
  parseConnectorPower,
  parseConnectorPowers,
  parseToolPrefs,
  previewArgs,
  readMcpApprovals,
  readMcpFlag,
  redactAgentMcpConfig,
  redactCliArgs,
  rejectSurvivingPlaceholders,
  removeAgentMcpSecrets,
  removeServerFromConfig,
  renderCommandLine,
  requireReadableConfig,
  resignedServers,
  restoreRedactedArgs,
  sameDestination,
  setConnectorPower,
  setServerDisabled,
  setToolPref,
  skipsConsentCard,
  stripBearer,
  unreadableConfigMessage,
  UNREADABLE_CONFIG_ROW,
  writeMcpFlag,
} from "./mcpConfig.js";

const asObject = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

// -------------------------------------------------- agent-initiated deletion

it("a_deletion_card_is_never_mistaken_for_a_tool_call_card", () => {
  // Audit #505: the frontend renders the tool-call card ("Allow a connected
  // tool to run?", "Always allow this connector") for anything without
  // `confirm` — the wrong question here, and one that would offer standing
  // consent to destruction.
  const v = destructiveRequest("id-1", "connector", "github", "Its sign-in goes too.");
  expect(v["confirm"]).toBe("Its sign-in goes too.");
  expect(v["tool"]).toBe("connector");
  expect(v["server"]).toBe("github");
  expect(v["id"]).toBe("id-1");
  // No arguments to preview: nothing is being SENT anywhere.
  expect(v["args"]).toBe("");
});

it("a_declined_deletion_says_nothing_was_changed", () => {
  expect(DELETE_DECLINED).toContain("Not deleted");
  expect(DELETE_DECLINED).toContain("Nothing was changed");
});

// --------------------------------------------------------- connector powers

it("both_connector_powers_are_off_until_the_user_turns_them_on", () => {
  expect(parseConnectorFlag(null)).toBe(false);
  expect(parseConnectorFlag("")).toBe(false);
  expect(parseConnectorFlag("garbage")).toBe(false);
  expect(parseConnectorFlag("false")).toBe(false);
  // Only the user's own explicit choice turns one on, whitespace and all.
  expect(parseConnectorFlag("true")).toBe(true);
  expect(parseConnectorFlag(" true\n")).toBe(true);
});

it("one_connector_can_reach_all_four_combinations", () => {
  // The per-connector layer only earns its keep if every combination is
  // reachable for a single connector, so this walks the truth table with the
  // two GLOBAL switches held OFF and only the connector's own answers moving.
  let raw = "{}";
  const seen = new Set<string>();
  for (const auto of [false, true]) {
    for (const unmask of [false, true]) {
      raw = setConnectorPower(raw, "linear", "autoApprove", auto);
      raw = setConnectorPower(raw, "linear", "outboundUnmask", unmask);
      const over = parseConnectorPowers(raw)["linear"]!;
      const skips = skipsConsentCard(effectivePower(false, over.autoApprove), false);
      const masks = masksOutboundArgs(true, effectivePower(false, over.outboundUnmask));
      expect(skips).toBe(auto);
      expect(masks).toBe(!unmask);
      seen.add(`${skips}-${masks}`);
    }
  }
  expect(seen.size).toBe(4);
});

it("two_connectors_do_not_affect_each_other", () => {
  // Trusting the connector that runs on this Mac must say nothing about the one
  // that reaches the internet.
  let raw = setConnectorPower("{}", "filesystem", "autoApprove", true);
  raw = setConnectorPower(raw, "linear", "outboundUnmask", true);
  const map = parseConnectorPowers(raw);
  expect(map["filesystem"]!.autoApprove).toBe(true);
  expect(map["filesystem"]!.outboundUnmask).toBeUndefined();
  expect(map["linear"]!.outboundUnmask).toBe(true);
  expect(map["linear"]!.autoApprove).toBeUndefined();
  expect(skipsConsentCard(effectivePower(false, map["filesystem"]!.autoApprove), false)).toBe(true);
  expect(skipsConsentCard(effectivePower(false, map["linear"]!.autoApprove), false)).toBe(false);
  expect(masksOutboundArgs(true, effectivePower(false, map["linear"]!.outboundUnmask))).toBe(false);
  expect(masksOutboundArgs(true, effectivePower(false, map["filesystem"]!.outboundUnmask))).toBe(true);

  // Clearing one connector's answer leaves the other's alone, and leaves no
  // residue behind that a later read could mistake for a choice.
  const map2 = parseConnectorPowers(setConnectorPower(raw, "filesystem", "autoApprove", null));
  expect(map2["filesystem"]).toBeUndefined();
  expect(map2["linear"]!.outboundUnmask).toBe(true);
});

it("the_upgrade_from_the_global_switches_grants_nothing_new", () => {
  // An install arriving from the global-only pair has no overrides file, so
  // every connector inherits the value that install already had. What must NOT
  // happen is the reverse — a global ON written out as per-connector grants, or
  // a global OFF read as a grant anywhere.
  expect(Object.keys(parseConnectorPowers("{}")).length).toBe(0);
  expect(Object.keys(parseConnectorPowers("garbage")).length).toBe(0);
  for (const global of [false, true]) {
    expect(effectivePower(global, undefined)).toBe(global);
  }
  expect(skipsConsentCard(effectivePower(false, undefined), false)).toBe(false);
  expect(masksOutboundArgs(true, effectivePower(false, undefined))).toBe(true);
  // An explicit per-connector NO outranks a global YES, so the stricter answer
  // is always reachable.
  expect(effectivePower(true, false)).toBe(false);
  expect(effectivePower(false, true)).toBe(true);
  // Only the two known powers can be written; a typo is an error the UI can
  // show, never a silent write into the other power.
  expect(parseConnectorPower("auto_approve")).toBe("autoApprove");
  expect(parseConnectorPower("outbound_unmask")).toBe("outboundUnmask");
  expect(() => parseConnectorPower("autoApprove")).toThrow();
});

it("a_connectors_powers_survive_a_restart_without_leaking_into_each_other", () => {
  let raw = setConnectorPower("{}", "filesystem", "autoApprove", true);
  raw = setConnectorPower(raw, "linear", "outboundUnmask", false);
  // "Follow the switch" must round-trip as an ABSENT key rather than a false,
  // because a false would pin a connector to today's global forever.
  expect(raw).not.toContain('"outbound_unmask":null');
  expect(raw).not.toContain('"auto_approve":null');
  const reloaded = parseConnectorPowers(raw);
  expect(reloaded["filesystem"]!.autoApprove).toBe(true);
  expect(reloaded["filesystem"]!.outboundUnmask).toBeUndefined();
  expect(reloaded["linear"]!.outboundUnmask).toBe(false);
  expect(reloaded["linear"]!.autoApprove).toBeUndefined();
  // An entry that names an unknown power is ignored, not fatal, and never turns
  // into an answer.
  const odd = parseConnectorPowers(`{"linear":{"auto_approve":true,"bogus":1}}`);
  expect(odd["linear"]!.autoApprove).toBe(true);
  expect(odd["linear"]!.outboundUnmask).toBeUndefined();
});

it("the_two_connector_powers_are_independent", () => {
  // The 2026-08-03 split, as a truth table over the REAL deciders for a REMOTE
  // connector. All four combinations must be distinct — before the split only
  // the two diagonal rows existed, because one flag drove both columns.
  const table: Array<[boolean, boolean, boolean, boolean]> = [
    [false, false, false, true],
    [true, false, true, true],
    [false, true, false, false],
    [true, true, true, false],
  ];
  for (const [auto, unmask, skips, masks] of table) {
    expect(skipsConsentCard(auto, false)).toBe(skips);
    expect(masksOutboundArgs(true, unmask)).toBe(masks);
  }
  const outcomes = new Set(
    table.map(([auto, unmask]) => `${skipsConsentCard(auto, false)}-${masksOutboundArgs(true, unmask)}`)
  );
  expect(outcomes.size).toBe(4);
  // A local connector never leaves this Mac, so unmasking is moot there while
  // auto-approve still decides whether the user is asked.
  expect(masksOutboundArgs(false, false)).toBe(false);
  expect(masksOutboundArgs(false, true)).toBe(false);
  // "Always allow this connector" for the session is still its own path into
  // skipping the card, and still has nothing to do with unmasking.
  expect(skipsConsentCard(false, true)).toBe(true);
});

// -------------------------------------------------------- per-Mac consent files

describe("per-Mac consent files (real disk I/O)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
  const freshDir = (): string => {
    dir = mkdtempSync(path.join(os.tmpdir(), "arcelle-connflags-"));
    return dir;
  };

  it("each power persists to its own file, and an absent file reads OFF", () => {
    // The only thing standing between "two switches" and "one switch with two
    // labels" is that the two callers pass different paths.
    const d = freshDir();
    const auto = path.join(d, "mcp_auto_approve.json");
    const unmask = path.join(d, "mcp_outbound_unmask.json");
    expect(readMcpFlag(auto)).toBe(false);
    expect(readMcpFlag(unmask)).toBe(false);

    writeMcpFlag(auto, true);
    expect(readMcpFlag(auto)).toBe(true);
    expect(readMcpFlag(unmask)).toBe(false); // granting consent must not unmask

    writeMcpFlag(unmask, true);
    writeMcpFlag(auto, false);
    // Withdrawing consent must not silently re-mask behind the user's back.
    expect(readMcpFlag(unmask)).toBe(true);
    expect(readMcpFlag(auto)).toBe(false);

    // A power that could not be written is REPORTED: the page's switch is
    // optimistic and re-reads on failure, so a swallowed error left it showing
    // a consent decision the next launch would not have.
    writeFileSync(path.join(d, "not-a-dir.json"), "x");
    expect(() => writeMcpFlag(path.join(d, "not-a-dir.json", "mcp_auto_approve.json"), true)).toThrow(
      /could not be saved/
    );
  });

  it("SEC-1 approvals accumulate per-Mac without duplicates", () => {
    const d = freshDir();
    expect(readMcpApprovals(d)).toEqual([]);
    const fp = mcpFingerprint(`{"mcpServers":{}}`);
    addMcpApproval(d, fp);
    addMcpApproval(d, fp);
    expect(readMcpApprovals(d)).toEqual([fp]);
    addMcpApproval(d, "another");
    expect(readMcpApprovals(d)).toEqual([fp, "another"]);
    // A corrupt file is not a crash, and grants nothing.
    writeFileSync(path.join(d, "mcp_approvals.json"), "{ half-written");
    expect(readMcpApprovals(d)).toEqual([]);
  });

  it("forgetConnectorGrants clears the session grant and the on-disk override", () => {
    // Both are keyed by NAME alone and used to outlive the connector: a later
    // connector landing on the same name silently inherited "run without
    // asking" and "send real values".
    const d = freshDir();
    writeFileSync(path.join(d, "mcp_connector_powers.json"), JSON.stringify({ github: { auto_approve: true } }));
    const session = new Set(["github", "notion"]);
    expect(forgetConnectorGrants(d, session, "github")).toBe(true);
    expect(session.has("github")).toBe(false);
    expect(session.has("notion")).toBe(true);
    expect(JSON.parse(readFileSync(path.join(d, "mcp_connector_powers.json"), "utf8"))).toEqual({});
    // Nothing was ever set for it the second time round.
    expect(forgetConnectorGrants(d, session, "github")).toBe(false);
  });
});

// ------------------------------------------------------------- config text

it("a_retargeted_or_dropped_connector_gives_up_its_sign_in", () => {
  // A stored sign-in belongs to an ENDPOINT and is filed under a NAME. The
  // Advanced editor and the marketplace both save through `mcp_apply_config`,
  // which never cleared one — so re-pointing `fetch` left `oauth:fetch` in
  // place, and the connect-time renewal merged a fresh token for the old
  // provider into an entry that now reached the new one.
  const withBody = (body: string): string => `{"mcpServers":${body}}`;
  const a = withBody(`{"fetch":{"url":"https://a.test/mcp","type":"http"}}`);
  const b = withBody(`{"fetch":{"url":"https://b.test/mcp","type":"http"}}`);
  expect(resignedServers(a, b)).toEqual(["fetch"]);

  // The same destination with other fields edited keeps its sign-in — otherwise
  // every save would log the user out.
  const aDisabled = withBody(`{"fetch":{"url":"https://a.test/mcp","type":"http","disabled":true}}`);
  expect(resignedServers(a, aDisabled)).toEqual([]);
  const aWithHeader = withBody(
    `{"fetch":{"url":"https://a.test/mcp","type":"http","headers":{"Authorization":"Bearer x"}}}`
  );
  expect(resignedServers(a, aWithHeader)).toEqual([]);
  // Key ORDER is not a change — `serde_json::Value`'s own equality ignores it,
  // and a re-serialized config routinely reorders.
  const reordered = withBody(`{"fetch":{"type":"http","url":"https://a.test/mcp"}}`);
  expect(resignedServers(a, reordered)).toEqual([]);

  // Dropped entirely: the name is free for something else, so the token must
  // not be waiting for whatever takes it.
  expect(resignedServers(a, withBody("{}"))).toEqual(["fetch"]);
  // A local connector re-pointed at another program is the same story.
  const local = withBody(`{"tools":{"command":"uvx","args":["one"]}}`);
  const moved = withBody(`{"tools":{"command":"uvx","args":["two"]}}`);
  expect(resignedServers(local, moved)).toEqual(["tools"]);
  // Nothing stored, or nothing readable: nothing is known to have moved.
  expect(resignedServers(withBody("{}"), a)).toEqual([]);
  expect(resignedServers("", a)).toEqual([]);
  expect(resignedServers("not json", a)).toEqual([]);
});

it("mcp_fingerprint_is_stable_and_config_sensitive", () => {
  const a = `{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}`;
  expect(mcpFingerprint(a)).toBe(mcpFingerprint(a));
  const b = `{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}`;
  expect(mcpFingerprint(a)).not.toBe(mcpFingerprint(b));
  expect(mcpFingerprint(a).length).toBe(64);
});

it("mcp_gate_blocks_unapproved_enabled_server", () => {
  // SEC-1 core invariant: an enabled server whose exact config has NOT been
  // approved on this Mac must NOT start — the gate asks first.
  const cfg = `{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}`;
  const gate = mcpGate(cfg, new Set());
  if (gate.kind !== "needsApproval") throw new Error("unapproved enabled server must gate, never Start");
  expect(gate.fingerprint).toBe(mcpFingerprint(cfg));
  expect(gate.servers.length).toBe(1);
  expect(gate.servers[0]![0]).toBe("web");
});

it("mcp_gate_starts_when_fingerprint_approved", () => {
  const cfg = `{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}`;
  const gate = mcpGate(cfg, new Set([mcpFingerprint(cfg)]));
  if (gate.kind !== "start") throw new Error("approved config must Start");
  expect(gate.servers.length).toBe(1);
  expect(gate.servers[0]![0]).toBe("web");
});

it("mcp_gate_nothing_when_only_disabled_servers", () => {
  // A config with only disabled servers is Nothing — no dialog, no spawn — even
  // though its fingerprint is not approved. The parsed list still rides along so
  // the UI can show them as Disabled without a second parse.
  const cfg = `{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"disabled":true}}}`;
  const gate = mcpGate(cfg, new Set());
  if (gate.kind !== "nothing") throw new Error("only-disabled config must be Nothing");
  expect(gate.servers.length).toBe(1);
  expect(gate.servers[0]![1].disabled).toBe(true);
  expect(mcpGate(`{"mcpServers":{}}`, new Set()).kind).toBe("nothing");
});

it("mcp_gate_edited_config_needs_reapproval", () => {
  const original = `{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}`;
  const approved = new Set([mcpFingerprint(original)]);
  expect(mcpGate(original, approved).kind).toBe("start");
  // One-character edit → different fingerprint → NeedsApproval again.
  const edited = `{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}`;
  expect(mcpGate(edited, approved).kind).toBe("needsApproval");
});

it("unreadable_config_is_reported_not_silently_empty", () => {
  // An unreadable connector setup used to be indistinguishable from "there is
  // nothing here": nothing started and the Connectors page just looked empty.
  const gate = mcpGate("{ half-written", new Set());
  if (gate.kind !== "unreadable") throw new Error("a config that cannot be parsed must be Unreadable");
  expect(gate.why.length).toBeGreaterThan(0);
  // A config from elsewhere whose server entry has neither command nor url.
  expect(mcpGate(`{"mcpServers":{"x":{"args":[]}}}`, new Set()).kind).toBe("unreadable");
  // Valid-but-empty is still Nothing, not an error.
  expect(mcpGate(`{"mcpServers":{}}`, new Set()).kind).toBe("nothing");
});

it("the_notice_row_is_not_a_connector_you_can_switch_off_or_delete", () => {
  // The Connectors page draws the "couldn't read your connector setup" row like
  // any other connector, so it comes with an On switch and a trash button.
  // Neither has a connector behind it — acting on them must repeat the SAME
  // explanation, not a second vaguer one, and must not touch the stored config.
  const broken = "{ half-written";
  const gate = mcpGate(broken, new Set());
  if (gate.kind !== "unreadable") throw new Error("expected unreadable");
  let err = "";
  try {
    requireReadableConfig(broken);
  } catch (e) {
    err = (e as Error).message;
  }
  expect(err).toBe(unreadableConfigMessage(gate.why));
  expect(err).toContain("fix the JSON under Advanced");

  // The dangerous shape: valid JSON with no `mcpServers`. Removing the notice
  // row from THAT succeeds silently, which rewrote the config, re-approved it
  // and left the page looking empty again — the very thing the row exists to
  // prevent.
  const noServers = `{"servers":{"x":{}}}`;
  expect(() => removeServerFromConfig(noServers, UNREADABLE_CONFIG_ROW)).not.toThrow();
  expect(() => requireReadableConfig(noServers)).toThrow();

  // A readable config — including a room that has never had one — is untouched
  // by the guard. And no real connector can collide with the notice row's name.
  expect(() => requireReadableConfig(`{"mcpServers":{}}`)).not.toThrow();
  expect(() => requireReadableConfig("")).not.toThrow();
  expect(() => requireReadableConfig("   ")).not.toThrow();
  expect(() => agentMcpName(UNREADABLE_CONFIG_ROW)).toThrow();
});

it("renders_full_command_line", () => {
  expect(
    renderCommandLine({
      transport: { kind: "stdio", command: "uvx", args: ["duckduckgo-mcp-server", "--verbose"], env: {} },
      disabled: false,
    })
  ).toBe("uvx duckduckgo-mcp-server --verbose");
  expect(renderCommandLine({ transport: { kind: "stdio", command: "node", args: [], env: {} }, disabled: false })).toBe(
    "node"
  );
});

it("renders_remote_endpoint_for_dialog", () => {
  // SEC-1: a remote connector's approval line names the endpoint and flags that
  // it reaches the internet — not a fake command line.
  const line = renderCommandLine({
    transport: { kind: "http", url: "https://mcp.notion.com/mcp", headers: {} },
    disabled: false,
  });
  expect(line).toContain("https://mcp.notion.com/mcp");
  expect(line).toContain("remote");
});

it("set_disabled_and_remove_edit_the_right_server", () => {
  const cfg = `{"mcpServers":{"web":{"command":"uvx","args":["ddg"]},"gh":{"type":"http","url":"https://x"}}}`;
  const off = setServerDisabled(cfg, "web", true);
  const v = asObject(JSON.parse(off));
  expect(asObject(asObject(v["mcpServers"])["web"])["disabled"]).toBe(true);
  expect(asObject(asObject(v["mcpServers"])["web"])["command"]).toBe("uvx");
  expect(asObject(asObject(v["mcpServers"])["gh"])["url"]).toBe("https://x");
  // Re-enabling removes the flag entirely (not "disabled":false).
  const v2 = asObject(JSON.parse(setServerDisabled(off, "web", false)));
  expect(asObject(asObject(v2["mcpServers"])["web"])["disabled"]).toBeUndefined();
  // Remove drops just that server.
  const v3 = asObject(JSON.parse(removeServerFromConfig(cfg, "web")));
  expect(asObject(v3["mcpServers"])["web"]).toBeUndefined();
  expect(asObject(v3["mcpServers"])["gh"]).toBeDefined();
  // Unknown server → error for disable, no-op for remove.
  expect(() => setServerDisabled(cfg, "nope", true)).toThrow();
  expect(() => removeServerFromConfig(cfg, "nope")).not.toThrow();
});

it("merge_and_strip_bearer_are_inverse", () => {
  const cfg = `{"mcpServers":{"gh":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}}`;
  const merged = mergeBearer(cfg, "gh", "tok123");
  const gh = (raw: string): Record<string, unknown> => asObject(asObject(asObject(JSON.parse(raw))["mcpServers"])["gh"]);
  expect(asObject(gh(merged)["headers"])["Authorization"]).toBe("Bearer tok123");
  expect(gh(merged)["url"]).toBe("https://api.githubcopilot.com/mcp/");
  // Stripping removes just the Authorization header.
  const stripped = stripBearer(merged, "gh");
  expect(asObject(gh(stripped)["headers"])["Authorization"]).toBeUndefined();
  expect(gh(stripped)["url"]).toBe("https://api.githubcopilot.com/mcp/");
  // Unknown server → error, not a crash; stripping one is a no-op.
  expect(() => mergeBearer(cfg, "nope", "t")).toThrow();
  expect(() => stripBearer(cfg, "nope")).not.toThrow();
});

it("tool_prefs_toggle_off_and_back_on", () => {
  expect(Object.keys(parseToolPrefs("{}")).length).toBe(0);
  // Turn a tool OFF → it lands in the server's off-list.
  const a = setToolPref("{}", "fetch-mcp", "http_head", false);
  expect(parseToolPrefs(a)["fetch-mcp"]!.has("http_head")).toBe(true);
  // A second tool OFF joins it; no duplicates on repeat.
  let b = setToolPref(a, "fetch-mcp", "http_put", false);
  b = setToolPref(b, "fetch-mcp", "http_put", false);
  expect(parseToolPrefs(b)["fetch-mcp"]!.size).toBe(2);
  // Turning the last one back ON removes it; emptying a server drops the key.
  let c = setToolPref(b, "fetch-mcp", "http_head", true);
  c = setToolPref(c, "fetch-mcp", "http_put", true);
  expect(parseToolPrefs(c)["fetch-mcp"]).toBeUndefined();
  // Garbage — or a stored value of the wrong SHAPE — degrades to "all on",
  // never an error and never a crash on `.filter` of a non-array.
  expect(Object.keys(parseToolPrefs("not json")).length).toBe(0);
  expect(Object.keys(parseToolPrefs(`{"srv":5}`)).length).toBe(0);
  expect(() => setToolPref(`{"srv":5}`, "srv", "t", false)).not.toThrow();
  expect(parseToolPrefs(setToolPref(`{"srv":5}`, "srv", "t", false))["srv"]!.has("t")).toBe(true);
});

// ---------------------------------------------------------------- redaction

it("agent_connector_views_never_expose_secret_fields", () => {
  const raw = {
    command: "npx",
    headers: { Authorization: "Bearer secret" },
    env: { API_KEY: "secret" },
    bearer_token_env_var: "TOKEN_ENV",
    token: "secret",
  };
  const safe = asObject(redactAgentMcpConfig(raw));
  expect(safe["headers"]).toBe("[redacted]");
  expect(safe["env"]).toBe("[redacted]");
  expect(safe["bearer_token_env_var"]).toBe("[redacted]");
  expect(safe["token"]).toBe("[redacted]");
  expect(JSON.stringify(safe)).not.toContain("secret");
  // A value that is not an object at all comes back unchanged rather than
  // becoming an empty one — the model must not be shown a connector the room
  // does not have.
  expect(redactAgentMcpConfig("just a string")).toBe("just a string");

  const incoming: Record<string, unknown> = { ...raw };
  removeAgentMcpSecrets(incoming);
  for (const key of AGENT_SECRET_KEYS) {
    expect(incoming[key]).toBeUndefined();
  }
});

it("agent_connector_views_mask_a_key_typed_onto_the_command_line", () => {
  // The named secret fields were covered; a key handed to a local connector as
  // an ARGUMENT went to the model verbatim.
  const raw = {
    command: "npx",
    args: [
      "-y",
      "@vendor/mcp-server",
      "--api-key",
      "sk-live-4kQm2p8Z1x7BvT0nRw",
      "--auth-token=9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny",
      "--db=/tmp/notes.db",
      "--port",
      "8080",
    ],
  };
  const shown = JSON.stringify(redactAgentMcpConfig(raw));
  expect(shown).not.toContain("sk-live-4kQm2p8Z1x7BvT0nRw");
  expect(shown).not.toContain("9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny");
  // Everything that merely describes the connector survives — the model still
  // has to be able to tell one connector from another.
  for (const kept of ["npx", "@vendor/mcp-server", "--api-key", "/tmp/notes.db", "8080"]) {
    expect(shown).toContain(kept);
  }
});

it("command_line_masking_knows_a_key_from_an_ordinary_argument", () => {
  // Bare opaque values: vendor prefixes, JWTs, long token runs.
  expect(redactCliArgs(["ghp_1a2b3c4d5e6f7g8h9i0j"])).toEqual(["[redacted]"]);
  expect(redactCliArgs(["A1b2C3d4E5f6G7h8I9j0K1l2M3"])).toEqual(["[redacted]"]);
  expect(redactCliArgs(["eyJhbGciOi.eyJzdWIiOiIxIn0.dBjftJeZ4CVP"])).toEqual(["[redacted]"]);
  // Ordinary arguments are left alone, however long.
  for (const plain of [
    "@modelcontextprotocol/server-filesystem",
    "/Users/me/Documents/notes",
    "--transport",
    "stdio",
    "--port=8080",
    "mcp-server-sqlite@0.1.2",
  ]) {
    expect(redactCliArgs([plain])).toEqual([plain]);
  }
  // Only the value after a credential flag is taken, and only once.
  expect(redactCliArgs(["--token", "abcdef", "--verbose"])).toEqual(["--token", "[redacted]", "--verbose"]);
  expect(isCredentialFlag("--api-key")).toBe(true);
  expect(isCredentialFlag("--accessToken")).toBe(true);
  expect(isCredentialFlag("API_KEY")).toBe(true);
  expect(isCredentialFlag("--port")).toBe(false);
  expect(isCredentialFlag("-")).toBe(false);
  expect(looksLikeSecret("sk-live-4kQm2p8Z1x7BvT0nRw")).toBe(true);
  expect(looksLikeSecret("/tmp/notes.db")).toBe(false);
});

it("saving_a_connector_read_through_the_mask_keeps_the_real_key", () => {
  // The model reads a connector (masked), edits something harmless, and saves
  // it back. The placeholder must NOT land in the stored config, and the
  // connector must not read as retargeted (which would drop the sign-in).
  const old = { command: "npx", args: ["srv", "--api-key", "sk-live-4kQm2p8Z1x7BvT0nRw"] };
  const incoming: Record<string, unknown> = { command: "npx", args: ["srv", "--api-key", "[redacted]"] };
  restoreRedactedArgs(old, incoming);
  expect((incoming["args"] as unknown[])[2]).toBe("sk-live-4kQm2p8Z1x7BvT0nRw");
  expect(sameDestination(old, incoming)).toBe(true);

  // The `--flag=[redacted]` spelling is restored the same way.
  const old2 = { command: "npx", args: ["--token=9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny"] };
  const incoming2: Record<string, unknown> = { command: "npx", args: ["--token=[redacted]"] };
  restoreRedactedArgs(old2, incoming2);
  expect((incoming2["args"] as unknown[])[0]).toBe("--token=9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny");
});

it("a_reshuffled_args_list_still_restores_the_right_key", () => {
  // The model read the masked args, then added, dropped and reordered arguments
  // before saving. Restoring by INDEX put the literal "[redacted]" — or a
  // neighbouring flag — where the user's key was.
  const key = "sk-live-4kQm2p8Z1x7BvT0nRw";
  const old = { command: "npx", args: ["srv", "--api-key", key] };

  // An argument inserted before the pair: the placeholder is now past the end
  // of the stored array.
  const inserted: Record<string, unknown> = { command: "npx", args: ["--verbose", "srv", "--api-key", "[redacted]"] };
  restoreRedactedArgs(old, inserted);
  expect((inserted["args"] as unknown[])[3]).toBe(key);

  // A leading argument dropped: index 1 in the stored array is the FLAG.
  const dropped: Record<string, unknown> = { command: "npx", args: ["--api-key", "[redacted]"] };
  restoreRedactedArgs(old, dropped);
  expect((dropped["args"] as unknown[])[1]).toBe(key);

  // Two credentials, swapped: each placeholder must follow its own flag.
  const token = "9f2Ab7Qz3Lm8Xt1Rv6Kd0Ny";
  const two = { command: "npx", args: ["--api-key", key, "--token", token] };
  const swapped: Record<string, unknown> = { command: "npx", args: ["--token", "[redacted]", "--api-key", "[redacted]"] };
  restoreRedactedArgs(two, swapped);
  expect((swapped["args"] as unknown[])[1]).toBe(token);
  expect((swapped["args"] as unknown[])[3]).toBe(key);
});

it("a_placeholder_that_matches_nothing_stops_the_save", () => {
  // Last line of defence: the word "[redacted]" is never a real argument.
  // Storing it replaces a credential the user cannot get back, and makes the
  // entry read as a retarget, which also clears their sign-in.
  const old = { command: "npx", args: ["srv"] };
  const invented: Record<string, unknown> = { command: "npx", args: ["srv", "--api-key", "[redacted]"] };
  restoreRedactedArgs(old, invented);
  expect(() => rejectSurvivingPlaceholders(invented)).toThrow(/no stored value matches it/);
  // A brand-new connector has no stored args at all.
  expect(() => rejectSurvivingPlaceholders({ command: "npx", args: ["--token=[redacted]"] })).toThrow();
  // A restored (or never-masked) save goes through untouched.
  expect(() =>
    rejectSurvivingPlaceholders({ command: "npx", args: ["srv", "--api-key", "sk-live-4kQm2p8Z"] })
  ).not.toThrow();
  expect(() => rejectSurvivingPlaceholders({ type: "http", url: "https://api.vendor.com/mcp" })).not.toThrow();
});

it("consent_card_says_when_arguments_are_cut_short", () => {
  // Short calls are shown whole, byte for byte.
  const small = { q: "weather" };
  expect(previewArgs(small, MCP_ARG_PREVIEW_MAX)).toBe(JSON.stringify(small));
  // A document-sized call must NOT read like a trivial one: the card says it
  // was cut, by how much, and that Allow sends all of it.
  const big = { doc: "x".repeat(5000) };
  const raw = JSON.stringify(big);
  const shown = previewArgs(big, 100);
  expect(shown.slice(0, 100)).toBe(raw.slice(0, 100));
  expect(shown).toContain("first 100 of");
  expect(shown).toContain("Allowing sends ALL of it");
  // The count is of the WHOLE payload, not the slice.
  expect(shown).toContain(String(Array.from(raw).length));
  // A call with no arguments at all still renders — the card is on the way to a
  // consent prompt, which must not be replaced by a crash.
  expect(previewArgs(undefined, MCP_ARG_PREVIEW_MAX)).toBe("null");
});

it("agent_edit_keeps_credentials_only_when_the_target_is_unchanged", () => {
  const old = { type: "http", url: "https://api.vendor.com/mcp" };
  const same = { type: "http", url: "https://api.vendor.com/mcp", disabled: true };
  expect(sameDestination(old, same)).toBe(true);
  // Same name, new endpoint → the saved sign-in must NOT travel with it.
  expect(sameDestination(old, { type: "http", url: "https://evil.example/mcp" })).toBe(false);
  // Local connectors are pinned on what they RUN, args included.
  const local = { command: "uvx", args: ["ddg"] };
  expect(sameDestination(local, { ...local })).toBe(true);
  expect(sameDestination(local, { command: "uvx", args: ["something-else"] })).toBe(false);
  // A missing key and an explicit null are not the same destination.
  expect(sameDestination(local, { command: "uvx", args: ["ddg"], url: null })).toBe(false);
});

it("agent_connector_names_and_roots_are_strict", () => {
  expect(agentMcpName("github.v2")).toBe("github.v2");
  expect(() => agentMcpName("has space")).toThrow();
  expect(() => agentMcpName("../escape")).toThrow();
  expect(() => agentMcpName("x".repeat(65))).toThrow();
  const root = agentMcpRoot(`{"mcpServers":{}}`);
  expect(typeof root["mcpServers"]).toBe("object");
  expect(() => agentMcpRoot(`{"mcpServers":[]}`)).toThrow();
  expect(() => agentMcpRoot(`[]`)).toThrow();
});

// ------------------------------- connector names that spell a JS prototype key

/**
 * A connector NAME is just a key to Rust's `serde_json::Map`/`BTreeMap`, and
 * `agent_mcp_name` accepts `__proto__`, `constructor`, `toString`, `valueOf` and
 * `hasOwnProperty` — all letters and underscores. In JavaScript every one of
 * them already exists on `Object.prototype`, so a port that reaches a config
 * entry with `map[name]` reads (and worse, WRITES) something that was never in
 * the config.
 *
 * The room's author is the attacker (SEC-1's own premise) and connector names
 * travel inside the `.roomai`, so these are inputs, not curiosities. The
 * exploit these tests pin: a room ships a remote connector named `__proto__`,
 * the user clicks "Connect account", and `mergeBearer` files their fresh OAuth
 * bearer under `Object.prototype.headers` — from where `parseMcpConfig` reads
 * it back as EVERY connector's own `Authorization` header, including the
 * attacker's. `setServerDisabled` was the same shape aimed at
 * `Object.prototype.disabled`, which stops every connector in the room at once.
 */
describe("connector names that collide with Object.prototype are ordinary keys", () => {
  const PROTO_NAMES = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];
  /** Nothing here may leave a mark on the prototype, whatever else it does. */
  afterEach(() => {
    for (const k of ["headers", "disabled", "Authorization", "url", "args"]) {
      expect(
        Object.prototype.hasOwnProperty.call(Object.prototype, k),
        `Object.prototype.${k} was set — the process is polluted`
      ).toBe(false);
    }
  });

  it("mergeBearer never writes a bearer onto Object.prototype", () => {
    const cfg = JSON.stringify({
      mcpServers: { innocent: { type: "http", url: "https://api.vendor.com/mcp" } },
    });
    for (const name of PROTO_NAMES) {
      // Not in the config → the same refusal any other absent name gets.
      expect(() => mergeBearer(cfg, name, "SECRET-USER-TOKEN")).toThrow(
        `"${name}" is not in the connector config`
      );
    }
    // The innocent connector's own headers are untouched by all of that.
    const innocent = asObject(asObject(asObject(JSON.parse(cfg))["mcpServers"])["innocent"]);
    expect(innocent["headers"]).toBeUndefined();
  });

  it("mergeBearer/stripBearer round-trip a connector that really IS named __proto__", () => {
    // JSON.parse gives `__proto__` as an OWN property, so this is a config a
    // room can genuinely carry — and the bearer belongs in ITS entry, nowhere else.
    const cfg = `{"mcpServers":{"__proto__":{"type":"http","url":"https://a.test/mcp"},"innocent":{"type":"http","url":"https://b.test/mcp"}}}`;
    const merged = mergeBearer(cfg, "__proto__", "SECRET-USER-TOKEN");
    const servers = asObject(asObject(JSON.parse(merged))["mcpServers"]);
    expect(asObject(asObject(servers["__proto__"])["headers"])["Authorization"]).toBe(
      "Bearer SECRET-USER-TOKEN"
    );
    // The other connector did not inherit the token.
    expect(asObject(servers["innocent"])["headers"]).toBeUndefined();
    expect(JSON.stringify(servers["innocent"])).not.toContain("SECRET-USER-TOKEN");
    const stripped = stripBearer(merged, "__proto__");
    const after = asObject(asObject(JSON.parse(stripped))["mcpServers"]);
    expect(asObject(asObject(after["__proto__"])["headers"])["Authorization"]).toBeUndefined();
  });

  it("setServerDisabled refuses an absent prototype-key name instead of disabling everything", () => {
    const cfg = JSON.stringify({
      mcpServers: { innocent: { type: "http", url: "https://api.vendor.com/mcp" } },
    });
    for (const name of PROTO_NAMES) {
      expect(() => setServerDisabled(cfg, name, true)).toThrow(
        `"${name}" is not in the connector config`
      );
    }
    expect(asObject(asObject(asObject(JSON.parse(cfg))["mcpServers"])["innocent"])["disabled"]).toBeUndefined();
  });

  it("setToolPref stores a per-tool opt-out for such a name instead of throwing", () => {
    for (const name of PROTO_NAMES) {
      const raw = setToolPref("{}", name, "dangerous_tool", false);
      expect(parseToolPrefs(raw)[name]?.has("dangerous_tool"), `${name} opt-out was lost`).toBe(true);
      // …and turning it back on empties the entry, exactly like any other name.
      expect(parseToolPrefs(setToolPref(raw, name, "dangerous_tool", true))[name]).toBeUndefined();
    }
  });

  it("setConnectorPower stores and clears such a name's override", () => {
    for (const name of PROTO_NAMES) {
      const raw = setConnectorPower("{}", name, "autoApprove", true);
      expect(parseConnectorPowers(raw)[name]?.autoApprove, `${name} override was lost`).toBe(true);
      expect(parseConnectorPowers(setConnectorPower(raw, name, "autoApprove", null))[name]).toBeUndefined();
    }
  });

  it("forgetConnectorGrants does not claim to have cleared a grant that never existed", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-proto-grants-"));
    const powers = path.join(dir, "mcp_connector_powers.json");
    try {
      for (const name of PROTO_NAMES) {
        expect(forgetConnectorGrants(dir, new Set<string>(), name), `${name} faked a cleared grant`).toBe(
          false
        );
      }
      // A real grant for such a name is still cleared for real.
      writeFileSync(powers, setConnectorPower("{}", "__proto__", "autoApprove", true));
      expect(forgetConnectorGrants(dir, new Set<string>(), "__proto__")).toBe(true);
      expect(parseConnectorPowers(readFileSync(powers, "utf8"))["__proto__"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resignedServers still catches a retarget of such a name", () => {
    for (const name of PROTO_NAMES) {
      const prev = JSON.stringify({ mcpServers: { [name]: { url: "https://a.test/mcp", type: "http" } } });
      expect(resignedServers(prev, JSON.stringify({ mcpServers: {} }))).toEqual([name]);
      const moved = JSON.stringify({ mcpServers: { [name]: { url: "https://b.test/mcp", type: "http" } } });
      expect(resignedServers(prev, moved)).toEqual([name]);
      // …and does NOT flag one that stayed put.
      expect(resignedServers(prev, prev)).toEqual([]);
    }
  });
});

// ============================================================== integration

/** Real room DB fixture, matching `db-host/memories.test.ts`'s convention. */
describe("agent_* integration (real room DB)", () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });
  function freshRoom(): Database.Database {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-mcpconfig-"));
    const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
    return createRoom(roomPath, "correct horse battery staple", "Test Room");
  }
  function storeConfig(db: Database.Database, json: string): void {
    db.prepare(
      `INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(MCP_CONFIG_KEY, json);
  }
  const stored = (db: Database.Database, name: string): Record<string, unknown> | undefined => {
    const servers = asObject(asObject(JSON.parse(getMcpConfig(db)))["mcpServers"]);
    // OWN key only: for a connector named `__proto__` a plain `servers[name]`
    // answers with `Object.prototype` — so this helper would have reported a
    // deleted connector as still present (and an absent one as `{}`).
    return Object.prototype.hasOwnProperty.call(servers, name) ? asObject(servers[name]) : undefined;
  };

  it("agentListMcps reports an empty room, then real entries with status", () => {
    const db = freshRoom();
    expect(agentListMcps(db)).toBe("No MCP connectors are configured in this room.");

    storeConfig(
      db,
      `{"mcpServers":{"web":{"command":"uvx","args":["ddg","--api-key","sk-live-4kQm2p8Z1x7BvT0nRw"]},"gh":{"type":"http","url":"https://api.githubcopilot.com/mcp/","disabled":true}}}`
    );
    const listing = agentListMcps(db, new Map([["web", "connected"]]));
    expect(listing).toContain("- web [connected] — local: uvx ddg --api-key [redacted]");
    expect(listing).toContain("- gh [disabled] — remote: https://api.githubcopilot.com/mcp/");
    expect(listing).not.toContain("sk-live-4kQm2p8Z1x7BvT0nRw");

    // No status supplied for an enabled connector → Rust's own "configured"
    // fallback, never a claim that it is connected.
    expect(agentListMcps(db)).toContain("- web [configured]");
  });

  it("agentReadMcp redacts secrets and refuses an unknown name", () => {
    const db = freshRoom();
    storeConfig(db, `{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"API_KEY":"topsecret"}}}}`);
    const read = agentReadMcp(db, "web");
    expect(read).toContain("Connector web (credentials redacted)");
    expect(read).not.toContain("topsecret");
    expect(() => agentReadMcp(db, "nope")).toThrow('No connector named "nope" exists.');
  });

  it("agentSaveMcp ALWAYS saves disabled, even when the model asks for enabled — the SEC-1 property", () => {
    const db = freshRoom();
    const msg = agentSaveMcp(db, { name: "web", config: { command: "uvx", args: ["ddg"], disabled: false } });
    expect(msg).toContain('Saved connector "web" as disabled.');
    expect(stored(db, "web")!["disabled"]).toBe(true);
  });

  it("agentSaveMcp strips secret fields the model tried to write, without mutating the caller's arguments", () => {
    const db = freshRoom();
    const args = {
      name: "web",
      config: { command: "uvx", args: ["ddg"], headers: { Authorization: "Bearer x" }, token: "abc" },
    };
    agentSaveMcp(db, args);
    expect(stored(db, "web")!["headers"]).toBeUndefined();
    expect(stored(db, "web")!["token"]).toBeUndefined();
    // Rust clones the whole `config` value; a shallow copy here would reach
    // back through `args.config.args` into the caller's own object.
    expect(args.config.headers).toEqual({ Authorization: "Bearer x" });
    expect(args.config.args).toEqual(["ddg"]);
    expect((args.config as Record<string, unknown>)["disabled"]).toBeUndefined();
  });

  it("agentSaveMcp preserves credentials on a same-destination edit, and updates rather than creates", () => {
    const db = freshRoom();
    // A save through the agent path can never itself carry a header in
    // (removeAgentMcpSecrets strips it) — seed the "already had a header" case
    // the way a user's own Connectors edit would, then re-save via the agent
    // with a cosmetic change.
    expect(agentSaveMcp(db, { name: "gh", config: { type: "http", url: "https://api.githubcopilot.com/mcp/" } })).toContain(
      "Saved connector"
    );
    storeConfig(
      db,
      JSON.stringify({
        mcpServers: {
          gh: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer real-token" },
            disabled: true,
          },
        },
      })
    );
    const second = agentSaveMcp(db, { name: "gh", config: { type: "http", url: "https://api.githubcopilot.com/mcp/" } });
    expect(second).toContain("Updated connector");
    expect(second).not.toContain("NOT carried over");
    expect(asObject(stored(db, "gh")!["headers"])["Authorization"]).toBe("Bearer real-token");
  });

  it("agentSaveMcp drops credentials AND the stored sign-in on a retarget, and reports both", () => {
    const db = freshRoom();
    storeConfig(
      db,
      JSON.stringify({
        mcpServers: {
          gh: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer real-token" },
            disabled: true,
          },
        },
      })
    );
    const token: TokenSet = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      clientId: "c",
      tokenEndpoint: "https://x/token",
      refreshRejected: false,
    };
    saveTokens(db, "gh", token);

    const forgotten: string[] = [];
    const msg = agentSaveMcp(
      db,
      { name: "gh", config: { type: "http", url: "https://evil.example/mcp" } },
      {
        forgetConnectorGrants: (server) => {
          forgotten.push(server);
          return { cleared: true };
        },
      }
    );
    expect(msg).toContain("NOT carried over");
    expect(msg).toContain("cleared for the same reason");
    expect(forgotten).toEqual(["gh"]);
    // The sign-in belonged to the OLD endpoint: it must not be waiting for the
    // new one under the same name.
    expect(loadTokens(db, "gh")).toBeNull();
    expect(stored(db, "gh")!["headers"]).toBeUndefined();
    expect(stored(db, "gh")!["url"]).toBe("https://evil.example/mcp");
  });

  it("agentSaveMcp leaves a same-destination edit's sign-in and grants alone", () => {
    const db = freshRoom();
    agentSaveMcp(db, { name: "gh", config: { type: "http", url: "https://api.vendor.com/mcp" } });
    saveTokens(db, "gh", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      clientId: "c",
      tokenEndpoint: "https://x/token",
      refreshRejected: false,
    });
    const forgetConnectorGrants = vi.fn(() => ({ cleared: true }));
    const msg = agentSaveMcp(
      db,
      { name: "gh", config: { type: "http", url: "https://api.vendor.com/mcp", description: "notes" } },
      { forgetConnectorGrants }
    );
    expect(msg).not.toContain("NOT carried over");
    expect(msg).not.toContain("cleared for the same reason");
    expect(forgetConnectorGrants).not.toHaveBeenCalled();
    expect(loadTokens(db, "gh")).not.toBeNull();
  });

  it("agentSaveMcp reports (without throwing) when the grants file could not be rewritten", () => {
    const db = freshRoom();
    agentSaveMcp(db, { name: "gh", config: { type: "http", url: "https://a.test/mcp" } });
    const msg = agentSaveMcp(
      db,
      { name: "gh", config: { type: "http", url: "https://b.test/mcp" } },
      {
        forgetConnectorGrants: () => {
          throw new Error("the permissions file could not be written");
        },
      }
    );
    expect(msg).toContain("the permissions file could not be written");
  });

  it("agentSaveMcp refuses a placeholder with nothing to restore it from", () => {
    const db = freshRoom();
    expect(() =>
      agentSaveMcp(db, { name: "web", config: { command: "npx", args: ["srv", "--api-key", "[redacted]"] } })
    ).toThrow(/no stored value matches it/);
    expect(stored(db, "web")).toBeUndefined();
  });

  it("agentSaveMcp validates the name and requires a config object", () => {
    const db = freshRoom();
    expect(() => agentSaveMcp(db, { name: "has space", config: {} })).toThrow();
    expect(() => agentSaveMcp(db, { name: "ok" })).toThrow("save_mcp needs a `config` object.");
  });

  it("agentSaveMcp kicks off a reconnect with the parsed servers", () => {
    const db = freshRoom();
    const reconnect = vi.fn();
    agentSaveMcp(db, { name: "web", config: { command: "uvx", args: [] } }, { reconnect });
    expect(reconnect).toHaveBeenCalledTimes(1);
    const servers = reconnect.mock.calls[0]![0] as Array<[string, unknown]>;
    expect(servers.some(([name]) => name === "web")).toBe(true);
  });

  it("agentDeleteMcp declined leaves the connector untouched", async () => {
    const db = freshRoom();
    agentSaveMcp(db, { name: "web", config: { command: "uvx", args: [] } });
    await expect(agentDeleteMcp(db, { name: "web" }, { confirmDestructive: async () => false })).rejects.toThrow(
      DELETE_DECLINED
    );
    expect(stored(db, "web")).toBeDefined();
  });

  it("agentDeleteMcp approved removes the connector and its OAuth token", async () => {
    const db = freshRoom();
    agentSaveMcp(db, { name: "web", config: { command: "uvx", args: [] } });
    saveTokens(db, "web", {
      accessToken: "at",
      refreshToken: null,
      expiresAt: 0,
      clientId: null,
      tokenEndpoint: null,
      refreshRejected: false,
    });
    let confirmed = "";
    const reconnect = vi.fn();
    const msg = await agentDeleteMcp(
      db,
      { name: "web" },
      {
        confirmDestructive: async (what, name, detail) => {
          confirmed = `${what}:${name}:${detail}`;
          return true;
        },
        reconnect,
      }
    );
    expect(confirmed).toContain("connector:web:");
    expect(confirmed).toContain("There is no undo");
    expect(msg).toContain('Deleted connector "web"');
    expect(stored(db, "web")).toBeUndefined();
    expect(loadTokens(db, "web")).toBeNull();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("agentDeleteMcp asks BEFORE it looks the connector up, and refuses an unknown name", async () => {
    const db = freshRoom();
    let asked = 0;
    await expect(
      agentDeleteMcp(db, { name: "nope" }, { confirmDestructive: async () => { asked += 1; return true; } })
    ).rejects.toThrow('No connector named "nope" exists.');
    expect(asked).toBe(1);
  });

  it("agentDeleteMcp reports (without throwing) when forgetConnectorGrants fails", async () => {
    // The connector IS deleted; answering with an error would have the model
    // tell the user nothing happened.
    const db = freshRoom();
    agentSaveMcp(db, { name: "web", config: { command: "uvx", args: [] } });
    const msg = await agentDeleteMcp(db, { name: "web" }, {
      confirmDestructive: async () => true,
      forgetConnectorGrants: () => {
        throw new Error("the permissions file could not be written");
      },
    });
    expect(msg).toContain('Deleted connector "web"');
    expect(msg).toContain("the permissions file could not be written");
  });

  it("a connector named __proto__ is saved, read and deleted like any other", async () => {
    // `agentMcpName` accepts it, so the agent CRUD path has to handle it as a
    // key. It used to answer 'Updated connector "__proto__" as disabled.' while
    // storing NOTHING (the assignment hit `Object.prototype`'s setter), and
    // `agentReadMcp` then answered with `Object.prototype` serialized as `{}`
    // rather than saying the connector does not exist.
    const db = freshRoom();
    expect(() => agentReadMcp(db, "__proto__")).toThrow('No connector named "__proto__" exists.');

    const msg = agentSaveMcp(db, { name: "__proto__", config: { command: "uvx", args: ["x"] } });
    expect(msg).toContain('Saved connector "__proto__" as disabled.'); // Saved, not "Updated"
    const entry = stored(db, "__proto__");
    expect(entry, "the connector was reported saved but never stored").toBeDefined();
    expect(entry!["command"]).toBe("uvx");
    expect(entry!["disabled"]).toBe(true);
    expect(agentReadMcp(db, "__proto__")).toContain('"command": "uvx"');
    expect(agentListMcps(db)).toContain("- __proto__ [disabled] — local: uvx x");

    // A second save is an UPDATE, and a retarget still gives up the sign-in.
    saveTokens(db, "__proto__", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      clientId: "c",
      tokenEndpoint: "https://x/token",
      refreshRejected: false,
    });
    const second = agentSaveMcp(db, { name: "__proto__", config: { command: "npx", args: ["y"] } });
    expect(second).toContain('Updated connector "__proto__"');
    expect(loadTokens(db, "__proto__")).toBeNull();

    expect(
      await agentDeleteMcp(db, { name: "__proto__" }, { confirmDestructive: async () => true })
    ).toContain('Deleted connector "__proto__"');
    expect(stored(db, "__proto__")).toBeUndefined();
    // Nothing in any of that touched the prototype every other object shares.
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "command")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "disabled")).toBe(false);
  });

  it("applyMcpConfig: retargeting a connector clears its OAuth token end to end", () => {
    const db = freshRoom();
    applyMcpConfig(db, JSON.stringify({ mcpServers: { fetch: { url: "https://a.test/mcp", type: "http" } } }));
    saveTokens(db, "fetch", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      clientId: "c",
      tokenEndpoint: "https://a.test/token",
      refreshRejected: false,
    });
    const { clearedTokensFor } = applyMcpConfig(
      db,
      JSON.stringify({ mcpServers: { fetch: { url: "https://b.test/mcp", type: "http" } } })
    );
    expect(clearedTokensFor).toEqual(["fetch"]);
    expect(loadTokens(db, "fetch")).toBeNull();
    expect(stored(db, "fetch")!["url"]).toBe("https://b.test/mcp");
  });

  it("applyMcpConfig: a cosmetic edit keeps the sign-in, and an unreadable config is never written", () => {
    const db = freshRoom();
    const a = JSON.stringify({ mcpServers: { fetch: { url: "https://a.test/mcp", type: "http" } } });
    applyMcpConfig(db, a);
    saveTokens(db, "fetch", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      clientId: "c",
      tokenEndpoint: "https://a.test/token",
      refreshRejected: false,
    });
    const again = applyMcpConfig(
      db,
      JSON.stringify({ mcpServers: { fetch: { url: "https://a.test/mcp", type: "http", disabled: true } } })
    );
    expect(again.clearedTokensFor).toEqual([]);
    expect(loadTokens(db, "fetch")).not.toBeNull();

    expect(() => applyMcpConfig(db, "not json")).toThrow();
    expect(stored(db, "fetch")!["disabled"]).toBe(true); // the last good config survived
  });
});
