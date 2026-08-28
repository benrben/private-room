/* Six things Settings did with state it had not actually read.
 *
 * Disconnecting OpenRouter wrote back whatever Ollama happened to list first —
 * or, with Ollama down, the very model being disconnected. The advisors switch
 * was gated on `ai.external`, which carries "openrouter" and therefore offered
 * a capability with no CLI to run it. A backdrop click with unsaved work left
 * focus on <body>, outside the focus trap. Two independent post-password
 * warnings shared one string slot, so the revoked recovery key went unsaid. The
 * Leash's saved access level was only read back while it was running, so an
 * off/on cycle downgraded "Full agent" to "Files only". And the marketplace's
 * install drawer promised redaction and a second ask that either connector
 * power can make false.
 *
 * Source-level on purpose: every one of these is about WHERE a value comes
 * from, and nothing in the tree renders the Settings modal. Same tactic as
 * settingsPages.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const settings = read("apps/desktop/src/renderer/Settings.tsx");
const advisors = read("apps/desktop/src/renderer/settings/AdvisorsSection.tsx");
const trap = read("apps/desktop/src/renderer/settings/useFocusTrap.ts");
const privacyHook = read("apps/desktop/src/renderer/settings/usePrivacy.ts");
const leashHook = read("apps/desktop/src/renderer/settings/useRoomServer.ts");
const marketplace = read("apps/desktop/src/renderer/settings/McpMarketplace.tsx");

test("disconnecting OpenRouter falls back to a model that can hold a chat", () => {
  // The old expression took Ollama's raw /api/tags order (which can lead with
  // nomic-embed-text, installed for semantic search and a 400 on /api/chat),
  // then `ai.defaultModel` — the room's SAVED model, i.e. the openrouter:: one
  // being disconnected — so the dialog's promise was not kept.
  assert.match(
    settings,
    /fallbackModel=\{\s*bestLocalModel\(/,
    "the OpenRouter fallback is not asked in the host's preference order",
  );
  assert.doesNotMatch(
    settings,
    /fallbackModel=\{[\s\S]{0,200}ai\?\.defaultModel/,
    "the fallback can still be the model being disconnected",
  );
  assert.doesNotMatch(
    settings,
    /endsWith\(":cloud"\)/,
    "the `<size>-cloud` relay tags isRelayedModel covers are back in scope",
  );
});

test("AI advisors are offered only for CLIs that can actually run one", () => {
  // `consult_advisor` is built from `detected_advisors`, which is the CLI probe
  // cache; `ai_status` appends "openrouter" to `external` for the model picker.
  assert.match(
    advisors,
    /filter\(\(e\) => e !== "openrouter"\)/,
    "an OpenRouter key still turns the advisors switch on",
  );
  assert.doesNotMatch(
    advisors,
    /ai\.external\.length > 0/,
    "the switch is still gated on the raw external list",
  );
});

test("a backdrop click that only asks puts focus back inside the trap", () => {
  assert.match(trap, /function refocusModal\(\)/);
  assert.match(trap, /return \{ modalRef, onModalKeyDown, refocusModal \}/);
  // …and it is called, from the one click that can leave the modal open with
  // focus on <body>. A trap helper nothing calls is not a trap.
  assert.match(settings, /if \(unsavedRef\.current\) refocusModal\(\)/);
});

test("both post-password-change warnings survive", () => {
  // The recovery-key revocation and the stranded checkpoints are independent
  // facts; the second used to overwrite the first before either was painted.
  const pushes = privacyHook.match(/warnings\.push\(/g) ?? [];
  assert.equal(pushes.length, 2, "the two warnings do not share an accumulator");
  assert.match(privacyHook, /setPwError\(warnings\.join\(" "\)\)/);
});

test("a stopped Leash still knows its saved access level", () => {
  // room_server_status_snapshot's stopped arm answers with the struct default
  // ("files"), not this room's saved answer — so the switch restarted at the
  // files tier and persisted it over "full", killing the pasted config.
  assert.match(leashHook, /getSetting\("room_server_scope"\)/);
  assert.match(leashHook, /saved === "full"/);
});

test("the install drawer's cloud note reads off the live connector powers", () => {
  assert.match(marketplace, /getMcpAutoApprove\(\)/);
  assert.match(marketplace, /getMcpOutboundUnmask\(\)/);
  assert.doesNotMatch(
    marketplace,
    /redacts sensitive spans first and asks again/,
    "the drawer still promises what either switch can make false",
  );
});
