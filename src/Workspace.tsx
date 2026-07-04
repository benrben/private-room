import { ClipboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AiStatus,
  AnnotationPayload,
  api,
  Chat,
  ENGINE_LABELS,
  FileContent,
  FileMeta,
  FileTarget,
  FileVersion,
  formatSize,
  McpServerStatus,
  Memory,
  Message,
  modelLabel,
  RoomInfo,
} from "./api";
import {
  CloseIcon,
  DownloadIcon,
  EmptyChatArt,
  EmptyViewerArt,
  EyeIcon,
  FileTypeIcon,
  GearIcon,
  LockIcon,
  Logomark,
  PaperclipIcon,
  PencilIcon,
  SendIcon,
  TrashIcon,
} from "./icons";
import Settings from "./Settings";
import ChatAnnotatedImage from "./viewers/ChatAnnotatedImage";
import CodeEditor from "./viewers/CodeEditor";
import DocxView from "./viewers/DocxView";
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

/** Human-friendly timestamp for a saved version (ADD-2). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
  const [asking, setAsking] = useState(false);
  const [streamText, setStreamText] = useState("");
  // CHG-5: per-turn tool-step chips shown above the live text (not saved).
  const [steps, setSteps] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
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
  const [editMode, setEditMode] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ id: string; name: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  const [webOn, setWebOn] = useState(false);
  // ADD-2 version history panel.
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  // ADD-3 two-step delete: which item is awaiting confirmation, keyed "kind:id".
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // HLT-6 cloud-sync banner.
  const [showSyncWarn, setShowSyncWarn] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const toastSeq = useRef(0);
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;
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

  function pushToast(kind: Toast["kind"], text: string) {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    // Successes and info clear themselves; errors stay until dismissed.
    if (kind !== "error") {
      window.setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        5000,
      );
    }
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
    api.listMemories().then(setMemories);
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
      setSteps((s) => [...s, label]);
    });
    const unlistenRound = api.onAskRound(() => {
      setStreamText("");
    });
    const unlistenNotice = api.onAskNotice((text) => {
      pushToast("info", text);
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
      const current = openFileRef.current;
      if (current && current.id === fileId) {
        // Refresh in place — keep the edit/preview mode and target.
        const content = await api.getFileContent(current.id);
        setOpenFile({ ...current, content });
      }
    });
    const unlistenFiles = api.onRoomFilesChanged(() => {
      api.listFiles().then(setFiles);
    });
    api.mcpStatus().then((s) => setMcpTools(connectedTools(s))).catch(() => {});
    const unlistenMcp = api.onMcpStatus((statuses) => {
      setMcpTools(connectedTools(statuses));
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenStep.then((fn) => fn());
      unlistenRound.then((fn) => fn());
      unlistenNotice.then((fn) => fn());
      unlistenPull.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
      unlistenOpen.then((fn) => fn());
      unlistenAnnotate.then((fn) => fn());
      unlistenUpdated.then((fn) => fn());
      unlistenFiles.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
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

  /** Core ask flow shared by send() and regenerate(). Owns the ask id (ADD-7),
   * resets the live stream/steps (CHG-5), and swallows cancel-driven rejections
   * so Stop/Lock never surface an error toast (HLT-7). */
  async function askOnce(q: string, attachmentIds: string[]) {
    if (!activeChatId) return;
    const chatId = activeChatId;
    const askId = crypto.randomUUID();
    askIdRef.current = askId;
    setAsking(true);
    setStreamText("");
    setSteps([]);
    try {
      await api.ask(chatId, q, attachmentIds, askId);
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
      setMessages(await api.getMessages(chatId));
      setChats(await api.listChats());
      // Agent tools may have created files or memories.
      api.listFiles().then(setFiles);
      api.listMemories().then(setMemories);
      setAsking(false);
      setStreamText("");
      setSteps([]);
    }
  }

  async function send() {
    const q = question.trim();
    if (!q || asking || !activeChatId) return;
    setQuestion("");
    const attachmentIds = attachments.map((f) => f.id);
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: q,
      sources: [],
      createdAt: "",
    };
    setMessages((m) => [...m, optimistic]);
    setAttachments([]);
    await askOnce(q, attachmentIds);
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

  async function changeModel(value: string) {
    setModel(value);
    await api.setSetting("model", value);
  }

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  return (
    <div className="workspace">
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <DownloadIcon size={28} />
            <span>Drop to add to this room</span>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="room-id">
          <span className="room-lock">
            <Logomark size={26} />
          </span>
          <div>
            <div className="room-name">{info.name}</div>
            <div className="room-path" title={info.path}>
              {info.path}
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <span
            className={`ai-dot ${ai?.running ? (modelReady ? "ok" : "warn") : "down"}`}
            title={
              ai?.running
                ? modelReady
                  ? "Local AI ready"
                  : "Model not downloaded"
                : "Ollama not running"
            }
          />
          {ai && (ai.models.length > 0 || ai.external.length > 0) ? (
            <select
              className={isCloudEngine(model) ? "cloud-engine" : undefined}
              value={model}
              onChange={(e) => changeModel(e.target.value)}
            >
              {!ai.models.includes(model) && !ai.external.includes(model) && (
                <option value={model}>{model}</option>
              )}
              {ai.models.map((m) => (
                <option key={m} value={m} title={m}>
                  {modelLabel(m) ? `${modelLabel(m)} — ${m}` : m}
                </option>
              ))}
              {ai.external.length > 0 && (
                <optgroup label="Cloud engines — leaves this Mac">
                  {ai.external.map((e) => (
                    <option key={e} value={e}>
                      {ENGINE_LABELS[e] ?? e}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <button className="subtle" onClick={refreshAi}>
              Check AI
            </button>
          )}
          <button
            className="subtle btn-ic"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            <GearIcon size={15} />
          </button>
          <button className="btn-ic" onClick={handleLock}>
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

      <div className="body">
        {/* ------- pane 1: file explorer ------- */}
        <aside className="sidebar">
          <div className="side-head">
            <span>Files</span>
            <span className="side-head-actions">
              {files.length > 0 && (
                <button
                  className="subtle"
                  title="Save normal copies of every file to a folder"
                  onClick={exportAllFiles}
                >
                  Export all…
                </button>
              )}
              <button className="subtle" onClick={importFiles}>
                + Add
              </button>
            </span>
          </div>
          <div className="file-list">
            {files.length === 0 && (
              <div className="empty-hint">
                Add PDFs, notes, images, code or spreadsheets — they are stored
                encrypted inside this room.
              </div>
            )}
            {files.map((f) => (
              <div key={f.id} className="file-row">
                <button className="file-main" onClick={() => viewFile(f.id)}>
                  <span className="file-icon">
                    <FileTypeIcon file={f} />
                  </span>
                  <span className="file-name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="file-size">{formatSize(f.sizeBytes)}</span>
                </button>
                <button
                  className={`chip-btn ${attachments.some((a) => a.id === f.id) ? "active" : ""}`}
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
                  title="Export a normal copy out of the room"
                  onClick={() => exportOne(f.id, f.name)}
                >
                  <DownloadIcon size={14} />
                </button>
                {deleteControl(
                  `file:${f.id}`,
                  <TrashIcon size={14} />,
                  () => removeFile(f.id),
                  "Remove from room",
                )}
              </div>
            ))}
          </div>

          <div className="side-head clickable" onClick={() => setShowMemory(!showMemory)}>
            <span>
              Memory <span className="count">{memories.length}</span>
            </span>
            <span>{showMemory ? "▾" : "▸"}</span>
          </div>
          {showMemory && (
            <div className="memory-panel">
              {memories.map((m) => (
                <div key={m.id} className="memory-row">
                  <span dir="auto">{m.content}</span>
                  {deleteControl(
                    `mem:${m.id}`,
                    "×",
                    async () => {
                      await api.deleteMemory(m.id);
                      setMemories(await api.listMemories());
                    },
                    "Forget this",
                  )}
                </div>
              ))}
              <div className="memory-add">
                <input
                  placeholder="Something the AI should always remember…"
                  value={memoryDraft}
                  dir="auto"
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMemory()}
                />
                <button className="subtle" onClick={addMemory}>
                  Add
                </button>
              </div>
            </div>
          )}
        </aside>

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
                        key={openFile.id}
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
                        key={`${openFile.id}-edit`}
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
                        key={`${openFile.id}-copy`}
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
                        key={`${openFile.id}-view`}
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
                          key={openFile.id}
                          fileId={openFile.id}
                          name={c.name}
                          mime={c.mime}
                          dataB64={c.dataB64 ?? ""}
                        />
                      );
                    case "pdf":
                      return (
                        <PdfView
                          key={openFile.id}
                          dataB64={c.dataB64 ?? ""}
                          target={{ page: t?.page, quote: t?.quote ?? t?.find }}
                        />
                      );
                    case "docx":
                      return (
                        <DocxView
                          key={openFile.id}
                          dataB64={c.dataB64 ?? ""}
                          target={{ quote: t?.quote ?? t?.find }}
                        />
                      );
                    case "sheet":
                      return (
                        <SheetView
                          key={openFile.id}
                          dataB64={c.dataB64}
                          target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
                        />
                      );
                    case "csv":
                      return (
                        <SheetView
                          key={openFile.id}
                          text={c.text}
                          target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
                        />
                      );
                    case "markdown":
                      return (
                        <MarkdownView
                          text={c.text ?? ""}
                          target={{ quote: t?.quote ?? t?.find }}
                        />
                      );
                    case "text":
                      return (
                        <TextView
                          key={openFile.id}
                          text={c.text ?? ""}
                          quote={t?.quote ?? t?.find}
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
              <p>Select a file on the left to open it here.</p>
            </div>
          )}
        </section>

        {/* ------- pane 3: chat ------- */}
        <main className="chat">
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
            <button className="subtle" title="New chat session" onClick={newChat}>
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
                <>
                  <span>
                    Model <strong>{model}</strong> isn't downloaded yet.
                  </span>
                  <span className="onboard-actions">
                    <button
                      className="subtle btn-ic"
                      onClick={() => downloadModel(model)}
                    >
                      <DownloadIcon size={13} /> Download {model}
                    </button>
                  </span>
                </>
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
                <h2>This room is yours alone.</h2>
                <p>
                  Ask about the files you add, attach images for the AI to look
                  at, or ask it to write summaries and notes — everything stays
                  inside this encrypted file.
                </p>
              </div>
            )}
            {messages.map((m) => {
              const { text, boxes, annotation } =
                m.role === "assistant"
                  ? splitMarkupBlocks(m.content)
                  : { text: m.content, boxes: undefined, annotation: undefined };
              return (
              <div key={m.id} className={`msg ${m.role}`}>
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
                          📍 {annotation.note ||
                            annotation.quote ||
                            annotation.range}{" "}
                          — {annotation.name}
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
                {steps.length > 0 && (
                  <div className="step-chips">
                    {steps.map((s, i) => (
                      <span key={i} className="step-chip">
                        {s}
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
                  ) : (
                    "Thinking locally…"
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="composer">
            {isCloudEngine(model) && (
              <div className="cloud-badge">
                <span>☁ Cloud engine active — questions leave this Mac</span>
                <button
                  className="subtle"
                  onClick={() => changeModel(ai?.defaultModel ?? "")}
                >
                  Switch to local
                </button>
              </div>
            )}
            {(webOn || mcpTools.length > 0) && (
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
                🌐 This room can reach the internet
              </div>
            )}
            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((f) => (
                  <span key={f.id} className="attach-chip">
                    <FileTypeIcon file={f} size={13} /> {f.name}
                    <button onClick={() => toggleAttach(f)}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="composer-row">
              <textarea
                placeholder="Ask this room anything…"
                value={question}
                rows={2}
                dir="auto"
                onChange={(e) => setQuestion(e.target.value)}
                onPaste={onComposerPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {asking ? (
                <button
                  className="btn-ic stop-btn"
                  title="Stop this answer"
                  onClick={stopAsk}
                >
                  <span className="stop-glyph">◼</span> Stop
                </button>
              ) : (
                <button
                  className="primary btn-ic"
                  onClick={send}
                  disabled={!question.trim()}
                >
                  <SendIcon size={14} /> Send
                </button>
              )}
            </div>
          </div>

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
        </main>
      </div>
    </div>
  );
}
