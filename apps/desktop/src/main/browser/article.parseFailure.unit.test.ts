import { describe, expect, it, vi } from "vitest";

vi.mock("linkedom", () => ({
  parseHTML: () => { throw new Error("fabricated parser failure"); },
}));
vi.mock("@mozilla/readability", () => ({ Readability: class Readability {} }));

import { readPage } from "./article.js";

describe("readPage parser boundary", () => {
  it("contains an untrusted-markup parser failure as an empty capture", () => {
    expect(readPage("<malformed>", "https://example.test/failure")).toEqual({
      meta: {},
      article: null,
    });
  });
});
