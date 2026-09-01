import { describe, expect, it } from "vitest";
import {
  autoSpeakTitle,
  handsFreeTitle,
  privacyConfirmationText,
  privacySummary,
  privacyValveTitle,
} from "./chatPaneRules";

describe("chat pane copy rules", () => {
  it("describes enabled speech controls in their button titles", () => {
    expect(autoSpeakTitle(true)).toContain("Auto-speak is on");
    expect(handsFreeTitle(true)).toContain("Hands-free is on");
  });

  it("distinguishes a clean privacy scan from hidden text or images", () => {
    const nothingHidden = {
      bypassed: false,
      entities_hidden: 0,
      images_blocked: 0,
    };

    expect(privacySummary(nothingHidden)).toBe("Shielded — nothing private needed hiding");
    expect(privacyValveTitle(nothingHidden)).toContain("hidden details");
    expect(privacyConfirmationText(nothingHidden)).toBe(
      "Send this question again with the real details?",
    );
  });
});
