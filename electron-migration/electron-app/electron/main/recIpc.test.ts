/**
 * Tests for `recIpc.ts` — the registration shape and the "no room open"
 * refusal. Everything a handler could decide lives in `recBridge.ts` and is
 * tested there; what these check is that each channel exists, is registered
 * once, and reaches the real DB-backed logic rather than a stub.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { defaultRecMeta, encodeWav } from "./recFormat.js";
import { createRecBridgeCtx, type RecBridgeCtx } from "./recBridge.js";
import { registerRecIpc, type RoomSource } from "./recIpc.js";

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "recIpc-"));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

function roomSource(open: boolean): RoomSource {
  return { currentRoom: () => (open ? { db, path: roomPath } : null) };
}

function ctxFor(source: RoomSource): RecBridgeCtx {
  return createRecBridgeCtx({ currentRoom: () => source.currentRoom() });
}

/** Every channel `registerRecIpc` registers, in order — pinned so a channel
 * silently dropped from the list fails here rather than shipping unnoticed.
 * These are the `#[tauri::command]` names `src/api.ts:1249-1345` invokes. */
const EXPECTED_CHANNELS = [
  "rec_start",
  "rec_push_audio",
  "rec_pause",
  "rec_resume",
  "rec_stop",
  "rec_live_status",
  "rec_set_live_translate",
  "rec_set_live_stt",
  "rec_get",
  "rec_delete_range",
  "rec_correct_range",
  "rec_set_speaker_name",
  "rec_read_start",
  "rec_note_add",
  "rec_note_set",
  "rec_chapter_add",
  "rec_chapter_set",
  "rec_highlight_add",
  "rec_item_delete",
  "voices_list",
  "voice_forget",
  "rec_export_clean",
  "rec_translate",
  "rec_retranscribe",
];

function listener(
  handle: ReturnType<typeof vi.fn>,
  channel: string
): (...args: unknown[]) => unknown {
  const entry = handle.mock.calls.find((c) => c[0] === channel);
  if (entry === undefined) {
    throw new Error(`channel ${channel} was not registered`);
  }
  return entry[1] as (...args: unknown[]) => unknown;
}

describe("registerRecIpc", () => {
  it("registers every ADD-27 channel exactly once", () => {
    freshRoom();
    const handle = vi.fn();
    const source = roomSource(true);
    registerRecIpc({ handle }, ctxFor(source), source);
    expect(handle.mock.calls.map((c) => c[0] as string)).toEqual(EXPECTED_CHANNELS);
  });

  it("a handler that needs a room refuses cleanly when none is open", async () => {
    freshRoom();
    const handle = vi.fn();
    const source = roomSource(false);
    registerRecIpc({ handle }, ctxFor(source), source);
    // `recGet` is synchronous, so its listener throws rather than returning a
    // rejected promise — which a real `ipcMain.handle` listener is allowed to
    // do (Electron's bridge turns either shape into an `invoke()` rejection).
    // Calling the raw listener bypasses that bridge, so normalize both here.
    await expect(
      Promise.resolve().then(() => listener(handle, "rec_get")({}, { id: "x" }))
    ).rejects.toThrowError("No room is open.");
  });

  it("a room-backed handler reaches the real DB logic, not a stub", async () => {
    freshRoom();
    const file = insertFile(db, "call.wav", "audio/wav", encodeWav(new Float32Array(0)), null, "recording");
    setRecMeta(db, file.id, JSON.stringify(defaultRecMeta()));
    const handle = vi.fn();
    const source = roomSource(true);
    registerRecIpc({ handle }, ctxFor(source), source);

    expect((await listener(handle, "rec_get")({}, { id: file.id })) as { name: string }).toMatchObject({
      name: "call.wav",
    });
    const meta = (await listener(handle, "rec_note_add")({}, {
      id: file.id,
      t0: 0,
      kind: "point",
      text: "hello",
    })) as { notes: unknown[] };
    expect(meta.notes).toHaveLength(1);
    expect(JSON.parse(getRecMeta(db, file.id) as string).notes).toHaveLength(1);
    expect(await listener(handle, "voices_list")({})).toEqual([]);
  });

  it("rec_live_status answers the control-plane shape, and null with nothing live", async () => {
    freshRoom();
    const handle = vi.fn();
    const source = roomSource(true);
    const ctx = ctxFor(source);
    registerRecIpc({ handle }, ctx, source);
    expect(await listener(handle, "rec_live_status")({})).toBeNull();
    ctx.state.liveFileId = "f1";
    ctx.state.liveStatus = "paused";
    // Deliberately NOT Rust's `RecLive` — `durationCs` and the per-source
    // health are only observable on the renderer's own `WS /rec/session`.
    expect(await listener(handle, "rec_live_status")({})).toEqual({ fileId: "f1", status: "paused" });
  });

  it("rec_push_audio is registered and refuses unconditionally", async () => {
    freshRoom();
    const handle = vi.fn();
    const source = roomSource(true);
    registerRecIpc({ handle }, ctxFor(source), source);
    await expect(
      listener(handle, "rec_push_audio")({}, { rate: 16_000, dataB64: "AAAA" }) as Promise<unknown>
    ).rejects.toThrowError(/WS \/rec\/session/);
  });
});
