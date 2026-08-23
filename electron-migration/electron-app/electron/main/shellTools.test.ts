/**
 * Tests for `shellTools.ts` — the three `arcelle.shell` handlers.
 *
 * The scope tests are the ones worth reading twice. `isAllowedOpenUrl` is not a
 * generic "is this a URL" check: it is this app's OWN grant, ported from
 * `src-tauri/capabilities/default.json`, which is the plugin's default regex
 * PLUS `x-apple.systempreferences:*`. Shipping the regex alone (what one of
 * this batch's merge candidates did) passes every hand-written test anyone
 * would think to write and still breaks a real, shipping button —
 * `RecordingView.tsx` sends the user to the Screen Recording pane with exactly
 * that scheme. That URL is pinned below, verbatim.
 */

import { describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  execFileOpenWithApp,
  isAllowedOpenUrl,
  openPath,
  openUrl,
  registerShellIpc,
  revealItemInDir,
  type ShellDeps,
} from "./shellTools.js";

/** The exact string `src/viewers/RecordingView.tsx` opens. */
const SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

function fakeDeps(openPathResult = ""): ShellDeps & {
  openExternal: ReturnType<typeof vi.fn>;
  openPathFn: ReturnType<typeof vi.fn>;
  showItemInFolder: ReturnType<typeof vi.fn>;
  openWithAppFn: ReturnType<typeof vi.fn>;
} {
  const openExternal = vi.fn(() => Promise.resolve());
  const openPathFn = vi.fn(() => Promise.resolve(openPathResult));
  const showItemInFolder = vi.fn();
  const openWithAppFn = vi.fn(() => Promise.resolve());
  return {
    shell: { openExternal, openPath: openPathFn, showItemInFolder },
    openWithApp: openWithAppFn,
    openExternal,
    openPathFn,
    showItemInFolder,
    openWithAppFn,
  };
}

const fakeEvent = {} as IpcMainInvokeEvent;

function fakeIpcMain(): {
  ipcMain: Pick<IpcMain, "handle">;
  handlers: Map<string, (event: IpcMainInvokeEvent, args?: unknown) => unknown>;
} {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, args?: unknown) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
        handlers.set(channel, listener as (event: IpcMainInvokeEvent, args?: unknown) => unknown);
      },
    } as Pick<IpcMain, "handle">,
  };
}

describe("isAllowedOpenUrl", () => {
  it("accepts the shapes the plugin's own default scope accepts", () => {
    expect(isAllowedOpenUrl("https://ollama.com/download")).toBe(true);
    expect(isAllowedOpenUrl("http://localhost:3000/x")).toBe(true);
    expect(isAllowedOpenUrl("mailto:someone@example.com")).toBe(true);
    expect(isAllowedOpenUrl("tel:15551234567")).toBe(true);
    expect(
      isAllowedOpenUrl("https://github.com/x/y/issues/new?title=Hello%20there")
    ).toBe(true);
  });

  it("carries the plugin regex's own `tel:+…` quirk rather than quietly improving on it", () => {
    // `tel:\w+` does not match a leading `+`, so the ordinary international
    // dialling form is outside Tauri's OWN default scope — measured against the
    // real regex, not assumed. Pinned rather than fixed: this app has no `tel:`
    // call site at all, and silently widening a security boundary to be nicer
    // than the thing being ported is how a scope stops meaning anything. If a
    // `tel:` link is ever added, THIS test is the one that says the widening
    // was a decision.
    expect(isAllowedOpenUrl("tel:+15551234567")).toBe(false);
  });

  it("accepts the macOS settings-pane scheme this app's capability file grants", () => {
    // RED on a port that ships only the plugin's default regex: this is a live
    // call site (`RecordingView.tsx`), and refusing it would look like the app
    // refusing its own help link.
    expect(isAllowedOpenUrl(SCREEN_CAPTURE_SETTINGS_URL)).toBe(true);
  });

  it("refuses everything else, including the shapes that would reach a local handler", () => {
    expect(isAllowedOpenUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedOpenUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedOpenUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isAllowedOpenUrl("")).toBe(false);
    // The scheme alone, with nothing after it, is not a target.
    expect(isAllowedOpenUrl("x-apple.systempreferences:")).toBe(false);
    // A scheme that merely STARTS like an allowed one.
    expect(isAllowedOpenUrl("x-apple.systempreferences-evil:whatever")).toBe(false);
  });
});

describe("openUrl", () => {
  it("opens an in-scope URL through shell.openExternal", async () => {
    const deps = fakeDeps();
    await openUrl(deps, { url: "https://example.com/page" });
    expect(deps.openExternal).toHaveBeenCalledWith("https://example.com/page");
  });

  it("refuses an out-of-scope URL WITHOUT calling the shell", async () => {
    const deps = fakeDeps();
    await expect(openUrl(deps, { url: "file:///etc/passwd" })).rejects.toThrow(
      "outside the app's URL scope"
    );
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("refuses an empty url", async () => {
    const deps = fakeDeps();
    await expect(openUrl(deps, { url: "" })).rejects.toThrow("non-empty `url`");
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("`with` routes through the /usr/bin/open bridge instead of the shell", async () => {
    const deps = fakeDeps();
    await openUrl(deps, { url: "https://example.com/page", with: "Firefox" });
    expect(deps.openWithAppFn).toHaveBeenCalledWith("Firefox", "https://example.com/page");
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("`with` does NOT get to skip the scope check", async () => {
    // The scope is about which URLs this app opens at all, not about which
    // mechanism opens them — an `openWith` that bypassed it would be a way
    // around the boundary rather than a feature.
    const deps = fakeDeps();
    await expect(openUrl(deps, { url: "file:///etc/passwd", with: "TextEdit" })).rejects.toThrow(
      "outside the app's URL scope"
    );
    expect(deps.openWithAppFn).not.toHaveBeenCalled();
  });
});

describe("openPath", () => {
  it("opens through shell.openPath and resolves on its empty-string success sentinel", async () => {
    const deps = fakeDeps("");
    await expect(openPath(deps, { path: "/tmp/file.pdf" })).resolves.toBeUndefined();
    expect(deps.openPathFn).toHaveBeenCalledWith("/tmp/file.pdf");
  });

  it("THROWS on the error string shell.openPath resolves with instead of rejecting", async () => {
    // Electron's own contract: `openPath` never rejects. A caller written
    // against the plugin's reject-on-failure behavior would otherwise treat a
    // failure as success.
    const deps = fakeDeps("Failed to open path");
    await expect(openPath(deps, { path: "/nope" })).rejects.toThrow("Failed to open path");
  });

  it("refuses an empty path", async () => {
    const deps = fakeDeps();
    await expect(openPath(deps, { path: "" })).rejects.toThrow("non-empty `path`");
    expect(deps.openPathFn).not.toHaveBeenCalled();
  });

  it("`with` routes through the bridge, and no URL scope applies to a path", async () => {
    const deps = fakeDeps();
    await openPath(deps, { path: "/tmp/movie.mkv", with: "VLC" });
    expect(deps.openWithAppFn).toHaveBeenCalledWith("VLC", "/tmp/movie.mkv");
    expect(deps.openPathFn).not.toHaveBeenCalled();
  });
});

describe("revealItemInDir", () => {
  it("reveals every path given, in order", () => {
    const deps = fakeDeps();
    revealItemInDir(deps, { paths: ["/a/one", "/b/two"] });
    expect(deps.showItemInFolder.mock.calls).toEqual([["/a/one"], ["/b/two"]]);
  });

  it("refuses an empty list rather than silently doing nothing", () => {
    const deps = fakeDeps();
    expect(() => revealItemInDir(deps, { paths: [] })).toThrow("non-empty `paths`");
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });

  it("validates the WHOLE list before revealing any of it", () => {
    // `showItemInFolder` is synchronous and per-path, so a bad entry checked
    // lazily would leave the first half of the list revealed and the call
    // rejected — a half-done operation reported as a failure.
    const deps = fakeDeps();
    expect(() => revealItemInDir(deps, { paths: ["/a/one", ""] })).toThrow("non-empty string");
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("registerShellIpc", () => {
  it("registers exactly the three shell channels", () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerShellIpc(ipcMain, fakeDeps());
    expect([...handlers.keys()].sort()).toEqual(["open_path", "open_url", "reveal_item_in_dir"]);
  });

  it("a malformed payload is refused rather than reaching the shell", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerShellIpc(ipcMain, deps);
    await expect(handlers.get("open_url")!(fakeEvent, { url: 42 })).rejects.toThrow(
      "non-empty `url`"
    );
    await expect(handlers.get("open_url")!(fakeEvent, undefined)).rejects.toThrow(
      "non-empty `url`"
    );
    await expect(handlers.get("open_path")!(fakeEvent, null)).rejects.toThrow("non-empty `path`");
    expect(() => handlers.get("reveal_item_in_dir")!(fakeEvent, { paths: "not an array" })).toThrow(
      "non-empty `paths`"
    );
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(deps.openPathFn).not.toHaveBeenCalled();
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });

  it("a non-string `with` is ignored rather than passed to the bridge", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerShellIpc(ipcMain, deps);
    await handlers.get("open_url")!(fakeEvent, { url: "https://example.com/x", with: 7 });
    expect(deps.openWithAppFn).not.toHaveBeenCalled();
    expect(deps.openExternal).toHaveBeenCalledWith("https://example.com/x");
  });

  it("registered handlers really reach the injected shell", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerShellIpc(ipcMain, deps);
    await handlers.get("open_url")!(fakeEvent, { url: SCREEN_CAPTURE_SETTINGS_URL });
    await handlers.get("open_path")!(fakeEvent, { path: "/tmp/x" });
    await handlers.get("reveal_item_in_dir")!(fakeEvent, { paths: ["/tmp/x"] });
    expect(deps.openExternal).toHaveBeenCalledWith(SCREEN_CAPTURE_SETTINGS_URL);
    expect(deps.openPathFn).toHaveBeenCalledWith("/tmp/x");
    expect(deps.showItemInFolder).toHaveBeenCalledWith("/tmp/x");
  });
});

describe("execFileOpenWithApp — the real subprocess", () => {
  it("REJECTS for an application macOS cannot resolve, rather than swallowing the failure", async () => {
    // The one test here that runs a real `/usr/bin/open`. It is given an app
    // name no Mac has, so nothing is launched; what is being checked is that a
    // non-zero exit becomes a rejected promise (an `execFile` callback whose
    // error is dropped would resolve, and the caller would believe VLC opened).
    await expect(
      execFileOpenWithApp("Arcelle No Such Application ", "/tmp")
    ).rejects.toBeInstanceOf(Error);
  });
});
