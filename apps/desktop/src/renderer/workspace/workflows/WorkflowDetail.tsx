import { useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "../../platform";
import {
  api,
  Schedule,
  WorkflowDef,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
} from "../../api";
import { addNodeAfter, addParallelNode, defaultEmoji, extsOf, formIsDirty, isFileScopedBinding, isValidWorkflow, parseExts, runBlockReason, runningJobIdOf, savedFormKey, selectedNodeOf, workflowForm, type Props } from "./workflowDetailModel";
import { WorkflowHeader } from "./WorkflowDetailActions";
import { WorkflowDetailBody } from "./WorkflowDetailEditor";

export function WorkflowDetail({ s, a, workflow }: Props) {
  const initial = workflowForm(workflow);
  const [def, setDef] = useState<WorkflowDef>(initial.def);
  const [name, setName] = useState(initial.name);
  const [emoji, setEmoji] = useState(initial.emoji);
  const [binding, setBinding] = useState(initial.binding);
  // Raw text mirror of binding.exts so trailing commas survive as the user types.
  const [extsText, setExtsText] = useState(() => extsOf(workflow.binding));
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  /** True while the backend validator is deciding — see the effect below. */
  const [checking, setChecking] = useState(true);
  // Dirty = the form actually differs from the saved workflow, so toggling a
  // value back to its original (e.g. Script mode Import→Pipe→Import) clears Save.
  const dirty = useMemo(
    () => formIsDirty({ name, emoji, def, binding }, workflow),
    [name, emoji, def, binding, workflow],
  );
  // The saved form itself — NOT its timestamp. Pin/Unpin/Deactivate bump
  // `updatedAt` without touching a single edited field, and re-seeding on the
  // timestamp threw away whatever was in the editor (those buttons sit right
  // next to Save). Keyed on the content, they no longer disturb the form, while
  // a real save or an outside edit still re-seeds it.
  const savedForm = useMemo(() => savedFormKey(workflow), [workflow]);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const stepHeadRef = useRef<HTMLHeadingElement>(null);

  // Selecting a step opens the inspector BELOW the canvas, which on a pipeline
  // of more than a few steps is below the fold — the node took an outline and
  // the panel that answered the click was off-screen. `nearest` moves nothing
  // when it is already visible.
  useEffect(() => {
    if (selected) stepHeadRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Re-seed from the store when the selected workflow, or its saved form,
  // changes.
  useEffect(() => {
    setDef(workflow.definition);
    setName(workflow.name);
    setEmoji(defaultEmoji(workflow.emoji));
    setBinding(workflow.binding);
    setExtsText(extsOf(workflow.binding));
    /* dirty is derived from a diff */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.id, savedForm]);

  // Load schedule + run history; refresh when the workflows list changes (a run
  // finishing emits workflows-changed → the list refreshes → we re-fetch).
  useEffect(() => {
    let live = true;
    api
      .getWorkflowSchedule(workflow.id)
      .then((v) => live && setSchedule(v))
      .catch(() => {});
    api
      .getWorkflowRuns(workflow.id)
      .then((v) => live && setRuns(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workflow.id, s.workflows]);

  // Validate on every edit (single source of truth — the backend validator).
  //
  // `checking` exists because "no errors yet" and "no errors" are not the same
  // thing. `errors` starts empty and the validator is async, so a brand-new draft
  // — zero nodes, the least valid workflow there is — rendered with Activate
  // ENABLED until the first result landed, and the same stale-empty window
  // reopened after every edit. Live QA 2026-08-03 activated an empty workflow
  // through it. Unknown is not valid; it just isn't known to be invalid yet.
  useEffect(() => {
    let live = true;
    setChecking(true);
    api
      .validateWorkflow(def, binding)
      .then((e) => {
        if (!live) return;
        setErrors(e);
        setChecking(false);
      })
      .catch((e) => {
        if (!live) return;
        // A validator we couldn't reach must not read as a clean bill of health.
        setErrors([`Couldn't check this workflow: ${String(e)}`]);
        setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [def, binding]);

  const selectedNode = selectedNodeOf(def, selected);
  const runningJobId = runningJobIdOf(runs);
  const liveStatus = runningJobId ? s.wfNodeStatus[runningJobId] : undefined;
  const isFileScoped = isFileScopedBinding(binding);
  const valid = isValidWorkflow(checking, errors);
  const isDraft = workflow.status === "draft";
  /** Why Run now cannot fire, in the words shown on the button — or null.
   *
   * A draft has never been refused by the backend: `start_workflow_run` does
   * not look at status, and the loop after "Compose with AI" is read → try →
   * fix. What IS refused is a run with no input file, which is every workflow
   * bound to a chosen file — the sentence below is the one the scheduler
   * already gives for the same rule. An active workflow keeps running from its
   * SAVED definition, so unsaved edits do not block it.
   *
   * A draft's test run is the one place that would MISLEAD: the whole point is
   * edit → try → fix, and the run reads the stored definition, so an unsaved
   * edit would be tested by running the version without it. Say so rather than
   * run the wrong thing — Save is enabled in exactly this state. */
  const runBlocked = runBlockReason({
    checking,
    dirty,
    errors,
    fileScoped: isFileScoped,
    isDraft,
  });

  function updateNode(n: WorkflowNode) {
    setDef((d) => ({
      ...d,
      nodes: d.nodes.map((x) => (x.id === n.id ? n : x)),
    }));
    /* dirty is derived from a diff */
  }
  function deleteNode(id: string) {
    setDef((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    setSelected(null);
    /* dirty is derived from a diff */
  }
  function updateEdges(edges: WorkflowEdge[]) {
    setDef((d) => ({ ...d, edges }));
    /* dirty is derived from a diff */
  }
  /** Add a step. With `afterId`, splice it in right after that node — rewiring
   * that node's successors through the new step. A condition/route picks ONE
   * path, so rewiring all of its outcomes through a single plain step would
   * silently un-branch it: there the new step is spliced into the FIRST outcome
   * only, leaving the others wired as they were. Without `afterId`, append at
   * the tail. */
  function addNode(afterId?: string | null) {
    setDef((current) => addNodeAfter(current, afterId));
    /* dirty is derived from a diff */
  }
  /** Add a PARALLEL branch: a new step wired from `afterId` WITHOUT rewiring its
   * existing successors, so `afterId` now fans out to two children (the engine
   * runs independent branches concurrently on the cloud/CPU lanes). Off a
   * condition/route the new edge takes the next free outcome label instead. */
  function addBranchNode(afterId: string) {
    setDef((current) => addParallelNode(current, afterId));
    /* dirty is derived from a diff */
  }

  async function save() {
    await a.saveWorkflowEdits(workflow.id, {
      name,
      emoji,
      definition: def,
      binding,
    });
    /* dirty is derived from a diff */
  }
  /** Activate = save, THEN flip the status — and only if the save landed.
   *
   * `saveWorkflowEdits` reports a failure as a toast and resolves anyway, so
   * awaiting it told us nothing: a failed save still flipped the workflow to
   * active, which then ran the PREVIOUS stored definition while the editor on
   * screen showed the edits the user believed they had just activated. The
   * save runs here rather than through the action for exactly that reason —
   * the failure has to reach this function. */
  async function saveAndActivate() {
    try {
      await api.updateWorkflow({
        id: workflow.id,
        name,
        emoji,
        definition: def,
        binding,
      });
    } catch (e) {
      s.pushToast("error", String(e));
      return;
    }
    // The save landed, so the list has to say so BEFORE the status flip is
    // attempted: `setWorkflowStatus` swallows its own failure, and if it fails
    // nothing else would refresh — the form would keep reporting edits that are
    // already stored, and leaving the pane would raise the unsaved-work prompt
    // over nothing. This is the refresh `saveWorkflowEdits` used to do.
    await a.refreshWorkflows();
    await a.setWorkflowStatus(workflow.id, "active");
  }

  /** Run now, then re-read the run list so the canvas has a live job id.
   *
   * The pipeline's badges are keyed on the running run's `jobId`; the backend
   * mints that row before `run_workflow` resolves, but nothing re-fetched it
   * here, so a run started from this pane animated nothing until it finished
   * and `workflows-changed` finally refreshed the list. */
  async function runNow() {
    await a.runWorkflowNow(workflow.id);
    try {
      setRuns(await api.getWorkflowRuns(workflow.id));
    } catch {
      // The run itself already reported anything that went wrong; the history
      // head simply stays as it was until the next refresh.
    }
  }

  /** Back to the library. The form lives only in this component and Save is off
   * while the def is still incomplete — which is most of the time mid-edit — so
   * leaving used to drop the work silently. Ask instead. */
  async function leave() {
    if (dirty) {
      const ok = await confirm(
        valid
          ? "Leave without saving your changes to this workflow?"
          : "This workflow has unsaved changes, and they can't be saved until the listed problems are fixed. Leave and lose them?",
        { title: "Unsaved changes", kind: "warning" },
      );
      if (!ok) return;
    }
    s.setWfDetailId(null);
  }

  function toggleKind(k: string) {
    if (binding.scope !== "file") return;
    const kinds = binding.kinds ?? [];
    const next = kinds.includes(k)
      ? kinds.filter((x) => x !== k)
      : [...kinds, k];
    setBinding({ ...binding, kinds: next });
    /* dirty is derived from a diff */
  }
  function setBindingExts(raw: string) {
    if (binding.scope !== "file") return;
    setExtsText(raw);
    setBinding({ ...binding, exts: parseExts(raw) });
    /* dirty is derived from a diff */
  }
  function setBindingFile(fileId: string | null) {
    if (binding.scope !== "file") return;
    setBinding({ ...binding, file_id: fileId });
    /* dirty is derived from a diff */
  }

  return (
    <div className="wf-page">
      <WorkflowHeader
        actions={{
          checking,
          dirty,
          errors,
          fileScoped: isFileScoped,
          isDraft,
          pinned: workflow.pinned,
          runBlocked,
          schedule,
          valid,
          onActivate: saveAndActivate,
          onDeactivate: () => a.setWorkflowStatus(workflow.id, "draft"),
          onDelete: () => a.deleteWorkflow(workflow.id),
          onPinToggle: () => a.setWorkflowPinned(workflow.id, !workflow.pinned),
          onRun: runNow,
          onSave: save,
          onScheduleSave: (nextSchedule) =>
            a.setWorkflowSchedule(workflow.id, nextSchedule),
          workflowName: workflow.name,
        }}
        emoji={emoji}
        name={name}
        onBack={leave}
        onEmojiChange={setEmoji}
        onNameChange={setName}
      />
      <WorkflowDetailBody
        binding={binding}
        def={def}
        errors={errors}
        extsText={extsText}
        fileScoped={isFileScoped}
        files={s.files}
        liveStatus={liveStatus}
        onAddBranch={addBranchNode}
        onAddNode={addNode}
        onEdgesChange={updateEdges}
        onExtsChange={setBindingExts}
        onFileChange={setBindingFile}
        onGeneral={() => setBinding({ scope: "general" })}
        onKindToggle={toggleKind}
        onNodeChange={updateNode}
        onNodeDelete={deleteNode}
        onSelect={setSelected}
        onSpecificFiles={() => {
          setBinding({ scope: "file", kinds: [], exts: [] });
          setExtsText("");
        }}
        selected={selected}
        selectedNode={selectedNode}
        stepHeadRef={stepHeadRef}
        runs={runs}
        workflow={workflow}
      />
    </div>
  );
}
