import { api, ScheduleArg, ScriptApproveRequest } from "../api";
import { WSState } from "./state";
import { tryToast } from "./guard";

/** Wave 5 (Idea 13): Scripts page + run/schedule/consent handlers. Runs flow
 * through the Wave 4a job queue (a hidden per-script auto-workflow), so their
 * cards, progress and history are the ordinary job/workflow surfaces. */
export function makeScriptActions(s: WSState) {
  async function refreshScripts() {
    try {
      s.setScripts(await api.listScripts());
    } catch {
      // No room / transient — keep the current list.
    }
  }

  /** Open the full-pane Scripts view (views are mutually exclusive). */
  function openScripts() {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setOpenFile(null);
    s.setShowScripts(true);
    void refreshScripts();
  }

  function closeScripts() {
    s.setShowScripts(false);
  }

  /** Run a script now. The backend may raise a consent card first (handled by
   * the script-approve-request listener); a decline is not an error. */
  async function runScript(fileId: string) {
    const sc = s.scripts.find((x) => x.fileId === fileId);
    const name = sc?.name ?? "script";
    try {
      await api.runScript(fileId);
      s.pushToast("info", `${name} started`, { label: "Scripts", run: openScripts });
      await refreshScripts();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("not approved")) {
        s.pushToast("info", `${name} was not run.`);
      } else {
        s.pushToast("error", msg);
      }
    }
  }

  /** Set (or clear, kind="") a script's schedule. */
  async function scheduleScript(fileId: string, schedule: ScheduleArg) {
    await tryToast(s, async () => {
      await api.setScriptSchedule(
        fileId,
        schedule.kind,
        schedule.param ?? "",
        schedule.enabled ?? true,
      );
      await refreshScripts();
    });
  }

  /** Answer a queued script-run consent card, then drop it from the queue. */
  function resolveScriptApproval(
    req: ScriptApproveRequest,
    decision: "once" | "always" | "deny",
  ) {
    api.resolveScriptRun(req.id, decision).catch(() => {});
    s.setScriptApprovals((q) => q.filter((r) => r.id !== req.id));
  }

  return {
    refreshScripts,
    openScripts,
    closeScripts,
    runScript,
    scheduleScript,
    resolveScriptApproval,
  };
}

export type ScriptActions = ReturnType<typeof makeScriptActions>;
