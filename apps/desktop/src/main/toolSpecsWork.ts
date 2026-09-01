import type { OllamaToolSpec } from "./toolSpecsTypes.js";

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
