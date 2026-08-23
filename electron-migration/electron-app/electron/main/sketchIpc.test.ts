/**
 * Tests for `sketchIpc.ts` — the registration shape and the "no room
 * open" refusal, matching `recIpc.test.ts`'s own established pattern.
 * Everything a handler could decide lives in `sketchCommands.ts` and is
 * tested there; what these check is that each channel exists, is
 * registered once, reaches the real DB-backed logic rather than a stub, and
 * that `emit` is threaded through where the Rust source calls
 * `app.emit(...)`.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { registerSketchIpc, type RoomSource } from "./sketchIpc.js";

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sketchIpc-"));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

function roomSource(open: boolean): RoomSource {
  return { currentRoom: () => (open ? { db, path: roomPath } : null) };
}

const EXPECTED_CHANNELS = ["create_sketch", "save_sketch", "export_sketch_svg", "export_sketch_png"];

function listener(handle: ReturnType<typeof vi.fn>, channel: string): (...args: unknown[]) => unknown {
  const entry = handle.mock.calls.find((c) => c[0] === channel);
  if (entry === undefined) {
    throw new Error(`channel ${channel} was not registered`);
  }
  return entry[1] as (...args: unknown[]) => unknown;
}

describe("registerSketchIpc", () => {
  it("registers every Sketch page channel exactly once", () => {
    freshRoom();
    const handle = vi.fn();
    registerSketchIpc({ handle }, roomSource(true));
    expect(handle.mock.calls.map((c) => c[0] as string)).toEqual(EXPECTED_CHANNELS);
  });

  it("a handler that needs a room refuses cleanly when none is open", async () => {
    freshRoom();
    const handle = vi.fn();
    registerSketchIpc({ handle }, roomSource(false));
    await expect(
      Promise.resolve().then(() => listener(handle, "create_sketch")({}, { name: "Flow" }))
    ).rejects.toThrowError("No room is open.");
  });

  it("create_sketch reaches the real DB logic, not a stub", async () => {
    freshRoom();
    const handle = vi.fn();
    registerSketchIpc({ handle }, roomSource(true));
    const meta = (await listener(handle, "create_sketch")({}, { name: "Flow" })) as { name: string };
    expect(meta.name).toBe("Flow.sketch");
  });

  it("save_sketch writes real bytes through the real logic", async () => {
    freshRoom();
    const handle = vi.fn();
    registerSketchIpc({ handle }, roomSource(true));
    const meta = (await listener(handle, "create_sketch")({}, { name: "Flow" })) as { id: string };
    const doc =
      '{"version":1,"width":1600,"height":1000,"seq":1,"elements":[' +
      '{"id":"e1","type":"rect","x":10,"y":10,"w":80,"h":60,"ink":"blue","label":"hi"}]}';
    await listener(handle, "save_sketch")({}, { id: meta.id, doc, snapshot: false });
    const row = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(meta.id) as {
      extracted_text: string;
    };
    expect(row.extracted_text).toContain("hi");
  });

  it("threads a supplied emit callback through to room-files-changed", async () => {
    freshRoom();
    const handle = vi.fn();
    const emit = vi.fn();
    registerSketchIpc({ handle }, roomSource(true), emit);
    await listener(handle, "create_sketch")({}, { name: "Flow" });
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });

  it("export_sketch_svg and export_sketch_png reach the real rendering logic", async () => {
    freshRoom();
    const handle = vi.fn();
    registerSketchIpc({ handle }, roomSource(true));
    const meta = (await listener(handle, "create_sketch")({}, { name: "Flow" })) as { id: string };
    const svgMeta = (await listener(handle, "export_sketch_svg")({}, { id: meta.id })) as { name: string };
    expect(svgMeta.name).toBe("Flow.svg");
    const pngMeta = (await listener(handle, "export_sketch_png")({}, { id: meta.id })) as { name: string };
    expect(pngMeta.name).toBe("Flow.png");
  });
});
