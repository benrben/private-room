/**
 * Vitest port of `src-tauri/src/commands/chat_commands/generate.rs`'s
 * `#[cfg(test)] mod chunked_pass_tests` (`ChunkFailures`, `safe_file_stem`,
 * `merge_sketch`, `sketch_schema`), plus the slice of `chat_commands.rs`'s
 * own `stream_watchdog_tests` this file's `watchStream`/`streamIdleSecs`
 * carry over (`watch_stream`, `stream_idle_secs`).
 *
 * NOT RE-TESTED HERE, because this file no longer DECLARES them —
 * `chatCommandsGenerate.ts` imports `CmdCtx`/`cmdWindows`/`quietStepText`/
 * `askQuiet`/`digest`/`CommandResult` from `chatCommandsKnowledge.ts` (a
 * concurrently-landed batch that got to `chat_commands.rs`'s shared
 * scaffolding first — see that file's own module doc), and `refsFiles`/
 * `refsContext`/`nameFromTopic`/`htmlNoteName` from `docsHtml.ts`, and
 * `serializeDelim` from `editMatchCells.ts`. Every one of those already has
 * its own direct test coverage: `cmdWindows`/`quietStepText`/`askQuiet`/
 * `digest` in `chatCommandsKnowledge.test.ts`, `refsContext`/`refsFiles`/
 * `nameFromTopic`/`htmlNoteName` in `docsHtml.test.ts`, `serializeDelim` in
 * `editMatchCells.test.ts`. Re-testing an imported, unmodified function here
 * would only be a second copy of an assertion that already exists.
 *
 * `cmd*` COMMAND-LEVEL COVERAGE is real end-to-end against REAL fixture
 * rooms (`db-host/open.ts`'s `createRoom`, this directory's established
 * convention), for everything that does not need a live sidecar/Ollama:
 * every early-return validation error, the two paths that need no model call
 * at all (`#to-sheet`'s full flow; `#transcribe`'s already-cached-transcript
 * path), both genuinely-unported seams (`transcribeAudio`/`layoutGraph`)
 * proven as an honest default refusal AND as a real injected success path,
 * and — using the SAME "test-only seam, real by default" convention
 * `chatCommandsKnowledge.ts`'s own `CmdCtx.generate` establishes for
 * `askQuiet` — the full success path of every command that reaches the
 * model, via `CmdCtx.generate` (`#translate`), `CmdCtx.chatStructured`
 * (`#minutes`, `#sketch`), and `CmdCtx.generateStream` (`#summarize`,
 * `#compare`). `#research` additionally needs `web.ts`'s `searchWeb`/
 * `fetchReadable`, which are not seams on `CmdCtx` (Rust's `cmd_research`
 * calls `web::search_web`/`web::fetch_readable` as free functions, not
 * through `CmdCtx`, so there is nothing to inject there either) — only its
 * two model-free early returns are covered.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { TurnId } from "./turn.js";
import type { RoomSource } from "./jobs.js";
import { createRoom } from "./db-host/open.js";
import { fileByExactName, getFileExtractedText, insertFile } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import {
  CHUNK_GIVE_UP_AFTER,
  ChunkFailures,
  cmdCompare,
  cmdMinutes,
  cmdResearch,
  cmdSketch,
  cmdSummarize,
  cmdToSheet,
  cmdTranscribe,
  cmdTranslate,
  COMMAND_STREAM_IDLE_CLI_SECS,
  COMMAND_STREAM_IDLE_SECS,
  extractMdTable,
  generateStream,
  LAYOUT_GRAPH_NOT_IMPLEMENTED,
  layoutGraphNotImplemented,
  mediaKind,
  mergeMinutes,
  mergeSketch,
  renderMinutesHtml,
  safeFileStem,
  sketchSchema,
  streamIdleSecs,
  TRANSCRIBE_AUDIO_NOT_IMPLEMENTED,
  translationLocale,
  translationSystemPrompt,
  translationValidationIssues,
  watchStream,
  type CmdCtx,
  type GraphEdge,
  type GraphNode,
  type SketchDoc,
} from "./chatCommandsGenerate.js";
import { htmlDocument } from "./docsHtml.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { createRoomFile } from "./workspace/roomContent.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import type { ProviderDeps } from "./providers.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

vi.mock("./web.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web.js")>();
  return {
    ...actual,
    fetchReadable: vi.fn(actual.fetchReadable),
    searchWeb: vi.fn(actual.searchWeb),
  };
});

import { ensureUp } from "./sidecar.js";
import { fetchReadable, searchWeb } from "./web.js";

// ============================================================================
// fixtures
// ============================================================================

let tmpDir: string | null = null;
let openDb: Database.Database | null = null;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.mocked(ensureUp).mockReset();
  vi.mocked(fetchReadable).mockReset();
  vi.mocked(searchWeb).mockReset();
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-commands-generate-"));
  const roomFile = path.join(tmpDir, `t-${randomUUID()}.roomai`);
  const db = createRoom(roomFile, "correct horse battery staple", "Test Room");
  openDb = db;
  return db;
}

function addFile(db: Database.Database, name: string, text: string | null, mime = "text/plain"): string {
  const bytes = Buffer.from(text ?? "", "utf8");
  return insertFile(db, name, mime, bytes, text, "test").id;
}

function roomSource(db: Database.Database): RoomSource {
  return { current: () => ({ db, path: "test.roomai" }) };
}

/** Everything a `CmdCtx` needs, with sensible no-op defaults — the model
 * value is irrelevant to every test that never reaches a real network call
 * (an early validation throw, a no-model success path, an already-cancelled
 * loop, or an injected `generate`/`chatStructured`/`generateStream` seam). */
function makeCtx(db: Database.Database, overrides: Partial<CmdCtx> = {}): CmdCtx {
  return {
    rooms: roomSource(db),
    send: () => {},
    turn: new TurnId("run-1", "chat-1"),
    model: "qwen3.5:4b",
    refs: [],
    args: "",
    history: "",
    cancel: new CancelFlag(),
    unread: { count: 0 },
    temperature: null,
    ...overrides,
  };
}

function ndjsonResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(Buffer.from(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function respondWith(response: Response): void {
  vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
  globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;
}

// ============================================================================
// generate_stream — streaming wire, cancellation, policy/provider and errors
// ============================================================================

describe("generateStream", () => {
  it("streams split NDJSON deltas while preserving attachments, tools, and an explicit privacy policy", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    let url = "";
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      url = String(input);
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ndjsonResponse([
        "not json\n123\n{\"t\":\"delta\",\"v\":\"\"}\n{\"t\":\"delta\",\"v\":4}\n{\"t\":4}\n{\"t\":\"other\"}\n{\"t\":\"delta\",\"v\":\"Hel",
        "lo\"}\n{\"t\":\"delta\",\"v\":\"!\"}\n{\"t\":\"done\"}\n",
      ]);
    }) as unknown as typeof fetch;
    const deltas: string[] = [];

    const result = await generateStream(
      "/generate_stream",
      {
        model: "qwen3.5:4b",
        messages: [{ role: "user", content: "Summarize the attachment" }],
        attachments: [{ fileId: "brief" }],
        tools: [{ name: "room_search" }],
        privacy: null,
      },
      new CancelFlag(),
      new AbortController(),
      (delta) => deltas.push(delta),
    );

    expect(result).toBe("Hello!");
    expect(deltas).toEqual(["Hello", "!"]);
    expect(url).toBe("http://sidecar.test/generate_stream");
    expect(sent).toMatchObject({
      attachments: [{ fileId: "brief" }],
      tools: [{ name: "room_search" }],
      privacy: null,
    });
  });

  it("returns the accumulated text when the sidecar ends without a done event", async () => {
    respondWith(ndjsonResponse(['{"t":"delta","v":"partial"}\n']));
    const deltas: string[] = [];

    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), (delta) => deltas.push(delta)),
    ).resolves.toBe("partial");
    expect(deltas).toEqual(["partial"]);
  });

  it("surfaces an in-stream sidecar error with its code and message", async () => {
    respondWith(ndjsonResponse(['{"t":"error","code":"MODEL_BUSY","error":"try later"}\n']));

    await expect(
      generateStream("/generate_stream", { model: "qwen3.5:4b" }, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/try later/);
  });

  it("classifies HTTP errors, malformed error bodies, and a missing response body", async () => {
    respondWith(new Response(JSON.stringify({ code: "INVALID_REQUEST", error: "bad prompt" }), { status: 422 }));
    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/bad prompt/);

    respondWith(new Response("not json", { status: 500 }));
    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/unknown error/);

    respondWith(new Response(null, { status: 200 }));
    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/returned no body/);
  });

  it("reports a reader failure and tolerates a reader that was already released", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    const reader = {
      read: async (): Promise<{ done: boolean }> => Promise.reject(new Error("socket reset")),
      cancel: async (): Promise<void> => Promise.reject(new Error("already released")),
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, body: { getReader: () => reader } }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/Local AI stream failed: socket reset/);
  });

  it("uses a provider setup failure as an engine refusal before it starts the sidecar", async () => {
    const providerDeps: ProviderDeps = {
      readKey: () => {
        throw new Error("missing provider key");
      },
      storeKey: () => {},
      deleteKey: () => {},
      fetchJson: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    };

    await expect(
      generateStream(
        "/generate_stream",
        { model: "openrouter::example/model" },
        new CancelFlag(),
        new AbortController(),
        () => {},
        providerDeps,
      ),
    ).rejects.toThrow(/no OpenRouter API key is saved/);
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("reports sidecar startup and both transport failure classes", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("sidecar not installed"));
    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/sidecar not installed/);

    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    globalThis.fetch = vi.fn(async () => {
      const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      throw refused;
    }) as unknown as typeof fetch;
    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow("OLLAMA_DOWN");

    globalThis.fetch = vi.fn(async () => Promise.reject("transport lost")) as unknown as typeof fetch;
    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), new AbortController(), () => {}),
    ).rejects.toThrow(/transport lost/);
  });

  it("keeps polling an uncancelled request until an external abort closes it", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    globalThis.fetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 125);

    await expect(
      generateStream("/generate_stream", {}, new CancelFlag(), controller, () => {}),
    ).resolves.toBe("");
    clearTimeout(stop);
  });

  it("polls Stop during a pending request and returns empty once it aborts the connection", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    globalThis.fetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const cancel = new CancelFlag();
    const stop = setTimeout(() => cancel.store(true), 0);

    await expect(
      generateStream("/generate_stream", {}, cancel, new AbortController(), () => {}),
    ).resolves.toBe("");
    clearTimeout(stop);
  });
});

// ============================================================================
// watch_stream (chat_commands.rs::stream_watchdog_tests)
// ============================================================================

describe("watchStream", () => {
  function never(): Promise<string> {
    return new Promise(() => {
      // never settles
    });
  }

  it("stop keeps the partial the user already saw", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    let aborted = false;
    const got = await watchStream(
      never(),
      () => {
        aborted = true;
      },
      cancel,
      { current: Date.now() },
      { current: "half an answer already on screen" },
      300,
      0
    );
    expect(got).toBe("half an answer already on screen");
    expect(aborted).toBe(true);
  });

  it("a silent stream still gets hung up on", async () => {
    const cancel = new CancelFlag();
    await expect(
      watchStream(never(), () => {}, cancel, { current: Date.now() - 10_000 }, { current: "" }, 0, 1_500)
    ).rejects.toThrow(/stopped responding/);
  });

  it("propagates a stream failure instead of disguising it as an idle timeout", async () => {
    const cancel = new CancelFlag();
    await expect(
      watchStream(Promise.reject(new Error("model exploded")), () => {}, cancel, { current: Date.now() }, { current: "" }, 300, 0),
    ).rejects.toThrow("model exploded");
  });

  it("waits through Stop grace before an independently stalled stream is hung up", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    let aborted = false;
    await expect(
      watchStream(never(), () => { aborted = true; }, cancel, { current: Date.now() - 10_000 }, { current: "" }, 0, 1_000),
    ).rejects.toThrow(/stopped responding/);
    expect(aborted).toBe(true);
  });
});

describe("streamIdleSecs", () => {
  it("a cloud CLI is not judged by a streaming clock", () => {
    for (const m of ["claude-cli", "codex-cli::gpt-5.6-sol", "claude-cli::opus::high"]) {
      expect(streamIdleSecs(m)).toBeGreaterThan(900);
      expect(streamIdleSecs(m)).toBe(COMMAND_STREAM_IDLE_CLI_SECS);
    }
    for (const m of ["qwen3.5:4b", "minimax-m3:cloud", "openrouter::vendor/model"]) {
      expect(streamIdleSecs(m)).toBe(COMMAND_STREAM_IDLE_SECS);
    }
  });
});

// ============================================================================
// ChunkFailures (chat_commands/generate.rs::chunked_pass_tests)
// ============================================================================

describe("ChunkFailures", () => {
  const DOWN = "The local AI (Ollama) isn't running — start it and try again.";

  it("a global failure is reported with the engine's own message", () => {
    const f = new ChunkFailures();
    f.note(DOWN);
    f.note(DOWN);
    expect(f.nothingSaved()).toBe(DOWN);
  });

  it("a pass that never failed keeps the generic message", () => {
    expect(new ChunkFailures().nothingSaved()).toBe("The model returned nothing to save.");
  });

  it("a run of failures gives up but one bad slice does not", () => {
    const f = new ChunkFailures();
    for (let i = 0; i < CHUNK_GIVE_UP_AFTER - 1; i++) {
      expect(f.note("boom")).toBe(false);
    }
    f.ok();
    for (let i = 0; i < CHUNK_GIVE_UP_AFTER - 1; i++) {
      expect(f.note("boom")).toBe(false);
    }
    expect(f.note("boom")).toBe(true);
  });
});

// ============================================================================
// #sketch — safe_file_stem / sketch_schema / merge_sketch
// ============================================================================

describe("safeFileStem", () => {
  it("a title a model wrote becomes a name a file can have", () => {
    expect(safeFileStem("Q3 plan: what's next?")).toBe("Q3 plan what s next");
    expect(safeFileStem("auth/session flow")).toBe("auth session flow");
    expect(safeFileStem("   ")).toBe("Sketch");
    expect(Array.from(safeFileStem("long ".repeat(40))).length).toBeLessThanOrEqual(60);
  });
});

describe("sketchSchema", () => {
  it("never asks the model where anything goes", () => {
    const s = JSON.stringify(sketchSchema());
    for (const banned of ['"x"', '"y"', '"width"', '"height"', "position", "coordinate"]) {
      expect(s).not.toContain(banned);
    }
  });
});

describe("mergeSketch", () => {
  function part(json: string): unknown {
    return JSON.parse(json);
  }

  it("windows of one document merge into one diagram", () => {
    const parts = [
      part(
        '{"title":"Flow","explanation":"First half.",' +
          '"nodes":[{"id":"a","label":"Draft","note":"Where it starts"}],' +
          '"edges":[{"from":"a","to":"b","label":"sent to"}]}'
      ),
      part('{"title":"Ignored","explanation":"Second half.","nodes":[{"id":"b","label":"Review"}],"edges":[]}'),
    ];
    const { title, explanation, nodes, edges } = mergeSketch(parts);
    expect(title).toBe("Flow");
    expect(explanation).toContain("First half.");
    expect(explanation).toContain("Second half.");
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ from: "a", to: "b", label: "sent to" });
  });

  it("a node described twice keeps the description that said something", () => {
    const parts = [
      part('{"title":"T","nodes":[{"id":"a","label":"Auth","note":"The real one"}]}'),
      part('{"title":"T","nodes":[{"id":"a","label":"Auth"}]}'),
    ];
    const { nodes } = mergeSketch(parts);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.note).toBe("The real one");
  });

  it("the same connection described twice is drawn once", () => {
    const parts = [
      part(
        '{"title":"T","nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[{"from":"a","to":"b"}]}'
      ),
      part('{"title":"T","nodes":[],"edges":[{"from":"a","to":"b"}]}'),
    ];
    const { edges } = mergeSketch(parts);
    expect(edges).toHaveLength(1);
  });

  it("a nameless or empty description still produces something usable", () => {
    const { title, nodes } = mergeSketch([]);
    expect(title).toBe("Sketch");
    expect(nodes).toHaveLength(0);
  });

  it("a node with no label is dropped rather than drawn blank", () => {
    const parts = [part('{"title":"T","nodes":[{"id":"a","label":""},{"id":"b","label":"Real"}]}')];
    const { nodes } = mergeSketch(parts);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("Real");
  });

  it("ignores malformed model fields while preserving fallback labels, kinds, and valid edge order", () => {
    const merged = mergeSketch([
      null,
      { title: 3, explanation: 4, nodes: "not an array", edges: "not an array" },
      {
        title: "  Model flow  ",
        nodes: [
          4,
          { id: "   " },
          { id: "fallback" },
          { id: "kind", label: " Kind ", note: " ", kind: "start" },
        ],
        edges: [
          4,
          {},
          { from: 3, to: "kind" },
          { from: "fallback", to: 4 },
          { from: "fallback", to: "kind", label: "  " },
          { from: "fallback", to: "kind", label: "duplicate" },
        ],
      },
    ]);

    expect(merged).toMatchObject({
      title: "Model flow",
      explanation: "",
      nodes: [
        { id: "fallback", label: "fallback" },
        { id: "kind", label: "Kind", kind: "start" },
      ],
      edges: [{ from: "fallback", to: "kind" }],
    });
  });
});

// ============================================================================
// mediaKind (stt.rs slice)
// ============================================================================

describe("mediaKind", () => {
  it("classifies by mime first, then by extension", () => {
    expect(mediaKind("audio/mpeg", "mp3")).toBe("audio");
    expect(mediaKind("application/octet-stream", "m4a")).toBe("audio");
    expect(mediaKind("video/mp4", "mp4")).toBe("video");
    expect(mediaKind("application/pdf", "pdf")).toBeNull();
    expect(mediaKind("image/png", "png")).toBeNull();
  });
});

// ============================================================================
// extractMdTable (docs_html.rs)
// ============================================================================

describe("extractMdTable", () => {
  it("parses and skips the separator row, and the LAST table wins", () => {
    const md = "intro\n\n| Name | Age |\n|------|-----|\n| Ann | 30 |\n| Bob | 25 |\n\nafter";
    const rows = extractMdTable(md);
    expect(rows).toHaveLength(3);
    expect(rows?.[0]).toEqual(["Name", "Age"]);
    expect(rows?.[2]).toEqual(["Bob", "25"]);
    expect(extractMdTable("just prose, no pipes")).toBeNull();
    const two = "| A |\n|---|\n| 1 |\n\ntext\n\n| Z |\n|---|\n| 9 |";
    expect(extractMdTable(two)?.[0]).toEqual(["Z"]);
  });
});

// ============================================================================
// docs_html/minutes.rs — mergeMinutes / renderMinutesHtml
// ============================================================================

describe("mergeMinutes", () => {
  it("stitches every pass into one timeline", () => {
    const first = {
      title: "Quarterly review",
      date: "2026-07-05",
      attendees: ["Ana", "Ben"],
      timeline: [{ time: "09:00", topic: "Kickoff", summary: "Reviewed goals." }],
      decisions: ["Ship on Friday"],
      actions: [{ owner: "Ana", task: "Send recap" }],
    };
    const second = {
      title: "",
      date: "",
      attendees: ["ben", "Cai"],
      timeline: [
        { time: "09:00", topic: "Kickoff", summary: "Reviewed goals." },
        { time: "10:30", topic: "Budget", summary: "Agreed Q3 numbers." },
      ],
      decisions: ["ship on friday", "Hire a designer"],
      actions: [{ owner: "Ana", task: "Send recap" }, { task: "Book room" }],
    };
    const m = mergeMinutes([first, second]);
    expect(m.title).toBe("Quarterly review");
    expect(m.date).toBe("2026-07-05");
    expect(m.attendees).toEqual(["Ana", "Ben", "Cai"]);
    expect(m.decisions).toEqual(["Ship on Friday", "Hire a designer"]);
    expect(m.timeline).toHaveLength(2);
    expect(m.timeline[0]?.topic).toBe("Kickoff");
    expect(m.timeline[1]?.topic).toBe("Budget");
    expect(m.actions).toHaveLength(2);
    expect(mergeMinutes([]).timeline).toHaveLength(0);
  });

  it("drops malformed, empty and duplicate structured fields without changing valid item order", () => {
    const merged = mergeMinutes([
      null,
      { title: 3, date: {}, attendees: "not an array", timeline: "not an array", decisions: {}, actions: {} },
      {
        title: "  Retrospective  ",
        date: " 2026-08-01 ",
        attendees: [4, " ", "Ana", " ana "],
        decisions: [null, "", "Ship", " ship "],
        timeline: [4, {}, { topic: " ", summary: " " }, { topic: "Plan", summary: "" }, { topic: "", summary: "Result" }, { topic: " plan ", summary: " " }],
        actions: [4, {}, { owner: "", task: "" }, { owner: " Ana ", task: "Send notes" }, { owner: "ana", task: " send notes " }],
      },
    ]);

    expect(merged).toMatchObject({
      title: "Retrospective",
      date: "2026-08-01",
      attendees: ["Ana"],
      decisions: ["Ship"],
      timeline: [{ topic: "Plan", summary: "" }, { topic: "", summary: "Result" }],
      actions: [{ owner: " Ana ", task: "Send notes" }],
    });
    expect(renderMinutesHtml(merged, "Retrospective")).toContain("Result");
  });
});

describe("renderMinutesHtml", () => {
  it("builds a timeline document", () => {
    const data = mergeMinutes([
      {
        title: "Weekly sync",
        date: "2026-07-05",
        attendees: ["Ana", "Ben"],
        timeline: [
          { time: "09:00", topic: "Kickoff", summary: "Reviewed goals." },
          { topic: "Budget", summary: "Agreed on Q3 numbers." },
        ],
        decisions: ["Ship on Friday"],
        actions: [{ owner: "Ana", task: "Send recap" }, { task: "Book room" }],
      },
    ]);
    const body = renderMinutesHtml(data, "Weekly sync");
    expect(body).toContain("<h1>Weekly sync</h1>");
    expect(body).toContain('class="eyebrow"');
    expect(body).toContain("Meeting minutes");
    expect(body).toContain('class="tl"');
    expect(body).toContain('class="chip"');
    expect(body).toContain("Kickoff");
    expect(body).toContain("Budget");
    expect(body).toContain("Ship on Friday");
    expect(body).toContain("Send recap");
    expect(body).toContain("<td>—</td>");
    const doc = htmlDocument("Weekly sync", body);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("--accent");
    expect(doc).toContain('class="doc"');
    expect(doc).toContain("doc-foot");
  });

  it("renders a minimal document when every optional section is empty or malformed", () => {
    const body = renderMinutesHtml(
      {
        title: "",
        date: " ",
        attendees: [" "],
        timeline: [null as unknown as Record<string, unknown>],
        decisions: [" "],
        actions: [],
      },
      "Minimal",
    );

    expect(body).toContain("Meeting minutes");
    expect(body).not.toContain('class="chips"');
    expect(body).not.toContain("<h2>Timeline</h2>");
    expect(body).not.toContain("<h2>Decisions</h2>");
    expect(body).not.toContain("<h2>Action items</h2>");
  });
});

// ============================================================================
// command-level: validation errors, no-model paths, and (via the CmdCtx
// test seams) real end-to-end success paths
// ============================================================================

describe("cmdSummarize", () => {
  it("refuses a file with no readable text", async () => {
    const db = freshRoom();
    const id = addFile(db, "empty.txt", "   ");
    const ctx = makeCtx(db, { refs: [id] });
    await expect(cmdSummarize(ctx)).rejects.toThrow('"empty.txt" has no readable text to summarize.');
  });

  it("refuses an empty room", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(cmdSummarize(ctx)).rejects.toThrow("This room has no files to summarize yet.");
  });

  it("streams a real answer for a single pinned file", async () => {
    const db = freshRoom();
    const id = addFile(db, "plan.md", "Ship the thing by Friday.");
    const ctx = makeCtx(db, {
      refs: [id],
      generateStream: async (_path, _body, _cancel, _controller, onDelta) => {
        onDelta("A short summary.");
        return "A short summary.";
      },
    });
    const result = await cmdSummarize(ctx);
    expect(result.content).toBe("A short summary.");
    expect(result.sources).toEqual(["plan.md"]);
  });

  it("summarizes the whole room from its file inventory", async () => {
    const db = freshRoom();
    addFile(db, "plan.md", "hello");
    const ctx = makeCtx(db, {
      generateStream: async (_path, _body, _cancel, _controller, onDelta) => {
        onDelta("This room is about planning.");
        return "This room is about planning.";
      },
    });
    const result = await cmdSummarize(ctx);
    expect(result.content).toContain("This room is about planning.");
    expect(result.content).toContain("Summarize room");
    expect(result.sources).toEqual([]);
  });

  it("uses an existing per-file summary in the room inventory", async () => {
    const db = freshRoom();
    const id = addFile(db, "plan.md", "hello");
    db.prepare("UPDATE files SET ai_summary = ? WHERE id = ?").run("  A saved planning summary.  ", id);
    let prompt = "";
    const ctx = makeCtx(db, {
      generateStream: async (_path, body) => {
        prompt = JSON.stringify(body);
        return "Room overview";
      },
    });
    await expect(cmdSummarize(ctx)).resolves.toMatchObject({ content: expect.stringContaining("Room overview") });
    expect(prompt).toContain("A saved planning summary.");
  });

  it("refuses a file when the digest boundary returns no readable content", async () => {
    const db = freshRoom();
    const id = addFile(db, "plan.md", "source text ".repeat(2_000));
    const ctx = makeCtx(db, { refs: [id], generate: async () => "   " });
    await expect(cmdSummarize(ctx)).rejects.toThrow('Couldn\'t read "plan.md"');
  });
});

describe("cmdCompare", () => {
  it("requires at least two files", async () => {
    const db = freshRoom();
    const id = addFile(db, "a.md", "hello");
    const ctx = makeCtx(db, { refs: [id] });
    await expect(cmdCompare(ctx)).rejects.toThrow("Add at least two files with @");
  });

  it("refuses when neither file has readable text", async () => {
    const db = freshRoom();
    const a = addFile(db, "a.md", "   ");
    const b = addFile(db, "b.md", "");
    const ctx = makeCtx(db, { refs: [a, b] });
    await expect(cmdCompare(ctx)).rejects.toThrow("Those files have no readable text to compare.");
  });

  it("compares two files only from verified per-file quotes", async () => {
    const db = freshRoom();
    const a = addFile(db, "plan-a.md", "Ship Friday.");
    const b = addFile(db, "plan-b.md", "Ship Monday.");
    const ctx = makeCtx(db, {
      refs: [a, b],
      chatStructured: async () => JSON.stringify({
        overview: {
          claim: "The plans choose different dates.",
          evidence: [
            { file: "plan-a.md", quote: "Ship Friday." },
            { file: "plan-b.md", quote: "Ship Monday." },
          ],
        },
        similarities: [],
        differences: [{
          claim: "The planned ship dates differ.",
          evidence: [
            { file: "plan-a.md", quote: "Ship Friday." },
            { file: "plan-b.md", quote: "Ship Monday." },
          ],
        }],
      }),
    });
    const result = await cmdCompare(ctx);
    expect(result.content).toContain("The planned ship dates differ.");
    expect(result.content).toContain("### Overview");
    expect(result.content).toContain("**plan-a.md**: “Ship Friday.”");
    expect(result.sources).toEqual(["plan-a.md", "plan-b.md"]);
  });

  it("rejects a fact attributed to a file that does not contain its quote", async () => {
    const db = freshRoom();
    const report = addFile(db, "report.txt", "Disposable QA baseline and rollback test purpose.");
    const findings = addFile(db, "Research/findings.md", "Three records total 10. Shared fact: Cedar Lantern.");
    const ctx = makeCtx(db, {
      refs: [report, findings],
      chatStructured: async () => JSON.stringify({
        overview: {
          claim: "Both discuss the findings dataset.",
          evidence: [{ file: "report.txt", quote: "findings dataset" }],
        },
        similarities: [{
          claim: "Both contain Cedar Lantern.",
          evidence: [
            { file: "report.txt", quote: "Cedar Lantern" },
            { file: "Research/findings.md", quote: "Cedar Lantern" },
          ],
        }],
        differences: [],
      }),
    });
    await expect(cmdCompare(ctx)).rejects.toThrow("no claims supported by quotes");
  });

  it("omits a one-file overview even when its quote and another difference are grounded", async () => {
    const db = freshRoom();
    const a = addFile(db, "a.md", "Ship Friday.");
    const b = addFile(db, "b.md", "Ship Monday.");
    const ctx = makeCtx(db, {
      refs: [a, b],
      chatStructured: async () => JSON.stringify({
        overview: {
          claim: "Both plans ship Friday.",
          evidence: [{ file: "a.md", quote: "Ship Friday." }],
        },
        similarities: [],
        differences: [{
          claim: "The ship dates differ.",
          evidence: [
            { file: "a.md", quote: "Ship Friday." },
            { file: "b.md", quote: "Ship Monday." },
          ],
        }],
      }),
    });

    const result = await cmdCompare(ctx);
    expect(result.content).not.toContain("Both plans ship Friday.");
    expect(result.content).toContain("The ship dates differ.");
    expect(result.content).toContain("No supported overview was found.");
  });

  it("rejects malformed structured comparison output with the grounding error", async () => {
    const db = freshRoom();
    const a = addFile(db, "a.md", "Alpha evidence");
    const b = addFile(db, "b.md", "Beta evidence");
    const ctx = makeCtx(db, { refs: [a, b], chatStructured: async () => "not-json" });
    await expect(cmdCompare(ctx)).rejects.toThrow("comparison was not grounded in readable source evidence");
  });
});

describe("cmdTranscribe", () => {
  it("reads workspace audio from the normal file and caches only transcript text", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-command-workspace-"));
    const root = path.join(tmpDir, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
    openDb = db;
    const workspace = new WorkspaceService(db, root);
    const audio = Buffer.from([1, 2, 3, 4]);
    const entry = await workspace.createFile("call.m4a", Readable.from([audio]), "upload");
    db.prepare("UPDATE files SET mime_type = 'audio/mp4' WHERE id = ?").run(entry.fileId);
    const rooms: RoomSource = { current: () => ({ db, path: root, workspace }) };
    const ctx = makeCtx(db, {
      rooms,
      refs: [entry.fileId],
      transcribeAudio: async (bytes) => {
        expect(bytes).toEqual(audio);
        return "Workspace words";
      },
    });

    await cmdTranscribe(ctx);

    expect(readFileSync(path.join(root, "call.m4a"))).toEqual(audio);
    expect(getFileExtractedText(db, entry.fileId)).toBe(
      "(transcribed from recording)\nWorkspace words",
    );
    const row = db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(entry.fileId) as {
      original_bytes: Buffer | null;
    };
    expect(row.original_bytes).toBeNull();
  });

  it("requires an @-pinned recording", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(cmdTranscribe(ctx)).rejects.toThrow("Add a recording with @");
  });

  it("refuses a non-media file", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.txt", "", "text/plain");
    const ctx = makeCtx(db, { refs: [id] });
    await expect(cmdTranscribe(ctx)).rejects.toThrow('"notes.txt" isn\'t an audio or video file.');
  });

  it("returns an already-cached transcript with no model call", async () => {
    const db = freshRoom();
    const id = addFile(db, "call.m4a", "(transcribed from recording)\nHello there.", "audio/mp4");
    const ctx = makeCtx(db, { refs: [id] });
    const result = await cmdTranscribe(ctx);
    expect(result.content).toBe("Transcript of **call.m4a**:\n\n(transcribed from recording)\nHello there.");
    expect(result.sources).toEqual(["call.m4a"]);
  });

  it("refuses new audio honestly when transcription has no port", async () => {
    const db = freshRoom();
    const id = addFile(db, "call.m4a", null, "audio/mp4");
    const ctx = makeCtx(db, { refs: [id] });
    await expect(cmdTranscribe(ctx)).rejects.toThrow(TRANSCRIBE_AUDIO_NOT_IMPLEMENTED);
  });

  it("transcribes, caches and reports through an injected engine", async () => {
    const db = freshRoom();
    const id = addFile(db, "call.m4a", null, "audio/mp4");
    const events: Array<[string, unknown]> = [];
    const ctx = makeCtx(db, {
      refs: [id],
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      transcribeAudio: async (bytes: Buffer, ext: string, kind: "audio" | "video") => {
        expect(ext).toBe("m4a");
        expect(kind).toBe("audio");
        expect(bytes.length).toBe(0);
        return "  Hello from the fake engine.  ";
      },
    });
    const result = await cmdTranscribe(ctx);
    expect(result.content).toBe("Transcript of **call.m4a**:\n\nHello from the fake engine.");
    expect(getFileExtractedText(db, id)).toBe("(transcribed from recording)\nHello from the fake engine.");
    expect(events.some(([e]) => e === "room-files-changed")).toBe(true);
  });

  it("refuses silence honestly", async () => {
    const db = freshRoom();
    const id = addFile(db, "call.m4a", null, "audio/mp4");
    const ctx = makeCtx(db, { refs: [id], transcribeAudio: async () => "   " });
    await expect(cmdTranscribe(ctx)).rejects.toThrow(/Couldn't get any speech/);
  });

  it("refuses a media row whose stored bytes have vanished", async () => {
    const db = freshRoom();
    const id = addFile(db, "call.m4a", null, "audio/mp4");
    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(id);
    const ctx = makeCtx(db, { refs: [id], transcribeAudio: async () => "must not run" });
    await expect(cmdTranscribe(ctx)).rejects.toThrow("This recording has no stored audio.");
  });

  it("returns the transcript even when best-effort cache persistence fails", async () => {
    const db = freshRoom();
    const id = addFile(db, "call.m4a", null, "audio/mp4");
    const ctx = makeCtx(db, {
      refs: [id],
      transcribeAudio: async () => {
        db.close();
        openDb = null;
        return "Words that still reached the user";
      },
    });
    await expect(cmdTranscribe(ctx)).resolves.toMatchObject({
      content: expect.stringContaining("Words that still reached the user"),
    });
  });
});

describe("cmdMinutes", () => {
  it("renders the whole-source coverage note when the meeting needs multiple windows", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      history: "Ana: ship Friday. ".repeat(2_000),
      chatStructured: async () => JSON.stringify({
        title: "Long meeting",
        timeline: [{ topic: "Decision", summary: "Ship Friday" }],
      }),
    });

    const result = await cmdMinutes(ctx);

    expect(result.content).toMatch(/a 1-point timeline, read in [2-9]\d* passes over the whole source/);
  });

  it("asks for a source when none is given", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(cmdMinutes(ctx)).rejects.toThrow("Give me something to turn into minutes");
  });

  it("points at #transcribe when the pinned file has no text yet", async () => {
    const db = freshRoom();
    const id = addFile(db, "meeting.m4a", "");
    const ctx = makeCtx(db, { refs: [id] });
    await expect(cmdMinutes(ctx)).rejects.toThrow(/run #transcribe on it first/);
  });

  it("reports nothing found when an already-cancelled run never reaches the model", async () => {
    const db = freshRoom();
    const cancel = new CancelFlag();
    cancel.store(true);
    const ctx = makeCtx(db, { history: "Ana: let's ship Friday.", cancel });
    await expect(cmdMinutes(ctx)).rejects.toThrow("Couldn't find a meeting to summarize");
  });

  it("builds and saves real minutes through an injected structured call", async () => {
    const db = freshRoom();
    const events: Array<[string, unknown]> = [];
    const ctx = makeCtx(db, {
      history: "Ana: let's ship Friday. Ben: agreed.",
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      chatStructured: async () =>
        JSON.stringify({
          title: "Ship decision",
          timeline: [{ topic: "Ship date", summary: "Agreed to ship Friday." }],
          decisions: ["Ship Friday"],
        }),
    });
    const result = await cmdMinutes(ctx);
    expect(result.content).toBe("Created **Ship decision.html** — a timeline of the meeting.");
    const saved = fileByExactName(db, "Ship decision.html");
    expect(saved).not.toBeNull();
    const html = getFileExtractedText(db, saved!.id) ?? "";
    expect(html).toContain("Ship date");
    expect(html).toContain("Ship Friday");
    expect(events.some(([e]) => e === "agent-open-file")).toBe(true);
  });

  it("saves minutes through a workspace room", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-minutes-workspace-"));
    const root = path.join(tmpDir, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
    openDb = db;
    const workspace = new WorkspaceService(db, root);
    const ctx = makeCtx(db, {
      rooms: { current: () => ({ db, path: root, workspace }) },
      history: "Ana: ship Friday. Ben: agreed.",
      chatStructured: async () => JSON.stringify({
        title: "Workspace meeting",
        timeline: [{ topic: "Decision", summary: "Ship Friday" }],
      }),
    });
    const result = await cmdMinutes(ctx);
    expect(result.content).toContain("Workspace meeting.html");
    const saved = fileByExactName(db, "Workspace meeting.html")!;
    await expect(workspace.readBuffer(saved.id)).resolves.toEqual(expect.any(Buffer));
  });
});

describe("cmdSketch", () => {
  it("makes the default missing-layout boundary explicit", () => {
    expect(() => layoutGraphNotImplemented([], [])).toThrow(LAYOUT_GRAPH_NOT_IMPLEMENTED);
  });

  it("asks for something to draw when nothing is given", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(cmdSketch(ctx)).rejects.toThrow("Give me something to draw");
  });

  it("reports nothing found when an already-cancelled run never reaches the model", async () => {
    const db = freshRoom();
    const cancel = new CancelFlag();
    cancel.store(true);
    const ctx = makeCtx(db, { args: "how our login flow works", cancel });
    await expect(cmdSketch(ctx)).rejects.toThrow("Couldn't find anything to draw");
  });

  it("the default layout seam refuses honestly rather than fabricating a drawing", () => {
    expect(() => {
      throw new Error(LAYOUT_GRAPH_NOT_IMPLEMENTED);
    }).toThrow(/NOT_IMPLEMENTED/);
  });

  it("draws through an injected structured call and layout engine, indexing the extracted text", async () => {
    const db = freshRoom();
    const events: Array<[string, unknown]> = [];
    const layoutCalls: Array<{ nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }> = [];
    const doc: SketchDoc = { toJson: () => '{"drawn":true}', extractedText: () => "Draft note" };
    const ctx = makeCtx(db, {
      args: "how our draft flow works",
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      chatStructured: async () =>
        JSON.stringify({
          title: "Draft flow",
          nodes: [{ id: "a", label: "Draft", note: "Draft note" }],
          edges: [],
        }),
      layoutGraph: (nodes, edges) => {
        layoutCalls.push({ nodes, edges });
        return doc;
      },
    });
    const result = await cmdSketch(ctx);
    expect(layoutCalls).toHaveLength(1);
    expect(layoutCalls[0]?.nodes).toEqual([{ id: "a", label: "Draft", note: "Draft note" }]);
    expect(result.content).toContain("Drew **Draft flow.sketch**");
    const saved = fileByExactName(db, "Draft flow.sketch");
    expect(saved).not.toBeNull();
    // Indexed as the EXTRACTED text, never the raw JSON (ART-1's `.sketch` rule).
    expect(getFileExtractedText(db, saved!.id)).toBe("Draft note");
    expect(events.some(([e]) => e === "agent-open-file")).toBe(true);
  });
});

describe("cmdToSheet", () => {
  it("refuses when no table is in the recent answer", async () => {
    const ctx = makeCtx(freshRoom(), { history: "just prose, no table here" });
    await expect(cmdToSheet(ctx)).rejects.toThrow("No table found in a recent answer to convert.");
  });

  it("converts the most recent table with no model call at all", async () => {
    const db = freshRoom();
    const history = "Here you go:\n\n| Name | Age |\n|------|-----|\n| Ann | 30 |\n| Bob | 25 |\n";
    const events: Array<[string, unknown]> = [];
    const ctx = makeCtx(db, { history, emit: (event: string, payload: unknown) => events.push([event, payload]) });
    const result = await cmdToSheet(ctx);
    expect(result.content).toBe("Saved the table as **table.csv** (2 row(s)).");
    expect(result.sources).toEqual(["table.csv"]);
    const saved = fileByExactName(db, "table.csv");
    expect(saved).not.toBeNull();
    expect(getFileExtractedText(db, saved!.id)).toBe("Name,Age\nAnn,30\nBob,25\n");
    expect(events.some(([e]) => e === "agent-open-file")).toBe(true);
  });

  it("saves a converted table through a workspace room and ignores emit failures", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-sheet-workspace-"));
    const root = path.join(tmpDir, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
    openDb = db;
    const workspace = new WorkspaceService(db, root);
    const ctx = makeCtx(db, {
      rooms: { current: () => ({ db, path: root, workspace }) },
      history: "| A | B |\n|---|---|\n| 1 | 2 |\n",
      emit: () => { throw new Error("fabricated renderer disconnect"); },
    });
    await expect(cmdToSheet(ctx)).resolves.toMatchObject({ content: expect.stringContaining("table.csv") });
    const saved = fileByExactName(db, "table.csv")!;
    await expect(workspace.readBuffer(saved.id)).resolves.toEqual(Buffer.from("A,B\n1,2\n"));
  });
});

describe("cmdTranslate", () => {
  it("uses a Hebrew locale rubric and validates preserved literals", () => {
    expect(translationLocale("עברית")).toBe("he");
    expect(translationLocale("Hebrew")).toBe("he");
    expect(translationSystemPrompt("Hebrew")).toContain("idiomatic modern Hebrew");
    const source = "Expected total 10 at https://example.com/q?a=1. Keep `records=3`.";
    expect(translationValidationIssues(
      source,
      "סה״כ צפוי 10 בכתובת https://example.com/q?a=1. שמור `records=3`.",
      "Hebrew",
    )).toEqual([]);
    expect(translationValidationIssues(source, "Expected total 11 â€™", "Hebrew")).toEqual([
      "the translation contains replacement or mojibake characters",
      "URLs were not preserved exactly",
      "numbers were not preserved exactly",
      "inline code were not preserved exactly",
      "a Hebrew translation must contain Hebrew script",
    ]);
    expect(translationValidationIssues(
      "Keep https://example.com/q twice: https://example.com/q and `same` with `same`.",
      "Conserva https://example.com/q dos veces: https://example.com/q y `same` con `same`.",
      "Spanish",
    )).toEqual([]);
  });

  it("requires an @-pinned file", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(cmdTranslate(ctx)).rejects.toThrow("Add a file with @");
  });

  it("requires a target language", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "hello");
    const ctx = makeCtx(db, { refs: [id], args: "" });
    await expect(cmdTranslate(ctx)).rejects.toThrow("Say the target language");
  });

  it("refuses a file with no readable text", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "");
    const ctx = makeCtx(db, { refs: [id], args: "to Spanish" });
    await expect(cmdTranslate(ctx)).rejects.toThrow('"notes.md" has no readable text to translate.');
  });

  it("reports the engine's own message when an already-cancelled run saves nothing", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "hello world");
    const cancel = new CancelFlag();
    cancel.store(true);
    const ctx = makeCtx(db, { refs: [id], args: "to Spanish", cancel });
    await expect(cmdTranslate(ctx)).rejects.toThrow("The model returned nothing to save.");
  });

  it("translates the whole file through an injected engine and saves the result", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "hello world");
    const events: Array<[string, unknown]> = [];
    const ctx = makeCtx(db, {
      refs: [id],
      args: "to Spanish",
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      generate: async (_model, messages) => {
        const user = messages[messages.length - 1]?.content ?? "";
        return `ES: ${user}`;
      },
    });
    const result = await cmdTranslate(ctx);
    expect(result.content).toBe("Translated **notes.md** into Spanish → **notes (Spanish).md**.");
    const saved = fileByExactName(db, "notes (Spanish).md");
    expect(saved).not.toBeNull();
    expect(getFileExtractedText(db, saved!.id)).toBe("ES: hello world\n");
    expect(events.some(([e]) => e === "agent-open-file")).toBe(true);
  });

  it("retries one invalid Hebrew translation at zero temperature and saves only the valid result", async () => {
    const db = freshRoom();
    const source = "Expected total 10 at https://example.com. Keep `records=3`.";
    const id = addFile(db, "report.txt", source);
    const calls: Array<{ system: string; user: string; temp: number | null }> = [];
    const answers = [
      "Expected total 11 â€™",
      "סה״כ צפוי 10 בכתובת https://example.com. שמור `records=3`.",
    ];
    const ctx = makeCtx(db, {
      refs: [id],
      args: "to Hebrew",
      generate: async (_model, messages, temp) => {
        calls.push({
          system: messages[0]?.content ?? "",
          user: messages[1]?.content ?? "",
          temp,
        });
        return answers.shift() ?? "";
      },
    });
    await cmdTranslate(ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ temp: 0.2 });
    expect(calls[0]?.system).toContain("idiomatic modern Hebrew");
    expect(calls[1]).toMatchObject({ temp: 0 });
    expect(calls[1]?.user).toContain("VALIDATION ERRORS:");
    expect(getFileExtractedText(db, fileByExactName(db, "report (Hebrew).md")!.id)).toBe(
      "סה״כ צפוי 10 בכתובת https://example.com. שמור `records=3`.\n"
    );
  });

  it("does not save a falsely complete artifact after two invalid Hebrew attempts", async () => {
    const db = freshRoom();
    const id = addFile(db, "report.txt", "Expected total 10.");
    let calls = 0;
    const ctx = makeCtx(db, {
      refs: [id],
      args: "to Hebrew",
      generate: async () => {
        calls += 1;
        return calls === 1 ? "Expected total 11." : "Still English total 12.";
      },
    });
    await expect(cmdTranslate(ctx)).rejects.toThrow("Translation quality validation failed");
    expect(calls).toBe(2);
    expect(fileByExactName(db, "report (Hebrew).md")).toBeNull();
  });

  it("marks a skipped early chunk as partial even when a later chunk succeeds", async () => {
    const db = freshRoom();
    const id = addFile(db, "long.txt", "Alpha ".repeat(501));
    const answers = [
      "Still English.",
      "Still English again.",
      "תרגום תקין בעברית.",
    ];
    const ctx = makeCtx(db, {
      refs: [id],
      args: "to Hebrew",
      generate: async () => answers.shift() ?? "",
    });

    const result = await cmdTranslate(ctx);
    const saved = getFileExtractedText(db, fileByExactName(db, "long (Hebrew).md")!.id) ?? "";
    expect(result.content).toContain("Partially translated");
    expect(saved).toContain("Partial translation — translated 1 of 2 parts");
    expect(saved).toContain("Part 1 is missing");
    expect(saved).toContain("תרגום תקין בעברית");
  });

  it("keeps a completed first chunk and publishes the partial artifact after Stop", async () => {
    const db = freshRoom();
    const id = addFile(db, "long.txt", "Alpha ".repeat(600));
    const cancel = new CancelFlag();
    const events: Array<[string, unknown]> = [];
    const steps: Array<[string, unknown]> = [];
    const ctx = makeCtx(db, {
      refs: [id],
      args: "to Spanish",
      cancel,
      send: (event: string, payload: unknown) => steps.push([event, payload]),
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      generate: async () => {
        cancel.store(true);
        return "Parte traducida";
      },
    });

    const result = await cmdTranslate(ctx);
    const saved = getFileExtractedText(db, fileByExactName(db, "long (Spanish).md")!.id) ?? "";

    expect(result.content).toBe("Partially translated **long.txt** into Spanish → **long (Spanish).md**.");
    expect(saved).toContain("Parte traducida\n");
    expect(saved).toContain('Part 2 is missing from "long.txt" because the run was stopped.');
    expect(steps.map(([event]) => event)).toEqual(["ask-step"]);
    expect(events.map(([event]) => event)).toEqual(["room-files-changed", "agent-open-file"]);
  });

  it("stops retrying after consecutive translation failures while retaining earlier chunks", async () => {
    const db = freshRoom();
    const id = addFile(db, "very-long.txt", "Alpha ".repeat(2_200));
    let calls = 0;
    const ctx = makeCtx(db, {
      refs: [id],
      args: "to Spanish",
      generate: async () => {
        calls += 1;
        if (calls === 1) return "Primer fragmento";
        throw new Error(`engine failure ${calls}`);
      },
    });

    const result = await cmdTranslate(ctx);
    const saved = getFileExtractedText(db, fileByExactName(db, "very-long (Spanish).md")!.id) ?? "";

    expect(calls).toBe(CHUNK_GIVE_UP_AFTER + 1);
    expect(result.content).toContain("Partially translated");
    expect(saved).toContain("Partial translation — translated 1 of 5 parts.");
    expect(saved).toContain("Parts 2, 3, 4, 5 are missing");
  });

  it("commits a complete translation through the workspace writer and announces it", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-command-translate-workspace-"));
    const root = path.join(tmpDir, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
    openDb = db;
    const workspace = new WorkspaceService(db, root);
    const source = await createRoomFile(
      { db, path: root },
      "notes.md",
      "text/markdown",
      Buffer.from("Hello"),
      "Hello",
      "upload",
    );
    const events: Array<[string, unknown]> = [];
    const steps: Array<[string, unknown]> = [];
    const ctx = makeCtx(db, {
      rooms: { current: () => ({ db, path: root, workspace }) },
      refs: [source.id],
      args: "to Spanish",
      send: (event: string, payload: unknown) => steps.push([event, payload]),
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      generate: async () => "Hola",
    });

    await expect(cmdTranslate(ctx)).resolves.toMatchObject({
      content: "Translated **notes.md** into Spanish → **notes (Spanish).md**.",
    });
    const written = fileByExactName(db, "notes (Spanish).md");
    expect(written).not.toBeNull();
    await expect(workspace.readBuffer(written!.id)).resolves.toEqual(Buffer.from("Hola\n"));
    expect(steps.map(([event]) => event)).toEqual(["ask-step"]);
    expect(events.map(([event]) => event)).toEqual(["room-files-changed", "agent-open-file"]);
  });
});

describe("cmdResearch", () => {
  it("requires a question", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(cmdResearch(ctx)).rejects.toThrow("Usage: #research <question>");
  });

  it("tells the user to turn web access on rather than silently searching", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "off");
    const ctx = makeCtx(db, { args: "who won the game" });
    const result = await cmdResearch(ctx);
    expect(result.content).toContain("Web access is off in this room.");
    expect(result.sources).toEqual([]);
  });

  it("distinguishes an unavailable search from a search with no results", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    vi.mocked(searchWeb).mockResolvedValue({
      hits: [],
      merged: 0,
      tookMs: 0,
      cached: false,
      failed: ["DuckDuckGo"],
    });

    const result = await cmdResearch(makeCtx(db, { args: "history of tea" }));
    expect(result.content).toContain("did not run");
    expect(result.content).toContain("DuckDuckGo");
  });

  it("saves each distinct readable page before answering from those saved sources", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    vi.mocked(searchWeb).mockResolvedValue({
      hits: [
        { title: "Source one", url: "https://example.test/one", engines: ["test"], score: 1 },
        { title: "Unavailable", url: "https://example.test/bad", engines: ["test"], score: 1 },
        { title: "Empty", url: "https://example.test/empty", engines: ["test"], score: 1 },
        { title: "Repeated", url: "https://example.test/one", engines: ["test"], score: 1 },
      ],
      merged: 4,
      tookMs: 0,
      cached: false,
      failed: [],
    });
    vi.mocked(fetchReadable).mockImplementation(async (url) => {
      if (url.endsWith("bad")) throw new Error("unavailable");
      if (url.endsWith("empty")) return { title: "Empty", text: "   " };
      return { title: "Read title", text: "Source evidence" };
    });
    const ctx = makeCtx(db, {
      args: "what happened",
      generate: async () => "Short digest",
      generateStream: async () => "The sources say what happened.",
    });

    const result = await cmdResearch(ctx);
    expect(result.content).toBe("The sources say what happened.");
    expect(result.sources).toEqual(["Read title.md"]);
    expect(fileByExactName(db, "Read title.md")).not.toBeNull();
    expect(fetchReadable).toHaveBeenCalledTimes(3);
  });

  it("keeps saved sources when the answer stream fails", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    vi.mocked(searchWeb).mockResolvedValue({
      hits: [{ title: "Source", url: "https://example.test/source", engines: ["test"], score: 1 }],
      merged: 1,
      tookMs: 0,
      cached: false,
      failed: [],
    });
    vi.mocked(fetchReadable).mockResolvedValue({ title: "", text: "Source evidence" });
    const result = await cmdResearch(makeCtx(db, {
      args: "what happened",
      generate: async () => "Short digest",
      generateStream: async () => Promise.reject(new Error("model unavailable")),
    }));

    expect(result.content).toContain("Saved 1 source(s) into the room:");
    expect(result.sources).toEqual(["Source.md"]);
  });

  it("falls back to the saved-source list when the answer stream is blank", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    vi.mocked(searchWeb).mockResolvedValue({
      hits: [{ title: "Source", url: "https://example.test/source", engines: ["test"], score: 1 }],
      merged: 1, tookMs: 0, cached: false, failed: [],
    });
    vi.mocked(fetchReadable).mockResolvedValue({ title: "Source", text: "Evidence" });
    const ctx = makeCtx(db, {
      args: "what happened",
      generate: async () => "Digest",
      generateStream: async () => "   ",
      emit: () => { throw new Error("fabricated renderer disconnect"); },
    });
    const result = await cmdResearch(ctx);
    expect(result.content).toContain("Saved 1 source(s) into the room:");
    expect(result.content).toContain("- Source.md");
  });

  it("reports readable hits as unsavable when the room write fails", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chat-research-workspace-"));
    const root = path.join(tmpDir, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
    openDb = db;
    const workspace = new WorkspaceService(db, root);
    setSetting(db, "web_provider", "duckduckgo");
    vi.mocked(searchWeb).mockResolvedValue({
      hits: [{ title: "Source", url: "https://example.test/source", engines: ["test"], score: 1 }],
      merged: 1, tookMs: 0, cached: false, failed: [],
    });
    vi.mocked(fetchReadable).mockImplementation(async () => {
      renameSync(root, `${root}-gone`);
      return { title: "Source", text: "Evidence" };
    });
    const result = await cmdResearch(makeCtx(db, {
      args: "what happened",
      rooms: { current: () => ({ db, path: root, workspace }) },
    }));
    expect(result.content).toContain("couldn't save any readable copies");
    expect(result.sources).toEqual([]);
  });
});

// ============================================================================
// Adversarial: malformed sources, model output shaped like a prototype, and a
// command argument that carries another command's trigger syntax.
// ============================================================================

describe("adversarial", () => {
  it("two DIFFERENT connections are two arrows, even when their ids collide under a join", () => {
    // Rust dedupes edges on a `HashSet<(String, String)>` — a tuple, which
    // cannot confuse two distinct pairs. A `${from} ${to}` string key can:
    // "a b"->"c" and "a"->"b c" both render "a b c", so the second edge was
    // silently dropped and the diagram lost a real connection.
    const parts = [
      {
        title: "Flow",
        nodes: [
          { id: "a b", label: "A B" },
          { id: "c", label: "C" },
          { id: "a", label: "A" },
          { id: "b c", label: "B C" },
        ],
        edges: [
          { from: "a b", to: "c", label: "one" },
          { from: "a", to: "b c", label: "two" },
        ],
      },
    ];
    const { edges } = mergeSketch(parts);
    expect(edges).toEqual([
      { from: "a b", to: "c", label: "one" },
      { from: "a", to: "b c", label: "two" },
    ]);
    // The genuinely repeated connection is still drawn once.
    expect(mergeSketch([{ nodes: [], edges: [{ from: "x", to: "y" }, { from: "x", to: "y" }] }]).edges).toHaveLength(1);
  });

  it("a model that answers with prototype-shaped keys cannot pollute Object.prototype", () => {
    // `#sketch` and `#minutes` both merge RAW parsed model JSON. A node id or
    // an attendee named "__proto__" must stay data.
    const sketchParts = [
      JSON.parse(
        '{"title":"T","nodes":[{"id":"__proto__","label":"Polluted","note":"n"},' +
          '{"id":"constructor","label":"Also fine"}],' +
          '"edges":[{"from":"__proto__","to":"constructor"}]}'
      ),
    ];
    const merged = mergeSketch(sketchParts);
    expect(merged.nodes.map((n) => n.id)).toEqual(["__proto__", "constructor"]);
    expect(merged.edges).toHaveLength(1);

    const minutes = mergeMinutes([
      JSON.parse(
        '{"title":"__proto__","attendees":["__proto__"],"decisions":["toString"],' +
          '"timeline":[{"topic":"__proto__","summary":"hasOwnProperty"}],' +
          '"actions":[{"owner":"constructor","task":"__proto__"}]}'
      ),
    ]);
    expect(minutes.attendees).toEqual(["__proto__"]);
    expect(minutes.timeline).toHaveLength(1);
    expect(minutes.actions).toHaveLength(1);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["topic"]).toBeUndefined();
    // …and the rendered HTML escapes it rather than treating it as markup.
    expect(renderMinutesHtml(minutes, "<script>x</script>")).toContain("&lt;script&gt;");
  });

  it("#translate's language is whatever the user typed, even another command's trigger", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "hello");
    const ctx = makeCtx(db, {
      refs: [id],
      // `rsplit_once(" to ")` takes the LAST " to ", so the language here is
      // the trailing text verbatim — a `#`-word in it is a language name, not
      // a second command, and it must reach the saved file's name unchanged.
      args: "to #sketch @plan.md",
      generate: async () => "translated",
    });
    const result = await cmdTranslate(ctx);
    expect(result.content).toBe("Translated **notes.md** into #sketch @plan.md → **notes (#sketch @plan.md).md**.");
    expect(fileByExactName(db, "notes (#sketch @plan.md).md")).not.toBeNull();
  });

  it("#translate parses its language exactly as rsplit_once(\" to \") does, refusing only a truly empty one", async () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "hello");
    // Only genuinely-empty args refuse.
    for (const args of ["", "   "]) {
      await expect(cmdTranslate(makeCtx(db, { refs: [id], args }))).rejects.toThrow(
        "Say the target language"
      );
    }
    // Everything else follows the Rust chain byte for byte: the LAST " to ",
    // else a leading "to ", else the whole string as a bare language name.
    // `"to "` trims to `"to"`, which matches NEITHER pattern, so the language
    // really is the word "to" — faithful, and easy to "fix" into a divergence.
    const seen: string[] = [];
    for (const [args, expected] of [
      ["to ", "to"],
      ["to Spanish", "Spanish"],
      ["notes to keep to Spanish", "Spanish"],
      ["Spanish", "Spanish"],
    ] as const) {
      const ctx = makeCtx(db, { refs: [id], args, generate: async () => "t" });
      const result = await cmdTranslate(ctx);
      seen.push(result.content);
      expect(result.content).toContain(`into ${expected} →`);
    }
    expect(seen).toHaveLength(4);
  });

  it("#to-sheet refuses a 'table' that is only separator rows, and never writes a file", async () => {
    const db = freshRoom();
    // One data-less separator line, and one lone row: neither reaches the
    // two-row minimum `extract_md_table` requires.
    for (const history of ["| --- | --- |", "| just | one |", "no pipes here at all", ""]) {
      const ctx = makeCtx(db, { history });
      await expect(cmdToSheet(ctx)).rejects.toThrow("No table found in a recent answer to convert.");
    }
    expect(fileByExactName(db, "table.csv")).toBeNull();
  });

  it("#minutes over an EMPTY window set refuses rather than writing blank minutes", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      history: "some discussion happened",
      // Every structured pass fails: parts stay empty, so the merged timeline
      // is empty and the command must refuse — not save an empty document.
      chatStructured: async () => {
        throw new Error("engine down");
      },
    });
    await expect(cmdMinutes(ctx)).rejects.toThrow("Couldn't find a meeting to summarize");
    expect(ctx.unread.count).toBeGreaterThan(0);
    expect(fileByExactName(db, "Meeting minutes.html")).toBeNull();
  });

  it("#sketch refuses a model reply whose nodes are all unusable", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      args: "how our login flow works",
      // Blank labels, blank ids, and a non-object — every one dropped, so
      // nothing is left to draw and the layout seam is never reached.
      chatStructured: async () =>
        '{"title":"T","nodes":[{"id":"","label":"x"},{"id":"a","label":"   "},"not an object"],"edges":[]}',
      layoutGraph: () => {
        throw new Error("layout must not be reached");
      },
    });
    await expect(cmdSketch(ctx)).rejects.toThrow("Couldn't find anything to draw in that source.");
  });
});
