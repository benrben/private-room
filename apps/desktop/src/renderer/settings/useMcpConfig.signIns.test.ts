import { describe, expect, it } from "vitest";
import { signInsDroppedBy } from "./useMcpConfig";

describe("signInsDroppedBy", () => {
  it("names only retained servers whose Authorization value would be removed", () => {
    const stored = JSON.stringify({
      mcpServers: {
        retained: { headers: { Authorization: "Bearer retained", "X-Other": "keep" } },
        alreadyUnsigned: { headers: { "X-Other": "value" } },
        removed: { headers: { Authorization: "Bearer removed" } },
      },
    });
    const posted = JSON.stringify({
      mcpServers: {
        retained: { headers: { "X-Other": "keep" } },
        alreadyUnsigned: { headers: {} },
      },
    });

    expect(signInsDroppedBy(stored, posted)).toEqual(["retained"]);
  });

  it("treats malformed or non-server JSON as an unknown config rather than a dropped sign-in", () => {
    expect(signInsDroppedBy("not json", JSON.stringify({ mcpServers: {} }))).toEqual([]);
    expect(signInsDroppedBy(JSON.stringify({ mcpServers: { a: { headers: { Authorization: "Bearer a" } } } }), "[]")).toEqual([]);
  });
});
