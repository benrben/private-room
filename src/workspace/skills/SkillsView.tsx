import { useEffect, useId, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatSize,
  RoomInfo,
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
import { WSActions } from "../actions";
import { useAdaptiveText } from "../adaptiveText";

type Props = { s: WSState; a: WSActions; info: RoomInfo };
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

/** What the host will actually store: `validate_skill_name` lowercases and
 * turns spaces and underscores into hyphens, so "Review Contracts" was saved
 * as `review-contracts` and the field only admitted it after a reload. It
 * TRIMS first, so a leading space is not a hyphen there and must not become
 * one here — that would refuse a name the host accepts. */
const normalizeSkillName = (value: string) =>
  value.toLowerCase().replace(/[ _]/g, "-").replace(/^-+/, "");

function pathLabel(path: string) {
  const parts = path.split("/");
  return { folder: parts.length > 1 ? parts.slice(0, -1).join("/") : "root", name: parts.at(-1) ?? path };
}

/* -------------------------------------------------------------- skill state
   A skill card has to be able to say what state it is in without the reader
   decoding a colour, so every flag is a marker MEANING plus a word:

     Enabled        green   done      the assistant can reach it
     Draft          yellow  pending   saved, but not offered to anyone yet
     Incomplete     red     urgent    a real fault, not a stage — a skill with
                                      no trigger sentence can never be chosen,
                                      so it is inert however enabled it looks
     Unknown owner  red     urgent    bound to a specialist this app does not
                                      have, which is the same silent inertness

   These are the four states the brief names, and each one is DERIVED from the
   data rather than invented: nothing here can light up for a condition the
   room cannot actually be in. */
type SkillFlag = { key: string; word: string; mark: string; why: string };

/** `instructions` is optional because the list only has SkillSummary, which
 * carries no body — the editor passes it and gets the fuller answer. */
function skillFlags(
  skill: { enabled: boolean; description: string; agent: string; instructions?: string },
  agentIds: string[],
): SkillFlag[] {
  const flags: SkillFlag[] = [
    skill.enabled
      ? {
          key: "on",
          word: "Enabled",
          mark: "nb-sem-done",
          why: "Its description is offered to the assistant, so it can choose this skill.",
        }
      : {
          key: "draft",
          word: "Draft",
          mark: "nb-sem-pending",
          why: "Saved in this room, but not offered to the assistant yet.",
        },
  ];
  if (!skill.description.trim() || (skill.instructions !== undefined && !skill.instructions.trim())) {
    flags.push({
      key: "incomplete",
      word: "Incomplete",
      mark: "nb-sem-urgent",
      why: "A skill needs a description to be chosen and instructions to follow. This one is missing at least one of them.",
    });
  }
  // Only once the roster has actually arrived — every skill would flag while
  // the list is still empty on first paint.
  if (skill.agent && agentIds.length > 0 && !agentIds.includes(skill.agent)) {
    flags.push({
      key: "owner",
      word: "Unknown owner",
      mark: "nb-sem-urgent",
      why: `Offered to "${skill.agent}", which is not a specialist this app has, so nothing can use it.`,
    });
  }
  return flags;
}

/* ---------------------------------------------------------- folder contents
   A skill is a real portable folder, and what is IN it is the interesting
   part — so the folder pane groups by what each file is for rather than
   listing a flat pile. Only the groups a skill actually has are drawn: four
   permanent empty slots would tell the reader a one-file skill is missing
   three things it was never supposed to have. */
const KIND_ORDER = ["reference", "script", "asset", "agent", "resource"] as const;
type ResKind = (typeof KIND_ORDER)[number];
const KIND_LABEL: Record<ResKind, string> = {
  reference: "References",
  script: "Scripts",
  asset: "Assets",
  agent: "Agents",
  resource: "Other files",
};
const KNOWN_KINDS = new Set<string>(KIND_ORDER);
/** Exhaustive on purpose: a kind the host adds later still renders, under
 * "Other files", instead of disappearing out of a pane that claims to be the
 * folder's contents. */
const kindOf = (r: SkillResourceMeta): ResKind =>
  KNOWN_KINDS.has(r.kind) ? (r.kind as ResKind) : "resource";

/** The empty state's worked example: one realistic skill folder drawn as an
 * index card.
 *
 * It must be impossible to mistake for something installed, so it carries
 * four independent signals — a dashed pencil border (the system's mark for a
 * provisional boundary), a tape label reading "Example", a caption that says
 * in words that it is not installed, and no interactive element at all, which
 * also puts it out of the tab order. */
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

export default function SkillsView({ s, a, info }: Props) {
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

  useEffect(() => {
    if (selected === shownId.current) return;
    const leaving = shownId.current;
    const wasSelfDeleted = selfDeleted.current;
    selfDeleted.current = false;
    // The open skill is no longer in the room: someone else deleted it, so
    // there is no "discard?" to ask — the answer was decided elsewhere. Say
    // so, and keep unsaved text on screen to be copied rather than dropping
    // the user back into the list mid-sentence.
    if (leaving !== null && selected === null && !s.skills.some((x) => x.id === leaving)) {
      shownId.current = null;
      if (wasSelfDeleted) return;
      const name = bundle?.skill.name ?? "That skill";
      if (dirtyRef.current || resourceDirtyRef.current) {
        setDeletedElsewhere(name);
        s.pushToast(
          "error",
          `${name} was deleted — your unsaved changes were not saved. Copy anything you still need.`,
        );
        return;
      }
      s.pushToast("info", `${name} was deleted.`);
      clearEditor();
      return;
    }
    // `leaving === null && isNew` is the unsaved NEW skill: putting the id
    // back is putting it back to null, which the early return above then
    // treats as "nothing changed" and the draft stays on screen.
    if ((leaving !== null || isNew) && (dirtyRef.current || resourceDirtyRef.current)) {
      let cancelled = false;
      void (async () => {
        const ok = await confirmDiscard("editor");
        if (cancelled) return;
        if (!ok) {
          s.setSelectedSkillId(leaving);
          return;
        }
        shownId.current = selected;
        if (selected) await load(selected);
        else clearEditor();
      })();
      return () => {
        cancelled = true;
      };
    }
    shownId.current = selected;
    if (selected) void load(selected);
    else if (!isNew) clearEditor();
    // `load` is intentionally keyed only by the selected id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  /* The room can write to the skill that is open: the assistant's `save_skill`
     / `write_skill_resource`, or another window. The editor used to show its
     pre-write state until something else reloaded it, so the Enabled toggle
     kept claiming a state the backend had already flipped. Only ever applied
     when nothing is typed-but-unsaved — a foreign write that lands mid-edit is
     caught by the save path instead, which asks before overwriting it. */
  useEffect(() => {
    const pending = api.onSkillsChanged(() => {
      const id = shownId.current;
      if (!id || dirtyRef.current || resourceDirtyRef.current) return;
      void (async () => {
        try {
          const next = await api.getSkill(id);
          // Anything the user did while this was in flight wins.
          if (shownId.current !== id || dirtyRef.current || resourceDirtyRef.current) return;
          setBundle(next);
          setDraft({
            name: next.skill.name,
            description: next.skill.description,
            instructions: next.skill.instructions,
            agent: next.skill.agent ?? "",
          });
          const open = resourceRef.current;
          if (!open) return;
          if (!next.resources.some((r) => r.path === open.path)) {
            setResource(null);
            setResourceText("");
            return;
          }
          const fresh = await api.getSkillResource(id, open.path);
          if (resourceDirtyRef.current || resourceRef.current?.path !== open.path) return;
          setResource(fresh);
          setResourceText(fresh.text ?? "");
        } catch {
          // Nobody asked for this refresh, so nobody is waiting on a toast for
          // it. The next thing the user does reports the room's failure.
        }
      })();
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
  const problems = useMemo(() => {
    if (!draft) return [];
    const list: string[] = [];
    const name = draft.name.trim();
    if (!name) {
      list.push("Give the skill a name.");
    } else if (
      name.length > 64 ||
      name.startsWith("-") ||
      name.endsWith("-") ||
      !/^[a-z0-9-]+$/.test(name)
    ) {
      list.push(
        "Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.",
      );
    }
    if (!draft.description.trim()) {
      list.push(
        "Describe what the skill does and when the assistant should use it.",
      );
    }
    return list;
  }, [draft]);

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

  /** True only when the draft is now stored. Callers that go on to do
   * something else with the skill (the Enabled switch) must not act on a save
   * that never landed. */
  async function saveMetadata(): Promise<boolean> {
    if (!draft || busy || deletedElsewhere) return false;
    setBusy(true);
    try {
      if (isNew) {
        const id = await api.createSkill(draft.name, draft.description, draft.instructions, draft.agent);
        await a.refreshSkills();
        s.setSelectedSkillId(id);
        s.pushToast("success", "Skill draft created — review it, then enable it.");
      } else if (bundle) {
        // The room may have written this skill since it was opened. Overwriting
        // that without a word is the loss this asks about.
        const stored = await api.getSkill(bundle.skill.id);
        const changedElsewhere =
          stored.skill.name !== bundle.skill.name ||
          stored.skill.description !== bundle.skill.description ||
          stored.skill.instructions !== bundle.skill.instructions ||
          stored.skill.agent !== bundle.skill.agent;
        if (
          changedElsewhere &&
          !(await confirm(
            `${bundle.skill.name} was changed outside this editor since you opened it. Save your version over it?`,
            { title: "Changed elsewhere", kind: "warning", okLabel: "Save mine" },
          ))
        ) {
          return false;
        }
        // The owner travels only when the user actually chose one. A skill
        // bound to a specialist this build no longer has would otherwise have
        // every save refused ("agent must be one of…") over a field the edit
        // never touched — `undefined` tells the host to leave the binding be.
        const owner = draft.agent === bundle.skill.agent ? undefined : draft.agent;
        await api.updateSkill(bundle.skill.id, draft.name, draft.description, draft.instructions, owner);
        await a.refreshSkills();
        await load(bundle.skill.id);
        s.pushToast("success", "SKILL.md saved.");
      }
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
    if (!bundle || deletedElsewhere) return;
    try {
      // The implicit save is not a courtesy — enabling advertises the skill to
      // the model. If it did not land, the version about to be advertised is
      // not the one on screen, so stop here and leave the switch and the draft
      // exactly as they are. `saveMetadata` has already said why.
      if (dirty && !(await saveMetadata())) return;
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

  async function saveResource() {
    if (!bundle || !resource || resource.text == null || deletedElsewhere) return;
    try {
      // `resource.text` is the copy this editor opened; `resourceText` is what
      // the user typed. A difference in the stored file is a write from
      // somewhere else, and it is not ours to drop.
      const stored = await api.getSkillResource(bundle.skill.id, resource.path);
      if (
        (stored.text ?? "") !== resource.text &&
        !(await confirm(
          `${resource.path} was changed outside this editor since you opened it. Save your version over it?`,
          { title: "Changed elsewhere", kind: "warning", okLabel: "Save mine" },
        ))
      ) {
        return;
      }
      await api.saveSkillResource(bundle.skill.id, resource.path, { text: resourceText });
      await reloadResources();
      await openResource(resource.path);
      s.pushToast("success", `${resource.path} saved.`);
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

  if (!draft) {
    return (
      <div className="sk-page">
        <div className="sk-inner">
          <header className="sk-masthead">
            <div className="sk-masthead-main">
              <span className="sk-masthead-ico" aria-hidden="true">
                <BookOpenIcon size={20} />
              </span>
              <div>
                <h1 className="sk-title">Skills</h1>
                <p className="sk-lead">
                  {skillDek ?? "Teach the assistant repeatable ways of working."}
                </p>
              </div>
            </div>
            <div className="sk-stamp">
              <span className="sk-stamp-count">
                {s.skills.length} skill{s.skills.length === 1 ? "" : "s"} in this room
              </span>
              {s.skills.length > 0 && (
                <span
                  className={`nb-tape sk-stamp-state ${enabledCount > 0 ? "nb-sem-done" : "nb-sem-pending"}`}
                >
                  {enabledCount > 0 ? `${enabledCount} enabled` : "None enabled yet"}
                </span>
              )}
            </div>
          </header>

          {/* The folder anatomy used to run on from the page's first sentence.
              It is technical detail, not a lead — so it moves into a
              disclosure, which keeps every word in the DOM and in the
              accessibility tree one keystroke away. Nothing is deleted. */}
          <details className="sk-note">
            <summary>What is inside a skill folder?</summary>
            <div className="sk-note-body">
              <p>
                Each skill is a portable folder: <code>SKILL.md</code>, plus optional{" "}
                <code>scripts/</code>, <code>references/</code>, <code>assets/</code>, and{" "}
                <code>agents/</code>. Enabled skills appear in chat when you type <code>/</code>.
              </p>
              <ul className="sk-note-list">
                <li>
                  <code>SKILL.md</code>
                  <span>the name, the trigger description, and the procedure itself</span>
                </li>
                <li>
                  <code>references/</code>
                  <span>knowledge read only once the skill fires</span>
                </li>
                <li>
                  <code>scripts/</code>
                  <span>deterministic code, run rather than guessed at</span>
                </li>
                <li>
                  <code>assets/</code>
                  <span>templates and materials the output is built from</span>
                </li>
                <li>
                  <code>agents/</code>
                  <span>sub-agents that travel with the skill</span>
                </li>
              </ul>
            </div>
          </details>

          <section className="sk-section">
            <div className="sk-compose">
              <p className="sk-compose-title">
                <SparklesIcon size={16} /> Ask the skill builder
              </p>
              {composeSourceFiles.length > 0 && (
                <div className="sk-source-chips" aria-label="Skill source files">
                  {composeSourceFiles.map((file) => (
                    <span key={file.id} className="sk-source-chip">
                      <FileTypeIcon file={file} size={14} />
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
              {/* Sits directly above the box it names. The builder's textarea
                  had a placeholder and no accessible name at all, so this is a
                  real <label> rather than a styled caption. */}
              <label className="sk-compose-label" htmlFor={composeId}>
                Describe what the skill should do, and when to use it
              </label>
              <div className="sk-compose-row">
                <textarea
                  id={composeId}
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
                <button
                  className="primary sk-compose-go"
                  disabled={composeBusy || !composeText.trim()}
                  onClick={() => void compose()}
                >
                  {composeBusy ? "Building…" : "Build with AI"}
                </button>
              </div>
              <div className="sk-source-bar">
                <div className="sk-source-wrap">
                  <button
                    type="button"
                    className={`subtle btn-ic${sourcePickerOpen ? " active" : ""}`}
                    aria-expanded={sourcePickerOpen}
                    onClick={() => setSourcePickerOpen((open) => !open)}
                  >
                    <PaperclipIcon size={14} />
                    {composeSourceIds.length > 0
                      ? `${composeSourceIds.length} source${composeSourceIds.length === 1 ? "" : "s"}`
                      : "Add room files"}
                  </button>
                  {sourcePickerOpen && (
                    /* Escape belongs to the SHEET, not to its filter field:
                       one Tab into the checkboxes and the key used to reach
                       the app-level handler instead and close the open file
                       behind the picker. Not a dialog — it is a non-modal
                       popover with real focusable content in DOM order after
                       its trigger, so `aria-expanded` plus a labelled section
                       is the honest description and no focus trap is owed. */
                    <section
                      className="sk-source-picker nb-float nb-float-draw"
                      aria-label="Choose source files"
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.stopPropagation();
                        setSourcePickerOpen(false);
                      }}
                    >
                      <div className="sk-source-picker-head">
                        <strong>Build from room files</strong>
                        <button className="subtle" onClick={() => setSourcePickerOpen(false)}>Done</button>
                      </div>
                      <input
                        autoFocus
                        value={sourceFilter}
                        placeholder="Find a file…"
                        onChange={(event) => setSourceFilter(event.target.value)}
                      />
                      <div className="sk-source-list">
                        {filteredSourceFiles.length === 0 && (
                          <div className="sk-source-empty">
                            {s.files.length === 0 ? "No files in this room yet." : "No files match that search."}
                          </div>
                        )}
                        {filteredSourceFiles.map((file) => {
                          const checked = composeSourceIds.includes(file.id);
                          const disabled = !file.hasText || (!checked && composeSourceIds.length >= 12);
                          return (
                            <label key={file.id} className={`sk-source-option${disabled ? " disabled" : ""}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggleComposeSource(file.id)}
                              />
                              <FileTypeIcon file={file} size={14} />
                              <span>
                                <strong title={file.name}>{displayName(file.name)}</strong>
                                <small>{file.hasText ? `${file.mimeType || "file"} · ${formatSize(file.sizeBytes)}` : "No readable text yet"}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </div>
                <span className="sk-source-hint">
                  Selected files are copied into the draft as portable reference snapshots.
                </span>
              </div>
            </div>
          </section>

          <section className="sk-section">
            <div className="sk-section-head">
              <h2>In this room</h2>
              <div className="sk-section-actions">
                <button className="subtle btn-ic" onClick={() => void importFolder()}><DownloadIcon size={14} /> Import folder</button>
                <button className="subtle btn-ic" onClick={startNew}><PlusIcon size={14} /> New skill</button>
              </div>
            </div>

            {s.skills.length === 0 ? (
              <div className="sk-empty">
                <div>
                  <h3 className="sk-empty-head">No skills yet</h3>
                  <p className="sk-empty-copy">
                    Build one with AI, start manually, or import any Agent Skills-compatible folder.
                  </p>
                </div>
                <ExampleSkill />
              </div>
            ) : (
              <div className="sk-grid nb-frame-set">
                {s.skills.map((skill) => (
                  <button
                    key={skill.id}
                    className="sk-card nb-card nb-lift"
                    onClick={() => a.openSkill(skill.id)}
                  >
                    <span className="sk-card-head">
                      <span className="sk-card-ico" aria-hidden="true"><FolderIcon size={16} /></span>
                      <span className="sk-card-name">{skill.name}</span>
                      <span className="sk-flags">
                        {skillFlags(skill, agentIds).map((f) => (
                          <span key={f.key} className={`nb-tape sk-flag ${f.mark}`} title={f.why}>
                            {f.word}
                          </span>
                        ))}
                      </span>
                    </span>
                    {/* A <span>, not a <p>: this sits inside a button, whose
                        content model is phrasing content only. */}
                    <span className="sk-card-desc">{skill.description}</span>
                    <span className="sk-card-foot">
                      <span className="sk-card-meta">
                        {skill.resourceCount} resource{skill.resourceCount === 1 ? "" : "s"} · {skill.createdBy}
                      </span>
                      {skill.agent && (
                        <span className="nb-chip sk-card-owner" title={`Offered to ${skill.agent}`}>
                          Offered to {skill.agent}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  const flags = skillFlags(
    { enabled: bundle?.skill.enabled ?? false, description: draft.description, agent: draft.agent, instructions: draft.instructions },
    agentIds,
  );
  if (deletedElsewhere) {
    flags.push({
      key: "deleted",
      word: "Deleted elsewhere",
      mark: "nb-sem-urgent",
      why: `${deletedElsewhere} was deleted from this room, so nothing here can be saved. Copy anything you still need, then go back to the list.`,
    });
  }

  return (
    <div className="sk-editor">
      <div className="sk-editor-head">
        <button className="subtle" onClick={() => void leaveEditor()}>← All skills</button>
        <div className="sk-editor-actions">
          {bundle && <button className="subtle btn-ic" onClick={() => void exportFolder()}><FolderIcon size={14} /> Export folder</button>}
          <button className="primary btn-ic" disabled={!dirty || busy || deletedElsewhere !== null || problems.length > 0} title={problems[0]} onClick={() => void saveMetadata()}><SaveIcon size={14} /> {busy ? "Saving…" : "Save SKILL.md"}</button>
        </div>
      </div>

      <div className="sk-editor-layout">
        <div className="sk-main">
          <div className="sk-head-row">
            <div>
              <span className="sk-kicker">{isNew ? "New skill" : selectedSummary?.createdBy === "agent" ? "AI-authored draft" : "Agent Skill"}</span>
              <h1 className="sk-editor-title">{draft.name || "Untitled skill"}</h1>
              {/* The same four states the card shows, so a skill does not
                  change its story when you open it. A new skill has nothing
                  saved yet, so it says nothing rather than claiming to be a
                  draft the room is holding. */}
              {bundle && (
                <span className="sk-flags">
                  {flags.map((f) => (
                    <span key={f.key} className={`nb-tape sk-flag ${f.mark}`} title={f.why}>
                      {f.word}
                    </span>
                  ))}
                </span>
              )}
            </div>
            {bundle && (
              <label className="sk-enable" title="Only enabled skills are advertised to the assistant">
                <input type="checkbox" checked={bundle.skill.enabled} disabled={deletedElsewhere !== null} onChange={(e) => void toggleEnabled(e.target.checked)} />
                <span className="mkt-sw" />
                <span>{bundle.skill.enabled ? "Enabled" : "Disabled draft"}</span>
              </label>
            )}
          </div>

          {/* Only once something has been typed: an untouched new form is not
              yet a fault, and spending the urgent marker on it is how a reader
              learns to look past it. */}
          {dirty && problems.length > 0 && (
            <div className="wf-errors">
              Fix these before saving:
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          <label className="sk-field">
            <span>Name <small>lowercase letters, numbers, hyphens</small></span>
            <input value={draft.name} placeholder="review-contracts" onChange={(e) => patchDraft("name", normalizeSkillName(e.target.value))} />
          </label>
          <label className="sk-field">
            <span>Description <small>the trigger: what it does and when to use it</small></span>
            <textarea rows={3} value={draft.description} placeholder="Review commercial contracts for risk. Use when…" onChange={(e) => patchDraft("description", e.target.value)} />
          </label>
          {/* The owning specialist. It travels in SKILL.md frontmatter and was
              invisible here, so an imported skill bound to one agent looked
              identical to a general one and could only be corrected by
              hand-editing the folder and re-importing. The options come from
              the host's own roster, so this can never offer an id the save
              would reject. */}
          <label className="sk-field">
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
          <label className="sk-field sk-instructions">
            <span>SKILL.md instructions <small>loaded only after this skill triggers</small></span>
            <textarea spellCheck={false} value={draft.instructions} onChange={(e) => patchDraft("instructions", e.target.value)} />
          </label>

          {bundle && (
            <div className="sk-danger">
              {confirmDelete ? (
                <span>Delete this skill and every bundled resource? <button className="danger" onClick={() => void removeSkill()}>Delete permanently</button> <button className="subtle" onClick={() => setConfirmDelete(false)}>Cancel</button></span>
              ) : (
                <button className="subtle btn-ic danger" onClick={() => setConfirmDelete(true)}><TrashIcon size={14} /> Delete skill</button>
              )}
            </div>
          )}
        </div>

        {bundle && (
          <aside className="sk-res">
            <div className="sk-res-head">
              <strong>Folder contents</strong>
              <small>Encrypted inside this room</small>
            </div>
            {/* SKILL.md is the row that is selected when NO resource is open —
                keying its highlight off `resource.path` meant clicking it
                cleared the very value the highlight was read from. */}
            <button className={`sk-res-row ${resource ? "" : "active"}`} onClick={() => void chooseMain()}>
              <BookOpenIcon size={14} /><span><strong>SKILL.md</strong><small>metadata + instructions</small></span>
            </button>
            {/* Grouped by what each file is FOR. Only the groups this skill
                actually has are drawn. */}
            {KIND_ORDER.filter((kind) => bundle.resources.some((r) => kindOf(r) === kind)).map((kind) => {
              const rows = bundle.resources.filter((r) => kindOf(r) === kind);
              return (
                <div key={kind} className="sk-res-group">
                  <div className="sk-res-group-head">
                    <span>{KIND_LABEL[kind]}</span>
                    {/* Not aria-hidden: "References 3" is information, and a
                        count is exactly what the hand-drawn ring is for. */}
                    <span className="nb-circled">{rows.length}</span>
                  </div>
                  {rows.map((r) => {
                    const label = pathLabel(r.path);
                    return (
                      <button key={r.path} className={`sk-res-row ${resource?.path === r.path ? "active" : ""}`} onClick={() => void chooseResource(r.path)}>
                        <FolderIcon size={14} />
                        <span><strong>{label.name}</strong><small>{label.folder} · {r.kind} · {formatSize(r.sizeBytes)}</small></span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <div className="sk-res-add">
              <input value={newResourcePath} placeholder="references/policy.md" aria-label="New file path" onChange={(e) => setNewResourcePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addResource(); }} />
              <button className="subtle" disabled={!newResourcePath.trim() || deletedElsewhere !== null} title="Add this file" aria-label="Add this file" onClick={() => void addResource()}><PlusIcon size={12} /></button>
            </div>
            {/* Kept, not deleted: the convention this folder follows is real
                guidance, it is simply not what the pane is FOR. */}
            <details className="sk-res-note">
              <summary>Which folder does what?</summary>
              <div className="sk-note-body">
                <p>Use <code>scripts/</code> for deterministic code, <code>references/</code> for on-demand knowledge, and <code>assets/</code> for output materials.</p>
              </div>
            </details>
          </aside>
        )}

        {bundle && resource && (
          <section className="sk-file">
            <div className="sk-file-head">
              <div><strong>{resource.path}</strong><small>{resource.kind}</small></div>
              <span>
                <button className="subtle btn-ic danger" disabled={deletedElsewhere !== null} onClick={() => void removeResource()}><TrashIcon size={12} /> Remove</button>
                {resource.text != null && <button className="primary btn-ic" disabled={!resourceDirty || deletedElsewhere !== null} onClick={() => void saveResource()}><SaveIcon size={12} /> Save</button>}
              </span>
            </div>
            {resource.text != null ? (
              // Deliberately no dir="auto": this buffer can hold a script, and
              // a file whose first strong character is Hebrew would flip the
              // whole listing to RTL and reorder how the code READS without
              // changing a byte of it. The editor shows the file exactly as the
              // previous one did.
              <textarea
                spellCheck={false}
                aria-label={`${resource.path} contents`}
                value={resourceText}
                onChange={(e) => { setResourceText(e.target.value); setResourceDirty(true); }}
              />
            ) : (
              <div className="sk-binary-note">Binary asset. Export the folder to inspect it, or re-import the skill folder to replace it.</div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
