/* Can the command-drift gate still fire?
 *
 * `qa/check-mock-coverage.mjs` is a build gate (preflight runs it), and its
 * newest rule — "the host registers a command NOTHING reaches" — is the kind
 * that goes quiet without anyone noticing: it answers reachability by looking
 * up which api.ts wrapper an `invoke("…")` sits under, and any sloppiness in
 * that lookup turns the rule into a pass-everything. It shipped attributing
 * `startStudioJob` to `kind` and `recStart` to `systemAudio` — the last field
 * of their multi-line options object — and since `kind` occurs all over src/,
 * 21 commands were permanently "reached" whatever the app did.
 *
 * So the checker is run here against a TINY TREE built on the spot, whose one
 * unreached command is known by construction. `MOCK_COVERAGE_ROOT` exists for
 * this. Nothing in the real repo is read, and nothing here asserts about this
 * file's own text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(here, "../../qa/check-mock-coverage.mjs");

/** A four-command host: one plain wrapper, one whose invoke sits under a
 *  multi-line options object, one only the agent calls, one nothing calls. */
const HANDLERS = ["list_things", "start_thing_job", "agent_only_thing", "forgotten_thing"];

const API_TS = `import { invoke } from "@tauri-apps/api/core";

export const api = {
  listThings: () => invoke<string[]>("list_things"),
  startThingJob: (opts: {
    scope?: string;
    kind: "podcast" | "mindmap";
  }) => invoke<string>("start_thing_job", opts),
  agentOnlyThing: () => invoke<void>("agent_only_thing"),
  forgottenThing: () => invoke<void>("forgotten_thing"),
};
`;

function writeTree(dir, screenBody) {
  const w = (rel, text) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w(
    "src-tauri/src/lib.rs",
    `fn main() {\n  tauri::generate_handler![\n${HANDLERS.map((h) => `    commands::${h},`).join("\n")}\n  ];\n}\n`,
  );
  w("src-tauri/src/room_mcp.rs", "// no tools here\n");
  w("src-tauri/src/commands/agent.rs", 'const TOOLS: &[&str] = &["agent_only_thing"];\n');
  w(
    "qa/qa-mock.js",
    `const commands = {\n    list_things: () => [],\n};\nconst EXTRA_READS = new Set(["list_things"]);\n`,
  );
  w("src/api.ts", API_TS);
  w("src/Screen.tsx", screenBody);
}

function run(screenBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-coverage-"));
  try {
    writeTree(dir, screenBody);
    const r = spawnSync(process.execPath, [CHECKER], {
      encoding: "utf8",
      env: { ...process.env, MOCK_COVERAGE_ROOT: dir },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Both wrappers called: only the command nobody calls is reported.
const CALLED = `import { api } from "./api";

export function Screen() {
  void api.listThings();
  void api.startThingJob({ kind: "podcast" });
}
`;

// startThingJob's last caller deleted. The word "kind" stays behind, exactly as
// it would in a real screen — that word is what the broken attribution latched
// onto, so this is the case that separates a working gate from a silent one.
const DROPPED = `import { api } from "./api";

export function Screen(props: { kind: string }) {
  void api.listThings();
  return props.kind;
}
`;

test("a registered command with no caller fails the build, by name", () => {
  const { code, out } = run(CALLED);
  assert.equal(code, 1, out);
  assert.match(out, /forgotten_thing/);
  // The three that ARE reached must not be dragged in with it: a gate that
  // over-reports is a gate people start ignoring.
  assert.doesNotMatch(out.split("DRIFT")[1] ?? "", /list_things|start_thing_job|agent_only_thing/);
});

test("a wrapper reached only through its options-object field is not reached", () => {
  const { code, out } = run(DROPPED);
  assert.equal(code, 1, out);
  assert.match(out, /start_thing_job/);
});

test("a command the agent's tools name is reached, though no screen invokes it", () => {
  // agent_only_thing is quoted in commands/agent.rs and nowhere in src/.
  const { out } = run(CALLED);
  const drift = out.split("DRIFT")[1] ?? "";
  assert.doesNotMatch(drift, /agent_only_thing/, out);
});

test("no orphan, no failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-coverage-ok-"));
  try {
    writeTree(dir, CALLED);
    // Take the two unreached commands out of the host and the gate goes quiet.
    const lib = path.join(dir, "src-tauri/src/lib.rs");
    fs.writeFileSync(
      lib,
      fs
        .readFileSync(lib, "utf8")
        .split("\n")
        .filter((l) => !/forgotten_thing/.test(l))
        .join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "src/api.ts"),
      API_TS.replace(/\n +forgottenThing:[^\n]*\n/, "\n"),
    );
    const r = spawnSync(process.execPath, [CHECKER], {
      encoding: "utf8",
      env: { ...process.env, MOCK_COVERAGE_ROOT: dir },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /reached by nothing +: 0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
