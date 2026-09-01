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
import { RoomSource } from "./studiosScope.js";
// ============================================================================
// studio_instruction / studio_prompts
// ============================================================================

export const STUDIO_FLASHCARDS_PROMPT = "Make up to 12 flashcards that test real understanding of this material.";
export const STUDIO_MINDMAP_PROMPT = "Build a mind map: one central topic and a short tree of the key ideas.";
export const STUDIO_PODCAST_PROMPT =
  "Write a two-host podcast script that discusses the key points in a natural back-and-forth.";

/** The instruction to use: the user's edited prompt if they supplied one,
 * else the default. Ported verbatim from `studio_instruction`. */
export function studioInstruction(supplied: string | null, defaultPrompt: string): string {
  const trimmed = supplied?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : defaultPrompt;
}

export interface StudioPrompts {
  flashcards: string;
  mindmap: string;
  podcast: string;
}

/** The default prompts, so the UI can show them in an editable box before a
 * Studio action runs. Ported verbatim from `studio_prompts`. */
export function studioPrompts(): StudioPrompts {
  return {
    flashcards: STUDIO_FLASHCARDS_PROMPT,
    mindmap: STUDIO_MINDMAP_PROMPT,
    podcast: STUDIO_PODCAST_PROMPT,
  };
}

// ============================================================================
// SELF_CONTAINED_HTML_RULES
// ============================================================================

/** Ported verbatim (character-for-character) from `SELF_CONTAINED_HTML_RULES`
 * — see the Rust source's own extensive comment for why this is the ONE
 * prompt in the pipeline allowed to name a colour or a font, and why the six
 * hex values must stay in step with `src/styles/tokens.css` /
 * `docsHtml.ts`'s `NOTEBOOK_CSS`. Pinned by this file's own
 * `thePromptPaletteMatchesTheNotebook` test. */
export const SELF_CONTAINED_HTML_RULES =
  "Output ONE complete, self-contained HTML " +
  "document and nothing else — no explanation, no markdown code fences. Put ALL CSS " +
  "inside a <style> tag and ALL JavaScript inside a <script> tag in the same file. Use " +
  "NO external resources whatsoever: no <link>, no <script src>, no CDN, no web fonts, " +
  "no remote images, no fetch/XMLHttpRequest — the page runs offline in a sandbox and " +
  "any network request silently fails. For images use inline SVG or a data: URI only. " +
  "Make it a polished, responsive page: ink on warm paper, light by default " +
  '(#f4f1e8 paper, #20221f ink) with a dark palette under the html[data-theme="dark"] ' +
  "selector (#151716 paper, #f0eee5 ink) — never a prefers-color-scheme media query — " +
  "and a muted marker accent (#a82fad light, #cc7ecf dark). System font stack only. " +
  "Add a @media print rule that puts the page back on white with black text and drops " +
  "any background pattern, because these pages get saved and printed. Write correct " +
  "JavaScript that runs on load with no errors.";

// ============================================================================
// register_studio_cancel
// ============================================================================

/**
 * Create this operation's cancel node and, when the caller supplied an op id,
 * register it in the shared cancel registry — the same one chat's Stop uses —
 * so `cancelId(opId)` stops a Studio run too. Ported verbatim from
 * `register_studio_cancel`. The caller MUST `dispose()` the returned node when
 * the run finishes — see this module's own doc's "ONE DELIBERATE STRUCTURAL
 * ADDITION" section.
 */
export function registerStudioCancel(
  cancelState: CancelState,
  opId: string | null,
  parentRun: string | null,
  label: string
): CancelNode {
  const node = childOfRun(cancelState, parentRun, label);
  if (opId !== null) {
    cancelState.cancels.set(opId, node.flag());
    remember(cancelState, opId, node);
  }
  return node;
}

// ============================================================================
// resolve_structured_model (commands/moonshot.rs — unported; see module doc)
// ============================================================================

/**
 * Resolve the chat model for a structured side-call (studios, AI actions,
 * front page, feedback drafts), honoring the room's explicit `model` setting.
 * Returns `null` when Ollama is unreachable or has no models, so callers can
 * degrade to empty/partial output. Ported verbatim from
 * `resolve_structured_model`.
 *
 * `listModelsFn` defaults to the real, already-ported `engineRouting.ts`
 * implementation, which — per that file's own documented simplification —
 * never throws (folds every failure into `[]`), so the `try`/`catch` below is
 * dead code with the production default. Kept anyway (not collapsed away),
 * matching `feedbackTools.ts`'s identical, already-flagged fidelity note for
 * its own near-identical model-pick: it activates correctly the moment
 * `engineRouting.ts` grows a throwing variant, or a caller injects one — which
 * is exactly how {@link resolveStructuredModel}'s own "Ollama isn't running"
 * branch is unit-tested here.
 */
export async function resolveStructuredModel(
  rooms: RoomSource,
  listModelsFn: () => Promise<string[]> = listModelsReal
): Promise<string | null> {
  const explicit = structuredModelSetting(rooms);
  if (explicit !== null && isExternalEngine(explicit)) {
    return explicit;
  }
  const models = await availableStructuredModels(listModelsFn);
  return models === null ? null : explicit ?? bestLocalDefault(models);
}

export function structuredModelSetting(rooms: RoomSource): string | null {
  const room = rooms.current();
  return room === null ? null : modelSetting(room.db);
}

export async function availableStructuredModels(listModelsFn: () => Promise<string[]>): Promise<string[] | null> {
  let models: string[];
  try {
    models = await listModelsFn();
  } catch {
    return null;
  }
  return models.length === 0 ? null : models;
}

// ============================================================================
// generate_studio_html / clean_studio_html
// ============================================================================

/**
 * Ask the model to author a complete interactive HTML page for a Studio
 * artifact. Returns cleaned HTML, or `null` when the output isn't usable HTML
 * — the caller then falls back to a built-in template. Ported verbatim from
 * `generate_studio_html`.
 */
export async function generateStudioHtml(
  model: string,
  pageRole: string,
  instr: string,
  label: string,
  text: string,
  cancel: CancelFlag,
  chatStructuredFn: typeof chatStructuredReal = chatStructuredReal
): Promise<string | null> {
  const schema = { type: "object", properties: { html: { type: "string" } }, required: ["html"] };
  const messages: SidecarChatMessage[] = [
    { role: "system", content: `${pageRole}\n\n${SELF_CONTAINED_HTML_RULES}` },
    { role: "user", content: `${instr}\n\nBuild it only from this material about "${label}":\n\n${text}` },
  ];
  const raw = await chatStructuredFn(model, messages, 0.4, KEEP_ALIVE_WARM, schema, { cancel });
  return cleanStudioHtml(jsonStrField(raw, "html") ?? "");
}

/** Normalize model-authored HTML; `null` if it isn't a real HTML page (so the
 * caller can fall back to the built-in template). Ported verbatim from
 * `clean_studio_html`. `h.len() < 60` is BYTES in Rust, so the length check
 * goes through {@link byteLength} rather than `.length`. */
export function cleanStudioHtml(html: string): string | null {
  let h = unfenceStudioHtml(html);
  const low = h.toLowerCase();
  if (byteLength(h) < 60 || !hasStudioHtmlMarker(low)) {
    return null;
  }
  if (!low.includes("<html")) {
    h = studioHtmlDocument(h);
  }
  return h;
}

export function unfenceStudioHtml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const withoutFence = removeOpeningHtmlFence(trimmed).trimStart();
  const closingAt = withoutFence.lastIndexOf("```");
  return (closingAt === -1 ? withoutFence : withoutFence.slice(0, closingAt)).trim();
}

export function removeOpeningHtmlFence(html: string): string {
  const rest = html.slice(3);
  return rest.startsWith("html") ? rest.slice(4) : rest;
}

export function hasStudioHtmlMarker(html: string): boolean {
  return ["<html", "<!doctype", "<body", "<style", "<div"].some((marker) => html.includes(marker));
}

export function studioHtmlDocument(content: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${content}</body></html>`
  );
}
