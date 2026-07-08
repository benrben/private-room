import type { ComponentType } from "react";
import type { AiStatus, McpServerStatus, ModelCaps, SttStatus } from "../api";

// Re-export the api-owned types the section components need, so those files
// depend only on this local module (they never import from ../api directly).
export type { AiStatus, McpServerStatus, ModelCaps, SttStatus };

/** A stroke-icon component (from icons.tsx), passed down to a section as a prop
 * so the presentational section files never import from icons.tsx directly. */
export type IconComponent = ComponentType<{
  size?: number;
  className?: string;
}>;

// Focusable-descendant selector for the Settings focus trap.
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// CONTRACT-NOTE: these mirror the BACKEND-ACTUALS return structs. The typed
// api.ts wrappers meant for these (getOllamaUrl/setOllamaUrl/roomServerStatus/
// setRoomServer/listRoles/writeRecoveryKey/recommendedModels) and the icons
// (ServerIcon/RecoveryIcon) are being added in parallel. Until they land we
// call the confirmed tauri commands directly via invoke() and keep the section
// headers icon-free to match every existing settings section. Fold these into
// api.ts wrappers during integration.
export interface RoomServerStatus {
  running: boolean;
  url: string;
  config: string;
}
export interface RoomRole {
  id: string;
  name: string;
  blurb: string;
  instructions: string;
  prompts: string[];
  commands: string[];
}
export interface RecommendedModels {
  chat: string[];
  embed: string;
  vision: string;
}

export interface Props {
  ai: AiStatus | null;
  model: string;
  onModelChange: (model: string) => void;
  onModelsChanged: () => void;
  onClose: () => void;
}

export interface PullProgress {
  status: string;
  percent: number | null;
}
