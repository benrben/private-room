import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { PRIVATE_DIR, pathKey } from "./pathSafety.js";
import type { ManifestEntry } from "./types.js";

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function scanWorkspaceManifest(rootPath: string): Promise<Map<string, ManifestEntry>> {
  const root = path.resolve(rootPath);
  const result = new Map<string, ManifestEntry>();

  async function walk(absoluteDir: string, prefix: string): Promise<void> {
    const dir = await opendir(absoluteDir);
    for await (const item of dir) {
      if (prefix === "" && item.name.toLocaleLowerCase("en-US") === PRIVATE_DIR) continue;
      const relativePath = prefix === "" ? item.name : `${prefix}/${item.name}`;
      const absolutePath = path.join(absoluteDir, item.name);
      const fileStat = await lstat(absolutePath, { bigint: true });
      if (fileStat.isSymbolicLink()) continue;
      if (fileStat.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!fileStat.isFile()) continue;
      const key = pathKey(relativePath);
      if (result.has(key)) throw new Error(`Two room files use the same normalized path: ${relativePath}`);
      result.set(key, {
        relativePath: relativePath.normalize("NFC"),
        pathKey: key,
        sizeBytes: Number(fileStat.size),
        mtimeNs: Number(fileStat.mtimeNs),
        sha256: await hashFile(absolutePath),
        fsIdentity: `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`,
      });
    }
  }

  await walk(root, "");
  return result;
}
