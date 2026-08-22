// Port of `a_finished_document_with_no_script_is_refused_not_still_loading`,
// `the_blank_start_page_is_not_mistaken_for_the_page_that_was_asked_for` and
// `a_readiness_probe_that_timed_out_is_a_busy_page_not_an_undriveable_one` in
// src-tauri/src/browser.rs.

import { describe, expect, it } from "vitest";
import {
  EVAL_LOST,
  EVAL_TIMED_OUT,
  EVAL_TIMEOUT_MS,
  READY_BUDGET_NAV_MS,
  SCRIPT_REFUSED,
  START_BLANK,
  classifyReady,
  evalLostToNavigation,
  readinessFromProbeError,
} from "./readiness.js";

describe("a_finished_document_with_no_script_is_refused_not_still_loading", () => {
  it("classifies a real, answered page as ready", () => {
    expect(classifyReady({ ok: true, url: "https://example.com/" }, false)).toBe("ready");
  });

  it("classifies a document that finished loading with no script as refused", () => {
    expect(classifyReady({ ok: false, refused: true }, false)).toBe("refused");
  });

  it("classifies mid-navigation (no script yet, not refused) as loading", () => {
    expect(classifyReady({ ok: false, refused: false }, false)).toBe("loading");
  });

  it("never reads the superseded page's bare {ok:false} as a refusal", () => {
    // The page being navigated AWAY from is complete and DOES have the script,
    // so it can never look refused — it answers the superseded arm.
    expect(classifyReady({ ok: false }, false)).toBe("loading");
  });

  it("does not fall over on a null or garbage answer", () => {
    expect(classifyReady(null, false)).toBe("loading");
    expect(classifyReady("nonsense", false)).toBe("loading");
  });
});

describe("the_blank_start_page_is_not_mistaken_for_the_page_that_was_asked_for", () => {
  it("reads the blank start document as still-loading when a real page was asked for", () => {
    expect(classifyReady({ ok: true, url: START_BLANK }, false)).toBe("loading");
  });

  it("reads it as ready when our own record agrees the tab IS blank", () => {
    // Otherwise every tool on a fresh tab would spin out its whole budget.
    expect(classifyReady({ ok: true, url: START_BLANK }, true)).toBe("ready");
  });
});

describe("a_readiness_probe_that_timed_out_is_a_busy_page_not_an_undriveable_one", () => {
  it("keeps the eval budget longer than the smallest readiness budget", () => {
    // If a probe could no longer outlast a budget, the distinction below would
    // be moot.
    expect(EVAL_TIMEOUT_MS).toBeGreaterThan(READY_BUDGET_NAV_MS);
  });

  it("reads a timeout as loading, not refused", () => {
    expect(readinessFromProbeError(EVAL_TIMED_OUT)).toBe("loading");
  });

  it("reads a lost call (a navigation) as loading — THE FIRST-NAVIGATION BUG", () => {
    // This used to map to "no script at all", so a window of these expired the
    // budget into SCRIPT_REFUSED — the message written to stop the model
    // retrying — for a page that was merely loading.
    expect(readinessFromProbeError(EVAL_LOST)).toBe("loading");
  });

  it("reads a genuine no-script answer as null", () => {
    expect(readinessFromProbeError(SCRIPT_REFUSED)).toBeNull();
    expect(readinessFromProbeError("The page answered with something unreadable: x")).toBeNull();
  });

  it("never diagnoses a closed browser — nothing closed, a navigation happened", () => {
    expect(EVAL_LOST).not.toContain("closed");
  });

  it("recognises a lost call as a navigation for the info poll, and nothing else", () => {
    expect(evalLostToNavigation(EVAL_LOST)).toBe(true);
    expect(evalLostToNavigation(EVAL_TIMED_OUT)).toBe(false);
    expect(evalLostToNavigation(SCRIPT_REFUSED)).toBe(false);
  });
});

describe("SCRIPT_REFUSED's wording", () => {
  it("does not invite a retry", () => {
    // An invitation to retry is what turned one failure into a twenty-round
    // loop in live QA.
    expect(SCRIPT_REFUSED.toLowerCase()).not.toContain("try again");
    expect(SCRIPT_REFUSED).toContain("Nothing was done");
  });
});
