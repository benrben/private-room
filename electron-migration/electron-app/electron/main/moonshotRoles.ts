/**
 * D11: room "roles" — a static persona catalog (name, blurb, instructions,
 * suggested prompts/commands) the Settings screen offers, and the persona
 * lookup a turn's system prompt injects. Ported from
 * `src-tauri/src/commands/moonshot/roles.rs` (132 lines, read in full
 * including its `#[cfg(test)] mod tests`).
 *
 * Apply is DATA-ONLY, per the Rust source's own doc comment: the app saves
 * `set_setting('room_role', id)` (the generic settings command; see
 * `src/settings/useRoles.ts`'s own comment, "list_roles + set_setting
 * room_role") and a turn's system-prompt assembly injects the chosen role's
 * `instructions`. Nothing here touches a database or the network — the whole
 * module is pure, exactly like the Rust source (`list_roles` takes no
 * `State`, and `role_instructions` is `pub(crate)` — not even a
 * `#[tauri::command]`).
 *
 * ============================================================================
 * OVERLAP WITH turnContext.ts — READ BEFORE CHANGING EITHER FILE
 * ============================================================================
 * `turnContext.ts` already carries its OWN narrowed copy of `role_instructions`
 * (its `roleInstructions`, backed by a private `ROLE_INSTRUCTIONS` map),
 * landed ahead of this module because `buildSystemPrompt` needed the persona
 * text before `moonshot/roles.rs` itself had a port. That file's own doc
 * comment names exactly the gap this one fills: "The full RoomRole catalog
 * (list_roles: blurbs, suggested prompts/commands, the Settings picker) is a
 * separate command surface, out of scope here; only the instructions text is
 * reproduced, verbatim."
 *
 * This file is now the CANONICAL, COMPLETE port: the full catalog (blurbs,
 * prompts, commands) plus {@link roleInstructions}, derived from
 * {@link listRoles} exactly as Rust's own `role_instructions` derives it — a
 * lookup THROUGH the catalog, never a second hand-maintained table.
 * `moonshotRoles.test.ts` pins this module's `roleInstructions` against
 * `turnContext.ts`'s own for every id in the catalog (plus an unknown id), so
 * the two copies cannot silently drift apart. A future consolidation pass
 * should delete `turnContext.ts`'s private `ROLE_INSTRUCTIONS`/
 * `roleInstructions` and have `buildSystemPrompt` import
 * {@link roleInstructions} from here instead — left undone in THIS batch per
 * rule 6 (an additive port, not a refactor of an already-committed file's
 * public surface out from under whatever else may be mid-flight against it).
 *
 * ============================================================================
 * NOT MODEL-INVOCABLE — no execTool.ts wiring
 * ============================================================================
 * Neither function here is a tool a model can call. `list_roles` is a
 * Settings-screen `#[tauri::command]` (`src/api.ts:1544`'s `listRoles()`,
 * consumed by `src/settings/useRoles.ts`); `role_instructions` is
 * `pub(crate)`, reached only from `agent.rs`'s own system-prompt assembly
 * (already ported as `turnContext.ts`'s `buildSystemPrompt`). There is no
 * `exec_tool` dispatch arm for either name anywhere in the Rust source (Rust
 * has no `commands/exec_tool.rs` at all — tool dispatch lives in `agent.rs`,
 * grepped for both names, no hit), and none of this migration's
 * `toolSpecs.ts`, `toolSchema.ts`, or `execTool.ts` names them either. Nothing
 * here was wired into `execTool.ts`.
 *
 * Rule 2 (never assign a room/model-controlled key onto a plain `{}` literal):
 * does not apply here — every field of every {@link RoomRole} is a compile-
 * time string literal, and the one caller-supplied value ({@link
 * roleInstructions}'s `id`) is only ever compared with `===` inside an array
 * `.find()`, never used as an object key.
 *
 * {@link registerRolesIpc} is NOT invoked from any bootstrap, per `recIpc.ts`'s
 * precedent: it exists, is tested directly, and a renderer-side owner wires it
 * when Phase 2 starts. Unlike `recIpc.ts`'s handlers, `list_roles` needs no
 * open room — it is registered unconditionally.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";

// ============================================================================
// D11: the room "roles" catalog — ported from `RoomRole` / `role` / `list_roles`.
// ============================================================================

/** Ported from `RoomRole` (`#[serde(rename_all = "camelCase")]`), so every
 * field below is already the wire shape a `list_roles` IPC caller reads — no
 * projection at the boundary. */
export interface RoomRole {
  id: string;
  name: string;
  blurb: string;
  instructions: string;
  prompts: string[];
  commands: string[];
}

/** Ported from the private `role(...)` constructor helper. Builds a fresh
 * `RoomRole` (fresh `prompts`/`commands` arrays too) on every call, exactly as
 * Rust's `.iter().map(|s| s.to_string()).collect()` allocates a fresh owned
 * `Vec<String>` every time `list_roles` runs. */
function role(
  id: string,
  name: string,
  blurb: string,
  instructions: string,
  prompts: readonly string[],
  commands: readonly string[]
): RoomRole {
  return { id, name, blurb, instructions, prompts: [...prompts], commands: [...commands] };
}

/**
 * D11: the static catalog of room "roles" (a persona + suggested prompts).
 * Apply is data-only — the app saves `set_setting('room_role', id)` and
 * injects the role's `instructions` into custom instructions. Pure, so it is
 * unit-testable. Ported from `list_roles`, verbatim strings (name, blurb,
 * instructions, prompts, commands — every one checked character for character
 * against the Rust source).
 */
export function listRoles(): RoomRole[] {
  return [
    role(
      "default",
      "Assistant",
      "A calm, careful helper grounded in your files.",
      "",
      ["Summarize this room", "What should I look at first?"],
      ["summarize", "find"]
    ),
    role(
      "tutor",
      "Tutor",
      "Explains patiently and checks your understanding.",
      "You are a patient tutor. Explain concepts step by step in plain language, check " +
        "understanding with short questions, and ground every explanation in the room's files.",
      ["Teach me the key ideas in this room", "Quiz me on @file", "Explain @file like I'm new to it"],
      ["summarize", "research"]
    ),
    role(
      "critic",
      "Critic",
      "Pushes back and finds the weak points.",
      "You are a sharp but fair critic. Point out weaknesses, unstated assumptions, and gaps, " +
        "and suggest concrete improvements — always grounded in the room's files, never harsh " +
        "for its own sake.",
      ["What's weak about @file?", "Poke holes in this argument"],
      ["compare", "find"]
    ),
    role(
      "opposing-counsel",
      "Opposing counsel",
      "Argues the other side to stress-test your case.",
      "You act as opposing counsel. Make the strongest good-faith case AGAINST the user's " +
        "position, cite the room's documents for every point, and flag the risks they would " +
        "face — so they can prepare. You are not their lawyer and give no legal advice.",
      ["Argue against @contract", "Where is my case weakest?"],
      ["compare", "extract"]
    ),
    role(
      "scribe",
      "Scribe",
      "Turns discussion into tidy notes and minutes.",
      "You are a meticulous scribe. Capture decisions, action items, and open questions in " +
        "clean, well-structured notes, using only what the room's files and this conversation " +
        "contain.",
      ["Take minutes from @recording", "Write up what we decided"],
      ["minutes", "to-sheet"]
    ),
  ];
}

/**
 * The persona instructions for a saved `room_role` id, or `""` for the plain
 * "default" role or an unknown id. Pure, so the agent's injection is unit-
 * testable. Ported from `role_instructions` — a lookup THROUGH
 * {@link listRoles} (`list_roles().into_iter().find(|r| r.id == id).map(|r|
 * r.instructions).unwrap_or_default()`), never a second hand-maintained
 * table.
 */
export function roleInstructions(id: string): string {
  return listRoles().find((r) => r.id === id)?.instructions ?? "";
}

// ============================================================================
// IPC — thin registration, per `recIpc.ts`'s precedent. NOT wired into any
// bootstrap file (rule 4/5).
// ============================================================================

/** Register the one Settings-screen channel `src/api.ts`'s `listRoles()`
 * invokes (`ipcMain.handle("list_roles", ...)`). Needs no open room — the
 * catalog is a compile-time constant, matching Rust's `list_roles` taking no
 * `State<'_, AppState>` at all. */
export function registerRolesIpc(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle("list_roles", (_event: IpcMainInvokeEvent) => listRoles());
}
