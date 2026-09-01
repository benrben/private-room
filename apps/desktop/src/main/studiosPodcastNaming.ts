/** Collision-safe names for rendered podcast episodes. */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { fileByExactName } from "./db-host/files.js";
import { safeScopeName } from "./studiosCmds.js";

export function nextTakeName(db: Database.Database, title: string, ext: string): string {
  const base = `${safeScopeName(title)} - episode`;
  const first = `${base}.${ext}`;
  if (fileByExactName(db, first) === null) {
    return first;
  }
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base} ${n}.${ext}`;
    if (fileByExactName(db, candidate) === null) {
      return candidate;
    }
  }
  const tail = randomUUID();
  return `${base} ${tail.slice(0, 8)}.${ext}`;
}
