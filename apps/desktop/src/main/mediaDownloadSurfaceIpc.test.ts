/**
 * The download intake funnel. `importDownload` is where every downloaded file
 * lands — a browser download, a yt-dlp media job, an agent's `download_url` —
 * so it is the one place to prove that audio and video are handed to the
 * speaker-aware transcription pass and that nothing else is, and that the pass
 * can never take the download down with it.
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDownloadEngineDeps } from "./mediaDownloadSurfaceIpc.js";
import { createRoom } from "./db-host/open.js";
import { createRoomManagerState } from "./roomManager.js";
import { getFileMeta } from "./db-host/files.js";
import type { MediaTranscribeDeps } from "./mediaTranscribeJob.js";

const PASSWORD = "correct horse battery staple";

async function withRoom(
  run: (ctx: {
    state: ReturnType<typeof createRoomManagerState>;
    root: string;
    events: [string, unknown][];
    emit: (event: string, payload: unknown) => void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-download-intake-"));
  const roomPath = path.join(root, "downloads.roomai");
  const db = createRoom(roomPath, PASSWORD, "Downloads");
  const state = createRoomManagerState();
  state.room = { conn: db, path: roomPath, name: "Downloads", password: PASSWORD };
  const events: [string, unknown][] = [];
  try {
    await run({ state, root, events, emit: (event, payload) => events.push([event, payload]) });
  } finally {
    state.room = null;
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("downloaded media transcribes itself", () => {
  it("hands the committed file id — not the staged temp path — to the speaker-aware pass", async () => {
    await withRoom(async ({ state, root, emit }) => {
      const calls: [MediaTranscribeDeps, string][] = [];
      const staged = path.join(root, "staged-episode.mp3");
      await writeFile(staged, Buffer.from("ID3 pretend audio"));

      const engine = createDownloadEngineDeps(state, root, emit, {
        resourcesPath: "/Applications/Arcelle.app/Contents/Resources",
        extractText: async () => null,
        transcribe: async (deps, fileId) => {
          calls.push([deps, fileId]);
          return null;
        },
      });
      const meta = await engine.importDownload!(staged, "Episode 12.mp3", "https://example.com/ep12");

      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toBe(meta.id);
      // The file really is in the room under that id, so the pass has
      // something to read — this is not a fabricated hand-off.
      expect(getFileMeta(state.room!.conn, meta.id).name).toBe("Episode 12.mp3");
      // The bundled weights only exist under resourcesPath; forwarding null
      // here is how a packaged build silently stops transcribing.
      expect(calls[0]![0].resourcesPath).toBe("/Applications/Arcelle.app/Contents/Resources");
      expect(calls[0]![0].state).toBe(state);
    });
  });

  it("transcribes a container whose MIME arrived generic, and leaves documents alone", async () => {
    await withRoom(async ({ state, root, emit }) => {
      const transcribed: string[] = [];
      const engine = createDownloadEngineDeps(state, root, emit, {
        extractText: async () => null,
        transcribe: async (_deps, fileId) => {
          transcribed.push(fileId);
          return null;
        },
      });
      // `.caf` has no entry in guessDownloadMime's table, so it commits as
      // application/octet-stream — the extension arm of `mediaKind` is the only
      // thing that recognizes it as audio at all.
      const audio = path.join(root, "staged-voice.caf");
      const document = path.join(root, "staged-report.pdf");
      await writeFile(audio, Buffer.from("caff pretend audio"));
      await writeFile(document, Buffer.from("%PDF-1.4 pretend document"));

      const recorded = await engine.importDownload!(audio, "voice.caf", "https://example.com/voice.caf");
      await engine.importDownload!(document, "report.pdf", "https://example.com/report.pdf");

      expect(transcribed).toEqual([recorded.id]);
    });
  });

  it("a failing transcription neither fails the download nor goes unsaid", async () => {
    await withRoom(async ({ state, root, events, emit }) => {
      const staged = path.join(root, "staged-interview.m4a");
      await writeFile(staged, Buffer.from("pretend audio"));
      const engine = createDownloadEngineDeps(state, root, emit, {
        extractText: async () => null,
        transcribe: async () => {
          throw new Error("the speech model could not be loaded");
        },
      });

      const meta = await engine.importDownload!(staged, "interview.m4a", "https://example.com/i");
      // The pass is fire-and-forget, so its rejection is reported on a later
      // turn of the loop than the one the import returned on.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The download stands: a row, and the "there are new files" announcement.
      expect(getFileMeta(state.room!.conn, meta.id).name).toBe("interview.m4a");
      expect(events.some(([event]) => event === "room-files-changed")).toBe(true);
      // …and the failure is reported on the lane the viewer reads, keyed by
      // file NAME, rather than being swallowed into a file that looks like it
      // is still waiting for a transcript.
      const failures = events.filter(([event]) => event === "stt-progress");
      expect(failures).toHaveLength(1);
      expect(failures[0]![1]).toEqual([
        "interview.m4a",
        "failed: the speech model could not be loaded",
      ]);
    });
  });
});
