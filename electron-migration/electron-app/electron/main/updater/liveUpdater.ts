/** Production adapter for the signed, Tauri-compatible update client. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultInstallDeps } from "./installBundle.js";
import {
  checkForUpdate,
  performUpdate,
  type FetchLike,
} from "./tauriUpdater.js";

export interface LiveUpdater {
  check(): Promise<{ version: string; notes?: string } | null>;
  install(): Promise<void>;
}

export interface LiveUpdaterOptions {
  currentVersion: string;
  execPath: string;
  quit(): void;
  fetchImpl?: FetchLike;
}

async function writeVerifiedPayload(payload: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arcelle-update-"));
  const file = path.join(dir, "Arcelle.app.tar.gz");
  await fs.writeFile(file, payload, { mode: 0o600 });
  return file;
}

/**
 * Build the one updater instance owned by the Electron main process.  Both
 * methods use the same minisign-verifying implementation as the bridge release;
 * `install()` rechecks immediately before download so a stale renderer result
 * can never select an arbitrary payload.
 */
export function createLiveUpdater(options: LiveUpdaterOptions): LiveUpdater {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  return {
    async check() {
      const result = await checkForUpdate(fetchImpl, options.currentVersion);
      if (!result.available) return null;
      const notes = result.manifest.notes;
      return notes === undefined
        ? { version: result.manifest.version }
        : { version: result.manifest.version, notes };
    },
    async install() {
      await performUpdate(
        {
          fetchImpl,
          writeVerifiedPayload,
          install: defaultInstallDeps(options.quit),
          execPath: options.execPath,
        },
        options.currentVersion,
      );
    },
  };
}
