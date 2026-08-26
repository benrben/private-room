import { describe, expect, it } from "vitest";
import { safeFinalizationFailure, safeProviderFailure } from "./failureSafety.js";

describe("harness failure safety", () => {
  it("emits only bounded provider labels, phases, and numeric exit codes", () => {
    expect(safeProviderFailure("codex", "run", 7))
      .toBe("Codex run failed (exit 7). Provider diagnostics were omitted to protect room data.");
    expect(safeProviderFailure("unknown-provider", "tool"))
      .toBe("The model provider tool failed. Provider diagnostics were omitted to protect room data.");
  });

  it("does not require or accept raw diagnostic text for finalization failures", () => {
    expect(safeFinalizationFailure("write-back")).toContain("diagnostics were omitted");
    expect(safeFinalizationFailure("reconciliation")).toContain("diagnostics were omitted");
  });
});
