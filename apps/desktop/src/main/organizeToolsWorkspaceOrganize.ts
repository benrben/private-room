import type Database from "better-sqlite3-multiple-ciphers";
import path from "node:path";
import { Readable } from "node:stream";
import {
  availableName,
  findFileLikeQualified,
  getFileExtractedText,
  setFileExtractedText,
} from "./db-host/files.js";
import { MAX_BULK_FILES, organizeSentence, type OrganizeEntry, type OrganizeReport } from "./organize.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import {
  asBoolDefault,
  asString,
  emitSafely,
  errMessage,
  extensionOf,
  fail,
  ok,
  parseOrganizeEntries,
  parseStringArray,
  type EmitFn,
  type OrganizeToolOutcome,
} from "./organizeToolsModel.js";
import { workspaceRow } from "./organizeToolsWorkspaceCore.js";
import { meansTopLevel } from "./organizeToolsCommitted.js";

type WorkspaceOrganizeRequest = {
  entries: OrganizeEntry[];
  make: string[];
  remove: string[];
  dryRun: boolean;
};

type WorkspaceFilePlan = {
  finalName: string;
  targetParent: string;
  destination: string;
  renamed: boolean;
  folderWasSpecified: boolean;
};

export function workspaceOrganizeRequest(
  args: Record<string, unknown>,
): WorkspaceOrganizeRequest {
  return {
    entries: parseOrganizeEntries(args.files),
    make: parseStringArray(args.make_folders),
    remove: parseStringArray(args.remove_folders),
    dryRun: asBoolDefault(args.dry_run, false),
  };
}

export function workspaceOrganizeRequestIsEmpty(
  request: WorkspaceOrganizeRequest,
): boolean {
  return (
    request.entries.length === 0 &&
    request.make.length === 0 &&
    request.remove.length === 0
  );
}

export function workspaceOrganizeReport(
  request: WorkspaceOrganizeRequest,
): OrganizeReport {
  return {
    moved: [],
    renamed: [],
    foldersMade: [],
    foldersRemoved: [],
    failed: [],
    capped:
      Math.max(0, request.entries.length - MAX_BULK_FILES) +
      Math.max(0, request.make.length - MAX_BULK_FILES) +
      Math.max(0, request.remove.length - MAX_BULK_FILES),
  };
}

export function shouldSkipWorkspaceFolder(folder: string): boolean {
  return folder === "" || meansTopLevel(folder);
}

export async function createWorkspaceOrganizeFolders(
  workspace: WorkspaceService,
  folders: string[],
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  for (const rawFolder of folders.slice(0, MAX_BULK_FILES)) {
    await createWorkspaceOrganizeFolder(
      workspace,
      rawFolder.trim(),
      dryRun,
      report,
    );
  }
}

export async function createWorkspaceOrganizeFolder(
  workspace: WorkspaceService,
  folder: string,
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  if (shouldSkipWorkspaceFolder(folder)) return;
  try {
    const state = await workspace.directoryState(folder);
    if (state.exists) return;
    const created = dryRun || (await workspace.createDirectory(folder));
    if (created) report.foldersMade.push(`"${state.relativePath}"`);
  } catch (error) {
    report.failed.push({ name: folder, error: errMessage(error) });
  }
}

export function requestedWorkspaceFileName(entry: OrganizeEntry): string {
  return entry.newName === undefined || entry.newName === null
    ? ""
    : entry.newName.trim();
}

export function finalWorkspaceFileName(
  realName: string,
  requestedName: string,
): string {
  if (requestedName === "") return realName;
  const needsOriginalExtension =
    extensionOf(requestedName) === "" && extensionOf(realName) !== "";
  return needsOriginalExtension
    ? `${requestedName}.${extensionOf(realName)}`
    : requestedName;
}

export function workspaceTargetParent(
  entry: OrganizeEntry,
  currentParent: string,
): string {
  if (entry.folder === undefined || entry.folder === null) return currentParent;
  return meansTopLevel(entry.folder) ? "." : entry.folder.trim();
}

export function planWorkspaceFile(
  entry: OrganizeEntry,
  realName: string,
  relativePath: string,
): WorkspaceFilePlan {
  const requestedName = requestedWorkspaceFileName(entry);
  const finalName = finalWorkspaceFileName(realName, requestedName);
  const targetParent = workspaceTargetParent(
    entry,
    path.posix.dirname(relativePath),
  );
  return {
    finalName,
    targetParent,
    destination:
      targetParent === "."
        ? finalName
        : path.posix.join(targetParent, finalName),
    renamed: requestedName !== "",
    folderWasSpecified: entry.folder !== undefined && entry.folder !== null,
  };
}

export function reportWorkspaceFilePlan(
  report: OrganizeReport,
  realName: string,
  plan: WorkspaceFilePlan,
  currentPath: string,
): void {
  if (plan.renamed) report.renamed.push(`"${realName}" → "${plan.finalName}"`);
  if (plan.destination === currentPath || !plan.folderWasSpecified) return;
  const target =
    plan.targetParent === "." ? "top level" : `"${plan.targetParent}"`;
  report.moved.push(`"${realName}" → ${target}`);
}

export async function organizeWorkspaceEntries(
  db: Database.Database,
  workspace: WorkspaceService,
  entries: OrganizeEntry[],
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  for (const entry of entries.slice(0, MAX_BULK_FILES)) {
    await organizeWorkspaceEntry(db, workspace, entry, dryRun, report);
  }
}

export async function organizeWorkspaceEntry(
  db: Database.Database,
  workspace: WorkspaceService,
  entry: OrganizeEntry,
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  try {
    const name = workspaceOrganizeEntryName(entry);
    const [id, realName] = findFileLikeQualified(db, name);
    const row = workspaceRow(db, id);
    const plan = planWorkspaceFile(entry, realName, row.relativePath);
    reportWorkspaceFilePlan(report, realName, plan, row.relativePath);
    await moveWorkspaceOrganizeEntry(
      workspace,
      id,
      plan.destination,
      row,
      dryRun,
    );
  } catch (error) {
    report.failed.push({
      name: workspaceOrganizeEntryName(entry),
      error: errMessage(error),
    });
  }
}

export function workspaceOrganizeEntryName(entry: OrganizeEntry): string {
  return entry.name ?? "";
}

export async function moveWorkspaceOrganizeEntry(
  workspace: WorkspaceService,
  id: string,
  destination: string,
  row: { relativePath: string; hash: string | null },
  dryRun: boolean,
): Promise<void> {
  if (dryRun || destination === row.relativePath) return;
  await workspace.move(id, destination, workspaceExpectedHash(row.hash));
}

export function workspaceExpectedHash(hash: string | null): string | undefined {
  return hash === null ? undefined : hash;
}

export async function removeWorkspaceOrganizeFolders(
  workspace: WorkspaceService,
  folders: string[],
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  for (const rawFolder of folders.slice(0, MAX_BULK_FILES)) {
    await removeWorkspaceOrganizeFolder(
      workspace,
      rawFolder.trim(),
      dryRun,
      report,
    );
  }
}

export async function removeWorkspaceOrganizeFolder(
  workspace: WorkspaceService,
  folder: string,
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  if (folder === "") return;
  if (rejectWorkspaceTopLevelRemoval(folder, report)) return;
  try {
    const state = await workspace.directoryState(folder);
    await removeEmptyWorkspaceFolder(workspace, folder, state, dryRun, report);
  } catch (error) {
    report.failed.push({ name: folder, error: errMessage(error) });
  }
}

export function rejectWorkspaceTopLevelRemoval(
  folder: string,
  report: OrganizeReport,
): boolean {
  if (!meansTopLevel(folder)) return false;
  report.failed.push({
    name: folder,
    error: "the workspace top level cannot be removed",
  });
  return true;
}

export async function removeEmptyWorkspaceFolder(
  workspace: WorkspaceService,
  folder: string,
  state: { relativePath: string; exists: boolean; empty: boolean },
  dryRun: boolean,
  report: OrganizeReport,
): Promise<void> {
  const refusal = workspaceFolderRemovalRefusal(state);
  if (refusal) {
    report.failed.push({ name: folder, error: refusal });
    return;
  }
  const removed = dryRun || (await workspace.removeDirectory(folder));
  if (removed) report.foldersRemoved.push(`"${state.relativePath}"`);
}

export function workspaceFolderRemovalRefusal(state: {
  exists: boolean;
  empty: boolean;
}): string | null {
  if (!state.exists) return "no folder by that path";
  return state.empty ? null : "the folder is not empty";
}

export function workspaceOrganizeChanged(report: OrganizeReport): boolean {
  return (
    report.moved.length > 0 ||
    report.renamed.length > 0 ||
    report.foldersMade.length > 0 ||
    report.foldersRemoved.length > 0
  );
}

export async function execOrganizeFilesWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const request = workspaceOrganizeRequest(args);
  if (workspaceOrganizeRequestIsEmpty(request)) {
    return fail(
      "organize_files needs at least one entry in files, make_folders or remove_folders.",
    );
  }
  const report = workspaceOrganizeReport(request);
  await createWorkspaceOrganizeFolders(
    workspace,
    request.make,
    request.dryRun,
    report,
  );
  await organizeWorkspaceEntries(
    db,
    workspace,
    request.entries,
    request.dryRun,
    report,
  );
  await removeWorkspaceOrganizeFolders(
    workspace,
    request.remove,
    request.dryRun,
    report,
  );
  if (!request.dryRun) {
    effects.wrote ||= workspaceOrganizeChanged(report);
    emitSafely(emit, "room-files-changed", undefined);
  }
  return ok(organizeSentence(report, request.dryRun, ""));
}

type MergeSource = { id: string; name: string; text: string };

export function readableMergeSource(db: Database.Database, name: string): MergeSource | null {
  try {
    const [id, realName] = findFileLikeQualified(db, name);
    const text = getFileExtractedText(db, id)?.trim();
    return text === undefined || text === "" ? null : { id, name: realName, text };
  } catch {
    return null;
  }
}

export function readableMergeSources(db: Database.Database, names: readonly string[]): MergeSource[] {
  const sources: MergeSource[] = [];
  for (const name of names) {
    const source = readableMergeSource(db, name);
    if (source !== null) sources.push(source);
  }
  return sources;
}

export function mergedContent(sources: readonly MergeSource[], headings: boolean): string {
  return sources.map((source) => (headings ? `## ${source.name}\n\n${source.text}` : source.text)).join("\n\n");
}

export function mergedFileName(db: Database.Database, requested: string): string {
  if (requested === "") return availableName(db, "Merged notes.md");
  return availableName(db, extensionOf(requested) === "" ? `${requested}.md` : requested);
}

export async function trashMergeSources(
  db: Database.Database,
  workspace: WorkspaceService,
  sources: readonly MergeSource[],
): Promise<void> {
  for (const source of sources) {
    const row = workspaceRow(db, source.id);
    await workspace.trash(source.id, row.hash ?? undefined);
  }
}

export function mergedWorkspaceReceipt(
  sourceCount: number,
  name: string,
  content: string,
  trashSources: boolean,
): OrganizeToolOutcome {
  const suffix = trashSources ? " and moved the originals to the trash." : " — the originals are untouched.";
  return ok(`Merged ${sourceCount} files into "${name}" (${[...content].length} characters)${suffix}`);
}

export async function execMergeFilesWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const names = parseStringArray(args.names);
  const sources = readableMergeSources(db, names);
  if (sources.length < 2) return fail("merge_files needs at least two files with readable text.");
  const headings = asBoolDefault(args.headings, true);
  const requested = asString(args.into).trim();
  const content = mergedContent(sources, headings);
  const name = mergedFileName(db, requested);
  const trashSources = asBoolDefault(args.trash_sources, false);
  try {
    const entry = await workspace.createFile(
      name,
      Readable.from([Buffer.from(content)]),
      "generated",
    );
    setFileExtractedText(db, entry.fileId, content);
    if (trashSources) await trashMergeSources(db, workspace, sources);
    effects.wrote = true;
    emitSafely(emit, "room-files-changed", undefined);
    return mergedWorkspaceReceipt(sources.length, name, content, trashSources);
  } catch (error) {
    return fail(errMessage(error));
  }
}
