import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { emptyPrivacyReport, type PrivacyRule, type Redactor } from "../privacyRedact.js";
import { decodeTextBytes } from "../editMatchExtraction.js";
import { normalizeRelativePath, pathKey, resolveWorkspacePath } from "../workspace/pathSafety.js";
import { scanWorkspaceManifest } from "../workspace/manifest.js";
import type { WorkspaceService } from "../workspace/workspaceService.js";

const MAX_EDITABLE_TEXT_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
  ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log", ".srt",
  ".vtt", ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java",
  ".c", ".h", ".cpp", ".hpp", ".css", ".scss", ".sql", ".sh", ".zsh",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff", ".bmp", ".svg"]);

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

function safeRedactedPathSegment(value: string): string {
  const safe = value.replace(/[\\/\0]/g, "_").normalize("NFC").trim();
  return safe === "" || safe === "." || safe === ".." ? "_protected" : safe;
}

function redactedRelativePath(
  relativePath: string,
  redactor: Redactor,
  occupied: Set<string>,
): { relativePath: string; entitiesHidden: number } {
  const report = emptyPrivacyReport();
  const segments = relativePath.split("/").map((segment) =>
    safeRedactedPathSegment(redactor.redact(segment, report))
  );
  let candidate = normalizeRelativePath(segments.join("/"));
  const extension = path.posix.extname(candidate);
  const stem = candidate.slice(0, candidate.length - extension.length);
  for (let suffix = 2; occupied.has(pathKey(candidate)); suffix += 1) {
    candidate = `${stem} (${suffix})${extension}`;
  }
  occupied.add(pathKey(candidate));
  return { relativePath: candidate, entitiesHidden: report.entitiesHidden };
}

function restoredRelativePath(relativePath: string, redactor: Redactor): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalizeRelativePath(normalized.split("/").map((segment) =>
    safeRedactedPathSegment(redactor.restore(segment))
  ).join("/"));
}

export interface CloudMirrorInfo {
  workspacePath: string;
  editableFiles: number;
  companionFiles: number;
  imagesBlocked: number;
  entitiesHidden: number;
}

export interface CloudMirrorWriteBack {
  updated: string[];
  created: string[];
  requiresReview: string[];
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error(`The ${label} is not safe for a runtime path.`);
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stripEmbeddedImages(text: string): string {
  return text.replace(
    /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu,
    "[Image blocked by Cloud Privacy]",
  );
}

function isTextPath(relativePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.posix.extname(relativePath).toLocaleLowerCase("en-US"));
}

function countToken(text: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(token, cursor)) !== -1) {
    count += 1;
    cursor += token.length;
  }
  return count;
}

function placeholderLabels(rules: readonly PrivacyRule[]): Set<string> {
  const labels = new Set<string>();
  for (const [, placeholder] of rules) {
    const match = /^\[([^\]\d]+?)(?:\s+[A-Z0-9]+)?\]$/u.exec(placeholder);
    if (match?.[1]) labels.add(match[1].trim());
  }
  return labels;
}

function unknownPlaceholders(
  text: string,
  known: ReadonlySet<string>,
  labels: ReadonlySet<string>,
): string[] {
  if (labels.size === 0) return [];
  const unknown = new Set<string>();
  for (const match of text.matchAll(/\[([^\]\r\n]{1,64})\]/gu)) {
    const token = match[0];
    const body = match[1]!.trim();
    if (known.has(token)) continue;
    if ([...labels].some((label) => body === label || body.startsWith(`${label} `))) unknown.add(token);
  }
  return [...unknown];
}

async function privateWrite(destination: string, text: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("The cloud runtime mirror must be outside the room.");
    }
    this.runRoot = path.join(runtime, safeId(roomId, "room id"), safeId(runId, "run id"));
    this.workspacePath = path.join(this.runRoot, "workspace");
  }

  async create(): Promise<CloudMirrorInfo> {
    if (this.created) throw new Error("This cloud mirror already exists.");
    if (await lstat(this.runRoot).then(() => true, () => false)) {
      throw new Error("A cloud runtime folder already exists for this run.");
    }
    await this.workspace.reconcile();
    await mkdir(this.workspacePath, { recursive: true, mode: 0o700 });
    await chmod(this.runRoot, 0o700);
    await chmod(this.workspacePath, 0o700);
    const rows = this.workspace.db.prepare(
      `SELECT id, relative_path, content_sha256, size_bytes, extracted_text
       FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL
       ORDER BY relative_path`,
    ).all() as Array<{
      id: string;
      relative_path: string;
      content_sha256: string;
      size_bytes: number;
      extracted_text: string | null;
    }>;
    const allocatedPaths = new Set<string>();
    const mirrorPaths = new Map<string, string>();
    let entitiesHidden = 0;
    for (const row of rows) {
      const original = normalizeRelativePath(row.relative_path);
      const redacted = redactedRelativePath(original, this.policy.redactor, allocatedPaths);
      mirrorPaths.set(row.id, redacted.relativePath);
      entitiesHidden += redacted.entitiesHidden;
    }
    const occupiedPaths = [...allocatedPaths];
    for (let suffix = 1; suffix <= 10_000; suffix += 1) {
      const candidate = suffix === 1 ? "_Arcelle Companions" : `_Arcelle Companions (${suffix})`;
      const candidateKey = pathKey(candidate);
      if (!occupiedPaths.some((key) => key === candidateKey || key.startsWith(`${candidateKey}/`))) {
        this.companionRoot = candidate;
        break;
      }
    }
    let companionFiles = 0;
    let imagesBlocked = 0;
    for (const row of rows) {
      const relativePath = normalizeRelativePath(row.relative_path);
      const mirrorPath = mirrorPaths.get(row.id)!;
      const extension = path.posix.extname(relativePath).toLocaleLowerCase("en-US");
      if (isTextPath(relativePath) && row.size_bytes <= MAX_EDITABLE_TEXT_BYTES) {
        const bytes = await this.workspace.readBuffer(row.id);
        if (sha256(bytes) !== row.content_sha256) throw new Error(`The room changed while mirroring ${relativePath}.`);
        const report = emptyPrivacyReport();
        const redacted = this.policy.redactor.redact(stripEmbeddedImages(decodeTextBytes(bytes)), report);
        entitiesHidden += report.entitiesHidden;
        const absoluteMirrorPath = resolveWorkspacePath(this.workspacePath, mirrorPath);
        await privateWrite(absoluteMirrorPath, redacted);
        const mirrorStat = await lstat(absoluteMirrorPath, { bigint: true });
        this.editable.set(pathKey(mirrorPath), {
          fileId: row.id,
          relativePath,
          mirrorPath,
          mirrorSha256: sha256(Buffer.from(redacted, "utf8")),
          mirrorFsIdentity: `${mirrorStat.dev}:${mirrorStat.ino}:${mirrorStat.birthtimeNs}`,
          expectedHash: row.content_sha256,
          baselineText: redacted,
        });
        continue;
      }

      const companionPath = normalizeRelativePath(path.posix.join(this.companionRoot, `${mirrorPath}.txt`));
      let companion: string;
      if (IMAGE_EXTENSIONS.has(extension)) {
        imagesBlocked += 1;
        companion = `Image blocked by Cloud Privacy\nMirror path: ${mirrorPath}\nNo pixel data is present in this mirror.\n`;
      } else if (row.extracted_text !== null) {
        const report = emptyPrivacyReport();
        companion = this.policy.redactor.redact(stripEmbeddedImages(row.extracted_text), report);
        entitiesHidden += report.entitiesHidden;
      } else {
        companion = `Binary file not exposed by Cloud Privacy\nMirror path: ${mirrorPath}\nUse an approved Arcelle tool for structured changes.\n`;
      }
      await privateWrite(resolveWorkspacePath(this.workspacePath, companionPath), companion);
      companionFiles += 1;
    }
    this.created = true;
    return {
      workspacePath: this.workspacePath,
      editableFiles: this.editable.size,
      companionFiles,
      imagesBlocked,
      entitiesHidden,
    };
  }

  async writeBack(allowProtectedDuplication = false): Promise<CloudMirrorWriteBack> {
    if (!this.created) throw new Error("The cloud mirror has not been created.");
    const manifest = await scanWorkspaceManifest(this.workspacePath);
    const knownTokens = new Set(this.policy.rules.map(([, placeholder]) => placeholder));
    const labels = placeholderLabels(this.policy.rules);
    const baselineAll = [...this.editable.values()]
      .flatMap((entry) => [entry.baselineText, entry.mirrorPath])
      .join("\n");
    const companionPrefix = `${pathKey(this.companionRoot)}/`;
    const visibleManifest = new Map(
      [...manifest].filter(([key]) => !key.startsWith(companionPrefix)),
    );
    const matched = new Map<string, { entry: EditableMirrorFile; currentPath: string; currentKey: string }>();
    const claimedCurrentKeys = new Set<string>();

    // Same-path files are unambiguous even when an editor replaced the inode.
    for (const [key, entry] of this.editable) {
      const current = visibleManifest.get(key);
      if (current === undefined) continue;
      matched.set(key, { entry, currentPath: current.relativePath, currentKey: key });
      claimedCurrentKeys.add(key);
    }

    // A rename preserves filesystem identity. Exact redacted bytes are a safe
    // fallback only when they identify one missing baseline and one new path.
    // We never guess between identical candidates.
    for (const [baselineKey, entry] of this.editable) {
      if (matched.has(baselineKey)) continue;
      const available = [...visibleManifest.values()].filter((candidate) =>
        !claimedCurrentKeys.has(candidate.pathKey) && isTextPath(candidate.relativePath),
      );
      let candidates = available.filter((candidate) => candidate.fsIdentity === entry.mirrorFsIdentity);
      if (candidates.length === 0) {
        candidates = available.filter((candidate) => candidate.sha256 === entry.mirrorSha256);
      }
      if (candidates.length !== 1) continue;
      const candidate = candidates[0]!;
      matched.set(baselineKey, {
        entry,
        currentPath: candidate.relativePath,
        currentKey: candidate.pathKey,
      });
      claimedCurrentKeys.add(candidate.pathKey);
    }

    const createdPaths = [...visibleManifest.values()]
      .filter((entry) => !claimedCurrentKeys.has(entry.pathKey));
    const edited = new Map<string, { text: string; relativePath: string; baseline?: EditableMirrorFile }>();
    for (const match of matched.values()) {
      edited.set(match.currentKey, {
        text: await readFile(resolveWorkspacePath(this.workspacePath, match.currentPath), "utf8"),
        relativePath: match.currentPath,
        baseline: match.entry,
      });
    }
    for (const entry of createdPaths) {
      if (!isTextPath(entry.relativePath) || entry.sizeBytes > MAX_EDITABLE_TEXT_BYTES) {
        throw new Error(`Cloud write-back only accepts new text files: ${entry.relativePath}`);
      }
      edited.set(entry.pathKey, {
        text: await readFile(resolveWorkspacePath(this.workspacePath, entry.relativePath), "utf8"),
        relativePath: entry.relativePath,
      });
    }

    const editedAll = [
      ...[...edited.values()].flatMap((entry) => [entry.text, entry.relativePath]),
    ].join("\n");
    const unknown = unknownPlaceholders(editedAll, knownTokens, labels);
    if (unknown.length > 0) {
      throw new Error(`Cloud output contains unknown or damaged protected placeholders: ${unknown.join(", ")}`);
    }
    const duplicated = [...knownTokens].filter((token) =>
      countToken(editedAll, token) > countToken(baselineAll, token),
    );
    if (duplicated.length > 0 && !allowProtectedDuplication) {
      return { updated: [], created: [], requiresReview: duplicated };
    }

    const updated: string[] = [];
    const created: string[] = [];
    const moves: Array<{ baseline: EditableMirrorFile; destination: string; text: string }> = [];
    const writes: Array<{ baseline: EditableMirrorFile; text: string; displayedPath: string }> = [];
    const additions: Array<{ destination: string; text: string }> = [];
    const deleted = [...this.editable.entries()]
      .filter(([key]) => !matched.has(key))
      .map(([, entry]) => entry);

    // Restore and validate every destination and every protected value before
    // the first real workspace mutation. This keeps malformed cloud output
    // from producing a partially applied run.
    for (const item of edited.values()) {
      const restored = this.policy.redactor.restore(item.text);
      const destination = restoredRelativePath(item.relativePath, this.policy.redactor);
      const baseline = item.baseline;
      if (baseline !== undefined) {
        if (destination !== baseline.relativePath) {
          moves.push({ baseline, destination, text: restored });
        } else if (item.text !== baseline.baselineText) {
          writes.push({ baseline, text: restored, displayedPath: baseline.relativePath });
        }
      } else {
        additions.push({ destination, text: restored });
      }
    }

    const occupied = new Set((this.workspace.db.prepare(
      `SELECT path_key FROM files
       WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key IS NOT NULL`,
    ).all() as Array<{ path_key: string }>).map((row) => row.path_key));
    for (const baseline of [...deleted, ...moves.map((move) => move.baseline)]) {
      occupied.delete(pathKey(baseline.relativePath));
    }
    for (const destination of [
      ...moves.map((move) => move.destination),
      ...additions.map((addition) => addition.destination),
    ]) {
      const key = pathKey(destination);
      if (occupied.has(key)) {
        throw new Error(`Cloud write-back destination already exists: ${destination}`);
      }
      occupied.add(key);
    }

    // Apply chains from their free end (B -> C before A -> B). A cycle has
    // no collision-free order through WorkspaceService and must fail closed.
    const orderedMoves: typeof moves = [];
    const pendingMoves = [...moves];
    while (pendingMoves.length > 0) {
      const nextIndex = pendingMoves.findIndex((candidate) =>
        !pendingMoves.some((other) =>
          other !== candidate && pathKey(other.baseline.relativePath) === pathKey(candidate.destination)
        )
      );
      if (nextIndex === -1) throw new Error("Cloud write-back cannot safely apply a file-move cycle.");
      orderedMoves.push(pendingMoves.splice(nextIndex, 1)[0]!);
    }

    for (const baseline of deleted) {
      await this.workspace.trash(baseline.fileId, baseline.expectedHash);
    }
    for (const move of orderedMoves) {
      await this.workspace.move(move.baseline.fileId, move.destination, move.baseline.expectedHash);
      if (move.text !== move.baseline.baselineText) {
        await this.workspace.writeAtomic(
          move.baseline.fileId,
          Readable.from([Buffer.from(move.text, "utf8")]),
          move.baseline.expectedHash,
        );
        this.workspace.db.prepare(
          `UPDATE files SET extracted_text = ?, provenance = ? WHERE id = ?`,
        ).run(move.text, JSON.stringify({ kind: "cloud-mirror", runId: path.basename(this.runRoot) }), move.baseline.fileId);
      }
      updated.push(move.destination);
    }
    for (const write of writes) {
      await this.workspace.writeAtomic(
        write.baseline.fileId,
        Readable.from([Buffer.from(write.text, "utf8")]),
        write.baseline.expectedHash,
      );
      this.workspace.db.prepare(
        `UPDATE files SET extracted_text = ?, provenance = ? WHERE id = ?`,
      ).run(write.text, JSON.stringify({ kind: "cloud-mirror", runId: path.basename(this.runRoot) }), write.baseline.fileId);
      updated.push(write.displayedPath);
    }
    for (const addition of additions) {
      await this.workspace.createFile(
        addition.destination,
        Readable.from([Buffer.from(addition.text, "utf8")]),
        "cloud-mirror",
      );
      created.push(addition.destination);
    }
    return { updated, created, requiresReview: [] };
  }

  async cleanup(): Promise<void> {
    await rm(this.runRoot, { recursive: true, force: true });
    this.created = false;
    this.editable.clear();
  }

  static async cleanupAbandoned(runtimeRoot: string, olderThanMs = 24 * 60 * 60 * 1_000): Promise<number> {
    let removed = 0;
    const now = Date.now();
    const rooms = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => []);
    for (const room of rooms) {
      if (!room.isDirectory() || !/^[A-Za-z0-9_-]{1,100}$/.test(room.name)) continue;
      const roomPath = path.join(runtimeRoot, room.name);
      const runs = await readdir(roomPath, { withFileTypes: true }).catch(() => []);
      for (const run of runs) {
        if (!run.isDirectory() || !/^[A-Za-z0-9_-]{1,100}$/.test(run.name)) continue;
        const runPath = path.join(roomPath, run.name);
        const info = await stat(runPath).catch(() => null);
        if (info !== null && now - info.mtimeMs >= olderThanMs) {
          await rm(runPath, { recursive: true, force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }
}
