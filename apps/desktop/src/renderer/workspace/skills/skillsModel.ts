import { useEffect, useId, useMemo, useRef, useState } from "react";
import { confirm } from "../../platform";
import { api, type RoomInfo, type SkillBundle, type SkillResourceContent } from "../../api";
import type { WSState } from "../state";
import type { WSActions } from "../actions";
import { useAdaptiveText } from "../adaptiveText";
import { STARTER, type SkillDraft, skillProblems } from "./skillsPolicy";
export type SkillsModelProps = { s: WSState; a: WSActions; info: RoomInfo };
export function useSkillsModel({ s, a, info }: SkillsModelProps) {
  const [bundle, setBundle] = useState<SkillBundle | null>(null);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeSourceIds, setComposeSourceIds] = useState<string[]>([]);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [resource, setResourceState] = useState<SkillResourceContent | null>(null);
  const [resourceText, setResourceText] = useState("");
  const [resourceDirty, setResourceDirtyState] = useState(false);
  const [newResourcePath, setNewResourcePath] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The skill on screen vanished from the room while it was being edited
   * (the assistant's `delete_skill`, another window). Its name, so the editor
   * can say what happened instead of unmounting mid-sentence. */
  const [deletedElsewhere, setDeletedElsewhere] = useState<string | null>(null);
  // The host's roster of valid owners — asked for, never written down here, so
  // the picker can only offer ids the save would accept.
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  // The builder's box had a placeholder and no accessible name at all; this
  // ties a real visible label to it.
  const composeId = useId();
  /* Two readers run OUTSIDE the render that last set this state — the room's
     `skills-changed` listener and the selection guard — and both decide
     whether typed work is about to be thrown away. State they read a frame
     late is a lost keystroke, so every setter below writes its mirror ref
     synchronously and the readers use the ref. */
  const dirtyRef = useRef(false);
  const resourceDirtyRef = useRef(false);
  const resourceRef = useRef<SkillResourceContent | null>(null);
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  const setResourceDirty = (v: boolean) => {
    resourceDirtyRef.current = v;
    setResourceDirtyState(v);
  };
  const setResource = (v: SkillResourceContent | null) => {
    resourceRef.current = v;
    setResourceState(v);
  };
  /** Which skill this editor is actually showing. `selectedSkillId` is changed
   * from outside (the sidebar rows, the cards, `refreshSkills` when a skill
   * disappears), so the guard has to sit on the CHANGE, not on a button. */
  const shownId = useRef<string | null>(null);
  /** This editor's own Delete, so the guard does not report it as someone
   * else's. */
  const selfDeleted = useRef(false);
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
      setDeletedElsewhere(null);
      setResource(null);
      setResourceText("");
      setResourceDirty(false);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }
  /** Everything the editor holds, dropped. Also clears the dirty flags: they
   * belong to the draft that is going away, and a stale one would make the
   * next selection change ask about work that no longer exists. */
  function clearEditor() {
    setBundle(null);
    setDraft(null);
    setDirty(false);
    setDeletedElsewhere(null);
    setResource(null);
    setResourceText("");
    setResourceDirty(false);
  }
  function hasUnsavedChanges(): boolean {
    return dirtyRef.current || resourceDirtyRef.current;
  }
  function skillWasDeleted(leaving: string | null): boolean {
    return leaving !== null && selected === null && !s.skills.some((skill) => skill.id === leaving);
  }
  function handleDeletedSelection(leaving: string | null, wasSelfDeleted: boolean): boolean {
    if (!skillWasDeleted(leaving)) return false;
    shownId.current = null;
    if (wasSelfDeleted) return true;
    const name = bundle?.skill.name ?? "That skill";
    if (hasUnsavedChanges()) {
      setDeletedElsewhere(name);
      s.pushToast("error", `${name} was deleted — your unsaved changes were not saved. Copy anything you still need.`);
      return true;
    }
    s.pushToast("info", `${name} was deleted.`);
    clearEditor();
    return true;
  }
  function selectionNeedsDiscard(leaving: string | null): boolean {
    return (leaving !== null || isNew) && hasUnsavedChanges();
  }
  async function applySelection(next: string | null) {
    shownId.current = next;
    if (next) await load(next);
    else if (!isNew) clearEditor();
  }
  function confirmSelectionChange(leaving: string | null) {
    let cancelled = false;
    void (async () => {
      const ok = await confirmDiscard("editor");
      if (cancelled) return;
      if (!ok) {
        s.setSelectedSkillId(leaving);
        return;
      }
      await applySelection(selected);
    })();
    return () => {
      cancelled = true;
    };
  }
  useEffect(() => {
    if (selected === shownId.current) return;
    const leaving = shownId.current;
    const wasSelfDeleted = selfDeleted.current;
    selfDeleted.current = false;
    if (handleDeletedSelection(leaving, wasSelfDeleted)) return;
    if (selectionNeedsDiscard(leaving)) return confirmSelectionChange(leaving);
    void applySelection(selected);
    // `load` is intentionally keyed only by the selected id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  /* The room can write to the skill that is open: the assistant's `save_skill`
     / `write_skill_resource`, or another window. The editor used to show its
     pre-write state until something else reloaded it, so the Enabled toggle
     kept claiming a state the backend had already flipped. Only ever applied
     when nothing is typed-but-unsaved — a foreign write that lands mid-edit is
     caught by the save path instead, which asks before overwriting it. */
  function mayRefreshSkill(id: string): boolean {
    return shownId.current === id && !dirtyRef.current && !resourceDirtyRef.current;
  }
  async function refreshOpenResource(id: string, next: SkillBundle) {
    const open = resourceRef.current;
    if (!open) return;
    if (!next.resources.some((resource) => resource.path === open.path)) {
      setResource(null);
      setResourceText("");
      return;
    }
    const fresh = await api.getSkillResource(id, open.path);
    if (resourceDirtyRef.current || resourceRef.current?.path !== open.path) return;
    setResource(fresh);
    setResourceText(fresh.text ?? "");
  }
  async function refreshOpenSkill(id: string) {
    try {
      const next = await api.getSkill(id);
      if (!mayRefreshSkill(id)) return;
      setBundle(next);
      setDraft({ name: next.skill.name, description: next.skill.description, instructions: next.skill.instructions, agent: next.skill.agent ?? "" });
      await refreshOpenResource(id, next);
    } catch {
      // Nobody asked for this refresh, so nobody is waiting on a toast for it.
    }
  }
  useEffect(() => {
    const pending = api.onSkillsChanged(() => {
      const id = shownId.current;
      if (!id || !mayRefreshSkill(id)) return;
      void refreshOpenSkill(id);
    });
    return () => {
      void pending.then((un) => un()).catch(() => {});
    };
    // Reads only refs and setters, so it never needs rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const enabledCount = useMemo(() => s.skills.filter((x) => x.enabled).length, [s.skills]);
  // A1 "living dek": the sk-lead line below always renders first (RULE 1/3/8)
  // — this only replaces it once there's a genuine fact to ground a sentence
  // in. Facts are exactly what the stamp beside the title already shows
  // (count, enabled count) plus the most recently added skill's name — read
  // off the same `s.skills` list, nothing fetched fresh (RULE 4/10). Gated on
  // 2+ skills: one skill is better introduced by its own card than summarized.
  const newestSkill = useMemo(
    () =>
      s.skills.length > 0
        ? s.skills.reduce((latest, x) => (x.createdAt.localeCompare(latest.createdAt) > 0 ? x : latest))
        : null,
    [s.skills],
  );
  const skillDekFacts =
    s.skills.length >= 2
      ? {
          total: s.skills.length,
          enabledCount,
          newestName: newestSkill?.name ?? null,
        }
      : null;
  const skillDek = useAdaptiveText({
    roomId: info.path,
    kind: "dek",
    prompt: skillDekFacts
      ? `Write one plain sentence, max 20 words, describing this room's saved skills. Use ONLY these facts: ${JSON.stringify(skillDekFacts)}. Match this voice: plain, direct (existing example: "Teach the assistant repeatable ways of working."). No preamble, just the sentence.`
      : "",
    facts: skillDekFacts,
    maxWords: 20,
    enabled: skillDekFacts !== null,
  });
  const composeSourceFiles = useMemo(
    () => composeSourceIds.flatMap((id) => s.files.find((file) => file.id === id) ?? []),
    [composeSourceIds, s.files],
  );
  const filteredSourceFiles = useMemo(() => {
    const query = sourceFilter.trim().toLowerCase();
    return s.files.filter((file) => !query || file.name.toLowerCase().includes(query));
  }, [s.files, sourceFilter]);
  /* Inline, beside the fields — the first save of the first skill is the one
     most likely to fail, and it failed into a toast that named a rule without
     pointing at anything. Mirrors `validate_skill_name` /
     `validate_skill_fields`, so Save is refused here for exactly what the host
     would refuse there. */
  const problems = useMemo(() => skillProblems(draft), [draft]);
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
    // What is on screen from here is the NEW draft, so the selection guard has
    // nothing to ask about: this replaces the editor's contents itself, and a
    // prompt raised afterwards would be about work that is already gone — and
    // discarding it would take the new draft with it.
    shownId.current = null;
    s.setSelectedSkillId(null);
    setBundle(null);
    setDraft({ name: "", description: "", instructions: STARTER, agent: "" });
    setIsNew(true);
    // Nothing has been typed yet, so leaving must not raise the discard dialog
    // — the same dialog that guards real work. `patchDraft` raises it on the
    // first real edit, and `problems` is what keeps Save honest on an empty form.
    setDirty(false);
    setResource(null);
    setConfirmDelete(false);
  }
  function patchDraft<K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setDirty(true);
  }
  async function saveNewSkill(current: SkillDraft) {
    const id = await api.createSkill(current.name, current.description, current.instructions, current.agent);
    await a.refreshSkills();
    s.setSelectedSkillId(id);
    s.pushToast("success", "Skill draft created — review it, then enable it.");
  }
  function metadataChanged(stored: SkillBundle, current: SkillBundle): boolean {
    return stored.skill.name !== current.skill.name || stored.skill.description !== current.skill.description || stored.skill.instructions !== current.skill.instructions || stored.skill.agent !== current.skill.agent;
  }
  async function confirmMetadataOverwrite(current: SkillBundle): Promise<boolean> {
    const stored = await api.getSkill(current.skill.id);
    if (!metadataChanged(stored, current)) return true;
    return await confirm(`${current.skill.name} was changed outside this editor since you opened it. Save your version over it?`, { title: "Changed elsewhere", kind: "warning", okLabel: "Save mine" });
  }
  async function saveExistingSkill(current: SkillDraft): Promise<boolean> {
    if (!bundle) return true;
    if (!(await confirmMetadataOverwrite(bundle))) return false;
    const owner = current.agent === bundle.skill.agent ? undefined : current.agent;
    await api.updateSkill(bundle.skill.id, current.name, current.description, current.instructions, owner);
    await a.refreshSkills();
    await load(bundle.skill.id);
    s.pushToast("success", "SKILL.md saved.");
    return true;
  }
  function canSaveMetadata(): boolean {
    return draft !== null && !busy && !deletedElsewhere;
  }
  async function saveDraft(current: SkillDraft): Promise<boolean> {
    if (!isNew) return await saveExistingSkill(current);
    await saveNewSkill(current);
    return true;
  }
  /** True only when the draft is now stored. Callers that go on to do
   * something else with the skill (the Enabled switch) must not act on a save
   * that never landed. */
  async function saveMetadata(): Promise<boolean> {
    if (!canSaveMetadata() || !draft) return false;
    setBusy(true);
    try {
      const saved = await saveDraft(draft);
      if (!saved) return false;
      setDirty(false);
      return true;
    } catch (e) {
      s.pushToast("error", String(e));
      return false;
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
  function selectedPath(picked: string | string[] | null): string | undefined {
    return Array.isArray(picked) ? picked[0] : picked ?? undefined;
  }
  async function importReplacement(path: string): Promise<{ clash: string | null; replace: boolean } | null> {
    const clash = await api.skillImportConflict(path);
    if (!clash) return { clash, replace: false };
    const replace = await confirm(`This room already has a skill called "${clash}". Replace it with this folder? Its SKILL.md and files are overwritten, and any file not in the folder is removed. Its enabled setting is kept.`, { title: "Replace this skill?", kind: "warning", okLabel: "Replace" });
    return replace ? { clash, replace } : null;
  }
  async function importFolder() {
    const picked = await api.chooseOpenPath({ directory: true, multiple: false, title: "Choose a skill folder" });
    const path = selectedPath(picked);
    if (!path) return;
    try {
      const choice = await importReplacement(path);
      if (!choice) return;
      const id = await api.importSkillFolder(path, choice.replace);
      await a.refreshSkills();
      s.setSelectedSkillId(id);
      s.pushToast("success", choice.replace ? `Replaced ${choice.clash} with the imported folder.` : "Skill imported as a disabled draft for review.");
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
  async function saveBeforeToggle(): Promise<boolean> {
    return !dirty || await saveMetadata();
  }
  async function toggleEnabled(on: boolean) {
    if (!bundle || deletedElsewhere) return;
    try {
      if (!(await saveBeforeToggle())) return;
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
      // Ours: the guard must not report this back to us as someone else's.
      selfDeleted.current = true;
      s.setSelectedSkillId(null);
      clearEditor();
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
  /** Back to the skill list — the whole editor, drafts included, goes with it.
   * A skill deleted under us has nothing left to save, and the toast already
   * said so, so that case leaves without a second question. */
  async function leaveEditor() {
    if (!deletedElsewhere && !(await confirmDiscard("editor"))) return;
    s.setSelectedSkillId(null);
    clearEditor();
  }
  /** Re-read the folder listing, and nothing else. `load` also replaces the
   * SKILL.md draft with the stored values — which silently threw away typed
   * instructions every time a file was saved, added or removed. */
  async function reloadResources() {
    if (!bundle) return;
    try {
      const next = await api.getSkill(bundle.skill.id);
      // The LISTING only. `bundle.skill` is the copy the SKILL.md save compares
      // the stored one against, so taking the fresh `skill` here would quietly
      // adopt a write from elsewhere as "what I opened" — and the next Save
      // would find nothing to warn about and overwrite it.
      setBundle((b) => (b ? { ...b, resources: next.resources } : b));
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }
  async function addResource() {
    if (!bundle || !newResourcePath.trim() || deletedElsewhere) return;
    if (!(await confirmDiscard("resource"))) return;
    try {
      await api.saveSkillResource(bundle.skill.id, newResourcePath.trim(), { text: "" });
      const path = newResourcePath.trim();
      setNewResourcePath("");
      await reloadResources();
      await openResource(path);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }
  function editableResource(): { bundle: SkillBundle; resource: SkillResourceContent } | null {
    if (!bundle || !resource || resource.text == null || deletedElsewhere) return null;
    return { bundle, resource };
  }
  async function confirmResourceOverwrite(current: SkillResourceContent, skill: SkillBundle): Promise<boolean> {
    const stored = await api.getSkillResource(skill.skill.id, current.path);
    if ((stored.text ?? "") === current.text) return true;
    return await confirm(`${current.path} was changed outside this editor since you opened it. Save your version over it?`, { title: "Changed elsewhere", kind: "warning", okLabel: "Save mine" });
  }
  async function saveResource() {
    const target = editableResource();
    if (!target) return;
    try {
      if (!(await confirmResourceOverwrite(target.resource, target.bundle))) return;
      await api.saveSkillResource(target.bundle.skill.id, target.resource.path, { text: resourceText });
      await reloadResources();
      await openResource(target.resource.path);
      s.pushToast("success", `${target.resource.path} saved.`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }
  async function removeResource() {
    if (!bundle || !resource || deletedElsewhere) return;
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
      setResourceText("");
      setResourceDirty(false);
      await reloadResources();
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }
  return {
    s,
    a,
    info,
    bundle,
    draft,
    isNew,
    dirty,
    busy,
    composeText,
    composeBusy,
    composeSourceIds,
    sourcePickerOpen,
    sourceFilter,
    resource,
    resourceText,
    resourceDirty,
    newResourcePath,
    confirmDelete,
    deletedElsewhere,
    agentIds,
    composeRef,
    composeId,
    selectedSummary,
    enabledCount,
    skillDek,
    composeSourceFiles,
    filteredSourceFiles,
    problems,
    setComposeText,
    setSourcePickerOpen,
    setSourceFilter,
    setNewResourcePath,
    setConfirmDelete,
    setResourceText,
    setResourceDirty,
    toggleComposeSource,
    startNew,
    patchDraft,
    saveMetadata,
    compose,
    importFolder,
    exportFolder,
    toggleEnabled,
    removeSkill,
    chooseResource,
    chooseMain,
    addResource,
    removeResource,
    saveResource,
    leaveEditor,
  };
}
export type SkillsModel = ReturnType<typeof useSkillsModel>;
