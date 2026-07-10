import { useRef, useState } from "react";
import {
  AiActionDef,
  AiStatus,
  Chat,
  ChatCommand,
  FileMeta,
  FileMetaSuggestion,
  FileVersion,
  Folder,
  FrontPage,
  McpApproveRequest,
  Memory,
  Message,
  RoomInfo,
  SearchResults,
  StudioPrompts,
} from "../api";
import { AutocompleteState } from "./composer";
import { OpenFile, Toast } from "./types";

/** All of Workspace's state + refs, plus the toast primitives that nearly every
 * handler needs. Split out of Workspace.tsx verbatim; the shell threads this to
 * the action factories, the effects hook, and the pane components. */
export function useWorkspaceState(info: RoomInfo) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [model, setModel] = useState("");
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
  const [dictState, setDictState] = useState<"idle" | "recording" | "busy">(
    "idle",
  );
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
  const [memoryDraft, setMemoryDraft] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ id: string; name: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  const [mcpDialogDismissed, setMcpDialogDismissed] = useState(false);
  const [approvingMcp, setApprovingMcp] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeProgress, setSummarizeProgress] = useState("");
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [importingLink, setImportingLink] = useState(false);
  const [webOn, setWebOn] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
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
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const internalDragRef = useRef(false);
  const paneKey = `paneWidths:${info.name}`;
  const [sidebarW, setSidebarW] = useState(300);
  const [chatW, setChatW] = useState(400);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState<string | null>(null);
  const [editingMemory, setEditingMemory] = useState<{ id: string; content: string } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [searchSel, setSearchSel] = useState(0);
  const chatRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const toastSeq = useRef(0);
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;
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
  const memoryHeadRef = useRef<HTMLDivElement>(null);
  const [showMemoryIntro, setShowMemoryIntro] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const showMapRef = useRef(false);
  showMapRef.current = showMap;
  const [showHelp, setShowHelp] = useState(false);
  const [fp, setFp] = useState<FrontPage | null>(null);
  const [fpSuggestions, setFpSuggestions] = useState<string[]>([]);
  const [studioBusy, setStudioBusy] = useState<
    "flashcards" | "mindmap" | "podcast" | null
  >(null);
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
  const [showFeedback, setShowFeedback] = useState(false);

  function pushToast(
    kind: Toast["kind"],
    text: string,
    action?: Toast["action"],
  ) {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text, action }]);
    const ttl = kind === "error" ? 9000 : 5000;
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      ttl,
    );
  }

  function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  return {
    files, setFiles, chats, setChats, activeChatId, setActiveChatId,
    messages, setMessages, memories, setMemories, ai, setAi, model, setModel,
    attachments, setAttachments, question, setQuestion, commands, setCommands,
    ac, setAc, composerRef, asking, setAsking, streamText, setStreamText,
    steps, setSteps, lane, setLane, undoByMsg, setUndoByMsg, editedRef,
    toasts, setToasts, dictState, setDictState, dictOwner, setDictOwner,
    recorderRef, dictChunksRef, dragOver, setDragOver, renaming, setRenaming,
    renameDraft, setRenameDraft, pullingModel, setPullingModel,
    pullStatus, setPullStatus, pullPercent, setPullPercent, pullError, setPullError,
    openFile, setOpenFile, viewerRev, setViewerRev, editMode, setEditMode,
    memoryDraft, setMemoryDraft, showMemory, setShowMemory, saveDraft, setSaveDraft,
    showSettings, setShowSettings, mcpTools, setMcpTools,
    mcpDialogDismissed, setMcpDialogDismissed, approvingMcp, setApprovingMcp,
    summarizing, setSummarizing, summarizeProgress, setSummarizeProgress,
    showAddLink, setShowAddLink, linkUrl, setLinkUrl, importingLink, setImportingLink,
    webOn, setWebOn, showHistory, setShowHistory, versions, setVersions,
    confirmRestore, setConfirmRestore, confirmDelete, setConfirmDelete,
    showSyncWarn, setShowSyncWarn, folders, setFolders,
    collapsedFolders, setCollapsedFolders, moveMenuFor, setMoveMenuFor,
    ctxMenu, setCtxMenu, ctxMenuRef, ctxMenuElRef, moveMenuElRef,
    renamingFile, setRenamingFile, fileFilter, setFileFilter,
    addMenuOpen, setAddMenuOpen, roomMenuOpen, setRoomMenuOpen,
    modelMenuOpen, setModelMenuOpen, mcpApprovals, setMcpApprovals,
    dragOverFolder, setDragOverFolder, internalDragRef, paneKey,
    sidebarW, setSidebarW, chatW, setChatW, renamingFolder, setRenamingFolder,
    creatingFolder, setCreatingFolder, editingMemory, setEditingMemory,
    showSearch, setShowSearch, searchQuery, setSearchQuery,
    searchResults, setSearchResults, searchSel, setSearchSel,
    chatRef, initRef, toastSeq, openFileRef, showSearchRef, showSettingsRef,
    exportWarnedRef, confirmTimer, autolockRef, lastActivityRef,
    askingRef, prevAskingRef, askIdRef, recheckTimer, prevModelRef,
    userPickedModelRef, memoryHeadRef, showMemoryIntro, setShowMemoryIntro,
    showMap, setShowMap, showMapRef, showHelp, setShowHelp,
    fp, setFp, fpSuggestions, setFpSuggestions, studioBusy, setStudioBusy,
    studioDefaults, setStudioDefaults, studioPrompt, setStudioPrompt,
    studioPromptRef, studioAc, setStudioAc, aiActionDefs, setAiActionDefs,
    aiPrompt, setAiPrompt, aiBusy, setAiBusy, memSuggestion, setMemSuggestion,
    importSuggestions, setImportSuggestions, pushToast, dismissToast,
    recLive, setRecLive, showFeedback, setShowFeedback,
  };
}

export type WSState = ReturnType<typeof useWorkspaceState>;
