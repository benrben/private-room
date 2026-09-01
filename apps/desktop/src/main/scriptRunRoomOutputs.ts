/** Cohesive extraction from scriptRun.ts; its public API remains on that module. */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";

import type { CancelFlag } from "./cancel.js";
import { extractText } from "./editMatch.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  fileByExactName,
  findFileLike,
  getFileBytes,
  getFileBytesNamed,
  getFileMeta,
  inTransaction,
  insertFile,
  listFiles,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { clampBytesMarked } from "./textClamp.js";
import type { ScriptManifest } from "../shared/apiTypes.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./workspace/roomContent.js";

export type { ScriptManifest };
import { Materialized, safeName } from "./scriptRunInterpreter.js";
import { MAX_IMPORT_BYTES, scriptFingerprint } from "./scriptRunManifest.js";
import { ModifiedOutputImportDeps, NewOutputBudget, NewOutputImportDeps, OutputImportState, acceptNewOutput, declaredOutput, importModifiedOutputs, isModifiedUsedFile, materializedBytes, newOutputFits, outputImportState, overImportCapNote, statOrNull, unchangedMaterializedOutput, undeclaredReplacementNote, workspaceFileNames, writeOutput, writeOutputInRoom } from "./scriptRunOutputs.js";
export interface ModifiedDbOutputImportDeps {
  readonly readMaterialized: (workspace: string, name: string) => Buffer | null;
  readonly writeOutput: (
    db: Database.Database,
    name: string,
    bytes: Buffer,
    cause: string,
  ) => { meta: FileMeta; replaced: boolean };
}

/** Test seam for modified DB-room inputs at the filesystem and room-write boundaries. */
export function importModifiedOutputsForTest(
  db: Database.Database,
  ws: string,
  materialized: readonly Materialized[],
  declared: readonly string[],
  cause: string,
  deps: ModifiedDbOutputImportDeps,
): { imported: FileMeta[]; skipped: string[] } {
  const state = outputImportState(materialized, "test-script.py");
  importModifiedOutputs(db, ws, materialized, declared, cause, state, deps);
  return { imported: state.imported, skipped: state.skipped };
}

/** Async twin used by workspace rooms so accepted output bytes land as normal files. */
export async function importOutputsInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  cause: string,
): Promise<{ imported: FileMeta[]; skipped: string[] }> {
  const state = outputImportState(materialized, scriptName);
  await importDeclaredOutputsInRoom(db, roomPath, ws, manifest.outputs, materialized, cause, state);
  await importNewOutputsInRoom(db, roomPath, ws, cause, state);
  await importModifiedOutputsInRoom(db, roomPath, ws, materialized, manifest.outputs, cause, state);
  return { imported: state.imported, skipped: state.skipped };
}

/** Test seam for the complete workspace-room import orchestration. */
export async function importOutputsInRoomForTest(
  db: Database.Database,
  roomPath: string,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  cause: string,
): Promise<{ imported: FileMeta[]; skipped: string[] }> {
  return importOutputsInRoom(db, roomPath, ws, manifest, materialized, scriptName, cause);
}

export async function importDeclaredOutputsInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  declared: readonly string[],
  materialized: readonly Materialized[],
  cause: string,
  state: OutputImportState,
): Promise<void> {
  const seen = new Set<string>();
  for (const want of declared) {
    const safe = safeName(want);
    state.handled.add(safe);
    if (seen.has(safe)) continue;
    seen.add(safe);
    const output = declaredOutput(ws, want, safe);
    if (output.skip !== null) {
      state.skipped.push(output.skip);
      continue;
    }
    const bytes = output.bytes as Buffer;
    if (unchangedMaterializedOutput(materialized, output.safe, bytes)) {
      state.skipped.push(`${want}: unchanged from the room's copy — no new version was saved`);
      continue;
    }
    state.imported.push((await writeOutputInRoom(db, roomPath, want, bytes, cause)).meta);
  }
}

export async function importNewOutputsInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  cause: string,
  state: OutputImportState,
): Promise<void> {
  await importNewOutputsInRoomWithDeps(db, roomPath, ws, cause, state, {
    listWorkspaceFiles: workspaceFileNames,
    fileSize: (filePath) => statOrNull(filePath)?.size ?? 0,
    readFile: fs.readFileSync,
    writeOutput: writeOutputInRoom,
  });
}

export async function importNewOutputsInRoomWithDeps(
  db: Database.Database,
  roomPath: string,
  ws: string,
  cause: string,
  state: OutputImportState,
  deps: NewOutputImportDeps,
): Promise<void> {
  const budget: NewOutputBudget = { bytes: 0, count: 0 };
  for (const name of deps.listWorkspaceFiles(ws)) {
    if (state.handled.has(name)) continue;
    state.handled.add(name);
    const filePath = path.join(ws, name);
    const length = deps.fileSize(filePath);
    if (!newOutputFits(budget, length)) {
      state.skipped.push(`${name}: skipped (new-file import cap reached)`);
      continue;
    }
    const bytes = deps.readFile(filePath);
    acceptNewOutput(budget, bytes);
    const written = await deps.writeOutput(db, roomPath, name, bytes, cause);
    state.imported.push(written.meta);
    if (written.replaced) state.skipped.push(undeclaredReplacementNote(name));
  }
}

/** Test-only entry point for the new-file import loop with fake workspace I/O. */
export async function importNewOutputsInRoomForTest(
  db: Database.Database,
  roomPath: string,
  workspace: string,
  cause: string,
  handled: Iterable<string>,
  deps: NewOutputImportDeps,
): Promise<{ imported: FileMeta[]; skipped: string[] }> {
  const state: OutputImportState = { imported: [], skipped: [], handled: new Set(handled) };
  await importNewOutputsInRoomWithDeps(db, roomPath, workspace, cause, state, deps);
  return { imported: state.imported, skipped: state.skipped };
}

export async function importModifiedOutputsInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  materialized: readonly Materialized[],
  declared: readonly string[],
  cause: string,
  state: OutputImportState,
): Promise<void> {
  await importModifiedOutputsInRoomWithDeps(
    db,
    roomPath,
    ws,
    materialized,
    declared,
    cause,
    state,
    { readMaterialized: materializedBytes, writeOutput: writeOutputInRoom },
  );
}

export async function importModifiedOutputsInRoomWithDeps(
  db: Database.Database,
  roomPath: string,
  ws: string,
  materialized: readonly Materialized[],
  declared: readonly string[],
  cause: string,
  state: OutputImportState,
  deps: ModifiedOutputImportDeps,
): Promise<void> {
  for (const item of materialized) {
    const bytes = deps.readMaterialized(ws, item.name);
    if (bytes === null) continue;
    if (!isModifiedUsedFile(item.sha, scriptFingerprint(bytes), item.name, declared)) continue;
    if (bytes.length > MAX_IMPORT_BYTES) {
      state.skipped.push(overImportCapNote(item.name, true));
      continue;
    }
    state.imported.push((await deps.writeOutput(db, roomPath, item.name, bytes, cause)).meta);
    state.skipped.push(
      `${item.name}: updated in place by the script — saved back as a new version (undo via Time Machine)`,
    );
  }
}

/** Test-only entry point for modified-output import with fake workspace I/O. */
export async function importModifiedOutputsInRoomForTest(
  db: Database.Database,
  roomPath: string,
  workspace: string,
  materialized: readonly Materialized[],
  declared: readonly string[],
  cause: string,
  deps: ModifiedOutputImportDeps,
): Promise<{ imported: FileMeta[]; skipped: string[] }> {
  const state: OutputImportState = { imported: [], skipped: [], handled: new Set() };
  await importModifiedOutputsInRoomWithDeps(
    db, roomPath, workspace, materialized, declared, cause, state, deps,
  );
  return { imported: state.imported, skipped: state.skipped };
}
