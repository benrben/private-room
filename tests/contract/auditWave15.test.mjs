/* Source guards for the fixes in packet p15. Each one pins the exact thing that
 * was wrong, so a revert fails here rather than in live QA.
 *
 * These are source-shape assertions, the same style as deleteConsent.test.mjs:
 * the components are not renderable under node:test, but every claim below is
 * about a decision that lives in one identifiable line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "../../", p), "utf8");

/* ---------------------------------------------------------------- locality */

test("every trust surface asks about the ROUTE, not just the model name", () => {
  const markup = read("apps/desktop/src/renderer/workspace/markup.ts");
  assert.ok(
    /export function isCloudRoute\(/.test(markup),
    "isCloudRoute is gone — the model name is back to being the whole answer",
  );
  assert.ok(
    /remoteRelay/.test(markup),
    "isCloudRoute no longer reads the host's relay fact",
  );
  // The surfaces that tell the user where their content goes. `isCloudEngine`
  // (name-only) must not be what any of them calls: with Settings → the Closet
  // pointing at another computer, `qwen3.5:4b` is a LAN model and the chip said
  // "Local only — nothing leaves the device".
  for (const f of [
    "apps/desktop/src/renderer/Workspace.tsx", // status-bar trust chip
    "apps/desktop/src/renderer/workspace/TopBar.tsx", // top-bar engine badge
    "apps/desktop/src/renderer/workspace/AiPane.tsx",
    "apps/desktop/src/renderer/workspace/ChatPane.tsx",
    "apps/desktop/src/renderer/workspace/FrontPage.tsx",
  ]) {
    const src = read(f);
    assert.ok(/isCloudRoute\(/.test(src), `${f} does not use isCloudRoute`);
    assert.ok(
      !/\bisCloudEngine\(\s*s?\.?model/.test(src),
      `${f} still decides "is this cloud?" from the model name alone`,
    );
  }
  assert.ok(
    /remoteRelay: boolean/.test(read("apps/desktop/src/shared/apiTypes.ts")),
    "AiStatus lost remoteRelay, so the UI has no way to learn about the relay",
  );
  // The Closet's own panel said the opposite, in so many words.
  const closet = read("apps/desktop/src/renderer/settings/RemoteAiSection.tsx");
  assert.ok(
    !/never leave this Mac/.test(closet),
    "the Remote AI panel still promises the files never leave this Mac",
  );
  assert.ok(
    /no longer local/.test(closet),
    "the Remote AI panel does not say what setting it actually does",
  );
});

/* ------------------------------------------------ destructive acts ask first */

test("deleting a checkpoint asks first, like rolling back does", () => {
  const src = read("apps/desktop/src/renderer/settings/CheckpointsSection.tsx");
  assert.ok(
    /setConfirmDelete\(c\.id\)/.test(src),
    "the Delete button fires straight into deleteCheckpoint again",
  );
  assert.ok(
    /confirmDelete === c\.id \? \(/.test(src),
    "there is no armed question for a delete",
  );
  assert.ok(
    /does not go to the Trash/.test(src),
    "the question no longer says the copy is gone for good",
  );
});

test("the browser journal's Clear asks before erasing the record", () => {
  const src = read("apps/desktop/src/renderer/workspace/BrowserView.tsx");
  assert.ok(/confirmClear/.test(src), "Clear is a one-click erase again");
  assert.ok(
    /setConfirmClear\(true\)/.test(src),
    "the Clear button no longer arms a question",
  );
});

/* ------------------------------------------------------- persona save honesty */

test("picking a persona is only shown as done once the write came back", () => {
  const src = read("apps/desktop/src/renderer/settings/useRoles.ts");
  assert.ok(
    /listRoles\(\)/.test(src) && !/invoke</.test(src),
    "useRoles talks to the backend by hand again instead of the typed wrapper",
  );
  assert.ok(
    /setRole\(previous\)/.test(src),
    "a failed save no longer puts the previous stance back",
  );
  assert.ok(/roleError/.test(src), "a failed save says nothing to the user");
  assert.ok(
    /roleError/.test(read("apps/desktop/src/renderer/settings/RoleSection.tsx")),
    "the picker has nowhere to show a failed save",
  );
});

test("RoomRole and RecommendedModels are declared once", () => {
  const types = read("apps/desktop/src/renderer/settings/types.ts");
  assert.ok(
    !/export interface RoomRole/.test(types),
    "settings/types.ts spells RoomRole out again beside the api.ts copy",
  );
  assert.ok(
    !/export interface RecommendedModels/.test(types),
    "settings/types.ts spells RecommendedModels out again",
  );
  assert.ok(/RoomRole,/.test(types), "settings/types.ts no longer re-exports RoomRole");
});

test("the checkpoints screen has no second copy of the date formatter", () => {
  const src = read("apps/desktop/src/renderer/settings/CheckpointsSection.tsx");
  assert.ok(
    !/function formatWhen\(/.test(src),
    "the near-identical private formatWhen is back",
  );
  assert.ok(
    /from "\.\.\/workspace\/composer"/.test(src),
    "it no longer reads the shared formatter",
  );
  // …but the legacy zone-less timestamps in manifests already on disk must
  // still be repaired, or they render in the wrong hour.
  assert.ok(/function asIso\(/.test(src), "pre-ISO checkpoint times are unhandled");
});

/* ------------------------------------------------------------ cloud privacy */

test("a room can hand its cloud-privacy choice back to the app default", () => {
  const src = read("apps/desktop/src/renderer/settings/CloudPrivacySection.tsx");
  assert.ok(
    /setPrivacyRoom\("default"\)/.test(src),
    "nothing offers the backend's own 'default' mode, so the switch is one-way",
  );
  assert.ok(
    /Follow the app default instead/.test(src),
    "there is no control to reach it",
  );
});

test("Escape in the private-topics box does not close Settings", () => {
  const src = read("apps/desktop/src/renderer/settings/CloudPrivacySection.tsx");
  const box = src.slice(src.indexOf("cpv-concepts"));
  assert.ok(
    /e\.key === "Escape"/.test(box) && /stopPropagation/.test(box),
    "that box only saves on blur, so Escape throws the typing away",
  );
});

/* ------------------------------------------------- connector runtime download */

test("the runtime download is wired end to end, not just written", () => {
  const host = read("apps/desktop/src/main/runtimesCmds.ts");
  for (const cmd of ["mcp_runtime_for_command", "mcp_provision_runtime"]) {
    assert.ok(host.includes(`handle("${cmd}"`), `${cmd} is not in the IPC handler`);
  }
  assert.ok(
    /refreshPathPrefix/.test(host),
    "nothing publishes the downloaded-runtime PATH at startup",
  );
  // Without this the download lands in a folder no connector ever looks in.
  assert.ok(
    /cachedPathPrefix/.test(read("apps/desktop/src/main/mcpClient.ts")),
    "the connector launcher does not put the downloaded runtimes on PATH",
  );
  const mkt = read("apps/desktop/src/renderer/settings/McpMarketplace.tsx");
  assert.ok(/mcpRuntimeForCommand/.test(mkt), "the install drawer never asks");
  assert.ok(/mcpProvisionRuntime/.test(mkt), "the install drawer offers no download");
  // Empty must read as empty: an unanswered probe shows nothing, not "ready".
  assert.ok(
    /runtime && !runtime\.available/.test(mkt),
    "the prompt no longer branches on a real answer",
  );
});
