import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { type ParsedMember } from "./castparse.js";
import type { OpenRoom } from "./turnEngine.js";
import type { PlannedShot } from "../shared/apiTypes.js";
import { storyAddCast, storyAddCastMany, storyAddShot, storyBoard, storyCreateList, storyDeleteList, storyDocuments, storyPicturesInRoom, storyReadCastFile, storyRemoveCast, storyRemoveShot, storyReorderShots, storySetFace, storySetShape, storyTextFromFile, storyUpdateCast, storyUpdateList, storyUpdateShot } from "./storyCastTools.js";
import { storyApplySplit, storyPlanSplit } from "./storyTools.js";



// -------------------------------------------------------------- IPC (unwired)

/** The slice of room state every story IPC handler needs: whichever room is
 * open RIGHT NOW, not whatever was open when {@link registerStoryIpc} ran.
 * Re-declared locally rather than imported (`recIpc.ts` does not export its
 * own), so this module's only dependency on `turnEngine.ts` is the `OpenRoom`
 * shape both already agree on. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}
export

/** `AppState::with_room`'s own refusal, so an IPC call made between rooms says
 * what the shipped app says — the same string `recIpc.ts` uses. */
const NO_ROOM_OPEN = "No room is open.";
export function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}
export function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) throw new Error(NO_ROOM_OPEN);
  return open;
}


/**
 * Register every Story-tab channel on `ipcMain`. NOT wired into any bootstrap
 * file (rule 4) — it exists, ready to be wired, once a preload/renderer batch
 * needs it.
 *
 * `story_pictures`/`story_read_cast_file` are async; every other handler is a
 * thin synchronous forward to the exported functions above.
 */
export function registerStoryIpc(ipcMain: Pick<IpcMain, "handle">, room: RoomSource): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("story_board", (args: { listId?: string | null }) =>
    storyBoard(openDb(room), args.listId ?? null)
  );
  handle("story_pictures", () => storyPicturesInRoom(openRoom(room)));

  handle("story_add_cast", (args: { name: string; description: string; story: string }) =>
    storyAddCast(openDb(room), args.name, args.description, args.story)
  );
  handle(
    "story_update_cast",
    (args: { id: string; name: string; description: string; story: string }) =>
      storyUpdateCast(openDb(room), args.id, args.name, args.description, args.story)
  );
  handle("story_set_face", (args: { id: string; fileId: string | null }) =>
    storySetFace(openDb(room), args.id, args.fileId)
  );
  handle("story_remove_cast", (args: { id: string }) => storyRemoveCast(openDb(room), args.id));

  handle("story_create_list", (args: { title: string; logline: string }) =>
    storyCreateList(openDb(room), args.title, args.logline)
  );
  handle("story_update_list", (args: { id: string; title: string; logline: string }) =>
    storyUpdateList(openDb(room), args.id, args.title, args.logline)
  );
  handle(
    "story_set_shape",
    (args: {
      id: string;
      aspectRatio: string;
      stillResolution: string;
      clipResolution: string;
    }) =>
      storySetShape(
        openDb(room),
        args.id,
        args.aspectRatio,
        args.stillResolution,
        args.clipResolution
      )
  );
  handle("story_delete_list", (args: { id: string }) => storyDeleteList(openDb(room), args.id));

  handle("story_add_shot", (args: { listId: string; action: string }) =>
    storyAddShot(openDb(room), args.listId, args.action)
  );
  handle(
    "story_update_shot",
    (args: {
      id: string;
      action: string;
      castIds: string[];
      seconds: number | null;
      imageModel: string;
      videoModel: string;
    }) =>
      storyUpdateShot(
        openDb(room),
        args.id,
        args.action,
        args.castIds,
        args.seconds,
        args.imageModel,
        args.videoModel
      )
  );
  handle("story_remove_shot", (args: { id: string }) => storyRemoveShot(openDb(room), args.id));
  handle("story_reorder_shots", (args: { listId: string; ids: string[] }) =>
    storyReorderShots(openDb(room), args.listId, args.ids)
  );

  handle("story_documents", () => storyDocuments(openDb(room)));
  handle("story_text_from_file", (args: { fileId: string }) =>
    storyTextFromFile(openDb(room), args.fileId)
  );
  handle("story_read_cast_file", (args: { fileId: string }) =>
    storyReadCastFile(openDb(room), args.fileId)
  );
  handle("story_add_cast_many", (args: { members: ParsedMember[] }) =>
    storyAddCastMany(openDb(room), args.members)
  );

  handle("story_plan_split", (args: { script: string; minutes: number; secondsEach: number }) =>
    storyPlanSplit(args.script, args.minutes, args.secondsEach)
  );
  handle(
    "story_apply_split",
    (args: { listId: string; shots: PlannedShot[]; imageModel: string; videoModel: string }) =>
      storyApplySplit(openDb(room), args.listId, args.shots, args.imageModel, args.videoModel)
  );
}
