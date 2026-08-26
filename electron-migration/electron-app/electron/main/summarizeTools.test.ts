/**
 * Tests for `summarizeTools.ts` — a port of
 * `src-tauri/src/commands/summarize.rs`'s `#[cfg(test)] mod tests`, PLUS wire
 * -level coverage for the two thin sidecar proxies (the `sidecarJsonCancellable.test.ts`
 * convention: `ensureUp` mocked to point at a real local `node:http` server)
 * and DB-level coverage for {@link writeRoomSummary} against a real fixture
 * room (the `workflowEngine.test.ts`/`filePass.test.ts` convention).
 *
 * NOT PORTED: `summarize_pages_past_first_window` — `#[ignore]`d in the Rust
 * source itself, needs a live tool-capable Ollama model. See
 * `summarizeTools.ts`'s own module doc.
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { createRoom } from "./db-host/open.js";
import { getFileMeta, insertFile, setFileAiSummary, trashFile } from "./db-host/files.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import { SIDECAR_DOWN } from "./sidecarJsonCancellable.js";
import {
  combineSummary,
  fileGlyph,
  isSummaryFile,
  MAX_SUMMARY_FILES,
  pinnedRoom,
  summarizeOneFile,
  SUMMARY_FILE_NAME,
  writeRoomSummary,
  type RoomSource,
  type SummaryRoom,
} from "./summarizeTools.js";

// ============================================================================
// fixtures
// ============================================================================

let tmpDirs: string[] = [];
let openDbs: Database.Database[] = [];

afterEach(() => {
  vi.mocked(ensureUp).mockReset();
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  openDbs = [];
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function freshRoomDb(name = "Test Room"): { db: Database.Database; path: string; name: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarize-tools-"));
  tmpDirs.push(dir);
  // A real, and — crucially for the room-swap test — UNIQUE path per call,
  // exactly what `pinnedRoom`'s `room.path === pin` check compares.
  const roomFile = path.join(dir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(roomFile, "correct horse battery staple", name);
  openDbs.push(db);
  return { db, path: roomFile, name };
}

class OneRoom implements RoomSource {
  constructor(private room: SummaryRoom | null) {}
  current(): SummaryRoom | null {
    return this.room;
  }
  swapTo(room: SummaryRoom | null): void {
    this.room = room;
  }
}

/** A tiny JSON server used for the two sidecar-wire tests. */
function jsonServer(handler: (body: unknown) => { status: number; body: unknown }): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: unknown[];
}> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const parsed = raw === "" ? null : JSON.parse(raw);
      requests.push(parsed);
      const { status, body } = handler(parsed);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
      });
    });
  });
}

// ============================================================================
// isSummaryFile
// ============================================================================

describe("isSummaryFile", () => {
  // Ported from `summary_file_excludes_only_the_generated_one`.
  it("excludes only the generated summary, by exact name+source", () => {
    expect(isSummaryFile("Room summary.html", "generated")).toBe(true);
    expect(isSummaryFile("Room summary.md", "generated")).toBe(true);
    // A user upload with the same name is NOT the canonical summary.
    expect(isSummaryFile("Room summary.html", "upload")).toBe(false);
    expect(isSummaryFile("Room summary.md", "upload")).toBe(false);
    expect(isSummaryFile("notes.md", "generated")).toBe(false);
  });
});

// ============================================================================
// pinnedRoom
// ============================================================================

describe("pinnedRoom", () => {
  // Ported from `pinned_room_rejects_a_swapped_or_closed_room`.
  it("rejects a swapped or closed room", () => {
    const room: SummaryRoom = { db: {} as Database.Database, path: "/tmp/a.roomai", name: "A" };
    const source = new OneRoom(room);

    // Unpinned and matching-pin lookups resolve the open room.
    expect(pinnedRoom(source, null)).toBe(room);
    expect(pinnedRoom(source, "/tmp/a.roomai")).toBe(room);

    // A pin for a DIFFERENT room (swapped mid-run) must error, never hand
    // back the room that is currently open.
    expect(() => pinnedRoom(source, "/tmp/b.roomai")).toThrow("the room this job belongs to was closed");

    // No room open: the pinned path keeps the job-style message; the
    // unpinned path says nothing is open.
    const empty = new OneRoom(null);
    expect(() => pinnedRoom(empty, null)).toThrow("No room is open.");
    expect(() => pinnedRoom(empty, "/tmp/a.roomai")).toThrow("the room this job belongs to was closed");
  });
});

// ============================================================================
// fileGlyph
// ============================================================================

describe("fileGlyph", () => {
  it("maps known extensions, case-insensitively", () => {
    expect(fileGlyph("report.PDF")).toBe("\u{1F4D5}");
    expect(fileGlyph("data.csv")).toBe("\u{1F4CA}");
    expect(fileGlyph("photo.JPG")).toBe("\u{1F5BC}\u{FE0F}");
    expect(fileGlyph("song.mp3")).toBe("\u{1F3A7}");
    expect(fileGlyph("clip.mov")).toBe("\u{1F3AC}");
    expect(fileGlyph("page.html")).toBe("\u{1F310}");
    expect(fileGlyph("notes.md")).toBe("\u{1F4DD}");
    expect(fileGlyph("config.yaml")).toBe("\u{1F5C2}\u{FE0F}");
    expect(fileGlyph("archive.zip")).toBe("\u{1F5DC}\u{FE0F}");
    expect(fileGlyph("letter.docx")).toBe("\u{1F4D8}");
    expect(fileGlyph("deck.pptx")).toBe("\u{1F4FD}\u{FE0F}");
  });

  it("falls back to a plain page glyph for anything unrecognized or extension-less", () => {
    expect(fileGlyph("README")).toBe("\u{1F4C4}");
    expect(fileGlyph("weird.xyz")).toBe("\u{1F4C4}");
  });
});

// ============================================================================
// summarizeOneFile (wire-level, /summarize_file)
// ============================================================================

describe("summarizeOneFile", () => {
  it("posts the six documented fields and reads back the summary", async () => {
    const server = await jsonServer(() => ({ status: 200, body: { summary: "A tidy one-liner." } }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      const out = await summarizeOneFile("qwen3.5:4b", "notes.txt", "text/plain", "hello world", "2m");
      expect(out).toBe("A tidy one-liner.");
      expect(server.requests).toEqual([
        {
          model: "qwen3.5:4b",
          name: "notes.txt",
          text: "hello world",
          mime: "text/plain",
          base_url: expect.any(String),
          keep_alive: "2m",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("a missing summary field reads as empty, not a throw", async () => {
    const server = await jsonServer(() => ({ status: 200, body: {} }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      expect(await summarizeOneFile("m", "n", "text/plain", "t", "1m")).toBe("");
    } finally {
      await server.close();
    }
  });

  it("a fatal engine failure throws the sentinel, tagged with the model", async () => {
    const server = await jsonServer(() => ({ status: 404, body: { code: "MODEL_MISSING", error: "not pulled" } }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      await expect(summarizeOneFile("qwen3.5:4b", "n", "text/plain", "t", "1m")).rejects.toThrow(
        "MODEL_MISSING:qwen3.5:4b"
      );
    } finally {
      await server.close();
    }
  });

  it("a dead sidecar surfaces as SIDECAR_DOWN, not a network error", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("no bundled binary"));
    await expect(summarizeOneFile("m", "n", "text/plain", "t", "1m")).rejects.toThrow(
      "Arcelle's AI helper could not start"
    );
    void SIDECAR_DOWN; // referenced for documentation purposes only
  });
});

// ============================================================================
// combineSummary (wire-level, /combine_summary)
// ============================================================================

describe("combineSummary", () => {
  it("posts model/room_name/file_lines/memories and reads back purpose+questions", async () => {
    const server = await jsonServer(() => ({
      status: 200,
      body: { purpose: "A room of receipts.", questions: ["What did I spend in July?"] },
    }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      const [purpose, questions] = await combineSummary(
        "qwen3.5:4b",
        "Finances",
        ["Prefers monthly totals"],
        "- a.pdf — a receipt\n"
      );
      expect(purpose).toBe("A room of receipts.");
      expect(questions).toEqual(["What did I spend in July?"]);
      expect(server.requests).toEqual([
        {
          model: "qwen3.5:4b",
          room_name: "Finances",
          file_lines: "- a.pdf — a receipt\n",
          memories: ["Prefers monthly totals"],
          base_url: expect.any(String),
          keep_alive: "30m",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("filters non-string entries out of questions and defaults missing fields", async () => {
    const server = await jsonServer(() => ({
      status: 200,
      body: { questions: [1, "a real question", null, "another"] },
    }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      const [purpose, questions] = await combineSummary("m", "R", [], "");
      expect(purpose).toBe("");
      expect(questions).toEqual(["a real question", "another"]);
    } finally {
      await server.close();
    }
  });

  it("a missing questions array reads as empty", async () => {
    const server = await jsonServer(() => ({ status: 200, body: { purpose: "P" } }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      const [, questions] = await combineSummary("m", "R", [], "");
      expect(questions).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a fatal engine failure throws the sentinel", async () => {
    const server = await jsonServer(() => ({ status: 503, body: { code: "OLLAMA_DOWN", error: "refused" } }));
    vi.mocked(ensureUp).mockResolvedValue(server.url);
    try {
      await expect(combineSummary("m", "R", [], "")).rejects.toThrow("OLLAMA_DOWN");
    } finally {
      await server.close();
    }
  });
});

// ============================================================================
// writeRoomSummary
// ============================================================================

describe("writeRoomSummary", () => {
  it("creates and versions the summary as a normal workspace file", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "summary-workspace-"));
    tmpDirs.push(parent);
    const root = path.join(parent, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Workspace");
    openDbs.push(db);
    const workspace = new WorkspaceService(db, root);
    const source = await workspace.createFile("notes.md", Readable.from(["facts"]), "upload");
    db.prepare("UPDATE files SET mime_type = 'text/markdown' WHERE id = ?").run(source.fileId);
    setFileAiSummary(db, source.fileId, "Useful facts.");
    const rooms = new OneRoom({ db, path: root, name: "Workspace", workspace });

    const first = await writeRoomSummary(rooms, "m", root, {
      combineSummary: async () => ["First summary.", []],
    });
    const second = await writeRoomSummary(rooms, "m", root, {
      combineSummary: async () => ["Second summary.", []],
    });

    expect(second.id).toBe(first.id);
    expect(readFileSync(path.join(root, SUMMARY_FILE_NAME), "utf8")).toContain("Second summary.");
    const row = db.prepare(
      "SELECT storage_kind, original_bytes FROM files WHERE id = ?",
    ).get(first.id) as { storage_kind: string; original_bytes: Buffer | null };
    expect(row).toEqual({ storage_kind: "workspace", original_bytes: null });
    expect((db.prepare("SELECT count(*) AS n FROM file_versions WHERE file_id = ?")
      .get(first.id) as { n: number }).n).toBe(1);
  });

  it("refuses an empty room", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    await expect(writeRoomSummary(rooms, "m", path)).rejects.toThrow(
      "This room has no files to summarize yet."
    );
  });

  it("throws 'No room is open.' when unpinned with nothing open", async () => {
    const rooms = new OneRoom(null);
    await expect(writeRoomSummary(rooms, "m", null)).rejects.toThrow("No room is open.");
  });

  it("builds the HTML page from cached one-liners and mime fallbacks, and creates a new file", async () => {
    const { db, path, name } = freshRoomDb("Recipes");
    const rooms = new OneRoom({ db, path, name });
    const summarized = insertFile(db, "pasta.md", "text/markdown", Buffer.from("x"), "x", "upload");
    setFileAiSummary(db, summarized.id, "A carbonara recipe.");
    insertFile(db, "photo.jpg", "image/jpeg", Buffer.from("y"), null, "upload");

    let capturedRoomName: string | null = null;
    let capturedFileLines: string | null = null;
    const combine = vi.fn(async (_model: string, roomName: string, _memories: readonly string[], fileLines: string) => {
      capturedRoomName = roomName;
      capturedFileLines = fileLines;
      return ["A room of recipes.", ["What's for dinner?"]] as [string, string[]];
    });

    const emitted: Array<[string, unknown]> = [];
    const meta = await writeRoomSummary(rooms, "qwen3.5:4b", path, {
      combineSummary: combine,
      emit: (event, payload) => emitted.push([event, payload]),
    });

    expect(meta.name).toBe(SUMMARY_FILE_NAME);
    expect(meta.mimeType).toBe("text/html");
    expect(capturedRoomName).toBe("Recipes");
    expect(capturedFileLines).toContain("- pasta.md — A carbonara recipe.\n");
    expect(capturedFileLines).toContain("- photo.jpg (image/jpeg)\n");

    const stored = getFileMeta(db, meta.id);
    const html = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(stored.id) as {
      extracted_text: string;
    };
    expect(html.extracted_text).toContain("<title>Recipes — Room summary</title>");
    expect(html.extracted_text).toContain("Generated on");
    expect(html.extracted_text).toContain("A room of recipes.");
    expect(html.extracted_text).toContain("A carbonara recipe.");
    expect(html.extracted_text).toContain('<span class="count">2</span>');
    expect(html.extracted_text).toContain("What's for dinner?");
    expect(html.extracted_text).not.toContain("Only the first");

    expect(emitted).toEqual([["room-files-changed", undefined]]);
  });

  it("an empty purpose falls back to the default sentence, and no questions omits the section", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");

    const meta = await writeRoomSummary(rooms, "m", path, {
      combineSummary: async () => ["", []],
    });
    const row = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(meta.id) as {
      extracted_text: string;
    };
    expect(row.extracted_text).toContain("A personal document room.");
    expect(row.extracted_text).not.toContain("Try asking");
  });

  it("overwrites the existing summary file in place rather than creating a second one", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");

    const first = await writeRoomSummary(rooms, "m", path, { combineSummary: async () => ["First pass.", []] });
    const second = await writeRoomSummary(rooms, "m", path, { combineSummary: async () => ["Second pass.", []] });

    expect(second.id).toBe(first.id);
    const rows = db.prepare("SELECT id FROM files WHERE name = ?").all(SUMMARY_FILE_NAME) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    const row = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(second.id) as {
      extracted_text: string;
    };
    expect(row.extracted_text).toContain("Second pass.");
    expect(row.extracted_text).not.toContain("First pass.");
  });

  it("trashes the legacy Markdown summary, labelled app/summarize_room", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");
    const legacy = insertFile(db, "Room summary.md", "text/markdown", Buffer.from("old"), "old", "generated");

    await writeRoomSummary(rooms, "m", path, { combineSummary: async () => ["P", []] });

    const row = db
      .prepare("SELECT trashed_at, trashed_by, trashed_by_id FROM files WHERE id = ?")
      .get(legacy.id) as { trashed_at: string | null; trashed_by: string | null; trashed_by_id: string | null };
    expect(row.trashed_at).not.toBeNull();
    expect(row.trashed_by).toBe("app");
    expect(row.trashed_by_id).toBe("summarize_room");
  });

  it("caps the reduce context and the per-file summary work at MAX_SUMMARY_FILES, listing the rest by name only", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    const total = MAX_SUMMARY_FILES + 1;
    for (let i = 0; i < total; i++) {
      insertFile(db, `f${String(i).padStart(3, "0")}.txt`, "text/plain", Buffer.from("x"), "x", "upload");
    }

    let capturedFileLines = "";
    const meta = await writeRoomSummary(rooms, "m", path, {
      combineSummary: async (_m, _r, _mem, fileLines) => {
        capturedFileLines = fileLines;
        return ["P", []];
      },
    });

    // Only the first MAX_SUMMARY_FILES files are handed to the reduce step.
    const linesGiven = capturedFileLines.split("\n").filter((l) => l !== "").length;
    expect(linesGiven).toBe(MAX_SUMMARY_FILES);
    expect(capturedFileLines).not.toContain(`f${String(total - 1).padStart(3, "0")}.txt`);

    const row = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(meta.id) as {
      extracted_text: string;
    };
    // But the file list in the finished page names every file, count included.
    expect(row.extracted_text).toContain(`<span class="count">${total}</span>`);
    expect(row.extracted_text).toContain(`f${String(total - 1).padStart(3, "0")}.txt`);
    expect(row.extracted_text).toContain(
      `Only the first ${MAX_SUMMARY_FILES} files were summarized; the rest are listed by name.`
    );
  });

  it("a summary deleted mid-reduce is not silently resurrected — a fresh file is created instead", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");
    const existing = insertFile(db, SUMMARY_FILE_NAME, "text/html", Buffer.from("<p>old</p>"), "old", "generated");

    const meta = await writeRoomSummary(rooms, "m", path, {
      combineSummary: async () => {
        // The user deletes the summary from the Library WHILE the reduce is
        // in flight — exactly the race `write_room_summary`'s own re-check
        // exists for.
        trashFile(db, existing.id, { kind: "user" });
        return ["New purpose.", []];
      },
    });

    expect(meta.id).not.toBe(existing.id);
    const rows = db.prepare("SELECT id FROM files WHERE name = ? AND trashed_at IS NULL").all(
      SUMMARY_FILE_NAME
    ) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(meta.id);
  });

  it("escapes every model- and room-controlled string it puts in the page", async () => {
    // ADVERSARIAL ADDITION (verification pass): the Rust source escapes FIVE
    // separate untrusted strings on the way into this page ("Everything is
    // escaped" — the file name/display path, the cached one-liner, the
    // model's purpose paragraph, each suggested question, and the room name
    // in the <title>), and NOTHING in this suite asserted any of it. The page
    // is rendered in the viewer, so a dropped `html_escape` is a real
    // injection into a document assembled from model output and from names a
    // model can choose. Every existing assertion here uses `toContain` on
    // plain text, which passes just as happily on an unescaped page.
    const { db, path, name } = freshRoomDb("R&D <team>");
    const rooms = new OneRoom({ db, path, name });
    const nasty = insertFile(
      db,
      '<img src=x onerror="alert(1)">.txt',
      "text/plain",
      Buffer.from("x"),
      "x",
      "upload"
    );
    setFileAiSummary(db, nasty.id, '</div><script>steal("liner")</script>');

    const meta = await writeRoomSummary(rooms, "m", path, {
      combineSummary: async () => [
        '<script>steal("purpose")</script>',
        ['<b>What about "quotes" & <angles>?</b>'],
      ],
    });
    const { extracted_text: html } = db
      .prepare("SELECT extracted_text FROM files WHERE id = ?")
      .get(meta.id) as { extracted_text: string };

    // Not one of the five reaches the page as live markup...
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>What about");
    expect(html).not.toContain("<team>");
    // ...and each one is present in its escaped spelling, so the page still
    // SAYS what it is supposed to say rather than dropping it.
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;.txt");
    expect(html).toContain("&lt;/div&gt;&lt;script&gt;steal(&quot;liner&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;steal(&quot;purpose&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;What about &quot;quotes&quot; &amp; &lt;angles&gt;?&lt;/b&gt;");
    expect(html).toContain("<title>R&amp;D &lt;team&gt; — Room summary</title>");
  });

  it("a whitespace-only cached one-liner is treated as absent, not printed as a blank description", async () => {
    // ADVERSARIAL ADDITION (verification pass): Rust reads the cached liner as
    // `f.ai_summary.as_deref().map(str::trim).filter(|s| !s.is_empty())` — the
    // TRIM happens before the emptiness test, so a one-liner the model
    // returned as whitespace falls back to the deterministic
    // "- name (mime)" line and to a file row with no description at all. A
    // port that tested `aiSummary !== null` alone would print an empty
    // `<div class="ds"></div>` and hand the reduce step a dangling
    // "- name — " line.
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    const blank = insertFile(db, "blank.txt", "text/plain", Buffer.from("x"), "x", "upload");
    setFileAiSummary(db, blank.id, "   \n\t ");

    let captured = "";
    const meta = await writeRoomSummary(rooms, "m", path, {
      combineSummary: async (_m, _r, _mem, fileLines) => {
        captured = fileLines;
        return ["P", []];
      },
    });
    expect(captured).toBe("- blank.txt (text/plain)\n");
    expect(captured).not.toContain("blank.txt — ");

    const { extracted_text: html } = db
      .prepare("SELECT extracted_text FROM files WHERE id = ?")
      .get(meta.id) as { extracted_text: string };
    expect(html).not.toContain('<div class="ds">');
  });

  it("a room swapped out from under a pinned run is refused, and nothing is written", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");

    const other = freshRoomDb("Other room");
    const otherRoom: SummaryRoom = { db: other.db, path: other.path, name: other.name };

    await expect(
      writeRoomSummary(rooms, "m", path, {
        combineSummary: async () => {
          rooms.swapTo(otherRoom);
          return ["P", []];
        },
      })
    ).rejects.toThrow("the room this job belongs to was closed");

    const rows = db.prepare("SELECT id FROM files WHERE name = ?").all(SUMMARY_FILE_NAME) as unknown[];
    expect(rows).toHaveLength(0);
    const otherRows = other.db.prepare("SELECT id FROM files WHERE name = ?").all(SUMMARY_FILE_NAME) as unknown[];
    expect(otherRows).toHaveLength(0);
  });

  it("propagates the reduce call's own sentinel error unwrapped", async () => {
    const { db, path, name } = freshRoomDb();
    const rooms = new OneRoom({ db, path, name });
    insertFile(db, "a.txt", "text/plain", Buffer.from("x"), "x", "upload");

    await expect(
      writeRoomSummary(rooms, "m", path, {
        combineSummary: async () => {
          throw new Error("OLLAMA_DOWN");
        },
      })
    ).rejects.toThrow("OLLAMA_DOWN");
  });
});
