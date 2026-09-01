import type Database from "better-sqlite3-multiple-ciphers";
import { insertHandoffMessage, listMessages, recentMessages, type Message } from "./db-host/messages.js";
import { compactHistory } from "./db-host/retrieval.js";
import { getSetting } from "./db-host/settings.js";
import { handoffSummary as handoffSummaryReal, listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting, parseTemperature } from "./gatherContext.js";
import { type SidecarChatMessage } from "./sidecar.js";
import { isFailureNotice } from "./turnNotices.js";
import { CHARS_PER_TOKEN, MAX_HISTORY_MESSAGES, bestDefault, handoffBudgetBytes } from "./turnContext.js";
import { OpenRoom, TurnRoomSource } from "./turnEngine.js";

export

/**
 * The newest assistant row that is a real ANSWER: not one of the app's own
 * failure notices, not a marker row, not empty. `is_failure_notice` is the
 * app's own check for "this row is one of OUR notices" — and this path, which
 * turns a previous reply into a FILE, was the one place that never asked it,
 * so a turn that failed left the user with a document containing only the
 * error text and the words "Saved your previous answer".
 */
function lastRealAssistantReply(db: Database.Database, chatId: string): Message | null {
  const rows = listMessages(db, chatId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (m.role === "assistant" && m.kind === null && m.content.trim() !== "" && !isFailureNotice(m.content)) {
      return m;
    }
  }
  return null;
}
export

// ------------------------------------------------------------- handoff_chat

/** `token_usage.rs::CATEGORIES` — the 5 fixed breakdown categories, in the
 * order the frontend legend and segment stack use. Never reordered: a missing
 * or moved key silently drops a segment. */
const TOKEN_USAGE_CATEGORIES = ["system", "history", "tools", "skills", "files"] as const;


/**
 * `token_usage.rs::handoff_usage_value` — the post-handoff `AskTokenUsage`
 * snapshot, in the snake_case shape the sidecar emits.
 *
 * No LLM turn happens during a handoff, so nothing else would update the
 * token-budget bar until the next real one. The recap IS the whole
 * conversation the next turn starts from, so it is charged entirely to
 * `history`; every other category is honestly zero (nothing else exists yet)
 * and the whole snapshot is marked `estimated`.
 */
export function handoffUsageValue(recap: string, maxContext: number): Record<string, unknown> {
  const history = Math.floor(Buffer.byteLength(recap, "utf8") / CHARS_PER_TOKEN);
  const breakdown: Record<string, unknown> = {};
  for (const c of TOKEN_USAGE_CATEGORIES) {
    breakdown[c] = { tokens: c === "history" ? history : 0, estimated: true };
  }
  return { total_tokens: history, max_context: maxContext, estimated: true, breakdown };
}


/** Everything {@link handoffChat} needs beyond the chat id. */
export interface HandoffChatDeps {
  room: TurnRoomSource;
  listModels?: () => Promise<string[]>;
  /**
   * `commands::capabilities_for(model).context_window` — the engine's real
   * advertised window. Out of scope (`capabilities.rs`); the default is
   * "unpublished" (`null`), which is exactly what makes the 128,000 floor
   * below apply — the SAME floor Rust's own call site uses, not a number this
   * port invented.
   */
  contextWindowFor?: (model: string) => Promise<number | null>;
  /**
   * `ollama::handoff_summary`. Defaults to `engineRouting.ts`'s real
   * sidecar-routed call; tests inject a fake so no engine is needed.
   */
  handoffSummary?: (
    model: string,
    messages: SidecarChatMessage[],
    temperature: number | null
  ) => Promise<string>;
}
export interface HandoffInput {
  room: OpenRoom;
  explicitModel: string | null;
  temperature: number | null;
  history: ReturnType<typeof recentMessages>;
}
export function handoffInput(roomSource: TurnRoomSource, chatId: string): HandoffInput {
  const room = roomSource.currentRoom();
  if (room === null) {
    throw new Error("No room is open");
  }
  const newestFirst = recentMessages(room.db, chatId, MAX_HISTORY_MESSAGES);
  if (newestFirst.length === 0) {
    throw new Error("Nothing to summarize yet.");
  }
  return {
    room,
    explicitModel: modelSetting(room.db),
    temperature: parseTemperature(getSetting(room.db, "temperature")),
    history: [...newestFirst].reverse(),
  };
}
export async function handoffModel(explicitModel: string | null, deps: HandoffChatDeps): Promise<string> {
  const models = await (deps.listModels ?? listModelsReal)();
  return explicitModel ?? bestDefault(models);
}
export async function handoffMaxContext(model: string, deps: HandoffChatDeps): Promise<number> {
  const contextWindowFor = deps.contextWindowFor;
  if (contextWindowFor === undefined) {
    return 128_000;
  }
  return (await contextWindowFor(model)) ?? 128_000;
}
export function handoffMessages(history: ReturnType<typeof recentMessages>, maxContext: number): SidecarChatMessage[] {
  return compactHistory(history, handoffBudgetBytes(maxContext)).map(([role, content]) => ({
    role: role as SidecarChatMessage["role"],
    content,
  }));
}
export function handoffRecap(raw: string, total: number, covered: number): string {
  if (raw.trim() === "") {
    throw new Error(
      "The model returned an empty summary, so the conversation was left untouched. Try again, or switch models in Settings → Model."
    );
  }
  if (covered === total) {
    return raw;
  }
  return `${raw}\n\n_This recap covers the most recent ${covered} of ${total} messages in this chat. The earlier ones are still above this marker in the transcript._`;
}
export function handoffPersistenceRoom(roomSource: TurnRoomSource): OpenRoom {
  const room = roomSource.currentRoom();
  if (room === null) {
    throw new Error("The room closed while summarizing.");
  }
  return room;
}


/**
 * Token-budget bar / context handoff: summarize the conversation the model
 * currently sees (already truncated at any earlier marker, per
 * `recentMessages`) and insert a fresh marker carrying the recap. Every future
 * turn in this chat then starts from that recap — the entire mechanism is
 * `recentMessages`'s truncation point, not a separate "compacted" state.
 * Ported from `agent.rs::handoff_chat`.
 */
export async function handoffChat(chatId: string, deps: HandoffChatDeps): Promise<Message> {
  // Phase 1 (locked): read what the model would currently see.
  const input = handoffInput(deps.room, chatId);
  const model = await handoffModel(input.explicitModel, deps);

  // The engine's own window, read once and used twice (the budget below and
  // the bar's snapshot at the end). `null` means "not published", and the 128k
  // floor for that case stays HERE rather than inside the record — a made-up
  // number does not belong in something the app calls a fact.
  const maxContext = await handoffMaxContext(model, deps);

  // FIT THE CONVERSATION TO THE ENGINE BEFORE SENDING IT. This is the one
  // history read with no compaction behind it: every row is flattened into a
  // single prompt for the one-shot `handoff_summary` gateway. Local Ollama
  // fits that to its window itself, but a `:cloud` model, an OpenRouter
  // provider and a cloud CLI trim NOTHING — so a long chat could overflow and
  // come back as an engine error precisely when the user pressed the button.
  const total = input.history.length;
  const messages = handoffMessages(input.history, maxContext);
  // What the recap could NOT cover has to be said: the marker is a hard
  // cut-off, so anything dropped is gone from the model's memory. The
  // transcript above the marker still shows it — this is what says to look.
  const uncovered = total - messages.length;

  // Phase 2 (unlocked): the summarization call — any engine, same as `ask`.
  // The recap BECOMES the model's entire memory of this conversation, so an
  // empty one is a FAILED handoff, not a handoff.
  const summarize = deps.handoffSummary ?? handoffSummaryReal;
  const raw = await summarize(model, messages, input.temperature);
  // No claim about WHY — only what was and was not covered.
  const summary = handoffRecap(raw, total, total - uncovered);

  const usageValue = handoffUsageValue(summary, maxContext);

  // Phase 3 (locked): persist the marker, with that snapshot as its effects.
  // Re-read rather than reusing the handle from Phase 1: the summarization
  // above is an `.await`, and the room can close across it.
  const roomNow = handoffPersistenceRoom(deps.room);
  return insertHandoffMessage(roomNow.db, chatId, summary, usageValue);
}
