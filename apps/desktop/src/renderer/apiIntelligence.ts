import { invoke, listen, type UnlistenFn } from "./platform";
import type { RoomInfo, FileMeta, JobProgress, WorkflowNodeEvent, ScriptApproveRequest, StopReport, McpServerStatus, AiStatus, ModelCaps, Capability, EngineCapabilities, EnginePreflight, SupportMatrix, Chat, Message, ChatCommand, Specialist, ImageBox, SttStatus, DictSessionInfo, AiActionDef, AgentOpenFilePayload, AnnotationPayload, EditApproveRequest, McpApproveRequest, ExternalModelInfo, ModelSelectionValidation, NeuralVoiceInfo, AskPrivacy, AiProviderStatus, AskTokenUsage, AskPlanStep, AskActiveAgent, AskReport, AskStep, AskTurn, PrivacyScanProgress, StudioStep, SketchDrawn, OrganizedChange } from "./apiTypes";
import { askEvent } from "./askEvent";

export const apiIntelligence = {
  aiStatus: () => invoke<AiStatus>("ai_status"),
  /** ADD-22: tool/vision abilities per installed model, for Settings badges. */
  modelCapabilities: () => invoke<ModelCaps[]>("model_capabilities"),
  /** The OPEN room's engine, as ONE declared capability record.
   *
   *  It is NOT yet the single source it was written to be, and saying otherwise
   *  here would be a claim this file cannot keep: the trust chip still answers
   *  the locality half from `markup.ts`'s own `isExternalEngine` id list, so a
   *  new provider has to be added in both places or the chip calls a remote
   *  room local. Wiring the chip to this record is what would close that. */
  engineCapabilities: () => invoke<EngineCapabilities>("engine_capabilities"),
  /** PREFLIGHT: can the room's engine do this, asked BEFORE the run so the user
   *  gets one plain sentence instead of a stream that dies halfway. */
  enginePreflight: (capability: Capability) =>
    invoke<EnginePreflight>("engine_preflight", { capability }),
  /** The published provider × agent matrix, DERIVED from the capability records
   *  and the sidecar's own agent registry — never hand-maintained. */
  engineSupportMatrix: () => invoke<SupportMatrix>("engine_support_matrix"),
  /**
   * Which model would mark an image for the open room, or null when nothing
   * can. The ONE source of truth for "can this room see?" — the same pick the
   * grounding call itself makes, capability-asked rather than name-matched.
   * Screens used to re-derive it from the local Ollama list, so a room on a
   * cloud vision model was told to download a local one it had no use for.
   */
  groundingModelForRoom: () => invoke<string | null>("grounding_model_for_room"),
  /** Models available for a detected cloud engine ("claude-cli"/"codex-cli"),
   *  for the Cloud picker's second level. */
  listEngineModels: (engine: string) =>
    invoke<ExternalModelInfo[]>("list_engine_models", { engine }),
  /** Validate the provider's exact runtime ID before persisting a selection. */
  validateEngineModel: (engine: string, model: string) =>
    invoke<ModelSelectionValidation>("validate_engine_model", { engine, model }),
  listAiProviders: () => invoke<AiProviderStatus[]>("list_ai_providers"),
  connectAiProvider: (provider: string, apiKey: string) =>
    invoke<number>("connect_ai_provider", { provider, apiKey }),
  disconnectAiProvider: (provider: string) =>
    invoke<void>("disconnect_ai_provider", { provider }),
  warmModel: () => invoke<void>("warm_model"),
  pullModel: (name: string) => invoke<void>("pull_model", { name }),
  deleteModel: (name: string) => invoke<void>("delete_model", { name }),
  openOllama: () => invoke<void>("open_ollama"),
  listChats: () => invoke<Chat[]>("list_chats"),
  createChat: () => invoke<Chat>("create_chat"),
  deleteChat: (id: string) => invoke<void>("delete_chat", { id }),
  renameChat: (id: string, title: string) =>
    invoke<void>("rename_chat", { id, title }),
  getMessages: (chatId: string) => invoke<Message[]>("get_messages", { chatId }),
  deleteMessage: (id: string) => invoke<void>("delete_message", { id }),
  // ADD-7: each ask carries an id so it can be cancelled mid-stream.
  // PRIV-1: `privacyBypass` is the confirmed "send real details this once".
  /** `viewing` is the NAME of the file open in the viewer as the question is
   *  sent, so "summarize this" can mean what the user is pointing at. Names
   *  only — the content still travels only through the paperclip. */
  ask: (
    chatId: string,
    question: string,
    attachments: string[],
    askId: string,
    viewing?: string | null,
    privacyBypass?: boolean,
  ) =>
    invoke<Message>("ask", {
      chatId,
      question,
      attachments,
      askId,
      viewing: viewing ?? null,
      privacyBypass: privacyBypass ?? null,
    }),
  /** Stop this run — and everything it had started. Answers with what it
   *  actually stopped (see `StopReport`), so the UI can say so instead of
   *  leaving the user to guess from a screen that went quiet. */
  cancelAsk: (askId: string) => invoke<StopReport>("cancel_ask", { askId }),
  // Context handoff: summarize the chat so far and insert a marker message —
  // every future turn's history then starts from that marker.
  handoffContext: (chatId: string) => invoke<Message>("handoff_chat", { chatId }),
  /** Run a prebuilt "#name" workflow. `refs` are @-pinned file ids; `raw` is
   *  the full line the user typed (saved verbatim as the user message). Streams
   *  the same ask-delta/ask-step events as `ask`. */
  runCommand: (
    chatId: string,
    command: string,
    args: string,
    refs: string[],
    raw: string,
    askId: string,
  ) => invoke<Message>("run_command", { chatId, command, args, refs, raw, askId }),
  /** The catalog of "#name" commands (for autocomplete + help). */
  listChatCommands: () => invoke<ChatCommand[]>("list_chat_commands"),
  /** The specialists this room can dispatch to, for the composer's "*" menu.
   *  Rejects (rather than returning []) when the sidecar cannot be reached —
   *  "no specialists" and "we could not find out" are different answers. */
  listSpecialists: () => invoke<Specialist[]>("list_specialists"),
  // ADD-8: import a pasted image (base64) as a room file.
  importImageBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_image_bytes", { name, b64 }),
  // ADD-18: store an in-room voice note; transcribes in the background.
  importAudioBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_audio_bytes", { name, b64 }),
  /** Ask the vision model where `query` is in an image; boxes come back in
   *  0-1000 coordinates, so nothing here depends on the on-screen size.
   *  The measured `imgWidth`/`imgHeight` are GONE from both sides — the command
   *  is `locate_in_image(fileId, query)` (vision.rs) and the sidecar stretches
   *  the original bytes itself. The two legacy parameters lingered here as
   *  ignored placeholders while the last caller still measured the element to
   *  fill them; it no longer does, so there is nothing left to keep. */
  locateInImage: (fileId: string, query: string) =>
    invoke<ImageBox[]>("locate_in_image", { fileId, query }),
  // ---- ADD-18: on-device dictation & transcription (Whisper built in) ----
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttDownloadModel: () => invoke<void>("stt_download_model"),
  /** Stop a voice-model download in progress. Answers whether there WAS one to
   *  stop — false means nothing was downloading, and the caller must not claim
   *  it stopped anything. The download itself then fails with "Download
   *  stopped." and its part-file is removed. */
  sttCancelDownload: () => invoke<boolean>("stt_cancel_download"),
  sttDeleteModel: () => invoke<void>("stt_delete_model"),
  /** Re-run on-device transcription for a stored audio/video file, replacing its
   *  transcript. Queues on the same STT lane as import; progress arrives via the
   *  usual `stt-progress` events. Rejects for non-media files. */
  retranscribeFile: (fileId: string) =>
    invoke<void>("retranscribe_file", { fileId }),
  /** Post-process dictated text on the LOCAL model (alfred's pipeline):
   *  optional translate-to-English + an intent rewrite (raw/email/message/
   *  commit/notes/prompt). mode="off" && !translate returns text unchanged. */
  shapeText: (text: string, translate: boolean, mode: string) =>
    invoke<string>("shape_text", { text, translate, mode }),
  // ---- Streaming dictation (Metal wave): partials while you speak ----
  /** Open a streaming dictation session. Rejects with STT_MODEL_MISSING
   *  before any audio flows when the voice model isn't installed. */
  dictStart: () => invoke<DictSessionInfo>("dict_start"),
  /** ~250ms of mic samples, same wire format as recPushAudio. */
  dictPushAudio: (rate: number, dataB64: string) =>
    invoke<void>("dict_push_audio", { rate, dataB64 }),
  /** Close the session: one final whole-utterance decode (may be ""). */
  dictStop: () => invoke<string>("dict_stop"),
  /** Abandon the session without a final decode (setup failed mid-way). */
  dictCancel: () => invoke<void>("dict_cancel"),
  /** The rolling partial transcript — the FULL text so far, repainted. */
  onDictPartial: (cb: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("dict-partial", (e) => cb(e.payload)),

  // ---- Idea 3: supernatural voice (neural synthesis via the sidecar) ----
  /** The spoken voice: one sentence-sized chunk (≤1,000 chars) via the
   *  sidecar's Edge TTS seam — normalized WAV, base64. `voice` picks from
   *  the curated multilingual roster (null = Andrew, the product default).
   *  Fails when offline; the caller skips that sentence (there is no
   *  on-device fallback voice). */
  speakTextNeural: (text: string, voice: string | null) =>
    invoke<string>("speak_text_neural", { text, voice }),
  /** The service's LIVE voice catalog for the Settings picker — nothing is
   *  bundled; new service voices appear without an app update. Fails when
   *  offline (and the sidecar has no last-good copy); the picker then keeps
   *  the saved voice and says the list couldn't load. */
  listNeuralVoices: () => invoke<NeuralVoiceInfo[]>("list_neural_voices"),

  // ---- AI actions (per-file / whole-room one-shot Markdown generators) ----
  /** The catalog of AI actions (file- and room-scoped), for the menus. */
  aiActionPrompts: () => invoke<AiActionDef[]>("ai_action_prompts"),
  /** Run an AI action; saves a Markdown file and emits agent-open-file. */
  aiAction: (
    action: string,
    opts: {
      scope?: string | null;
      refs?: string[] | null;
      instructions?: string | null;
      question?: string | null;
      /** This run's id, so `cancelAsk(opId)` can Stop it — the same registry
       *  chat's Stop and a Studio build use. */
      opId?: string | null;
    },
  ) =>
    invoke<FileMeta>("ai_action", {
      action,
      scope: opts.scope ?? null,
      refs: opts.refs ?? null,
      instructions: opts.instructions ?? null,
      question: opts.question ?? null,
      opId: opts.opId ?? null,
    }),

  // ---- events (@tauri-apps/api/event) ----
  onSttDownloadProgress: (
    cb: (p: { got: number; total: number; percent: number }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ got: number; total: number; percent: number }>(
      "stt-download-progress",
      (e) => cb(e.payload),
    ),
  /** Background transcription of an imported recording: [fileName, phase],
   *  phase one of started | done | none | model-missing. */
  onSttProgress: (cb: (p: [string, string]) => void): Promise<UnlistenFn> =>
    listen<[string, string]>("stt-progress", (e) => cb(e.payload)),
  /** AUDIT 262: background OCR of a scanned page or image: [fileName, phase],
   *  phase one of started | done | none. The host emitted this from the first
   *  build and nothing listened, so a scan that runs for minutes on a local
   *  vision model showed no sign of activity anywhere in the app. */
  onOcrProgress: (cb: (p: [string, string]) => void): Promise<UnlistenFn> =>
    listen<[string, string]>("ocr-progress", (e) => cb(e.payload)),
  onOpenRoomFile: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("open-room-file", (e) => cb(e.payload)),
  // Idea 9: the room was rolled back to a checkpoint — the whole workspace
  // remounts against the swapped DB. Payload is the reopened room's info.
  onRoomRolledBack: (cb: (info: RoomInfo) => void): Promise<UnlistenFn> =>
    listen<RoomInfo>("room-rolled-back", (e) => cb(e.payload)),
  // ---- turn events -----------------------------------------------------
  //
  // Owner replacement #4 (2026-08-03): every `ask-*` event now arrives in an
  // identity envelope — `{ runId, chatId, v }` — because a window event is a
  // broadcast and the listener used to infer ownership from what was mounted.
  // `askEvent` unwraps `v` and hands the ids alongside it, so every listener
  // below has the same shape: `(payload, turn)`. The ids can be null: an
  // emitter that belongs to no conversation says so rather than borrowing one
  // (crate::turn::emit_unowned).
  onAskDelta: (
    cb: (delta: string, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<string>("ask-delta", cb),
  // CHG-5: structured turn events. `ask-step` fires when a tool runs;
  // `ask-round` fires when a new model round starts (clear the live text).
  // Two payload shapes reach this event: the sidecar sends {label, node} so a
  // step can be attributed to the agent that ran it, while the many other
  // emitters (chat commands, ai_actions, the native agent paths) send a bare
  // string. Normalised here so no consumer has to know which one fired.
  // The Sketch page. Loading and saving a drawing ride updateFileContent, so
  // starting one and flattening one to SVG are all the page needs of its own.
  createSketch: (name: string): Promise<FileMeta> =>
    invoke<FileMeta>("create_sketch", { name }),
  // Drawings autosave several times a minute, so they do NOT go through
  // updateFileContent: that snapshots a version, reindexes and broadcasts
  // room-files-changed on every call. `snapshot` is true once per editing
  // session, which is where version history actually belongs. The host does
  // not echo this canvas's own autosave back as an external-file refresh;
  // every non-editor caller of the channel gets that refresh by default.
  saveSketch: (id: string, doc: string, snapshot: boolean, expectedDoc?: string): Promise<void> =>
    invoke<void>("save_sketch", { id, doc, snapshot, expectedDoc, editorAutosave: true }),
  exportSketchSvg: (id: string): Promise<FileMeta> =>
    invoke<FileMeta>("export_sketch_svg", { id }),
  /** …and as a flat picture, for everywhere that will not take a vector. */
  exportSketchPng: (id: string): Promise<FileMeta> =>
    invoke<FileMeta>("export_sketch_png", { id }),
  // The drawing agent finished a `draw` call. Carries the WHOLE document, so
  // an open editor can fold it in without a re-read — the window between a
  // write and a read is exactly when a user's un-autosaved stroke goes missing.
  onSketchDrawn: (cb: (e: SketchDrawn) => void): Promise<UnlistenFn> =>
    listen<SketchDrawn>("sketch-drawn", (e) => cb(e.payload)),
  onAskStep: (
    cb: (step: AskStep, turn: AskTurn) => void,
  ): Promise<UnlistenFn> =>
    askEvent<string | AskStep>("ask-step", (v, turn) =>
      cb(
        typeof v === "string"
          ? { label: v, node: null }
          : { label: v.label, node: v.node ?? null },
        turn,
      ),
    ),
  // ADD-22: the deterministic router's chosen lane ("Answering", "Working on
  // your files", …), shown as a subtle label so an odd answer is explainable.
  onAskLane: (
    cb: (label: string, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<string>("ask-lane", cb),
  // Dispatch-first agent visibility: the roster of domain agents handling
  // this ask (once, before work starts) and the currently active one.
  onAskPlan: (
    cb: (plan: AskPlanStep[], turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskPlanStep[]>("ask-plan", cb),
  onAskAgent: (
    cb: (agent: AskActiveAgent, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskActiveAgent>("ask-agent", cb),
  // ADD-22: outcome of the most recent tool step, so a failed chip reads failed.
  // `node` (when present) says WHOSE most-recent step this resolves — with
  // parallel children "the most recent step" is ambiguous without it.
  onAskStepStatus: (
    cb: (p: { ok: boolean; node?: string | null }, turn: AskTurn) => void,
  ): Promise<UnlistenFn> =>
    askEvent<{ ok: boolean; node?: string | null }>("ask-step-status", cb),
  onAskRound: (cb: (turn: AskTurn) => void): Promise<UnlistenFn> =>
    askEvent<unknown>("ask-round", (_v, turn) => cb(turn)),
  /** What a specialist reported back, stamped with its graph slot — the
   * durable copy of words the live area shows once and then clears. */
  onAskReport: (
    cb: (r: AskReport, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskReport>("ask-report", cb),
  // PRIV-1: what the privacy door did on this turn ("N details hidden"), or
  // { bypassed: true } when the user shared real details this once.
  onAskPrivacy: (
    cb: (p: AskPrivacy, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskPrivacy>("ask-privacy", cb),
  // Token-budget bar: one live usage snapshot per completed model round.
  onAskTokenUsage: (
    cb: (p: AskTokenUsage, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskTokenUsage>("ask-token-usage", cb),
  // PRIV-2: background privacy-scan progress for the Settings section.
  onPrivacyScan: (cb: (p: PrivacyScanProgress) => void): Promise<UnlistenFn> =>
    listen<PrivacyScanProgress>("privacy-scan", (e) => cb(e.payload)),
  // ADD-31: named stage while a Studio (flashcards/mindmap/podcast) runs.
  // `local` says whether this stage keeps the room's content on the Mac. It
  // travels WITH the words so the pane can style a privacy consequence
  // differently from a progress aside without matching English against the
  // sentence — see studios.rs, where the flag comes from the model's declared
  // capabilities rather than from its name.
  onStudioStep: (cb: (p: StudioStep) => void): Promise<UnlistenFn> =>
    listen<StudioStep>("studio-step", (e) => cb(e.payload)),
  // ADD-30: live progress of a background job, plus its terminal flags.
  onJobProgress: (cb: (p: JobProgress) => void): Promise<UnlistenFn> =>
    listen<JobProgress>("job-progress", (e) => cb(e.payload)),
  // Wave 4a: a workflow node's live status during a run (drives the pipeline
  // animation) and any workflow save/update/delete (refresh the library).
  onWorkflowNode: (cb: (e: WorkflowNodeEvent) => void): Promise<UnlistenFn> =>
    listen<WorkflowNodeEvent>("workflow-node", (e) => cb(e.payload)),
  onWorkflowsChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("workflows-changed", () => cb()),
  onSkillsChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("skills-changed", () => cb()),
  /** The agent added, corrected or forgot a memory. Emitted by every writer,
   * including the ones with no chat turn to end (workflow nodes, scheduled
   * runs, an outside agent on the room bridge). */
  onMemoriesChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("memories-changed", () => cb()),
  // Wave 5 (Idea 13): the backend is about to run a script from this room and
  // needs the user's consent (SEC-1 — the card is data-agent-blocked).
  onScriptApproveRequest: (
    cb: (req: ScriptApproveRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<ScriptApproveRequest>("script-approve-request", (e) => cb(e.payload)),
  // ADD-31: live import queue — done/total/current name, plus a final receipt
  // (done === total) carrying imported/failed counts.
  onImportProgress: (
    cb: (p: {
      done: number;
      total: number;
      name: string;
      imported?: number;
      failed?: number;
    }) => void,
  ): Promise<UnlistenFn> =>
    listen<{
      done: number;
      total: number;
      name: string;
      imported?: number;
      failed?: number;
    }>("import-progress", (e) => cb(e.payload)),
  onAgentOpenFile: (
    cb: (payload: AgentOpenFilePayload) => void,
  ): Promise<UnlistenFn> =>
    listen<AgentOpenFilePayload>("agent-open-file", (e) => cb(e.payload)),
  onAgentAnnotate: (
    cb: (payload: AnnotationPayload) => void,
  ): Promise<UnlistenFn> =>
    listen<AnnotationPayload>("agent-annotate", (e) => cb(e.payload)),
  onFileUpdated: (cb: (fileId: string) => void): Promise<UnlistenFn> =>
    listen<string>("file-updated", (e) => cb(e.payload)),
  /** The assistant changed what the Library shows. A different fact from
   *  `room-files-changed`, which only says the list is stale: this one names
   *  the object and says which way it went, so Activity can record it. */
  onAssistantOrganized: (
    cb: (change: OrganizedChange) => void,
  ): Promise<UnlistenFn> =>
    listen<OrganizedChange>("assistant-organized", (e) => cb(e.payload)),
  onRoomFilesChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("room-files-changed", () => cb()),
  // SEC-1b: the AI is about to invoke a connected (MCP) tool and needs consent.
  onMcpApproveRequest: (
    cb: (req: McpApproveRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<McpApproveRequest>("mcp-approve-request", (e) => cb(e.payload)),
  // Wave 2 (Idea 6): the AI is about to change a file and (with the gate on)
  // needs the user to approve the before/after diff.
  onEditApproveRequest: (
    cb: (req: EditApproveRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<EditApproveRequest>("edit-approve-request", (e) => cb(e.payload)),
  onMcpStatus: (
    cb: (statuses: McpServerStatus[]) => void,
  ): Promise<UnlistenFn> =>
    listen<McpServerStatus[]>("mcp-status", (e) => cb(e.payload)),

  // ---- ADD-27: live Recording file ----
  /** Start recording — a fresh file (fileId omitted) or resume an existing
   *  recording file. Mic PCM is pushed separately via recPushAudio. The
   *  meeting's speakers are discovered from their voices; nothing to pre-set. */
};
