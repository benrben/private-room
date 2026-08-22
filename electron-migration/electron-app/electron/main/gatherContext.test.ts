/**
 * Tests for `gatherContext.ts` — the DB-real half of a turn's Phase 1, driven
 * against REAL fixture rooms via `db-host/open.ts`'s `createRoom` (this repo's
 * convention: real behavior over mocks).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { createChat } from "./db-host/chats.js";
import { insertFile } from "./db-host/files.js";
import { addMemory } from "./db-host/memories.js";
import { insertMessage, listMessages } from "./db-host/messages.js";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import { createSkill } from "./db-host/skills.js";
import {
  advisorToolsEnabled,
  advisorsEnabled,
  gatherContextAndSaveQuestion,
  modelSetting,
  parseTemperature,
  webAccessEnabled,
} from "./gatherContext.js";
import { BASE_SYSTEM_PROMPT } from "./turnContext.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "gather-context-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

// ------------------------------------------------------------ settings reads

describe("settings one-liners", () => {
  it("modelSetting reads the room's explicit model, or null when unset", () => {
    const db = freshRoom();
    expect(modelSetting(db)).toBeNull();
    setSetting(db, "model", "qwen3.5:9b");
    expect(modelSetting(db)).toBe("qwen3.5:9b");
  });

  it("webAccessEnabled: absent/off/'' are off, any other provider value is on", () => {
    const db = freshRoom();
    expect(webAccessEnabled(db)).toBe(false);
    setSetting(db, "web_provider", "off");
    expect(webAccessEnabled(db)).toBe(false);
    setSetting(db, "web_provider", "");
    expect(webAccessEnabled(db)).toBe(false);
    // Old provider-dropdown values still mean "on" — that IS the migration.
    setSetting(db, "web_provider", "duckduckgo");
    expect(webAccessEnabled(db)).toBe(true);
  });

  it("advisorsEnabled/advisorToolsEnabled require the literal 'on'", () => {
    const db = freshRoom();
    expect(advisorsEnabled(db)).toBe(false);
    expect(advisorToolsEnabled(db)).toBe(false);
    setSetting(db, "advisors_enabled", "on");
    setSetting(db, "advisor_tools_enabled", "yes");
    expect(advisorsEnabled(db)).toBe(true);
    expect(advisorToolsEnabled(db)).toBe(false);
    setSetting(db, "advisor_tools_enabled", "on");
    expect(advisorToolsEnabled(db)).toBe(true);
  });

  it("advisorToolsOn is only ever true when advisors themselves are on", () => {
    const db = freshRoom();
    setSetting(db, "advisor_tools_enabled", "on");
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null);
    expect(ctx.advisorsOn).toBe(false);
    expect(ctx.advisorToolsOn).toBe(false);
  });

  it("parseTemperature reads a number, and refuses blank or non-finite values", () => {
    expect(parseTemperature(null)).toBeNull();
    expect(parseTemperature("   ")).toBeNull();
    expect(parseTemperature("nonsense")).toBeNull();
    expect(parseTemperature("Infinity")).toBeNull();
    expect(parseTemperature("0.4")).toBe(0.4);
  });
});

// ------------------------------------------- gatherContextAndSaveQuestion

describe("gatherContextAndSaveQuestion", () => {
  it("builds a system+user pair, saves the question, and titles the chat", () => {
    const db = freshRoom();
    const chat = createChat(db);
    const ctx = gatherContextAndSaveQuestion(db, chat.id, "What does the lease say about parking?", [], null, null);

    expect(ctx.chatMessages[0]?.role).toBe("system");
    expect(ctx.chatMessages[0]?.content).toBe(BASE_SYSTEM_PROMPT);
    const user = ctx.chatMessages.at(-1)!;
    expect(user.role).toBe("user");
    expect(user.content).toContain("Question: What does the lease say about parking?");
    expect(ctx.webEnabled).toBe(false);
    expect(ctx.advisorsOn).toBe(false);
    expect(ctx.firstImage).toBeNull();

    const saved = listMessages(db, chat.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.role).toBe("user");
    expect(saved[0]?.content).toBe("What does the lease say about parking?");
  });

  it("titles the chat from the first question, clamped at 48 chars, and never overwrites it", () => {
    const db = freshRoom();
    const chat = createChat(db);
    gatherContextAndSaveQuestion(db, chat.id, "x".repeat(60), [], null, null);
    const first = db.prepare("SELECT title FROM chats WHERE id = ?").get(chat.id) as { title: string };
    expect(first.title).toBe(`${"x".repeat(48)}…`);

    gatherContextAndSaveQuestion(db, chat.id, "second question", [], null, null);
    const second = db.prepare("SELECT title FROM chats WHERE id = ?").get(chat.id) as { title: string };
    expect(second.title).toBe(first.title);
  });

  it("adds the web-access tool block only when the setting is on", () => {
    const db = freshRoom();
    expect(gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null).chatMessages[0]?.content).not.toContain(
      "web_search (find pages)"
    );
    setSetting(db, "web_provider", "duckduckgo");
    const on = gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null);
    expect(on.chatMessages[0]?.content).toContain("web_search (find pages)");
    expect(on.webEnabled).toBe(true);
  });

  it("advertises connected MCP servers only when the injected seam reports any", () => {
    const db = freshRoom();
    const withServers = gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null, {
      connectedMcpServers: () => ["gmail", "calendar"],
    });
    expect(withServers.chatMessages[0]?.content).toContain(
      "connected external tool servers to this room: gmail, calendar"
    );
    expect(gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null).chatMessages[0]?.content).not.toContain(
      "connected external tool servers"
    );
  });

  it("injects the room persona, the style preset and custom instructions", () => {
    const db = freshRoom();
    setSetting(db, "room_role", "tutor");
    setSetting(db, "response_style", "formal");
    setSetting(db, "custom_instructions", "Always answer in bullet points.");
    const system = gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null).chatMessages[0]!.content;
    expect(system).toContain("patient tutor");
    expect(system).toContain("Response style: FORMAL");
    expect(system).toContain("standing preferences below say otherwise");
    expect(system).toContain("Always answer in bullet points.");
  });

  it("lists the file inventory with its cached one-liners", () => {
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("lease text"), "lease text", "upload");
    db.prepare("UPDATE files SET ai_summary = ? WHERE name = ?").run("A residential lease.", "lease.pdf");
    const system = gatherContextAndSaveQuestion(db, randomUUID(), "hi", [], null, null).chatMessages[0]!.content;
    expect(system).toContain("Files currently stored in this room:");
    expect(system).toContain("lease.pdf (application/pdf) — A residential lease.");
  });

  it("injects question-relevant memories into the USER message, never the system prompt", () => {
    const db = freshRoom();
    addMemory(db, "The tenant's name is Dana Cohen.", null);
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "Who is the tenant?", [], null, null);
    expect(ctx.chatMessages[0]?.content).not.toContain("Dana Cohen");
    const user = ctx.chatMessages.at(-1)!;
    expect(user.content).toContain("Notes to remember for this room:");
    expect(user.content).toContain("Dana Cohen");
  });

  it("carries a text attachment as guaranteed context and a source chip", () => {
    const db = freshRoom();
    const file = insertFile(db, "notes.txt", "text/plain", Buffer.from("secret plan"), "secret plan", "upload");
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "what's the plan?", [file.id], null, null);
    expect(ctx.chatMessages.at(-1)!.content).toContain("[attached file: notes.txt]\nsecret plan");
    expect(ctx.sources).toContain("notes.txt");
  });

  it("says an attachment with no extracted text was NOT sent, rather than guessing", () => {
    const db = freshRoom();
    const file = insertFile(db, "scan.pdf", "application/pdf", Buffer.from("bytes"), null, "upload");
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "what does it say?", [file.id], null, null);
    expect(ctx.chatMessages.at(-1)!.content).toContain("no readable text has been extracted from it yet");
    expect(ctx.sources).not.toContain("scan.pdf");
  });

  it("skips an attachment id that no longer exists, without failing the turn", () => {
    const db = freshRoom();
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "about that file", ["gone-id"], null, null);
    expect(ctx.sources).toEqual([]);
    expect(ctx.chatMessages.at(-1)!.content).toContain("Question: about that file");
  });

  it("carries an attached image through the prepareImage seam and reports the first one", () => {
    const db = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "what's in this?", [file.id], null, null, {
      prepareImage: (bytes) => ({ bytes: Buffer.concat([bytes, Buffer.from([9])]), width: 1000, height: 1000 }),
    });
    const user = ctx.chatMessages.at(-1)!;
    expect(user.images).toHaveLength(1);
    expect(user.images?.[0]).toBe(Buffer.from([1, 2, 3, 9]).toString("base64"));
    expect(ctx.firstImage).toEqual({
      fileId: file.id,
      name: "photo.png",
      bytes: Buffer.from([1, 2, 3, 9]),
      width: 1000,
      height: 1000,
    });
  });

  it("says so instead of silently dropping more than MAX_ATTACHED_IMAGES", () => {
    const db = freshRoom();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(insertFile(db, `p${i}.png`, "image/png", Buffer.from([i]), null, "upload").id);
    }
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "look at these", ids, null, null);
    const user = ctx.chatMessages.at(-1)!;
    expect(user.images).toHaveLength(4);
    expect(user.content).toContain("NOT sent: this turn carries at most 4 images");
  });

  it("says an image row with no stored bytes was NOT sent", () => {
    const db = freshRoom();
    const file = insertFile(db, "ghost.png", "image/png", Buffer.alloc(0), null, "upload");
    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(file.id);
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "describe it", [file.id], null, null);
    expect(ctx.chatMessages.at(-1)!.content).toContain("the room has no image data stored for it");
    expect(ctx.chatMessages.at(-1)!.images).toBeUndefined();
  });

  it("names the viewed file only when nothing was carried (attachments answer 'this' instead)", () => {
    const db = freshRoom();
    const without = gatherContextAndSaveQuestion(db, randomUUID(), "summarize this", [], null, "lease.pdf");
    expect(without.chatMessages.at(-1)!.content).toContain('The user has "lease.pdf" open in the workspace');

    const file = insertFile(db, "notes.txt", "text/plain", Buffer.from("x"), "x", "upload");
    const withAttachment = gatherContextAndSaveQuestion(db, randomUUID(), "summarize this", [file.id], null, "lease.pdf");
    expect(withAttachment.chatMessages.at(-1)!.content).not.toContain("open in the workspace");
  });

  // CARRIED, not clipped. A paperclip whose content never reached the model
  // resolves no anaphora, so suppressing the hint for it left the turn with
  // NEITHER — the model was handed "summarize this" and nothing that says what
  // "this" is.
  it("still names the viewed file when the paperclip was DROPPED and carried nothing", () => {
    const db = freshRoom();
    // A scan with no extracted text yet: clipped, but nothing reaches the model.
    const dropped = insertFile(db, "scan.pdf", "application/pdf", Buffer.from("bytes"), null, "upload");
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "summarize this", [dropped.id], null, "lease.pdf");
    const user = ctx.chatMessages.at(-1)!.content;
    expect(user).toContain("no readable text has been extracted from it yet");
    expect(user).toContain('The user has "lease.pdf" open in the workspace');
  });

  // The user's own paperclip is the strongest signal about what the question is
  // about, so it leads the context block; the retrieved excerpts follow it.
  it("puts attached files BEFORE retrieved excerpts in the context block", () => {
    const db = freshRoom();
    insertFile(db, "lease.pdf", "application/pdf", Buffer.from("parking"), "The parking space is reserved.", "upload");
    const attached = insertFile(db, "notes.txt", "text/plain", Buffer.from("x"), "secret plan", "upload");
    const user = gatherContextAndSaveQuestion(
      db,
      randomUUID(),
      "what about the parking space?",
      [attached.id],
      null,
      null
    ).chatMessages.at(-1)!.content;

    const note = user.indexOf("[attached file: notes.txt]");
    const chunk = user.indexOf("[file: lease.pdf]");
    expect(note).toBeGreaterThan(-1);
    expect(chunk).toBeGreaterThan(-1);
    expect(note).toBeLessThan(chunk);
    // …and both sit under the one header, which the attachment makes non-fallback.
    expect(user.indexOf("Context from files stored in this room:")).toBeLessThan(note);
  });

  it("adds the bare-save anaphora hint only when there is history to refer back to", () => {
    const db = freshRoom();
    const chatId = randomUUID();
    const first = gatherContextAndSaveQuestion(db, chatId, "save that as a file", [], null, null);
    expect(first.chatMessages.at(-1)!.content).not.toContain('the user\'s "that"/"this" refers to earlier content');

    const second = gatherContextAndSaveQuestion(db, chatId, "save that as a file", [], null, null);
    expect(second.chatMessages.at(-1)!.content).toContain('the user\'s "that"/"this" refers to earlier content');
  });

  it("advertises enabled, unowned skills and honors an explicit /skill request", () => {
    const db = freshRoom();
    createSkill(db, "lease-review", "Reviews a lease for red flags.", "Check the termination clause.", true, "user", "");
    createSkill(db, "disabled-one", "Not ready yet.", "…", false, "user", "");
    // Scoped to a sub-agent — never advertised to the main assistant.
    createSkill(db, "video-cut", "Trims a video.", "Do the trim.", true, "user", "media.video");

    const plain = gatherContextAndSaveQuestion(db, randomUUID(), "look at my lease", [], null, null);
    const plainUser = plain.chatMessages.at(-1)!.content;
    expect(plainUser).toContain("lease-review: Reviews a lease for red flags.");
    expect(plainUser).not.toContain("disabled-one");
    expect(plainUser).not.toContain("- video-cut:");

    const explicit = gatherContextAndSaveQuestion(db, randomUUID(), "/lease-review check the deposit clause", [], null, null);
    const explicitUser = explicit.chatMessages.at(-1)!.content;
    expect(explicitUser).toContain("Explicitly selected Agent Skill: /lease-review");
    expect(explicitUser).toContain("Check the termination clause.");
    expect(explicitUser).toContain("Question: check the deposit clause");
  });

  it("throws for an unknown /skill rather than silently ignoring it, and saves nothing", () => {
    const db = freshRoom();
    const chatId = randomUUID();
    expect(() => gatherContextAndSaveQuestion(db, chatId, "/no-such-skill do it", [], null, null)).toThrow(
      'No skill named "no-such-skill" exists.'
    );
    expect(listMessages(db, chatId)).toHaveLength(0);
  });

  it("throws for a disabled /skill, naming it a draft", () => {
    const db = freshRoom();
    createSkill(db, "draft-skill", "d", "instructions", false, "user", "");
    expect(() => gatherContextAndSaveQuestion(db, randomUUID(), "/draft-skill go", [], null, null)).toThrow(
      /still a disabled draft/
    );
  });

  it("falls back to recent content when nothing matches, but never credits it as a source", () => {
    const db = freshRoom();
    insertFile(db, "random.txt", "text/plain", Buffer.from("unrelated content"), "unrelated content", "upload");
    const ctx = gatherContextAndSaveQuestion(db, randomUUID(), "asdkjasldkj qwepoiqwe", [], null, null);
    expect(ctx.chatMessages.at(-1)!.content).toContain("Recently added content (may be unrelated to the question):");
    expect(ctx.sources).not.toContain("random.txt");
  });

  it("preserves conversation history under the compaction budget, oldest to newest", () => {
    const db = freshRoom();
    const chatId = randomUUID();
    insertMessage(db, chatId, "user", "first turn", [], null);
    insertMessage(db, chatId, "assistant", "first reply", [], null);
    const ctx = gatherContextAndSaveQuestion(db, chatId, "second turn", [], null, null);
    expect(ctx.chatMessages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(ctx.chatMessages[1]?.content).toBe("first turn");
  });
});
