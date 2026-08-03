import { useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, formatSize, SkillBundle, SkillResourceContent } from "../../api";
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
import { WSActions } from "../actions";

type Props = { s: WSState; a: WSActions };
type SkillDraft = {
  name: string;
  description: string;
  instructions: string;
  /** The one specialist this skill is offered to. "" = every agent (general).
   * It was invisible here before: an imported skill's owner could not be seen
   * and could not be corrected without hand-editing the folder. */
  agent: string;
};

const STARTER = `# Purpose

Follow this workflow when the skill applies.

## Workflow

1. Inspect the user's request and relevant room context.
2. Apply the specialized procedure.
3. Verify the result before replying.`;

function pathLabel(path: string) {
  const parts = path.split("/");
  return { folder: parts.length > 1 ? parts.slice(0, -1).join("/") : "root", name: parts.at(-1) ?? path };
}

export default function SkillsView({ s, a }: Props) {
  const [bundle, setBundle] = useState<SkillBundle | null>(null);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeSourceIds, setComposeSourceIds] = useState<string[]>([]);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [resource, setResource] = useState<SkillResourceContent | null>(null);
  const [resourceText, setResourceText] = useState("");
  const [resourceDirty, setResourceDirty] = useState(false);
  const [newResourcePath, setNewResourcePath] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The host's roster of valid owners — asked for, never written down here, so
  // the picker can only offer ids the save would accept.
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const selected = s.selectedSkillId;

  async function load(id: string) {
    try {
      const next = await api.getSkill(id);
      setBundle(next);
      setDraft({
        name: next.skill.name,
        description: next.skill.description,
        instructions: next.skill.instructions,
        agent: next.skill.agent ?? "",
      });
      setIsNew(false);
      setDirty(false);
      setResource(null);
      setResourceText("");
      setResourceDirty(false);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  useEffect(() => {
    if (selected) void load(selected);
    else if (!isNew) {
      setBundle(null);
      setDraft(null);
      setResource(null);
    }
    // `load` is intentionally keyed only by the selected id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    api
      .skillAgentIds()
      .then(setAgentIds)
      .catch(() => setAgentIds([]));
  }, []);

  useEffect(() => {
    const ta = composeRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 136)}px`;
  }, [composeText]);

  const selectedSummary = useMemo(
    () => s.skills.find((x) => x.id === selected) ?? null,
    [s.skills, selected],
  );
  const composeSourceFiles = useMemo(
    () => composeSourceIds.flatMap((id) => s.files.find((file) => file.id === id) ?? []),
    [composeSourceIds, s.files],
  );
  const filteredSourceFiles = useMemo(() => {
    const query = sourceFilter.trim().toLowerCase();
    return s.files.filter((file) => !query || file.name.toLowerCase().includes(query));
  }, [s.files, sourceFilter]);

  function toggleComposeSource(id: string) {
    setComposeSourceIds((current) => {
      if (current.includes(id)) return current.filter((sourceId) => sourceId !== id);
      if (current.length >= 12) {
        s.pushToast("error", "Choose at most 12 source files for one skill.");
        return current;
      }
      return [...current, id];
    });
  }

  function startNew() {
    s.setSelectedSkillId(null);
    setBundle(null);
    setDraft({ name: "", description: "", instructions: STARTER, agent: "" });
    setIsNew(true);
    setDirty(true);
    setResource(null);
    setConfirmDelete(false);
  }

  function patchDraft<K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setDirty(true);
  }

  async function saveMetadata() {
    if (!draft || busy) return;
    setBusy(true);
    try {
      if (isNew) {
        const id = await api.createSkill(draft.name, draft.description, draft.instructions, draft.agent);
        await a.refreshSkills();
        s.setSelectedSkillId(id);
        s.pushToast("success", "Skill draft created — review it, then enable it.");
      } else if (bundle) {
        await api.updateSkill(bundle.skill.id, draft.name, draft.description, draft.instructions, draft.agent);
        await a.refreshSkills();
        await load(bundle.skill.id);
        s.pushToast("success", "SKILL.md saved.");
      }
      setDirty(false);
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function compose() {
    const text = composeText.trim();
    if (!text || composeBusy) return;
    setComposeBusy(true);
    s.pushToast("info", "Designing the skill folder…");
    try {
      const id = await api.composeSkill(text, composeSourceIds);
      setComposeText("");
      setComposeSourceIds([]);
      setSourcePickerOpen(false);
      setSourceFilter("");
      await a.refreshSkills();
      s.setSelectedSkillId(id);
      s.pushToast("success", "Skill draft ready — review its trigger, instructions, and resources.");
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setComposeBusy(false);
    }
  }

  async function importFolder() {
    const picked = await api.chooseOpenPath({ directory: true, multiple: false, title: "Choose a skill folder" });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      // A name clash used to be a flat refusal, so the only way to install a
      // newer version of a skill was to delete the old one — which also threw
      // away every file you had hand-edited inside it. Ask instead.
      const clash = await api.skillImportConflict(path);
      let replace = false;
      if (clash) {
        replace = await confirm(
          `This room already has a skill called "${clash}". Replace it with this folder? Its SKILL.md and files are overwritten, and any file not in the folder is removed. Its enabled setting is kept.`,
          { title: "Replace this skill?", kind: "warning", okLabel: "Replace" },
        );
        if (!replace) return;
      }
      const id = await api.importSkillFolder(path, replace);
      await a.refreshSkills();
      s.setSelectedSkillId(id);
      s.pushToast(
        "success",
        replace
          ? `Replaced ${clash} with the imported folder.`
          : "Skill imported as a disabled draft for review.",
      );
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function exportFolder() {
    if (!bundle) return;
    const picked = await api.chooseOpenPath({ directory: true, multiple: false, title: "Export skill into…" });
    const destination = Array.isArray(picked) ? picked[0] : picked;
    if (!destination) return;
    try {
      await api.exportSkillFolder(bundle.skill.id, destination);
      s.pushToast("success", `Exported ${bundle.skill.name}/ with SKILL.md and resources.`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function toggleEnabled(on: boolean) {
    if (!bundle) return;
    try {
      if (dirty) await saveMetadata();
      await api.setSkillEnabled(bundle.skill.id, on);
      await a.refreshSkills();
      await load(bundle.skill.id);
      s.pushToast("success", on ? "Skill enabled — its description is now available to the assistant." : "Skill disabled.");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function removeSkill() {
    if (!bundle) return;
    try {
      await api.deleteSkill(bundle.skill.id);
      s.setSelectedSkillId(null);
      setBundle(null);
      setDraft(null);
      await a.refreshSkills();
      s.pushToast("success", `Deleted ${bundle.skill.name}.`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Ask before throwing typed-but-unsaved work away: the SKILL.md fields and
   * the open resource's text live only in this component, so every move that
   * replaces them (another file, a new file, leaving the editor) is a silent
   * delete unless it stops to ask. `scope` is what the move actually discards. */
  async function confirmDiscard(scope: "resource" | "editor"): Promise<boolean> {
    const pending = scope === "resource" ? resourceDirty : resourceDirty || dirty;
    if (!pending) return true;
    const what = resourceDirty ? (resource?.path ?? "this file") : "SKILL.md";
    return await confirm(`Discard your unsaved changes to ${what}?`, {
      title: "Unsaved changes",
      kind: "warning",
    });
  }

  async function openResource(path: string) {
    if (!bundle) return;
    try {
      const next = await api.getSkillResource(bundle.skill.id, path);
      setResource(next);
      setResourceText(next.text ?? "");
      setResourceDirty(false);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** A folder row click. `openResource` itself stays silent — the save/add paths
   * re-open a file they have just written and must never prompt. */
  async function chooseResource(path: string) {
    if (resource?.path === path) return;
    if (!(await confirmDiscard("resource"))) return;
    await openResource(path);
  }

  /** The SKILL.md row: the main instructions, i.e. no resource open. */
  async function chooseMain() {
    if (!resource) return;
    if (!(await confirmDiscard("resource"))) return;
    setResource(null);
    setResourceText("");
    setResourceDirty(false);
  }

  /** Back to the skill list — the whole editor, drafts included, goes with it. */
  async function leaveEditor() {
    if (!(await confirmDiscard("editor"))) return;
    s.setSelectedSkillId(null);
    setDraft(null);
    setBundle(null);
    setResource(null);
    setResourceText("");
    setResourceDirty(false);
  }

  async function addResource() {
    if (!bundle || !newResourcePath.trim()) return;
    if (!(await confirmDiscard("resource"))) return;
    try {
      await api.saveSkillResource(bundle.skill.id, newResourcePath.trim(), { text: "" });
      const path = newResourcePath.trim();
      setNewResourcePath("");
      await load(bundle.skill.id);
      await openResource(path);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function saveResource() {
    if (!bundle || !resource || resource.text == null) return;
    try {
      await api.saveSkillResource(bundle.skill.id, resource.path, { text: resourceText });
      await load(bundle.skill.id);
      await openResource(resource.path);
      s.pushToast("success", `${resource.path} saved.`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function removeResource() {
    if (!bundle || !resource) return;
    // Unlike an ordinary room file this has no version history, so the click IS
    // the point of no return — and deleting the whole skill already asks.
    const ok = await confirm(
      `Remove ${resource.path} from ${bundle.skill.name}? Skill files have no version history, so this can't be undone.`,
      { title: "Remove file", kind: "warning" },
    );
    if (!ok) return;
    try {
      await api.deleteSkillResource(bundle.skill.id, resource.path);
      setResource(null);
      await load(bundle.skill.id);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  if (!draft) {
    return (
      <div className="skills-page">
        <div className="skills-hero">
          <span className="skills-hero-icon"><BookOpenIcon size={24} /></span>
          <div>
            <h1>Skills</h1>
            <p>
              Teach the assistant repeatable ways of working. Each skill is a portable folder:
              <code> SKILL.md</code>, plus optional <code>scripts/</code>, <code>references/</code>,
              <code>assets/</code>, and <code>agents/</code>. Enabled skills appear in chat when
              you type <code>/</code>.
            </p>
          </div>
        </div>

        <div className="skill-compose">
          <div className="skill-compose-title"><SparklesIcon size={16} /> Ask the skill builder</div>
          {composeSourceFiles.length > 0 && (
            <div className="skill-compose-source-chips" aria-label="Skill source files">
              {composeSourceFiles.map((file) => (
                <span key={file.id} className="skill-source-chip">
                  <FileTypeIcon file={file} size={13} />
                  <span title={file.name}>{displayName(file.name)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => toggleComposeSource(file.id)}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <div className="skill-compose-row">
            <textarea
              ref={composeRef}
              value={composeText}
              rows={1}
              placeholder="e.g. Review supplier contracts using our risk policy and always return a clause-by-clause table"
              onChange={(e) => setComposeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void compose();
                }
              }}
            />
            <button className="primary" disabled={composeBusy || !composeText.trim()} onClick={() => void compose()}>
              {composeBusy ? "Building…" : "Build with AI"}
            </button>
          </div>
          <div className="skill-compose-source-bar">
            <div className="skill-source-picker-wrap">
              <button
                type="button"
                className={`subtle btn-ic${sourcePickerOpen ? " active" : ""}`}
                onClick={() => setSourcePickerOpen((open) => !open)}
              >
                <PaperclipIcon size={13} />
                {composeSourceIds.length > 0
                  ? `${composeSourceIds.length} source${composeSourceIds.length === 1 ? "" : "s"}`
                  : "Add room files"}
              </button>
              {sourcePickerOpen && (
                <div className="skill-source-picker" role="dialog" aria-label="Choose source files">
                  <div className="skill-source-picker-head">
                    <strong>Build from room files</strong>
                    <button className="subtle" onClick={() => setSourcePickerOpen(false)}>Done</button>
                  </div>
                  <input
                    autoFocus
                    value={sourceFilter}
                    placeholder="Find a file…"
                    onChange={(event) => setSourceFilter(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setSourcePickerOpen(false);
                    }}
                  />
                  <div className="skill-source-list">
                    {filteredSourceFiles.length === 0 && (
                      <div className="skill-source-empty">
                        {s.files.length === 0 ? "No files in this room yet." : "No files match that search."}
                      </div>
                    )}
                    {filteredSourceFiles.map((file) => {
                      const checked = composeSourceIds.includes(file.id);
                      const disabled = !file.hasText || (!checked && composeSourceIds.length >= 12);
                      return (
                        <label key={file.id} className={`skill-source-option${disabled ? " disabled" : ""}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleComposeSource(file.id)}
                          />
                          <FileTypeIcon file={file} size={15} />
                          <span>
                            <strong title={file.name}>{displayName(file.name)}</strong>
                            <small>{file.hasText ? `${file.mimeType || "file"} · ${formatSize(file.sizeBytes)}` : "No readable text yet"}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <span>Selected files are copied into the draft as portable reference snapshots.</span>
          </div>
        </div>

        <div className="skills-toolbar">
          <span>{s.skills.length} skill{s.skills.length === 1 ? "" : "s"} in this room</span>
          <button className="subtle btn-ic" onClick={() => void importFolder()}><DownloadIcon size={13} /> Import folder</button>
          <button className="subtle btn-ic" onClick={startNew}><PlusIcon size={13} /> New skill</button>
        </div>

        {s.skills.length === 0 ? (
          <div className="skills-empty">
            <h3>No skills yet</h3>
            <p>Build one with AI, start manually, or import any Agent Skills-compatible folder.</p>
          </div>
        ) : (
          <div className="skills-grid">
            {s.skills.map((skill) => (
              <button key={skill.id} className="skill-card" onClick={() => a.openSkill(skill.id)}>
                <span className="skill-card-icon"><BookOpenIcon size={16} /></span>
                <span className="skill-card-main">
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                  <small>{skill.resourceCount} resource{skill.resourceCount === 1 ? "" : "s"} · {skill.createdBy}</small>
                </span>
                <span className={`skill-state ${skill.enabled ? "on" : "draft"}`}>{skill.enabled ? "Enabled" : "Draft"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="skills-page skill-editor-page">
      <div className="skill-editor-head">
        <button className="subtle" onClick={() => void leaveEditor()}>← All skills</button>
        <div className="skill-editor-actions">
          {bundle && <button className="subtle btn-ic" onClick={() => void exportFolder()}><FolderIcon size={13} /> Export folder</button>}
          <button className="primary btn-ic" disabled={!dirty || busy} onClick={() => void saveMetadata()}><SaveIcon size={13} /> {busy ? "Saving…" : "Save SKILL.md"}</button>
        </div>
      </div>

      <div className="skill-editor-layout">
        <div className="skill-main-editor">
          <div className="skill-status-row">
            <div>
              <span className="skill-kicker">{isNew ? "New skill" : selectedSummary?.createdBy === "agent" ? "AI-authored draft" : "Agent Skill"}</span>
              <h1>{draft.name || "Untitled skill"}</h1>
            </div>
            {bundle && (
              <label className="skill-enable" title="Only enabled skills are advertised to the assistant">
                <input type="checkbox" checked={bundle.skill.enabled} onChange={(e) => void toggleEnabled(e.target.checked)} />
                <span className="mkt-sw" />
                <span>{bundle.skill.enabled ? "Enabled" : "Disabled draft"}</span>
              </label>
            )}
          </div>

          <label className="skill-field">
            <span>Name <small>lowercase letters, numbers, hyphens</small></span>
            <input value={draft.name} placeholder="review-contracts" onChange={(e) => patchDraft("name", e.target.value)} />
          </label>
          <label className="skill-field">
            <span>Description <small>the trigger: what it does and when to use it</small></span>
            <textarea rows={3} value={draft.description} placeholder="Review commercial contracts for risk. Use when…" onChange={(e) => patchDraft("description", e.target.value)} />
          </label>
          {/* The owning specialist. It travels in SKILL.md frontmatter and was
              invisible here, so an imported skill bound to one agent looked
              identical to a general one and could only be corrected by
              hand-editing the folder and re-importing. The options come from
              the host's own roster, so this can never offer an id the save
              would reject. */}
          <label className="skill-field">
            <span>
              Offered to <small>which specialist may use this skill</small>
            </span>
            <select
              value={draft.agent}
              onChange={(e) => patchDraft("agent", e.target.value)}
            >
              <option value="">Every assistant (general)</option>
              {agentIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
              {/* A skill imported before this list existed can carry an owner
                  the roster no longer has. Show it rather than silently
                  re-labelling the skill as general on the next save. */}
              {draft.agent && !agentIds.includes(draft.agent) && (
                <option value={draft.agent}>
                  {draft.agent} (not a specialist this app has)
                </option>
              )}
            </select>
          </label>
          <label className="skill-field skill-instructions">
            <span>SKILL.md instructions <small>loaded only after this skill triggers</small></span>
            <textarea spellCheck={false} value={draft.instructions} onChange={(e) => patchDraft("instructions", e.target.value)} />
          </label>

          {bundle && (
            <div className="skill-danger">
              {confirmDelete ? (
                <span>Delete this skill and every bundled resource? <button className="danger" onClick={() => void removeSkill()}>Delete permanently</button> <button className="subtle" onClick={() => setConfirmDelete(false)}>Cancel</button></span>
              ) : (
                <button className="subtle btn-ic" onClick={() => setConfirmDelete(true)}><TrashIcon size={13} /> Delete skill</button>
              )}
            </div>
          )}
        </div>

        {bundle && (
          <aside className="skill-resources">
            <div className="skill-resources-head">
              <div><strong>Folder contents</strong><small>Encrypted inside this room</small></div>
            </div>
            {/* SKILL.md is the row that is selected when NO resource is open —
                keying its highlight off `resource.path` meant clicking it
                cleared the very value the highlight was read from. */}
            <button className={`skill-resource-row ${resource ? "" : "active"}`} onClick={() => void chooseMain()}>
              <BookOpenIcon size={14} /><span><strong>SKILL.md</strong><small>metadata + instructions</small></span>
            </button>
            {bundle.resources.map((r) => {
              const label = pathLabel(r.path);
              return (
                <button key={r.path} className={`skill-resource-row ${resource?.path === r.path ? "active" : ""}`} onClick={() => void chooseResource(r.path)}>
                  <FolderIcon size={14} />
                  <span><strong>{label.name}</strong><small>{label.folder} · {r.kind} · {formatSize(r.sizeBytes)}</small></span>
                </button>
              );
            })}
            <div className="skill-add-resource">
              <input value={newResourcePath} placeholder="references/policy.md" onChange={(e) => setNewResourcePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addResource(); }} />
              <button className="subtle" disabled={!newResourcePath.trim()} onClick={() => void addResource()}><PlusIcon size={12} /></button>
            </div>
            <p className="skill-folder-hint">Use <code>scripts/</code> for deterministic code, <code>references/</code> for on-demand knowledge, and <code>assets/</code> for output materials.</p>
          </aside>
        )}

        {bundle && resource && (
          <section className="skill-resource-editor">
            <div className="skill-resource-editor-head">
              <div><strong>{resource.path}</strong><small>{resource.kind}</small></div>
              <span>
                <button className="subtle btn-ic" onClick={() => void removeResource()}><TrashIcon size={12} /> Remove</button>
                {resource.text != null && <button className="primary btn-ic" disabled={!resourceDirty} onClick={() => void saveResource()}><SaveIcon size={12} /> Save</button>}
              </span>
            </div>
            {resource.text != null ? (
              <textarea spellCheck={false} value={resourceText} onChange={(e) => { setResourceText(e.target.value); setResourceDirty(true); }} />
            ) : (
              <div className="skill-binary-note">Binary asset. Export the folder to inspect it, or re-import the skill folder to replace it.</div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
