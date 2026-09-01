/** Cohesive extraction from studiosCmds.ts; its public API remains on that module. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  childOfRun,
  forget,
  guardCommit,
  remember,
  type CancelFlag,
  type CancelState,
  type GuardResult,
  type Node as CancelNode,
} from "./cancel.js";
import {
  fileNamesHint,
  findFileLike,
  getFileExtractedText,
  getFileName,
  listFiles,
  type FileMeta,
} from "./db-host/files.js";
import { titleFromName } from "./docsHtml.js";
import { byteLength } from "./extractionWindow.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { jsonStrField } from "./jsonTools.js";
import * as obs from "./obs.js";
import { chatStructured as chatStructuredReal } from "./ollamaGenerate.js";
import { bestLocalDefault, KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { clampBytes } from "./textClamp.js";
import { declaredFor } from "./capabilities.js";
import { isExternalEngine, ROLLBACK_BUSY } from "./turnContext.js";
import { isSummaryFile } from "./summarizeTools.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { readRoomFile } from "./workspace/roomContent.js";
import { RunStudioDeps, StudioSpec, runStudio } from "./studiosRun.js";
import { NO_ROOM_OPEN } from "./studiosScope.js";
// ============================================================================
// exec_tool's shared studio arm — agent.rs ~4299-4370
// ============================================================================

/**
 * Resolve the schema's file-NAME `refs` (a model has names, from
 * `list_room_files`/`search_room`, never ids) to file ids — an id slipped
 * through untouched, a name resolved via {@link findFileLike}. Missing names
 * are collected and only refused if EVERY one missed (a partial match still
 * proceeds with what resolved); an empty/absent list is `null` (whole room).
 * Ported verbatim from `agent.rs`'s `exec_tool` refs-resolution block.
 *
 * `findFileLike` already throws its OWN "No file matching..." sentence on a
 * miss — NOT reused for the final refusal here, because the Rust arm builds a
 * DIFFERENT one that names every name that missed, joined with " or ", once
 * all `wanted` names have been tried; `findFileLike`'s per-fragment message
 * would report only the FIRST miss and silently drop the rest.
 *
 * Lives HERE, not beside one artifact, because the Rust source resolves refs
 * ONCE for all three studio tools — `"studio_flashcards" | "studio_mindmap" |
 * "generate_podcast_script"` share a single match arm whose only per-artifact
 * difference is `spec`. `studiosFlashcards.ts` re-exports it as
 * `resolveFlashcardsRefs`, the name it shipped under before that arm was
 * shared.
 */
export function resolveStudioRefs(db: Database.Database, rawRefs: unknown): string[] | null {
  const wanted = studioRefNames(rawRefs);
  if (wanted === null) {
    return null;
  }
  const { ids, missing } = resolveNamedStudioRefs(db, wanted);
  if (missing.length > 0 && ids.length === 0) {
    throw new Error(noStudioRefsMessage(db, missing));
  }
  return ids.length === 0 ? null : ids;
}

export function studioRefNames(rawRefs: unknown): string[] | null {
  if (!Array.isArray(rawRefs)) {
    return null;
  }
  return rawRefs
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export interface ResolvedStudioRefs {
  ids: string[];
  missing: string[];
}

export function resolveNamedStudioRefs(db: Database.Database, wanted: readonly string[]): ResolvedStudioRefs {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const want of wanted) {
    const id = studioRefId(db, want);
    if (id !== null) {
      ids.push(id);
    } else {
      missing.push(want);
    }
  }
  return { ids, missing };
}

export function studioRefId(db: Database.Database, want: string): string | null {
  if (isExistingStudioFile(db, want)) {
    return want;
  }
  try {
    const [id] = findFileLike(db, want);
    return id;
  } catch {
    return null;
  }
}

export function isExistingStudioFile(db: Database.Database, id: string): boolean {
  try {
    getFileName(db, id); // already an id — probe only, name unused
    return true;
  } catch {
    return false;
  }
}

export function noStudioRefsMessage(db: Database.Database, missing: readonly string[]): string {
  return `No file matching ${missing.map((name) => `"${name}"`).join(" or ")} in this room.${fileNamesHint(db)}`;
}

/**
 * `agent.rs`'s ONE `exec_tool` arm for `"studio_flashcards" | "studio_mindmap"
 * | "generate_podcast_script"` (~4299-4370) — the tool-calling entry point,
 * distinct from the three `#[tauri::command]` wrappers in exactly the two ways
 * that arm's own comments call out: `scope` is always `null` (an agent has no
 * file-id scope, only `refs`/whole-room), and `parentRun` is threaded through
 * (`turn.map(TurnId::run_id)`) rather than hard-coded `null` — the
 * Owner-replacement-#3 fix that makes a Stop on the asking run cancel a studio
 * build it triggered. Returns the exact reply text Rust's arm does:
 * `Ok(format!("Saved \"{}\" into the room.", meta.name))`.
 *
 * ONE function taking `spec`, exactly as Rust has ONE arm taking `spec`: the
 * previous shape (a flashcards-only `execStudioFlashcards`, with the mind-map
 * and podcast arms refusing unconditionally) meant two of the three
 * model-invocable Studio tools stayed dead even once a host bootstrap supplied
 * a live {@link RunStudioDeps} — a divergence from a single Rust arm that no
 * per-artifact test could see.
 */
export async function execStudio(
  deps: RunStudioDeps,
  spec: StudioSpec,
  parentRun: string | null,
  args: Record<string, unknown>
): Promise<string> {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const refs = resolveStudioRefs(room.db, (args as { refs?: unknown }).refs);
  const instructions = typeof args.instructions === "string" ? args.instructions : null;
  const meta = await runStudio(deps, spec, null, instructions, refs, null, parentRun);
  // Success is not prose: re-open the committed artifact through the same
  // content abstraction every viewer uses and issue a hash receipt. The
  // sidecar write ledger accepts Studio output only when this receipt exists.
  const after = deps.rooms.current();
  if (after === null) throw new Error(NO_ROOM_OPEN);
  const reopened = await readRoomFile(after, meta.id);
  if (reopened.bytes === null) {
    throw new Error(`Studio artifact "${meta.name}" could not be verified after it was saved.`);
  }
  const bytes = reopened.bytes;
  const receipt = {
    fileId: meta.id,
    name: meta.name,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return `Saved "${meta.name}" into the room.\nARCELLE_ARTIFACT_RECEIPT ${JSON.stringify(receipt)}`;
}
