import { WSState } from "../state";
import { WSActions } from "../actions";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { WorkflowDetail } from "./WorkflowDetail";
import { WorkflowsIcon } from "../../icons";
import { CloseIcon } from "../../icons";

type Props = { s: WSState; a: WSActions };

/** The full-pane Workflows view: library grid or one workflow's detail. */
export function WorkflowsPage({ s, a }: Props) {
  const detail = s.wfDetailId ? s.workflows.find((w) => w.id === s.wfDetailId) : null;

  if (detail) {
    return <WorkflowDetail s={s} a={a} workflow={detail} />;
  }

  return (
    <div className="wf-page">
      <div className="viewer-head">
        <span className="viewer-title">
          <WorkflowsIcon size={15} /> Workflows
        </span>
        <span className="viewer-actions">
          <button className="subtle btn-ic" onClick={() => s.setShowWorkflows(false)}>
            <CloseIcon size={12} /> Close
          </button>
        </span>
      </div>
      <WorkflowLibrary s={s} a={a} />
    </div>
  );
}
