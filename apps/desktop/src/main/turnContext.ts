/**
 * The PURE half of a chat turn: every helper `gatherContext.ts` and
 * `turnEngine.ts` need that touches neither the database nor the network, so
 * each one can be pinned against the Rust source's own test fixtures.
 *
 * Ported from `src-tauri/src/commands/agent.rs` — `explicit_skill_request`,
 * `advertise_skills`, `style_paragraph`/`style_block`, the system-prompt
 * assembly, `is_bare_save_reference`/`is_pure_save_reference`/
 * `requested_file_name`/`find_ci`, `pixels_reach_chat_model` — plus the small
 * pure helpers this turn's model selection needs from neighbouring modules,
 * each cited on its own function: `commands.rs`'s constants and budget
 * formulas, `commands/models.rs`'s `is_embedding_model`/`best_default`,
 * `commands/external.rs`'s `split_external_model`/`is_cli_engine`,
 * `commands/vision.rs`'s `is_locate_intent`, `extraction.rs`'s `is_image`, and
 * `commands/moonshot/roles.rs`'s `role_instructions`.
 *
 * Everything already ported elsewhere is REUSED, never re-declared here:
 * `clampChars`/`clampWords`/`clampBytesMarked` live in `textClamp.ts`, and the
 * app's own failure notices + the anti-fabrication gate live in
 * `turnNotices.ts` (`emptyReplyNotice`, `isFailureNotice`,
 * `claimsUnbackedAction`) — import them from there.
 */

import { clampWords } from "./textClamp.js";
import type { TurnEvidencePolicy } from "./turnContextRequests.js";

export {
  advertiseSkills,
  explicitSkillRequest,
  explicitlyNamedRoomFiles,
  explicitlyProhibitsToolsOrSources,
  isBareSaveReference,
  isPureSaveReference,
  requestedFileName,
  resolveTurnEvidencePolicy,
  stripStoppedSuffix,
  type TurnEvidencePolicy,
} from "./turnContextRequests.js";

// ------------------------------------------------------------------ constants

/** `commands.rs:174` — how many of a chat's most recent rows a turn reads
 * before {@link historyBudgetBytes}-driven compaction trims them. */
export const AGENT_HISTORY_MESSAGES = 200;

/** `commands.rs:163` — the same number under the name the hand-off's own
 * history read uses. */
export const MAX_HISTORY_MESSAGES = AGENT_HISTORY_MESSAGES;

/** `commands.rs:183` — the backstop byte budget for a whole conversation. */
export const HISTORY_HANDOFF_MAX = 200_000;

/** `token_usage.rs:25` — deliberately LOW, so a budget overstates tokens
 * (the safe direction). */
export const CHARS_PER_TOKEN = 3;

/** `commands.rs:246`. */
export const MAX_MEMORY_INJECT_CHARS = 1_500;

/** `commands.rs:153`. */
export const MAX_ATTACHED_IMAGES = 4;

/** `commands.rs:407` — the refusal a turn started mid-rollback carries. */
export const ROLLBACK_BUSY = "The room is rolling back — try again in a moment.";

/** `commands.rs:146` — chat default: text + vision + tool calling. */
export const DEFAULT_MODEL = "qwen3.5:4b";

/** `ollama.rs`'s `EMBED_MODEL`, used here only to recognize an embedding model
 * by name (the embed call itself is out of scope — see `retrieval.ts`). */
const EMBED_MODEL = "nomic-embed-text";

/** `agent.rs:4994`. */
export const SKILL_BODY_TRUNCATED =
  "\n\n… (instructions truncated — the full SKILL.md is longer than this tool can return. " +
  "Work from what is above and say so if the rest was needed.)";

// ------------------------------------------------------------ history budgets

/** `commands.rs::history_budget_bytes` — every engine gets the same flat
 * backstop because the sidecar compacts whatever it receives; the model
 * argument is accepted (signature parity) and unused in the Rust source too. */
export function historyBudgetBytes(_model: string): number {
  return HISTORY_HANDOFF_MAX;
}

/** `commands.rs::handoff_budget_bytes` — two thirds of the engine's window,
 * converted at {@link CHARS_PER_TOKEN}, capped at {@link HISTORY_HANDOFF_MAX}.
 * The hand-off, unlike the agent path, has no compacting receiver. */
export function handoffBudgetBytes(maxContext: number): number {
  const usable = Math.floor(maxContext / 3) * 2;
  return Math.min(usable * CHARS_PER_TOKEN, HISTORY_HANDOFF_MAX);
}

// -------------------------------------------------------------- external.rs

/** `external.rs::split_external_model` — splits a picked cloud selection
 * (`"codex-cli::gpt-5.6-sol::high"`) into `[engineId, model?, effort?]`; a
 * plain local Ollama tag passes through as `[model, undefined, undefined]`.
 *
 * The tail split is Rust's `splitn(3, "::")`, not JS's `split("::")`: anything
 * past the SECOND separator stays INSIDE the effort part rather than being
 * dropped. That matters because the effort is a room-file-controlled value on
 * its way to becoming a `zsh -ilc` word — `externalAdvisor.ts`'s `checkCliSlug`
 * refuses a malformed one outright, and it can only refuse what it is handed.
 * Dropping the tail would silently run `--effort high` for a room that says
 * `high::something-else`, which is precisely the unevidenced success the Rust
 * source refuses. */
const EXTERNAL_ENGINES = new Set(["claude-cli", "codex-cli", "antigravity-cli", "openrouter"]);

function externalModelParts(
  model: string,
  engine: string,
  firstSeparator: number
): [string, string | undefined, string | undefined] {
  if (firstSeparator === -1) {
    return [engine, undefined, undefined];
  }
  const rest = model.slice(firstSeparator + 2);
  const secondSeparator = rest.indexOf("::");
  return secondSeparator === -1
    ? [engine, rest, undefined]
    : [engine, rest.slice(0, secondSeparator), rest.slice(secondSeparator + 2)];
}

export function splitExternalModel(model: string): [string, string | undefined, string | undefined] {
  const firstSeparator = model.indexOf("::");
  const engine = firstSeparator === -1 ? model : model.slice(0, firstSeparator);
  if (!EXTERNAL_ENGINES.has(engine)) {
    return [model, undefined, undefined];
  }
  return externalModelParts(model, engine, firstSeparator);
}

/** `external.rs::is_external_engine` — any non-local engine. */
export function isExternalEngine(model: string): boolean {
  const base = splitExternalModel(model)[0];
  return base === "claude-cli" || base === "codex-cli" || base === "antigravity-cli" || base === "openrouter";
}

/** `external.rs::is_cli_engine` — only the CLI-backed engines run as a
 * subprocess; `openrouter` is non-local too but goes through the
 * provider-aware sidecar. */
export function isCliEngine(model: string): boolean {
  const base = splitExternalModel(model)[0];
  return base === "claude-cli" || base === "codex-cli" || base === "antigravity-cli";
}

// ---------------------------------------------------------------- models.rs

/** `models.rs::is_embedding_model` — an embedding-only model answers
 * `/api/embed` but not `/api/chat`, so it must never be picked as the chat
 * model. */
export function isEmbeddingModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith(EMBED_MODEL) || m.includes("embed") || m.includes("bge-");
}

/** `models.rs::installed_default` — the installed tag that IS the default,
 * exact match preferred over a build-suffixed one (`qwen3.5:4b-mlx`). */
function installedDefault(models: readonly string[]): string | undefined {
  return models.find((m) => m === DEFAULT_MODEL) ?? models.find((m) => m.startsWith(DEFAULT_MODEL));
}

/** `models.rs::best_default` — the tuned default in whatever build form it is
 * actually installed as, else the first chat-capable model, else the bare
 * default name. */
export function bestDefault(models: readonly string[]): string {
  if (models.length === 0) {
    return DEFAULT_MODEL;
  }
  return installedDefault(models) ?? models.find((m) => !isEmbeddingModel(m)) ?? DEFAULT_MODEL;
}

// -------------------------------------------------------------- extraction.rs

/** `extraction::is_image` — pure string matching. */
export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

// ------------------------------------------------------------- vision.rs seam

/** What a `prepareImage` implementation hands back — mirrors
 * `vision::prepare_image`'s `(Vec<u8>, f64, f64)` return. */
export interface PreparedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * An explicitly-labelled NO-OP `prepareImage`: the original bytes through
 * unchanged, width/height `0`.
 *
 * NOT a real substitute for `vision::prepare_image` (no transcode, no resize,
 * no square-canvas fitting that a vision model's box coordinates depend on) —
 * no Node image library is wired into this migration yet, so this is the
 * honest placeholder rather than a fabricated resize. Two consequences a
 * caller must know: Ollama may refuse an unusual source format (WebP/HEIC),
 * and the reported `0×0` dimensions would misplace boxes — so a caller that
 * wires a REAL `groundingPass` must wire a real `prepareImage` with it.
 */
export function passthroughPrepareImage(bytes: Buffer): PreparedImage {
  return { bytes, width: 0, height: 0 };
}

/**
 * `agent.rs::pixels_reach_chat_model` — will the pixels a perception tool
 * captures actually REACH the chat model? Capability is necessary but not
 * sufficient: the room's privacy door strips every image out of a request
 * bound off this Mac and only COUNTS what it removed, so a capable cloud model
 * in a door-on room is handed none and must be marked blind (it then gets a
 * LOCAL vision model's description instead).
 *
 * Both facts the Rust source reads from unported modules are passed IN rather
 * than looked up — `runsOnThisMac` is `commands::runs_on_this_mac`
 * (`capabilities.rs`'s engine table AND where the transport points) and
 * `privacyActive` is `privacy::active_policy().is_some()`. Same pairing the
 * Rust function makes for `engine_sees_images`, and for the same reason: the
 * decision is worth testing without a network.
 */
export function pixelsReachChatModel(
  model: string,
  engineSeesImages: boolean,
  deps: { runsOnThisMac: (model: string) => boolean; privacyActive: () => boolean }
): boolean {
  return engineSeesImages && (deps.runsOnThisMac(model) || !deps.privacyActive());
}

// ------------------------------------------------------------- slash skills

// ------------------------------------------------------- D11 room personas

/**
 * `moonshot/roles.rs::role_instructions`, narrowed to the id -> persona
 * instructions lookup a turn needs. The full `RoomRole` catalog (`list_roles`:
 * blurbs, suggested prompts/commands, the Settings picker) is a separate
 * command surface, out of scope here; only the instructions text is
 * reproduced, verbatim.
 */
const ROLE_INSTRUCTIONS: ReadonlyMap<string, string> = new Map([
  ["default", ""],
  [
    "tutor",
    "You are a patient tutor. Explain concepts step by step in plain language, check " +
      "understanding with short questions, and ground every explanation in the room's files.",
  ],
  [
    "critic",
    "You are a sharp but fair critic. Point out weaknesses, unstated assumptions, and gaps, " +
      "and suggest concrete improvements — always grounded in the room's files, never harsh " +
      "for its own sake.",
  ],
  [
    "opposing-counsel",
    "You act as opposing counsel. Make the strongest good-faith case AGAINST the user's " +
      "position, cite the room's documents for every point, and flag the risks they would " +
      "face — so they can prepare. You are not their lawyer and give no legal advice.",
  ],
  [
    "scribe",
    "You are a meticulous scribe. Capture decisions, action items, and open questions in " +
      "clean, well-structured notes, using only what the room's files and this conversation " +
      "contain.",
  ],
]);

/** The persona instructions for a saved `room_role` id, or `""` for the plain
 * "default" role or an unknown id. */
export function roleInstructions(id: string): string {
  return ROLE_INSTRUCTIONS.get(id) ?? "";
}

// ------------------------------------------- Wave 1b: response-style presets

const STYLE_TERSE =
  'Response style: TERSE. Answer in the fewest words that fully answer. Use short sentences or bullets. Use precise technical vocabulary; never simplify terminology. No greetings, no restating the question, no "Sure" or "Great question", no closing offers like "Let me know if you need more". Example — Q: "When does the lease end?" A: "March 31, 2027 (lease.pdf, section 2)."';

const STYLE_FRIENDLY =
  'Response style: FRIENDLY. Sound like a helpful colleague: warm, plain everyday words, address the user as "you". At most one short warm phrase per answer, then get straight to the point — the answer itself must arrive in the first sentence. After the direct answer, briefly explain the why or the context. Example — Q: "When does the lease end?" A: "Good news — your lease runs until March 31, 2027 (it\'s in lease.pdf, section 2)."';

const STYLE_FORMAL =
  'Response style: FORMAL. Write complete sentences in professional business language. No slang, no contractions, no exclamation marks, no emoji. State findings precisely and cite the file. For multi-part answers, use short headings or numbered points. Example — Q: "When does the lease end?" A: "The lease terminates on 31 March 2027, as stated in Section 2 of lease.pdf."';

/** `agent.rs::style_paragraph` — `null`/`"default"`/an unknown value all map
 * to `null`, so an absent or unrecognized setting produces a system prompt
 * byte-identical to one with no style at all. */
export function styleParagraph(style: string | null): string | null {
  switch (style) {
    case "terse":
      return STYLE_TERSE;
    case "friendly":
      return STYLE_FRIENDLY;
    case "formal":
      return STYLE_FORMAL;
    default:
      return null;
  }
}

/** `agent.rs::style_block` — the preset paragraph plus, ONLY when the user
 * also has custom instructions, one precedence sentence (free text always wins
 * over the preset). */
export function styleBlock(style: string | null, hasCustomInstructions: boolean): string | null {
  const para = styleParagraph(style);
  if (para === null) {
    return null;
  }
  return hasCustomInstructions
    ? `${para} If the user's standing preferences below say otherwise, follow the user's preferences.`
    : para;
}

// ------------------------------------------------------------ system prompt

/**
 * The byte-stable base of every turn's system prompt (ADD-22: unchanged across
 * a whole conversation so Ollama reuses the cached KV prefix, measured
 * elsewhere at 40-65% faster first token). Transcribed VERBATIM from
 * `agent.rs`'s literal (lines ~898-947) — the line structure below is source
 * formatting only; on the wire this is one continuous string, exactly as
 * Rust's backslash-continued literal is. Never re-wrap or reword it.
 */
export const BASE_SYSTEM_PROMPT =
  'You are the private AI assistant inside "Arcelle", a local encrypted workspace. Everything you see stays on this computer. Answer the user\'s question using the file excerpts provided as context when they are relevant, and mention the file names you drew from. If the room\'s content does not contain the answer, say so, then answer from general knowledge if you can. Be concise and useful.\n\n' +
  "You can control the app with your tools: list_room_files, search_room (find content), open_file (show a file to the user in the viewer — it can jump to a page, cell, or text), mark_image (draw boxes on an image), annotate_file (highlight an exact quote or a cell range in a document or spreadsheet so the user sees it), create_file (save a new note/document into the room), edit_file (replace exact text in ONE place in an existing file — text, code, csv, or docx), edit_files (change several places/files, or rename + update references, in ONE atomic step — all succeed or none do), write_file (rewrite a whole text file), set_cells (change a spreadsheet cell by A1 reference like B7), rename_file (rename a file), move_file (move a file into a folder), add_memory (remember something permanently). Use them whenever the user asks you to open, show, mark, find, create, change, rename, move or remember something — then give your answer in plain text. Before editing or annotating, copy text exactly as it appears in the file (search_room shows it verbatim).\n\n" +
  "CRITICAL — never fabricate an action:\n" +
  '- To change a file you MUST call edit_file, write_file, or set_cells. NEVER say a file was changed, edited, updated, saved, or fixed unless that tool call returned success in THIS turn. Do not print a diff, a new version, or "File updated" from memory — only a real tool result proves a change happened.\n' +
  "- To highlight or mark a passage you MUST call annotate_file with text copied EXACTLY from the file. If you have not already seen the file's exact text this turn, call open_file or search_room FIRST to read it, then annotate_file with the verbatim quote. Never claim you highlighted, marked, or boxed anything unless annotate_file (or mark_image) returned success this turn — a guessed quote that fails to match is NOT a highlight.\n" +
  "- If a tool call fails or you cannot find the exact text, say so plainly and stop; do not narrate success you did not achieve.\n\n" +
  'The room keeps one shared working-notes file named "Scratch pad.md": when the user asks to jot, note, write down, or record something temporarily, edit_file or write_file that file instead of making a new file; read it with open_file when asked what is on the pad.\n\n' +
  'Scripts: a .py or .js file in the room can be Run with one click and scheduled. When you create or edit a runnable Python script that imports third-party packages, you MUST declare them inline so they install automatically on Run — the user should never have to pip install anything. Put a PEP-723 block at the very top:\n    # /// script\n    # dependencies = ["pandas", "yfinance"]\n    # ///\n' +
  '(a bare `# dependencies = ["pkg", ...]` line also works). List every third-party import; the standard library needs no declaration. Do not tell the user to run pip or create a venv — declaring the dependencies is how the install happens. When a script reads or writes room files, refer to each by its EXACT room file name (e.g. open("ETF Tracker.csv")); you MAY also list them under `# room-inputs:` / `# room-outputs:` for clarity, but you do not have to — the runner auto-copies any room file whose name appears in the script and saves back any it modifies in place (every write is versioned and undoable).';

/** Minimal system boundary for a hard no-tools turn. It intentionally omits
 * room settings, inventory, capability advertisements, and standing context. */
export const NO_TOOLS_NO_SOURCES_SYSTEM_PROMPT =
  "Answer the user's request without tools or sources. You cannot read files, attachments, room data, memories, the web, or connected services in this turn. Use only the user's request, general knowledge, and any explicitly selected skill instructions included with the request. Do not claim that you opened, searched, changed, or verified anything.";

/** The web-access addition, appended only when the room's internet switch is
 * on (`agent.rs` lines ~949-958). */
const WEB_ENABLED_ADDITION =
  "\n\nThe user has turned web access ON for this room. You have two more tools: web_search (find pages) and fetch_page (read one page). IMPORTANT: for any question about current or recent things — weather, news, prices, sports, events, anything after your training data — you MUST call web_search first. Never answer that you lack real-time data: search instead. Mention that you searched the web in your answer.";

const INVENTORY_TRAILER =
  "You can see an image's pixels only when the user attaches it to a question (paperclip); otherwise you still know it exists by name.";

/** Everything {@link buildSystemPrompt} needs beyond the byte-stable base. */
export interface SystemPromptInputs {
  evidencePolicy?: TurnEvidencePolicy;
  webEnabled: boolean;
  /** Connected MCP servers with at least one served tool — the `state.mcp`
   * disclosure sentence. See `gatherContext.ts`'s `connectedMcpServers` dep. */
  connectedMcp: readonly string[];
  /** (display name, mime, cached one-liner), newest first —
   * `listFileInventory`'s own shape, UNTRUNCATED: this function does the same
   * truncate-at-100-with-a-partial-marker Rust does. */
  inventory: ReadonlyArray<readonly [string, string, string | null]>;
  roomRoleId: string | null;
  responseStyle: string | null;
  customInstructions: string | null;
}

function webPrompt(webEnabled: boolean): string {
  return webEnabled ? WEB_ENABLED_ADDITION : "";
}

function connectedMcpPrompt(connectedMcp: readonly string[]): string {
  if (connectedMcp.length === 0) {
    return "";
  }
  return (
    `\n\nThe user has also connected external tool servers to this room: ${connectedMcp.join(", ")}. ` +
    "Their tools are available dynamically through search_mcp_tools and run_mcp_tool and can reach the internet or other apps. Search before choosing a connector tool, then pass the returned exact tool id and arguments to run_mcp_tool. IMPORTANT: when a question needs current or outside information (weather, news, prices, events) and no built-in tool covers it, you MUST search and use a connected tool instead of answering that you lack real-time data. Mention when you did."
  );
}

function inventoryLine(
  name: string,
  mime: string,
  summary: string | null,
  linerBudget: number
): { line: string; remainingBudget: number } {
  if (summary === null || linerBudget === 0 || summary.trim() === "") {
    return { line: `- ${name} (${mime})\n`, remainingBudget: linerBudget };
  }
  const liner = clampWords(summary.trim(), 120);
  return {
    line: `- ${name} (${mime}) — ${liner}\n`,
    remainingBudget: Math.max(0, linerBudget - Buffer.byteLength(liner, "utf8")),
  };
}

function inventoryPrompt(inventory: SystemPromptInputs["inventory"]): string {
  const files = inventory.slice(0, 100);
  const inventoryPartial = inventory.length > 100;
  if (files.length === 0) {
    return "";
  }
  let prompt = "\n\nFiles currently stored in this room:\n";
  let linerBudget = 3_000;
  for (const [name, mime, summary] of files) {
    const item = inventoryLine(name, mime, summary, linerBudget);
    prompt += item.line;
    linerBudget = item.remainingBudget;
  }
  if (inventoryPartial) {
    prompt += "This list is partial (the room has more files) — call list_room_files for the complete list.\n";
  }
  return `${prompt}${INVENTORY_TRAILER}`;
}

function rolePrompt(roomRoleId: string | null): string {
  if (roomRoleId === null) {
    return "";
  }
  const instructions = roleInstructions(roomRoleId).trim();
  return instructions === "" ? "" : `\n\n${instructions}`;
}

function styleAndCustomPrompt(responseStyle: string | null, customInstructions: string | null): string {
  const custom = (customInstructions ?? "").trim();
  const style = styleBlock(responseStyle, custom !== "");
  const stylePrompt = style === null ? "" : `\n\n${style}`;
  const customPrompt = custom === "" ? "" : `\n\nThe user has set these standing preferences for how you respond:\n${custom}`;
  return `${stylePrompt}${customPrompt}`;
}

/** `agent.rs`'s system-prompt assembly (the `let mut system = …` block, lines
 * ~898-1046) — pure, so its byte-stability can be pinned by a test. */
export function buildSystemPrompt(inputs: SystemPromptInputs): string {
  if (inputs.evidencePolicy === "no-tools-no-sources") {
    return NO_TOOLS_NO_SOURCES_SYSTEM_PROMPT;
  }
  return (
    BASE_SYSTEM_PROMPT +
    webPrompt(inputs.webEnabled) +
    connectedMcpPrompt(inputs.connectedMcp) +
    inventoryPrompt(inputs.inventory) +
    rolePrompt(inputs.roomRoleId) +
    styleAndCustomPrompt(inputs.responseStyle, inputs.customInstructions)
  );
}

// -------------------------------------------------------------- locate intent

function containsIntentTerm(question: string, terms: readonly string[]): boolean {
  return terms.some((term) => question.includes(term));
}

function refersToImage(question: string, imageName: string | null): boolean {
  const imageTerms = ["image", "screenshot", "photo", "picture", "png", "jpg", "jpeg", "scan"];
  if (containsIntentTerm(question, imageTerms)) {
    return true;
  }
  return imageName !== null && question.includes(imageName.toLowerCase());
}

/** `vision.rs::is_locate_intent` — does the question want boxes drawn on the
 * attached image? Ported verbatim (pure text logic; the vision call itself is
 * an injected seam — see `turnEngine.ts`'s `groundingPass`). */
export function isLocateIntent(question: string, imageName: string | null): boolean {
  const normalized = question.toLowerCase();
  // Names a different, non-image target → an annotate_file/open_file job.
  const otherTargets = ["pdf", "spreadsheet", "sheet", "workbook", "document", "the doc", "report", "the page"];
  if (containsIntentTerm(normalized, otherTargets)) {
    return false;
  }
  const strongTerms = [
    "mark ",
    "mark the",
    "locate",
    "point to",
    "point out",
    "circle",
    "find where",
    "where is",
    "where are",
    "where's",
  ];
  if (containsIntentTerm(normalized, strongTerms)) {
    return true;
  }
  // Ambiguous document/general verbs need an image reference too.
  return containsIntentTerm(normalized, ["highlight", "show me", "find the", "find all"])
    && refersToImage(normalized, imageName);
}
