import { createContext, useContext } from "react";
import {
  formatSize,
  SkillBundle,
  SkillResourceContent,
  SkillResourceMeta,
} from "../../api";
import {
  BookOpenIcon,
  DownloadIcon,
  FileTypeIcon,
  FolderIcon,
  PaperclipIcon,
  PlusIcon,
  SaveIcon,
  SparklesIcon,
  TrashIcon,
} from "../../icons";
import { displayName } from "../composer";
import { WSState } from "../state";
import { useSkillsModel, type SkillsModel, type SkillsModelProps as Props } from "./skillsModel";
import { KIND_LABEL, KIND_ORDER, type ResKind, type SkillDraft, type SkillFlag, kindOf, normalizeSkillName, pathLabel, skillFlags } from "./skillsPolicy";

function ExampleSkill() {
  return (
    <figure className="sk-example">
      <figcaption className="sk-example-cap">
        <span className="nb-tape nb-sem-pending">Example</span>
        <span>Not installed — this is the shape of a skill folder.</span>
      </figcaption>
      <div className="sk-example-card nb-card">
        <span className="sk-example-name">review-contracts</span>
        <p className="sk-example-desc">
          Review commercial contracts for risk against our own policy. Use when
          the user shares an agreement, an MSA, or a supplier terms sheet.
        </p>
        <ul className="sk-tree nb-connect">
          <li>
            <code>SKILL.md</code>
            <span>what it does, when to use it, the procedure</span>
          </li>
          <li>
            <code>references/risk-policy.md</code>
            <span>read only once the skill fires</span>
          </li>
          <li>
            <code>scripts/extract_clauses.py</code>
            <span>run, not guessed at</span>
          </li>
          <li>
            <code>assets/report-template.md</code>
            <span>the shape of the answer</span>
          </li>
        </ul>
      </div>
    </figure>
  );
}

const SkillsContext = createContext<SkillsModel | null>(null);

function useSkills(): SkillsModel {
  const model = useContext(SkillsContext);
  if (!model) throw new Error("Skills view context is unavailable.");
  return model;
}

function SkillsContent() {
  const { draft } = useSkills();
  return draft ? <SkillsEditor /> : <SkillsBrowse />;
}

function SkillsBrowse() {
  return (
    <div className="sk-page">
      <div className="sk-inner">
        <SkillsBrowseHeader />
        <SkillFolderNote />
        <SkillComposer />
        <SkillsIndex />
      </div>
    </div>
  );
}

function SkillsBrowseHeader() {
  const { enabledCount, s, skillDek } = useSkills();
  const hasSkills = s.skills.length > 0;
  const count = s.skills.length;
  const state = enabledCount > 0 ? `${enabledCount} enabled` : "None enabled yet";
  return (
    <header className="sk-masthead">
      <div className="sk-masthead-main">
        <span className="sk-masthead-ico" aria-hidden="true"><BookOpenIcon size={20} /></span>
        <div><h1 className="sk-title">Skills</h1><p className="sk-lead">{skillDek ?? "Teach the assistant repeatable ways of working."}</p></div>
      </div>
      <div className="sk-stamp">
        <span className="sk-stamp-count">{count} skill{count === 1 ? "" : "s"} in this room</span>
        {hasSkills && <span className={`nb-tape sk-stamp-state ${enabledCount > 0 ? "nb-sem-done" : "nb-sem-pending"}`}>{state}</span>}
      </div>
    </header>
  );
}

function SkillFolderNote() {
  return (
    <details className="sk-note">
      <summary>What is inside a skill folder?</summary>
      <div className="sk-note-body">
        <p>Each skill is a portable folder: <code>SKILL.md</code>, plus optional <code>scripts/</code>, <code>references/</code>, <code>assets/</code>, and <code>agents/</code>. Enabled skills appear in chat when you type <code>/</code>.</p>
        <ul className="sk-note-list">
          <li><code>SKILL.md</code><span>the name, the trigger description, and the procedure itself</span></li>
          <li><code>references/</code><span>knowledge read only once the skill fires</span></li>
          <li><code>scripts/</code><span>deterministic code, run rather than guessed at</span></li>
          <li><code>assets/</code><span>templates and materials the output is built from</span></li>
          <li><code>agents/</code><span>sub-agents that travel with the skill</span></li>
        </ul>
      </div>
    </details>
  );
}

function SkillComposer() {
  return <section className="sk-section"><div className="sk-compose"><p className="sk-compose-title"><SparklesIcon size={16} /> Ask the skill builder</p><SkillSourceChips /><SkillComposeInput /><SkillSourceControl /></div></section>;
}

function SkillSourceChips() {
  const { composeSourceFiles, toggleComposeSource } = useSkills();
  if (composeSourceFiles.length === 0) return null;
  return <div className="sk-source-chips" aria-label="Skill source files">{composeSourceFiles.map((file) => <span key={file.id} className="sk-source-chip"><FileTypeIcon file={file} size={14} /><span title={file.name}>{displayName(file.name)}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => toggleComposeSource(file.id)}>×</button></span>)}</div>;
}

function SkillComposeInput() {
  const { compose, composeBusy, composeId, composeRef, composeText, setComposeText } = useSkills();
  const submitOnEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void compose();
  };
  return <><label className="sk-compose-label" htmlFor={composeId}>Describe what the skill should do, and when to use it</label><div className="sk-compose-row"><textarea id={composeId} ref={composeRef} value={composeText} rows={1} placeholder="e.g. Review supplier contracts using our risk policy and always return a clause-by-clause table" onChange={(event) => setComposeText(event.target.value)} onKeyDown={submitOnEnter} /><button className="primary sk-compose-go" disabled={composeBusy || !composeText.trim()} onClick={() => void compose()}>{composeBusy ? "Building…" : "Build with AI"}</button></div></>;
}

function SkillSourceControl() {
  const { composeSourceIds, setSourcePickerOpen, sourcePickerOpen } = useSkills();
  const count = composeSourceIds.length;
  const label = count > 0 ? `${count} source${count === 1 ? "" : "s"}` : "Add room files";
  return <div className="sk-source-bar"><div className="sk-source-wrap"><button type="button" className={`subtle btn-ic${sourcePickerOpen ? " active" : ""}`} aria-expanded={sourcePickerOpen} onClick={() => setSourcePickerOpen((open) => !open)}><PaperclipIcon size={14} />{label}</button>{sourcePickerOpen && <SkillSourcePicker />}</div><span className="sk-source-hint">Selected files are copied into the draft as portable reference snapshots.</span></div>;
}

function SkillSourcePicker() {
  const { composeSourceIds, filteredSourceFiles, s, setSourceFilter, setSourcePickerOpen, sourceFilter, toggleComposeSource } = useSkills();
  const closeOnEscape = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setSourcePickerOpen(false);
  };
  const emptyLabel = s.files.length === 0 ? "No files in this room yet." : "No files match that search.";
  return <section className="sk-source-picker nb-float nb-float-draw" aria-label="Choose source files" onKeyDown={closeOnEscape}><div className="sk-source-picker-head"><strong>Build from room files</strong><button className="subtle" onClick={() => setSourcePickerOpen(false)}>Done</button></div><input autoFocus value={sourceFilter} placeholder="Find a file…" onChange={(event) => setSourceFilter(event.target.value)} /><div className="sk-source-list">{filteredSourceFiles.length === 0 && <div className="sk-source-empty">{emptyLabel}</div>}{filteredSourceFiles.map((file) => <SkillSourceFileOption key={file.id} file={file} selected={composeSourceIds} onToggle={toggleComposeSource} />)}</div></section>;
}

function SkillSourceFileOption({ file, selected, onToggle }: { file: WSState["files"][number]; selected: string[]; onToggle: (id: string) => void }) {
  const checked = selected.includes(file.id);
  const disabled = !file.hasText || (!checked && selected.length >= 12);
  const detail = file.hasText ? `${file.mimeType || "file"} · ${formatSize(file.sizeBytes)}` : "No readable text yet";
  return <label className={`sk-source-option${disabled ? " disabled" : ""}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(file.id)} /><FileTypeIcon file={file} size={14} /><span><strong title={file.name}>{displayName(file.name)}</strong><small>{detail}</small></span></label>;
}

function SkillsIndex() {
  const { s } = useSkills();
  return <section className="sk-section"><SkillsIndexHeader />{s.skills.length === 0 ? <SkillsEmpty /> : <SkillsGrid />}</section>;
}

function SkillsIndexHeader() {
  const { importFolder, startNew } = useSkills();
  return <div className="sk-section-head"><h2>In this room</h2><div className="sk-section-actions"><button className="subtle btn-ic" onClick={() => void importFolder()}><DownloadIcon size={14} /> Import folder</button><button className="subtle btn-ic" onClick={startNew}><PlusIcon size={14} /> New skill</button></div></div>;
}

function SkillsEmpty() {
  return <div className="sk-empty"><div><h3 className="sk-empty-head">No skills yet</h3><p className="sk-empty-copy">Build one with AI, start manually, or import any Agent Skills-compatible folder.</p></div><ExampleSkill /></div>;
}

function SkillsGrid() {
  const { s } = useSkills();
  return <div className="sk-grid nb-frame-set">{s.skills.map((skill) => <SkillCard key={skill.id} skill={skill} />)}</div>;
}

function SkillCard({ skill }: { skill: WSState["skills"][number] }) {
  const { a, agentIds } = useSkills();
  return <button className="sk-card nb-card nb-lift" onClick={() => a.openSkill(skill.id)}><span className="sk-card-head"><span className="sk-card-ico" aria-hidden="true"><FolderIcon size={16} /></span><span className="sk-card-name">{skill.name}</span><SkillFlagList flags={skillFlags(skill, agentIds)} /></span><span className="sk-card-desc">{skill.description}</span><span className="sk-card-foot"><span className="sk-card-meta">{skill.resourceCount} resource{skill.resourceCount === 1 ? "" : "s"} · {skill.createdBy}</span>{skill.agent && <span className="nb-chip sk-card-owner" title={`Offered to ${skill.agent}`}>Offered to {skill.agent}</span>}</span></button>;
}

function SkillFlagList({ flags }: { flags: SkillFlag[] }) {
  return <span className="sk-flags">{flags.map((flag) => <span key={flag.key} className={`nb-tape sk-flag ${flag.mark}`} title={flag.why}>{flag.word}</span>)}</span>;
}

function SkillsEditor() {
  const { bundle, resource } = useSkills();
  return <div className="sk-editor"><SkillsEditorHeader /><div className="sk-editor-layout"><SkillEditorMain />{bundle && <SkillResourceSidebar />}{bundle && resource && <SkillResourceEditor />}</div></div>;
}

function SkillsEditorHeader() {
  const { bundle, busy, deletedElsewhere, dirty, exportFolder, leaveEditor, problems, saveMetadata } = useSkills();
  return <div className="sk-editor-head"><button className="subtle" onClick={() => void leaveEditor()}>← All skills</button><div className="sk-editor-actions">{bundle && <button className="subtle btn-ic" onClick={() => void exportFolder()}><FolderIcon size={14} /> Export folder</button>}<button className="primary btn-ic" disabled={!dirty || busy || deletedElsewhere !== null || problems.length > 0} title={problems[0]} onClick={() => void saveMetadata()}><SaveIcon size={14} /> {busy ? "Saving…" : "Save SKILL.md"}</button></div></div>;
}

function SkillEditorMain() {
  return <div className="sk-main"><SkillEditorHeading /><SkillProblems /><SkillMetadataFields /><SkillDeleteControl /></div>;
}

function editorKicker(isNew: boolean, createdBy: string | undefined): string {
  if (isNew) return "New skill";
  return createdBy === "agent" ? "AI-authored draft" : "Agent Skill";
}

function editorFlags(bundle: SkillBundle | null, draft: SkillDraft, agentIds: string[], deletedElsewhere: string | null): SkillFlag[] {
  if (!bundle) return [];
  const flags = skillFlags({ enabled: bundle.skill.enabled, description: draft.description, agent: draft.agent, instructions: draft.instructions }, agentIds);
  if (deletedElsewhere) flags.push({ key: "deleted", word: "Deleted elsewhere", mark: "nb-sem-urgent", why: `${deletedElsewhere} was deleted from this room, so nothing here can be saved. Copy anything you still need, then go back to the list.` });
  return flags;
}

function SkillEditorHeading() {
  const { agentIds, bundle, deletedElsewhere, draft, isNew, selectedSummary } = useSkills();
  if (!draft) return null;
  const kicker = editorKicker(isNew, selectedSummary?.createdBy);
  const flags = editorFlags(bundle, draft, agentIds, deletedElsewhere);
  return <div className="sk-head-row"><div><span className="sk-kicker">{kicker}</span><h1 className="sk-editor-title">{draft.name || "Untitled skill"}</h1>{bundle && <SkillFlagList flags={flags} />}</div>{bundle && <SkillEnabledToggle />}</div>;
}

function SkillEnabledToggle() {
  const { bundle, deletedElsewhere, toggleEnabled } = useSkills();
  if (!bundle) return null;
  return <label className="sk-enable" title="Only enabled skills are advertised to the assistant"><input type="checkbox" checked={bundle.skill.enabled} disabled={deletedElsewhere !== null} onChange={(event) => void toggleEnabled(event.target.checked)} /><span className="mkt-sw" /><span>{bundle.skill.enabled ? "Enabled" : "Disabled draft"}</span></label>;
}

function SkillProblems() {
  const { dirty, problems } = useSkills();
  if (!dirty || problems.length === 0) return null;
  return <div className="wf-errors">Fix these before saving:<ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>;
}

function SkillMetadataFields() {
  const { agentIds, draft, patchDraft } = useSkills();
  if (!draft) return null;
  const unknownAgent = draft.agent && !agentIds.includes(draft.agent);
  return <><label className="sk-field"><span>Name <small>lowercase letters, numbers, hyphens</small></span><input value={draft.name} placeholder="review-contracts" onChange={(event) => patchDraft("name", normalizeSkillName(event.target.value))} /></label><label className="sk-field"><span>Description <small>the trigger: what it does and when to use it</small></span><textarea rows={3} value={draft.description} placeholder="Review commercial contracts for risk. Use when…" onChange={(event) => patchDraft("description", event.target.value)} /></label><label className="sk-field"><span>Offered to <small>which specialist may use this skill</small></span><select value={draft.agent} onChange={(event) => patchDraft("agent", event.target.value)}><option value="">Every assistant (general)</option>{agentIds.map((id) => <option key={id} value={id}>{id}</option>)}{unknownAgent && <option value={draft.agent}>{draft.agent} (not a specialist this app has)</option>}</select></label><label className="sk-field sk-instructions"><span>SKILL.md instructions <small>loaded only after this skill triggers</small></span><textarea spellCheck={false} value={draft.instructions} onChange={(event) => patchDraft("instructions", event.target.value)} /></label></>;
}

function SkillDeleteControl() {
  const { bundle, confirmDelete, removeSkill, setConfirmDelete } = useSkills();
  if (!bundle) return null;
  return <div className="sk-danger">{confirmDelete ? <span>Delete this skill and every bundled resource? <button className="danger" onClick={() => void removeSkill()}>Delete permanently</button> <button className="subtle" onClick={() => setConfirmDelete(false)}>Cancel</button></span> : <button className="subtle btn-ic danger" onClick={() => setConfirmDelete(true)}><TrashIcon size={14} /> Delete skill</button>}</div>;
}

function SkillResourceSidebar() {
  const { bundle, chooseMain, newResourcePath, resource, setNewResourcePath, addResource, deletedElsewhere } = useSkills();
  if (!bundle) return null;
  return <aside className="sk-res"><div className="sk-res-head"><strong>Folder contents</strong><small>Encrypted inside this room</small></div><button className={`sk-res-row ${resource ? "" : "active"}`} onClick={() => void chooseMain()}><BookOpenIcon size={14} /><span><strong>SKILL.md</strong><small>metadata + instructions</small></span></button><SkillResourceGroups resources={bundle.resources} /><div className="sk-res-add"><input value={newResourcePath} placeholder="references/policy.md" aria-label="New file path" onChange={(event) => setNewResourcePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addResource(); }} /><button className="subtle" disabled={!newResourcePath.trim() || deletedElsewhere !== null} title="Add this file" aria-label="Add this file" onClick={() => void addResource()}><PlusIcon size={12} /></button></div><details className="sk-res-note"><summary>Which folder does what?</summary><div className="sk-note-body"><p>Use <code>scripts/</code> for deterministic code, <code>references/</code> for on-demand knowledge, and <code>assets/</code> for output materials.</p></div></details></aside>;
}

function SkillResourceGroups({ resources }: { resources: SkillResourceMeta[] }) {
  return <>{KIND_ORDER.filter((kind) => resources.some((resource) => kindOf(resource) === kind)).map((kind) => <SkillResourceGroup key={kind} kind={kind} resources={resources.filter((resource) => kindOf(resource) === kind)} />)}</>;
}

function SkillResourceGroup({ kind, resources }: { kind: ResKind; resources: SkillResourceMeta[] }) {
  return <div className="sk-res-group"><div className="sk-res-group-head"><span>{KIND_LABEL[kind]}</span><span className="nb-circled">{resources.length}</span></div>{resources.map((resource) => <SkillResourceRow key={resource.path} resource={resource} />)}</div>;
}

function SkillResourceRow({ resource }: { resource: SkillResourceMeta }) {
  const { chooseResource, resource: open } = useSkills();
  const label = pathLabel(resource.path);
  return <button className={`sk-res-row ${open?.path === resource.path ? "active" : ""}`} onClick={() => void chooseResource(resource.path)}><FolderIcon size={14} /><span><strong>{label.name}</strong><small>{label.folder} · {resource.kind} · {formatSize(resource.sizeBytes)}</small></span></button>;
}

function SkillResourceEditor() {
  const { resource } = useSkills();
  if (!resource) return null;
  return <section className="sk-file"><div className="sk-file-head"><div><strong>{resource.path}</strong><small>{resource.kind}</small></div><SkillResourceActions /></div><SkillResourceBody resource={resource} /></section>;
}

function SkillResourceActions() {
  const { deletedElsewhere, removeResource, resource, resourceDirty, saveResource } = useSkills();
  if (!resource) return null;
  return <span><button className="subtle btn-ic danger" disabled={deletedElsewhere !== null} onClick={() => void removeResource()}><TrashIcon size={12} /> Remove</button>{resource.text != null && <button className="primary btn-ic" disabled={!resourceDirty || deletedElsewhere !== null} onClick={() => void saveResource()}><SaveIcon size={12} /> Save</button>}</span>;
}

function SkillResourceBody({ resource }: { resource: SkillResourceContent }) {
  const { resourceText, setResourceDirty, setResourceText } = useSkills();
  if (resource.text == null) return <div className="sk-binary-note">Binary asset. Export the folder to inspect it, or re-import the skill folder to replace it.</div>;
  return <textarea spellCheck={false} aria-label={`${resource.path} contents`} value={resourceText} onChange={(event) => { setResourceText(event.target.value); setResourceDirty(true); }} />;
}

export default function SkillsView(props: Props) {
  const model = useSkillsModel(props);
  return (
    <SkillsContext.Provider value={model}>
      <SkillsContent />
    </SkillsContext.Provider>
  );
}
