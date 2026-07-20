import { FileContent, FileTarget, RoomInfo } from "../api";

export interface OpenFile {
  id: string;
  content: FileContent;
  target?: FileTarget;
}

/** One flattened search hit (ADD-6) — the arrow-key navigable unit. */
export type FlatResult =
  | { kind: "file"; id: string; name: string; snippet: string }
  | { kind: "message"; chatId: string; messageId: string; snippet: string }
  | { kind: "memory"; id: string; snippet: string };

/** A transient message to the user. Successes/info self-dismiss; errors stay
 * until closed (UX-7). */
export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  /** Optional remediation button (e.g. "Open Ollama", "Download"). Runs, then
   * the toast dismisses itself. */
  action?: { label: string; run: () => void };
}

export interface Props {
  info: RoomInfo;
  onLock: () => void | Promise<void>;
}

/** The product areas the activity rail navigates between. "files" is the
 * default document workspace; map/workflows/scripts keep their existing
 * show* flags as the source of truth, and this value adds the areas that
 * had no flag before (home, recordings, memory). */
export type WorkArea =
  | "files"
  | "home"
  | "map"
  | "recordings"
  | "workflows"
  | "scripts"
  | "memory"
  | "connectors";
