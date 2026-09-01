/**
 * `exec_tool`'s OUTER SHELL — argument validation, the effects/usage
 * accounting wrapper, error shaping, and the dispatch structure (a name-keyed
 * match, faithfully mirroring how the Rust source does it), WITHOUT porting
 * every arm's real logic.
 *
 * Ported from `src-tauri/src/commands/agent.rs` lines ~3053-4803 (`exec_tool`
 * itself, ~1750 lines) plus the `ToolEffects` struct (lines ~3002-3051, just
 * above it) and `effects_json` (lines ~1538-1573).
 *
 * MOST ARMS ARE STUBS, and that is the honest state of the port rather than an
 * oversight. `exec_tool` dispatches into whole subsystems this rewrite has not
 * reached — `edit_match.rs`, the AgentUi screen-driving bridge, the private
 * browser's command surface, the Scripts/Studio/STT/jobs-workflows/
 * local-generate lanes, and the external-CLI advisor subprocess. `web.rs`
 * (and its `fetch`/`guard`/`search` submodules) is now REAL — see
 * `web_search`/`fetch_page` below — but `save_link`/`download_url`, whose OWN
 * arms reach further pieces of it plus `files.rs`'s `import_link_and_index`,
 * are not. `sketch.rs`/`sketchdoc.rs` (the `creator.draw` agent tools) are
 * ALSO now REAL — see `read_drawing`/`draw` below, against
 * `sketchCommands.ts`.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: every name the tool catalog or an
 * `McpRoute` can produce reaches a NAMED arm. A stub returns a labeled
 * `NOT_IMPLEMENTED: …` naming the batch that owns it — never a thrown
 * exception that would crash the turn, never a fabricated success, and never
 * the `Unknown tool:` fallthrough, which is reserved for a name that is
 * genuinely neither a built-in nor a connected route. `execTool.test.ts`
 * proves it by DRIVING every catalog name through this function with
 * schema-satisfying arguments, not by comparing two hand-written lists.
 *
 * REAL ARMS (wired against already-committed modules):
 * - memories — `add_memory` / `list_memories` / `update_memory` /
 *   `delete_memory`, against `db-host/memories.ts`.
 * - skills — `list_skills` / `read_skill` / `read_skill_resource` /
 *   `save_skill` (fully, EXCEPT its `source_files` snapshot path) /
 *   `write_skill_resource` / `delete_skill_resource`, against
 *   `db-host/skills.ts`.
 * - `consult_advisor` — its budget cap, question validation and engine choice
 *   are real; only the subprocess is an injected seam.
 * - the connector route — real dispatch STRUCTURE with both of Rust's doors
 *   (outbound masking, SEC-1b consent) required rather than skipped.
 * - files, read side — `list_room_files` / `search_room` / `open_file` /
 *   `annotate_file`, against the now-committed `db-host/files.ts` and
 *   `db-host/retrieval.ts`; the arms themselves live in `fileTools.ts`.
 *   `search_room` degrades to keyword-only retrieval, because `embed_question`
 *   has no Electron port yet — see that file's own module doc for why that is
 *   the Rust arm's own no-embed-model path rather than a stand-in.
 * - the organize box — `mark_image` / `create_file` / `rename_file` /
 *   `move_file` / `set_in_library` / `organize_files` / `trash_files` /
 *   `merge_files`, against the already-committed `organize.ts` and
 *   `db-host/{files,folders,versions,artifacts}.ts`, plus `bulkReport.ts`
 *   (the `BulkReport::changed_anything`/`::sentence` helpers `organize.ts`'s
 *   own doc flags as the one piece of `commands/bulk.rs` still missing) and
 *   `docsHtml.ts` (the scratch-pad and HTML-first slice of
 *   `commands/docs_html.rs` `create_file` needs, carrying the app's real
 *   inlined design system rather than a look-alike); the arms themselves live
 *   in `organizeTools.ts`. Seven are fully real, `create_file` included — the
 *   ART-1 staged-artifact commit is replicated by hand against
 *   `db-host/artifacts.ts`, since `commands/artifact.rs`'s fluent `Artifact`
 *   builder has no port of its own yet. `mark_image` is the one honestly
 *   PARTIAL arm: it resolves the image and answers a repeat-mark for real,
 *   but the vision grounding pass (`ollama.rs`'s model listing and vision
 *   pick, the privacy-door check, `ground_prepared_image`) is wholly unported
 *   and still comes back `NOT_IMPLEMENTED` — see `organizeTools.ts`'s own
 *   module doc for why that refusal deliberately does NOT borrow Rust's "no
 *   vision model installed on this Mac" wording.
 * - MCP connector management — `list_mcps` / `read_mcp` / `save_mcp` against
 *   `mcpConfig.ts`. `delete_mcp` is wired to the same module but REFUSES
 *   while {@link ExecToolDeps.confirmDestructive} is unwired, for the reason
 *   `delete_skill` gives: a deletion that erases a saved OAuth token must not
 *   happen behind a confirmation the user never saw. The live `McpManager`
 *   (statuses, reconnects) has no app-wide container yet, and the per-Mac
 *   connector-grants file needs the app's `userDataDir`, which an `exec_tool`
 *   arm has no access to — each degrades through its own named dep below.
 * - the web tools — `web_search` (against `web.ts`'s search-fusion wrapper,
 *   `db-host/webCache.ts`'s 15-minute cache, and `browser/webAccess.ts`'s
 *   internet switch) and `fetch_page` (same cache/switch, against `web.ts`'s
 *   guarded HTTP client — `web/fetch.rs`'s per-hop SSRF re-check, DNS pinning
 *   and streaming byte caps, over `web/guard.rs`'s SSRF guard, already ported
 *   and committed as `browser/guard.ts` by an earlier batch). Both hold their
 *   PRIV-4 door open as an injected seam — {@link ExecToolDeps.maskOutboundWeb}
 *   for `web_search`'s outbound QUERY, {@link ExecToolDeps.outboundUrlRefusal}
 *   (shared with `download_media`) for `fetch_page`'s URL — and REFUSE while
 *   it is unwired rather than ever sending real names to the network unmasked.
 *   {@link withRealPrivacyGates} is the one-line way to fill both with
 *   `privacy.ts`'s real, committed port. `download_media` is the only OTHER
 *   web/download arm that is real; `save_link`/`download_url` still reach
 *   pieces of `web.ts` that back THEM specifically (the YouTube-transcript and
 *   binary-download engines) but are not wired to a tool arm here.
 */

export { type ToolEffects, type MediaFrameReceipt, createToolEffects, effectsJson, type ToolOutcome, type ExecToolDeps, type ConnectorReply, type RemoteSeam } from "./execToolEffects.js";
export { validateSkillName, validateSkillFields } from "./execToolSkills.js";
export { withRealAdvisorCli, withRealPrivacyGates } from "./execToolAdvisor.js";
export { NAMED_ARM_TOOL_NAMES } from "./execToolDispatchCore.js";
export { execTool } from "./execToolDispatch.js";
