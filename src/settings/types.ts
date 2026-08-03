import type { ComponentType } from "react";
import type {
  AiStatus,
  McpServerStatus,
  ModelCaps,
  RecommendedModels,
  RoomRole,
  RoomServerStatus,
  SttStatus,
} from "../api";

// Re-export the api-owned types the section components need, so those files
// depend only on this local module (they never import from ../api directly).
export type {
  AiStatus,
  McpServerStatus,
  ModelCaps,
  RecommendedModels,
  RoomRole,
  RoomServerStatus,
  SttStatus,
};

/** A stroke-icon component (from icons.tsx), passed down to a section as a prop
 * so the presentational section files never import from icons.tsx directly. */
export type IconComponent = ComponentType<{
  size?: number;
  className?: string;
}>;

// Focusable-descendant selector for the Settings focus trap.
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// RoomRole and RecommendedModels used to be spelled out AGAIN here, beside the
// api.ts copies the same commands already return. They matched, so a drift
// would have compiled cleanly and fed a screen a shape the backend never sends.
// One declaration (apiTypes.ts), re-exported above like every other.

export interface Props {
  ai: AiStatus | null;
  model: string;
  onModelChange: (model: string) => void;
  onModelsChanged: () => void;
  onClose: () => void;
  /** A section id (e.g. "set-cloud-privacy") to scroll to when the modal opens —
   * lets the status-bar trust chip deep-link straight to Cloud privacy. */
  initialSection?: string | null;
  /** Idea 9: true when a job runs/queues, a recording is live, or an answer is
   * streaming — CheckpointsSection disables Roll back (it can't reach WSState
   * itself). The backend refuses regardless; this is UX. */
  busy: boolean;
}

export interface PullProgress {
  status: string;
  percent: number | null;
}
