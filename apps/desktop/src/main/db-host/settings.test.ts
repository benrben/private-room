/**
 * Vitest coverage for `settings.ts`.
 *
 * `src-tauri/src/db/settings.rs` has NO `#[cfg(test)]` module of its own (it
 * is 17 lines), so these are new tests rather than a port — written in the
 * style of the sibling `meta.test.ts`, since `settings` is the same
 * key/value shape as `meta` and is a real table in the room schema rather
 * than scratch plumbing, so it gets a real fixture room via `createRoom`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./open.js";
import { getSetting, setSetting } from "./settings.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-settings-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

describe("getSetting", () => {
  it("returns null for an unset key", () => {
    const db = freshRoom();
    expect(getSetting(db, "no_such_key")).toBeNull();
    db.close();
  });
});

describe("setSetting", () => {
  it("upserts_and_reads_back", () => {
    const db = freshRoom();

    expect(getSetting(db, "theme")).toBeNull();
    setSetting(db, "theme", "dark");
    expect(getSetting(db, "theme")).toBe("dark");
    setSetting(db, "theme", "light");
    expect(getSetting(db, "theme")).toBe("light");

    // UPSERT never duplicates the key.
    const row = db.prepare("SELECT count(*) as n FROM settings WHERE key = 'theme'").get() as {
      n: number;
    };
    expect(row.n).toBe(1);

    db.close();
  });

  it("inserts_a_brand_new_key", () => {
    const db = freshRoom();
    expect(getSetting(db, "brand_new")).toBeNull();
    setSetting(db, "brand_new", "hello");
    expect(getSetting(db, "brand_new")).toBe("hello");
    db.close();
  });

  it("keeps independent keys independent", () => {
    const db = freshRoom();
    setSetting(db, "a", "1");
    setSetting(db, "b", "2");
    setSetting(db, "a", "3");
    expect(getSetting(db, "a")).toBe("3");
    expect(getSetting(db, "b")).toBe("2");
    db.close();
  });
});
