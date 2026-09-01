// The journal insert/emit path, against a REAL encrypted room (via
// db-host/open.ts's `createRoom`) rather than a mock DB — this workspace's own
// convention (see open.test.ts), and the only way to actually prove invariant
// #2: the web leaves no trace, the AGENT's conduct leaves a complete one,
// inside the encrypted room. A written row has to survive a real SQLCipher
// round trip with the shape `BrowseJournalRow` promises the renderer.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom } from "../db-host/open.js";
import { insertBrowseJournal, journal, nowIso, type JournalSink } from "./journal.js";

let dir: string | null = null;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function realRoom() {
  dir = mkdtempSync(path.join(os.tmpdir(), "arcelle-browser-journal-"));
  const filePath = path.join(dir, "test.room");
  return createRoom(filePath, "correct horse battery staple", "Test Room");
}

describe("insertBrowseJournal", () => {
  it("writes a real row into a real room and reads it back with an assigned id", () => {
    const db = realRoom();
    try {
      const row = insertBrowseJournal(db, "20260822120000-0", "open", "https://example.com/", "Opened");
      expect(row.id).toBeGreaterThan(0);
      expect(row.session).toBe("20260822120000-0");
      expect(row.kind).toBe("open");
      expect(row.url).toBe("https://example.com/");
      expect(row.detail).toBe("Opened");
      expect(typeof row.at).toBe("string");
      expect(row.at.length).toBeGreaterThan(0);

      const again = db.prepare("SELECT COUNT(*) AS n FROM browse_journal").get() as { n: number };
      expect(again.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rows for different sittings are independently readable", () => {
    const db = realRoom();
    try {
      const a = insertBrowseJournal(db, "sit-a", "open", "https://a.example/", "");
      const b = insertBrowseJournal(db, "sit-b", "open", "https://b.example/", "");
      expect(a.id).not.toBe(b.id);
      const rows = db
        .prepare("SELECT session FROM browse_journal ORDER BY id")
        .all() as { session: string }[];
      expect(rows.map((r) => r.session)).toEqual(["sit-a", "sit-b"]);
    } finally {
      db.close();
    }
  });

  it("keeps the inserted row when best-effort retention cannot run", () => {
    const inserted = { lastInsertRowid: 5_001 };
    const row = { id: 5_001, session: "sit", kind: "open", url: "https://example.com", detail: "", at: "now" };
    const insert = { run: vi.fn(() => inserted) };
    const select = { get: vi.fn(() => row) };
    const trim = { run: vi.fn(() => { throw new Error("fabricated trim failure"); }) };
    const db = {
      prepare: vi.fn((sql: string) => sql.startsWith("INSERT")
        ? insert
        : sql.trimStart().startsWith("DELETE") ? trim : select),
    } as unknown as Parameters<typeof insertBrowseJournal>[0];

    expect(insertBrowseJournal(db, "sit", "open", "https://example.com", "")).toEqual(row);
    expect(trim.run).toHaveBeenCalledWith(4_999);
  });
});

describe("journal", () => {
  it("persists into the room AND emits the persisted row", () => {
    const db = realRoom();
    try {
      const emitted: unknown[] = [];
      const sink: JournalSink = { db, emit: (row) => emitted.push(row) };
      journal(sink, "sit-1", "act", "https://example.com/", "clicked e1");

      expect(emitted).toHaveLength(1);
      const row = emitted[0] as { id: number; session: string; kind: string };
      expect(row.id).toBeGreaterThan(0);
      expect(row.session).toBe("sit-1");
      expect(row.kind).toBe("act");

      const persisted = db.prepare("SELECT COUNT(*) AS n FROM browse_journal").get() as {
        n: number;
      };
      expect(persisted.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("a closed room is not an error — it still emits an honest row", () => {
    const emitted: unknown[] = [];
    const sink: JournalSink = { db: null, emit: (row) => emitted.push(row) };
    journal(sink, "sit-1", "blocked", "http://127.0.0.1/", "Navigation blocked");

    expect(emitted).toHaveLength(1);
    const row = emitted[0] as { session: string; kind: string; url: string; detail: string };
    expect(row.session).toBe("sit-1");
    expect(row.kind).toBe("blocked");
    expect(row.url).toBe("http://127.0.0.1/");
    expect(row.detail).toBe("Navigation blocked");
  });

  it("falls back to a live-only row when the room database rejects the write", () => {
    const db = realRoom();
    db.close();
    const emitted: unknown[] = [];

    expect(() => journal({ db, emit: (row) => emitted.push(row) }, "sit", "open", "https://example.com", "failed write")).not.toThrow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ id: -1, session: "sit", kind: "open", detail: "failed write" });
  });
});

describe("nowIso", () => {
  it("matches browser.rs's now_iso shape: %Y-%m-%dT%H:%M:%S", () => {
    const d = new Date(2026, 7, 22, 9, 5, 3);
    expect(nowIso(d)).toBe("2026-08-22T09:05:03");
  });
});
