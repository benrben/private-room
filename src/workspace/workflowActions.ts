import { api, Workflow, ScheduleArg, WorkflowTemplate } from "../api";
import { WSState } from "./state";
import { tryToast } from "./guard";

/** Wave 4a (Idea 2): Workflows page + shortcuts handlers. `viewFile` opens a
 * workflow's output when a manual run finishes. */
export function makeWorkflowActions(
  s: WSState,
  _deps: { viewFile: (id: string) => Promise<void> },
) {
  async function refreshWorkflows() {
    try {
      s.setWorkflows(await api.listWorkflows());
    } catch {
      // No room / transient — leave the current list.
    }
  }

  /** Open the full-pane Workflows view (views are mutually exclusive). */
  function openWorkflows() {
    s.setShowMap(false);
    s.setOpenFile(null);
    s.setWfDetailId(null);
    s.setShowWorkflows(true);
    void refreshWorkflows();
  }

  function openWorkflowDetail(id: string) {
    s.setShowMap(false);
    s.setOpenFile(null);
    s.setWfDetailId(id);
    s.setShowWorkflows(true);
  }

  function closeWorkflows() {
    s.setShowWorkflows(false);
    s.setWfDetailId(null);
  }

  async function runWorkflowNow(id: string, fileId?: string) {
    const wf = s.workflows.find((w) => w.id === id);
    await tryToast(s, async () => {
      await api.runWorkflow(id, fileId);
      s.pushToast("info", `${wf?.name ?? "Workflow"} started`, {
        label: "View",
        run: () => openWorkflowDetail(id),
      });
    });
  }

  /** File-header Actions run: names the file in the toast. */
  async function runWorkflowOn(id: string, fileId: string, fileName: string) {
    const wf = s.workflows.find((w) => w.id === id);
    await tryToast(s, async () => {
      await api.runWorkflow(id, fileId);
      s.pushToast("info", `${wf?.name ?? "Workflow"} started on ${fileName}`, {
        label: "View",
        run: openWorkflows,
      });
    });
  }

  async function setWorkflowStatus(id: string, status: "active" | "draft") {
    await tryToast(s, async () => {
      await api.setWorkflowStatus(id, status);
      await refreshWorkflows();
    });
  }

  async function setWorkflowPinned(id: string, pinned: boolean) {
    await tryToast(s, async () => {
      await api.setWorkflowPinned(id, pinned);
      await refreshWorkflows();
    });
  }

  async function deleteWorkflow(id: string) {
    await tryToast(s, async () => {
      await api.deleteWorkflow(id);
      s.setWfDetailId(null);
      await refreshWorkflows();
    });
  }

  async function setWorkflowSchedule(id: string, schedule: ScheduleArg) {
    await tryToast(s, async () => {
      await api.setWorkflowSchedule(id, schedule);
      await refreshWorkflows();
    });
  }

  /** Save an edited definition/meta for a workflow (returns to draft). */
  async function saveWorkflowEdits(
    id: string,
    patch: {
      name?: string;
      description?: string;
      emoji?: string;
      definition?: unknown;
      binding?: unknown;
    },
  ) {
    await tryToast(s, async () => {
      await api.updateWorkflow({ id, ...patch });
      await refreshWorkflows();
    });
  }

  /** Instantiate a template as a new draft and open it. */
  async function instantiateTemplate(t: WorkflowTemplate) {
    await tryToast(s, async () => {
      const id = await api.saveWorkflow({
        name: t.name,
        description: t.description,
        emoji: t.emoji,
        definition: t.definition,
        binding: t.binding,
        schedule: t.schedule,
      });
      await refreshWorkflows();
      openWorkflowDetail(id);
    });
  }

  /** Save a brand-new blank workflow and open it. */
  async function createBlankWorkflow() {
    await tryToast(s, async () => {
      const id = await api.saveWorkflow({
        name: "New workflow",
        emoji: "⚙️",
        definition: {
          version: 1,
          nodes: [
            {
              id: "n1",
              label: "Write something",
              kind: "generate",
              model: "auto",
              prompt: "Summarize the files in this room:\n{{files}}",
            },
          ],
          edges: [],
        },
      });
      await refreshWorkflows();
      openWorkflowDetail(id);
    });
  }

  return {
    refreshWorkflows,
    openWorkflows,
    openWorkflowDetail,
    closeWorkflows,
    runWorkflowNow,
    runWorkflowOn,
    setWorkflowStatus,
    setWorkflowPinned,
    deleteWorkflow,
    setWorkflowSchedule,
    saveWorkflowEdits,
    instantiateTemplate,
    createBlankWorkflow,
  };
}

export type WorkflowActions = ReturnType<typeof makeWorkflowActions>;
export type { Workflow };
