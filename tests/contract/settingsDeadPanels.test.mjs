/* Settings must not carry screens nobody can open, and must ask before it
 * destroys a credential.
 *
 * Audit #230: `src/settings/McpSection.tsx` was a complete, styled "add a
 * connector by hand" panel that nothing imported — connectors moved to their
 * own rail area in 0.13.0. The UA checklist (§"Connectors (MCP) — NOT in
 * Settings") now says finding one in Settings IS a failure, so the orphaned
 * component contradicted the test surface it was supposed to be tested by.
 *
 * Audit #362: "Disconnect" deleted the OpenRouter key from the Keychain and
 * switched the room back to the local model on the FIRST click, while every
 * other destructive button on that screen asked first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("no unreachable connector panel is left in the Settings folder", () => {
  assert.equal(
    existsSync(join(root, "apps/desktop/src/renderer/settings/McpSection.tsx")),
    false,
    "McpSection.tsx is back — Settings has no connector page (see UA checklist §Connectors)",
  );
  // …and nothing imports it, which is what made it invisible in the first place.
  const hits = readdirSync(join(root, "apps/desktop/src/renderer/settings"))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => read(`apps/desktop/src/renderer/settings/${f}`).includes("McpSection"));
  assert.deepEqual(hits, [], `McpSection is referenced by ${hits.join(", ")}`);
});

test("the checklist still calls a connector page in Settings a failure", () => {
  // The removal only stays honest while the manual test surface agrees.
  const checklist = read("tests/manual/UA-FEATURE-CHECKLIST.md");
  assert.match(checklist, /Settings has \*\*no\*\* connector page at all/);
});

test("disconnecting a cloud provider asks before wiping the key", () => {
  const src = read("apps/desktop/src/renderer/settings/AiProvidersSection.tsx");
  const body = /async function disconnect\(\) \{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? "";
  assert.ok(body, "disconnect() not found");
  assert.match(body, /askConfirm\(/, "Disconnect still deletes the key on the first click");
  assert.match(body, /if \(!ok\) return;/, "the confirmation's answer is not honoured");
  // The confirmation has to name the real consequence, not just "are you sure".
  assert.match(body, /Keychain/, "the prompt does not say the key is deleted from the Keychain");
});
