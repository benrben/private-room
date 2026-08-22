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

import { clampChars, clampWords } from "./textClamp.js";

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

/** `agent.rs:183-184`. */
const MAX_ADVERTISED_SKILLS = 12;
const MAX_ADVERTISED_SKILL_CHARS = 200;

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
 * plain local Ollama tag passes through as `[model, undefined, undefined]`. */
export function splitExternalModel(model: string): [string, string | undefined, string | undefined] {
  const parts = model.split("::");
  const engine = parts[0] ?? model;
  if (engine !== "claude-cli" && engine !== "codex-cli" && engine !== "openrouter") {
    return [model, undefined, undefined];
  }
  return [engine, parts[1], parts[2]];
}

/** `external.rs::is_external_engine` — any non-local engine. */
export function isExternalEngine(model: string): boolean {
  const base = splitExternalModel(model)[0];
  return base === "claude-cli" || base === "codex-cli" || base === "openrouter";
}

/** `external.rs::is_cli_engine` — only the CLI-backed engines run as a
 * subprocess; `openrouter` is non-local too but goes through the
 * provider-aware sidecar. */
export function isCliEngine(model: string): boolean {
  const base = splitExternalModel(model)[0];
  return base === "claude-cli" || base === "codex-cli";
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

/** `agent.rs::explicit_skill_request` — `"/lease-review check the clause"` ->
 * `{name: "lease-review", request: "check the clause"}`; a bare `/x` yields an
 * empty request. `null` when the question does not open with a valid `/name`
 * (lowercase ascii/digits/hyphen, 1-64 chars). */
export function explicitSkillRequest(question: string): { name: string; request: string } | null {
  const trimmed = question.trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const rest = trimmed.slice(1);
  const ws = /\p{White_Space}/u.exec(rest);
  const end = ws ? ws.index : rest.length;
  const name = rest.slice(0, end);
  if (name.length === 0 || name.length > 64 || !/^[a-z0-9-]+$/.test(name)) {
    return null;
  }
  return { name, request: rest.slice(end).trim() };
}

/** `agent.rs::advertise_skills` — level 1 of skill progressive disclosure: the
 * block offering the room's enabled GENERAL skills at the top of every
 * question. Empty when there are none; a cut always SAYS it was cut, because
 * the model is the only reader and a list that silently ends at twelve is a
 * list it thinks is complete. */
export function advertiseSkills(skills: ReadonlyArray<readonly [name: string, description: string]>): string {
  if (skills.length === 0) {
    return "";
  }
  let out =
    "Available Agent Skills (specialized instructions). If one clearly matches the question, call read_skill before doing the work:\n";
  for (const [name, description] of skills.slice(0, MAX_ADVERTISED_SKILLS)) {
    const desc = clampChars(description, MAX_ADVERTISED_SKILL_CHARS);
    // BYTE lengths, matching Rust's `desc.len() < description.len()`
    // (`String::len()` is UTF-8 bytes). `desc` is always a prefix of
    // `description`, so this agrees with a char comparison either way — the
    // byte form is kept because it is what the source says.
    const ellipsis = Buffer.byteLength(desc, "utf8") < Buffer.byteLength(description, "utf8") ? "…" : "";
    out += `- ${name}: ${desc}${ellipsis}\n`;
  }
  if (skills.length > MAX_ADVERTISED_SKILLS) {
    out += `(…and ${skills.length - MAX_ADVERTISED_SKILLS} more enabled skills, not listed here — call list_skills to see them all.)\n`;
  }
  return `${out}\n`;
}

// -------------------------------------------------- save-that-as-a-file

const NAME_MARKERS = ["called ", "named ", "titled ", "as file ", "בשם "];

/**
 * `agent.rs::find_ci` — case-insensitive substring search returning CODE-POINT
 * `[start, end)` offsets into the ORIGINAL `haystack`.
 *
 * `haystack.toLowerCase().indexOf(needle)` is the obvious version and it is
 * subtly wrong: lowercasing is not length-preserving (Turkish `İ` lowercases
 * to TWO characters), so an index found in the lowered copy can point
 * somewhere else in the original. Sliding a same-length window over the
 * ORIGINAL and lowering only that window keeps every offset native to the
 * string that will actually be cut. `needleLower` must already be lowercase.
 */
function findCi(haystack: string, needleLower: string): [number, number] | null {
  const chars = Array.from(haystack);
  const n = Array.from(needleLower).length;
  if (n === 0) {
    return null;
  }
  for (let k = 0; k + n <= chars.length; k++) {
    if (chars.slice(k, k + n).join("").toLowerCase() === needleLower) {
      return [k, k + n];
    }
  }
  return null;
}

/** Rust's `trim_matches`, code-point-wise: drop leading AND trailing chars the
 * predicate rejects. */
function trimEdgeChars(s: string, keep: (ch: string) => boolean): string {
  const arr = Array.from(s);
  let start = 0;
  let end = arr.length;
  while (start < end && !keep(arr[start]!)) {
    start++;
  }
  while (end > start && !keep(arr[end - 1]!)) {
    end--;
  }
  return arr.slice(start, end).join("");
}

const QUOTE_CHARS = new Set(['"', "'", "“", "”", "„"]);
const SENTENCE_END_CHARS = new Set([".", "!", "?"]);

/** `agent.rs::requested_file_name` — `"…called Summary"` / `"…named Q3 notes"`
 * / `"…בשם סיכום"` -> the requested file name, when the save turn carries one. */
export function requestedFileName(question: string): string | null {
  const q = question.trim();
  for (const marker of NAME_MARKERS) {
    const hit = findCi(q, marker);
    if (hit === null) {
      continue;
    }
    let name = Array.from(q).slice(hit[1]).join("").trim();
    name = trimEdgeChars(name, (ch) => !QUOTE_CHARS.has(ch));
    // `trim_end_matches`: the TRAILING side only.
    const arr = Array.from(name);
    let last = arr.length;
    while (last > 0 && SENTENCE_END_CHARS.has(arr[last - 1]!)) {
      last--;
    }
    name = arr.slice(0, last).join("").trim();
    if (name.length > 0 && Array.from(name).length <= 80) {
      return name;
    }
  }
  return null;
}

/** `agent.rs::is_bare_save_reference` — a short save/record turn whose object
 * is a bare reference ("that", "this", "it", "זה") rather than inline content,
 * so the turn can carry a deterministic anaphora hint. */
export function isBareSaveReference(question: string): boolean {
  const q = question.toLowerCase();
  if (Array.from(q).length > 160) {
    return false;
  }
  const VERBS = [
    "save",
    "keep ",
    "record",
    "write that",
    "write this",
    "write it",
    "note that",
    "note this",
    "jot",
    "שמור",
    "שמרי",
    "תשמור",
    "רשום",
    "רשמי",
  ];
  const REFERENTS = [
    "that",
    "this",
    "it ",
    " it",
    "the above",
    "your answer",
    "your reply",
    "your summary",
    "זה",
    "זאת",
    "את זה",
    "התשובה",
  ];
  return VERBS.some((v) => q.includes(v)) && REFERENTS.some((r) => q.includes(r));
}

const PURE_SAVE_ALLOWED: ReadonlySet<string> = new Set([
  // verbs
  "save", "saves", "saved", "keep", "store", "record", "write", "jot", "note", "put", "add",
  // referents
  "that", "this", "it", "above", "answer", "reply", "response", "message", "text", "output",
  "last", "previous", "your",
  // filler
  "a", "an", "the", "as", "to", "in", "into", "on", "of", "for", "my", "our", "please", "down",
  "here", "just", "new", "file", "files", "document", "doc", "note's", "notes", "room", "library",
  "somewhere",
  // Hebrew equivalents
  "שמור", "שמרי", "תשמור", "רשום", "רשמי", "זה", "זאת", "את", "קובץ", "כקובץ", "חדש", "בחדר",
  "התשובה", "בבקשה", "לקובץ", "אותו",
]);

function isAlnumOrApostrophe(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch) || ch === "'";
}

/**
 * `agent.rs::is_pure_save_reference` — a PURE save-that turn (nothing to do
 * but write the previous reply verbatim) is executed by CODE and the model
 * gets no vote; see `turnEngine.ts`'s `ask` for the fast path this gates.
 *
 * Decided by an ALLOW-list over every word outside an explicit "…called X"
 * name, never a blacklist of transform verbs — those cannot be enumerated, so
 * a blacklist would silently hand "save that translated to Hebrew" to a
 * deterministic copy.
 */
export function isPureSaveReference(question: string): boolean {
  if (!isBareSaveReference(question)) {
    return false;
  }
  let body = question.trim();
  for (const marker of NAME_MARKERS) {
    const hit = findCi(body, marker);
    if (hit !== null) {
      body = Array.from(body).slice(0, hit[0]).join("");
    }
  }
  const words = body
    .split(/[\p{White_Space},;:]/u)
    .map((w) => trimEdgeChars(w, isAlnumOrApostrophe).toLowerCase())
    .filter((w) => w.length > 0);
  return words.every((w) => PURE_SAVE_ALLOWED.has(w));
}

/** The stopped marker the save-that fast path strips off the reply it is
 * copying. Rust does this with `trim_end_matches(" *(stopped)*")`, which
 * removes EVERY trailing repetition, not just one — kept exactly. */
export function stripStoppedSuffix(s: string): string {
  const suffix = " *(stopped)*";
  let out = s;
  while (out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}

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

/** The web-access addition, appended only when the room's internet switch is
 * on (`agent.rs` lines ~949-958). */
const WEB_ENABLED_ADDITION =
  "\n\nThe user has turned web access ON for this room. You have two more tools: web_search (find pages) and fetch_page (read one page). IMPORTANT: for any question about current or recent things — weather, news, prices, sports, events, anything after your training data — you MUST call web_search first. Never answer that you lack real-time data: search instead. Mention that you searched the web in your answer.";

const INVENTORY_TRAILER =
  "You can see an image's pixels only when the user attaches it to a question (paperclip); otherwise you still know it exists by name.";

/** Everything {@link buildSystemPrompt} needs beyond the byte-stable base. */
export interface SystemPromptInputs {
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

/** `agent.rs`'s system-prompt assembly (the `let mut system = …` block, lines
 * ~898-1046) — pure, so its byte-stability can be pinned by a test. */
export function buildSystemPrompt(inputs: SystemPromptInputs): string {
  let system = BASE_SYSTEM_PROMPT;
  if (inputs.webEnabled) {
    system += WEB_ENABLED_ADDITION;
  }
  if (inputs.connectedMcp.length > 0) {
    system +=
      `\n\nThe user has also connected external tool servers to this room: ${inputs.connectedMcp.join(", ")}. ` +
      "Their tools are available dynamically through search_mcp_tools and run_mcp_tool and can reach the internet or other apps. Search before choosing a connector tool, then pass the returned exact tool id and arguments to run_mcp_tool. IMPORTANT: when a question needs current or outside information (weather, news, prices, events) and no built-in tool covers it, you MUST search and use a connected tool instead of answering that you lack real-time data. Mention when you did.";
  }

  // CHG-9 + CHG-23: newest-first inventory, a partial marker, and each file's
  // cached one-liner under a running BYTE budget (Rust's `liner.len()`).
  const inventoryPartial = inputs.inventory.length > 100;
  const inventory = inputs.inventory.slice(0, 100);
  if (inventory.length > 0) {
    system += "\n\nFiles currently stored in this room:\n";
    let linerBudget = 3_000;
    for (const [name, mime, summary] of inventory) {
      if (summary !== null && linerBudget > 0 && summary.trim() !== "") {
        const liner = clampWords(summary.trim(), 120);
        linerBudget = Math.max(0, linerBudget - Buffer.byteLength(liner, "utf8"));
        system += `- ${name} (${mime}) — ${liner}\n`;
      } else {
        system += `- ${name} (${mime})\n`;
      }
    }
    if (inventoryPartial) {
      system += "This list is partial (the room has more files) — call list_room_files for the complete list.\n";
    }
    system += INVENTORY_TRAILER;
  }

  // D11: the room's persona, byte-stable (a constant chosen by a setting), so
  // the ADD-22 KV-cache invariant holds.
  if (inputs.roomRoleId !== null) {
    const instructions = roleInstructions(inputs.roomRoleId).trim();
    if (instructions !== "") {
      system += `\n\n${instructions}`;
    }
  }

  // Wave 1b: the response-style preset rides immediately before the custom
  // instructions, and says itself that the free text below wins.
  const hasCustom = (inputs.customInstructions ?? "").trim() !== "";
  const block = styleBlock(inputs.responseStyle, hasCustom);
  if (block !== null) {
    system += `\n\n${block}`;
  }

  if (hasCustom) {
    system += `\n\nThe user has set these standing preferences for how you respond:\n${inputs.customInstructions!.trim()}`;
  }

  return system;
}

// -------------------------------------------------------------- locate intent

/** `vision.rs::is_locate_intent` — does the question want boxes drawn on the
 * attached image? Ported verbatim (pure text logic; the vision call itself is
 * an injected seam — see `turnEngine.ts`'s `groundingPass`). */
export function isLocateIntent(question: string, imageName: string | null): boolean {
  const q = question.toLowerCase();
  // Names a different, non-image target → an annotate_file/open_file job.
  const OTHER_TARGETS = ["pdf", "spreadsheet", "sheet", "workbook", "document", "the doc", "report", "the page"];
  if (OTHER_TARGETS.some((t) => q.includes(t))) {
    return false;
  }
  const STRONG = [
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
  if (STRONG.some((k) => q.includes(k))) {
    return true;
  }
  // Ambiguous document/general verbs — only when the question refers to the
  // image (an image-referential word, or the image's own file name).
  const WEAK = ["highlight", "show me", "find the", "find all"];
  if (WEAK.some((k) => q.includes(k))) {
    const IMG_REFS = ["image", "screenshot", "photo", "picture", "png", "jpg", "jpeg", "scan"];
    return IMG_REFS.some((r) => q.includes(r)) || (imageName !== null && q.includes(imageName.toLowerCase()));
  }
  return false;
}
