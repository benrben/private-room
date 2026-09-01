import type { ReactNode } from "react";
import Workspace from "./Workspace";
import { Logomark } from "./icons";
import type { RoomInfo, RecentRoom, SealedPackageInspection, WorkspaceOperationProgressEvent } from "./api";
import type { RoomRole, Screen } from "./rooms/constants";
import { StartScreen } from "./screens/StartScreen";
import { CreateScreen } from "./screens/CreateScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { RecoveryModal } from "./screens/RecoveryModal";
import { WorkspaceOperationProgress } from "./screens/WorkspaceOperationProgress";
import { SealedInspectionScreen } from "./screens/SealedInspectionScreen";
import { SealLockingOverlay, SealUnlockingOverlay } from "./screens/SealOverlay";

type StartGateProps = {
  recent: RecentRoom[];
  onCreate: () => void;
  onOpen: () => void;
  onDemo: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => Promise<void>;
  onTrashRoom: (room: RecentRoom) => void;
  onClearRecent: () => Promise<void>;
};

function StartGate(props: StartGateProps) {
  return <StartScreen {...props} />;
}

type CreateGateProps = {
  roomName: string;
  setRoomName: (name: string) => void;
  templateKey: string;
  setTemplateKey: (key: string) => void;
  roles: RoomRole[];
  roleId: string;
  setRoleId: (id: string) => void;
  password: string;
  setPassword: (password: string) => void;
  confirm: string;
  setConfirm: (confirmation: string) => void;
  error: string;
  setError: (error: string) => void;
  busy: boolean;
  onSubmit: () => Promise<void>;
  onBack: () => void;
};

function CreateGate(props: CreateGateProps) {
  return <CreateScreen {...props} />;
}

type UnlockGateProps = {
  path: string;
  sealedInspection: SealedPackageInspection | null;
  busy: boolean;
  error: string;
  setError: (error: string) => void;
  recoveryMode: boolean;
  canTouchId: boolean;
  hasRecovery: boolean;
  password: string;
  setPassword: (password: string) => void;
  recoveryInput: string;
  setRecoveryInput: (input: string) => void;
  onUnlock: () => void;
  onRecoveryUnlock: () => void;
  onTouchId: () => void;
  onConvertLegacy: () => void;
  onInspectSealed: () => void;
  onExtract: (fileIds: string[]) => void;
  onImport: () => void;
  onEnterRecoveryMode: () => void;
  onExitRecoveryMode: () => void;
  onBack: () => void;
  onDismissInspection: () => void;
};

function UnlockGate({ sealedInspection, ...props }: UnlockGateProps) {
  if (sealedInspection) {
    return (
      <SealedInspectionScreen
        path={props.path}
        inspection={sealedInspection}
        busy={props.busy}
        error={props.error}
        onExtract={props.onExtract}
        onImport={props.onImport}
        onBack={props.onDismissInspection}
      />
    );
  }
  return (
    <UnlockScreen
      path={props.path}
      recoveryMode={props.recoveryMode}
      canTouchId={props.canTouchId}
      hasRecovery={props.hasRecovery}
      busy={props.busy}
      password={props.password}
      setPassword={props.setPassword}
      recoveryInput={props.recoveryInput}
      setRecoveryInput={props.setRecoveryInput}
      error={props.error}
      setError={props.setError}
      onUnlock={props.onUnlock}
      onRecoveryUnlock={props.onRecoveryUnlock}
      onTouchId={props.onTouchId}
      onConvertLegacy={props.onConvertLegacy}
      onInspectSealed={props.onInspectSealed}
      onEnterRecoveryMode={props.onEnterRecoveryMode}
      onExitRecoveryMode={props.onExitRecoveryMode}
      onBack={props.onBack}
    />
  );
}

type OpenWorkspaceProps = {
  info: RoomInfo;
  roomEpoch: number;
  operations: WorkspaceOperationProgressEvent[];
  locking: boolean;
  lockSlow: boolean;
  onLock: () => Promise<void>;
  onRename: (info: RoomInfo) => void;
};

export function OpenWorkspace({
  info,
  roomEpoch,
  operations,
  locking,
  lockSlow,
  onLock,
  onRename,
}: OpenWorkspaceProps) {
  return (
    <>
      <Workspace key={`${info.path}:${roomEpoch}`} info={info} onLock={onLock} onRenamed={onRename} />
      <WorkspaceOperationProgress operations={operations} />
      {locking && <SealLockingOverlay slow={lockSlow} />}
    </>
  );
}

type GateContentProps = {
  screen: Exclude<Screen, { kind: "workspace" }>;
  start: StartGateProps;
  create: CreateGateProps;
  unlock: UnlockGateProps;
};

export function GateContent({ screen, start, create, unlock }: GateContentProps) {
  if (screen.kind === "start") return <StartGate {...start} />;
  if (screen.kind === "create") return <CreateGate {...create} />;
  return <UnlockGate {...unlock} path={screen.path} />;
}

type GateShellProps = {
  entering: boolean;
  operations: WorkspaceOperationProgressEvent[];
  recoveryCode: string | null;
  recoveryCopied: boolean;
  setRecoveryCopied: (copied: boolean) => void;
  onDismissRecovery: () => void;
  children: ReactNode;
};

export function GateShell({
  entering,
  operations,
  recoveryCode,
  recoveryCopied,
  setRecoveryCopied,
  onDismissRecovery,
  children,
}: GateShellProps) {
  return (
    <div className={`gate${entering ? " entering" : ""}`}>
      <div className="gate-card">
        <div className="gate-logo"><Logomark size={56} /></div>
        <h1>Arcelle</h1>
        {children}
      </div>
      <WorkspaceOperationProgress operations={operations} />
      {entering && <SealUnlockingOverlay />}
      {recoveryCode && (
        <RecoveryModal
          recoveryCode={recoveryCode}
          recoveryCopied={recoveryCopied}
          setRecoveryCopied={setRecoveryCopied}
          onDismiss={onDismissRecovery}
        />
      )}
    </div>
  );
}
