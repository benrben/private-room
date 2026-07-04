import { useEffect, useRef, useState } from "react";
import {
  AiStatus,
  AnnotationPayload,
  api,
  Chat,
  ENGINE_LABELS,
  FileContent,
  FileMeta,
  FileTarget,
  formatSize,
  McpServerStatus,
  Memory,
  Message,
  RoomInfo,
} from "./api";
import {
  CloseIcon,
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
  const [notice, setNotice] = useState("");
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [saveDraft, setSaveDraft] = useState<{ id: string; name: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  const [webOn, setWebOn] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;

  function refreshWebAccess() {
    api
      .getSetting("web_provider")
      .then((v) => setWebOn(v === "brave" || v === "searxng"))
      .catch(() => {});
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
    const unlisten = api.onAskDelta((delta) => {
      setStreamText((t) => t + delta);
    });
    refreshWebAccess();
    // The AI can drive the app: open files in the viewer, create/edit files,
    // and highlight spots in documents.
    const unlistenOpen = api.onAgentOpenFile((p) => {
      if (typeof p === "string") {
        viewFile(p);
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
      unlistenOpen.then((fn) => fn());
      unlistenAnnotate.then((fn) => fn());
      unlistenUpdated.then((fn) => fn());
      unlistenFiles.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
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

  const modelReady =
    (ai?.running &&
      (ai.models.includes(model) ||
        ai.models.some((m) => m.startsWith(model + ":") || model.startsWith(m)))) ||
    ai?.external.includes(model);

  async function importFiles() {
    const picked = await api.chooseOpenPath({ title: "Add files to this room", multiple: true });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const report = await api.importFiles(paths);
    setFiles(await api.listFiles());
    if (report.errors.length > 0) {
      setNotice(report.errors.join(" · "));
    } else {
      setNotice(`Added ${report.imported.length} file${report.imported.length === 1 ? "" : "s"} to the room.`);
    }
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
    setNotice(`Saved "${openFile.content.name}".`);
  }

  /** Editing a binary format (pdf/docx/pptx) can't round-trip — the edited
   * text is saved as a new Markdown file, the original stays unchanged. */
  async function saveEditAsCopy(newText: string) {
    if (!openFile) return;
    const base = openFile.content.name.replace(/\.[^.]+$/, "");
    const meta = await api.saveGeneratedFile(`${base} (edited).md`, newText);
    setFiles(await api.listFiles());
    setNotice(`Saved "${meta.name}" into the room — the original file is unchanged.`);
  }

  async function editCell(sheet: string, cell: string, value: string) {
    if (!openFile) return;
    try {
      await api.setCell(openFile.id, sheet || null, cell, value);
    } catch (e) {
      setNotice(String(e));
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

  async function send() {
    const q = question.trim();
    if (!q || asking || !activeChatId) return;
    setAsking(true);
    setNotice("");
    setQuestion("");
    setStreamText("");
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: q,
      sources: [],
      createdAt: "",
    };
    setMessages((m) => [...m, optimistic]);
    try {
      await api.ask(activeChatId, q, attachments.map((f) => f.id));
      setMessages(await api.getMessages(activeChatId));
      setChats(await api.listChats());
      setAttachments([]);
      // Agent tools may have created files or memories.
      api.listFiles().then(setFiles);
      api.listMemories().then(setMemories);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("OLLAMA_DOWN")) {
        setNotice("Ollama is not running. Start the Ollama app, then try again.");
      } else if (msg.includes("MODEL_MISSING")) {
        setNotice(`Model "${model}" is not downloaded. Run: ollama pull ${model}`);
      } else {
        setNotice(msg);
      }
      setMessages(await api.getMessages(activeChatId));
      refreshAi();
    } finally {
      setAsking(false);
      setStreamText("");
    }
  }

  async function saveToRoom(message: Message) {
    if (!saveDraft || saveDraft.id !== message.id) return;
    const name = saveDraft.name.trim() || "AI note.md";
    const meta = await api.saveGeneratedFile(name, message.content);
    setFiles(await api.listFiles());
    setSaveDraft(null);
    setNotice(`Saved "${meta.name}" into the room.`);
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

  return (
    <div className="workspace">
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
            <select value={model} onChange={(e) => changeModel(e.target.value)}>
              {!ai.models.includes(model) && !ai.external.includes(model) && (
                <option value={model}>{model}</option>
              )}
              {ai.models.map((m) => (
                <option key={m} value={m}>
                  {m}
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
          <button className="btn-ic" onClick={onLock}>
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
          }}
        />
      )}

      <div className="body">
        {/* ------- pane 1: file explorer ------- */}
        <aside className="sidebar">
          <div className="side-head">
            <span>Files</span>
            <button className="subtle" onClick={importFiles}>
              + Add
            </button>
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
                  className="chip-btn danger"
                  title="Remove from room"
                  onClick={() => removeFile(f.id)}
                >
                  <TrashIcon size={14} />
                </button>
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
                  <span>{m.content}</span>
                  <button
                    className="chip-btn danger"
                    onClick={async () => {
                      await api.deleteMemory(m.id);
                      setMemories(await api.listMemories());
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="memory-add">
                <input
                  placeholder="Something the AI should always remember…"
                  value={memoryDraft}
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
            <select
              className="chat-select"
              value={activeChatId ?? ""}
              onChange={(e) => setActiveChatId(e.target.value)}
            >
              {chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <button className="subtle" title="New chat session" onClick={newChat}>
              ＋ New
            </button>
            {activeChatId && (
              <button
                className="chip-btn danger"
                title="Delete this chat session"
                onClick={() => removeChat(activeChatId)}
              >
                <TrashIcon size={14} />
              </button>
            )}
          </div>

          {ai && !ai.running && (
            <div className="banner">
              Local AI engine is offline. Start <strong>Ollama</strong> to chat
              with this room. <button className="subtle" onClick={refreshAi}>Retry</button>
            </div>
          )}
          {ai?.running && !modelReady && (
            <div className="banner">
              Model <strong>{model}</strong> is not downloaded. Run{" "}
              <code>ollama pull {model}</code> in a terminal, then{" "}
              <button className="subtle" onClick={refreshAi}>refresh</button>.
            </div>
          )}
          {notice && (
            <div className="banner notice">
              {notice}{" "}
              <button className="subtle" onClick={() => setNotice("")}>
                <CloseIcon size={12} />
              </button>
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
                <div className="msg-content">
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
                          <span key={s} className="source-chip">
                            {s}
                          </span>
                        ))}
                      </span>
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
            {asking &&
              (streamText ? (
                <div className="msg assistant">
                  <div className="msg-content">
                    {streamText}
                    <span className="stream-cursor">▍</span>
                  </div>
                </div>
              ) : (
                <div className="msg assistant thinking">
                  <div className="msg-content">Thinking locally…</div>
                </div>
              ))}
          </div>

          <div className="composer">
            {mcpTools.length > 0 && (
              <div className="mcp-badge" title={mcpTools.join("\n")}>
                🌐 External tools connected — answers can use the internet
              </div>
            )}
            {webOn && (
              <div className="mcp-badge">
                🌐 Web access is on — searches and page fetches leave this Mac
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
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                className="primary btn-ic"
                onClick={send}
                disabled={asking || !question.trim()}
              >
                <SendIcon size={14} />
                {asking ? "…" : "Send"}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
