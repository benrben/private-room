import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceIndexService } from "./indexing.js";

const candidate = { id: "file-1", name: "notes.txt", content_sha256: "expected-hash" };

describe("workspace indexing stale-result boundaries", () => {
  it("discards an extraction when the row changes between validation and transaction commit", async () => {
    let hashReads = 0;
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("ORDER BY last_seen_at")) return { all: () => [candidate] };
        if (sql.includes("SELECT content_sha256")) {
          return { get: () => ({ content_sha256: ++hashReads === 1 ? "expected-hash" : "replacement-hash" }) };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      transaction: (callback: () => void) => () => callback(),
    };
    const workspace = { db, readStream: () => Readable.from(["notes"]) };
    const indexer = new WorkspaceIndexService(workspace as never, async () => ({
      text: "notes",
      sha256: "expected-hash",
      sizeBytes: 5,
    }));

    await expect(indexer.indexPending()).resolves.toEqual({
      ready: 0,
      unsupported: 0,
      failed: 0,
      staleDiscarded: 1,
    });
  });

  it("discards an extractor failure when the current-row check itself is unavailable", async () => {
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("ORDER BY last_seen_at")) return { all: () => [candidate] };
        if (sql.includes("SELECT content_sha256")) return { get: () => { throw new Error("fabricated closed db"); } };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    const workspace = { db, readStream: () => Readable.from(["notes"]) };
    const indexer = new WorkspaceIndexService(workspace as never, async () => {
      throw new Error("fabricated extraction failure");
    });

    await expect(indexer.indexPending()).resolves.toMatchObject({ failed: 0, staleDiscarded: 1 });
  });
});
