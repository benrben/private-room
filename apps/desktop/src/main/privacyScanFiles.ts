/** Cohesive extraction from privacy.ts; the facade preserves its public API. */
import { addPrivacyEntity, privacyTextSha, setPrivacyScan } from "./db-host/privacy.js";
import { isProtectable } from "./privacyRedact.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import type { RoomHandle } from "./jobs.js";
import { defaultSleepMs, emitSafely, errorCode, type PrivacyScanDeps, type ScanEnd, scanFinished, scanGeneration, type SidecarPrivacyScanResult } from "./privacyScanControl.js";
import { currentPinnedRoom, isScanEnd, type ScanIdentity, type ScanPassSnapshot, type ScanRunState, type ScanWorkItem } from "./privacyScanRun.js";


export async function scanRunnableFiles(
  scan: PrivacyScanDeps,
  identity: ScanIdentity,
  state: ScanRunState,
  snapshot: ScanPassSnapshot,
  runnable: ReadonlyArray<ScanWorkItem>
): Promise<ScanEnd | null> {
  const total = runnable.length;
  for (let index = 0; index < runnable.length; index += 1) {
    if (scanGeneration !== snapshot.generation) {
      break;
    }
    const [fileId, name, text] = runnable[index]!;
    const pause = waitForChatToFinish(scan, snapshot.generation, index, total);
    if (pause !== null) {
      await pause;
    }
    emitSafely(scan.emit, { running: true, done: index, total, label: name });
    const end = await scanFile(scan, identity, state, snapshot, fileId, text);
    if (end !== null) {
      return end;
    }
  }
  return null;
}


function waitForChatToFinish(
  scan: PrivacyScanDeps,
  generation: number,
  done: number,
  total: number
): Promise<void> | null {
  if (!scan.isChatBusy() || scanGeneration !== generation) {
    return null;
  }
  return waitForChatToFinishAfterPause(scan, generation, done, total);
}


async function waitForChatToFinishAfterPause(
  scan: PrivacyScanDeps,
  generation: number,
  done: number,
  total: number
): Promise<void> {
  do {
    emitSafely(scan.emit, { running: true, done, total, label: "Paused while you chat" });
    await (scan.sleepMs ?? defaultSleepMs)(2000);
  } while (scan.isChatBusy() && scanGeneration === generation);
}


async function scanFile(
  scan: PrivacyScanDeps,
  identity: ScanIdentity,
  state: ScanRunState,
  snapshot: ScanPassSnapshot,
  fileId: string,
  text: string
): Promise<ScanEnd | null> {
  const result = await callPrivacyScanner(scan, state, snapshot, fileId, text);
  if (result === null) {
    return null;
  }
  if (isScanEnd(result)) {
    return result;
  }
  const room = currentPinnedRoom(scan, identity);
  if (isScanEnd(room)) {
    return room;
  }
  saveFindings(room, result.entities, snapshot.known);
  recordScanCompletion(room, snapshot, state, fileId, text, result.complete ?? true);
  return null;
}


async function callPrivacyScanner(
  scan: PrivacyScanDeps,
  state: ScanRunState,
  snapshot: ScanPassSnapshot,
  fileId: string,
  text: string
): Promise<SidecarPrivacyScanResult | ScanEnd | null> {
  try {
    return await scan.privacyScanCall(scanRequest(snapshot, text));
  } catch (e) {
    return scannerCallFailed(e, state, fileId, snapshot.guardModel);
  }
}


function scanRequest(snapshot: ScanPassSnapshot, text: string): Record<string, unknown> {
  return {
    model: snapshot.guardModel,
    base_url: resolvedBaseUrl(),
    text,
    concepts: snapshot.concepts,
    known: snapshot.known.slice(),
  };
}


function scannerCallFailed(e: unknown, state: ScanRunState, fileId: string, guardModel: string): ScanEnd | null {
  const code = errorCode(e);
  if (code === "OLLAMA_DOWN" || code === "MODEL_MISSING") {
    return scanFinished(scannerUnavailableMessage(code, guardModel));
  }
  state.failed.add(fileId);
  return null;
}


function scannerUnavailableMessage(code: string | null, guardModel: string): string {
  if (code === "MODEL_MISSING") {
    return `The scan model "${guardModel}" isn't downloaded — get it in Settings → Model, then scan again.`;
  }
  return "The local AI engine isn't reachable — the scan will retry on the next import or when you press Scan now.";
}


function saveFindings(room: RoomHandle, entities: SidecarPrivacyScanResult["entities"], known: string[]): void {
  for (const entity of Array.isArray(entities) ? entities : []) {
    saveFinding(room, entity, known);
  }
}


function saveFinding(room: RoomHandle, entity: unknown, known: string[]): void {
  const finding = protectableFinding(entity);
  if (finding === null) {
    return;
  }
  try {
    known.push(addPrivacyEntity(room.db, finding.real, finding.category, "scan").realText);
  } catch {
    // A failed insert is skipped, and the finding is simply not on the list this pass.
  }
}


function protectableFinding(entity: unknown): { real: string; category: string } | null {
  if (typeof entity !== "object" || entity === null) {
    return null;
  }
  const candidate = entity as { text?: unknown; category?: unknown };
  const real = typeof candidate.text === "string" ? candidate.text : "";
  if (!isProtectable(real)) {
    return null;
  }
  return {
    real,
    category: typeof candidate.category === "string" ? candidate.category : "concept",
  };
}


function recordScanCompletion(
  room: RoomHandle,
  snapshot: ScanPassSnapshot,
  state: ScanRunState,
  fileId: string,
  text: string,
  complete: boolean
): void {
  if (!complete) {
    state.failed.add(fileId);
    return;
  }
  try {
    setPrivacyScan(room.db, fileId, privacyTextSha(text), snapshot.sha);
  } catch {
    state.failed.add(fileId);
  }
}
