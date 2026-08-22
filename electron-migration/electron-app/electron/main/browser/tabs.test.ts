// Port of the tab/sitting tests in src-tauri/src/browser.rs:
// `closing_a_page_shows_its_right_neighbour_then_its_left`,
// `a_page_is_labelled_by_its_host_until_its_title_is_known`,
// `a_page_that_has_told_us_its_name_is_called_by_it`,
// `moving_a_page_drops_the_name_the_old_document_gave_it`,
// `the_page_cap_is_small_enough_to_matter_and_larger_than_one`,
// `bounds_are_clamped_to_something_the_platform_accepts`,
// `a_browsing_sitting_opens_with_the_first_page_and_closes_with_the_last`,
// `two_sittings_in_the_same_second_are_still_two`,
// `closing_the_browser_ends_the_sitting`.

import { describe, expect, it } from "vitest";
import {
  MAX_TABS,
  PARKED,
  START_BLANK,
  TabRegistry,
  heirAfter,
  mintSessionId,
  nowIso,
  pageLabel,
  pageTitle,
  saneBounds,
  type Page,
} from "./tabs.js";
import { UNKNOWN_PROTECTION } from "./protection.js";

const page = (id: string, url = "https://example.com/", title = ""): Page => ({
  id,
  url,
  title,
  protection: UNKNOWN_PROTECTION,
});

describe("closing_a_page_shows_its_right_neighbour_then_its_left", () => {
  it("takes the right neighbour, else the left, else nothing", () => {
    // The frontend tab strip picks its heir by the identical rule and the two
    // MUST agree — if they disagree, the page on screen is not the tab the
    // strip highlights, which is the worst kind of UI bug because everything
    // still looks like it is working.
    expect(heirAfter(["a", "c"], 1)).toBe("c");
    expect(heirAfter(["a", "b"], 2)).toBe("b");
    expect(heirAfter(["b"], 0)).toBe("b");
    expect(heirAfter([], 0)).toBe("");
    expect(heirAfter(["a"], null)).toBe("");
  });

  it("does not let a NEGATIVE index wrap round to count from the END", () => {
    // Rust's `index.wrapping_sub(1)` lands on usize::MAX (always out of
    // bounds); JS's `.at()` counts backwards from the end instead.
    //
    // THE ASSERTION HAS TO BE THIS ONE. `at - 1` can only be negative when `at`
    // is 0, and `at === 0` only falls left when `remaining` is EMPTY — where
    // `[].at(-1)` is `undefined` as well. So `heirAfter([], 0)` and
    // `heirAfter(["only"], 0)` are satisfied by the `.at()` spelling too, and a
    // test built only from those could never fail however this was written.
    // A negative `at` is where the two genuinely differ.
    expect(heirAfter(["a", "b", "c"], -1)).toBe("");
    expect(heirAfter(["a", "b", "c"], -2)).toBe("");
    expect(heirAfter(["a"], -1)).toBe("");
    // …and the non-negative cases the rule is actually driven with.
    expect(heirAfter(["only"], 0)).toBe("only");
    expect(heirAfter([], 0)).toBe("");
  });

  it("never hands back an index dropPage can produce for a page it did not find", () => {
    // `dropPage` maps "not found" to `null`, never to `-1`, so the negative
    // case above cannot arrive from this side — pinned so a future "simplify"
    // that returns the raw `findIndex` result fails here rather than silently
    // showing the last tab.
    const r = new TabRegistry();
    r.addPage(page("0"));
    r.addPage(page("1"));
    expect(r.dropPage("nope").at).toBeNull();
    expect(heirAfter(r.dropPage("nope").remaining, r.dropPage("nope").at)).toBe("");
  });
});

describe("a_page_is_labelled_by_its_host_until_its_title_is_known", () => {
  it("labels by host, stripping www.", () => {
    expect(pageTitle("https://www.example.com/a/b?c=d")).toBe("example.com");
    expect(pageTitle("https://news.ycombinator.com/")).toBe("news.ycombinator.com");
  });

  it("stays honest for a blank or unparseable address", () => {
    expect(pageTitle(START_BLANK)).toBe("New page");
    expect(pageTitle("")).toBe("New page");
  });
});

describe("a_page_that_has_told_us_its_name_is_called_by_it", () => {
  it("prefers the document's own title", () => {
    expect(pageLabel("Example Domain", "https://example.com/")).toBe("Example Domain");
  });

  it("falls back through host, then the honest placeholder", () => {
    // All three states are real and distinguishable; the row read "New page"
    // over a loaded example.com because only the last resort was consulted.
    expect(pageLabel("", "https://example.com/")).toBe("example.com");
    expect(pageLabel("   ", "https://example.com/")).toBe("example.com");
    expect(pageLabel("", START_BLANK)).toBe("New page");
  });
});

describe("moving_a_page_drops_the_name_the_old_document_gave_it", () => {
  it("keeps the title when the SAME url is re-reported", () => {
    const r = new TabRegistry();
    r.addPage(page("0", "https://example.com/", "Example Domain"));
    r.recordUrl("0", "https://example.com/");
    expect(r.find("0")?.title).toBe("Example Domain");
  });

  it("drops it on a real move, falling back to the new host", () => {
    const r = new TabRegistry();
    r.addPage(page("0", "https://example.com/", "Example Domain"));
    r.recordUrl("0", "https://other.test/");
    const p = r.find("0");
    expect(pageLabel(p?.title ?? "", p?.url ?? "")).toBe("other.test");
  });

  it("only writes the ACTIVE page's title, and only when non-empty", () => {
    const r = new TabRegistry();
    r.addPage(page("0", "https://example.com/", "Example Domain"));
    r.addPage(page("1"));
    r.setActive("0");
    r.recordActiveTitle("   ");
    expect(r.find("0")?.title).toBe("Example Domain");
    r.recordActiveTitle("Renamed");
    expect(r.find("0")?.title).toBe("Renamed");
    expect(r.find("1")?.title).toBe("");
  });
});

describe("recordActiveUrl (the info poll's self-heal)", () => {
  it("writes back a real destination for the showing page", () => {
    const r = new TabRegistry();
    r.addPage(page("0", START_BLANK));
    r.setActive("0");
    r.recordActiveUrl("https://example.com/real");
    expect(r.recordedUrl("0")).toBe("https://example.com/real");
  });

  it("ignores about:blank and anything unparseable", () => {
    const r = new TabRegistry();
    r.addPage(page("0", "https://example.com/"));
    r.setActive("0");
    r.recordActiveUrl(START_BLANK);
    r.recordActiveUrl("not a url");
    expect(r.recordedUrl("0")).toBe("https://example.com/");
  });

  it("does nothing when no page is active", () => {
    const r = new TabRegistry();
    r.addPage(page("0"));
    r.recordActiveUrl("https://other.test/");
    expect(r.recordedUrl("0")).toBe("https://example.com/");
  });
});

describe("the cap and the parking spot", () => {
  it("is small enough to matter and larger than one", () => {
    // It REFUSES a ninth page rather than silently closing one the user was
    // reading.
    expect(MAX_TABS).toBeGreaterThan(1);
    expect(MAX_TABS).toBeLessThanOrEqual(16);
  });

  it("clamps negative/zero dimensions to something the platform accepts", () => {
    const b = saneBounds({ x: -5, y: -1, width: 0, height: -20 });
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.width).toBeGreaterThanOrEqual(1);
    expect(b.height).toBeGreaterThanOrEqual(1);
  });

  it("keeps PARKED itself legal", () => {
    expect(saneBounds(PARKED)).toEqual(PARKED);
  });
});

describe("a_browsing_sitting_opens_with_the_first_page_and_closes_with_the_last", () => {
  it("opens with the first page, is shared by the rest, and ends with the last", () => {
    const r = new TabRegistry();
    expect(r.sessionId()).toBe("");

    r.addPage(page("0"));
    const first = r.sessionId();
    expect(first).not.toBe("");

    r.addPage(page("1"));
    expect(r.sessionId()).toBe(first);

    r.dropPage("0");
    expect(r.sessionId()).toBe(first);

    r.dropPage("1");
    // The sitting must end with the browser, or the next one is labelled as
    // this one.
    expect(r.sessionId()).toBe("");

    r.addPage(page("2"));
    expect(r.sessionId()).not.toBe(first);
  });

  it("ends the sitting on closeAll too — room close and app quit", () => {
    const r = new TabRegistry();
    r.addPage(page("0"));
    r.setActive("0");
    r.closeAll();
    expect(r.sessionId()).toBe("");
    expect(r.active).toBe("");
    expect(r.all()).toHaveLength(0);
  });
});

describe("two_sittings_in_the_same_second_are_still_two", () => {
  it("differs by the counter even with an identical clock reading", () => {
    const at = new Date(2026, 7, 22, 16, 45, 5);
    expect(mintSessionId(0, at)).not.toBe(mintSessionId(1, at));
    expect(mintSessionId(0, at)).toBe("20260822164505-0");
  });

  it("is not a bare counter — journal lines outlive the process", () => {
    // A bare counter would restart at 0 and label last week's browsing as this
    // sitting.
    expect(mintSessionId(0).length).toBeGreaterThan(8);
  });
});

describe("nowIso", () => {
  it("matches browser.rs's now_iso shape: %Y-%m-%dT%H:%M:%S", () => {
    expect(nowIso(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05");
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("isBlank and tabList", () => {
  it("is blank with nothing open, and until a real destination is recorded", () => {
    const r = new TabRegistry();
    expect(r.isBlank()).toBe(true);
    r.addPage(page("0", START_BLANK));
    r.setActive("0");
    expect(r.isBlank()).toBe(true);
    r.recordUrl("0", "https://example.com/");
    expect(r.isBlank()).toBe(false);
  });

  it("drops entries the caller says are gone, so a row cannot outlive its view", () => {
    const r = new TabRegistry();
    r.addPage(page("0"));
    r.addPage(page("1", "https://other.test/"));
    r.setActive("1");
    const live = r.tabList((id) => id === "1");
    expect(live).toEqual([{ id: "1", title: "other.test", url: "https://other.test/", active: true }]);
  });
});

describe("page ids", () => {
  it("increment monotonically and are never reused", () => {
    // A stale frontend reference must resolve to "gone", never to somebody
    // else's page.
    const r = new TabRegistry();
    const ids = [r.nextId(), r.nextId(), r.nextId()];
    expect(ids).toEqual(["0", "1", "2"]);
    r.addPage(page(ids[0] as string));
    r.dropPage(ids[0] as string);
    expect(r.nextId()).toBe("3");
  });
});
