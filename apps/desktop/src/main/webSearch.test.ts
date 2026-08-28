/**
 * Coverage for `webSearch.ts` — the port of `src-tauri/src/web/search.rs`,
 * whose own `#[cfg(test)] mod tests` is the baseline for everything below.
 *
 * The sidecar POST is supplied through `searchPage`'s optional `post`
 * parameter (real by default), so these drive the module's own logic without
 * mocking a module — `sidecarJsonCancellable.test.ts` covers the layer beneath.
 */

import { describe, expect, it } from "vitest";
import type { WebHit } from "../shared/apiTypes.js";
import type { CancelFlag } from "./cancel.js";
import type { SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import {
  BROWSER_SEARCH_LIMIT,
  hitSource,
  joinNames,
  provenance,
  renderHits,
  searchForBrowser,
  searchPage,
  searchWeb,
  SIDECAR_FANOUT_BUDGET_MS,
  WEB_SEARCH_TIMEOUT_MS,
  type SidecarPostFn,
} from "./webSearch.js";

function hit(overrides: Partial<WebHit> = {}): WebHit {
  return { title: "T", url: "https://example.com/a", engines: ["brave"], score: 0.5, ...overrides };
}

/** A `post` double that answers with one fixed payload and records the body. */
function posting(value: unknown): { post: SidecarPostFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const post: SidecarPostFn = async (_path, body) => {
    calls.push(body);
    return { kind: "value", value } satisfies SidecarPostOutcome;
  };
  return { post, calls };
}

// ------------------------------------------------------------------ timeouts

describe("host timeout tracks the sidecar fan-out budget", () => {
  it("outwaits the fan-out it is waiting for, but not by an unbounded multiple", () => {
    // The host's wait used to describe a design that no longer exists (seven
    // engines in sequence) and was 11x the deadline the sidecar actually
    // enforces, so a wedged sidecar showed "Searching…" for four minutes.
    expect(WEB_SEARCH_TIMEOUT_MS).toBeGreaterThan(SIDECAR_FANOUT_BUDGET_MS);
    expect(WEB_SEARCH_TIMEOUT_MS).toBeLessThanOrEqual(SIDECAR_FANOUT_BUDGET_MS * 3);
  });
});

// ---------------------------------------------------------------- provenance

describe("provenance", () => {
  it("names the engine and its relevance", () => {
    expect(provenance(hit({ engines: ["mojeek"], score: 0.874 }))).toBe("via mojeek · relevance 0.87");
  });

  it("includes a date when the engine knows one", () => {
    expect(provenance(hit({ engines: ["news"], date: "2026-07-06", score: 0.9 }))).toBe(
      "via news · 2026-07-06 · relevance 0.90"
    );
  });

  it("skips an empty date rather than printing a bare separator", () => {
    expect(provenance(hit({ engines: ["brave"], date: "" }))).toBe("via brave · relevance 0.50");
  });

  it("counts the agreeing engines — cross-engine agreement is the fusion's own best signal", () => {
    expect(provenance(hit({ engines: ["duckduckgo", "brave", "mojeek"], score: 0.8 }))).toBe(
      "via duckduckgo +2 more · relevance 0.80"
    );
  });
});

describe("hitSource", () => {
  it("a hit with no engines still names a source", () => {
    expect(hitSource(hit({ engines: [] }))).toBe("web");
  });
});

// ------------------------------------------------------------------ renderHits

describe("renderHits", () => {
  it("puts the snippet between the URL and the provenance line", () => {
    expect(renderHits([hit({ snippet: "A short description." })])).toBe(
      "1. T\n   https://example.com/a\n   A short description.\n   via brave · relevance 0.50"
    );
  });

  it("omits the snippet line entirely when there is none", () => {
    expect(renderHits([hit()])).toBe("1. T\n   https://example.com/a\n   via brave · relevance 0.50");
  });

  it("numbers multiple hits in order", () => {
    expect(renderHits([hit({ title: "First" }), hit({ title: "Second", url: "https://b.com" })])).toBe(
      "1. First\n   https://example.com/a\n   via brave · relevance 0.50\n" +
        "2. Second\n   https://b.com\n   via brave · relevance 0.50"
    );
  });
});

// -------------------------------------------------------------------- joinNames

describe("joinNames", () => {
  it("reads engine names as a sentence, not a debug list", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["brave"])).toBe("brave");
    expect(joinNames(["brave", "mojeek"])).toBe("brave and mojeek");
    expect(joinNames(["brave", "mojeek", "ddg"])).toBe("brave, mojeek and ddg");
  });
});

// --------------------------------------------------------------------- searchPage

describe("searchPage / searchWeb / searchForBrowser", () => {
  it("asks the sidecar's /web_search with the given query and limit, on the host's own timeout", async () => {
    const calls: Array<{ path: string; body: unknown; timeoutMs: number | undefined }> = [];
    const post: SidecarPostFn = async (path, body, _cancel: CancelFlag, timeoutMs) => {
      calls.push({ path, body, timeoutMs });
      return { kind: "value", value: { hits: [] } };
    };
    await searchPage("central bank", 7, post);
    expect(calls).toEqual([
      { path: "/web_search", body: { query: "central bank", limit: 7 }, timeoutMs: WEB_SEARCH_TIMEOUT_MS },
    ]);
  });

  it("searchWeb/searchForBrowser ask for their own distinct limits", async () => {
    const { post, calls } = posting({ hits: [] });
    await searchWeb("x", post);
    await searchForBrowser("x", post);
    expect(calls).toEqual([
      { query: "x", limit: 10 },
      { query: "x", limit: BROWSER_SEARCH_LIMIT },
    ]);
    expect(BROWSER_SEARCH_LIMIT).toBe(12);
  });

  it("reads the fused shape: title/url/engines/date/snippet/score, trimmed", async () => {
    const { post } = posting({
      hits: [
        {
          title: " Bank ",
          url: "https://boi.org.il/",
          engines: ["wikipedia", "brave"],
          date: "2026-07-06",
          snippet: " the central bank ",
          score: 0.91,
        },
      ],
      merged: 4,
      tookMs: 120,
    });
    const page = await searchWeb("bank", post);
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]!.title).toBe("Bank");
    expect(page.hits[0]!.engines).toEqual(["wikipedia", "brave"]);
    expect(page.hits[0]!.snippet).toBe("the central bank");
    expect(page.merged).toBe(4);
    expect(page.tookMs).toBe(120);
    expect(page.cached).toBe(false);
    expect(page.failed).toEqual([]);
  });

  it("falls back to the legacy single `source` key when `engines` is missing (an older sidecar)", async () => {
    const { post } = posting({ hits: [{ title: "T", url: "https://a.com/", source: "mojeek", score: 0.4 }] });
    expect((await searchWeb("x", post)).hits[0]!.engines).toEqual(["mojeek"]);
  });

  it("drops hits with no URL rather than surfacing a dead link", async () => {
    const { post } = posting({
      hits: [
        { title: "T", url: "", source: "brave" },
        { title: "U", url: "https://a.com/", source: "brave" },
      ],
    });
    const page = await searchWeb("x", post);
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]!.url).toBe("https://a.com/");
  });

  it("blanks a whitespace-only snippet rather than keeping it", async () => {
    const { post } = posting({ hits: [{ title: "T", url: "https://a.com/", source: "brave", snippet: "   " }] });
    expect((await searchWeb("x", post)).hits[0]!.snippet).toBeNull();
  });

  it("an untitled hit reads as '(untitled)', never a blank line", async () => {
    const { post } = posting({ hits: [{ title: "   ", url: "https://a.com/", source: "brave" }] });
    expect((await searchWeb("x", post)).hits[0]!.title).toBe("(untitled)");
  });

  it("survives a malformed payload rather than throwing (a null hit, a non-array hits)", async () => {
    const { post } = posting({ hits: [null, 7, { title: "T", url: "https://a.com/" }] });
    expect((await searchWeb("x", post)).hits).toHaveLength(1);
    const { post: notAnObject } = posting("nonsense");
    expect((await searchWeb("x", notAnObject)).hits).toEqual([]);
  });

  it("carries the engines that could not answer — the difference between an empty web and a blocked search", async () => {
    const { post } = posting({ hits: [], merged: 0, tookMs: 12, failed: ["mojeek", "brave"] });
    const page = await searchWeb("x", post);
    expect(page.hits).toEqual([]);
    expect(page.failed).toEqual(["mojeek", "brave"]);
  });

  it("maps OLLAMA_DOWN to a plain-language local-engine message, not the bare sentinel", async () => {
    const post: SidecarPostFn = async () => ({
      kind: "error",
      error: { code: "OLLAMA_DOWN", error: "connection refused", status: 503 },
    });
    await expect(searchWeb("x", post)).rejects.toThrow(
      "The local AI engine isn't running, so web search is unavailable."
    );
  });

  it("any other engine error is reported as a plain 'Web search failed: …' sentence", async () => {
    const post: SidecarPostFn = async () => ({
      kind: "error",
      error: { code: "ENGINE_ERROR", error: "timed out", status: 504 },
    });
    await expect(searchWeb("x", post)).rejects.toThrow("Web search failed: timed out");
  });

  it("handles the 'stopped' arm exhaustively rather than treating it as a value", async () => {
    const post: SidecarPostFn = async () => ({ kind: "stopped" });
    await expect(searchWeb("x", post)).rejects.toThrow("Web search was stopped.");
  });
});
