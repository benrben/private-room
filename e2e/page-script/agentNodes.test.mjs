/* The agent diagram's roster model — what a turn's nodes are, live and after.
 *
 * Runs under `npm run test:page` (node --test) next to the address-bar tests,
 * and exercises the REAL `src/workspace/agentNodes.ts`: the source is
 * type-stripped with the `typescript` dev dependency and imported from memory,
 * so there is no compiled output to keep in sync. (AgentGraph.tsx itself
 * imports React, which plain Node cannot resolve — that is why the rules worth
 * pinning live in their own module.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../src/workspace/agentNodes.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { toNodes, toBands, MAIN_KEY } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

/** The shape the sidecar emits at the END of a delegated turn: every child
 *  terminal, and the hub re-marked active because it resumed to compose the
 *  answer. No terminal "everything is done" roster ever follows it. */
const finishedDelegatedTurn = [
  {
    agent: "files.read",
    label: "Files",
    instruction: "find the contract",
    status: "done",
    batch: 0,
    key: "files.read#0",
  },
  {
    agent: "chat.web",
    label: "Web",
    instruction: "check the filing date",
    status: "done",
    batch: 0,
    key: "chat.web#1",
  },
  {
    agent: "chat.answer",
    label: "Main agent",
    instruction: "answer the user from the specialists' reports",
    status: "running",
    batch: null,
    key: MAIN_KEY,
  },
];

test("a live turn draws the roster exactly as sent", () => {
  const nodes = toNodes(finishedDelegatedTurn, null, true);
  assert.deepEqual(
    nodes.map((n) => n.status),
    ["done", "done", "running"],
  );
});

test("an archived turn never leaves the Main agent spinning", () => {
  // The bug: `live={false}` only stopped the clock, so every finished
  // delegated answer kept a perpetually animating hub next to a header that
  // already said "2/2 done".
  const nodes = toNodes(finishedDelegatedTurn, null, false);
  assert.equal(nodes[nodes.length - 1].status, "done");
  assert.equal(
    nodes.some((n) => n.status === "running"),
    false,
  );
});

test("an archived child caught mid-flight did not finish, and does not claim to", () => {
  // Stop pressed while a child was still working: the sidecar marks that child
  // failed but the run is torn down before it can emit, so the last snapshot
  // the UI holds still says "running". Calling that "done" would claim a
  // report that was never made.
  const stopped = [
    { ...finishedDelegatedTurn[0], status: "running" },
    finishedDelegatedTurn[1],
    finishedDelegatedTurn[2],
  ];
  const nodes = toNodes(stopped, null, false);
  assert.equal(nodes[0].status, "failed");
  assert.equal(nodes[2].status, "done");
});

test("pending and failed survive the archive untouched", () => {
  const roster = [
    { ...finishedDelegatedTurn[0], status: "failed" },
    { ...finishedDelegatedTurn[1], status: "pending" },
    finishedDelegatedTurn[2],
  ];
  const nodes = toNodes(roster, null, false);
  assert.deepEqual(
    nodes.map((n) => n.status),
    ["failed", "pending", "done"],
  );
});

test("a roster with no statuses still reads truthfully from the active marker", () => {
  // A frontend newer than the bundled sidecar gets no per-entry status.
  const bare = finishedDelegatedTurn.map(({ status: _s, ...rest }) => rest);
  const nodes = toNodes(bare, { step: 2, active_steps: [2] }, true);
  assert.deepEqual(
    nodes.map((n) => n.status),
    ["done", "running", "pending"],
  );
});

test("keys fall back to agent#index, and the hub is always MAIN_KEY", () => {
  const bare = finishedDelegatedTurn.map(({ key: _k, ...rest }) => rest);
  assert.deepEqual(
    toNodes(bare, null, true).map((n) => n.key),
    ["files.read#0", "chat.web#1", MAIN_KEY],
  );
});

test("consecutive children sharing a batch band together", () => {
  const children = toNodes(finishedDelegatedTurn, null, true).slice(0, -1);
  assert.deepEqual(toBands(children).map((b) => b.length), [2]);
  const twoRounds = toBands([
    { ...children[0], batch: 0 },
    { ...children[1], batch: 1 },
  ]);
  assert.deepEqual(twoRounds.map((b) => b.length), [1, 1]);
});
