// Port of `one_unprotected_page_makes_the_whole_browser_unprotected` and
// `the_verdict_reaches_the_frontend_as_a_tagged_state` in
// src-tauri/src/browser.rs.

import { describe, expect, it } from "vitest";
import type { BrowserProtection } from "../../shared/apiTypes.js";
import { UNKNOWN_PROTECTION, protectionSeverity, worstProtection } from "./protection.js";

const failed: BrowserProtection = { state: "failed", reason: "compile refused" };
const unavailable: BrowserProtection = { state: "unavailable", reason: "no store" };
const unknown: BrowserProtection = { state: "unknown" };
const active: BrowserProtection = { state: "active" };

describe("one_unprotected_page_makes_the_whole_browser_unprotected", () => {
  it("reports unknown with nothing open — never active", () => {
    // A browser with no pages has protected nothing.
    expect(worstProtection([])).toEqual(unknown);
    expect(UNKNOWN_PROTECTION).toEqual(unknown);
  });

  it("only reports active when EVERY page said so", () => {
    expect(worstProtection([active, active])).toEqual(active);
  });

  it("lets one bad page outrank any number of active pages", () => {
    for (const bad of [failed, unavailable, unknown]) {
      const mixed = [active, bad, active];
      expect(worstProtection(mixed), `one ${bad.state} page must win`).toEqual(bad);
      expect(worstProtection(mixed)).not.toEqual(active);
    }
  });

  it("orders severity failed > unavailable > unknown > active", () => {
    expect(worstProtection([unavailable, failed, unknown])).toEqual(failed);
    expect(worstProtection([unknown, unavailable])).toEqual(unavailable);
    expect(worstProtection([active, unknown])).toEqual(unknown);
    expect(protectionSeverity(failed)).toBeGreaterThan(protectionSeverity(unavailable));
    expect(protectionSeverity(unavailable)).toBeGreaterThan(protectionSeverity(unknown));
    expect(protectionSeverity(unknown)).toBeGreaterThan(protectionSeverity(active));
  });

  it("keeps the FIRST page's reason on a tie, so it belongs to the page that hit trouble earliest", () => {
    expect(
      worstProtection([failed, { state: "failed", reason: "second" }]),
    ).toEqual(failed);
  });
});

describe("the_verdict_reaches_the_frontend_as_a_tagged_state", () => {
  it("keeps the exact wire shape apiTypes.ts's BrowserProtection promises", () => {
    // The shield reads this off browser_info, so the JSON shape IS the
    // contract — a renamed tag or variant silently turns the chip's checks
    // into "none of the above".
    expect(JSON.parse(JSON.stringify(unknown))).toEqual({ state: "unknown" });
    expect(JSON.parse(JSON.stringify(active))).toEqual({ state: "active" });
    expect(JSON.parse(JSON.stringify(failed))).toEqual({
      state: "failed",
      reason: "compile refused",
    });
    expect(JSON.parse(JSON.stringify(unavailable))).toEqual({
      state: "unavailable",
      reason: "no store",
    });
  });

  it("defaults to the one state that is never presented as safe", () => {
    expect(UNKNOWN_PROTECTION.state).toBe("unknown");
  });
});
