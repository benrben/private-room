/**
 * Tests for `workflowEngine.ts`.
 *
 * Every Rust unit test this slice owns is ported BY NAME from
 * `src-tauri/src/commands/jobs/workflow.rs`'s `#[cfg(test)] mod tests`
 * (`edge_liveness_rule`, `condition_ops_evaluate`,
 * `transform_ops_are_deterministic`, `merge_modes_combine_branches`,
 * `a_name_contains_filter_is_not_a_wildcard`,
 * `upstream_text_cannot_conjure_a_template_placeholder`), plus dispatch
 * coverage for all 16 `NodeKind` variants against a REAL fixture room
 * (`createRoom` + a `RoomSource` stub — the `filePass.test.ts`/
 * `scriptRun.test.ts` convention), the reserved-keys/`__proto__` payload
 * guard, Stop and NEEDS_APPROVAL classification at every hop, and a branching
 * plan driven end to end through `jobs.ts`'s own `runPlan`.
 *
 * `script_run` and `file_pass` are driven through the REAL already-ported
 * `scriptRun.ts` / `filePass.ts` runners (only their own documented process /
 * sidecar seams are faked), because "does this arm reach the real executor"
 * is exactly what a stub would hide.
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import {
  getFileExtractedText,
  getFileMeta,
  insertFile,
  listFiles,
  setFileAiSummary,
  type FileMeta,
} from "./db-host/files.js";
import { putJobArtifact } from "./db-host/jobs.js";
import { runPlan, type Lane, type RoomHandle, type RoomSource, type Step } from "./jobs.js";
import type { SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import { scriptFingerprint, type ExecOut } from "./scriptRun.js";
import { htmlDocument } from "./docsHtml.js";
import { DEFAULT_WF_ARTIFACT, type WfArtifact, type WorkflowNode, type WorkflowPlan } from "./workflowModel.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import {
  agentRunNotImplemented,
  applyMerge,
  applyTransform,
  buildWfNodePayload,
  classifyLiner,
  countNewFiles,
  edgeIsLive,
  emitWorkflowNode,
  evalCondition,
  executeWorkflowStep,
  interpolate,
  likeEscape,
  loadWfArtifact,
  NEEDS_APPROVAL,
  PER_FILE_CHARS,
  resolveFiles,
  ROOM_GONE,
  saveFileNode,
  sidecarJsonCancellableRun,
  storeWfArtifact,
  wfGenerate,
  wfNode,
  wfNodeValue,
  type EmitFn,
  type PublishedRef,
  type WfNodePostFn,
  type WorkflowStepDeps,
} from "./workflowEngine.js";

// ============================================================================
// fixtures
// ============================================================================

let tmpDirs: string[] = [];
let openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  openDbs = [];
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

class OneRoom implements RoomSource {
  constructor(private room: RoomHandle | null) {}
  current(): RoomHandle | null {
    return this.room;
  }
  swapTo(room: RoomHandle | null): void {
    this.room = room;
  }
}

function freshRoom(roomPath = "mem://wf-test"): { rooms: OneRoom; db: Database.Database; path: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-engine-"));
  tmpDirs.push(dir);
  const roomFile = path.join(dir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(roomFile, "correct horse battery staple", "Test Room");
  openDbs.push(db);
  return { rooms: new OneRoom({ db, path: roomPath }), db, path: roomPath };
}

function cacheDirFor(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-engine-cache-"));
  tmpDirs.push(dir);
  return dir;
}

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    workflow_id: "wf-1",
    workflow_name: "Test workflow",
    trigger: "manual",
    def: { version: 1, nodes: [], edges: [] },
    resolved_model: "resolved-model",
    input_file_id: null,
    prev_run_at: null,
    script_consents: new Map(),
    steps: [],
    ...overrides,
  };
}

function makeStep(
  id: number,
  node: WorkflowNode,
  opts: { model?: string | null; incoming?: Array<{ parent: number; branch: string | null }>; lane?: Lane } = {}
): Step {
  const incoming = opts.incoming ?? [];
  return {
    id,
    lane: opts.lane ?? "cpu",
    kind: "workflow_node",
    params: { node, model: opts.model ?? null, incoming },
    dependsOn: incoming.map((i) => i.parent),
  };
}

function baseDeps(rooms: RoomSource, extra: Partial<WorkflowStepDeps> = {}): WorkflowStepDeps {
  return { rooms, cacheDir: cacheDirFor(), ...extra };
}

function ref(): PublishedRef {
  return { value: null };
}

/** `put_job_artifact`'s own `WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?1)`
 * guard (a job deleted mid-run must not have a later step write an artifact
 * under an id that no longer exists) means a step's artifact silently fails to
 * persist unless a `jobs` row exists first — the fixture's job, not the
 * engine's. */
function ensureJobRow(db: Database.Database, jobId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO jobs(id, kind, title, status, plan, state, cursor) VALUES (?, 'workflow', 't', 'running', '{}', '{}', 0)"
  ).run(jobId);
}

async function runStep(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  step: Step,
  cancel: CancelFlag = new CancelFlag()
): Promise<{ result: Awaited<ReturnType<typeof executeWorkflowStep>>; published: PublishedRef }> {
  const room = deps.rooms.current();
  if (room !== null && room.path === roomPath) {
    ensureJobRow(room.db, jobId);
  }
  const published = ref();
  const result = await executeWorkflowStep(deps, jobId, roomPath, plan, step, cancel, published);
  return { result, published };
}

function valuePost(value: unknown): (p: string, b: unknown, c: CancelFlag) => Promise<SidecarPostOutcome> {
  return async () => ({ kind: "value", value });
}

function valueWfNodePost(
  value: unknown
): (p: string, b: unknown, c: CancelFlag, runId: string, timeoutMs: number) => Promise<SidecarPostOutcome> {
  return async () => ({ kind: "value", value });
}

function errorOf(result: { ok: boolean } & Partial<{ error: string }>): string {
  expect(result.ok).toBe(false);
  return result.error ?? "";
}

// ============================================================================
// pure helpers
// ============================================================================

describe("edgeIsLive", () => {
  it("edge_liveness_rule", () => {
    const done: WfArtifact = { ...DEFAULT_WF_ARTIFACT, result: "hi" };
    const skipped: WfArtifact = { ...DEFAULT_WF_ARTIFACT, skipped: true };
    const thenBranch: WfArtifact = { ...DEFAULT_WF_ARTIFACT, branch: "then" };
    // No branch: live iff not skipped, missing = dead.
    expect(edgeIsLive(done, null)).toBe(true);
    expect(edgeIsLive(skipped, null)).toBe(false);
    expect(edgeIsLive(null, null)).toBe(false);
    // Branch edge: live only on a matching condition branch.
    expect(edgeIsLive(thenBranch, "then")).toBe(true);
    expect(edgeIsLive(thenBranch, "else")).toBe(false);
  });
});

describe("evalCondition", () => {
  it("condition_ops_evaluate", () => {
    expect(evalCondition("contains", "hello world", "world", 0)).toBe(true);
    expect(evalCondition("contains", "hello", "bye", 0)).toBe(false);
    expect(evalCondition("not_contains", "hello", "bye", 0)).toBe(true);
    expect(evalCondition("is_empty", "   ", null, 0)).toBe(true);
    expect(evalCondition("not_empty", "x", null, 0)).toBe(true);
    expect(evalCondition("new_files_since_last_run", "", null, 3)).toBe(true);
    expect(evalCondition("new_files_since_last_run", "", null, 0)).toBe(false);
  });

  it("an unknown op is false, never a silently-taken branch", () => {
    expect(evalCondition("bogus", "anything", "x", 9)).toBe(false);
  });
});

describe("applyTransform", () => {
  it("transform_ops_are_deterministic", () => {
    expect(applyTransform("append", null, " world", "hi")).toBe("hi world");
    expect(applyTransform("prepend", null, ">> ", "hi")).toBe(">> hi");
    expect(applyTransform("replace", "a", "b", "banana")).toBe("bbnbnb");
    expect(applyTransform("upper", null, null, "hi")).toBe("HI");
    expect(applyTransform("lower", null, null, "HI")).toBe("hi");
    expect(applyTransform("trim", null, null, "  hi \n")).toBe("hi");
    expect(applyTransform("truncate", null, "3", "abcdef")).toBe("abc");
    expect(applyTransform("strip_html", null, null, "<b>hi</b>").trim()).toBe("hi");
    // Unknown op is a passthrough (validation catches it earlier).
    expect(applyTransform("bogus", null, null, "hi")).toBe("hi");
  });

  it("replace is LITERAL — a `$&` in the replacement is not a substitution pattern", () => {
    // `String.replaceAll` would expand `$&`/`` $` ``/`$'`/`$1` here; Rust's
    // `str::replace` does not, and the replacement is workflow-author text.
    expect(applyTransform("replace", "a", "[$&]", "cat")).toBe("c[$&]t");
    expect(applyTransform("replace", "b", "$`", "abc")).toBe("a$`c");
  });

  it("replace with an empty find is a no-op (Rust checks is_empty(), not trim)", () => {
    expect(applyTransform("replace", "", "X", "abc")).toBe("abc");
    expect(applyTransform("replace", null, "X", "abc")).toBe("abc");
  });

  it("truncate treats a non-usize value as 0, not NaN or a lenient prefix parse", () => {
    expect(applyTransform("truncate", null, "3.5", "abcdef")).toBe("");
    expect(applyTransform("truncate", null, "-1", "abcdef")).toBe("");
    expect(applyTransform("truncate", null, "abc", "abcdef")).toBe("");
    expect(applyTransform("truncate", null, "2x", "abcdef")).toBe("");
    expect(applyTransform("truncate", null, "+2", "abcdef")).toBe("ab");
    expect(applyTransform("truncate", null, null, "abcdef")).toBe("");
  });

  it("truncate counts Unicode SCALAR VALUES, not UTF-16 units", () => {
    expect(applyTransform("truncate", null, "2", "😀😀😀")).toBe("😀😀");
  });
});

describe("applyMerge", () => {
  it("merge_modes_combine_branches", () => {
    const inputs = ["a\nb", "b\nc"];
    expect(applyMerge("concat", "|", inputs)).toBe("a\nb|b\nc");
    expect(applyMerge("numbered", "\n", inputs)).toBe("1. a\nb\n2. b\nc");
    // dedupe_lines keeps first occurrence order, drops the repeat 'b'.
    expect(applyMerge("dedupe_lines", null, inputs)).toBe("a\nb\nc");
  });

  it("concat defaults its separator to a blank line", () => {
    expect(applyMerge("concat", null, ["a", "b"])).toBe("a\n\nb");
  });

  it("dedupe_lines does not invent a trailing empty line for text ending in \\n", () => {
    expect(applyMerge("dedupe_lines", null, ["a\nb\n"])).toBe("a\nb");
    expect(applyMerge("dedupe_lines", null, [""])).toBe("");
  });
});

describe("likeEscape", () => {
  it("a_name_contains_filter_is_not_a_wildcard", () => {
    // `_` and `%` are wildcards to SQL LIKE, so filtering for q3_report also
    // matched q3-report and q3xreport — a workflow running on files the user
    // never meant. The escaped pattern only matches a literal.
    expect(likeEscape("q3_report")).toBe("q3\\_report");
    expect(likeEscape("50%")).toBe("50\\%");
    expect(likeEscape("a\\b")).toBe("a\\\\b");
    expect(likeEscape("plain name.pdf")).toBe("plain name.pdf");
  });
});

describe("classifyLiner", () => {
  it("a non-empty answer caches; an empty one is Stuck, not Failed", () => {
    expect(classifyLiner({ ok: true, liner: "a one-liner" })).toEqual({ kind: "cached", liner: "a one-liner" });
    expect(classifyLiner({ ok: true, liner: "   " })).toEqual({ kind: "stuck" });
  });

  it("OLLAMA_DOWN / MODEL_MISSING are Hard; anything else is a soft Failed", () => {
    expect(classifyLiner({ ok: false, error: "OLLAMA_DOWN" })).toEqual({ kind: "hard", error: "OLLAMA_DOWN" });
    expect(classifyLiner({ ok: false, error: "MODEL_MISSING:x" })).toEqual({ kind: "hard", error: "MODEL_MISSING:x" });
    expect(classifyLiner({ ok: false, error: "a 502" })).toEqual({ kind: "failed", error: "a 502" });
  });

  it("this port's own NOT_IMPLEMENTED sentinel reads as Hard, never a silent per-file retry", () => {
    expect(classifyLiner({ ok: false, error: "NOT_IMPLEMENTED: x" })).toEqual({
      kind: "hard",
      error: "NOT_IMPLEMENTED: x",
    });
  });
});

// ============================================================================
// emit_workflow_node
// ============================================================================

describe("emitWorkflowNode", () => {
  it("is a no-op when no diagram is wired up yet (the Phase 2 gap)", () => {
    expect(() => emitWorkflowNode(undefined, "j", "w", "n", "running", "peek")).not.toThrow();
  });

  it("clamps the peek to 200 UNICODE SCALAR VALUES, not UTF-16 units", () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const emit: EmitFn = (event, payload) => events.push({ event, payload: payload as Record<string, unknown> });
    emitWorkflowNode(emit, "j", "w", "n", "done", "😀".repeat(300));
    expect(events[0]?.event).toBe("workflow-node");
    expect(Array.from(events[0]?.payload.peek as string).length).toBe(200);
  });

  it("passes a null peek through as null (running/skipped events)", () => {
    const events: unknown[] = [];
    emitWorkflowNode((_e, p) => events.push(p), "j", "w", "n", "skipped", null);
    expect(events[0]).toEqual({ jobId: "j", workflowId: "w", nodeId: "n", status: "skipped", peek: null });
  });

  it("a throwing sink never breaks the step — Rust's `let _ = w.emit(...)`", () => {
    expect(() =>
      emitWorkflowNode(
        () => {
          throw new Error("renderer gone");
        },
        "j",
        "w",
        "n",
        "error",
        "x"
      )
    ).not.toThrow();
  });
});

// ============================================================================
// buildWfNodePayload — the RESERVED-keys guard
// ============================================================================

describe("buildWfNodePayload", () => {
  it("carries the reserved fields at the top level, with the lane's slot count", () => {
    const payload = buildWfNodePayload("extract", "the-model", "job:0", "cloud", { fields: ["a"] });
    expect(payload.kind).toBe("extract");
    expect(payload.model).toBe("the-model");
    expect(payload.keep_alive).toBe("30m");
    expect(payload.run_id).toBe("job:0");
    expect(payload.parallel).toBe(4); // cloud lane slots
    expect(payload.fields).toEqual(["a"]);
  });

  it("a node body field named model/run_id/kind/parallel never shadows the reserved value", () => {
    // A shadowing `model` would silently move the sidecar's privacy door and
    // its Keychain-backed provider credentials onto another engine.
    const payload = buildWfNodePayload("route", "real-model", "job:1", "local_llm", {
      model: "attacker-model",
      run_id: "attacker-run",
      kind: "not-route",
      parallel: 999,
      base_url: "http://evil.example",
      keep_alive: "0s",
      prompt: "hi",
    });
    expect(payload.model).toBe("real-model");
    expect(payload.run_id).toBe("job:1");
    expect(payload.kind).toBe("route");
    expect(payload.parallel).toBe(1); // local_llm lane slots, NOT the body's 999
    expect(payload.base_url).not.toBe("http://evil.example");
    expect(payload.keep_alive).toBe("30m");
    expect(payload.prompt).toBe("hi");
  });

  it("a body field literally named '__proto__' cannot pollute Object.prototype (rule 2)", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "prompt": "hi"}') as Record<string, unknown>;
    const payload = buildWfNodePayload("route", "m", "job:2", "cpu", hostile);
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(payload.prompt).toBe("hi");
    // …and the payload still serializes to what the sidecar expects.
    expect(JSON.parse(JSON.stringify(payload)).model).toBe("m");
  });

  it("a non-object body contributes nothing and never throws", () => {
    expect(buildWfNodePayload("vote", "m", "j:0", "cpu", null).kind).toBe("vote");
    expect(buildWfNodePayload("vote", "m", "j:0", "cpu", ["a"]).kind).toBe("vote");
  });
});

// ============================================================================
// wfGenerate / wfNodeValue / wfNode
// ============================================================================

describe("wfGenerate", () => {
  it("returns the text field on success", async () => {
    let sent: Record<string, unknown> = {};
    const text = await wfGenerate(
      async (_p, body) => {
        sent = body as Record<string, unknown>;
        return { kind: "value", value: { text: "hello" } };
      },
      "m",
      "the prompt",
      undefined,
      new CancelFlag()
    );
    expect(text).toBe("hello");
    expect(sent.model).toBe("m");
    expect(sent.keep_alive).toBe("30m");
    expect(sent.messages).toEqual([{ role: "user", content: "the prompt" }]);
    expect("format" in sent).toBe(false);
  });

  it("a format schema rides along only when one was given", async () => {
    let sent: Record<string, unknown> = {};
    await wfGenerate(
      async (_p, body) => {
        sent = body as Record<string, unknown>;
        return { kind: "value", value: { text: "" } };
      },
      "m",
      "p",
      { type: "object" },
      new CancelFlag()
    );
    expect(sent.format).toEqual({ type: "object" });
  });

  it("stopped reads as a STOPPED throw", async () => {
    await expect(wfGenerate(async () => ({ kind: "stopped" }), "m", "p", undefined, new CancelFlag())).rejects.toThrow(
      "STOPPED"
    );
  });

  it("an engine error is sentinel-mapped", async () => {
    await expect(
      wfGenerate(
        async () => ({ kind: "error", error: { code: "MODEL_MISSING", error: "x", status: 404 } }),
        "my-model",
        "p",
        undefined,
        new CancelFlag()
      )
    ).rejects.toThrow("MODEL_MISSING:my-model");
  });
});

describe("wfNodeValue / wfNode", () => {
  it("the sidecar's own stopped answer maps to the same STOPPED sentinel", async () => {
    await expect(
      wfNodeValue(valueWfNodePost({ stopped: true }), "vote", "m", "job", 0, "cpu", {}, new CancelFlag())
    ).rejects.toThrow("STOPPED");
  });

  it("posts to /wf_node with a jobId:stepId run_id", async () => {
    let seenPath = "";
    let seenRun = "";
    await wfNodeValue(
      async (p, _b, _c, runId) => {
        seenPath = p;
        seenRun = runId;
        return { kind: "value", value: {} };
      },
      "refine",
      "m",
      "job-9",
      4,
      "cpu",
      {},
      new CancelFlag()
    );
    expect(seenPath).toBe("/wf_node");
    expect(seenRun).toBe("job-9:4");
  });

  it("wfNode reads the result field, and an absent one reads as empty text", async () => {
    expect(await wfNode(valueWfNodePost({ result: "voted" }), "vote", "m", "j", 0, "cpu", {}, new CancelFlag())).toBe(
      "voted"
    );
    expect(await wfNode(valueWfNodePost({}), "vote", "m", "j", 0, "cpu", {}, new CancelFlag())).toBe("");
  });
});

describe("sidecarJsonCancellableRun", () => {
  afterEach(() => {
    vi.mocked(ensureUp).mockReset();
  });

  it("never reached the sidecar pre-cancelled: no /cancel delivery attempted", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    expect(await sidecarJsonCancellableRun("/wf_node", {}, cancel, "job:0")).toEqual({ kind: "stopped" });
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("a completed chain comes back as its parsed value", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: "chain done", path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const outcome = await sidecarJsonCancellableRun("/wf_node", { a: 1 }, new CancelFlag(), "job:0", 5_000);
      expect(outcome).toEqual({ kind: "value", value: { result: "chain done", path: "/wf_node" } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a Stop mid-chain DELIVERS /cancel with the run id, then resolves stopped", async () => {
    // Dropping the connection alone does not stop a chain handler — the Stop
    // has to be delivered on a second connection, which is what this pins.
    let cancelBody: unknown = null;
    let cancelCalls = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/cancel") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          cancelCalls += 1;
          cancelBody = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, known: true, stopped: ["wf"] }));
        });
        return;
      }
      // The long-running /wf_node POST — never answers on its own.
      void res;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    const cancel = new CancelFlag();
    try {
      const promise = sidecarJsonCancellableRun("/wf_node", { a: 1 }, cancel, "job-42:0", 5_000);
      setTimeout(() => cancel.store(true), 30);
      expect(await promise).toEqual({ kind: "stopped" });
      expect(cancelCalls).toBe(1);
      expect(cancelBody).toEqual({ run_id: "job-42:0" });
    } finally {
      // The hung /wf_node socket is deliberately never answered, so it must be
      // torn down explicitly or `close()` waits for it.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ============================================================================
// artifact load/store
// ============================================================================

describe("loadWfArtifact / storeWfArtifact", () => {
  it("round-trips, and a missing step reads as null", () => {
    const { db } = freshRoom();
    expect(loadWfArtifact(db, "job1", 0)).toBeNull();
    ensureJobRow(db, "job1");
    const artifact: WfArtifact = { ...DEFAULT_WF_ARTIFACT, result: "hi", node_label: "Step" };
    storeWfArtifact(db, "job1", 0, artifact);
    expect(loadWfArtifact(db, "job1", 0)).toEqual(artifact);
  });

  it("a stored `{}` reads as ALL DEFAULTS, not undefined fields", () => {
    // Every field of the Rust struct is `#[serde(default)]`. A bare cast would
    // leave `result` undefined and the next `a.result.trim()` would throw.
    const { db } = freshRoom();
    ensureJobRow(db, "job1");
    putJobArtifact(db, "job1", 3, "{}");
    expect(loadWfArtifact(db, "job1", 3)).toEqual(DEFAULT_WF_ARTIFACT);
  });

  it("unparseable stored JSON reads as absent, never a throw", () => {
    const { db } = freshRoom();
    ensureJobRow(db, "job1");
    putJobArtifact(db, "job1", 4, "not json");
    expect(loadWfArtifact(db, "job1", 4)).toBeNull();
  });

  it("a step whose stored artifact is `{}` is treated as a LIVE parent with empty text", async () => {
    // The regression this pins: reading `{}` through a cast made `skipped`
    // undefined (falsy → live) and `result` undefined → `.trim()` TypeError.
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    putJobArtifact(db, "job1", 0, "{}");
    const step = makeStep(1, { id: "t", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    const { result } = await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe("");
  });
});

// ============================================================================
// interpolate
// ============================================================================

describe("interpolate", () => {
  it("upstream_text_cannot_conjure_a_template_placeholder", () => {
    // Placeholders are what the workflow AUTHOR writes. Substituting {{input}}
    // FIRST meant a document — or an AI reply — that happened to contain the
    // marker {{files}} had the room's whole file inventory pasted into the
    // next step's prompt.
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "quarterly-plan.md", "text/markdown", Buffer.from("body"), "body", "upload");
    const hostile = "the model wrote: {{files}}";
    const out = interpolate(rooms, roomPath, "Continue from:\n{{input}}", hostile);
    expect(out, "the marker is left as literal text").toContain("{{files}}");
    expect(out, "upstream text must not expand into the file inventory").not.toContain("quarterly-plan.md");
    // A placeholder the TEMPLATE itself carries still resolves.
    const real = interpolate(rooms, roomPath, "Files:\n{{files}}\n\n{{input}}", "x");
    expect(real).toContain("quarterly-plan.md");
    expect(real.endsWith("x")).toBe(true);
  });

  it("substitution is LITERAL — a `$&` in upstream text is not a replacement pattern", () => {
    // `String.replaceAll` would expand it; the replacement here is model
    // output, so it must be inserted byte for byte.
    const { rooms, path: roomPath } = freshRoom();
    expect(interpolate(rooms, roomPath, "[{{input}}]", "a $& b $` c")).toBe("[a $& b $` c]");
  });

  it("{{date}} resolves against the room, and every occurrence is substituted", () => {
    const { rooms, path: roomPath } = freshRoom();
    const out = interpolate(rooms, roomPath, "{{date}}/{{date}} {{input}}{{input}}", "x");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2} xx$/);
  });

  it("a file's cached one-liner rides along in the {{files}} inventory", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const f = insertFile(db, "a.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    setFileAiSummary(db, f.id, "a greeting");
    expect(interpolate(rooms, roomPath, "{{files}}", "")).toBe("- a.txt: a greeting");
  });

  it("a room that has swapped or closed reads {{files}}/{{date}} as empty, never throws", () => {
    const { rooms, path: roomPath } = freshRoom();
    rooms.swapTo(null);
    expect(interpolate(rooms, roomPath, "[{{files}}][{{date}}][{{input}}]", "in")).toBe("[][][in]");
  });
});

// ============================================================================
// resolve_files — the generated-vs-not-generated split, per selector
// ============================================================================

describe("resolveFiles", () => {
  it("run_input resolves the pinned input file, or throws if there is none / it is gone", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const f = insertFile(db, "in.txt", "text/plain", Buffer.from("x"), "x", "upload");
    expect(resolveFiles(rooms, roomPath, { type: "run_input", pattern: null }, f.id, null)).toEqual([
      [f.id, "in.txt", "text/plain"],
    ]);
    expect(() => resolveFiles(rooms, roomPath, { type: "run_input", pattern: null }, null, null)).toThrow(
      "this workflow needs a file to run on"
    );
    expect(() => resolveFiles(rooms, roomPath, { type: "run_input", pattern: null }, "gone-id", null)).toThrow(
      "no longer in the room"
    );
  });

  it("newest / all / name_like / missing_summary INCLUDE generated files", () => {
    // Excluding `source='generated'` here once matched nothing in a room whose
    // useful content IS AI-authored, so every file-read node reported "No file
    // matched — nothing to read."
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "made.html", "text/html", Buffer.from("<p>x</p>"), "<p>x</p>", "generated");
    const names = (kind: string, pattern: string | null = null): string[] =>
      resolveFiles(rooms, roomPath, { type: kind, pattern }, null, null).map(([, n]) => n);
    expect(names("newest")).toEqual(["made.html"]);
    expect(names("all")).toEqual(["made.html"]);
    expect(names("name_like", "made")).toEqual(["made.html"]);
    expect(names("missing_summary")).toEqual(["made.html"]);
  });

  it("since_last_run EXCLUDES generated files — the feedback-loop guard", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "made.html", "text/html", Buffer.from("<p>x</p>"), "<p>x</p>", "generated");
    insertFile(db, "dropped.txt", "text/plain", Buffer.from("y"), "y", "upload");
    const names = resolveFiles(rooms, roomPath, { type: "since_last_run", pattern: null }, null, "1970-01-01").map(
      ([, n]) => n
    );
    expect(names).toEqual(["dropped.txt"]);
  });

  it("since_last_run returns nothing for a cutoff in the future", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("y"), "y", "upload");
    expect(resolveFiles(rooms, roomPath, { type: "since_last_run", pattern: null }, null, "9999-01-01")).toEqual([]);
  });

  it("missing_summary skips a file that already has one, and one with no text", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const described = insertFile(db, "described.txt", "text/plain", Buffer.from("a"), "a", "upload");
    setFileAiSummary(db, described.id, "already described");
    insertFile(db, "blank.bin", "application/octet-stream", Buffer.from([1, 2]), null, "upload");
    insertFile(db, "todo.txt", "text/plain", Buffer.from("b"), "b", "upload");
    const names = resolveFiles(rooms, roomPath, { type: "missing_summary", pattern: null }, null, null).map(
      ([, n]) => n
    );
    expect(names).toEqual(["todo.txt"]);
  });

  it("name_like escapes % and _ so a typed fragment is not a wildcard", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "q3_report.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "q3-report.txt", "text/plain", Buffer.from("b"), "b", "upload");
    const names = resolveFiles(rooms, roomPath, { type: "name_like", pattern: "q3_report" }, null, null).map(
      ([, n]) => n
    );
    expect(names).toEqual(["q3_report.txt"]);
  });

  it("an unknown selector resolves to an empty list, matching Rust's `_ => Vec::new()`", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("a"), "a", "upload");
    expect(resolveFiles(rooms, roomPath, { type: "sideways", pattern: null }, null, null)).toEqual([]);
  });

  it("a room that is no longer open throws ROOM_GONE", () => {
    const { rooms, path: roomPath } = freshRoom();
    rooms.swapTo(null);
    expect(() => resolveFiles(rooms, roomPath, { type: "all", pattern: null }, null, null)).toThrow(ROOM_GONE);
  });
});

describe("countNewFiles", () => {
  it("counts source files created after `since`, and 0 when the room is gone", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "made.html", "text/html", Buffer.from("b"), "b", "generated");
    expect(countNewFiles(rooms, roomPath, "1970-01-01")).toBe(1);
    expect(countNewFiles(rooms, roomPath, "9999-01-01")).toBe(0);
    rooms.swapTo(null);
    expect(countNewFiles(rooms, roomPath, "1970-01-01")).toBe(0);
  });
});

// ============================================================================
// dispatch — every NodeKind variant
// ============================================================================

describe("executeWorkflowStep — generate", () => {
  it("interpolates the prompt, calls /generate, and stores the artifact", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "upstream text" });
    let seenPrompt = "";
    const deps = baseDeps(rooms, {
      post: async (_p, body) => {
        seenPrompt = ((body as Record<string, unknown>).messages as Array<{ content: string }>)[0]?.content ?? "";
        return { kind: "value", value: { text: "the answer" } };
      },
    });
    const step = makeStep(1, { id: "g", label: "Ask", kind: "generate", prompt: "Say: {{input}}", model: "" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    expect(seenPrompt).toBe("Say: upstream text");
    const artifact = loadWfArtifact(db, "job1", 1);
    expect(artifact?.result).toBe("the answer");
    expect(artifact?.node_label).toBe("Ask");
    expect(artifact?.node_kind).toBe("generate");
  });

  it("the step's own model overrides the plan's resolved model", async () => {
    const { rooms, path: roomPath } = freshRoom();
    let seenModel = "";
    const deps = baseDeps(rooms, {
      post: async (_p, body) => {
        seenModel = (body as Record<string, unknown>).model as string;
        return { kind: "value", value: { text: "" } };
      },
    });
    const step = makeStep(0, { id: "g", label: "", kind: "generate", prompt: "p", model: "pinned" }, {
      model: "pinned-model",
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(seenModel).toBe("pinned-model");
  });

  it("a STOPPED sidecar answer is reported, not silently swallowed", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const deps = baseDeps(rooms, { post: async () => ({ kind: "stopped" }) });
    const step = makeStep(0, { id: "g", label: "", kind: "generate", prompt: "p", model: "" });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
  });
});

describe("executeWorkflowStep — skip propagation", () => {
  it("a non-root node with no live incoming edge is skipped, and the skip propagates", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, skipped: true });
    const deps = baseDeps(rooms);
    const first = makeStep(1, { id: "t", label: "T", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    expect((await runStep(deps, "job1", roomPath, makePlan(), first)).result).toEqual({ ok: true });
    expect(loadWfArtifact(db, "job1", 1)?.skipped).toBe(true);
    expect(loadWfArtifact(db, "job1", 1)?.node_kind).toBe("transform");
    // …and the node downstream of THAT is skipped too.
    const second = makeStep(2, { id: "t2", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 1, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), second);
    expect(loadWfArtifact(db, "job1", 2)?.skipped).toBe(true);
  });

  it("a MISSING parent artifact is dead, exactly like a skipped one", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    const step = makeStep(1, { id: "t", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 1)?.skipped).toBe(true);
  });

  it("a dead condition branch skips the node wired to the OTHER branch", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "branch: then", branch: "then" });
    const elseStep = makeStep(1, { id: "e", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 0, branch: "else" }],
    });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), elseStep);
    expect(loadWfArtifact(db, "job1", 1)?.skipped).toBe(true);
  });
});

describe("executeWorkflowStep — condition", () => {
  it("takes the then/else branch and records it on the artifact", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "alpha beta" });
    const deps = baseDeps(rooms);
    const yes = makeStep(1, { id: "c", label: "", kind: "condition", op: "contains", value: "beta" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), yes);
    expect(loadWfArtifact(db, "job1", 1)).toMatchObject({ result: "branch: then", branch: "then" });
    const no = makeStep(2, { id: "c2", label: "", kind: "condition", op: "contains", value: "zeta" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), no);
    expect(loadWfArtifact(db, "job1", 2)).toMatchObject({ result: "branch: else", branch: "else" });
  });

  it("new_files_since_last_run counts real new SOURCE files", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "new.txt", "text/plain", Buffer.from("x"), "x", "upload");
    const step = makeStep(0, { id: "c", label: "", kind: "condition", op: "new_files_since_last_run", value: null });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan({ prev_run_at: "1970-01-01" }), step);
    expect(loadWfArtifact(db, "job1", 0)?.branch).toBe("then");
  });
});

describe("executeWorkflowStep — transform / merge", () => {
  it("transform runs the pure op over the JOINED input", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "a" });
    storeWfArtifact(db, "job1", 1, { ...DEFAULT_WF_ARTIFACT, result: "b" });
    const step = makeStep(2, { id: "t", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [
        { parent: 0, branch: null },
        { parent: 1, branch: null },
      ],
    });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 2)?.result).toBe("A\n\nB");
  });

  it("merge reduces the LIVE branches individually, not the pre-joined blob", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "one" });
    storeWfArtifact(db, "job1", 1, { ...DEFAULT_WF_ARTIFACT, result: "two" });
    const step = makeStep(2, { id: "m", label: "", kind: "merge", mode: "numbered", separator: "\n" }, {
      incoming: [
        { parent: 0, branch: null },
        { parent: 1, branch: null },
      ],
    });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 2)?.result).toBe("1. one\n2. two");
  });
});

describe("executeWorkflowStep — http_fetch", () => {
  it("interpolates the url and formats title + text", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "reports" });
    let seenUrl = "";
    const deps = baseDeps(rooms, {
      fetchPage: async (url) => {
        seenUrl = url;
        return { title: "The Page", text: "body text", finalUrl: url, status: 200 };
      },
    });
    const step = makeStep(1, { id: "h", label: "", kind: "http_fetch", url: "https://example.test/{{input}}" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(seenUrl).toBe("https://example.test/reports");
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe("The Page\n\nbody text");
  });

  it("refuses to start when already cancelled, without a fetch", async () => {
    const { rooms, path: roomPath } = freshRoom();
    let called = false;
    const deps = baseDeps(rooms, {
      fetchPage: async () => {
        called = true;
        throw new Error("should not run");
      },
    });
    const cancel = new CancelFlag();
    cancel.store(true);
    const step = makeStep(0, { id: "h", label: "", kind: "http_fetch", url: "https://example.test/" });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step, cancel);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
    expect(called).toBe(false);
  });
});

describe("executeWorkflowStep — the five /wf_node chain arms", () => {
  type Sent = { kind: string; body: Record<string, unknown> };

  function recordingWfNodePost(sent: Sent[], value: unknown) {
    return async (_p: string, body: unknown): Promise<SidecarPostOutcome> => {
      const b = body as Record<string, unknown>;
      sent.push({ kind: b.kind as string, body: b });
      return { kind: "value", value };
    };
  }

  it("extract posts fields + context and returns the sidecar's result verbatim", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "source text" });
    const sent: Sent[] = [];
    const deps = baseDeps(rooms, { wfNodePost: recordingWfNodePost(sent, { result: '{"a":1}' }) });
    const step = makeStep(1, { id: "x", label: "", kind: "extract", fields: ["a", "b"], model: "" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(sent[0]?.kind).toBe("extract");
    expect(sent[0]?.body.fields).toEqual(["a", "b"]);
    expect(sent[0]?.body.context).toBe("source text");
    expect(sent[0]?.body.model).toBe("resolved-model");
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe('{"a":1}');
  });

  it("route reads BOTH the result and the taken branch", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const sent: Sent[] = [];
    const deps = baseDeps(rooms, {
      wfNodePost: recordingWfNodePost(sent, { result: "billing", branch: "billing" }),
    });
    const step = makeStep(0, { id: "r", label: "", kind: "route", prompt: "which?", labels: ["billing", "tech"], model: "" });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(sent[0]?.body.labels).toEqual(["billing", "tech"]);
    expect(loadWfArtifact(db, "job1", 0)).toMatchObject({ result: "billing", branch: "billing" });
  });

  it("vote posts prompt/mode/samples and carries the LANE's slot budget", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const sent: Sent[] = [];
    const deps = baseDeps(rooms, { wfNodePost: recordingWfNodePost(sent, { result: "the winner" }) });
    const step = makeStep(0, { id: "v", label: "", kind: "vote", prompt: "p", model: "", samples: 5, mode: "majority" }, {
      lane: "local_llm",
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(sent[0]?.body).toMatchObject({ kind: "vote", prompt: "p", mode: "majority", samples: 5, parallel: 1 });
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("the winner");
  });

  it("refine posts prompt/rubric/max_rounds", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const sent: Sent[] = [];
    const deps = baseDeps(rooms, { wfNodePost: recordingWfNodePost(sent, { result: "refined" }) });
    const step = makeStep(0, { id: "rf", label: "", kind: "refine", prompt: "p", rubric: "r", model: "", max_rounds: 3 });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(sent[0]?.body).toMatchObject({ kind: "refine", prompt: "p", rubric: "r", max_rounds: 3 });
  });

  it("plan_and_map posts the objective, the context and max_workers", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const sent: Sent[] = [];
    const deps = baseDeps(rooms, { wfNodePost: recordingWfNodePost(sent, { result: "planned" }) });
    const step = makeStep(0, { id: "pm", label: "", kind: "plan_and_map", objective: "o", model: "", max_workers: 4 }, {
      lane: "cloud",
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(sent[0]?.body).toMatchObject({ kind: "plan_and_map", prompt: "o", max_workers: 4, parallel: 4 });
  });

  it("a chain arm's Stop surfaces as STOPPED, not an engine error", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const deps = baseDeps(rooms, { wfNodePost: async () => ({ kind: "stopped" }) });
    const step = makeStep(0, { id: "v", label: "", kind: "vote", prompt: "p", model: "", samples: 3, mode: "concat" });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
  });
});

describe("executeWorkflowStep — summarize_file", () => {
  it("caches a real one-liner and reports it, leaving the file's text untouched", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const f = insertFile(db, "a.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    const deps = baseDeps(rooms, { summarizeOneFile: async () => "a greeting" });
    const step = makeStep(0, { id: "s", label: "", kind: "summarize_file", select: { type: "newest", pattern: null } });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("a.txt: a greeting");
    expect(getFileMeta(db, f.id).name).toBe("a.txt");
    expect(getFileExtractedText(db, f.id)).toBe("hi");
    // Cached, so the file leaves the missing-summary set.
    expect(resolveFiles(rooms, roomPath, { type: "missing_summary", pattern: null }, null, null)).toEqual([]);
  });

  it("an empty answer caches the '' sentinel and reports 'no description'", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    const deps = baseDeps(rooms, { summarizeOneFile: async () => "   " });
    const step = makeStep(0, { id: "s", label: "", kind: "summarize_file", select: { type: "all", pattern: null } });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("a.txt: (no description could be written)");
    expect(resolveFiles(rooms, roomPath, { type: "missing_summary", pattern: null }, null, null)).toEqual([]);
  });

  it("a soft CALL failure caches NOTHING, so the next run retries the file", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    const deps = baseDeps(rooms, {
      summarizeOneFile: async () => {
        throw new Error("a 502");
      },
    });
    const step = makeStep(0, { id: "s", label: "", kind: "summarize_file", select: { type: "all", pattern: null } });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("a.txt: (not described this run — trying again next time)");
    // Still missing — a permanent sentinel here would have been unrecoverable.
    expect(resolveFiles(rooms, roomPath, { type: "missing_summary", pattern: null }, null, null)).toHaveLength(1);
  });

  it("a HARD failure (OLLAMA_DOWN) aborts the node instead of a per-file retry line", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const db = rooms.current()!.db;
    insertFile(db, "a.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    const deps = baseDeps(rooms, {
      summarizeOneFile: async () => {
        throw new Error("OLLAMA_DOWN");
      },
    });
    const step = makeStep(0, { id: "s", label: "", kind: "summarize_file", select: { type: "all", pattern: null } });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(errorOf(result)).toBe("OLLAMA_DOWN");
  });

  it("files with no readable text are skipped, and no matches reports the honest empty line", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "blank.bin", "application/octet-stream", Buffer.from([1]), null, "upload");
    const deps = baseDeps(rooms, { summarizeOneFile: async () => "never called" });
    const step = makeStep(0, { id: "s", label: "", kind: "summarize_file", select: { type: "all", pattern: null } });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("");

    const empty = makeStep(1, {
      id: "s2",
      label: "",
      kind: "summarize_file",
      select: { type: "name_like", pattern: "nothing-matches" },
    });
    await runStep(deps, "job1", roomPath, makePlan(), empty);
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe("No files matched — nothing to summarize.");
  });

  it("a Stop between files ends the node without touching the next one", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "b.txt", "text/plain", Buffer.from("b"), "b", "upload");
    const cancel = new CancelFlag();
    let calls = 0;
    const deps = baseDeps(rooms, {
      summarizeOneFile: async () => {
        calls += 1;
        cancel.store(true);
        return "described";
      },
    });
    const step = makeStep(0, { id: "s", label: "", kind: "summarize_file", select: { type: "all", pattern: null } });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step, cancel);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
    expect(calls).toBe(1);
  });
});

describe("executeWorkflowStep — for_each_file", () => {
  it("runs the instruction against each file, clipping and NOTING a long one", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const longText = "x".repeat(PER_FILE_CHARS + 500);
    insertFile(db, "short.txt", "text/plain", Buffer.from("short body"), "short body", "upload");
    insertFile(db, "long.txt", "text/plain", Buffer.from(longText), longText, "upload");
    const prompts: string[] = [];
    const deps = baseDeps(rooms, {
      post: async (_p, body) => {
        prompts.push(((body as Record<string, unknown>).messages as Array<{ content: string }>)[0]?.content ?? "");
        return { kind: "value", value: { text: "  section text  " } };
      },
    });
    const step = makeStep(0, {
      id: "fe",
      label: "",
      kind: "for_each_file",
      select: { type: "all", pattern: null },
      instruction: "Describe this.",
      model: "",
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    const out = loadWfArtifact(db, "job1", 0)?.result ?? "";
    expect(out).toContain("## long.txt\n\n_Read the first 12000 characters only._");
    expect(out).toContain("## short.txt");
    expect(out).toContain("section text");
    // The clip note is in the PROMPT too, not only the heading.
    expect(prompts.some((p) => p.includes("Only the first 12000 characters"))).toBe(true);
    expect(prompts.some((p) => p.startsWith("Describe this.\n\nFile: short.txt\n\nshort body"))).toBe(true);
  });

  it("no matching files, and files with no text, both report their own honest line", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const deps = baseDeps(rooms, { post: valuePost({ text: "x" }) });
    const none = makeStep(0, {
      id: "fe",
      label: "",
      kind: "for_each_file",
      select: { type: "all", pattern: null },
      instruction: "i",
      model: "",
    });
    await runStep(deps, "job1", roomPath, makePlan(), none);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("No files matched — nothing to do.");

    insertFile(db, "blank.bin", "application/octet-stream", Buffer.from([1]), null, "upload");
    const blank = makeStep(1, {
      id: "fe2",
      label: "",
      kind: "for_each_file",
      select: { type: "all", pattern: null },
      instruction: "i",
      model: "",
    });
    await runStep(deps, "job1", roomPath, makePlan(), blank);
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe("No files had readable text.");
  });
});

describe("executeWorkflowStep — agent_run", () => {
  it("interpolates the question and reports the injected agent's answer", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "the budget" });
    let asked = "";
    const deps = baseDeps(rooms, {
      agentRun: async (q) => {
        asked = q;
        return "42";
      },
    });
    const step = makeStep(1, { id: "a", label: "", kind: "agent_run", question: "What about {{input}}?" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(asked).toBe("What about the budget?");
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe("42");
  });

  it("with no agentRun wired, refuses honestly rather than fabricating an answer", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const step = makeStep(0, { id: "a", label: "", kind: "agent_run", question: "q" });
    const { result } = await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(errorOf(result)).toContain("NOT_IMPLEMENTED");
  });

  it("agentRunNotImplemented itself always rejects with the labeled sentence", async () => {
    await expect(agentRunNotImplemented("x")).rejects.toThrow("NOT_IMPLEMENTED");
  });
});

describe("saveFileNode / executeWorkflowStep — save_file", () => {
  it("create mode inserts a fresh generated file, html by default, and publishes it", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const published = ref();
    const { result, fileId } = saveFileNode(
      rooms,
      roomPath,
      "Morning digest",
      "html",
      "create",
      "<p>hello</p>",
      null,
      published,
      "Workflow saved — Test"
    );
    expect(result).toBe('Saved "Morning digest.html" into the room.');
    expect(published.value?.name).toBe("Morning digest.html");
    const files = listFiles(db);
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe(fileId);
    expect(files[0]?.source).toBe("generated");
    expect(getFileExtractedText(db, fileId)).toContain("<p>hello</p>");
  });

  it("md format writes the raw markdown, not an HTML document", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const { fileId } = saveFileNode(rooms, roomPath, "Notes", "md", "create", "# hi", null, ref(), "cause");
    expect(getFileExtractedText(db, fileId)).toBe("# hi");
  });

  it("the name template is interpolated and then cleaned", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const { fileId } = saveFileNode(
      rooms,
      roomPath,
      "Digest {{input}}",
      "md",
      "create",
      "2026/07\n18",
      null,
      ref(),
      "cause"
    );
    expect(getFileMeta(db, fileId).name).toBe("Digest 2026 07 18.md");
  });

  it("an existing file id (idempotent re-run) overwrites that file rather than duplicating it", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const first = insertFile(db, "Digest.html", "text/html", Buffer.from("<p>old</p>"), "<p>old</p>", "generated");
    const { fileId } = saveFileNode(
      rooms,
      roomPath,
      "Digest",
      "html",
      "create",
      "<p>new</p>",
      { ...DEFAULT_WF_ARTIFACT, file_id: first.id },
      ref(),
      "cause"
    );
    expect(fileId).toBe(first.id);
    expect(getFileExtractedText(db, first.id)).toContain("<p>new</p>");
    expect(listFiles(db)).toHaveLength(1);
  });

  it("an existing file id pointing at a DELETED file falls back to a fresh insert", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const { fileId, result } = saveFileNode(
      rooms,
      roomPath,
      "Digest",
      "html",
      "create",
      "<p>x</p>",
      { ...DEFAULT_WF_ARTIFACT, file_id: "not-a-real-file-id" },
      ref(),
      "cause"
    );
    expect(fileId).not.toBe("not-a-real-file-id");
    expect(result).toContain("Digest.html");
    expect(listFiles(db)).toHaveLength(1);
  });

  it("overwrite mode without a recorded id reuses the newest generated file of that name", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const first = insertFile(db, "Report.html", "text/html", Buffer.from("<p>v1</p>"), "<p>v1</p>", "generated");
    const { fileId } = saveFileNode(rooms, roomPath, "Report", "html", "overwrite", "<p>v2</p>", null, ref(), "cause");
    expect(fileId).toBe(first.id);
    expect(getFileExtractedText(db, first.id)).toContain("<p>v2</p>");
    expect(listFiles(db)).toHaveLength(1);
  });

  it("overwrite mode never claims an UPLOADED file of the same name", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const mine = insertFile(db, "Report.html", "text/html", Buffer.from("<p>mine</p>"), "<p>mine</p>", "upload");
    const { fileId } = saveFileNode(rooms, roomPath, "Report", "html", "overwrite", "<p>v2</p>", null, ref(), "cause");
    expect(fileId).not.toBe(mine.id);
    expect(getFileExtractedText(db, mine.id)).toBe("<p>mine</p>");
  });

  it("append mode (html) keeps ONE document, adding the block before the footer", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    saveFileNode(rooms, roomPath, "Log", "html", "append", "<p>first</p>", null, ref(), "cause");
    const { fileId } = saveFileNode(rooms, roomPath, "Log", "html", "append", "<p>second</p>", null, ref(), "cause");
    expect(listFiles(db)).toHaveLength(1);
    const text = getFileExtractedText(db, fileId) ?? "";
    expect(text).toContain("<p>first</p>");
    expect(text).toContain("<p>second</p>");
    expect((text.match(/<!doctype html>/g) ?? []).length).toBe(1);
  });

  it("append mode (md) joins with a blank line", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    saveFileNode(rooms, roomPath, "Log", "md", "append", "one", null, ref(), "cause");
    const { fileId } = saveFileNode(rooms, roomPath, "Log", "md", "append", "two", null, ref(), "cause");
    expect(getFileExtractedText(db, fileId)).toBe("one\n\ntwo");
  });

  it("a room that swapped or closed throws ROOM_GONE instead of writing somewhere else", () => {
    const { rooms, path: roomPath } = freshRoom();
    rooms.swapTo(null);
    expect(() => saveFileNode(rooms, roomPath, "x", "html", "create", "y", null, ref(), "c")).toThrow(ROOM_GONE);
  });

  it("calls notifyFilesChanged exactly once per write", () => {
    const { rooms, path: roomPath } = freshRoom();
    let calls = 0;
    saveFileNode(rooms, roomPath, "x", "html", "create", "y", null, ref(), "c", () => (calls += 1));
    expect(calls).toBe(1);
  });

  it("as a node: writes the file, stamps node_label/node_kind and records the file id", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "the body" });
    const step = makeStep(1, { id: "sv", label: "Save", kind: "save_file", name_template: "Out", format: "md", mode: "create" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    const { result, published } = await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    const artifact = loadWfArtifact(db, "job1", 1);
    expect(artifact?.node_label).toBe("Save");
    expect(artifact?.node_kind).toBe("save_file");
    expect(artifact?.file_id).toBe(published.value?.id);
    expect(getFileExtractedText(db, artifact?.file_id as string)).toBe("the body");
  });

  it("as a node: a Stop before this step refuses to write into the room at all", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const cancel = new CancelFlag();
    cancel.store(true);
    const step = makeStep(0, { id: "sv", label: "", kind: "save_file", name_template: "x", format: "md", mode: "create" });
    const { result, published } = await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step, cancel);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
    expect(published.value).toBeNull();
    expect(listFiles(db)).toHaveLength(0);
  });

  it("as a node: re-running an already-published step overwrites the SAME file id", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    const first = insertFile(db, "Out.md", "text/markdown", Buffer.from("v1"), "v1", "generated");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "Saved", file_id: first.id });
    const step = makeStep(0, { id: "sv", label: "", kind: "save_file", name_template: "Out", format: "md", mode: "create" });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 0)?.file_id).toBe(first.id);
    expect(listFiles(db)).toHaveLength(1);
  });
});

describe("executeWorkflowStep — file_pass (through the REAL filePass.ts runner)", () => {
  /** `driveFilePass`'s two sidecar endpoints, faked at its own documented
   * `post` seam so the real map → compose → publish pipeline runs. */
  const passPost: WorkflowStepDeps["post"] = async (endpoint, body) => {
    const b = body as Record<string, unknown>;
    if (endpoint === "/file_pass_map") {
      return { kind: "value", value: { result: `notes ${b.part as number}`, thread: "t", skipped: false } };
    }
    if (endpoint === "/file_pass_section") {
      return { kind: "value", value: { result: "<h2>A section</h2>", thread: "", skipped: false } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  it("reads the selected file end to end and publishes the pass page", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const text = "A short document about lighthouses. ".repeat(20);
    insertFile(db, "doc.txt", "text/plain", Buffer.from(text), text, "upload");
    const deps = baseDeps(rooms, { post: passPost, resolveEngine: async () => ({ model: "m", lane: "local_llm" }) });
    const step = makeStep(0, {
      id: "fp",
      label: "",
      kind: "file_pass",
      select: { type: "newest", pattern: null },
      instruction: "Summarize it.",
      mode: "merge",
    });
    const { result, published } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    expect(published.value?.name).toBe("Full pass — doc.txt.html");
    const artifact = loadWfArtifact(db, "job1", 0);
    expect(artifact?.file_id).toBe(published.value?.id);
    expect(artifact?.result).toContain('Saved a full pass of "doc.txt"');
  });

  it("names the one file it read when a narrowing selector matched several", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const text = "Body text. ".repeat(20);
    insertFile(db, "note-a.txt", "text/plain", Buffer.from(text), text, "upload");
    insertFile(db, "note-b.txt", "text/plain", Buffer.from(text), text, "upload");
    const deps = baseDeps(rooms, { post: passPost, resolveEngine: async () => ({ model: "m", lane: "local_llm" }) });
    const step = makeStep(0, {
      id: "fp",
      label: "",
      kind: "file_pass",
      select: { type: "name_like", pattern: "note-" },
      instruction: "",
      mode: "merge",
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    const out = loadWfArtifact(db, "job1", 0)?.result ?? "";
    expect(out).toContain("1 other matching file(s) were not read");
    expect(out).toContain('use a "for each file" step');
  });

  it("no matching file reports the honest empty line, never a fabricated pass", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const deps = baseDeps(rooms, { post: passPost, resolveEngine: async () => ({ model: "m", lane: "local_llm" }) });
    const step = makeStep(0, {
      id: "fp",
      label: "",
      kind: "file_pass",
      select: { type: "all", pattern: null },
      instruction: "",
      mode: "merge",
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("No file matched — nothing to read.");
  });

  it("with no engine resolver wired, refuses honestly rather than inventing a pass", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "doc.txt", "text/plain", Buffer.from("body"), "body", "upload");
    const step = makeStep(0, {
      id: "fp",
      label: "",
      kind: "file_pass",
      select: { type: "newest", pattern: null },
      instruction: "",
      mode: "merge",
    });
    const { result } = await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(errorOf(result)).toContain("NOT_IMPLEMENTED");
  });

  it("an already-published artifact (idempotent re-run) is reused verbatim, with no second pass", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "already done", file_id: "file-xyz" });
    let resolved = false;
    const deps = baseDeps(rooms, {
      resolveEngine: async () => {
        resolved = true;
        return { model: "m", lane: "local_llm" };
      },
    });
    const step = makeStep(0, {
      id: "fp",
      label: "",
      kind: "file_pass",
      select: { type: "newest", pattern: null },
      instruction: "",
      mode: "merge",
    });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    expect(resolved).toBe(false);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("already done");
  });
});

describe("executeWorkflowStep — script_run (through the REAL scriptRun.ts runner)", () => {
  const OK: ExecOut = { exitCode: 0, stdoutTail: "", stderrTail: "" };

  it("transform mode pipes the script's stdout as the artifact, and its stdin is {{input}}", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "piped in" });
    const bytes = Buffer.from("print(1)");
    const file = insertFile(db, "s.py", "text/x-python", bytes, "print(1)", "upload");
    let stdinSeen: string | null = null;
    const deps = baseDeps(rooms, {
      scriptExecute: async (_ws, _runner, _name, _timeout, _cancel, stdin) => {
        stdinSeen = stdin == null ? null : Buffer.from(stdin).toString("utf8");
        return { ...OK, stdoutTail: "hello from script" };
      },
    });
    const step = makeStep(1, { id: "sc", label: "", kind: "script_run", file: file.id, mode: "transform" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    const plan = makePlan({ script_consents: new Map([[file.id, scriptFingerprint(bytes)]]) });
    await runStep(deps, "job1", roomPath, plan, step);
    expect(loadWfArtifact(db, "job1", 1)?.result).toBe("hello from script");
    expect(stdinSeen).toBe("piped in");
  });

  it("import mode records the run report JSON", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const bytes = Buffer.from("print(1)");
    const file = insertFile(db, "s.py", "text/x-python", bytes, "print(1)", "upload");
    const deps = baseDeps(rooms, { scriptExecute: async () => ({ ...OK, stdoutTail: "noise" }) });
    const step = makeStep(0, { id: "sc", label: "", kind: "script_run", file: file.id, mode: "import" });
    const plan = makePlan({ script_consents: new Map([[file.id, scriptFingerprint(bytes)]]) });
    await runStep(deps, "job1", roomPath, plan, step);
    const parsed = JSON.parse(loadWfArtifact(db, "job1", 0)?.result ?? "{}") as Record<string, unknown>;
    expect(parsed.exitCode).toBe(0);
    expect(parsed.imported).toEqual([]);
  });

  it("consent stamped under a DIFFERENT id still matches byte-for-byte", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const bytes = Buffer.from("print(1)");
    const file = insertFile(db, "s.py", "text/x-python", bytes, "print(1)", "upload");
    const deps = baseDeps(rooms, { scriptExecute: async () => ({ ...OK, stdoutTail: "ran" }) });
    const step = makeStep(0, { id: "sc", label: "", kind: "script_run", file: file.id, mode: "transform" });
    // The id moved out from under the stamp, but the CONTENT hash is the same.
    const plan = makePlan({ script_consents: new Map([["some-older-id", scriptFingerprint(bytes)]]) });
    const { result } = await runStep(deps, "job1", roomPath, plan, step);
    expect(result).toEqual({ ok: true });
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("ran");
  });

  it("an unapproved script PARKS (NEEDS_APPROVAL), which is not the same as a failure", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const bytes = Buffer.from("print(1)");
    const file = insertFile(db, "s.py", "text/x-python", bytes, "print(1)", "upload");
    const deps = baseDeps(rooms, { scriptExecute: async () => OK });
    const step = makeStep(0, { id: "sc", label: "", kind: "script_run", file: file.id, mode: "import" });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(errorOf(result).startsWith(NEEDS_APPROVAL)).toBe(true);
  });

  it("a resumed job with an already-stored, non-skipped artifact does not re-run the script", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    const bytes = Buffer.from("print(1)");
    const file = insertFile(db, "s.py", "text/x-python", bytes, "print(1)", "upload");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "already ran" });
    let executed = false;
    const deps = baseDeps(rooms, {
      scriptExecute: async () => {
        executed = true;
        return OK;
      },
    });
    const step = makeStep(0, { id: "sc", label: "", kind: "script_run", file: file.id, mode: "import" });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(executed).toBe(false);
    expect(loadWfArtifact(db, "job1", 0)?.result).toBe("already ran");
  });
});

// ============================================================================
// the funnel every path reaches
// ============================================================================

describe("executeWorkflowStep — the one funnel that owns the diagram", () => {
  function events(): { emit: EmitFn; seen: Array<{ status: string; peek: string | null }> } {
    const seen: Array<{ status: string; peek: string | null }> = [];
    return {
      emit: (_event, payload) => {
        const p = payload as { status: string; peek: string | null };
        seen.push({ status: p.status, peek: p.peek });
      },
      seen,
    };
  }

  it("emits running then done, in order, with the result as the done peek", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "hi" });
    const { emit, seen } = events();
    const step = makeStep(1, { id: "t", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step);
    expect(seen).toEqual([
      { status: "running", peek: null },
      { status: "done", peek: "HI" },
    ]);
  });

  it("an empty result emits a null peek, never an empty-string one", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const { emit, seen } = events();
    const step = makeStep(0, { id: "t", label: "", kind: "transform", op: "trim", find: null, value: null });
    await runStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step);
    expect(seen[1]).toEqual({ status: "done", peek: null });
  });

  it("a skipped node emits `skipped`, not `done`", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, skipped: true });
    const { emit, seen } = events();
    const step = makeStep(1, { id: "t", label: "", kind: "transform", op: "upper", find: null, value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step);
    expect(seen.map((e) => e.status)).toEqual(["running", "skipped"]);
  });

  it("an unreadable step is reported WITHOUT emitting — there is no node id to emit against", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const { emit, seen } = events();
    const step: Step = {
      id: 0,
      lane: "cpu",
      kind: "workflow_node",
      params: { node: { kind: "bogus" }, model: null, incoming: [] },
      dependsOn: [],
    };
    const result = await executeWorkflowStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step, new CancelFlag(), ref());
    expect(result).toEqual({ ok: false, error: "this workflow step is unreadable" });
    expect(seen).toEqual([]);
  });

  it("a NEEDS_APPROVAL park is STRIPPED for the diagram but KEPT in the returned error", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const { emit, seen } = events();
    const deps = baseDeps(rooms, {
      emit,
      agentRun: () => Promise.reject(new Error(`${NEEDS_APPROVAL}the script needs approval`)),
    });
    const step = makeStep(0, { id: "a", label: "", kind: "agent_run", question: "q" });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: false, error: `${NEEDS_APPROVAL}the script needs approval` });
    expect(seen.find((e) => e.status === "error")?.peek).toBe("the script needs approval");
  });

  it("a Stop sentinel flows through unchanged, for a later park_outcome to classify", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const { emit, seen } = events();
    const cancel = new CancelFlag();
    cancel.store(true);
    const step = makeStep(0, { id: "h", label: "", kind: "http_fetch", url: "https://example.test/" });
    const { result } = await runStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step, cancel);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
    expect(seen.find((e) => e.status === "error")?.peek).toBe("STOPPED");
  });

  it("an empty-generation failure is humanized ONCE, here, for every node kind alike", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const deps = baseDeps(rooms, {
      agentRun: () => Promise.reject(new Error("No generation chunks were returned")),
    });
    const step = makeStep(0, { id: "a", label: "", kind: "agent_run", question: "q" });
    const { result } = await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(errorOf(result)).toContain("The AI model returned nothing.");
  });

  it("a room that closed mid-run surfaces as ROOM_GONE and still turns the box red", async () => {
    const { rooms, path: roomPath } = freshRoom();
    const { emit, seen } = events();
    rooms.swapTo(null);
    const step = makeStep(0, { id: "t", label: "", kind: "transform", op: "upper", find: null, value: null });
    const { result } = await runStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step);
    expect(errorOf(result)).toBe(ROOM_GONE);
    expect(seen.map((e) => e.status)).toEqual(["running", "error"]);
  });
});

// ============================================================================
// integration: a branching plan through jobs.ts's own runPlan
// ============================================================================

describe("integration: a branching workflow through runPlan + executeWorkflowStep", () => {
  it("seed -> gate(condition) -> hot|cold(dead) -> join(merge) -> out(save_file)", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    const nodes = {
      seed: { id: "seed", label: "", kind: "transform", op: "append", find: null, value: "alpha" },
      gate: { id: "gate", label: "", kind: "condition", op: "contains", value: "alpha" },
      hot: { id: "hot", label: "", kind: "transform", op: "append", find: null, value: " HOT" },
      cold: { id: "cold", label: "", kind: "transform", op: "append", find: null, value: " COLD" },
      join: { id: "join", label: "", kind: "merge", mode: "concat", separator: "||" },
      out: { id: "out", label: "", kind: "save_file", name_template: "wf-out", format: "md", mode: "create" },
    } satisfies Record<string, WorkflowNode>;
    const steps: Step[] = [
      makeStep(0, nodes.seed),
      makeStep(1, nodes.gate, { incoming: [{ parent: 0, branch: null }] }),
      makeStep(2, nodes.hot, { incoming: [{ parent: 1, branch: "then" }] }),
      makeStep(3, nodes.cold, { incoming: [{ parent: 1, branch: "else" }] }),
      makeStep(4, nodes.join, {
        incoming: [
          { parent: 2, branch: null },
          { parent: 3, branch: null },
        ],
      }),
      makeStep(5, nodes.out, { incoming: [{ parent: 4, branch: null }] }),
    ];

    const plan = makePlan({ steps });
    const deps = baseDeps(rooms);
    const published = ref();
    const outcome = await runPlan(
      steps,
      new Set(),
      new CancelFlag(),
      async (step) => executeWorkflowStep(deps, "job1", roomPath, plan, step, new CancelFlag(), published),
      () => {},
      () => {}
    );
    expect(outcome).toEqual({ kind: "done" });

    // The gate's OWN artifact result is the fixed sentence "branch: then" —
    // the taken BRANCH is what a downstream node reads, not the text that
    // decided it.
    expect(loadWfArtifact(db, "job1", 1)?.branch).toBe("then");
    expect(loadWfArtifact(db, "job1", 2)?.result).toBe("branch: then HOT");
    expect(loadWfArtifact(db, "job1", 3)?.skipped).toBe(true); // cold is dead
    expect(loadWfArtifact(db, "job1", 4)?.result).toBe("branch: then HOT"); // join saw only the live branch
    const savedId = loadWfArtifact(db, "job1", 5)?.file_id as string;
    expect(getFileExtractedText(db, savedId)).toBe("branch: then HOT");
    expect(published.value?.name).toBe("wf-out.md");
  });

  it("an html save_file's document is a real page, not a raw fragment", () => {
    // Guards the `htmlDocument` wiring the integration path relies on.
    const { rooms, db, path: roomPath } = freshRoom();
    const { fileId } = saveFileNode(rooms, roomPath, "Page", "html", "create", "<p>x</p>", null, ref(), "c");
    const text = getFileExtractedText(db, fileId) ?? "";
    expect(text).toBe(htmlDocument("Page.html", "<p>x</p>"));
  });
});

// ============================================================================
// ADVERSARIAL PASS — the six scenarios the review brief names, each driven
// against a REAL fixture room (or the real transport seam) rather than the
// pure function underneath it, because "does the property survive the whole
// dispatch path" is exactly what a unit-level assertion cannot show.
// ============================================================================

/** `created_at` defaults to a SECOND-resolution stamp, so two files inserted
 * in the same test share one and `ORDER BY created_at DESC` becomes a coin
 * flip. Every ordering assertion below stamps its rows by hand. */
function setCreatedAt(db: Database.Database, id: string, stamp: string): void {
  db.prepare("UPDATE files SET created_at = ? WHERE id = ?").run(stamp, id);
}

function trashFileRow(db: Database.Database, id: string): void {
  db.prepare("UPDATE files SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(id);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Captures the prompt of the single `/generate` POST a node makes. */
function capturingPost(sink: string[]): NonNullable<WorkflowStepDeps["post"]> {
  return async (_path, body) => {
    const messages = (body as { messages?: Array<{ content?: unknown }> }).messages ?? [];
    sink.push(typeof messages[0]?.content === "string" ? messages[0].content : "");
    return { kind: "value", value: { text: "ok" } };
  };
}

describe("adversarial: upstream model output cannot conjure a template placeholder", () => {
  /** A file name that is worth NOT leaking, so a failure reads as the privacy
   * fault it is rather than as a string mismatch. */
  const SECRET = "salary-review-2026.pdf";

  it("a generate node whose PARENT wrote {{files}} passes the marker on as literal text", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    insertFile(db, SECRET, "application/pdf", Buffer.from("x"), "x", "upload");
    storeWfArtifact(db, "job1", 0, {
      ...DEFAULT_WF_ARTIFACT,
      result: "The model wrote: {{files}} and {{date}}",
    });
    const prompts: string[] = [];
    const step = makeStep(1, { id: "g", label: "", kind: "generate", prompt: "Continue:\n{{input}}", model: "" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    const { result } = await runStep(baseDeps(rooms, { post: capturingPost(prompts) }), "job1", roomPath, makePlan(), step);
    expect(result).toEqual({ ok: true });
    expect(prompts[0]).toContain("{{files}}");
    expect(prompts[0]).toContain("{{date}}");
    expect(prompts[0], "the room's inventory must never ride in on upstream text").not.toContain(SECRET);
  });

  it("a template that carries {{files}} ITSELF expands exactly once — the input's copy stays literal", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    insertFile(db, SECRET, "application/pdf", Buffer.from("x"), "x", "upload");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "upstream said {{files}}" });
    const prompts: string[] = [];
    const step = makeStep(
      1,
      { id: "g", label: "", kind: "generate", prompt: "Inventory:\n{{files}}\n\nUpstream:\n{{input}}", model: "" },
      { incoming: [{ parent: 0, branch: null }] }
    );
    await runStep(baseDeps(rooms, { post: capturingPost(prompts) }), "job1", roomPath, makePlan(), step);
    // The AUTHOR's placeholder resolved; the one that arrived in model output
    // did not, and the inventory appears exactly once.
    expect(occurrences(prompts[0] ?? "", "{{files}}")).toBe(1);
    expect(occurrences(prompts[0] ?? "", `- ${SECRET}`)).toBe(1);
  });

  it("a save_file NAME template never pastes the inventory in from model text", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    insertFile(db, SECRET, "application/pdf", Buffer.from("x"), "x", "upload");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "{{files}}" });
    const step = makeStep(
      1,
      { id: "sv", label: "", kind: "save_file", name_template: "Digest {{input}}", format: "md", mode: "create" },
      { incoming: [{ parent: 0, branch: null }] }
    );
    const { published } = await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(published.value?.name).toBe("Digest {{files}}.md");
    expect(published.value?.name).not.toContain(SECRET);
  });

  it("an http_fetch URL never pastes the inventory in from model text", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    insertFile(db, SECRET, "application/pdf", Buffer.from("x"), "x", "upload");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "{{files}}" });
    let asked = "";
    const deps = baseDeps(rooms, {
      fetchPage: async (url) => {
        asked = url;
        return { title: "t", text: "b", finalUrl: url, status: 200 };
      },
    });
    const step = makeStep(1, { id: "h", label: "", kind: "http_fetch", url: "https://example.com/?q={{input}}" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), step);
    expect(asked).toBe("https://example.com/?q={{files}}");
    expect(asked, "a file inventory in an OUTBOUND url is a leak, not a prompt bug").not.toContain(SECRET);
  });

  it("for_each_file keeps an upstream {{files}} literal in every per-file prompt", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    insertFile(db, SECRET, "application/pdf", Buffer.from("body"), "body", "upload");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "{{files}}" });
    const prompts: string[] = [];
    const step = makeStep(
      1,
      { id: "fe", label: "", kind: "for_each_file", select: { type: "all", pattern: null }, instruction: "Do: {{input}}", model: "" },
      { incoming: [{ parent: 0, branch: null }] }
    );
    await runStep(baseDeps(rooms, { post: capturingPost(prompts) }), "job1", roomPath, makePlan(), step);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Do: {{files}}");
    // The file's own NAME is in the prompt (it is the file being read); the
    // INVENTORY line "- <name>: …" that {{files}} would have produced is not.
    expect(prompts[0]).not.toContain(`- ${SECRET}`);
  });
});

describe("adversarial: a node body cannot shadow a reserved /wf_node payload field", () => {
  /** Every reserved slot, spelled as a node body would if it ever carried
   * them — `model` first, because that is the one the sidecar keys the
   * privacy door and the Keychain provider credentials off. */
  const HOSTILE_BODY = JSON.stringify({
    model: "attacker/gpt-cloud",
    run_id: "someone-elses-run",
    kind: "exfiltrate",
    base_url: "http://evil.example",
    keep_alive: "0s",
    parallel: 64,
    prompt: "the real prompt",
  });

  it("wfNodeValue keeps the reserved values, and the run_id it registers for /cancel", async () => {
    let sentBody: Record<string, unknown> = {};
    let sentRunId = "";
    const post: WfNodePostFn = async (_p, body, _c, runId) => {
      sentBody = body as Record<string, unknown>;
      sentRunId = runId;
      return { kind: "value", value: { result: "ok" } };
    };
    const v = await wfNodeValue(
      post,
      "route",
      "the-rooms-model",
      "job9",
      3,
      "local_llm",
      JSON.parse(HOSTILE_BODY),
      new CancelFlag()
    );
    expect(v.result).toBe("ok");
    expect(sentBody.model).toBe("the-rooms-model");
    expect(sentBody.run_id).toBe("job9:3");
    expect(sentBody.kind).toBe("route");
    expect(sentBody.keep_alive).toBe("30m");
    expect(sentBody.parallel).toBe(1); // the LANE's slot count, not the body's 64
    expect(sentBody.base_url).not.toBe("http://evil.example");
    // The body's own non-reserved field still arrives.
    expect(sentBody.prompt).toBe("the real prompt");
    // A hijacked run_id would have pointed Stop's /cancel at another run.
    expect(sentRunId).toBe("job9:3");
  });

  it("the guard survives the JSON round-trip that is what actually goes on the wire", async () => {
    let wire = "";
    const post: WfNodePostFn = async (_p, body) => {
      wire = JSON.stringify(body);
      return { kind: "value", value: { result: "" } };
    };
    await wfNodeValue(post, "vote", "the-rooms-model", "j", 0, "cloud", JSON.parse(HOSTILE_BODY), new CancelFlag());
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(parsed.model).toBe("the-rooms-model");
    expect(parsed.run_id).toBe("j:0");
    expect(occurrences(wire, "attacker/gpt-cloud")).toBe(0);
  });

  it("a body key literally named __proto__ reaches the sidecar as data and pollutes nothing", async () => {
    let sentBody: Record<string, unknown> = {};
    const post: WfNodePostFn = async (_p, body) => {
      sentBody = body as Record<string, unknown>;
      return { kind: "value", value: { result: "" } };
    };
    // `JSON.parse` is the realistic carrier: an object LITERAL `{__proto__: …}`
    // sets the prototype instead of creating the own key this guards.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "model": "attacker", "context": "c"}') as unknown;
    await wfNodeValue(post, "extract", "real-model", "j", 1, "cpu", hostile, new CancelFlag());
    expect(({} as Record<string, unknown>).polluted, "Object.prototype must be untouched").toBeUndefined();
    expect(Object.getPrototypeOf(sentBody)).toBeNull();
    expect(sentBody.model).toBe("real-model");
    expect(sentBody.context).toBe("c");
    expect(JSON.stringify(sentBody)).toContain('"model":"real-model"');
  });
});

describe("adversarial: a name_like pattern is text the USER typed, never a wildcard", () => {
  const namesFor = (rooms: RoomSource, roomPath: string, pattern: string): string[] =>
    resolveFiles(rooms, roomPath, { type: "name_like", pattern }, null, null).map(([, n]) => n);

  it("% matches only a literal percent sign", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "50%off.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "50-off.txt", "text/plain", Buffer.from("b"), "b", "upload");
    insertFile(db, "500ff.txt", "text/plain", Buffer.from("c"), "c", "upload");
    expect(namesFor(rooms, roomPath, "50%off")).toEqual(["50%off.txt"]);
  });

  it("_ matches only a literal underscore", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "q3_report.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "q3-report.txt", "text/plain", Buffer.from("b"), "b", "upload");
    insertFile(db, "q3xreport.txt", "text/plain", Buffer.from("c"), "c", "upload");
    expect(namesFor(rooms, roomPath, "q3_report")).toEqual(["q3_report.txt"]);
  });

  it("a backslash matches only a literal backslash, and never breaks the ESCAPE clause", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "a\\b.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "axb.txt", "text/plain", Buffer.from("b"), "b", "upload");
    expect(namesFor(rooms, roomPath, "a\\b")).toEqual(["a\\b.txt"]);
    // A pattern ENDING in the escape character would be a malformed LIKE if it
    // were passed through raw; `likeEscape` doubles it, so this is a query, not
    // a SQLite error.
    expect(() => namesFor(rooms, roomPath, "a\\")).not.toThrow();
    expect(namesFor(rooms, roomPath, "a\\")).toEqual(["a\\b.txt"]);
  });

  it("a pattern of nothing but wildcards is not 'everything'", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "plain.txt", "text/plain", Buffer.from("a"), "a", "upload");
    insertFile(db, "100%.txt", "text/plain", Buffer.from("b"), "b", "upload");
    expect(namesFor(rooms, roomPath, "%")).toEqual(["100%.txt"]);
    expect(namesFor(rooms, roomPath, "_")).toEqual([]);
  });
});

describe("adversarial: the generated-file split, on ONE room that holds both", () => {
  it("since_last_run drops the workflow's own output; newest/all/name_like/missing_summary keep it", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const mine = insertFile(db, "meeting-notes.txt", "text/plain", Buffer.from("n"), "n", "upload");
    const made = insertFile(db, "meeting-digest.html", "text/html", Buffer.from("<p>d</p>"), "<p>d</p>", "generated");
    // The generated file is the NEWEST — the shape that once made `newest`
    // return nothing at all when it still excluded `source='generated'`.
    setCreatedAt(db, mine.id, "2026-01-01T00:00:00Z");
    setCreatedAt(db, made.id, "2026-06-01T00:00:00Z");
    const names = (kind: string, pattern: string | null = null): string[] =>
      resolveFiles(rooms, roomPath, { type: kind, pattern }, null, "2025-01-01T00:00:00Z").map(([, n]) => n);

    expect(names("newest"), "newest INCLUDES generated").toEqual(["meeting-digest.html"]);
    expect(names("all"), "all INCLUDES generated, newest first").toEqual([
      "meeting-digest.html",
      "meeting-notes.txt",
    ]);
    expect(names("name_like", "meeting")).toEqual(["meeting-digest.html", "meeting-notes.txt"]);
    expect(names("missing_summary")).toEqual(["meeting-digest.html", "meeting-notes.txt"]);
    // …and the ONE selector that drives scheduled re-runs excludes it, so a
    // workflow cannot re-ingest what it just wrote.
    expect(names("since_last_run"), "since_last_run EXCLUDES generated").toEqual(["meeting-notes.txt"]);
    expect(countNewFiles(rooms, roomPath, "2025-01-01T00:00:00Z")).toBe(1);
  });

  it("a room whose files are ALL generated: since_last_run finds nothing, newest still finds one", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    insertFile(db, "made.html", "text/html", Buffer.from("<p>x</p>"), "<p>x</p>", "generated");
    const sel = (kind: string) =>
      resolveFiles(rooms, roomPath, { type: kind, pattern: null }, null, "1970-01-01").map(([, n]) => n);
    expect(sel("since_last_run")).toEqual([]);
    expect(sel("newest")).toEqual(["made.html"]);
    expect(countNewFiles(rooms, roomPath, "1970-01-01")).toBe(0);
  });
});

describe("adversarial: condition / merge / transform fed empty or all-dead input", () => {
  it("all-dead: a condition node is SKIPPED and records no branch, so both branches die", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, skipped: true });
    const seen: Array<{ status: string; peek: unknown }> = [];
    const emit: EmitFn = (_e, payload) => {
      const p = payload as { status: string; peek: unknown };
      seen.push({ status: p.status, peek: p.peek });
    };
    const deps = baseDeps(rooms, { emit });
    const cond = makeStep(1, { id: "c", label: "Gate", kind: "condition", op: "is_empty", value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    expect((await runStep(deps, "job1", roomPath, makePlan(), cond)).result).toEqual({ ok: true });
    const a = loadWfArtifact(db, "job1", 1);
    expect(a?.skipped).toBe(true);
    // NOT "branch: then" — a skipped condition never evaluated `is_empty`
    // against the empty join, which would have taken a branch it never saw.
    expect(a?.result).toBe("");
    expect(a?.branch).toBeNull();
    expect(seen.map((s) => s.status)).toEqual(["running", "skipped"]);

    for (const [id, branch] of [
      [2, "then"],
      [3, "else"],
    ] as const) {
      const child = makeStep(id, { id: `k${id}`, label: "", kind: "transform", op: "upper", find: null, value: null }, {
        incoming: [{ parent: 1, branch }],
      });
      await runStep(deps, "job1", roomPath, makePlan(), child);
      expect(loadWfArtifact(db, "job1", id)?.skipped, `${branch} branch`).toBe(true);
    }
  });

  it("a ROOT node has no incoming edge at all, so it runs on empty input rather than being skipped", async () => {
    // The guard is `incoming.length > 0 && !livePresent`. Dropping the first
    // half would skip every root — the whole workflow — because a root has no
    // live parent BY DEFINITION.
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    const deps = baseDeps(rooms);
    const cond = makeStep(0, { id: "c", label: "", kind: "condition", op: "is_empty", value: null });
    expect((await runStep(deps, "job1", roomPath, makePlan(), cond)).result).toEqual({ ok: true });
    expect(loadWfArtifact(db, "job1", 0)).toMatchObject({ skipped: false, branch: "then" });

    const merge = makeStep(1, { id: "m", label: "", kind: "merge", mode: "concat", separator: "||" });
    await runStep(deps, "job1", roomPath, makePlan(), merge);
    expect(loadWfArtifact(db, "job1", 1)).toMatchObject({ skipped: false, result: "" });

    const xf = makeStep(2, { id: "t", label: "", kind: "transform", op: "prepend", find: null, value: "P" });
    await runStep(deps, "job1", roomPath, makePlan(), xf);
    expect(loadWfArtifact(db, "job1", 2)).toMatchObject({ skipped: false, result: "P" });
  });

  it("live-but-empty: the node RUNS, and is_empty reads the empty join as empty", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "" });
    const deps = baseDeps(rooms);
    const cond = makeStep(1, { id: "c", label: "", kind: "condition", op: "is_empty", value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), cond);
    expect(loadWfArtifact(db, "job1", 1)).toMatchObject({ skipped: false, result: "branch: then", branch: "then" });

    const notEmpty = makeStep(2, { id: "c2", label: "", kind: "condition", op: "not_empty", value: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(deps, "job1", roomPath, makePlan(), notEmpty);
    expect(loadWfArtifact(db, "job1", 2)?.branch).toBe("else");
  });

  it("a whitespace-only parent result is LIVE but contributes no input", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "   \n  " });
    const step = makeStep(1, { id: "t", label: "", kind: "transform", op: "append", find: null, value: "END" }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    const a = loadWfArtifact(db, "job1", 1);
    expect(a?.skipped, "a live parent, so this is not a dead subgraph").toBe(false);
    expect(a?.result, "…but its blank text is not joined in").toBe("END");
  });

  it("merge over zero live inputs is empty text, never '1. ' or a stray separator", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "" });
    const deps = baseDeps(rooms);
    for (const [id, mode] of [
      [1, "numbered"],
      [2, "dedupe_lines"],
      [3, "concat"],
    ] as const) {
      const step = makeStep(id, { id: `m${id}`, label: "", kind: "merge", mode, separator: "||" }, {
        incoming: [{ parent: 0, branch: null }],
      });
      await runStep(deps, "job1", roomPath, makePlan(), step);
      expect(loadWfArtifact(db, "job1", id)?.result, mode).toBe("");
    }
  });

  it("numbered merge skips an empty branch entirely rather than numbering a blank", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "" });
    storeWfArtifact(db, "job1", 1, { ...DEFAULT_WF_ARTIFACT, result: "real" });
    const step = makeStep(2, { id: "m", label: "", kind: "merge", mode: "numbered", separator: "\n" }, {
      incoming: [
        { parent: 0, branch: null },
        { parent: 1, branch: null },
      ],
    });
    await runStep(baseDeps(rooms), "job1", roomPath, makePlan(), step);
    expect(loadWfArtifact(db, "job1", 2)?.result).toBe("1. real");
  });

  it("a done node whose result is empty reports a NULL peek, never an empty bubble", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "" });
    const seen: Array<{ status: string; peek: unknown }> = [];
    const emit: EmitFn = (_e, payload) => {
      const p = payload as { status: string; peek: unknown };
      seen.push({ status: p.status, peek: p.peek });
    };
    const step = makeStep(1, { id: "m", label: "", kind: "merge", mode: "concat", separator: null }, {
      incoming: [{ parent: 0, branch: null }],
    });
    await runStep(baseDeps(rooms, { emit }), "job1", roomPath, makePlan(), step);
    expect(seen).toEqual([
      { status: "running", peek: null },
      { status: "done", peek: null },
    ]);
  });

  it("a transform on genuinely empty input is empty, for every op that could have thrown", async () => {
    const { rooms, db, path: roomPath } = freshRoom();
    ensureJobRow(db, "job1");
    storeWfArtifact(db, "job1", 0, { ...DEFAULT_WF_ARTIFACT, result: "" });
    const deps = baseDeps(rooms);
    const ops: Array<[number, string, string | null, string | null]> = [
      [1, "truncate", null, "5"],
      [2, "strip_html", null, null],
      [3, "replace", "a", "b"],
      [4, "trim", null, null],
      [5, "upper", null, null],
    ];
    for (const [id, op, find, value] of ops) {
      const step = makeStep(id, { id: `t${id}`, label: "", kind: "transform", op, find, value }, {
        incoming: [{ parent: 0, branch: null }],
      });
      expect((await runStep(deps, "job1", roomPath, makePlan(), step)).result, op).toEqual({ ok: true });
      expect(loadWfArtifact(db, "job1", id)?.result.trim(), op).toBe("");
    }
  });
});

describe("adversarial: save_file into a name that is already taken", () => {
  it("create mode does NOT reuse the name — a second file of that name is inserted", () => {
    // Rust's `db::insert_file` has no name-dedupe, and `create` never looks
    // for an existing row, so the room ends with two files of one name. Pinned
    // because "create quietly overwrote my page" and "create silently renamed
    // it" would both be behaviour changes from this line.
    const { rooms, db, path: roomPath } = freshRoom();
    const first = insertFile(db, "Report.html", "text/html", Buffer.from("<p>v1</p>"), "<p>v1</p>", "generated");
    const { fileId } = saveFileNode(rooms, roomPath, "Report", "html", "create", "<p>v2</p>", null, ref(), "c");
    expect(fileId).not.toBe(first.id);
    expect(listFiles(db).map((f) => f.name)).toEqual(["Report.html", "Report.html"]);
    expect(getFileExtractedText(db, first.id), "the first file is untouched").toBe("<p>v1</p>");
  });

  it("append mode refuses an UPLOADED file of the same name and starts its own", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const mine = insertFile(db, "Log.md", "text/markdown", Buffer.from("mine"), "mine", "upload");
    const { fileId } = saveFileNode(rooms, roomPath, "Log", "md", "append", "wf", null, ref(), "c");
    expect(fileId).not.toBe(mine.id);
    expect(getFileExtractedText(db, mine.id), "a user file is never appended to").toBe("mine");
    expect(getFileExtractedText(db, fileId)).toBe("wf");
  });

  it("overwrite mode ignores a TRASHED generated file of the same name", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const gone = insertFile(db, "Report.html", "text/html", Buffer.from("<p>old</p>"), "<p>old</p>", "generated");
    trashFileRow(db, gone.id);
    const { fileId } = saveFileNode(rooms, roomPath, "Report", "html", "overwrite", "<p>new</p>", null, ref(), "c");
    expect(fileId).not.toBe(gone.id);
    expect(
      db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(gone.id),
      "a trashed file is not resurrected by an overwrite"
    ).toEqual({ extracted_text: "<p>old</p>" });
  });

  it("overwrite mode picks the NEWEST generated file when two share the name", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const older = insertFile(db, "Report.html", "text/html", Buffer.from("<p>a</p>"), "<p>a</p>", "generated");
    const newer = insertFile(db, "Report.html", "text/html", Buffer.from("<p>b</p>"), "<p>b</p>", "generated");
    setCreatedAt(db, older.id, "2026-01-01T00:00:00Z");
    setCreatedAt(db, newer.id, "2026-06-01T00:00:00Z");
    const { fileId } = saveFileNode(rooms, roomPath, "Report", "html", "overwrite", "<p>c</p>", null, ref(), "c");
    expect(fileId).toBe(newer.id);
    expect(getFileExtractedText(db, older.id)).toBe("<p>a</p>");
  });

  it("an idempotent re-run of an APPEND node overwrites its recorded file instead of appending twice", () => {
    // The recorded `file_id` wins over `mode` in Rust, deliberately: a crash
    // between publish and checkpoint must not add the same block again.
    const { rooms, db, path: roomPath } = freshRoom();
    const prev = insertFile(db, "Log.md", "text/markdown", Buffer.from("one"), "one", "generated");
    const { fileId } = saveFileNode(
      rooms,
      roomPath,
      "Log",
      "md",
      "append",
      "two",
      { ...DEFAULT_WF_ARTIFACT, file_id: prev.id },
      ref(),
      "c"
    );
    expect(fileId).toBe(prev.id);
    expect(getFileExtractedText(db, prev.id)).toBe("two");
    expect(listFiles(db)).toHaveLength(1);
  });

  it("append into a generated file that is not a recognisable page wraps BOTH into one document", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const plain = insertFile(db, "Log.html", "text/html", Buffer.from("bare text"), "bare text", "generated");
    const { fileId } = saveFileNode(rooms, roomPath, "Log", "html", "append", "<p>next</p>", null, ref(), "c");
    expect(fileId).toBe(plain.id);
    const text = getFileExtractedText(db, fileId) ?? "";
    expect(text).toContain("bare text");
    expect(text).toContain("<p>next</p>");
    expect(occurrences(text.toLowerCase(), "<!doctype html>")).toBe(1);
  });

  it("every overwrite of a colliding name cuts a version first, so nothing is lost", () => {
    const { rooms, db, path: roomPath } = freshRoom();
    const first = insertFile(db, "Report.md", "text/markdown", Buffer.from("v1"), "v1", "generated");
    saveFileNode(rooms, roomPath, "Report", "md", "overwrite", "v2", null, ref(), "Workflow saved — T");
    const versions = db
      .prepare("SELECT count(*) AS n FROM file_versions WHERE file_id = ?")
      .get(first.id) as { n: number };
    expect(versions.n).toBeGreaterThanOrEqual(1);
    expect(getFileExtractedText(db, first.id)).toBe("v2");
  });
});

// keeps `FileMeta` referenced for the fixture types above
export type _PublishedMeta = FileMeta;
