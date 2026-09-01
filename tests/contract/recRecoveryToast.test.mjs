/* THE CRASH-RECOVERY FAILURE REACHES THE USER EXACTLY ONCE.
 *
 * "Audio from an interrupted recording could not be restored" is delivered on
 * TWO paths on purpose (rooms.rs): it is PARKED for whichever workspace mounts
 * next, and it is emitted on `rec-error` two seconds later for a workspace that
 * is already up. The host used to decide between them by TAKING the park inside
 * the emit — which made the emit the last consumer, so a workspace that mounted
 * a moment after the timer collected nothing and the failure was silent, the
 * very thing the message exists to report. The host now peeks and emits a copy,
 * so both copies can arrive and the workspace is what makes them one toast.
 *
 * That de-duplication is five lines inside the mount-once workspace
 * subscriptions, which close over React state and cannot be imported. So it is
 * SLICED out of the shipped source and driven here against a fake workspace —
 * the same technique unsavedGuard/contextualNav use. Nothing below re-implements it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SUBSCRIPTIONS = readFileSync(
  join(root, "apps/desktop/src/renderer/workspace/workspaceSubscriptions.ts"),
  "utf8",
);

/** The recovery-delivery region: the de-duplicator, the `rec-error` listener
 * that routes through it, and the mount-time collection of the parked copy. */
function recoveryRegion() {
  const at = SUBSCRIPTIONS.indexOf("    const shownRecovery = new Set<string>();");
  assert.notEqual(at, -1, "the recovery de-duplicator is gone from workspaceSubscriptions.ts");
  const take = SUBSCRIPTIONS.indexOf(".takeRecRecoveryError()", at);
  assert.notEqual(take, -1, "the mount-time collect no longer follows it");
  const end = SUBSCRIPTIONS.indexOf(".catch(() => {});", take);
  assert.notEqual(end, -1, "the collect's tail moved — this slice is stale");
  return SUBSCRIPTIONS.slice(at, end + ".catch(() => {});".length);
}

const MODULE = [
  "export function wireRecovery(s, api) {",
  recoveryRegion(),
  "  return unlistenRecError;",
  "}",
].join("\n");

const JS = ts.transpileModule(MODULE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { wireRecovery } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

const RECOVERY =
  "Audio from an interrupted recording could not be restored: disk full " +
  "Nothing was lost — it is still stored in the room.";

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A workspace that records its toasts, plus the two api seams this region
 * touches. `parked` is what `take_rec_recovery_error` answers on mount; the
 * returned `emit` plays the host's 2-second `rec-error`. */
function wire(parked) {
  const toasts = [];
  let onError = () => {};
  const s = { pushToast: (kind, message) => toasts.push([kind, message]) };
  const api = {
    onRecError: (cb) => {
      onError = cb;
      return Promise.resolve(() => {});
    },
    // A Tauri command costs a real round trip — never resolved within the same
    // microtask, or the order this test cares about could not happen at all.
    takeRecRecoveryError: async () => {
      await new Promise((r) => setTimeout(r, 0));
      return parked;
    },
  };
  wireRecovery(s, api);
  return { toasts, emit: (p) => onError(p) };
}

test("the parked copy and the emitted copy are one toast, park first", async () => {
  const w = wire(RECOVERY);
  await settle();
  await settle();
  assert.deepEqual(w.toasts, [["error", RECOVERY]], "the mount collect shows it");
  // The host's fallback emit lands afterwards carrying the same news.
  w.emit({ fileId: "", message: RECOVERY });
  assert.equal(w.toasts.length, 1, `told twice: ${JSON.stringify(w.toasts)}`);
});

test("the parked copy and the emitted copy are one toast, emit first", async () => {
  const w = wire(RECOVERY);
  // The 2 s timer wins the race with the mount's collect.
  w.emit({ fileId: "", message: RECOVERY });
  assert.deepEqual(w.toasts, [["error", RECOVERY]]);
  await settle();
  await settle();
  assert.equal(w.toasts.length, 1, `told twice: ${JSON.stringify(w.toasts)}`);
});

test("a recording's own error is never folded into the recovery message", async () => {
  const w = wire(null);
  await settle();
  await settle();
  // Two lanes of one recording can fail the same way. Both belong on screen:
  // they name a file, and swallowing the second would hide a real outage.
  w.emit({ fileId: "rec-1", message: "The microphone stopped responding." });
  w.emit({ fileId: "rec-1", message: "The microphone stopped responding." });
  assert.equal(w.toasts.length, 2, "an ordinary rec-error must not be deduped");
});

test("a second, different recovery failure still reaches the user", async () => {
  const w = wire(null);
  await settle();
  await settle();
  w.emit({ fileId: "", message: RECOVERY });
  w.emit({ fileId: "", message: "Audio from an interrupted recording could not be restored: no space" });
  assert.equal(w.toasts.length, 2);
});

test("nothing parked and nothing emitted says nothing at all", async () => {
  const w = wire(null);
  await settle();
  await settle();
  assert.deepEqual(w.toasts, [], "the ordinary unlock must be silent");
});
