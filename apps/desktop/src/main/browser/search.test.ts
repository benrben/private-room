/**
 * Port of `src-tauri/src/commands/browse/search.rs`'s `#[cfg(test)] mod tests`
 * (the pure helpers), plus orchestration tests for the five functions against
 * a REAL fixture room and the REAL web cache (`db-host/webCache.ts`) — with
 * only `crate::web`/`ollama`/`import_web_source` supplied through this
 * module's own seam, per search.ts's header.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import type { WebHit } from "../../shared/apiTypes.js";
import { createRoom } from "../db-host/open.js";
import { setSetting } from "../db-host/settings.js";
import { getFreshWebPage, putWebSearch, saveWebPage } from "../db-host/webCache.js";
import type { FileMeta } from "../db-host/files.js";
import {
  browserPeek,
  browserPreview,
  browserSearchSummary,
  cacheKey,
  clip,
  dataUrl,
  formatHitsForAgent,
  importSearchResult,
  runSearch,
  stripThinkSpans,
  type PeekDeps,
  type PreviewDeps,
  type RunSearchDeps,
  type SummaryDeps,
} from "./search.js";

// --------------------------------------------------------------------- pure

describe("clip", () => {
  it("keeps short text whole", () => {
    expect(clip("hello there", 40)).toBe("hello there");
  });

  it("breaks on whitespace, not mid-word", () => {
    expect(clip("alpha beta gamma delta", 14)).toBe("alpha beta");
  });

  it("hard-cuts a single unbroken token, or the budget would not be a budget", () => {
    expect(Array.from(clip("x".repeat(50), 10))).toHaveLength(10);
  });

  /**
   * Rust's `Some(at) if at > max / 2`: a whitespace break only counts when it
   * is past the HALFWAY point. Without that floor, a long word early in the
   * text drags the cut back to the first space and a 1,400-character Peek
   * comes back as two words — a budget spent on almost nothing. This is the
   * branch a hand-written backward scan is most likely to get wrong, and
   * nothing else in this file walks that loop past its first hit.
   */
  it("ignores a break in the first half rather than cutting back to it", () => {
    // The only whitespace inside the budget sits at index 2, below 10/2.
    expect(clip("ab cdefghijklmnopqrstu", 10)).toBe("ab cdefghi");
    // Past the floor — index 6 of a 10-character budget — and it IS taken.
    expect(clip("abcdef ghijklmnopqrstu", 10)).toBe("abcdef");
    // Exactly ON the floor is not past it: `at > max / 2`, not `>=`.
    expect(clip("abcde fghijklmnopqrstu", 10)).toBe("abcde fghi");
    expect(clip("abcd efghijklmnopqrstu", 8)).toBe("abcd efg");
  });

  it("counts code points, so an emoji is one character and never split", () => {
    const clipped = clip("🙂".repeat(50), 10);
    expect(Array.from(clipped)).toHaveLength(10);
    expect(clipped.endsWith("\ud83d")).toBe(false);
  });
});

describe("dataUrl", () => {
  it("carries the mime and base64", () => {
    expect(dataUrl("image/png", Buffer.from("hi"))).toBe("data:image/png;base64,aGk=");
  });
});

describe("cacheKey", () => {
  /** The whole point of the Peek cache is that expanding a result is free. It
   * never was for a plain domain: the engine's spelling and the normalized one
   * the fetch filed it under could not match. */
  it("serves both the lookup and the save with one normalized key", () => {
    expect(cacheKey("https://example.com")).toBe(cacheKey("https://example.com/"));
    expect(cacheKey("https://example.com")).toBe("https://example.com/");
    // Case in the host is normalized too; the path is left alone.
    expect(cacheKey("https://EXAMPLE.com/A")).toBe("https://example.com/A");
    // Something the checker refuses is still a usable key rather than a throw
    // or a silent collapse to the empty string.
    expect(cacheKey("not a url")).toBe("not a url");
    expect(cacheKey("http://localhost/x")).toBe("http://localhost/x");
  });
});

function hit(title: string, url: string, snippet: string | null = null): WebHit {
  return { title, url, engines: ["duckduckgo"], date: null, snippet, score: 1.0 };
}

describe("formatHitsForAgent", () => {
  /** The agent's whole next move is `browse_open <one of these>`, so every
   * line it reads has to carry an address it can pass straight back. */
  it("names an address per line", () => {
    const text = formatHitsForAgent({
      query: "tallest building in europe",
      hits: [
        hit("Lakhta Center", "https://en.wikipedia.org/wiki/Lakhta_Center", "462 m"),
        hit("Tallest in Europe", "https://example.org/list"),
      ],
    });
    expect(text).toContain("1. Lakhta Center — https://en.wikipedia.org/wiki/Lakhta_Center");
    expect(text).toContain("462 m");
    // A hit with no snippet still gets its line; it just has no second one.
    expect(text).toContain("2. Tallest in Europe — https://example.org/list");
    expect(text).toContain("browse_open");
  });

  it("shows the agent a shortlist, not the whole page", () => {
    const hits = Array.from({ length: 12 }, (_, i) =>
      hit(`Result ${i}`, `https://example.com/${i}`),
    );
    const text = formatHitsForAgent({ query: "q", hits });
    expect(text).toContain("https://example.com/5");
    expect(text).not.toContain("https://example.com/6");
  });

  /** These two phrases are load-bearing ACROSS the language boundary: the
   * sidecar's `chat.browse` spec lists them in `Flow.probe_unless` to know that
   * a `browse_open` ran without leaving a page behind it. Reword them and the
   * probe silently starts failing again — so this test is the tripwire. */
  it("carries the phrases the sidecar gates its probe on", () => {
    const found = formatHitsForAgent({ query: "q", hits: [hit("T", "https://e.com")] });
    expect(found.toLowerCase()).toContain("searched the room's own engines");
    const empty = formatHitsForAgent({ query: "q", hits: [] });
    expect(empty.toLowerCase()).toContain("no results across seven engines");
  });

  /** Nothing found is a dead end for the SEARCH, not an invitation to go drive
   * google.com by hand — which is exactly what a model does next unless the
   * result says otherwise. */
  it("tells the agent not to go hunting when nothing was found", () => {
    const empty = formatHitsForAgent({ query: "asdfqwer", hits: [] });
    expect(empty).toContain("asdfqwer");
    expect(empty.toLowerCase()).toContain("do not open a search engine");
  });
});

describe("stripThinkSpans", () => {
  /** The summary sits directly above the real results. A thinking model's
   * private monologue rendered there is worse than no summary at all. */
  it("strips a thinking model's private reasoning", () => {
    const raw = "<think>Let me weigh source 1 against 2.</think>\nRates held steady [1].";
    expect(stripThinkSpans(raw).trim()).toBe("Rates held steady [1].");
  });

  it("removes every span when there are several", () => {
    expect(stripThinkSpans("<think>a</think>keep<think>b</think>this")).toBe("keepthis");
  });

  it("truncates at an unterminated tag rather than letting the monologue through", () => {
    expect(stripThinkSpans("before <think>never closes")).toBe("before ");
  });
});

// ------------------------------------------------------------- orchestration

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRoom(online = true): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "browse-search-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  if (online) setSetting(db, "web_provider", "duckduckgo");
  return db;
}

function searchDeps(db: Database.Database | null, over: Partial<RunSearchDeps> = {}): RunSearchDeps {
  return {
    db,
    searchForBrowser: async () => ({ hits: [], merged: 0, tookMs: 0, failed: [] }),
    hasModelConfigured: () => false,
    journal: () => {},
    ...over,
  };
}

describe("runSearch", () => {
  it("refuses a closed room and an offline room in different words", async () => {
    await expect(runSearch(searchDeps(null), "pizza")).rejects.toThrow("No room is open.");
    const db = freshRoom(false);
    await expect(runSearch(searchDeps(db), "pizza")).rejects.toThrow(/offline/);
    db.close();
  });

  it("refuses an empty query", async () => {
    const db = freshRoom();
    await expect(runSearch(searchDeps(db), "   ")).rejects.toThrow("Type something to search for.");
    db.close();
  });

  it("runs a fresh search, caches it, and journals only the miss", async () => {
    const db = freshRoom();
    const journalled: Array<[string, string, string]> = [];
    let engineCalls = 0;
    const deps = searchDeps(db, {
      searchForBrowser: async () => {
        engineCalls += 1;
        return { hits: [hit("T", "https://a/")], merged: 3, tookMs: 12, failed: ["brave"] };
      },
      hasModelConfigured: () => true,
      journal: (k, u, d) => void journalled.push([k, u, d]),
    });

    const first = await runSearch(deps, "  best pizza  ");
    expect(first.query).toBe("best pizza");
    expect(first.cached).toBe(false);
    expect(first.hits).toHaveLength(1);
    expect(first.merged).toBe(3);
    expect(first.tookMs).toBe(12);
    expect(first.failed).toEqual(["brave"]);
    expect(first.summaryAvailable).toBe(true);
    expect(journalled).toEqual([["search", "", 'Searched for "best pizza"']]);

    // A second search hits the cache, does not call the engine again, and must
    // NOT re-journal — only the miss is news, because only the miss left this
    // Mac. A cache hit also reports NO failed engines: whichever were blocked
    // when it was stored is not news about this search.
    const again = await runSearch(deps, "BEST PIZZA");
    expect(again.cached).toBe(true);
    expect(again.failed).toEqual([]);
    expect(again.tookMs).toBe(0);
    expect(engineCalls).toBe(1);
    expect(journalled).toHaveLength(1);
    db.close();
  });

  it("does not cache an empty result as an answer", async () => {
    const db = freshRoom();
    let engineCalls = 0;
    const deps = searchDeps(db, {
      searchForBrowser: async () => {
        engineCalls += 1;
        return { hits: [], merged: 0, tookMs: 0, failed: ["brave"] };
      },
    });
    await runSearch(deps, "nothing here");
    await runSearch(deps, "nothing here");
    // Both calls actually reached the engine — an OFFLINE Mac's empty answer
    // must not be replayed for the next fifteen minutes.
    expect(engineCalls).toBe(2);
    db.close();
  });

  /**
   * The seven engines have already answered; the caller is owed those hits.
   * Rust writes the cache row with `let _ = db::put_web_search(...)`, so a row
   * that will not write costs the NEXT search its free cache hit and nothing
   * more. Unwrapped, a locked or older room threw a COMPLETED search away at
   * the very last step — the user watched a real fan-out finish and then saw
   * an SQLite error instead of the results.
   */
  it("still answers when the cache row cannot be written", async () => {
    const db = freshRoom();
    // The one realistic shape of this: the cache table is gone (an older room,
    // or a room mid-migration), so the upsert throws where the search did not.
    db.prepare("DROP TABLE web_searches").run();
    const journalled: Array<[string, string, string]> = [];
    const deps = searchDeps(db, {
      searchForBrowser: async () => ({
        hits: [hit("T", "https://a/")],
        merged: 1,
        tookMs: 9,
        failed: [],
      }),
      journal: (k, u, d) => void journalled.push([k, u, d]),
    });
    const page = await runSearch(deps, "best pizza");
    expect(page.hits).toHaveLength(1);
    expect(page.cached).toBe(false);
    // …and the search is still journalled: it really did leave this Mac.
    expect(journalled).toEqual([["search", "", 'Searched for "best pizza"']]);
    db.close();
  });

  it("reports the room's preview setting and whether a summary is even possible", async () => {
    const db = freshRoom();
    const deps = searchDeps(db, {
      searchForBrowser: async () => ({
        hits: [hit("T", "https://a/")],
        merged: 1,
        tookMs: 1,
        failed: [],
      }),
    });
    expect((await runSearch(deps, "q")).previewsEnabled).toBe(true);
    setSetting(db, "web_result_previews", "off");
    expect((await runSearch(deps, "q2")).previewsEnabled).toBe(false);
    expect((await runSearch(deps, "q3")).summaryAvailable).toBe(false);
    db.close();
  });
});

describe("browserPreview", () => {
  it("contacts no origin at all when the room turned previews off", async () => {
    const db = freshRoom();
    setSetting(db, "web_result_previews", "off");
    let fetched = 0;
    const deps: PreviewDeps = {
      db,
      fetchPreview: async () => {
        fetched += 1;
        return null;
      },
      fetchImage: async () => null,
    };
    expect(await browserPreview(deps, ["https://a/"])).toEqual([]);
    expect(fetched).toBe(0);
    db.close();
  });

  it("reads a page, caches its text for a later Peek, and encodes its images", async () => {
    const db = freshRoom();
    const deps: PreviewDeps = {
      db,
      fetchPreview: async () => ({
        title: "Good",
        description: "d",
        text: "some readable text",
        imageUrl: "https://a/i.png",
        iconUrl: "https://a/f.ico",
      }),
      fetchImage: async (u) => ({
        mime: u.endsWith(".ico") ? "image/x-icon" : "image/png",
        bytes: Buffer.from("xx"),
      }),
    };
    const [preview] = await browserPreview(deps, ["https://good/"]);
    expect(preview).toEqual({
      url: "https://good/",
      title: "Good",
      description: "d",
      image: dataUrl("image/png", Buffer.from("xx")),
      icon: dataUrl("image/x-icon", Buffer.from("xx")),
      done: true,
    });
    expect(getFreshWebPage(db, cacheKey("https://good/"))?.text).toBe("some readable text");
    db.close();
  });

  it("degrades a failed page to an empty preview rather than failing the batch", async () => {
    const db = freshRoom();
    const deps: PreviewDeps = {
      db,
      fetchPreview: async (url) => {
        if (url === "https://bad/") throw new Error("blocked");
        if (url === "https://nul/") return null;
        return { title: "Good", description: "d", text: "text" };
      },
      fetchImage: async () => null,
    };
    const out = await browserPreview(deps, ["https://bad/", "https://nul/", "https://good/"]);
    expect(out).toHaveLength(3);
    // A failure is an EMPTY preview, not a missing key: the card can tell "we
    // read it and it has no image" from "we never heard back".
    expect(out[0]).toEqual({
      url: "https://bad/",
      image: null,
      icon: null,
      description: null,
      title: null,
      done: true,
    });
    expect(out[1]?.title).toBeNull();
    expect(out[2]?.title).toBe("Good");
    db.close();
  });

  it("reads at most MAX_PREVIEWS pages however many results it is handed", async () => {
    const db = freshRoom();
    let previewCalls = 0;
    let imageCalls = 0;
    const deps: PreviewDeps = {
      db,
      fetchPreview: async (url) => {
        previewCalls += 1;
        return { text: "", imageUrl: `${url}/img.png` };
      },
      fetchImage: async () => {
        imageCalls += 1;
        return { mime: "image/png", bytes: Buffer.from("x") };
      },
    };
    const urls = Array.from({ length: 20 }, (_, i) => `https://a/${i}`);
    expect(await browserPreview(deps, urls)).toHaveLength(8);
    expect(previewCalls).toBe(8);
    expect(imageCalls).toBe(8);
    db.close();
  });

  it("reuses a cached image instead of fetching it twice", async () => {
    const db = freshRoom();
    let imageCalls = 0;
    const deps: PreviewDeps = {
      db,
      fetchPreview: async () => ({ text: "", imageUrl: "https://a/shared.png" }),
      fetchImage: async () => {
        imageCalls += 1;
        return { mime: "image/png", bytes: Buffer.from("x") };
      },
    };
    await browserPreview(deps, ["https://a/1"]);
    await browserPreview(deps, ["https://a/2"]);
    expect(imageCalls).toBe(1);
    db.close();
  });

  it("degrades both rejected and absent image responses to empty preview fields", async () => {
    const db = freshRoom();
    const imageCalls: string[] = [];
    const deps: PreviewDeps = {
      db,
      fetchPreview: async () => ({
        text: "",
        imageUrl: "https://a/rejected.png",
        iconUrl: "https://a/missing.ico",
      }),
      fetchImage: async (url) => {
        imageCalls.push(url);
        if (url.endsWith("rejected.png")) throw new Error("image fetch blocked");
        return null;
      },
    };

    const [preview] = await browserPreview(deps, ["https://a/page"]);
    expect(preview).toMatchObject({ image: null, icon: null, done: true });
    expect(imageCalls).toEqual(["https://a/rejected.png", "https://a/missing.ico"]);
    db.close();
  });
});

describe("importSearchResult", () => {
  function fileMeta(name: string): FileMeta {
    return {
      id: "f1",
      name,
      mimeType: "text/markdown",
      sizeBytes: 10,
      source: "web",
      hasText: true,
      createdAt: "now",
      folderId: null,
      partiallyIndexed: false,
      aiSummary: null,
      originDestination: "library",
      libraryVisibility: "linked",
      originUrl: "https://example.com/",
    };
  }

  it("guards the address, imports it, and journals the save under the checked url", async () => {
    const db = freshRoom();
    const journalled: Array<[string, string, string]> = [];
    const meta = await importSearchResult(
      {
        db,
        importWebSource: async (_url, title) => fileMeta(title),
        journal: (k, u, d) => void journalled.push([k, u, d]),
      },
      "https://example.com",
      "A page",
    );
    expect(meta.name).toBe("A page");
    // The NORMALIZED address is what is journalled and what the importer saw.
    expect(journalled).toEqual([["save", "https://example.com/", 'Saved "A page" into the room']]);
    db.close();
  });

  it("refuses a private address before importing anything", async () => {
    const db = freshRoom();
    let called = false;
    const deps = {
      db,
      importWebSource: async () => {
        called = true;
        throw new Error("should not be reached");
      },
      journal: () => {},
    };
    await expect(importSearchResult(deps, "http://localhost/", "x")).rejects.toThrow(
      "Local and private-network addresses cannot be fetched.",
    );
    expect(called).toBe(false);
    db.close();
  });
});

describe("browserPeek", () => {
  it("serves a cached page for free, without fetching", async () => {
    const db = freshRoom();
    saveWebPage(db, cacheKey("https://a/"), "A", "cached readable text");
    let fetchCalls = 0;
    const deps: PeekDeps = {
      db,
      fetchPage: async () => {
        fetchCalls += 1;
        return { title: "A", text: "fresh text" };
      },
    };
    expect(await browserPeek(deps, "https://a/")).toBe("cached readable text");
    expect(fetchCalls).toBe(0);
    db.close();
  });

  it("fetches through the guard on a miss and caches the result under the same key", async () => {
    const db = freshRoom();
    const deps: PeekDeps = { db, fetchPage: async () => ({ title: "Fresh", text: "freshly fetched text" }) };
    // Typed the way an engine writes it (no trailing slash); cached under the
    // key a later lookup will use.
    expect(await browserPeek(deps, "https://example.com")).toBe("freshly fetched text");
    expect(getFreshWebPage(db, "https://example.com/")?.text).toBe("freshly fetched text");
    db.close();
  });

  it("refuses a page with no readable text rather than showing an empty Peek", async () => {
    const db = freshRoom();
    const deps: PeekDeps = { db, fetchPage: async () => ({ title: "T", text: "   " }) };
    await expect(browserPeek(deps, "https://example.com/empty")).rejects.toThrow(
      "That page has no readable text to preview.",
    );
    db.close();
  });

  it("refuses a private address before fetching", async () => {
    const db = freshRoom();
    let called = false;
    const deps: PeekDeps = {
      db,
      fetchPage: async () => {
        called = true;
        return { title: "", text: "" };
      },
    };
    await expect(browserPeek(deps, "http://192.168.1.1/")).rejects.toThrow();
    expect(called).toBe(false);
    db.close();
  });
});

describe("browserSearchSummary", () => {
  function summaryDeps(db: Database.Database, over: Partial<SummaryDeps> = {}): SummaryDeps {
    return {
      db,
      modelSetting: () => "qwen3.5:4b",
      fetchPage: async () => ({ title: "T", text: "source text long enough to summarize" }),
      generate: async () => "A grounded summary [1].",
      ...over,
    };
  }

  it("refuses when the search has expired from the cache", async () => {
    const db = freshRoom();
    await expect(browserSearchSummary(summaryDeps(db), "never searched")).rejects.toThrow(
      /expired/,
    );
    db.close();
  });

  it("refuses when no model is configured", async () => {
    const db = freshRoom();
    putWebSearch(db, "q", [hit("T", "https://a/")]);
    await expect(
      browserSearchSummary(summaryDeps(db, { modelSetting: () => null }), "q"),
    ).rejects.toThrow("No AI engine is set for this room.");
    db.close();
  });

  it("builds numbered sources from at most SUMMARY_SOURCES results and strips the monologue", async () => {
    const db = freshRoom();
    putWebSearch(db, "q", [
      hit("One", "https://a/"),
      hit("Two", "https://b/"),
      hit("Three", "https://c/"),
      hit("Four", "https://d/"),
    ]);
    const prompts: string[] = [];
    const out = await browserSearchSummary(
      summaryDeps(db, {
        fetchPage: async (url) => ({ title: url, text: `the text of ${url}` }),
        generate: async (_model, _system, user) => {
          prompts.push(user);
          return "<think>reasoning here</think>Grounded answer [1].";
        },
      }),
      "q",
    );
    expect(out).toBe("Grounded answer [1].");
    const user = prompts[0] ?? "";
    expect(user).toContain("Question: q");
    expect(user).toContain("[1] One");
    expect(user).toContain("[3] Three");
    // The fourth result is past the budget and must not be in the context.
    expect(user).not.toContain("[4] Four");
    db.close();
  });

  it("skips a source that will not load rather than failing the whole summary", async () => {
    const db = freshRoom();
    putWebSearch(db, "q", [hit("Bad", "https://bad/"), hit("Good", "https://good/")]);
    const out = await browserSearchSummary(
      summaryDeps(db, {
        fetchPage: async (url) => {
          if (url === "https://bad/") throw new Error("network error");
          return { title: "Good", text: "readable source text" };
        },
      }),
      "q",
    );
    expect(out).toBe("A grounded summary [1].");
    db.close();
  });

  it("refuses when every source fails to load", async () => {
    const db = freshRoom();
    putWebSearch(db, "q", [hit("Bad", "https://bad/")]);
    await expect(
      browserSearchSummary(
        summaryDeps(db, {
          fetchPage: async () => {
            throw new Error("down");
          },
        }),
        "q",
      ),
    ).rejects.toThrow("None of these results could be read, so there is nothing to summarize.");
    db.close();
  });

  it("refuses when the engine answers with nothing but its own reasoning", async () => {
    const db = freshRoom();
    putWebSearch(db, "q", [hit("T", "https://a/")]);
    await expect(
      browserSearchSummary(summaryDeps(db, { generate: async () => "<think>hmm</think>  " }), "q"),
    ).rejects.toThrow("The engine returned nothing for this summary.");
    db.close();
  });

  it("reads a cached source without fetching it again", async () => {
    const db = freshRoom();
    putWebSearch(db, "q", [hit("T", "https://a/")]);
    saveWebPage(db, cacheKey("https://a/"), "T", "already cached text");
    let fetchCalls = 0;
    await browserSearchSummary(
      summaryDeps(db, {
        fetchPage: async () => {
          fetchCalls += 1;
          return { title: "T", text: "fetched" };
        },
      }),
      "q",
    );
    expect(fetchCalls).toBe(0);
    db.close();
  });
});
