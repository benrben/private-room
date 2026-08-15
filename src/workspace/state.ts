import { useCallback, useRef, useState } from "react";
import {
  AiActionDef,
  AiStatus,
  AskPrivacy,
  AskTokenUsage,
  Chat,
  ChatCommand,
  Specialist,
  ExternalModelInfo,
  FileMeta,
  FileMetaSuggestion,
  TrashedFile,
  EditApproveRequest,
  FileVersion,
  Provenance,
  Folder,
  FrontPage,
  Job,
  OrganizedRecord,
  BrowseConsentRequest,
  McpApproveRequest,
  McpServerStatus,
  Memory,
  Message,
  Podcast,
  RoomInfo,
  SearchResults,
  ScriptInfo,
  ScriptApproveRequest,
  SkillSummary,
  StudioPrompts,
  Workflow,
  WorkflowNodeEvent,
} from "../api";
import {
  applyEvent,
  finishRun,
  isAsking,
  liveTurn,
  LiveTurn,
  runIdOf as runIdIn,
  Runs,
  startRun,
  usageOf,
} from "./runIdentity";
import { AutocompleteState } from "./composer";
import { type FileSort, loadFileSort, saveFileSort } from "./fileSort";
import { OpenFile, Toast, WorkArea } from "./types";
import { clearToastsAbout, stackToast, toastLifeMs } from "./toastStack";

/** How many error messages the bug-report sheet may offer. Enough to cover the
 * run-up to a failure, few enough that the sheet stays readable — the user has
 * to be able to READ what they are attaching before they attach it. */
const MAX_ERROR_LOG = 10;

/** The popovers the ROOM TOOLBAR can raise. At most one is open at a time and
 * `openMenu` holds which — see the field's own comment in the hook below.
 *
 * Menus that belong to some other surface (the library's Add menu, the file
 * header's Actions and Scripts menus) are deliberately absent: they are not in
 * competition with these for the same corner of the screen, and folding them
 * in would mean opening a file-header menu closed the toolbar's. */
export type TopMenu =
  | "model"
  | "room"
  | "workflows"
  | "scripts"
  | "layout"
  | "assistant";

/** All of Workspace's state + refs, plus the toast primitives that nearly every
 * handler needs. Split out of Workspace.tsx verbatim; the shell threads this to
 * the action factories, the effects hook, and the pane components. */
export function useWorkspaceState(_info: RoomInfo) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  // Trash: deleted files, kept apart from `files` on purpose — anything that
  // reads `files` is asking "what is in this room", and a trashed file is not.
  const [trashed, setTrashed] = useState<TrashedFile[]>([]);
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
  // The composer's "*" menu: the specialists this room can dispatch to.
  // `null` is NOT "none" — it is "not established yet", and the menu says which
  // of the two it is looking at. `specialistsError` carries the reason a lookup
  // failed, because "we could not ask" must never be drawn as "there are none".
  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [specialistsError, setSpecialistsError] = useState("");
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // ---- the live overlay of a turn in progress, OWNED BY ITS CHAT -----------
  //
  // Owner replacement #4 (2026-08-03). All of this used to be seven module-wide
  // useStates written by unkeyed window events, so it described "the newest
  // turn" rather than "this conversation's turn": start an answer, open another
  // chat, and the previous chat's streamed text, step chips and agent roster
  // were painting into the new one (live QA: "new chats inherit orphaned agent
  // work"). Keyed by chat id, each turn writes only into its own slot and the
  // reads below simply look up the conversation on screen — so two chats can
  // have runs in flight at once with no way to cross-talk, and an answer the
  // user switched away from is still complete when they switch back.
  const [runs, setRuns] = useState<Runs>({});
  // The conversation on screen, for the mount-once event listeners — they close
  // over the first render and cannot read `activeChatId` directly.
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  const live: LiveTurn = liveTurn(runs, activeChatId);
  const asking = isAsking(runs, activeChatId);
  const streamText = live.text;
  const steps = live.steps;
  const lane = live.lane;
  // Dispatch-first agent visibility: the roster of domain agents handling this
  // chat's ask (ask-plan, one entry per step) and which one is active
  // (ask-agent).
  const agentPlan = live.plan;
  const activeAgent = live.agent;
  // The same tool steps as `steps`, but filed under the agent that ran them
  // (`AskPlanStep.key`) so the graph's inspector can show one node's work
  // alone. Kept ALONGSIDE the flat list rather than replacing it: `steps` is
  // still what the flat chip row renders, and the many non-sidecar `ask-step`
  // emitters carry no node at all.
  const agentSteps = live.agentSteps;
  // What each specialist handed back, keyed by `AskPlanStep.key`. The same
  // words stream into the live text area and are wiped by the next round, so
  // this is the only lasting copy — and for a child that FAILED it is the only
  // account of why anywhere in the UI.
  const agentReports = live.agentReports;

  // The rules themselves live in `runIdentity.ts` — pure, and pinned by
  // `e2e/page-script/runIdentity.test.mjs`. These are just their React bindings.
  const beginRun = useCallback(
    (chatId: string, runId: string) =>
      setRuns((r) => startRun(r, chatId, runId)),
    [],
  );
  const endRun = useCallback(
    (chatId: string) => setRuns((r) => finishRun(r, chatId)),
    [],
  );
  const runIdOf = useCallback(
    (chatId: string | null) => runIdIn(runs, chatId),
    [runs],
  );
  const applyToRun = useCallback(
    (chatId: string, runId: string | null, patch: (t: LiveTurn) => LiveTurn) =>
      setRuns((r) => applyEvent(r, chatId, runId, patch)),
    [],
  );
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
  // The hands-free re-arm listener is registered once at mount, so it cannot
  // read `dictState` directly — and it MUST read it: arming while a dictation
  // the user started themselves is in flight lands in `dictateTo`'s toggle
  // branch and STOPS them mid-sentence.
  const dictStateRef = useRef(dictState);
  dictStateRef.current = dictState;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const dictChunksRef = useRef<Blob[]>([]);
  // Streaming dictation (Metal wave): the active session's stop function
  // (the mic re-click and the dock's Stop call it) + the rolling partial
  // transcript the capture dock shows for non-composer owners.
  const dictStreamRef = useRef<(() => void) | null>(null);
  const [dictPartial, setDictPartial] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [pullingModel, setPullingModel] = useState(false);
  // The model name a running download was started with — what Stop needs to
  // reach the backend's `pull:<name>` cancel flag. A ref, not state: `model`
  // can be switched (or the card re-rendered) while a multi-gigabyte pull is
  // still running, and Stop must never reach for a name that has moved on.
  const pullingModelRef = useRef<string | null>(null);
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
  // Deep-link target when Settings opens (a section id like "set-cloud-privacy",
  // e.g. from the status-bar trust chip); null = open at the top.
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  // Full per-server statuses (drives the Connectors area's count badge).
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpDialogDismissed, setMcpDialogDismissed] = useState(false);
  const [approvingMcp, setApprovingMcp] = useState(false);
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [importingLink, setImportingLink] = useState(false);
  const [webOn, setWebOn] = useState(false);
  // PRIV-1: is the cloud-privacy door effectively ON for this room? null =
  // not loaded yet. Drives the loud OFF banner and the composer badge truth.
  const [privacyOn, setPrivacyOn] = useState<boolean | null>(null);
  // The other two facts the SAME `privacyStatus()` call already returns. Home
  // used to fetch them again on its own, keyed on the file count, so the count
  // froze for as long as no file was added and the scan state was never read
  // at all — while a second IPC round trip asked for everything and kept one
  // field. One call, one place, every reader.
  const [privacyPending, setPrivacyPending] = useState(0);
  const [privacyScanning, setPrivacyScanning] = useState(false);
  // PRIV-1: what the door did on the latest finished turn (the chat chip),
  // per conversation — it describes THAT chat's last turn, and survives the
  // turn ending, so it cannot live in `runs`.
  const [privacyByChat, setPrivacyByChat] = useState<
    Record<string, AskPrivacy | null>
  >({});
  const askPrivacy = (activeChatId && privacyByChat[activeChatId]) || null;
  const setAskPrivacy = useCallback(
    (chatId: string, p: AskPrivacy | null) =>
      setPrivacyByChat((m) => ({ ...m, [chatId]: p })),
    [],
  );
  // Token-budget bar: the latest turn's usage snapshot FOR EACH CHAT.
  //
  // Owner replacement #4: this was one global snapshot that only the next
  // turn's event ever overwrote, so a brand-new conversation kept displaying
  // the previous one's reading — live QA saw an identical "30,034 / 1,000,000"
  // with 12,092 tokens of "conversation history" on a chat that had none, and
  // reasonably concluded New Chat was inheriting context. It was not: history
  // is keyed by chat_id in `db::recent_messages` and a fresh chat matches no
  // rows. Only the READOUT was stale — the more dangerous kind of wrong,
  // because it made a correct system look broken. A fresh chat now reads zero
  // because it HAS no entry, not because something remembered to clear one.
  const [usageByChat, setUsageByChat] = useState<
    Record<string, AskTokenUsage>
  >({});
  const tokenUsage = usageOf(usageByChat, activeChatId);
  const setChatUsage = useCallback(
    (chatId: string, usage: AskTokenUsage) =>
      setUsageByChat((m) => ({ ...m, [chatId]: usage })),
    [],
  );
  // True while a "hand off" (context-compaction) summary call is in flight.
  const [handoffStarting, setHandoffStarting] = useState(false);
  // Engine parity: mirrors the "let a cloud AI use this room's tools" switch,
  // so the composer badge can tell the truth for external engines.
  const [advisorToolsOn, setAdvisorToolsOn] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  // How many UNPINNED versions a file keeps. Read from the host (one constant,
  // one source) rather than written twice — the History strip states the limit
  // so the eleventh save no longer drops the oldest version in silence.
  const [versionsKept, setVersionsKept] = useState(10);
  // ART-1: what produced the open file's CURRENT content. `null` means the room
  // recorded nothing, which the History strip shows as no attribution at all —
  // never as "made by the AI".
  const [headProvenance, setHeadProvenance] = useState<Provenance | null>(null);
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
  // The message a search hit asked the transcript to jump to, held only until
  // the pane has PAINTED it. The transcript renders a tail page (CHAT_PAGE), so
  // a hit on an older message has no element to scroll to and the search jump
  // silently did nothing; ChatPane reads this, widens its page far enough to
  // include the row, and clears it.
  const [revealMsgId, setRevealMsgId] = useState<string | null>(null);
  const [showSyncWarn, setShowSyncWarn] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  // The Library's MULTI-SELECTION — the set of file rows the user has picked
  // out for one action (move, trash, export).
  //
  // Deliberately NOT `attachments`, and the two must never be merged. The "AI
  // sources" tab's checkboxes already mean something else entirely: which files
  // ground the next answer. One set is "what am I about to do something to",
  // the other is "what may the model read". Collapsing them would make
  // selecting three files to move them silently rewrite the evidence set of the
  // next question.
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  // The Trash tab's own selection. A separate set on purpose: the two tabs list
  // disjoint rows, and one shared set would carry a library selection into a
  // "delete for good" button — the one place in the app where acting on the
  // wrong set cannot be undone.
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<string>>(new Set());
  // The podcast script attached to the OPEN file, when it has one. Null covers
  // both "not a podcast" and "a podcast page from before scripts were stored as
  // data" — the panel tells those two apart and says which.
  const [openPodcast, setOpenPodcast] = useState<Podcast | null>(null);
  // Where a shift-range starts. Held separately from the selection because the
  // anchor survives the range being re-drawn: shift-clicking twice from the
  // same anchor must replace the range, not extend from wherever it last ended.
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  // The ids currently on screen, in the exact order they are painted (loose
  // files first, then each folder's contents). Owned here rather than
  // recomputed by every consumer because a shift-range and ⌘A both have to
  // agree with what the reader can actually see — a range computed against the
  // unsorted or unfiltered list selects rows that are not on the screen.
  const [visibleFileOrder, setVisibleFileOrder] = useState<string[]>([]);
  const [moveMenuFor, setMoveMenuFor] = useState<{
    /** The files this move applies to — one for a single row, many when the
     * multi-selection is what opened it. */
    ids: string[];
    x: number;
    y: number;
  } | null>(null);
  // `files` is the set the menu acts on: one row normally, the whole selection
  // when the right-clicked row is part of it. `file` (the first) stays the
  // subject of the single-file items (Open, Rename) so those never have to
  // guess which of several they meant.
  const [ctxMenu, setCtxMenu] = useState<{
    file: FileMeta;
    files: FileMeta[];
    x: number;
    y: number;
  } | null>(null);
  const ctxMenuRef = useRef(false);
  const ctxMenuElRef = useRef<HTMLDivElement>(null);
  const moveMenuElRef = useRef<HTMLDivElement>(null);
  // The ONE open rename box. `where` says which surface opened it: the library
  // shows a row for the open file too, so without it the viewer's Rename and
  // the row's Rename both draw an autoFocus input bound to this same slot —
  // React focuses both in one commit, the second focus blurs the first, and
  // that blur commits (i.e. cancels) the rename the moment it opens.
  const [renamingFile, setRenamingFile] = useState<{
    id: string;
    name: string;
    where?: "viewer" | "library";
  } | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  // How the Library orders files. Device-wide and remembered, so a reader who
  // works by name doesn't re-choose it every launch.
  const [fileSort, setFileSortState] = useState<FileSort>(loadFileSort);
  const setFileSort = useCallback((next: FileSort) => {
    setFileSortState(next);
    saveFileSort(next);
  }, []);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  /** WHICH top-bar popover is open, or null. One value, not one boolean each.
   *
   * The bar used to carry a separate flag per menu (model / room / pinned
   * workflows / global scripts) and enforce "only one popover at a time" by
   * hand: every open site had to remember to clear the other flags, and the
   * Escape handler had to clear all of them. That is a rule nothing checked —
   * the scripts menu never joined it at all, so it stacked over the model
   * picker — and the navigation redesign adds two more menus to the same bar.
   * A single slot makes the exclusion structural: opening one IS closing the
   * others, and Escape sets it to null. */
  const [openMenu, setOpenMenu] = useState<TopMenu | null>(null);
  const [mcpApprovals, setMcpApprovals] = useState<McpApproveRequest[]>([]);
  // BROWSE-1: queued outbound-typing consent cards (room content about to be
  // typed into a web page), mirroring mcpApprovals.
  const [browseConsents, setBrowseConsents] = useState<BrowseConsentRequest[]>([]);
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
  // Why the last search returned nothing to show ("" = it ran fine). Results
  // are cleared alongside it, so a failed query can never leave the previous
  // query's hits on screen looking current.
  const [searchError, setSearchError] = useState("");
  const [searchSel, setSearchSel] = useState(0);
  // The keyboard-shortcuts sheet (⌘/ or "?", the palette, the room menu).
  const [showShortcuts, setShowShortcuts] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  /** Has this room's one-shot seeding run? Only the LOADS are guarded by it —
   * the backend subscriptions must be re-made on every mount (see effects.ts).
   * A real unlock builds a fresh state, so a reopened room seeds again. */
  const seededRef = useRef(false);
  const toastSeq = useRef(0);
  /** The error toasts this session, newest last — see `pushToast`. A ref, not
   * state: nothing renders on every error, and the feedback sheet reads it at
   * the moment it opens. */
  const errorLogRef = useRef<{ at: string; text: string }[]>([]);
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;
  // A file whose bytes are still being fetched. `viewFile` awaits
  // `get_file_content` — a synchronous command that takes the room mutex —
  // BEFORE it sets `openFile`, so the most-used action in the app showed
  // nothing at all until the bytes landed and read as a dead click. Deliberately
  // a separate flag rather than making `openFile.content` optional: that shape
  // is read across the whole viewer pane, and duplicating one id is cheaper
  // than reshaping a type for one call site.
  const [openingFileId, setOpeningFileId] = useState<string | null>(null);
  // Wave 1b (idea 10): the mount-once onFileUpdated listener captures the
  // first render's closure, so it reads edit state through refs (the
  // openFileRef pattern above). editorDirtyRef mirrors the Monaco buffer's
  // dirty flag via CodeEditor's onDirtyChange.
  const editModeRef = useRef(false);
  editModeRef.current = editMode;
  const editorDirtyRef = useRef(false);
  // The open editor's own save, registered by CodeEditor while it is mounted.
  // The unsaved-edits dialog needs it: "Save and continue" has to write the
  // buffer that is about to be unmounted, and only the editor holds that text.
  // Resolves false when the write failed, so a failed save never proceeds with
  // the navigation that would have thrown the edit away.
  const editorSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  // The pending "you have unsaved edits" question. `proceed` is the navigation
  // that was interrupted — running it is what Save and Discard both end with.
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  // Wave 1b (idea 5): the auto-save switch, mirrored as a ref for the same
  // mount-once-listener reason; re-read when Settings closes.
  const memAutoSaveRef = useRef(false);
  const showSearchRef = useRef(false);
  showSearchRef.current = showSearch;
  const showSettingsRef = useRef(false);
  showSettingsRef.current = showSettings;
  const exportWarnedRef = useRef(false);
  const autolockRef = useRef<string>("15");
  const lastActivityRef = useRef<number>(Date.now());
  // "Is ANY turn in flight?" — autolock, the hands-free re-arm and the lock
  // ritual all mean the whole app, not the chat on screen (locking mid-answer
  // in a background conversation is the same casualty). `asking` above is the
  // per-chat question; these two are deliberately different.
  const askingRef = useRef(false);
  const prevAskingRef = useRef(false);
  askingRef.current = Object.keys(runs).length > 0;
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
  const [libraryTab, setLibraryTab] = useState<"browse" | "sources" | "trash">(
    "browse",
  );
  // "New creation" (the Creations sidebar header, ⌘T in Create). A creation is
  // COMPOSED rather than created, so there is no object to open — "new" means
  // an empty composer. A counter, not a boolean: pressing it twice in a row has
  // to clear twice, and a flag that was already true would do nothing the
  // second time. The Create page watches it and resets its prompt.
  const [newCreationSeq, setNewCreationSeq] = useState(0);
  const bumpNewCreation = useCallback(() => setNewCreationSeq((n) => n + 1), []);
  // Which creation the Creations sidebar has selected, when it is a job rather
  // than a finished file (a finished one is just the open file). Null = the
  // composer is what the workspace shows.
  const [selectedCreationJob, setSelectedCreationJob] = useState<string | null>(null);
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
  // Skills are their own encrypted library (not files/folders). Only metadata
  // lives here; the selected SKILL.md + resource tree is loaded on demand.
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  // Queued script-run consent cards, mirroring mcpApprovals.
  const [scriptApprovals, setScriptApprovals] = useState<ScriptApproveRequest[]>([]);
  // Per-job map of node id → live status, driving the pipeline animation.
  const [wfNodeStatus, setWfNodeStatus] = useState<
    Record<string, Record<string, WorkflowNodeEvent>>
  >({});
  // The file-header Actions menu. (The top bar's own pinned-workflows popover
  // moved into `openMenu` above, with every other menu that bar can raise.)
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
  // What the ASSISTANT changed about how the room is organised, newest first —
  // Activity's record of the one kind of room change that leaves no job behind.
  //
  // Session-only, and deliberately so. It is a convenience for the reader who
  // steps away mid-turn, not an audit trail: the room's durable record of every
  // agent act is the chat transcript, and a second one on disk would be a
  // second thing to keep true, to migrate, and to leak. Capped for the same
  // reason the error log is — a panel is not an archive.
  const [organized, setOrganized] = useState<OrganizedRecord[]>([]);
  // ADD-30: unfinished background jobs + their live progress (sidebar cards).
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobProgress, setJobProgress] = useState<
    Record<string, { label: string; done: number; total: number }>
  >({});
  // The summary command can take seconds to RESOLVE on a cold local model
  // (Ollama waking, listing models); this optimistic flag shows a "Starting…"
  // card the instant the button is pressed, so a click is never silent.
  const [summaryStarting, setSummaryStarting] = useState(false);
  // AUDIT 262: what a Studio job is doing RIGHT NOW ("Reading the material…",
  // "Building the deck — a local model can take a few minutes…"). The backend
  // has always named each step, and nothing was listening: a run that takes
  // minutes on a local model sat on "Starting…" the whole way through, and the
  // step that says "your cloud AI is writing (content leaves this Mac)" — a
  // privacy statement, not a nicety — was never shown at all. "" = no step
  // reported since the last job ended.
  /** The Studio's current stage, and whether it keeps content on this Mac.
   * The flag rides with the words because the pane draws a privacy
   * consequence differently from a progress aside — see apiTypes' StudioStep. */
  const [studioStep, setStudioStep] = useState<{ text: string; local: boolean }>({
    text: "",
    local: true,
  });
  // AUDIT 262: file names whose scanned pages are being read right now. The
  // `ocr-progress` event existed from the first build with nothing listening,
  // so a vision pass that takes minutes on a local model looked like nothing at
  // all was happening. Names, not a count: "Reading X" is the answer to "why is
  // this slow", and a bare number is not.
  const [ocrFiles, setOcrFiles] = useState<string[]>([]);
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
  // The running AI action's cancel id. Studio builds have had a Stop button all
  // along; Summarize/Research/Translate/Fact-check had none, and their modal's
  // Cancel went grey while the run held the window — so a room-wide Summarize
  // on a local model could not be ended at all. Null when nothing is running.
  const [aiOpId, setAiOpId] = useState<string | null>(null);
  const [aiStopping, setAiStopping] = useState(false);
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
    (
      kind: Toast["kind"],
      text: string,
      action?: Toast["action"],
      about?: string,
    ) => {
      const id = ++toastSeq.current;
      // ADD-28 (audit #548): keep the last few error messages so the bug-report
      // sheet can offer them. An error pop-up is this app's ONLY report that
      // something failed and it disappears when dismissed, so "what did it
      // say?" was answerable from memory alone. In-memory only — this is room
      // content (an error can name a file), so it is never persisted, never
      // logged, and the sheet attaches it only if the user ticks the box after
      // reading it.
      if (kind === "error") {
        errorLogRef.current = [
          ...errorLogRef.current,
          { at: new Date().toISOString(), text },
        ].slice(-MAX_ERROR_LOG);
      }
      // Which messages stack, which replace one another, and which wait to be
      // dismissed are all one set of rules — see workspace/toastStack.ts.
      const toast: Toast = { id, kind, text, action, about };
      setToasts((t) => stackToast(t, toast));
      const life = toastLifeMs(toast);
      if (life === null) return;
      window.setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        life,
      );
    },
    [],
  );

  function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  /** Retire whatever was said about `about` — for the caller that just made it
   * untrue by succeeding. See `clearToastsAbout`. */
  const forgetToastsAbout = useCallback((about: string) => {
    setToasts((t) => clearToastsAbout(t, about));
  }, []);

  return {
    files, setFiles, trashed, setTrashed, chats, setChats, activeChatId, setActiveChatId,
    messages, setMessages, memories, setMemories, ai, setAi, model, setModel,
    engineModels, setEngineModels,
    attachments, setAttachments, question, setQuestion, commands, setCommands,
    specialists, setSpecialists, specialistsError, setSpecialistsError,
    ac, setAc, composerRef, asking, streamText,
    steps, lane, agentPlan,
    activeAgent, agentSteps,
    agentReports,
    runs, beginRun, endRun, applyToRun, runIdOf,
    undoByMsg, setUndoByMsg, editedRef,
    toasts, setToasts, dictState, setDictState, dictStateRef, dictOwner, setDictOwner,
    recorderRef, dictChunksRef, dictStreamRef, dictPartial, setDictPartial,
    dragOver, setDragOver, renaming, setRenaming,
    renameDraft, setRenameDraft, pullingModel, setPullingModel, pullingModelRef,
    pullStatus, setPullStatus, pullPercent, setPullPercent, pullError, setPullError,
    openFile, setOpenFile, openingFileId, setOpeningFileId,
    viewerRev, setViewerRev, editMode, setEditMode,
    staleFile, setStaleFile, editModeRef, editorDirtyRef, memAutoSaveRef,
    editorSaveRef, pendingLeave, setPendingLeave,
    memoryDraft, setMemoryDraft, memoryDraftCat, setMemoryDraftCat,
    saveDraft, setSaveDraft,
    showSettings, setShowSettings, settingsSection, setSettingsSection, mcpTools, setMcpTools,
    mcpStatuses, setMcpStatuses,
    mcpDialogDismissed, setMcpDialogDismissed, approvingMcp, setApprovingMcp,
    showAddLink, setShowAddLink, linkUrl, setLinkUrl, importingLink, setImportingLink,
    webOn, setWebOn, advisorToolsOn, setAdvisorToolsOn,
    privacyOn, setPrivacyOn, privacyPending, setPrivacyPending,
    privacyScanning, setPrivacyScanning, askPrivacy, setAskPrivacy,
    tokenUsage, setChatUsage, handoffStarting, setHandoffStarting,
    showHistory, setShowHistory, versions, setVersions, versionsKept, setVersionsKept,
    headProvenance, setHeadProvenance,
    confirmRestore, setConfirmRestore, compare, setCompare,
    confirmDelete, setConfirmDelete,
    revealMsgId, setRevealMsgId,
    showSyncWarn, setShowSyncWarn, folders, setFolders,
    collapsedFolders, setCollapsedFolders, moveMenuFor, setMoveMenuFor,
    selectedFileIds, setSelectedFileIds, selectionAnchor, setSelectionAnchor,
    selectedTrashIds, setSelectedTrashIds, openPodcast, setOpenPodcast,
    visibleFileOrder, setVisibleFileOrder,
    ctxMenu, setCtxMenu, ctxMenuRef, ctxMenuElRef, moveMenuElRef,
    renamingFile, setRenamingFile, fileFilter, setFileFilter,
    fileSort, setFileSort,
    addMenuOpen, setAddMenuOpen, openMenu, setOpenMenu,
    mcpApprovals, setMcpApprovals,
    browseConsents, setBrowseConsents,
    editApprovals, setEditApprovals,
    dragOverFolder, setDragOverFolder, internalDragRef,
    renamingFolder, setRenamingFolder,
    creatingFolder, setCreatingFolder, editingMemory, setEditingMemory,
    showSearch, setShowSearch, searchQuery, setSearchQuery,
    searchResults, setSearchResults, searchError, setSearchError,
    searchSel, setSearchSel, showShortcuts, setShowShortcuts,
    chatRef, seededRef, toastSeq, errorLogRef, openFileRef, showSearchRef, showSettingsRef,
    exportWarnedRef, autolockRef, lastActivityRef,
    askingRef, prevAskingRef, activeChatIdRef, recheckTimer, prevModelRef,
    userPickedModelRef, showMemoryIntro, setShowMemoryIntro,
    showMap, setShowMap, showMapRef, showHelp, setShowHelp,
    area, setArea, aiTab, setAiTab, libraryTab, setLibraryTab,
    newCreationSeq, bumpNewCreation,
    selectedCreationJob, setSelectedCreationJob,
    showWorkflows, setShowWorkflows, showWorkflowsRef, wfDetailId, setWfDetailId,
    workflows, setWorkflows, wfNodeStatus, setWfNodeStatus,
    showScripts, setShowScripts, showScriptsRef, scripts, setScripts,
    skills, setSkills, selectedSkillId, setSelectedSkillId,
    scriptApprovals, setScriptApprovals,
    qaFileMenuOpen, setQaFileMenuOpen,
    qaScriptMenuOpen, setQaScriptMenuOpen,
    fp, setFp, fpSuggestions, setFpSuggestions,
    importProgress, setImportProgress,
    organized, setOrganized,
    jobs, setJobs, jobProgress, setJobProgress,
    summaryStarting, setSummaryStarting,
    studioStep, setStudioStep,
    ocrFiles, setOcrFiles,
    studioDefaults, setStudioDefaults, studioPrompt, setStudioPrompt,
    studioPromptRef, studioAc, setStudioAc, aiActionDefs, setAiActionDefs,
    aiPrompt, setAiPrompt, aiBusy, setAiBusy,
    aiOpId, setAiOpId, aiStopping, setAiStopping,
    memSuggestion, setMemSuggestion,
    importSuggestions, setImportSuggestions, pushToast, dismissToast, forgetToastsAbout,
    recLive, setRecLive, recLiveRef, recSave, setRecSave,
    sttStatus, setSttStatus, showFeedback, setShowFeedback,
    autoSpeak, setAutoSpeak, handsFree, setHandsFree, handsFreeRef,
    armTimerRef, speakingMsgId, setSpeakingMsgId,
  };
}

/** A navigation held up by unsaved edits.
 *
 * `what` completes the sentence "Save your changes before you …", so it reads
 * as the thing the user just tried to do rather than as a generic warning.
 * `proceed` is that action, replayed once the question is answered. */
export interface PendingLeave {
  what: string;
  proceed: () => void;
}

export type WSState = ReturnType<typeof useWorkspaceState>;
