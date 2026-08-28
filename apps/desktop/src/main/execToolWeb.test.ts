/**
 * Coverage for `execTool.ts`'s `web_search`/`fetch_page` arms — the ports of
 * `agent.rs`'s own `"web_search"` (~3591-3683) and `"fetch_page"` (~3684-3731)
 * match arms — plus `withRealPrivacyGates`, the wiring helper that fills their
 * PRIV-4 seams with `privacy.ts`'s real port.
 *
 * `execTool.test.ts` itself needs no edit: under its all-default `deps()` (no
 * `maskOutboundWeb`, no `outboundUrlRefusal`) both tools still resolve to a
 * labeled `NOT_IMPLEMENTED`, exactly as they did as stubs.
 *
 * `web.ts`'s own engines are exercised for real against real HTTP servers in
 * `webFetch.test.ts`/`webSearch.test.ts`; this file mocks them out (as
 * `execToolDownload.test.ts` fakes the yt-dlp subprocess) so these tests are
 * about the ARM's gating, caching, ordering and rendering — not the network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import { getFreshWebSearch, putWebSearch } from "./db-host/webCache.js";
import { clearPolicy, setPolicyRulesForTests } from "./privacy.js";
import type { WebHit } from "../shared/apiTypes.js";

const { mockSearchWeb, mockFetchPage } = vi.hoisted(() => ({
  mockSearchWeb: vi.fn(),
  mockFetchPage: vi.fn(),
}));

vi.mock("./web.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web.js")>();
  return { ...actual, searchWeb: mockSearchWeb, fetchPage: mockFetchPage };
});

import {
  createToolEffects,
  execTool,
  withRealPrivacyGates,
  type ExecToolDeps,
  type ToolEffects,
} from "./execTool.js";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  clearPolicy();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "exec-tool-web-"));
  tmpDirs.push(dir);
  const roomPath = path.join(dir, `t-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function turnWebAccessOn(db: Database.Database): void {
  setSetting(db, "web_provider", "duckduckgo");
}

function deps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
  return { db: null, routes: [], ...overrides };
}

function effects(overrides: Partial<ToolEffects> = {}): ToolEffects {
  return { ...createToolEffects(), ...overrides };
}

function hit(overrides: Partial<WebHit> = {}): WebHit {
  return { title: "Bank of Israel", url: "https://boi.org.il/", engines: ["brave"], score: 0.9, ...overrides };
}

// --------------------------------------------------------------- web_search

describe("web_search", () => {
  it("refuses (NOT_IMPLEMENTED) before touching any room when nothing installed the privacy mask", async () => {
    const outcome = await execTool("web_search", { query: "x" }, effects(), deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/^NOT_IMPLEMENTED: /);
      expect(outcome.error).toContain("withRealPrivacyGates");
    }
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it("a privacy mask runs before the room check — 'No room is open' is never reached ahead of it", async () => {
    let seenQuery: string | null = null;
    const outcome = await execTool(
      "web_search",
      { query: "Ben Reich weather" },
      effects(),
      deps({
        maskOutboundWeb: (q) => {
          seenQuery = q;
          return { query: "[Person A] weather", note: " [masked]" };
        },
      })
    );
    expect(seenQuery).toBe("Ben Reich weather");
    expect(outcome).toEqual({ ok: false, error: "No room is open." });
  });

  it("answers 'web access is off' as a normal result once a room is open but offline", async () => {
    const db = freshRoom();
    const outcome = await execTool("web_search", { query: "x" }, effects(), deps({ db, maskOutboundWeb: () => null }));
    expect(outcome).toEqual({ ok: true, text: "Web access is turned off in Settings → Online features." });
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it("searches for the MASKED query, never the one the model asked for", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockResolvedValueOnce({ hits: [hit()], merged: 1, tookMs: 5, cached: false, failed: [] });
    await execTool(
      "web_search",
      { query: "Ben Reich weather" },
      effects(),
      deps({ db, maskOutboundWeb: () => ({ query: "[Person A] weather", note: " [masked]" }) })
    );
    expect(mockSearchWeb).toHaveBeenCalledWith("[Person A] weather");
  });

  it("serves a fresh cached search with no network touched, appending the mask note", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    putWebSearch(db, "weather", [hit()]);
    const outcome = await execTool(
      "web_search",
      { query: "weather" },
      effects(),
      deps({ db, maskOutboundWeb: () => ({ query: "weather", note: " NOTE" }) })
    );
    expect(mockSearchWeb).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Bank of Israel");
      expect(outcome.text.endsWith(" NOTE")).toBe(true);
    }
  });

  it("once throttled this turn, refuses to search again and says so", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const outcome = await execTool(
      "web_search",
      { query: "x" },
      effects({ webSearchThrottled: true }),
      deps({ db, maskOutboundWeb: () => null })
    );
    expect(mockSearchWeb).not.toHaveBeenCalled();
    expect(outcome.ok && outcome.text).toContain("do not search again this turn");
  });

  it("a live search failure sets webSearchThrottled and surfaces the error", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockRejectedValueOnce(new Error("Web search failed: boom"));
    const eff = effects();
    const outcome = await execTool("web_search", { query: "x" }, eff, deps({ db, maskOutboundWeb: () => null }));
    expect(outcome).toEqual({ ok: false, error: "Web search failed: boom" });
    expect(eff.webSearchThrottled).toBe(true);
  });

  it("no hits and nothing failed reads as 'No results found', never cached", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockResolvedValueOnce({ hits: [], merged: 0, tookMs: 5, cached: false, failed: [] });
    const outcome = await execTool(
      "web_search",
      { query: "x" },
      effects(),
      deps({ db, maskOutboundWeb: () => ({ query: "x", note: "!" }) })
    );
    expect(outcome).toEqual({ ok: true, text: "No results found.!" });
    expect(getFreshWebSearch(db, "x")).toBeNull();
  });

  it("no hits but every engine failed says the search did not run — and never caches that as an empty web", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockResolvedValueOnce({
      hits: [],
      merged: 0,
      tookMs: 5,
      cached: false,
      failed: ["mojeek", "brave"],
    });
    const outcome = await execTool(
      "web_search",
      { query: "x" },
      effects(),
      // Mirrors the Rust arm exactly: this branch appends no mask note.
      deps({ db, maskOutboundWeb: () => ({ query: "x", note: "!SHOULD NOT APPEAR!" }) })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("The search did not run: mojeek and brave could not be reached");
      expect(outcome.text).toContain("NOT evidence that nothing exists");
      expect(outcome.text).not.toContain("!SHOULD NOT APPEAR!");
    }
    expect(getFreshWebSearch(db, "x")).toBeNull();
  });

  it("a successful search is rendered, cached for next time, and gets a blocked-engine note when partial", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockResolvedValueOnce({
      hits: [hit({ title: "Result A" })],
      merged: 3,
      tookMs: 12,
      cached: false,
      failed: ["marginalia"],
    });
    const outcome = await execTool(
      "web_search",
      { query: "central bank" },
      effects(),
      deps({ db, maskOutboundWeb: () => null })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Result A");
      expect(outcome.text).toContain("only part of the web");
    }
    expect(getFreshWebSearch(db, "central bank")).not.toBeNull();
  });
});

// --------------------------------------------------------------- fetch_page

describe("fetch_page", () => {
  it("refuses (NOT_IMPLEMENTED) before touching any room when nothing installed the URL check", async () => {
    const outcome = await execTool("fetch_page", { url: "https://example.com" }, effects(), deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/^NOT_IMPLEMENTED: /);
      expect(outcome.error).toContain("withRealPrivacyGates");
    }
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it("outbound_url_refusal runs before the room check — 'No room is open' is never reached ahead of it", async () => {
    let seenUrl: string | null = null;
    const outcome = await execTool(
      "fetch_page",
      { url: "https://x.test/?q=Ben" },
      effects(),
      deps({
        outboundUrlRefusal: (url) => {
          seenUrl = url;
          return null;
        },
      })
    );
    expect(seenUrl).toBe("https://x.test/?q=Ben");
    expect(outcome).toEqual({ ok: false, error: "No room is open." });
  });

  it("a URL-carries-a-protected-name refusal is a normal ok() result, never a tool failure", async () => {
    const outcome = await execTool(
      "fetch_page",
      { url: "https://x.test/?q=Ben+Reich" },
      effects(),
      deps({ outboundUrlRefusal: () => "Not fetched: this URL carries 1 protected name(s)..." })
    );
    expect(outcome).toEqual({ ok: true, text: "Not fetched: this URL carries 1 protected name(s)..." });
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it("answers 'web access is off' as a normal result once a room is open but offline", async () => {
    const db = freshRoom();
    const outcome = await execTool(
      "fetch_page",
      { url: "https://example.com" },
      effects(),
      deps({ db, outboundUrlRefusal: () => null })
    );
    expect(outcome).toEqual({ ok: true, text: "Web access is turned off in Settings → Online features." });
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it("serves a fresh cached page with no network touched, and no redirect note (a cache hit has none)", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockFetchPage.mockResolvedValueOnce({
      title: "Example",
      text: "hello world",
      finalUrl: "https://example.com/",
      status: 200,
    });
    const d = deps({ db, outboundUrlRefusal: () => null });
    await execTool("fetch_page", { url: "https://example.com/" }, effects(), d);
    mockFetchPage.mockClear();
    const outcome = await execTool("fetch_page", { url: "https://example.com/" }, effects(), d);
    expect(mockFetchPage).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).not.toContain("(Redirected to");
      expect(outcome.text).toContain("hello world");
      expect(outcome.text).toContain("[Example] https://example.com/");
    }
  });

  it("a fresh fetch that redirected notes the real URL; one that didn't gets no pointless note", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const d = deps({ db, outboundUrlRefusal: () => null });
    mockFetchPage.mockResolvedValueOnce({
      title: "Real Site",
      text: "the real article",
      finalUrl: "https://real-site.com/full-article",
      status: 200,
    });
    const redirected = await execTool("fetch_page", { url: "https://short.link/x" }, effects(), d);
    expect(redirected.ok && redirected.text.startsWith("(Redirected to https://real-site.com/full-article)\n")).toBe(
      true
    );

    mockFetchPage.mockResolvedValueOnce({
      title: "Plain",
      text: "plain text",
      finalUrl: "https://plain.example/",
      status: 200,
    });
    const plain = await execTool("fetch_page", { url: "https://plain.example/" }, effects(), d);
    expect(plain.ok && plain.text).not.toContain("(Redirected to");
  });

  it("a fetch error is a real tool failure, never fabricated text", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    mockFetchPage.mockRejectedValueOnce(new Error("Local and private-network addresses cannot be fetched."));
    const outcome = await execTool(
      "fetch_page",
      { url: "http://127.0.0.1/x" },
      effects(),
      deps({ db, outboundUrlRefusal: () => null })
    );
    expect(outcome).toEqual({ ok: false, error: "Local and private-network addresses cannot be fetched." });
  });

  it("windows a long page from `start`, telling the model how to get the rest", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const d = deps({ db, outboundUrlRefusal: () => null });
    mockFetchPage.mockResolvedValueOnce({
      title: "Long",
      text: "y".repeat(45_000),
      finalUrl: "https://long.example/",
      status: 200,
    });
    const first = await execTool("fetch_page", { url: "https://long.example/" }, effects(), d);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.text).toContain("40000 of 45000 characters shown");
      expect(first.text).toContain("start 40000 for the rest");
    }

    // The cached page now serves the second window too.
    const second = await execTool("fetch_page", { url: "https://long.example/", start: 40_000 }, effects(), d);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.text).not.toContain("characters shown");
      expect(second.text).toContain("y".repeat(5_000));
    }
  });

  it("a non-numeric or negative `start` is read as 0 rather than throwing", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const d = deps({ db, outboundUrlRefusal: () => null });
    mockFetchPage.mockResolvedValue({ title: "T", text: "abcdef", finalUrl: "https://s.example/", status: 200 });
    for (const start of ["nonsense", -5, Number.NaN, undefined]) {
      const outcome = await execTool("fetch_page", { url: "https://s.example/", start }, effects(), d);
      expect(outcome.ok && outcome.text.endsWith("abcdef"), String(start)).toBe(true);
    }
  });
});

// ------------------------------------------------- withRealPrivacyGates (PRIV-4)

describe("withRealPrivacyGates", () => {
  it("installs privacy.ts's REAL mask, so a protected name never reaches the search engines", async () => {
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockResolvedValueOnce({ hits: [hit()], merged: 1, tookMs: 3, cached: false, failed: [] });
    const outcome = await execTool(
      "web_search",
      { query: "Ben Reich weather" },
      effects(),
      withRealPrivacyGates(deps({ db }))
    );
    expect(mockSearchWeb).toHaveBeenCalledWith("[Person A] weather");
    expect(outcome.ok && outcome.text).toContain("protected name(s) in this request were replaced");
  });

  it("installs privacy.ts's REAL URL check, refusing a fetch that would carry a protected name out", async () => {
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    const db = freshRoom();
    turnWebAccessOn(db);
    // Percent/plus encoded — the shape a raw-string redactor would miss, which
    // is why the URL seam is `outboundUrlHides` rather than the masker.
    const outcome = await execTool(
      "fetch_page",
      { url: "https://anywhere.test/?q=Ben+Reich" },
      effects(),
      withRealPrivacyGates(deps({ db }))
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Not fetched: this URL carries 1 protected name(s)");
      expect(outcome.text).toContain("Settings → Cloud privacy");
    }
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it("with the Cloud-privacy switch OFF, both tools run unmasked — the door is the user's switch, not a skipped check", async () => {
    setPolicyRulesForTests(false, [["Ben Reich", "[Person A]"]]);
    const db = freshRoom();
    turnWebAccessOn(db);
    mockSearchWeb.mockResolvedValueOnce({ hits: [hit()], merged: 1, tookMs: 3, cached: false, failed: [] });
    const outcome = await execTool(
      "web_search",
      { query: "Ben Reich weather" },
      effects(),
      withRealPrivacyGates(deps({ db }))
    );
    expect(mockSearchWeb).toHaveBeenCalledWith("Ben Reich weather");
    expect(outcome.ok && outcome.text).not.toContain("protected name(s)");
  });

  it("never overwrites a seam a caller already supplied", async () => {
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    const mine = vi.fn(() => null);
    const filled = withRealPrivacyGates(deps({ maskOutboundWeb: mine }));
    expect(filled.maskOutboundWeb).toBe(mine);
    // …and the OTHER seam still gets the real one.
    expect(filled.outboundUrlRefusal?.("https://x.test/?q=Ben%20Reich")).toContain("Not fetched:");
  });

  it("also fills download_media's shared seam, so one helper wires every PRIV-4 arm", async () => {
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    const db = freshRoom();
    turnWebAccessOn(db);
    const outcome = await execTool(
      "download_media",
      { url: "https://video.test/watch?u=Ben%20Reich" },
      effects(),
      withRealPrivacyGates(deps({ db }))
    );
    expect(outcome.ok && outcome.text).toContain("Not fetched: this URL carries");
  });
});
