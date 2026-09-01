/**
 * Vitest coverage for `retrievalBackfill.ts` — the port of
 * `src-tauri/src/commands/retrieval/backfill.rs`.
 *
 * `passIsCurrent`'s three cases are a direct port of backfill.rs's own
 * `#[cfg(test)] mod tests` — the only Rust unit tests that exist for this
 * material (`spawn_reextract_backfill`, `spawn_legacy_text_repair` and
 * `backfill_embeddings` each need a real `tauri::AppHandle`, which the Rust
 * suite never constructs). `isOcrCandidate`'s own port of `ocr.rs`'s
 * `ocr_candidates_are_images_and_pdfs` lives in `ocrTools.test.ts` — this file
 * imports the predicate from `ocrTools.ts` rather than carrying a second copy,
 * and exercises it only through `runReextractBackfill`'s real skip branch
 * below ("skips images, PDFs and media using the REAL predicates"). Everything
 * else here is new coverage, following the precedent `autoIndex.test.ts` and
 * `privacy.test.ts` set for a ported room-lifecycle background pass.
 *
 * REAL FIXTURE ROOMS throughout (this directory's convention): every test that
 * touches the database opens a real `.roomai` via `createRoom` and drives the
 * real `db-host/*` readers and writers. `embedAt`'s tests use a real
 * `node:http` server, matching `engineRouting.test.ts`'s "real behavior over
 * mocks" convention for this exact class of dependency.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import {
  chunksMissingEmbedding,
  forEachChunkEmbedding,
} from "./db-host/embeddings.js";
import {
  filesMissingText,
  getFileExtractedText,
  getFileMeta,
  insertFile,
  setFileAiSummary,
} from "./db-host/files.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import type { RoomHandle, RoomSource } from "./jobs.js";

// The production default reaches a real bundled sidecar. Keep every other
// sidecar export real, but make its startup seam controllable for the one
// regression that proves the default embedding path releases back to the pass.
vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});
import { ensureUp } from "./sidecar.js";

vi.mock("./workspace/roomContent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace/roomContent.js")>();
  return { ...actual, readRoomFile: vi.fn(actual.readRoomFile) };
});
import { readRoomFile } from "./workspace/roomContent.js";

import {
  type EmbedBackfillDeps,
  type EmbedFn,
  type LegacyTextRepairDeps,
  type ReextractBackfillDeps,
  EMBED_IDLE_POLL_MS,
  EMBED_RETRY_BACKOFF_MS,
  backfillEmbeddings,
  createEmbedBackfillState,
  embedAt,
  embedQuestion,
  embedViaSidecar,
  extractTextNotImplemented,
  passIsCurrent,
  runEmbedBackfillPass,
  runLegacyTextRepair,
  runReextractBackfill,
  spawnEmbeddingBackfill,
  spawnLegacyTextRepair,
  spawnReextractBackfill,
} from "./retrievalBackfill.js";

const ROOM = "/Users/x/Rooms/work.room";
const OTHER_ROOM = "/Users/x/Rooms/personal.room";

/**
 * The Rust source's own literals, spelled out here rather than imported from
 * the module under test. Asserting against the module's own exported constant
 * proves only that it equals itself — a test that could never go red on the
 * value drifting away from `backfill.rs`. The exports are still checked, once,
 * against these literals below.
 */
const RUST_IDLE_POLL_MS = 10_000; // Duration::from_secs(10)
const RUST_RETRY_BACKOFF_MS = 60_000; // Duration::from_secs(60)
const RUST_REPAIR_STAMP = "legacy_text_repaired_v1";

describe("the constants backfill.rs fixes", () => {
  it("carry the Rust source's own values", () => {
    expect(EMBED_IDLE_POLL_MS).toBe(RUST_IDLE_POLL_MS);
    expect(EMBED_RETRY_BACKOFF_MS).toBe(RUST_RETRY_BACKOFF_MS);
  });
});

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** A distinct temp dir per call — several tests open two rooms at once (the
 * room-swap fixtures), and each must be cleaned up independently. */
function freshRoom(): Database.Database {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "retrieval-backfill-"));
  tmpDirs.push(tmpDir);
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** A `RoomSource` whose `current()` answer can be swapped mid-test — the
 * fixture shape `autoIndex.test.ts`/`jobQueue.test.ts` use for this seam. */
function fakeRooms(getHandle: () => RoomHandle | null): RoomSource {
  return { current: getHandle };
}

function addFile(
  db: Database.Database,
  name: string,
  mime: string,
  text: string | null
): string {
  return insertFile(db, name, mime, Buffer.from(`${name}-bytes`, "utf8"), text, "upload").id;
}

function freshWorkspace(): {
  db: Database.Database;
  root: string;
  workspace: WorkspaceService;
} {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "retrieval-workspace-"));
  tmpDirs.push(tmpDir);
  const root = path.join(tmpDir, "Room");
  const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
  return { db, root, workspace: new WorkspaceService(db, root) };
}

// ============================================================================
// pass_is_current — the Rust suite's own three tests, verbatim
// ============================================================================

describe("passIsCurrent", () => {
  it("a superseded pass does not write (a_superseded_pass_does_not_write)", () => {
    // Another room was opened (or re-opened) while this batch was out at
    // Ollama, so a newer pass now owns the slot. Writing here would land
    // vectors computed from the previous corpus.
    expect(passIsCurrent(3, 4, ROOM, ROOM)).toBe(false);
  });

  it("a pass aimed at another room does not write (a_pass_aimed_at_another_room_does_not_write)", () => {
    // Same generation, different file — the ids in this batch address a
    // different room's chunks table.
    expect(passIsCurrent(3, 3, ROOM, OTHER_ROOM)).toBe(false);
  });

  it("the current pass writes (the_current_pass_writes)", () => {
    expect(passIsCurrent(3, 3, ROOM, ROOM)).toBe(true);
  });
});

// ============================================================================
// embedAt — real node:http server, mirroring engineRouting.test.ts
// ============================================================================

describe("embedAt", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  async function listenOn(handler: http.RequestListener): Promise<string> {
    const created = http.createServer(handler);
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    const { port } = created.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("POSTs {model, texts, base_url, keep_alive} to /embed and parses {embeddings}", async () => {
    let bodyRaw = "";
    let method: string | undefined;
    let url: string | undefined;
    const base = await listenOn((req, res) => {
      method = req.method;
      url = req.url;
      req.on("data", (chunk: Buffer) => (bodyRaw += chunk.toString("utf8")));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
      });
    });
    const out = await embedAt(base, "nomic-embed-text", ["search_query: hello"], "5m");
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(method).toBe("POST");
    expect(url).toBe("/embed");
    const body = JSON.parse(bodyRaw) as Record<string, unknown>;
    expect(body.model).toBe("nomic-embed-text");
    expect(body.texts).toEqual(["search_query: hello"]);
    expect(body.keep_alive).toBe("5m");
    expect(typeof body.base_url).toBe("string");
    // PRIV-1's inject_policy is deliberately not applied at this seam — the
    // same documented gap engineRouting.ts carries for /models. Pinned so the
    // omission stays a known one rather than becoming a silent surprise.
    expect(body.privacy).toBeUndefined();
  });

  it("empty texts short-circuits to [] without a network call", async () => {
    // Nothing is listening at that port — a real request would reject.
    expect(await embedAt("http://127.0.0.1:1", "nomic-embed-text", [], "5m")).toEqual([]);
  });

  it("throws on a non-2xx status", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(503);
      res.end("busy");
    });
    await expect(embedAt(base, "nomic-embed-text", ["x"], "5m")).rejects.toThrow(
      "sidecar /embed status 503"
    );
  });

  it("throws when the response carries no embeddings array", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    await expect(embedAt(base, "nomic-embed-text", ["x"], "5m")).rejects.toThrow(
      "Embed response had no embeddings"
    );
  });

  it("a bare `null` body is the same refusal, not a TypeError", async () => {
    // Rust indexes a Null value and gets None from `as_array()`; reading
    // `.embeddings` off `null` in JS would throw a TypeError instead, which
    // says nothing about what went wrong.
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("null");
    });
    await expect(embedAt(base, "nomic-embed-text", ["x"], "5m")).rejects.toThrow(
      "Embed response had no embeddings"
    );
  });

  it("drops non-number entries from a vector rather than propagating NaN", async () => {
    // Rust's `filter_map(|n| n.as_f64())`.
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: [[1, "oops", 2, null]] }));
    });
    expect(await embedAt(base, "nomic-embed-text", ["x"], "5m")).toEqual([[1, 2]]);
  });

  it("a non-array entry is an empty vector, not a failure", async () => {
    // Rust's `.map(...).unwrap_or_default()`; both callers already treat an
    // empty vector as "no embedding for this one".
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: [null, [1, 2]] }));
    });
    expect(await embedAt(base, "nomic-embed-text", ["a", "b"], "5m")).toEqual([[], [1, 2]]);
  });
});

// ============================================================================
// embedQuestion — CHG-12 prefix + "None on any failure"
// ============================================================================

describe("embedQuestion", () => {
  it("embeds with the search_query: prefix and returns the first vector", async () => {
    const calls: Array<[string, readonly string[], string]> = [];
    const embed: EmbedFn = async (model, texts, keepAlive) => {
      calls.push([model, texts, keepAlive]);
      return [[0.5, 0.25]];
    };
    expect(await embedQuestion("how much time off do I have", embed)).toEqual([0.5, 0.25]);
    expect(calls).toEqual([
      ["nomic-embed-text", ["search_query: how much time off do I have"], "5m"],
    ]);
  });

  it("resolves null when the embed call throws (model missing / sidecar down)", async () => {
    const embed: EmbedFn = () => Promise.reject(new Error("OLLAMA_DOWN"));
    await expect(embedQuestion("anything", embed)).resolves.toBeNull();
  });

  it("resolves null on an empty result", async () => {
    const embed: EmbedFn = async () => [];
    expect(await embedQuestion("anything", embed)).toBeNull();
  });

  it("resolves null when the first vector is itself empty", async () => {
    const embed: EmbedFn = async () => [[]];
    expect(await embedQuestion("anything", embed)).toBeNull();
  });

  it("defaults to the REAL sidecar call, never a stub", () => {
    // Not driven end-to-end here (that needs a live sidecar), but the default
    // has to be the real function — this is the seam `turnEngine.ts`'s
    // `AskDeps.embedQuestion` was declared against.
    expect(embedQuestion.length).toBe(1); // `embed` is optional
    expect(embedViaSidecar).toBeTypeOf("function");
  });
});

// ============================================================================
// runEmbedBackfillPass
// ============================================================================

describe("runEmbedBackfillPass", () => {
  function deps(db: Database.Database, embed: EmbedBackfillDeps["embed"]): EmbedBackfillDeps {
    return { rooms: fakeRooms(() => ({ db, path: ROOM })), embed };
  }

  it("idles when nothing lacks an embedding", async () => {
    const db = freshRoom();
    const embed = vi.fn();
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass(deps(db, embed), state, state.generation)).toEqual({
      kind: "idle",
    });
    expect(embed).not.toHaveBeenCalled();
    db.close();
  });

  it("embeds a batch with the search_document: prefix and writes the vectors back", async () => {
    const db = freshRoom();
    addFile(db, "hr.txt", "text/plain", "Our vacation schedule lists everyone's paid time away.");
    const before = chunksMissingEmbedding(db, 10);
    expect(before).toHaveLength(1);
    const [, name, text] = before[0] as [string, string, string];

    const calls: Array<[string, readonly string[], string]> = [];
    const embed: EmbedFn = async (model, texts, keepAlive) => {
      calls.push([model, texts, keepAlive]);
      return [[1, 0, 0]];
    };
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass(deps(db, embed), state, state.generation)).toEqual({
      kind: "wrote",
      count: 1,
    });
    expect(calls).toEqual([
      ["nomic-embed-text", [`search_document: ${name}\n${text}`], "30s"],
    ]);
    expect(chunksMissingEmbedding(db, 10)).toEqual([]);
    // …and a real blob landed on the chunk, not just a NULL that stopped
    // matching the "missing" query.
    const written: Array<[number, Buffer]> = [];
    forEachChunkEmbedding(db, (rowid, blob) => written.push([rowid, Buffer.from(blob)]));
    expect(written).toHaveLength(1);
    expect((written[0] as [number, Buffer])[1].length).toBe(3 * 4); // three f32s
    db.close();
  });

  it("uses the production sidecar default when an embedding seam is not supplied", async () => {
    const db = freshRoom();
    addFile(db, "default.txt", "text/plain", "the default sidecar route");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: [[1, 0, 0]] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);

    try {
      const state = createEmbedBackfillState();
      await expect(runEmbedBackfillPass({ rooms: fakeRooms(() => ({ db, path: ROOM })) }, state, 0))
        .resolves.toEqual({ kind: "wrote", count: 1 });
      expect(ensureUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(ensureUp).mockReset();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it("skips a per-vector failure without counting it, and without aborting the batch", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    addFile(db, "b.txt", "text/plain", "beta content");
    const embed: EmbedFn = async (_m, texts) => texts.map((_t, i) => (i === 0 ? [] : [1, 0]));
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass(deps(db, embed), state, state.generation)).toEqual({
      kind: "wrote",
      count: 1,
    });
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(1);
    db.close();
  });

  it("continues when one embedding write is rejected by the database", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    addFile(db, "b.txt", "text/plain", "beta content");
    const [first] = chunksMissingEmbedding(db, 10);
    const firstId = first?.[0];
    expect(firstId).toBeDefined();
    db.exec(
      `CREATE TRIGGER reject_first_embedding BEFORE UPDATE OF embedding ON chunks
       WHEN OLD.id = '${firstId}' BEGIN SELECT RAISE(FAIL, 'simulated embedding write'); END;`,
    );

    const state = createEmbedBackfillState();
    await expect(
      runEmbedBackfillPass(deps(db, async (_model, texts) => texts.map(() => [1, 0, 0])), state, 0),
    ).resolves.toEqual({ kind: "wrote", count: 1 });
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(1);
    db.close();
  });

  it("backs off on a thrown embed call, writing nothing", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    const embed: EmbedFn = () => Promise.reject(new Error("MODEL_MISSING:nomic-embed-text"));
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass(deps(db, embed), state, state.generation)).toEqual({
      kind: "embedFailed",
    });
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(1);
    db.close();
  });

  it("backs off when the embed call returns the wrong vector count", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    addFile(db, "b.txt", "text/plain", "beta content");
    const embed: EmbedFn = async () => [[1, 0]]; // one vector for two texts
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass(deps(db, embed), state, state.generation)).toEqual({
      kind: "embedFailed",
    });
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(2);
    db.close();
  });

  it("a superseded generation writes nothing, even though the embed call succeeded", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    const state = createEmbedBackfillState();
    const embed: EmbedFn = async () => {
      state.generation += 1; // a newer spawn took the slot mid-call
      return [[1, 0, 0]];
    };
    expect(await runEmbedBackfillPass(deps(db, embed), state, state.generation)).toEqual({
      kind: "stale",
    });
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(1); // untouched
    db.close();
  });

  it("a room swap mid-call writes into neither room", async () => {
    const dbA = freshRoom();
    addFile(dbA, "a.txt", "text/plain", "alpha content");
    const dbB = freshRoom();
    addFile(dbB, "b.txt", "text/plain", "beta content");

    let current: RoomHandle | null = { db: dbA, path: ROOM };
    const rooms = fakeRooms(() => current);
    const embed: EmbedFn = async () => {
      current = { db: dbB, path: OTHER_ROOM }; // closed and reopened elsewhere
      return [[1, 0, 0]];
    };
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass({ rooms, embed }, state, state.generation)).toEqual({
      kind: "stale",
    });
    expect(chunksMissingEmbedding(dbA, 10)).toHaveLength(1);
    expect(chunksMissingEmbedding(dbB, 10)).toHaveLength(1);
    dbA.close();
    dbB.close();
  });

  it("the room closing mid-call writes nothing", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    let current: RoomHandle | null = { db, path: ROOM };
    const embed: EmbedFn = async () => {
      current = null; // the room was locked/closed while the call was out
      return [[1, 0, 0]];
    };
    const state = createEmbedBackfillState();
    expect(
      await runEmbedBackfillPass({ rooms: fakeRooms(() => current), embed }, state, state.generation)
    ).toEqual({ kind: "stale" });
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(1);
    db.close();
  });

  it("no room open at all is stale, not idle", async () => {
    const embed = vi.fn();
    const state = createEmbedBackfillState();
    expect(
      await runEmbedBackfillPass({ rooms: fakeRooms(() => null), embed }, state, state.generation)
    ).toEqual({ kind: "stale" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("a stale generation is checked BEFORE the room is ever read", async () => {
    // Rust checks `embed_generation` first and returns without taking the room
    // lock at all.
    const state = createEmbedBackfillState();
    state.generation = 5;
    let reads = 0;
    const rooms: RoomSource = {
      current: () => {
        reads += 1;
        return null;
      },
    };
    expect(await runEmbedBackfillPass({ rooms, embed: vi.fn() }, state, 3)).toEqual({
      kind: "stale",
    });
    expect(reads).toBe(0);
  });

  it("an unreadable batch read is idle, not stale — a transient DB hiccup does not stop the pass", async () => {
    const db = freshRoom();
    const throwing = {
      ...db,
      prepare: () => {
        throw new Error("simulated: db busy");
      },
    } as unknown as Database.Database;
    const embed = vi.fn();
    const state = createEmbedBackfillState();
    expect(await runEmbedBackfillPass(deps(throwing, embed), state, state.generation)).toEqual({
      kind: "idle",
    });
    expect(embed).not.toHaveBeenCalled();
    db.close();
  });
});

// ============================================================================
// backfillEmbeddings — the outer loop
// ============================================================================

describe("backfillEmbeddings", () => {
  it("drains every batch without sleeping, then idles for the Rust interval", async () => {
    const db = freshRoom();
    for (let i = 0; i < 5; i++) {
      addFile(db, `f${i}.txt`, "text/plain", `content number ${i}`);
    }
    let open = true;
    const state = createEmbedBackfillState();
    const sleeps: number[] = [];
    const embed: EmbedFn = async (_m, texts) => texts.map(() => [1, 0, 0]);

    await backfillEmbeddings(
      {
        rooms: fakeRooms(() => (open ? { db, path: ROOM } : null)),
        embed,
      },
      state,
      state.generation,
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          open = false; // let the loop stop on its next iteration
        },
      }
    );

    expect(chunksMissingEmbedding(db, 10)).toEqual([]); // every chunk drained
    // Exactly one sleep, and only after the drain — the write path never
    // sleeps, and the idle interval is backfill.rs's own 10 s.
    expect(sleeps).toEqual([RUST_IDLE_POLL_MS]);
    db.close();
  });

  it("an embed rejection backs off for the Rust interval and retries rather than throwing", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    const state = createEmbedBackfillState();
    const sleeps: number[] = [];
    const embed: EmbedFn = () => Promise.reject(new Error("ollama down"));

    await backfillEmbeddings(
      { rooms: fakeRooms(() => ({ db, path: ROOM })), embed },
      state,
      state.generation,
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          state.generation += 1; // stop after one back-off
        },
      }
    );

    expect(sleeps).toEqual([RUST_RETRY_BACKOFF_MS]);
    expect(chunksMissingEmbedding(db, 10)).toHaveLength(1); // untouched
    db.close();
  });

  it("stops immediately when the room is already gone", async () => {
    const embed = vi.fn();
    const state = createEmbedBackfillState();
    const sleep = vi.fn();
    await backfillEmbeddings({ rooms: fakeRooms(() => null), embed }, state, state.generation, {
      sleep,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps polling an idle room until the generation moves", async () => {
    const db = freshRoom();
    const state = createEmbedBackfillState();
    let ticks = 0;
    await backfillEmbeddings(
      { rooms: fakeRooms(() => ({ db, path: ROOM })), embed: vi.fn() },
      state,
      state.generation,
      {
        sleep: async () => {
          ticks += 1;
          if (ticks === 3) {
            state.generation += 1;
          }
        },
      }
    );
    expect(ticks).toBe(3);
    db.close();
  });
});

describe("spawnEmbeddingBackfill", () => {
  it("bumps the generation, returns it, and the pass it starts actually writes", async () => {
    const db = freshRoom();
    addFile(db, "a.txt", "text/plain", "alpha content");
    let open = true;
    const embed: EmbedFn = async (_m, texts) => texts.map(() => [1, 0, 0]);
    const state = createEmbedBackfillState();

    const generation = spawnEmbeddingBackfill(
      { rooms: fakeRooms(() => (open ? { db, path: ROOM } : null)), embed },
      state,
      { idleMs: 1, errorBackoffMs: 1 }
    );
    expect(generation).toBe(1);
    expect(state.generation).toBe(1);

    await vi.waitFor(() => {
      expect(chunksMissingEmbedding(db, 10)).toEqual([]);
    });
    open = false; // let the detached loop stop rather than idle forever
    db.close();
  });

  it("a second call supersedes the first", () => {
    const rooms = fakeRooms(() => null); // no room: both passes end at once
    const state = createEmbedBackfillState();
    const first = spawnEmbeddingBackfill({ rooms }, state);
    const second = spawnEmbeddingBackfill({ rooms }, state);
    expect(second).toBe(first + 1);
    expect(state.generation).toBe(second);
  });

  it("reports a throw from the detached loop rather than leaving it unhandled", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = createEmbedBackfillState();
    spawnEmbeddingBackfill(
      {
        rooms: {
          current: () => {
            throw new Error("boom");
          },
        },
      },
      state
    );
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith("embedding backfill 1 failed:", expect.any(Error));
    });
  });
});

// ============================================================================
// runReextractBackfill / spawnReextractBackfill
// ============================================================================

describe("runReextractBackfill", () => {
  it("extracts a workspace file from normal bytes without repopulating original_bytes", async () => {
    const { db, root, workspace } = freshWorkspace();
    const bytes = Buffer.from("workspace spreadsheet bytes");
    const entry = await workspace.createFile("numbers.xlsx", Readable.from([bytes]), "upload");
    const notify = vi.fn();

    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: root, workspace })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: (_name, source) => {
        expect(source).toEqual(bytes);
        return "42 43 44";
      },
    });

    expect(getFileExtractedText(db, entry.fileId)).toBe("42 43 44");
    const row = db.prepare(
      "SELECT original_bytes FROM files WHERE id = ?",
    ).get(entry.fileId) as { original_bytes: Buffer | null };
    expect(row.original_bytes).toBeNull();
    expect(await workspace.readBuffer(entry.fileId)).toEqual(bytes);
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("skips a workspace entry whose normal file disappeared before the pass", async () => {
    const { db, root, workspace } = freshWorkspace();
    await workspace.createFile(
      "gone.xlsx",
      Readable.from([Buffer.from("normal file that disappears")]),
      "upload",
    );
    rmSync(path.join(root, "gone.xlsx"));
    const extractText = vi.fn(() => "must not receive missing bytes");

    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: root, workspace })),
      roomEpoch: () => 0,
      extractText,
    });

    expect(extractText).not.toHaveBeenCalled();
    db.close();
  });

  it("skips a workspace entry whose reader has no bytes to extract", async () => {
    const { db, root, workspace } = freshWorkspace();
    const entry = await workspace.createFile(
      "empty.xlsx",
      Readable.from([Buffer.from("normal bytes")]),
      "upload",
    );
    vi.mocked(readRoomFile).mockResolvedValueOnce({
      name: "empty.xlsx",
      mimeType: "application/vnd.ms-excel",
      bytes: null,
      extractedText: null,
      storageKind: "workspace",
    });
    const extractText = vi.fn(() => "must not receive absent bytes");

    try {
      await runReextractBackfill({
        rooms: fakeRooms(() => ({ db, path: root, workspace })),
        roomEpoch: () => 0,
        extractText,
      });
      expect(extractText).not.toHaveBeenCalled();
      expect(getFileExtractedText(db, entry.fileId)).toBeNull();
    } finally {
      vi.mocked(readRoomFile).mockReset();
      db.close();
    }
  });

  it("treats an unreadable candidate query as an empty pass", async () => {
    const db = freshRoom();
    const unavailable = {
      ...db,
      prepare: () => {
        throw new Error("simulated: files query unavailable");
      },
    } as unknown as Database.Database;
    const extractText = vi.fn(() => "must not run");

    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db: unavailable, path: ROOM })),
      roomEpoch: () => 0,
      extractText,
    });

    expect(extractText).not.toHaveBeenCalled();
    db.close();
  });

  it("discards workspace extraction when the normal file changes during extraction", async () => {
    const { db, root, workspace } = freshWorkspace();
    const entry = await workspace.createFile(
      "numbers.xlsx",
      Readable.from([Buffer.from("old bytes")]),
      "upload",
    );
    const initial = db.prepare(
      "SELECT content_sha256 FROM files WHERE id = ?",
    ).get(entry.fileId) as { content_sha256: string };
    const replacement = Buffer.from("externally newer bytes");
    const notify = vi.fn();

    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: root, workspace })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: async () => {
        await workspace.writeAtomic(
          entry.fileId,
          Readable.from([replacement]),
          initial.content_sha256,
        );
        return "text from obsolete bytes";
      },
    });

    expect(await workspace.readBuffer(entry.fileId)).toEqual(replacement);
    expect(getFileExtractedText(db, entry.fileId)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it("re-extracts a file that carries no text, and re-indexes it", async () => {
    const db = freshRoom();
    const id = addFile(db, "numbers.xlsx", "application/vnd.ms-excel", null);
    const notify = vi.fn();
    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: (name) => (name === "numbers.xlsx" ? "42 43 44" : null),
    });
    expect(getFileExtractedText(db, id)).toBe("42 43 44");
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("continues after a failed extracted-text write without reporting a repair", async () => {
    const db = freshRoom();
    const id = addFile(db, "numbers.xlsx", "application/vnd.ms-excel", null);
    db.exec(
      `CREATE TRIGGER reject_extract BEFORE UPDATE OF extracted_text ON files
       WHEN OLD.id = '${id}' BEGIN SELECT RAISE(FAIL, 'simulated text write'); END;`,
    );
    const notify = vi.fn();

    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: () => "recovered",
    });

    expect(getFileExtractedText(db, id)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it("skips images, PDFs and media using the REAL predicates — no injection", async () => {
    // The skip branch is the whole reason `is_image`/`is_ocr_candidate`/
    // `media_kind` are called here: stubbing them to "no" would feed every
    // scan, photo and recording in the room to the document extractor.
    const db = freshRoom();
    addFile(db, "photo.png", "image/png", null); // extraction::is_image
    addFile(db, "scan.pdf", "application/pdf", null); // ocr::is_ocr_candidate
    addFile(db, "meeting.wav", "audio/wav", null); // stt::media_kind (mime)
    addFile(db, "clip.mov", "application/octet-stream", null); // media_kind (ext)
    addFile(db, "notes.xlsx", "application/vnd.ms-excel", null); // the one candidate
    const seen: string[] = [];
    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      extractText: (name) => {
        seen.push(name);
        return "recovered";
      },
    });
    expect(seen).toEqual(["notes.xlsx"]);
    db.close();
  });

  it("uses ocrTools.ts's own startsWith semantics, not a hypothetical looser copy", async () => {
    // Regression guard for the isOcrCandidate consolidation: this file used
    // to carry its OWN byte-identical copy of `ocr::is_ocr_candidate` before
    // importing it from `ocrTools.ts`. A mime that merely CONTAINS "image/"
    // (rather than starting with it) is exactly the case ocrTools.test.ts's
    // own adversarial coverage pins down — reused here at the real call site
    // so a future drift between the two would fail an integration test too,
    // not only ocrTools.ts's own unit test.
    const db = freshRoom();
    addFile(db, "weird.bin", "application/x-image/jpeg", null);
    const seen: string[] = [];
    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      extractText: (name) => {
        seen.push(name);
        return "recovered";
      },
    });
    expect(seen).toEqual(["weird.bin"]);
    db.close();
  });

  it("a rollback (epoch bump) mid-pass drops the write AND abandons the rest of the batch", async () => {
    // Ported behavior, not a relaxation of it: Rust's epoch mismatch is a bare
    // `return` from the WHOLE async fn, not a `continue` to the next
    // candidate. A rollback mid-pass ends the pass; it does not skip one write
    // and carry on writing the rest of the pre-rollback bytes.
    const db = freshRoom();
    addFile(db, "a.xlsx", "application/vnd.ms-excel", null);
    addFile(db, "b.xlsx", "application/vnd.ms-excel", null);
    let roomEpoch = 0;
    const seen: string[] = [];
    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => roomEpoch,
      extractText: (name) => {
        seen.push(name);
        roomEpoch += 1; // a rollback lands between extraction and the write
        return "recovered text";
      },
    });
    expect(seen).toEqual(["a.xlsx"]);
    expect(filesMissingText(db).map((r) => r[1]).sort()).toEqual(["a.xlsx", "b.xlsx"]);
    db.close();
  });

  it("a room SWAP mid-pass abandons it too — including the already-fixed file's event", async () => {
    // The other half of the pin: same epoch, different room. The first file is
    // written; the second notices the swap, so the loop returns without ever
    // reaching its trailing `if fixed > 0 { emit }` — matching Rust's bare
    // `return` inside the loop, which also skips that emit.
    const db = freshRoom();
    const first = addFile(db, "a.xlsx", "application/vnd.ms-excel", null);
    const second = addFile(db, "b.xlsx", "application/vnd.ms-excel", null);
    let current: RoomHandle | null = { db, path: ROOM };
    const notify = vi.fn();
    await runReextractBackfill({
      rooms: fakeRooms(() => current),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: (name) => {
        if (name === "b.xlsx") {
          current = { db, path: OTHER_ROOM }; // swapped under the pass
        }
        return `recovered ${name}`;
      },
    });
    expect(getFileExtractedText(db, first)).toBe("recovered a.xlsx");
    expect(getFileExtractedText(db, second)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it("extractText answering null (nothing to fix) is not counted, and no event fires", async () => {
    const db = freshRoom();
    addFile(db, "weird.bin", "application/octet-stream", null);
    const notify = vi.fn();
    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: () => null,
    });
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it("no room open resolves immediately and touches nothing", async () => {
    const extractText = vi.fn(() => "x");
    await expect(
      runReextractBackfill({
        rooms: fakeRooms(() => null),
        roomEpoch: () => 0,
        extractText,
      })
    ).resolves.toBeUndefined();
    expect(extractText).not.toHaveBeenCalled();
  });

  it("the NOT_IMPLEMENTED extractor fixes nothing, logs its reason, and crashes nothing", async () => {
    const db = freshRoom();
    const id = addFile(db, "numbers.xlsx", "application/vnd.ms-excel", null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = vi.fn();
    await runReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: extractTextNotImplemented,
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("NOT_IMPLEMENTED"));
    expect(getFileExtractedText(db, id)).toBeNull(); // nothing fabricated
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });
});

describe("spawnReextractBackfill", () => {
  it("fire-and-forget: eventually fixes the file without the caller awaiting it", async () => {
    const db = freshRoom();
    const id = addFile(db, "numbers.xlsx", "application/vnd.ms-excel", null);
    spawnReextractBackfill({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      extractText: () => "42",
    });
    await vi.waitFor(() => {
      expect(getFileExtractedText(db, id)).toBe("42");
    });
    db.close();
  });

  it("a thrown error inside the pass is reported, not an unhandled rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    spawnReextractBackfill({
      rooms: {
        current() {
          throw new Error("boom");
        },
      },
      roomEpoch: () => 0,
      extractText: () => null,
    });
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith("reextract backfill failed:", expect.any(Error));
    });
  });
});

// ============================================================================
// runLegacyTextRepair / spawnLegacyTextRepair
// ============================================================================

describe("runLegacyTextRepair", () => {
  function repairDeps(
    db: Database.Database,
    overrides: Partial<LegacyTextRepairDeps> = {}
  ): LegacyTextRepairDeps {
    return {
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      extractText: () => null,
      ...overrides,
    };
  }

  it("repairs workspace legacy text while keeping current bytes in the normal file", async () => {
    const { db, root, workspace } = freshWorkspace();
    const bytes = Buffer.from("legacy doc bytes");
    const entry = await workspace.createFile("lease.doc", Readable.from([bytes]), "upload");
    const staleText = "Times New Roman / Droid Sans Fallback / …";
    db.prepare("UPDATE files SET extracted_text = ? WHERE id = ?").run(staleText, entry.fileId);
    const notify = vi.fn();

    await runLegacyTextRepair({
      rooms: fakeRooms(() => ({ db, path: root, workspace })),
      roomEpoch: () => 0,
      notifyFilesChanged: notify,
      extractText: (_name, source) => {
        expect(source).toEqual(bytes);
        return "The tenant shall pay rent.";
      },
    });

    expect(getFileExtractedText(db, entry.fileId)).toBe("The tenant shall pay rent.");
    expect(getSetting(db, RUST_REPAIR_STAMP)).toBe("1");
    const row = db.prepare(
      "SELECT original_bytes FROM files WHERE id = ?",
    ).get(entry.fileId) as { original_bytes: Buffer | null };
    expect(row.original_bytes).toBeNull();
    expect(await workspace.readBuffer(entry.fileId)).toEqual(bytes);
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("re-reads a .doc file whose legacy extractor was wrong, and stamps the room", async () => {
    const db = freshRoom();
    const id = addFile(
      db,
      "lease.doc",
      "application/msword",
      "Times New Roman / Droid Sans Fallback / …"
    );
    setFileAiSummary(db, id, "a stale cached summary");
    const notify = vi.fn();
    await runLegacyTextRepair(
      repairDeps(db, {
        extractText: (name) => (name === "lease.doc" ? "The tenant shall pay rent." : null),
        notifyFilesChanged: notify,
      })
    );
    expect(getFileExtractedText(db, id)).toBe("The tenant shall pay rent.");
    // updateFileContent clears the cached one-liner — proof the real writer ran.
    expect(getFileMeta(db, id).aiSummary).toBeNull();
    expect(getSetting(db, RUST_REPAIR_STAMP)).toBe("1");
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("continues from settings and candidate-query failures as an empty repair pass", async () => {
    const db = freshRoom();
    const unavailable = {
      ...db,
      prepare: () => {
        throw new Error("simulated: room database unavailable");
      },
    } as unknown as Database.Database;
    const extractText = vi.fn(() => "must not run");

    await runLegacyTextRepair({
      rooms: fakeRooms(() => ({ db: unavailable, path: ROOM })),
      roomEpoch: () => 0,
      extractText,
    });

    expect(extractText).not.toHaveBeenCalled();
    db.close();
  });

  it("does not report a repair when reading and writing a candidate both fail", async () => {
    const db = freshRoom();
    addFile(db, "legacy.doc", "application/msword", "stale text");
    const notify = vi.fn();

    await runLegacyTextRepair(
      repairDeps(db, {
        notifyFilesChanged: notify,
        extractText: () => {
          db.exec("DROP TABLE files");
          db.exec("DROP TABLE settings");
          return "recovered text";
        },
      }),
    );

    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it("ignores every extension except .doc/.ppt", async () => {
    const db = freshRoom();
    addFile(db, "notes.txt", "text/plain", "already fine");
    addFile(db, "sheet.xlsx", "application/vnd.ms-excel", "already fine");
    addFile(db, "modern.docx", "application/msword", "already fine");
    const extractText = vi.fn(() => "should never run");
    await runLegacyTextRepair(repairDeps(db, { extractText }));
    expect(extractText).not.toHaveBeenCalled();
    db.close();
  });

  it("unchanged text is never written, but the room is still stamped", async () => {
    const db = freshRoom();
    const id = addFile(db, "deck.ppt", "application/vnd.ms-powerpoint", "same text either way");
    setFileAiSummary(db, id, "kept because nothing changed");
    const notify = vi.fn();
    await runLegacyTextRepair(
      repairDeps(db, {
        extractText: () => "same text either way",
        notifyFilesChanged: notify,
      })
    );
    // `updateFileContent` nulls ai_summary as a side effect, so it still being
    // set is the proof the write never happened — "notify was not called"
    // alone cannot tell a skipped write from an uncounted one.
    expect(getFileMeta(db, id).aiSummary).toBe("kept because nothing changed");
    expect(notify).not.toHaveBeenCalled();
    expect(getSetting(db, RUST_REPAIR_STAMP)).toBe("1");
    db.close();
  });

  it("runs once per room — a second call does not re-extract", async () => {
    const db = freshRoom();
    addFile(db, "deck.ppt", "application/vnd.ms-powerpoint", "garbled font-table text");
    const extractText = vi.fn(() => "recovered text");
    await runLegacyTextRepair(repairDeps(db, { extractText }));
    expect(extractText).toHaveBeenCalledTimes(1);
    await runLegacyTextRepair(repairDeps(db, { extractText }));
    expect(extractText).toHaveBeenCalledTimes(1); // the stamp short-circuits it
    db.close();
  });

  it("an already-stamped room is skipped before any file is read", async () => {
    const db = freshRoom();
    setSetting(db, RUST_REPAIR_STAMP, "1");
    const id = addFile(db, "old.doc", "application/msword", "garbage");
    const extractText = vi.fn(() => "new text");
    await runLegacyTextRepair(repairDeps(db, { extractText }));
    expect(extractText).not.toHaveBeenCalled();
    expect(getFileExtractedText(db, id)).toBe("garbage");
    db.close();
  });

  it("a rollback (epoch bump) mid-pass drops the write AND the stamp", async () => {
    const db = freshRoom();
    const id = addFile(db, "deck.ppt", "application/vnd.ms-powerpoint", "garbled text");
    let roomEpoch = 0;
    await runLegacyTextRepair(
      repairDeps(db, {
        roomEpoch: () => roomEpoch,
        extractText: () => {
          roomEpoch += 1; // a rollback lands right after extraction
          return "recovered text";
        },
      })
    );
    expect(getFileExtractedText(db, id)).toBe("garbled text"); // untouched
    expect(getSetting(db, RUST_REPAIR_STAMP)).toBeNull(); // never stamped
    db.close();
  });

  it("a room/epoch change before the trailing stamp write leaves the room unstamped", async () => {
    // No .doc/.ppt candidates at all, so the loop body never runs — this
    // isolates the FINAL, post-loop room-pin re-check.
    const db = freshRoom();
    addFile(db, "notes.pdf", "application/pdf", "text");
    let epochCalls = 0;
    await runLegacyTextRepair(
      repairDeps(db, {
        roomEpoch: () => (epochCalls++ === 0 ? 1 : 2), // moves between the reads
        extractText: () => "unused",
      })
    );
    expect(getSetting(db, RUST_REPAIR_STAMP)).toBeNull();
    db.close();
  });

  it("THE STAMP HAZARD: a stubbed extractor still marks the room swept", async () => {
    // Pinned deliberately, because it is the port's most surprising honest
    // behavior and it is `backfill.rs`'s own: the stamp is written on every
    // completed run, repaired or not. Wiring `extractTextNotImplemented` (or
    // any extractor that cannot read .doc/.ppt) therefore burns the one-shot
    // sweep for every room it touches. The escape hatch the Rust comment names
    // is bumping REPAIR_STAMP.
    const db = freshRoom();
    const id = addFile(db, "old.doc", "application/msword", "font-table garbage");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runLegacyTextRepair(repairDeps(db, { extractText: extractTextNotImplemented }));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("NOT_IMPLEMENTED"));
    expect(getFileExtractedText(db, id)).toBe("font-table garbage"); // not repaired
    expect(getSetting(db, RUST_REPAIR_STAMP)).toBe("1"); // …and swept anyway
    db.close();
  });

  it("no room open resolves immediately and touches nothing", async () => {
    const extractText = vi.fn(() => "x");
    await expect(
      runLegacyTextRepair({
        rooms: fakeRooms(() => null),
        roomEpoch: () => 0,
        extractText,
      })
    ).resolves.toBeUndefined();
    expect(extractText).not.toHaveBeenCalled();
  });
});

describe("spawnLegacyTextRepair", () => {
  it("fire-and-forget: eventually stamps the room without the caller awaiting it", async () => {
    const db = freshRoom();
    spawnLegacyTextRepair({
      rooms: fakeRooms(() => ({ db, path: ROOM })),
      roomEpoch: () => 0,
      extractText: () => null,
    });
    await vi.waitFor(() => {
      expect(getSetting(db, RUST_REPAIR_STAMP)).toBe("1");
    });
    db.close();
  });

  it("a thrown error inside the pass is reported, not an unhandled rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    spawnLegacyTextRepair({
      rooms: {
        current() {
          throw new Error("boom");
        },
      },
      roomEpoch: () => 0,
      extractText: () => null,
    });
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith("legacy text repair failed:", expect.any(Error));
    });
  });
});
