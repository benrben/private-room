// REAL-Electron integration tests for BROWSE-1.
//
// CAN THIS WORKSPACE EXERCISE REAL ELECTRON MAIN-PROCESS APIS? Not from inside
// vitest: `vitest.config.ts` runs `environment: "node"`, and under plain Node
// `import "electron"` resolves to the STRING PATH of the Electron binary rather
// than the API object — keychain.ts's and menu.ts's own doc comments record the
// same thing, which is why nothing else in this workspace constructs a live
// `BrowserWindow`/`session`/`Menu`.
//
// BUT this repo's shell has `ELECTRON_RUN_AS_NODE=1` set, and that variable is
// exactly what makes `require("electron")` degrade to the path string: Electron
// checks it on startup and, when set, skips its own bootstrap and behaves like
// plain Node. Clearing it for a SPAWNED CHILD restores the real runtime. So
// these tests spawn the real Electron binary (whose path is, conveniently, what
// `import "electron"` gives this process) running browserLive.worker.cjs, and
// read back one JSON line.
//
// WHAT THAT BUYS, AND WHY IT IS NOT DECORATION. Five architectural choices in
// this port were unverifiable from a Node process, and every one of them is
// load-bearing: whether a non-`persist:` partition really is non-persistent;
// whether a `webRequest` listener really cancels a request Chromium would
// otherwise complete; whether a `contextBridge` export from a sandboxed,
// context-isolated preload actually reaches a real page's main world, in every
// frame, before the page's own first inline script; whether
// `nodeIntegrationInSubFrames` is required for that; and which navigation
// events a `loadURL` and a 302 actually fire. Both candidate ports flagged
// several of these as "genuinely unverified from here". They are verified here.
//
// STILL NOT COVERED, and stated plainly: a full page DRIVE (snapshot → act →
// settle) against a real site, download gating against a real transfer, and the
// orchestrator's own sequencing (browser.ts) — all of which need either the
// network or a much larger fixture than this pass builds.

import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_SCRIPT_PATHS } from "./pageScript.js";

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "browserLive.worker.cjs",
);

async function electronBinaryPath(): Promise<string> {
  const mod = (await import("electron")) as unknown as { default: string };
  return mod.default;
}

async function runWorker(
  [scenario, ...extras]: string[],
  timeoutMs = 75_000,
): Promise<Record<string, unknown>> {
  const electronPath = await electronBinaryPath();
  const env = { ...process.env };
  // THE ONE LOAD-BEARING LINE — see this file's header.
  delete env["ELECTRON_RUN_AS_NODE"];

  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      // The worker's own arg contract: scenario, ordered page-script paths,
      // then extras.
      [WORKER_PATH, scenario as string, JSON.stringify(PAGE_SCRIPT_PATHS), ...extras],
      { env, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`electron worker failed: ${error.message}\nstderr: ${stderr}\nstdout: ${stdout}`));
          return;
        }
        const line = stdout
          .split("\n")
          .reverse()
          .find((l) => l.startsWith("RESULT:"));
        if (!line) {
          reject(new Error(`no RESULT line from the worker.\nstdout: ${stdout}\nstderr: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(line.slice("RESULT:".length)));
        } catch {
          reject(new Error(`could not parse the worker result: ${line}`));
        }
      },
    );
  });
}

describe("verify_ephemeral, against a REAL session rather than the flag we set", () => {
  it("confirms a partition WITHOUT persist: is non-persistent, and WITH it is not", async () => {
    const r = await runWorker(["ephemeral"]);
    expect(r["ephemeralIsPersistent"]).toBe(false);
    // The second, independent question `verifyPageEphemeral` also asks.
    expect(r["ephemeralStoragePath"]).toBeNull();
    expect(r["persistentIsPersistent"]).toBe(true);
    expect(r["persistentHasStoragePath"]).toBe(true);
  }, 90_000);

  it("confirms a partition NAME is a session's identity for the life of the process", async () => {
    // This is why a page's partition is a fresh UUID and not something derived
    // from its page id: ids restart at "0" for every new room, so a name-derived
    // partition would hand a new room's first page the PREVIOUS room's in-memory
    // cookies and storage — exactly the trace this browser promises not to keep.
    const r = await runWorker(["ephemeral"]);
    expect(r["sameNameIsTheSameSession"]).toBe(true);
    expect(r["differentNamesAreDifferentSessions"]).toBe(true);
  }, 90_000);
});

describe("content blocking, against a REAL local server and a REAL webRequest handler", () => {
  it("cancels the request through a session with our handler, and completes it through one without", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not bind a local test server");
    }

    try {
      const r = await runWorker(["webrequest-block", String(address.port)]);
      const blocked = r["blocked"] as { ok: boolean };
      const allowed = r["allowed"] as { ok: boolean; status?: number };
      expect(blocked.ok).toBe(false);
      // The SAME address through a session with no handler must succeed, or the
      // block above proves nothing but an unreachable server.
      expect(allowed.ok).toBe(true);
      expect(allowed.status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 90_000);
});

describe("real WebContentsViews attached to a real BaseWindow", () => {
  it("gives each page its own webContents and its own non-persistent session", async () => {
    const r = await runWorker(["views"]);
    const views = r["views"] as Array<{ id: number; sessionIsPersistent: boolean }>;
    expect(views).toHaveLength(3);
    expect(r["allUnique"]).toBe(true);
    for (const v of views) expect(v.sessionIsPersistent).toBe(false);
  }, 90_000);
});

describe("the page script really reaches a real page", () => {
  it("is in the main world, in every frame, BEFORE the page's own first inline script", async () => {
    const r = await runWorker(["preload"]);

    // A preload runs in an isolated world under contextIsolation, so this is
    // the contextBridge export in page.js's footer actually working.
    expect(r["bridgeInMainWorld"]).toBe("object");
    // The race both candidate ports flagged as unverifiable: the page's OWN
    // first inline <script> already saw the bridge.
    expect(r["sawBridgeAtFirstInlineScript"]).toBe("object");

    const ping = r["ping"] as { ok: boolean; url: string; doc: string };
    expect(ping.ok).toBe(true);
    expect(typeof ping.doc).toBe("string");
    // A real snapshot of a real DOM, through the bridge.
    expect(r["snapshotLabels"]).toEqual(["Hello"]);

    // Every frame gets its own instance with its own per-document nonce, which
    // is what `initialization_script_for_all_frames` gave the Tauri app.
    expect(r["frameCount"]).toBe(1);
    expect(r["subframeBridge"]).toBe("object");
    expect(r["subframeDoc"]).not.toBe(r["mainDoc"]);
  }, 90_000);

  it("needs nodeIntegrationInSubFrames for sub-frames — the flag is load-bearing", async () => {
    const r = await runWorker(["preload"]);
    expect(r["withoutSubFrameFlag_main"]).toBe("object");
    expect(r["withoutSubFrameFlag_frameCount"]).toBe(1);
    // Without the flag the sub-frame gets NOTHING. A port that omitted it would
    // silently lose every iframe.
    expect(r["withoutSubFrameFlag_sub"]).toBe("undefined");
  }, 90_000);

  it("lets the host's superseded mark be seen by the readiness probe", async () => {
    const r = await runWorker(["preload"]);
    // markSuperseded writes in the main world through executeJavaScript; READY_JS
    // reads it there. "The mark is present" must read as still-loading.
    expect(r["readyProbeAfterSuperseded"]).toEqual({ ok: false, refused: false });
  }, 90_000);
});

describe("which navigations Electron actually reports", () => {
  it("does NOT fire a navigation event for loadURL — why browser.ts guards that path itself", async () => {
    const r = await runWorker(["preload"]);
    const events = r["navEventsDuringLoadURL"] as Array<{ url: string; isMainFrame: boolean }>;
    // The only event during a main-frame loadURL is the IFRAME's own load.
    expect(events.every((e) => e.isMainFrame === false)).toBe(true);
    expect(events.some((e) => e.url.endsWith("/frame"))).toBe(true);
  }, 90_000);

  it("fires will-redirect, and ONLY will-redirect, for a server-side 302", async () => {
    // This is why navigation.ts listens on both events: a page answering
    // 302 -> a private address would otherwise walk straight past the gate.
    const r = await runWorker(["navigation-events"]);
    const events = r["redirectEvents"] as Array<{ event: string; url: string; isMainFrame: boolean }>;
    expect(events.map((e) => e.event)).toEqual(["will-redirect"]);
    expect(events[0]?.isMainFrame).toBe(true);
    expect(events[0]?.url).toMatch(/\/landing$/);
    expect(r["finalUrl"]).toMatch(/\/landing$/);
  }, 90_000);

  it("resolves a bare window.open() to about:blank — why popup.ts refuses to navigate there", async () => {
    const r = await runWorker(["navigation-events"]);
    const opens = r["windowOpenDetails"] as Array<{ url: string }>;
    expect(opens).toHaveLength(1);
    expect(opens[0]?.url).toBe("about:blank");
  }, 90_000);

  it("reports an EMPTY top-frame url for a main-frame request — why resolveTopLevelUrl special-cases it", async () => {
    const r = await runWorker(["navigation-events"]);
    const reqs = r["webRequests"] as Array<{
      url: string;
      resourceType: string;
      hasFrame: boolean;
      topUrl: string | null;
    }>;
    const main = reqs.find((q) => q.resourceType === "mainFrame");
    const sub = reqs.find((q) => q.resourceType === "subFrame");
    expect(main?.topUrl).toBe("");
    // …while a sub-resource DOES get the real top document, which is what makes
    // third-party classification work at all.
    expect(sub?.topUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  }, 90_000);
});
