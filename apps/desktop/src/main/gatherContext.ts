/**
 * Phase 1 of a chat turn: gather the room's context and save the user's
 * question. Ported from `src-tauri/src/commands/agent.rs`'s
 * `gather_context_and_save_question` (lines ~750-1192), plus the four one-line
 * settings wrappers it reads (each cited on its own function below).
 *
 * This is the largest, most detail-heavy function of the turn engine: it reads
 * every room setting the model's context depends on, assembles the system +
 * user prompt EXACTLY as the Rust source does (the byte-stable system prefix
 * is load-bearing for Ollama's KV-cache reuse — ADD-22), and saves the user's
 * message. The prompt assembly itself lives in `turnContext.ts`'s pure
 * {@link buildSystemPrompt} so its byte-stability can be pinned without a
 * database.
 *
 * In the Rust source this whole function runs under the room mutex and
 * performs NO `.await`, which is the lock discipline `ask` relies on. Here it
 * is plain synchronous code against an already-open connection — the same
 * guarantee, structurally: nothing inside can suspend, so nothing can land in
 * a room that was swapped underneath it.
 *
 * ALL DB READS ARE REAL, against the already-ported `db-host/*` layer
 * (settings, memories, skills, messages, retrieval, files) — nothing is
 * stubbed at the database boundary; `db-host/skills.ts` already landed, so
 * `/skill-name` and the level-1 skill advertisement are fully real.
 *
 * TWO THINGS ARE GENUINELY OUT OF SCOPE and injected via
 * {@link GatherContextDeps} rather than faked:
 *   - `connectedMcpServers` — Rust reads `state.mcp.lock().servers` (the MCP
 *     server MANAGER, a different subsystem from `room_mcp.rs`'s tool-dispatch
 *     bridge), and no such host state exists anywhere in this rewrite yet.
 *     Default `[]`: the honest "no manager is wired up" answer, and the safe
 *     direction — advertising a connector the model cannot reach is the worse
 *     failure.
 *   - `prepareImage` — `vision::prepare_image` transcodes an attached image
 *     onto a fixed square canvas via the `image` crate; no Node image library
 *     is wired in yet. Default: `turnContext.ts`'s explicitly-labelled
 *     {@link passthroughPrepareImage}, whose own doc spells out what it does
 *     NOT do.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { setChatTitleIfNew } from "./db-host/chats.js";
import { getFileFull, listFileInventory, listFilesBrief } from "./db-host/files.js";
import { listMemories } from "./db-host/memories.js";
import { insertMessage, recentMessages } from "./db-host/messages.js";
import {
  compactHistory,
  retrieveContext,
  retrieveContextForFiles,
  selectMemories,
} from "./db-host/retrieval.js";
import { getSetting } from "./db-host/settings.js";
import { findSkill, listSkillResources, listSkills } from "./db-host/skills.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { clampBytesMarked } from "./textClamp.js";
import {
  AGENT_HISTORY_MESSAGES,
  MAX_MEMORY_INJECT_CHARS,
  SKILL_BODY_TRUNCATED,
  advertiseSkills,
  buildSystemPrompt,
  explicitSkillRequest,
  explicitlyNamedRoomFiles,
  historyBudgetBytes,
  isBareSaveReference,
  isImage,
  passthroughPrepareImage,
  resolveTurnEvidencePolicy,
  type PreparedImage,
  type TurnEvidencePolicy,
} from "./turnContext.js";
import { readRoomFile } from "./workspace/roomContent.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { processAttachments, type AttachmentResult, type FirstImage } from "./gatherAttachments.js";
import {
  advisorToolsEnabled,
  advisorsEnabled,
  modelSetting,
  parseTemperature,
  webAccessEnabled,
} from "./gatherSettings.js";

export type { FirstImage } from "./gatherAttachments.js";
export {
  advisorToolsEnabled,
  advisorsEnabled,
  modelSetting,
  parseTemperature,
  webAccessEnabled,
} from "./gatherSettings.js";

// --------------------------------------------------------- settings reads

// ------------------------------------------------------------------ types

/** Everything Phase 1 produces for the rest of a turn — ported field-for-field
 * from Rust's (private) `QuestionContext`. `chatMessages` uses `sidecar.ts`'s
 * `SidecarChatMessage` (the exact wire shape `/run` expects) rather than a
 * separately re-declared `ollama::ChatMessage` twin. */
export interface QuestionContext {
  explicitModel: string | null;
  chatMessages: SidecarChatMessage[];
  sources: string[];
  firstImage: FirstImage | null;
  temperature: number | null;
  webEnabled: boolean;
  advisorsOn: boolean;
  advisorToolsOn: boolean;
  evidencePolicy: TurnEvidencePolicy;
}

/** The two out-of-scope seams — see this module's own doc for both. */
export interface GatherContextDeps {
  /** `state.mcp.lock().servers`, filtered to connected servers with at least
   * one served tool. Default `[]`. */
  connectedMcpServers?: () => readonly string[];
  /** `vision::prepare_image`. Default {@link passthroughPrepareImage}. */
  prepareImage?: (bytes: Buffer) => PreparedImage;
  /** Trusted pre-read workspace image bytes. Internal to the async room wrapper. */
  workspaceAttachmentBytes?: ReadonlyMap<string, Buffer | null>;
  /** A host preflight may force the hard policy before any asynchronous file
   * preparation. It can only tighten, never relax, the policy inferred here. */
  evidencePolicy?: TurnEvidencePolicy;
}

/** Resolve the turn policy early enough for embedding and MCP bridge setup.
 * Missing/disabled skills still throw later in the normal gather path; this
 * read-only preflight only decides whether capabilities must be closed. */
export function turnEvidencePolicyForQuestion(
  db: Database.Database,
  question: string,
): TurnEvidencePolicy {
  const requested = explicitSkillRequest(question);
  const effective = requested === null ? question.trim() : requested.request;
  const skill = requested === null ? null : findSkill(db, requested.name);
  return resolveTurnEvidencePolicy(effective, skill?.instructions ?? null);
}

/** A directly tagged specialist should begin with an empty ambient source set.
 * It can still read explicitly named/attached files through the normal paths,
 * and can discover further evidence with its own tools. */
export function isDirectSpecialistQuestion(question: string): boolean {
  return /^\s*\*[a-z]+(?:\s|$)/iu.test(question);
}

interface ExplicitSkill {
  name: string;
  description: string;
  instructions: string;
  resources: Array<{ path: string; kind: string }>;
}

interface AmbientContext {
  connectedMcp: readonly string[];
  customInstructions: string | null;
  responseStyle: string | null;
  roomRole: string | null;
  memories: string[];
  availableSkills: ReturnType<typeof listSkills>;
  history: ReturnType<typeof recentMessages>;
  inventory: ReturnType<typeof listFileInventory>;
}

interface RetrievedContext {
  contextChunks: ReturnType<typeof retrieveContext>[0];
  contextFallback: boolean;
}

interface UserContentInput {
  availableSkills: ReturnType<typeof listSkills>;
  namedFiles: string[];
  explicitSkill: ExplicitSkill | null;
  hardNoEvidence: boolean;
  memories: string[];
  effectiveQuestion: string;
  contextChunks: ReturnType<typeof retrieveContext>[0];
  contextFallback: boolean;
  attachedNotes: string[];
  carried: number;
  viewing: string | null;
  hasHistory: boolean;
  question: string;
}

function gatheredQuestion(question: string, deps: GatherContextDeps) {
  const skillRequest = explicitSkillRequest(question);
  return {
    prepareImage: deps.prepareImage ?? passthroughPrepareImage,
    skillRequest,
    effectiveQuestion: skillRequest === null ? question.trim() : skillRequest.request,
  };
}

function selectedSkill(
  db: Database.Database,
  skillRequest: ReturnType<typeof explicitSkillRequest>,
): ExplicitSkill | null {
  if (skillRequest === null) return null;
  const skill = findSkill(db, skillRequest.name);
  if (skill === null) throw new Error(`No skill named "${skillRequest.name}" exists.`);
  if (!skill.enabled) {
    throw new Error(
      `The skill "${skillRequest.name}" is still a disabled draft. Review and enable it in Skills before using /${skillRequest.name}.`,
    );
  }
  return { name: skill.name, description: skill.description, instructions: skill.instructions, resources: [] };
}

function resolvedEvidencePolicy(
  effectiveQuestion: string,
  explicitSkill: ExplicitSkill | null,
  deps: GatherContextDeps,
): TurnEvidencePolicy {
  const inferred = resolveTurnEvidencePolicy(effectiveQuestion, explicitSkill?.instructions ?? null);
  return deps.evidencePolicy === "no-tools-no-sources" || inferred === "no-tools-no-sources"
    ? "no-tools-no-sources"
    : "normal";
}

function skillWithResources(
  db: Database.Database,
  explicitSkill: ExplicitSkill | null,
  hardNoEvidence: boolean,
): ExplicitSkill | null {
  if (explicitSkill === null || hardNoEvidence) return explicitSkill;
  const skill = findSkill(db, explicitSkill.name);
  const resources = skill === null ? [] : listSkillResources(db, skill.id).map((r) => ({ path: r.path, kind: r.kind }));
  return { ...explicitSkill, resources };
}

function emptyAmbientContext(): AmbientContext {
  return {
    connectedMcp: [], customInstructions: null, responseStyle: null, roomRole: null,
    memories: [], availableSkills: [], history: [], inventory: [],
  };
}

function ambientContext(
  db: Database.Database,
  chatId: string,
  hardNoEvidence: boolean,
  deps: GatherContextDeps,
): AmbientContext {
  if (hardNoEvidence) return emptyAmbientContext();
  return {
    connectedMcp: deps.connectedMcpServers?.() ?? [],
    customInstructions: getSetting(db, "custom_instructions"),
    responseStyle: getSetting(db, "response_style"),
    roomRole: getSetting(db, "room_role"),
    memories: listMemories(db).map((memory) => memory.content),
    availableSkills: listSkills(db, true).filter((skill) => skill.agent.trim() === ""),
    history: [...recentMessages(db, chatId, AGENT_HISTORY_MESSAGES)].reverse(),
    inventory: listFileInventory(db),
  };
}

function completeInventory(
  db: Database.Database,
  inventory: ReturnType<typeof listFileInventory>,
) {
  return inventory.length <= 100
    ? inventory
    : listFilesBrief(db).map(([name, mime, _size, summary]): [string, string, string | null] => [name, mime, summary]);
}

function contextForQuestion(
  db: Database.Database,
  hardNoEvidence: boolean,
  namedFiles: string[],
  directSpecialist: boolean,
  effectiveQuestion: string,
  questionEmbedding: readonly number[] | null,
): RetrievedContext {
  if (hardNoEvidence) return { contextChunks: [], contextFallback: false };
  if (namedFiles.length > 0) {
    const [contextChunks, contextFallback] = retrieveContextForFiles(db, effectiveQuestion, namedFiles);
    return { contextChunks, contextFallback };
  }
  if (directSpecialist) return { contextChunks: [], contextFallback: false };
  const [contextChunks, contextFallback] = retrieveContext(db, effectiveQuestion, questionEmbedding);
  return { contextChunks, contextFallback };
}

function namedFilesForQuestion(
  hardNoEvidence: boolean,
  effectiveQuestion: string,
  inventory: ReturnType<typeof listFileInventory>,
): string[] {
  return hardNoEvidence ? [] : explicitlyNamedRoomFiles(effectiveQuestion, inventory);
}

function attachmentsForQuestion(
  db: Database.Database,
  hardNoEvidence: boolean,
  attachments: readonly string[],
  prepareImage: (bytes: Buffer) => PreparedImage,
  workspaceAttachmentBytes?: ReadonlyMap<string, Buffer | null>,
): AttachmentResult {
  if (hardNoEvidence) return { images: [], attachedNotes: [], sources: [], firstImage: null, carried: 0 };
  return processAttachments(db, attachments, prepareImage, workspaceAttachmentBytes);
}

function attachRetrievedSources(
  sources: string[],
  contextChunks: ReturnType<typeof retrieveContext>[0],
  contextFallback: boolean,
): void {
  if (contextFallback) return;
  for (const chunk of contextChunks) {
    if (!sources.includes(chunk.fileName)) sources.push(chunk.fileName);
  }
}

function turnSettings(db: Database.Database, hardNoEvidence: boolean) {
  if (hardNoEvidence) return { webEnabled: false, advisorsOn: false, advisorToolsOn: false };
  const advisorsOn = advisorsEnabled(db);
  return { webEnabled: webAccessEnabled(db), advisorsOn, advisorToolsOn: advisorsOn && advisorToolsEnabled(db) };
}

function scopedFilePreamble(namedFiles: string[]): string {
  if (namedFiles.length === 0) return "";
  return `The user explicitly scoped this request to these room files: ${namedFiles.join(", ")}.\n`
    + "Use only those files and any paperclipped attachments as room-file evidence for this request. "
    + "Do not search or cite other room files unless the user asks you to broaden the scope.\n\n";
}

function explicitSkillPreamble(explicitSkill: ExplicitSkill, hardNoEvidence: boolean): string {
  const instructions = clampBytesMarked(explicitSkill.instructions, 20_000, SKILL_BODY_TRUNCATED);
  if (hardNoEvidence) {
    return `Explicitly selected Agent Skill: /${explicitSkill.name}\n`
      + "Follow only these instructions where they agree with the user's request. This turn has no tools, file reads, bundled resources, or other sources.\n\n"
      + `Skill instructions:\n${instructions}\n\n`;
  }
  const tree = explicitSkill.resources.length === 0
    ? "(no bundled resources)"
    : explicitSkill.resources.map((resource) => `- ${resource.path} (${resource.kind})`).join("\n");
  return `Explicitly selected Agent Skill: /${explicitSkill.name}\n`
    + "Follow this skill for the current request. The slash selection overrides automatic skill choice, but never the user's request or safety/privacy rules. Read listed resources with read_skill_resource when the instructions call for them.\n"
    + `Description: ${explicitSkill.description}\n\nSkill instructions:\n${instructions}\n\nBundled resources:\n${tree}\n\n`;
}

function memoryPreamble(memories: string[], effectiveQuestion: string): string {
  const chosen = selectMemories(memories, effectiveQuestion, MAX_MEMORY_INJECT_CHARS);
  if (chosen.length === 0) return "";
  return `Notes to remember for this room:\n${chosen.map((memory) => `- ${memory}\n`).join("")}\n`;
}

function contextPreamble(
  contextFallback: boolean,
  attachedNotes: string[],
  contextChunks: ReturnType<typeof retrieveContext>[0],
): string {
  if (contextChunks.length === 0 && attachedNotes.length === 0) return "";
  const heading = contextFallback && attachedNotes.length === 0
    ? "Recently added content (may be unrelated to the question):\n\n"
    : "Context from files stored in this room:\n\n";
  const attachments = attachedNotes.map((note) => `${note}\n\n`).join("");
  const chunks = contextChunks.map((chunk) => `[file: ${chunk.fileName}]\n${chunk.text}\n\n`).join("");
  return `${heading}${attachments}${chunks}---\n\n`;
}

function viewingPreamble(hardNoEvidence: boolean, carried: number, viewing: string | null): string {
  if (hardNoEvidence || carried !== 0) return "";
  const open = viewing?.trim() ?? "";
  if (open === "") return "";
  return `The user has "${open}" open in the workspace. If their question says "this" or "here" `
    + "without naming anything, they almost certainly mean that file — open it and work from what it says.\n\n";
}

function bareSavePreamble(hasHistory: boolean, question: string): string {
  if (!hasHistory || !isBareSaveReference(question)) return "";
  return '(Note: the user\'s "that"/"this" refers to earlier content in this conversation — usually your own previous reply. Save THAT full text with create_file or write_file now; do not ask the user to re-provide content that is already above.)\n\n';
}

function userContent(input: UserContentInput): string {
  let content = advertiseSkills(input.availableSkills.map((skill): [string, string] => [skill.name, skill.description]));
  content += scopedFilePreamble(input.namedFiles);
  if (input.explicitSkill !== null) content += explicitSkillPreamble(input.explicitSkill, input.hardNoEvidence);
  content += memoryPreamble(input.memories, input.effectiveQuestion);
  content += contextPreamble(input.contextFallback, input.attachedNotes, input.contextChunks);
  content += viewingPreamble(input.hardNoEvidence, input.carried, input.viewing);
  content += bareSavePreamble(input.hasHistory, input.question);
  return `${content}Question: ${input.effectiveQuestion}`;
}

function assembledMessages(
  system: string,
  history: ReturnType<typeof recentMessages>,
  explicitModel: string | null,
  user: string,
  images: string[],
): SidecarChatMessage[] {
  const messages: SidecarChatMessage[] = [{ role: "system", content: system }];
  for (const [role, content] of compactHistory(history, historyBudgetBytes(explicitModel ?? ""))) {
    messages.push({ role: role as SidecarChatMessage["role"], content });
  }
  messages.push({ role: "user", content: user, ...(images.length > 0 ? { images } : {}) });
  return messages;
}

function saveQuestion(db: Database.Database, chatId: string, question: string, effectiveQuestion: string): void {
  insertMessage(db, chatId, "user", question, [], null);
  const titleSource = effectiveQuestion === "" ? question : effectiveQuestion;
  const titleChars = Array.from(titleSource);
  const title = titleChars.slice(0, 48).join("") + (titleChars.length > 48 ? "…" : "");
  setChatTitleIfNew(db, chatId, title);
}

// ------------------------------------------------------------------ main

/**
 * Phase 1 (locked, in the Rust source): gather the room's context and save the
 * user's message.
 *
 * THROWS (rather than returning an error union) on exactly the conditions the
 * Rust function's `?` propagates on — an explicit `/skill` naming a skill that
 * does not exist, or one that is still a disabled draft — matching this
 * codebase's `db-host` convention. Never a partial write: the user message is
 * inserted only after every earlier step has succeeded, in the Rust source's
 * own order.
 *
 * `questionEmbedding` is computed by the CALLER (`ask`), exactly as the Rust
 * signature takes it rather than computing it: the embed call is an `.await`
 * that must happen BEFORE the room lock is taken.
 */
export function gatherContextAndSaveQuestion(
  db: Database.Database,
  chatId: string,
  question: string,
  attachments: readonly string[],
  questionEmbedding: readonly number[] | null,
  viewing: string | null,
  deps: GatherContextDeps = {}
): QuestionContext {
  const gathered = gatheredQuestion(question, deps);
  const explicitModel = modelSetting(db);
  const temperature = parseTemperature(getSetting(db, "temperature"));
  let explicitSkill = selectedSkill(db, gathered.skillRequest);
  const evidencePolicy = resolvedEvidencePolicy(gathered.effectiveQuestion, explicitSkill, deps);
  const hardNoEvidence = evidencePolicy === "no-tools-no-sources";
  explicitSkill = skillWithResources(db, explicitSkill, hardNoEvidence);

  const ambient = ambientContext(db, chatId, hardNoEvidence, deps);
  const scopeInventory = completeInventory(db, ambient.inventory);
  const namedFiles = namedFilesForQuestion(hardNoEvidence, gathered.effectiveQuestion, scopeInventory);
  const retrieved = contextForQuestion(
    db,
    hardNoEvidence,
    namedFiles,
    isDirectSpecialistQuestion(gathered.effectiveQuestion),
    gathered.effectiveQuestion,
    questionEmbedding,
  );
  const attachment = attachmentsForQuestion(
    db,
    hardNoEvidence,
    attachments,
    gathered.prepareImage,
    deps.workspaceAttachmentBytes,
  );
  attachRetrievedSources(attachment.sources, retrieved.contextChunks, retrieved.contextFallback);

  const settings = turnSettings(db, hardNoEvidence);
  const system = buildSystemPrompt({
    evidencePolicy,
    webEnabled: settings.webEnabled,
    connectedMcp: ambient.connectedMcp,
    inventory: ambient.inventory,
    roomRoleId: ambient.roomRole,
    responseStyle: ambient.responseStyle,
    customInstructions: ambient.customInstructions,
  });
  const chatMessages = assembledMessages(
    system,
    ambient.history,
    explicitModel,
    userContent({
      availableSkills: ambient.availableSkills,
      namedFiles,
      explicitSkill,
      hardNoEvidence,
      memories: ambient.memories,
      effectiveQuestion: gathered.effectiveQuestion,
      contextChunks: retrieved.contextChunks,
      contextFallback: retrieved.contextFallback,
      attachedNotes: attachment.attachedNotes,
      carried: attachment.carried,
      viewing,
      hasHistory: ambient.history.length > 0,
      question,
    }),
    attachment.images,
  );
  saveQuestion(db, chatId, question, gathered.effectiveQuestion);

  return {
    explicitModel,
    chatMessages,
    sources: attachment.sources,
    firstImage: attachment.firstImage,
    temperature,
    webEnabled: settings.webEnabled,
    advisorsOn: settings.advisorsOn,
    advisorToolsOn: settings.advisorToolsOn,
    evidencePolicy,
  };
}

export interface GatherContextRoom {
  db: Database.Database;
  path: string;
  workspace?: WorkspaceService;
}

function roomEvidencePolicy(
  db: Database.Database,
  question: string,
  requestedPolicy: TurnEvidencePolicy | undefined,
): TurnEvidencePolicy {
  if (requestedPolicy === "no-tools-no-sources") {
    return requestedPolicy;
  }
  return turnEvidencePolicyForQuestion(db, question);
}

async function workspaceImageBytes(room: GatherContextRoom, fileId: string): Promise<Buffer | null | undefined> {
  try {
    const [, mime] = getFileFull(room.db, fileId);
    if (!isImage(mime ?? "")) {
      return undefined;
    }
    return (await readRoomFile(room, fileId)).bytes;
  } catch {
    return null;
  }
}

async function workspaceAttachmentImages(
  room: GatherContextRoom,
  attachments: readonly string[],
): Promise<Map<string, Buffer | null>> {
  const workspaceAttachmentBytes = new Map<string, Buffer | null>();
  for (const fileId of attachments) {
    const bytes = await workspaceImageBytes(room, fileId);
    if (bytes !== undefined) {
      workspaceAttachmentBytes.set(fileId, bytes);
    }
  }
  return workspaceAttachmentBytes;
}

/** Async folder-room wrapper. Text remains private indexed state; only image
 * bytes are read from normal files before entering the stable synchronous
 * prompt builder above. */
export async function gatherContextAndSaveQuestionInRoom(
  room: GatherContextRoom,
  chatId: string,
  question: string,
  attachments: readonly string[],
  questionEmbedding: readonly number[] | null,
  viewing: string | null,
  deps: GatherContextDeps = {},
): Promise<QuestionContext> {
  const evidencePolicy = roomEvidencePolicy(room.db, question, deps.evidencePolicy);
  const resolvedDeps = { ...deps, evidencePolicy };
  if (room.workspace === undefined || evidencePolicy === "no-tools-no-sources") {
    return gatherContextAndSaveQuestion(
      room.db,
      chatId,
      question,
      attachments,
      questionEmbedding,
      viewing,
      resolvedDeps,
    );
  }
  const workspaceAttachmentBytes = await workspaceAttachmentImages(room, attachments);
  return gatherContextAndSaveQuestion(
    room.db,
    chatId,
    question,
    attachments,
    questionEmbedding,
    viewing,
    { ...resolvedDeps, workspaceAttachmentBytes },
  );
}
