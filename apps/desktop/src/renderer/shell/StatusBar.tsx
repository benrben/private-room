import { useEffect, useState } from "react";
import { CloudIcon, CloudOffIcon, DatabaseIcon, ShieldIcon } from "../icons";
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

type Trust = ReturnType<typeof trustState>;

interface StatusBarProps {
  layout: LayoutApi;
  fileCount: number;
  cloud: boolean;
  engineLabel: string;
  protectedOn: boolean | null;
  onOpenPrivacy: () => void;
  webOn: boolean;
  mcpToolCount: number;
  runningJobs: number;
  pendingApprovals: number;
  onShowActivity: () => void;
}

function connectedToolLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} connected tool${count === 1 ? "" : "s"}`;
}

function outboundLabels(webOn: boolean, mcpToolCount: number): string[] {
  return [
    webOn ? "online search on" : null,
    connectedToolLabel(mcpToolCount),
  ].filter((label): label is string => label !== null);
}

function outboundNote(webOn: boolean, mcpToolCount: number): string {
  return [
    webOn ? "Online search sends what the AI asks for off this Mac." : null,
    mcpToolCount > 0
      ? "Connected tools receive what the AI asks for, and a remote connector takes it off this Mac."
      : null,
  ]
    .filter((note): note is string => note !== null)
    .join(" ");
}

function trustWithOutbound(
  engine: Trust,
  cloud: boolean,
  labels: string[],
  note: string,
): Trust {
  if (labels.length === 0) return engine;
  const source = cloud
    ? engine
    : { label: "Local model", title: "The AI runs on this Mac." };
  return {
    tone: cloud ? engine.tone : "warn",
    label: `${source.label} · ${labels.join(" · ")}`,
    title: `${source.title} ${note}`,
  };
}

function pluralSuffix(count: number): string {
  return count === 1 ? "" : "s";
}

function TrustButton({
  cloud,
  engineLabel,
  hasOutbound,
  trust,
  onOpenPrivacy,
}: {
  cloud: boolean;
  engineLabel: string;
  hasOutbound: boolean;
  trust: Trust;
  onOpenPrivacy: () => void;
}) {
  const leavesMac = cloud || hasOutbound;
  return (
    <button
      className={`status-item status-trust ${trust.tone}`}
      title={`${trust.title} (${engineLabel})${leavesMac ? " Click to review." : ""}`}
      onClick={onOpenPrivacy}
    >
      {leavesMac ? <CloudIcon size={12} /> : <ShieldIcon size={12} />}{" "}
      {trust.label}
    </button>
  );
}

function StatusLeft({
  cloud,
  engineLabel,
  fileCount,
  hasOutbound,
  trust,
  onOpenPrivacy,
}: Pick<
  StatusBarProps,
  "cloud" | "engineLabel" | "fileCount" | "onOpenPrivacy"
> & {
  hasOutbound: boolean;
  trust: Trust;
}) {
  return (
    <div className="status-left">
      <TrustButton
        cloud={cloud}
        engineLabel={engineLabel}
        hasOutbound={hasOutbound}
        trust={trust}
        onOpenPrivacy={onOpenPrivacy}
      />
      <span
        className="status-item"
        title="Room files available to you, including files shown only in sections such as Recordings or Sketches; internal preview artifacts are not counted"
      >
        <DatabaseIcon size={12} /> {fileCount} room file
        {pluralSuffix(fileCount)}
      </span>
    </div>
  );
}

function OfflineStatus({ online }: { online: boolean }) {
  if (online) return null;
  return (
    <span
      className="status-item warn"
      title="This Mac has no internet connection. Everything in the room still works; cloud models, web search, the browser and read-aloud need a connection."
    >
      <CloudOffIcon size={12} /> Offline
    </span>
  );
}

function PendingApprovals({
  count,
  onShowActivity,
}: {
  count: number;
  onShowActivity: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      className="status-item warn"
      title="Something needs your approval — open Activity"
      onClick={onShowActivity}
    >
      <span className="nb-circled nb-sem-pending">{count}</span> approval
      {pluralSuffix(count)} waiting
    </button>
  );
}

function RunningJobs({
  count,
  onShowActivity,
}: {
  count: number;
  onShowActivity: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      className="status-item"
      title="Background work — open Activity"
      onClick={onShowActivity}
    >
      <span className="status-dot busy" />
      {count} job{pluralSuffix(count)} running or waiting
    </button>
  );
}

function StatusRight({
  online,
  pendingApprovals,
  runningJobs,
  onShowActivity,
}: Pick<
  StatusBarProps,
  "pendingApprovals" | "runningJobs" | "onShowActivity"
> & { online: boolean }) {
  return (
    <div className="status-right">
      <OfflineStatus online={online} />
      <PendingApprovals
        count={pendingApprovals}
        onShowActivity={onShowActivity}
      />
      <RunningJobs count={runningJobs} onShowActivity={onShowActivity} />
    </div>
  );
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
}: StatusBarProps) {
  const engine = trustState(cloud, protectedOn);
  const labels = outboundLabels(webOn, mcpToolCount);
  const trust = trustWithOutbound(
    engine,
    cloud,
    labels,
    outboundNote(webOn, mcpToolCount),
  );
  const online = useOnline();
  return (
    <footer className="pr-statusbar" aria-label="Workspace status">
      <div
        className="status-seal"
        role="img"
        aria-label="Room data on this Mac; private Arcelle state encrypted"
        title="Room data on this Mac; private Arcelle state encrypted"
      >
        <ShieldIcon size={12} />
      </div>
      <StatusLeft
        cloud={cloud}
        engineLabel={engineLabel}
        fileCount={fileCount}
        hasOutbound={labels.length > 0}
        trust={trust}
        onOpenPrivacy={onOpenPrivacy}
      />
      <StatusRight
        online={online}
        pendingApprovals={pendingApprovals}
        runningJobs={runningJobs}
        onShowActivity={onShowActivity}
      />
    </footer>
  );
}
