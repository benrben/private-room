import type {
  VersionContent,
  CheckpointMeta,
  RoomInfo,
  RecentRoom,
  FileMeta,
  Memory,
  Folder,
  SearchResults,
  PrivacyStatus,
} from "./apiTypes.js";

export type Chunk2 = {
  restore_file_version: { args: { versionId: string }; result: void };
  file_versions_kept: { args: Record<string, never>; result: number };
  pin_file_version: {
    args: { versionId: string; pinned: boolean };
    result: void;
  };
  delete_file_version: { args: { versionId: string }; result: void };
  get_file_version: { args: { versionId: string }; result: VersionContent };
  create_room_checkpoint: { args: { name: string }; result: CheckpointMeta };
  list_room_checkpoints: {
    args: Record<string, never>;
    result: { entries: CheckpointMeta[]; totalBytes: number };
  };
  delete_room_checkpoint: { args: { id: string }; result: void };
  rollback_room_checkpoint: { args: { id: string }; result: RoomInfo };
  list_stranded_checkpoints: {
    args: Record<string, never>;
    result: string[];
  };
  export_file: { args: { id: string; destPath: string }; result: void };
  export_all: { args: { destDir: string }; result: number };
  change_password: {
    args: { current: string; newPassword: string };
    result: string | null;
  };
  duplicate_room: {
    args: { destPath: string; newPassword: string | null };
    result: void;
  };
  compact_room: { args: Record<string, never>; result: string };
  list_recent: { args: Record<string, never>; result: RecentRoom[] };
  remove_recent: { args: { path: string }; result: void };
  clear_recent: { args: Record<string, never>; result: void };
  save_generated_file: {
    args: { name: string; content: string };
    result: FileMeta;
  };
  open_html_in_browser: {
    args: { name: string; html: string };
    result: string;
  };
  stage_preview_html: { args: { html: string }; result: string };
  add_memory: {
    args: { content: string; category: string | null };
    result: Memory;
  };
  list_memories: { args: Record<string, never>; result: Memory[] };
  delete_memory: { args: { id: string }; result: void };
  update_memory: {
    args: { id: string; content: string; category: string | null };
    result: void;
  };
  open_scratch_pad: { args: Record<string, never>; result: FileMeta };
  list_folders: { args: Record<string, never>; result: Folder[] };
  create_folder: { args: { name: string }; result: Folder };
  rename_folder: { args: { id: string; name: string }; result: void };
  delete_folder: { args: { id: string }; result: void };
  rename_file: { args: { id: string; name: string }; result: void };
  move_file_to_folder: {
    args: { fileId: string; folderId: string | null };
    result: void;
  };
  search_all: { args: { query: string }; result: SearchResults };
  get_setting: { args: { key: string }; result: string | null };
  privacy_status: { args: Record<string, never>; result: PrivacyStatus };
  set_privacy_room: {
    args: { mode: "on" | "off" | "default" };
    result: void;
  };
  set_privacy_global: { args: { on: boolean }; result: void };
};

// extracted: restore_file_version, file_versions_kept, pin_file_version, delete_file_version, get_file_version, create_room_checkpoint, list_room_checkpoints, delete_room_checkpoint, rollback_room_checkpoint, list_stranded_checkpoints, export_file, export_all, change_password, duplicate_room, compact_room, list_recent, remove_recent, clear_recent, save_generated_file, open_html_in_browser, stage_preview_html, add_memory, list_memories, delete_memory, update_memory, open_scratch_pad, list_folders, create_folder, rename_folder, delete_folder, rename_file, move_file_to_folder, search_all, get_setting, privacy_status, set_privacy_room, set_privacy_global
