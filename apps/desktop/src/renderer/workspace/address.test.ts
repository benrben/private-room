import { describe, expect, it } from "vitest";
import { classifyAddress, needsFreshFetch } from "./address";

describe("classifyAddress", () => {
  it("does nothing for blank input and keeps an explicit empty search empty", () => {
    expect(classifyAddress("  ")).toBeNull();
    expect(classifyAddress("?   ")).toBeNull();
  });

  it("honors forced searches and explicit URL schemes before guessing", () => {
    expect(classifyAddress("?example.com")).toEqual({ kind: "search", query: "example.com" });
    expect(classifyAddress("https://private.test/path")).toEqual({ kind: "url", url: "https://private.test/path" });
  });

  it("searches spaced or bare queries while navigating host-like targets", () => {
    expect(classifyAddress("best pizza nyc")).toEqual({ kind: "search", query: "best pizza nyc" });
    expect(classifyAddress("weather")).toEqual({ kind: "search", query: "weather" });
    expect(classifyAddress("example.com/article")).toEqual({ kind: "url", url: "https://example.com/article" });
    expect(classifyAddress("localhost:3000")).toEqual({ kind: "url", url: "https://localhost:3000" });
    expect(classifyAddress("192.168.1.1:8080")).toEqual({ kind: "url", url: "https://192.168.1.1:8080" });
  });
});

describe("needsFreshFetch", () => {
  it("falls back to the live page when the address cannot be parsed", () => {
    expect(needsFreshFetch("not a valid URL")).toBe(false);
  });

  it("fetches captions and binary downloads but reuses ordinary live pages", () => {
    expect(needsFreshFetch("https://www.youtube.com/watch?v=fabricated")).toBe(true);
    expect(needsFreshFetch("https://files.test/report.PDF?download=1")).toBe(true);
    expect(needsFreshFetch("https://news.test/private/article")).toBe(false);
  });
});
