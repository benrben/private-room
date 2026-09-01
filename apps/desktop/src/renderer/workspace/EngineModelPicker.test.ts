import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, ExternalModelInfo } from "../api";

const mocks = vi.hoisted(() => ({
  listEngineModels: vi.fn(),
  validateEngineModel: vi.fn(),
}));

vi.mock("../api", () => ({
  api: mocks,
  ENGINE_LABELS: {
    "claude-cli": "Claude Code",
    "codex-cli": "Codex",
    "antigravity-cli": "Antigravity CLI",
    openrouter: "OpenRouter",
  },
  modelLabel: (model: string) =>
    model === "named-local" ? "Named local" : null,
}));
vi.mock("../icons", () => ({
  CheckIcon: () => null,
  ChevronDownIcon: () => null,
}));
vi.mock("./markup", () => ({
  isRemoteModel: (model: string) => model.includes("cloud"),
}));
vi.mock("./localModel", () => ({
  isEmbeddingModel: (model: string) => model.includes("embed"),
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function engineModel(
  overrides: Partial<ExternalModelInfo> = {},
): ExternalModelInfo {
  return {
    slug: "alpha",
    label: "Alpha",
    efforts: [],
    defaultEffort: null,
    contextWindow: null,
    description: null,
    inputPrice: null,
    outputPrice: null,
    inputModalities: [],
    outputModalities: [],
    tools: false,
    vision: false,
    imageOutput: false,
    videoOutput: false,
    reasoning: false,
    structuredOutputs: false,
    ...overrides,
  };
}

function ai(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    running: true,
    installed: true,
    models: ["named-local"],
    defaultModel: "named-local",
    external: [],
    remoteRelay: false,
    ...overrides,
  };
}

type PickerProps = {
  ai?: AiStatus;
  model?: string;
  engineModels?: Record<string, ExternalModelInfo[]>;
  onModelsLoaded?: (engine: string, models: ExternalModelInfo[]) => void;
  renderLocalExtra?: (model: string) => React.ReactNode;
  localEmptyHint?: React.ReactNode;
  manage?: boolean;
};
type View = Awaited<ReturnType<typeof renderPicker>>;

beforeEach(() => {
  mocks.listEngineModels.mockReset();
  mocks.validateEngineModel.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function flush(rounds = 5) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderPicker(initial: PickerProps = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { default: EngineModelPicker }] = await Promise.all([
    import("react-dom/client"),
    import("./EngineModelPicker"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const onSelect = vi.fn();
  const draw = async (next: PickerProps = initial) => {
    await act(async () => {
      root.render(
        createElement(EngineModelPicker, {
          ai: ai(),
          model: "named-local",
          onSelect,
          ...next,
        }),
      );
      await Promise.resolve();
    });
  };
  await draw();
  return {
    close: async () => act(async () => root.unmount()),
    document,
    draw,
    host,
    onSelect,
    window,
  };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React prop ${name} missing`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    reactProp(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    });
    await Promise.resolve();
  });
}

function button(view: View, text: string): HTMLButtonElement {
  const found = [...view.host.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === text ||
      candidate.textContent?.trim().startsWith(text),
  ) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`button ${text} missing`);
  return found;
}

async function click(view: View, text: string) {
  const found = button(view, text);
  await invoke(found);
  return found;
}

async function input(view: View, value: string) {
  const field = view.host.querySelector("input") as HTMLInputElement | null;
  if (!field) throw new Error("search field missing");
  await invoke(field, "onChange", { target: { value } });
  return field;
}

describe("EngineModelPicker", () => {
  it("separates local, embedding-only, and remote models while retaining host extras", async () => {
    const extra = vi.fn((model: string) =>
      createElement("button", null, `remove ${model}`),
    );
    const view = await renderPicker({
      ai: ai({
        models: ["named-local", "nomic-embed-text"],
      }),
      renderLocalExtra: extra,
    });

    expect(view.host.textContent).toContain("Named local");
    expect(view.host.textContent).not.toContain("nomic-embed-text");
    expect(button(view, "Cloud").disabled).toBe(true);
    expect(button(view, "Cloud").title).toContain("No cloud AI models");
    await click(view, "Named localLocal");
    expect(view.onSelect).toHaveBeenCalledWith("named-local");
    expect(extra).toHaveBeenCalledWith("named-local");
    await view.close();

    const managed = await renderPicker({
      ai: ai({ models: ["nomic-embed-text"] }),
      model: "nomic-embed-text",
      manage: true,
      localEmptyHint: "Ollama is offline",
    });
    const embedding = button(managed, "nomic-embed-textSearch only");
    expect(embedding.disabled).toBe(true);
    expect(embedding.title).toContain("semantic search");
    await managed.draw({
      ai: ai({ models: [] }),
      localEmptyHint: "Ollama is offline",
    });
    expect(managed.host.textContent).toContain("Ollama is offline");
    await managed.close();
  });

  it("filters rich catalogs, displays context and price metadata, and validates exact cloud models", async () => {
    const models = [
      engineModel({
        slug: "alpha",
        label: "Alpha",
        efforts: ["low", "high"],
        defaultEffort: "low",
        contextWindow: 1_000_000,
        description: "Reasoning model",
        inputPrice: "0.000000005",
        outputPrice: "0",
        tools: true,
        vision: true,
        reasoning: true,
        structuredOutputs: true,
      }),
      engineModel({
        slug: "beta",
        label: "Beta",
        efforts: ["medium"],
        contextWindow: 128_000,
        description: null,
        inputPrice: "not-a-price",
        outputPrice: null,
      }),
      engineModel({
        slug: "gamma",
        label: "Gamma",
        inputPrice: "0.00001",
      }),
    ];
    mocks.validateEngineModel.mockImplementation(async (_engine, model) => {
      if (model === "beta") throw new Error("offline");
      return { selectable: true, reason: null };
    });
    const view = await renderPicker({
      ai: ai({
        external: ["codex-cli"],
        models: ["remote:cloud"],
      }),
      model: "codex-cli::alpha::low",
      engineModels: { "codex-cli": models },
    });
    await flush();

    expect(mocks.listEngineModels).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("1.0M ctx");
    expect(view.host.textContent).toContain("128K ctx");
    expect(view.host.textContent).toContain("$0.005/M in");
    expect(view.host.textContent).toContain("free out");
    expect(view.host.textContent).toContain("$10.00/M in");
    expect(button(view, "low").getAttribute("aria-pressed")).toBe("true");
    await click(view, "On this Mac");
    await click(view, "Cloud");
    await click(view, "Default");
    await click(view, "high");
    expect(view.onSelect).toHaveBeenCalledWith("codex-cli::alpha");
    expect(view.onSelect).toHaveBeenCalledWith("codex-cli::alpha::high");

    await click(view, "Alpha");
    await flush();
    expect(mocks.validateEngineModel).toHaveBeenCalledWith(
      "codex-cli",
      "alpha",
    );
    expect(view.onSelect).toHaveBeenCalledWith("codex-cli::alpha");
    await click(view, "Alpha");
    expect(mocks.validateEngineModel).toHaveBeenCalledTimes(1);

    await click(view, "Beta");
    await flush();
    expect(view.host.textContent).toContain("could not be checked");
    await invoke(button(view, "Beta"));

    await click(view, "remote:cloudCloud");
    await flush();
    expect(mocks.validateEngineModel).toHaveBeenCalledWith(
      "ollama-cloud",
      "remote:cloud",
    );

    await click(view, "Tools");
    await click(view, "Vision");
    await click(view, "Reasoning");
    await click(view, "JSON");
    expect(view.host.textContent).toContain("1 shown");
    await input(view, "not-present");
    expect(view.host.textContent).toContain("No models match these filters");
    await click(view, "Codex");
    await click(view, "Codex");
    expect((view.host.querySelector("input") as HTMLInputElement).value).toBe(
      "",
    );
    await view.draw({
      ai: ai({ external: ["codex-cli"], models: ["remote:cloud"] }),
      model: "codex-cli::beta",
      engineModels: { "codex-cli": models },
    });
    expect(button(view, "Default").title).toBe("The CLI's default effort");
    await view.close();
  });

  it("loads uncached engines, reports provider failures, and handles empty OpenRouter catalogs", async () => {
    let resolveClaude!: (models: ExternalModelInfo[]) => void;
    let openRouterLoads = 0;
    mocks.listEngineModels.mockImplementation((engine: string) => {
      if (engine === "claude-cli") {
        return new Promise<ExternalModelInfo[]>((resolve) => {
          resolveClaude = resolve;
        });
      }
      if (engine === "antigravity-cli")
        return Promise.reject(new Error("unavailable"));
      openRouterLoads += 1;
      return openRouterLoads === 1
        ? Promise.resolve([])
        : Promise.reject(new Error("catalog unavailable"));
    });
    const view = await renderPicker({
      ai: ai({
        external: ["claude-cli", "antigravity-cli", "openrouter"],
      }),
    });

    await click(view, "Cloud");
    await click(view, "Claude Code");
    expect(view.host.textContent).toContain("Checking…");
    resolveClaude([engineModel({ slug: "plain", label: "Plain" })]);
    await flush();
    expect(view.host.textContent).toContain("Plain");
    expect(view.host.textContent).toContain("Claude Code's default");
    await click(view, "Claude Code's default");

    await click(view, "Antigravity CLI");
    await flush();
    expect(view.host.textContent).toContain("Couldn't list models");
    expect(view.host.textContent).toContain("Antigravity CLI's default");

    await click(view, "OpenRouter");
    await flush();
    expect(view.host.textContent).toContain(
      "No models are available for this OpenRouter account.",
    );
    await click(view, "OpenRouter");
    await click(view, "OpenRouter");
    await flush();
    expect(view.host.textContent).toContain(
      "Couldn't refresh the model catalog",
    );
    await view.close();
  });
});
