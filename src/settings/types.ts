import type { ComponentType } from "react";
import type {
  AiStatus,
  McpServerStatus,
  ModelCaps,
  RoomServerStatus,
  SttStatus,
} from "../api";

// Re-export the api-owned types the section components need, so those files
// depend only on this local module (they never import from ../api directly).
export type { AiStatus, McpServerStatus, ModelCaps, RoomServerStatus, SttStatus };

/** A stroke-icon component (from icons.tsx), passed down to a section as a prop
 * so the presentational section files never import from icons.tsx directly. */
export type IconComponent = ComponentType<{
  size?: number;
  className?: string;
}>;

// Focusable-descendant selector for the Settings focus trap.
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Settings-local mirrors of a few BACKEND-ACTUALS return structs. Callers reach
// the backend through the typed api.ts wrappers (getOllamaUrl/setOllamaUrl/
// listRoles/writeRecoveryKey/recommendedModels).
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
  /** Idea 9: true when a job runs/queues, a recording is live, or an answer is
   * streaming — CheckpointsSection disables Roll back (it can't reach WSState
   * itself). The backend refuses regardless; this is UX. */
  busy: boolean;
}

export interface PullProgress {
  status: string;
  percent: number | null;
}
