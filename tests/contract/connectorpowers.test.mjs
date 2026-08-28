/* Renderer checks for the two independent connector powers. Host persistence
 * and fail-closed behavior are covered by mcpConfig.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const view = read("apps/desktop/src/renderer/workspace/ConnectorsView.tsx");
const hook = read("apps/desktop/src/renderer/settings/useMcpConfig.ts");
const contract = read("apps/desktop/src/shared/ipc-contract.ts");
const mock = read("tests/support/qa-mock.js");

test("both connector powers are wired through Electron and QA", () => {
  for (const cmd of [
    "get_mcp_auto_approve", "set_mcp_auto_approve",
    "get_mcp_outbound_unmask", "set_mcp_outbound_unmask",
    "get_mcp_connector_powers", "set_mcp_connector_power",
  ]) {
    assert.ok(contract.includes(`${cmd}:`), `${cmd} missing from IPC contract`);
    assert.ok(mock.includes(`${cmd}:`), `${cmd} missing from QA mock`);
  }
});

test("each connector states which level is in force", () => {
  assert.match(view, /connectorPowers\[s\.name\]/);
  assert.match(view, /over\.auto_approve \?\? autoApprove/);
  assert.match(view, /over\.outbound_unmask \?\? outboundUnmask/);
  for (const value of ['value="follow"', 'value="on"', 'value="off"']) assert.ok(view.includes(value));
  assert.match(view, /from the setting above/);
  assert.match(view, /set here, so the setting above doesn't apply/);
  assert.match(hook, /value: boolean \| null/);
  assert.match(hook, /mcpSetConnectorPower\(server, power, value\)/);
});

test("the hook's global setters move only their own flag", () => {
  const auto = hook.slice(hook.indexOf("async function setAutoApprove"), hook.indexOf("async function setOutboundUnmask"));
  const unmask = hook.slice(hook.indexOf("async function setOutboundUnmask"), hook.indexOf("async function setConnectorPower"));
  assert.doesNotMatch(auto, /OutboundUnmask/);
  assert.doesNotMatch(unmask, /AutoApprove/);
  assert.match(hook, /useState\(false\);\s*\n\s*const \[outboundUnmask/);
});

test("the page offers two switches with distinct consequences", () => {
  const rowAt = view.indexOf('<div className="conn-powers');
  const row = view.slice(rowAt, view.indexOf("</section>", rowAt));
  const cards = row.split("<PowerCard").slice(1);
  assert.equal(cards.length, 2);
  const auto = cards.find((p) => /on=\{autoApprove\}/.test(p)) ?? "";
  const unmask = cards.find((p) => /on=\{outboundUnmask\}/.test(p)) ?? "";
  assert.match(auto, /without asking/i);
  assert.doesNotMatch(auto, /real values/i);
  assert.match(unmask, /real values/i);
});
