import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const PRIVATE_DIR = ".arcelle";

/** Convert a user/tool path into one portable, room-relative representation. */
export function normalizeRelativePath(input: string): string {
  if (input.includes("\0")) throw new Error("A file path cannot contain NUL.");
  if (path.isAbsolute(input) || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new Error("Only room-relative paths are allowed.");
  }
  const portable = input.replace(/\\/g, "/").normalize("NFC");
  const parts = portable.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error("A file path cannot be empty.");
  if (parts.some((part) => part === "..")) throw new Error("A file path cannot leave the room.");
  if (parts[0]?.toLocaleLowerCase("en-US") === PRIVATE_DIR) {
    throw new Error("The .arcelle directory is private.");
  }
  return parts.join("/");
}

/** macOS default filesystems compare case-insensitively; NFC avoids aliases. */
export function pathKey(relativePath: string): string {
  return normalizeRelativePath(relativePath).normalize("NFC").toLocaleLowerCase("en-US");
}

export function resolveWorkspacePath(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("A file path cannot leave the room.");
  }
  return resolved;
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
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in managed room paths.");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && index < parts.length - 1) return;
      if (code === "ENOENT" && allowMissingLeaf && index === parts.length - 1) return;
      throw error;
    }
  }
}
