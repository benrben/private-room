// Download gating, against a scripted fake `DownloadItem` — the only way to
// make a transfer report progress, completion and failure on command.
//
// Ports `the_download_path_runs_its_own_url_guard` and
// `an_oversize_download_is_noticed_while_it_is_still_arriving`, both of which
// the Rust side could only pin as SOURCE SCANS.

import { describe, expect, it, vi } from "vitest";
import {
  attachDownloadGating,
  handleWillDownload,
  type DownloadGatingDeps,
  type DownloadItemLike,
} from "./downloadGating.js";
import { MAX_DOWNLOAD_BYTES } from "./downloads.js";
import { checkPublicHttpUrl } from "./guard.js";

interface Recorder {
  journalled: Array<[string, string, string]>;
  blocked: string[];
  results: Array<{ url: string; name: string; ok: boolean; error?: string }>;
  oversize: Array<{ url: string; name: string; bytes: number; detail: string }>;
  removed: string[];
  imported: Array<[string, string, string]>;
}

function fakeDeps(
  over: Partial<DownloadGatingDeps> = {},
): { deps: DownloadGatingDeps; rec: Recorder } {
  const rec: Recorder = {
    journalled: [],
    blocked: [],
    results: [],
    oversize: [],
    removed: [],
    imported: [],
  };
  const deps: DownloadGatingDeps = {
    stagingDir: () => "/tmp/arcelle-browse-downloads",
    ensureStagingDir: () => {},
    isPublicHttpUrl: (url) => {
      try {
        checkPublicHttpUrl(url);
        return true;
      } catch {
        return false;
      }
    },
    journal: (kind, url, detail) => rec.journalled.push([kind, url, detail]),
    emitBlocked: (url) => rec.blocked.push(url),
    emitDownloadResult: (p) => rec.results.push(p),
    emitDownloadOversize: (p) => rec.oversize.push(p),
    importFinishedDownload: async (path, name, url) => {
      rec.imported.push([path, name, url]);
      return { name };
    },
    removeStagedFile: async (p) => {
      rec.removed.push(p);
    },
    ...over,
  };
  return { deps, rec };
}

function fakeItem(url: string, filename = "report.pdf") {
  let savePath = "";
  let received = 0;
  const listeners = { updated: [] as Array<(e: unknown, s: string) => void>, done: [] as Array<(e: unknown, s: string) => void> };
  const item: DownloadItemLike = {
    getURL: () => url,
    getFilename: () => filename,
    getSavePath: () => savePath,
    getReceivedBytes: () => received,
    setSavePath: (p) => {
      savePath = p;
    },
    on: (_event, listener) => listeners.updated.push(listener),
    once: (_event, listener) => listeners.done.push(listener),
  };
  return {
    item,
    savePath: () => savePath,
    progress(bytes: number, state = "progressing") {
      received = bytes;
      for (const l of listeners.updated) l({}, state);
    },
    finish(state: string) {
      for (const l of listeners.done) l({}, state);
    },
  };
}

const willDownloadEvent = () => ({ preventDefault: vi.fn() });

it("attaches the session listener that drives the same download gate", () => {
  let listener: ((event: ReturnType<typeof willDownloadEvent>, item: DownloadItemLike) => void) | undefined;
  const session = {
    on: vi.fn((_event: "will-download", callback: typeof listener) => { listener = callback; }),
  };
  const { deps, rec } = fakeDeps();
  const event = willDownloadEvent();

  attachDownloadGating(session, deps);
  listener?.(event, fakeItem("http://127.0.0.1/private").item);

  expect(session.on).toHaveBeenCalledWith("will-download", expect.any(Function));
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(rec.blocked).toEqual(["http://127.0.0.1/private"]);
});

describe("the_download_path_runs_its_own_url_guard", () => {
  it("refuses a private-network download and cancels it", () => {
    // wry decides `.Download` BEFORE the navigation policy hook runs, and
    // Electron reaches `will-download` instead of a navigation, so an
    // <a download> click is the one navigation the gate never sees.
    const { deps, rec } = fakeDeps();
    const { item } = fakeItem("http://127.0.0.1:11434/secrets.json");
    const event = willDownloadEvent();

    const outcome = handleWillDownload(event, item, deps);
    expect(outcome).toEqual({ accepted: false, reason: "blocked" });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(rec.journalled).toEqual([
      ["blocked", "http://127.0.0.1:11434/secrets.json", "Download blocked: private or non-web address."],
    ]);
    expect(rec.blocked).toEqual(["http://127.0.0.1:11434/secrets.json"]);
  });

  it("accepts a public download and stages it under a UUID-prefixed safe name", () => {
    const { deps, rec } = fakeDeps();
    const f = fakeItem("https://example.com/../../etc/passwd", "../../etc/passwd");
    const outcome = handleWillDownload(willDownloadEvent(), f.item, deps);

    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) throw new Error("unreachable");
    expect(outcome.name).toBe(".._.._etc_passwd");
    expect(f.savePath()).toBe(outcome.stagedPath);
    // Staged in OUR directory, under a name that cannot climb out of it.
    expect(outcome.stagedPath.startsWith("/tmp/arcelle-browse-downloads/")).toBe(true);
    expect(outcome.stagedPath).toMatch(/\/[0-9a-f-]{36}-\.\._\.\._etc_passwd$/);
    expect(rec.journalled).toEqual([
      ["download", "https://example.com/../../etc/passwd", "Downloading .._.._etc_passwd"],
    ]);
  });

  it("says WHY when the staging directory cannot be made, instead of doing nothing visible", () => {
    // Refusing here cancels the download with no other trace, so clicking the
    // link simply appeared to do nothing.
    const { deps, rec } = fakeDeps({
      ensureStagingDir: () => {
        throw new Error("Read-only file system");
      },
    });
    const { item } = fakeItem("https://example.com/report.pdf");
    const event = willDownloadEvent();

    expect(handleWillDownload(event, item, deps)).toEqual({
      accepted: false,
      reason: "staging-failed",
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(rec.journalled[0]?.[2]).toContain("Read-only file system");
    expect(rec.results[0]?.ok).toBe(false);
    expect(rec.results[0]?.error).toContain("could not be prepared");
  });
});

describe("an_oversize_download_is_noticed_while_it_is_still_arriving", () => {
  it("warns ONCE, while it is still running, and does not claim to stop it", () => {
    const { deps, rec } = fakeDeps();
    const f = fakeItem("https://example.com/huge.zip", "huge.zip");
    handleWillDownload(willDownloadEvent(), f.item, deps);

    f.progress(1024);
    expect(rec.oversize).toHaveLength(0);

    f.progress(MAX_DOWNLOAD_BYTES + 1);
    expect(rec.oversize).toHaveLength(1);
    expect(rec.oversize[0]?.detail).toContain("900 MB limit");
    expect(rec.oversize[0]?.detail).toContain("Nothing here can stop a download that has started.");

    // Still growing — but the user has already been told once.
    f.progress(MAX_DOWNLOAD_BYTES * 2);
    expect(rec.oversize).toHaveLength(1);
  });

  it("uses its OWN event, never the one that means 'this download is over'", () => {
    // Reusing `browser-download` would put a failure toast on a transfer that
    // is still running.
    const { deps, rec } = fakeDeps();
    const f = fakeItem("https://example.com/huge.zip");
    handleWillDownload(willDownloadEvent(), f.item, deps);
    f.progress(MAX_DOWNLOAD_BYTES + 1);
    expect(rec.oversize).toHaveLength(1);
    expect(rec.results).toHaveLength(0);
  });

  it("ignores progress reported for an interrupted item", () => {
    const { deps, rec } = fakeDeps();
    const f = fakeItem("https://example.com/huge.zip");
    handleWillDownload(willDownloadEvent(), f.item, deps);
    f.progress(MAX_DOWNLOAD_BYTES + 1, "interrupted");
    expect(rec.oversize).toHaveLength(0);
  });
});

describe("completion", () => {
  it("imports a finished download into the room and reports what arrived", () => {
    const { deps, rec } = fakeDeps();
    const f = fakeItem("https://example.com/report.pdf");
    const outcome = handleWillDownload(willDownloadEvent(), f.item, deps);
    if (!outcome.accepted) throw new Error("unreachable");

    f.finish("completed");
    return Promise.resolve().then(() => {
      expect(rec.imported).toEqual([[outcome.stagedPath, "report.pdf", "https://example.com/report.pdf"]]);
      expect(rec.journalled.at(-1)?.[2]).toBe("report.pdf arrived in the room");
      expect(rec.results).toEqual([
        { url: "https://example.com/report.pdf", name: "report.pdf", ok: true },
      ]);
    });
  });

  it("reports an import failure without pretending the download itself failed", async () => {
    const { deps, rec } = fakeDeps({
      importFinishedDownload: async () => {
        throw new Error("that file is too big for a room");
      },
    });
    const f = fakeItem("https://example.com/report.pdf");
    handleWillDownload(willDownloadEvent(), f.item, deps);
    f.finish("completed");
    await Promise.resolve();
    await Promise.resolve();

    expect(rec.journalled.at(-1)?.[2]).toContain("Import failed: that file is too big");
    expect(rec.results[0]?.ok).toBe(false);
    expect(rec.results[0]?.error).toContain("too big");
  });

  it("removes the staged file and says so when a download is cancelled or interrupted", () => {
    // A failed transfer must not leave its partial file behind in the staging
    // directory.
    const { deps, rec } = fakeDeps();
    const f = fakeItem("https://example.com/report.pdf");
    const outcome = handleWillDownload(willDownloadEvent(), f.item, deps);
    if (!outcome.accepted) throw new Error("unreachable");

    f.finish("cancelled");
    expect(rec.removed).toEqual([outcome.stagedPath]);
    expect(rec.journalled.at(-1)).toEqual(["download", "https://example.com/report.pdf", "Download failed"]);
    expect(rec.results[0]?.ok).toBe(false);
    expect(rec.imported).toEqual([]);
  });

  it("lets two concurrent downloads of the SAME address both succeed", () => {
    // Rust refuses the duplicate because its `Finished` event carries only the
    // URL, so two staged paths under one key are indistinguishable. Electron
    // keeps every listener on the live item, so there is no shared key and no
    // reason to refuse — a deliberate, visible behaviour change.
    const { deps, rec } = fakeDeps();
    const a = fakeItem("https://example.com/report.pdf");
    const b = fakeItem("https://example.com/report.pdf");
    const first = handleWillDownload(willDownloadEvent(), a.item, deps);
    const second = handleWillDownload(willDownloadEvent(), b.item, deps);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) throw new Error("unreachable");
    // Different staging paths, so neither can overwrite the other's file.
    expect(first.stagedPath).not.toBe(second.stagedPath);
    expect(rec.blocked).toEqual([]);
  });
});
