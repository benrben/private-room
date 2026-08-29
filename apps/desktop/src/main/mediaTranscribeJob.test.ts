/**
 * Tests for `mediaTranscribeJob.ts` — the shared speaker-aware transcription
 * job.
 *
 * The whole whole-file transcription lane had NO test before this one, which
 * is a large part of why it could ship writing flat text over a live meta for
 * as long as it did. So the two properties that were actually broken are
 * pinned first and hardest:
 *
 *   1. BOTH HALVES ARE WRITTEN, AND THEY AGREE. `recordings.meta` is the row
 *      `fileRuntimeSurfaceIpc.ts` reads to choose `RecordingView` over
 *      `AudioView`; `files.extracted_text` is the only path by which speaker
 *      labels reach search and RAG. A test that checks one and not the other
 *      would pass on the exact corruption this module exists to fix, so every
 *      success case asserts `extracted_text === transcriptText(stored meta)`.
 *   2. A `RecMeta` WITH A `durationCs` COMES BACK. `RecordingView.tsx`'s
 *      `runRetranscribe` reads `updated.durationCs` the statement after
 *      awaiting the IPC call; the previous handler returned `undefined`, so the
 *      button threw a TypeError on every press.
 *
 * Network-carrying work runs against a REAL local `node:http` server with
 * `ensureUp` (from `sidecar.js`) mocked to point at it — the convention
 * `visionTools.test.ts`/`sidecarJsonCancellable.test.ts` set — never a patched
 * `fetch`, and never a stubbed module that succeeds by construction. Every DB
 * write runs against a REAL `.roomai` room via `createRoom`, matching
 * `recRead.test.ts`/`recBridge.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { getFileExtractedText, insertFile } from "./db-host/files.js";
import { createRoom } from "./db-host/open.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { enrollVoice } from "./db-host/voices.js";
import { isRetranscribing } from "./recBridge.js";
import {
  defaultRecMeta,
  encodeWav,
  transcriptText,
  type RecMeta,
  type RecSegment,
} from "./recFormat.js";
import { createRoomManagerState, type RoomManagerState } from "./roomManager.js";
import { ensureUp } from "./sidecar.js";
import { MODEL_FILE } from "./sttTools.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import {
  DIARIZE_MODEL_FILE,
  bundledDiarizeModelPath,
  diarizeEffectiveModel,
  diarizeModelPath,
  mergeTypedSince,
  postRetranscribeStream,
  reconcileRebuilt,
  retranscribeLine,
  transcribeMediaWithSpeakers,
  type MediaTranscribeDeps,
} from "./mediaTranscribeJob.js";

// --------------------------------------------------------------- scaffolding

let server: http.Server | undefined;
let tmpDir: string | undefined;

/** `closeAllConnections` first: the module's own keep-alive undici dispatcher
 * holds a socket open, so a bare `close()` never calls back. Same helper shape
 * `visionTools.test.ts` uses for the same reason. */
async function closeServer(): Promise<void> {
  if (server === undefined) {
    return;
  }
  const s = server;
  server = undefined;
  s.closeAllConnections?.();
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

function removeTmp(): void {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
}

afterEach(async () => {
  vi.mocked(ensureUp).mockReset();
  await closeServer();
  removeTmp();
});

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A sidecar whose `/rec/retranscribe` answers with the given NDJSON lines.
 * Captures the request body so the wire shape is pinned by the server, not by
 * the code that produced it. */
async function ndjsonSidecar(
  lines: readonly unknown[],
  seen: { body?: Record<string, unknown>; url?: string; auth?: string } = {},
): Promise<{ base: string; seen: typeof seen }> {
  const base = await listenOn((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.url = req.url ?? "";
      seen.auth = String(req.headers.authorization ?? "");
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const line of lines) {
        res.write(`${JSON.stringify(line)}\n`);
      }
      res.end();
    });
  });
  vi.mocked(ensureUp).mockResolvedValue(base);
  return { base, seen };
}

interface Harness {
  db: Database.Database;
  state: RoomManagerState;
  deps: MediaTranscribeDeps;
  events: Array<[string, unknown]>;
  indexed: string[];
  roomPath: string;
  userDataDir: string;
}

/** A real `.roomai` room plus a `userData` dir holding stub weights, so
 * `sttEffectiveModel`/`diarizeEffectiveModel` resolve without shipping 600 MB
 * into the test tree. `models: false` leaves both missing. */
function harness(opts: { models?: boolean } = {}): Harness {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mediaTranscribeJob-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  const userDataDir = path.join(tmpDir, "userData");
  if (opts.models !== false) {
    mkdirSync(path.join(userDataDir, "models"), { recursive: true });
    writeFileSync(path.join(userDataDir, "models", MODEL_FILE), "stub");
    writeFileSync(path.join(userDataDir, "models", DIARIZE_MODEL_FILE), "stub");
  }
  const state = createRoomManagerState();
  state.room = { conn: db, path: roomPath, name: "Test Room", password: "correct horse battery staple" };
  const events: Array<[string, unknown]> = [];
  const indexed: string[] = [];
  return {
    db,
    state,
    events,
    indexed,
    roomPath,
    userDataDir,
    deps: {
      state,
      userDataDir,
      resourcesPath: null,
      emit: (event, payload) => {
        events.push([event, payload]);
      },
      onIndexed: (p) => indexed.push(p),
    },
  };
}

function addMedia(db: Database.Database, name = "Team sync.m4a", mime = "audio/mp4"): string {
  return insertFile(db, name, mime, encodeWav(new Float32Array(16_000)), "", "library").id;
}

function seg(t0: number, t1: number, speaker: string, text: string): RecSegment {
  return { id: randomUUID(), source: "sys", speaker, t0, t1, text, words: [] };
}

/** What the sidecar's `RecMeta.to_dict()` puts on the wire — note that it OMITS
 * every empty optional field, which is exactly the shape `coerceRecMeta` has to
 * tolerate. */
function wireMeta(over: Partial<RecMeta> = {}): Record<string, unknown> {
  const meta = { ...defaultRecMeta(), durationCs: 100, segments: [seg(0, 100, "Speaker 1", "hello there")], ...over };
  const out: Record<string, unknown> = {
    durationCs: meta.durationCs,
    segments: meta.segments,
    cuts: meta.cuts,
    maxSpeakers: meta.maxSpeakers,
  };
  if (Object.keys(meta.speakerNames).length > 0) out.speakerNames = meta.speakerNames;
  if (meta.recognized.length > 0) out.recognized = meta.recognized;
  return out;
}

function stageFor(events: Array<[string, unknown]>, name: string): string[] {
  return events
    .filter(([event, payload]) => event === "stt-progress" && Array.isArray(payload) && payload[0] === name)
    .map(([, payload]) => String((payload as unknown[])[1]));
}

// ============================================================ model resolution

describe("diarizeEffectiveModel", () => {
  it("prefers a user-supplied copy, then the packaged one", () => {
    const downloaded = diarizeModelPath("/u");
    const bundled = bundledDiarizeModelPath("/r");
    expect(diarizeEffectiveModel("/u", "/r", (p) => p === downloaded || p === bundled)).toBe(downloaded);
    expect(diarizeEffectiveModel("/u", "/r", (p) => p === bundled)).toBe(bundled);
    expect(diarizeEffectiveModel("/u", null, (p) => p === bundled)).not.toBe(bundled);
  });

  it("still resolves in a dev tree, where resourcesPath is always null", () => {
    // The whole reason this function is not a literal copy of
    // `sttEffectiveModel`: `resourcesPath` is `app.isPackaged ? … : null`, so a
    // developer would otherwise get `null` here forever and voice enrolment
    // would look like a feature that does not work.
    const seen: string[] = [];
    const found = diarizeEffectiveModel("/nope", null, (p) => {
      seen.push(p);
      return p.endsWith(path.join("apps", "desktop", "resources", "models", DIARIZE_MODEL_FILE));
    });
    expect(found).not.toBeNull();
    expect(found!.endsWith(path.join("resources", "models", DIARIZE_MODEL_FILE))).toBe(true);
    // …and it must never reach for the packaging FIXTURE of the same name.
    expect(seen.some((p) => p.includes(`${path.sep}fixtures_a${path.sep}`))).toBe(false);
  });

  it("is null when nothing exists anywhere", () => {
    expect(diarizeEffectiveModel("/u", "/r", () => false)).toBeNull();
  });
});

// ================================================================ line protocol

describe("retranscribeLine", () => {
  it("reports progress and keeps reading", () => {
    const seen: Array<[number, number]> = [];
    expect(retranscribeLine({ kind: "progress", doneCs: 50, totalCs: 400 }, (d, t) => seen.push([d, t]))).toBeNull();
    // A progress line missing its numbers is skipped, never reported as 0/0.
    expect(retranscribeLine({ kind: "progress" }, (d, t) => seen.push([d, t]))).toBeNull();
    expect(seen).toEqual([[50, 400]]);
  });

  it("coerces the done line's meta and refuses one that will not coerce", () => {
    const ok = retranscribeLine({ kind: "done", meta: wireMeta(), neural: true }, () => {});
    expect(ok).toMatchObject({ kind: "done", neural: true });
    expect(ok && ok.kind === "done" && ok.meta.durationCs).toBe(100);

    // The exact shape RecordingView reads `.durationCs` off. A "done" carrying
    // a meta without one must fail here rather than be persisted.
    const bad = retranscribeLine({ kind: "done", meta: { segments: [], cuts: [] } }, () => {});
    expect(bad).toMatchObject({ kind: "error", code: "REC_RETRANSCRIBE_BAD_META" });
  });

  it("carries the two terminal failures apart, and ignores an unknown kind", () => {
    expect(retranscribeLine({ kind: "stopped" }, () => {})).toEqual({ kind: "stopped" });
    expect(retranscribeLine({ kind: "error", code: "REC_DECODE_FAILED", error: "no audio track" }, () => {})).toEqual({
      kind: "error",
      code: "REC_DECODE_FAILED",
      error: "no audio track",
    });
    expect(retranscribeLine({ kind: "heartbeat" }, () => {})).toBeNull();
  });
});

describe("postRetranscribeStream", () => {
  it("reads a real NDJSON stream to its terminal line, progress and all", async () => {
    const { base } = await ndjsonSidecar([
      { kind: "progress", doneCs: 10, totalCs: 100 },
      { kind: "progress", doneCs: 60, totalCs: 100 },
      { kind: "done", meta: wireMeta(), neural: true },
    ]);
    const seen: Array<[number, number]> = [];
    const outcome = await postRetranscribeStream(base, {}, (d, t) => seen.push([d, t]));
    expect(seen).toEqual([
      [10, 100],
      [60, 100],
    ]);
    expect(outcome.kind).toBe("done");
  });

  it("a stream that ends with no terminal line is an ERROR, never an empty transcript", async () => {
    // The failure this guards: a connection severed mid-rebuild reading as
    // "the recording is empty", which would then overwrite a good transcript
    // with silence.
    const { base } = await ndjsonSidecar([{ kind: "progress", doneCs: 10, totalCs: 100 }]);
    const outcome = await postRetranscribeStream(base, {}, () => {});
    expect(outcome).toMatchObject({ kind: "error", code: "REC_RETRANSCRIBE_TRUNCATED" });
  });

  it("surfaces a non-2xx refusal with the sidecar's own code", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "REC_PATH_REFUSED", error: "that path is not in the staging area" }));
    });
    vi.mocked(ensureUp).mockResolvedValue(base);
    expect(await postRetranscribeStream(base, {}, () => {})).toMatchObject({
      kind: "error",
      code: "REC_PATH_REFUSED",
    });
  });
});

// ================================================================ reconciliation

describe("reconcileRebuilt", () => {
  it("brings back only a name typed WHILE the rebuild ran (GH #5)", () => {
    const rebuilt = { "Speaker 1": "Dana" };
    const typed = mergeTypedSince(rebuilt, { "Speaker 2": "Dana" }, { "Speaker 2": "Dana", "Speaker 3": "Ari" });
    // "Dana" was already in the snapshot, and the rebuild has moved her onto
    // Speaker 1 — re-adding her under Speaker 2 is the one-person-two-speakers
    // symptom itself.
    expect(rebuilt).toEqual({ "Speaker 1": "Dana", "Speaker 3": "Ari" });
    expect([...typed]).toEqual(["Ari"]);
  });

  it("never overwrites a name the rebuild placed itself", () => {
    const rebuilt = { "Speaker 1": "Dana" };
    mergeTypedSince(rebuilt, {}, { "Speaker 1": "Someone else" });
    expect(rebuilt).toEqual({ "Speaker 1": "Dana" });
  });

  it("strips a typed name out of the guesses, and drops a guess about nobody", () => {
    const rebuilt: RecMeta = {
      ...defaultRecMeta(),
      durationCs: 10,
      speakerNames: { "Speaker 1": "Dana" },
      recognized: ["Dana", "Ghost"],
    };
    const stored: RecMeta = { ...defaultRecMeta(), speakerNames: { "Speaker 2": "Ari" } };
    const out = reconcileRebuilt(rebuilt, stored, {});
    expect(out.speakerNames).toEqual({ "Speaker 1": "Dana", "Speaker 2": "Ari" });
    // "Dana" survives as a guess (nobody typed her this run); "Ghost" is a
    // guess about a label the rebuild did not mint, so it goes.
    expect(out.recognized).toEqual(["Dana"]);

    // …and a name typed while it ran is the user's, never a guess.
    const typedRun = reconcileRebuilt(
      { ...rebuilt, recognized: ["Dana", "Ari"] },
      { ...defaultRecMeta(), speakerNames: { "Speaker 2": "Ari" } },
      {},
    );
    expect(typedRun.recognized).toEqual(["Dana"]);
  });

  it("carries cuts, chapters, highlights and notes forward, and clears readOf", () => {
    // `POST /rec/retranscribe` takes a REDUCED prior (names + guesses only), so
    // the sidecar can only ever copy empty lists back. Without this, pressing
    // "Transcribe again" would silently delete a recording's studio cuts and
    // every typed note.
    const stored: RecMeta = {
      ...defaultRecMeta(),
      cuts: [{ t0: 10, t1: 20 }],
      chapters: [{ id: "c", t0: 0, title: "Intro", by: "you" }],
      highlights: [{ id: "h", t0: 5, t1: 9, by: "you" }],
      notes: [{ id: "n", t0: 7, kind: "action", text: "send the deck", by: "you" }],
      readOf: { turns: 3, chars: 40 },
    };
    const out = reconcileRebuilt({ ...defaultRecMeta(), durationCs: 99 }, stored, {});
    expect(out.cuts).toEqual(stored.cuts);
    expect(out.chapters).toEqual(stored.chapters);
    expect(out.highlights).toEqual(stored.highlights);
    expect(out.notes).toEqual(stored.notes);
    // The transcript has just been rewritten, so any reading of the old one is
    // stale by definition.
    expect(out.readOf).toBeNull();
  });
});

// =================================================== the job, end to end

describe("transcribeMediaWithSpeakers", () => {
  it("writes BOTH recordings.meta and extracted_text, and they agree", async () => {
    const h = harness();
    const id = addMedia(h.db);
    await ndjsonSidecar([
      { kind: "progress", doneCs: 50, totalCs: 100 },
      { kind: "done", meta: wireMeta({ speakerNames: { "Speaker 1": "Dana" } }), neural: true },
    ]);

    const meta = await transcribeMediaWithSpeakers(h.deps, id);

    // (2) the contract RecordingView crashes on.
    expect(meta).not.toBeNull();
    expect(meta!.durationCs).toBe(100);

    // (1) BOTH halves, and mutually consistent.
    const storedJson = getRecMeta(h.db, id);
    expect(storedJson).not.toBeNull();
    const stored = JSON.parse(storedJson!) as RecMeta;
    expect(stored.durationCs).toBe(100);
    expect(stored.segments).toHaveLength(1);
    const text = getFileExtractedText(h.db, id);
    // This file was never captured here, so the provenance header must say so
    // rather than claiming a live recording that never happened.
    expect(text).toBe(transcriptText(stored, "(transcribed from recording)"));
    expect(text.startsWith("(transcribed from recording)\n")).toBe(true);
    // The speaker's NAME is in the indexed text — the only path by which it
    // reaches search and RAG.
    expect(text).toContain("Dana: hello there");
  });

  it("posts the camelCase body the /rec/retranscribe request model reads", async () => {
    const h = harness();
    const id = addMedia(h.db);
    enrollVoice(h.db, "Dana", { v: new Array(192).fill(0.1), f: 40 });
    setRecMeta(
      h.db,
      id,
      JSON.stringify({ ...defaultRecMeta(), maxSpeakers: 3, speakerNames: { "Speaker 1": "Ari" }, recognized: ["Ari"] }),
    );
    const { seen } = await ndjsonSidecar([{ kind: "done", meta: wireMeta(), neural: true }]);

    await transcribeMediaWithSpeakers(h.deps, id);

    expect(seen.url).toBe("/rec/retranscribe");
    expect(String(seen.auth).startsWith("Bearer ")).toBe(true);
    expect(Object.keys(seen.body!).sort()).toEqual(
      ["diarizeModelPath", "filePath", "kind", "knownVoices", "maxSpeakers", "modelPath", "prior"].sort(),
    );
    // Sent, never left to the sidecar's suffix guess — the text-only lane this
    // replaces sent it too, and a video staged without a suffix decodes to
    // nothing when it is guessed as audio.
    expect(seen.body!.kind).toBe("audio");
    // The path allowlist `server.py` copies: parent named `arcelle-stt-*`,
    // directly inside the system temp dir.
    const staged = String(seen.body!.filePath);
    expect(path.basename(path.dirname(staged)).startsWith("arcelle-stt-")).toBe(true);
    expect(seen.body!.modelPath).toBe(path.join(h.userDataDir, "models", MODEL_FILE));
    expect(seen.body!.diarizeModelPath).toBe(path.join(h.userDataDir, "models", DIARIZE_MODEL_FILE));
    expect(seen.body!.maxSpeakers).toBe(3);
    // `cuts` rides with the naming overlay: the sidecar re-marks every freshly
    // derived word inside a carried-over cut as deleted, so without them a
    // rebuild resurrects content the user cut.
    expect(seen.body!.prior).toEqual({
      speakerNames: { "Speaker 1": "Ari" },
      recognized: ["Ari"],
      cuts: [],
    });
    expect(seen.body!.knownVoices).toMatchObject([{ name: "Dana", rejects: [] }]);
  });

  it('sends kind:"video" for a video whose name carries no usable suffix', async () => {
    // The staged file is `source.<ext>`, so a download or a paste that arrived
    // without an extension stages as `source.bin`. Guessed from that suffix it
    // reads as audio, the container's audio track is never lifted out, and the
    // rebuild fails on a file that plays perfectly.
    const h = harness();
    const id = insertFile(h.db, "Standup recording", "video/mp4", encodeWav(new Float32Array(16_000)), "", "library").id;
    const { seen } = await ndjsonSidecar([{ kind: "done", meta: wireMeta(), neural: true }]);
    await transcribeMediaWithSpeakers(h.deps, id);
    expect(String(seen.body!.filePath).endsWith("source.bin")).toBe(true);
    expect(seen.body!.kind).toBe("video");
  });

  it("gives a video its transcript WITHOUT the recordings row that would cost it its picture", async () => {
    // `fileRuntimeSurfaceIpc` picks the viewer on the existence of a
    // `recordings` row, not on the MIME type, and `RecordingView` has no
    // <video> element. Writing the row for a video would trade the file's
    // image for speaker chips — it would still play its sound and silently
    // stop showing anything. The transcript still carries the speakers,
    // because that is what `AudioView` parses back out of the text.
    const h = harness();
    const id = insertFile(h.db, "Conference talk.mp4", "video/mp4", encodeWav(new Float32Array(16_000)), "", "library").id;
    await ndjsonSidecar([
      { kind: "done", meta: wireMeta({ speakerNames: { "Speaker 1": "Dana" } }), neural: true },
    ]);

    const meta = await transcribeMediaWithSpeakers(h.deps, id);

    expect(meta).not.toBeNull();
    expect(getRecMeta(h.db, id)).toBeNull();
    const text = getFileExtractedText(h.db, id);
    expect(text).toContain("Dana: hello there");
  });

  it("sends prior:null for a file that was never a recording", async () => {
    const h = harness();
    const id = addMedia(h.db);
    const { seen } = await ndjsonSidecar([{ kind: "done", meta: wireMeta(), neural: false }]);
    await transcribeMediaWithSpeakers(h.deps, id);
    expect(seen.body!.prior).toBeNull();
  });

  it("emits progress on both channels the two viewers read", async () => {
    const h = harness();
    const id = addMedia(h.db);
    await ndjsonSidecar([
      { kind: "progress", doneCs: 25, totalCs: 100 },
      { kind: "done", meta: wireMeta(), neural: true },
    ]);
    await transcribeMediaWithSpeakers(h.deps, id);

    // AudioView reads the stage, keyed by NAME (never by id).
    expect(stageFor(h.events, "Team sync.m4a")).toEqual(["started", "processing", "done"]);
    // RecordingView's progress bar reads the numbers, keyed by id.
    expect(h.events.filter(([e]) => e === "rec-retranscribe").map(([, p]) => p)).toEqual([
      { fileId: id, doneCs: 25, totalCs: 100 },
      { fileId: id, doneCs: 100, totalCs: 100 },
    ]);
    expect(h.indexed).toEqual([h.roomPath]);
  });

  it('answers "none" for a file the engine read all the way through in silence', async () => {
    const h = harness();
    const id = addMedia(h.db);
    await ndjsonSidecar([{ kind: "done", meta: wireMeta({ segments: [] }), neural: true }]);
    await transcribeMediaWithSpeakers(h.deps, id);
    expect(stageFor(h.events, "Team sync.m4a")).toEqual(["started", "none"]);
  });

  it("refuses a non-media file silently — the caller owns that sentence", async () => {
    const h = harness();
    const id = insertFile(h.db, "notes.txt", "text/plain", Buffer.from("hi"), "hi", "library").id;
    expect(await transcribeMediaWithSpeakers(h.deps, id)).toBeNull();
    expect(h.events).toEqual([]);
    expect(getRecMeta(h.db, id)).toBeNull();
  });

  it("says model-missing rather than transcribing nothing", async () => {
    const h = harness({ models: false });
    const id = addMedia(h.db);
    expect(await transcribeMediaWithSpeakers(h.deps, id)).toBeNull();
    expect(stageFor(h.events, "Team sync.m4a")).toEqual(["model-missing"]);
    expect(getRecMeta(h.db, id)).toBeNull();
  });

  it("still warms a workspace video's visual index when speech weights are missing", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mediaTranscribeVisual-"));
    const roomPath = path.join(tmpDir, "Room");
    const created = createWorkspaceRoom(roomPath, "correct horse battery staple", "Video Room");
    const workspace = new WorkspaceService(created.db, roomPath);
    const source = Buffer.from("video source for visual cache");
    const entry = await workspace.createFile("talk.mp4", Readable.from([source]), "import");
    created.db.prepare("UPDATE files SET mime_type = 'video/mp4' WHERE id = ?").run(entry.fileId);
    const hash = (created.db.prepare("SELECT content_sha256 FROM files WHERE id = ?").get(entry.fileId) as {
      content_sha256: string;
    }).content_sha256;
    const state = createRoomManagerState();
    state.room = {
      conn: created.db,
      path: roomPath,
      name: "Video Room",
      password: "correct horse battery staple",
      workspace,
    };
    const events: Array<[string, unknown]> = [];
    const warmVisualIndex = vi.fn(async (stagedPath: string, expectedSha?: string) => {
      expect(path.basename(path.dirname(stagedPath))).toMatch(/^arcelle-visual-index-/);
      expect(readFileSync(stagedPath)).toEqual(source);
      expect(expectedSha).toBe(hash);
      return null;
    });

    expect(await transcribeMediaWithSpeakers({
      state,
      userDataDir: path.join(tmpDir, "no-models"),
      resourcesPath: null,
      emit: (event, payload) => events.push([event, payload]),
      warmVisualIndex,
    }, entry.fileId)).toBeNull();

    expect(warmVisualIndex).toHaveBeenCalledTimes(1);
    expect(stageFor(events, "talk.mp4")).toEqual(["model-missing"]);
    created.db.close();
  });

  it("writes NOTHING when the rebuild fails, is stopped, or is truncated", async () => {
    for (const [lines, needle] of [
      [[{ kind: "error", code: "REC_DECODE_FAILED", error: "no audio track" }], "no audio track"],
      [[{ kind: "stopped" }], "stopped"],
      [[{ kind: "progress", doneCs: 1, totalCs: 2 }], "closed the connection"],
    ] as const) {
      const h = harness();
      const id = addMedia(h.db);
      const before: RecMeta = { ...defaultRecMeta(), durationCs: 7, segments: [seg(0, 7, "Speaker 1", "keep me")] };
      setRecMeta(h.db, id, JSON.stringify(before));
      await ndjsonSidecar(lines);

      expect(await transcribeMediaWithSpeakers(h.deps, id)).toBeNull();
      const stage = stageFor(h.events, "Team sync.m4a").at(-1) ?? "";
      expect(stage.startsWith("failed: ")).toBe(true);
      expect(stage).toContain(needle);
      // The stored transcript is exactly as it was.
      expect(JSON.parse(getRecMeta(h.db, id)!)).toEqual(before);

      await closeServer();
      removeTmp();
    }
  });

  it("refuses to write into a room that was swapped while it ran", async () => {
    const h = harness();
    const id = addMedia(h.db);
    await listenOn((req, res) => {
      req.resume();
      req.on("end", () => {
        // Swap the room out mid-flight, exactly as closing one would.
        h.state.room = null;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ kind: "done", meta: wireMeta(), neural: true })}\n`);
      });
    });
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);

    expect(await transcribeMediaWithSpeakers(h.deps, id)).toBeNull();
    expect(stageFor(h.events, "Team sync.m4a").at(-1)).toContain("the room was closed");
    expect(getRecMeta(h.db, id)).toBeNull();
  });

  it("refuses to write into a room that was ROLLED BACK while it ran", async () => {
    // A checkpoint rollback closes and reopens the room AT THE SAME PATH, so a
    // path-only pin reads it as "nothing happened" and lands the rebuild on the
    // restored database. `roomManager.ts` bumps `roomEpoch` for exactly this,
    // and every other writer that defers a write across an await checks it.
    const h = harness();
    const id = addMedia(h.db);
    await listenOn((req, res) => {
      req.resume();
      req.on("end", () => {
        h.state.roomEpoch += 1;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ kind: "done", meta: wireMeta(), neural: true })}\n`);
      });
    });
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);

    expect(await transcribeMediaWithSpeakers(h.deps, id)).toBeNull();
    expect(stageFor(h.events, "Team sync.m4a").at(-1)).toContain("the room was closed");
    expect(getRecMeta(h.db, id)).toBeNull();
    // …and the other half is untouched too: no half-written transcript.
    expect(getFileExtractedText(h.db, id) ?? "").toBe("");
  });

  it("holds the retranscribing guard for the life of the job and releases it after", async () => {
    const h = harness();
    const id = addMedia(h.db);
    let duringJob: boolean | undefined;
    await listenOn((req, res) => {
      req.resume();
      req.on("end", () => {
        // Observed from inside the request, i.e. while the job is awaiting.
        duringJob = isRetranscribing(id);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ kind: "done", meta: wireMeta(), neural: true })}\n`);
      });
    });
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);

    expect(isRetranscribing(id)).toBe(false);
    await transcribeMediaWithSpeakers(h.deps, id);
    expect(duringJob).toBe(true);
    // Released even though the job succeeded — a claim that outlives its job
    // locks the file's transcript editing for the rest of the app run.
    expect(isRetranscribing(id)).toBe(false);
  });

  it("keeps the old transcript in History", async () => {
    const h = harness();
    const id = addMedia(h.db);
    setRecMeta(h.db, id, JSON.stringify({ ...defaultRecMeta(), durationCs: 7 }));
    h.db.prepare("UPDATE files SET extracted_text = ? WHERE id = ?").run("(live recording)\n[0:00] You: old\n", id);
    await ndjsonSidecar([{ kind: "done", meta: wireMeta(), neural: true }]);

    await transcribeMediaWithSpeakers(h.deps, id);

    const versions = h.db
      .prepare("SELECT cause, text, rec_meta FROM file_versions WHERE file_id = ?")
      .all(id) as Array<{ cause: string; text: string | null; rec_meta: string | null }>;
    const snapshot = versions.find((v) => v.cause === "Re-transcribed");
    expect(snapshot).toBeDefined();
    expect(snapshot!.text).toContain("old");
    // The snapshot is compound: restoring bytes alone could never bring the old
    // words, speakers or cuts back.
    expect(JSON.parse(snapshot!.rec_meta!).durationCs).toBe(7);
  });

  it("does NOT spend a History version on a file that had no transcript", async () => {
    // A History entry copies the file's WHOLE bytes. This lane now runs over
    // imports and downloads, so an unconditional snapshot would duplicate a
    // two-hour video inside the room the first time anyone pressed Transcribe
    // — to preserve an empty transcript. RecordingView's own toast draws the
    // same line ("Transcript written from the audio", no History promise).
    const h = harness();
    const id = addMedia(h.db);
    await ndjsonSidecar([{ kind: "done", meta: wireMeta(), neural: true }]);

    expect(await transcribeMediaWithSpeakers(h.deps, id)).not.toBeNull();

    const versions = h.db
      .prepare("SELECT cause FROM file_versions WHERE file_id = ?")
      .all(id) as Array<{ cause: string }>;
    expect(versions).toEqual([]);
    // …and the transcript itself still landed.
    expect(getRecMeta(h.db, id)).not.toBeNull();
  });
});
