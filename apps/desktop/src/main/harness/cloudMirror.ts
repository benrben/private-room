import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  emptyPrivacyReport,
  type PrivacyRule,
  type Redactor,
} from "../privacyRedact.js";
import { decodeTextBytes } from "../editMatchExtraction.js";
import {
  normalizeRelativePath,
  pathKey,
  resolveWorkspacePath,
} from "../workspace/pathSafety.js";
import { scanWorkspaceManifest } from "../workspace/manifest.js";
import type { ManifestEntry } from "../workspace/types.js";
import type { WorkspaceService } from "../workspace/workspaceService.js";

const MAX_EDITABLE_TEXT_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".log",
  ".srt",
  ".vtt",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".css",
  ".scss",
  ".sql",
  ".sh",
  ".zsh",
]);
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".tif",
  ".tiff",
  ".bmp",
  ".svg",
]);

export interface MirrorRedactionPolicy {
  redactor: Redactor;
  rules: readonly PrivacyRule[];
}

interface EditableMirrorFile {
  fileId: string;
  relativePath: string;
  mirrorPath: string;
  mirrorSha256: string;
  mirrorFsIdentity: string;
  expectedHash: string;
  baselineText: string;
}

interface MirrorMatch {
  entry: EditableMirrorFile;
  currentPath: string;
  currentKey: string;
}

interface MirrorEdit {
  text: string;
  relativePath: string;
  baseline?: EditableMirrorFile;
}

interface MirrorMove {
  baseline: EditableMirrorFile;
  destination: string;
  text: string;
}

interface MirrorWrite {
  baseline: EditableMirrorFile;
  text: string;
  displayedPath: string;
}

interface MirrorAddition {
  destination: string;
  text: string;
}

interface MirrorMutationPlan {
  deleted: EditableMirrorFile[];
  moves: MirrorMove[];
  writes: MirrorWrite[];
  additions: MirrorAddition[];
}

interface WorkspaceMirrorRow {
  id: string;
  relative_path: string;
  content_sha256: string;
  size_bytes: number;
  extracted_text: string | null;
}

interface MirrorPathAllocation {
  mirrorPaths: Map<string, string>;
  allocatedPathKeys: Set<string>;
  entitiesHidden: number;
}

interface MirrorRowResult {
  editable?: EditableMirrorFile;
  companionFiles: number;
  imagesBlocked: number;
  entitiesHidden: number;
}

interface MirrorWriteStats {
  companionFiles: number;
  imagesBlocked: number;
  entitiesHidden: number;
}
import { CloudMirrorInfo, CloudMirrorWriteBack, cloudMirrorProvenance, collectMirrorEdits, duplicatedProtectedTokens, isTextPath, orderMirrorMoves, planMirrorMutations, privateWrite, redactedRelativePath, safeId, sha256, stripEmbeddedImages, textStream, updateCloudMirrorMetadata, validateMirrorDestinations } from "./cloudMirrorPlanning.js";
export type { CloudMirrorInfo, CloudMirrorWriteBack } from "./cloudMirrorPlanning.js";


async function applyMirrorDeletes(
  workspace: WorkspaceService,
  deleted: readonly EditableMirrorFile[],
): Promise<void> {
  for (const baseline of deleted) {
    await workspace.trash(baseline.fileId, baseline.expectedHash);
  }
}

async function applyMirrorMoves(
  workspace: WorkspaceService,
  moves: readonly MirrorMove[],
  provenance: string,
  updated: string[],
): Promise<void> {
  for (const move of moves) {
    await workspace.move(
      move.baseline.fileId,
      move.destination,
      move.baseline.expectedHash,
    );
    if (move.text !== move.baseline.baselineText) {
      await workspace.writeAtomic(
        move.baseline.fileId,
        textStream(move.text),
        move.baseline.expectedHash,
      );
      updateCloudMirrorMetadata(
        workspace,
        move.baseline.fileId,
        move.text,
        provenance,
      );
    }
    updated.push(move.destination);
  }
}

async function applyMirrorWrites(
  workspace: WorkspaceService,
  writes: readonly MirrorWrite[],
  provenance: string,
  updated: string[],
): Promise<void> {
  for (const write of writes) {
    await workspace.writeAtomic(
      write.baseline.fileId,
      textStream(write.text),
      write.baseline.expectedHash,
    );
    updateCloudMirrorMetadata(
      workspace,
      write.baseline.fileId,
      write.text,
      provenance,
    );
    updated.push(write.displayedPath);
  }
}

async function applyMirrorAdditions(
  workspace: WorkspaceService,
  additions: readonly MirrorAddition[],
  created: string[],
): Promise<void> {
  for (const addition of additions) {
    await workspace.createFile(
      addition.destination,
      textStream(addition.text),
      "cloud-mirror",
    );
    created.push(addition.destination);
  }
}

async function applyMirrorPlan(
  workspace: WorkspaceService,
  plan: MirrorMutationPlan,
  runId: string,
): Promise<CloudMirrorWriteBack> {
  const updated: string[] = [];
  const created: string[] = [];
  await applyMirrorDeletes(workspace, plan.deleted);
  await applyMirrorMoves(
    workspace,
    orderMirrorMoves(plan.moves),
    cloudMirrorProvenance(runId),
    updated,
  );
  await applyMirrorWrites(
    workspace,
    plan.writes,
    cloudMirrorProvenance(runId),
    updated,
  );
  await applyMirrorAdditions(workspace, plan.additions, created);
  return { updated, created, requiresReview: [] };
}

async function assertMirrorCanCreate(
  created: boolean,
  runRoot: string,
): Promise<void> {
  if (created) throw new Error("This cloud mirror already exists.");
  const exists = await lstat(runRoot).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new Error("A cloud runtime folder already exists for this run.");
}

async function prepareMirrorRoot(
  workspace: WorkspaceService,
  runRoot: string,
  workspacePath: string,
): Promise<void> {
  await workspace.reconcile();
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  await chmod(workspacePath, 0o700);
}

function workspaceMirrorRows(
  workspace: WorkspaceService,
): WorkspaceMirrorRow[] {
  return workspace.db
    .prepare(
      `SELECT id, relative_path, content_sha256, size_bytes, extracted_text
     FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL
     ORDER BY relative_path`,
    )
    .all() as WorkspaceMirrorRow[];
}

function allocateMirrorPaths(
  rows: readonly WorkspaceMirrorRow[],
  redactor: Redactor,
): MirrorPathAllocation {
  const allocatedPaths = new Set<string>();
  const mirrorPaths = new Map<string, string>();
  let entitiesHidden = 0;
  for (const row of rows) {
    const original = normalizeRelativePath(row.relative_path);
    const redacted = redactedRelativePath(original, redactor, allocatedPaths);
    mirrorPaths.set(row.id, redacted.relativePath);
    entitiesHidden += redacted.entitiesHidden;
  }
  return { mirrorPaths, allocatedPathKeys: allocatedPaths, entitiesHidden };
}

function companionRootFor(allocatedPaths: Iterable<string>): string {
  const occupiedPaths = [...allocatedPaths];
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate =
      suffix === 1 ? "_Arcelle Companions" : `_Arcelle Companions (${suffix})`;
    const candidateKey = pathKey(candidate);
    if (
      !occupiedPaths.some(
        (key) => key === candidateKey || key.startsWith(`${candidateKey}/`),
      )
    ) {
      return candidate;
    }
  }
  return "_Arcelle Companions";
}

async function editableMirrorFile(
  workspace: WorkspaceService,
  workspacePath: string,
  row: WorkspaceMirrorRow,
  relativePath: string,
  mirrorPath: string,
  redactor: Redactor,
): Promise<{ file: EditableMirrorFile; entitiesHidden: number }> {
  const bytes = await workspace.readBuffer(row.id);
  if (sha256(bytes) !== row.content_sha256)
    throw new Error(`The room changed while mirroring ${relativePath}.`);
  const report = emptyPrivacyReport();
  const redacted = redactor.redact(
    stripEmbeddedImages(decodeTextBytes(bytes)),
    report,
  );
  const absoluteMirrorPath = resolveWorkspacePath(workspacePath, mirrorPath);
  await privateWrite(absoluteMirrorPath, redacted);
  const mirrorStat = await lstat(absoluteMirrorPath, { bigint: true });
  return {
    file: {
      fileId: row.id,
      relativePath,
      mirrorPath,
      mirrorSha256: sha256(Buffer.from(redacted, "utf8")),
      mirrorFsIdentity: `${mirrorStat.dev}:${mirrorStat.ino}:${mirrorStat.birthtimeNs}`,
      expectedHash: row.content_sha256,
      baselineText: redacted,
    },
    entitiesHidden: report.entitiesHidden,
  };
}

function companionMirrorText(
  row: WorkspaceMirrorRow,
  mirrorPath: string,
  extension: string,
  redactor: Redactor,
): { text: string; imagesBlocked: number; entitiesHidden: number } {
  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      text: `Image blocked by Cloud Privacy\nMirror path: ${mirrorPath}\nNo pixel data is present in this mirror.\n`,
      imagesBlocked: 1,
      entitiesHidden: 0,
    };
  }
  if (row.extracted_text === null) {
    return {
      text: `Binary file not exposed by Cloud Privacy\nMirror path: ${mirrorPath}\nUse an approved Arcelle tool for structured changes.\n`,
      imagesBlocked: 0,
      entitiesHidden: 0,
    };
  }
  const report = emptyPrivacyReport();
  return {
    text: redactor.redact(stripEmbeddedImages(row.extracted_text), report),
    imagesBlocked: 0,
    entitiesHidden: report.entitiesHidden,
  };
}

async function mirrorRow(
  workspace: WorkspaceService,
  workspacePath: string,
  companionRoot: string,
  row: WorkspaceMirrorRow,
  mirrorPath: string,
  redactor: Redactor,
): Promise<MirrorRowResult> {
  const relativePath = normalizeRelativePath(row.relative_path);
  if (isTextPath(relativePath) && row.size_bytes <= MAX_EDITABLE_TEXT_BYTES) {
    const editable = await editableMirrorFile(
      workspace,
      workspacePath,
      row,
      relativePath,
      mirrorPath,
      redactor,
    );
    return {
      editable: editable.file,
      companionFiles: 0,
      imagesBlocked: 0,
      entitiesHidden: editable.entitiesHidden,
    };
  }
  const extension = path.posix.extname(relativePath).toLocaleLowerCase("en-US");
  const companionPath = normalizeRelativePath(
    path.posix.join(companionRoot, `${mirrorPath}.txt`),
  );
  const companion = companionMirrorText(row, mirrorPath, extension, redactor);
  await privateWrite(
    resolveWorkspacePath(workspacePath, companionPath),
    companion.text,
  );
  return {
    companionFiles: 1,
    imagesBlocked: companion.imagesBlocked,
    entitiesHidden: companion.entitiesHidden,
  };
}

async function mirrorWorkspaceRows(
  workspace: WorkspaceService,
  workspacePath: string,
  companionRoot: string,
  rows: readonly WorkspaceMirrorRow[],
  mirrorPaths: ReadonlyMap<string, string>,
  redactor: Redactor,
  editable: Map<string, EditableMirrorFile>,
): Promise<MirrorWriteStats> {
  const stats: MirrorWriteStats = {
    companionFiles: 0,
    imagesBlocked: 0,
    entitiesHidden: 0,
  };
  for (const row of rows) {
    const result = await mirrorRow(
      workspace,
      workspacePath,
      companionRoot,
      row,
      mirrorPaths.get(row.id)!,
      redactor,
    );
    if (result.editable !== undefined)
      editable.set(pathKey(result.editable.mirrorPath), result.editable);
    stats.companionFiles += result.companionFiles;
    stats.imagesBlocked += result.imagesBlocked;
    stats.entitiesHidden += result.entitiesHidden;
  }
  return stats;
}

function safeRuntimeDirectory(name: string, isDirectory: boolean): boolean {
  return isDirectory && /^[A-Za-z0-9_-]{1,100}$/.test(name);
}
async function runtimeDirectories(root: string): Promise<Dirent[]> {
  return readdir(root, { withFileTypes: true }).catch((): Dirent[] => []);
}

async function hasExpiredRuntime(
  runPath: string,
  now: number,
  olderThanMs: number,
): Promise<boolean> {
  const info = await stat(runPath).catch(() => null);
  return info !== null && now - info.mtimeMs >= olderThanMs;
}

async function cleanupRoomRuns(
  roomPath: string,
  now: number,
  olderThanMs: number,
): Promise<number> {
  let removed = 0;
  for (const run of await runtimeDirectories(roomPath)) {
    if (!safeRuntimeDirectory(run.name, run.isDirectory())) continue;
    const runPath = path.join(roomPath, run.name);
    if (!(await hasExpiredRuntime(runPath, now, olderThanMs))) continue;
    await rm(runPath, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** One per-run redacted filesystem exposure. Reverse mappings never enter it. */
export class CloudRedactedMirror {
  readonly runRoot: string;
  readonly workspacePath: string;
  private readonly editable = new Map<string, EditableMirrorFile>();
  private companionRoot = "_Arcelle Companions";
  private created = false;

  constructor(
    private readonly workspace: WorkspaceService,
    runtimeRoot: string,
    roomId: string,
    runId: string,
    private readonly policy: MirrorRedactionPolicy,
  ) {
    const runtime = path.resolve(runtimeRoot);
    const relative = path.relative(path.resolve(workspace.rootPath), runtime);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      throw new Error("The cloud runtime mirror must be outside the room.");
    }
    this.runRoot = path.join(
      runtime,
      safeId(roomId, "room id"),
      safeId(runId, "run id"),
    );
    this.workspacePath = path.join(this.runRoot, "workspace");
  }

  async create(): Promise<CloudMirrorInfo> {
    await assertMirrorCanCreate(this.created, this.runRoot);
    await prepareMirrorRoot(this.workspace, this.runRoot, this.workspacePath);
    const rows = workspaceMirrorRows(this.workspace);
    const allocation = allocateMirrorPaths(rows, this.policy.redactor);
    this.companionRoot = companionRootFor(allocation.allocatedPathKeys);
    const stats = await mirrorWorkspaceRows(
      this.workspace,
      this.workspacePath,
      this.companionRoot,
      rows,
      allocation.mirrorPaths,
      this.policy.redactor,
      this.editable,
    );
    this.created = true;
    return {
      workspacePath: this.workspacePath,
      editableFiles: this.editable.size,
      companionFiles: stats.companionFiles,
      imagesBlocked: stats.imagesBlocked,
      entitiesHidden: allocation.entitiesHidden + stats.entitiesHidden,
    };
  }

  async writeBack(
    allowProtectedDuplication = false,
  ): Promise<CloudMirrorWriteBack> {
    if (!this.created)
      throw new Error("The cloud mirror has not been created.");
    const { matched, edited } = await collectMirrorEdits(
      this.workspacePath,
      this.companionRoot,
      this.editable,
    );
    const duplicated = duplicatedProtectedTokens(
      edited,
      this.editable,
      this.policy,
    );
    if (duplicated.length > 0 && !allowProtectedDuplication) {
      return { updated: [], created: [], requiresReview: duplicated };
    }
    const plan = planMirrorMutations(
      edited,
      this.editable,
      matched,
      this.policy.redactor,
    );
    validateMirrorDestinations(this.workspace, plan);
    return applyMirrorPlan(this.workspace, plan, path.basename(this.runRoot));
  }

  async cleanup(): Promise<void> {
    await rm(this.runRoot, { recursive: true, force: true });
    this.created = false;
    this.editable.clear();
  }

  static async cleanupAbandoned(
    runtimeRoot: string,
    olderThanMs = 24 * 60 * 60 * 1_000,
  ): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const room of await runtimeDirectories(runtimeRoot)) {
      if (!safeRuntimeDirectory(room.name, room.isDirectory())) continue;
      const roomPath = path.join(runtimeRoot, room.name);
      removed += await cleanupRoomRuns(roomPath, now, olderThanMs);
    }
    return removed;
  }
}
export { EditableMirrorFile, MAX_EDITABLE_TEXT_BYTES, MirrorAddition, MirrorEdit, MirrorMatch, MirrorMove, MirrorMutationPlan, MirrorWrite, TEXT_EXTENSIONS };
