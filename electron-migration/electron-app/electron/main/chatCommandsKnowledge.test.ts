/**
 * Vitest port of `src-tauri/src/commands/chat_commands/knowledge.rs`'s
 * `#[cfg(test)] mod tests`:
 *
 *   - tabular_field_rows_reads_matching_columns_per_row
 *   - tabular_field_rows_bails_when_a_field_is_not_a_column
 *   - tabular_field_rows_only_for_tabular_extensions
 *   - trailing_preposition_only_strips_a_whole_word
 *   - the_fan_out_is_capped_and_says_what_it_left_out
 *   - find_prints_a_bounded_list_and_admits_what_it_left_out
 *   - tabular_field_rows_handles_tsv_and_quoted_commas
 *
 * plus the slice of `chat_commands.rs`'s own `#[cfg(test)] mod tests` that
 * covers the shared scaffolding this file also ports:
 *
 *   - short_source_is_a_single_window / long_source_is_covered_end_to_end /
 *     windows_stay_within_one_pass (`full_ops_tests`, for {@link cmdWindows})
 *   - a_quiet_step_never_carries_the_models_reasoning (`quiet_step_tests`,
 *     for {@link quietStepText})
 *
 * plus NEW integration coverage (no Rust equivalent — `chat_commands.rs` has
 * no test for `ask_quiet`/`map_windows`/`fold_notes`/`digest`, and the Rust
 * suite's `CmdCtx` closes over a real `AppState`/`tauri::Window` this port
 * does not have) for {@link askQuiet}/{@link digest} and for each of the five
 * `cmd*` functions, against a REAL fixture room (`createRoom`, this
 * directory's established convention).
 *
 * SIDECAR CALLS (`#add-file`'s `/knowledge_extract` + `/generate_doc`,
 * `#extract`'s non-tabular `/knowledge_extract`) are exercised against a REAL
 * local `node:http` server with only `./sidecar.js`'s `ensureUp` mocked to
 * point at it — the same convention `storyTools.test.ts`/
 * `sidecarJsonCancellable.test.ts` already establish. `#highlight`'s model
 * call goes through {@link CmdCtx.generate} instead (its own injectable test
 * seam), which needs no network at all.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { addMemory, listMemories } from "./db-host/memories.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { TurnId, type EventSender } from "./turn.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import type { GenerateOpts } from "./ollamaGenerate.js";
import type { SidecarChatMessage } from "./sidecar.js";
import {
  askQuiet,
  capFanOut,
  CMD_WINDOW_CHARS,
  cmdAddFile,
  cmdExtract,
  cmdFind,
  cmdHighlight,
  cmdRemember,
  cmdWindows,
  COMMAND_STEP_TIMEOUT_MS,
  digest,
  findBody,
  MAX_FAN_OUT_FILES,
  MAX_FIND_MATCHES,
  quietStepText,
  stripTrailingPreposition,
  tabularFieldRows,
  type CmdCtx,
  type EmitFn,
} from "./chatCommandsKnowledge.js";
import type { ScoredChunk } from "./db-host/retrieval.js";

// ------------------------------------------------------------- fixtures

let tmpDir: string | null = null;
let openDb: Database.Database | null = null;

afterEach(() => {
  vi.mocked(ensureUp).mockReset();
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

class TestRoomSource implements RoomSource {
  private room: RoomHandle | null = null;
  open(db: Database.Database, roomPath: string): void {
    this.room = { db, path: roomPath };
  }
  close(): void {
    this.room = null;
  }
  current(): RoomHandle | null {
    return this.room;
  }
}

function freshRoom(): { rooms: TestRoomSource; db: Database.Database } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-commands-knowledge-"));
  const roomFile = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(roomFile, "correct horse battery staple", "Test Room");
  openDb = db;
  const rooms = new TestRoomSource();
  rooms.open(db, roomFile);
  return { rooms, db };
}

/** A base {@link CmdCtx} a test only needs to override a few fields of. */
function baseCtx(rooms: RoomSource, overrides: Partial<CmdCtx> = {}): CmdCtx {
  return {
    rooms,
    send: (() => {}) as EventSender,
    turn: new TurnId("run-1", "chat-1"),
    model: "qwen3.5:4b",
    refs: [],
    args: "",
    history: "",
    cancel: new CancelFlag(),
    unread: { count: 0 },
    ...overrides,
  };
}

/** Collects the raw (non-turn-enveloped) events {@link CmdCtx.emit} fires. */
function collectingEmit(): { emit: EmitFn; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  return { emit: (event, payload) => events.push([event, payload]), events };
}

async function withFakeSidecar<T>(
  handler: (body: unknown, req: http.IncomingMessage) => unknown,
  fn: () => Promise<T>
): Promise<T> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body: unknown = raw === "" ? null : JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(body, req)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ============================================================================
// pure helpers ported from chat_commands.rs / knowledge.rs
// ============================================================================

describe("cmdWindows", () => {
  it("short_source_is_a_single_window", () => {
    const text = "a short meeting transcript";
    expect(cmdWindows(text)).toEqual([text]);
    expect(cmdWindows("   ")).toEqual([]);
  });

  it("long_source_is_covered_end_to_end", () => {
    let body = "";
    for (let i = 0; i < 4000; i++) {
      body += `[00:${String(i % 60).padStart(2, "0")}] speaker ${i}: line number ${i}\n`;
    }
    const text = `${body}FINAL LINE: the meeting ended.`;
    const windows = cmdWindows(text);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[windows.length - 1]).toContain("FINAL LINE");
    const joined = windows.join("");
    for (const probe of ["line number 0", "line number 1999", "line number 3999"]) {
      expect(joined).toContain(probe);
    }
  });

  it("windows_stay_within_one_pass", () => {
    const text = "sentence. ".repeat(20_000);
    for (const w of cmdWindows(text)) {
      expect(Buffer.byteLength(w, "utf8")).toBeLessThanOrEqual(CMD_WINDOW_CHARS + 400);
    }
  });
});

describe("quietStepText", () => {
  it("a_quiet_step_never_carries_the_models_reasoning", () => {
    expect(
      quietStepText("<think>The user wants French. Careful with the idiom.</think>\nBonjour le monde.")
    ).toBe("Bonjour le monde.");
    expect(quietStepText("<think>still thinking about it")).toBe("");
    expect(quietStepText("  Plain answer.  ")).toBe("Plain answer.");
  });
});

function s(v: readonly string[]): string[] {
  return [...v];
}

describe("tabularFieldRows", () => {
  it("tabular_field_rows_reads_matching_columns_per_row", () => {
    const csv =
      "product,category,units_sold,unit_price,revenue\n" +
      "Widget A,Gadgets,120,19.99,2398.80\n" +
      "Widget B,Gadgets,80,29.99,2399.20\n";
    const rows = tabularFieldRows("sales.csv", csv, s(["Product", "revenue"]));
    expect(rows).toEqual([s(["Widget A", "2398.80"]), s(["Widget B", "2399.20"])]);
  });

  it("tabular_field_rows_bails_when_a_field_is_not_a_column", () => {
    const csv = "product,revenue\nWidget A,2398.80\n";
    expect(tabularFieldRows("sales.csv", csv, s(["product", "total profit"]))).toBeNull();
  });

  it("tabular_field_rows_only_for_tabular_extensions", () => {
    const csv = "product,revenue\nWidget A,2398.80\n";
    expect(tabularFieldRows("notes.md", csv, s(["product", "revenue"]))).toBeNull();
  });

  it("tabular_field_rows_handles_tsv_and_quoted_commas", () => {
    const tsv = 'name\tnote\nAcme\t"a, b, c"\n';
    const rows = tabularFieldRows("data.tsv", tsv, s(["note", "name"]));
    expect(rows).toEqual([s(["a, b, c", "Acme"])]);
  });
});

describe("stripTrailingPreposition", () => {
  it("trailing_preposition_only_strips_a_whole_word", () => {
    expect(stripTrailingPreposition("revenue, CEO from")).toBe("revenue, CEO");
    expect(stripTrailingPreposition("revenue in ")).toBe("revenue");
    expect(stripTrailingPreposition("share of")).toBe("share");
    expect(stripTrailingPreposition("gross margin")).toBe("gross margin");
    expect(stripTrailingPreposition("country of origin")).toBe("country of origin");
    expect(stripTrailingPreposition("burden of proof")).toBe("burden of proof");
    expect(stripTrailingPreposition("from")).toBe("");
  });
});

describe("capFanOut", () => {
  it("the_fan_out_is_capped_and_says_what_it_left_out", () => {
    const small = Array.from({ length: 3 }, (_, i) => `item ${i}`);
    const [kept, over] = capFanOut(small);
    expect(kept).toEqual(small);
    expect(over).toBe(0);

    const long = Array.from({ length: 90 }, (_, i) => `item ${i}`);
    const [keptLong, overLong] = capFanOut(long);
    expect(keptLong).toHaveLength(MAX_FAN_OUT_FILES);
    expect(overLong).toBe(90 - MAX_FAN_OUT_FILES);
    expect(keptLong[0]).toBe("item 0");

    const exact = Array.from({ length: MAX_FAN_OUT_FILES }, (_, i) => `i${i}`);
    expect(capFanOut(exact)[1]).toBe(0);
  });
});

function chunks(n: number): ScoredChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    rowid: i,
    fileName: `book${i % 3}.txt`,
    text: `the deposit clause, paragraph ${i}`,
    score: 1,
  }));
}

describe("findBody", () => {
  it("find_prints_a_bounded_list_and_admits_what_it_left_out", () => {
    const body = findBody("deposit", chunks(200));
    expect(body.startsWith("Matches for **deposit** (200):")).toBe(true);
    expect(body.split("\n").filter((l) => l.startsWith("- **")).length).toBe(MAX_FIND_MATCHES);
    expect(body).toContain(`…and ${200 - MAX_FIND_MATCHES} more`);

    const small = findBody("deposit", chunks(3));
    expect(small.split("\n").filter((l) => l.startsWith("- **")).length).toBe(3);
    expect(small).not.toContain("more");

    const exact = findBody("deposit", chunks(MAX_FIND_MATCHES));
    expect(exact).not.toContain("…and");
  });
});

// ============================================================================
// askQuiet / digest — new coverage for the shared scaffolding
// ============================================================================

type FakeGenerate = (
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null,
  keepAlive: string,
  opts?: GenerateOpts
) => Promise<string>;

describe("askQuiet", () => {
  it("strips a thinking model's preamble from the returned text", async () => {
    const rooms = new TestRoomSource();
    const fake: FakeGenerate = async () => "<think>reasoning</think>Bonjour.";
    const ctx = baseCtx(rooms, { generate: fake as never });
    await expect(askQuiet(ctx, "sys", "user", 0.0)).resolves.toBe("Bonjour.");
  });

  it("times out with an actionable message rather than hanging forever", async () => {
    const rooms = new TestRoomSource();
    const fake: FakeGenerate = () => new Promise(() => {}); // never resolves
    const ctx = baseCtx(rooms, { generate: fake as never, stepTimeoutMs: 20 });
    await expect(askQuiet(ctx, "sys", "user", 0.0)).rejects.toThrow(/took too long to respond/);
  });

  it("propagates a genuine engine failure rather than swallowing it", async () => {
    const rooms = new TestRoomSource();
    const fake: FakeGenerate = async () => {
      throw new Error("MODEL_MISSING:qwen3.5:4b");
    };
    const ctx = baseCtx(rooms, { generate: fake as never });
    await expect(askQuiet(ctx, "sys", "user", 0.0)).rejects.toThrow("MODEL_MISSING:qwen3.5:4b");
  });
});

describe("digest", () => {
  it("a short source is returned unchanged, with no model call at all", async () => {
    const rooms = new TestRoomSource();
    let calls = 0;
    const fake: FakeGenerate = async () => {
      calls += 1;
      return "note";
    };
    const ctx = baseCtx(rooms, { generate: fake as never });
    const text = "a short pinned file";
    await expect(digest(ctx, text, "Reading")).resolves.toBe(text);
    expect(calls).toBe(0);
  });

  it("a long source is windowed, noted and folded — never truncated away", async () => {
    const rooms = new TestRoomSource();
    let calls = 0;
    const fake: FakeGenerate = async (_m, messages) => {
      calls += 1;
      // One short note per window/fold call — small enough that folding
      // converges instead of looping FOLD_MAX_ROUNDS times.
      const user = messages[1]?.content ?? "";
      return `note-${calls}-len${user.length}`;
    };
    const ctx = baseCtx(rooms, { generate: fake as never });
    const big = "word ".repeat(5000); // well over CMD_WINDOW_CHARS (16000) bytes
    const out = await digest(ctx, big, "Reading the source");
    expect(calls).toBeGreaterThan(1); // more than one window was read
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CMD_WINDOW_CHARS);
  });

  it("a window whose model call fails is counted as unread, not silently dropped", async () => {
    const rooms = new TestRoomSource();
    let calls = 0;
    const fake: FakeGenerate = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("MODEL_MISSING:qwen3.5:4b");
      }
      return "a real note";
    };
    const ctx = baseCtx(rooms, { generate: fake as never });
    const big = "word ".repeat(5000);
    await digest(ctx, big, "Reading");
    expect(ctx.unread.count).toBeGreaterThan(0);
  });

  it("a fold round that fails to shrink stops the pass rather than looping FOLD_MAX_ROUNDS times", async () => {
    // The private foldNotes's own guard: every round has already seen the
    // whole source, so a round that comes back no smaller than it went in
    // must stop (giving up honestly) rather than spin for all 6 rounds —
    // real notes never regenerate identically, but a pathological model
    // reply (or a summarizer that just echoes its input back) must not hang
    // the command. Each call ECHOES the window it was given, minus its
    // "Part of the source:\n"/"Notes:\n" prefix, so nothing ever shrinks.
    const rooms = new TestRoomSource();
    let calls = 0;
    const fake: FakeGenerate = async (_m, messages) => {
      calls += 1;
      const user = messages[1]?.content ?? "";
      return user.replace(/^(Part of the source:\n|Notes:\n)/, "");
    };
    const ctx = baseCtx(rooms, { generate: fake as never });
    const big = "y".repeat(CMD_WINDOW_CHARS + 500);
    const out = await digest(ctx, big, "Reading");
    // Gave up rather than fabricating a shrunk result: still over budget.
    expect(Buffer.byteLength(out, "utf8")).toBeGreaterThan(CMD_WINDOW_CHARS);
    // Bounded well below what even ONE further non-shrinking round would
    // add (2 more windows), let alone all 6 — the initial map plus exactly
    // one fold round that then stops.
    expect(calls).toBeLessThan(6);
  });
});

// ============================================================================
// #remember
// ============================================================================

describe("cmdRemember", () => {
  it("Usage error on empty args", async () => {
    const { rooms } = freshRoom();
    await expect(cmdRemember(baseCtx(rooms, { args: "  " }))).rejects.toThrow("Usage: #remember");
  });

  it("saves a new fact verbatim, with no length cap (unlike the UI/tool path)", async () => {
    const { rooms, db } = freshRoom();
    const longFact = "x".repeat(5000); // well past the UI/tool MAX_MEMORY_CONTENT_CHARS cap
    const result = await cmdRemember(baseCtx(rooms, { args: longFact }));
    expect(result.content).toContain("Saved to memory:");
    expect(result.content).toContain(longFact);
    const saved = listMemories(db);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe(longFact);
    expect(saved[0]?.category).toBeNull();
  });

  it("an exact duplicate is reported, not saved a second time", async () => {
    const { rooms, db } = freshRoom();
    addMemory(db, "The lease renews every March.", null);
    const result = await cmdRemember(baseCtx(rooms, { args: "The lease renews every March." }));
    expect(result.content).toBe("That's already in this room's memory.");
    expect(listMemories(db)).toHaveLength(1);
  });
});

// ============================================================================
// #find
// ============================================================================

describe("cmdFind", () => {
  it("Usage error on empty args", async () => {
    const { rooms } = freshRoom();
    await expect(cmdFind(baseCtx(rooms, { args: " " }))).rejects.toThrow("Usage: #find");
  });

  it("reports no matches for a term nothing in the room contains", async () => {
    const { rooms, db } = freshRoom();
    vi.mocked(ensureUp).mockRejectedValue(new Error("no sidecar in this test"));
    insertFile(db, "lease.txt", "text/plain", Buffer.from("the tenant pays rent"), "the tenant pays rent", "upload");
    const result = await cmdFind(baseCtx(rooms, { args: "zzz-nonexistent-term" }));
    expect(result.content).toBe("No matches found for **zzz-nonexistent-term**.");
    expect(result.sources).toEqual([]);
  });

  it("lists real matches with a snippet, and names each matching file once as a source", async () => {
    const { rooms, db } = freshRoom();
    vi.mocked(ensureUp).mockRejectedValue(new Error("no sidecar in this test"));
    insertFile(
      db,
      "lease.txt",
      "text/plain",
      Buffer.from("the deposit clause says the deposit is refundable"),
      "the deposit clause says the deposit is refundable",
      "upload"
    );
    const result = await cmdFind(baseCtx(rooms, { args: "deposit" }));
    expect(result.content).toContain("Matches for **deposit**");
    expect(result.content).toContain("lease.txt");
    expect(result.sources).toEqual(["lease.txt"]);
  });
});

// ============================================================================
// #add-file
// ============================================================================

describe("cmdAddFile", () => {
  it("Usage error on empty args", async () => {
    const { rooms } = freshRoom();
    await expect(cmdAddFile(baseCtx(rooms, { args: "  " }))).rejects.toThrow("Usage: #add-file");
  });

  it("single file: defaults to an HTML name derived from the topic, and opens it", async () => {
    const { rooms, db } = freshRoom();
    const { emit, events } = collectingEmit();
    await withFakeSidecar(
      (body) => {
        expect((body as { mode: string }).mode).toBe("single");
        expect((body as { topic: string }).topic).toBe("Q3 revenue plan");
        return { text: "<p>Revenue is up.</p>" };
      },
      async () => {
        const result = await cmdAddFile(baseCtx(rooms, { args: "Q3 revenue plan", emit }));
        expect(result.content).toContain("Created **Q3 revenue plan.html** and opened it.");
        expect(result.sources).toEqual(["Q3 revenue plan.html"]);
      }
    );
    const names = db
      .prepare("SELECT name FROM files WHERE trashed_at IS NULL")
      .all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(["Q3 revenue plan.html"]);
    expect(events.some(([e]) => e === "room-files-changed")).toBe(true);
    expect(events.some(([e]) => e === "agent-open-file")).toBe(true);
  });

  it("single file: an explicit 'name: topic' keeps a given extension, or gets .html appended", async () => {
    const { rooms } = freshRoom();
    await withFakeSidecar(
      () => ({ text: "<p>body</p>" }),
      async () => {
        const result = await cmdAddFile(baseCtx(rooms, { args: "notes.md: the kickoff meeting" }));
        expect(result.sources).toEqual(["notes.md"]);
      }
    );
  });

  it("single file: an empty model reply is refused rather than saved as a blank file", async () => {
    const { rooms } = freshRoom();
    await withFakeSidecar(
      () => ({ text: "   " }),
      async () => {
        await expect(cmdAddFile(baseCtx(rooms, { args: "Empty topic" }))).rejects.toThrow(
          "The model returned nothing"
        );
      }
    );
  });

  it("single file: a genuine engine failure propagates as a sentinel error", async () => {
    const { rooms } = freshRoom();
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "MODEL_MISSING", error: "not pulled" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      await expect(cmdAddFile(baseCtx(rooms, { args: "Some topic" }))).rejects.toThrow(
        "MODEL_MISSING:qwen3.5:4b"
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("for each: enumerates, generates one file per item, and reports every one created", async () => {
    const { rooms, db } = freshRoom();
    await withFakeSidecar(
      (body) => {
        const mode = (body as { mode: string }).mode;
        if (mode === "list") {
          return { items: ["AAPL", "MSFT"] };
        }
        const item = (body as { item: string }).item;
        return { text: `<p>Report for ${item}</p>` };
      },
      async () => {
        const result = await cmdAddFile(baseCtx(rooms, { args: "#add-file for each: stocks in the chat" }));
        expect(result.content).toContain("Created 2 file(s)");
        expect(result.sources).toEqual(["AAPL.html", "MSFT.html"]);
      }
    );
    const rows = db.prepare("SELECT name FROM files WHERE trashed_at IS NULL").all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual(["AAPL.html", "MSFT.html"]);
  });

  it("for each: an item whose generation comes back empty is skipped, not fatal to the rest", async () => {
    const { rooms } = freshRoom();
    await withFakeSidecar(
      (body) => {
        const mode = (body as { mode: string }).mode;
        if (mode === "list") {
          return { items: ["Alpha", "Beta"] };
        }
        const item = (body as { item: string }).item;
        return { text: item === "Alpha" ? "" : "<p>Beta's report</p>" };
      },
      async () => {
        const result = await cmdAddFile(baseCtx(rooms, { args: "for each thing" }));
        expect(result.sources).toEqual(["Beta.html"]);
      }
    );
  });

  it("for each: no list found in the conversation is a clear refusal, not a fabricated file", async () => {
    const { rooms } = freshRoom();
    await withFakeSidecar(
      () => ({ items: [] }),
      async () => {
        await expect(cmdAddFile(baseCtx(rooms, { args: "for each thing" }))).rejects.toThrow(
          "Couldn't find a list to iterate over"
        );
      }
    );
  });
});

// ============================================================================
// #highlight
// ============================================================================

describe("cmdHighlight", () => {
  it("refuses without an @file", async () => {
    const { rooms } = freshRoom();
    await expect(cmdHighlight(baseCtx(rooms, { args: "the total" }))).rejects.toThrow("Add a file with @");
  });

  it("refuses when nothing to highlight was said", async () => {
    const { rooms, db } = freshRoom();
    const file = insertFile(db, "invoice.pdf", "application/pdf", Buffer.from("x"), "the total is $500", "upload");
    await expect(cmdHighlight(baseCtx(rooms, { args: "   ", refs: [file.id] }))).rejects.toThrow(
      "Say what to highlight"
    );
  });

  it("the trailing 'in'/'on' the UI leaves behind is stripped, REPEATEDLY, as a whole word", async () => {
    const { rooms, db } = freshRoom();
    const text = "Invoice #4021. The total due is $532.10.";
    const file = insertFile(db, "invoice.pdf", "application/pdf", Buffer.from(text), text, "upload");
    const fake: FakeGenerate = async (_m, messages) => {
      // Whatever the model was asked confirms "in in" collapsed to "the total".
      expect(messages[1]?.content).toContain("Request: the total\n");
      return '"The total due is $532.10"';
    };
    const result = await cmdHighlight(
      baseCtx(rooms, { args: "the total in in", refs: [file.id], generate: fake as never })
    );
    expect(result.content).toContain("Highlighted");
  });

  it("refuses when the file has no readable text", async () => {
    const { rooms, db } = freshRoom();
    const file = insertFile(db, "scan.pdf", "application/pdf", Buffer.from("x"), null, "upload");
    await expect(
      cmdHighlight(baseCtx(rooms, { args: "the total", refs: [file.id] }))
    ).rejects.toThrow("no readable text to highlight");
  });

  it("finds and annotates an exact quote the model returns", async () => {
    const { rooms, db } = freshRoom();
    const text = "Invoice #4021. The total due is $532.10, payable on receipt.";
    const file = insertFile(db, "invoice.pdf", "application/pdf", Buffer.from(text), text, "upload");
    const { emit, events } = collectingEmit();
    const fake: FakeGenerate = async () => '"The total due is $532.10"';
    const result = await cmdHighlight(
      baseCtx(rooms, { args: "the total", refs: [file.id], generate: fake as never, emit })
    );
    expect(result.content).toContain('Highlighted "The total due is $532.10" in **invoice.pdf**.');
    expect(result.effects.annotation).not.toBeNull();
    expect(events.some(([e]) => e === "agent-annotate")).toBe(true);
  });

  it("a passage the file never contains is refused, not fabricated", async () => {
    const { rooms, db } = freshRoom();
    const text = "Invoice #4021. The total due is $532.10.";
    const file = insertFile(db, "invoice.pdf", "application/pdf", Buffer.from(text), text, "upload");
    const fake: FakeGenerate = async () => ""; // the model finds nothing
    await expect(
      cmdHighlight(baseCtx(rooms, { args: "the signature", refs: [file.id], generate: fake as never }))
    ).rejects.toThrow("Couldn't find an exact passage");
  });
});

// ============================================================================
// #extract
// ============================================================================

describe("cmdExtract", () => {
  it("refuses without any @files", async () => {
    const { rooms } = freshRoom();
    await expect(cmdExtract(baseCtx(rooms, { args: "revenue, CEO" }))).rejects.toThrow("Add files with @");
  });

  it("refuses without any fields", async () => {
    const { rooms, db } = freshRoom();
    const file = insertFile(db, "a.pdf", "application/pdf", Buffer.from("x"), "x", "upload");
    await expect(cmdExtract(baseCtx(rooms, { args: "  ", refs: [file.id] }))).rejects.toThrow(
      "Say which fields to extract"
    );
  });

  it("reads a matching CSV directly, with no model call at all", async () => {
    const { rooms, db } = freshRoom();
    const csv = "product,revenue\nWidget A,2398.80\nWidget B,2399.20\n";
    const file = insertFile(db, "sales.csv", "text/csv", Buffer.from(csv), csv, "upload");
    vi.mocked(ensureUp).mockRejectedValue(new Error("must not be called"));
    const result = await cmdExtract(baseCtx(rooms, { args: "product, revenue", refs: [file.id] }));
    expect(result.content).toContain("Extracted 2 field(s) from 1 file(s)");
    expect(result.sources).toEqual(["extract.csv"]);
    const meta = db.prepare("SELECT extracted_text FROM files WHERE name = 'extract.csv'").get() as {
      extracted_text: string;
    };
    expect(meta.extracted_text).toContain("Widget A,2398.80");
    expect(meta.extracted_text).toContain("Widget B,2399.20");
  });

  it("falls back to the model for a non-tabular file, defaulting a truly missing field to (not found)", async () => {
    const { rooms, db } = freshRoom();
    const text = "Acme Corp reported revenue of $12M this quarter.";
    const file = insertFile(db, "report.txt", "text/plain", Buffer.from(text), text, "upload");
    await withFakeSidecar(
      (body) => {
        const fields = (body as { fields: string[] }).fields;
        const values: Record<string, string> = {};
        for (const f of fields) {
          values[f] = f === "revenue" ? "$12M" : "(not found)";
        }
        return { values };
      },
      async () => {
        const result = await cmdExtract(
          baseCtx(rooms, { args: "revenue, CEO", refs: [file.id] })
        );
        expect(result.content).toContain("Extracted 2 field(s) from 1 file(s)");
      }
    );
    const meta = db.prepare("SELECT extracted_text FROM files WHERE name = 'extract.csv'").get() as {
      extracted_text: string;
    };
    expect(meta.extracted_text).toContain("$12M");
    expect(meta.extracted_text).toContain("(not found)");
  });
});

// ============================================================================
// Adversarial: empty/malformed arguments, and an argument that carries another
// command's trigger syntax (a `#word`, an `@ref`, a bare colon).
// ============================================================================

describe("adversarial", () => {
  it("every command refuses empty/whitespace arguments with its own usage line, touching nothing", async () => {
    const { rooms, db } = freshRoom();
    vi.mocked(ensureUp).mockRejectedValue(new Error("no sidecar must be reached"));
    for (const args of ["", "   ", "\n\t "]) {
      await expect(cmdRemember(baseCtx(rooms, { args }))).rejects.toThrow("Usage: #remember <fact>");
      await expect(cmdFind(baseCtx(rooms, { args }))).rejects.toThrow("Usage: #find <keywords>");
      await expect(cmdAddFile(baseCtx(rooms, { args }))).rejects.toThrow(
        "Usage: #add-file <name>: <topic>   (or)   #add-file for each <thing>"
      );
      // #highlight and #extract check their @refs FIRST, so with none pinned
      // that is the error they must give — not the empty-args one.
      await expect(cmdHighlight(baseCtx(rooms, { args }))).rejects.toThrow(
        "Add a file with @ — e.g. #highlight the total in @invoice.pdf"
      );
      await expect(cmdExtract(baseCtx(rooms, { args }))).rejects.toThrow(
        "Add files with @ — e.g. #extract revenue, CEO from @a.pdf @b.pdf"
      );
    }
    expect(listMemories(db)).toHaveLength(0);
  });

  it("#extract whose fields are nothing but the trailing preposition refuses before any model call", async () => {
    const { rooms, db } = freshRoom();
    const id = insertFile(db, "a.pdf", "application/pdf", Buffer.from("x"), "x", "test").id;
    vi.mocked(ensureUp).mockRejectedValue(new Error("no sidecar must be reached"));
    // `strip_trailing_preposition` eats the whole word, leaving nothing.
    for (const args of ["from", "  in  ", "of", ",", " , , "]) {
      await expect(cmdExtract(baseCtx(rooms, { refs: [id], args }))).rejects.toThrow(
        "Say which fields to extract — e.g. #extract revenue, CEO from @a @b"
      );
    }
  });

  it("#highlight whose target strips to nothing refuses, and one that does not is stripped as a WHOLE word", async () => {
    const { rooms, db } = freshRoom();
    const id = insertFile(db, "c.txt", "text/plain", Buffer.from("body"), "body", "test").id;
    vi.mocked(ensureUp).mockRejectedValue(new Error("no sidecar in this test"));
    for (const args of ["", "   "]) {
      await expect(cmdHighlight(baseCtx(rooms, { refs: [id], args }))).rejects.toThrow(
        "Say what to highlight"
      );
    }
    // But `" in "` is NOT one of those: it trims to "in", and Rust's
    // `trim_end_matches(" in")` needs the leading SPACE, so nothing more is
    // stripped and the target really is the word "in". "in on in" is the same
    // rule applied twice: one trailing " in", then one trailing " on", leaving
    // "in" — the command proceeds rather than refusing.
    await expect(cmdHighlight(baseCtx(rooms, { refs: [id], args: " in " }))).rejects.toThrow(
      'Couldn\'t find an exact passage for "in" in c.txt.'
    );
    let asked: string | null = null;
    await expect(
      cmdHighlight(
        baseCtx(rooms, {
          refs: [id],
          args: "in on in",
          generate: async (_m, messages) => {
            asked = messages[messages.length - 1]?.content ?? "";
            return "";
          },
        })
      )
    ).rejects.toThrow('Couldn\'t find an exact passage for "in" in c.txt.');
    expect(asked).toBe("Request: in\n\nDocument:\nbody");
  });

  it("a fact that is another command's trigger syntax is stored verbatim, never re-dispatched", async () => {
    const { rooms, db } = freshRoom();
    const hostile = "#add-file for each: @a.pdf, @b.pdf — and #checkpoint after";
    const result = await cmdRemember(baseCtx(rooms, { args: `  ${hostile}  ` }));
    expect(result.content).toBe(`Saved to memory:\n\n> ${hostile}`);
    expect(listMemories(db).map((m) => m.content)).toEqual([hostile]);
    // The fan-out branch is keyed off `#add-file`'s OWN args, not a memory's
    // text, so nothing was enumerated and no file was created.
    expect(result.sources).toEqual([]);
  });

  it("#add-file's 'name: topic' split survives a topic that itself contains colons and #words", async () => {
    const { rooms } = freshRoom();
    // `split_once(':')` takes the FIRST colon only; the rest — colons, a
    // `#word`, an `@ref` — is the topic, verbatim.
    const seen: Array<Record<string, unknown>> = [];
    await withFakeSidecar(
      (body) => {
        seen.push(body as Record<string, unknown>);
        return { text: "<p>body</p>" };
      },
      async () => {
        const result = await cmdAddFile(
          baseCtx(rooms, { args: "Plan: rollout: phase #2 — see @old.md" })
        );
        expect(result.content).toBe("Created **Plan.html** and opened it.");
      }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.mode).toBe("single");
    expect(seen[0]!.topic).toBe("rollout: phase #2 — see @old.md");
  });

  it("a name hint of more than eight words is NOT a name — the whole line is the topic", async () => {
    const { rooms } = freshRoom();
    const nine = "one two three four five six seven eight nine";
    const seen: Array<Record<string, unknown>> = [];
    await withFakeSidecar(
      (body) => {
        seen.push(body as Record<string, unknown>);
        return { text: "<p>body</p>" };
      },
      async () => {
        await cmdAddFile(baseCtx(rooms, { args: `${nine}: the actual topic` }));
      }
    );
    // Rust: `n.split_whitespace().count() <= 8` fails, so `(None, a)` — the
    // topic is the WHOLE argument, colon included.
    expect(seen[0]!.topic).toBe(`${nine}: the actual topic`);
  });

  it("#add-file 'for each' matches case-insensitively and survives an empty subject", async () => {
    const { rooms } = freshRoom();
    const modes: string[] = [];
    await withFakeSidecar(
      (body) => {
        const b = body as Record<string, unknown>;
        modes.push(String(b.mode));
        return b.mode === "list" ? { items: [] } : { text: "" };
      },
      async () => {
        // "FOR EACH" with nothing after it still takes the fan-out branch —
        // Rust lowercases before `find`, and the subject is simply empty.
        await expect(cmdAddFile(baseCtx(rooms, { args: "FOR EACH" }))).rejects.toThrow(
          "Couldn't find a list to iterate over in this chat."
        );
      }
    );
    expect(modes).toEqual(["list"]);
  });
});
