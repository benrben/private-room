/* THE DRIFT TEST for the two connector powers.
 *
 * Until 2026-08-03 a single "auto-approve" switch opened two gates at once:
 * it skipped the consent card AND it stopped the privacy door masking the
 * arguments a remote connector receives. The owner split them, because "run
 * this tool without asking me" and "send this tool the user's unredacted data"
 * are different risks and one of them is the product's whole promise.
 *
 * A split like that fails silently. Both flags are `Arc<AtomicBool>` on the
 * same struct, so reading the wrong one at either seam compiles, passes every
 * unit test written in terms of the deciders, and ships a build where turning
 * off the consent card quietly starts sending real names. The Rust tests pin
 * the DECIDERS (`skips_consent_card`, `masks_outbound_args`); nothing but this
 * pins which flag is handed to each of them, or that the UI still offers two
 * switches with honest copy.
 *
 * Textual, on purpose: it runs in `npm run test:page`, in a second, and it
 * reads the shipped sources rather than a model of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

/* Rust line comments, gone. This codebase writes WHY-comments, and the ones
 * around these two seams necessarily NAME the other flag to explain what it is
 * not — so a comment-blind "does this seam mention the wrong flag" check reads
 * good documentation as a defect. Only code counts. */
const stripComments = (src) => src.replace(/\/\/[^\n]*/g, "");

const AGENT = stripComments(read("src-tauri/src/commands/agent.rs"));
const MCP_CMDS = stripComments(read("src-tauri/src/commands/mcp_cmds.rs"));
const LIB = read("src-tauri/src/lib.rs");
const VIEW = read("src/workspace/ConnectorsView.tsx");
const HOOK = read("src/settings/useMcpConfig.ts");
const API = read("src/api.ts");
const MOCK = read("qa/qa-mock.js");

/** The body of a Rust fn, by brace matching from its signature. */
function fnBody(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `${signature} is gone from the source`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

test("the consent gate reads only the auto-approve flag, for THIS connector", () => {
  const body = fnBody(MCP_CMDS, "pub(crate) async fn mcp_call_approved");
  // Since the settings became per-connector the seam no longer reads the atomic
  // itself — it asks the resolver, which is the only place the Mac-wide default
  // and the connector's own answer are combined. Naming the connector is the
  // point: a seam that resolved without one would be the global switch again.
  assert.match(body, /auto_approve_for\(state, &route\.server_name\)/);
  assert.ok(
    !body.includes("unmask"),
    "asking for real arguments must never be a way to stop being asked",
  );
  // It goes through the pure decider, so the Rust truth table covers it.
  assert.match(body, /skips_consent_card\(/);
  // …and the resolver it calls touches only the auto-approve level.
  const resolver = fnBody(MCP_CMDS, "pub(crate) fn auto_approve_for");
  assert.match(resolver, /mcp_auto_approve/);
  assert.match(resolver, /\.auto_approve\b/, "it must read the connector's own answer");
  assert.ok(
    !resolver.includes("outbound_unmask"),
    "the consent resolver reaches into the unmasking level",
  );
});

test("the outbound seam reads only the unmasking flag, for THIS connector", () => {
  // `exec_tool` is enormous; take the window around the seam decision.
  const at = AGENT.indexOf("masks_outbound_args(route.remote");
  assert.notEqual(at, -1, "the outbound seam no longer calls masks_outbound_args");
  const window = AGENT.slice(at - 400, at + 200);
  assert.match(window, /outbound_unmask_for\(state, &route\.server_name\)/);
  assert.ok(
    !window.includes("auto_approve"),
    "permission to run unattended must never unmask what leaves the room",
  );
  const resolver = fnBody(MCP_CMDS, "pub(crate) fn outbound_unmask_for");
  assert.match(resolver, /mcp_outbound_unmask/);
  assert.match(resolver, /\.outbound_unmask\b/, "it must read the connector's own answer");
  assert.ok(
    !resolver.includes("auto_approve"),
    "the unmasking resolver reaches into the consent level",
  );
});

test("both connector powers persist separately and fail closed", () => {
  // Separate files: one flag's value can never be read as the other's, and an
  // install upgrading from the combined switch has no unmasking file at all.
  assert.match(MCP_CMDS, /"mcp_auto_approve\.json"/);
  assert.match(MCP_CMDS, /"mcp_outbound_unmask\.json"/);
  // Missing/corrupt on disk = OFF, for both, through one pure reader.
  const parse = fnBody(MCP_CMDS, "pub(crate) fn parse_connector_flag");
  assert.match(parse, /unwrap_or\(false\)/);
  // Four commands, all registered — a get/set pair per power.
  for (const cmd of [
    "get_mcp_auto_approve",
    "set_mcp_auto_approve",
    "get_mcp_outbound_unmask",
    "set_mcp_outbound_unmask",
  ]) {
    assert.match(LIB, new RegExp(`commands::${cmd},`), `${cmd} is not registered`);
    assert.match(API, new RegExp(`"${cmd}"`), `${cmd} is not reachable from the UI`);
  }
  // The harness answers both — including the SETTERS, whose absence meant a
  // switch in QA flipped optimistically and never round-tripped.
  for (const cmd of [
    "get_mcp_auto_approve",
    "set_mcp_auto_approve",
    "get_mcp_outbound_unmask",
    "set_mcp_outbound_unmask",
    "get_mcp_connector_powers",
    "set_mcp_connector_power",
  ]) {
    assert.match(MOCK, new RegExp(`${cmd}:`), `qa-mock.js does not fake ${cmd}`);
  }
});

test("the per-connector layer is reachable and defaults to following the switch", () => {
  // The owner's decision was "both default off — PER CONNECTOR". The global
  // pair survives only as the default a connector inherits, so the thing to pin
  // is that the per-connector level exists end to end AND that its neutral
  // state is a MISSING answer rather than a stored false — a false would freeze
  // every connector at whatever the global happened to be on upgrade day.
  assert.match(LIB, /commands::get_mcp_connector_powers,/);
  assert.match(LIB, /commands::set_mcp_connector_power,/);
  assert.match(API, /"get_mcp_connector_powers"/);
  assert.match(API, /"set_mcp_connector_power"/);
  // The overrides persist per-Mac beside the other consent state, never in the
  // room — the room's author is the attacker (SEC-1).
  assert.match(MCP_CMDS, /"mcp_connector_powers\.json"/);
  const parse = fnBody(MCP_CMDS, "pub(crate) fn parse_connector_powers");
  assert.match(parse, /unwrap_or_default\(\)/, "a corrupt file must grant nothing");
  // Both fields optional, and an absent answer is serialized as ABSENT.
  const shape = MCP_CMDS.slice(
    MCP_CMDS.indexOf("pub struct ConnectorOverride"),
    MCP_CMDS.indexOf("}", MCP_CMDS.indexOf("pub struct ConnectorOverride")),
  );
  assert.match(shape, /auto_approve: Option<bool>/);
  assert.match(shape, /outbound_unmask: Option<bool>/);
  assert.equal(
    (shape.match(/skip_serializing_if = "Option::is_none"/g) ?? []).length,
    2,
    "an unanswered power must not be written out as null",
  );
  // The two levels are combined in exactly ONE place, so the UI's "in force"
  // sentence and the seams can never disagree about which level wins.
  const eff = fnBody(MCP_CMDS, "pub(crate) fn effective_power");
  assert.match(eff, /over\.unwrap_or\(global\)/);
});

test("each connector states which level is in force for it", () => {
  // Point 3 of the packet: two controls whose interaction the user has to guess
  // are not acceptable. The per-connector control offers "follow the switch"
  // explicitly, and every connector prints the resolved answer next to it.
  assert.match(VIEW, /connectorPowers\[s\.name\]/, "the page ignores the overrides");
  assert.match(VIEW, /over\.auto_approve \?\? autoApprove/, "auto-approve does not fall back");
  assert.match(VIEW, /over\.outbound_unmask \?\? outboundUnmask/, "unmasking does not fall back");
  // Three states, not two — "follow" has to be selectable or a user could never
  // hand a connector back to the switch above.
  for (const v of ['value="follow"', 'value="on"', 'value="off"']) {
    assert.ok(VIEW.includes(v), `the per-connector control is missing ${v}`);
  }
  // The resolved sentence names the level, both ways.
  assert.match(VIEW, /from the setting above/);
  assert.match(VIEW, /set here, so the setting above doesn't apply/);
  // And the two global switches no longer claim to be the last word.
  assert.match(VIEW, /except where a connector below says otherwise/);
  // The hook clears an override with null (follow), never false (a stored no).
  assert.match(HOOK, /async function setConnectorPower\([^)]*value: boolean \| null,/s);
  const setter = fnBody(HOOK, "async function setConnectorPower");
  assert.match(setter, /mcpSetConnectorPower\(server, power, value\)/);
  // Not optimistic: it shows what the backend stored. A per-connector grant is
  // a permission, and the page must never display one that was never written.
  assert.match(setter, /setConnectorPowers\(await api\.mcpSetConnectorPower/);
});

test("each Tauri command touches only its own flag and its own file", () => {
  /* The hole the first pass left open. The two seams were pinned, and the Rust
   * tests pin the deciders and the persistence pair — but nothing pinned the
   * four COMMANDS in between, and they are the easiest place to swap a field by
   * accident because the two atomics have the same type on the same struct.
   *
   * Verified by mutation, three ways, all of which the suite passed before this
   * test existed:
   *   - `set_mcp_auto_approve` storing into `mcp_outbound_unmask`: flipping
   *     "run without asking" would have started sending real values and never
   *     have granted consent at all.
   *   - `set_mcp_auto_approve` writing `mcp_outbound_unmask.json`: the choice
   *     comes back as the OTHER power after a restart.
   *   - `get_mcp_outbound_unmask` reading `mcp_auto_approve`: the switch and
   *     its "Currently ON/OFF" sentence both report the wrong power.
   * They cannot be caught in Rust — every one of these commands takes an
   * `AppHandle`. */
  const pairs = [
    ["get_mcp_auto_approve", "mcp_auto_approve", "mcp_outbound_unmask"],
    ["set_mcp_auto_approve", "mcp_auto_approve", "mcp_outbound_unmask"],
    ["get_mcp_outbound_unmask", "mcp_outbound_unmask", "mcp_auto_approve"],
    ["set_mcp_outbound_unmask", "mcp_outbound_unmask", "mcp_auto_approve"],
  ];
  for (const [cmd, own, other] of pairs) {
    const body = fnBody(MCP_CMDS, `pub fn ${cmd}`);
    // The atomic it reads or stores.
    assert.match(body, new RegExp(`\\.${own}\\b`), `${cmd} does not touch ${own}`);
    // A setter also has to name its OWN file. Deliberately a bare substring
    // check on the other name, not a word-boundary one: `mcp_outbound_unmask`
    // and `mcp_outbound_unmask_file` are different identifiers, and a setter
    // that stored the right atomic but persisted to the wrong file would slip
    // straight through a `\b`-anchored test and come back as the other power
    // after a restart.
    if (cmd.startsWith("set_")) {
      assert.match(body, new RegExp(`${own}_file\\(`), `${cmd} persists elsewhere`);
    }
    assert.ok(
      !body.includes(other),
      `${cmd} reaches into ${other} — the two powers are one switch again`,
    );
  }
});

test("the hook's setters each move only their own flag", () => {
  const auto = fnBody(HOOK, "async function setAutoApprove");
  const unmask = fnBody(HOOK, "async function setOutboundUnmask");
  assert.ok(!auto.includes("OutboundUnmask"), "the consent switch must not unmask");
  assert.ok(!unmask.includes("AutoApprove"), "the unmask switch must not grant consent");
  // Both start false, so a switch never reads ON for a frame before Rust answers
  // and tells the user their details are already leaving.
  assert.match(HOOK, /useState\(false\);\s*\n\s*const \[outboundUnmask/);
});

/* The two powers used to be written out twice as hand-rolled <label> blocks.
 * The notebook pass factored them into one local <PowerCard>, which is why this
 * reads props rather than a raw checkbox: the flag now arrives as `on={…}` and
 * the words as `copy`/`whenOn`/`whenOff`. The INVARIANT is unchanged, and so is
 * what would break it — a card's flag and its words still live inside the same
 * slice of source, so crossing the copy onto the wrong switch still fails here.
 *
 * Slicing on the sibling tag, not on `/>`: the copy contains `</>` fragments,
 * whose last two characters are also `/>`. */
function powerCards() {
  const rowAt = VIEW.indexOf('<div className="conn-powers');
  assert.notEqual(rowAt, -1, "the row that holds the two powers is gone");
  const row = VIEW.slice(rowAt, VIEW.indexOf("</section>", rowAt));
  const parts = row.split("<PowerCard").slice(1);
  const byFlag = new Map();
  for (const part of parts) {
    const flag = /\bon=\{(\w+)\}/.exec(part)?.[1];
    assert.ok(flag, `a power switch is not bound to a flag at all: ${part.slice(0, 80)}`);
    // Cut at this card's OWN closing tag, not at the next <PowerCard. Splitting
    // on the sibling left each slice running through the gap to the next one —
    // including the next card's leading JSX comment — so the "must not mention
    // the other power" guards below were reading text belonging to the control
    // they were meant to be isolating from.
    //
    // The boundary is `/>` alone on its own line at the element's indent. A
    // bare indexOf("/>") does NOT work: the copy is JSX containing `</>`
    // fragment closers, whose last two characters are also `/>`, so it cuts in
    // the middle of the very sentences these tests exist to pin.
    const end = part.search(/\n\s*\/>/);
    byFlag.set(flag, end === -1 ? part : part.slice(0, end));
  }
  return byFlag;
}

test("the Connectors page offers two switches and each states its own effect", () => {
  const cards = powerCards();
  assert.ok(cards.has("autoApprove"), "the consent switch is gone");
  assert.ok(cards.has("outboundUnmask"), "the unmasking switch is gone");
  assert.equal(cards.size, 2, "a third Mac-wide power appeared without a test");

  // Each card's copy is scoped to its own power. The consent switch must NOT
  // still promise real values — that claim moving with the wrong switch is the
  // exact confusion the split removes.
  const autoCopy = cards.get("autoApprove");
  assert.ok(
    !/real values/i.test(autoCopy),
    "the consent switch must not claim to change what is sent",
  );
  assert.match(autoCopy, /without asking/i);
  assert.match(cards.get("outboundUnmask"), /real values/i);

  // The CONSEQUENCE, not just the label. These two sentences are the whole
  // reason the switches are dangerous, and pinning only the prop NAMES let
  // them be emptied without failing anything: whenOn=" " would have passed.
  assert.match(
    autoCopy,
    /run unattended/i,
    "the consent switch no longer says its calls run unattended",
  );
  assert.match(
    cards.get("outboundUnmask"),
    /remote connectors see real values/i,
    "the unmasking switch no longer says remote connectors see real values",
  );

  // Each still supplies BOTH halves of the live-state sentence. A card that
  // passed only one would read as a default again the moment it was flipped.
  for (const part of cards.values()) {
    assert.match(part, /\bwhenOn=/);
    assert.match(part, /\bwhenOff=/);
  }

  // The state sentence itself is now rendered once, by the shared card, off the
  // live flag — so neither power can quietly drift back to describing a fresh
  // install. That wording is what live QA once read as a privacy bug.
  const cardAt = VIEW.indexOf("function PowerCard");
  assert.notEqual(cardAt, -1, "the shared power card is gone");
  const card = VIEW.slice(cardAt, VIEW.indexOf("\n}\n", cardAt));
  assert.match(card, /on \? "Currently ON" : "Currently OFF"/);
  assert.match(card, /on \? whenOn : whenOff/);

  // …and so does the header ABOVE them. It used to promise flatly that Arcelle
  // "asks before either starts, and hides this room's private details", two
  // sentences the two switches can each falsify — sitting directly over the
  // checkbox that falsifies them. Splitting the control without fixing the
  // paragraph would have left the page's most prominent privacy claim wrong in
  // one more way than before. (It was `.settings-hint`; the notebook pass moved
  // it to `.conn-lead` because it is the page's lead instruction, not a 12px
  // muted aside. The class may move again — the reading off both flags may not.)
  const leadAt = VIEW.indexOf('<p className="conn-lead">');
  assert.notEqual(leadAt, -1, "the page lost the lead paragraph over the switches");
  const head = VIEW.slice(leadAt, VIEW.indexOf("</p>", leadAt));
  assert.match(head, /autoApprove/, "the header does not read off the consent switch");
  assert.match(head, /outboundUnmask/, "the header does not read off the unmasking switch");
});
