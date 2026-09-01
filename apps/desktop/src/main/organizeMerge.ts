import type Database from "better-sqlite3-multiple-ciphers";
import type { BulkFailure } from "../shared/apiTypes.js";
import {
  availableName,
  getFileExtractedText,
  insertFile,
} from "./db-host/files.js";
import {
  extensionOf,
  mimeFor,
  resolve,
  trashFilesIn,
  type Resolved,
} from "./organizeCore.js";

interface MergeContents {
  body: string;
  merged: string[];
}

function requireTwoResolvedFiles(resolved: Resolved, failures: readonly BulkFailure[]): void {
  if (resolved.hits.length >= 2) {
    return;
  }
  const notFound =
    failures.length === 0 ? "" : ` Not found: ${failures.map((failure) => `"${failure.name}"`).join(", ")}.`;
  throw new Error(
    `merge_files needs at least two files it can find; matched ${resolved.hits.length}.${notFound}`
  );
}

function hasReadableText(text: string | null): text is string {
  return text !== null && text.trim() !== "";
}

function mergeContents(
  db: Database.Database,
  hits: ReadonlyArray<[number, string, string]>,
  headings: boolean,
  failures: BulkFailure[]
): MergeContents {
  let body = "";
  const merged: string[] = [];
  for (const [, id, name] of hits) {
    const text = getFileExtractedText(db, id);
    if (!hasReadableText(text)) {
      failures.push({ name, error: "no readable text in this file" });
      continue;
    }
    if (headings) {
      body += `\n\n## ${name}\n\n`;
    } else if (body !== "") {
      body += "\n\n";
    }
    body += text.trim();
    merged.push(name);
  }
  return { body, merged };
}

function requireTwoReadableFiles(merged: readonly string[]): void {
  if (merged.length >= 2) {
    return;
  }
  throw new Error("merge_files needs at least two files with readable text; the rest had none.");
}

function mergedFileName(db: Database.Database, into: string): string {
  const requested = into.trim();
  const name = requested === "" ? "Merged notes.md" : extensionOf(requested) === "" ? `${requested}.md` : requested;
  return availableName(db, name);
}

function contributedIds(hits: ReadonlyArray<[number, string, string]>, merged: readonly string[]): string[] {
  return hits.filter(([, , name]) => merged.includes(name)).map(([, id]) => id);
}

function mergeReceipt(
  name: string,
  content: string,
  merged: readonly string[],
  failures: readonly BulkFailure[],
  trashSources: boolean
): string {
  const skipped =
    failures.length === 0
      ? ""
      : ` Skipped: ${failures.map((failure) => `"${failure.name}" (${failure.error})`).join("; ")}.`;
  const sourceDisposition = trashSources
    ? " and moved the originals to the trash"
    : " — the originals are untouched";
  return (
    `Merged ${merged.length} files into "${name}" ` +
    `(${[...content].length} characters)` +
    `${sourceDisposition}.${skipped}`
  );
}

/** Join several text files into one new room file without a model call. */
export function merge(
  db: Database.Database,
  names: readonly string[],
  into: string,
  headings: boolean,
  trashSources: boolean
): [string, string, BulkFailure[]] {
  const resolved = resolve(db, names);
  const failures: BulkFailure[] = [...resolved.misses];
  requireTwoResolvedFiles(resolved, failures);

  const { body, merged } = mergeContents(db, resolved.hits, headings, failures);
  requireTwoReadableFiles(merged);

  const name = mergedFileName(db, into);
  const content = body.trimStart();
  const meta = insertFile(db, name, mimeFor(name), Buffer.from(content, "utf8"), content, "generated");

  if (trashSources) {
    const ids = contributedIds(resolved.hits, merged);
    failures.push(...trashFilesIn(db, ids, { kind: "agent", who: "merge_files" }).failed);
  }

  return [meta.name, mergeReceipt(meta.name, content, merged, failures, trashSources), failures];
}
