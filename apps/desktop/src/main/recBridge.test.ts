/**
 * Tests for `recBridge.ts`.
 *
 * Transport is faked (`sidecarPost`/`connectHostWs`/`readSpoolFrame`) but every
 * DB write runs against a REAL `.roomai` room via `createRoom`, matching this
 * migration's `db-host` convention — plus a real `http.Server` for the wire
 * bodies themselves, so the exact JSON `session_ws.py`'s request models expect
 * is pinned by something other than the fake that produced it.
 *
 * `correctWords`/`reflowAfterCuts` cases are drawn from the edges
 * `recording_cmds.rs`'s own commands guard (a cut spanning a chapter, a legacy
 * segment with no word timings, an uneven token count against the old span);
 * the Rust source exercises both only through the full commands.
 */

import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { getFileBytes, getFileExtractedText, getFileName, insertFile } from "./db-host/files.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { enrollVoice, knownVoices, savedVoices } from "./db-host/voices.js";
import {
  decodeWav,
  defaultRecMeta,
  encodeWav,
  type RecMeta,
  type RecSegment,
  type RecWord,
  type VoicePrint,
} from "./recFormat.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  RecControlError,
  attachHostWs,
  buildTranslatePrompt,
  buildTranslatedDocument,
  coerceRecMeta,
  correctWords,
  createRecBridgeCtx,
  decryptSpoolFrame,
  handlePersistRequest,
  noteLiveSessionEnded,
  parseRecMeta,
  readSpoolFrame,
  recChapterAdd,
  recChapterSet,
  recCorrectRange,
  recDeleteRange,
  recExportClean,
  recGet,
  recHighlightAdd,
  recHostWsUrl,
  recItemDelete,
  recLiveStatus,
  recNoteAdd,
  recNoteSet,
  recPause,
  recPushAudio,
  recReadStart,
  recResume,
  recRetranscribe,
  recSetLiveStt,
  recSetLiveTranslate,
  recSetSpeakerName,
  recStart,
  recStop,
  recTranslate,
  reconcileTranslatedBatch,
  recordingStamp,
  reflowAfterCuts,
  sidecarPostAt,
  translatableLines,
  voiceForget,
  voicesList,
  type HostWsLike,
  type PersistRequest,
  type RecBridgeCtx,
  type RecBridgeDeps,
} from "./recBridge.js";

// --------------------------------------------------------------- fixtures

let tmpDir: string;
let server: http.Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

let roomPath = "";

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "recBridge-"));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function makeCtx(db: Database.Database | null, overrides: Partial<RecBridgeDeps> = {}): RecBridgeCtx {
  return createRecBridgeCtx({
    currentRoom: (): OpenRoom | null => (db === null ? null : { db, path: roomPath }),
    resolveSttModel: () => "/models/whisper.bin",
    spoolDir: () => tmpDir,
    sessionWsUrl: async (fileId) => `ws://127.0.0.1/rec/session?token=test&fileId=${fileId}`,
    ...overrides,
  });
}

function fakePost(
  handlers: Record<string, (body: unknown) => { status: number; json: unknown }>
): ((path: string, body: unknown) => Promise<{ status: number; json: unknown }>) & {
  calls: Array<{ path: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fn = async (p: string, body: unknown): Promise<{ status: number; json: unknown }> => {
    calls.push({ path: p, body: body as Record<string, unknown> });
    const handler = handlers[p];
    if (handler === undefined) {
      throw new Error(`fakePost: no handler registered for ${p}`);
    }
    return handler(body);
  };
  return Object.assign(fn, { calls });
}

function ok(json: Record<string, unknown> = {}): { status: number; json: unknown } {
  return { status: 200, json: { ok: true, ...json } };
}

function fakeHostWs(): HostWsLike & { sent: string[]; closed: boolean } {
  const ws = {
    sent: [] as string[],
    closed: false,
    onMessage: null as ((data: string) => void) | null,
    onClose: null as (() => void) | null,
    send: (data: string): void => {
      ws.sent.push(data);
    },
    close: (): void => {
      ws.closed = true;
    },
  };
  return ws;
}

function addRecording(db: Database.Database, name: string, meta: RecMeta): string {
  const file = insertFile(db, name, "audio/wav", encodeWav(new Float32Array(0)), "(live recording)\n", "recording");
  setRecMeta(db, file.id, JSON.stringify(meta));
  return file.id;
}

function word(w: string, t0: number, t1: number, del = false): RecWord {
  return { w, t0, t1, del };
}

function phrase(words: RecWord[], over: Partial<RecSegment> = {}): RecSegment {
  return {
    id: randomUUID(),
    source: "mic",
    speaker: "You",
    t0: words[0]?.t0 ?? 0,
    t1: words[words.length - 1]?.t1 ?? 0,
    text: words.map((w) => w.w).join(" "),
    words,
    lang: null,
    voice: null,
    ...over,
  };
}

/** A NEURAL-width (192-dim) voiceprint in the SHAPE THE WIRE USES — Rust's
 * `#[serde(rename = "v"/"f")]` on `diarize::VoicePrint`. Every real segment,
 * from an existing room or from the sidecar's `RecMeta.to_dict()`, carries
 * exactly these two keys. */
function voicePrint(dir: number, tilt: number, frames: number): VoicePrint {
  const v = new Array<number>(192).fill(0);
  v[dir] = 1;
  v[191] = tilt;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return { v: v.map((x) => x / norm), f: frames };
}

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

// ============================================================ meta parsing

describe("parseRecMeta", () => {
  it("no row is not damage; a damaged row is, and never a silent empty transcript", () => {
    expect(parseRecMeta(null).durationCs).toBe(0);
    expect(parseRecMeta('{"durationCs":900,"segments":[],"cuts":[]}').durationCs).toBe(900);

    // Rust's own `unreadable_meta_is_an_error_not_an_empty_transcript` cases.
    for (const damaged of ["", "{", "not json at all", '{"durationCs":"soon"}']) {
      expect(() => parseRecMeta(damaged)).toThrowError(/can't be read/);
    }
    // …and the shapes a bare `JSON.parse(x) as RecMeta` would wave through into
    // a TypeError three frames later. `durationCs`/`segments`/`cuts` carry no
    // `#[serde(default)]` in Rust, so serde refuses these too.
    for (const damaged of ["null", "123", '"a string"', "[]", '{"foo":1}', '{"durationCs":1,"segments":{}}']) {
      expect(() => parseRecMeta(damaged)).toThrowError(/can't be read/);
    }
    expect(() => parseRecMeta("{")).toThrowError(/History/); // must say how to get it back
  });

  it("defaults every optional field, exactly like serde(default)", () => {
    const meta = parseRecMeta('{"durationCs":5,"segments":[],"cuts":[]}');
    expect(meta).toEqual({ ...defaultRecMeta(), durationCs: 5 });
  });

  it("coerceRecMeta accepts the already-parsed object /rec/edit_meta answers with", () => {
    expect(coerceRecMeta({ durationCs: 42, segments: [], cuts: [] }).durationCs).toBe(42);
    expect(() => coerceRecMeta({ segments: [], cuts: [] })).toThrowError(/durationCs/);
  });
});

// ============================================== control POST, over real HTTP

describe("control POSTs (real HTTP server)", () => {
  it("recStart posts the exact camelCase body session_ws.py's StartSessionRequest reads", async () => {
    const db = freshRoom();
    let seen: Record<string, unknown> = {};
    const base = await listenOn((req, res) => {
      void readJsonBody(req).then((body) => {
        seen = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, fileId: body.fileId, spoolKey: "a2V5", spoolPath: "/tmp/x.spool" }));
      });
    });
    const ctx = makeCtx(db, {
      sidecarPost: (p, body) => sidecarPostAt(base, p, body),
      connectHostWs: () => fakeHostWs(),
      diarizeModelPath: () => "/models/titanet.onnx",
    });
    await recStart(db, ctx, { systemAudio: true, liveTranslate: "  " });

    expect(Object.keys(seen).sort()).toEqual(
      [
        "baseSamples",
        "defaultTranslationModel",
        "diarizeModelPath",
        "fileId",
        "knownVoices",
        "liveTranslate",
        "meta",
        "modelPath",
        "spoolDir",
        "systemAudio",
      ].sort()
    );
    expect(seen.modelPath).toBe("/models/whisper.bin");
    expect(seen.systemAudio).toBe(true);
    expect(seen.baseSamples).toBeNull();
    expect(seen.liveTranslate).toBeNull(); // whitespace-only is "off", not a language
    expect(seen.knownVoices).toEqual([]);
    expect(seen.diarizeModelPath).toBe("/models/titanet.onnx");
    // `baseUrl` is omitted entirely when unset so the sidecar's own default
    // applies, rather than being overridden with null.
    expect("baseUrl" in seen).toBe(false);
  });

  it("maps a non-2xx to a RecControlError carrying the sidecar's own code", async () => {
    const db = freshRoom();
    const base = await listenOn((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "A recording is already in progress.", code: "REC_ALREADY_LIVE" }));
    });
    const ctx = makeCtx(db, { sidecarPost: (p, body) => sidecarPostAt(base, p, body) });
    await expect(recStart(db, ctx, { systemAudio: false })).rejects.toMatchObject({
      code: "REC_ALREADY_LIVE",
      message: "A recording is already in progress.",
    });
  });

  it("recHostWsUrl carries the token and file id on the query string, ws-scheme", () => {
    expect(recHostWsUrl("http://127.0.0.1:8123", "f 1", "tok/en")).toBe(
      "ws://127.0.0.1:8123/rec/host?token=tok%2Fen&fileId=f%201"
    );
  });
});

// ================================================================= recStart

describe("recStart", () => {
  it("creates a fresh recording file, tracks the live session, and attaches the host WS", async () => {
    const db = freshRoom();
    const post = fakePost({ "/rec/start": () => ok({ spoolKey: "a2V5", spoolPath: "/tmp/f.spool" }) });
    const ws = fakeHostWs();
    let notified = 0;
    const ctx = makeCtx(db, {
      sidecarPost: post,
      connectHostWs: () => ws,
      notifyFilesChanged: () => {
        notified++;
      },
    });

    const started = await recStart(db, ctx, { systemAudio: false });
    expect(started.name).toMatch(/^Recording \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.wav$/);
    expect(started.meta).toEqual(defaultRecMeta());
    expect(getFileName(db, started.fileId)).toBe(started.name);
    expect(getRecMeta(db, started.fileId)).not.toBeNull();
    expect(ctx.state.liveFileId).toBe(started.fileId);
    expect(ctx.state.liveStatus).toBe("recording");
    expect(ctx.state.sessionRoomPath).toBe(roomPath);
    expect(ctx.state.spoolKey?.toString("utf8")).toBe("key");
    expect(ctx.state.hostWs).toBe(ws);
    expect(ws.onMessage).not.toBeNull();
    expect(notified).toBe(1);
  });

  it("names a fresh recording from the local wall clock, Rust's strftime format", () => {
    expect(recordingStamp(new Date(2026, 7, 22, 9, 4))).toBe("2026-08-22 09.04");
  });

  it("refuses with no resolved STT model, and never inserts a file for it", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, { resolveSttModel: () => null });
    await expect(recStart(db, ctx, { systemAudio: false })).rejects.toThrowError("STT_MODEL_MISSING");
    expect(db.prepare("SELECT COUNT(*) FROM files").pluck().get() as number).toBe(0);
  });

  it("refuses a second start, and says something followable while the last one is SAVING", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      sidecarPost: fakePost({ "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }) }),
      connectHostWs: () => fakeHostWs(),
    });
    const started = await recStart(db, ctx, { systemAudio: false });
    await expect(recStart(db, ctx, { systemAudio: false })).rejects.toThrowError(
      `A recording is already running (file ${started.fileId}). Stop it first.`
    );
    // "Stop it first" is an instruction nobody can follow once the engine is
    // saving, so that state gets its own sentence.
    ctx.state.liveStatus = "saving";
    await expect(recStart(db, ctx, { systemAudio: false })).rejects.toThrowError(/still being saved/);
  });

  it("rolls the fresh row back when the sidecar refuses to start", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      sidecarPost: fakePost({
        "/rec/start": () => ({ status: 409, json: { error: "busy", code: "REC_ALREADY_LIVE" } }),
      }),
    });
    await expect(recStart(db, ctx, { systemAudio: false })).rejects.toBeInstanceOf(RecControlError);
    // Nothing will ever reference that row — an empty "Recording ….wav" left in
    // the room is a file the user has to notice and delete by hand.
    expect(db.prepare("SELECT COUNT(*) FROM files").pluck().get() as number).toBe(0);
    expect(ctx.state.liveFileId).toBeNull();
  });

  it("resumes an existing file: rescues checkpoints, decodes base samples, sends the stored meta", async () => {
    const db = freshRoom();
    const meta: RecMeta = { ...defaultRecMeta(), durationCs: 250, segments: [phrase([word("hi", 0, 50)])] };
    const id = addRecording(db, "board meeting.wav", meta);
    const stored = encodeWav(Float32Array.from([0.25, 0.5, -0.25]));
    db.prepare("UPDATE files SET original_bytes = ? WHERE id = ?").run(stored, id);
    db.prepare("INSERT INTO rec_chunks(file_id, seq, pcm) VALUES (?, 1, ?)").run(id, Buffer.from([0, 0x40]));

    const post = fakePost({ "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }) });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });
    const started = await recStart(db, ctx, { fileId: id, systemAudio: false });

    expect(started.fileId).toBe(id);
    expect(started.name).toBe("board meeting.wav");
    expect(started.meta.durationCs).toBe(250);
    // The checkpoint was spliced in BEFORE the read — resuming without the
    // rescue records over that stretch of the meeting.
    expect(db.prepare("SELECT COUNT(*) FROM rec_chunks").pluck().get() as number).toBe(0);
    const body = post.calls[0]?.body as Record<string, unknown>;
    const sent = Buffer.from(body.baseSamples as string, "base64");
    expect(sent.length).toBe(4 * 4); // three stored samples + the recovered one
    expect((body.meta as RecMeta).durationCs).toBe(250);
  });

  it("clears an unrecoverable stale spool after restart and retries Resume once", async () => {
    const db = freshRoom();
    const id = addRecording(db, "interrupted.wav", defaultRecMeta());
    const stale = path.join(tmpDir, `${id}.spool`);
    writeFileSync(stale, "encrypted-with-a-lost-process-key");
    let starts = 0;
    const post = fakePost({
      "/rec/start": () => {
        starts += 1;
        return starts === 1
          ? { status: 409, json: { error: "stale", code: "REC_SPOOL_EXISTS" } }
          : ok({ spoolKey: "", spoolPath: "" });
      },
    });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });

    await expect(recStart(db, ctx, { fileId: id, systemAudio: false })).resolves.toMatchObject({
      fileId: id,
    });
    expect(starts).toBe(2);
    expect(existsSync(stale)).toBe(false);
  });

  it("still starts when the voice table cannot be read — a recording that names nobody beats none", async () => {
    const db = freshRoom();
    db.exec("DROP TABLE voice_ids");
    const post = fakePost({ "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }) });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });
    await expect(recStart(db, ctx, { systemAudio: false })).resolves.toBeTruthy();
    expect((post.calls[0]?.body as Record<string, unknown>).knownVoices).toEqual([]);
  });

  it("sends the room's known voices in KnownVoiceIn's own {name, vec, rejects} shape", async () => {
    const db = freshRoom();
    // Enrolled through the real table, so the shape is whatever the DB layer
    // actually produces rather than a hand-written fixture.
    enrollVoice(db, "Dana", voicePrint(0, 0, 400));
    const post = fakePost({ "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }) });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });
    await recStart(db, ctx, { systemAudio: false });
    const sent = (post.calls[0]?.body as Record<string, unknown>).knownVoices as Array<
      Record<string, unknown>
    >;
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(["name", "rejects", "vec"]);
    expect((sent[0]?.vec as number[]).length).toBe(192);
  });

  it("refuses when no room is open", async () => {
    const db = freshRoom();
    await expect(recStart(db, makeCtx(null), { systemAudio: false })).rejects.toThrowError("No room is open.");
  });
});

// ============================================ pause / resume / stop / status

describe("pause / resume / set_live_* / stop / live status", () => {
  async function live(db: Database.Database, post = fakePost({ "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }) })): Promise<{
    ctx: RecBridgeCtx;
    fileId: string;
    ws: HostWsLike & { sent: string[]; closed: boolean };
  }> {
    const ws = fakeHostWs();
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => ws });
    const started = await recStart(db, ctx, { systemAudio: false });
    return { ctx, fileId: started.fileId, ws };
  }

  it("all refuse when nothing is live", async () => {
    const ctx = makeCtx(freshRoom());
    await expect(recPause(ctx)).rejects.toThrowError("No live recording.");
    await expect(recResume(ctx)).rejects.toThrowError("No live recording.");
    await expect(recSetLiveStt(ctx, true)).rejects.toThrowError("No live recording.");
    await expect(recSetLiveTranslate(ctx, "es")).rejects.toThrowError("No live recording.");
    await expect(recStop(ctx)).rejects.toThrowError("No live recording.");
    await expect(recLiveStatus(ctx)).resolves.toBeNull();
  });

  it("post the plain bodies and track the coarse local status", async () => {
    const db = freshRoom();
    const post = fakePost({
      "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }),
      "/rec/pause": () => ok(),
      "/rec/resume": () => ok(),
      "/rec/set_live_stt": () => ok(),
      "/rec/set_live_translate": () => ok(),
    });
    const { ctx, fileId } = await live(db, post);

    await recPause(ctx);
    await expect(recLiveStatus(ctx)).resolves.toEqual({
      fileId,
      status: "paused",
      sessionUrl: `ws://127.0.0.1/rec/session?token=test&fileId=${fileId}`,
    });
    await recResume(ctx);
    await expect(recLiveStatus(ctx)).resolves.toEqual({
      fileId,
      status: "recording",
      sessionUrl: `ws://127.0.0.1/rec/session?token=test&fileId=${fileId}`,
    });
    await recSetLiveStt(ctx, false);
    await recSetLiveTranslate(ctx, "es");
    await recSetLiveTranslate(ctx, "   "); // whitespace-only turns it OFF

    expect(post.calls.slice(1)).toEqual([
      { path: "/rec/pause", body: { fileId } },
      { path: "/rec/resume", body: { fileId } },
      { path: "/rec/set_live_stt", body: { fileId, on: false } },
      { path: "/rec/set_live_translate", body: { fileId, lang: "es" } },
      { path: "/rec/set_live_translate", body: { fileId, lang: null } },
    ]);
  });

  it("stop returns the final meta and releases the session — including when the save FAILED", async () => {
    const db = freshRoom();
    let calls = 0;
    const post = fakePost({
      "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }),
      "/rec/stop": () => {
        calls++;
        return calls === 1
          ? ok({ meta: { ...defaultRecMeta(), durationCs: 700 } })
          : { status: 502, json: { error: "the disk is full", code: "REC_SAVE_FAILED" } };
      },
    });
    const first = await live(db, post);
    expect((await recStop(first.ctx)).durationCs).toBe(700);
    expect(first.ctx.state.liveFileId).toBeNull();
    expect(first.ws.closed).toBe(true);

    // A failed stop still ends the session slot server-side, so believing a
    // recording is live afterwards would refuse every later start for ever.
    const second = await live(db, post);
    await expect(recStop(second.ctx)).rejects.toMatchObject({ code: "REC_SAVE_FAILED" });
    expect(second.ctx.state.liveFileId).toBeNull();
  });

  it("noteLiveSessionEnded clears only the matching, still-current session", async () => {
    const db = freshRoom();
    const { ctx, fileId } = await live(db);
    noteLiveSessionEnded(ctx, "some-other-file");
    expect(ctx.state.liveFileId).toBe(fileId);
    noteLiveSessionEnded(ctx, fileId);
    expect(ctx.state.liveFileId).toBeNull();
    expect(() => noteLiveSessionEnded(ctx, fileId)).not.toThrow(); // idempotent
  });
});

// ================================================= WS /rec/host persist path

describe("handlePersistRequest", () => {
  interface Live {
    db: Database.Database;
    ctx: RecBridgeCtx;
    fileId: string;
    reads: Array<readonly [number, number]>;
  }

  function liveSession(payload: Buffer | (() => Buffer), overrides: Partial<RecBridgeDeps> = {}): Live {
    const db = freshRoom();
    const reads: Array<readonly [number, number]> = [];
    const ctx = makeCtx(db, {
      readSpoolFrame: async (_p, range) => {
        reads.push(range);
        return typeof payload === "function" ? payload() : payload;
      },
      ...overrides,
    });
    const fileId = addRecording(db, "call.wav", defaultRecMeta());
    ctx.state.liveFileId = fileId;
    ctx.state.sessionRoomPath = roomPath;
    ctx.state.spoolPath = "/tmp/unused.spool";
    ctx.state.spoolKey = Buffer.alloc(32);
    return { db, ctx, fileId, reads };
  }

  function req(over: Partial<PersistRequest>): PersistRequest {
    return {
      reqId: "r1",
      kind: "checkpoint",
      fromSample: 0,
      toSample: 0,
      spoolRange: null,
      metaJson: JSON.stringify({ ...defaultRecMeta(), durationCs: 300 }),
      text: "(live recording)\nhello\n",
      ...over,
    };
  }

  function chunkCount(db: Database.Database, id: string): number {
    return db.prepare("SELECT COUNT(*) FROM rec_chunks WHERE file_id = ?").pluck().get(id) as number;
  }

  it("checkpoint: appends the decrypted PCM and refreshes text + meta, in one transaction", async () => {
    const pcm = Buffer.alloc(8);
    pcm.writeFloatLE(0.5, 0);
    pcm.writeFloatLE(-0.5, 4);
    const { db, ctx, fileId, reads } = liveSession(pcm);
    const ack = await handlePersistRequest(ctx, req({ spoolRange: [0, 40] }));
    expect(ack).toEqual({ reqId: "r1", ok: true });
    expect(reads).toEqual([[0, 40]]);
    expect(chunkCount(db, fileId)).toBe(1);
    expect(getFileExtractedText(db, fileId)).toBe("(live recording)\nhello\n");
    expect(JSON.parse(getRecMeta(db, fileId) as string).durationCs).toBe(300);
  });

  it("checkpoint with no spoolRange appends nothing but still refreshes text + meta", async () => {
    const { db, ctx, fileId, reads } = liveSession(Buffer.alloc(0));
    expect(await handlePersistRequest(ctx, req({}))).toEqual({ reqId: "r1", ok: true });
    expect(reads).toEqual([]);
    expect(chunkCount(db, fileId)).toBe(0);
    expect(getFileExtractedText(db, fileId)).toBe("(live recording)\nhello\n");
  });

  it("full: finalizes the WAV from the spool and then writes the meta, clearing the checkpoints", async () => {
    const wav = encodeWav(Float32Array.from([0.25, 0.5]));
    const { db, ctx, fileId } = liveSession(wav);
    db.prepare("INSERT INTO rec_chunks(file_id, seq, pcm) VALUES (?, 1, ?)").run(fileId, Buffer.alloc(4));
    const ack = await handlePersistRequest(ctx, req({ kind: "full", spoolRange: [0, 100], text: "final\n" }));
    expect(ack).toEqual({ reqId: "r1", ok: true });
    expect(getFileBytes(db, fileId)?.equals(wav)).toBe(true);
    expect(getFileExtractedText(db, fileId)).toBe("final\n");
    // A complete WAV whose checkpoints survived gets spliced onto itself by the
    // next crash recovery.
    expect(chunkCount(db, fileId)).toBe(0);
    expect(JSON.parse(getRecMeta(db, fileId) as string).durationCs).toBe(300);
  });

  it("full with no spoolRange is a FAILED ack, not an exception past this boundary", async () => {
    const { ctx } = liveSession(Buffer.alloc(0));
    expect(await handlePersistRequest(ctx, req({ kind: "full" }))).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("transcript: text + meta only, and no spool read at all", async () => {
    const { db, ctx, fileId, reads } = liveSession(Buffer.alloc(0));
    const before = getFileBytes(db, fileId);
    expect(await handlePersistRequest(ctx, req({ kind: "transcript", spoolRange: [0, 40] }))).toEqual({
      reqId: "r1",
      ok: true,
    });
    // The engine is paused: the audio is already durable and cannot have grown.
    expect(reads).toEqual([]);
    expect(getFileBytes(db, fileId)?.equals(before as Buffer)).toBe(true);
    expect(getFileExtractedText(db, fileId)).toBe("(live recording)\nhello\n");
  });

  it('answers "closed" — with no DB write attempted — when no room is open, or a DIFFERENT one is', async () => {
    // Rust's own `_ => Err(None)` arm: `Some(room) if room.path ==
    // self.cfg.room_path` is the ONLY arm that writes.
    const noRoom = liveSession(Buffer.alloc(0), { currentRoom: () => null });
    expect(await handlePersistRequest(noRoom.ctx, req({}))).toEqual({
      reqId: "r1",
      ok: false,
      reason: "closed",
      message: "The room closed — recording stopped.",
    });
    expect(getFileExtractedText(noRoom.db, noRoom.fileId)).toBe("(live recording)\n");

    const switched = liveSession(Buffer.alloc(0));
    switched.ctx.state.sessionRoomPath = "/somewhere/else.roomai";
    expect(await handlePersistRequest(switched.ctx, req({}))).toMatchObject({ reason: "closed" });
    expect(getFileExtractedText(switched.db, switched.fileId)).toBe("(live recording)\n");
  });

  it('answers "failed", NEVER "closed", for a real write error against the correct open room', async () => {
    // A wrong "closed" here makes Engine.flush end the recording quietly and
    // abandon the un-flushed tail; "failed" is retried, which is what a full
    // disk or a bad decrypt deserves.
    const decryptFails = liveSession(() => {
      throw new Error("auth tag mismatch");
    });
    expect(await handlePersistRequest(decryptFails.ctx, req({ spoolRange: [0, 40] }))).toEqual({
      reqId: "r1",
      ok: false,
      reason: "failed",
      message: "auth tag mismatch",
    });

    const { db, ctx } = liveSession(Buffer.alloc(0));
    db.exec("DROP TABLE recordings");
    expect(await handlePersistRequest(ctx, req({}))).toMatchObject({ ok: false, reason: "failed" });
  });

  it("a TRANSIENT DB failure is answered so the sidecar RETRIES, and the retry lands", async () => {
    // The failure that matters most is the recoverable one — a full disk that
    // gets emptied, a moment of read-only. `session_ws.py` §3: "failed" is
    // retried, "closed" makes `Engine.flush` end the session QUIETLY and
    // abandon the un-flushed tail. So answering a passing write error with
    // "closed" throws away every phrase since the last checkpoint, on a room
    // that never closed.
    const { db, ctx, fileId } = liveSession(Buffer.alloc(0));
    db.pragma("query_only = ON"); // every write fails; nothing else changes
    const during = await handlePersistRequest(ctx, req({ text: "during the outage\n" }));
    expect(during).toMatchObject({ ok: false, reason: "failed" });
    expect((during as { message: string }).message).toMatch(/readonly/);
    // The room is still open and still THIS session's, so nothing may have been
    // torn down by the answer.
    expect(ctx.state.liveFileId).toBe(fileId);
    expect(ctx.deps.currentRoom()?.path).toBe(ctx.state.sessionRoomPath);

    db.pragma("query_only = OFF");
    expect(
      await handlePersistRequest(ctx, req({ reqId: "r2", text: "after it cleared\n" }))
    ).toEqual({ reqId: "r2", ok: true });
    // The retry wrote the whole dirty tail, exactly as the "failed" ack promised.
    expect(getFileExtractedText(db, fileId)).toBe("after it cleared\n");
  });

  it("an unknown kind is a failed ack, never a crash", async () => {
    const { ctx } = liveSession(Buffer.alloc(0));
    const ack = await handlePersistRequest(ctx, req({ kind: "sideways" as PersistRequest["kind"] }));
    expect(ack).toMatchObject({ ok: false, reason: "failed" });
    expect((ack as { message: string }).message).toMatch(/Unknown persist kind/);
  });

  it('a persist arriving with no live session is "closed" — the session it named is over', async () => {
    const { ctx } = liveSession(Buffer.alloc(0));
    ctx.state.liveFileId = null;
    expect(await handlePersistRequest(ctx, req({}))).toMatchObject({ reason: "closed" });
  });
});

describe("attachHostWs", () => {
  it("dispatches an incoming request and sends the ack back on the same socket", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const fileId = addRecording(db, "call.wav", defaultRecMeta());
    ctx.state.liveFileId = fileId;
    ctx.state.sessionRoomPath = roomPath;
    const ws = fakeHostWs();
    attachHostWs(ctx, ws);

    ws.onMessage?.(
      JSON.stringify({
        reqId: "abc",
        kind: "transcript",
        fromSample: null,
        toSample: null,
        spoolRange: null,
        metaJson: JSON.stringify(defaultRecMeta()),
        text: "words\n",
      })
    );
    await new Promise((r) => setImmediate(r));
    expect(ws.sent).toEqual([JSON.stringify({ reqId: "abc", ok: true })]);
    expect(getFileExtractedText(db, fileId)).toBe("words\n");
  });

  it("drops a malformed frame silently — no ack to send, and never a dead socket", async () => {
    const ctx = makeCtx(freshRoom());
    const ws = fakeHostWs();
    attachHostWs(ctx, ws);
    ws.onMessage?.("not json");
    ws.onMessage?.("[]");
    ws.onMessage?.(JSON.stringify({ kind: "checkpoint" })); // no reqId to answer with
    await new Promise((r) => setImmediate(r));
    expect(ws.sent).toEqual([]);
  });

  it("keeps the session but releases the handle when the socket drops", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      sidecarPost: fakePost({ "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }) }),
      connectHostWs: () => ws,
    });
    const ws = fakeHostWs();
    const started = await recStart(db, ctx, { systemAudio: false });
    ws.onClose?.();
    // "Electron reconnecting is not the room closing" (session_ws.py §3) — the
    // sidecar keeps the session and retries, so clearing it here would strand a
    // live recording with no way to stop it.
    expect(ctx.state.liveFileId).toBe(started.fileId);
    expect(ctx.state.hostWs).toBeNull();
  });
});

describe("the spool file", () => {
  /** Exactly `SpoolWriter.append`'s on-disk frame. */
  function frame(plaintext: Buffer, key: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(nonce.length + body.length, 0);
    return Buffer.concat([len, nonce, body]);
  }

  it("decrypts a frame written the way SpoolWriter.append writes it", () => {
    const key = randomBytes(32);
    const plain = Buffer.from("the meeting audio");
    expect(decryptSpoolFrame(frame(plain, key), key).equals(plain)).toBe(true);
  });

  it("throws on a wrong key rather than returning garbage", () => {
    const key = randomBytes(32);
    expect(() => decryptSpoolFrame(frame(Buffer.from("x"), key), randomBytes(32))).toThrow();
  });

  it("refuses a range that does not line up with a frame boundary", () => {
    const key = randomBytes(32);
    const f = frame(Buffer.from("hello"), key);
    // One byte short: the declared length no longer matches what was read, so
    // this fails loudly instead of feeding GCM a shifted window.
    expect(() => decryptSpoolFrame(f.subarray(0, f.length - 1), key)).toThrowError(/length mismatch/);
    expect(() => decryptSpoolFrame(Buffer.alloc(2), key)).toThrowError(/length prefix/);
  });

  it("readSpoolFrame reads the exact byte range of the SECOND of two frames", async () => {
    freshRoom();
    const key = randomBytes(32);
    const first = frame(Buffer.from("first chunk"), key);
    const second = frame(Buffer.from("second chunk"), key);
    const spoolPath = path.join(tmpDir, "session.spool");
    writeFileSync(spoolPath, Buffer.concat([first, second]));
    const range: [number, number] = [first.length, first.length + second.length];
    expect((await readSpoolFrame(spoolPath, range, key)).toString()).toBe("second chunk");
  });

  it("readSpoolFrame refuses a short read rather than decrypting a truncated frame", async () => {
    freshRoom();
    const key = randomBytes(32);
    const f = frame(Buffer.from("only frame"), key);
    const spoolPath = path.join(tmpDir, "short.spool");
    writeFileSync(spoolPath, f.subarray(0, f.length - 3)); // a hard-killed sidecar
    await expect(readSpoolFrame(spoolPath, [0, f.length], key)).rejects.toThrowError(/short/);
    await expect(readSpoolFrame(spoolPath, [0, 0], key)).rejects.toThrowError(/empty/);
  });
});

// ============================================================== annotations

describe("edit ops — offline path (direct DB)", () => {
  it("round-trips notes, chapters and highlights through the room and the transcript", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = addRecording(db, "call.wav", {
      ...defaultRecMeta(),
      durationCs: 1000,
      segments: [phrase([word("hello", 0, 50)], { speaker: "Speaker 1" })],
    });

    let meta = await recNoteAdd(db, ctx, id, 100, "action", "  send the deck  ", " Dana ");
    expect(meta.notes).toHaveLength(1);
    expect(meta.notes[0]).toMatchObject({ t0: 100, kind: "action", text: "send the deck", who: "Dana", by: "you" });
    meta = await recNoteSet(db, ctx, id, meta.notes[0]?.id as string, "send the slides");
    expect(meta.notes[0]?.text).toBe("send the slides");

    meta = await recChapterAdd(db, ctx, id, 200, "Wrap up");
    meta = await recChapterSet(db, ctx, id, meta.chapters[0]?.id as string, "Closing");
    expect(meta.chapters[0]).toMatchObject({ t0: 200, title: "Closing", by: "you" });

    meta = await recHighlightAdd(db, ctx, id, 300, 250); // t1 before t0 marks the instant
    expect(meta.highlights[0]).toMatchObject({ t0: 300, t1: 300 });

    // Every path refreshes the searchable transcript, so what search and the AI
    // read can never drift from what the screen shows.
    expect(getFileExtractedText(db, id)).toContain("Action (Dana): send the slides");
    expect(recGet(db, id).meta.notes).toHaveLength(1);

    meta = await recItemDelete(db, ctx, id, "note", meta.notes[0]?.id as string);
    expect(meta.notes).toHaveLength(0);
    await expect(recItemDelete(db, ctx, id, "chapter", "nope")).rejects.toThrowError(/no longer in this recording/);
    await expect(
      recItemDelete(db, ctx, id, "sideways" as "note", "x")
    ).rejects.toThrowError(/Unknown item kind "sideways"/);
  });

  it("NORMALIZES an unknown note kind to a point instead of storing it verbatim", async () => {
    // Rust's `match kind.trim() { … _ => NoteKind::Point }`. IPC arguments are
    // whatever the renderer sent, so an unknown kind reaching the stored meta
    // would render as a label no reader has ever seen — and round-trip into a
    // Rust `RecMeta` that refuses to deserialize it at all.
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = addRecording(db, "call.wav", { ...defaultRecMeta(), durationCs: 500 });
    const meta = await recNoteAdd(db, ctx, id, 0, "URGENT", "look at this");
    expect(meta.notes[0]?.kind).toBe("point");
    expect(getFileExtractedText(db, id)).toContain("Point: look at this");
  });

  it("refuses empty text, an unknown id, and a moment outside the recording", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = addRecording(db, "call.wav", { ...defaultRecMeta(), durationCs: 500 });
    await expect(recNoteAdd(db, ctx, id, 0, "point", "   ")).rejects.toThrowError("A note needs some words.");
    await expect(recChapterAdd(db, ctx, id, 0, "  ")).rejects.toThrowError("A chapter needs a name.");
    await expect(recNoteAdd(db, ctx, id, 900, "point", "late")).rejects.toThrowError(
      "That moment is outside this recording."
    );
    await expect(recNoteAdd(db, ctx, id, -1, "point", "early")).rejects.toThrowError(
      "That moment is outside this recording."
    );
    await expect(recNoteSet(db, ctx, id, "nope", "x")).rejects.toThrowError(/no longer in this recording/);
    await expect(recChapterSet(db, ctx, id, "nope", "x")).rejects.toThrowError(/no longer in this recording/);
  });

  it("caps a pasted note at 400 CODE POINTS, not UTF-16 units", () => {
    // `[...s].slice(cap)` is what Rust's `.chars().take(cap)` counts. A plain
    // `String.slice` would cut an astral character in half at the boundary.
    return (async (): Promise<void> => {
      const db = freshRoom();
      const ctx = makeCtx(db);
      const id = addRecording(db, "call.wav", { ...defaultRecMeta(), durationCs: 500 });
      const meta = await recNoteAdd(db, ctx, id, 0, "point", "🎧".repeat(500));
      expect([...(meta.notes[0]?.text ?? "")]).toHaveLength(400);
      expect(meta.notes[0]?.text.endsWith("🎧")).toBe(true);
    })();
  });
});

describe("edit ops — live path (routed to /rec/edit_meta)", () => {
  it("posts the exact op body and never writes the DB directly", async () => {
    const db = freshRoom();
    const returned = { ...defaultRecMeta(), durationCs: 4200 };
    const post = fakePost({
      "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }),
      "/rec/edit_meta": () => ok({ meta: returned }),
    });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });
    const started = await recStart(db, ctx, { systemAudio: false });
    const before = getRecMeta(db, started.fileId);

    const meta = await recNoteAdd(db, ctx, started.fileId, 900_000, "decision", "we ship Thursday");
    expect(meta.durationCs).toBe(4200);
    // `Engine::flush` writes the engine's own meta over this row every few
    // phrases, so a direct write here would be erased seconds later in silence.
    expect(getRecMeta(db, started.fileId)).toBe(before);
    expect(post.calls[1]).toEqual({
      path: "/rec/edit_meta",
      body: {
        fileId: started.fileId,
        op: "add_note",
        t0: 900_000,
        kind: "decision",
        text: "we ship Thursday",
        who: null,
      },
    });
    // And the routed answer becomes the snapshot the next live rename reads.
    expect(ctx.state.lastMeta?.durationCs).toBe(4200);
  });

  it("routes every other op with the field names EditMetaRequest declares", async () => {
    const db = freshRoom();
    const post = fakePost({
      "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }),
      "/rec/edit_meta": () => ok({ meta: defaultRecMeta() }),
    });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });
    const { fileId } = await recStart(db, ctx, { systemAudio: false });
    await recNoteSet(db, ctx, fileId, "n1", "retyped");
    await recChapterAdd(db, ctx, fileId, 10, "Intro");
    await recChapterSet(db, ctx, fileId, "c1", "Opening");
    await recHighlightAdd(db, ctx, fileId, 10, 20);
    await recItemDelete(db, ctx, fileId, "highlight", "h1");

    expect(post.calls.slice(1).map((c) => c.body)).toEqual([
      { fileId, op: "set_note", noteId: "n1", text: "retyped" },
      { fileId, op: "add_chapter", t0: 10, title: "Intro" },
      { fileId, op: "set_chapter", chapterId: "c1", title: "Opening" },
      { fileId, op: "add_highlight", t0: 10, t1: 20 },
      { fileId, op: "delete_item", itemKind: "highlight", itemId: "h1" },
    ]);
  });

  it("surfaces the sidecar's own refusal, with its code", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      sidecarPost: fakePost({
        "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }),
        "/rec/edit_meta": () => ({
          status: 400,
          json: { error: "That moment is outside this recording.", code: "REC_EDIT_META_FAILED" },
        }),
      }),
      connectHostWs: () => fakeHostWs(),
    });
    const { fileId } = await recStart(db, ctx, { systemAudio: false });
    await expect(recNoteAdd(db, ctx, fileId, 5, "point", "x")).rejects.toMatchObject({
      code: "REC_EDIT_META_FAILED",
      message: "That moment is outside this recording.",
    });
  });
});

// ================================================ speaker naming + enrolment

describe("recSetSpeakerName", () => {
  function withSpeaker(db: Database.Database, over: Partial<RecMeta> = {}): string {
    return addRecording(db, "call.wav", {
      ...defaultRecMeta(),
      durationCs: 1000,
      segments: [
        phrase([word("hello", 0, 50)], { speaker: "Speaker 1", voice: voicePrint(0, 0, 400) }),
        phrase([word("hi", 60, 90)], { speaker: "Speaker 2" }),
      ],
      ...over,
    });
  }

  it("renames every line at once as an OVERLAY, and an empty name restores the label", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = withSpeaker(db);

    let meta = await recSetSpeakerName(db, ctx, id, " Speaker 1 ", "  Dana  ");
    expect(meta.speakerNames).toEqual({ "Speaker 1": "Dana" });
    // Not baked into the segments — re-clustering rewrites labels freely.
    expect(meta.segments[0]?.speaker).toBe("Speaker 1");
    expect(getFileExtractedText(db, id)).toContain("Dana: hello");

    meta = await recSetSpeakerName(db, ctx, id, "Speaker 1", "   ");
    expect(meta.speakerNames).toEqual({});
    // Naming someone back to their machine label is a removal, not an entry
    // that shadows itself.
    meta = await recSetSpeakerName(db, ctx, id, "Speaker 1", "Speaker 1");
    expect(meta.speakerNames).toEqual({});
  });

  it("refuses no speaker, a recording with no transcript, and a label nobody carries", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = withSpeaker(db);
    await expect(recSetSpeakerName(db, ctx, id, "  ", "Dana")).rejects.toThrowError("No speaker selected.");
    await expect(recSetSpeakerName(db, ctx, id, "Speaker 9", "Dana")).rejects.toThrowError(
      'Nobody in this recording is labelled "Speaker 9".'
    );
    const empty = addRecording(db, "silent.wav", defaultRecMeta());
    await expect(recSetSpeakerName(db, ctx, empty, "Speaker 1", "Dana")).rejects.toThrowError(
      "That recording has no transcript yet."
    );
  });

  it("TEACHES the room the voice, reading the {v, f} shape every real segment carries", async () => {
    // The wire shape is `#[serde(rename = "v"/"f")]` on diarize::VoicePrint. A
    // port that spelled the fields {vec, voicedFrames} reads undefined off every
    // real segment, and the rename that carried it throws.
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = withSpeaker(db);
    await recSetSpeakerName(db, ctx, id, "Speaker 1", "Dana");
    expect(savedVoices(db).map((v) => v.name)).toEqual(["Dana"]);
    expect(knownVoices(db)[0]?.vec).toHaveLength(192);
    expect(voicesList(db).map((v) => v.name)).toEqual(["Dana"]);
    expect(voiceForget(db, "Dana")).toEqual([]);
  });

  it("learns nothing from a voice with too little speech behind it", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    // Strong enough to be labelled, far too thin to recognise anyone by later.
    const id = withSpeaker(db, {
      segments: [phrase([word("hi", 0, 50)], { speaker: "Speaker 1", voice: voicePrint(0, 0, 80) })],
    });
    await recSetSpeakerName(db, ctx, id, "Speaker 1", "Dana");
    expect(savedVoices(db)).toHaveLength(0);
  });

  it("teaches BOTH halves when correcting a guess the app made", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = withSpeaker(db, {
      speakerNames: { "Speaker 1": "Yossi" },
      recognized: ["Yossi"],
      segments: [phrase([word("hello", 0, 50)], { speaker: "Speaker 1", voice: voicePrint(3, 0, 400) })],
    });
    const meta = await recSetSpeakerName(db, ctx, id, "Speaker 1", "Dana");
    expect(meta.speakerNames).toEqual({ "Speaker 1": "Dana" });
    // The name on this voice is now the user's own, so it stops being a guess.
    expect(meta.recognized).toEqual([]);
    // The right person gains this voice…
    expect(savedVoices(db).map((v) => v.name)).toEqual(["Dana"]);
    // …and the wrong one is told it is not theirs, or the same mistake repeats
    // in every future recording.
    expect(db.prepare("SELECT name FROM voice_rejects").pluck().all()).toEqual(["Yossi"]);
  });

  it("changing your own mind is not a correction — nothing is denied", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    // "Yossi" was TYPED (not in `recognized`), so renaming is not the user
    // correcting the app; denying Yossi's own voice would be a fresh error.
    const id = withSpeaker(db, {
      speakerNames: { "Speaker 1": "Yossi" },
      segments: [phrase([word("hello", 0, 50)], { speaker: "Speaker 1", voice: voicePrint(3, 0, 400) })],
    });
    await recSetSpeakerName(db, ctx, id, "Speaker 1", "Dana");
    expect(db.prepare("SELECT COUNT(*) FROM voice_rejects").pluck().get() as number).toBe(0);
  });

  it("CONFIRMING the app's guess denies nobody — least of all the person confirmed", async () => {
    // Typing back the name the app already guessed is agreement, not a
    // correction: the label's old name and its new one are the same person, so
    // nothing may end up in `voice_rejects` saying this voice is NOT them. That
    // would teach the room the exact opposite of what the user just said, and
    // the next recording would refuse to recognise them.
    //
    // Two independent things hold this: `learnVoice`'s `wrong !== name` guard,
    // and `enrollVoice`'s stale-reject sweep (which withdraws a denial the
    // enrolment overrules). This asserts the OUTCOME, so losing either one is
    // still caught.
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = withSpeaker(db, {
      speakerNames: { "Speaker 1": "Dana" },
      recognized: ["Dana"], // the app guessed it
      segments: [phrase([word("hello", 0, 50)], { speaker: "Speaker 1", voice: voicePrint(3, 0, 400) })],
    });
    const meta = await recSetSpeakerName(db, ctx, id, "Speaker 1", "Dana");
    expect(meta.speakerNames).toEqual({ "Speaker 1": "Dana" });
    // Confirmed by the user, so it stops being something the next pass may undo.
    expect(meta.recognized).toEqual([]);
    expect(savedVoices(db).map((v) => v.name)).toEqual(["Dana"]);
    expect(db.prepare("SELECT COUNT(*) FROM voice_rejects").pluck().get() as number).toBe(0);
  });

  it("a failed enrolment never fails the rename it was enhancing", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = withSpeaker(db);
    db.exec("DROP TABLE voice_ids");
    const meta = await recSetSpeakerName(db, ctx, id, "Speaker 1", "Dana");
    expect(meta.speakerNames).toEqual({ "Speaker 1": "Dana" });
  });

  it("the LIVE path routes the rename and learns from the meta the engine answers with", async () => {
    const db = freshRoom();
    const withName: RecMeta = {
      ...defaultRecMeta(),
      durationCs: 50,
      speakerNames: { "Speaker 1": "Dana" },
      recognized: [],
      segments: [phrase([word("hello", 0, 50)], { speaker: "Speaker 1", voice: voicePrint(0, 0, 400) })],
    };
    const post = fakePost({
      "/rec/start": () => ok({ spoolKey: "", spoolPath: "" }),
      "/rec/edit_meta": () => ok({ meta: withName }),
    });
    const ctx = makeCtx(db, { sidecarPost: post, connectHostWs: () => fakeHostWs() });
    const { fileId } = await recStart(db, ctx, { systemAudio: false });
    // The engine holds the authoritative meta and re-clustered while we watched;
    // the snapshot this process last saw is what says the app had GUESSED here.
    ctx.state.lastMeta = { ...withName, speakerNames: { "Speaker 1": "Yossi" }, recognized: ["Yossi"] };

    const meta = await recSetSpeakerName(db, ctx, fileId, "Speaker 1", "Dana");
    expect(meta.speakerNames).toEqual({ "Speaker 1": "Dana" });
    expect(post.calls[1]?.body).toEqual({ fileId, op: "rename_speaker", label: "Speaker 1", name: "Dana" });
    expect(savedVoices(db).map((v) => v.name)).toEqual(["Dana"]);
    expect(db.prepare("SELECT name FROM voice_rejects").pluck().all()).toEqual(["Yossi"]);
  });
});

// ============================================ studio-style transcript editing

describe("recDeleteRange / recCorrectRange", () => {
  function edited(db: Database.Database): string {
    return addRecording(db, "call.wav", {
      ...defaultRecMeta(),
      durationCs: 1000,
      segments: [
        phrase([word("keep", 0, 100), word("cut", 100, 200), word("this", 200, 300)]),
        phrase([], { id: "legacy", t0: 400, t1: 500, text: "legacy line", words: [] }),
      ],
    });
  }

  it("marks words deleted, drops a legacy segment the cut swallows, and records the cut", () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = edited(db);
    const meta = recDeleteRange(db, ctx, id, 100, 200);
    expect(meta.segments[0]?.words.map((w) => w.del === true)).toEqual([false, true, false]);
    expect(meta.cuts).toEqual([{ t0: 100, t1: 200 }]);
    expect(getFileExtractedText(db, id)).toContain("keep this");
    expect(getFileExtractedText(db, id)).not.toContain("cut");

    // A segment without word timings is dropped wholesale when a cut swallows it.
    const after = recDeleteRange(db, ctx, id, 390, 510);
    expect(after.segments[1]?.text).toBe("");
    expect(after.cuts).toEqual([
      { t0: 100, t1: 200 },
      { t0: 390, t1: 510 },
    ]);
  });

  it("snapshots the file into History first, so a studio edit is undoable", () => {
    // `store_file_bytes` = snapshot + overwrite, one transaction. Without the
    // snapshot the transcript edit is the one destructive thing in the feature.
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = edited(db);
    recDeleteRange(db, ctx, id, 100, 200);
    recCorrectRange(db, ctx, id, 200, 300, "that");
    const causes = db
      .prepare("SELECT cause FROM file_versions WHERE file_id = ? ORDER BY rowid")
      .pluck()
      .all(id);
    expect(causes).toEqual(["Edited transcript", "Corrected transcript"]);
    // The snapshot carries the recording meta too — restoring bytes alone could
    // never bring the old words, speakers or cuts back.
    const snapshot = db
      .prepare("SELECT rec_meta FROM file_versions WHERE file_id = ? ORDER BY rowid LIMIT 1")
      .pluck()
      .get(id) as string;
    expect(JSON.parse(snapshot).cuts).toEqual([]);
  });

  it("refuses an empty selection, and both refuse while the file is the live recording", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = edited(db);
    expect(() => recDeleteRange(db, ctx, id, 200, 200)).toThrowError("Nothing selected.");
    expect(() => recCorrectRange(db, ctx, id, 200, 100, "x")).toThrowError("Nothing selected.");
    // An empty correction is a DELETE, and delete is a different button with a
    // different consequence. Never guess which was meant.
    expect(() => recCorrectRange(db, ctx, id, 0, 100, "   ")).toThrowError(/Delete from recording/);

    ctx.state.liveFileId = id;
    expect(() => recDeleteRange(db, ctx, id, 0, 100)).toThrowError(
      "Pause the recording before editing the transcript."
    );
    expect(() => recCorrectRange(db, ctx, id, 0, 100, "x")).toThrowError(
      "Pause the recording before editing the transcript."
    );
  });

  it("correctWords retypes one phrase evenly across the span the old words held", () => {
    const seg = phrase([word("a", 0, 100), word("beeb", 100, 200), word("c", 200, 300)]);
    expect(correctWords(seg, 100, 200, "bee bee")).toBe(1);
    expect(seg.words.map((w) => [w.w, w.t0, w.t1])).toEqual([
      ["a", 0, 100],
      ["bee", 100, 150],
      ["bee", 150, 200],
      ["c", 200, 300],
    ]);
    // The audio is untouched — no cut is added and `del` is never set.
    expect(seg.words.every((w) => w.del === false)).toBe(true);
  });

  it("correctWords leaves no stray words when the correction is shorter, and is a no-op on nothing", () => {
    const seg = phrase([word("one", 0, 100), word("two", 100, 200), word("three", 200, 300)]);
    expect(correctWords(seg, 0, 300, "just this")).toBe(3);
    expect(seg.words.map((w) => w.w)).toEqual(["just", "this"]);
    expect(correctWords(seg, 900, 1000, "nothing here")).toBe(0);
    expect(seg.words.map((w) => w.w)).toEqual(["just", "this"]);
  });

  it("correctWords never counts a deleted word as a hit, and keeps the ones outside the splice", () => {
    // A deleted word inside the SELECTION but before the first surviving hit is
    // outside [first, last] and keeps its own timings — Rust's own note about
    // "any already marked deleted inside the range's gaps".
    const leading = phrase([word("gone", 0, 100, true), word("b", 100, 200), word("c", 200, 300)]);
    expect(correctWords(leading, 0, 300, "x")).toBe(2);
    expect(leading.words.map((w) => [w.w, w.t0, w.t1])).toEqual([
      ["gone", 0, 100],
      ["x", 100, 300],
    ]);
    // One BETWEEN two hits is inside the replaced span and goes with it, since
    // the splice replaces first..=last wholesale.
    const middle = phrase([word("a", 0, 100), word("gone", 100, 200, true), word("c", 200, 300)]);
    expect(correctWords(middle, 0, 300, "x y")).toBe(2);
    expect(middle.words.map((w) => w.w)).toEqual(["x", "y"]);
  });

  it("recCorrectRange refuses a cross-phrase selection and one with no word timings", () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = addRecording(db, "call.wav", {
      ...defaultRecMeta(),
      durationCs: 1000,
      segments: [
        phrase([word("first", 0, 100)], { speaker: "Speaker 1" }),
        phrase([word("second", 100, 200)], { speaker: "Speaker 2" }),
        phrase([], { t0: 300, t1: 400, text: "legacy", words: [] }),
      ],
    });
    // Whose line are the new words? Guessing puts words in somebody's mouth.
    expect(() => recCorrectRange(db, ctx, id, 0, 200, "x")).toThrowError(/more than one phrase/);
    expect(() => recCorrectRange(db, ctx, id, 300, 400, "x")).toThrowError(/no word timings/);
    expect(recCorrectRange(db, ctx, id, 0, 100, "1st").segments[0]?.words.map((w) => w.w)).toEqual(["1st"]);
  });
});

describe("reflowAfterCuts", () => {
  it("pulls surviving timestamps back, drops cut words, and carries the names over", () => {
    const meta: RecMeta = {
      ...defaultRecMeta(),
      durationCs: 1000,
      cuts: [{ t0: 100, t1: 200 }],
      speakerNames: { "Speaker 1": "Dana" },
      recognized: ["Dana"],
      maxSpeakers: 3,
      segments: [
        phrase([word("keep", 0, 100), word("cut", 100, 200, true), word("this", 200, 300)], {
          speaker: "Speaker 1",
          voice: voicePrint(0, 0, 400),
        }),
      ],
    };
    const out = reflowAfterCuts(meta, 16_000); // 1.00 s of spliced audio
    expect(out.durationCs).toBe(100);
    expect(out.maxSpeakers).toBe(3);
    // Otherwise "Dana" silently reverts to "Speaker 2" in the exported copy.
    expect(out.speakerNames).toEqual({ "Speaker 1": "Dana" });
    expect(out.recognized).toEqual(["Dana"]);
    expect(out.cuts).toEqual([]); // the copy has no edits left to apply
    expect(out.segments[0]?.words.map((w) => [w.w, w.t0, w.t1])).toEqual([
      ["keep", 0, 100],
      ["this", 100, 200],
    ]);
    expect(out.segments[0]?.t0).toBe(0);
    expect(out.segments[0]?.t1).toBe(200);
    // The voiceprint rides along so the copy keeps its speakers.
    expect(out.segments[0]?.voice?.v).toHaveLength(192);
    // Ids are re-minted, so nothing points at a segment on the old timeline.
    expect(out.segments[0]?.id).not.toBe(meta.segments[0]?.id);
  });

  it("moves annotations with the words they point at, and drops the ones cut out", () => {
    const meta: RecMeta = {
      ...defaultRecMeta(),
      durationCs: 1000,
      cuts: [{ t0: 100, t1: 200 }],
      segments: [phrase([word("a", 0, 100), word("b", 200, 300)])],
      chapters: [
        { id: "c1", t0: 50, title: "Before", by: "you" },
        { id: "c2", t0: 150, title: "Inside the cut", by: "room" },
        { id: "c3", t0: 250, title: "After", by: "you" },
      ],
      notes: [{ id: "n1", t0: 150, kind: "point", text: "gone with the words", by: "room" }],
      highlights: [{ id: "h1", t0: 250, t1: 300, by: "you" }],
    };
    const out = reflowAfterCuts(meta, 16_000);
    expect(out.chapters.map((c) => [c.title, c.t0])).toEqual([
      ["Before", 50],
      ["After", 150],
    ]);
    // The copy no longer contains what that note was about. The ORIGINAL keeps
    // it — cuts are undoable, so un-deleting must bring the note back too.
    expect(out.notes).toEqual([]);
    expect(out.highlights).toEqual([{ id: "h1", t0: 150, t1: 200, by: "you" }]);
    expect(meta.notes).toHaveLength(1);
  });

  it("drops a segment with nothing left to say and falls back to segment bounds with no words", () => {
    const meta: RecMeta = {
      ...defaultRecMeta(),
      durationCs: 1000,
      cuts: [{ t0: 0, t1: 100 }],
      segments: [
        phrase([word("gone", 0, 100, true)]),
        phrase([], { t0: 300, t1: 400, text: "legacy line", words: [] }),
      ],
    };
    const out = reflowAfterCuts(meta, 16_000);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({ text: "legacy line", t0: 200, t1: 300 });
  });
});

describe("recExportClean", () => {
  it("splices the cut audio out and reflows the transcript into a new file", () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const samples = new Float32Array(16_000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = i / 16_000;
    }
    const meta: RecMeta = {
      ...defaultRecMeta(),
      durationCs: 100,
      cuts: [{ t0: 25, t1: 50 }],
      segments: [phrase([word("kept", 0, 25), word("cut", 25, 50, true), word("also", 50, 100)])],
    };
    const id = addRecording(db, "board meeting.wav", meta);
    db.prepare("UPDATE files SET original_bytes = ? WHERE id = ?").run(encodeWav(samples), id);

    let notified = 0;
    ctx.deps.notifyFilesChanged = (): void => {
      notified++;
    };
    const file = recExportClean(db, ctx, id);
    expect(file.name).toBe("board meeting (edited).wav");
    expect(decodeWav(getFileBytes(db, file.id) as Buffer).length).toBe(12_000);
    const newMeta = parseRecMeta(getRecMeta(db, file.id));
    expect(newMeta.durationCs).toBe(75);
    expect(newMeta.segments[0]?.words.map((w) => w.w)).toEqual(["kept", "also"]);
    expect(getFileExtractedText(db, file.id)).toContain("kept also");
    expect(notified).toBe(1);
    // The original is untouched.
    expect(parseRecMeta(getRecMeta(db, id)).cuts).toEqual([{ t0: 25, t1: 50 }]);
  });

  it("refuses when there is nothing to apply", () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    const id = addRecording(db, "call.wav", {
      ...defaultRecMeta(),
      segments: [phrase([word("all here", 0, 100)])],
    });
    expect(() => recExportClean(db, ctx, id)).toThrowError(/No edits to apply/);
  });
});

// ================================================================= translate

describe("recTranslate", () => {
  function translatable(db: Database.Database): string {
    return addRecording(db, "board meeting.wav", {
      ...defaultRecMeta(),
      durationCs: 3000,
      speakerNames: { "Speaker 1": "Dana" },
      segments: Array.from({ length: 14 }, (_, i) =>
        phrase([word(`line${i}`, i * 100, i * 100 + 50)], { speaker: "Speaker 1" })
      ),
    });
  }

  it("translates batch by batch, links the result to the source, and reports progress", async () => {
    const db = freshRoom();
    const prompts: string[] = [];
    const progress: Array<[number, number]> = [];
    const ctx = makeCtx(db, {
      generate: async (prompt) => {
        prompts.push(prompt);
        const count = Number(/Output exactly (\d+) lines/.exec(prompt)?.[1] ?? 0);
        return `<think>hmm</think>${Array.from({ length: count }, (_, i) => `translated ${i}`).join("\n")}`;
      },
      onTranslateProgress: (_id, done, total) => progress.push([done, total]),
    });
    const id = translatable(db);
    const file = await recTranslate(db, ctx, id, "  Spanish  ");

    expect(file.name).toBe("board meeting — Spanish.md");
    expect(prompts).toHaveLength(2); // 14 lines, batches of 12
    expect(prompts[0]).toContain("Output exactly 12 lines");
    expect(prompts[0]).toContain("[0:00] Dana: line0"); // the user's own name (GH #5)
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    const content = getFileExtractedText(db, file.id) as string;
    expect(content).toContain("# board meeting — Spanish");
    expect(content).toContain("translated 0");
    expect(content).not.toContain("<think>"); // reasoning spans stripped
    expect(content).not.toContain("came back untranslated");
    // Room map: the name says it came from this recording, but a name is not
    // evidence — renaming either file must not break the link.
    expect(db.prepare("SELECT derived_from FROM files WHERE id = ?").pluck().get(file.id)).toBe(id);
  });

  it("OPENS the translated document, the way Rust's own last line does", async () => {
    // A translation runs for minutes on the local model, so the user is looking
    // at something else by the time it lands. `recording_cmds.rs:1659` emits
    // `agent-open-file` for exactly that reason; without it a finished job is a
    // file nobody is told about.
    const db = freshRoom();
    const opened: string[] = [];
    const order: string[] = [];
    const ctx = makeCtx(db, {
      generate: async () => "translated",
      notifyFilesChanged: () => order.push("files-changed"),
      onOpenFile: (fileId) => {
        opened.push(fileId);
        order.push("open-file");
      },
    });
    const file = await recTranslate(db, ctx, translatable(db), "Spanish");
    expect(opened).toEqual([file.id]);
    // The list refreshes before the viewer is pointed at the new row, or it
    // opens a file the file list does not yet have.
    expect(order).toEqual(["files-changed", "open-file"]);
  });

  it("a viewer that cannot be told never fails the translation it was told about", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, {
      generate: async () => "translated",
      onOpenFile: () => {
        throw new Error("no window");
      },
    });
    await expect(recTranslate(db, ctx, translatable(db), "Spanish")).resolves.toBeTruthy();
  });

  it("keeps the ORIGINAL line for anything the model failed to translate, and says how many", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db, { generate: async () => "only one line came back" });
    const id = addRecording(db, "call.wav", {
      ...defaultRecMeta(),
      durationCs: 300,
      segments: [phrase([word("uno", 0, 50)]), phrase([word("dos", 100, 150)])],
    });
    const file = await recTranslate(db, ctx, id, "Spanish");
    const content = getFileExtractedText(db, file.id) as string;
    // A turn that silently disappears from the translated document is worse
    // than one that appears untranslated.
    expect(content).toContain("only one line came back");
    expect(content).toContain("[0:01] You: dos");
    expect(content).toContain("1 line(s) came back untranslated");
  });

  it("GH #24: translates a 45-minute transcript through every batch instead of stopping near minute two", async () => {
    const db = freshRoom();
    const segments = Array.from({ length: 45 }, (_, minute) =>
      phrase([word(`Hebrew line ${minute + 1}`, minute * 6_000, minute * 6_000 + 100)])
    );
    const id = addRecording(db, "long-hebrew.wav", {
      ...defaultRecMeta(),
      durationCs: 45 * 60 * 100,
      segments,
    });
    let calls = 0;
    const ctx = makeCtx(db, {
      generate: async (prompt) => {
        calls++;
        return prompt.slice(prompt.indexOf("\n\n") + 2);
      },
    });

    const file = await recTranslate(db, ctx, id, "English");
    const content = getFileExtractedText(db, file.id) as string;
    expect(calls).toBe(4);
    expect(content).toContain("[0:00] You: Hebrew line 1");
    expect(content).toContain("[44:00] You: Hebrew line 45");
    expect(content.match(/Hebrew line/g)).toHaveLength(45);
  });

  it("refuses an empty language, a silent recording, and an unavailable model", async () => {
    const db = freshRoom();
    const id = translatable(db);
    await expect(recTranslate(db, makeCtx(db, { generate: async () => "" }), id, "  ")).rejects.toThrowError(
      "Pick a language first."
    );
    await expect(recTranslate(db, makeCtx(db), id, "Spanish")).rejects.toThrowError(/Ollama/);
    const silent = addRecording(db, "silent.wav", defaultRecMeta());
    await expect(
      recTranslate(db, makeCtx(db, { generate: async () => "" }), silent, "Spanish")
    ).rejects.toThrowError(/No transcript to translate/);
  });

  it("stops between batches without saving a half document", async () => {
    const db = freshRoom();
    let batches = 0;
    const ctx = makeCtx(db, {
      generate: async () => {
        batches++;
        return "x";
      },
      isStopped: () => batches >= 1,
    });
    const id = translatable(db);
    await expect(recTranslate(db, ctx, id, "Spanish")).rejects.toThrowError(
      "Stopped — no translated file was saved."
    );
    expect(batches).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM files WHERE name LIKE '%Spanish%'").pluck().get() as number).toBe(0);
  });

  it("the pure batching helpers hold their own contracts", () => {
    expect(reconcileTranslatedBatch(["a", "b", "c"], "x\n\n y \n")).toEqual({
      translated: ["x", "y", "c"],
      untranslated: 1,
    });
    expect(reconcileTranslatedBatch(["a"], "x\ny")).toEqual({ translated: ["x", "y"], untranslated: 0 });
    expect(buildTranslatePrompt("Hebrew", ["l1", "l2"])).toContain("Output exactly 2 lines");
    expect(buildTranslatedDocument("call", "Hebrew", ["a", "b"], 0)).toBe(
      "# call — Hebrew\n\n_Translated on this Mac from the recording's transcript._\n\na\n\nb\n"
    );
    expect(translatableLines({ ...defaultRecMeta(), segments: [phrase([word("gone", 0, 50, true)])] })).toEqual(
      []
    );
  });
});

// ================================================================ the stubs

describe("out-of-scope commands", () => {
  it("recPushAudio, recReadStart and recRetranscribe all refuse with an explanation", async () => {
    const db = freshRoom();
    const ctx = makeCtx(db);
    await expect(recPushAudio(48_000, "AAAA")).rejects.toThrowError(/WS \/rec\/session/);
    await expect(recReadStart(db, ctx, "x")).rejects.toThrowError(/background AI job/);
    await expect(recRetranscribe(db, ctx, "x")).rejects.toThrowError(/no HTTP route mounted/);
    // The follow-up must not silently drop the guard set that goes with it.
    await expect(recRetranscribe(db, ctx, "x")).rejects.toThrowError(/retranscribing/);
  });
});
