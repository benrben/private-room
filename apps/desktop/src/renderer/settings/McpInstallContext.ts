import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { CatalogEntry, InstallSpec, McpServerStatus, RuntimeStatus } from "../api";

export type InstallDrawerModel = {
  authBusy: boolean;
  authUrl: string;
  autoApprove: boolean | null;
  badEndpoint: boolean;
  busy: boolean;
  confirming: boolean;
  connStatus: McpServerStatus | null;
  copied: boolean;
  done: boolean;
  entry: CatalogEntry;
  err: string;
  host: string;
  isRemote: boolean;
  outboundUnmask: boolean | null;
  runtime: RuntimeStatus | null;
  runtimeBusy: boolean;
  runtimePct: number;
  secretKeys: string[];
  secrets: Record<string, string>;
  signedIn: boolean;
  spec: InstallSpec;
  useCloud: boolean;
  onClose: () => void;
  onCancelOauth: () => void;
  onConfirming: Dispatch<SetStateAction<boolean>>;
  onDoInstall: () => void;
  onDoOauth: () => void;
  onDoProvision: () => void;
  onDoSignOut: () => void;
  onSecrets: Dispatch<SetStateAction<Record<string, string>>>;
  onUseCloud: Dispatch<SetStateAction<boolean>>;
  onCopied: Dispatch<SetStateAction<boolean>>;
};

export const InstallDrawerContext = createContext<InstallDrawerModel | null>(null);

export function useInstallDrawer(): InstallDrawerModel {
  const model = useContext(InstallDrawerContext);
  if (!model) throw new Error("Install drawer context is unavailable.");
  return model;
}
