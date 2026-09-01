import type { FileMeta } from "./db-host/files.js";
import type { Schedule, WorkflowRun } from "./db-host/workflows.js";
import type { ScriptLang } from "./scriptRun.js";

/** One script row for the Scripts page. */
export interface ScriptInfo {
  fileId: string;
  name: string;
  lang: string;
  deps: string[];
  inputs: string[];
  outputs: string[];
  shortcut: string;
  approved: boolean;
  changedSinceApproval: boolean;
  workflowId: string | null;
  schedule: Schedule | null;
  lastRun: WorkflowRun | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface ScriptCandidate {
  file: FileMeta;
  lang: ScriptLang;
}

export interface FailureHistory {
  consecutiveFailures: number;
  lastError: string | null;
}
