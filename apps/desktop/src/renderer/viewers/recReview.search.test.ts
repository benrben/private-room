import { describe, expect, it } from "vitest";
import { formatTimestamp, highlightQuote, searchTranscript, type SearchTurn } from "./recReview";

describe("review labels", () => {
  it("formats recordings beyond one hour without dropping zero-padded fields", () => {
    expect(formatTimestamp(3_661_99)).toBe("1:01:01");
  });

  it("keeps a long first sentence available in both its title and excerpt", () => {
    const sentence = "A deliberately long heading without an early stopping point that remains useful to the reviewer.";
    const quote = highlightQuote([{ t0: 0, t1: 10, text: sentence }], 0, 10);

    expect(quote?.title.endsWith("…")).toBe(true);
    expect(quote?.excerpt).toBe(sentence);
  });

  it("cuts an unbroken long word at the hard boundary", () => {
    const word = "x".repeat(80);
    const quote = highlightQuote([{ t0: 0, t1: 10, text: word }], 0, 10);

    expect(quote?.title).toBe(`${"x".repeat(58)}…`);
  });
});

function turn(key: string, phrases: ReadonlyArray<readonly [string, string]>): SearchTurn {
  return {
    key,
    segs: phrases.map(([id, text]) => ({ seg: { id }, text })),
  };
}

describe("searchTranscript", () => {
  it("keeps the original renderer state when whitespace does not form a search", () => {
    const turns = [turn("turn-1", [["segment-1", "A planned release"]])];

    const result = searchTranscript(turns, "  \t ");

    expect(result).toEqual({ turns, hits: new Set(), phrases: 0, searching: false });
    expect(result.turns).toBe(turns);
  });

  it("finds each matching phrase case-insensitively while retaining its complete turn", () => {
    const first = turn("turn-1", [
      ["segment-1", "Ship on Thursday"],
      ["segment-2", "Review the Thursday rollout"],
    ]);
    const second = turn("turn-2", [["segment-3", "Unrelated status"]]);
    const third = turn("turn-3", [["segment-4", "Thursday afternoon works"]]);

    const result = searchTranscript([first, second, third], "THURSDAY");

    expect(result.turns).toEqual([first, third]);
    expect(result.hits).toEqual(new Set(["segment-1", "segment-2", "segment-4"]));
    expect(result.phrases).toBe(3);
    expect(result.searching).toBe(true);
  });

  it("keeps a real search active when no visible phrase matches", () => {
    const result = searchTranscript(
      [turn("turn-1", [["segment-1", "Hello there"]]), turn("turn-2", [["segment-2", "General update"]])],
      "zebra"
    );

    expect(result).toEqual({ turns: [], hits: new Set(), phrases: 0, searching: true });
  });
});
