// BROWSE-1: download gating — the Electron wiring.
//
// Port of `download_allowed`/`watch_download_size`/`import_finished_download`
// in src-tauri/src/browser.rs, wired to `session.on("will-download", …)` and a
// live `DownloadItem` instead of Tauri's `DownloadEvent::Requested`/`Finished`.
//
// Downloads land in the ROOM, never in `~/Downloads` (D9). The file is staged
// in the app's own temp area and imported into the room on completion.
//
// THE URL GUARD RUNS HERE, NOT ONLY IN THE NAVIGATION GATE. wry decides
// `.Download` BEFORE the navigation policy hook runs, so an `<a download>`
// click is the one navigation the gate never sees — and the same is true of
// Electron's `will-download`, which is reached instead of a navigation. The
// Rust test `the_download_path_runs_its_own_url_guard` pins that; this module
// keeps the guard for the same reason.
//
// WHAT ELECTRON MAKES BETTER, AND WHAT IT MAKES WORSE:
//
//  * Progress. Tauri's `DownloadEvent` has exactly two arms and no progress
//    callback, so `watch_download_size` has to `stat` the staged file on a 2s
//    timer just to notice an oversize transfer while it is still running.
//    `DownloadItem` fires a real `updated` event with `getReceivedBytes()`
//    already computed, so the timer — and the leak risk of a timer that outlives
//    its download — is gone. The warning still fires exactly ONCE, and still
//    does not claim to stop anything: nothing in either API can cancel a
//    transfer already in flight, and saying otherwise would be the fabrication
//    this module exists to prevent.
//  * De-duplication. Rust's `downloads: Map<url, StagedDownload>` exists only
//    because `Finished` carries nothing but the URL on macOS. Electron keeps
//    every listener attached to the live item, so there is no shared key for
//    two same-URL downloads to collide under, and the map is not ported (see
//    downloads.ts). The visible consequence is deliberate: a second download of
//    the same address now succeeds instead of being refused.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DownloadItem, Session } from "electron";
import { MAX_DOWNLOAD_BYTES, downloadOverLimit, safeFileName } from "./downloads.js";

/** The minimum of Electron's `DownloadItem` this module needs, so every
 *  decision below is testable against a scripted fake that can produce
 *  progress, completion and failure on command — which a real transfer cannot
 *  be made to do on a schedule inside a test. */
export interface DownloadItemLike {
  getURL(): string;
  getFilename(): string;
  getSavePath(): string;
  getReceivedBytes(): number;
  setSavePath(savePath: string): void;
  on(event: "updated", listener: (event: unknown, state: string) => void): unknown;
  once(event: "done", listener: (event: unknown, state: string) => void): unknown;
}

export interface DownloadGatingDeps {
  /** Where in-flight downloads are staged before import. Mirrors
   *  `staging_dir()`; swept on room close. */
  stagingDir(): string;
  /** Create the staging directory, mirroring the Rust `create_dir_all`. */
  ensureStagingDir(dir: string): void;
  /** The same literal guard the navigation gate applies. */
  isPublicHttpUrl(url: string): boolean;
  journal(kind: string, url: string, detail: string): void;
  emitBlocked(url: string): void;
  emitDownloadResult(payload: { url: string; name: string; ok: boolean; error?: string }): void;
  emitDownloadOversize(payload: { url: string; name: string; bytes: number; detail: string }): void;
  /** Move the finished, staged file into the room. Port of
   *  `import_finished_download`'s call into `commands::import_download`. */
  importFinishedDownload(stagedPath: string, name: string, url: string): Promise<{ name: string }>;
  /** Delete an abandoned staged file — a failed or cancelled download must not
   *  leave its partial file behind (Rust removes it in the `Finished` arm). */
  removeStagedFile(stagedPath: string): Promise<void>;
}

/**
 * Warn ONCE, while it is still downloading, that a file has already passed the
 * size a room can hold. Port of `watch_download_size`.
 *
 * The ceiling is `import_download`'s — the SAME number, deliberately, because
 * the point is to say early what that funnel will decide at the end.
 */
function watchDownloadSize(item: DownloadItemLike, name: string, deps: DownloadGatingDeps): void {
  let warned = false;
  item.on("updated", (_event, state) => {
    if (warned || state !== "progressing") return;
    const bytes = item.getReceivedBytes();
    if (!downloadOverLimit(bytes)) return;
    warned = true;
    const url = item.getURL();
    const limitMb = Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024));
    const detail =
      `${name} has already passed the ${limitMb} MB limit for a room file ` +
      `(${Math.floor(bytes / (1024 * 1024))} MB so far) — it will be refused when it finishes. ` +
      `Nothing here can stop a download that has started.`;
    deps.journal("download", url, detail);
    // Its OWN event, not `browser-download`: that one means "this download is
    // over, here is what happened", and reusing it would put a failure toast on
    // a transfer that is still running.
    deps.emitDownloadOversize({ url, name, bytes, detail });
  });
}

export type WillDownloadOutcome =
  | { accepted: true; stagedPath: string; name: string }
  | { accepted: false; reason: "blocked" | "staging-failed" };

/**
 * The whole decision, factored out of the listener so it is unit-testable.
 * Port of `download_allowed`'s two arms.
 */
export function handleWillDownload(
  event: { preventDefault(): void },
  item: DownloadItemLike,
  deps: DownloadGatingDeps,
): WillDownloadOutcome {
  const url = item.getURL();
  if (!deps.isPublicHttpUrl(url)) {
    deps.journal("blocked", url, "Download blocked: private or non-web address.");
    deps.emitBlocked(url);
    event.preventDefault();
    return { accepted: false, reason: "blocked" };
  }

  const name = safeFileName(item.getFilename() || "download");
  const dir = deps.stagingDir();
  try {
    deps.ensureStagingDir(dir);
  } catch (e) {
    // Refusing with no other trace makes clicking the link simply appear to do
    // nothing. Say why.
    const message = e instanceof Error ? e.message : String(e);
    deps.journal("download", url, `Download could not be started: ${message}`);
    deps.emitDownloadResult({
      url,
      name,
      ok: false,
      error: `The download could not be prepared: ${message}`,
    });
    event.preventDefault();
    return { accepted: false, reason: "staging-failed" };
  }

  const stagedPath = path.join(dir, `${randomUUID()}-${name}`);
  item.setSavePath(stagedPath);
  deps.journal("download", url, `Downloading ${name}`);
  watchDownloadSize(item, name, deps);

  item.once("done", (_event, state) => {
    // `getSavePath()` is the path Electron actually wrote to; it is normally the
    // one set above, and asking the item is more truthful than assuming.
    const finalPath = item.getSavePath() || stagedPath;
    if (state !== "completed") {
      void deps.removeStagedFile(finalPath).catch(() => {});
      deps.journal("download", url, "Download failed");
      deps.emitDownloadResult({ url, name, ok: false, error: "Download failed" });
      return;
    }
    void deps.importFinishedDownload(finalPath, name, url).then(
      (meta) => {
        deps.journal("download", url, `${meta.name} arrived in the room`);
        deps.emitDownloadResult({ url, name: meta.name, ok: true });
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        deps.journal("download", url, `Import failed: ${message}`);
        deps.emitDownloadResult({ url, name, ok: false, error: message });
      },
    );
  });

  return { accepted: true, stagedPath, name };
}

/** The minimum of `Session` this module needs. */
export interface DownloadSessionLike {
  on(
    event: "will-download",
    listener: (event: { preventDefault(): void }, item: DownloadItem) => void,
  ): unknown;
}

/** Register the real `will-download` listener on one page's session. */
export function attachDownloadGating(
  session: DownloadSessionLike | Session,
  deps: DownloadGatingDeps,
): void {
  (session as DownloadSessionLike).on("will-download", (event, item) => {
    handleWillDownload(event, item as unknown as DownloadItemLike, deps);
  });
}
