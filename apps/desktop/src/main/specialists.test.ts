import { describe, expect, it } from "vitest";
import { createCancelState, registerRun } from "./cancel.js";
import {
  type ListSpecialistsDeps,
  type ListSpecialistsRoomSource,
  cancelAsk,
  listSpecialists,
  parseSpecialists,
} from "./specialists.js";

describe("parseSpecialists", () => {
  const good = {
    key: "browse",
    tool: "ask_web_agent",
    agent: "chat.browse",
    label: "Browser agent",
    area: "browsing the web",
    description: "Drives a private browser to look things up.",
  };

  it("parses a well-formed agents array", () => {
    expect(parseSpecialists([good])).toEqual([good]);
  });

  it("preserves canonical disabled-row prerequisites from the sidecar registry", () => {
    expect(parseSpecialists([{
      ...good,
      capability: "unavailable",
      capabilityReason: "Turn on room internet",
      localHandoff: false,
    }])).toEqual([{
      ...good,
      capability: "unavailable",
      capabilityReason: "Turn on room internet",
      localHandoff: false,
    }]);
  });

  it("drops malformed capability decorations without dropping a valid specialist", () => {
    expect(parseSpecialists([{ ...good, capability: "pretend", capabilityReason: 17, localHandoff: "yes" }]))
      .toEqual([good]);
  });

  it("is [] for a non-array payload", () => {
    expect(parseSpecialists(undefined)).toEqual([]);
    expect(parseSpecialists(null)).toEqual([]);
    expect(parseSpecialists({ not: "an array" })).toEqual([]);
  });

  it("drops one malformed entry without discarding the rest of the menu", () => {
    const malformed = { key: "broken" }; // missing every other field
    expect(parseSpecialists([good, malformed])).toEqual([good]);
  });

  it("is [] for an empty array (this room really has no specialists)", () => {
    expect(parseSpecialists([])).toEqual([]);
  });
});

describe("listSpecialists", () => {
  function room(webEnabled: boolean, explicitModel: string | undefined): ListSpecialistsRoomSource {
    return { webEnabled: () => webEnabled, explicitModel: () => explicitModel };
  }

  it("calls dependencies in order: models -> served names -> sidecar POST, and returns the parsed roster", async () => {
    const calls: string[] = [];
    const deps: ListSpecialistsDeps = {
      listModels: async () => {
        calls.push("listModels");
        return ["qwen3.5:4b"];
      },
      bestDefault: (models) => {
        calls.push("bestDefault");
        return models[0] ?? "none";
      },
      servedToolNames: (model, webEnabled) => {
        calls.push(`servedToolNames(${model},${webEnabled})`);
        return ["web_search", "fetch_page"];
      },
      fetchAgents: async (body) => {
        calls.push(`fetchAgents(${JSON.stringify(body)})`);
        return {
          agents: [
            {
              key: "web",
              tool: "ask_web_agent",
              agent: "chat.web",
              label: "Web agent",
              area: "web search",
              description: "Searches the web.",
            },
          ],
        };
      },
    };
    const result = await listSpecialists(room(true, undefined), deps);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("web");
    expect(calls).toEqual([
      "listModels",
      "bestDefault",
      "servedToolNames(qwen3.5:4b,true)",
      'fetchAgents({"web_enabled":true,"served_names":["web_search","fetch_page"]})',
    ]);
  });

  it("prefers the room's explicit model over bestDefault, and skips calling bestDefault's result", async () => {
    let servedModel: string | undefined;
    const deps: ListSpecialistsDeps = {
      listModels: async () => ["a", "b"],
      bestDefault: () => "should-not-be-used",
      servedToolNames: (model) => {
        servedModel = model;
        return [];
      },
      fetchAgents: async () => ({ agents: [] }),
    };
    await listSpecialists(room(false, "explicit-model"), deps);
    expect(servedModel).toBe("explicit-model");
  });

  it("falls back to an empty model list when listModels rejects, rather than throwing", async () => {
    const deps: ListSpecialistsDeps = {
      listModels: async () => {
        throw new Error("ollama not reachable");
      },
      bestDefault: (models) => {
        expect(models).toEqual([]);
        return "fallback-model";
      },
      servedToolNames: () => [],
      fetchAgents: async () => ({ agents: [] }),
    };
    await expect(listSpecialists(room(false, undefined), deps)).resolves.toEqual([]);
  });

  it("propagates a sidecar transport failure as a real error (not an empty list)", async () => {
    const deps: ListSpecialistsDeps = {
      listModels: async () => [],
      bestDefault: () => "m",
      servedToolNames: () => [],
      fetchAgents: async () => {
        throw new Error("sidecar unreachable");
      },
    };
    await expect(listSpecialists(room(false, undefined), deps)).rejects.toThrow("sidecar unreachable");
  });

  it("keeps Video visibly unavailable before dispatch when the provider has no image channel", async () => {
    const reason = "The selected provider or privacy mode does not expose the tools required by *video. Switch to On this Mac to use it.";
    const deps: ListSpecialistsDeps = {
      listModels: async () => [],
      bestDefault: () => "antigravity-cli::gemini-3.7-flash-high",
      servedToolNames: () => ["ui_snapshot"],
      effectiveServedToolNames: () => ["ui_snapshot"],
      agentToolNames: () => ["view_media_frame"],
      fetchAgents: async ({ served_names }) => {
        expect(served_names).not.toContain("view_media_frame");
        return { agents: [{
          key: "video",
          tool: "ask_video_agent",
          agent: "media.video",
          label: "Video agent",
          area: "video inspection",
          description: "Inspects video frames.",
          capability: "unavailable",
          capabilityReason: reason,
          localHandoff: true,
        }] };
      },
    };
    await expect(listSpecialists(room(true, undefined), deps)).resolves.toEqual([
      expect.objectContaining({
        key: "video",
        capability: "unavailable",
        capabilityReason: reason,
        localHandoff: true,
      }),
    ]);
  });

  it("labels restricted specialists from the effective Cloud Privacy roster before dispatch", async () => {
    const row = (key: string, agent: string) => ({
      key,
      tool: `ask_${key}_agent`,
      agent,
      label: `${key} agent`,
      area: `${key} work`,
      description: `Does ${key} work.`,
    });
    const fullRoster = [
      row("web", "chat.web"),
      row("sketch", "creator.draw"),
      row("app", "app.ui"),
    ];
    const calls: string[][] = [];
    const deps: ListSpecialistsDeps = {
      listModels: async () => [],
      bestDefault: () => "openrouter:auto",
      servedToolNames: () => ["web_search", "save_link", "draw", "read_drawing", "ui_snapshot", "ui_act"],
      effectiveServedToolNames: () => ["web_search", "read_drawing", "ui_snapshot"],
      agentToolNames: (agent) => ({
        "chat.web": ["web_search", "save_link"],
        "creator.draw": ["draw", "read_drawing"],
        "app.ui": ["ui_snapshot", "ui_act"],
      }[agent] ?? []),
      fetchAgents: async ({ served_names }) => {
        calls.push(served_names);
        return {
          // Web and Sketch can genuinely run with their remaining inspect
          // tools. App requires ui_snapshot + ui_act together and disappears.
          agents: served_names.includes("draw") ? fullRoster : fullRoster.slice(0, 2),
        };
      },
    };

    const result = await listSpecialists(room(true, undefined), deps);
    expect(calls).toHaveLength(2);
    expect(result.find((specialist) => specialist.key === "web")).toMatchObject({
      capability: "inspect-only",
      localHandoff: true,
    });
    expect(result.find((specialist) => specialist.key === "sketch")).toMatchObject({
      capability: "inspect-only",
      localHandoff: true,
    });
    expect(result.find((specialist) => specialist.key === "app")).toMatchObject({
      capability: "unavailable",
      localHandoff: true,
    });
    expect(result.find((specialist) => specialist.key === "app")?.capabilityReason).toContain("On this Mac");
  });
});

describe("cancelAsk", () => {
  it("returns the underlying cancel tree's StopReport for a known run", () => {
    const state = createCancelState();
    registerRun(state, "run-1", "this answer");
    const report = cancelAsk(state, "run-1");
    expect(report.known).toBe(true);
    expect(report.stopped).toEqual(["this answer"]);
  });

  it("is known:false for an id nothing registered (already-finished run)", () => {
    const state = createCancelState();
    const report = cancelAsk(state, "never-existed");
    expect(report.known).toBe(false);
    expect(report.stopped).toEqual([]);
  });

  it("does not throw when observability has no sink installed", () => {
    const state = createCancelState();
    registerRun(state, "run-2", "another answer");
    expect(() => cancelAsk(state, "run-2")).not.toThrow();
  });
});
