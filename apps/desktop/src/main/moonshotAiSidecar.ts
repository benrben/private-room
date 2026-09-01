import type { FileMetaSuggestion, MemorySuggestion } from "../shared/apiTypes.js";
import { CancelFlag } from "./cancel.js";
import { getFileExtractedText, getFileName } from "./db-host/files.js";
import { listMessages, type Message } from "./db-host/messages.js";
import { stripMarkupBlocks } from "./db-host/retrieval.js";
import { titleFromName } from "./docsHtml.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { resolveStructuredModel } from "./moonshotCmds.js";
import {
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import { isFailureNotice } from "./turnNotices.js";
import type { OpenRoom } from "./turnEngine.js";

export interface RoomHandle extends OpenRoom {
  name: string;
}

export interface RoomSource {
  currentRoom(): RoomHandle | null;
  rollingBack?(): boolean;
}

type SidecarPostFn = (
  path: string,
  body: unknown,
  cancel: CancelFlag,
  timeoutMs?: number,
) => Promise<SidecarPostOutcome>;

export interface AiSidecarDeps {
  rooms: RoomSource;
  listModels?: () => Promise<string[]>;
  post?: SidecarPostFn;
}

export function requireRoom(rooms: RoomSource): RoomHandle {
  const room = rooms.currentRoom();
  if (room === null) throw new Error("No room is open.");
  return room;
}

export function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function noMemorySuggestion(): MemorySuggestion {
  return { worth: false, fact: "" };
}

function lastByRole(msgs: readonly Message[], role: string): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === role) return stripMarkupBlocks(msgs[i]!.content);
  }
  return null;
}

function memoryConversation(msgs: readonly Message[]): { user: string; assistant: string } | null {
  const user = lastByRole(msgs, "user");
  const assistant = lastByRole(msgs, "assistant");
  if (user === null || assistant === null || isFailureNotice(assistant)) return null;
  return { user, assistant };
}

function memorySuggestionFromOutcome(outcome: SidecarPostOutcome): MemorySuggestion {
  if (outcome.kind !== "value") return noMemorySuggestion();
  const worth = ownField(outcome.value, "worth");
  const fact = ownField(outcome.value, "fact");
  return {
    worth: typeof worth === "boolean" ? worth : false,
    fact: typeof fact === "string" ? fact : "",
  };
}

export async function memorySuggestion(deps: AiSidecarDeps, chatId: string): Promise<MemorySuggestion> {
  const room = requireRoom(deps.rooms);
  const conversation = memoryConversation(listMessages(room.db, chatId));
  if (conversation === null) return noMemorySuggestion();
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) return noMemorySuggestion();
  const body = {
    model,
    base_url: resolvedBaseUrl(),
    user_text: conversation.user,
    assistant_text: conversation.assistant,
  };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/memory_suggestion", body, new CancelFlag());
  return memorySuggestionFromOutcome(outcome);
}

function emptyFileMetaSuggestion(currentName: string): FileMetaSuggestion {
  return { title: titleFromName(currentName), folder: "", tags: [] };
}

function hasEnoughMetadataText(text: string): boolean {
  return [...text.trim()].length >= 80;
}

function stringField(value: unknown, field: string): string {
  const candidate = ownField(value, field);
  return typeof candidate === "string" ? candidate : "";
}

function stringTags(value: unknown): string[] {
  const tags = ownField(value, "tags");
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function fileMetaSuggestionFromOutcome(
  outcome: SidecarPostOutcome,
  fallback: FileMetaSuggestion,
): FileMetaSuggestion {
  if (outcome.kind !== "value") return fallback;
  return {
    title: stringField(outcome.value, "title"),
    folder: stringField(outcome.value, "folder"),
    tags: stringTags(outcome.value),
  };
}

export async function suggestFileMeta(deps: AiSidecarDeps, fileId: string): Promise<FileMetaSuggestion> {
  const room = requireRoom(deps.rooms);
  const currentName = getFileName(room.db, fileId);
  const text = getFileExtractedText(room.db, fileId) ?? "";
  const echo = emptyFileMetaSuggestion(currentName);
  if (!hasEnoughMetadataText(text)) return echo;
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) return echo;
  const body = { model, base_url: resolvedBaseUrl(), current_name: currentName, text };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/suggest_file_meta", body, new CancelFlag());
  return fileMetaSuggestionFromOutcome(outcome, echo);
}

export async function generateUiText(
  deps: AiSidecarDeps,
  kind: string,
  prompt: string,
  facts: unknown,
  maxWords: number,
): Promise<string | null> {
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) return null;
  const body = { model, base_url: resolvedBaseUrl(), kind, prompt, facts, max_words: maxWords };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/generate_ui_text", body, new CancelFlag());
  if (outcome.kind !== "value") return null;
  const text = ownField(outcome.value, "text");
  return typeof text === "string" ? text : null;
}
