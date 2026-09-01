import { SKILL_AGENT_IDS, type OllamaToolSpec } from "./toolSpecsTypes.js";

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
        name: "view_file_image",
        description:
          "Attach the real pixels of an image or .sketch file in this room so you can visually inspect it. Use this before answering what is shown, visible, written, colored, arranged, or depicted; open_file only opens the viewer for the user and is not visual evidence.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Image or .sketch file name, or a distinctive part of it" },
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
