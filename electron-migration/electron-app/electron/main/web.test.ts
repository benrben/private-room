/**
 * Coverage for `web.ts` — the barrel port of `src-tauri/src/web.rs`:
 * `SearchPage`, `blocked_note`, `PRIVATE_BLOCKED`, and the re-export surface
 * `pub use fetch::*; pub use search::*;` creates.
 */

import { describe, expect, it } from "vitest";
import * as web from "./web.js";
import { blockedNote, PRIVATE_BLOCKED, type SearchPage, type WebHit } from "./web.js";

function page(failed: readonly string[]): SearchPage {
  const hits: WebHit[] = [{ title: "T", url: "https://example.com/a", engines: ["brave"], score: 0.5 }];
  return { hits, merged: hits.length, tookMs: 5, cached: false, failed: [...failed] };
}

describe("blockedNote", () => {
  it("a fully healthy search says nothing about engines", () => {
    expect(blockedNote(page([]))).toBeNull();
  });

  it("a partial search warns that the results are only part of the web", () => {
    const note = blockedNote(page(["mojeek", "marginalia"]));
    expect(note).toContain("mojeek and marginalia");
    expect(note).toContain("only part of the web");
    expect(note).toContain("blocked, rate limited or too slow");
  });

  it("reads engine names as a sentence, through the same joinNames the model's list uses", () => {
    expect(blockedNote(page(["brave"]))).toContain("Note: brave could not be reached");
  });
});

describe("PRIVATE_BLOCKED", () => {
  it("is the exact sentence browser/guard.ts throws, so a caller can recognise the refusal", () => {
    expect(PRIVATE_BLOCKED).toBe("This address points to a private network and was blocked.");
  });
});

describe("the barrel surface", () => {
  it("re-exports both halves of web.rs — the fetch engine and the search fusion", () => {
    // `pub use fetch::*; pub use search::*;`. The guard half is deliberately
    // NOT re-exported: it lives at `browser/guard.ts`, where every existing
    // importer already reaches it.
    for (const name of [
      "fetchPage",
      "fetchReadable",
      "fetchPreview",
      "fetchImage",
      "guardedGet",
      "downloadToTemp",
      "youtubeVideoId",
      "youtubeTranscript",
      "safeFileName",
      "searchWeb",
      "searchForBrowser",
      "searchPage",
      "renderHits",
      "joinNames",
      "provenance",
      "hitSource",
    ]) {
      expect(typeof (web as unknown as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(web.MAX_DOWNLOAD_BYTES).toBe(900 * 1024 * 1024);
    expect(web.INLINE_DOWNLOAD_BYTES).toBe(64 * 1024 * 1024);
    expect(web.MAX_FETCH_BYTES).toBe(8 * 1024 * 1024);
    expect(web.MAX_PAGE_CHARS).toBe(200_000);
  });

  it("does NOT re-export the SSRF guard — one home for it, so the two cannot drift", () => {
    const surface = web as unknown as Record<string, unknown>;
    expect(surface.checkPublicHttpUrl).toBeUndefined();
    expect(surface.resolvePublicAddr).toBeUndefined();
  });
});
