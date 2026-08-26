import { describe, expect, it } from "vitest";

import { antigravityModelsFromJson } from "./modelCatalogSurfaceIpc.js";

describe("Antigravity live model catalog", () => {
  it("maps the machine-readable agy catalog without hard-coding model names", () => {
    const raw = JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "models",
        data: {
          models: [
            { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
            { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
          ],
        },
      },
    });

    expect(antigravityModelsFromJson(raw).map(({ slug, label }) => ({ slug, label }))).toEqual([
      { slug: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { slug: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    ]);
  });

  it("fails closed on malformed JSON and ignores malformed rows", () => {
    expect(() => antigravityModelsFromJson("not json")).toThrow("bad JSON from agy");
    expect(antigravityModelsFromJson(JSON.stringify({ command: { data: { models: [{ label: "missing id" }] } } }))).toEqual([]);
  });
});
