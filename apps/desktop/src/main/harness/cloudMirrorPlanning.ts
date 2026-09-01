import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { emptyPrivacyReport, type PrivacyRule, type Redactor } from "../privacyRedact.js";
import { normalizeRelativePath, pathKey, resolveWorkspacePath } from "../workspace/pathSafety.js";
import { scanWorkspaceManifest } from "../workspace/manifest.js";
import type { ManifestEntry } from "../workspace/types.js";
import type { WorkspaceService } from "../workspace/workspaceService.js";
import { EditableMirrorFile, MAX_EDITABLE_TEXT_BYTES, MirrorAddition, MirrorEdit, MirrorMatch, MirrorMove, MirrorMutationPlan, MirrorRedactionPolicy, MirrorWrite, TEXT_EXTENSIONS } from "./cloudMirror.js";

export function safeRedactedPathSegment(value: string): string {
  const safe = value
    .replace(/[\\/\0]/g, "_")
    .normalize("NFC")
    .trim();
  return safe === "" || safe === "." || safe === ".." ? "_protected" : safe;
}
export function redactedRelativePath(
  relativePath: string,
  redactor: Redactor,
  occupied: Set<string>,
): { relativePath: string; entitiesHidden: number } {
  const report = emptyPrivacyReport();
  const segments = relativePath
    .split("/")
    .map((segment) =>
      safeRedactedPathSegment(redactor.redact(segment, report)),
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
export function restoredRelativePath(
  relativePath: string,
  redactor: Redactor,
): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalizeRelativePath(
    normalized
      .split("/")
      .map((segment) => safeRedactedPathSegment(redactor.restore(segment)))
      .join("/"),
  );
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
export function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error(`The ${label} is not safe for a runtime path.`);
  return value;
}
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function stripEmbeddedImages(text: string): string {
  return text.replace(
    /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu,
    "[Image blocked by Cloud Privacy]",
  );
}
export function isTextPath(relativePath: string): boolean {
  return TEXT_EXTENSIONS.has(
    path.posix.extname(relativePath).toLocaleLowerCase("en-US"),
  );
}
export function countToken(text: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(token, cursor)) !== -1) {
    count += 1;
    cursor += token.length;
  }
  return count;
}
export function placeholderLabels(rules: readonly PrivacyRule[]): Set<string> {
  const labels = new Set<string>();
  for (const [, placeholder] of rules) {
    const match = /^\[([^\]\d]+?)(?:\s+[A-Z0-9]+)?\]$/u.exec(placeholder);
    if (match?.[1]) labels.add(match[1].trim());
  }
  return labels;
}
export function unknownPlaceholders(
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
    if (
      [...labels].some(
        (label) => body === label || body.startsWith(`${label} `),
      )
    )
      unknown.add(token);
  }
  return [...unknown];
}
export async function privateWrite(destination: string, text: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, text, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}
export function visibleMirrorManifest(
  manifest: ReadonlyMap<string, ManifestEntry>,
  companionRoot: string,
): Map<string, ManifestEntry> {
  const companionPrefix = `${pathKey(companionRoot)}/`;
  return new Map(
    [...manifest].filter(([key]) => !key.startsWith(companionPrefix)),
  );
}
export function matchOriginalMirrorPaths(
  editable: ReadonlyMap<string, EditableMirrorFile>,
  manifest: ReadonlyMap<string, ManifestEntry>,
): { matched: Map<string, MirrorMatch>; claimed: Set<string> } {
  const matched = new Map<string, MirrorMatch>();
  const claimed = new Set<string>();
  for (const [key, entry] of editable) {
    const current = manifest.get(key);
    if (current === undefined) continue;
    matched.set(key, {
      entry,
      currentPath: current.relativePath,
      currentKey: key,
    });
    claimed.add(key);
  }
  return { matched, claimed };
}
export function uniqueRenamedMirrorFile(
  manifest: ReadonlyMap<string, ManifestEntry>,
  claimed: ReadonlySet<string>,
  entry: EditableMirrorFile,
): ManifestEntry | undefined {
  const available = [...manifest.values()].filter(
    (candidate) =>
      !claimed.has(candidate.pathKey) && isTextPath(candidate.relativePath),
  );
  const sameIdentity = available.filter(
    (candidate) => candidate.fsIdentity === entry.mirrorFsIdentity,
  );
  if (sameIdentity.length > 0)
    return sameIdentity.length === 1 ? sameIdentity[0] : undefined;
  const sameBytes = available.filter(
    (candidate) => candidate.sha256 === entry.mirrorSha256,
  );
  return sameBytes.length === 1 ? sameBytes[0] : undefined;
}
export function matchRenamedMirrorPaths(
  editable: ReadonlyMap<string, EditableMirrorFile>,
  manifest: ReadonlyMap<string, ManifestEntry>,
  matched: Map<string, MirrorMatch>,
  claimed: Set<string>,
): void {
  for (const [baselineKey, entry] of editable) {
    if (matched.has(baselineKey)) continue;
    const candidate = uniqueRenamedMirrorFile(manifest, claimed, entry);
    if (candidate === undefined) continue;
    matched.set(baselineKey, {
      entry,
      currentPath: candidate.relativePath,
      currentKey: candidate.pathKey,
    });
    claimed.add(candidate.pathKey);
  }
}
export function matchMirrorFiles(
  editable: ReadonlyMap<string, EditableMirrorFile>,
  manifest: ReadonlyMap<string, ManifestEntry>,
): { matched: Map<string, MirrorMatch>; claimed: Set<string> } {
  const result = matchOriginalMirrorPaths(editable, manifest);
  matchRenamedMirrorPaths(editable, manifest, result.matched, result.claimed);
  return result;
}
export function unclaimedManifestFiles(
  manifest: ReadonlyMap<string, ManifestEntry>,
  claimed: ReadonlySet<string>,
): ManifestEntry[] {
  return [...manifest.values()].filter((entry) => !claimed.has(entry.pathKey));
}
export async function readMatchedMirrorEdits(
  workspacePath: string,
  matched: ReadonlyMap<string, MirrorMatch>,
  edited: Map<string, MirrorEdit>,
): Promise<void> {
  for (const match of matched.values()) {
    edited.set(match.currentKey, {
      text: await readFile(
        resolveWorkspacePath(workspacePath, match.currentPath),
        "utf8",
      ),
      relativePath: match.currentPath,
      baseline: match.entry,
    });
  }
}
export async function readAddedMirrorEdits(
  workspacePath: string,
  entries: readonly ManifestEntry[],
  edited: Map<string, MirrorEdit>,
): Promise<void> {
  for (const entry of entries) {
    if (
      !isTextPath(entry.relativePath) ||
      entry.sizeBytes > MAX_EDITABLE_TEXT_BYTES
    ) {
      throw new Error(
        `Cloud write-back only accepts new text files: ${entry.relativePath}`,
      );
    }
    edited.set(entry.pathKey, {
      text: await readFile(
        resolveWorkspacePath(workspacePath, entry.relativePath),
        "utf8",
      ),
      relativePath: entry.relativePath,
    });
  }
}
export async function readMirrorEdits(
  workspacePath: string,
  matched: ReadonlyMap<string, MirrorMatch>,
  createdPaths: readonly ManifestEntry[],
): Promise<Map<string, MirrorEdit>> {
  const edited = new Map<string, MirrorEdit>();
  await readMatchedMirrorEdits(workspacePath, matched, edited);
  await readAddedMirrorEdits(workspacePath, createdPaths, edited);
  return edited;
}
export async function collectMirrorEdits(
  workspacePath: string,
  companionRoot: string,
  editable: ReadonlyMap<string, EditableMirrorFile>,
): Promise<{
  matched: Map<string, MirrorMatch>;
  edited: Map<string, MirrorEdit>;
}> {
  const manifest = await scanWorkspaceManifest(workspacePath);
  const visible = visibleMirrorManifest(manifest, companionRoot);
  const { matched, claimed } = matchMirrorFiles(editable, visible);
  const edited = await readMirrorEdits(
    workspacePath,
    matched,
    unclaimedManifestFiles(visible, claimed),
  );
  return { matched, edited };
}
export function joinedMirrorValues(
  values: Iterable<{ text: string; relativePath: string }>,
): string {
  return [...values]
    .flatMap((entry) => [entry.text, entry.relativePath])
    .join("\n");
}
export function joinedMirrorBaselines(
  editable: ReadonlyMap<string, EditableMirrorFile>,
): string {
  return [...editable.values()]
    .flatMap((entry) => [entry.baselineText, entry.mirrorPath])
    .join("\n");
}
export function duplicatedProtectedTokens(
  edited: ReadonlyMap<string, MirrorEdit>,
  editable: ReadonlyMap<string, EditableMirrorFile>,
  policy: MirrorRedactionPolicy,
): string[] {
  const knownTokens = new Set(
    policy.rules.map(([, placeholder]) => placeholder),
  );
  const editedAll = joinedMirrorValues(edited.values());
  const unknown = unknownPlaceholders(
    editedAll,
    knownTokens,
    placeholderLabels(policy.rules),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Cloud output contains unknown or damaged protected placeholders: ${unknown.join(", ")}`,
    );
  }
  const baselineAll = joinedMirrorBaselines(editable);
  return [...knownTokens].filter(
    (token) => countToken(editedAll, token) > countToken(baselineAll, token),
  );
}
export function deletedMirrorFiles(
  editable: ReadonlyMap<string, EditableMirrorFile>,
  matched: ReadonlyMap<string, MirrorMatch>,
): EditableMirrorFile[] {
  return [...editable.entries()]
    .filter(([key]) => !matched.has(key))
    .map(([, entry]) => entry);
}
export function planMirrorMutations(
  edited: ReadonlyMap<string, MirrorEdit>,
  editable: ReadonlyMap<string, EditableMirrorFile>,
  matched: ReadonlyMap<string, MirrorMatch>,
  redactor: Redactor,
): MirrorMutationPlan {
  const moves: MirrorMove[] = [];
  const writes: MirrorWrite[] = [];
  const additions: MirrorAddition[] = [];
  for (const item of edited.values()) {
    const restored = redactor.restore(item.text);
    const destination = restoredRelativePath(item.relativePath, redactor);
    if (item.baseline === undefined) {
      additions.push({ destination, text: restored });
      continue;
    }
    if (destination !== item.baseline.relativePath) {
      moves.push({ baseline: item.baseline, destination, text: restored });
    } else if (item.text !== item.baseline.baselineText) {
      writes.push({
        baseline: item.baseline,
        text: restored,
        displayedPath: item.baseline.relativePath,
      });
    }
  }
  return {
    deleted: deletedMirrorFiles(editable, matched),
    moves,
    writes,
    additions,
  };
}
export function occupiedWorkspacePaths(workspace: WorkspaceService): Set<string> {
  const rows = workspace.db
    .prepare(
      `SELECT path_key FROM files
     WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key IS NOT NULL`,
    )
    .all() as Array<{ path_key: string }>;
  return new Set(rows.map((row) => row.path_key));
}
export function releaseMovedDestinations(
  occupied: Set<string>,
  plan: MirrorMutationPlan,
): void {
  for (const baseline of [
    ...plan.deleted,
    ...plan.moves.map((move) => move.baseline),
  ]) {
    occupied.delete(pathKey(baseline.relativePath));
  }
}
export function reserveNewDestinations(
  occupied: Set<string>,
  plan: MirrorMutationPlan,
): void {
  for (const destination of [
    ...plan.moves.map((move) => move.destination),
    ...plan.additions.map((addition) => addition.destination),
  ]) {
    const key = pathKey(destination);
    if (occupied.has(key))
      throw new Error(
        `Cloud write-back destination already exists: ${destination}`,
      );
    occupied.add(key);
  }
}
export function validateMirrorDestinations(
  workspace: WorkspaceService,
  plan: MirrorMutationPlan,
): void {
  const occupied = occupiedWorkspacePaths(workspace);
  releaseMovedDestinations(occupied, plan);
  reserveNewDestinations(occupied, plan);
}
export function orderMirrorMoves(moves: readonly MirrorMove[]): MirrorMove[] {
  const ordered: MirrorMove[] = [];
  const pending = [...moves];
  while (pending.length > 0) {
    const nextIndex = pending.findIndex(
      (candidate) =>
        !pending.some(
          (other) =>
            other !== candidate &&
            pathKey(other.baseline.relativePath) ===
              pathKey(candidate.destination),
        ),
    );
    if (nextIndex === -1)
      throw new Error(
        "Cloud write-back cannot safely apply a file-move cycle.",
      );
    ordered.push(pending.splice(nextIndex, 1)[0]!);
  }
  return ordered;
}
export function cloudMirrorProvenance(runId: string): string {
  return JSON.stringify({ kind: "cloud-mirror", runId });
}
export function updateCloudMirrorMetadata(
  workspace: WorkspaceService,
  fileId: string,
  text: string,
  provenance: string,
): void {
  workspace.db
    .prepare(`UPDATE files SET extracted_text = ?, provenance = ? WHERE id = ?`)
    .run(text, provenance, fileId);
}
export function textStream(text: string): Readable {
  return Readable.from([Buffer.from(text, "utf8")]);
}
