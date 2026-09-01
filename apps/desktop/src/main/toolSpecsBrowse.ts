import { DOWNLOAD_TOOL_NAMES, type OllamaToolSpec } from "./toolSpecsTypes.js";

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
          "Look at a sketch through its real PNG pixels, plus every shape with its id, position and label in draw's own commands and measured problems — overlaps, shapes off the page, unlabelled shapes, arrows that stop short. Use it before changing existing work, and again after drawing to check yourself.",
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

function isSearchLaneTool(name: string): boolean {
  return name === "web_search" || name === "fetch_page" || DOWNLOAD_TOOL_NAMES.includes(name);
}

function blocksSearchLane(lanes: WebLanes, name: string): boolean {
  return !lanes.search && isSearchLaneTool(name);
}

function blocksBrowseLane(lanes: WebLanes, name: string): boolean {
  return !lanes.browse && isBrowseTool(name);
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
  return blocksSearchLane(lanes, name) || blocksBrowseLane(lanes, name);
}
