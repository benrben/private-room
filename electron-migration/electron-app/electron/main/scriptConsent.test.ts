/**
 * Vitest port of `src-tauri/src/commands/scripts.rs`'s `#[cfg(test)] mod
 * tests` (all five, by name), plus the direct coverage the Rust source never
 * had for the SEC-1 property the whole file exists to guarantee — that one
 * lives in the app's end-to-end behavior over there, which is exactly the kind
 * of property that rots silently.
 *
 * THE PROPERTY, asserted three ways rather than inferred from a function name:
 *   1. mechanically — one flipped byte, a different fingerprint, and a
 *      cross-language golden hash proving this really is SHA-256 over RAW
 *      BYTES (the same digest `shasum -a 256` and Rust's `sha2` produce);
 *   2. through the DECISION — `stampScriptConsents` re-reads and re-hashes a
 *      REAL room row, so editing that row makes yesterday's grant stop
 *      covering it;
 *   3. through the COMMAND — `setScriptSchedule` accepts an approved script,
 *      then refuses the very same file id after its bytes change.
 *
 * Plus: the approval store is real disk I/O (read back with `fs`, bypassing
 * this module's own reader), and its location depends on the app's data folder
 * alone — never on which room is open.
 *
 * Ported Rust tests, by name:
 *   - a_finished_script_hands_its_output_back_as_the_answer
 *   - the_agent_gets_what_the_script_printed_not_the_run_record
 *   - the_assistant_is_told_which_files_the_script_created
 *   - wf_matches_only_its_own_script_row
 *   - stamp_script_consents_only_stamps_approved_hashes
 *
 * DEVIATION from the Rust test module: it uses an in-memory `db::mem()`
 * connection; this port uses the established real-fixture-room convention
 * (`createRoom`, as in `db-host/workflows.test.ts`), so the DB half of these
 * tests exercises the same encrypted-room path the app does.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { insertFile, updateFileContent } from "./db-host/files.js";
import { createJob, putJobArtifact } from "./db-host/jobs.js";
import { createRoom } from "./db-host/open.js";
import { createWorkflow, getSchedule, getWorkflow, listWorkflows } from "./db-host/workflows.js";
import {
  addScriptApproval,
  agentListScripts,
  agentRunScript,
  approveScriptBytes,
  approveWorkflowScripts,
  clampScriptOutput,
  createPendingScriptApprovals,
  ensureScriptWorkflow,
  getScriptManifest,
  interpreterLine,
  listScripts,
  parseScriptDecision,
  printedOutput,
  readScriptApprovals,
  resolveScriptFile,
  resolveScriptRun,
  runScript,
  runScriptInner,
  scriptApprovalsFile,
  scriptFingerprint,
  scriptOutput,
  setScriptSchedule,
  stampScriptConsents,
  wfIsForScript,
} from "./scriptConsent.js";

// --------------------------------------------------------------------------
// fixtures — every temp dir and every open handle is cleaned up, so a suite
// run leaves nothing behind in $TMPDIR.
// --------------------------------------------------------------------------

const tmpDirs: string[] = [];
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by a test that needed the file on disk.
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in for the app's own data folder (Electron's `userData`). */
function freshUserDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcelle-script-approvals-"));
  tmpDirs.push(dir);
  return dir;
}

function freshRoomAt(): { db: Database.Database; roomPath: string; roomDir: string } {
  const roomDir = mkdtempSync(path.join(os.tmpdir(), "db-host-scriptconsent-"));
  tmpDirs.push(roomDir);
  const roomPath = path.join(roomDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  openDbs.push(db);
  return { db, roomPath, roomDir };
}

function freshRoom(): Database.Database {
  return freshRoomAt().db;
}

/**
 * Every value stored anywhere in an OPEN room, as one searchable string —
 * every table, every column, BLOBs decoded as latin1 so bytes that spell text
 * are still findable. Used to prove a secret is NOT in the room; searching the
 * encrypted `.roomai` file itself could never prove that.
 */
function roomContents(db: Database.Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string;
  }>;
  const out: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t.name}"`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        out.push(v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v));
      }
    }
  }
  return out.join(" ");
}

function scriptRunDef(file: string): unknown {
  return { version: 1, nodes: [{ id: "run", kind: "script_run", file }], edges: [] };
}

/** The body `clampScriptOutput` wrapped, with its truncation marker removed —
 * so a test can measure exactly what survived the cut. */
function clampedBody(wrapped: string): string {
  const marker = "\n… (output truncated)";
  const prefix = "answer:\n";
  const at = wrapped.indexOf(prefix);
  expect(at).toBeGreaterThan(-1);
  const body = wrapped.slice(at + prefix.length);
  return body.endsWith(marker) ? body.slice(0, -marker.length) : body;
}

// ============================================================================
// SEC-1: the content address itself
// ============================================================================

describe("scriptFingerprint — the content address SEC-1 rests on", () => {
  it("changes when even ONE byte of the script changes", () => {
    const original = Buffer.from("print('hello, room')\n");
    const edited = Buffer.from("print('hello, Room')\n"); // r -> R, one byte
    expect(scriptFingerprint(original)).not.toBe(scriptFingerprint(edited));
    // ...and it is the EDIT that moved it, not nondeterminism.
    expect(scriptFingerprint(Buffer.from("print('hello, room')\n"))).toBe(
      scriptFingerprint(original)
    );
    // Trailing whitespace is content too — no normalization anywhere.
    expect(scriptFingerprint(Buffer.from("print('hi')  "))).not.toBe(
      scriptFingerprint(Buffer.from("print('hi')"))
    );
  });

  it("is REAL SHA-256 over raw bytes — the same digest Rust's sha2 produces", () => {
    // Golden vectors (`shasum -a 256`), so this cannot silently become some
    // other hash, or start hashing a decoded STRING: two different files with
    // the same lossy UTF-8 decoding would then share one approval.
    expect(scriptFingerprint(Buffer.from("print('run me')"))).toBe(
      "c6b665e07d371f6a30e03f945ae1f3599badd0d6667b994c560dd79d86175ef2"
    );
    expect(scriptFingerprint(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    // Bytes that are not valid UTF-8 at all still hash, and hash correctly.
    expect(scriptFingerprint(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toBe(
      "6e153708ea1302ccc480999bda6939c7aef6dd60531b7acfff00e81bde4986ab"
    );
  });
});

// ============================================================================
// SEC-1: the per-Mac approval store
// ============================================================================

describe("the approval store (per-Mac, outside any room)", () => {
  it("lives at <userData>/script_approvals.json, a sibling of mcp_approvals.json", () => {
    const dir = freshUserDataDir();
    expect(scriptApprovalsFile(dir)).toBe(path.join(dir, "script_approvals.json"));
  });

  it("accumulates fingerprints without duplicates", () => {
    const dir = freshUserDataDir();
    expect(readScriptApprovals(dir)).toEqual([]);
    const sha = scriptFingerprint(Buffer.from("print(1)"));
    addScriptApproval(dir, sha);
    addScriptApproval(dir, sha); // idempotent
    expect(readScriptApprovals(dir)).toEqual([sha]);
    addScriptApproval(dir, "another");
    expect(readScriptApprovals(dir)).toEqual([sha, "another"]);
  });

  it("fails closed on a missing, corrupt, or wrong-shaped file", () => {
    const dir = freshUserDataDir();
    expect(readScriptApprovals(dir)).toEqual([]); // absent
    writeFileSync(scriptApprovalsFile(dir), "{ half-written");
    expect(readScriptApprovals(dir)).toEqual([]); // unparseable
    writeFileSync(scriptApprovalsFile(dir), '{"approved":["abc"]}');
    expect(readScriptApprovals(dir)).toEqual([]); // an object, not a list
  });

  it("persists via REAL file I/O — a restart re-reads it, nothing is cached", () => {
    const dir = freshUserDataDir();
    const sha = scriptFingerprint(Buffer.from("#!/usr/bin/env python3\nprint(1)\n"));
    addScriptApproval(dir, sha);
    // Bypass this module's reader entirely: if the grant were held in a
    // module-level Map it would not be here, and it would die with the process.
    const onDisk: unknown = JSON.parse(readFileSync(scriptApprovalsFile(dir), "utf8"));
    expect(onDisk).toEqual([sha]);
    expect(readScriptApprovals(dir)).toEqual([sha]);
  });

  it("an approval for the old bytes never covers the edited ones", () => {
    const dir = freshUserDataDir();
    const before = scriptFingerprint(Buffer.from("# room-inputs: a.csv\nprint('v1')\n"));
    addScriptApproval(dir, before);
    expect(readScriptApprovals(dir)).toContain(before);
    const after = scriptFingerprint(Buffer.from("# room-inputs: a.csv\nprint('v2')\n"));
    expect(after).not.toBe(before);
    expect(readScriptApprovals(dir)).not.toContain(after);
  });

  it("its path depends on the app's data folder alone — never on a room", () => {
    const dir = freshUserDataDir();
    // Two rooms anywhere on disk share one per-Mac store, because the room
    // plays no part in the signature.
    expect(scriptApprovalsFile(dir)).not.toContain("room-a.roomai");
    expect(scriptApprovalsFile(dir)).not.toContain("/Volumes/External");

    const { db, roomPath, roomDir } = freshRoomAt();
    const bytes = Buffer.from("print('secret sauce')");
    const sha = scriptFingerprint(bytes);
    insertFile(db, "s.py", "text/x-python", bytes, "print('secret sauce')", "upload");
    addScriptApproval(dir, sha);
    expect(scriptApprovalsFile(dir).startsWith(roomDir)).toBe(false);
    expect(scriptApprovalsFile(dir)).not.toBe(roomPath);

    // And nothing wrote the grant into the `.roomai` itself — the file a
    // hostile room author hands you must never be able to carry consent.
    //
    // Scanned through the OPEN (decrypted) handle, every table, every column,
    // BLOBs included. Searching the room FILE's bytes for the hex instead
    // would prove nothing at all: SQLCipher encrypts every page, so that
    // assertion reads "absent" whether or not the grant is sitting inside —
    // it cannot fail, and a test that cannot fail is not evidence.
    expect(roomContents(db)).not.toContain(sha);
    // ...and the scan really reached the room's data, so the line above
    // cannot pass by searching an empty string.
    expect(roomContents(db)).toContain("print('secret sauce')");
  });
});

// ============================================================================
// resolveScriptFile — the ONE resolver
// ============================================================================

describe("resolveScriptFile", () => {
  it("takes an exact id first, then falls back to a fuzzy name match", () => {
    const db = freshRoom();
    const bytes = Buffer.from("print('hi')");
    const f = insertFile(db, "word_counter.py", "text/x-python", bytes, "print('hi')", "upload");

    expect(resolveScriptFile(db, f.id)).toEqual({
      id: f.id,
      name: "word_counter.py",
      bytes,
    });
    const byName = resolveScriptFile(db, "word_counter");
    expect(byName.id).toBe(f.id);
    expect(byName.name).toBe("word_counter.py");
  });

  it("always returns the bytes that are there NOW, not the ones at import", () => {
    const db = freshRoom();
    const f = insertFile(db, "s.py", "text/x-python", Buffer.from("print('v1')"), null, "upload");
    updateFileContent(db, f.id, Buffer.from("print('v2')"), "print('v2')");
    expect(resolveScriptFile(db, f.id).bytes.toString()).toBe("print('v2')");
  });

  it("throws a room-scoped error when nothing matches", () => {
    const db = freshRoom();
    expect(() => resolveScriptFile(db, "nope.py")).toThrow(/no file matching/i);
  });
});

// ============================================================================
// wf_matches_only_its_own_script_row
// ============================================================================

describe("wfIsForScript / ensureScriptWorkflow", () => {
  it("wf_matches_only_its_own_script_row (and is idempotent)", () => {
    const db = freshRoom();
    // A user workflow (not a script) never matches.
    const userDef = { version: 1, nodes: [{ id: "g", kind: "generate", prompt: "hi" }], edges: [] };
    createWorkflow(db, "wf", "", "", userDef, "user", { scope: "general" });

    expect(ensureScriptWorkflow(db, "file-1", "a.py")).toBeTruthy();
    const scriptWf = listWorkflows(db).find((w) => w.createdBy === "script");
    expect(scriptWf).toBeDefined();
    expect(wfIsForScript(scriptWf!, "file-1")).toBe(true);
    expect(wfIsForScript(scriptWf!, "file-2")).toBe(false);

    // A second call returns the same id — no duplicate row.
    expect(ensureScriptWorkflow(db, "file-1", "a.py")).toBe(scriptWf!.id);
    expect(listWorkflows(db).filter((w) => w.createdBy === "script")).toHaveLength(1);

    // The auto-workflow is active so the scheduler can fire it.
    expect(getWorkflow(db, scriptWf!.id).status).toBe("active");
  });

  it("stores the definition as ordinary JSON, not a typed WorkflowDef", () => {
    const db = freshRoom();
    const id = ensureScriptWorkflow(db, "file-x", "run-me.js");
    const wf = getWorkflow(db, id);
    const nodes = (wf.definition as { nodes: Array<Record<string, unknown>> }).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!["kind"]).toBe("script_run");
    expect(nodes[0]!["file"]).toBe("file-x");
    expect(nodes[0]!["label"]).toBe("Run run-me.js");
  });

  it("a workflow someone else created for the same file is not ours", () => {
    const db = freshRoom();
    // Same shape, `createdBy: 'user'` — the Scripts page must not adopt it.
    const id = createWorkflow(db, "hand-made", "", "", scriptRunDef("file-1"), "user", {
      scope: "general",
    });
    expect(wfIsForScript(getWorkflow(db, id), "file-1")).toBe(false);
  });
});

// ============================================================================
// stamp_script_consents_only_stamps_approved_hashes
// ============================================================================

describe("stampScriptConsents", () => {
  it("stamp_script_consents_only_stamps_approved_hashes", () => {
    const db = freshRoom();
    const bytes = Buffer.from("print('run me')");
    const f = insertFile(db, "s.py", "text/x-python", bytes, "print('run me')", "upload");
    const def = scriptRunDef(f.id);
    const sha = scriptFingerprint(bytes);

    // Not approved → no entry.
    expect(stampScriptConsents(db, def, new Set()).size).toBe(0);
    // Approved → the exact hash, keyed by file id.
    expect(stampScriptConsents(db, def, new Set([sha])).get(f.id)).toBe(sha);
  });

  it("SEC-1: an edit invalidates the old grant, because the decision RE-HASHES", () => {
    const db = freshRoom();
    const original = Buffer.from("print('v1')");
    const f = insertFile(db, "s.py", "text/x-python", original, "print('v1')", "upload");
    const oldSha = scriptFingerprint(original);
    const def = scriptRunDef(f.id);
    expect(stampScriptConsents(db, def, new Set([oldSha])).get(f.id)).toBe(oldSha);

    // The room's author edits the script under the same id and name.
    const edited = Buffer.from("print('v2')");
    updateFileContent(db, f.id, edited, "print('v2')");
    const newSha = scriptFingerprint(edited);
    expect(newSha).not.toBe(oldSha);

    // Yesterday's grant no longer covers it — the executor parks and the user
    // is asked again. Only approving the CURRENT bytes clears it.
    expect(stampScriptConsents(db, def, new Set([oldSha])).has(f.id)).toBe(false);
    expect(stampScriptConsents(db, def, new Set([newSha])).get(f.id)).toBe(newSha);
  });

  it("resolves a node that names the file, through the same resolver", () => {
    const db = freshRoom();
    const bytes = Buffer.from("print('by name')");
    const f = insertFile(db, "word_counter.py", "text/x-python", bytes, null, "upload");
    const stamped = stampScriptConsents(
      db,
      scriptRunDef("word_counter"),
      new Set([scriptFingerprint(bytes)])
    );
    // Keyed by the resolved ID even though the node held a NAME — so the
    // executor looks the consent up under the same key it will run.
    expect(stamped.get(f.id)).toBe(scriptFingerprint(bytes));
  });

  it("ignores non-script nodes, unresolvable files, and a malformed definition", () => {
    const db = freshRoom();
    const def = {
      version: 1,
      nodes: [
        { id: "g", kind: "generate", prompt: "hi" },
        { id: "run", kind: "script_run", file: "does-not-exist" },
        { id: "bad", kind: "script_run" }, // no `file` at all
      ],
      edges: [],
    };
    expect(stampScriptConsents(db, def, new Set(["anything"])).size).toBe(0);
    expect(stampScriptConsents(db, null, new Set()).size).toBe(0);
    expect(stampScriptConsents(db, "not an object", new Set()).size).toBe(0);
    expect(stampScriptConsents(db, { nodes: "not an array" }, new Set()).size).toBe(0);
  });
});

// ============================================================================
// set_script_schedule
// ============================================================================

describe("setScriptSchedule", () => {
  it("refuses to schedule a script that is not approved on this Mac", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const f = insertFile(db, "job.py", "text/x-python", Buffer.from("print(1)"), null, "upload");
    expect(() => setScriptSchedule(db, dir, f.id, "daily", "09:00", true)).toThrow(
      /approve this script/i
    );
    // Nothing was scheduled behind the refusal.
    const wf = listWorkflows(db).find((w) => wfIsForScript(w, f.id));
    expect(wf === undefined || getSchedule(db, wf.id) === null).toBe(true);
  });

  it("schedules an approved script on its auto-workflow, catch-up by kind", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const bytes = Buffer.from("print('daily')");
    const f = insertFile(db, "daily.py", "text/x-python", bytes, null, "upload");
    addScriptApproval(dir, scriptFingerprint(bytes));

    setScriptSchedule(db, dir, f.id, "daily", "09:00", true);
    const wf = listWorkflows(db).find((w) => wfIsForScript(w, f.id));
    expect(wf).toBeDefined();
    const sched = getSchedule(db, wf!.id);
    expect(sched).not.toBeNull();
    expect(sched!.kind).toBe("daily");
    expect(sched!.param).toBe("09:00");
    expect(sched!.enabled).toBe(true);
    expect(sched!.catchUp).toBe(true); // a missed nightly run should catch up
    expect(sched!.nextRunAt).not.toBeNull();
  });

  it("interval schedules do NOT get catch-up", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const bytes = Buffer.from("print('interval')");
    const f = insertFile(db, "iv.py", "text/x-python", bytes, null, "upload");
    addScriptApproval(dir, scriptFingerprint(bytes));
    setScriptSchedule(db, dir, f.id, "interval", "30", true);
    const wf = listWorkflows(db).find((w) => wfIsForScript(w, f.id))!;
    expect(getSchedule(db, wf.id)!.catchUp).toBe(false);
  });

  it("rejects an unreadable schedule param", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const bytes = Buffer.from("print('bad')");
    const f = insertFile(db, "bad.py", "text/x-python", bytes, null, "upload");
    addScriptApproval(dir, scriptFingerprint(bytes));
    expect(() => setScriptSchedule(db, dir, f.id, "daily", "not-a-time", true)).toThrow(/invalid/i);
  });

  it("clearing (kind='') needs no approval — turning it OFF is never the risk", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const bytes = Buffer.from("print('clear-me')");
    const f = insertFile(db, "clear.py", "text/x-python", bytes, null, "upload");
    addScriptApproval(dir, scriptFingerprint(bytes));
    setScriptSchedule(db, dir, f.id, "daily", "09:00", true);
    const wfId = listWorkflows(db).find((w) => wfIsForScript(w, f.id))!.id;
    expect(getSchedule(db, wfId)).not.toBeNull();

    // Now forget the approval entirely — clearing must still work.
    rmSync(scriptApprovalsFile(dir), { force: true });
    expect(() => setScriptSchedule(db, dir, f.id, "", "", true)).not.toThrow();
    expect(getSchedule(db, wfId)).toBeNull();
  });

  it("SEC-1: an edit after 'Always allow' re-blocks scheduling until re-approved", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const original = Buffer.from("print('v1')");
    const f = insertFile(db, "edit.py", "text/x-python", original, "print('v1')", "upload");
    addScriptApproval(dir, scriptFingerprint(original));
    setScriptSchedule(db, dir, f.id, "interval", "30", true); // approved: fine

    // Same file id, same name, one changed byte in the code that would run
    // unattended at 3am. The server-side gate is what catches this.
    updateFileContent(db, f.id, Buffer.from("print('v2')"), "print('v2')");
    expect(() => setScriptSchedule(db, dir, f.id, "interval", "30", true)).toThrow(
      /approve this script/i
    );
    // Re-approving the CURRENT bytes is the only way back.
    addScriptApproval(dir, scriptFingerprint(Buffer.from("print('v2')")));
    expect(() => setScriptSchedule(db, dir, f.id, "interval", "30", true)).not.toThrow();
  });
});

// ============================================================================
// the consent card's pure fragments
// ============================================================================

describe("interpreterLine", () => {
  it("shows the command the run would execute, basenamed", () => {
    expect(interpreterLine({ program: "/usr/bin/python3", argvPrefix: [] }, "word_counter.py")).toBe(
      "python3 word_counter.py"
    );
    expect(
      interpreterLine(
        { program: "/opt/homebrew/bin/uv", argvPrefix: ["run", "--no-project"] },
        "x.py"
      )
    ).toBe("uv run --no-project x.py");
    expect(interpreterLine({ program: "node", argvPrefix: [] }, "x.js")).toBe("node x.js");
    // Rust's `file_name()` is None for a path with no final component; the
    // whole program string stands in, rather than an empty word.
    expect(interpreterLine({ program: "/", argvPrefix: [] }, "x.py")).toBe("/ x.py");
  });
});

describe("parseScriptDecision / resolveScriptRun", () => {
  it("once runs, always runs and remembers, anything else declines", () => {
    expect(parseScriptDecision("once")).toEqual({ approved: true, remember: false });
    expect(parseScriptDecision("always")).toEqual({ approved: true, remember: true });
    expect(parseScriptDecision("declined")).toEqual({ approved: false, remember: false });
    expect(parseScriptDecision("")).toEqual({ approved: false, remember: false });
    // The 180 s timeout takes the same arm — silence is never consent.
    expect(parseScriptDecision("timeout")).toEqual({ approved: false, remember: false });
  });

  it("answers the matching pending card once, and only once", () => {
    const pending = createPendingScriptApprovals();
    const seen: unknown[] = [];
    pending.set("req-1", (d) => seen.push(d));
    resolveScriptRun(pending, "req-1", "always");
    expect(seen).toEqual([{ approved: true, remember: true }]);
    expect(pending.has("req-1")).toBe(false);
    // A second answer to the same card is dropped, not double-delivered.
    resolveScriptRun(pending, "req-1", "once");
    expect(seen).toHaveLength(1);
  });

  it("is a no-op for an unknown id", () => {
    const pending = createPendingScriptApprovals();
    expect(() => resolveScriptRun(pending, "nope", "once")).not.toThrow();
  });
});

// ============================================================================
// a_finished_script_hands_its_output_back_as_the_answer
// ============================================================================

describe("clampScriptOutput", () => {
  it("a_finished_script_hands_its_output_back_as_the_answer", () => {
    const out = clampScriptOutput("Word Counter.py", "book.md: 1715 words");
    expect(out).toContain("book.md: 1715 words");
    expect(out).toContain("quote these values");
    expect(out).not.toContain("Started");

    // A silent script is a success, not a missing answer to apologise for.
    const quiet = clampScriptOutput("quiet.py", "   \n ");
    expect(quiet).toContain("printed nothing");
    expect(quiet).not.toContain("quote these values");

    // A runaway print loop cannot eat the turn.
    const huge = clampScriptOutput("loud.py", "x".repeat(20_000));
    expect(huge.length).toBeLessThan(5_000);
    expect(huge.endsWith("(output truncated)")).toBe(true);
    expect(Buffer.byteLength(clampedBody(huge), "utf8")).toBe(4000);
  });

  it("clamps by BYTES at a character boundary, exactly as Rust does", () => {
    // Rust compares `String::len()` (bytes) and cuts at the last char start at
    // or before 4000. `日` is 3 bytes, so 2000 of them are 6000 bytes and the
    // cut lands at 3999 — 1333 whole characters. A UTF-16 `.slice(0, 4000)`
    // would keep 4000 characters (12000 bytes); a byte slice that ignored
    // boundaries would end in U+FFFD.
    const body = clampedBody(clampScriptOutput("wide.py", "日".repeat(2000)));
    expect(Buffer.byteLength(body, "utf8")).toBe(3999);
    expect([...body]).toHaveLength(1333);
    expect(body).not.toContain("�");
  });
});

// ============================================================================
// the_agent_gets_what_the_script_printed_not_the_run_record
// the_assistant_is_told_which_files_the_script_created
// ============================================================================

describe("printedOutput", () => {
  it("the_agent_gets_what_the_script_printed_not_the_run_record", () => {
    const report = {
      exitCode: 0,
      imported: [{ id: "f1", name: "out.csv" }],
      skipped: [] as string[],
      stdoutTail: "book.md: 1715 words\n",
      stderrTail: "",
    };
    const out = printedOutput(JSON.stringify({ result: JSON.stringify(report) }));
    expect(out.startsWith("book.md: 1715 words")).toBe(true);
    expect(out).not.toContain("exitCode");
    expect(out).not.toContain("stdoutTail");

    // A transform-mode step's result already IS the stdout.
    expect(printedOutput(JSON.stringify({ result: "just the output" }))).toBe("just the output");
    // Anything unreadable yields nothing rather than a blob.
    expect(printedOutput("not json")).toBe("");
    expect(printedOutput(JSON.stringify({ noResult: 1 }))).toBe("");
  });

  it("the_assistant_is_told_which_files_the_script_created", () => {
    const report = {
      exitCode: 0,
      imported: [
        { id: "f1", name: "chart.png" },
        { id: "f2", name: "data.csv" },
      ],
      skipped: ["notes.txt: the script did not write this declared output"],
      stdoutTail: "",
      stderrTail: "",
    };
    const out = printedOutput(JSON.stringify({ result: JSON.stringify(report) }));
    expect(out).toContain("chart.png");
    expect(out).toContain("data.csv");
    expect(out).toContain("did not write this declared output");

    // A silent, file-producing run is no longer "printed nothing".
    const told = clampScriptOutput("make-chart.py", out);
    expect(told).not.toContain("printed nothing");
    expect(told).toContain("chart.png");

    // Printed text still LEADS — it is the answer when there is one.
    const withStdout = {
      exitCode: 2,
      imported: [{ id: "f1", name: "out.csv" }],
      skipped: [] as string[],
      stdoutTail: "42 rows\n",
      stderrTail: "",
    };
    const out2 = printedOutput(JSON.stringify({ result: JSON.stringify(withStdout) }));
    expect(out2.startsWith("42 rows")).toBe(true);
    expect(out2).toContain("Created: out.csv");
    // A non-zero exit is visible; a clean one is not worth a line.
    expect(out2).toContain("Exit code: 2");
  });

  it("a clean exit, and a missing/non-numeric exit code, cost no line", () => {
    const base = { imported: [] as unknown[], skipped: [] as string[], stdoutTail: "done\n" };
    expect(printedOutput(JSON.stringify({ result: JSON.stringify({ ...base, exitCode: 0 }) })))
      .not.toContain("Exit code");
    expect(printedOutput(JSON.stringify({ result: JSON.stringify(base) }))).not.toContain(
      "Exit code"
    );
    // Rust's `as_i64()` says None here, which `unwrap_or(0)` reads as clean.
    expect(
      printedOutput(JSON.stringify({ result: JSON.stringify({ ...base, exitCode: "2" }) }))
    ).not.toContain("Exit code");
  });
});

describe("scriptOutput (real job artifacts)", () => {
  it("reads back what a real run printed", () => {
    const db = freshRoom();
    const jobId = createJob(db, "workflow", "Run word_counter.py", { version: 1 }, 1);
    const report = {
      exitCode: 0,
      imported: [] as unknown[],
      skipped: [] as string[],
      stdoutTail: "book.md: 1715 words\n",
      stderrTail: "",
    };
    putJobArtifact(db, jobId, 0, JSON.stringify({ result: JSON.stringify(report) }));
    expect(scriptOutput(db, jobId)).toBe("book.md: 1715 words");
  });

  it("joins the steps it finds and stops at the first unwritten one", () => {
    const db = freshRoom();
    const jobId = createJob(db, "workflow", "Run s.py", { version: 1 }, 1);
    putJobArtifact(db, jobId, 0, JSON.stringify({ result: "first" }));
    putJobArtifact(db, jobId, 1, JSON.stringify({ result: "second" }));
    // Step 2 is missing, so step 3 is never consulted.
    putJobArtifact(db, jobId, 3, JSON.stringify({ result: "unreachable" }));
    expect(scriptOutput(db, jobId)).toBe("first\nsecond");
  });

  it("is empty when the job wrote no artifact at all", () => {
    const db = freshRoom();
    const jobId = createJob(db, "workflow", "Run x.py", { version: 1 }, 1);
    expect(scriptOutput(db, jobId)).toBe("");
  });
});

// ============================================================================
// Read surfaces are live; legacy injectable defaults still fail loudly.
// ============================================================================

describe("script read surfaces and legacy injectable defaults", () => {
  it("the Scripts page and agent read the real parsed manifest", () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    const bytes = Buffer.from(
      '# /// script\n# dependencies = ["requests"]\n# ///\nprint(\'ok\')\n',
    );
    const file = insertFile(db, "report.py", "text/x-python", bytes, null, "upload");
    const rows = listScripts(db, dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileId: file.id, name: "report.py", lang: "py", deps: ["requests"] });
    expect(getScriptManifest(db, file.id).deps).toEqual(["requests"]);
    expect(agentListScripts(db, dir)).toContain("report.py (py, needs requests)");
  });

  it("the run arms name BOTH script_run.rs and workflow.rs", async () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    await expect(runScriptInner(db, dir, "f1")).rejects.toThrow(
      /NOT_IMPLEMENTED: run_script[\s\S]*script_run\.rs[\s\S]*workflow\.rs/
    );
    // The command and the agent seam are ONE implementation, deliberately.
    expect(runScript).toBe(runScriptInner);
    await expect(agentRunScript(db, dir, "s.py")).rejects.toThrow(
      /NOT_IMPLEMENTED: agent_run_script/
    );
  });

  it("the consent-card arms name the missing renderer round trip too", async () => {
    await expect(approveScriptBytes("s.py", Buffer.from("print(1)"))).rejects.toThrow(
      /NOT_IMPLEMENTED: approve_script_bytes[\s\S]*script_run\.rs[\s\S]*renderer/
    );
    await expect(approveWorkflowScripts(scriptRunDef("f1"))).rejects.toThrow(
      /NOT_IMPLEMENTED: approve_workflow_scripts[\s\S]*workflow\.rs[\s\S]*script_run\.rs/
    );
  });

  it("no stub fabricates a success", async () => {
    const db = freshRoom();
    const dir = freshUserDataDir();
    expect(listScripts(db, dir)).toEqual([]);
    await expect(runScript(db, dir, "f1")).rejects.toBeInstanceOf(Error);
    await expect(approveWorkflowScripts({})).rejects.toBeInstanceOf(Error);
  });
});
