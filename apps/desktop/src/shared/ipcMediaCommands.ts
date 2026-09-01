import type {
  RoomInfo,
  ImportReport,
  FileMeta,
  ImageBox,
  SttStatus,
  DictSessionInfo,
  NeuralVoiceInfo,
  AiActionDef,
  RecStart,
  RecMeta,
  RecLive,
  RecFile,
  NoteKind,
  SavedVoice,
  FeedbackDraft,
  AppDiag,
  ViewMenuState,
  MediaQualityOption,
  RecommendedModels,
  RoomGraph,
  FrontPage,
  StudioPrompts,
  MemorySuggestion,
  FileMetaSuggestion,
  RoomServerStatus,
  RoomRole,
} from "./apiTypes.js";

import type {
  ApprovalDecision,
  HarnessHistoryRun,
  PrivacyMode,
} from "./harnessTypes.js";

export interface MediaCommands {
  // ---- chunk 7 --------------------------------------------------------
  import_image_bytes: { args: { name: string; b64: string }; result: FileMeta };
  import_audio_bytes: { args: { name: string; b64: string }; result: FileMeta };
  locate_in_image: { args: { fileId: string; query: string }; result: ImageBox[] };
  stt_status: { args: Record<string, never>; result: SttStatus };
  stt_download_model: { args: Record<string, never>; result: void };
  stt_cancel_download: { args: Record<string, never>; result: boolean };
  stt_delete_model: { args: Record<string, never>; result: void };
  retranscribe_file: { args: { fileId: string }; result: void };
  shape_text: {
    args: { text: string; translate: boolean; mode: string };
    result: string;
  };
  dict_start: { args: Record<string, never>; result: DictSessionInfo };
  dict_push_audio: { args: { rate: number; dataB64: string }; result: void };
  dict_stop: { args: Record<string, never>; result: string };
  dict_cancel: { args: Record<string, never>; result: void };
  speak_text_neural: {
    args: { text: string; voice: string | null };
    result: string;
  };
  list_neural_voices: { args: Record<string, never>; result: NeuralVoiceInfo[] };
  ai_action_prompts: { args: Record<string, never>; result: AiActionDef[] };
  ai_action: {
    args: {
      action: string;
      scope: string | null;
      refs: string[] | null;
      instructions: string | null;
      question: string | null;
      opId: string | null;
    };
    result: FileMeta;
  };
  create_sketch: { args: { name: string }; result: FileMeta };
  save_sketch: {
    args: { id: string; doc: string; snapshot: boolean; expectedDoc?: string };
    result: void;
  };
  export_sketch_svg: { args: { id: string }; result: FileMeta };
  export_sketch_png: { args: { id: string }; result: FileMeta };
  rec_start: {
    args: {
      fileId: string | null;
      systemAudio: boolean;
      liveTranslate: string | null;
    };
    result: RecStart;
  };
  rec_push_audio: { args: { rate: number; dataB64: string }; result: void };
  rec_pause: { args: Record<string, never>; result: void };
  rec_resume: { args: Record<string, never>; result: void };
  rec_stop: { args: Record<string, never>; result: RecMeta };
  rec_live_status: { args: Record<string, never>; result: RecLive | null };
  rec_set_live_translate: {
    args: { language: string | null };
    result: void;
  };
  rec_set_live_stt: { args: { on: boolean }; result: void };
  rec_get: { args: { id: string }; result: RecFile };
  rec_delete_range: {
    args: { id: string; t0: number; t1: number };
    result: RecMeta;
  };
  rec_correct_range: {
    args: { id: string; t0: number; t1: number; text: string };
    result: RecMeta;
  };
  rec_set_speaker_name: {
    args: { id: string; speaker: string; name: string };
    result: RecMeta;
  };
  rec_read_start: { args: { id: string }; result: string };
  rec_note_add: {
    args: { id: string; t0: number; kind: NoteKind; text: string; who?: string };
    result: RecMeta;
  };
  rec_note_set: {
    args: { id: string; noteId: string; text: string };
    result: RecMeta;
  };
  rec_chapter_add: {
    args: { id: string; t0: number; title: string };
    result: RecMeta;
  };

  // ---- chunk 8 --------------------------------------------------------
  rec_chapter_set: {
    args: { id: string; chapterId: string; title: string };
    result: RecMeta;
  };
  rec_highlight_add: {
    args: { id: string; t0: number; t1: number };
    result: RecMeta;
  };
  rec_item_delete: {
    args: { id: string; kind: "note" | "chapter" | "highlight"; itemId: string };
    result: RecMeta;
  };
  voices_list: { args: Record<string, never>; result: SavedVoice[] };
  voice_forget: { args: { name: string }; result: SavedVoice[] };
  rec_export_clean: { args: { id: string }; result: FileMeta };
  rec_translate: { args: { id: string; language: string }; result: FileMeta };
  rec_retranscribe: { args: { id: string }; result: RecMeta };
  feedback_draft: { args: { text: string }; result: FeedbackDraft };
  app_diag: { args: Record<string, never>; result: AppDiag };
  reveal_logs: { args: Record<string, never>; result: string };
  set_unsaved_edits: { args: { on: boolean }; result: void };
  quit_guard_rearm: { args: Record<string, never>; result: void };
  menu_sync: { args: { view: ViewMenuState }; result: void };
  import_media_url: {
    args: { url: string; maxHeight?: number };
    result: ImportReport;
  };
  list_media_formats: { args: { url: string }; result: MediaQualityOption[] };
  cancel_media_download: { args: Record<string, never>; result: void };
  resolve_agent_ui: { args: { id: string; payload: unknown }; result: void };
  recommended_models: { args: Record<string, never>; result: RecommendedModels };
  ensure_embed_model: { args: Record<string, never>; result: void };
  room_graph: { args: Record<string, never>; result: RoomGraph };
  front_page: { args: Record<string, never>; result: FrontPage };
  front_page_suggestions: { args: Record<string, never>; result: string[] };
  studio_prompts: { args: Record<string, never>; result: StudioPrompts };
  memory_suggestion: { args: { chatId: string }; result: MemorySuggestion };
  suggest_file_meta: { args: { fileId: string }; result: FileMetaSuggestion };
  generate_ui_text: {
    args: { kind: string; prompt: string; facts: unknown; maxWords: number };
    result: string | null;
  };
  room_server_status: { args: Record<string, never>; result: RoomServerStatus };
  set_room_server: {
    args: { enabled: boolean; allowCloud: boolean; scope: "files" | "full" };
    result: RoomServerStatus;
  };
  regenerate_leash_token: { args: Record<string, never>; result: RoomServerStatus };
  set_ollama_url: { args: { url: string }; result: void };
  test_ollama_url: { args: { url: string }; result: string };
  get_ollama_url: { args: Record<string, never>; result: string };
  list_roles: { args: Record<string, never>; result: RoomRole[] };
  write_recovery_key: { args: Record<string, never>; result: string };
  has_recovery_key: { args: { path: string }; result: boolean };
  open_room_with_recovery: { args: { path: string; code: string }; result: RoomInfo };

  // ---- the plugin surfaces (NOT from api.ts's invoke call sites) ---------
  // Everything above was extracted from an `invoke("name", …)` in api.ts.
  // These seven were not, and could not have been: under Tauri they were not
  // commands of ours at all. Six back the two Tauri PLUGINS the frontend calls
  // as plain JS imports (`@tauri-apps/plugin-dialog`,
  // `@tauri-apps/plugin-opener`), which the Electron port has to supply
  // itself; the seventh, `quit_guard_confirm`, is the one step of the quit door
  // the Tauri build answered with a third plugin (`plugin-process`'s
  // `exit(0)`). See the comment on each group below.
  //
  // SHAPES READ FROM THE REAL, INSTALLED PLUGIN SOURCE
  // (`node_modules/@tauri-apps/plugin-{dialog,opener}/dist-js/{index.js,index.d.ts}`),
  // never guessed — the field names, the defaults, and the result types below
  // all come from that reading, and `preload/index.ts` re-implements those
  // modules' own client-side functions on top of these channels so a renderer
  // port changes an import rather than a call shape.
  //
  // TWO DELIBERATE DEVIATIONS FROM THE LITERAL TAURI WIRE, both because these
  // are new channels of OURS rather than descriptions of an existing wire (the
  // header's "model the shape the invoke call actually sends" rule applies to
  // the extracted 296):
  //   1. `dialog_open`/`dialog_save` take their options FLAT, not nested under
  //      an `options` key as `invoke('plugin:dialog|open', { options })` does.
  //      Every other entry in this interface passes flat named args, and the
  //      renderer-facing `open(options)`/`save(options)` signature is identical
  //      either way.
  //   2. `dialog_message`'s `buttons` carries the plugin's own FRIENDLY union
  //      (`'YesNo'`, `{ok, cancel}`, …), not the tagged
  //      `{OkCancelCustom: [ok, cancel]}` shape its `buttonsToRust()` encodes
  //      to. That encoding exists to satisfy a Rust serde enum; re-encoding
  //      into it here only to decode it again in `dialogTools.ts` would carry a
  //      foreign engine's serialization artifact into a contract that has no
  //      Rust on either end.

  /** `plugin:dialog|open`. `null` on cancel; an array when `multiple` is set,
   * otherwise the single chosen path — mirroring `OpenDialogReturn<T>`, which
   * the caller can discriminate because it knows the args it sent.
   *
   * DROPPED from the real `OpenDialogOptions`, named rather than silently
   * omitted: `recursive`, `pickerMode` and `fileAccessMode`, each documented by
   * the plugin itself as "meant for mobile platforms (iOS and Android)". This
   * app is Mac-only and Electron's `showOpenDialog` has no counterpart for any
   * of the three. */
  dialog_open: {
    args: {
      title?: string;
      filters?: DialogFilter[];
      defaultPath?: string;
      /** macOS guidance displayed in the native open panel. */
      message?: string;
      /** Label for the native panel's affirmative button. */
      buttonLabel?: string;
      multiple?: boolean;
      directory?: boolean;
      /** macOS room picker: allow either a workspace folder or a legacy room file. */
      room?: boolean;
      /** macOS-only in the real plugin too, and enabled by default there — so
       * only an explicit `false` turns it off. */
      canCreateDirectories?: boolean;
    };
    result: string | string[] | null;
  };
  /** `plugin:dialog|save` (`SaveDialogOptions`). `null` on cancel. */
  dialog_save: {
    args: {
      title?: string;
      filters?: DialogFilter[];
      defaultPath?: string;
      canCreateDirectories?: boolean;
    };
    result: string | null;
  };
  /** `plugin:dialog|message` — the ONE command behind the plugin's three JS
   * functions. `message`/`ask`/`confirm` are client-side sugar over it in the
   * real plugin (`index.js`'s `messageCommand`), and are client-side sugar over
   * it in `preload/index.ts` too, for the same reason: the difference between
   * them is which buttons they ask for and which answer counts as yes, not
   * which dialog is shown.
   *
   * `okLabel` is deliberately absent from `MessageDialogOptions` here: the real
   * plugin's own type marks it `@deprecated Use buttons instead` and folds it
   * into `buttons` before the command is ever called. A contract with no
   * back-compat callers starts at the recommended shape. */
  dialog_message: {
    args: {
      message: string;
      title?: string;
      kind?: MessageDialogKind;
      buttons?: MessageDialogButtons;
    };
    result: MessageDialogResult;
  };

  /** `plugin:opener|open_url`. The wire field really is named `with` (the JS
   * wrapper's `openWith` parameter is sent as `{ url, with: openWith }`), so it
   * is named `with` here. */
  open_url: { args: { url: string; with?: string }; result: void };
  /** `plugin:opener|open_path`, same `with` convention. */
  open_path: { args: { path: string; with?: string }; result: void };
  /** `plugin:opener|reveal_item_in_dir`. The plugin's JS wrapper normalizes its
   * `string | string[]` parameter into `{ paths }` before invoking; these args
   * are that already-normalized shape rather than the union the wrapper exists
   * to remove. */
  reveal_item_in_dir: { args: { paths: string[] }; result: void };

  /** THE QUIT DOOR'S THIRD ANSWER — "the user was asked about unsaved edits and
   * said go ahead; finish the quit now."
   *
   * `set_unsaved_edits` arms the door and `quit_guard_rearm` cancels a held
   * quit; until this channel there was no way to COMPLETE one. The Tauri build
   * did not need a command for it because the frontend could call
   * `@tauri-apps/plugin-process`'s bare `exit(0)`; an isolated Electron
   * renderer has no equivalent, so without this the user answering "Quit and
   * discard" left the app running until they pressed ⌘Q a second time.
   * See `quitDoor.ts`'s `confirmQuit` and `main/index.ts`'s host bridge. */
  quit_guard_confirm: { args: Record<string, never>; result: void };

  // ---- Electron host/update surface -----------------------------------
  /** The installed app version, supplied by Electron's `app.getVersion()`. */
  app_version: { args: Record<string, never>; result: string };
  /** Check the Tauri-compatible signed update feed without downloading. */
  updater_check: {
    args: Record<string, never>;
    result: { version: string; notes?: string } | null;
  };
  /** Download, verify, install and relaunch the update found by the feed. */
  updater_install: { args: Record<string, never>; result: void };

  // ---- unified provider-neutral agent harness ------------------------
  harness_capabilities: {
    args: Record<string, never>;
    result: {
      flags: Record<string, boolean>;
      roomFormat: "workspace-folder" | "sealed-db" | null;
      outsideWorkspaceIsolation: boolean;
      providers: Record<string, {
        enabled: boolean;
        installed: boolean;
        reason: string | null;
        harness: import("./harnessTypes.js").HarnessName | null;
      }>;
    };
  };
  harness_start: {
    args: {
      provider: "codex" | "claude" | "ollama-local" | "ollama-cloud" | "openrouter";
      model: string;
      privacyMode: PrivacyMode;
      writeEnabled: boolean;
      text: string;
      threadId?: string;
      systemPrompt?: string;
    };
    result: { runId: string };
  };
  harness_approve: {
    args: { runId: string; requestId: string; decision: ApprovalDecision };
    result: void;
  };
  harness_cancel: { args: { runId: string }; result: void };
  harness_cloud_writeback: { args: { runId: string; approved: boolean }; result: void };
  harness_list_runs: { args: Record<string, never>; result: HarnessHistoryRun[] };
  harness_rollback: {
    args: { runId: string };
    result: { restored: string[]; removedCreated: string[]; conflicts: string[] };
  };
  harness_restore_baseline_copies: {
    args: { runId: string; relativePaths: string[] };
    result: string[];
  };
}

// merged: 291 commands total (chunk 1: 37, chunk 2: 36, chunk 3: 36,
// chunk 4: 36, chunk 5: 36, chunk 6: 37, chunk 7: 37, chunk 8: 36).
// No command-name collisions were found across the 8 chunks (each of the
// 8 line-range extractions was disjoint and every top-level key across all
// chunks appears exactly once).
// (That count is of the api.ts extraction only, and predates later additions
// to this file; `channelAllowlist.ts`'s `ALL_COMMAND_NAMES.length` is the one
// number anything should ever compute from.)

// ============================================================================
// The dialog plugin's own option/result types
// ============================================================================
// Declared here rather than in `apiTypes.ts` because they belong to this
// contract, not to api.ts's type surface: the frontend imports them from
// `@tauri-apps/plugin-dialog` today, and will import them from the renderer's
// own bridge module after the cutover. Each mirrors the real plugin type of the
// same name.

/** `DialogFilter`. */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** `MessageDialogOptions['kind']` — `'info'` when unset, per the plugin. */
export type MessageDialogKind = "info" | "warning" | "error";

/** `MessageDialogDefaultButtons`. */
export type MessageDialogDefaultButtons = "Ok" | "OkCancel" | "YesNo" | "YesNoCancel";

/** `MessageDialogCustomButtons` — the three custom shapes, kept as a union so
 * an object with, say, `yes` but no `cancel` cannot be passed. */
export type MessageDialogCustomButtons =
  | { ok: string }
  | { ok: string; cancel: string }
  | { yes: string; no: string; cancel: string };

/** `MessageDialogButtons`. */
export type MessageDialogButtons = MessageDialogDefaultButtons | MessageDialogCustomButtons;

/** `MessageDialogResult` — `'Yes' | 'No' | 'Ok' | 'Cancel' | (string & {})`:
 * one of the four named answers for a preset button set, or the clicked
 * button's own label for a custom one. Written with
 * `Record<never, never>` rather than the plugin's `{}` because this repo's lint
 * rules reject the bare `{}` type; the two mean the same thing here — "a string
 * that keeps its literal type in a union". */
export type MessageDialogResult = "Yes" | "No" | "Ok" | "Cancel" | (string & Record<never, never>);
