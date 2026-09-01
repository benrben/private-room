import type Database from "better-sqlite3-multiple-ciphers";
import type { BulkFailure, BulkReport } from "../shared/apiTypes.js";
import {
  anyFileName,
  findFileLikeQualified,
  trashFile,
  type TrashActor,
} from "./db-host/files.js";

/** Ceiling on one agent batch: a blast-radius limit, not a performance limit. */
export const MAX_BULK_FILES = 200;

/** De-duplicate ids before applying the batch ceiling. */
function takeCapped(ids: readonly string[]): [string[], number] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return [unique.slice(0, MAX_BULK_FILES), Math.max(0, unique.length - MAX_BULK_FILES)];
}

/** Move files to recoverable trash while retaining an honest per-file receipt. */
export function trashFilesIn(
  db: Database.Database,
  ids: readonly string[],
  actor: TrashActor
): BulkReport {
  const [kept, capped] = takeCapped(ids);
  const report: BulkReport = { ok: [], failed: [], capped };
  for (const id of kept) {
    const name = anyFileName(db, id) ?? id;
    try {
      trashFile(db, id, actor);
      report.ok.push(name);
    } catch (e) {
      report.failed.push({ name, error: errorText(e) });
    }
  }
  return report;
}

/** A path extension, excluding dotfiles and normalized to lower case. */
export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  py: "text/x-python",
  js: "text/javascript",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

/** MIME for a generated merged file, without prototype-chain lookups. */
export function mimeFor(name: string): string {
  const ext = extensionOf(name);
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext) ? (MIME_BY_EXT[ext] as string) : "text/plain";
}

/** The stable text representation used in per-item failure receipts. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface Resolved {
  /** (index in the input names, file id, real file name). */
  hits: Array<[number, string, string]>;
  misses: BulkFailure[];
  dupes: BulkFailure[];
}

/** Resolve names in order and report misses and duplicate file identities. */
export function resolve(db: Database.Database, names: readonly string[]): Resolved {
  const hits: Array<[number, string, string]> = [];
  const misses: BulkFailure[] = [];
  const dupes: BulkFailure[] = [];
  const seen = new Set<string>();
  names.forEach((raw, at) => {
    const name = raw.trim();
    if (name === "") {
      return;
    }
    try {
      const [id, real] = findFileLikeQualified(db, name);
      if (seen.has(id)) {
        dupes.push({ name, error: "names the same file as an earlier entry" });
      } else {
        seen.add(id);
        hits.push([at, id, real]);
      }
    } catch (e) {
      misses.push({ name, error: errorText(e) });
    }
  });
  return { hits, misses, dupes };
}
