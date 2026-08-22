/**
 * Behavioral tests for `execTool.ts`'s outer shell.
 *
 * The memory arms are tested against a REAL room (via `db-host/open.ts`'s
 * `createRoom`, this repo's established fixture convention — see
 * `db-host/memories.test.ts`), because the DB layer they depend on is
 * already fully ported and real behavior is reachable. Every other arm is
 * tested only for its STUB shape (never silent, never a thrown exception,
 * clearly labeled) since the subsystems behind them are out of scope.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { addMemory } from "./db-host/memories.js";
import { findSkill, listSkillResources, listSkills } from "./db-host/skills.js";
import { BUILTIN_TOOL_NAMES, type McpRoute } from "./toolSpecs.js";
import { builtinParamSchemas } from "./toolSchema.js";
import { scopedSpecs } from "./bridgeDispatcher.js";
import {
  createToolEffects,
  effectsJson,
  execTool,
  NAMED_ARM_TOOL_NAMES,
  type ExecToolDeps,
  type ToolEffects,
} from "./execTool.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "exec-tool-a-"));
  const roomPath = path.join(tmpDir, `t-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function deps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
  return { db: null, routes: [], ...overrides };
}

function effects(): ToolEffects {
  return createToolEffects();
}

// ----------------------------------------------------- the exhaustive coverage test

describe("exhaustive tool-arm coverage — the single most valuable test in this batch", () => {
  /**
   * Build arguments that satisfy `tool`'s advertised `required` list, so a
   * name can be DRIVEN through the real `execTool` switch instead of being
   * compared against a second hand-written list of arm names (which is the
   * thing that drifts). Values are the cheapest possible instance of each
   * declared JSON type — `missingRequiredArg` only asks whether something
   * meaningful was supplied.
   */
  function satisfyingArgs(tool: string): Record<string, unknown> {
    const schema = builtinParamSchemas().get(tool);
    const required = schema?.required;
    const props = (schema?.properties ?? {}) as Record<string, { type?: string }>;
    const out: Record<string, unknown> = {};
    if (!Array.isArray(required)) {
      return out;
    }
    for (const key of required) {
      if (typeof key !== "string") continue;
      switch (props[key]?.type) {
        case "integer":
        case "number":
          out[key] = 1;
          break;
        case "boolean":
          out[key] = true;
          break;
        case "array":
          out[key] = ["x"];
          break;
        case "object":
          out[key] = { k: 1 };
          break;
        default:
          out[key] = "x";
      }
    }
    return out;
  }

  it("EVERY name the tool catalog can produce reaches a named arm — driven through the real execTool, never a list-vs-list comparison", async () => {
    // The union of everything any scope can be served, plus the reserved
    // BUILTIN_TOOL_NAMES set, minus the MCP proxy pair (intercepted a layer
    // up in bridgeDispatcher.ts, and never reaching exec_tool in the Rust
    // source either).
    const catalogNames = new Set<string>([
      ...BUILTIN_TOOL_NAMES,
      ...scopedSpecs(true, { kind: "LocalEngine" }).map((t) => t.name),
      ...scopedSpecs(true, { kind: "ExternalAgent" }).map((t) => t.name),
      ...scopedSpecs(true, { kind: "CloudEngine" }).map((t) => t.name),
      ...scopedSpecs(true, { kind: "CloudAdvisor", includeMcp: true }).map((t) => t.name),
    ]);
    catalogNames.delete("search_mcp_tools");
    catalogNames.delete("run_mcp_tool");
    expect(catalogNames.size).toBeGreaterThan(60);

    for (const name of catalogNames) {
      const outcome = await execTool(name, satisfyingArgs(name), effects(), deps());
      // THE invariant: never the connector-route fallthrough. A stub's
      // NOT_IMPLEMENTED, a "No room is open.", or a real answer are all fine
      // — "Unknown tool" is not, because it means the switch has no arm and
      // the model is told the tool does not exist when the catalog just
      // offered it.
      const text = outcome.ok ? outcome.text : outcome.error;
      expect(text, `"${name}" fell through to the connector default`).not.toContain(
        `Unknown tool: ${name}`
      );
    }
  });

  it("a stubbed arm refuses loudly — NOT_IMPLEMENTED, naming its owner, never a fabricated success", async () => {
    const outcome = await execTool("start_file_pass", { name: "x", instruction: "y" }, effects(), deps());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toMatch(/^NOT_IMPLEMENTED: /);
  });

  it("NAMED_ARM_TOOL_NAMES is BUILTIN_TOOL_NAMES minus exactly the two proxy names", () => {
    expect(new Set(NAMED_ARM_TOOL_NAMES).size).toBe(NAMED_ARM_TOOL_NAMES.length);
    expect(NAMED_ARM_TOOL_NAMES).not.toContain("search_mcp_tools");
    expect(NAMED_ARM_TOOL_NAMES).not.toContain("run_mcp_tool");
    expect(NAMED_ARM_TOOL_NAMES.length).toBe(BUILTIN_TOOL_NAMES.length - 2);
  });

  it("a genuinely unknown name (no builtin arm, no matching connector route) is a real 'Unknown tool' error, never silent", async () => {
    const outcome = await execTool("totally_made_up_tool_xyz", {}, effects(), deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("Unknown tool: totally_made_up_tool_xyz");
    }
  });

  it("every stubbed arm returns a clearly-labeled NOT_IMPLEMENTED result, never throws, never silently succeeds", async () => {
    // Every arm that is NOT wired for real. Kept as an explicit list rather
    // than a predicate so that promoting an arm from stub to real is a
    // deliberate edit here — which is exactly the review moment you want.
    const REAL_ARMS = [
      "add_memory",
      "list_memories",
      "update_memory",
      "delete_memory",
      "list_skills",
      "read_skill",
      "read_skill_resource",
      "save_skill",
      "write_skill_resource",
      "delete_skill_resource",
      "list_room_files",
      "search_room",
      "open_file",
      "annotate_file",
    ];
    const stubbedNames = NAMED_ARM_TOOL_NAMES.filter((n) => !REAL_ARMS.includes(n));
    for (const name of stubbedNames) {
      // Arguments are DERIVED from each tool's own advertised schema, not a
      // hand-kept superset — the superset silently stopped covering browse_do
      // the moment the browse specs joined the table, and a
      // missing-required-arg error would have been mistaken for a stub.
      const args = satisfyingArgs(name);
      const outcome = await execTool(name, args, effects(), deps());
      expect(outcome.ok, `${name} should not report ok:true — nothing real ran`).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.startsWith("NOT_IMPLEMENTED:"), `${name}: ${outcome.error}`).toBe(true);
      }
    }
  });

  it("stubs never throw even with completely empty arguments (missingRequiredArg fires first, itself never a crash)", async () => {
    for (const name of NAMED_ARM_TOOL_NAMES) {
      await expect(execTool(name, {}, effects(), deps())).resolves.toBeDefined();
    }
  });
});

// --------------------------------------------------------------- missingRequiredArg gating

describe("missing-required-arg gating runs before dispatch, real arms and stubs alike", () => {
  it("a stubbed tool still reports its OWN missing-arg error, not the stub text", async () => {
    const outcome = await execTool("open_file", {}, effects(), deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("name is required");
      expect(outcome.error).not.toContain("NOT_IMPLEMENTED");
    }
  });
});

// --------------------------------------------------- execTool is TOTAL in `args`

describe("a malformed `arguments` value is answered, never thrown on", () => {
  /**
   * `exec_tool` in Rust holds `call.arguments` as a `serde_json::Value`, and
   * every arm reads it with `args["k"]` — TOTAL for a Value of any shape. The
   * JS analogue is not: `null["k"]` throws, and so does the
   * `hasOwnProperty.call(args, …)` inside the required-arg guard. That made
   * `execTool(name, null, …)` reject with a bare `TypeError: Cannot convert
   * undefined or null to object` for every tool with a required argument —
   * the exact "thrown exception that would crash the turn" this module's own
   * doc forbids.
   *
   * Not reachable through `bridgeDispatcher.ts` (which normalizes first, as
   * does `mcpBridge.ts` before it), but `execTool` is exported and the
   * consult_advisor arm's own doc names its other caller: "a native
   * (non-bridge) chat loop reaches THIS check and nothing else". That caller
   * has no normalizing door in front of it.
   */
  const MALFORMED: Array<[string, unknown]> = [
    ["a bare string", "not an object"],
    ["a JSON-encoded string", '{"name":"x"}'],
    ["an array", ["name", "x"]],
    ["a number", 42],
    ["zero", 0],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
  ];

  it("every named arm resolves rather than throwing, for every malformed shape", async () => {
    for (const name of NAMED_ARM_TOOL_NAMES) {
      for (const [label, bad] of MALFORMED) {
        await expect(
          execTool(name, bad as Record<string, unknown>, effects(), deps()),
          `${name} / ${label}`
        ).resolves.toBeDefined();
      }
    }
  });

  it("is read as 'supplied nothing', so a required argument is reported missing", async () => {
    for (const [label, bad] of MALFORMED) {
      const outcome = await execTool("open_file", bad as Record<string, unknown>, effects(), deps());
      expect(outcome.ok, label).toBe(false);
      expect(outcome.ok ? "" : outcome.error, label).toContain("name is required");
    }
  });

  it("a real arm with an OPEN room does not index into it either", async () => {
    // `list_skills` has no required list, so the guard above waves it through
    // and the arm itself reaches `args["agent"]`. With no room open it never
    // gets that far, which is why this case needs a live room to be a test at
    // all.
    const db = freshRoom();
    for (const [label, bad] of MALFORMED) {
      const outcome = await execTool("list_skills", bad as Record<string, unknown>, effects(), deps({ db }));
      expect(outcome.ok, label).toBe(true);
      expect(outcome.ok ? outcome.text : "", label).toBe("No skills are stored in this room yet.");
    }
  });
});

// --------------------------------------------------------------------------- memories

describe("add_memory (real, against a live room)", () => {
  it("saves a new memory and reports success", async () => {
    const db = freshRoom();
    const outcome = await execTool("add_memory", { content: "The client prefers email." }, effects(), deps({ db }));
    expect(outcome).toEqual({ ok: true, text: "Memory saved." });
  });

  it("refuses an exact duplicate rather than storing it twice", async () => {
    const db = freshRoom();
    await execTool("add_memory", { content: "Prefers dark mode." }, effects(), deps({ db }));
    const second = await execTool("add_memory", { content: "  prefers   DARK mode.  " }, effects(), deps({ db }));
    expect(second).toEqual({ ok: true, text: "Already remembered." });
  });

  it("refuses (never silently truncates) content over the character cap", async () => {
    const db = freshRoom();
    const huge = "x".repeat(600);
    const outcome = await execTool("add_memory", { content: huge }, effects(), deps({ db }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Memory too long");
    }
  });

  it("normalizes a valid category and drops an unrecognised one to uncategorized", async () => {
    const db = freshRoom();
    await execTool("add_memory", { content: "A", category: "Fact" }, effects(), deps({ db }));
    await execTool("add_memory", { content: "B", category: "not-a-real-category" }, effects(), deps({ db }));
    const listing = await execTool("list_memories", {}, effects(), deps({ db }));
    expect(listing.ok).toBe(true);
    if (listing.ok) {
      expect(listing.text).toContain("[fact] A");
      expect(listing.text).toContain("- B"); // no bracketed category
    }
  });

  it("emits memories-changed on success", async () => {
    const db = freshRoom();
    const emitted: Array<[string, unknown]> = [];
    await execTool(
      "add_memory",
      { content: "note" },
      effects(),
      deps({ db, emit: (e, p) => emitted.push([e, p]) })
    );
    expect(emitted).toEqual([["memories-changed", undefined]]);
  });

  it("does not let a throwing emit callback break the tool result", async () => {
    const db = freshRoom();
    const outcome = await execTool(
      "add_memory",
      { content: "note" },
      effects(),
      deps({
        db,
        emit: () => {
          throw new Error("window is gone");
        },
      })
    );
    expect(outcome).toEqual({ ok: true, text: "Memory saved." });
  });

  it("fails honestly when no room is open", async () => {
    const outcome = await execTool("add_memory", { content: "x" }, effects(), deps({ db: null }));
    expect(outcome).toEqual({ ok: false, error: "No room is open." });
  });
});

describe("list_memories (real)", () => {
  it("reports the empty-room notice", async () => {
    const db = freshRoom();
    const outcome = await execTool("list_memories", {}, effects(), deps({ db }));
    expect(outcome).toEqual({ ok: true, text: "No memories are saved in this room yet." });
  });

  it("lists saved memories in creation order", async () => {
    const db = freshRoom();
    addMemory(db, "first", null);
    addMemory(db, "second", "project");
    const outcome = await execTool("list_memories", {}, effects(), deps({ db }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe("- first\n- [project] second");
    }
  });
});

describe("update_memory / delete_memory (real)", () => {
  it("update_memory corrects the matched note and reports the old text", async () => {
    const db = freshRoom();
    addMemory(db, "old fact about the room", null);
    const outcome = await execTool(
      "update_memory",
      { find: "old fact", content: "corrected fact" },
      effects(),
      deps({ db })
    );
    expect(outcome).toEqual({ ok: true, text: "Updated. Was: old fact about the room" });
    const listing = await execTool("list_memories", {}, effects(), deps({ db }));
    expect(listing.ok && listing.text).toBe("- corrected fact");
  });

  it("delete_memory soft-deletes and reports what was forgotten", async () => {
    const db = freshRoom();
    addMemory(db, "forget this please", null);
    const outcome = await execTool("delete_memory", { find: "forget this" }, effects(), deps({ db }));
    expect(outcome).toEqual({ ok: true, text: "Forgot: forget this please" });
    const listing = await execTool("list_memories", {}, effects(), deps({ db }));
    expect(listing.ok && listing.text).toBe("No memories are saved in this room yet.");
  });

  it("neither verb guesses among several matches — it lists them and asks to narrow", async () => {
    const db = freshRoom();
    addMemory(db, "call the client on Monday", null);
    addMemory(db, "call the client about pricing", null);
    const outcome = await execTool("delete_memory", { find: "call the client" }, effects(), deps({ db }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("matches 2 notes");
      expect(outcome.text).toContain("call the client on Monday");
      expect(outcome.text).toContain("call the client about pricing");
    }
  });

  it("says plainly when nothing matches, rather than guessing", async () => {
    const db = freshRoom();
    const outcome = await execTool("update_memory", { find: "nonexistent", content: "x" }, effects(), deps({ db }));
    expect(outcome.ok && outcome.text).toContain('No memory contains "nonexistent"');
  });

  it("update_memory keeps the existing category when only correcting text", async () => {
    const db = freshRoom();
    addMemory(db, "a preference note", "preference");
    await execTool("update_memory", { find: "preference note", content: "an updated preference note" }, effects(), deps({ db }));
    const listing = await execTool("list_memories", {}, effects(), deps({ db }));
    expect(listing.ok && listing.text).toBe("- [preference] an updated preference note");
  });
});

// ------------------------------------------------------------------------ files
//
// The per-function behavior of these four arms — `closest_snippet` anchoring,
// A1 parsing, the >100-file overflow line, the two approximate-match notes —
// is exercised exhaustively against real fixture rooms in `fileTools.test.ts`.
// What is proved HERE is the DISPATCH side, which is what this edit to
// `execTool.ts` is: each name reaches the real arm (never `NOT_IMPLEMENTED`,
// never the `Unknown tool` fallthrough), the room is resolved once through
// `requireRoom`, `deps.emit` and `effects` really arrive, and with no room
// open each still refuses with the one sentence every other real arm uses.

describe("list_room_files / search_room / open_file / annotate_file (real, through execTool)", () => {
  it("list_room_files reaches the real arm: the empty-room notice, then a real listing", async () => {
    const db = freshRoom();
    expect(await execTool("list_room_files", {}, effects(), deps({ db }))).toEqual({
      ok: true,
      text: "The room has no files.",
    });
    insertFile(db, "notes.txt", "text/plain", Buffer.from("hello"), "hello", "user");
    expect(await execTool("list_room_files", {}, effects(), deps({ db }))).toEqual({
      ok: true,
      text: "- notes.txt (text/plain, 5 bytes)",
    });
  });

  it("search_room reaches the real retrieval layer and excerpts a real hit", async () => {
    const db = freshRoom();
    insertFile(
      db,
      "lease.pdf",
      "application/pdf",
      Buffer.from("x"),
      "The tenant shall pay a security deposit before moving in.",
      "user"
    );
    const outcome = await execTool("search_room", { query: "security deposit" }, effects(), deps({ db }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("[lease.pdf]");
      expect(outcome.text.toLowerCase()).toContain("security deposit");
    }
  });

  it("open_file reaches the real arm and its agent-open-file event carries deps.emit", async () => {
    const db = freshRoom();
    insertFile(db, "notes.txt", "text/plain", Buffer.from("hello world"), "hello world", "user");
    const emitted: Array<[string, unknown]> = [];
    const outcome = await execTool(
      "open_file",
      { name: "notes" },
      effects(),
      deps({ db, emit: (e, p) => emitted.push([e, p]) })
    );
    expect(outcome).toEqual({
      ok: true,
      text: 'Opened "notes.txt" in the viewer.\nIt begins:\nhello world',
    });
    expect(emitted).toEqual([
      ["agent-open-file", { id: expect.any(String), page: null, cell: null, find: null }],
    ]);
  });

  it("annotate_file reaches the real arm, writes THIS turn's effects.annotation, and emits", async () => {
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("x"), "No pets are allowed here.", "user");
    const eff = effects();
    const emitted: Array<[string, unknown]> = [];
    const outcome = await execTool(
      "annotate_file",
      { name: "lease", text: "no pets are allowed" },
      eff,
      deps({ db, emit: (e, p) => emitted.push([e, p]) })
    );
    expect(outcome).toEqual({
      ok: true,
      text: 'Sent the viewer to "no pets are allowed" in "lease.pdf".',
    });
    // ADD-23 reads this back out of the same struct — a fake success that
    // never set it would still print the sentence above.
    expect(effectsJson(eff)).toEqual({ annotation: eff.annotation });
    expect(emitted).toEqual([["agent-annotate", eff.annotation]]);
  });

  it("all four resolve to a real answer, never NOT_IMPLEMENTED and never Unknown tool", async () => {
    const db = freshRoom();
    insertFile(
      db,
      "lease.pdf",
      "application/pdf",
      Buffer.from("x"),
      "No pets are allowed on the premises.",
      "user"
    );
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_room_files", {}],
      ["search_room", { query: "pets" }],
      ["open_file", { name: "lease" }],
      ["annotate_file", { name: "lease", text: "no pets are allowed" }],
    ];
    for (const [name, args] of calls) {
      const outcome = await execTool(name, args, effects(), deps({ db }));
      const text = outcome.ok ? outcome.text : outcome.error;
      expect(outcome.ok, `${name}: ${text}`).toBe(true);
      expect(text).not.toContain("NOT_IMPLEMENTED");
      expect(text).not.toContain("Unknown tool");
    }
  });

  it("every one of the four refuses honestly with no room open — not a stub, not a crash", async () => {
    for (const [name, args] of [
      ["list_room_files", {}],
      ["search_room", { query: "x" }],
      ["open_file", { name: "x" }],
      ["annotate_file", { name: "x", text: "x" }],
    ] as const) {
      const outcome = await execTool(name, args, effects(), deps({ db: null }));
      expect(outcome, name).toEqual({ ok: false, error: "No room is open." });
    }
  });
});

// -------------------------------------------------------------------- connector fallback

describe("the default arm (connector routes)", () => {
  // LOCAL by default: "Local connectors run on this Mac and are exempt" from
  // the outbound masking seam, so this fixture exercises the dispatch path
  // itself. The remote fixture below exercises the two doors.
  const route: McpRoute = {
    catalogName: "acme_lookup_customer",
    toolName: "lookup_customer",
    serverName: "acme",
    remote: false,
    spec: {
      type: "function",
      function: { name: "acme_lookup_customer", description: "d", parameters: { type: "object", properties: {} } },
    },
  };
  const remoteRoute: McpRoute = { ...route, remote: true };

  it("REFUSES a remote connector when the outbound masking seam is not ported — never sends real values instead", async () => {
    // The whole point: "we cannot mask" must not degrade to "so send it
    // unmasked". A refusal is the only safe reading of a missing privacy door.
    const outcome = await execTool(
      "acme_lookup_customer",
      { name: "Dana Cohen" },
      effects(),
      deps({
        routes: [remoteRoute],
        callConnectorTool: async () => ({ text: "should never run" }),
        connectorApproved: async () => true,
      })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("nothing left this room");
  });

  it("sends a remote connector MASKED arguments and restores the reply, reporting what was hidden", async () => {
    let sent: unknown;
    const outcome = await execTool(
      "acme_lookup_customer",
      { name: "Dana Cohen" },
      effects(),
      deps({
        routes: [remoteRoute],
        connectorApproved: async () => true,
        remoteSeam: {
          redactValue: () => ({ value: { name: "[Person A]" }, entitiesHidden: 1 }),
          restore: (t) => t.replace("[Person A]", "Dana Cohen"),
        },
        callConnectorTool: async (_r, args) => {
          sent = args;
          return { text: `found [Person A]` };
        },
      })
    );
    expect(sent).toEqual({ name: "[Person A]" });
    expect(outcome.ok).toBe(true);
    // Restored on the way home…
    expect(outcome.ok ? outcome.text : "").toContain("found Dana Cohen");
    // …and the masking that actually FIRED leaves a trace, so an empty or
    // off-target answer is explainable rather than looking like the connector
    // failing.
    expect(outcome.ok ? outcome.text : "").toContain("hid 1 protected value");
  });

  it("REFUSES when the SEC-1b consent gate is not ported, rather than running a connector ungated", async () => {
    const outcome = await execTool(
      "acme_lookup_customer",
      {},
      effects(),
      deps({ routes: [route], callConnectorTool: async () => ({ text: "should never run" }) })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("mcp_call_approved");
  });

  it("a declined consent is a normal result telling the model nothing left the room — not an error", async () => {
    const outcome = await execTool(
      "acme_lookup_customer",
      {},
      effects(),
      deps({
        routes: [route],
        connectorApproved: async () => false,
        callConnectorTool: async () => ({ text: "should never run" }),
      })
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.text : "").toContain("The user declined to run");
  });

  it("is NOT_IMPLEMENTED when no real connector-call function is injected", async () => {
    const outcome = await execTool("acme_lookup_customer", {}, effects(), deps({ routes: [route] }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("NOT_IMPLEMENTED");
      expect(outcome.error).toContain("acme_lookup_customer");
    }
  });

  it("calls the injected connector function for real when one is provided", async () => {
    const outcome = await execTool(
      "acme_lookup_customer",
      { id: "42" },
      effects(),
      deps({
        routes: [route],
        callConnectorTool: async (r, args) => ({ text: `looked up ${JSON.stringify(args)} via ${r.serverName}` }),
        connectorApproved: async () => true,
      })
    );
    expect(outcome).toEqual({ ok: true, text: 'looked up {"id":"42"} via acme' });
  });

  it("turns a connector call's rejection into a tool failure, not a crash", async () => {
    const outcome = await execTool(
      "acme_lookup_customer",
      {},
      effects(),
      deps({
        routes: [route],
        callConnectorTool: async () => {
          throw new Error("connector timed out");
        },
        connectorApproved: async () => true,
      })
    );
    expect(outcome).toEqual({ ok: false, error: "connector timed out" });
  });

  it("an unmatched name that is also not a route is a real Unknown-tool error", async () => {
    const outcome = await execTool("not_a_route_either", {}, effects(), deps({ routes: [route] }));
    expect(outcome).toEqual({ ok: false, error: "Unknown tool: not_a_route_either" });
  });
});

// ------------------------------------------------------------------------------- effectsJson

describe("effectsJson", () => {
  it("is null when nothing worth persisting fired", () => {
    expect(effectsJson(createToolEffects())).toBeNull();
  });

  it("includes only the keys that actually fired", () => {
    const e = createToolEffects();
    e.annotation = { foo: "bar" };
    expect(effectsJson(e)).toEqual({ annotation: { foo: "bar" } });
  });

  it("assembles every populated field under its own key", () => {
    const e = createToolEffects();
    e.boxes = { x: 1 };
    e.annotation = { y: 2 };
    e.editOutcomes = [{ tool: "edit_file", outcome: "exact", n: 1 }];
    e.tokenUsage = { used: 10 };
    e.agentPlan = [{ agent: "chat.web" }];
    expect(effectsJson(e)).toEqual({
      boxes: { x: 1 },
      annotation: { y: 2 },
      edits: [{ tool: "edit_file", outcome: "exact", n: 1 }],
      usage: { used: 10 },
      agents: [{ agent: "chat.web" }],
    });
  });
});

// ============================================ REAL skill arms (candidate B's)

describe("list_skills / read_skill / read_skill_resource", () => {
  it("list_skills distinguishes an empty room from a room with skills none of which are the caller's", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    const empty = await execTool("list_skills", {}, effects(), ctx);
    expect(empty).toEqual({ ok: true, text: "No skills are stored in this room yet." });

    room.exec(
      `INSERT INTO skills(id, name, description, instructions, enabled, created_by, agent)
       VALUES ('s1','review','Review docs','Do the review', 1, 'user', 'chat.web')`
    );
    const notMine = await execTool("list_skills", { agent: "app.ui" }, effects(), ctx);
    expect(notMine).toEqual({ ok: true, text: "No skills are assigned to you yet." });

    const mine = await execTool("list_skills", { agent: "chat.web" }, effects(), ctx);
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.text).toContain("review");
      expect(mine.text).toContain("(yours)");
      expect(mine.text).toContain("[enabled]");
    }

    const general = await execTool("list_skills", {}, effects(), ctx);
    expect(general.ok).toBe(true);
    if (general.ok) expect(general.text).not.toContain("(yours)"); // no caller supplied
  });

  it("read_skill renders status/description/instructions and the resource tree, or a clear miss", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    const missing = await execTool("read_skill", { skill: "nope" }, effects(), ctx);
    expect(missing).toEqual({ ok: false, error: 'No skill named "nope" exists.' });

    room.exec(
      `INSERT INTO skills(id, name, description, instructions, enabled, created_by, agent)
       VALUES ('s1','review','Review docs','Do the review', 0, 'agent', '')`
    );
    room.exec(
      `INSERT INTO skill_resources(id, skill_id, path, kind, content) VALUES ('r1','s1','references/policy.md','reference', 'be nice')`
    );
    const result = await execTool("read_skill", { skill: "review" }, effects(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("# Skill: review");
      expect(result.text).toContain("Status: disabled draft");
      expect(result.text).toContain("Do the review");
      expect(result.text).toContain("- references/policy.md (reference)");
    }
  });

  it("read_skill_resource rejects a traversal/absolute/SKILL.md path before touching the DB", async () => {
    const ctx = deps();
    for (const bad of ["../etc/passwd", "/etc/passwd", "a/../b", "SKILL.md", "a/"]) {
      const result = await execTool("read_skill_resource", { skill: "x", path: bad }, effects(), ctx);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("read_skill_resource returns the text, or a clear error for a binary/missing resource", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    room.exec(
      `INSERT INTO skills(id, name, description, instructions, enabled, created_by, agent)
       VALUES ('s1','review','d','i', 1, 'user', '')`
    );
    room
      .prepare("INSERT INTO skill_resources(id, skill_id, path, kind, content) VALUES (?,?,?,?,?)")
      .run("r1", "s1", "references/x.md", "reference", Buffer.from("hello there", "utf8"));
    const ok = await execTool("read_skill_resource", { skill: "review", path: "references/x.md" }, effects(), ctx);
    expect(ok).toEqual({ ok: true, text: "hello there" });

    room
      .prepare("INSERT INTO skill_resources(id, skill_id, path, kind, content) VALUES (?,?,?,?,?)")
      .run("r2", "s1", "assets/img.bin", "asset", Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const binary = await execTool("read_skill_resource", { skill: "review", path: "assets/img.bin" }, effects(), ctx);
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.error).toContain("binary");

    const missingResource = await execTool("read_skill_resource", { skill: "review", path: "references/nope.md" }, effects(), ctx);
    expect(missingResource.ok).toBe(false);
  });
});

describe("save_skill", () => {
  it("creates a new skill as a disabled draft", async () => {
    const room = freshRoom();
    const events: Array<[string, unknown]> = [];
    const ctx = deps({ db: room, emit: (e, p) => events.push([e, p]) });
    const result = await execTool("save_skill", { name: "My Skill", description: "does things", instructions: "do them" }, effects(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('Created skill "my-skill"');
    const skill = findSkill(room, "my-skill");
    expect(skill).not.toBeNull();
    expect(skill?.enabled).toBe(false);
    expect(events).toEqual([["skills-changed", undefined]]);
  });

  it("updates an existing skill, keeping its agent binding when none is supplied", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    await execTool("save_skill", { name: "review", description: "d1", instructions: "i1", agent: "chat.web" }, effects(), ctx);
    const result = await execTool("save_skill", { name: "review", description: "d2", instructions: "i2" }, effects(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('Updated skill "review"');
    const skill = findSkill(room, "review")!;
    expect(skill.description).toBe("d2");
    expect(skill.agent).toBe("chat.web"); // untouched
  });

  it("rejects an agent id outside SKILL_AGENT_IDS without writing anything", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    const result = await execTool("save_skill", { name: "x", description: "d", instructions: "i", agent: "not.a.real.agent" }, effects(), ctx);
    expect(result.ok).toBe(false);
    expect(listSkills(room, false)).toEqual([]);
  });

  it("reports NOT_IMPLEMENTED for source_files, without writing anything", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    const result = await execTool("save_skill", { name: "x", description: "d", instructions: "i", source_files: ["notes.md"] }, effects(), ctx);
    expect(result.ok).toBe(false);
    // The merged convention is A's machine-readable `NOT_IMPLEMENTED:` prefix
    // (the exhaustive coverage test keys off it), naming the owning batch.
    if (!result.ok) {
      expect(result.error).toMatch(/^NOT_IMPLEMENTED: /);
      expect(result.error).toContain("files.ts");
    }
    // Genuinely partial, and the partiality must not leak: a save that
    // refused half-way would leave a draft the user never asked for.
    expect(listSkills(room, false)).toEqual([]);
  });

  it("validates fields (empty description) before touching the room", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    const result = await execTool("save_skill", { name: "x", description: "  ", instructions: "i" }, effects(), ctx);
    expect(result.ok).toBe(false);
    expect(listSkills(room, false)).toEqual([]);
  });
});

describe("write_skill_resource / delete_skill_resource", () => {
  it("write_skill_resource saves the resource and disables the skill for review", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    await execTool("save_skill", { name: "review", description: "d", instructions: "i" }, effects(), ctx);
    // Enable it first, so we can observe write_skill_resource disabling it again.
    room.prepare("UPDATE skills SET enabled = 1 WHERE name = 'review'").run();
    const result = await execTool("write_skill_resource", { skill: "review", path: "references/policy.md", content: "be nice" }, effects(), ctx);
    expect(result.ok).toBe(true);
    const skill = findSkill(room, "review")!;
    expect(skill.enabled).toBe(false);
    const resources = listSkillResources(room, skill.id);
    expect(resources).toHaveLength(1);
    expect(resources[0]!.path).toBe("references/policy.md");
  });

  it("write_skill_resource refuses a file/folder name collision", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    await execTool("save_skill", { name: "review", description: "d", instructions: "i" }, effects(), ctx);
    await execTool("write_skill_resource", { skill: "review", path: "references", content: "x" }, effects(), ctx);
    const result = await execTool("write_skill_resource", { skill: "review", path: "references/child.md", content: "x" }, effects(), ctx);
    expect(result.ok).toBe(false);
  });

  it("delete_skill_resource removes a resource, and refuses one that was never there", async () => {
    const room = freshRoom();
    const ctx = deps({ db: room });
    await execTool("save_skill", { name: "review", description: "d", instructions: "i" }, effects(), ctx);
    await execTool("write_skill_resource", { skill: "review", path: "references/policy.md", content: "x" }, effects(), ctx);
    const ok = await execTool("delete_skill_resource", { skill: "review", path: "references/policy.md" }, effects(), ctx);
    expect(ok.ok).toBe(true);
    const again = await execTool("delete_skill_resource", { skill: "review", path: "references/policy.md" }, effects(), ctx);
    expect(again.ok).toBe(false);
  });
});


// ================================================= REAL consult_advisor arm

describe("consult_advisor", () => {
  it("refuses rather than fabricating an advisor's answer when no CLI seam is injected — and does NOT spend the budget", async () => {
    const e = effects();
    const outcome = await execTool("consult_advisor", { question: "what now?" }, e, deps());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("NOT_IMPLEMENTED");
    // A refusal that cost nothing must not also cost the turn's only consult.
    expect(e.advisorCalls).toBe(0);
  });

  it("spends the budget, runs the chosen CLI, and formats the reply", async () => {
    const e = effects();
    let seen: [string, string] | null = null;
    const outcome = await execTool(
      "consult_advisor",
      { question: "  what now?  ", advisor: "codex" },
      e,
      deps({
        runAdvisorCli: async (engine, question) => {
          seen = [engine, question];
          return "do the thing";
        },
      })
    );
    expect(seen).toEqual(["codex-cli", "what now?"]);
    expect(e.advisorCalls).toBe(1);
    expect(outcome).toEqual({ ok: true, text: "Advisor (codex) replied:\n\ndo the thing" });
  });

  it("defaults to claude-cli when no advisor is named", async () => {
    let engine = "";
    await execTool(
      "consult_advisor",
      { question: "q" },
      effects(),
      deps({ runAdvisorCli: async (e) => { engine = e; return "a"; } })
    );
    expect(engine).toBe("claude-cli");
  });

  it("re-checks the budget itself — a second consult on the same effects is refused as a NORMAL result", async () => {
    // This is exec_tool's OWN cap, separate from the AdvisorRuntime cap in
    // bridgeDispatcher.ts: a native (non-bridge) chat loop reaches only this
    // one, so it is not redundant.
    const e = effects();
    const d = deps({ runAdvisorCli: async () => "first answer" });
    await execTool("consult_advisor", { question: "q" }, e, d);
    const second = await execTool("consult_advisor", { question: "q" }, e, d);
    expect(second.ok).toBe(true);
    expect(second.ok ? second.text : "").toContain("already consulted an advisor this turn");
  });

  it("a CLI that fails comes back as Ok, so the local model recovers by answering itself", async () => {
    const outcome = await execTool(
      "consult_advisor",
      { question: "q" },
      effects(),
      deps({
        runAdvisorCli: async () => {
          throw new Error("claude not found");
        },
      })
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.text : "").toContain("The advisor could not be reached (claude not found)");
  });
});
