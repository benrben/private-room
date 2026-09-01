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
import { errMessage, safeScopeName } from "./studiosScope.js";
// ============================================================================
// open_html_in_browser
// ============================================================================

export const PREVIEW_DIR_NAME = "arcelle-preview";

/** Where staged/opened preview HTML lives — `std::env::temp_dir().join(
 * "arcelle-preview")`. */
export function previewDir(): string {
  return path.join(os.tmpdir(), PREVIEW_DIR_NAME);
}

/** `std::process::Command::new("/usr/bin/open").arg(&path).spawn()` — waits
 * only long enough to know the OS accepted the launch (Node's `spawn` event),
 * matching Rust's synchronous `Result<Child, io::Error>`; never waits for the
 * browser itself to exit. */
export async function realOpenPath(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [filePath]);
    child.once("error", (err: Error) => reject(err));
    child.once("spawn", () => resolve());
  });
}

/**
 * Write an HTML document to a temp file and open it in the user's real
 * browser, where interactive/JS pages render fully. Mac-only. Ported verbatim
 * from `open_html_in_browser`. `openPath` is a test seam over the real
 * `/usr/bin/open` spawn.
 */
export async function openHtmlInBrowser(
  name: string | null,
  html: string,
  openPath: (filePath: string) => Promise<void> = realOpenPath
): Promise<string> {
  const dir = previewDir();
  await createPreviewDirectory(dir);
  const filePath = path.join(dir, `${previewFileBase(name)}-${Date.now()}.html`);
  await writePreviewHtml(filePath, html);
  await openPreviewHtml(openPath, filePath);
  return filePath;
}

export async function createPreviewDirectory(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Couldn't create the preview folder: ${errMessage(err)}`);
  }
}

export function previewFileBase(name: string | null): string {
  if (name === null) {
    return "preview";
  }
  const folded = safeScopeName(stripPreviewHtmlSuffix(name));
  return folded === "" ? "preview" : folded;
}

export function stripPreviewHtmlSuffix(name: string): string {
  if (name.endsWith(".html")) {
    return name.slice(0, -".html".length);
  }
  return name.endsWith(".htm") ? name.slice(0, -".htm".length) : name;
}

export async function writePreviewHtml(filePath: string, html: string): Promise<void> {
  try {
    await fsp.writeFile(filePath, html, "utf8");
  } catch (err) {
    throw new Error(`Couldn't write the preview file: ${errMessage(err)}`);
  }
}

export async function openPreviewHtml(openPath: (filePath: string) => Promise<void>, filePath: string): Promise<void> {
  try {
    await openPath(filePath);
  } catch (err) {
    throw new Error(`Couldn't open your browser: ${errMessage(err)}`);
  }
}

// ============================================================================
// cleanup_browser_previews / cleanup_browser_previews_older_than /
// sweep_previews_older_than
// ============================================================================

/** Sweep the browser-preview folder clean at startup (files from a
 * crashed/force-quit session). Ported verbatim from
 * `cleanup_browser_previews`. Best-effort: must never block startup/exit. */
export function cleanupBrowserPreviews(): void {
  try {
    fs.rmSync(previewDir(), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * The body of {@link cleanupBrowserPreviewsOlderThan}, over an explicit
 * directory so the age rule is testable without touching the shared temp dir
 * every other test and the running app share. Ported verbatim from
 * `sweep_previews_older_than`.
 */
export function sweepPreviewsOlderThan(dir: string, graceMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // nothing was ever opened this session
  }
  const now = Date.now();
  for (const name of names) {
    const p = path.join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue; // an unreadable timestamp leaves the file alone, matching Rust
    }
    if (now - mtimeMs >= graceMs) {
      try {
        fs.rmSync(p);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * The same sweep as {@link cleanupBrowserPreviews}, but only for files that
 * have had time to be read — called mid-session (room lock), where an eager
 * sweep could pull a page out from under the browser that just opened it.
 * Ported verbatim from `cleanup_browser_previews_older_than`.
 */
export function cleanupBrowserPreviewsOlderThan(graceMs: number): void {
  sweepPreviewsOlderThan(previewDir(), graceMs);
}

// ============================================================================
// stage_preview_html / stage_preview_html_core
// ============================================================================

/** How many staged preview pages the store holds. */
export const PREVIEW_MAX = 24;

/** `HtmlPreviews` — see this module's own doc for why a plain object (no
 * `Mutex`/`AtomicU64`) is the whole port. */
export interface HtmlPreviews {
  next: number;
  map: Map<string, string>;
}

export function createHtmlPreviews(): HtmlPreviews {
  return { next: 0, map: new Map() };
}

/**
 * Stage a self-contained HTML page for the isolated in-app preview and return
 * a token. Full store → the OLDEST entry (by token, tokens are a monotonic
 * counter) is evicted; clearing the whole map instead took the page the user
 * still had open down with it. Ported verbatim from `stage_preview_html_core`.
 */
export function stagePreviewHtmlCore(previews: HtmlPreviews, html: string): string {
  const token = String(previews.next);
  previews.next += 1;
  while (previews.map.size >= PREVIEW_MAX) {
    let oldestKey: string | undefined;
    let oldestVal = Number.POSITIVE_INFINITY;
    for (const k of previews.map.keys()) {
      const n = Number(k);
      const val = Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
      if (val < oldestVal) {
        oldestVal = val;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) {
      break;
    }
    previews.map.delete(oldestKey);
  }
  previews.map.set(token, html);
  return token;
}
