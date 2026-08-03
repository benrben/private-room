/* THE DRIFT TEST for command reachability.
 *
 * A `#[tauri::command]` that is not named in `generate_handler!` compiles, runs
 * every unit test it has, and is unreachable from the app. That is the exact
 * shape a lost edit takes in this codebase: the handler function survives in
 * its own file with its tests passing, and the one line that made it reachable
 * — a single entry in a 240-line list in `lib.rs`, the file every packet edits
 * — is gone. Nothing else notices. `cargo test` is green, `tsc` is clean, and
 * the feature is simply not there.
 *
 * `check-mock-coverage.mjs` compares REGISTERED against invoked and mocked, so
 * it sees a command the frontend calls but Rust does not register. It cannot
 * see the reverse, because it never reads the command definitions at all. This
 * test closes that direction: DEFINED against REGISTERED.
 *
 * Written after the 2026-08-03 wave, in which a `git stash` reverted the whole
 * shared working tree mid-session and four files were hand-merged back. Nothing
 * turned out to be missing, but the only way to establish that was to re-derive
 * every packet's wiring by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const SRC = path.join(root, "src-tauri/src");

/* Commands that are deliberately not reachable from the app yet. An entry here
 * is a claim that someone chose this, so each one carries its reason and the
 * list is asserted to be exact — a name that becomes registered has to be
 * removed from it, and the test says so rather than quietly passing.
 *
 * Empty as of the runtime-provisioning wiring (audit 80 + 228): the two
 * `mcp_*_runtime` commands that lived here were a complete, unit-tested feature
 * that nothing declared, so a connector needing `uvx`/`npx` on a Mac without
 * them just failed. They are registered now, and the download lands on a PATH
 * the connector launcher actually reads. */
const KNOWN_UNREGISTERED = new Set([]);

/** Every name inside `generate_handler![...]`, by bracket matching. */
export function registeredCommands(libRs) {
  const at = libRs.indexOf("generate_handler!");
  assert.notEqual(at, -1, "generate_handler! is gone from lib.rs");
  const open = libRs.indexOf("[", at);
  let depth = 0;
  let body = "";
  for (let i = open; i < libRs.length; i++) {
    if (libRs[i] === "[") depth++;
    else if (libRs[i] === "]" && --depth === 0) {
      body = libRs.slice(open + 1, i);
      break;
    }
  }
  assert.notEqual(body, "", "unterminated generate_handler! list");
  // Comments first: the list is annotated, and a commented-out registration is
  // an UNregistered command, not a registered one.
  return new Set(
    [...body.replace(/\/\/[^\n]*/g, "").matchAll(/(?:\w+::)*(\w+)\s*(?:,|$)/gm)].map((m) => m[1]),
  );
}

/** Every `#[tauri::command]` fn in the crate, name → file it lives in. */
export function definedCommands(dir, into = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) definedCommands(p, into);
    else if (entry.name.endsWith(".rs")) {
      const text = fs.readFileSync(p, "utf8");
      // Further attributes may sit between the marker and the fn — several
      // commands carry `#[allow(clippy::too_many_arguments)]`. Skipping them is
      // load-bearing: without it those commands read as unregistered-but-listed
      // and the whole comparison inverts.
      for (const m of text.matchAll(
        /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g,
      )) {
        into.set(m[1], path.relative(root, p));
      }
    }
  }
  return into;
}

test("every Tauri command the crate defines is reachable from the app", () => {
  const registered = registeredCommands(fs.readFileSync(path.join(SRC, "lib.rs"), "utf8"));
  const defined = definedCommands(SRC);

  // Sanity: if either side collapses, the comparison below is vacuous and would
  // pass while proving nothing. This is the failure mode a drift test dies of.
  assert.ok(defined.size > 200, `only ${defined.size} commands found — the scan broke`);
  assert.ok(registered.size > 200, `only ${registered.size} registered — the parse broke`);

  const orphans = [...defined.keys()].filter((n) => !registered.has(n)).sort();
  const unexpected = orphans.filter((n) => !KNOWN_UNREGISTERED.has(n));
  assert.deepEqual(
    unexpected,
    [],
    `defined but never registered — the app cannot call ${unexpected
      .map((n) => `${n} (${defined.get(n)})`)
      .join(", ")}`,
  );

  // And the allow-list stays honest: once one of these is wired up, it must
  // leave the list. A stale exemption is how a guard rots into a comment.
  const stale = [...KNOWN_UNREGISTERED].filter((n) => registered.has(n)).sort();
  assert.deepEqual(stale, [], `now registered, so remove from KNOWN_UNREGISTERED: ${stale}`);
});

test("nothing is registered that the crate does not define", () => {
  // The other direction. `generate_handler!` naming a function that no longer
  // exists does not compile, so this cannot fail in a build — but the parser
  // above is what the first test trusts, and this pins that it is reading real
  // names rather than, say, matching the `commands` path segment or a comment.
  const registered = registeredCommands(fs.readFileSync(path.join(SRC, "lib.rs"), "utf8"));
  const defined = definedCommands(SRC);
  const phantom = [...registered].filter((n) => !defined.has(n)).sort();
  assert.deepEqual(phantom, [], `registered but not defined anywhere: ${phantom}`);
});
