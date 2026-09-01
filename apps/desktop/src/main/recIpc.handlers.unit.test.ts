import { beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({
  recChapterAdd: vi.fn(),
  recChapterSet: vi.fn(),
  recCorrectRangeHybrid: vi.fn(),
  recDeleteRangeHybrid: vi.fn(),
  recExportCleanHybrid: vi.fn(),
  recGet: vi.fn(),
  recHighlightAdd: vi.fn(),
  recItemDelete: vi.fn(),
  recLiveStatus: vi.fn(),
  recNoteAdd: vi.fn(),
  recNoteSet: vi.fn(),
  recPause: vi.fn(),
  recPushAudio: vi.fn(),
  recReadStart: vi.fn(),
  recResume: vi.fn(),
  recRetranscribe: vi.fn(),
  recSetLiveStt: vi.fn(),
  recSetLiveTranslate: vi.fn(),
  recSetSpeakerName: vi.fn(),
  recStart: vi.fn(),
  recStop: vi.fn(),
  recTranslate: vi.fn(),
  voiceForget: vi.fn(),
  voicesList: vi.fn(),
}));

vi.mock("./recBridge.js", () => rec);

import { registerRecIpc } from "./recIpc.js";

type Handler = (...args: unknown[]) => unknown;

beforeEach(() => vi.clearAllMocks());

describe("recording IPC forwarding", () => {
  it("forwards every command to its recording behavior with the current room", async () => {
    const db = { marker: "current db" };
    const ctx = { marker: "bridge context" };
    const handlers = new Map<string, Handler>();
    registerRecIpc(
      { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } } as never,
      ctx as never,
      { currentRoom: () => ({ db, path: "/fabricated/room" }) } as never,
    );
    const call = (channel: string, args?: unknown) => handlers.get(channel)!({}, ...(args === undefined ? [] : [args]));

    await call("rec_start", { fileId: "f", systemAudio: true });
    await call("rec_pause");
    await call("rec_resume");
    await call("rec_stop");
    await call("rec_set_live_translate", { language: "fr" });
    await call("rec_set_live_stt", { on: true });
    await call("rec_delete_range", { id: "f", t0: 1, t1: 2 });
    await call("rec_correct_range", { id: "f", t0: 1, t1: 2, text: "fixed" });
    await call("rec_set_speaker_name", { id: "f", speaker: "S1", name: "Ada" });
    await call("rec_read_start", { id: "f" });
    await call("rec_note_set", { id: "f", noteId: "n", text: "note" });
    await call("rec_chapter_add", { id: "f", t0: 3, title: "Start" });
    await call("rec_chapter_set", { id: "f", chapterId: "c", title: "New" });
    await call("rec_highlight_add", { id: "f", t0: 3, t1: 4 });
    await call("rec_item_delete", { id: "f", kind: "highlight", itemId: "h" });
    await call("voice_forget", { name: "Ada" });
    await call("rec_export_clean", { id: "f" });
    await call("rec_translate", { id: "f", language: "fr" });
    await call("rec_retranscribe", { id: "f" });

    expect(rec.recStart).toHaveBeenCalledWith(db, ctx, { fileId: "f", systemAudio: true });
    expect(rec.recPause).toHaveBeenCalledWith(ctx);
    expect(rec.recResume).toHaveBeenCalledWith(ctx);
    expect(rec.recStop).toHaveBeenCalledWith(ctx);
    expect(rec.recSetLiveTranslate).toHaveBeenCalledWith(ctx, "fr");
    expect(rec.recSetLiveStt).toHaveBeenCalledWith(ctx, true);
    expect(rec.recDeleteRangeHybrid).toHaveBeenCalledWith(db, ctx, "f", 1, 2);
    expect(rec.recCorrectRangeHybrid).toHaveBeenCalledWith(db, ctx, "f", 1, 2, "fixed");
    expect(rec.recSetSpeakerName).toHaveBeenCalledWith(db, ctx, "f", "S1", "Ada");
    expect(rec.recReadStart).toHaveBeenCalledWith(db, ctx, "f");
    expect(rec.recNoteSet).toHaveBeenCalledWith(db, ctx, "f", "n", "note");
    expect(rec.recChapterAdd).toHaveBeenCalledWith(db, ctx, "f", 3, "Start");
    expect(rec.recChapterSet).toHaveBeenCalledWith(db, ctx, "f", "c", "New");
    expect(rec.recHighlightAdd).toHaveBeenCalledWith(db, ctx, "f", 3, 4);
    expect(rec.recItemDelete).toHaveBeenCalledWith(db, ctx, "f", "highlight", "h");
    expect(rec.voiceForget).toHaveBeenCalledWith(db, "Ada");
    expect(rec.recExportCleanHybrid).toHaveBeenCalledWith(db, ctx, "f");
    expect(rec.recTranslate).toHaveBeenCalledWith(db, ctx, "f", "fr");
    expect(rec.recRetranscribe).toHaveBeenCalledWith(db, ctx, "f");
  });
});
