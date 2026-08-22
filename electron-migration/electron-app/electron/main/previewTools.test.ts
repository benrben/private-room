/**
 * Tests for `previewTools.ts` — `commands/preview.rs`'s `quicklook_preview`
 * port. Runs the real room-lookup / DB-read / empty-bytes short-circuit
 * against a real fixture `.roomai` file; the render step (the not-yet-ported
 * PyObjC/sidecar half) is exercised both via its honest NOT_IMPLEMENTED stub
 * and via an injected fake standing in for a future real renderer.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import {
  previewRenderNotImplemented,
  QUICKLOOK_RENDER_NOT_IMPLEMENTED,
  quicklookPreview,
  registerPreviewIpc,
  type PreviewRenderFn,
  type RoomSource,
} from "./previewTools.js";

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "previewTools-"));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

function roomSource(open: boolean): RoomSource {
  return { currentRoom: () => (open ? { db, path: roomPath } : null) };
}

describe("quicklookPreview", () => {
  it("throws when the id names no file in this room — mirrors get_file_full's Err propagation", async () => {
    freshRoom();
    await expect(quicklookPreview(db, "no-such-id")).rejects.toThrow();
  });

  it("resolves null for empty bytes WITHOUT ever calling render — Ok(None) short-circuit before the OS call", async () => {
    freshRoom();
    const file = insertFile(db, "empty.key", "application/vnd.apple.keynote", new Uint8Array(), null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.reject(new Error("must not be called")));
    await expect(quicklookPreview(db, file.id, render)).resolves.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it("resolves null for a NULL bytes column — bytes.unwrap_or_default() reads as empty, not a crash", async () => {
    freshRoom();
    const file = insertFile(db, "linked.pages", "application/vnd.apple.pages", new Uint8Array([1]), null, "library");
    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(file.id);
    const render = vi.fn<PreviewRenderFn>(() => Promise.reject(new Error("must not be called")));
    await expect(quicklookPreview(db, file.id, render)).resolves.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it("passes the file's NAME and BYTES to render — QuickLook dispatches on the extension", async () => {
    freshRoom();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = insertFile(db, "deck.key", "application/vnd.apple.keynote", bytes, null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([9, 9, 9])));
    await quicklookPreview(db, file.id, render);
    expect(render).toHaveBeenCalledTimes(1);
    const [name, gotBytes] = render.mock.calls[0]!;
    expect(name).toBe("deck.key");
    expect(Buffer.from(gotBytes)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("base64-encodes a real render result into pngB64", async () => {
    freshRoom();
    const file = insertFile(db, "photo.raw", "image/x-raw", new Uint8Array([1, 2, 3]), null, "library");
    const pngBytes = Buffer.from("not really a png but bytes", "utf8");
    const render: PreviewRenderFn = () => Promise.resolve(pngBytes);
    const result = await quicklookPreview(db, file.id, render);
    expect(result).toEqual({ pngB64: pngBytes.toString("base64") });
  });

  it("resolves null (not an error) when render reports the OS drew nothing — 'this Mac can't preview it either' is a normal answer", async () => {
    freshRoom();
    const file = insertFile(db, "mystery.xyz", "application/octet-stream", new Uint8Array([1]), null, "library");
    const render: PreviewRenderFn = () => Promise.resolve(null);
    await expect(quicklookPreview(db, file.id, render)).resolves.toBeNull();
  });

  it("with no render dependency, rejects with the labelled NOT_IMPLEMENTED reason rather than a fabricated result", async () => {
    freshRoom();
    const file = insertFile(db, "deck.key", "application/vnd.apple.keynote", new Uint8Array([1, 2, 3]), null, "library");
    await expect(quicklookPreview(db, file.id)).rejects.toThrow(QUICKLOOK_RENDER_NOT_IMPLEMENTED);
    expect(QUICKLOOK_RENDER_NOT_IMPLEMENTED).toMatch(/^NOT_IMPLEMENTED: /);
  });

  it("previewRenderNotImplemented itself always rejects, never resolves a fabricated PNG or a fabricated null", async () => {
    await expect(previewRenderNotImplemented("x.key", Buffer.from([1]))).rejects.toThrow(
      QUICKLOOK_RENDER_NOT_IMPLEMENTED
    );
  });

  // ADVERSARIAL: the three ways this command can be asked for something that
  // isn't there, and the one place its two "nothing" answers must NOT collapse
  // into each other.
  it("an EMPTY render result is `{pngB64: ''}`, not null — Rust's Some(vec![]) is a drawn preview, None is not", async () => {
    // `png.map(|png| QuickLookPreview { ... })` maps `Some(vec![])` to a
    // struct carrying the empty string. Only `None` becomes `null`. Folding
    // an empty buffer into `null` would make "the OS drew a zero-byte image"
    // indistinguishable from "the OS has no Quick Look extension for this",
    // which is precisely the distinction the Rust doc comment insists on.
    freshRoom();
    const file = insertFile(db, "deck.key", "application/vnd.apple.keynote", new Uint8Array([1]), null, "library");
    await expect(quicklookPreview(db, file.id, () => Promise.resolve(Buffer.alloc(0)))).resolves.toEqual({
      pngB64: "",
    });
  });

  it("a TRASHED file is refused, never previewed — get_file_full's `trashed_at IS NULL` is part of the contract", async () => {
    freshRoom();
    const file = insertFile(db, "secret.key", "application/vnd.apple.keynote", new Uint8Array([1, 2]), null, "library");
    db.prepare("UPDATE files SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(file.id);
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([9])));
    await expect(quicklookPreview(db, file.id, render)).rejects.toThrow();
    expect(render).not.toHaveBeenCalled();
  });

  it("an empty id is a missing file, not an empty preview", async () => {
    freshRoom();
    await expect(quicklookPreview(db, "", () => Promise.resolve(null))).rejects.toThrow();
  });

  it("base64 survives an oversized render result byte for byte", async () => {
    freshRoom();
    const file = insertFile(db, "huge.psd", "image/vnd.adobe.photoshop", new Uint8Array([1]), null, "library");
    // 1 MB of non-ASCII bytes at a length that is NOT a multiple of 3, so the
    // encoder's padding path is exercised too. Compared with Buffer.equals
    // rather than a deep-equality matcher, which walks a megabyte byte by byte.
    const big = Buffer.alloc(1024 * 1024 + 1);
    for (let i = 0; i < big.length; i++) {
      big[i] = (i * 7 + 13) & 0xff;
    }
    const result = await quicklookPreview(db, file.id, () => Promise.resolve(big));
    expect(Buffer.from(result!.pngB64, "base64").equals(big)).toBe(true);
  });
});

describe("registerPreviewIpc", () => {
  function listener(handle: ReturnType<typeof vi.fn>, channel: string): (...args: unknown[]) => unknown {
    const entry = handle.mock.calls.find((c) => c[0] === channel);
    if (entry === undefined) {
      throw new Error(`channel ${channel} was not registered`);
    }
    return entry[1] as (...args: unknown[]) => unknown;
  }

  it("registers exactly the quicklook_preview channel", () => {
    freshRoom();
    const handle = vi.fn();
    registerPreviewIpc({ handle }, roomSource(true));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("quicklook_preview");
  });

  it("refuses with 'No room is open.' when no room is open — AppState::with_room's own wording", async () => {
    freshRoom();
    const handle = vi.fn();
    registerPreviewIpc({ handle }, roomSource(false));
    const fn = listener(handle, "quicklook_preview");
    // openDb() throws SYNCHRONOUSLY rather than returning a rejected promise
    // — which a real `ipcMain.handle` listener is allowed to do (Electron's
    // bridge turns either shape into an `invoke()` rejection). Calling the raw
    // listener bypasses that bridge, so normalize both here, exactly as
    // `recIpc.test.ts` does for the same "No room is open." case.
    await expect(Promise.resolve().then(() => fn({}, { id: "anything" }))).rejects.toThrow(
      "No room is open."
    );
  });

  it("reaches the real DB-backed logic, not a stub — a bad id gets the real 'no such file' failure", async () => {
    freshRoom();
    const handle = vi.fn();
    registerPreviewIpc({ handle }, roomSource(true));
    const fn = listener(handle, "quicklook_preview");
    await expect(fn({}, { id: "not-a-real-id" })).rejects.toThrow();
  });

  it("forwards an injected render dependency through to the real logic", async () => {
    freshRoom();
    const file = insertFile(db, "deck.key", "application/vnd.apple.keynote", new Uint8Array([1, 2]), null, "library");
    const render: PreviewRenderFn = () => Promise.resolve(Buffer.from([5, 6]));
    const handle = vi.fn();
    registerPreviewIpc({ handle }, roomSource(true), render);
    const fn = listener(handle, "quicklook_preview");
    await expect(fn({}, { id: file.id })).resolves.toEqual({ pngB64: Buffer.from([5, 6]).toString("base64") });
  });
});
