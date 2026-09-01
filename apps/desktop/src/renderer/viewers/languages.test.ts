import { describe, expect, it } from "vitest";
import { languageForFile } from "./languages";

describe("languageForFile", () => {
  it("uses the final extension case-insensitively", () => {
    expect(languageForFile("notes.release.JSONL")).toBe("json");
    expect(languageForFile("component.TSX")).toBe("typescript");
  });

  it("leaves extensionless and unsupported files as plain text", () => {
    expect(languageForFile("README")).toBe("plaintext");
    expect(languageForFile("archive.unknown")).toBe("plaintext");
  });
});
