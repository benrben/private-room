import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SafeStorage } from "electron";

// Keychain ACLs bind to the app's code signature. A re-signed Electron app
// may not be able to read old Rust-app Keychain items, so this fallback lets a
// user re-enroll once via `safeStorage`. Electron is resolved lazily because
// its package exposes a path string under plain Node, where these tests run.
function requireSafeStorage(): SafeStorage {
  const req = createRequire(import.meta.url);
  const electronModule = req("electron") as { safeStorage?: SafeStorage };
  if (!electronModule || !electronModule.safeStorage) {
    throw new Error("safeStorage is only available inside a running Electron app.");
  }
  return electronModule.safeStorage;
}

/** Return the deterministic wrap-file path for a room's safe-storage secret. */
export function safeStorageWrapPath(userDataDir: string, roomPath: string): string {
  const hash = createHash("sha256").update(roomPath, "utf8").digest("hex").slice(0, 20);
  return path.join(userDataDir, "unlock", `${hash}.bin`);
}

/** Encrypt a password with Electron safeStorage and persist its wrap file. */
export function safeStorageStore(userDataDir: string, roomPath: string, password: string): void {
  const safeStorage = requireSafeStorage();
  const wrapPath = safeStorageWrapPath(userDataDir, roomPath);
  fs.mkdirSync(path.dirname(wrapPath), { recursive: true });
  const encrypted = safeStorage.encryptString(password);
  fs.writeFileSync(wrapPath, encrypted);
}

/** Read and decrypt the safe-storage password for a room. */
export function safeStorageRead(userDataDir: string, roomPath: string): string {
  const safeStorage = requireSafeStorage();
  const wrapPath = safeStorageWrapPath(userDataDir, roomPath);
  if (!fs.existsSync(wrapPath)) {
    throw new Error(`No safeStorage entry for this room at ${wrapPath}.`);
  }
  const encrypted = fs.readFileSync(wrapPath);
  return safeStorage.decryptString(encrypted);
}

/** Return whether a room has a safe-storage wrap file. */
export function safeStorageHas(userDataDir: string, roomPath: string): boolean {
  return fs.existsSync(safeStorageWrapPath(userDataDir, roomPath));
}

/** Idempotently remove a room's safe-storage wrap file. */
export function safeStorageRemove(userDataDir: string, roomPath: string): void {
  const wrapPath = safeStorageWrapPath(userDataDir, roomPath);
  fs.rmSync(wrapPath, { force: true });
}
