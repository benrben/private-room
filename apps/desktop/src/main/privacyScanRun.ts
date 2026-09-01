/** Cohesive extraction from privacy.ts; the facade preserves its public API. */
import { getSetting } from "./db-host/settings.js";
import { filesNeedingPrivacyScan, listPrivacyEntities } from "./db-host/privacy.js";
import { DEFAULT_MODEL } from "./turnContext.js";
import type { RoomHandle } from "./jobs.js";
import { emitSafely, type PrivacyScanDeps, scanAbandoned, type ScanEnd, scanFinished, scanGeneration } from "./privacyScanControl.js";
import { scanRunnableFiles } from "./privacyScanFiles.js";
import { KEY_CONCEPTS, parseConcepts, policyCell, rulesSha } from "./privacyPolicy.js";


export async function scanPasses(scan: PrivacyScanDeps): Promise<ScanEnd> {
  const identity = scanIdentity(scan);
  if (identity === null) {
    return scanFinished(null);
  }
  const wake = announceAndWakeScanner(scan);
  if (wake !== null) {
    const wakeEnd = await wake;
    if (wakeEnd !== null) {
      return wakeEnd;
    }
  }
  const state: ScanRunState = {
    failed: new Set<string>(),
    failedGeneration: scanGeneration,
    resolvedGuardModel: null,
  };

  for (;;) {
    const end = await scanOnePass(scan, identity, state);
    if (end !== null) {
      return end;
    }
  }
}


/** The room these findings belong to. Every write re-checks this pin so a long
 * sidecar call cannot file room A's names in room B. */
export interface ScanIdentity {
  path: string;
  epoch: number;
}


export type ScanWorkItem = readonly [string, string, string];


export interface ScanRunState {
  failed: Set<string>;
  failedGeneration: number;
  resolvedGuardModel: string | null;
}


export interface ScanPassSnapshot {
  room: RoomHandle;
  generation: number;
  concepts: string[];
  sha: string;
  work: ReadonlyArray<ScanWorkItem>;
  known: string[];
  guardModel: string;
}


function scanIdentity(scan: PrivacyScanDeps): ScanIdentity | null {
  const room = scan.room.current();
  if (room === null) {
    return null;
  }
  return { path: room.path, epoch: scan.roomEpoch() };
}


function announceAndWakeScanner(scan: PrivacyScanDeps): Promise<ScanEnd | null> | null {
  emitSafely(scan.emit, { running: true, done: 0, total: 0, label: "Starting…" });
  if (scan.wakeDaemon === undefined) {
    return null;
  }
  try {
    return scan.wakeDaemon().then(() => null, wakeFailure);
  } catch (e) {
    return Promise.resolve(wakeFailure(e));
  }
}


function wakeFailure(e: unknown): ScanEnd {
  const msg = e instanceof Error ? e.message : String(e);
  return scanFinished(`The local AI engine isn't available: ${msg}`);
}


function scanOnePass(scan: PrivacyScanDeps, identity: ScanIdentity, state: ScanRunState): Promise<ScanEnd | null> {
  const snapshot = takeScanSnapshot(scan, identity, state);
  if (snapshot instanceof Promise) {
    return snapshot.then((value) => scanSnapshot(scan, identity, state, value));
  }
  return scanSnapshot(scan, identity, state, snapshot);
}


function scanSnapshot(
  scan: PrivacyScanDeps,
  identity: ScanIdentity,
  state: ScanRunState,
  snapshot: ScanPassSnapshot | ScanEnd
): Promise<ScanEnd | null> {
  if (isScanEnd(snapshot)) {
    return Promise.resolve(snapshot);
  }
  if (snapshot.work.length === 0) {
    return Promise.resolve(scanFinished(null));
  }
  const runnable = snapshot.work.filter(([id]) => !state.failed.has(id));
  if (runnable.length === 0) {
    return Promise.resolve(scanFinished(failedFilesMessage(state.failed.size)));
  }
  return scanRunnableFiles(scan, identity, state, snapshot, runnable);
}


export function isScanEnd(value: object): value is ScanEnd {
  return "roomChanged" in value;
}


function takeScanSnapshot(
  scan: PrivacyScanDeps,
  identity: ScanIdentity,
  state: ScanRunState
): ScanPassSnapshot | ScanEnd | Promise<ScanPassSnapshot | ScanEnd> {
  const generation = scanGeneration;
  resetFailedFiles(state, generation);
  const room = currentPinnedRoom(scan, identity);
  if (isScanEnd(room)) {
    return room;
  }
  const concepts = parseConcepts(getSetting(room.db, KEY_CONCEPTS));
  const sha = rulesSha(concepts);
  const work = scanWork(room, sha);
  if (isScanEnd(work)) {
    return work;
  }
  const known = knownEntities(room);
  const guardModel = scanGuardModel(scan, state);
  if (typeof guardModel === "string") {
    return scanSnapshotFor(room, generation, concepts, sha, work, known, guardModel);
  }
  return guardModel.then((model) => scanSnapshotFor(room, generation, concepts, sha, work, known, model));
}


function scanSnapshotFor(
  room: RoomHandle,
  generation: number,
  concepts: string[],
  sha: string,
  work: ReadonlyArray<ScanWorkItem>,
  known: string[],
  guardModel: string
): ScanPassSnapshot {
  return {
    room,
    generation,
    concepts,
    sha,
    work,
    known,
    guardModel,
  };
}


function resetFailedFiles(state: ScanRunState, generation: number): void {
  if (generation !== state.failedGeneration) {
    state.failed.clear();
    state.failedGeneration = generation;
  }
}


export function currentPinnedRoom(scan: PrivacyScanDeps, identity: ScanIdentity): RoomHandle | ScanEnd {
  const room = scan.room.current();
  if (room === null) {
    return scanFinished(null);
  }
  if (room.path !== identity.path || scan.roomEpoch() !== identity.epoch) {
    return scanAbandoned();
  }
  return room;
}


function scanWork(room: RoomHandle, sha: string): ReadonlyArray<ScanWorkItem> | ScanEnd {
  try {
    return filesNeedingPrivacyScan(room.db, sha);
  } catch (e) {
    return scanFinished(e instanceof Error ? e.message : String(e));
  }
}


function knownEntities(room: RoomHandle): string[] {
  try {
    return listPrivacyEntities(room.db).map((entity) => entity.realText);
  } catch {
    return [];
  }
}


function scanGuardModel(scan: PrivacyScanDeps, state: ScanRunState): string | Promise<string> {
  if (state.resolvedGuardModel !== null) {
    return state.resolvedGuardModel;
  }
  const preferred = policyCell?.guardModel ?? DEFAULT_MODEL;
  const resolved = resolveGuardModel(scan, preferred);
  if (typeof resolved === "string") {
    state.resolvedGuardModel = resolved;
    return resolved;
  }
  return resolved.then((model) => {
    state.resolvedGuardModel = model;
    return model;
  });
}


function resolveGuardModel(scan: PrivacyScanDeps, preferred: string): string | Promise<string> {
  if (scan.resolveGuardModel === undefined) {
    return preferred;
  }
  try {
    return scan.resolveGuardModel(preferred).catch(() => preferred);
  } catch {
    return preferred;
  }
}


function failedFilesMessage(count: number): string {
  const suffix = count === 1 ? "" : "s";
  return (
    `${count} file${suffix} couldn't be scanned all the way through this time — ` +
    "anything found so far is protected, the rest is not yet. They'll be retried on the " +
    "next import, or when you press Scan now."
  );
}
