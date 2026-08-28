/* Can a running AI action be stopped?
 *
 * Summarize, Analyze, Translate, Research and Fact-check run for minutes on a
 * local model over a whole room. They had no Stop: the modal's Cancel went grey
 * for the duration, clicking outside did nothing, and Escape was deliberately
 * ignored while running — so the only way out was to wait. A Studio build, the
 * same shape of work started from the same shelf, has had Stop and Resume all
 * along.
 *
 * Stop only works if the WHOLE chain is present, and each link lives in a
 * different file, which is why this is asserted as a chain: the modal's button
 * → `stopAiAction` → `cancelAsk(opId)` → the same id `api.aiAction` sent → the
 * host command that registers a cancel flag under it. Any missing link leaves a
 * button that does nothing, which is worse than no button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const modal = read("apps/desktop/src/renderer/workspace/AiActionModal.tsx");
const actions = read("apps/desktop/src/renderer/workspace/studioActions.ts");
const api = read("apps/desktop/src/renderer/api.ts");
const host = read("apps/desktop/src/main/moonshotAiActions.ts");

test("the AI action modal offers Stop while it is running", () => {
  assert.match(modal, /a\.stopAiAction\(\)/, "no Stop control in the modal");
  // And it must be reachable: a disabled-while-running button is the bug.
  const stopButton = modal.match(/disabled=\{s\.aiStopping[^}]*\}/);
  assert.ok(stopButton, "Stop is not gated on the stopping state alone");
  assert.doesNotMatch(
    stopButton[0],
    /\brunning\b/,
    "Stop must not be disabled by the very state it exists to end",
  );
});

test("Stop reaches the host through the id the run was started with", () => {
  // One id, minted once, used for both calls — two ids would cancel nothing.
  assert.match(actions, /const opId = /, "the run has no cancel id");
  assert.match(actions, /opId,\n\s*\}\);/, "the id is not sent with the run");
  assert.match(
    actions,
    /function stopAiAction[\s\S]*?api\.cancelAsk\(opId\)/,
    "Stop does not cancel the run's own id",
  );
  // A Stop that did not land must not read as one that did.
  assert.match(
    actions,
    /function stopAiAction[\s\S]*?catch[\s\S]*?pushToast\("error"/,
    "a failed Stop is swallowed",
  );
  assert.match(api, /opId: opts\.opId \?\? null/, "invoke drops the id");
});

test("the host registers the run under that id and refuses to save a stopped one", () => {
  assert.match(host, /opId: string \| null/, "the command takes no cancel id");
  assert.match(
    host,
    /registerAiActionCancel\(deps\.cancelState, opId/,
    "the flag is never put in the registry the Stop button reaches",
  );
  assert.match(
    host,
    /post\("\/ai_action", body, cancel\)/,
    "the model call cannot be abandoned",
  );
  // The whole point: a stopped run writes nothing into the room.
  assert.match(host, /guardCommit\(cancel,/, "a stopped run could still save its file");
});
