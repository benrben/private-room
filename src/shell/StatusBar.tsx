import {
  CloudIcon,
  CloudOffIcon,
  DatabaseIcon,
  ShieldIcon,
} from "../icons";
import { LayoutApi } from "./useLayout";

/** The 23px status strip. Every item reflects real state: the data route
 * (local vs the chosen cloud engine), indexed file count, connected tools,
 * background work, and the current pane layout. */
export default function StatusBar({
  layout,
  fileCount,
  cloud,
  engineLabel,
  webOn,
  mcpToolCount,
  runningJobs,
  pendingApprovals,
  onShowActivity,
}: {
  layout: LayoutApi;
  fileCount: number;
  cloud: boolean;
  engineLabel: string;
  webOn: boolean;
  mcpToolCount: number;
  runningJobs: number;
  pendingApprovals: number;
  onShowActivity: () => void;
}) {
  return (
    <footer className="pr-statusbar" aria-label="Workspace status">
      <div className="status-seal" title="This room is an encrypted file on this Mac">
        <ShieldIcon size={12} />
      </div>
      <div className="status-left">
        {cloud ? (
          <span
            className="status-item warn"
            title={`${engineLabel} runs in the cloud — prompts and attached context leave this Mac`}
          >
            <CloudIcon size={11} /> Cloud · {engineLabel}
          </span>
        ) : (
          <span
            className="status-item good"
            title="AI runs on this Mac — nothing leaves the device"
          >
            <span className="status-dot" /> Local · {engineLabel}
          </span>
        )}
        <span className="status-item" title="Files stored in this room">
          <DatabaseIcon size={11} /> {fileCount} file{fileCount === 1 ? "" : "s"}
        </span>
        {webOn || mcpToolCount > 0 ? (
          <span
            className="status-item warn"
            title={
              [
                webOn ? "Online search is on" : null,
                mcpToolCount > 0 ? `${mcpToolCount} connected tools` : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          >
            <CloudIcon size={11} /> Internet tools on
          </span>
        ) : (
          <span className="status-item" title="No online search or connected tools">
            <CloudOffIcon size={11} /> No external tools
          </span>
        )}
      </div>
      <div className="status-right">
        {pendingApprovals > 0 && (
          <button
            className="status-item warn"
            title="Something needs your approval — open Activity"
            onClick={onShowActivity}
          >
            {pendingApprovals} approval{pendingApprovals === 1 ? "" : "s"} waiting
          </button>
        )}
        {runningJobs > 0 && (
          <button
            className="status-item"
            title="Background work is running — open Activity"
            onClick={onShowActivity}
          >
            <span className="status-dot" style={{ background: "var(--accent)" }} />
            {runningJobs} job{runningJobs === 1 ? "" : "s"} running
          </button>
        )}
        <span className="status-item" title="Current pane layout">
          {layout.layoutLabel}
        </span>
      </div>
    </footer>
  );
}
