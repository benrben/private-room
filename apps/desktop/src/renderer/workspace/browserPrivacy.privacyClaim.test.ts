import { describe, expect, it } from "vitest";
import {
  EPHEMERAL_VS_ROOM,
  NOT_ANONYMOUS,
  privacyClaim,
  startScreenCopy,
} from "./browserPrivacy";

describe("privacyClaim", () => {
  it("makes no storage or protection claim when no fabricated page is open", () => {
    const claim = privacyClaim(false, { state: "failed", reason: "ignored without a page" }, false);

    expect(claim).toEqual({
      tone: "checking",
      chip: "No page",
      detail: `No private page is open. ${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`,
      alert: null,
    });
  });

  it("makes the breached storage result override an otherwise active fabricated blocker", () => {
    const claim = privacyClaim(false, { state: "active" });

    expect(claim).toEqual({
      tone: "breached",
      chip: "Not private",
      detail:
        "WARNING: this page's storage is NOT ephemeral — history, cookies and cache may be written to disk. Close this page.",
      alert:
        "This browser is not private: a page reported a storage that survives the session. Close the private pages and reopen the room.",
    });
  });

  it("masks unproven storage or unreported protection as checking without claiming verification", () => {
    const storagePending = privacyClaim(null, { state: "failed", reason: "fake block list failure" });
    const protectionMissing = privacyClaim(true, undefined);
    const protectionPending = privacyClaim(true, { state: "unknown" });

    expect(storagePending).toMatchObject({
      tone: "checking",
      chip: "Checking",
      alert: "Tracker blocking is OFF: the block list failed to load (fake block list failure). Pages will load their trackers until this succeeds.",
    });
    expect(protectionMissing).toMatchObject({ tone: "checking", chip: "Checking", alert: null });
    expect(protectionPending).toMatchObject({ tone: "checking", chip: "Checking", alert: null });
    for (const claim of [storagePending, protectionMissing, protectionPending]) {
      expect(claim.chip).not.toBe("Private");
      expect(claim.detail).toContain(NOT_ANONYMOUS);
    }
  });

  it("separates failed and unavailable fabricated blocker reasons while retaining ephemeral storage", () => {
    const failed = privacyClaim(true, { state: "failed", reason: "fake load failure" });
    const unavailable = privacyClaim(true, { state: "unavailable", reason: "fake platform limitation" });

    expect(failed).toMatchObject({
      tone: "degraded",
      chip: "Partly private",
      alert: "Tracker blocking is OFF: the block list failed to load (fake load failure). Pages will load their trackers until this succeeds.",
    });
    expect(unavailable).toMatchObject({
      tone: "degraded",
      chip: "Partly private",
      alert: "Tracker blocking is unavailable on this system (fake platform limitation). Everything else about this browser is unchanged: the web session still writes nothing to disk.",
    });
    expect(failed.detail).toContain(EPHEMERAL_VS_ROOM);
    expect(unavailable.detail).toContain(NOT_ANONYMOUS);
  });

  it("uses the verified claim only when both fabricated privacy facts are positive", () => {
    const claim = privacyClaim(true, { state: "active" });

    expect(claim).toEqual({
      tone: "verified",
      chip: "Private",
      detail: `The web session writes nothing to disk, and the tracker block list is loaded. ${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`,
      alert: null,
    });
  });
});

describe("startScreenCopy", () => {
  it("names tracker blocking only after protection is verified", () => {
    expect(startScreenCopy({ state: "active" })).toContain("Known trackers are blocked.");
    expect(startScreenCopy({ state: "failed", reason: "fabricated" })).not.toContain("Known trackers are blocked.");
  });
});
