export interface RunFileRow {
  file_id: string;
  baseline_path: string | null;
  baseline_hash: string | null;
  baseline_object_id: string | null;
  final_path: string | null;
  final_hash: string | null;
  rollback_state: string | null;
}

export interface CaptureRun {
  write_enabled: number;
  baseline_completed: number;
}

export interface BaselineFileRow {
  file_id: string;
  baseline_path: string | null;
  baseline_hash: string | null;
}

export interface CurrentWorkspaceFile {
  id: string;
  relative_path: string;
  content_sha256: string | null;
  index_state: string;
}

export interface FinalFileState {
  finalPath: string | null;
  finalHash: string | null;
  change: "created" | "modified" | "moved" | "deleted" | "unchanged";
}

export interface RollbackResult {
  restored: string[];
  removedCreated: string[];
  conflicts: string[];
}

export interface RunChangeSummary {
  changedPaths: string[];
  changedFiles: Array<{
    fileId: string;
    relativePath: string;
    change: "created" | "modified" | "moved" | "deleted";
  }>;
  count: number;
}
