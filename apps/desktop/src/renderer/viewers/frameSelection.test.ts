import { describe, expect, it } from "vitest";
import { frameSelectionOf, withSelectionReporter } from "./frameSelection";

const MARK = "arcelle:frame-selection";

describe("withSelectionReporter", () => {
  it("appends the bounded reporter without displacing the staged document", () => {
    const source = "<html><body><p>Readable</p></body></html>";
    const reported = withSelectionReporter(source);

    expect(reported.startsWith(source)).toBe(true);
    expect(reported).toContain(MARK);
    expect(reported).toContain("selectionchange");
    expect(reported).toContain("slice(0,8000)");
  });
});

describe("frameSelectionOf", () => {
  it("rejects hostile or incomplete message shapes", () => {
    for (const value of [
      null,
      "selection",
      [],
      {},
      { mark: "another-message", text: "quote" },
      { mark: MARK, text: 42 },
    ]) {
      expect(frameSelectionOf(value)).toBeNull();
    }
  });

  it("caps text and keeps a fully finite viewport rectangle", () => {
    const text = "x".repeat(8001);

    expect(
      frameSelectionOf({
        mark: MARK,
        text,
        rect: { top: 12, left: -4.5, width: 0 },
      }),
    ).toEqual({
      text: "x".repeat(8000),
      rect: { top: 12, left: -4.5, width: 0 },
    });
  });

  it("keeps a valid quote while dropping partial or non-finite rectangles", () => {
    for (const rect of [
      null,
      { top: 1, left: 2 },
      { top: Infinity, left: 2, width: 3 },
      { top: 1, left: "2", width: 3 },
      { top: 1, left: 2, width: Number.NaN },
    ]) {
      expect(frameSelectionOf({ mark: MARK, text: "quote", rect })).toEqual({
        text: "quote",
        rect: null,
      });
    }
  });
});
