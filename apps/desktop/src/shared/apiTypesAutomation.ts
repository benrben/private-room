// ------------------------------------------------------------ Wave 4a: workflows

/** Where a workflow surfaces. `general` = library/top bar; `file` = a file's
 * Actions menu, run on that file. */
export type WorkflowBinding =
  | { scope: "general" }
  | { scope: "file"; kinds?: string[]; exts?: string[]; file_id?: string | null };

/** A saved LLM graph workflow. `definition`/`binding` are opaque JSON here. */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  definition: WorkflowDef;
  status: "draft" | "active";
  createdBy: "user" | "agent" | "script";
  binding: WorkflowBinding;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The node graph. Nodes carry a `kind` discriminant plus its params. */
export interface WorkflowDef {
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowNode {
  id: string;
  label?: string;
  kind:
    | "generate"
    | "summarize_file"
    | "file_pass"
    | "for_each_file"
    | "agent_run"
    | "extract"
    | "route"
    | "vote"
    | "refine"
    | "plan_and_map"
    | "transform"
    | "merge"
    | "http_fetch"
    | "script_run"
    | "save_file"
    | "condition";
  // Kind-specific params (flattened): prompt/model/select/instruction/mode/
  // name_template/format/question/op/value/fields/labels/samples/rubric/
  // objective/url/file/find/separator. Kept loose so the param sheet edits
  // them generically.
  [key: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** "then"/"else" off a condition, or one of a route node's labels; absent
   * otherwise. */
  branch?: string | null;
}

export interface Schedule {
  id: string;
  workflowId: string;
  kind: "interval" | "daily" | "weekly";
  param: string;
  enabled: boolean;
  catchUp: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
}

export interface ScheduleArg {
  kind: string; // interval|daily|weekly, or "" to clear
  param?: string;
  enabled?: boolean;
  catchUp?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  jobId: string | null;
  trigger: string;
  status: string;
  error: string | null;
  inputFileId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  emoji: string;
  binding: WorkflowBinding;
  schedule?: ScheduleArg;
  definition: WorkflowDef;
}

/** One `workflow-node` event — a node's live status during a run. */
export interface WorkflowNodeEvent {
  jobId: string;
  workflowId: string;
  nodeId: string;
  status: "running" | "done" | "skipped" | "error";
  peek?: string | null;
}

// ------------------------------------------------------------ Wave 5: scripts

/** A `.py`/`.js` room file as a first-class runnable/schedulable script. Its run
 * history/schedule come from the same `workflow_runs`/`schedules` rows as
 * everything else, via a hidden per-script auto-workflow. */
export interface ScriptInfo {
  fileId: string;
  name: string;
  lang: "py" | "js";
  deps: string[];
  inputs: string[];
  outputs: string[];
  /** Where it surfaces as a one-click shortcut. */
  shortcut: "global" | "file" | "none";
  /** True when this exact content is approved to run on this Mac. */
  approved: boolean;
  /** Ran/scheduled before, but the current content isn't approved (edited). */
  changedSinceApproval: boolean;
  workflowId: string | null;
  schedule: Schedule | null;
  lastRun: WorkflowRun | null;
  /** How many of the most-recent runs failed with the SAME error (newest-first;
   * 0 = latest run didn't fail). Drives the single "incident" card. */
  consecutiveFailures: number;
  /** The shared error text of that failure streak, or null when not failing. */
  lastError: string | null;
}

/** The parsed PEP-723 + room-* manifest for one script. */
export interface ScriptManifest {
  interpreter: "py" | "js";
  deps: string[];
  inputs: string[];
  outputs: string[];
  timeoutSecs: number;
  shortcut: "global" | "file" | "none";
}

/** A pending script-run consent prompt from the backend (SEC-1 doctrine). */
export interface ScriptApproveRequest {
  id: string;
  name: string;
  /** The exact command line that would run, e.g. "uv run --no-project x.py". */
  interpreterLine: string;
  deps: string[];
  inputs: string[];
  outputs: string[];
  timeout: number;
}

// ------------------------------------------------------------ Agent Skills

/** Level-1 progressive-disclosure metadata. This is the only part of every
 * enabled skill placed in an ordinary model turn. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdBy: "user" | "agent" | "import";
  /** Which domain agent owns this skill (`agent:` in SKILL.md frontmatter).
   * "" = general: offered to every agent, which is what an ordinary
   * hand-written skill stays. */
  agent: string;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Skill extends Omit<SkillSummary, "resourceCount"> {
  instructions: string;
}

export interface SkillResourceMeta {
  path: string;
  kind: "script" | "reference" | "asset" | "agent" | "resource";
  sizeBytes: number;
  text: boolean;
  updatedAt: string;
}

export interface SkillBundle {
  skill: Skill;
  resources: SkillResourceMeta[];
}

export interface SkillResourceContent {
  path: string;
  kind: string;
  text: string | null;
  dataB64: string | null;
}

// --------------------------------------------------------------- BROWSE-1

/** Live state of the private browser's child webview. */
export interface BrowserInfo {
  open: boolean;
  /** A new tab that has not navigated yet. The native view is parked while
   *  this is true, so the start screen underneath is actually visible. */
  blank?: boolean;
  url?: string | null;
  title?: string | null;
  /** `false` marks a navigation whose previous page stopped answering before
   * the requested page committed; otherwise this is document.readyState. */
  ready?: string | boolean | null;
  takeover?: boolean;
  /** Item #18: the page latched a double Escape — the user is asking for the
   *  keyboard back. True on exactly one poll; the page clears it as it reports
   *  it, so acting on it twice is impossible. */
  leaveRequested?: boolean;
  error?: string;
  /** A passage is selected on the page right now. Carried on this poll rather
   *  than asked for separately — the scope strip needs it every tick to decide
   *  whether to offer a "selected passage" scope at all. */
  hasSelection?: boolean;
  /** What the content blocker actually did. Absent from an older backend, which
   *  `protectionClaim` reads as "unknown" — never as protected. */
  protection?: BrowserProtection;
  /** The browsing sitting the journal is currently writing into, `""` when no
   *  page is open. */
  session?: string;
  /** Real request cancellations on the active page. Absent on older hosts. */
  blockedCount?: number;
}

/** The content blocker's real verdict, asked of WebKit rather than assumed.
 *
 * THE DEFECT THIS TYPE EXISTS FOR (product audit, 2026-08-15): the shield said
 * "Trackers blocked." off `browser_verify_private`, which checks whether the
 * website data store is non-persistent and knows nothing whatsoever about
 * blocking. Meanwhile the room's journal was filling with "Content blocking
 * FAILED to load", and the interface showed a confident protected state
 * throughout. Two different questions had one answer between them.
 *
 * `unknown` is a real state and is never rendered as protected: the rule list
 * compiles asynchronously, so there is a window in which the honest answer is
 * that we do not know yet. */
export type BrowserProtection =
  | { state: "unknown" }
  | { state: "active" }
  | { state: "failed"; reason: string }
  | { state: "unavailable"; reason: string };

/** One slice of the current page as text (`browser_page_text`).
 *
 * The raw page-script answer, not a formatted string: the reading view follows
 * `truncated`/`nextOffset` itself so it can say how much of the page it is
 * actually showing rather than presenting a slice as the whole thing. */
export interface BrowserPageText {
  url?: string;
  title?: string;
  mode?: "main" | "full";
  offset?: number;
  /** Where the NEXT read must start, in the page script's own UTF-16 units. */
  nextOffset?: number;
  total?: number;
  truncated?: boolean;
  text?: string;
}

/** One open private-browser page (`browser_tabs`).
 *
 * These are never persisted: a restored list of visited URLs is a browsing
 * history, which is the one thing this browser promises not to keep. */
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/** One fused web result (BROWSE-3).
 *
 * The engines that agreed on a URL are kept as a LIST, not collapsed to one
 * name: cross-engine agreement is a ranking signal we can show and a single
 * search engine cannot. */
export interface WebHit {
  title: string;
  url: string;
  /** Every engine that returned this URL, in the fusion's priority order. */
  engines: string[];
  date?: string | null;
  /** The engine's own blurb, upgraded to the page's `meta description` once
   *  the enrich pass has read it. */
  snippet?: string | null;
  score: number;
}

/** What the browser's results page renders for one search (BROWSE-3). */
export interface BrowserSearchResult {
  hits: WebHit[];
  /** Raw hits collected across all engines before dedup — the honest
   *  denominator behind "31 merged into 12". */
  merged: number;
  tookMs: number;
  /** Served from this Mac's 15-minute cache, no network touched. */
  cached: boolean;
  /** Engines that could not answer — blocked, rate limited or too slow. A
   *  thin result set with two engines down is not the same page as a thin
   *  result set from a whole working fan-out, and only this says which. */
  failed?: string[];
  query: string;
  /** False when the room turned result previews off: every card keeps its
   *  monogram tile and no result origin is contacted. */
  previewsEnabled: boolean;
  /** False when the room has no engine configured — the view must not offer a
   *  summary button that can only fail. */
  summaryAvailable: boolean;
}

/** One result's preview, from the enrich pass (BROWSE-3b).
 *
 * Images arrive as data URLs because the results page must never fetch
 * anything itself — every byte comes through the Rust guard. */
export interface ResultPreview {
  url: string;
  image?: string | null;
  icon?: string | null;
  description?: string | null;
  title?: string | null;
  /** The page was read; if `image` is still null it simply has no preview
   *  image, and the card should stop waiting and keep its monogram tile. */
  done: boolean;
}

/** One row of the browser's audit trail.
 *
 * The inversion that makes the private browser trustworthy: the WEB persists
 * nothing (non-persistent data store — no history, cookies or cache), while
 * everything the AGENT did persists here, inside the encrypted room.
 */
export interface BrowseJournalRow {
  id: number;
  at: string;
  /** open | search | read | act | look | consent | save | download | blocked |
   *  blocker | error | takeover. Free-form in Rust — `browserJournal.ts` holds
   *  the one map from these to the panel's filters, and shows anything it does
   *  not recognise rather than hiding it. */
  kind: string;
  url: string;
  detail: string;
  /** The browsing sitting this row belongs to, or `""` for rows written before
   *  sittings were recorded. What lets the panel default to "what just
   *  happened" instead of every event in the room's history. */
  session: string;
}

/** How much a Clear would erase (`browser_clear_scope`).
 *
 * Clearing the journal also empties the web cache, which the button's own words
 * never mentioned. These counts are what let the confirmation say so. */
export interface BrowseClearScope {
  journal: number;
  searches: number;
  pages: number;
  images: number;
}

/** The passage a person has selected on the live page (`browser_page_selection`).
 *
 * Read-only and journalled NOWHERE: saving is an act worth recording, but a
 * person reading the page in front of them is not the agent doing something.
 * An empty `text` is an honest "nothing is selected", not a failure — a page
 * that genuinely refuses rejects instead. */
export interface BrowserPageSelection {
  text: string;
  url: string;
  title: string;
  truncated: boolean;
  /** The WHOLE selection's length, so a clipped passage can say how much it is
   *  leaving out instead of implying it carries all of it. */
  total: number;
}

/** What one Stop actually stopped (`cancel_ask`).
 *
 * Owner replacement #3: cancellation is a TREE rooted at the run, so a Stop can
 * reach a Studio build or a file pass the answer had started. `stopped` names
 * them, root first, and lists ONLY what this Stop moved from running to
 * stopped — work that had already finished is not in it, because claiming a
 * Stop reached it would be untrue. `known: false` means the host no longer had
 * the run at all (it had just finished), which is not an error but is also not
 * a Stop that stopped anything.
 */
export interface StopReport {
  stopped: string[];
  known: boolean;
}

/** The payload of the `sketch-drawn` event (see `api.onSketchDrawn`). */
export interface SketchDrawn {
  fileId: string;
  name: string;
  added: string[];
  changed: string[];
  removed: string[];
  /** One line per statement the script ran, in order. */
  steps: string[];
  /** The whole document after the write, as JSON. */
  doc: string;
}

/** What the native View menu should be showing (see `api.syncViewMenu`).
 *
 * Sent whole, and this is why: the four ticks and the enabled flag are one
 * fact about one window. A `setCheck(id, bool)` per row would let the menu be
 * observed halfway through a layout change — Assistant already ticked, Focus
 * not yet — for no benefit, since every one of them changes on the same
 * render anyway.
 *
 * `enabled` is false whenever no room is open. The menu bar outlives the room
 * (it is there over the password gate), and a View menu that offers to hide a
 * Library nobody is looking at is a dead control. */
/** One organization change the ASSISTANT made — the payload of
 * `assistant-organized`, and one row in Activity's history.
 *
 * Only what the room can state as fact: which object, and which way. No prose,
 * because the sentence a reader sees is written where it is shown rather than
 * carried across the wire from a model's turn. */
export interface OrganizedChange {
  id: string;
  name: string;
  /** True for "added to the Library", false for "removed from it". */
  linked: boolean;
}

/** One change as Activity holds it: the payload, plus the order it arrived in.
 *
 * The order is not decoration. Add, remove and add again is three acts on one
 * object and two of them are identical — without a counter they are the same
 * row twice, which React cannot tell apart and a reader cannot either. */
export interface OrganizedRecord extends OrganizedChange {
  seq: number;
}

export interface ViewMenuState {
  enabled: boolean;
  library: boolean;
  assistant: boolean;
  focus: boolean;
  railLabels: boolean;
  /** False while the WINDOW, not the reader, is what took the sidebar's labels
   * away — below 1180px the rail drops them on its own and the preference
   * cannot put them back. The row greys out rather than ticking itself off and
   * then refusing to tick back on. The rail's own expander hides for the same
   * reason; a menu row cannot hide. */
  railLabelsSettable: boolean;
  /** What the ⌘1 row is CALLED — the active destination's name for its second
   * column ("Library" at Home, "Sketches" in Sketch, "Private pages" in the
   * browser). A tick alone was never enough: the row named Home's contents
   * wherever it stood. */
  sidebar: string;
}
