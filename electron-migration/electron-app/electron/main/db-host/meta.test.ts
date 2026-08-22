/**
 * Vitest port of the `meta.rs` tests (`src-tauri/src/db/meta.rs`, `mod
 * tests`):
 *
 *   - set_meta_upserts_and_reads_back
 *
 * Plus (against a real fixture room made with the sibling `open.ts`
 * `createRoom`, rather than Rust's bare in-memory `mem()` helper, since this
 * port has no equivalent in-memory schema helper of its own): getMeta reads
 * back the format/format_version/name rows `createRoom` stamps, getMeta
 * returns null for a never-set key, and setMeta on a brand-new key followed
 * by setMeta on an EXISTING key (overwriting "name") in the same room.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./open.js";
import { getMeta, setMeta } from "./meta.js";

// A unique throwaway room path in a fresh temp dir per test.
let tmpDir: string;
function tempRoomPath(): string {
  return path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function withFreshTmpDir<T>(fn: () => T): T {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-meta-"));
  return fn();
}

describe("getMeta", () => {
  it("reads back the rows createRoom stamps", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");

      expect(getMeta(db, "format")).toBe("roomai");
      expect(getMeta(db, "format_version")).toBe("1");
      expect(getMeta(db, "name")).toBe("My Room");

      db.close();
    });
  });

  it("returns null for an unset key", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");

      expect(getMeta(db, "no_such_key")).toBeNull();

      db.close();
    });
  });
});

describe("setMeta", () => {
  // Ported from meta.rs `set_meta_upserts_and_reads_back`: set_meta writes,
  // get_meta reads, a second write replaces in place rather than erroring on
  // the UNIQUE conflict or duplicating the row.
  it("set_meta_upserts_and_reads_back", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");

      expect(getMeta(db, "embed_model")).toBeNull();
      setMeta(db, "embed_model", "nomic-embed-text");
      expect(getMeta(db, "embed_model")).toBe("nomic-embed-text");
      setMeta(db, "embed_model", "other");
      expect(getMeta(db, "embed_model")).toBe("other");

      // UPSERT never duplicates the key.
      const row = db
        .prepare("SELECT count(*) as n FROM meta WHERE key = 'embed_model'")
        .get() as { n: number };
      expect(row.n).toBe(1);

      db.close();
    });
  });

  it("inserts a brand-new key", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");

      expect(getMeta(db, "brand_new")).toBeNull();
      setMeta(db, "brand_new", "hello");
      expect(getMeta(db, "brand_new")).toBe("hello");

      db.close();
    });
  });

  it("overwrites an existing meta row (name) in place rather than erroring", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");

      expect(getMeta(db, "name")).toBe("My Room");
      setMeta(db, "name", "Renamed Room");
      expect(getMeta(db, "name")).toBe("Renamed Room");

      const row = db.prepare("SELECT count(*) as n FROM meta WHERE key = 'name'").get() as {
        n: number;
      };
      expect(row.n).toBe(1);

      db.close();
    });
  });
});
