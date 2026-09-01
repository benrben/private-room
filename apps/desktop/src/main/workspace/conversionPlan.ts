import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { getMeta, setMeta } from "../db-host/meta.js";
import { pathKey, PRIVATE_DIR } from "./pathSafety.js";

export const PHASE_META = "workspace_conversion_phase";
const REPORT_META = "workspace_conversion_report";

export interface ConversionRename {
  fileId: string;
  originalPath: string;
  convertedPath: string;
}

export interface ConversionSkipped {
  fileId: string;
  name: string;
  reason: string;
}

interface PlannedRow {
  id: string;
  name: string;
  missing_bytes: number;
  folder_id: string | null;
}

export interface PersistedReport {
  renamed: ConversionRename[];
  skipped: ConversionSkipped[];
}

interface ConvertedFolder {
  original: string;
  converted: string;
}

interface PlannedFilePaths {
  originalPath: string;
  convertedPath: string;
}

export function conversionTempRoot(destinationPath: string): string {
  const resolved = path.resolve(destinationPath);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.arcelle-conversion.tmp`);
}

function safeComponent(raw: string, fallback: string): string {
  let value = raw.normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (value === "" || value === "." || value === "..") value = fallback;
  if (value.toLocaleLowerCase("en-US") === PRIVATE_DIR) value = `${value}_files`;
  value = [...value].slice(0, 180).join("").replace(/[. ]+$/g, "");
  return value === "" ? fallback : value;
}

function availableRelativePath(desired: string, used: Set<string>): string {
  const extension = path.posix.extname(desired);
  const stem = desired.slice(0, desired.length - extension.length);
  for (let number = 1; number <= 10_000; number += 1) {
    const candidate = number === 1 ? desired : `${stem} (${number})${extension}`;
    const key = pathKey(candidate);
    if (!used.has(key)) {
      used.add(key);
      return candidate;
    }
  }
  throw new Error(`Could not create a unique workspace path for ${desired}.`);
}

export function loadReport(db: Database.Database): PersistedReport {
  const raw = getMeta(db, REPORT_META);
  if (raw === null) return { renamed: [], skipped: [] };
  try {
    const parsed = JSON.parse(raw) as PersistedReport;
    return {
      renamed: Array.isArray(parsed.renamed) ? parsed.renamed : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    };
  } catch {
    throw new Error("The saved workspace conversion report is damaged.");
  }
}

function persistReport(db: Database.Database, report: PersistedReport): void {
  setMeta(db, REPORT_META, JSON.stringify(report));
}

function planFolderPaths(db: Database.Database): Map<string, ConvertedFolder> {
  const folderRows = db.prepare("SELECT id, name FROM folders ORDER BY rowid")
    .all() as Array<{ id: string; name: string }>;
  const usedFolders = new Set<string>();
  const folders = new Map<string, ConvertedFolder>();
  for (const folder of folderRows) {
    const safe = availableRelativePath(safeComponent(folder.name, "Folder"), usedFolders);
    folders.set(folder.id, { original: folder.name, converted: safe });
    db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(safe, folder.id);
  }
  return folders;
}

function plannedFileRows(db: Database.Database): PlannedRow[] {
  return db.prepare(
    `SELECT id, name, original_bytes IS NULL AS missing_bytes, folder_id FROM files
     WHERE trashed_at IS NULL ORDER BY rowid`,
  ).all() as PlannedRow[];
}

function folderForPlannedRow(
  row: PlannedRow,
  folders: ReadonlyMap<string, ConvertedFolder>,
): ConvertedFolder | null {
  return row.folder_id === null ? null : folders.get(row.folder_id) ?? null;
}

function plannedFilePaths(
  row: PlannedRow,
  folders: ReadonlyMap<string, ConvertedFolder>,
  usedPaths: Set<string>,
): PlannedFilePaths {
  const fileName = safeComponent(row.name, `File-${row.id.slice(0, 8)}`);
  const folder = folderForPlannedRow(row, folders);
  const originalPath = folder === null ? row.name : `${folder.original}/${row.name}`;
  const desired = folder === null ? fileName : `${folder.converted}/${fileName}`;
  return { originalPath, convertedPath: availableRelativePath(desired, usedPaths) };
}

function recordSkippedLegacyRow(report: PersistedReport, row: PlannedRow): void {
  report.skipped.push({
    fileId: row.id,
    name: row.name,
    reason: "This legacy row has no current file bytes.",
  });
}

function planFileRow(
  row: PlannedRow,
  folders: ReadonlyMap<string, ConvertedFolder>,
  usedPaths: Set<string>,
  update: Database.Statement,
  report: PersistedReport,
): void {
  if (row.missing_bytes === 1) {
    recordSkippedLegacyRow(report, row);
    return;
  }
  const paths = plannedFilePaths(row, folders, usedPaths);
  update.run(path.posix.basename(paths.convertedPath), paths.convertedPath, pathKey(paths.convertedPath), row.id);
  if (paths.convertedPath !== paths.originalPath) {
    report.renamed.push({
      fileId: row.id,
      originalPath: paths.originalPath,
      convertedPath: paths.convertedPath,
    });
  }
}

export function planPaths(db: Database.Database): PersistedReport {
  const folders = planFolderPaths(db);
  const usedPaths = new Set<string>();
  const report: PersistedReport = { renamed: [], skipped: [] };
  const update = db.prepare(
    "UPDATE files SET name = ?, relative_path = ?, path_key = ? WHERE id = ?",
  );
  for (const row of plannedFileRows(db)) {
    planFileRow(row, folders, usedPaths, update, report);
  }
  persistReport(db, report);
  setMeta(db, PHASE_META, "planned");
  return report;
}
