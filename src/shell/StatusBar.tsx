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
 * protected cloud / raw cloud, and what leaves through online search or a
 * connector), indexed file count, and background work.
 *
 * It is the quietest thing on screen and stays that way: one hairline above
 * it, no cell borders, no fills, and everything in the faint ink except the
 * two readouts that are allowed to interrupt — the trust chip when the room's
 * content is leaving the Mac, and anything actually waiting on the user. The
 * type does NOT shrink to achieve that. It used to run at 10px, under the
 * design system's 12px floor; a status bar earns its lightness from restraint,
 * not from being too small to read. */
export default function StatusBar({
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
  const engine = trustState(cloud, protectedOn);
  /* `trustState` answers from the engine route and the privacy door alone.
   * Online search and connectors are a second way off this Mac that it cannot
   * see, and "nothing leaves the device" is false while either is on — so the
   * chip that owns the claim carries them, instead of being contradicted by the
   * cell that used to sit beside it. The breakdown is the chip's visible text,
   * not its tooltip: what is reaching the internet cannot be hover-only. */
  const outbound = [
    webOn ? "online search on" : null,
    mcpToolCount > 0
      ? `${mcpToolCount} connected tool${mcpToolCount === 1 ? "" : "s"}`
      : null,
  ].filter((x): x is string => x !== null);
  const sendsOut = outbound.length > 0;
  /* Said separately, because only one of the two is certain. Online search is
   * the internet by definition. A connector is a process this room hands the
   * AI's request to, and `mcpToolCount` cannot tell a remote server from a
   * local one — so the chip says what the tools receive, not where it goes. */
  const outboundNote = [
    webOn ? "Online search sends what the AI asks for off this Mac." : null,
    mcpToolCount > 0
      ? "Connected tools receive what the AI asks for, and a remote connector takes it off this Mac."
      : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" ");
  const trust = !sendsOut
    ? engine
    : {
        tone: cloud ? engine.tone : ("warn" as const),
        label: `${cloud ? engine.label : "Local model"} · ${outbound.join(" · ")}`,
        title: `${cloud ? engine.title : "The AI runs on this Mac."} ${outboundNote}`,
      };
  const online = useOnline();
  return (
    <footer className="pr-statusbar" aria-label="Workspace status">
      {/* Picture-only, so it carries its own name: a hover tooltip is not a
          text alternative for anyone who never hovers. */}
      <div
        className="status-seal"
        role="img"
        aria-label="Room data on this Mac; private Arcelle state encrypted"
        title="Room data on this Mac; private Arcelle state encrypted"
      >
        <ShieldIcon size={12} />
      </div>
      <div className="status-left">
        <button
          className={`status-item status-trust ${trust.tone}`}
          title={`${trust.title} (${engineLabel})${cloud || sendsOut ? " Click to review." : ""}`}
          onClick={onOpenPrivacy}
        >
          {cloud || sendsOut ? <CloudIcon size={12} /> : <ShieldIcon size={12} />}{" "}
          {trust.label}
        </button>
        <span className="status-item" title="Files stored in this room">
          <DatabaseIcon size={12} /> {fileCount} file{fileCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="status-right">
        {!online && (
          <span
            className="status-item warn"
            title="This Mac has no internet connection. Everything in the room still works; cloud models, web search, the browser and read-aloud need a connection."
          >
            <CloudOffIcon size={12} /> Offline
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
            title="Background work — open Activity"
            onClick={onShowActivity}
          >
            {/* The dot's colour lives in the stylesheet, where both themes can
                be checked at once — an inline var() could only ever be one. */}
            <span className="status-dot busy" />
            {/* "running" was a claim this number cannot make: `runningJobCount`
                counts queued jobs too, and Activity one click away shows them
                as Waiting. The wording covers what is actually counted. */}
            {runningJobs} job{runningJobs === 1 ? "" : "s"} running or waiting
          </button>
        )}
      </div>
    </footer>
  );
}
