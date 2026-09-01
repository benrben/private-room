import { describe, expect, it } from "vitest";

import type { BrowserInfo } from "../apiTypes";
import { announcement, guardClause, hostOf, stalledBanner } from "./browserAnnounce";

function page(overrides: Partial<BrowserInfo> = {}): BrowserInfo {
  return {
    open: true,
    blank: false,
    url: "https://example.test/article",
    title: "Example article",
    ready: "complete",
    protection: { state: "active" },
    ...overrides,
  };
}

describe("private browser announcements", () => {
  it("finds speakable hosts without inventing one for missing or malformed addresses", () => {
    expect(hostOf("https://docs.example.test:8443/guide")).toBe("docs.example.test:8443");
    expect(hostOf()).toBeNull();
    expect(hostOf("not a URL")).toBeNull();
  });

  it("states only real blocking failures", () => {
    expect(guardClause(page({ protection: { state: "failed", reason: "offline" } }))).toBe(
      " Tracker blocking is off — the block list failed to load.",
    );
    expect(guardClause(page({ protection: { state: "unavailable", reason: "unsupported" } }))).toBe(
      " Tracker blocking is unavailable on this system.",
    );
    expect(guardClause(page({ protection: { state: "unknown" } }))).toBe("");
  });

  it("exposes a stalled page only while an opened nonblank page has a reason", () => {
    expect(stalledBanner(page({ error: "  Web view exited  ", ready: false }))).toBe(
      "This page has stopped answering (Web view exited), so the address and anything read from it may be out of date. Reload to try again.",
    );
    expect(stalledBanner(page({ error: "   " }))).toBe(
      "This page has stopped answering, so the address and anything read from it may be out of date. Reload to try again.",
    );
    expect(stalledBanner(page({ open: false, error: "Web view exited" }))).toBeNull();
    expect(stalledBanner(page({ blank: true, error: "Web view exited" }))).toBeNull();
    expect(stalledBanner(page())).toBeNull();
  });

  it("announces each changed browser state without repeating an identical poll", () => {
    const complete = page();
    expect(announcement(complete, complete)).toBeNull();
    expect(announcement(complete, { open: false })).toBe(
      "All private pages are closed. This browsing session is cleared — its history, cookies and cache are gone.",
    );
    expect(announcement(complete, page({ blank: true }))).toBe(
      "New tab. Nothing is loaded yet — type an address or a search.",
    );
    expect(announcement(complete, page({ error: "Lost the web view" }))).toBe(
      "This page is not answering. Lost the web view",
    );
  });

  it("describes loading, secure and insecure completed pages with the blocker status", () => {
    expect(announcement(null, page({ ready: "loading", url: "not a URL", title: null }))).toBe(
      "Loading not a URL.",
    );
    expect(
      announcement(
        null,
        page({
          ready: "loading",
          protection: { state: "failed", reason: "offline" },
        }),
      ),
    ).toBe("Loading example.test. Tracker blocking is off — the block list failed to load.");
    expect(
      announcement(
        null,
        page({
          url: "http://example.test/news",
          protection: { state: "unavailable", reason: "unsupported" },
        }),
      ),
    ).toBe(
      "Loaded: Example article. example.test. Not encrypted. Tracker blocking is unavailable on this system.",
    );
    expect(announcement(null, page({ title: "   ", url: null }))).toBe(
      "Loaded an unnamed page. This page has no title.",
    );
  });

  it("treats a protection verdict as a changed page state", () => {
    const prior = page({ protection: { state: "active" } });
    expect(
      announcement(prior, page({ protection: { state: "failed", reason: "offline" } })),
    ).toBe(
      "Loaded: Example article. example.test. Tracker blocking is off — the block list failed to load.",
    );
  });
});
