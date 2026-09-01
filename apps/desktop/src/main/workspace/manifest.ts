import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { PRIVATE_DIR, pathKey } from "./pathSafety.js";
import type { ManifestEntry } from "./types.js";

export interface TrustedManifestEntry {
  sizeBytes: number;
  mtimeNs: number;
  sha256: string;
  fsIdentity: string;
}

export interface ManifestScanOptions {
  /**
   * Previously verified rows keyed by normalized relative path. A hash may be
   * reused only when every cheap filesystem identity field is unchanged.
   */
  trustedEntries?: ReadonlyMap<string, TrustedManifestEntry>;
  /** Test/diagnostic hook. It never receives file bytes. */
  onHash?: (relativePath: string) => void;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Arcelle writes normal files through a hidden sibling and then renames it.
 * Watcher hints already ignore these names, but a full manifest scan can run
 * while the sibling exists. The scan is the source of truth, so it must apply
 * the same exclusion or it can permanently adopt a short-lived partial file. */
export function isArcelleAtomicTemporaryName(name: string): boolean {
  return /^\..+\.arcelle-[0-9a-f-]+\.tmp$/i.test(name);
}

type WalkWorkspaceDirectory = (absoluteDir: string, prefix: string) => Promise<void>;

function skipWorkspaceEntry(prefix: string, name: string): boolean {
  return (prefix === "" && name.toLocaleLowerCase("en-US") === PRIVATE_DIR)
    || isArcelleAtomicTemporaryName(name);
}

function workspaceRelativePath(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

function filesystemIdentity(fileStat: BigIntStats): string {
  return `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`;
}

function canReuseTrustedHash(
  trusted: TrustedManifestEntry | undefined,
  sizeBytes: number,
  mtimeNs: number,
  fsIdentity: string
): trusted is TrustedManifestEntry {
  return trusted !== undefined
    && trusted.sizeBytes === sizeBytes
    && trusted.mtimeNs === mtimeNs
    && trusted.fsIdentity === fsIdentity;
}

async function manifestSha256(
  absolutePath: string,
  relativePath: string,
  trusted: TrustedManifestEntry | undefined,
  sizeBytes: number,
  mtimeNs: number,
  fsIdentity: string,
  options: ManifestScanOptions
): Promise<string> {
  if (canReuseTrustedHash(trusted, sizeBytes, mtimeNs, fsIdentity)) {
    return trusted.sha256;
  }
  options.onHash?.(relativePath);
  return hashFile(absolutePath);
}

async function scanWorkspaceEntry(
  absoluteDir: string,
  prefix: string,
  name: string,
  result: Map<string, ManifestEntry>,
  options: ManifestScanOptions,
  walk: WalkWorkspaceDirectory
): Promise<void> {
  const relativePath = workspaceRelativePath(prefix, name);
  const absolutePath = path.join(absoluteDir, name);
  const fileStat = await lstat(absolutePath, { bigint: true });
  if (fileStat.isSymbolicLink()) return;
  if (fileStat.isDirectory()) {
    await walk(absolutePath, relativePath);
    return;
  }
  if (!fileStat.isFile()) return;
  const key = pathKey(relativePath);
  if (result.has(key)) {
    throw new Error(`Two room files use the same normalized path: ${relativePath}`);
  }
  const sizeBytes = Number(fileStat.size);
  const mtimeNs = Number(fileStat.mtimeNs);
  const fsIdentity = filesystemIdentity(fileStat);
  const trusted = options.trustedEntries?.get(key);
  result.set(key, {
    relativePath: relativePath.normalize("NFC"),
    pathKey: key,
    sizeBytes,
    mtimeNs,
    sha256: await manifestSha256(absolutePath, relativePath, trusted, sizeBytes, mtimeNs, fsIdentity, options),
    fsIdentity,
  });
}

export async function scanWorkspaceManifest(
  rootPath: string,
  options: ManifestScanOptions = {},
): Promise<Map<string, ManifestEntry>> {
  const root = path.resolve(rootPath);
  const result = new Map<string, ManifestEntry>();

  const walk: WalkWorkspaceDirectory = async (absoluteDir, prefix) => {
    const dir = await opendir(absoluteDir);
    for await (const item of dir) {
      if (skipWorkspaceEntry(prefix, item.name)) continue;
      await scanWorkspaceEntry(absoluteDir, prefix, item.name, result, options, walk);
    }
  };

  await walk(root, "");
  return result;
}
