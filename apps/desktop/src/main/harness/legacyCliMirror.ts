import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeProviderFailure } from "./failureSafety.js";
import { normalizeRelativePath } from "../workspace/pathSafety.js";
import { WorkspaceCalls } from "./legacyCli.js";

export async function assertNoSymlinkParents(root: string, relative: string): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Workspace symlinks are not exposed to agents.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export function relativeArg(value: unknown): string {
  const raw = typeof value === "string" ? value.replace(/^\/+/, "") : "";
  return normalizeRelativePath(raw);
}
export function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}


/** Filesystem projection used only for a redacted runtime mirror. */
export function createMirrorWorkspaceBackend(root: string, writeEnabled: boolean): WorkspaceCalls {
  const absolute = async (value: unknown): Promise<{ relative: string; absolute: string }> => {
    const relative = relativeArg(value);
    await assertNoSymlinkParents(root, relative);
    const candidate = path.join(root, relative);
    try {
      if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Workspace symlinks are not exposed to agents.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { relative, absolute: candidate };
  };
  const files = () => findMirrorFiles(root);
  const writable = (): void => {
    if (!writeEnabled) throw new Error("This harness run is read-only.");
  };
  const deps: MirrorWorkspaceDeps = { root, absolute, files, writable };
  return {
    async call(operation, args) {
      try {
        return await callMirrorOperation(operation, args, deps);
      } catch {
        return { error: safeProviderFailure("provider", "tool") };
      }
    },
  };
}
export async function findMirrorFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await collectMirrorFiles(root, "", found);
  return found;
}
export async function collectMirrorFiles(directory: string, prefix: string, found: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    await collectMirrorEntry(directory, prefix, entry, found);
  }
}
export async function collectMirrorEntry(
  directory: string,
  prefix: string,
  entry: Dirent<string>,
  found: string[],
): Promise<void> {
  if (omitsMirrorEntry(prefix, entry.name)) return;
  const relative = mirrorEntryPath(prefix, entry.name);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) return collectMirrorFiles(path.join(directory, entry.name), relative, found);
  if (entry.isFile()) found.push(relative);
}
export function omitsMirrorEntry(prefix: string, name: string): boolean {
  return prefix === "" && name.toLocaleLowerCase("en-US") === ".arcelle";
}
export function mirrorEntryPath(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}
export interface MirrorWorkspaceDeps {
  root: string;
  absolute: (value: unknown) => Promise<{ relative: string; absolute: string }>;
  files: () => Promise<string[]>;
  writable: () => void;
}
export async function callMirrorOperation(
  operation: string,
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
): Promise<Record<string, unknown>> {
  const query = MIRROR_QUERY_HANDLERS[operation];
  if (query !== undefined) {
    return query(args, deps);
  }
  if (operation === "move" || operation === "rename") {
    return moveMirrorFile(operation, args, deps);
  }
  return callMirrorPathOperation(operation, args, deps);
}
export type MirrorQueryHandler = (
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
) => Promise<Record<string, unknown>>;
export const MIRROR_QUERY_HANDLERS: Readonly<Record<string, MirrorQueryHandler>> = {
  list: listMirrorFiles,
  glob: globMirrorFiles,
  grep: grepMirrorFiles,
};
export async function listMirrorFiles(
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
): Promise<Record<string, unknown>> {
  const prefix = listPrefix(args.path);
  const entries = (await deps.files())
    .filter((file) => isWithinPrefix(file, prefix))
    .map((file) => ({ path: `/${file}`, is_dir: false }));
  return { entries };
}
export function listPrefix(value: unknown): string {
  return typeof value === "string" ? value.replace(/^\/+|\/+$/g, "") : "";
}
export function isWithinPrefix(file: string, prefix: string): boolean {
  return prefix === "" || file.startsWith(`${prefix}/`) || file === prefix;
}
export async function globMirrorFiles(
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
): Promise<Record<string, unknown>> {
  const pattern = typeof args.pattern === "string" ? args.pattern.replace(/^\/+/, "") : "**/*";
  const matcher = globRegex(pattern);
  return { matches: (await deps.files()).filter((file) => matcher.test(file)).map((file) => `/${file}`) };
}
export async function grepMirrorFiles(
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
): Promise<Record<string, unknown>> {
  const pattern = String(args.pattern ?? "");
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of await deps.files()) {
    addMatchingLines(matches, file, pattern, await mirrorFileText(deps.root, file));
  }
  return { matches };
}
export async function mirrorFileText(root: string, file: string): Promise<string | null> {
  return readFile(path.join(root, file), "utf8").catch(() => null);
}
export function addMatchingLines(
  matches: Array<{ path: string; line: number; text: string }>,
  file: string,
  pattern: string,
  text: string | null,
): void {
  if (text === null) return;
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(pattern)) {
      matches.push({ path: `/${file}`, line: index + 1, text: line });
    }
  });
}
export async function moveMirrorFile(
  operation: string,
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
): Promise<Record<string, unknown>> {
  deps.writable();
  const source = await deps.absolute(args.source_path);
  const sourceStat = await lstat(source.absolute);
  if (!sourceStat.isFile()) {
    throw new Error("Workspace move accepts regular files only.");
  }
  const destination = await deps.absolute(moveDestination(operation, args, source.relative));
  if (await destinationConflicts(destination.absolute, sourceStat)) {
    throw new Error("A workspace file already exists at the destination.");
  }
  await mkdir(path.dirname(destination.absolute), { recursive: true });
  await rename(source.absolute, destination.absolute);
  return { old_path: `/${source.relative}`, path: `/${destination.relative}` };
}
export function moveDestination(operation: string, args: Record<string, unknown>, source: string): string {
  if (operation === "move") {
    return relativeArg(args.destination_path);
  }
  return renamedPath(source, args.new_name);
}
export function renamedPath(source: string, value: unknown): string {
  const newName = typeof value === "string" ? value.trim() : "";
  if (!safeLeafName(newName)) {
    throw new Error("The new name must be one safe file name.");
  }
  const parent = path.posix.dirname(source);
  return parent === "." ? newName : path.posix.join(parent, newName);
}
export function safeLeafName(name: string): boolean {
  return !invalidLeafName(name) && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}
export function invalidLeafName(name: string): boolean {
  return name === "" || name === "." || name === ".." || name.toLocaleLowerCase("en-US") === ".arcelle";
}
export async function destinationConflicts(destination: string, source: Awaited<ReturnType<typeof lstat>>): Promise<boolean> {
  const existing = await lstat(destination).catch(missingDestination);
  return existing !== null && (existing.dev !== source.dev || existing.ino !== source.ino);
}
export function missingDestination(error: NodeJS.ErrnoException): Awaited<ReturnType<typeof lstat>> | null {
  if (error.code !== "ENOENT") throw error;
  return null;
}
export async function callMirrorPathOperation(
  operation: string,
  args: Record<string, unknown>,
  deps: MirrorWorkspaceDeps,
): Promise<Record<string, unknown>> {
  const requested = await deps.absolute(args.path ?? args.name);
  if (operation === "read") {
    return readMirrorFile(requested, args);
  }
  deps.writable();
  return callWritableMirrorPathOperation(operation, args, requested);
}
export async function callWritableMirrorPathOperation(
  operation: string,
  args: Record<string, unknown>,
  requested: MirrorPath,
): Promise<Record<string, unknown>> {
  if (operation === "delete") {
    return deleteMirrorFile(requested);
  }
  if (operation === "edit") {
    return editMirrorFile(requested, args);
  }
  if (operation !== "write") {
    return { error: `Unknown workspace operation: ${operation}` };
  }
  return writeMirrorFile(requested, String(args.content ?? ""));
}
export type MirrorPath = { relative: string; absolute: string };
export async function readMirrorFile(requested: MirrorPath, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const text = await readFile(requested.absolute, "utf8");
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number(args.start_line ?? 1));
  const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
  return { path: `/${requested.relative}`, content: lines.slice(start - 1, end).join("\n"), start_line: start, end_line: end };
}
export async function deleteMirrorFile(requested: MirrorPath): Promise<Record<string, unknown>> {
  await rm(requested.absolute, { force: false });
  return { path: `/${requested.relative}`, deleted: true };
}
export async function editMirrorFile(requested: MirrorPath, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await readFile(requested.absolute, "utf8");
  const content = editedMirrorContent(current, args);
  if (typeof content !== "string") {
    return content;
  }
  return writeMirrorFile(requested, content);
}
export function editedMirrorContent(current: string, args: Record<string, unknown>): string | { error: string } {
  const { oldText, newText } = mirrorEditTexts(args);
  const count = mirrorTextCount(current, oldText);
  if (count === 0) {
    return { error: "The old text was not found." };
  }
  if (multipleMirrorMatches(count) && args.all !== true) {
    return { error: "The old text is not unique." };
  }
  return replaceMirrorText(current, oldText, newText, args.all === true);
}
export function mirrorEditTexts(args: Record<string, unknown>): { oldText: string; newText: string } {
  return {
    oldText: mirrorEditText(args.old_string, args.old_text),
    newText: mirrorEditText(args.new_string, args.new_text),
  };
}
export function mirrorEditText(primary: unknown, secondary: unknown): string {
  return String(primary ?? secondary ?? "");
}
export function mirrorTextCount(current: string, oldText: string): number {
  return oldText === "" ? 0 : current.split(oldText).length - 1;
}
export function multipleMirrorMatches(count: number): boolean {
  return count > 1;
}
export function replaceMirrorText(current: string, oldText: string, newText: string, all: boolean): string {
  return all ? current.split(oldText).join(newText) : current.replace(oldText, newText);
}
export async function writeMirrorFile(requested: MirrorPath, content: string): Promise<Record<string, unknown>> {
  await mkdir(path.dirname(requested.absolute), { recursive: true });
  const temporary = path.join(
    path.dirname(requested.absolute),
    `.${path.basename(requested.absolute)}.arcelle-${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, requested.absolute);
  return { path: `/${requested.relative}` };
}
