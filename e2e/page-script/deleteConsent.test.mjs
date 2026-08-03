/* Audit #505: the agent could delete a connector — and its saved OAuth token —
 * with nothing asking first, reachable from any document the agent READ.
 *
 * The backend now emits a consent card carrying `confirm` (mcp_cmds.rs
 * `destructive_request`, unit-tested there). This is the other half: the
 * frontend has to render THAT card rather than the tool-call one, and must not
 * offer standing consent for a deletion — "Always allow this connector" would
 * hand the agent a blanket permission to destroy the room's configuration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "../../", p), "utf8");

const OVERLAYS = read("src/workspace/Overlays.tsx");

test("a deletion request gets its own card, not the tool-call card", () => {
  assert.ok(
    /pendingApproval\?\.confirm/.test(OVERLAYS),
    "no branch on `confirm` — a deletion would render as 'Allow a connected tool to run?'",
  );
  assert.ok(
    /pendingApproval && !pendingApproval\.confirm/.test(OVERLAYS),
    "the tool-call card no longer excludes deletions, so both would render at once",
  );
});

test("the deletion card never offers standing consent", () => {
  // Slice out the destructive branch and check what it can answer with.
  const start = OVERLAYS.indexOf("pendingApproval?.confirm");
  const end = OVERLAYS.indexOf("pendingApproval && !pendingApproval.confirm");
  assert.ok(start > 0 && end > start, "could not locate the deletion card");
  const card = OVERLAYS.slice(start, end);
  assert.ok(!/"always"/.test(card), "the deletion card offers 'always' — there is no undo");
  assert.ok(/"deny"/.test(card), "the deletion card has no way to say no");
  assert.ok(/"once"/.test(card), "the deletion card has no way to say yes");
});

test("every agent-facing delete that cannot be undone is gated", () => {
  // #505 named three: connectors, skills and workflows. Gating only the
  // connector left the other two exactly as the finding described them — one
  // sentence in a document the agent read, and the thing is gone.
  const gated = [
    ["src-tauri/src/commands/mcp_cmds.rs", "agent_delete_mcp"],
    ["src-tauri/src/commands/skills.rs", "agent_delete_skill"],
    ["src-tauri/src/commands/jobs/workflow.rs", "agent_delete_workflow"],
  ];
  for (const [file, fn] of gated) {
    const src = read(file);
    const at = src.indexOf(`async fn ${fn}(`);
    assert.ok(at > 0, `${fn} is not async — it cannot await a consent card`);
    // The body up to the next top-level `pub(crate)` item.
    const body = src.slice(at, src.indexOf("\npub(crate)", at + 10));
    assert.ok(
      /confirm_destructive\(/.test(body),
      `${fn} deletes without asking — there is no trash for what it removes`,
    );
    assert.ok(
      /DELETE_DECLINED/.test(body),
      `${fn} does not tell the model the user said no`,
    );
  }
});

test("the request type carries the deletion marker", () => {
  const types = read("src/apiTypes.ts");
  assert.ok(
    /McpApproveRequest[\s\S]{0,600}confirm\?: string/.test(types),
    "McpApproveRequest lost its `confirm` field",
  );
});
