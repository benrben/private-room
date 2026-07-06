import {
  ClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AiStatus,
  AnnotationPayload,
  api,
  Chat,
  ChatCommand,
  ENGINE_LABELS,
  FileContent,
  FileMeta,
  FileTarget,
  FileVersion,
  Folder,
  formatSize,
  McpServerStatus,
  McpApproveRequest,
  Memory,
  Message,
  modelLabel,
  RoomInfo,
  SearchResults,
} from "./api";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CloudIcon,
  DotsIcon,
  DownloadIcon,
  EmptyChatArt,
  EmptyViewerArt,
  EyeIcon,
  FileTypeIcon,
  FolderIcon,
  GlobeIcon,
  LinkIcon,
  MemoryIcon,
  MicIcon,
  LockIcon,
  Logomark,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SparkIcon,
  TrashIcon,
  UndoIcon,
} from "./icons";
import Settings from "./Settings";
import ChatAnnotatedImage from "./viewers/ChatAnnotatedImage";
import CodeEditor from "./viewers/CodeEditor";
import AudioView from "./viewers/AudioView";
import DocxView from "./viewers/DocxView";
import HtmlView from "./viewers/HtmlView";
import ImageView from "./viewers/ImageView";
import MarkdownView from "./viewers/MarkdownView";
import PdfView from "./viewers/PdfView";
import SheetView from "./viewers/SheetView";
import { applyQuoteHighlight, clearQuoteHighlight } from "./viewers/highlight";
import { languageForFile } from "./viewers/monacoSetup";

interface OpenFile {
  id: string;
  content: FileContent;
  target?: FileTarget;
}

/** One flattened search hit (ADD-6) — the arrow-key navigable unit. */
type FlatResult =
  | { kind: "file"; id: string; name: string; snippet: string }
  | { kind: "message"; chatId: string; messageId: string; snippet: string }
  | { kind: "memory"; id: string; snippet: string };

/** A transient message to the user. Successes/info self-dismiss; errors stay
 * until closed (UX-7). */
interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

/** Cloud CLI engines send questions off this Mac (SEC-6). */
function isCloudEngine(model: string): boolean {
  return model === "claude-cli" || model === "codex-cli";
}

interface BoxesPayload {
  fileId: string;
  name?: string;
  boxes: { label: string; x1: number; y1: number; x2: number; y2: number }[];
}

/** Split assistant content into visible text and optional viewer-markup payloads. */
function splitMarkupBlocks(content: string): {
  text: string;
  boxes?: BoxesPayload;
  annotation?: AnnotationPayload;
} {
  let text = content;
  let boxes: BoxesPayload | undefined;
  let annotation: AnnotationPayload | undefined;
  const boxMatch = text.match(/```boxes\n([\s\S]*?)\n?```/);
  if (boxMatch) {
    try {
      boxes = JSON.parse(boxMatch[1]) as BoxesPayload;
    } catch {
      /* malformed payload — show the text alone */
    }
    text = text.replace(boxMatch[0], "").trim();
  }
  const annotMatch = text.match(/```annotation\n([\s\S]*?)\n?```/);
  if (annotMatch) {
    try {
      annotation = JSON.parse(annotMatch[1]) as AnnotationPayload;
    } catch {
      /* malformed payload — show the text alone */
    }
    text = text.replace(annotMatch[0], "").trim();
  }
  return { text, boxes, annotation };
}

/** Viewer navigation for an annotation: quote or cell range. */
function annotationTarget(a: AnnotationPayload): FileTarget {
  return {
    quote: a.quote,
    find: a.quote,
    page: a.page,
    sheet: a.sheet,
    range: a.range,
  };
}

/** Read a File (pasted image) into base64 without the data: prefix (ADD-8). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result);
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** CHG-6: an in-progress stream may hold a half-open ``` fence — balance it
 * (display only) so MarkdownView never renders a broken code block. */
function patchStreamFences(s: string): string {
  const fences = (s.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${s}\n\`\`\`` : s;
}

// ---- "#command" / "@reference" parsing (makes the small model deterministic) ----

/** Live autocomplete popover state for the composer. */
interface AutocompleteState {
  kind: "cmd" | "ref";
  /** The partial token being typed (after # or @), lowercased for matching. */
  query: string;
  /** Byte offset of the '#'/'@' that opened this token. */
  start: number;
  /** Highlighted item index. */
  index: number;
}

/** The token immediately left of the caret, if it's a "#…" or "@…" being typed
 *  (i.e. no whitespace since the sigil). Returns null otherwise. */
function tokenAtCaret(
  value: string,
  caret: number,
): { kind: "cmd" | "ref"; start: number; query: string } | null {
  const before = value.slice(0, caret);
  // A '#' command only makes sense as the first token of the message.
  const cmd = /^#([a-z-]*)$/.exec(before);
  if (cmd) {
    return { kind: "cmd", start: 0, query: cmd[1].toLowerCase() };
  }
  // '@' references can appear anywhere; match back to the sigil (allows spaces
  // in the query so multi-word filenames can be typed/filtered).
  const at = /@([^@\n]*)$/.exec(before);
  if (at) {
    return { kind: "ref", start: caret - at[1].length - 1, query: at[1].toLowerCase() };
  }
  return null;
}

/** Resolve every "@name" / "@folder/" span in `text` against the room's files
 *  and folders (longest-name-first so spaces work), returning the collected
 *  file ids and the text with those spans removed. Unmatched "@…" is left as
 *  literal text. */
function resolveRefs(
  text: string,
  files: FileMeta[],
  folders: Folder[],
): { refIds: string[]; cleaned: string } {
  // Build match candidates, longest label first (so "Room summary.md" wins over
  // a file literally named "Room").
  const candidates: { label: string; ids: string[] }[] = [];
  for (const fo of folders) {
    const ids = files.filter((f) => f.folderId === fo.id).map((f) => f.id);
    candidates.push({ label: `${fo.name}/`, ids });
  }
  for (const f of files) candidates.push({ label: f.name, ids: [f.id] });
  candidates.sort((a, b) => b.label.length - a.label.length);

  const refIds: string[] = [];
  let cleaned = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@") {
      const rest = text.slice(i + 1);
      const hit = candidates.find((c) =>
        rest.toLowerCase().startsWith(c.label.toLowerCase()),
      );
      if (hit) {
        for (const id of hit.ids) if (!refIds.includes(id)) refIds.push(id);
        i += 1 + hit.label.length;
        continue;
      }
    }
    cleaned += text[i];
    i += 1;
  }
  return { refIds, cleaned: cleaned.replace(/\s+/g, " ").trim() };
}

/** Parse a composed message into a command (if any), its cleaned args, and the
 *  resolved @-file ids. `commandError` is set when "#word" names no command. */
function parseComposer(
  text: string,
  commands: ChatCommand[],
  files: FileMeta[],
  folders: Folder[],
): {
  command?: string;
  args: string;
  refIds: string[];
  commandError?: string;
} {
  const { refIds, cleaned } = resolveRefs(text, files, folders);
  const m = /^#([a-z-]+)\b\s*([\s\S]*)$/.exec(cleaned);
  if (!m) return { args: cleaned, refIds };
  const name = m[1];
  if (!commands.some((c) => c.name === name)) {
    return { args: cleaned, refIds, commandError: name };
  }
  return { command: name, args: m[2].trim(), refIds };
}

/** Friendly file name for the sidebar: drop the extension (the type icon
 * already conveys it) and turn underscores into spaces. The full original
 * name still rides along in a tooltip and on export. */
function displayName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const cleaned = base.replace(/_+/g, " ").trim();
  return cleaned || name;
}

/** Human-friendly timestamp for a saved version (ADD-2). Spelled-out month so
 * it's never ambiguous between D/M/Y and M/D/Y locales (e.g. "Jul 5, 2026,
 * 12:47 AM"). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Read-only extracted-text preview that can highlight a quoted snippet. */
function TextView({ text, quote }: { text: string; quote?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!quote || !ref.current) return;
    applyQuoteHighlight(ref.current, quote);
    return clearQuoteHighlight;
  }, [text, quote]);
  return <pre ref={ref}>{text}</pre>;
}

interface Props {
  info: RoomInfo;
  onLock: () => void;
}

/**
 * First-run model chooser. A curated set of local chat models the app can fully
 * drive (chat + tools + image marking), so a fresh install isn't hard-wired to
 * one download. Sizes are the Ollama download size; anything else can still be
 * pulled by name in Settings → Model manager. Keep the first entry the default
 * (matches the backend's DEFAULT_MODEL / best_default).
 */
const RECOMMENDED_MODELS: {
  name: string;
  label: string;
  size: string;
  blurb: string;
  tag?: string;
}[] = [
  {
    name: "qwen3.5:4b",
    label: "Balanced",
    size: "3.4 GB",
    blurb: "Chat, tools, and image marking. A great default on 16 GB Macs.",
    tag: "Recommended",
  },
  {
    name: "qwen3.5:9b",
    label: "Higher quality",
    size: "6.6 GB",
    blurb: "Sharper answers and reasoning; best with 32 GB+ of RAM.",
  },
  {
    name: "gemma3:4b",
    label: "Compact",
    size: "3.3 GB",
    blurb: "Google's small model — a lighter, capable all-rounder.",
  },
];

export default function Workspace({ info, onLock }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [model, setModel] = useState("");
  const [attachments, setAttachments] = useState<FileMeta[]>([]);
  const [question, setQuestion] = useState("");
  // Prebuilt "#name" workflows + inline "#"/"@" autocomplete state.
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [asking, setAsking] = useState(false);
  const [streamText, setStreamText] = useState("");
  // CHG-5: per-turn tool-step chips shown above the live text (not saved).
  // ADD-22: each chip carries an ok flag so a failed tool reads as failed.
  const [steps, setSteps] = useState<{ label: string; ok: boolean }[]>([]);
  // ADD-22: the deterministic router's chosen lane, shown as a subtle label.
  const [lane, setLane] = useState("");
  // ADD-22: files edited during a turn, keyed by the resulting assistant message
  // id, so we can offer a one-tap Undo on that message (session-only).
  const [undoByMsg, setUndoByMsg] = useState<Record<string, string[]>>({});
  const editedRef = useRef<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  // ADD-18: dictation — idle → recording (mic live) → busy (transcribing).
  // `dictOwner` is which button holds the mic: composer/note/memory/file/journal.
  const [dictState, setDictState] = useState<"idle" | "recording" | "busy">(
    "idle",
  );
  const [dictOwner, setDictOwner] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const dictChunksRef = useRef<Blob[]>([]);
  // ADD-8: full-window highlight while files are dragged over the app.
  const [dragOver, setDragOver] = useState(false);
  // ADD-9: inline chat rename.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // CHG-1/ADD-10: download the missing model from the onboarding banner.
  const [pullingModel, setPullingModel] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullError, setPullError] = useState("");
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  // BUG 2: bumping this remounts the viewer/editor with fresh content. Bumped
  // ONLY on genuinely external changes (file-updated event + Restore), never on
  // the user's own typing — so an AI edit / restore shows without reopening.
  const [viewerRev, setViewerRev] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ id: string; name: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  // SEC-1: MCP approval prompt, driven by info.pendingMcp; dismissed once chosen.
  const [mcpDialogDismissed, setMcpDialogDismissed] = useState(false);
  const [approvingMcp, setApprovingMcp] = useState(false);
  // ADD-17: room summary generation.
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeProgress, setSummarizeProgress] = useState("");
  // ADD-12: add-link dialog.
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [importingLink, setImportingLink] = useState(false);
  const [webOn, setWebOn] = useState(false);
  // ADD-2 version history panel.
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  // ADD-3 two-step delete: which item is awaiting confirmation, keyed "kind:id".
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // HLT-6 cloud-sync banner.
  const [showSyncWarn, setShowSyncWarn] = useState(false);
  // ADD-16 folders: the room's one-level folders, which groups are collapsed,
  // which file row's "Move to…" menu is open, and the inline folder rename.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [moveMenuFor, setMoveMenuFor] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  // Right-click file menu + inline rename (mirrors the folder rename pattern).
  const [ctxMenu, setCtxMenu] = useState<{ file: FileMeta; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef(false);
  const ctxMenuElRef = useRef<HTMLDivElement>(null);
  const moveMenuElRef = useRef<HTMLDivElement>(null);
  const [renamingFile, setRenamingFile] = useState<{ id: string; name: string } | null>(null);
  // Redesign: sidebar file filter + the header/sidebar popover menus.
  const [fileFilter, setFileFilter] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // SEC-1b: queued MCP tool-call approval prompts (one shown at a time).
  const [mcpApprovals, setMcpApprovals] = useState<McpApproveRequest[]>([]);
  // ADD-16: which folder header (or "root") a dragged file is hovering over.
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  // True while a file row is being dragged within the sidebar. Used to keep the
  // full-canvas "Drop to add to this room" overlay (meant for Finder drops) from
  // hijacking the window during an in-app move.
  const internalDragRef = useRef(false);
  // Resizable panes. Widths persist per room in localStorage so a room reopens
  // the way the user left it. Clamped so no pane can be dragged away entirely.
  const paneKey = `paneWidths:${info.name}`;
  const [sidebarW, setSidebarW] = useState(300);
  const [chatW, setChatW] = useState(400);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  // BUG 1: inline "+ Folder" create input (window.prompt is a no-op in
  // WKWebView). null = not creating; a string is the in-progress name.
  const [creatingFolder, setCreatingFolder] = useState<string | null>(null);
  // UX-5 memory inline edit.
  const [editingMemory, setEditingMemory] = useState<{ id: string; content: string } | null>(null);
  // ADD-6 search overlay.
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [searchSel, setSearchSel] = useState(0);
  const chatRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const toastSeq = useRef(0);
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;
  // UX-6: live values for the single window keydown listener (added once).
  const showSearchRef = useRef(false);
  showSearchRef.current = showSearch;
  const showSettingsRef = useRef(false);
  showSettingsRef.current = showSettings;
  // ADD-1: show the "not encrypted" notice only once per session.
  const exportWarnedRef = useRef(false);
  // ADD-3: revert the confirm affordance after a few seconds.
  const confirmTimer = useRef<number | undefined>(undefined);
  // SEC-3 auto-lock bookkeeping (refs so the interval reads live values).
  const autolockRef = useRef<string>("15");
  const lastActivityRef = useRef<number>(Date.now());
  const askingRef = useRef(false);
  const prevAskingRef = useRef(false);
  askingRef.current = asking;
  // ADD-7/HLT-7: the current in-flight ask's id, so Stop/Lock can cancel it.
  const askIdRef = useRef<string | null>(null);
  // ADD-10: interval that re-checks AI status after "Open Ollama".
  const recheckTimer = useRef<number | undefined>(undefined);
  // Trust: announce every engine change. `prevModelRef` tracks the last value
  // we've already announced; `userPickedModelRef` marks a change the user made
  // in the dropdown (no toast needed) vs. an automatic/fallback switch (toast).
  const prevModelRef = useRef<string>("");
  const userPickedModelRef = useRef(false);
  const memoryHeadRef = useRef<HTMLDivElement>(null);
  // One-time spotlight explaining what Memory is, dismissed per room.
  const [showMemoryIntro, setShowMemoryIntro] = useState(false);

  function pushToast(kind: Toast["kind"], text: string) {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    // Everything auto-dismisses so nothing lingers across later actions; errors
    // simply linger longer, and the × is always available to close early.
    const ttl = kind === "error" ? 9000 : 5000;
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      ttl,
    );
  }

  function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  function refreshWebAccess() {
    api
      .getSetting("web_provider")
      .then((v) => setWebOn(v === "duckduckgo" || v === "searxng" || v === "brave"))
      .catch(() => {});
  }

  // SEC-3: (re)load the per-room auto-lock choice into the ref the timer reads.
  function refreshAutolock() {
    api
      .getSetting("autolock_minutes")
      .then((v) => {
        autolockRef.current = v ?? "15";
      })
      .catch(() => {});
  }

  // ---- ADD-1: export copies out of the room ----
  /** The room's contents leave encrypted; exported copies are plain files. */
  function noteExportOnce() {
    if (exportWarnedRef.current) return;
    exportWarnedRef.current = true;
    pushToast("info", "Exported copies are normal, NOT encrypted files.");
  }

  async function exportOne(id: string, name: string) {
    const dest = await api.chooseSavePath({ defaultPath: name });
    if (!dest) return;
    try {
      await api.exportFile(id, dest);
      noteExportOnce();
      pushToast("success", `Exported "${name}".`);
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function exportAllFiles() {
    const dir = await api.chooseOpenPath({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    try {
      const count = await api.exportAll(dir);
      noteExportOnce();
      pushToast(
        "success",
        `Exported ${count} file${count === 1 ? "" : "s"} out of the room.`,
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  // ---- ADD-2: file version history ----
  async function openHistory() {
    if (!openFile) return;
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    try {
      const vs = await api.listFileVersions(openFile.id);
      // Newest first, defensively (backend order not relied upon).
      setVersions([...vs].sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
      setShowHistory(true);
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function restoreVersion(versionId: string) {
    const current = openFile;
    if (!current) return;
    try {
      await api.restoreFileVersion(versionId);
      const content = await api.getFileContent(current.id);
      setOpenFile({ ...current, content });
      // External change → remount the viewer/editor so restored bytes show now.
      setViewerRev((r) => r + 1);
      setFiles(await api.listFiles());
      setVersions(
        [...(await api.listFileVersions(current.id))].sort((a, b) =>
          b.savedAt.localeCompare(a.savedAt),
        ),
      );
      pushToast("success", "Restored an earlier version.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** ADD-22: undo the file change(s) an AI turn made, by restoring each file's
   *  most recent version (the pre-edit snapshot store_file_bytes took). Restore
   *  is itself undoable, so this is reversible via the file's version history. */
  async function undoEdits(msgId: string) {
    const fileIds = undoByMsg[msgId];
    if (!fileIds || fileIds.length === 0) return;
    try {
      for (const fid of fileIds) {
        const versions = await api.listFileVersions(fid);
        if (versions[0]) await api.restoreFileVersion(versions[0].id);
      }
      setUndoByMsg((u) => {
        const next = { ...u };
        delete next[msgId];
        return next;
      });
      setFiles(await api.listFiles());
      // If the reverted file is open, remount so it shows the restored bytes.
      const current = openFileRef.current;
      if (current && fileIds.includes(current.id)) {
        const content = await api.getFileContent(current.id);
        setOpenFile({ ...current, content });
        setViewerRev((r) => r + 1);
      }
      pushToast(
        "success",
        fileIds.length > 1 ? `Undid changes to ${fileIds.length} files.` : "Change undone.",
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  // ---- ADD-3: two-step delete ----
  function askConfirm(key: string) {
    window.clearTimeout(confirmTimer.current);
    setConfirmDelete(key);
    confirmTimer.current = window.setTimeout(
      () => setConfirmDelete((k) => (k === key ? null : k)),
      3000,
    );
  }

  function cancelConfirm() {
    window.clearTimeout(confirmTimer.current);
    setConfirmDelete(null);
  }

  /** A trash/× button that first asks "Delete? ✓ ✕" before firing. */
  function deleteControl(
    key: string,
    trigger: ReactNode,
    onConfirm: () => void,
    title: string,
  ): ReactNode {
    if (confirmDelete === key) {
      return (
        <span className="confirm-del">
          <span className="confirm-q">Delete?</span>
          <button
            className="chip-btn confirm-yes"
            title="Confirm delete"
            onClick={() => {
              cancelConfirm();
              onConfirm();
            }}
          >
            ✓
          </button>
          <button className="chip-btn confirm-no" title="Keep" onClick={cancelConfirm}>
            ✕
          </button>
        </span>
      );
    }
    return (
      <button
        className="chip-btn danger"
        title={title}
        onClick={() => askConfirm(key)}
      >
        {trigger}
      </button>
    );
  }

  // ---- HLT-6: dismiss the cloud-sync warning for this room ----
  async function dismissSyncWarn() {
    setShowSyncWarn(false);
    try {
      await api.setSetting("hlt6_sync_dismissed", "1");
    } catch {
      /* best-effort; banner is already hidden for this session */
    }
  }

  function connectedTools(statuses: McpServerStatus[]): string[] {
    return statuses
      .filter((s) => s.status === "connected")
      .flatMap((s) => s.tools.map((t) => `${s.name}: ${t}`));
  }

  // ---- SEC-1: approve (or decline) the room's pending MCP servers ----
  async function approveMcp() {
    const pending = info.pendingMcp;
    if (!pending || approvingMcp) return;
    setApprovingMcp(true);
    try {
      const statuses = await api.approveMcp(pending.fingerprint);
      setMcpTools(connectedTools(statuses));
      setMcpDialogDismissed(true);
      pushToast("success", "This room's tools are now allowed on this Mac.");
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setApprovingMcp(false);
    }
  }

  // Decline: servers stay stopped (they show as blocked in Settings).
  function keepMcpOff() {
    setMcpDialogDismissed(true);
  }

  // ---- ADD-17: build/refresh "Room summary.md" and open it ----
  async function summarizeRoom() {
    if (summarizing) return;
    setSummarizing(true);
    setSummarizeProgress("");
    try {
      const result = await api.summarizeRoom();
      setFiles(await api.listFiles());
      viewFile(result.id);
      pushToast("success", "Room summary is ready.");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("OLLAMA_DOWN")) {
        pushToast(
          "error",
          "Ollama is not running. Start the Ollama app, then try again.",
        );
      } else {
        pushToast("error", msg);
      }
    } finally {
      // Never leave the button stuck disabled on error.
      setSummarizing(false);
      setSummarizeProgress("");
    }
  }

  // ---- ADD-12: fetch one web page and save it as a readable room file ----
  async function submitLink() {
    const url = linkUrl.trim();
    if (!url || importingLink) return;
    setImportingLink(true);
    try {
      const meta = await api.importLink(url);
      setFiles(await api.listFiles());
      setShowAddLink(false);
      setLinkUrl("");
      pushToast("success", `Saved "${meta.name}" into the room.`);
      viewFile(meta.id);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setImportingLink(false);
    }
  }

  async function refreshAi() {
    const status = await api.aiStatus();
    setAi(status);
    setModel((current) => current || status.defaultModel);
  }

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    // Show which room is open in the title bar / Mission Control (CHG-9).
    // Reset to plain "Private Room" happens on lock, in App.handleLock.
    getCurrentWindow()
      .setTitle(`${info.name} — Private Room`)
      .catch(() => {});
    api.listFiles().then(setFiles);
    api.listFolders().then(setFolders).catch(() => {});
    api.listMemories().then(setMemories);
    api.listChatCommands().then(setCommands).catch(() => {});
    refreshAi();
    // Pre-load the model so the first question doesn't pay the cold start.
    api.warmModel().catch(() => {});
    api.listChats().then(async (cs) => {
      if (cs.length === 0) {
        const c = await api.createChat();
        setChats([c]);
        setActiveChatId(c.id);
      } else {
        setChats(cs);
        setActiveChatId(cs[0].id);
      }
    });
    // CHG-5: split the old single ask-delta stream into structured events.
    // ask-delta = current round's text; ask-round = a new round starts (clear
    // the live text); ask-step = a tool ran (append a chip). UX-4 ask-notice.
    const unlisten = api.onAskDelta((delta) => {
      setStreamText((t) => t + delta);
    });
    const unlistenStep = api.onAskStep((label) => {
      setSteps((s) => [...s, { label, ok: true }]);
    });
    // ADD-22: the router's lane label, and per-step success/failure.
    const unlistenLane = api.onAskLane((label) => {
      setLane(label);
    });
    const unlistenStepStatus = api.onAskStepStatus(({ ok }) => {
      if (ok) return;
      setSteps((s) =>
        s.length ? [...s.slice(0, -1), { ...s[s.length - 1], ok: false }] : s,
      );
    });
    const unlistenRound = api.onAskRound(() => {
      setStreamText("");
    });
    const unlistenNotice = api.onAskNotice((text) => {
      pushToast("info", text);
    });
    // ADD-17: live "Summarizing file N of M…" progress.
    const unlistenSummarize = api.onSummarizeProgress((text) => {
      setSummarizeProgress(text);
    });
    // CHG-1/ADD-10: live progress for the in-banner model download.
    const unlistenPull = listen<{ status: string; percent: number | null }>(
      "pull-progress",
      (e) => {
        setPullStatus(e.payload.status);
        setPullPercent(e.payload.percent);
      },
    );
    // ADD-8: drop files anywhere on the window to import them.
    const unlistenDrop = getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      // An in-app file-row drag isn't a Finder import — leave the canvas alone.
      if (internalDragRef.current) return;
      if (p.type === "enter" || p.type === "over") {
        setDragOver(true);
      } else if (p.type === "leave") {
        setDragOver(false);
      } else if (p.type === "drop") {
        setDragOver(false);
        if (p.paths && p.paths.length > 0) {
          try {
            const report = await api.importFiles(p.paths);
            setFiles(await api.listFiles());
            reportImport(report);
          } catch (e) {
            pushToast("error", String(e));
          }
        }
      }
    });
    const unlistenMcpApprove = api.onMcpApproveRequest((req) => {
      setMcpApprovals((q) => [...q, req]);
    });
    refreshWebAccess();
    refreshAutolock();
    // HLT-6: warn once per room when it lives in a cloud-sync folder.
    if (info.synced) {
      api
        .getSetting("hlt6_sync_dismissed")
        .then((v) => {
          if (v !== "1") setShowSyncWarn(true);
        })
        .catch(() => {});
    }
    // The AI can drive the app: open files in the viewer, create/edit files,
    // and highlight spots in documents.
    const unlistenOpen = api.onAgentOpenFile((p) => {
      const id = typeof p === "string" ? p : p.id;
      const hint =
        typeof p === "string" ? undefined : (p.page ?? p.cell ?? p.find ?? undefined);
      // Models often call open_file alongside annotate_file; a plain open
      // must not wipe a highlight already applied to the same file.
      const current = openFileRef.current;
      if (hint == null && current?.id === id && current.target) return;
      if (typeof p === "string" || hint == null) {
        viewFile(id);
      } else {
        viewFile(p.id, {
          page: p.page ?? undefined,
          cell: p.cell ?? undefined,
          range: p.cell ?? undefined,
          find: p.find ?? undefined,
          quote: p.find ?? undefined,
        });
      }
    });
    const unlistenAnnotate = api.onAgentAnnotate((payload) => {
      viewFile(payload.fileId, annotationTarget(payload));
    });
    const unlistenUpdated = api.onFileUpdated(async (fileId) => {
      // ADD-22: remember which files this turn changed, to offer Undo afterward.
      editedRef.current.add(fileId);
      const current = openFileRef.current;
      if (current && current.id === fileId) {
        // Refresh in place — keep the edit/preview mode and target.
        const content = await api.getFileContent(current.id);
        setOpenFile({ ...current, content });
        // External write (e.g. an AI edit) → remount so the open viewer/editor
        // shows the new bytes instead of its mount-time snapshot.
        setViewerRev((r) => r + 1);
      }
    });
    const unlistenFiles = api.onRoomFilesChanged(() => {
      api.listFiles().then(setFiles);
      api.listFolders().then(setFolders).catch(() => {});
    });
    api.mcpStatus().then((s) => setMcpTools(connectedTools(s))).catch(() => {});
    const unlistenMcp = api.onMcpStatus((statuses) => {
      setMcpTools(connectedTools(statuses));
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenStep.then((fn) => fn());
      unlistenLane.then((fn) => fn());
      unlistenStepStatus.then((fn) => fn());
      unlistenRound.then((fn) => fn());
      unlistenNotice.then((fn) => fn());
      unlistenSummarize.then((fn) => fn());
      unlistenPull.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
      unlistenOpen.then((fn) => fn());
      unlistenAnnotate.then((fn) => fn());
      unlistenUpdated.then((fn) => fn());
      unlistenFiles.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
      unlistenMcpApprove.then((fn) => fn());
      window.clearInterval(recheckTimer.current);
    };
  }, []);

  useEffect(() => {
    if (activeChatId) {
      api.getMessages(activeChatId).then(setMessages);
    } else {
      setMessages([]);
    }
  }, [activeChatId]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, asking, streamText]);

  // SEC-3: treat "an answer just finished" as fresh activity, so an idle user
  // who kicked off a long answer gets the full timeout after it lands (and we
  // never lock mid-stream — the timer skips while asking is true).
  useEffect(() => {
    if (prevAskingRef.current && !asking) {
      lastActivityRef.current = Date.now();
    }
    prevAskingRef.current = asking;
  }, [asking]);

  // SEC-3: auto-lock on idle or after sleep. One timer + activity listeners.
  useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);
    let lastTick = Date.now();
    const interval = window.setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      const setting = autolockRef.current;
      if (setting === "off") return;
      const limitMs = Number(setting) * 60_000;
      if (!Number.isFinite(limitMs) || limitMs <= 0) return;
      // Never lock while an answer is streaming — wait for it to finish.
      if (askingRef.current) return;
      const idle = now - lastActivityRef.current;
      // A gap far larger than the 30s interval means the Mac slept; if that
      // sleep exceeded the limit, lock on this first tick after waking even if
      // a stray mousemove already refreshed the activity clock.
      const slept = gap > 45_000;
      if (idle >= limitMs || (slept && gap >= limitMs)) {
        onLock();
      }
    }, 30_000);
    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      window.clearInterval(interval);
    };
  }, [onLock]);

  // ADD-3: cancel any pending confirm timer on unmount.
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  // UX-6: one window keydown listener for Mac shortcuts. Only ⌘-combos are
  // intercepted (never plain typing); Esc has a priority order. Added once —
  // it reads live state through refs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (ctxMenuRef.current) {
          e.preventDefault();
          setCtxMenu(null);
          return;
        }
        if (showSearchRef.current) {
          e.preventDefault();
          setShowSearch(false);
          return;
        }
        // Let Settings handle its own Esc (it renders its own close).
        if (showSettingsRef.current) return;
        // Don't steal Esc from an inline input (memory/rename/composer) that
        // uses it to cancel — only close the viewer when not typing.
        const t = e.target as HTMLElement | null;
        const typing =
          t != null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
        if (!typing && openFileRef.current) {
          e.preventDefault();
          setOpenFile(null);
        }
        return;
      }
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        newChat();
      } else if (k === "l") {
        e.preventDefault();
        handleLock();
      } else if (k === "f" || k === "k") {
        e.preventDefault();
        setSearchSel(0);
        setShowSearch(true);
      } else if (k === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ADD-6: debounced room-wide search while the overlay is open.
  useEffect(() => {
    if (!showSearch) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .searchAll(q)
        .then((r) => {
          setSearchResults(r);
          setSearchSel(0);
        })
        .catch(() => {});
    }, 200);
    return () => window.clearTimeout(t);
  }, [searchQuery, showSearch]);

  // ADD-2: a fresh file starts with the history panel closed.
  useEffect(() => {
    setShowHistory(false);
  }, [openFile?.id]);

  const modelReady =
    (ai?.running &&
      (ai.models.includes(model) ||
        ai.models.some((m) => m.startsWith(model + ":") || model.startsWith(m)))) ||
    ai?.external.includes(model);

  /** Turn an import report into toasts (shared by the picker and drag-drop). */
  function reportImport(report: { imported: FileMeta[]; errors: string[] }) {
    if (report.imported.length > 0) {
      pushToast(
        "success",
        `Added ${report.imported.length} file${report.imported.length === 1 ? "" : "s"} to the room.`,
      );
    }
    // One toast per failed file, grouped once there are more than three.
    if (report.errors.length > 3) {
      pushToast(
        "error",
        `${report.errors.length} files could not be added:\n${report.errors.join("\n")}`,
      );
    } else {
      report.errors.forEach((err) => pushToast("error", err));
    }
  }

  async function importFiles() {
    const picked = await api.chooseOpenPath({ title: "Add files to this room", multiple: true });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const report = await api.importFiles(paths);
    setFiles(await api.listFiles());
    reportImport(report);
  }

  async function removeFile(id: string) {
    await api.deleteFile(id);
    setFiles(await api.listFiles());
    setAttachments((a) => a.filter((f) => f.id !== id));
  }

  async function viewFile(id: string, target?: FileTarget) {
    setOpenFile({ id, content: await api.getFileContent(id), target });
    setEditMode(false);
  }

  async function saveEdit(newText: string) {
    if (!openFile) return;
    await api.updateFileContent(openFile.id, newText);
    setFiles(await api.listFiles());
    setOpenFile({
      ...openFile,
      content: { ...openFile.content, text: newText },
    });
    pushToast("success", `Saved "${openFile.content.name}".`);
  }

  /** Editing a binary format (pdf/docx/pptx) can't round-trip — the edited
   * text is saved as a new Markdown file, the original stays unchanged. */
  async function saveEditAsCopy(newText: string) {
    if (!openFile) return;
    const base = openFile.content.name.replace(/\.[^.]+$/, "");
    const meta = await api.saveGeneratedFile(`${base} (edited).md`, newText);
    setFiles(await api.listFiles());
    pushToast("success", `Saved "${meta.name}" into the room — the original file is unchanged.`);
  }

  async function editCell(sheet: string, cell: string, value: string) {
    if (!openFile) return;
    try {
      await api.setCell(openFile.id, sheet || null, cell, value);
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  /** What edit mode means for the open file, if anything. */
  function editModeOf(c: FileContent): "grid" | "editor" | "copy" | null {
    if (c.kind === "sheet" || c.kind === "csv") {
      // Legacy .xls can be viewed but not written back.
      return /\.xls$/i.test(c.name) ? null : "grid";
    }
    if (c.editable) return "editor";
    if (c.text && ["pdf", "docx", "text"].includes(c.kind)) return "copy";
    return null;
  }

  function toggleAttach(file: FileMeta) {
    setAttachments((a) =>
      a.some((f) => f.id === file.id)
        ? a.filter((f) => f.id !== file.id)
        : [...a, file],
    );
  }

  async function newChat() {
    const c = await api.createChat();
    setChats(await api.listChats());
    setActiveChatId(c.id);
  }

  async function removeChat(id: string) {
    await api.deleteChat(id);
    const remaining = await api.listChats();
    if (remaining.length === 0) {
      const c = await api.createChat();
      setChats([c]);
      setActiveChatId(c.id);
    } else {
      setChats(remaining);
      if (activeChatId === id) setActiveChatId(remaining[0].id);
    }
  }

  /** Core turn flow shared by ask, regenerate, and "#command" runs. Owns the
   * ask id (ADD-7), resets the live stream/steps (CHG-5), swallows cancel-driven
   * rejections so Stop/Lock never surface an error toast (HLT-7), and reloads
   * the saved transcript + files/memories afterward. `run` performs the actual
   * backend call with the freshly-minted ask id. */
  async function runTurn(run: (askId: string) => Promise<unknown>) {
    if (!activeChatId) return;
    const chatId = activeChatId;
    const askId = crypto.randomUUID();
    askIdRef.current = askId;
    setAsking(true);
    setStreamText("");
    setSteps([]);
    setLane("");
    editedRef.current = new Set();
    try {
      await run(askId);
    } catch (e) {
      const msg = String(e);
      // A cancel (Stop or Lock) rejects the in-flight promise — not an error.
      if (!/cancel/i.test(msg)) {
        if (msg.includes("OLLAMA_DOWN")) {
          pushToast("error", "Ollama is not running. Start the Ollama app, then try again.");
        } else if (msg.includes("MODEL_MISSING")) {
          pushToast("error", `Model "${model}" is not downloaded — use the Download button above.`);
        } else {
          pushToast("error", msg);
        }
        refreshAi();
      }
    } finally {
      askIdRef.current = null;
      // The saved message (incl. any "(stopped)" partial) is the source of truth.
      const msgs = await api.getMessages(chatId);
      setMessages(msgs);
      // ADD-22: if this turn edited any files, offer a one-tap Undo on the
      // resulting assistant message.
      const edited = [...editedRef.current];
      if (edited.length) {
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        if (lastAssistant) {
          setUndoByMsg((u) => ({ ...u, [lastAssistant.id]: edited }));
        }
      }
      setChats(await api.listChats());
      // Agent tools / commands may have created files or memories.
      api.listFiles().then(setFiles);
      api.listMemories().then(setMemories);
      setAsking(false);
      setStreamText("");
      setSteps([]);
      setLane("");
    }
  }

  async function askOnce(q: string, attachmentIds: string[]) {
    const chatId = activeChatId;
    if (!chatId) return;
    await runTurn((askId) => api.ask(chatId, q, attachmentIds, askId));
  }

  async function send() {
    const raw = question.trim();
    if (!raw || asking || !activeChatId) return;
    // Deterministic routing done by the human: parse "#command" and "@refs"
    // BEFORE anything reaches the model.
    const parsed = parseComposer(raw, commands, files, folders);
    if (parsed.commandError) {
      const names = commands.map((c) => `#${c.name}`).join(", ");
      pushToast(
        "error",
        `#${parsed.commandError} isn't a command. Try: ${names || "(none available)"}`,
      );
      return;
    }
    setQuestion("");
    setAc(null);
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: raw,
      sources: [],
      createdAt: "",
    };
    setMessages((m) => [...m, optimistic]);
    const chatId = activeChatId;
    if (parsed.command) {
      // A prebuilt workflow: the model (if used at all) gets a tiny task prompt.
      setAttachments([]);
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, raw, askId),
      );
    } else {
      // Plain chat: @-pinned files join the manual attachments as guaranteed
      // context.
      const attachmentIds = [
        ...new Set([...attachments.map((f) => f.id), ...parsed.refIds]),
      ];
      setAttachments([]);
      await askOnce(raw, attachmentIds);
    }
  }

  // ---- "#"/"@" autocomplete ----

  /** The popover items for the current token (commands, or files/folders). */
  function autocompleteItems(): { key: string; label: string; hint: string; insert: string }[] {
    if (!ac) return [];
    if (ac.kind === "cmd") {
      return commands
        .filter((c) => c.name.startsWith(ac.query))
        .map((c) => ({
          key: c.name,
          label: `#${c.name}`,
          hint: c.summary,
          insert: `#${c.name} `,
        }));
    }
    const q = ac.query;
    const folderItems = folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => ({
        key: `fo-${f.id}`,
        label: `@${f.name}/`,
        hint: "folder",
        insert: `@${f.name}/ `,
      }));
    const fileItems = files
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({
        key: `fi-${f.id}`,
        label: `@${f.name}`,
        hint: f.mimeType,
        insert: `@${f.name} `,
      }));
    return [...folderItems, ...fileItems].slice(0, 10);
  }

  /** Recompute the autocomplete state from the textarea value + caret. */
  function refreshAutocomplete(value: string, caret: number) {
    const tok = tokenAtCaret(value, caret);
    setAc(tok ? { kind: tok.kind, query: tok.query, start: tok.start, index: 0 } : null);
  }

  /** Composer "Attach"/"# Action" chips: drop the trigger token at the caret
   * and open its popover, so the affordance is discoverable without knowing
   * the @ / # shortcuts. */
  function insertComposerToken(token: "@" | "#") {
    const cur = question;
    let next: string;
    let caret: number;
    if (token === "#") {
      // A "#command" only parses as the FIRST token, so prepend it (never
      // append mid-text, which the parser ignores) and drop the caret after
      // the sigil so the command picker opens with an empty query.
      const body = cur.replace(/^\s+/, "");
      next = `#${body}`;
      caret = 1;
    } else {
      // "@file" can sit anywhere — append at the caret/end.
      const needsSpace = cur.length > 0 && !/\s$/.test(cur);
      next = `${cur}${needsSpace ? " " : ""}@`;
      caret = next.length;
    }
    setQuestion(next);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
        refreshAutocomplete(next, caret);
      }
    });
  }

  /** Replace the in-progress token with the chosen item's text. */
  function acceptAutocomplete(insert: string) {
    const el = composerRef.current;
    const caret = el ? el.selectionStart : question.length;
    const start = ac ? ac.start : caret;
    const next = question.slice(0, start) + insert + question.slice(caret);
    setQuestion(next);
    setAc(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }

  /** Textarea keydown: drive the popover when open, else Enter sends. */
  function onComposerKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const items = autocompleteItems();
    if (ac && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAc({ ...ac, index: (ac.index + 1) % items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAc({ ...ac, index: (ac.index - 1 + items.length) % items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptAutocomplete(items[Math.min(ac.index, items.length - 1)].insert);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAc(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // ADD-7: cancel the running answer; the backend saves the partial "(stopped)".
  function stopAsk() {
    const id = askIdRef.current;
    if (id) api.cancelAsk(id).catch(() => {});
  }

  // HLT-7: lock cleanly during an answer — cancel, let the partial save land,
  // then close. Any cancel rejection is already swallowed inside askOnce().
  async function handleLock() {
    if (askingRef.current && askIdRef.current) {
      try {
        await api.cancelAsk(askIdRef.current);
      } catch {
        /* ignore — we're locking anyway */
      }
      await new Promise((r) => window.setTimeout(r, 250));
    }
    onLock();
  }

  // ADD-9c: delete the last answer and re-ask the previous question. Original
  // attachments aren't stored per message, so the retry goes without them.
  async function regenerate(assistantId: string) {
    if (asking || !activeChatId) return;
    const idx = messages.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    let userText = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userText = messages[i].content;
        break;
      }
    }
    if (!userText) return;
    try {
      await api.deleteMessage(assistantId);
    } catch (e) {
      pushToast("error", String(e));
      return;
    }
    setMessages(await api.getMessages(activeChatId));
    await askOnce(userText, []);
  }

  // ADD-9b: copy an assistant answer with viewer-markup blocks stripped out.
  function copyMessage(m: Message) {
    const clean = splitMarkupBlocks(m.content).text;
    navigator.clipboard.writeText(clean).then(
      () => pushToast("success", "Copied to clipboard."),
      (e) => pushToast("error", String(e)),
    );
  }

  // BUG 3 (UX-2): copy the open document's whole extracted text (PDFs now
  // return their text; also fine for docx/text). Hidden when there's no text.
  function copyAllText() {
    const text = openFile?.content.text;
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => pushToast("success", "Copied all text to clipboard."),
      (e) => pushToast("error", String(e)),
    );
  }

  // CHG-7: a source chip names a file — resolve name → id (exact, newest first)
  // and open it; if it's gone, say so gently.
  function openSource(name: string) {
    const match = files
      .filter((f) => f.name === name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (match) viewFile(match.id);
    else pushToast("info", "That file is no longer in the room.");
  }

  // ADD-9a: inline chat rename.
  function startRename() {
    const c = chats.find((c) => c.id === activeChatId);
    setRenameDraft(c?.title ?? "");
    setRenaming(true);
  }

  async function commitRename() {
    const title = renameDraft.trim();
    setRenaming(false);
    if (!title || !activeChatId) return;
    await api.renameChat(activeChatId, title);
    setChats(await api.listChats());
  }

  // ADD-8b: paste an image into the composer → import it and attach it.
  async function onComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const file = it.getAsFile();
        if (!file) continue;
        try {
          const b64 = await fileToBase64(file);
          const time = new Date()
            .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            .replace(/:/g, ".");
          const meta = await api.importImageBytes(`Pasted image ${time}.png`, b64);
          setFiles(await api.listFiles());
          setAttachments((a) => (a.some((f) => f.id === meta.id) ? a : [...a, meta]));
        } catch (err) {
          pushToast("error", String(err));
        }
        return;
      }
    }
  }

  // ---- ADD-18: one shared microphone, several sinks (composer / voice note /
  // memory / talk-to-file / journal). `owner` names the button that holds the
  // live mic so only it renders the recording state.
  async function beginRecording(
    owner: string,
    onDone: (blob: Blob, ext: string) => Promise<void>,
  ) {
    if (dictState === "busy") return;
    if (dictState === "recording") {
      if (dictOwner === owner) recorderRef.current?.stop(); // finish
      return; // another button owns the live mic
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // Distinguish the real failure modes rather than always blaming Privacy
      // settings: a denied prompt vs. no hardware vs. the device being busy.
      const name = (e as { name?: string })?.name || "";
      const msg =
        name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone found — plug one in or check your input device."
          : name === "NotReadableError" || name === "AbortError"
            ? "The microphone is busy in another app — close it and try again."
            : "Microphone blocked — allow Private Room in System Settings → Privacy & Security → Microphone, then reopen the app.";
      pushToast("error", msg);
      return;
    }
    // WKWebView records AAC in an MP4 container; the backend decodes it with
    // the OS's own converter, so no other format is needed.
    const mime = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    dictChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) dictChunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setDictState("busy");
      try {
        const blob = new Blob(dictChunksRef.current, {
          type: rec.mimeType || "audio/mp4",
        });
        const ext = (rec.mimeType || "").includes("webm") ? "webm" : "m4a";
        await onDone(blob, ext);
      } catch (e) {
        pushToast(
          "error",
          String(e).includes("STT_MODEL_MISSING")
            ? "Download the voice model first (Settings → Model → Dictation)."
            : `Dictation failed: ${e}`,
        );
      } finally {
        setDictState("idle");
        setDictOwner(null);
      }
    };
    rec.start();
    recorderRef.current = rec;
    setDictOwner(owner);
    setDictState("recording");
  }

  /** Record → transcribe on this Mac → optional translate/intent shaping on
   * the room's LOCAL model (alfred's pipeline; Settings → Dictation) → hand
   * the words to `sink`. Shaping failures never lose the words: the raw
   * transcript is used instead. */
  function dictateTo(owner: string, sink: (text: string) => void | Promise<void>) {
    void beginRecording(owner, async (blob, ext) => {
      const b64 = await fileToBase64(new File([blob], `dictation.${ext}`));
      let text = (await api.transcribeAudio(b64, ext, false)).trim();
      if (!text) {
        pushToast("info", "No speech detected.");
        return;
      }
      try {
        const [translate, mode] = await Promise.all([
          api.getSetting("dict_translate"),
          api.getSetting("dict_mode"),
        ]);
        if (translate === "on" || (mode && mode !== "off")) {
          text = (await api.shapeText(text, translate === "on", mode || "off")).trim() || text;
        }
      } catch (e) {
        pushToast("info", `Kept the exact transcript — ${e}`);
      }
      await sink(text);
    });
  }

  /** Owner-aware classes/titles for a mic button. */
  function micState(owner: string) {
    const active = dictOwner === owner ? dictState : "idle";
    return {
      cls: active,
      title:
        active === "recording"
          ? "Stop recording"
          : active === "busy"
            ? "Transcribing…"
            : "Dictate (transcribed on this Mac)",
      disabled: dictState !== "idle" && dictOwner !== owner,
    };
  }

  /** ADD-18 (voice note): keep the audio itself; the transcript follows in the
   * background, so the room ends up with both. */
  function recordVoiceNote() {
    void beginRecording("note", async (blob, ext) => {
      const stamp = new Date()
        .toLocaleString([], { dateStyle: "short", timeStyle: "short" })
        .replace(/[/:]/g, ".");
      const b64 = await fileToBase64(new File([blob], `note.${ext}`));
      await api.importAudioBytes(`Voice note ${stamp}.${ext}`, b64);
      setFiles(await api.listFiles());
      pushToast("success", "Voice note saved — transcript is being written…");
    });
  }

  /** ADD-18 (journal): dictate a dated entry; appends to today's journal file
   * in a "Journal" folder (both created on first use). */
  function dictateJournal() {
    dictateTo("journal", async (text) => {
      const today = new Date().toISOString().slice(0, 10);
      const name = `Journal ${today}.md`;
      const existing = files.find((f) => f.name === name);
      if (existing) {
        const c = await api.getFileContent(existing.id);
        await api.updateFileContent(
          existing.id,
          `${(c.text ?? "").replace(/\s+$/, "")}\n\n${text}\n`,
        );
      } else {
        const meta = await api.saveGeneratedFile(
          name,
          `# Journal — ${today}\n\n${text}\n`,
        );
        let folder = folders.find((f) => f.name === "Journal");
        if (!folder) folder = await api.createFolder("Journal");
        await api.moveFileToFolder(meta.id, folder.id);
        setFolders(await api.listFolders());
      }
      setFiles(await api.listFiles());
      pushToast("success", "Journal updated.");
    });
  }

  /** ADD-18 (talk-to-file): dictate straight into the open editable file —
   * the words are appended to its saved content (a version is snapshotted,
   * like every edit). */
  function dictateIntoFile() {
    if (!openFile) return;
    const id = openFile.id;
    const current = openFile.content.text ?? "";
    dictateTo("file", async (text) => {
      await api.updateFileContent(
        id,
        current ? `${current.replace(/\s+$/, "")}\n\n${text}\n` : `${text}\n`,
      );
      await viewFile(id);
      pushToast("success", "Added your words to the file.");
    });
  }

  /** ADD-18 / ADD-22 (make minutes): run the deterministic #minutes command on
   * the open recording's transcript. It fills a structured template and Rust
   * renders a timeline-styled HTML minutes file — far more reliable (and prettier)
   * than asking the small model to hand-author a document. */
  async function makeMinutes() {
    if (!openFile || asking || !activeChatId) return;
    const raw = `#minutes @${openFile.content.name}`;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: raw,
      sources: [],
      createdAt: "",
    };
    setMessages((m) => [...m, optimistic]);
    const chatId = activeChatId;
    await runTurn((askId) =>
      api.runCommand(chatId, "minutes", "", [openFile.id], raw, askId),
    );
  }

  // CHG-1: download the missing model from the banner with live progress.
  async function downloadModel(name: string) {
    if (pullingModel) return;
    setPullingModel(true);
    setPullError("");
    setPullStatus("starting…");
    setPullPercent(null);
    try {
      await api.pullModel(name);
      refreshAi();
    } catch (e) {
      setPullError(String(e));
    } finally {
      setPullingModel(false);
      setPullPercent(null);
    }
  }

  // First-run chooser: make the picked model the room's active model, then pull
  // it — so once the download finishes the app is immediately ready to use it.
  async function pickAndDownload(name: string) {
    if (pullingModel) return;
    await changeModel(name);
    await downloadModel(name);
  }

  // ADD-10: open the download page for people who don't have Ollama yet.
  async function getOllama() {
    try {
      await openUrl("https://ollama.com/download");
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  // ADD-10: start the installed-but-not-running Ollama, then auto-recheck.
  async function openOllamaApp() {
    try {
      await api.openOllama();
    } catch (e) {
      pushToast("error", String(e));
      return;
    }
    window.clearInterval(recheckTimer.current);
    let tries = 0;
    recheckTimer.current = window.setInterval(async () => {
      tries++;
      try {
        const st = await api.aiStatus();
        setAi(st);
        setModel((current) => current || st.defaultModel);
        if (st.running || tries >= 6) window.clearInterval(recheckTimer.current);
      } catch {
        if (tries >= 6) window.clearInterval(recheckTimer.current);
      }
    }, 1500);
  }

  async function saveToRoom(message: Message) {
    if (!saveDraft || saveDraft.id !== message.id) return;
    const name = saveDraft.name.trim() || "AI note.md";
    const meta = await api.saveGeneratedFile(name, message.content);
    setFiles(await api.listFiles());
    setSaveDraft(null);
    pushToast("success", `Saved "${meta.name}" into the room.`);
  }

  async function addMemory() {
    const content = memoryDraft.trim();
    if (!content) return;
    await api.addMemory(content);
    setMemories(await api.listMemories());
    setMemoryDraft("");
  }

  // ---- UX-5: edit a memory in place ----
  async function saveMemoryEdit() {
    if (!editingMemory) return;
    const { id, content } = editingMemory;
    const trimmed = content.trim();
    setEditingMemory(null);
    if (!trimmed) return;
    try {
      await api.updateMemory(id, trimmed);
      setMemories(await api.listMemories());
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  // ---- ADD-16: folders ----
  // BUG 1: reveal the inline create input (mirrors the folder-rename input).
  function startCreateFolder() {
    setCreatingFolder("");
  }

  // Enter/blur commits; a guard covers the blur that fires after Esc cancels.
  async function commitCreateFolder() {
    if (creatingFolder === null) return;
    const name = creatingFolder.trim();
    setCreatingFolder(null);
    if (!name) return;
    try {
      await api.createFolder(name);
      setFolders(await api.listFolders());
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function commitFolderRename() {
    if (!renamingFolder) return;
    const { id, name } = renamingFolder;
    const trimmed = name.trim();
    setRenamingFolder(null);
    if (!trimmed) return;
    try {
      await api.renameFolder(id, trimmed);
      setFolders(await api.listFolders());
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  // Deleting a folder only ungroups its files — it never deletes them.
  async function deleteFolder(id: string) {
    try {
      await api.deleteFolder(id);
      setFolders(await api.listFolders());
      setFiles(await api.listFiles());
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function moveFile(fileId: string, folderId: string | null) {
    setMoveMenuFor(null);
    try {
      await api.moveFileToFolder(fileId, folderId);
      setFiles(await api.listFiles());
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  async function commitRenameFile() {
    const pending = renamingFile;
    setRenamingFile(null);
    if (!pending) return;
    const name = pending.name.trim();
    const original = files.find((f) => f.id === pending.id);
    if (!name || name === original?.name) return;
    try {
      await api.renameFile(pending.id, name);
      setFiles(await api.listFiles());
      if (openFileRef.current?.id === pending.id) {
        setOpenFile((o) => (o ? { ...o, name } : o));
      }
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  function toggleFolderCollapse(id: string) {
    setCollapsedFolders((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---- ADD-6: act on a search hit ----
  function activateResult(r: FlatResult) {
    if (r.kind === "file") {
      viewFile(r.id, { find: r.snippet });
    } else if (r.kind === "message") {
      setActiveChatId(r.chatId);
      // Best-effort: jump to the message once the chat's rendered.
      const mid = r.messageId;
      window.setTimeout(() => {
        document
          .getElementById(`msg-${mid}`)
          ?.scrollIntoView({ block: "center" });
      }, 120);
    } else {
      setShowMemory(true);
    }
    setShowSearch(false);
  }

  useEffect(() => {
    ctxMenuRef.current = ctxMenu !== null;
  }, [ctxMenu]);

  // Keep the fixed-position row menus inside the viewport — a bottom/right row
  // would otherwise open partly off-screen. Runs before paint, so no flash.
  function clampMenu(el: HTMLDivElement | null, x: number, y: number) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - r.width - 8;
    const maxTop = window.innerHeight - r.height - 8;
    el.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
    el.style.top = `${Math.max(8, Math.min(y, maxTop))}px`;
  }
  useLayoutEffect(() => {
    if (ctxMenu) clampMenu(ctxMenuElRef.current, ctxMenu.x, ctxMenu.y);
  }, [ctxMenu]);
  useLayoutEffect(() => {
    if (moveMenuFor) clampMenu(moveMenuElRef.current, moveMenuFor.x, moveMenuFor.y);
  }, [moveMenuFor]);

  // Restore saved pane widths once per room.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(paneKey);
      if (raw) {
        const w = JSON.parse(raw);
        if (typeof w.sidebar === "number") setSidebarW(w.sidebar);
        if (typeof w.chat === "number") setChatW(w.chat);
      }
    } catch {
      /* ignore malformed saved widths */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneKey]);

  /** Start dragging a pane divider. `edge` says which pane the divider sizes. */
  function startPaneResize(edge: "sidebar" | "chat", e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = edge === "sidebar" ? sidebarW : chatW;
    document.body.classList.add("resizing-col");
    function onMove(ev: MouseEvent) {
      // Sidebar grows to the right; chat grows to the left (mirror the delta).
      const delta = edge === "sidebar" ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.max(220, Math.min(560, startW + delta));
      if (edge === "sidebar") setSidebarW(next);
      else setChatW(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-col");
      // Persist the final widths (read from the DOM-synced state on next tick).
      setSidebarW((sw) => {
        setChatW((cw) => {
          try {
            localStorage.setItem(paneKey, JSON.stringify({ sidebar: sw, chat: cw }));
          } catch {
            /* storage full/unavailable — non-fatal */
          }
          return cw;
        });
        return sw;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function engineLabelOf(m: string): string {
    return ENGINE_LABELS[m] ?? modelLabel(m) ?? m;
  }

  function resolveMcpApproval(
    req: McpApproveRequest,
    decision: "once" | "always" | "deny",
  ) {
    api.resolveMcpCall(req.id, decision).catch(() => {});
    setMcpApprovals((q) => q.filter((r) => r.id !== req.id));
  }

  // Open the Memory panel and bring it into view — used by the top-of-sidebar
  // chip so this trust feature is reachable without scrolling to the bottom.
  function revealMemory() {
    setShowMemory(true);
    setShowMemoryIntro(false);
    try {
      localStorage.setItem(`memoryIntroSeen:${info.name}`, "1");
    } catch {
      /* non-fatal */
    }
    window.setTimeout(() => {
      memoryHeadRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 30);
  }

  // Show the Memory intro once per room.
  useEffect(() => {
    try {
      if (!localStorage.getItem(`memoryIntroSeen:${info.name}`)) {
        setShowMemoryIntro(true);
      }
    } catch {
      /* ignore */
    }
  }, [info.name]);

  async function changeModel(value: string) {
    userPickedModelRef.current = true;
    setModel(value);
    await api.setSetting("model", value);
  }

  // Surface engine changes the user didn't make (auto-fallback, cloud CLI
  // disappearing, status re-fetch) so the header label is never the only clue.
  useEffect(() => {
    const prev = prevModelRef.current;
    if (prev && model && prev !== model && !userPickedModelRef.current) {
      pushToast("info", `Switched to ${engineLabelOf(model)}`);
    }
    prevModelRef.current = model;
    userPickedModelRef.current = false;
  }, [model]);

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  // Sidebar name filter (client-side): matches the cleaned display name too, so
  // "EOSE Stock" finds "EOSE_Stock_Info.md".
  const filterQ = fileFilter.trim().toLowerCase();
  const matchesFilter = (f: FileMeta) =>
    !filterQ ||
    f.name.toLowerCase().includes(filterQ) ||
    displayName(f.name).toLowerCase().includes(filterQ);
  const shownFiles = files.filter(matchesFilter);
  // ADD-16: files without a folder sit at the top level; the rest group.
  const looseFiles = shownFiles.filter((f) => f.folderId === null);

  /** One file row — identical behaviour whether loose or inside a folder.
   * Normally shows just name + size; the actions (attach + a ••• menu) reveal
   * on hover to keep the list calm. */
  function renderFileRow(f: FileMeta) {
    const attached = attachments.some((a) => a.id === f.id);
    const selected = openFile?.id === f.id;
    return (
      <div
        key={f.id}
        className={`file-row${selected ? " selected" : ""}${attached ? " attached" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", f.id);
          e.dataTransfer.effectAllowed = "move";
          internalDragRef.current = true;
        }}
        onDragEnd={() => {
          internalDragRef.current = false;
          setDragOverFolder(null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMoveMenuFor(null);
          setCtxMenu({ file: f, x: e.clientX, y: e.clientY });
        }}
      >
        {renamingFile?.id === f.id ? (
          <input
            className="file-rename-input"
            autoFocus
            dir="auto"
            value={renamingFile.name}
            onChange={(e) => setRenamingFile({ id: f.id, name: e.target.value })}
            onBlur={commitRenameFile}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRenameFile();
              if (e.key === "Escape") setRenamingFile(null);
            }}
          />
        ) : (
          <button className="file-main" onClick={() => viewFile(f.id)}>
            <span className="file-icon">
              <FileTypeIcon file={f} />
            </span>
            <span className="file-name" title={f.name}>
              {displayName(f.name)}
            </span>
            {f.partiallyIndexed && (
              <span
                className="partial-badge"
                title="Partially indexed — only the first part of this large file is searchable."
              >
                ◐
              </span>
            )}
            <span className="file-size">{formatSize(f.sizeBytes)}</span>
          </button>
        )}
        <span className="row-actions">
          <button
            className={`chip-btn ${attached ? "active" : ""}`}
            title={
              f.mimeType.startsWith("image/")
                ? "Attach image to your next question (vision)"
                : "Pin this file into your next question"
            }
            onClick={() => toggleAttach(f)}
          >
            <PaperclipIcon size={14} />
          </button>
          <button
            className="chip-btn"
            title="More actions"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMoveMenuFor(null);
              setCtxMenu({ file: f, x: r.right - 4, y: r.bottom + 4 });
            }}
          >
            <DotsIcon size={14} />
          </button>
        </span>
      </div>
    );
  }

  // ADD-6: flatten the grouped results for arrow-key navigation.
  const searchFlat: FlatResult[] = [];
  if (searchResults) {
    searchResults.files.forEach((f) =>
      searchFlat.push({ kind: "file", id: f.id, name: f.name, snippet: f.snippet }),
    );
    searchResults.messages.forEach((m) =>
      searchFlat.push({
        kind: "message",
        chatId: m.chatId,
        messageId: m.messageId,
        snippet: m.snippet,
      }),
    );
    searchResults.memories.forEach((m) =>
      searchFlat.push({ kind: "memory", id: m.id, snippet: m.snippet }),
    );
  }
  const msgOffset = searchResults ? searchResults.files.length : 0;
  const memOffset = searchResults
    ? searchResults.files.length + searchResults.messages.length
    : 0;

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSearchSel((s) => Math.min(s + 1, Math.max(searchFlat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSearchSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = searchFlat[searchSel];
      if (r) activateResult(r);
    }
    // Esc is handled by the global keydown listener.
  }

  const pendingApproval = mcpApprovals[0];

  return (
    <div className="workspace">
      {pendingApproval && (
        <div className="approve-backdrop">
          <div className="approve-card" role="alertdialog" aria-modal="true">
            <div className="approve-title">
              <GlobeIcon size={17} /> Allow a connected tool to run?
            </div>
            <p className="approve-body">
              The AI wants to use{" "}
              <strong>{pendingApproval.tool}</strong> from the{" "}
              <strong>{pendingApproval.server}</strong> connector. This is a
              separate program that can reach the internet — what the AI sends
              it leaves this room.
            </p>
            {pendingApproval.args && pendingApproval.args !== "{}" && (
              <pre className="approve-args">{pendingApproval.args}</pre>
            )}
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => resolveMcpApproval(pendingApproval, "once")}
              >
                Allow once
              </button>
              <button
                onClick={() => resolveMcpApproval(pendingApproval, "always")}
              >
                Always allow this connector
              </button>
              <button
                className="danger"
                onClick={() => resolveMcpApproval(pendingApproval, "deny")}
              >
                Don't allow
              </button>
            </div>
          </div>
        </div>
      )}
      {ctxMenu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div
            ref={ctxMenuElRef}
            className="ctx-menu"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
          >
            <button className="ctx-item" onClick={() => { viewFile(ctxMenu.file.id); setCtxMenu(null); }}>Open</button>
            <button className="ctx-item" onClick={() => { toggleAttach(ctxMenu.file); setCtxMenu(null); }}>{attachments.some((a) => a.id === ctxMenu.file.id) ? "Detach from chat" : "Attach to chat"}</button>
            <button className="ctx-item" onClick={() => { setRenamingFile({ id: ctxMenu.file.id, name: ctxMenu.file.name }); setCtxMenu(null); }}>Rename…</button>
            <button className="ctx-item" onClick={() => { setMoveMenuFor({ id: ctxMenu.file.id, x: ctxMenu.x, y: ctxMenu.y }); setCtxMenu(null); }}>Move to…</button>
            <button className="ctx-item" onClick={() => { exportOne(ctxMenu.file.id, ctxMenu.file.name); setCtxMenu(null); }}>Export a copy…</button>
            <div className="ctx-sep" />
            <button className="ctx-item danger" onClick={() => { removeFile(ctxMenu.file.id); setCtxMenu(null); }}>Remove from room</button>
          </div>
        </>
      )}
      {moveMenuFor && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => setMoveMenuFor(null)}
            onContextMenu={(e) => { e.preventDefault(); setMoveMenuFor(null); }}
          />
          <div
            ref={moveMenuElRef}
            className="ctx-menu"
            style={{ top: moveMenuFor.y, left: moveMenuFor.x }}
          >
            <div className="ctx-heading">Move to…</div>
            {(() => {
              const mf = files.find((f) => f.id === moveMenuFor.id);
              return (
                <>
                  <button
                    className="ctx-item"
                    disabled={!mf || mf.folderId === null}
                    onClick={() => { moveFile(moveMenuFor.id, null); setMoveMenuFor(null); }}
                  >
                    No folder
                  </button>
                  {folders.map((fo) => (
                    <button
                      key={fo.id}
                      className="ctx-item"
                      disabled={mf?.folderId === fo.id}
                      onClick={() => { moveFile(moveMenuFor.id, fo.id); setMoveMenuFor(null); }}
                    >
                      {fo.name}
                    </button>
                  ))}
                  {folders.length === 0 && (
                    <div className="ctx-empty">No folders yet</div>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <DownloadIcon size={28} />
            <span>Drop to add to this room</span>
          </div>
        </div>
      )}
      {showSearch && (
        <div
          className="search-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowSearch(false);
          }}
        >
          <div className="search-panel">
            <input
              className="search-input"
              autoFocus
              dir="auto"
              placeholder="Search files, messages and memories…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
            <div className="search-results">
              {searchQuery.trim() &&
                searchResults &&
                searchFlat.length === 0 && (
                  <div className="search-empty">No matches.</div>
                )}
              {searchQuery.trim() &&
                searchResults &&
                searchFlat.length > 0 && (
                  <div className="search-summary">
                    {searchResults.files.length} file
                    {searchResults.files.length === 1 ? "" : "s"} ·{" "}
                    {searchResults.messages.length} message
                    {searchResults.messages.length === 1 ? "" : "s"} ·{" "}
                    {searchResults.memories.length} memor
                    {searchResults.memories.length === 1 ? "y" : "ies"}
                  </div>
                )}
              {searchResults && searchResults.files.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Files <span className="search-count">{searchResults.files.length}</span>
                  </div>
                  {searchResults.files.map((f, i) => (
                    <button
                      key={f.id}
                      className={`search-result ${searchSel === i ? "sel" : ""}`}
                      onMouseEnter={() => setSearchSel(i)}
                      onClick={() =>
                        activateResult({
                          kind: "file",
                          id: f.id,
                          name: f.name,
                          snippet: f.snippet,
                        })
                      }
                    >
                      <span className="search-result-title">{f.name}</span>
                      <span className="search-result-snippet" dir="auto">
                        {f.snippet}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults && searchResults.messages.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Messages <span className="search-count">{searchResults.messages.length}</span>
                  </div>
                  {searchResults.messages.map((m, i) => {
                    const idx = msgOffset + i;
                    return (
                      <button
                        key={m.messageId}
                        className={`search-result ${searchSel === idx ? "sel" : ""}`}
                        onMouseEnter={() => setSearchSel(idx)}
                        onClick={() =>
                          activateResult({
                            kind: "message",
                            chatId: m.chatId,
                            messageId: m.messageId,
                            snippet: m.snippet,
                          })
                        }
                      >
                        <span className="search-result-snippet" dir="auto">
                          {m.snippet}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {searchResults && searchResults.memories.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Memories <span className="search-count">{searchResults.memories.length}</span>
                  </div>
                  {searchResults.memories.map((m, i) => {
                    const idx = memOffset + i;
                    return (
                      <button
                        key={m.id}
                        className={`search-result ${searchSel === idx ? "sel" : ""}`}
                        onMouseEnter={() => setSearchSel(idx)}
                        onClick={() =>
                          activateResult({
                            kind: "memory",
                            id: m.id,
                            snippet: m.snippet,
                          })
                        }
                      >
                        <span className="search-result-snippet" dir="auto">
                          {m.snippet}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="search-hint">
              ↑↓ to move · Enter to open · Esc to close
            </div>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="room-id" title={info.path}>
          <span className="room-lock">
            <Logomark size={26} />
          </span>
          <div className="room-id-text">
            <div className="room-name">{info.name}</div>
            <div className="room-sub">Private Room</div>
          </div>
        </div>
        <div className="topbar-right">
          {ai && (ai.models.length > 0 || ai.external.length > 0) ? (
            <div className="model-pill-wrap">
              <button
                className={`model-pill${isCloudEngine(model) ? " cloud" : ""}`}
                onClick={() => setModelMenuOpen((o) => !o)}
                title={
                  ai?.running
                    ? modelReady || isCloudEngine(model)
                      ? "AI ready — click to switch engine"
                      : "Model not downloaded"
                    : "Ollama not running"
                }
              >
                <span
                  className={`model-dot ${
                    isCloudEngine(model)
                      ? "ok"
                      : ai?.running
                        ? modelReady
                          ? "ok"
                          : "warn"
                        : "down"
                  }`}
                />
                <span className="model-pill-name">{engineLabelOf(model)}</span>
                <span className="model-pill-tier">
                  {isCloudEngine(model) ? "Cloud" : "Local"}
                </span>
                <ChevronDownIcon size={13} className="model-pill-caret" />
              </button>
              {modelMenuOpen && (
                <>
                  <div
                    className="menu-backdrop"
                    onMouseDown={() => setModelMenuOpen(false)}
                  />
                  <div className="pop-menu model-menu">
                    {ai.models.map((m) => (
                      <button
                        key={m}
                        className={`model-menu-item${m === model ? " sel" : ""}`}
                        onClick={() => {
                          changeModel(m);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="model-dot local" />
                        <span className="model-menu-name">
                          {modelLabel(m) ?? m}
                        </span>
                        <span className="model-menu-tier">Local</span>
                        {m === model && <CheckIcon size={14} />}
                      </button>
                    ))}
                    {ai.external.map((e) => (
                      <button
                        key={e}
                        className={`model-menu-item${e === model ? " sel" : ""}`}
                        onClick={() => {
                          changeModel(e);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="model-dot cloud" />
                        <span className="model-menu-name">
                          {ENGINE_LABELS[e] ?? e}
                        </span>
                        <span className="model-menu-tier cloud">Cloud</span>
                        {e === model && <CheckIcon size={14} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <button className="subtle" onClick={refreshAi}>
              Check AI
            </button>
          )}
          <button
            className="icon-btn"
            title="Search ⌘F"
            onClick={() => {
              setSearchSel(0);
              setShowSearch(true);
            }}
          >
            <SearchIcon size={16} />
          </button>
          <div className="room-menu-wrap">
            <button
              className="icon-btn"
              title="Room menu"
              onClick={() => setRoomMenuOpen((o) => !o)}
            >
              <DotsIcon size={16} />
            </button>
            {roomMenuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onMouseDown={() => setRoomMenuOpen(false)}
                />
                <div className="pop-menu room-menu">
                  <button
                    className="pop-item"
                    onClick={() => {
                      setShowSettings(true);
                      setRoomMenuOpen(false);
                    }}
                  >
                    Room settings
                  </button>
                  {files.length > 0 && (
                    <button
                      className="pop-item"
                      onClick={() => {
                        exportAllFiles();
                        setRoomMenuOpen(false);
                      }}
                    >
                      Export all files…
                    </button>
                  )}
                  <button
                    className="pop-item"
                    onClick={() => {
                      revealItemInDir(info.path).catch(() => {});
                      setRoomMenuOpen(false);
                    }}
                  >
                    Reveal in Finder
                  </button>
                </div>
              </>
            )}
          </div>
          <button className="lock-btn btn-ic" title="Lock ⌘L" onClick={handleLock}>
            <LockIcon size={14} /> Lock
          </button>
        </div>
      </header>

      {showSettings && (
        <Settings
          ai={ai}
          model={model}
          onModelChange={changeModel}
          onModelsChanged={refreshAi}
          onClose={() => {
            setShowSettings(false);
            refreshWebAccess();
            refreshAutolock();
          }}
        />
      )}

      {/* SEC-1: ask before any of the room's saved plug-ins start. Driven
          purely by info.pendingMcp — the backend only sets it when nothing
          has run yet, so this appears before anything can start. */}
      {info.pendingMcp && !mcpDialogDismissed && (
        <div className="settings-backdrop mcp-approve-backdrop">
          <div className="settings mcp-approve">
            <div className="settings-head">
              <span className="badge-label">
                <LockIcon size={15} /> This room wants to start programs
              </span>
            </div>
            <div className="settings-body">
              <p className="mcp-approve-lead">
                Opening <strong>{info.name}</strong> wants to run these programs
                on this Mac to give the AI extra tools. Only allow this if you
                trust whoever made the room.
              </p>
              <div className="mcp-approve-list">
                {info.pendingMcp.servers.map((s) => (
                  <div key={s.name} className="mcp-approve-server">
                    <div className="mcp-approve-name">{s.name}</div>
                    <code className="mcp-approve-cmd">{s.command}</code>
                  </div>
                ))}
              </div>
            </div>
            <div className="settings-actions mcp-approve-actions">
              <button
                className="subtle"
                onClick={keepMcpOff}
                disabled={approvingMcp}
              >
                Keep off
              </button>
              <button
                className="primary"
                onClick={approveMcp}
                disabled={approvingMcp}
              >
                {approvingMcp ? "Starting…" : "Allow"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD-12: paste a URL to save one page as a readable room file. */}
      {showAddLink && (
        <div
          className="settings-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !importingLink)
              setShowAddLink(false);
          }}
        >
          <div className="settings add-link-modal">
            <div className="settings-head">
              <span className="badge-label">
                <LinkIcon size={15} /> Add a web link
              </span>
              <button
                className="subtle btn-ic"
                title="Close"
                onClick={() => setShowAddLink(false)}
                disabled={importingLink}
              >
                <CloseIcon size={12} />
              </button>
            </div>
            <div className="settings-body">
              <p className="settings-hint">
                This fetches one page from the internet.
              </p>
              <input
                className="add-link-input"
                autoFocus
                dir="auto"
                placeholder="https://example.com/article"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitLink();
                  if (e.key === "Escape" && !importingLink) setShowAddLink(false);
                }}
              />
              <div className="settings-actions">
                <button
                  className="subtle"
                  onClick={() => setShowAddLink(false)}
                  disabled={importingLink}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  onClick={submitLink}
                  disabled={importingLink || !linkUrl.trim()}
                >
                  {importingLink ? "Fetching…" : "Save page"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="body">
        {/* ------- pane 1: file explorer ------- */}
        <aside className="sidebar" style={{ width: sidebarW }}>
          <div
            className={`side-head${dragOverFolder === "__root__" ? " drag-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverFolder !== "__root__") setDragOverFolder("__root__");
            }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              setDragOverFolder(null);
              if (id) moveFile(id, null);
            }}
          >
            <span>Files</span>
            <span className="side-head-actions">
              <div className="add-menu-wrap">
                <button
                  className="add-btn"
                  title="Add something to this room"
                  onClick={() => setAddMenuOpen((o) => !o)}
                >
                  <PlusIcon size={14} /> Add
                </button>
                {addMenuOpen && (
                  <>
                    <div
                      className="menu-backdrop"
                      onMouseDown={() => setAddMenuOpen(false)}
                    />
                    <div className="pop-menu add-menu">
                      <button
                        className="pop-item"
                        onClick={() => {
                          importFiles();
                          setAddMenuOpen(false);
                        }}
                      >
                        <DownloadIcon size={14} /> File
                      </button>
                      <button
                        className="pop-item"
                        onClick={() => {
                          startCreateFolder();
                          setAddMenuOpen(false);
                        }}
                      >
                        <FolderIcon size={14} /> Folder
                      </button>
                      <button
                        className="pop-item"
                        onClick={() => {
                          setLinkUrl("");
                          setShowAddLink(true);
                          setAddMenuOpen(false);
                        }}
                      >
                        <LinkIcon size={14} /> Web link
                      </button>
                      <button
                        className="pop-item"
                        disabled={micState("note").disabled}
                        onClick={() => {
                          recordVoiceNote();
                          setAddMenuOpen(false);
                        }}
                      >
                        <MicIcon size={14} /> Voice note
                      </button>
                      <button
                        className="pop-item"
                        disabled={micState("journal").disabled}
                        onClick={() => {
                          dictateJournal();
                          setAddMenuOpen(false);
                        }}
                      >
                        <MicIcon size={14} /> Journal entry
                      </button>
                    </div>
                  </>
                )}
              </div>
            </span>
          </div>
          <div className="side-search">
            <SearchIcon size={14} />
            <input
              className="side-search-input"
              placeholder="Search files…"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
            />
            {fileFilter && (
              <button
                className="side-search-clear"
                title="Clear"
                onClick={() => setFileFilter("")}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <button
            className="summarize-btn"
            title="Write a short overview of this room and what's inside"
            disabled={summarizing}
            onClick={summarizeRoom}
          >
            {summarizing ? (
              summarizeProgress || "Summarizing…"
            ) : (
              <>
                <SparkIcon size={14} /> Summarize room
              </>
            )}
          </button>
          <button
            className={`memory-chip${showMemoryIntro ? " glow" : ""}`}
            title="What the AI remembers about you — visible and editable"
            onClick={revealMemory}
          >
            <span className="memory-chip-label">
              <MemoryIcon size={14} /> Memory
            </span>
            <span className="count">{memories.length}</span>
          </button>
          {showMemoryIntro && (
            <div className="memory-intro">
              This is your room's memory — everything the AI remembers about
              you, visible and editable any time.
              <button
                className="memory-intro-dismiss"
                onClick={() => {
                  setShowMemoryIntro(false);
                  try {
                    localStorage.setItem(`memoryIntroSeen:${info.name}`, "1");
                  } catch {
                    /* non-fatal */
                  }
                }}
              >
                Got it
              </button>
            </div>
          )}
          <div className="file-list">
            {creatingFolder !== null && (
              <input
                className="folder-create-input"
                autoFocus
                dir="auto"
                placeholder="New folder name"
                value={creatingFolder}
                onChange={(e) => setCreatingFolder(e.target.value)}
                onBlur={commitCreateFolder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreateFolder();
                  if (e.key === "Escape") setCreatingFolder(null);
                }}
              />
            )}
            {files.length === 0 && (
              <div className="empty-hint">
                Add PDFs, notes, images, code or spreadsheets — they are stored
                encrypted inside this room.
              </div>
            )}
            {files.length > 0 && shownFiles.length === 0 && (
              <div className="empty-hint">No files match “{fileFilter}”.</div>
            )}
            {/* ADD-16: top-level (unfoldered) files first, then folder groups. */}
            {looseFiles.map(renderFileRow)}
            {folders.map((folder) => {
              const inFolder = shownFiles.filter((f) => f.folderId === folder.id);
              // While filtering, hide folders that have no matching file.
              if (filterQ && inFolder.length === 0) return null;
              const collapsed = collapsedFolders.has(folder.id);
              return (
                <div key={folder.id} className="folder-group">
                  <div
                    className={`folder-head${dragOverFolder === folder.id ? " drag-over" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverFolder !== folder.id) setDragOverFolder(folder.id);
                    }}
                    onDragLeave={() => setDragOverFolder(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("text/plain");
                      setDragOverFolder(null);
                      if (id) moveFile(id, folder.id);
                    }}
                  >
                    <button
                      className="folder-caret-btn"
                      title={collapsed ? "Expand" : "Collapse"}
                      onClick={() => toggleFolderCollapse(folder.id)}
                    >
                      {collapsed ? "▸" : "▾"}
                    </button>
                    {renamingFolder?.id === folder.id ? (
                      <input
                        className="folder-rename"
                        autoFocus
                        dir="auto"
                        value={renamingFolder.name}
                        onChange={(e) =>
                          setRenamingFolder({ id: folder.id, name: e.target.value })
                        }
                        onBlur={commitFolderRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitFolderRename();
                          if (e.key === "Escape") setRenamingFolder(null);
                        }}
                      />
                    ) : (
                      <button
                        className="folder-label"
                        onClick={() => toggleFolderCollapse(folder.id)}
                      >
                        <span className="folder-name" title={folder.name}>
                          {folder.name}
                        </span>
                        <span className="count">{inFolder.length}</span>
                      </button>
                    )}
                    <span className="folder-actions">
                      <button
                        className="chip-btn"
                        title="Rename folder"
                        onClick={() =>
                          setRenamingFolder({ id: folder.id, name: folder.name })
                        }
                      >
                        <PencilIcon size={13} />
                      </button>
                      {deleteControl(
                        `folder:${folder.id}`,
                        <TrashIcon size={14} />,
                        () => deleteFolder(folder.id),
                        "Delete folder (its files are kept, just ungrouped)",
                      )}
                    </span>
                  </div>
                  {!collapsed && (
                    <div className="folder-files">
                      {inFolder.length === 0 ? (
                        <div className="folder-empty">
                          Empty — drag a file here, or use the folder button on a file.
                        </div>
                      ) : (
                        inFolder.map(renderFileRow)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div
            ref={memoryHeadRef}
            className="side-head clickable"
            onClick={() => setShowMemory(!showMemory)}
          >
            <span>
              Memory <span className="count">{memories.length}</span>
            </span>
            <span>{showMemory ? "▾" : "▸"}</span>
          </div>
          {showMemory && (
            <div className="memory-panel">
              {memories.map((m) =>
                editingMemory?.id === m.id ? (
                  <div key={m.id} className="memory-row editing">
                    <input
                      className="memory-edit-input"
                      autoFocus
                      dir="auto"
                      value={editingMemory.content}
                      onChange={(e) =>
                        setEditingMemory({ id: m.id, content: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveMemoryEdit();
                        if (e.key === "Escape") setEditingMemory(null);
                      }}
                    />
                    <button
                      className="chip-btn"
                      title="Save"
                      onClick={saveMemoryEdit}
                    >
                      ✓
                    </button>
                    <button
                      className="chip-btn"
                      title="Cancel"
                      onClick={() => setEditingMemory(null)}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div key={m.id} className="memory-row">
                    <span dir="auto">{m.content}</span>
                    <span className="memory-actions">
                      <button
                        className="chip-btn"
                        title="Edit this memory"
                        onClick={() =>
                          setEditingMemory({ id: m.id, content: m.content })
                        }
                      >
                        <PencilIcon size={13} />
                      </button>
                      {deleteControl(
                        `mem:${m.id}`,
                        "×",
                        async () => {
                          await api.deleteMemory(m.id);
                          setMemories(await api.listMemories());
                        },
                        "Forget this",
                      )}
                    </span>
                  </div>
                ),
              )}
              <div className="memory-add">
                <input
                  placeholder="Something the AI should always remember…"
                  value={memoryDraft}
                  dir="auto"
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMemory()}
                />
                <button
                  className={`subtle btn-ic mic-btn ${micState("memory").cls}`}
                  title={
                    dictOwner === "memory" && dictState === "recording"
                      ? "Stop recording"
                      : "Speak a memory"
                  }
                  disabled={micState("memory").disabled}
                  onClick={() =>
                    dictateTo("memory", (text) =>
                      setMemoryDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text)),
                    )
                  }
                >
                  <MicIcon size={12} />
                </button>
                <button className="subtle" onClick={addMemory}>
                  Add
                </button>
              </div>
            </div>
          )}
        </aside>

        <div
          className="pane-resizer"
          title="Drag to resize"
          onMouseDown={(e) => startPaneResize("sidebar", e)}
        />

        {/* ------- pane 2: opened file ------- */}
        <section className="viewer">
          {openFile ? (
            <>
              <div className="viewer-head">
                <span className="viewer-title">{openFile.content.name}</span>
                <span className="viewer-actions">
                  {editModeOf(openFile.content) && (
                    <button
                      className="subtle btn-ic"
                      title={
                        editModeOf(openFile.content) === "copy"
                          ? "Edit the extracted text — saving creates a Markdown copy"
                          : "Switch between preview and editing"
                      }
                      onClick={() => setEditMode(!editMode)}
                    >
                      {editMode ? <EyeIcon size={13} /> : <PencilIcon size={13} />}
                      {editMode
                        ? "Preview"
                        : editModeOf(openFile.content) === "copy"
                          ? "Edit as text"
                          : "Edit"}
                    </button>
                  )}
                  <span className="history-wrap">
                    <button
                      className={`subtle ${showHistory ? "active" : ""}`}
                      title="Earlier saved versions of this file"
                      onClick={openHistory}
                    >
                      History
                    </button>
                    {showHistory && (
                      <div className="history-pop">
                        {versions.length === 0 ? (
                          <div className="history-empty">
                            No earlier versions yet.
                          </div>
                        ) : (
                          versions.map((v) => (
                            <div key={v.id} className="history-row">
                              <span className="history-meta">
                                <span className="history-cause">{v.cause}</span>
                                <span className="history-time">
                                  {formatWhen(v.savedAt)}
                                </span>
                              </span>
                              <button
                                className="subtle"
                                onClick={() => restoreVersion(v.id)}
                              >
                                Restore
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </span>
                  {openFile.content.text && (
                    <button
                      className="subtle"
                      title="Copy the whole document's extracted text"
                      onClick={copyAllText}
                    >
                      Copy all text
                    </button>
                  )}
                  {/* ADD-18: talk-to-file — dictate into the open editable file. */}
                  {openFile.content.editable && (
                    <button
                      className={`subtle btn-ic mic-btn ${micState("file").cls}`}
                      title={
                        dictOwner === "file" && dictState === "recording"
                          ? "Stop and append the words"
                          : "Dictate into this file — your words are appended to its saved content"
                      }
                      disabled={micState("file").disabled}
                      onClick={dictateIntoFile}
                    >
                      <MicIcon size={12} /> Dictate
                    </button>
                  )}
                  {/* ADD-18: one-click minutes from a recording's transcript. */}
                  {(openFile.content.kind === "audio" ||
                    openFile.content.kind === "video") &&
                    openFile.content.text && (
                      <button
                        className="subtle"
                        title="Turn this recording's transcript into timeline-style HTML minutes (summary, decisions, action items)"
                        disabled={asking}
                        onClick={makeMinutes}
                      >
                        <SparkIcon size={13} /> Minutes
                      </button>
                    )}
                  <button
                    className="subtle btn-ic"
                    title="Export a normal copy out of the room"
                    onClick={() => exportOne(openFile.id, openFile.content.name)}
                  >
                    <DownloadIcon size={13} /> Export
                  </button>
                  <button
                    className="subtle btn-ic"
                    onClick={() => setOpenFile(null)}
                  >
                    <CloseIcon size={12} /> Close
                  </button>
                </span>
              </div>
              <div
                className={`viewer-body ${
                  openFile.content.kind === "code" ||
                  openFile.content.kind === "html" ||
                  (editMode && editModeOf(openFile.content) !== "grid")
                    ? "fill"
                    : ""
                }`}
              >
                {(() => {
                  const c = openFile.content;
                  const t = openFile.target;
                  const mode = editModeOf(c);
                  // Edit mode: per-format editors. Monaco is keyed by edit
                  // state too — it takes value/readOnly at mount only.
                  if (editMode && mode === "grid") {
                    return (
                      <SheetView
                        key={`${openFile.id}-grid-${viewerRev}`}
                        dataB64={c.dataB64}
                        text={c.text}
                        target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
                        editable
                        onEditCell={editCell}
                      />
                    );
                  }
                  if (editMode && mode === "editor") {
                    return (
                      <CodeEditor
                        key={`${openFile.id}-edit-${viewerRev}`}
                        value={c.text ?? ""}
                        language={languageForFile(c.name)}
                        onSave={saveEdit}
                        find={t?.find}
                      />
                    );
                  }
                  if (editMode && mode === "copy") {
                    return (
                      <CodeEditor
                        key={`${openFile.id}-copy-${viewerRev}`}
                        value={c.text ?? ""}
                        language="markdown"
                        onSave={saveEditAsCopy}
                        saveLabel="Save copy"
                        find={t?.find}
                      />
                    );
                  }
                  // Preview mode. Code gets a read-only Monaco (syntax
                  // colors) — the Edit button unlocks it.
                  if (c.kind === "code") {
                    return (
                      <CodeEditor
                        key={`${openFile.id}-view-${viewerRev}`}
                        value={c.text ?? ""}
                        language={languageForFile(c.name)}
                        readOnly
                        find={t?.find}
                      />
                    );
                  }
                  switch (c.kind) {
                    case "image":
                      return (
                        <ImageView
                          key={`${openFile.id}-${viewerRev}`}
                          fileId={openFile.id}
                          name={c.name}
                          mime={c.mime}
                          dataB64={c.dataB64 ?? ""}
                        />
                      );
                    case "pdf":
                      return (
                        <PdfView
                          key={`${openFile.id}-${viewerRev}`}
                          dataB64={c.dataB64 ?? ""}
                          target={{ page: t?.page, quote: t?.quote ?? t?.find }}
                        />
                      );
                    case "docx":
                      return (
                        <DocxView
                          key={`${openFile.id}-${viewerRev}`}
                          dataB64={c.dataB64 ?? ""}
                          target={{ quote: t?.quote ?? t?.find }}
                        />
                      );
                    case "sheet":
                      return (
                        <SheetView
                          key={`${openFile.id}-${viewerRev}`}
                          dataB64={c.dataB64}
                          target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
                        />
                      );
                    case "csv":
                      return (
                        <SheetView
                          key={`${openFile.id}-${viewerRev}`}
                          text={c.text}
                          target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
                        />
                      );
                    case "markdown":
                      return (
                        <MarkdownView
                          key={`${openFile.id}-${viewerRev}`}
                          text={c.text ?? ""}
                          target={{ quote: t?.quote ?? t?.find }}
                        />
                      );
                    // HTML renders live in a sandboxed runner; Edit drops to
                    // Monaco for the source.
                    case "html":
                      return (
                        <HtmlView
                          key={`${openFile.id}-${viewerRev}`}
                          source={c.text ?? ""}
                        />
                      );
                    case "text":
                      return (
                        <TextView
                          key={`${openFile.id}-${viewerRev}`}
                          text={c.text ?? ""}
                          quote={t?.quote ?? t?.find}
                        />
                      );
                    // ADD-18: recordings/videos with a clickable transcript.
                    case "audio":
                    case "video":
                      return (
                        <AudioView
                          key={`${openFile.id}-${viewerRev}`}
                          kind={c.kind}
                          mime={c.mime}
                          dataB64={c.dataB64 ?? ""}
                          text={c.text}
                          target={{ quote: t?.quote ?? t?.find }}
                        />
                      );
                    default:
                      return (
                        <div className="empty-hint">
                          No preview available for this file type yet. Its
                          content is still stored safely inside the room.
                        </div>
                      );
                  }
                })()}
              </div>
            </>
          ) : (
            <div className="viewer-empty">
              <div className="viewer-empty-icon">
                <EmptyViewerArt />
              </div>
              <h1 className="viewer-empty-title">Your room is sealed</h1>
              <p className="viewer-empty-sub">
                Everything you add stays inside{" "}
                <strong>{info.path.split("/").pop()}</strong>. Add a file, open a
                note, or ask the room a question about everything inside.
              </p>
              <div className="viewer-empty-actions">
                <button className="qa-btn primary" onClick={importFiles}>
                  <PlusIcon size={15} /> Add a file
                </button>
                <button
                  className="qa-btn"
                  disabled={summarizing || files.length === 0}
                  onClick={summarizeRoom}
                >
                  <SparkIcon size={15} /> Summarize room
                </button>
                <button
                  className="qa-btn"
                  onClick={() => composerRef.current?.focus()}
                >
                  <SendIcon size={14} /> Ask the room
                </button>
              </div>
              <div className="viewer-empty-note">
                <LockIcon size={16} />
                <div>
                  <strong>End-to-end encrypted.</strong> Your data is encrypted
                  and never leaves this file unless you choose a cloud model.
                </div>
              </div>
            </div>
          )}
        </section>

        <div
          className="pane-resizer"
          title="Drag to resize"
          onMouseDown={(e) => startPaneResize("chat", e)}
        />

        {/* ------- pane 3: chat ------- */}
        <main className="chat" style={{ width: chatW, maxWidth: "none", flex: "0 0 auto" }}>
          <div className="chat-head">
            {renaming ? (
              <input
                className="chat-select chat-rename"
                autoFocus
                dir="auto"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <select
                className="chat-select"
                value={activeChatId ?? ""}
                dir="auto"
                onChange={(e) => setActiveChatId(e.target.value)}
              >
                {chats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            <button
              className="subtle btn-ic"
              title="Rename this chat"
              disabled={asking || !activeChatId || renaming}
              onClick={startRename}
            >
              <PencilIcon size={13} />
            </button>
            <button className="subtle" title="New chat ⌘N" onClick={newChat}>
              ＋ New
            </button>
            {activeChatId &&
              deleteControl(
                `chat:${activeChatId}`,
                <TrashIcon size={14} />,
                () => removeChat(activeChatId),
                "Delete this chat session",
              )}
          </div>

          {showSyncWarn && (
            <div className="banner">
              This room lives in a synced folder. Never open it on two computers
              at the same time — the file can be damaged. Lock it before
              switching machines.{" "}
              <button className="subtle" onClick={dismissSyncWarn}>
                Dismiss
              </button>
            </div>
          )}
          {/* ADD-10: three distinct onboarding states, all button-driven. */}
          {ai && !ai.running && !ai.installed && (
            <div className="banner onboard">
              <span>
                This room's AI runs on <strong>Ollama</strong>, a free app.
              </span>
              <span className="onboard-actions">
                <button className="subtle" onClick={getOllama}>
                  Get Ollama
                </button>
                <button className="subtle" onClick={refreshAi}>
                  I installed it — check again
                </button>
              </span>
            </div>
          )}
          {ai && !ai.running && ai.installed && (
            <div className="banner onboard">
              <span>
                <strong>Ollama</strong> is installed but not running.
              </span>
              <span className="onboard-actions">
                <button className="subtle" onClick={openOllamaApp}>
                  Open Ollama
                </button>
              </span>
            </div>
          )}
          {ai?.running && !modelReady && (
            <div className="banner onboard">
              {pullingModel ? (
                <span className="banner-pull">
                  <span className="banner-pull-label">
                    Downloading <strong>{model}</strong>…
                  </span>
                  <span className="pull-bar">
                    <span
                      className="pull-bar-fill"
                      style={{ width: `${pullPercent ?? 0}%` }}
                    />
                  </span>
                  <span className="banner-pull-status">
                    {pullStatus}
                    {pullPercent != null && ` — ${pullPercent.toFixed(0)}%`}
                  </span>
                </span>
              ) : (
                <div className="model-pick">
                  <div className="model-pick-head">
                    <strong>Pick a model to download</strong>
                    <span className="model-pick-sub">
                      It runs entirely on your Mac. You can switch or add more
                      anytime in Settings.
                    </span>
                  </div>
                  <div className="model-pick-grid">
                    {RECOMMENDED_MODELS.map((m) => (
                      <div className="model-pick-card" key={m.name}>
                        {m.tag && (
                          <span className="model-pick-tag">{m.tag}</span>
                        )}
                        <div className="model-pick-name">{m.name}</div>
                        <div className="model-pick-meta">
                          {m.label} · {m.size}
                        </div>
                        <div className="model-pick-blurb">{m.blurb}</div>
                        <button
                          className="subtle btn-ic model-pick-get"
                          onClick={() => pickAndDownload(m.name)}
                        >
                          <DownloadIcon size={13} /> Download
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {pullError && <div className="banner-error">{pullError}</div>}
            </div>
          )}
          <div className="messages" ref={chatRef}>
            {messages.length === 0 && (
              <div className="chat-hero">
                <div className="chat-hero-icon">
                  <EmptyChatArt />
                </div>
                <h2>Ask your room</h2>
                <p>
                  I can work across everything inside{" "}
                  {info.path.split("/").pop()}, using only the context you attach
                  or make available.
                </p>
                <div className="prompt-chips">
                  {[
                    "Summarize what's in this room",
                    "What are the key points across my files?",
                    "What did I add recently?",
                    "Draft a short memo from these files",
                  ].map((p) => (
                    <button
                      key={p}
                      className="prompt-chip"
                      onClick={() => {
                        setQuestion(p);
                        composerRef.current?.focus();
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                {commands.length > 0 && (
                  <div className="cmd-hints">
                    <span className="cmd-hints-label">Or run a command:</span>
                    {commands.slice(0, 4).map((c) => (
                      <button
                        key={c.name}
                        className="cmd-hint-chip"
                        title={c.summary}
                        onClick={() => {
                          setQuestion(`#${c.name} `);
                          composerRef.current?.focus();
                        }}
                      >
                        #{c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {messages.map((m) => {
              const { text, boxes, annotation } =
                m.role === "assistant"
                  ? splitMarkupBlocks(m.content)
                  : { text: m.content, boxes: undefined, annotation: undefined };
              return (
              <div key={m.id} id={`msg-${m.id}`} className={`msg ${m.role}`}>
                <div className="msg-content" dir="auto">
                  {m.role === "assistant" ? (
                    <>
                      <MarkdownView text={text} />
                      {boxes && (
                        <ChatAnnotatedImage
                          fileId={boxes.fileId}
                          boxes={boxes.boxes}
                        />
                      )}
                      {annotation && (
                        <button
                          className="annot-chip"
                          title="Show the highlight in the viewer"
                          onClick={() =>
                            viewFile(annotation.fileId, annotationTarget(annotation))
                          }
                        >
                          <EyeIcon size={13} />{" "}
                          {annotation.note ||
                            annotation.quote ||
                            annotation.range}{" "}
                          — {annotation.name}
                          {annotation.approx && (
                            <span
                              className="annot-approx"
                              title="The exact quote wasn't found — the closest passage was highlighted"
                            >
                              {" "}
                              · ≈ closest match
                            </span>
                          )}
                        </button>
                      )}
                    </>
                  ) : (
                    text
                  )}
                </div>
                {m.role === "assistant" && (
                  <div className="msg-footer">
                    {m.sources.length > 0 && (
                      <span className="msg-sources">
                        {m.sources.map((s) => (
                          <button
                            key={s}
                            className="source-chip"
                            title={`Open ${s}`}
                            onClick={() => openSource(s)}
                          >
                            {s}
                          </button>
                        ))}
                      </span>
                    )}
                    <button
                      className="subtle"
                      title="Copy this answer"
                      disabled={asking}
                      onClick={() => copyMessage(m)}
                    >
                      Copy
                    </button>
                    {undoByMsg[m.id] && (
                      <button
                        className="subtle undo-edit"
                        title="Undo the file change this answer made (reversible via version history)"
                        disabled={asking}
                        onClick={() => undoEdits(m.id)}
                      >
                        <UndoIcon size={13} /> Undo{" "}
                        {undoByMsg[m.id].length > 1 ? `${undoByMsg[m.id].length} edits` : "edit"}
                      </button>
                    )}
                    {m.id === lastAssistantId && (
                      <button
                        className="subtle"
                        title="Delete this answer and ask again (the original attachments are not re-sent)"
                        disabled={asking}
                        onClick={() => regenerate(m.id)}
                      >
                        Regenerate
                      </button>
                    )}
                    {saveDraft?.id === m.id ? (
                      <span className="save-form">
                        <input
                          value={saveDraft.name}
                          autoFocus
                          onChange={(e) =>
                            setSaveDraft({ id: m.id, name: e.target.value })
                          }
                          onKeyDown={(e) => e.key === "Enter" && saveToRoom(m)}
                        />
                        <button className="subtle" onClick={() => saveToRoom(m)}>
                          Save
                        </button>
                        <button className="subtle" onClick={() => setSaveDraft(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="subtle"
                        onClick={() => setSaveDraft({ id: m.id, name: "AI note.md" })}
                      >
                        Save to room
                      </button>
                    )}
                  </div>
                )}
              </div>
              );
            })}
            {asking && (
              <div className={`msg assistant ${streamText ? "" : "thinking"}`}>
                {(lane || steps.length > 0) && (
                  <div className="step-chips">
                    {lane && <span className="lane-chip">{lane}</span>}
                    {steps.map((s, i) => (
                      <span
                        key={i}
                        className={`step-chip${s.ok ? "" : " failed"}`}
                        title={s.ok ? undefined : "This step didn't succeed"}
                      >
                        {s.ok ? "" : "⚠ "}
                        {s.label}
                      </span>
                    ))}
                  </div>
                )}
                <div className="msg-content" dir="auto">
                  {streamText ? (
                    <>
                      <MarkdownView text={patchStreamFences(streamText)} />
                      <span className="stream-cursor">▍</span>
                    </>
                  ) : isCloudEngine(model) ? (
                    "Asking your cloud AI — content leaves this Mac…"
                  ) : (
                    "Thinking locally…"
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="composer">
            {toasts.length > 0 && (
              <div className="toast-stack">
                {toasts.map((t) => (
                  <div key={t.id} className={`toast ${t.kind}`}>
                    <span className="toast-text">{t.text}</span>
                    <button
                      className="toast-close"
                      title="Dismiss"
                      onClick={() => dismissToast(t.id)}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {isCloudEngine(model) && (
              <div className="cloud-strip" title="This room is using a cloud model — your prompts and attached context are sent to it.">
                <span className="cloud-strip-label">
                  <CloudIcon size={13} /> Cloud · leaves this Mac
                </span>
                <button
                  className="cloud-strip-action"
                  onClick={() => changeModel(ai?.defaultModel ?? "")}
                >
                  Use local
                </button>
              </div>
            )}
            {!isCloudEngine(model) && (webOn || mcpTools.length > 0) && (
              <div
                className="mcp-badge"
                title={[
                  webOn ? "Web search: on" : null,
                  mcpTools.length > 0
                    ? `Connected tools: ${mcpTools.join(", ")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                <span className="badge-label">
                  <GlobeIcon size={13} /> This room can reach the internet
                </span>
              </div>
            )}
            {(() => {
              // ADD-22: if the question names an image file that isn't attached,
              // nudge to attach it — the model can only SEE an image via the
              // paperclip, a rule users won't remember.
              const q = question.trim().toLowerCase();
              if (!q) return null;
              const attachedIds = new Set(attachments.map((f) => f.id));
              const hit = files.find(
                (f) =>
                  f.mimeType.startsWith("image/") &&
                  !attachedIds.has(f.id) &&
                  f.name.length >= 3 &&
                  q.includes(f.name.toLowerCase()),
              );
              if (!hit) return null;
              return (
                <div className="attach-nudge">
                  <span>
                    The AI can only see <strong>{displayName(hit.name)}</strong> if you
                    attach it.
                  </span>
                  <button className="subtle" onClick={() => toggleAttach(hit)}>
                    <PaperclipIcon size={13} /> Attach it
                  </button>
                </div>
              );
            })()}
            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((f) => (
                  <span key={f.id} className="attach-chip">
                    <FileTypeIcon file={f} size={13} /> {displayName(f.name)}
                    <button onClick={() => toggleAttach(f)}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className={`composer-card${asking ? " busy" : ""}`}>
              {ac && autocompleteItems().length > 0 && (
                <div className="ac-popover">
                  <div className="ac-hint">
                    {ac.kind === "cmd"
                      ? "Commands — run a prebuilt action"
                      : "Attach a file or folder as context"}
                  </div>
                  {autocompleteItems().map((it, i) => (
                    <button
                      key={it.key}
                      className={`ac-item ${i === ac.index ? "active" : ""}`}
                      // mousedown so the textarea doesn't blur first.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptAutocomplete(it.insert);
                      }}
                    >
                      <span className="ac-label">{it.label}</span>
                      <span className="ac-desc">{it.hint}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                className="composer-input"
                placeholder="Ask anything about this room…"
                value={question}
                rows={3}
                dir="auto"
                onChange={(e) => {
                  setQuestion(e.target.value);
                  refreshAutocomplete(e.target.value, e.target.selectionStart);
                }}
                onSelect={(e) =>
                  refreshAutocomplete(
                    e.currentTarget.value,
                    e.currentTarget.selectionStart,
                  )
                }
                onBlur={() => setAc(null)}
                onPaste={onComposerPaste}
                onKeyDown={onComposerKeyDown}
              />
              <div className="composer-tools">
                <div className="composer-tools-left">
                  <button
                    className="tool-chip"
                    title="Attach a file as context"
                    onClick={() => insertComposerToken("@")}
                  >
                    <PaperclipIcon size={14} /> Attach
                  </button>
                  <button
                    className="tool-chip"
                    title="Run a prebuilt action"
                    onClick={() => insertComposerToken("#")}
                  >
                    <span className="tool-hash">#</span> Action
                  </button>
                </div>
                <div className="composer-tools-right">
                  <button
                    className={`icon-btn mic-btn ${micState("composer").cls}`}
                    title={micState("composer").title}
                    disabled={micState("composer").disabled || asking}
                    onClick={() =>
                      dictateTo("composer", (text) =>
                        setQuestion((q) =>
                          q.trim() ? `${q.trimEnd()} ${text}` : text,
                        ),
                      )
                    }
                  >
                    <MicIcon size={16} />
                  </button>
                  {asking ? (
                    <button
                      className="send-btn stop"
                      title="Stop this answer"
                      onClick={stopAsk}
                    >
                      <span className="stop-glyph">◼</span>
                    </button>
                  ) : (
                    <button
                      className="send-btn"
                      title="Send ⏎"
                      onClick={send}
                      disabled={!question.trim()}
                    >
                      <SendIcon size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
