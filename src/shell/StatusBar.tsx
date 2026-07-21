import {
  CloudIcon,
  CloudOffIcon,
  DatabaseIcon,
  ShieldIcon,
} from "../icons";
import { LayoutApi } from "./useLayout";
import { trustState } from "../workspace/markup";

/** The 23px status strip. Every item reflects real state: the trust route
 * (local / protected cloud / raw cloud), indexed file count, connected tools,
 * background work, and the current pane layout. */
export default function StatusBar({
  layout,
  fileCount,
  cloud,
  engineLabel,
  protectedOn,
  onOpenPrivacy,
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
  /** The cloud-privacy door's effective state; null while still loading. */
  protectedOn: boolean | null;
  /** Open the trust control (Settings → Cloud privacy). */
  onOpenPrivacy: () => void;
  webOn: boolean;
  mcpToolCount: number;
  runningJobs: number;
  pendingApprovals: number;
  onShowActivity: () => void;
}) {
  const trust = trustState(cloud, protectedOn);
  return (
    <footer className="pr-statusbar" aria-label="Workspace status">
      <div className="status-seal" title="This room is an encrypted file on this Mac">
        <ShieldIcon size={12} />
      </div>
      <div className="status-left">
        <button
          className={`status-item status-trust ${trust.tone}`}
          title={`${trust.title} (${engineLabel})${cloud ? " Click to review." : ""}`}
          onClick={onOpenPrivacy}
        >
          {cloud ? <CloudIcon size={11} /> : <ShieldIcon size={11} />} {trust.label}
        </button>
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
