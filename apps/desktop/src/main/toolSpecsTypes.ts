/**
 * The agent's built-in tool JSON schemas — the always-on catalog plus every
 * optional tool GROUP a turn may add on top of it.
 *
 * Ported from `src-tauri/src/commands/agent.rs` lines ~1577-3052 (the
 * catalog-building half only — see `toolRouting.ts` for the deterministic
 * "does this turn want group X" heuristics, and `toolSchema.ts` for the
 * validation/slimming machinery built ON TOP of these specs).
 *
 * Every description string below is copied VERBATIM from the Rust source.
 * Models are sensitive to exact wording here — a paraphrase that reads as
 * "the same thing" to a person is a different prompt to a small model, and
 * degrades every turn silently. Do not improve the prose.
 */

// ------------------------------------------------------------- ollama-shaped

/** One tool spec in the `{"type":"function","function":{...}}` shape every
 * spec builder below returns — the same shape `ollama::ToolCall`/the OpenAI
 * function-calling convention uses, and what `room_mcp.rs`'s `to_mcp_tool`
 * translates to an MCP tool record. Kept as a loose `Record` (mirroring the
 * Rust source's `serde_json::Value`) rather than a strict interface: the
 * `parameters` JSON Schema varies per tool and nothing here needs to reach
 * into it generically except by property name. */
export type OllamaToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
};

/**
 * A connected MCP tool exposed to the model this turn: its catalog entry,
 * namespaced and slimmed, plus enough identity to dispatch a call and shape
 * its consent/redaction behaviour. Ported from `commands::McpRoute` — MINUS
 * its `client: Arc<Mutex<mcp::Client>>` field, which is a live resource this
 * rewrite has no ported transport for yet. A real dispatch is therefore
 * always reached through an INJECTED function keyed by this record (see
 * `execTool.ts`'s `ExecToolDeps.callConnectorTool`), never a method on this
 * type itself.
 */
export interface McpRoute {
  /** The namespaced, de-duplicated name offered to the model
   * (`mcp::sanitize_tool_name` composition — namespacing itself is not
   * ported here; callers supply an already-unique name). */
  catalogName: string;
  /** The connector's own name for this tool. */
  toolName: string;
  /** Which connector this tool belongs to — shown in the approval prompt and
   * used as the "always allow" key. */
  serverName: string;
  /** True when this connector is reached over the network — the outbound
   * redaction seam masks the room's entities in this tool's args. */
  remote: boolean;
  /** The (already slimmed) ollama-shaped spec offered to the model. */
  spec: OllamaToolSpec;
}

// ------------------------------------------------------------------ constants

/**
 * The sub-agent ids a skill may be scoped to — the sidecar's worker registry,
 * in its order. Ported verbatim from `SKILL_AGENT_IDS`. BOTH the `save_skill`
 * enum the model picks from and the value the (not-yet-ported) skill-save
 * command validates against — a typo here is an invisible-forever skill.
 */
export const SKILL_AGENT_IDS: readonly string[] = [
  "files.read",
  "scripts.run",
  "chat.web",
  "chat.browse",
  "app.ui",
  "jobs.run",
  "jobs.workflows",
  "skills.use",
  "skills.author",
  "connectors.admin",
  "connectors.use",
  "media.transcribe",
  "media.video",
  "creator.studio",
  "creator.draw",
];

/**
 * Every built-in agent tool name — the reserved set a connected MCP tool may
 * never shadow. Ported verbatim from `BUILTIN_TOOL_NAMES`. Keep in sync with
 * {@link toolsCatalog} and `execTool.ts`'s dispatch (the Rust comment says
 * the same of `tools_catalog`/`exec_tool`) — `execTool.test.ts` pins every
 * one of these to a real, named arm.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "list_room_files",
  "search_room",
  "open_file",
  "view_file_image",
  "mark_image",
  "annotate_file",
  "create_file",
  "edit_file",
  "edit_files",
  "write_file",
  "set_cells",
  "rename_file",
  "move_file",
  "organize_files",
  "trash_files",
  "merge_files",
  "add_memory",
  "list_memories",
  "update_memory",
  "delete_memory",
  "list_skills",
  "read_skill",
  "read_skill_resource",
  "save_skill",
  "write_skill_resource",
  "delete_skill",
  "delete_skill_resource",
  "run_skill_script",
  "list_mcps",
  "read_mcp",
  "save_mcp",
  "delete_mcp",
  "search_mcp_tools",
  "run_mcp_tool",
  "web_search",
  "fetch_page",
  "ui_snapshot",
  "ui_act",
  "view_screenshot",
  "view_media_frame",
  "browse_open",
  "browse_read",
  "browse_find",
  "browse_snapshot",
  "browse_do",
  "browse_look",
  "browse_save",
  "save_link",
  "download_url",
  "download_media",
  "start_file_pass",
  "job_status",
  "list_scripts",
  "run_script",
  "studio_flashcards",
  "studio_mindmap",
  "generate_podcast_script",
  "retranscribe_file",
  "stt_status",
  "read_recording",
  "list_workflows",
  "save_workflow",
  "update_workflow",
  "delete_workflow",
  "run_workflow",
  "test_workflow",
  "draw",
  "read_drawing",
  "set_in_library",
  "local_generate",
  "consult_advisor",
];

/** The download/save tool names — the WEB AGENT's box (`routing.DOWNLOAD_TOOL_NAMES`
 * on the sidecar side). Ported verbatim from `DOWNLOAD_TOOL_NAMES`. */
export const DOWNLOAD_TOOL_NAMES: readonly string[] = [
  "save_link",
  "download_url",
  "download_media",
];

/** How many `consult_advisor` calls one turn/bridge may spend. Ported from
 * `commands::MAX_ADVISOR_CALLS`. */
export const MAX_ADVISOR_CALLS = 1;

/** The cap on one memory note's length, in CHARACTERS. Ported from
 * `commands::MAX_MEMORY_CONTENT_CHARS`. */
export const MAX_MEMORY_CONTENT_CHARS = 500;

/** How many memories `list_memories`/`format_memory_list` shows before
 * summarizing the rest. Ported from `agent.rs`'s `MAX_LISTED_MEMORIES`. */
export const MAX_LISTED_MEMORIES = 50;

// --------------------------------------------------------- tool group builders

/** The Scripts lane (2026-07-24). Ported verbatim from `script_tools_specs`. */
