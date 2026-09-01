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
import { StudioSpec } from "./studiosRun.js";
// ============================================================================
// studio_spec_for / studio_title
// ============================================================================

export type StudioKind = "flashcards" | "mindmap" | "podcast";

export function isStudioKind(k: string): k is StudioKind {
  return k === "flashcards" || k === "mindmap" || k === "podcast";
}

/**
 * `flashcards_spec`/`mindmap_spec`/`podcast_spec` — all three now REAL and
 * tested (`studiosFlashcards.ts`'s `flashcardsSpec`, `studiosMindmap.ts`'s
 * `mindmapSpec`, `studiosPodcast.ts`'s `podcastSpec`), so a caller can pass
 * `{flashcards: flashcardsSpec, mindmap: mindmapSpec, podcast: podcastSpec}`
 * here today. This file does not import the three itself — `studios.rs`
 * genuinely never called them by name either (Rust's own `studio_spec_for`
 * match arm does, but that caller, `jobs.rs`'s `spawn_studio`/
 * `start_studio_job_inner`, is `jobs.ts`'s own documented future-batch gap,
 * not this file's) — so a THIRD copy of the wiring decision does not get
 * made here ahead of the job-runner batch that actually needs it. Each key
 * mirrors `studio_spec_for`'s own match arm.
 */
export interface StudioSpecFactories {
  readonly flashcards?: () => StudioSpec;
  readonly mindmap?: () => StudioSpec;
  readonly podcast?: () => StudioSpec;
}

/**
 * Reconstruct a studio's `StudioSpec` from a durable job's `kind` string.
 * `factories` defaults to empty, so this HONESTLY returns `null` for every
 * kind until a caller registers real factories — never a fabricated spec.
 * This is a deliberate signature deviation from Rust's `fn(kind: &str) ->
 * Option<StudioSpec>` (which needs no registry, because
 * `flashcards_spec`/`mindmap_spec`/`podcast_spec` are real in Rust): the
 * three factories are the one genuinely unported dependency in this file, and
 * a registry — not a thrown `NOT_IMPLEMENTED:` — keeps `studio_spec_for`'s
 * own `Option`-returning shape intact for whichever future batch ports its
 * caller (`jobs.rs`'s `match studio_spec_for(&kind) { Some(spec) => ...,
 * None => fail() }`, itself still out of scope — see `jobs.ts`'s own module
 * doc).
 */
export function studioSpecFor(kind: string, factories: StudioSpecFactories = {}): StudioSpec | null {
  if (!isStudioKind(kind)) {
    return null;
  }
  // `factories[kind]` is a plain member read on a caller-supplied object
  // literal (the default is `{}`), and `kind` comes from a durable job plan's
  // stored string. A polluted `Object.prototype.mindmap` therefore used to be
  // returned as if a caller had registered it — a FABRICATED spec on a
  // registry that genuinely had none, which is precisely the read-side hole
  // `jsonTools.ts`'s own `ownValue` doc describes ("with `Object.prototype
  // .html` set to a string, `jsonStrField(reply, "html")` used to hand a
  // studio generator that string as if the model had produced it"). Rust's
  // `match kind { "mindmap" => Some(mindmap_spec()), ... }` has no such
  // surface at all.
  const factory = Object.prototype.hasOwnProperty.call(factories, kind)
    ? (factories[kind] as (() => StudioSpec) | undefined)
    : undefined;
  return factory !== undefined ? factory() : null;
}

/** Human title for a studio job card. Ported verbatim from `studio_title` —
 * pure string mapping, real regardless of whether the three specs exist. */
export function studioTitle(kind: string): string {
  switch (kind) {
    case "flashcards":
      return "Flashcards";
    case "mindmap":
      return "Mind map";
    case "podcast":
      return "Podcast script";
    default:
      return "Studio";
  }
}
