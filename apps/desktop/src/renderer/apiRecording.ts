import { invoke, listen, open, save, type OpenDialogOptions, type SaveDialogOptions, type UnlistenFn } from "./platform";
import type { AppDiag, FeedbackDraft, RecFile, RecLive, RecMeta, NoteKind, RecSegment, RecStart, SavedVoice, ImportReport, MediaQualityOption, FileMeta, AgentUiRequest, ViewMenuState, HarnessEvent, WorkspaceOperationProgressEvent } from "./apiTypes";

export const apiRecording = {
  recStart: (opts: {
    fileId?: string | null;
    systemAudio: boolean;
    liveTranslate?: string | null;
  }) =>
    invoke<RecStart>("rec_start", {
      fileId: opts.fileId ?? null,
      systemAudio: opts.systemAudio,
      liveTranslate: opts.liveTranslate ?? null,
    }),
  /** ~250ms of mic samples: little-endian f32 bytes, base64-packed. */
  recPushAudio: (rate: number, dataB64: string) =>
    invoke<void>("rec_push_audio", { rate, dataB64 }),
  recPause: () => invoke<void>("rec_pause"),
  recResume: () => invoke<void>("rec_resume"),
  /** Stop and save; resolves once the tail phrases finished transcribing. */
  recStop: () => invoke<RecMeta>("rec_stop"),
  recLiveStatus: () => invoke<RecLive | null>("rec_live_status"),
  recSetLiveTranslate: (language: string | null) =>
    invoke<void>("rec_set_live_translate", { language }),
  /** Live transcription on/off mid-recording. Off: the audio keeps recording
   *  but no text is written (recoverable later with recRetranscribe). */
  recSetLiveStt: (on: boolean) => invoke<void>("rec_set_live_stt", { on }),
  recGet: (id: string) => invoke<RecFile>("rec_get", { id }),
  /** Studio-style edit: delete a [t0,t1) span from transcript + playback. */
  recDeleteRange: (id: string, t0: number, t1: number) =>
    invoke<RecMeta>("rec_delete_range", { id, t0, t1 }),
  /** …and the other half of editing: RETYPE what a span says. Deleting was the
   *  only edit there was, so a misheard name meant leaving it wrong or losing
   *  the sentence. The audio is untouched — this is not a cut. */
  recCorrectRange: (id: string, t0: number, t1: number, text: string) =>
    invoke<RecMeta>("rec_correct_range", { id, t0, t1, text }),
  /** GH #5: name a speaker after transcribing ("Speaker 2" → "Dana"). Renames
   * every line they said at once; an empty name restores the machine label.
   *
   * Also teaches the ROOM this voice, so the next recording recognises them
   * without being asked again — and, when it is correcting a guess, teaches it
   * that the name it guessed belongs to somebody else. */
  recSetSpeakerName: (id: string, speaker: string, name: string) =>
    invoke<RecMeta>("rec_set_speaker_name", { id, speaker, name }),
  /** "Read this recording" / "Read again": have the room read a recording and
   * write its chapters, highlights and notes. The same job the room starts by
   * itself when a recording stops — this is the button for when it did not (no
   * model then, the room was busy, an old recording, or a transcript you have
   * since corrected). Resolves to the job id; watch it via the job events. */
  recReadStart: (id: string) => invoke<string>("rec_read_start", { id }),
  /** The reading finished — reload the recording so the tabs fill in. */
  onRecReadDone: (cb: (p: { fileId: string }) => void): Promise<UnlistenFn> =>
    listen("rec-read-done", (e) => cb(e.payload as never)),
  /** Your own note at a moment. Works while a recording is running. */
  recNoteAdd: (id: string, t0: number, kind: NoteKind, text: string, who?: string) =>
    invoke<RecMeta>("rec_note_add", { id, t0, kind, text, who }),
  /** Retype a note. Correcting one the ROOM wrote makes it yours, and the next
   * reading leaves it alone. */
  recNoteSet: (id: string, noteId: string, text: string) =>
    invoke<RecMeta>("rec_note_set", { id, noteId, text }),
  /** Name a section starting at `t0`. */
  recChapterAdd: (id: string, t0: number, title: string) =>
    invoke<RecMeta>("rec_chapter_add", { id, t0, title }),
  /** Rename a chapter — and make it yours. */
  recChapterSet: (id: string, chapterId: string, title: string) =>
    invoke<RecMeta>("rec_chapter_set", { id, chapterId, title }),
  /** Mark a span worth coming back to. Works while recording. */
  recHighlightAdd: (id: string, t0: number, t1: number) =>
    invoke<RecMeta>("rec_highlight_add", { id, t0, t1 }),
  /** Remove one item ("note" | "chapter" | "highlight"). */
  recItemDelete: (id: string, kind: "note" | "chapter" | "highlight", itemId: string) =>
    invoke<RecMeta>("rec_item_delete", { id, kind, itemId }),
  /** The voices this room can recognise. */
  voicesList: () => invoke<SavedVoice[]>("voices_list"),
  /** Forget a saved voice — transcripts already written keep the names they
   * show. Returns the remaining voices. */
  voiceForget: (name: string) => invoke<SavedVoice[]>("voice_forget", { name }),
  /** Render the cuts into a new "<name> (edited).wav" file. */
  recExportClean: (id: string) => invoke<FileMeta>("rec_export_clean", { id }),
  /** Translate the whole transcript on the local model into any language. */
  recTranslate: (id: string, language: string) =>
    invoke<FileMeta>("rec_translate", { id, language }),
  /** Rebuild the whole transcript from the audio with the current pipeline
   *  (saved recordings only; the audio is untouched, the old transcript goes
   *  to History). Progress arrives via onRecRetranscribe. */
  recRetranscribe: (id: string) => invoke<RecMeta>("rec_retranscribe", { id }),
  onRecPartial: (
    cb: (p: { fileId: string; source: "mic" | "sys"; t0: number; text: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-partial", (e) => cb(e.payload as never)),
  onRecSegment: (
    cb: (p: { fileId: string; segment: RecSegment }) => void,
  ): Promise<UnlistenFn> => listen("rec-segment", (e) => cb(e.payload as never)),
  /** A row already on screen was the microphone's echo of meeting audio the
   *  system lane captured too — remove it. */
  onRecSegmentDrop: (
    cb: (p: { fileId: string; id: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-segment-drop", (e) => cb(e.payload as never)),
  /** The meeting's speakers were re-derived from every voice heard so far —
   *  labels already on screen may change (that's the point). */
  /** Speakers sorting themselves out mid-meeting. Carries the name overlay as
   * well as the labels: a pass can change what a voice is CALLED without
   * moving a single label (a saved voice recognised as the meeting grows). */
  onRecRelabel: (
    cb: (p: {
      fileId: string;
      labels: { id: string; speaker: string }[];
      speakerNames?: Record<string, string>;
      recognized?: string[];
    }) => void,
  ): Promise<UnlistenFn> => listen("rec-relabel", (e) => cb(e.payload as never)),
  onRecLevel: (
    cb: (p: { fileId: string; mic: number; sys: number; durationCs: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-level", (e) => cb(e.payload as never)),
  onRecState: (
    cb: (p: { fileId: string; status: string; durationCs: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-state", (e) => cb(e.payload as never)),
  /** Stop→saved drain progress: the audio is already durable when the first
   *  event arrives; `remaining` counts phrase decodes still queued. */
  onRecSaveProgress: (
    cb: (p: { fileId: string; stage: "transcribing" | "writing"; remaining: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-save-progress", (e) => cb(e.payload as never)),
  onRecSource: (
    cb: (p: { fileId: string; source: string; status: string; message: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-source", (e) => cb(e.payload as never)),
  onRecError: (
    cb: (p: { fileId: string; message: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-error", (e) => cb(e.payload as never)),
  onRecLiveTranslation: (
    cb: (p: { fileId: string; segId: string; text: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-live-translation", (e) => cb(e.payload as never)),
  onRecTranslateProgress: (
    cb: (p: { fileId: string; done: number; total: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-translate-progress", (e) => cb(e.payload as never)),
  onRecRetranscribe: (
    cb: (p: { fileId: string; doneCs: number; totalCs: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-retranscribe", (e) => cb(e.payload as never)),

  // ---- ADD-28: feedback → GitHub issue ----
  /** Draft an issue title/body from raw feedback on the LOCAL model. */
  feedbackDraft: (text: string) =>
    invoke<FeedbackDraft>("feedback_draft", { text }),
  appDiag: () => invoke<AppDiag>("app_diag"),
  /** Show the folder holding the app's two log files in Finder, and return its
   *  path so it can be named on screen. The logs hold ids, counts, durations
   *  and error kinds — never anything from a room — so they are safe to attach
   *  to a bug report. */
  revealLogs: () => invoke<string>("reveal_logs"),

  /** Tell Rust whether the open editor holds edits a quit would throw away.
   *  ⌘Q raises no window close request on macOS, so the window's own guard
   *  never sees it — the event-loop handler that does is synchronous and
   *  cannot ask anything, which is why this is pushed rather than pulled. */
  setUnsavedEdits: (on: boolean) => invoke<void>("set_unsaved_edits", { on }),
  /** Answered the quit question with "no": re-arm the door, buffer still dirty. */
  quitGuardRearm: () => invoke<void>("quit_guard_rearm"),
  quitGuardConfirm: () => invoke<void>("quit_guard_confirm"),
  /** Rust held a ⌘Q so this window can ask about those edits. Whoever listens
   *  OWNS finishing the quit — Rust will not hold the next one. */
  onQuitRequested: (cb: () => void): Promise<UnlistenFn> =>
    listen("quit-requested", () => cb()),

  /** A row of the native View menu was chosen; the payload is its id.
   *  One event for the whole menu — see src-tauri/src/menu.rs. */
  onMenuAction: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("menu-action", (e) => cb(e.payload)),
  /** What the native View menu should be showing. Sent whole rather than a
   *  tick at a time so the menu is never caught halfway through a layout
   *  change, and once more with `enabled: false` when the room closes — the
   *  menu bar outlives the room, and a row that cannot act must not look
   *  like it can. Cosmetic by design: it never rejects into the UI. */
  syncViewMenu: (view: ViewMenuState) => invoke<void>("menu_sync", { view }),

  /** ADD-26 / BROWSE-2: download a video or audio page into the room via
   *  yt-dlp (fetched on first use), YouTube included. Emits ytdlp-progress.
   *  `maxHeight` caps the resolution (the modal's quality pick); omitted =
   *  best available. */
  importMediaUrl: (url: string, maxHeight?: number) =>
    invoke<ImportReport>("import_media_url", { url, maxHeight }),
  /** The qualities a video actually offers, best first — feeds the modal's
   *  picker. A metadata-only probe, but still an outbound reach (same web
   *  gating as the download). */
  listMediaFormats: (url: string) =>
    invoke<MediaQualityOption[]>("list_media_formats", { url }),
  /** Abandon the video download running now. The command itself then rejects
   *  with "Stopped." — a download you started by mistake used to have no way
   *  out short of quitting the app. */
  cancelMediaDownload: () => invoke<void>("cancel_media_download"),
  onYtdlpProgress: (
    cb: (p: { status: string; percent: number | null }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ status: string; percent: number | null }>("ytdlp-progress", (e) =>
      cb(e.payload),
    ),

  // ADD-25: the agent↔UI bridge — the backend asks the live webview for an
  // element snapshot / click / frame grab; the driver answers by id.
  onAgentUiRequest: (
    cb: (req: AgentUiRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<AgentUiRequest>("agent-ui-request", (e) => cb(e.payload)),
  onHarnessEvent: (cb: (event: HarnessEvent) => void): Promise<UnlistenFn> =>
    listen<HarnessEvent>("harness-event", (e) => cb(e.payload)),
  /** Scan/copy/validate progress shared by migration, packages, checkpoints,
   * and the protected baseline made before a write-enabled agent starts. */
  onWorkspaceOperationProgress: (
    cb: (event: WorkspaceOperationProgressEvent) => void,
  ): Promise<UnlistenFn> =>
    listen<WorkspaceOperationProgressEvent>(
      "workspace-operation-progress",
      (e) => cb(e.payload),
    ),
  resolveAgentUi: (id: string, payload: unknown) =>
    invoke<void>("resolve_agent_ui", { id, payload }),

  // ---- dialogs (@tauri-apps/plugin-dialog) ----
  chooseOpenPath: (options?: OpenDialogOptions) => open(options),
  chooseSavePath: (options?: SaveDialogOptions) => save(options),};
