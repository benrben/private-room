import { useEffect, useRef, useState } from "react";
import { CheckIcon, PencilIcon, SaveIcon, SparklesIcon, TrashIcon, UndoIcon } from "../icons";
import type { LayoutApi, PresetName } from "../shell/useLayout";
import { validateSkin } from "./skinModel";
import {
  DEFAULT_SKIN_ID,
  activateSavedSkin,
  deleteSavedSkin,
  discardSkinDraft,
  exportSkin,
  importSkin,
  redoDraft,
  saveAndApplySkin,
  setDraftName,
  setSkinPreview,
  undoDraft,
  useSkinWorkspace,
} from "./skinStore";

function modeLabel(mode: "user" | "agent" | "together"): string {
  if (mode === "user") return "User only";
  if (mode === "agent") return "Agent only";
  return "Together";
}

function SkinStatus() {
  const { draft } = useSkinWorkspace();
  const issues = validateSkin(draft.config);
  return (
    <div className="skin-status" aria-live="polite">
      <span className={`skin-status-dot ${issues.length === 0 ? "is-valid" : "is-invalid"}`} />
      <strong>{issues.length === 0 ? "Valid draft" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`}</strong>
      <span>State version {draft.revision}</span>
      <span>{draft.dirty ? "Unsaved changes" : "Saved"}</span>
    </div>
  );
}

function PreviewWindow() {
  const { draft } = useSkinWorkspace();
  return (
    <section className="skin-preview-card" aria-label="Live app skin preview">
      <div className="skin-preview-note"><span>Live preview</span><small>The app around this canvas changes too.</small></div>
      <div className="skin-demo-window">
        <nav className="skin-demo-rail" aria-label="Preview navigation">
          <span className="skin-demo-logo">A</span>
          <span className="is-active">⌂</span><span>▱</span><span>◌</span><span>✦</span>
        </nav>
        <aside className="skin-demo-sidebar">
          <strong>Library</strong>
          <label><span>⌕</span><input aria-label="Preview search" readOnly value="Search this room" /></label>
          <button className="is-selected">Quarterly notes <small>Today</small></button>
          <button>Product brief <small>Yesterday</small></button>
          <button>Research clips <small>4 pages</small></button>
        </aside>
        <main className="skin-demo-main">
          <span className="skin-demo-kicker">Workspace / Preview</span>
          <h2>Your room, in your voice.</h2>
          <p>Typography, colours, backgrounds, spacing and shape are driven by one safe skin document.</p>
          <div className="skin-demo-callout"><SparklesIcon size={15} /><span><strong>Design agent</strong> suggested a calmer reading surface.</span></div>
          <div className="skin-demo-actions"><button className="nb-btn nb-btn-primary">Primary action</button><button className="nb-btn">Secondary</button></div>
        </main>
        <aside className="skin-demo-agent">
          <span><SparklesIcon size={14} /> Design agent</span>
          <p>I can propose an allow-listed patch, explain it, and validate contrast before saving.</p>
          <div><i /><small>Accent and heading scale</small></div>
          <div><i /><small>Surface contrast</small></div>
        </aside>
      </div>
      <footer className="skin-preview-meta">
        <span>{draft.config.typography.bodySize}px body</span>
        <span>{draft.config.shape.radius}px corners</span>
        <span>{draft.config.canvas.texture} texture</span>
        <span>{draft.config.canvas.backdrop} backdrop</span>
      </footer>
    </section>
  );
}

function DraftHistory() {
  const { draft } = useSkinWorkspace();
  return (
    <section className="skin-history-card">
      <div className="skin-card-heading"><div><h3>Draft history</h3><p>Every accepted user and agent change is attributable and reversible.</p></div><span>{draft.history.length}</span></div>
      {draft.history.length === 0 ? <p className="skin-empty-copy">Move a control or ask the Design agent for a first proposal.</p> : (
        <ol className="skin-history-list">
          {[...draft.history].reverse().slice(0, 12).map((entry) => (
            <li key={`${entry.revision}-${entry.label}`}><span className={`skin-actor is-${entry.actor}`}>{entry.actor === "agent" ? <SparklesIcon size={12} /> : <PencilIcon size={12} />}</span><span><strong>{entry.label}</strong><small>{entry.actor === "agent" ? "Design agent" : "You"} · recorded at version {entry.revision}</small></span></li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SavedSkins() {
  const workspace = useSkinWorkspace();
  const rows = [{ id: DEFAULT_SKIN_ID, name: "Arcelle default", savedBy: "system" as const }, ...workspace.saved];
  return (
    <section className="skin-saved-card">
      <div className="skin-card-heading"><div><h3>Saved skins</h3><p>Switch instantly; drafts stay separate until applied.</p></div><span>{rows.length}</span></div>
      <div className="skin-saved-list">
        {rows.map((skin) => <SavedSkinRow key={skin.id} activeSkinId={workspace.activeSkinId} skin={skin} />)}
      </div>
    </section>
  );
}

interface SavedSkinListItem {
  id: string;
  name: string;
  savedBy: "system" | "user" | "agent";
}

function SavedSkinRow({ activeSkinId, skin }: { activeSkinId: string; skin: SavedSkinListItem }) {
  const active = activeSkinId === skin.id;
  const activate = () => {
    if (activateSavedSkin(skin.id)) setSkinPreview(true);
  };
  const remove = () => {
    if (deleteSavedSkin(skin.id)) setSkinPreview(true);
  };
  return (
    <div className={active ? "is-active" : ""}>
      <button type="button" onClick={activate}><span className="skin-mini-palette" /><span><strong>{skin.name}</strong><small>{savedSkinStatus(active, skin.savedBy)}</small></span>{active && <CheckIcon size={14} />}</button>
      {skin.id !== DEFAULT_SKIN_ID && <button type="button" className="skin-delete" aria-label={`Delete ${skin.name}`} onClick={remove}><TrashIcon size={13} /></button>}
    </div>
  );
}

function savedSkinStatus(active: boolean, savedBy: SavedSkinListItem["savedBy"]): string {
  if (active) return "Active";
  if (savedBy === "agent") return "Saved by agent";
  if (savedBy === "user") return "Saved by you";
  return "Built in";
}

function ImportExport({ report }: { report: (message: string, error?: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const download = () => {
    try {
      const source = exportSkin();
      const blob = new Blob([source], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "arcelle-skin.json";
      link.click();
      URL.revokeObjectURL(url);
      report("Skin exported.");
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    }
  };
  const read = async (file: File | undefined) => {
    if (!file) return;
    const result = importSkin(await file.text());
    report(result.ok ? "Skin imported as a draft." : result.error, !result.ok);
    if (input.current) input.current.value = "";
  };
  return (
    <div className="skin-port-actions">
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(event) => void read(event.target.files?.[0])} />
      <button type="button" className="nb-btn" onClick={() => input.current?.click()}>Import JSON</button>
      <button type="button" className="nb-btn" onClick={download}>Export JSON</button>
    </div>
  );
}

function AgentHandoff({ question, setQuestion, showAgent }: { question: string; setQuestion: (value: string) => void; showAgent: () => void }) {
  const { draft } = useSkinWorkspace();
  const [wish, setWish] = useState("");
  const blocked = draft.mode === "user";
  const send = () => {
    const instruction = wish.trim();
    if (!instruction) return;
    const prompt = `*design ${instruction}`;
    setQuestion(question.trim() ? `${question.trim()}\n\n${prompt}` : prompt);
    setWish("");
    showAgent();
  };
  return (
    <section className="skin-agent-handoff">
      <div><span className="skin-agent-mark"><SparklesIcon size={16} /></span><span><strong>Design with the agent</strong><small>{blocked ? "Unavailable in User-only mode." : "Stages a typed design request in the room Assistant; current privacy and source scope apply."}</small></span></div>
      <textarea aria-label="Design request" disabled={blocked} value={wish} onChange={(event) => setWish(event.target.value)} placeholder="Make it warmer, quieter, and easier to read at night…" />
      <button type="button" className="nb-btn nb-btn-primary" disabled={blocked || !wish.trim()} onClick={send}>Open in Assistant</button>
    </section>
  );
}

function LayoutPresets({ layout }: { layout: LayoutApi }) {
  const presets: Array<{ id: PresetName; label: string; title?: string }> = [{ id: "focus", label: "Canvas focus", title: "Hide both side panes; choose Research or Review to restore them" }, { id: "research", label: "Research" }, { id: "review", label: "Review" }];
  return <div className="skin-layout-presets"><span>Try workspace layout</span>{presets.map((preset) => <button key={preset.id} title={preset.title} type="button" onClick={() => layout.applyPreset(preset.id)}>{preset.label}</button>)}</div>;
}

export function SkinStudio({ layout, question, setQuestion, showAgent }: {
  layout: LayoutApi;
  question: string;
  setQuestion: (value: string) => void;
  showAgent: () => void;
}) {
  const workspace = useSkinWorkspace();
  const { draft } = workspace;
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  useEffect(() => {
    setSkinPreview(true);
    return () => setSkinPreview(false);
  }, []);
  const report = (message: string, error = false) => setNotice({ message, error });
  const undo = () => {
    const result = undoDraft("user");
    report(result.ok ? "Last change undone." : result.error, !result.ok);
  };
  const redo = () => {
    const result = redoDraft("user");
    report(result.ok ? "Change restored." : result.error, !result.ok);
  };
  const save = () => {
    const result = saveAndApplySkin("user");
    report(result.ok ? `Saved and applied “${result.saved.name}”.` : result.error, !result.ok);
  };
  const discard = () => {
    discardSkinDraft();
    setSkinPreview(true);
    report("Draft discarded; the active skin is back.");
  };
  return (
    <div className="skin-studio">
      <header className="skin-studio-header">
        <div><span className="skin-eyebrow">Visual system editor</span><h1>Skin Studio</h1><p>Edit the real app manually, with the Design agent, or together. Draft freely; nothing becomes active until you save.</p></div>
        <SkinStatus />
      </header>
      <div className="skin-studio-bar">
        <label><span>Draft name</span><input value={workspace.draftName} onChange={(event) => setDraftName(event.target.value)} /></label>
        <span className="skin-mode-chip"><span className={`skin-mode-dot is-${draft.mode}`} />{modeLabel(draft.mode)}</span>
        <button className="nb-btn" type="button" disabled={draft.history.length === 0 || draft.mode === "agent"} onClick={undo}><UndoIcon size={13} /> Undo</button>
        <button className="nb-btn" type="button" disabled={draft.future.length === 0 || draft.mode === "agent"} onClick={redo}>Redo</button>
        <button className="nb-btn" type="button" disabled={!draft.dirty} onClick={discard}>Discard</button>
        <button className="nb-btn nb-btn-primary" type="button" disabled={validateSkin(draft.config).length > 0} onClick={save}><SaveIcon size={13} /> Save &amp; apply</button>
      </div>
      {notice && <div className={`skin-notice ${notice.error ? "is-error" : ""}`} role="status">{notice.message}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      <PreviewWindow />
      <LayoutPresets layout={layout} />
      <AgentHandoff question={question} setQuestion={setQuestion} showAgent={showAgent} />
      <div className="skin-studio-lower"><DraftHistory /><SavedSkins /></div>
      <footer className="skin-studio-footer"><p><strong>Portable, not programmable.</strong> JSON import and agent edits use the same allow-list; arbitrary CSS and scripts are rejected.</p><ImportExport report={report} /></footer>
    </div>
  );
}
