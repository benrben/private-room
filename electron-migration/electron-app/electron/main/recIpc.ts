/**
 * Thin `ipcMain.handle` registration for every ADD-27 recording channel
 * `src/api.ts:1249-1345` invokes, over the real business logic in
 * `recBridge.ts`.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts` and
 * `browser/browseCommands_*.ts`: Phase 2 (renderer/preload) needs an explicit
 * owner go-ahead before touching the live shipping app. {@link registerRecIpc}
 * exists, ready to be wired, but nothing in this migration's bootstrap calls
 * it yet.
 *
 * Every handler is THIN: no logic of its own beyond resolving the open room's
 * `db` and forwarding arguments. Anything a handler could decide (refusals,
 * live-vs-offline routing, DB writes) already lives in `recBridge.ts`, tested
 * there against a real fixture room. `ipcMain` is accepted as a parameter and
 * typed against the real `electron` module without importing it at runtime, so
 * this file resolves and tests under plain Node/vitest exactly like
 * `registerDictIpc` does.
 *
 * `RoomSource`/`OpenRoom` reuse `turnEngine.ts`'s already-shipped shape rather
 * than inventing a second "how do I reach the open room" convention — a future
 * host-state batch implements one thing and satisfies both call sites.
 *
 * TWO CHANNELS ANSWER DIFFERENTLY FROM THE RUST COMMAND OF THE SAME NAME, and
 * Phase 2's renderer work has to know it:
 *   - `rec_push_audio` is retired. It resolves to `recBridge.ts`'s throwing
 *     stub (see that module's §5): the renderer sends audio on its own
 *     `WS /rec/session` socket now, and this channel exists only so a stale
 *     bundle gets an instruction rather than "no handler registered".
 *   - `rec_live_status` answers a {@link RecLiveControl}, not Rust's `RecLive`.
 *     `durationCs` and the per-source `mic`/`sys` health are emitted on
 *     `WS /rec/session`, which the RENDERER owns — the renderer already has
 *     those numbers and must merge them itself rather than read zeroes from
 *     here. See `recBridge.ts`'s `RecLiveControl` doc.
 * `rec_read_start` and `rec_retranscribe` ARE registered — the wire contract
 * still expects the channels to exist — and forward to the explaining throws,
 * which `ipcMain.handle` turns into a rejected `invoke()` like any other
 * failure.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import type { OpenRoom } from "./turnEngine.js";
import {
  recChapterAdd,
  recChapterSet,
  recCorrectRange,
  recDeleteRange,
  recExportCleanHybrid,
  recGet,
  recHighlightAdd,
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
  voiceForget,
  voicesList,
  type RecBridgeCtx,
} from "./recBridge.js";

/** The slice of room state every recording IPC handler needs: whichever room is
 * open RIGHT NOW, not whatever was open when `registerRecIpc` ran (a room can
 * be closed, reopened or switched over the app's lifetime — the same reasoning
 * `turnEngine.ts`'s own `TurnRoomSource` gives). */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, so an IPC call made between rooms says
 * what the shipped app says. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/** Register every ADD-27 recording channel on `ipcMain`. Channel names are the
 * Rust `#[tauri::command]` names `src/api.ts`'s `invoke(...)` calls already
 * use, so the renderer side needs no rename. */
export function registerRecIpc(
  ipcMain: Pick<IpcMain, "handle">,
  ctx: RecBridgeCtx,
  room: RoomSource,
  live: {
    readStart?: (db: Database.Database, ctx: RecBridgeCtx, id: string) => Promise<string>;
    retranscribe?: (db: Database.Database, ctx: RecBridgeCtx, id: string) => Promise<unknown>;
  } = {}
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle(
    "rec_start",
    (args: { fileId?: string | null; systemAudio: boolean; liveTranslate?: string | null }) =>
      recStart(openDb(room), ctx, args)
  );
  handle("rec_push_audio", (args: { rate: number; dataB64: string }) =>
    recPushAudio(args.rate, args.dataB64)
  );
  handle("rec_pause", () => recPause(ctx));
  handle("rec_resume", () => recResume(ctx));
  handle("rec_stop", () => recStop(ctx));
  handle("rec_live_status", () => recLiveStatus(ctx));
  handle("rec_set_live_translate", (args: { language: string | null }) =>
    recSetLiveTranslate(ctx, args.language)
  );
  handle("rec_set_live_stt", (args: { on: boolean }) => recSetLiveStt(ctx, args.on));
  handle("rec_get", (args: { id: string }) => recGet(openDb(room), args.id));
  handle("rec_delete_range", (args: { id: string; t0: number; t1: number }) =>
    recDeleteRange(openDb(room), ctx, args.id, args.t0, args.t1)
  );
  handle("rec_correct_range", (args: { id: string; t0: number; t1: number; text: string }) =>
    recCorrectRange(openDb(room), ctx, args.id, args.t0, args.t1, args.text)
  );
  handle("rec_set_speaker_name", (args: { id: string; speaker: string; name: string }) =>
    recSetSpeakerName(openDb(room), ctx, args.id, args.speaker, args.name)
  );
  handle("rec_read_start", (args: { id: string }) =>
    (live.readStart ?? recReadStart)(openDb(room), ctx, args.id));
  handle(
    "rec_note_add",
    (args: { id: string; t0: number; kind: string; text: string; who?: string | null }) =>
      recNoteAdd(openDb(room), ctx, args.id, args.t0, args.kind, args.text, args.who)
  );
  handle("rec_note_set", (args: { id: string; noteId: string; text: string }) =>
    recNoteSet(openDb(room), ctx, args.id, args.noteId, args.text)
  );
  handle("rec_chapter_add", (args: { id: string; t0: number; title: string }) =>
    recChapterAdd(openDb(room), ctx, args.id, args.t0, args.title)
  );
  handle("rec_chapter_set", (args: { id: string; chapterId: string; title: string }) =>
    recChapterSet(openDb(room), ctx, args.id, args.chapterId, args.title)
  );
  handle("rec_highlight_add", (args: { id: string; t0: number; t1: number }) =>
    recHighlightAdd(openDb(room), ctx, args.id, args.t0, args.t1)
  );
  handle(
    "rec_item_delete",
    (args: { id: string; kind: "note" | "chapter" | "highlight"; itemId: string }) =>
      recItemDelete(openDb(room), ctx, args.id, args.kind, args.itemId)
  );
  handle("voices_list", () => voicesList(openDb(room)));
  handle("voice_forget", (args: { name: string }) => voiceForget(openDb(room), args.name));
  handle("rec_export_clean", (args: { id: string }) => recExportCleanHybrid(openDb(room), ctx, args.id));
  handle("rec_translate", (args: { id: string; language: string }) =>
    recTranslate(openDb(room), ctx, args.id, args.language)
  );
  handle("rec_retranscribe", (args: { id: string }) =>
    (live.retranscribe ?? recRetranscribe)(openDb(room), ctx, args.id));
}
