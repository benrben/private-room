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
export function scriptToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "list_scripts",
        description:
          "List the runnable .py/.js scripts in this room, with their declared dependencies and whether the user has already approved each one to run.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "run_script",
        description:
          "Run one of this room's scripts now. The user is asked to approve any script whose exact contents they have not approved before — including one you just wrote. Output and any files it writes appear in the Scripts view.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "The script's file name, e.g. etf-report.py" },
          },
          required: ["name"],
        },
      },
    },
  ];
}

/** The Studio lanes (2026-07-24). Ported verbatim from `studio_tools_specs`. */
export function studioToolsSpecs(): OllamaToolSpec[] {
  // A FACTORY, not one shared object literal. The Rust source writes this
  // property out three times, so its three specs own three independent JSON
  // values; a single object reused across all three would make them ALIASES,
  // and `slimSchema` (this codebase's one schema transform) edits schemas IN
  // PLACE — slimming one studio tool would silently rewrite the other two.
  const refs = (): Record<string, unknown> => ({
    type: "array",
    items: { type: "string" },
    description: "Optional file names to build from; omit to use the whole room",
  });
  return [
    {
      type: "function",
      function: {
        name: "studio_flashcards",
        description:
          "Build question/answer flashcards from this room's material and save them as a new file. Say what to focus on in instructions.",
        parameters: {
          type: "object",
          properties: {
            instructions: { type: "string", description: "What to cover, in the user's words" },
            refs: refs(),
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "studio_mindmap",
        description:
          "Build a structured mind map from this room's material and save it as a new file.",
        parameters: {
          type: "object",
          properties: {
            instructions: { type: "string", description: "What to map, in the user's words" },
            refs: refs(),
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_podcast_script",
        description:
          "Write a two-voice podcast script from this room's material and save it as a new file.",
        parameters: {
          type: "object",
          properties: {
            instructions: { type: "string", description: "What the episode should cover" },
            refs: refs(),
          },
        },
      },
    },
  ];
}

/** The File agent's ORGANIZE box. Ported verbatim from `organize_tools_specs`. */
export function organizeToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "organize_files",
        description:
          'Tidy the room: move files into folders, rename them, add/remove folders — ALL IN ONE CALL. Use this, not repeated move_file/rename_file, whenever more than one file is involved. Folders are created on the way in. dry_run: true shows the user the plan first. To delete, use trash_files. Example: {"files": [{"name": "q3.pdf", "folder": "Invoices", "new_name": "Q3 invoice"}], "remove_folders": ["Untitled"]}',
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "Per file: folder to move it, new_name to rename it, or both.",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: 'File name or part of it; "Folder/file.md" works as listed',
                  },
                  folder: {
                    type: "string",
                    description: "Destination folder, created if missing; empty string = top level",
                  },
                  new_name: {
                    type: "string",
                    description: "New name; extension kept if omitted",
                  },
                },
                required: ["name"],
              },
            },
            make_folders: {
              type: "array",
              items: { type: "string" },
              description: "Folders to create even if empty",
            },
            remove_folders: {
              type: "array",
              items: { type: "string" },
              description: "Folders to delete; their files survive at the top level",
            },
            dry_run: {
              type: "boolean",
              description: "Report the plan, change nothing (default false)",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "trash_files",
        description:
          'Move files to the room\'s trash. They leave the library and everything you can search, but the user can restore them from Library → Trash — you cannot destroy anything. Only when the user asked. Example: {"names": ["old draft.md"]}',
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "File names or parts of them",
            },
          },
          required: ["names"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_in_library",
        description:
          "Add a section-only object (a sketch, a generated picture or clip) to this room's Library, or remove it from the Library. Room-local: nothing is exported or copied, and the object stays in its own section either way. Only when the user asks or approves — never automatically.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or part of it" },
            in_library: { type: "boolean", description: "true = add, false = remove" },
          },
          required: ["name", "in_library"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "merge_files",
        description:
          'Join text files into ONE new file, in order. A mechanical join of their FULL contents — nothing summarized, no length limit — for combining notes/chapters/transcripts. To have the material rewritten or summarized instead, use start_file_pass. Example: {"names": ["ch1.md", "ch2.md"], "into": "Book draft.md"}',
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "At least two files, in the order they should appear",
            },
            into: { type: "string", description: "Name for the new file (.md added if omitted)" },
            headings: {
              type: "boolean",
              description: "Head each part with its source file name (default true)",
            },
            trash_sources: {
              type: "boolean",
              description: "Trash the originals afterwards (default false)",
            },
          },
          required: ["names", "into"],
        },
      },
    },
  ];
}

/** On-device transcription for a room file that already exists. Ported
 * verbatim from `transcribe_tools_specs`. */
export function transcribeToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "stt_status",
        description:
          "Whether the on-device speech-to-text model is installed and ready. Check this before promising a transcription.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "retranscribe_file",
        description:
          "Transcribe a room audio/video file again on this computer — use when a transcript is missing, in the wrong language, or poor. Nothing is uploaded.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The file's name in this room" } },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_recording",
        description:
          "Read a recording and write its chapters, highlights and notes (decisions, action items, open questions) onto it. Needs an existing transcript; runs in the background.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The recording's name in this room" } },
          required: ["name"],
        },
      },
    },
  ];
}

/** The whole-file pass tools. Ported verbatim from `job_tools_specs`. */
export function jobToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "start_file_pass",
        description:
          'Start a durable BACKGROUND pass that reads an ENTIRE file part by part — every character, no matter how large the file is — and saves the result as a new file in the room. Use it whenever the user wants work covering a whole large file (summarize/analyze/translate it all), instead of answering from excerpts. It is slow (minutes to hours) but survives app restarts; the user sees a live progress card. mode "merge" (default) folds notes into one final document; mode "stitch" transforms each part and joins them in order (translation, rewriting). After starting it, tell the user it is underway — do not wait for it.',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or a distinctive part of it" },
            instruction: {
              type: "string",
              description:
                'What to do across the whole file, e.g. "summarize thoroughly", "translate to French", "list every obligation with its section"',
            },
            mode: {
              type: "string",
              enum: ["merge", "stitch"],
              description:
                "merge = one final document distilled from the whole file (default); stitch = transform each part and join them in order",
            },
          },
          required: ["name", "instruction"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "job_status",
        description:
          "Report the progress of background jobs (whole-file passes, room summaries): what is running, paused, finished or failed, and how far along. Each listed job shows a short id in brackets; pass job_id (that short id, or more of it) to see just one job in full detail.",
        parameters: {
          type: "object",
          properties: {
            job_id: {
              type: "string",
              description:
                "A job's short id (shown in brackets by a previous job_status call) to see just that one job",
            },
          },
        },
      },
    },
  ];
}

/** Local-only connector administration. Ported verbatim from
 * `mcp_management_tools_specs`. */
export function mcpManagementToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "list_mcps",
        description:
          "List the room's MCP connectors with their enabled state, transport, and live status. Use this to inspect or manage connectors.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "read_mcp",
        description:
          "Read one connector's configuration for editing. Secret header, environment, and OAuth values are redacted and never shown to the agent.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Connector name" } },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_mcp",
        description:
          "Create or update one MCP connector configuration. Supply a name plus a standard MCP server config object (command/args for local, or type:url for remote). Do not include headers, env, tokens, or credentials: those stay in Connectors. Every changed connector is saved DISABLED, so the user reviews it and explicitly enables/approves it before anything runs or reaches the network.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Unique connector name (letters, digits, dot, dash, underscore)",
            },
            config: { type: "object", description: "MCP server configuration, without secrets" },
          },
          required: ["name", "config"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_mcp",
        description:
          "Remove one MCP connector from this room, including its saved OAuth token. Use only when the user explicitly asks to remove that connector.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Connector name" } },
          required: ["name"],
        },
      },
    },
  ];
}

/**
 * The top-level model's optional cloud-advisor tool. Ported verbatim from
 * `consult_advisor_spec`. `null` when no recognised advisor CLI is present —
 * serving `"enum": []` would advertise a tool no value can satisfy.
 */
export function consultAdvisorSpec(advisors: readonly string[]): OllamaToolSpec | null {
  const names: string[] = [];
  if (advisors.some((item) => item === "claude-cli")) {
    names.push("claude");
  }
  if (advisors.some((item) => item === "codex-cli")) {
    names.push("codex");
  }
  if (names.length === 0) {
    return null;
  }
  return {
    type: "function",
    function: {
      name: "consult_advisor",
      description:
        "Delegate ONE hard, self-contained subtask to an installed cloud AI advisor (Claude or Codex). It is slow, may cost money, and the question leaves this Mac through the user's cloud account, so use it only when a second model would materially improve the answer. Put the full task and all necessary context in `question`. When advisor room tools are enabled, Claude may also inspect the room through its restricted bridge. Returns the advisor's written answer for use in the final response.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Complete, self-contained task with all context the advisor needs.",
          },
          advisor: {
            type: "string",
            enum: names,
            description: "Use codex for coding-heavy work; use claude otherwise.",
          },
        },
        required: ["question"],
      },
    },
  };
}

/** Wave 1a: tools served ONLY to `ToolScope::ExternalAgent`. Ported verbatim
 * from `external_agent_tools_specs`. */
export function externalAgentToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "local_generate",
        description:
          "Run one prompt on the user's LOCAL model on this Mac and return its text (or JSON when a schema is given). Slow but private — use it for steps whose content must not leave this machine. For reading a whole huge file use start_file_pass instead.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The full, self-contained prompt" },
            system: { type: "string", description: "Optional system instruction" },
            schema: {
              type: "object",
              description: "Optional JSON Schema — the reply is constrained to match it",
            },
            temperature: { type: "number" },
          },
          required: ["prompt"],
        },
      },
    },
  ];
}

/** Wave 1a: the CONTENT subset of the UI/perception specs — `view_media_frame`
 * only. Ported verbatim from `media_tools_specs`. */
export function mediaToolsSpecs(): OllamaToolSpec[] {
  return uiToolsSpecs().filter((s) => s.function.name === "view_media_frame");
}

/**
 * Wave 1a: the model `local_generate` runs on. Ported verbatim from
 * `resolve_local_generate_model`. `runsOnThisMac`/`bestLocalDefault` are
 * injected — the model-capability/Ollama-registry lookups they wrap are a
 * separate, not-yet-ported system (`ollama.rs`).
 */
export function resolveLocalGenerateModel(
  explicit: string | undefined,
  models: readonly string[],
  runsOnThisMac: (model: string) => boolean,
  bestLocalDefault: (models: readonly string[]) => string
): string {
  if (explicit !== undefined && runsOnThisMac(explicit)) {
    return explicit;
  }
  return bestLocalDefault(models);
}

/**
 * BROWSE-2 (D17): the download/save tools. Ported verbatim from
 * `download_tools_specs`.
 */
export function downloadToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "save_link",
        description:
          "Save a web page into this room as a readable Markdown file (title, source URL, readable text). A YouTube link saves the video's transcript instead. Use when the user asks to save, keep or bookmark a link.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Full http(s) URL" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_url",
        description:
          "Download the file at a URL (PDF, CSV, image, archive, …) into this room. Up to 64 MB arrives immediately; a bigger file continues as a background job — report the job id and track it with job_status. Not for web pages (save_link) or videos on streaming sites (download_media).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Full http(s) URL of the file" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_media",
        description:
          "Download the video/audio from a media page (YouTube and most video sites) into this room as a background job. Returns the job id — track it with job_status. After it arrives the file is transcribed on this Mac with speakers separated; that is a second pass, so the transcript appears on the file some minutes after the job ends, and not at all if no speech model is installed.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Full http(s) URL of the video page" } },
          required: ["url"],
        },
      },
    },
  ];
}

/** ADD-25: the UI/perception tool specs. Ported verbatim from
 * `ui_tools_specs`. */
export function uiToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "ui_snapshot",
        description:
          "List every clickable/typable control currently visible in the app as numbered marks (role, label, region). Call this FIRST when asked to open or use an app surface — the Room Map (the Map toggle), the Memory panel, Studio buttons (Flashcards, Mind map, Podcast script), a viewer tab, or History. Those are app controls, NOT files: never search_room for them. Take a fresh snapshot before each ui_act — marks go stale when the screen changes. Consent-sensitive controls (settings, approvals) are never listed.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ui_act",
        description:
          'Operate one control from the latest ui_snapshot by its mark number. The user watches every action. Example: {"mark": 12, "action": "click"}',
        parameters: {
          type: "object",
          properties: {
            mark: { type: "integer", description: "Mark number from the latest ui_snapshot" },
            action: {
              type: "string",
              enum: ["click", "type", "set", "scroll"],
              description:
                "click a control; type appends text into a field; set replaces the field's text; scroll moves the element's pane (text: \"up\" or \"down\")",
            },
            text: {
              type: "string",
              description: 'For type/set: the text. For scroll: "up" or "down".',
            },
          },
          required: ["mark", "action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "view_screenshot",
        description:
          "Capture what the user currently sees in the app window and look at it. Use when the words in the transcript aren't enough and you need the actual pixels (layout, an open image or PDF page, a chart).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "view_media_frame",
        description:
          'Grab one frame from a video file in the room at a timestamp and look at it. Pair with the transcript\'s [m:ss] stamps to inspect the exact moment. Example: {"name": "lecture.mp4", "at": "12:34"}',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Video file name or a distinctive part of it" },
            at: {
              type: "string",
              description:
                'Timestamp like "1:23" or "1:02:03", or plain seconds like "75"',
            },
          },
          required: ["name", "at"],
        },
      },
    },
  ];
}

/**
 * PRIV-4: the refusal a URL-taking tool owes the model when the address
 * itself carries a protected name, or `null` when it carries none. Ported
 * verbatim from `outbound_url_refusal`. `outboundUrlHides` is injected — the
 * room's protected-name scan (`privacy.rs`) is a separate, not-yet-ported
 * system; a real implementation is TODO for that future privacy batch.
 */
export function outboundUrlRefusal(
  url: string,
  outboundUrlHides: (url: string) => number | null
): string | null {
  const hidden = outboundUrlHides(url);
  if (hidden === null) {
    return null;
  }
  return (
    `Not fetched: this URL carries ${hidden} protected name(s) from this room's block list, ` +
    `and Cloud privacy is on, so it must not leave this Mac (Settings → Cloud privacy). ` +
    `Tell the user rather than retrying.`
  );
}

// -------------------------------------------------------- outbound-arg masking

/**
 * Whether one connector call's arguments get masked on the way out. Ported
 * verbatim from `masks_outbound_args`.
 */
export function masksOutboundArgs(remote: boolean, unmaskOutbound: boolean): boolean {
  return remote && !unmaskOutbound;
}

/**
 * What to tell the agent when the outbound seam actually rewrote something.
 * Ported verbatim from `masked_args_note`, including its exact wording.
 */
export function maskedArgsNote(server: string, entitiesHidden: number): string | null {
  if (entitiesHidden === 0) {
    return null;
  }
  const n = entitiesHidden;
  const plural = n === 1 ? "value" : "values";
  return (
    `\n\n[This room hid ${n} protected ${plural} in what it sent, so "${server}" was asked ` +
    `about placeholders, not the real text. If the answer above is empty or off-target, ` +
    `that is very likely why — tell the user, and that Connectors → "Send remote ` +
    `connectors real values" is what would send the real ones.]`
  );
}

// --------------------------------------------------------------- tools_catalog

/**
 * Tools the local model can use to drive the app — the always-on catalog
 * every scope is served. Ported verbatim from `tools_catalog`. The web tools
 * (`web_search`/`fetch_page`) appear only when `webEnabled`.
 */
export function toolsCatalog(webEnabled: boolean): OllamaToolSpec[] {
  const tools: OllamaToolSpec[] = [
    {
      type: "function",
      function: {
        name: "list_room_files",
        description: "List every file stored in this room with its type and size.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "search_room",
        description:
          "Search all room files for content the excerpts already provided above do not cover. Use 2-4 keywords, not a full sentence. Results are verbatim file text safe to quote in annotate_file. To SHOW the user a passage you found, call open_file with find set to a short quote from these results — you never need a page number.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "open_file",
        description:
          "Open a file in the app's viewer pane so the user sees it. To jump to a passage, pass find with a short exact quote (copied from search_room results) — the viewer locates the right page itself, in any language; never ask the user for a page number. page/cell also work when known.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or a distinctive part of it" },
            page: { type: "integer", description: "PDF page number to show" },
            cell: { type: "string", description: "Spreadsheet cell to show, like B7" },
            find: {
              type: "string",
              description:
                "Short exact text from the file to locate, scroll to, and show — use this to jump to content found with search_room",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mark_image",
        description: "Draw labeled boxes on an image in the room showing where something is.",
        parameters: {
          type: "object",
          properties: {
            image_name: { type: "string" },
            find: { type: "string", description: "What to locate in the image" },
          },
          required: ["image_name", "find"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "annotate_file",
        description:
          'Highlight a spot in a document or spreadsheet so the user sees it marked in the viewer. Quote exact text from the file, or give a cell range for spreadsheets. For images use mark_image instead. Example: {"name": "lease.pdf", "text": "no pets are allowed", "note": "pet clause"}',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or part of it" },
            text: {
              type: "string",
              description: "Short exact quote copied from the file (max ~200 chars)",
            },
            page: { type: "integer", description: "PDF page the text is on, if known" },
            sheet: { type: "string", description: "Sheet name, for spreadsheets" },
            range: { type: "string", description: "Cell or range to highlight, like B7 or B2:D5" },
            note: { type: "string", description: "Short label explaining the highlight" },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_file",
        description:
          "Create a new note/document file saved into the room. For a document without a specific format, write the content as simple HTML body markup (<h2>, <p>, <ul>, <table>) and the app saves it as an .html page. Only use another extension (.md, .csv, .txt) if the user asked for it. HTML opens in a network-blocked sandbox, so any page you write — especially a dashboard or anything with charts — MUST be fully self-contained: inline ALL CSS and JavaScript, embed the data as literals in the page (never fetch()/XHR at view time — it is blocked), and draw charts as inline SVG (preferred) or with a charting library whose full source you paste inline. NEVER reference a CDN or any external <script src>/<link href>/remote image — it silently won't load and the chart renders blank. If the data is 'live', snapshot the current numbers into the page.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" }, content: { type: "string" } },
          required: ["name", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          'Change ONE place in ONE file (text, code, notes, csv, html, or docx) by replacing exact text. Copy old_text exactly as it appears — curly quotes/spacing/dashes are matched tolerantly, but old_text must be a UNIQUE spot: a repeat gives an error with the count, then use prefix_context/suffix_context/occurrence/section to narrow it, or all: true to replace every one. On HTML, quote the readable text — it may span inline markup (bold, a link) but never crosses into a different paragraph/heading/list item/table cell. To change several places or files at once, use edit_files. Example: {"name": "notes.md", "old_text": "Q3 revenue was $4M", "new_text": "Q3 revenue was $5M"}',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or part of it" },
            old_text: { type: "string", description: "Exact text currently in the file" },
            new_text: { type: "string", description: "Text to replace it with" },
            all: {
              type: "boolean",
              description: "Replace EVERY occurrence (needs an exact quote; default false)",
            },
            prefix_context: {
              type: "string",
              description: "Exact text right before old_text, to pick one occurrence (exact quote only)",
            },
            suffix_context: {
              type: "string",
              description: "Exact text right after old_text, to pick one occurrence (exact quote only)",
            },
            occurrence: {
              type: "integer",
              description: "Which occurrence to replace, 1-based (exact quote only; not with all)",
            },
            section: {
              type: "string",
              description:
                'Scope to one heading\'s section, by its text e.g. "2026 Outlook" (html/md only)',
            },
            dry_run: { type: "boolean", description: "Preview the result without writing anything" },
          },
          required: ["name", "old_text", "new_text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_files",
        description:
          'Change several files (or several places in one file) in ONE atomic step: every edit is checked first, then all are applied together — if any single edit can\'t match, none are applied. Also renames files as part of the same atomic change, so "rename X and update every reference" fully lands or fully doesn\'t. Prefer this over repeated edit_file calls when a change spans files. Example: {"edits": [{"name": "a.md", "old_text": "foo", "new_text": "bar"}, {"name": "old.md", "new_name": "new.md"}]}',
        parameters: {
          type: "object",
          properties: {
            edits: {
              type: "array",
              description:
                "The changes to apply atomically. Each is either an edit {name, old_text, new_text} or a rename {name, new_name}.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "File name or part of it" },
                  old_text: { type: "string", description: "For an edit: exact text currently in the file" },
                  new_text: { type: "string", description: "For an edit: text to replace it with" },
                  new_name: { type: "string", description: "For a rename: the file's new name" },
                },
                required: ["name"],
              },
            },
            dry_run: { type: "boolean", description: "Preview the results without writing anything" },
          },
          required: ["edits"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Replace the entire content of an existing text file. For small changes prefer edit_file.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or part of it" },
            content: { type: "string", description: "The complete new file content" },
          },
          required: ["name", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_cells",
        description:
          "Set one or more cells in a spreadsheet (.xlsx or .csv). Pass ALL changes in one call via updates.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or part of it" },
            updates: {
              type: "array",
              description:
                'The cells to change, e.g. [{"cell":"B2","value":"120"},{"cell":"B3","value":"95"}]',
              items: {
                type: "object",
                properties: {
                  cell: { type: "string", description: "Cell in A1 notation, like B7" },
                  value: { type: "string", description: "New value for the cell" },
                },
                required: ["cell", "value"],
              },
            },
            sheet: { type: "string", description: "Sheet name (default: first sheet)" },
          },
          required: ["name", "updates"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "rename_file",
        description:
          'Rename a file in the room. The extension is kept if you omit it. Example: {"name": "draft.md", "new_name": "Q3 plan"}',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Current file name or part of it" },
            new_name: { type: "string", description: "The new name" },
          },
          required: ["name", "new_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "move_file",
        description:
          'Move a file into a folder (created if it doesn\'t exist), or to the top level with an empty folder. Example: {"name": "NVDA_Stock_Info.md", "folder": "stocks"}',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name or part of it" },
            folder: { type: "string", description: "Destination folder name; empty string for the top level" },
          },
          required: ["name", "folder"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_memory",
        description: "Save a permanent memory note that the assistant will always see in this room.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string" },
            category: {
              type: "string",
              enum: ["preference", "fact", "project", "instruction"],
              description: "What kind of note this is (optional)",
            },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_memories",
        description:
          "List every memory note saved in this room. Use it when asked what you remember, or when the notes shown in context look incomplete.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "update_memory",
        description:
          "Correct a memory note that is now wrong or out of date. Identify it by a distinctive phrase from the note itself, not by an id.",
        parameters: {
          type: "object",
          properties: {
            find: { type: "string", description: "A distinctive phrase from the note to correct" },
            content: { type: "string", description: "The corrected note, in full" },
          },
          required: ["find", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_memory",
        description:
          "Forget a memory note the user no longer wants remembered. Identify it by a distinctive phrase from the note itself, not by an id.",
        parameters: {
          type: "object",
          properties: {
            find: { type: "string", description: "A distinctive phrase from the note to forget" },
          },
          required: ["find"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_skills",
        description:
          "List the Agent Skills available to you, including disabled drafts. Call this to see which procedures exist for your domain, then read_skill to load one.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "read_skill",
        description:
          "Load a skill's full SKILL.md instructions and resource tree. Call this when an available skill's description matches the user's task, before doing the work.",
        parameters: {
          type: "object",
          properties: { skill: { type: "string", description: "Skill name or id" } },
          required: ["skill"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_skill_resource",
        description:
          "Read one text file from a loaded skill, such as references/policy.md or scripts/process.py. Use the relative path listed by read_skill.",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name or id" },
            path: { type: "string", description: "Relative resource path" },
          },
          required: ["skill", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_skill",
        description:
          "Create or update a portable Agent Skill. Saves it DISABLED as a draft for human review. Put all trigger conditions in description and concise imperative Markdown in instructions; add reusable resources separately with write_skill_resource. When the user wants a skill based on attached room files, pass their file names in source_files: Arcelle snapshots their readable content under references/source-files/ without making the model repeat the documents.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Lowercase hyphenated name, at most 64 characters" },
            description: { type: "string", description: "What the skill does and exactly when to use it" },
            instructions: { type: "string", description: "The SKILL.md Markdown body" },
            source_files: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional names of attached/readable room files to bundle as portable reference snapshots (maximum 12)",
            },
            agent: {
              type: "string",
              // A COPY. Rust's `json!` clones `SKILL_AGENT_IDS` into the spec;
              // handing out the module constant itself would put a live,
              // runtime-mutable reference to the skill-validation vocabulary
              // inside every served catalog — and `execSaveSkill` validates
              // against that same constant, so one in-place edit of a served
              // schema would change what `save_skill` accepts, process-wide.
              enum: [...SKILL_AGENT_IDS],
              description:
                "Optional: the sub-agent this procedure belongs to, so only that specialist is offered it — files.read (room files), scripts.run (this room's scripts), chat.web (internet search/fetch), chat.browse (driving web pages in the private browser), app.ui (this app's interface), jobs.run (whole-file passes), jobs.workflows (automation), skills.use (running skills), skills.author (writing skills), connectors.use (connected services), connectors.admin (connector setup), media.transcribe (transcripts), media.video (watching room videos), creator.studio (flashcards, mind maps, podcast scripts), creator.draw (drawing on the room's sketches). Omit for a skill any agent may use.",
            },
          },
          required: ["name", "description", "instructions"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_skill_resource",
        description:
          "Add or replace a text resource in a skill draft under scripts/, references/, assets/, agents/, or another relative folder. The skill is disabled again for review.",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name or id" },
            path: { type: "string", description: "Relative path, e.g. references/schema.md" },
            content: { type: "string" },
          },
          required: ["skill", "path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_skill_resource",
        description:
          "Delete one bundled resource from a skill. Use only when the user explicitly asks to remove that resource.",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name or id" },
            path: { type: "string", description: "Relative resource path" },
          },
          required: ["skill", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_skill",
        description:
          "Delete an entire Agent Skill and all of its bundled resources. Use only when the user explicitly asks to delete that skill.",
        parameters: {
          type: "object",
          properties: { skill: { type: "string", description: "Skill name or id" } },
          required: ["skill"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_skill_script",
        description:
          "Run an enabled skill's bundled Python or JavaScript helper from scripts/ in an isolated temporary copy of the skill folder. The user must approve the exact script contents first. Optional input is sent on stdin; stdout is returned.",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Enabled skill name or id" },
            path: { type: "string", description: "Relative scripts/... .py or .js path" },
            input: { type: "string", description: "Optional text sent to the script on stdin" },
          },
          required: ["skill", "path"],
        },
      },
    },
  ];
  if (webEnabled) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the public web across several engines at once, merged into one relevance ranking. Use for current events or information not in the room. Returns a title, a URL, and which engine found it — NOT the page's text, so call fetch_page on a URL to actually read it.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Short search query" } },
          required: ["query"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "fetch_page",
        description:
          "Fetch one web page by URL and return its readable text. If the result is truncated, call again with the same url and the start value from the truncation notice to read further.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL" },
            start: {
              type: "integer",
              description:
                "Character offset to continue reading a long page; use the value from the truncation notice.",
            },
          },
          required: ["url"],
        },
      },
    });
  }
  return tools;
}

// ----------------------------------------------------- BROWSE-1 / sketch names

/**
 * The private browser's tool names — the BROWSER AGENT's box. Ported verbatim
 * from `commands::browse::BROWSE_TOOL_NAMES`. Reserved in
 * {@link BUILTIN_TOOL_NAMES} so a connected MCP server can never shadow a
 * `browse_*` arm.
 */
export const BROWSE_TOOL_NAMES: readonly string[] = [
  "browse_open",
  "browse_read",
  "browse_find",
  "browse_snapshot",
  "browse_do",
  "browse_look",
  // BROWSE-2: capture the live page (or the user's selection) into the room.
  "browse_save",
];

/** Ported verbatim from `commands::browse::is_browse_tool`. */
export function isBrowseTool(name: string): boolean {
  return BROWSE_TOOL_NAMES.includes(name);
}

/**
 * The sketch page's tool names. Ported verbatim from
 * `commands::sketch::DRAW_TOOL_NAMES` — TWO, not three, deliberately (see the
 * Rust source's own comment: a third `see_drawing` that differed only in
 * whether pixels rode along is exactly the near-duplicate a 4B picks between
 * wrongly).
 */
export const DRAW_TOOL_NAMES: readonly string[] = ["draw", "read_drawing"];

// --------------------------------------------------------- browse_tools_specs

/**
 * BROWSE-1: the private browser's tool specs. Ported VERBATIM from
 * `commands::browse::browse_tools_specs` (browse.rs lines ~72-107).
 *
 * Advertised only while the room's Online-features switch is on (see
 * `bridgeDispatcher.ts`'s `scopedSpecs`) — a room that is not browsing must
 * not pay these tokens on every turn.
 *
 * Read the wording twice before changing it: `browse_open` deliberately
 * accepts PLAIN WORDS as well as a URL (it IS the room's search, over the
 * room's own seven engines), `browse_read` pages with `mode`/`offset`, and
 * `browse_do` takes an `actions` ARRAY so related steps batch into one call.
 * A paraphrase that keeps the gist but loses those three facts changes what
 * the model can do.
 */
export function browseToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "browse_open",
        description:
          'Open a web page in the room\'s private browser and return the page\'s interactive elements — or, when you pass plain words instead of an address, search the room\'s own seven engines and return the ranked results to open. The browser keeps nothing — no history, cookies or cache. Never navigate to google.com or another search engine to search: this tool IS the search. Examples: {"url": "https://example.com"} · {"url": "tallest building in europe"}',
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "A full http(s) URL or bare domain to open, OR plain words to search for when no site is named",
            },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_read",
        description:
          "Read the CURRENT page as text. This is the cheapest way to answer a question about a page — prefer it over snapshot/click loops whenever you only need to KNOW something rather than operate the page. Returns readable content with links; call again with a larger offset to continue a long page.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["main", "full"],
              description:
                "main = just the article/body (default); full = the whole page including navigation",
            },
            offset: {
              type: "integer",
              description: "Character offset to continue from when the previous read was truncated",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_find",
        description:
          'Find controls on the current page whose label contains some text, without paying for a full snapshot. Returns the matching refs. Example: {"text": "sign in"}',
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Text to look for in element labels" } },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_snapshot",
        description:
          "List the current page's interactive elements as refs (e1, e2, …) with role, label and region. Take a fresh one before acting — refs go stale when the page changes. Password fields are never listed: they are fenced and the user must type those.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_do",
        description:
          'Perform one or more actions on the current page, in order, stopping at the first failure. Batch related steps into ONE call rather than calling repeatedly. Returns what happened plus a fresh snapshot. Example: {"actions": [{"type": {"ref": "e3", "text": "hello", "clear": true}}, {"click": "e7"}]}',
        parameters: {
          type: "object",
          properties: {
            actions: {
              type: "array",
              description:
                'Actions in order. Each is ONE of: {"click": "e4"} | {"type": {"ref": "e3", "text": "...", "clear": true, "submit": true}} | {"select": {"ref": "e5", "value": "..."}} | {"scroll": "down"|"up"|"top"|"bottom"} | {"scroll": {"to": "e9"}} | {"key": "Enter"} | {"click_at": {"x": 120, "y": 340}} | {"back": true} | {"wait_for": {"text": "..."}}',
              items: { type: "object" },
            },
          },
          required: ["actions"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_look",
        description:
          "Look at the current page as an image, with each interactive element's number drawn on it — the SAME numbers browse_snapshot returns, so you can read the list and see the layout together. Use it for layout questions, canvases, maps, or to check what actually happened after an action.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "browse_save",
        description:
          "Save the CURRENT page into the room as files: the readable article as Markdown (searchable) plus a formatted HTML copy, both under the metadata the page declares — site, author, publication date. Captures the live page as rendered, logins and scripts included — works where fetch_page can't. what=selection saves only the text the user has selected on the page.",
        parameters: {
          type: "object",
          properties: {
            what: { type: "string", enum: ["page", "selection"], description: "Default page" },
          },
        },
      },
    },
  ];
}

// ------------------------------------------------ workflow / draw tool specs

/**
 * Wave 4a (Idea 2): the workflow-authoring tools. Ported VERBATIM from
 * `commands::jobs::workflow::workflow_tools_specs`. Their `exec_tool` arms
 * belong to Batch C (the jobs/workflow engine) and are stubbed in
 * `execTool.ts` — the SPECS are here regardless, because `scopedSpecs` and
 * `builtinParamSchemas` both read them and a catalog missing a tool is a
 * capability the engine silently loses.
 */
export function workflowToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "list_workflows",
        description:
          "List the saved workflows in this room (name, id, status, schedule), and the full node reference you need to write one. Call this FIRST when creating or changing a workflow. Pass `name` to get one workflow's definition JSON — needed before update_workflow.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Optional: a workflow name to fetch its full definition" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_workflow",
        description:
          "Create a reusable multi-step workflow as a DRAFT the user reviews and activates on the Workflows page. `definition` is a graph of nodes + edges — call list_workflows first for the full node reference (kinds, `select` types, {{input}}/{{files}}/{{date}}, and a worked example). Validation is strict: an invalid definition comes back as a numbered list to fix. After saving, don't stop there: call test_workflow to actually RUN it, read which step failed, fix it with update_workflow, and test again until test_workflow returns `VALIDATED: yes` — only then tell the user the draft is ready to activate. NEVER tell the user it's fixed or works before a test returns `VALIDATED: yes`; a script_run step can only be confirmed by an approved run on the Scripts page.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            emoji: { type: "string" },
            definition: { type: "object", description: "The workflow graph {version, nodes, edges}" },
            binding: { type: "object", description: "Optional {scope: general|file, kinds?, exts?, file_id?}" },
            schedule: { type: "object", description: "Optional {kind: interval|daily|weekly, param}" },
          },
          required: ["name", "definition"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_workflow",
        description:
          "Change an existing workflow (fetch it first with list_workflows). Same validation as save_workflow. Updating an ACTIVE workflow returns it to draft until the user re-activates it — the review gate.",
        parameters: {
          type: "object",
          properties: {
            name_or_id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            emoji: { type: "string" },
            definition: { type: "object" },
            binding: { type: "object" },
            schedule: { type: "object" },
          },
          required: ["name_or_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_workflow",
        description:
          "Delete a workflow and its schedule/run history. Any unfinished run is cancelled first. Use only when the user explicitly asks to delete that workflow.",
        parameters: {
          type: "object",
          properties: { name_or_id: { type: "string", description: "Workflow name or id" } },
          required: ["name_or_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_workflow",
        description:
          "Run an ACTIVE workflow now, in the background. Optionally pass `file` (a file name) for a file-scoped workflow. After starting it, tell the user it is underway — do not wait for it or poll.",
        parameters: {
          type: "object",
          properties: {
            name_or_id: { type: "string" },
            file: { type: "string", description: "Optional file name for a file-scoped workflow" },
          },
          required: ["name_or_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "test_workflow",
        description:
          "TEST a workflow you're building: run it (draft or active) to completion RIGHT NOW and get the result of every step back, so you can see what failed and fix it. This is how you iterate — save_workflow (draft) → test_workflow → read the failing step → update_workflow to fix it → test_workflow again → repeat until the result says `VALIDATED: yes`, then tell the user it's ready to activate. The result ends with `VALIDATED: yes` only when every step actually ran; treat `VALIDATED: no` as not-yet-working and never report success on it. Unlike run_workflow this WAITS and returns the outcome (each step's label, kind, whether it was skipped, and a preview of its output). It never changes the workflow's status — a tested workflow stays a DRAFT for the user to review and activate. A script_run step needs the user's approval (you can't approve code), so it PARKS in a test and comes back `VALIDATED: no` — that does NOT mean the script works; tell the user to approve and run it on the Scripts page, don't claim it's fixed. Only runs when no other job is busy; if it says another job is running, ask the user to wait and try again. Pass `file` (a file name) for a file-scoped workflow.",
        parameters: {
          type: "object",
          properties: {
            name_or_id: { type: "string" },
            file: { type: "string", description: "Optional file name for a file-scoped workflow" },
          },
          required: ["name_or_id"],
        },
      },
    },
  ];
}

export function drawToolsSpecs(): OllamaToolSpec[] {
  const scriptArgDoc =
    "Commands, ONE PER LINE. Page 1600x1000, whole numbers, " +
    "colours pink/yellow/green/blue/red.\n" +
    'rect|ellipse X Y W H [colour] [fill] "label"\n' +
    'text X Y [colour] [size] "words"\n' +
    'arrow|line X1 Y1 X2 Y2 [colour] ["label"]\n' +
    'link A B [colour] ["label"] = arrow BETWEEN two shapes; prefer over arrow\n' +
    'move ID DX DY | label ID "new" | ink ID colour | delete ID | clear\n' +
    "A/B/ID = an id on the page (e3), or #1/#2 = 1st/2nd shape this script draws.";
  return [
    {
      type: "function",
      function: {
        name: "draw",
        description:
          "Draw on a room sketch. Put EVERY shape in one call's script — never one call per shape. Starts a new sketch if the name is new. Read it first when changing existing work, and read_drawing after to check.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Sketch to draw on; a new name starts one" },
            script: { type: "string", description: scriptArgDoc },
          },
          required: ["name", "script"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_drawing",
        description:
          "Look at a sketch: every shape with its id, position and label in draw's own commands, plus measured problems — overlaps, shapes off the page, unlabelled shapes, arrows that stop short. Use it before changing existing work, and again after drawing to check yourself.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Which sketch; omit if the room has one" } },
        },
      },
    },
  ];
}

// ------------------------------------------------------------------ WebLanes

/**
 * The room's two per-agent web switches. Ported verbatim from
 * `commands::WebLanes` — a two-field record, NOT an opaque predicate: which
 * lanes exist is a settled product decision (`web_agent_search` /
 * `web_agent_browse`), and the bridge's own catalog filter reads them by name.
 *
 * ABSENT MEANS ON: every room that existed before the toggles keeps its
 * behaviour without a migration, which is why {@link WEB_LANES_ALL} is the
 * default rather than a derived all-false.
 */
export interface WebLanes {
  /** `web_search` + `fetch_page` + the download verbs — the Web agent
   * (`chat.web`). */
  readonly search: boolean;
  /** The `browse_*` tools — the Browser agent (`chat.browse`). */
  readonly browse: boolean;
}

/** Both lanes on: what every room did before the toggles existed, and what an
 * unset setting still means. Ported from `WebLanes::ALL`. */
export const WEB_LANES_ALL: WebLanes = { search: true, browse: true };

/** Is `lanes` the "everything on" configuration? The `!=` short-circuit
 * `served_tools_with` uses before it filters at all. */
export function webLanesAreAll(lanes: WebLanes): boolean {
  return lanes.search && lanes.browse;
}

/**
 * Is this tool name gated by a lane that is currently off? Ported verbatim
 * from `WebLanes::blocks`.
 *
 * The download verbs ride with SEARCH because the Web agent is where they are
 * boxed — without them here, "Web agent off" left saving a link, downloading
 * a file and downloading a video all still reachable, and the agent still
 * reachable with them.
 */
export function webLanesBlock(lanes: WebLanes, name: string): boolean {
  if (!lanes.search && (name === "web_search" || name === "fetch_page" || DOWNLOAD_TOOL_NAMES.includes(name))) {
    return true;
  }
  if (!lanes.browse && isBrowseTool(name)) {
    return true;
  }
  return false;
}
