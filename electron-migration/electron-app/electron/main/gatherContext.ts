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
  MAX_ATTACHED_IMAGES,
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

// --------------------------------------------------------- settings reads

/** `models.rs::model_setting` — the room's explicitly chosen engine, or `null`
 * to let `bestDefault` pick. */
export function modelSetting(db: Database.Database): string | null {
  return getSetting(db, "model");
}

/** `commands.rs::web_access_enabled` — `web_provider` keeps its old
 * provider-dropdown values ("duckduckgo", "searxng", …), every one of which
 * meant "internet on", so only `"off"`, `""`, or never having chosen is off. */
export function webAccessEnabled(db: Database.Database): boolean {
  const v = getSetting(db, "web_provider");
  return v !== null && v !== "" && v !== "off";
}

/** `commands.rs::advisors_enabled` — off by default; while off,
 * `consult_advisor` is not even offered to the model. */
export function advisorsEnabled(db: Database.Database): boolean {
  return getSetting(db, "advisors_enabled") === "on";
}

/** `commands.rs::advisor_tools_enabled` — the sub-option that also gives a
 * consulted advisor the room's connected MCP tools. */
export function advisorToolsEnabled(db: Database.Database): boolean {
  return getSetting(db, "advisor_tools_enabled") === "on";
}

/**
 * The stored `temperature` setting as a number, or `null` when absent or
 * unreadable — Rust's `.and_then(|s| s.parse().ok())`.
 *
 * One deliberate narrowing: a non-finite value (`"inf"`, `"NaN"`), which
 * Rust's `f64::from_str` would accept, is refused here and reads as "unset".
 * Neither is a temperature any UI can produce, and passing one to an engine is
 * strictly worse than falling back to its default.
 */
export function parseTemperature(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ types

/** The first attached image, held back for the deferred grounding pass. */
export interface FirstImage {
  fileId: string;
  name: string;
  bytes: Buffer;
  width: number;
  height: number;
}

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

// ------------------------------------------------------------- attachments

interface AttachmentResult {
  images: string[];
  attachedNotes: string[];
  sources: string[];
  firstImage: FirstImage | null;
  /** How many paperclipped files actually REACHED the model. A dropped one is
   * not a source (it is not what the answer was built from) and resolves no
   * anaphora, so this — not `attachments.length` — is what the viewing hint
   * asks. */
  carried: number;
}

/**
 * Images go to the model as vision input, text files as guaranteed context —
 * and every SKIPPED attachment says out loud that it was skipped. The composer
 * counts what the user clipped ("Attached 6"); when the turn carried four and
 * the model was told nothing, its answer about six read exactly like one that
 * had weighed them.
 */
function processAttachments(
  db: Database.Database,
  attachments: readonly string[],
  prepareImage: (bytes: Buffer) => PreparedImage,
  workspaceAttachmentBytes?: ReadonlyMap<string, Buffer | null>,
): AttachmentResult {
  const images: string[] = [];
  const attachedNotes: string[] = [];
  const sources: string[] = [];
  let firstImage: FirstImage | null = null;
  let carried = 0;

  for (const fileId of attachments) {
    let row: [string, string | null, Buffer | null, string | null];
    try {
      row = getFileFull(db, fileId);
    } catch {
      continue;
    }
    const [name, mimeRaw, blobBytes, text] = row;
    const mime = mimeRaw ?? "";
    if (isImage(mime)) {
      const bytes = workspaceAttachmentBytes?.has(fileId)
        ? workspaceAttachmentBytes.get(fileId) ?? null
        : blobBytes;
      if (bytes === null) {
        attachedNotes.push(
          `(Attached image: ${name} — NOT sent: the room has no image data stored for it. Say so rather than describing it.)`
        );
        continue;
      }
      if (images.length >= MAX_ATTACHED_IMAGES) {
        attachedNotes.push(
          `(Attached image: ${name} — NOT sent: this turn carries at most ${MAX_ATTACHED_IMAGES} images. Say so rather than describing it.)`
        );
        continue;
      }
      const prepared = prepareImage(bytes);
      if (firstImage === null) {
        firstImage = { fileId, name, bytes: prepared.bytes, width: prepared.width, height: prepared.height };
      }
      images.push(prepared.bytes.toString("base64"));
      attachedNotes.push(`(Attached image: ${name})`);
      sources.push(name);
      carried += 1;
    } else if (text !== null && text.trim() !== "") {
      attachedNotes.push(`[attached file: ${name}]\n${text}`);
      sources.push(name);
      carried += 1;
    } else {
      attachedNotes.push(
        `(Attached file: ${name} — no readable text has been extracted from it yet (a scan still to be read, a recording still to be transcribed), so its content is NOT in this turn. Say so rather than guessing at it.)`
      );
    }
  }

  return { images, attachedNotes, sources, firstImage, carried };
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
  const prepareImage = deps.prepareImage ?? passthroughPrepareImage;

  const skillRequest = explicitSkillRequest(question);
  const effectiveQuestion = skillRequest !== null ? skillRequest.request : question.trim();

  const explicitModel = modelSetting(db);
  const temperature = parseTemperature(getSetting(db, "temperature"));

  let explicitSkill: {
    name: string;
    description: string;
    instructions: string;
    resources: Array<{ path: string; kind: string }>;
  } | null = null;
  if (skillRequest !== null) {
    const skill = findSkill(db, skillRequest.name);
    if (skill === null) {
      throw new Error(`No skill named "${skillRequest.name}" exists.`);
    }
    if (!skill.enabled) {
      throw new Error(
        `The skill "${skillRequest.name}" is still a disabled draft. Review and enable it in Skills before using /${skillRequest.name}.`
      );
    }
    explicitSkill = {
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      resources: [],
    };
  }

  const inferredPolicy = resolveTurnEvidencePolicy(
    effectiveQuestion,
    explicitSkill?.instructions ?? null,
  );
  const evidencePolicy = deps.evidencePolicy === "no-tools-no-sources"
    || inferredPolicy === "no-tools-no-sources"
    ? "no-tools-no-sources"
    : "normal";
  const hardNoEvidence = evidencePolicy === "no-tools-no-sources";

  // Only the selected skill instructions and the current request survive the
  // hard boundary. In particular, do not even enumerate resources or general
  // skills: resource names and descriptions are room-derived evidence too.
  if (explicitSkill !== null && !hardNoEvidence) {
    const skill = findSkill(db, explicitSkill.name);
    explicitSkill.resources = skill === null
      ? []
      : listSkillResources(db, skill.id).map((r) => ({ path: r.path, kind: r.kind }));
  }

  const connectedMcp = hardNoEvidence ? [] : deps.connectedMcpServers?.() ?? [];
  const customInstructions = hardNoEvidence ? null : getSetting(db, "custom_instructions");
  const responseStyle = hardNoEvidence ? null : getSetting(db, "response_style");
  const roomRole = hardNoEvidence ? null : getSetting(db, "room_role");
  const memories = hardNoEvidence ? [] : listMemories(db).map((m) => m.content);
  const availableSkills = hardNoEvidence
    ? []
    : listSkills(db, true).filter((s) => s.agent.trim() === "");

  // `recentMessages` is newest-first; the prompt wants chronological order.
  const history = hardNoEvidence
    ? []
    : [...recentMessages(db, chatId, AGENT_HISTORY_MESSAGES)].reverse();

  const inventory = hardNoEvidence ? [] : listFileInventory(db);
  // `listFileInventory` intentionally stops at 101 rows for the system prompt.
  // Explicit scope must still recognize an older file in a large room, so only
  // the name resolver expands to the complete lightweight listing.
  const scopeInventory =
    inventory.length <= 100
      ? inventory
      : listFilesBrief(db).map(([name, mime, _size, summary]): [string, string, string | null] => [
          name,
          mime,
          summary,
        ]);
  const namedFiles = hardNoEvidence
    ? []
    : explicitlyNamedRoomFiles(effectiveQuestion, scopeInventory);
  const [contextChunks, contextFallback] =
    hardNoEvidence
      ? [[], false] as const
      : namedFiles.length > 0
      ? retrieveContextForFiles(db, effectiveQuestion, namedFiles)
      : retrieveContext(db, effectiveQuestion, questionEmbedding);

  const { images, attachedNotes, sources, firstImage, carried } = hardNoEvidence
    ? { images: [], attachedNotes: [], sources: [], firstImage: null, carried: 0 }
    : processAttachments(db, attachments, prepareImage, deps.workspaceAttachmentBytes);

  // Only credit files that genuinely matched the question: on the zero-score
  // fallback the chunks are just "recent content", so they must not appear as
  // source chips (CHG-10). Attachments still count.
  if (!contextFallback) {
    for (const chunk of contextChunks) {
      if (!sources.includes(chunk.fileName)) {
        sources.push(chunk.fileName);
      }
    }
  }

  const webEnabled = hardNoEvidence ? false : webAccessEnabled(db);
  // ADD-21: whether the advisor tool may be offered this turn, and whether a
  // consulted Claude advisor may reach the room's tools.
  const advisorsOn = hardNoEvidence ? false : advisorsEnabled(db);
  const advisorToolsOn = advisorsOn && advisorToolsEnabled(db);

  const system = buildSystemPrompt({
    evidencePolicy,
    webEnabled,
    connectedMcp,
    inventory,
    roomRoleId: roomRole,
    responseStyle,
    customInstructions,
  });

  // ADD-22 (KV cache): the system prompt stays byte-stable across a
  // conversation, so per-question memory selection lives in the always-new
  // user message below rather than up here.
  const chatMessages: SidecarChatMessage[] = [{ role: "system", content: system }];
  const hasHistory = history.length > 0;
  for (const [role, content] of compactHistory(history, historyBudgetBytes(explicitModel ?? ""))) {
    chatMessages.push({ role: role as SidecarChatMessage["role"], content });
  }

  let userContent = advertiseSkills(availableSkills.map((s): [string, string] => [s.name, s.description]));

  if (namedFiles.length > 0) {
    userContent +=
      `The user explicitly scoped this request to these room files: ${namedFiles.join(", ")}.\n` +
      "Use only those files and any paperclipped attachments as room-file evidence for this request. " +
      "Do not search or cite other room files unless the user asks you to broaden the scope.\n\n";
  }

  if (explicitSkill !== null) {
    const instructions = clampBytesMarked(explicitSkill.instructions, 20_000, SKILL_BODY_TRUNCATED);
    if (hardNoEvidence) {
      userContent +=
        `Explicitly selected Agent Skill: /${explicitSkill.name}\n` +
        "Follow only these instructions where they agree with the user's request. This turn has no tools, file reads, bundled resources, or other sources.\n\n" +
        `Skill instructions:\n${instructions}\n\n`;
    } else {
      const tree =
        explicitSkill.resources.length === 0
          ? "(no bundled resources)"
          : explicitSkill.resources.map((r) => `- ${r.path} (${r.kind})`).join("\n");
      userContent +=
        `Explicitly selected Agent Skill: /${explicitSkill.name}\n` +
        "Follow this skill for the current request. The slash selection overrides automatic skill choice, but never the user's request or safety/privacy rules. Read listed resources with read_skill_resource when the instructions call for them.\n" +
        `Description: ${explicitSkill.description}\n\nSkill instructions:\n${instructions}\n\nBundled resources:\n${tree}\n\n`;
    }
  }

  if (memories.length > 0) {
    const chosen = selectMemories(memories, effectiveQuestion, MAX_MEMORY_INJECT_CHARS);
    if (chosen.length > 0) {
      userContent += "Notes to remember for this room:\n";
      for (const m of chosen) {
        userContent += `- ${m}\n`;
      }
      userContent += "\n";
    }
  }

  const hasContext = contextChunks.length > 0 || attachedNotes.length > 0;
  if (hasContext) {
    userContent +=
      contextFallback && attachedNotes.length === 0
        ? "Recently added content (may be unrelated to the question):\n\n"
        : "Context from files stored in this room:\n\n";
    for (const note of attachedNotes) {
      userContent += `${note}\n\n`;
    }
    for (const chunk of contextChunks) {
      userContent += `[file: ${chunk.fileName}]\n${chunk.text}\n\n`;
    }
    userContent += "---\n\n";
  }

  // What the user has open while they ask — in the always-new user message,
  // never the system prompt (a fact that changes whenever a tab does would
  // invalidate the cached prefix every turn). The NAME only, stated as what it
  // is: "has open", not "is looking at", because the flag says a file is
  // loaded, and the pane can be collapsed or behind Home.
  //
  // Skipped when the paperclip carried something: that is an explicit choice
  // about what this question is about, and there is no anaphora left to
  // resolve. What was CARRIED, not what was clipped — a paperclip whose
  // content never reached the model resolves nothing.
  if (!hardNoEvidence && carried === 0) {
    const open = viewing?.trim() ?? "";
    if (open !== "") {
      userContent +=
        `The user has "${open}" open in the workspace. If their question says "this" or "here" ` +
        "without naming anything, they almost certainly mean that file — open it and work from what it says.\n\n";
    }
  }

  // Deterministic anaphora hint: a 4B model sees its own previous reply in the
  // history and still asks the user to re-provide it. The conditional wording
  // keeps a rare false positive harmless.
  if (hasHistory && isBareSaveReference(question)) {
    userContent +=
      '(Note: the user\'s "that"/"this" refers to earlier content in this conversation — usually your own previous reply. Save THAT full text with create_file or write_file now; do not ask the user to re-provide content that is already above.)\n\n';
  }

  userContent += `Question: ${effectiveQuestion}`;

  chatMessages.push({
    role: "user",
    content: userContent,
    ...(images.length > 0 ? { images } : {}),
  });

  insertMessage(db, chatId, "user", question, [], null);

  // The first question names the session.
  const titleSource = effectiveQuestion === "" ? question : effectiveQuestion;
  const titleChars = Array.from(titleSource);
  const title = titleChars.slice(0, 48).join("") + (titleChars.length > 48 ? "…" : "");
  setChatTitleIfNew(db, chatId, title);

  return {
    explicitModel,
    chatMessages,
    sources,
    firstImage,
    temperature,
    webEnabled,
    advisorsOn,
    advisorToolsOn,
    evidencePolicy,
  };
}

export interface GatherContextRoom {
  db: Database.Database;
  path: string;
  workspace?: WorkspaceService;
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
  const evidencePolicy = deps.evidencePolicy === "no-tools-no-sources"
    ? deps.evidencePolicy
    : turnEvidencePolicyForQuestion(room.db, question);
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
  const workspaceAttachmentBytes = new Map<string, Buffer | null>();
  for (const fileId of attachments) {
    try {
      const [, mime] = getFileFull(room.db, fileId);
      if (isImage(mime ?? "")) {
        workspaceAttachmentBytes.set(fileId, (await readRoomFile(room, fileId)).bytes);
      }
    } catch {
      workspaceAttachmentBytes.set(fileId, null);
    }
  }
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
