/**
 * Agent Skills: validation, encrypted CRUD, folder import/export, source-file
 * snapshots, and the agent-facing seams `execTool.ts` does not already carry.
 * Ported from `src-tauri/src/commands/skills.rs` (1811 lines, read in full
 * including its `#[cfg(test)] mod tests`) over the already-committed
 * `db-host/skills.ts`.
 *
 * ============================================================================
 * THE TWO CALLERS skills.rs MIXES, AND HOW THIS PORT KEEPS THEM APART
 * ============================================================================
 *   - The SETTINGS-SCREEN half — Rust's `#[tauri::command]`s, reached by the
 *     renderer's Skills screen and never by a model: {@link createSkillCmd},
 *     {@link updateSkillCmd}, {@link setSkillEnabledCmd}, {@link deleteSkillCmd},
 *     {@link getSkillCmd}, {@link getSkillResourceCmd},
 *     {@link saveSkillResourceCmd}, {@link deleteSkillResourceCmd},
 *     {@link importSkillFolderCmd}, {@link skillImportConflict},
 *     {@link exportSkillFolderCmd}, {@link skillAgentIds}, {@link listSkillsCmd},
 *     {@link composeSkill}. None of these existed anywhere in this migration
 *     before: the Skills SCREEN had no Electron-side implementation at all.
 *     The `Cmd` suffix is deliberate — `createSkill`/`updateSkill`/
 *     `deleteSkill`/`getSkill`/`listSkills` are all names `db-host/skills.ts`
 *     already exports, and `execTool.ts` imports BOTH modules.
 *
 *   - The MODEL-INVOCABLE half, reached through `exec_tool`'s dispatch. Five of
 *     these are ALREADY REAL in `execTool.ts` (`list_skills`/`read_skill`/
 *     `read_skill_resource`/`save_skill`/`write_skill_resource`/
 *     `delete_skill_resource`) and are deliberately NOT re-ported here. What
 *     this file adds is the three that were missing or incomplete:
 *     {@link agentSaveSkill} (the FULL `agent_save_skill`, including the
 *     `source_files` → room-file snapshot path `execSaveSkill` still refuses),
 *     {@link agentDeleteSkill} (wired into `execTool.ts`'s `delete_skill`
 *     dispatch case, mirroring its `delete_mcp` neighbour), and
 *     {@link agentRunSkillScript}.
 *
 * ============================================================================
 * THE ASYMMETRY THIS PORT PRESERVES RATHER THAN RE-INVENTS
 * ============================================================================
 * "The agent builds drafts; a human applies them." skills.rs draws that line in
 * exactly one place and so does this port:
 *   - {@link agentSaveSkill} always returns the skill to `enabled: false`, even
 *     on an UPDATE of an already-enabled skill, so a person reviews the exact
 *     instructions and bundled resources before they can influence a later
 *     turn. (`execTool.ts`'s `execSaveSkill`/`execWriteSkillResource` do the
 *     same for the arms it owns.) Nothing a model can call flips a skill on.
 *   - {@link setSkillEnabledCmd} is the ONLY seam that can set `enabled = true`,
 *     and it is reachable solely from the Skills screen a human is looking at.
 *     Nothing in this file, and nothing in the agent half, calls it that way.
 *   - {@link agentDeleteSkill} requires a live `confirmDestructive` approval
 *     before anything is destroyed; {@link deleteSkillCmd} (human-facing) does
 *     not — the click IS the confirmation, matching Rust's own `delete_skill`
 *     command, which calls `confirm_destructive` nowhere.
 *
 * ============================================================================
 * TWO GENUINELY UNPORTED DEPENDENCIES — HONEST REFUSAL, NEVER A FABRICATION
 * ============================================================================
 *   1. {@link composeSkill}. `generate_text_any_engine`/`default_resolved_model`
 *      live in the unported `commands/jobs/workflow.rs`; `model_setting`
 *      (`commands/models.rs`) and `ollama::recover_json`/`list_models` have no
 *      Electron port either. Everything BEFORE the model call is real and runs:
 *      request validation, {@link loadSkillSources} against the committed
 *      `db-host/files.ts`, and {@link skillComposePrompt}. It then rejects with
 *      {@link COMPOSE_SKILL_NOT_IMPLEMENTED} naming the exact missing pieces.
 *   2. {@link agentRunSkillScript}'s consent step. `approve_script_bytes` is
 *      real for two thirds of itself (`scriptRun.ts`'s `scriptLangOf`/
 *      `parseScriptManifest`/`resolveInterpreter` all landed) but
 *      `scriptConsent.ts`'s own `approveScriptBytes` still throws, because the
 *      live script-approve round trip to a renderer window has no wiring
 *      anywhere in this migration (the same gap `mcpConfig.ts` documents for
 *      `mcp_call_approved`). {@link AgentRunSkillScriptDeps.approveScriptBytes}
 *      defaults to that real, currently-throwing export, so everything BELOW
 *      the seam — workspace lifecycle, materialization, execution, result
 *      shaping — is fully exercised today and needs no change once a real
 *      consent surface lands.
 *
 * ============================================================================
 * DELIBERATE DIVERGENCES FROM `execTool.ts`'S PRIVATE COPIES
 * ============================================================================
 * `execTool.ts` carries private, unexported copies of `normalizeSkillPath`,
 * `checkResourcePaths`, `skillResourceKind` and the two validators for its own
 * already-real arms. This file re-derives them from the same Rust source and,
 * in three places, is STRICTER about matching it — each is a real difference,
 * not a style choice, and a future consolidation pass should fold the two
 * copies together on THESE definitions:
 *   - {@link normalizeSkillPath} reproduces `Path::components()`' actual rule:
 *     a `.` in the MIDDLE of a path is normalized away (Rust's own comment
 *     names `a/./b` collapsing as intended), while a LEADING `.` and a `..`
 *     anywhere are refused. execTool.ts's copy refuses all three. It also caps
 *     length in BYTES (`raw.len()`), not UTF-16 code units.
 *   - {@link checkResourcePaths} folds case with ASCII rules only, matching
 *     `eq_ignore_ascii_case`. JS `toLowerCase()` folds Unicode, which makes
 *     `K` (U+212A KELVIN SIGN) collide with `k` and can even change a string's
 *     length mid-comparison — a refusal Rust never issues.
 *   - {@link parseSkillMd} splits with {@link rustLines}, reproducing
 *     `str::lines()`: a CRLF SKILL.md's `\r`s are stripped from the stored
 *     instructions instead of travelling into the database.
 *
 * ============================================================================
 * REUSED, NOT RE-PORTED
 * ============================================================================
 *   - `db-host/skills.ts`: every row-level CRUD op, and `SKILL_GONE`.
 *   - `db-host/files.ts`: `getFileMeta`/`getFileExtractedText`/`findFileLike`.
 *   - `scriptRun.ts`: `executeScriptInWorkspace`, `Runner`, `ScriptManifest`,
 *     the `STOPPED` sentinel.
 *   - `scriptConsent.ts`: `approveScriptBytes` (the injected default).
 *   - `mcpConfig.ts`: `DELETE_DECLINED` — the exact shared sentence Rust's
 *     `agent_delete_skill` borrows from `mcp_cmds.rs` rather than declaring
 *     its own.
 *   - `toolSpecs.ts`: `SKILL_AGENT_IDS` — the single roster both
 *     {@link skillAgentIds} and {@link validateSkillAgent} read, matching
 *     Rust's own one-source-of-truth discipline (AUDIT 511).
 *
 * {@link registerSkillsIpc} is NOT invoked from any bootstrap, per `recIpc.ts`'s
 * precedent: it exists, it is tested directly, and a renderer-side owner wires
 * it when Phase 2 starts.
 */

export { MAX_NAME, MAX_DESCRIPTION, MAX_INSTRUCTIONS, MAX_RESOURCE_BYTES, MAX_IMPORT_BYTES, MAX_RESOURCES, MAX_COMPOSE_SOURCE_FILES, MAX_COMPOSE_SOURCE_PROMPT_CHARS, MAX_COMPOSE_SOURCE_PROMPT_PER_FILE, MAX_COMPOSE_SOURCE_SNAPSHOT_CHARS, MAX_COMPOSE_SOURCE_SNAPSHOT_TOTAL_CHARS, type EmitFn, rustLines, requireSkill, type SkillResourceMeta, type SkillBundle, type SkillResourceContent, validateSkillName, validateSkillFields, validateSkillAgent, skillAgentIds, skillOwnerToStore, normalizeSkillPath, storedResourceKey, skillResourceKind, checkResourcePaths, checkNewResourcePath, isTextPath } from "./skillsCore.js";
export { renderSkillMd, type ParsedSkillMd, parseSkillMd, safeExportName, type SkillSourceSnapshot, clipChars, sourceSlug, uniqueSourcePath, loadSkillSources, instructionsWithSourceLinks } from "./skillsResources.js";
export { listSkillsCmd, getSkillCmd, createSkillCmd, updateSkillCmd, setSkillEnabledCmd, deleteSkillCmd, getSkillResourceCmd, saveSkillResourceCmd, deleteSkillResourceCmd, collectFolderFiles, importInto, importSkillFolderCmd, skillImportConflict, exportSkillFolderCmd } from "./skillsArchive.js";
export { skillComposePrompt, COMPOSE_SKILL_NOT_IMPLEMENTED, type ComposeSkillDeps, composeSkill, agentSaveSkill, agentDeleteSkill } from "./skillsMutations.js";
export { resetLiveSkillRunsForTests, type SkillScriptConsent, type AgentRunSkillScriptDeps, agentRunSkillScript, type RoomSource, registerSkillsIpc } from "./skillsRuntime.js";
