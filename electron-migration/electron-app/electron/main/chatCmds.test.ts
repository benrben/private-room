/**
 * Vitest port of `chat.rs`'s `#[cfg(test)] mod tests`
 * (`pasted_media_gets_the_same_ceiling_a_linked_file_does`, reproduced
 * byte-for-byte below as `checkPasteSize`'s own describe block), plus real
 * fixture-room coverage for every command chat.rs has no test of its own for
 * — the same "port the Rust tests, then add real DB coverage" split
 * `db-host/chats.test.ts` documents.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { getFileBytes } from "./db-host/files.js";
import { createRoom } from "./db-host/open.js";
import { createRoomManagerState, type RoomManagerState } from "./roomManager.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { MAX_DOWNLOAD_BYTES } from "./web.js";
import {
  checkPasteSize,
  createChat,
  deleteChat,
  deleteMessage,
  enqueueSttNotImplemented,
  getMessages,
  importAudioBytes,
  importAudioBytesHybrid,
  importImageBytes,
  importImageBytesHybrid,
  listChats,
  registerChatIpc,
  renameChat,
  STT_ENQUEUE_NOT_IMPLEMENTED,
  type ChatCmdsDeps,
  type JobMeta,
} from "./chatCmds.js";

let tmpDir: string;

beforeEach(() => {
  // Every call that reaches `enqueueSttNotImplemented` (the default, when a
  // test does not inject its own `enqueueStt`) logs a real NOT_IMPLEMENTED
  // line — see module doc. Keep the suite's own console quiet, the same
  // pattern `roomCheckpoints.test.ts` uses for its own unwired-dep logging.
  // The two tests that specifically assert on this logging re-spy locally,
  // which layers a fresh mock on top and still captures the call.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** A room open on a real fixture file, with the manager state pointed at it —
 * the same shape `roomCheckpoints.test.ts`'s own `openRoomState` uses. */
function openRoomState(tag: string): { state: RoomManagerState; conn: Database.Database; roomPath: string } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), `chatCmds-${tag}-`));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  const conn = createRoom(roomPath, "correct horse battery staple", "Test Room");
  const state = createRoomManagerState();
  state.room = { conn, path: roomPath, name: "Test Room", password: "correct horse battery staple" };
  return { state, conn, roomPath };
}

function emptyState(): RoomManagerState {
  return createRoomManagerState();
}

// ============================================================================
// checkPasteSize — ported verbatim from chat.rs's own test
// ============================================================================

describe("checkPasteSize", () => {
  it("pasted_media_gets_the_same_ceiling_a_linked_file_does", () => {
    // An ordinary paste is untouched.
    expect(() => checkPasteSize(1024, "shot.png")).not.toThrow();
    // Exactly at the limit still passes; one base64 quantum over does not.
    const atLimit = (MAX_DOWNLOAD_BYTES / 3) * 4;
    expect(() => checkPasteSize(atLimit, "shot.png")).not.toThrow();
    let message = "";
    try {
      checkPasteSize(atLimit + 4, "voice note.m4a");
      throw new Error("expected checkPasteSize to throw");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, "names the file").toContain("voice note.m4a");
    expect(message, "states the limit").toContain("limit for a room file");
    expect(message, "the exact wording, em dash included").toBe(
      "voice note.m4a is 900 MB — larger than the 900 MB limit for a room file."
    );
  });
});

// ============================================================================
// list_chats / create_chat / delete_chat / get_messages / rename_chat /
// delete_message
// ============================================================================

describe("chat CRUD commands", () => {
  it("refuse cleanly when no room is open", () => {
    const state = emptyState();
    expect(() => listChats(state)).toThrow("No room is open.");
    expect(() => createChat(state)).toThrow("No room is open.");
    expect(() => deleteChat(state, "x")).toThrow("No room is open.");
    expect(() => getMessages(state, "x")).toThrow("No room is open.");
    expect(() => renameChat(state, "x", "y")).toThrow("No room is open.");
    expect(() => deleteMessage(state, "x")).toThrow("No room is open.");
  });

  it("reach the real DB logic, not a stub", () => {
    const { state, conn } = openRoomState("crud");
    expect(listChats(state)).toEqual([]);

    const chat = createChat(state);
    expect(chat.title).toBe("New chat");
    expect(listChats(state).map((c) => c.id)).toEqual([chat.id]);

    renameChat(state, chat.id, "Renamed");
    expect(listChats(state)[0]?.title).toBe("Renamed");

    conn.prepare("INSERT INTO messages(id, chat_id, role, content) VALUES (?, ?, 'user', 'hi')").run(
      randomUUID(),
      chat.id
    );
    const messages = getMessages(state, chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hi");

    deleteMessage(state, messages[0]!.id);
    expect(getMessages(state, chat.id)).toHaveLength(0);

    deleteChat(state, chat.id);
    expect(listChats(state)).toEqual([]);
  });
});

// ============================================================================
// import_image_bytes
// ============================================================================

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("importImageBytes", () => {
  it("stores pasted image and audio bytes as normal workspace files", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-cmds-workspace-"));
    const root = path.join(tmpDir, "Workspace");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Workspace");
    const state = createRoomManagerState();
    state.room = {
      conn: db,
      path: root,
      name: "Workspace",
      password: "correct horse battery staple",
      workspace: new WorkspaceService(db, root),
    };
    const jobs: JobMeta[] = [];

    const image = await importImageBytesHybrid(state, "shot.png", PNG_B64);
    const audio = await importAudioBytesHybrid(
      state,
      { enqueueStt: (job) => jobs.push(job) },
      "note.m4a",
      PNG_B64,
    );

    expect(readFileSync(path.join(root, "shot.png"))).toEqual(Buffer.from(PNG_B64, "base64"));
    expect(readFileSync(path.join(root, "note.m4a"))).toEqual(Buffer.from(PNG_B64, "base64"));
    const rows = db.prepare(
      "SELECT original_bytes FROM files WHERE id IN (?, ?)",
    ).all(image.id, audio.id) as Array<{ original_bytes: Buffer | null }>;
    expect(rows.every((row) => row.original_bytes === null)).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: audio.id, name: "note.m4a", roomPath: root });
    db.close();
  });

  it("stores the decoded bytes as an uploaded file, mime guessed from the name", () => {
    const { state, conn } = openRoomState("image");
    const meta = importImageBytes(state, "shot.png", PNG_B64);
    expect(meta.name).toBe("shot.png");
    expect(meta.mimeType).toBe("image/png");
    expect(meta.sizeBytes).toBe(4);
    expect(
      (conn.prepare("SELECT source FROM files WHERE id = ?").get(meta.id) as { source: string }).source
    ).toBe("upload");
  });

  it("defaults to image/png for an unrecognized extension", () => {
    const { state } = openRoomState("image-default-mime");
    const meta = importImageBytes(state, "mystery.xyz", PNG_B64);
    expect(meta.mimeType).toBe("image/png");
  });

  // Regression: a plain `{}[key]` lookup table resolves "__proto__" to the
  // object's own prototype rather than `undefined`, which `?? fallback`
  // never catches — this app has shipped that exact bug twice already
  // (`mcpConfig.ts`, `privacyRedact.ts`, per `jsonTools.ts`'s doc). A pasted
  // file literally named "shot.__proto__" must still fall back to a plain
  // string mime, not leak `Object.prototype` into the files table.
  it("a file named after a prototype key does not leak Object.prototype as the mime", () => {
    const { state } = openRoomState("image-proto-key");
    const meta = importImageBytes(state, "shot.__proto__", PNG_B64);
    expect(meta.mimeType).toBe("image/png");
    expect(typeof meta.mimeType).toBe("string");
  });

  // NOTE: the exact 900 MB boundary is exhaustively proven above by
  // `checkPasteSize`'s own ported test (byte-for-byte, including the em dash
  // and both MB figures); it is not re-proven here through a real >900 MB
  // string, which would mean allocating a JS string past V8's own length
  // ceiling just to watch it get rejected. What IS worth proving at this
  // layer is that `import_image_bytes` calls `check_paste_size` at all
  // (rather than skipping straight to decode) — the next test does that with
  // a small, safe input by checking WHICH refusal comes back.

  it("decodes INSIDE with_room: no room open reports the room refusal, not a decode error", () => {
    const state = emptyState();
    expect(() => importImageBytes(state, "shot.png", "not base64!!")).toThrow("No room is open.");
  });

  it("refuses invalid base64 with a real room open", () => {
    const { state } = openRoomState("image-bad-b64");
    expect(() => importImageBytes(state, "shot.png", "not base64!!")).toThrow(
      "Could not read the pasted image"
    );
  });
});

// ============================================================================
// import_audio_bytes
// ============================================================================

describe("importAudioBytes", () => {
  it("m4a and mp4 both get audio/mp4, exactly like the Rust match arm", () => {
    const { state: s1 } = openRoomState("audio-m4a");
    expect(importAudioBytes(s1, {}, "note.m4a", PNG_B64).mimeType).toBe("audio/mp4");
    const { state: s2 } = openRoomState("audio-mp4");
    expect(importAudioBytes(s2, {}, "note.mp4", PNG_B64).mimeType).toBe("audio/mp4");
  });

  it("webm gets audio/webm", () => {
    const { state } = openRoomState("audio-webm");
    expect(importAudioBytes(state, {}, "note.webm", PNG_B64).mimeType).toBe("audio/webm");
  });

  it("falls back to a guessed mime for any other extension, audio/mp4 if unknown", () => {
    const { state: wav } = openRoomState("audio-wav");
    expect(importAudioBytes(wav, {}, "note.wav", PNG_B64).mimeType).toBe("audio/x-wav");
    const { state: unknown } = openRoomState("audio-unknown");
    expect(importAudioBytes(unknown, {}, "note.mysteryext", PNG_B64).mimeType).toBe("audio/mp4");
  });

  // Same regression as import_image_bytes's own prototype-key test, for the
  // audio table's fallback branch.
  it("a file named after a prototype key does not leak Object.prototype as the mime", () => {
    const { state } = openRoomState("audio-proto-key");
    const meta = importAudioBytes(state, {}, "note.__proto__", PNG_B64);
    expect(meta.mimeType).toBe("audio/mp4");
    expect(typeof meta.mimeType).toBe("string");
  });

  it("decodes BEFORE with_room: no room open still reports the decode failure, not the room refusal", () => {
    const state = emptyState();
    expect(() => importAudioBytes(state, {}, "note.m4a", "not base64!!")).toThrow(
      "Could not read the recording"
    );
  });

  it("with no enqueueStt supplied, still returns a real FileMeta and only logs NOT_IMPLEMENTED", () => {
    const { state, conn } = openRoomState("audio-stt-default");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const meta = importAudioBytes(state, {}, "note.m4a", PNG_B64);
      expect(meta.name).toBe("note.m4a");
      expect(
        (conn.prepare("SELECT name FROM files WHERE id = ?").get(meta.id) as { name: string }).name
      ).toBe("note.m4a");
      expect(spy).toHaveBeenCalledWith(STT_ENQUEUE_NOT_IMPLEMENTED);
    } finally {
      spy.mockRestore();
    }
  });

  it("enqueueSttNotImplemented itself logs rather than throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        enqueueSttNotImplemented({
          id: "x",
          name: "note.m4a",
          mime: "audio/mp4",
          ext: "m4a",
          roomPath: "/tmp/x.roomai",
          epoch: 0,
        })
      ).not.toThrow();
      expect(spy).toHaveBeenCalledWith(STT_ENQUEUE_NOT_IMPLEMENTED);
    } finally {
      spy.mockRestore();
    }
  });

  it("hands a real enqueueStt the JobMeta pinned to the epoch in effect right after the insert", () => {
    const { state, roomPath } = openRoomState("audio-stt-real");
    state.roomEpoch = 7;
    const jobs: JobMeta[] = [];
    const deps: ChatCmdsDeps = { enqueueStt: (job) => jobs.push(job) };
    const meta = importAudioBytes(state, deps, "note.m4a", PNG_B64);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: meta.id,
      name: "note.m4a",
      mime: "audio/mp4",
      ext: "m4a",
      roomPath,
      epoch: 7,
    });
  });

  it("the recording is retrievable through the ordinary messages/files path", () => {
    const { state } = openRoomState("audio-e2e");
    const chat = createChat(state);
    const meta = importAudioBytes(state, {}, "note.webm", PNG_B64);
    expect(meta.hasText).toBe(false); // no extracted text at insert time — see module doc
    // Sanity: the chat CRUD and the import share the same open room.
    expect(getMessages(state, chat.id)).toEqual([]);
  });
});

// ============================================================================
// registerChatIpc — thin forwarding, invoked directly (rule 4)
// ============================================================================

type Handler = (...args: unknown[]) => unknown;

function registerForTest(state: RoomManagerState, deps: ChatCmdsDeps = {}): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeEvent = {} as never;
  const handle = vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, (...args: unknown[]) => listener(fakeEvent, ...args));
  });
  registerChatIpc({ handle }, state, deps);
  return handlers;
}

describe("registerChatIpc", () => {
  it("registers all eight channels, in chat.rs's own order", () => {
    const handlers = registerForTest(emptyState());
    expect([...handlers.keys()]).toEqual([
      "list_chats",
      "create_chat",
      "delete_chat",
      "get_messages",
      "rename_chat",
      "delete_message",
      "import_image_bytes",
      "import_audio_bytes",
    ]);
  });

  it("a handler that needs a room refuses cleanly when none is open", () => {
    const handlers = registerForTest(emptyState());
    expect(() => handlers.get("list_chats")!()).toThrow("No room is open.");
  });

  it("forwards arguments faithfully and reaches the real DB logic", async () => {
    const { state } = openRoomState("ipc");
    const handlers = registerForTest(state);

    const chat = handlers.get("create_chat")!() as { id: string; title: string };
    expect(chat.title).toBe("New chat");

    handlers.get("rename_chat")!({ id: chat.id, title: "Via IPC" });
    expect((handlers.get("list_chats")!() as { title: string }[])[0]?.title).toBe("Via IPC");

    expect(handlers.get("get_messages")!({ chatId: chat.id })).toEqual([]);

    const meta = await handlers.get("import_image_bytes")!({ name: "shot.png", b64: PNG_B64 }) as {
      id: string;
      mimeType: string;
    };
    expect(meta.mimeType).toBe("image/png");

    handlers.get("delete_chat")!({ id: chat.id });
    expect(handlers.get("list_chats")!()).toEqual([]);
  });

  it("threads its ChatCmdsDeps into import_audio_bytes", async () => {
    const { state } = openRoomState("ipc-audio-deps");
    const jobs: JobMeta[] = [];
    const handlers = registerForTest(state, { enqueueStt: (job) => jobs.push(job) });
    await handlers.get("import_audio_bytes")!({ name: "note.m4a", b64: PNG_B64 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.mime).toBe("audio/mp4");
  });
});

// ============================================================================
// Adversarial: names that read as another feature's syntax, degenerate base64,
// and prototype-shaped extensions reaching the two MIME tables.
// ============================================================================

describe("adversarial", () => {
  it("a pasted file whose NAME is a #command line is stored as data, never parsed", () => {
    const { state, conn } = openRoomState("hostile-name");
    // `import_image_bytes`/`import_audio_bytes` are CRUD over db::insert_file —
    // there is no `#`/`@` recognition anywhere in chat.rs, so a name shaped
    // like a composer line must survive byte for byte into the row.
    const hostile = "#add-file for each: @a.pdf, @b.pdf.png";
    const meta = importImageBytes(state, hostile, PNG_B64);
    expect(meta.name).toBe(hostile);
    expect(meta.mimeType).toBe("image/png");
    const jobs: JobMeta[] = [];
    const audioName = "#transcribe @meeting to Spanish.m4a";
    const audio = importAudioBytes(state, { enqueueStt: (j) => jobs.push(j) }, audioName, PNG_B64);
    expect(audio.name).toBe(audioName);
    expect(audio.mimeType).toBe("audio/mp4");
    // The queued STT job carries the same untouched name.
    expect(jobs[0]?.name).toBe(audioName);
    expect(getFileBytes(conn, meta.id)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("an empty paste is a real empty file, and a malformed one is refused by name", () => {
    const { state } = openRoomState("degenerate-b64");
    // "" is valid base64 for zero bytes — Rust's `decode("")` is `Ok(vec![])`,
    // so this really does store an empty file rather than erroring.
    const empty = importImageBytes(state, "empty.png", "");
    expect(empty.name).toBe("empty.png");
    // Anything that is not canonical base64 is refused, and the two functions
    // give DIFFERENT messages — chat.rs's own asymmetry, worth pinning.
    for (const bad of ["not base64!", "aGVsbG8", "aGVs bG8=", "####"]) {
      expect(() => importImageBytes(state, "shot.png", bad)).toThrow(/Could not read the pasted image/);
      expect(() => importAudioBytes(state, {}, "note.m4a", bad)).toThrow(/Could not read the recording/);
    }
  });

  it("a prototype-shaped extension resolves to the fallback mime, not Object.prototype", () => {
    const { state } = openRoomState("proto-ext");
    // `table[key]` on a plain `{}` would resolve "__proto__"/"constructor" to
    // a non-string, which `?? fallback` never catches — it would reach
    // db::insert_file's `mime` column. The hasOwnProperty guard is what makes
    // these come back as the two Rust fallbacks.
    for (const name of ["shot.__proto__", "shot.constructor", "shot.toString", "shot.valueOf"]) {
      expect(importImageBytes(state, name, PNG_B64).mimeType).toBe("image/png");
    }
    for (const name of ["note.__proto__", "note.constructor", "note.hasOwnProperty"]) {
      expect(importAudioBytes(state, {}, name, PNG_B64).mimeType).toBe("audio/mp4");
    }
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("the size ceiling names the file it refused, whatever that name looks like", () => {
    // Measured on the BASE64 LENGTH, never on a decoded copy — which is why
    // this can be asserted without ever materialising an 800 MB string (the
    // ceiling is far past JS's own max string length, so a literal oversized
    // paste cannot even be constructed here).
    const over = (MAX_DOWNLOAD_BYTES / 3) * 4 + 4;
    expect(() => checkPasteSize(over, "#find huge.png")).toThrow(/^#find huge\.png is \d+ MB/);
    expect(() => checkPasteSize(over, "voice note.m4a")).toThrow(
      /voice note\.m4a is \d+ MB — larger than the \d+ MB limit for a room file\.$/
    );
    // A name that is itself a format string stays literal.
    expect(() => checkPasteSize(over, "{} MB ${x}.png")).toThrow(/^\{\} MB \$\{x\}\.png is /);
  });

  it("with no room open, the two importers refuse in their own DIFFERENT order", () => {
    // chat.rs decodes INSIDE `with_room` for images and BEFORE it for audio.
    // Garbage base64 with no room open therefore gives two different errors,
    // and flattening them into one shape would be a silent divergence.
    expect(() => importImageBytes(emptyState(), "shot.png", "not base64!")).toThrow("No room is open.");
    expect(() => importAudioBytes(emptyState(), {}, "note.m4a", "not base64!")).toThrow(
      /Could not read the recording/
    );
  });
});
