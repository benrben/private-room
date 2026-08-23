/**
 * Tests for `moonshotRoles.ts` — ported from `src-tauri/src/commands/moonshot/
 * roles.rs`. Section 1 mirrors the Rust source's own `#[cfg(test)] mod tests`
 * one for one (`list_roles_static_catalog`, `role_instructions_looks_up_
 * persona_or_empty`); the rest covers what a `#[cfg(test)]` fixture on a pure
 * static catalog does not need to: the exact wire shape, that every call
 * returns fresh (non-aliased) arrays, the IPC registration, and — because this
 * module documents itself as the canonical replacement for a narrower copy
 * that landed first — that `turnContext.ts`'s own `roleInstructions` cannot
 * silently drift out of step with this one.
 */

import { describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { listRoles, registerRolesIpc, roleInstructions, type RoomRole } from "./moonshotRoles.js";
import { roleInstructions as turnContextRoleInstructions } from "./turnContext.js";

// ============================================================================
// Section 1 — ports of roles.rs's own #[cfg(test)] fixtures.
// ============================================================================

describe("listRoles (ported from list_roles_static_catalog)", () => {
  it("carries the five personas the UI offers, apply-by-setting only", () => {
    const roles = listRoles();
    const ids = roles.map((r) => r.id);
    for (const want of ["default", "tutor", "critic", "opposing-counsel", "scribe"]) {
      expect(ids, `missing role ${want}`).toContain(want);
    }
    // A persona injects instructions; the plain default injects nothing.
    const tutor = roles.find((r) => r.id === "tutor")!;
    expect(tutor.instructions).not.toBe("");
    const def = roles.find((r) => r.id === "default")!;
    expect(def.instructions).toBe("");
  });
});

describe("roleInstructions (ported from role_instructions_looks_up_persona_or_empty)", () => {
  it("looks up a persona's instructions, or answers empty for default/unknown", () => {
    expect(roleInstructions("tutor")).toContain("patient tutor");
    expect(roleInstructions("default")).toBe("");
    expect(roleInstructions("no-such-role")).toBe("");
  });
});

// ============================================================================
// Section 2 — exact catalog fidelity (every field, checked against the Rust
// source character for character, not just "non-empty").
// ============================================================================

describe("listRoles — full catalog fidelity", () => {
  const EXPECTED: RoomRole[] = [
    {
      id: "default",
      name: "Assistant",
      blurb: "A calm, careful helper grounded in your files.",
      instructions: "",
      prompts: ["Summarize this room", "What should I look at first?"],
      commands: ["summarize", "find"],
    },
    {
      id: "tutor",
      name: "Tutor",
      blurb: "Explains patiently and checks your understanding.",
      instructions:
        "You are a patient tutor. Explain concepts step by step in plain language, check " +
        "understanding with short questions, and ground every explanation in the room's files.",
      prompts: ["Teach me the key ideas in this room", "Quiz me on @file", "Explain @file like I'm new to it"],
      commands: ["summarize", "research"],
    },
    {
      id: "critic",
      name: "Critic",
      blurb: "Pushes back and finds the weak points.",
      instructions:
        "You are a sharp but fair critic. Point out weaknesses, unstated assumptions, and gaps, " +
        "and suggest concrete improvements — always grounded in the room's files, never harsh " +
        "for its own sake.",
      prompts: ["What's weak about @file?", "Poke holes in this argument"],
      commands: ["compare", "find"],
    },
    {
      id: "opposing-counsel",
      name: "Opposing counsel",
      blurb: "Argues the other side to stress-test your case.",
      instructions:
        "You act as opposing counsel. Make the strongest good-faith case AGAINST the user's " +
        "position, cite the room's documents for every point, and flag the risks they would " +
        "face — so they can prepare. You are not their lawyer and give no legal advice.",
      prompts: ["Argue against @contract", "Where is my case weakest?"],
      commands: ["compare", "extract"],
    },
    {
      id: "scribe",
      name: "Scribe",
      blurb: "Turns discussion into tidy notes and minutes.",
      instructions:
        "You are a meticulous scribe. Capture decisions, action items, and open questions in " +
        "clean, well-structured notes, using only what the room's files and this conversation " +
        "contain.",
      prompts: ["Take minutes from @recording", "Write up what we decided"],
      commands: ["minutes", "to-sheet"],
    },
  ];

  it("matches the Rust source's five roles, in order, field for field", () => {
    expect(listRoles()).toEqual(EXPECTED);
  });

  it("carries exactly the six camelCase fields RoomRole's #[serde(rename_all)] produces", () => {
    for (const r of listRoles()) {
      expect(Object.keys(r).sort()).toEqual(
        ["blurb", "commands", "id", "instructions", "name", "prompts"].sort()
      );
    }
  });

  it("JSON round-trips to the exact shape an IPC caller reads (no dropped/renamed fields)", () => {
    const wire = JSON.parse(JSON.stringify(listRoles()[1]));
    expect(wire).toEqual(EXPECTED[1]);
  });

  it("returns freshly built arrays every call — mutating one call's result cannot taint another's", () => {
    const first = listRoles();
    first[1]!.prompts.push("mutated");
    first[1]!.commands.push("mutated");
    const second = listRoles();
    expect(second[1]!.prompts).not.toContain("mutated");
    expect(second[1]!.commands).not.toContain("mutated");
    expect(second[1]!.prompts).toEqual(EXPECTED[1]!.prompts);
  });

  it("roleInstructions derives from the SAME catalog listRoles returns, not a second table", () => {
    for (const r of listRoles()) {
      expect(roleInstructions(r.id)).toBe(r.instructions);
    }
  });
});

// ============================================================================
// Section 3 — the turnContext.ts overlap: two implementations of the same
// Rust function must never silently disagree.
// ============================================================================

describe("roleInstructions vs. turnContext.ts's own narrowed copy", () => {
  it("agree for every catalog id, plus an id neither one knows", () => {
    for (const id of [...listRoles().map((r) => r.id), "no-such-role", ""]) {
      expect(roleInstructions(id), id).toBe(turnContextRoleInstructions(id));
    }
  });
});

// ============================================================================
// Section 4 — IPC registration, per recIpc.ts's precedent (NOT wired into any
// bootstrap file).
// ============================================================================

describe("registerRolesIpc", () => {
  function fakeIpcMain(): {
    ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void };
    call: (channel: string) => unknown;
  } {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    return {
      ipcMain: {
        handle: (channel, fn) => {
          handlers.set(channel, fn);
        },
      },
      call: (channel) => {
        const fn = handlers.get(channel);
        if (fn === undefined) throw new Error(`no handler registered for ${channel}`);
        return fn(undefined as unknown as IpcMainInvokeEvent);
      },
    };
  }

  it("registers list_roles and answers the full catalog with no room open", () => {
    const { ipcMain, call } = fakeIpcMain();
    registerRolesIpc(ipcMain);
    expect(call("list_roles")).toEqual(listRoles());
  });

  it("registers exactly one channel", () => {
    const handle = vi.fn();
    registerRolesIpc({ handle });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("list_roles");
  });
});

// ============================================================================
// ADVERSARIAL
// ============================================================================

describe("roles — adversarial", () => {
  it("an Object.prototype key is not a role, and cannot borrow one's instructions", () => {
    // Rust's `list_roles().into_iter().find(|r| r.id == id)` is a linear scan
    // over a Vec — there is no map to index, so no key can be inherited. A
    // port that had reached for `ROLE_INSTRUCTIONS[id]` on a plain `{}` would
    // answer `"function Object() { [native code] }"` for `"constructor"` and
    // splice it into the system prompt of every turn in the room.
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(roleInstructions(id)).toBe("");
      expect(listRoles().some((r) => r.id === id)).toBe(false);
    }
  });

  it("each call hands back independent arrays — a mutating caller cannot poison the catalog", () => {
    // Rust's `role(...)` allocates a fresh owned `Vec<String>` on every
    // `list_roles()` call (`.iter().map(|s| s.to_string()).collect()`), so a
    // caller cannot reach back into the static table. A TS port returning a
    // shared module-level literal would let the Settings screen's own
    // `.sort()`/`.push()` rewrite what the next reader sees.
    const first = listRoles();
    const tutor = first.find((r) => r.id === "tutor");
    expect(tutor).toBeDefined();
    tutor!.prompts.push("INJECTED");
    tutor!.commands.length = 0;
    tutor!.instructions = "OVERWRITTEN";
    const second = listRoles();
    const tutor2 = second.find((r) => r.id === "tutor");
    expect(tutor2!.prompts).not.toContain("INJECTED");
    expect(tutor2!.commands).toEqual(["summarize", "research"]);
    expect(roleInstructions("tutor")).toContain("patient tutor");
  });
});
