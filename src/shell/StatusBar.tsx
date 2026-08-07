import { useEffect, useState } from "react";
import {
  CloudIcon,
  CloudOffIcon,
  DatabaseIcon,
  ShieldIcon,
} from "../icons";
import { LayoutApi } from "./useLayout";
import { trustState } from "../workspace/markup";

/** Whether this Mac has a network at all. Everything on-device keeps working
 * without one; cloud models, web search, the browser and read-aloud do not,
 * and each used to fail in its own way (read-aloud simply went silent, which
 * reads as "the app is mute"). One honest indicator beats four mysteries. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/** The status strip. Every item reflects real state: the trust route (local /
 * protected cloud / raw cloud), indexed file count, connected tools,
 * background work, and the current pane layout.
 *
 * It is the quietest thing on screen and stays that way: one hairline above
 * it, no cell borders, no fills, and everything in the faint ink except the
 * two readouts that are allowed to interrupt — the trust chip when the room's
 * content is leaving the Mac, and anything actually waiting on the user. The
 * type does NOT shrink to achieve that. It used to run at 10px, under the
 * design system's 12px floor; a status bar earns its lightness from restraint,
 * not from being too small to read. */
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
  const online = useOnline();
  return (
    <footer className="pr-statusbar" aria-label="Workspace status">
      {/* Picture-only, so it carries its own name: a hover tooltip is not a
          text alternative for anyone who never hovers. */}
      <div
        className="status-seal"
        role="img"
        aria-label="This room is an encrypted file on this Mac"
        title="This room is an encrypted file on this Mac"
      >
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
        {!online && (
          <span
            className="status-item warn"
            title="This Mac has no internet connection. Everything in the room still works; cloud models, web search, the browser and read-aloud need a connection."
          >
            <CloudOffIcon size={11} /> Offline
          </span>
        )}
        {pendingApprovals > 0 && (
          <button
            className="status-item warn"
            title="Something needs your approval — open Activity"
            onClick={onShowActivity}
          >
            {/* The one notification in the bar, so the one circled number:
                drawn round by hand, and still followed by the words that say
                what it counts — the ring is emphasis, never the message. NOT
                aria-hidden, and not abbreviated: the ring is a border around a
                real number, and hiding it would take the count out of the
                button's accessible name, which used to read "3 approvals
                waiting". The explicit space keeps it reading that way. */}
            <span className="nb-circled nb-sem-pending">{pendingApprovals}</span>{" "}
            approval{pendingApprovals === 1 ? "" : "s"} waiting
          </button>
        )}
        {runningJobs > 0 && (
          <button
            className="status-item"
            title="Background work is running — open Activity"
            onClick={onShowActivity}
          >
            {/* The dot's colour lives in the stylesheet, where both themes can
                be checked at once — an inline var() could only ever be one. */}
            <span className="status-dot busy" />
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
