import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const PRIVATE_DIR = ".arcelle";

function isAbsolutePath(input: string): boolean {
  return path.isAbsolute(input) || path.posix.isAbsolute(input) || path.win32.isAbsolute(input);
}

function validatePathInput(input: string): void {
  if (input.includes("\0")) throw new Error("A file path cannot contain NUL.");
  if (isAbsolutePath(input)) throw new Error("Only room-relative paths are allowed.");
}

function validateRelativeParts(parts: string[]): void {
  if (parts.length === 0) throw new Error("A file path cannot be empty.");
  if (parts.some((part) => part === "..")) throw new Error("A file path cannot leave the room.");
  if (parts[0]?.toLocaleLowerCase("en-US") === PRIVATE_DIR) {
    throw new Error("The .arcelle directory is private.");
  }
}

/** Convert a user/tool path into one portable, room-relative representation. */
export function normalizeRelativePath(input: string): string {
  validatePathInput(input);
  const portable = input.replace(/\\/g, "/").normalize("NFC");
  const parts = portable.split("/").filter((part) => part !== "" && part !== ".");
  validateRelativeParts(parts);
  return parts.join("/");
}

/** macOS default filesystems compare case-insensitively; NFC avoids aliases. */
export function pathKey(relativePath: string): string {
  return normalizeRelativePath(relativePath).normalize("NFC").toLocaleLowerCase("en-US");
}

export function resolveWorkspacePath(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const root = path.resolve(rootPath);
  return path.resolve(root, ...normalized.split("/"));
}

type PathSegmentCheck =
  | { kind: "present" }
  | { kind: "missing"; error: unknown };

async function checkPathSegment(segmentPath: string): Promise<PathSegmentCheck> {
  try {
    const stat = await lstat(segmentPath);
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in managed room paths.");
    return { kind: "present" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", error };
    }
    throw error;
  }
}

function permitsMissingSegment(index: number, segmentCount: number, allowMissingLeaf: boolean): boolean {
  return index < segmentCount - 1 || allowMissingLeaf;
}

/**
 * Reject symlinks in every existing path segment. The final segment may be
 * absent for a create operation. This closes lexical-safe-but-link-escaping
 * paths before a filesystem mutation.
 */
export async function assertNoSymlinkSegments(
  rootPath: string,
  relativePath: string,
  allowMissingLeaf = false,
): Promise<void> {
  const normalized = normalizeRelativePath(relativePath);
  const canonicalRoot = await realpath(rootPath);
  let cursor = canonicalRoot;
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    const segment = await checkPathSegment(cursor);
    if (segment.kind !== "missing") continue;
    if (permitsMissingSegment(index, parts.length, allowMissingLeaf)) return;
    throw segment.error;
  }
}
