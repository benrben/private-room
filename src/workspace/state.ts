import { useCallback, useRef, useState } from "react";
import {
  AiActionDef,
  AiStatus,
  AskPrivacy,
  Chat,
  ChatCommand,
  ExternalModelInfo,
  FileMeta,
  FileMetaSuggestion,
  EditApproveRequest,
  FileVersion,
  Folder,
  FrontPage,
  Job,
  McpApproveRequest,
  Memory,
  Message,
  RoomInfo,
  SearchResults,
  ScriptInfo,
  ScriptApproveRequest,
  StudioPrompts,
  Workflow,
  WorkflowNodeEvent,
} from "../api";
import { AutocompleteState } from "./composer";
import { OpenFile, Toast, WorkArea } from "./types";

/** All of Workspace's state + refs, plus the toast primitives that nearly every
 * handler needs. Split out of Workspace.tsx verbatim; the shell threads this to
 * the action factories, the effects hook, and the pane components. */
export function useWorkspaceState(_info: RoomInfo) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [model, setModel] = useState("");
  /** {engine: ExternalModelInfo[]} — populated as the Cloud picker fetches each
   * engine's model list, so a chosen sub-model shows its friendly name (not
   * the raw slug) in the model pill and toasts, without re-fetching. */
  const [engineModels, setEngineModels] = useState<
    Record<string, ExternalModelInfo[]>
  >({});
  const [attachments, setAttachments] = useState<FileMeta[]>([]);
  const [question, setQuestion] = useState("");
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [asking, setAsking] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [steps, setSteps] = useState<{ label: string; ok: boolean }[]>([]);
  const [lane, setLane] = useState("");
  const [undoByMsg, setUndoByMsg] = useState<Record<string, string[]>>({});
  const editedRef = useRef<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  // "preparing" = between the click and the microphone actually opening
  // (permission dialog, device wake) — the capture dock names this phase so a
  // slow start never looks like a dead button.
  const [dictState, setDictState] = useState<
    "idle" | "preparing" | "recording" | "busy"
  >("idle");
  const [dictOwner, setDictOwner] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const dictChunksRef = useRef<Blob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [pullingModel, setPullingModel] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullError, setPullError] = useState("");
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [viewerRev, setViewerRev] = useState(0);
  const [editMode, setEditMode] = useState(false);
  // Wave 1b (idea 10): file id whose viewer content went stale because the AI
  // wrote it while the user had unsaved edits — drives the choice banner.
  const [staleFile, setStaleFile] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  // Wave 1b (idea 5): category picked in the memory-panel add row ("" = none).
  const [memoryDraftCat, setMemoryDraftCat] = useState("");
  const [saveDraft, setSaveDraft] = useState<{ id: string; name: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  const [mcpDialogDismissed, setMcpDialogDismissed] = useState(false);
  const [approvingMcp, setApprovingMcp] = useState(false);
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [importingLink, setImportingLink] = useState(false);
  const [webOn, setWebOn] = useState(false);
  // PRIV-1: is the cloud-privacy door effectively ON for this room? null =
  // not loaded yet. Drives the loud OFF banner and the composer badge truth.
  const [privacyOn, setPrivacyOn] = useState<boolean | null>(null);
  // PRIV-1: what the door did on the latest finished turn (the chat chip);
  // cleared when the next turn starts.
  const [askPrivacy, setAskPrivacy] = useState<AskPrivacy | null>(null);
  // Engine parity: mirrors the "let a cloud AI use this room's tools" switch,
  // so the composer badge can tell the truth for external engines.
  const [advisorToolsOn, setAdvisorToolsOn] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  // Idea 11: the open side-by-side compare (null when closed). Holds both
  // diff texts (fetched once), plus the version id so the modal's own
  // "Restore this version" can re-arm the popover's confirm.
  const [compare, setCompare] = useState<{
    versionId: string;
    cause: string;
    savedAt: string;
    versionText: string | null;
    currentText: string | null;
    fileName: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showSyncWarn, setShowSyncWarn] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [moveMenuFor, setMoveMenuFor] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ file: FileMeta; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef(false);
  const ctxMenuElRef = useRef<HTMLDivElement>(null);
  const moveMenuElRef = useRef<HTMLDivElement>(null);
  const [renamingFile, setRenamingFile] = useState<{ id: string; name: string } | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [mcpApprovals, setMcpApprovals] = useState<McpApproveRequest[]>([]);
  // Wave 2 (Idea 6): queued diff-preview approval cards, mirroring mcpApprovals.
  const [editApprovals, setEditApprovals] = useState<EditApproveRequest[]>([]);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const internalDragRef = useRef(false);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState<string | null>(null);
  const [editingMemory, setEditingMemory] = useState<{
    id: string;
    content: string;
    category: string | null;
  } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [searchSel, setSearchSel] = useState(0);
  const chatRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const toastSeq = useRef(0);
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;
  // Wave 1b (idea 10): the mount-once onFileUpdated listener captures the
  // first render's closure, so it reads edit state through refs (the
  // openFileRef pattern above). editorDirtyRef mirrors the Monaco buffer's
  // dirty flag via CodeEditor's onDirtyChange.
  const editModeRef = useRef(false);
  editModeRef.current = editMode;
  const editorDirtyRef = useRef(false);
  // Wave 1b (idea 5): the auto-save switch, mirrored as a ref for the same
  // mount-once-listener reason; re-read when Settings closes.
  const memAutoSaveRef = useRef(false);
  const showSearchRef = useRef(false);
  showSearchRef.current = showSearch;
  const showSettingsRef = useRef(false);
  showSettingsRef.current = showSettings;
  const exportWarnedRef = useRef(false);
  const confirmTimer = useRef<number | undefined>(undefined);
  const autolockRef = useRef<string>("15");
  const lastActivityRef = useRef<number>(Date.now());
  const askingRef = useRef(false);
  const prevAskingRef = useRef(false);
  askingRef.current = asking;
  const askIdRef = useRef<string | null>(null);
  const recheckTimer = useRef<number | undefined>(undefined);
  const prevModelRef = useRef<string>("");
  const userPickedModelRef = useRef(false);
  const [showMemoryIntro, setShowMemoryIntro] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const showMapRef = useRef(false);
  showMapRef.current = showMap;
  // Shell redesign: the activity-rail area. map/workflows/scripts still key
  // off their show* flags (which many actions clear against each other);
  // this adds home/recordings/memory, and "files" as the default lens.
  const [area, setArea] = useState<WorkArea>("files");
  // Right-pane tab: chat is the resting state; studio and activity are the
  // contextual tools. Approvals/jobs pull attention to "activity".
  const [aiTab, setAiTab] = useState<"chat" | "studio" | "activity">("chat");
  // Library-pane tab: browse the room vs. manage the AI's evidence set.
  const [libraryTab, setLibraryTab] = useState<"browse" | "sources">("browse");
  // Wave 4a (Idea 2): the full-pane Workflows view, mirroring showMap (+ ref for
  // the mount-once Escape handler). `wfDetailId` selects a workflow inside it.
  const [showWorkflows, setShowWorkflows] = useState(false);
  const showWorkflowsRef = useRef(false);
  showWorkflowsRef.current = showWorkflows;
  const [wfDetailId, setWfDetailId] = useState<string | null>(null);
  // The room's workflows (one source of truth for the page, top bar, and the
  // file-header Actions menu). Loaded on mount, refreshed on workflows-changed.
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  // Wave 5 (Idea 13): the full-pane Scripts view (mirrors showWorkflows) + the
  // scripts index (one source of truth for the page, the file-header Run button,
  // and the header/global shortcut bars). Loaded on mount, refreshed on
  // room-files-changed / workflows-changed.
  const [showScripts, setShowScripts] = useState(false);
  const showScriptsRef = useRef(false);
  showScriptsRef.current = showScripts;
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  // Queued script-run consent cards, mirroring mcpApprovals.
  const [scriptApprovals, setScriptApprovals] = useState<ScriptApproveRequest[]>([]);
  // Per-job map of node id → live status, driving the pipeline animation.
  const [wfNodeStatus, setWfNodeStatus] = useState<
    Record<string, Record<string, WorkflowNodeEvent>>
  >({});
  // The top-bar pinned-workflows popover (⌘J) and the file-header Actions menu.
  const [qaMenuOpen, setQaMenuOpen] = useState(false);
  const [qaFileMenuOpen, setQaFileMenuOpen] = useState(false);
  // Wave 5 (Idea 13): the file-header "Scripts" shortcut menu open flag.
  const [qaScriptMenuOpen, setQaScriptMenuOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [fp, setFp] = useState<FrontPage | null>(null);
  const [fpSuggestions, setFpSuggestions] = useState<string[]>([]);
  // ADD-31: live import queue (null when idle) for the sidebar strip.
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
    name: string;
  } | null>(null);
  // ADD-30: unfinished background jobs + their live progress (sidebar cards).
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobProgress, setJobProgress] = useState<
    Record<string, { label: string; done: number; total: number }>
  >({});
  // The summary command can take seconds to RESOLVE on a cold local model
  // (Ollama waking, listing models); this optimistic flag shows a "Starting…"
  // card the instant the button is pressed, so a click is never silent.
  const [summaryStarting, setSummaryStarting] = useState(false);
  const [studioDefaults, setStudioDefaults] = useState<StudioPrompts | null>(
    null,
  );
  const [studioPrompt, setStudioPrompt] = useState<{
    kind: "flashcards" | "mindmap" | "podcast";
    scope?: string;
    text: string;
  } | null>(null);
  const studioPromptRef = useRef<HTMLTextAreaElement>(null);
  const [studioAc, setStudioAc] = useState<AutocompleteState | null>(null);
  const [aiActionDefs, setAiActionDefs] = useState<AiActionDef[] | null>(null);
  const [aiPrompt, setAiPrompt] = useState<{
    def: AiActionDef;
    scope: string | null;
    refs: string[] | null;
    text: string;
    question: string;
  } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [memSuggestion, setMemSuggestion] = useState<{ fact: string } | null>(
    null,
  );
  const [importSuggestions, setImportSuggestions] = useState<
    { fileId: string; current: string; suggestion: FileMetaSuggestion }[]
  >([]);
  // ADD-27: the workspace-wide live recording session (survives view/file
  // switches; null when nothing records). ADD-28: the feedback modal flag.
  const [recLive, setRecLive] = useState<{ fileId: string; status: string } | null>(null);
  // Timers and event closures need the CURRENT session without re-arming:
  // the auto-lock interval must see a recording the instant it starts.
  const recLiveRef = useRef<{ fileId: string; status: string } | null>(null);
  recLiveRef.current = recLive;
  // Stop→saved drain: which phase the save is in and how many phrase decodes
  // remain, plus when it began (for the sidebar card's elapsed clock). The
  // audio is already durable when this is non-null — that's the whole point
  // of surfacing it. Null outside a save.
  const [recSave, setRecSave] = useState<{
    stage: "transcribing" | "writing";
    remaining: number;
    startedAt: string;
  } | null>(null);
  // ADD-18 status of imported media transcriptions, keyed by file NAME (the
  // backend's stt-progress payload): processing | done | none | model-missing.
  const [sttStatus, setSttStatus] = useState<Record<string, string>>({});
  const [showFeedback, setShowFeedback] = useState(false);
  // Idea 3: the room's spoken voice — chat-header toggles + per-message Play.
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  // The turn-audio-done listener (hands-free re-arm) is registered once at
  // mount; it must see the current toggle without re-subscribing.
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  // Pending hands-free arm attempt (the done signal can fire while `asking`
  // is still closing — the listener defers via this single-flight timer).
  const armTimerRef = useRef<number | null>(null);

  // Stable identity: several mount-time event subscriptions (the rec-* set
  // among them) list pushToast as an effect dependency — a per-render
  // function would tear them down and back up on every render, and a fast
  // event can land in the gap.
  const pushToast = useCallback(
    (kind: Toast["kind"], text: string, action?: Toast["action"]) => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t, { id, kind, text, action }]);
      const ttl = kind === "error" ? 9000 : 5000;
      window.setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        ttl,
      );
    },
    [],
  );

  function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  return {
    files, setFiles, chats, setChats, activeChatId, setActiveChatId,
    messages, setMessages, memories, setMemories, ai, setAi, model, setModel,
    engineModels, setEngineModels,
    attachments, setAttachments, question, setQuestion, commands, setCommands,
    ac, setAc, composerRef, asking, setAsking, streamText, setStreamText,
    steps, setSteps, lane, setLane, undoByMsg, setUndoByMsg, editedRef,
    toasts, setToasts, dictState, setDictState, dictOwner, setDictOwner,
    recorderRef, dictChunksRef, dragOver, setDragOver, renaming, setRenaming,
    renameDraft, setRenameDraft, pullingModel, setPullingModel,
    pullStatus, setPullStatus, pullPercent, setPullPercent, pullError, setPullError,
    openFile, setOpenFile, viewerRev, setViewerRev, editMode, setEditMode,
    staleFile, setStaleFile, editModeRef, editorDirtyRef, memAutoSaveRef,
    memoryDraft, setMemoryDraft, memoryDraftCat, setMemoryDraftCat,
    saveDraft, setSaveDraft,
    showSettings, setShowSettings, mcpTools, setMcpTools,
    mcpDialogDismissed, setMcpDialogDismissed, approvingMcp, setApprovingMcp,
    showAddLink, setShowAddLink, linkUrl, setLinkUrl, importingLink, setImportingLink,
    webOn, setWebOn, advisorToolsOn, setAdvisorToolsOn,
    privacyOn, setPrivacyOn, askPrivacy, setAskPrivacy,
    showHistory, setShowHistory, versions, setVersions,
    confirmRestore, setConfirmRestore, compare, setCompare,
    confirmDelete, setConfirmDelete,
    showSyncWarn, setShowSyncWarn, folders, setFolders,
    collapsedFolders, setCollapsedFolders, moveMenuFor, setMoveMenuFor,
    ctxMenu, setCtxMenu, ctxMenuRef, ctxMenuElRef, moveMenuElRef,
    renamingFile, setRenamingFile, fileFilter, setFileFilter,
    addMenuOpen, setAddMenuOpen, roomMenuOpen, setRoomMenuOpen,
    modelMenuOpen, setModelMenuOpen, mcpApprovals, setMcpApprovals,
    editApprovals, setEditApprovals,
    dragOverFolder, setDragOverFolder, internalDragRef,
    renamingFolder, setRenamingFolder,
    creatingFolder, setCreatingFolder, editingMemory, setEditingMemory,
    showSearch, setShowSearch, searchQuery, setSearchQuery,
    searchResults, setSearchResults, searchSel, setSearchSel,
    chatRef, initRef, toastSeq, openFileRef, showSearchRef, showSettingsRef,
    exportWarnedRef, confirmTimer, autolockRef, lastActivityRef,
    askingRef, prevAskingRef, askIdRef, recheckTimer, prevModelRef,
    userPickedModelRef, showMemoryIntro, setShowMemoryIntro,
    showMap, setShowMap, showMapRef, showHelp, setShowHelp,
    area, setArea, aiTab, setAiTab, libraryTab, setLibraryTab,
    showWorkflows, setShowWorkflows, showWorkflowsRef, wfDetailId, setWfDetailId,
    workflows, setWorkflows, wfNodeStatus, setWfNodeStatus,
    showScripts, setShowScripts, showScriptsRef, scripts, setScripts,
    scriptApprovals, setScriptApprovals,
    qaMenuOpen, setQaMenuOpen, qaFileMenuOpen, setQaFileMenuOpen,
    qaScriptMenuOpen, setQaScriptMenuOpen,
    fp, setFp, fpSuggestions, setFpSuggestions,
    importProgress, setImportProgress,
    jobs, setJobs, jobProgress, setJobProgress,
    summaryStarting, setSummaryStarting,
    studioDefaults, setStudioDefaults, studioPrompt, setStudioPrompt,
    studioPromptRef, studioAc, setStudioAc, aiActionDefs, setAiActionDefs,
    aiPrompt, setAiPrompt, aiBusy, setAiBusy, memSuggestion, setMemSuggestion,
    importSuggestions, setImportSuggestions, pushToast, dismissToast,
    recLive, setRecLive, recLiveRef, recSave, setRecSave,
    sttStatus, setSttStatus, showFeedback, setShowFeedback,
    autoSpeak, setAutoSpeak, handsFree, setHandsFree, handsFreeRef,
    armTimerRef, speakingMsgId, setSpeakingMsgId,
  };
}

export type WSState = ReturnType<typeof useWorkspaceState>;
