import { describe, expect, it } from "vitest";

import {
  newPasswordProblem,
  revokedRecoveryWarning,
  sealedExportPasswordProblem,
  strandedCheckpointWarning,
  touchIdLostWarning,
} from "./passwordChange";

describe("sealedExportPasswordProblem", () => {
  it("reports a mismatched backup confirmation before evaluating its length", () => {
    expect(sealedExportPasswordProblem("short", "different", 12)).toBe(
      "The backup passwords do not match.",
    );
  });

  it("counts a fabricated emoji password by characters rather than UTF-16 units", () => {
    expect(sealedExportPasswordProblem("🔐", "🔐", 2)).toBe(
      "Backup password must be at least 2 characters.",
    );
  });

  it("accepts a matching backup password at the character boundary", () => {
    expect(sealedExportPasswordProblem("🔐🗝️", "🔐🗝️", 2)).toBeNull();
  });
});

describe("password-change warnings", () => {
  it("validates a new room password and names stranded restore points", () => {
    expect(newPasswordProblem("one", "two", 4)).toContain("do not match");
    expect(newPasswordProblem("one", "one", 4)).toContain("at least 4");
    expect(newPasswordProblem("long enough", "long enough", 4)).toBeNull();
    expect(strandedCheckpointWarning([])).toBeNull();
    expect(strandedCheckpointWarning(["daily"])).toContain("1 restore point");
    expect(strandedCheckpointWarning(["daily", "weekly"])).toContain("2 restore points");
  });

  it("warns when recovery or Touch ID was actually revoked", () => {
    expect(revokedRecoveryWarning(true, null)).toContain("has been revoked");
    expect(touchIdLostWarning(true, false)).toContain("Touch ID unlock was turned off");
  });

  it("stays quiet when recovery and Touch ID remain available", () => {
    expect(revokedRecoveryWarning(false, null)).toBeNull();
    expect(revokedRecoveryWarning(true, "fresh-code")).toBeNull();
    expect(touchIdLostWarning(false, false)).toBeNull();
    expect(touchIdLostWarning(true, true)).toBeNull();
  });
});
