import { describe, expect, it, vi } from "vitest";

import type { AiStatus } from "../api";

const fakes = vi.hoisted(() => ({
  isRelayedModel: vi.fn((model: string) => model === "gpt-oss:120b-cloud"),
}));

vi.mock("../api", () => ({
  splitExternalModel: (model: string): [string, string | null, string | null] => {
    const [engine = "", submodel = null, effort = null] = model.split("::");
    return [engine, submodel, effort];
  },
}));

vi.mock("./localModel", () => ({
  isRelayedModel: fakes.isRelayedModel,
}));

import {
  annotationTarget,
  handTokens,
  isCloudEngine,
  isCloudRoute,
  isExternalEngine,
  isHandwritten,
  isModelReady,
  isRemoteModel,
  lostReplyAdvice,
  lostReplyNotice,
  messageClock,
  patchStreamFences,
  speakerName,
  splitMarkupBlocks,
  trustState,
} from "./markup";

function ai(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    running: true,
    installed: true,
    models: ["qwen3.5:4b"],
    defaultModel: "qwen3.5:4b",
    external: [],
    remoteRelay: false,
    ...overrides,
  };
}

describe("workspace markup model and trust decisions", () => {
  it("recognizes external and relayed routes without calling a provider", () => {
    for (const model of [
      "claude-cli",
      "codex-cli::gpt-5.6-sol",
      "antigravity-cli::gemini",
      "openrouter::model",
    ]) {
      expect(isExternalEngine(model)).toBe(true);
    }
    expect(isExternalEngine("qwen3.5:4b")).toBe(false);

    expect(isRemoteModel("gpt-oss:120b-cloud")).toBe(true);
    expect(isCloudEngine("gpt-oss:120b-cloud")).toBe(true);
    expect(isCloudEngine("qwen3.5:4b")).toBe(false);
    expect(isCloudRoute("qwen3.5:4b", null)).toBe(false);
    expect(isCloudRoute("qwen3.5:4b", { remoteRelay: true })).toBe(true);
    expect(isCloudRoute("codex-cli::gpt-5.6-sol", { remoteRelay: false })).toBe(true);
    expect(fakes.isRelayedModel).toHaveBeenCalledWith("gpt-oss:120b-cloud");
  });

  it("keeps privacy labels and readiness aligned with fabricated AI status", () => {
    expect(trustState(false, false)).toMatchObject({
      tone: "good",
      label: "Local only",
    });
    expect(trustState(true, false)).toMatchObject({
      tone: "danger",
      label: "Raw cloud",
    });
    expect(trustState(true, null)).toMatchObject({
      tone: "warn",
      label: "Protected cloud",
    });

    expect(isModelReady(null, "qwen3.5:4b")).toBe(false);
    expect(
      isModelReady(
        ai({ running: false, external: ["codex-cli"] }),
        "codex-cli::gpt-5.6-sol",
      ),
    ).toBe(true);
    expect(isModelReady(ai(), "qwen3.5:4b")).toBe(true);
    expect(isModelReady(ai(), "qwen3.5:4b:latest")).toBe(true);
    expect(isModelReady(ai({ models: ["qwen3.5:4b:latest"] }), "qwen3.5:4b")).toBe(true);
    expect(isModelReady(ai({ models: ["qwen3"] }), "qwen3.5:4b")).toBe(false);
    expect(isModelReady(ai({ running: false }), "qwen3.5:4b")).toBe(false);
  });

  it("formats stored timestamps against a controlled clock", () => {
    expect(messageClock("")).toBe("");
    expect(messageClock("not a timestamp")).toBe("");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    try {
      const today = messageClock("2026-08-31T09:15:00Z");
      const earlierThisYear = messageClock("2026-07-14T09:15:00Z");
      const previousYear = messageClock("2025-07-14T09:15:00Z");

      expect(today).not.toBe("");
      expect(earlierThisYear).not.toBe(today);
      expect(previousYear).not.toBe(earlierThisYear);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("workspace markup parsing and recovery", () => {
  it("extracts valid boxes and annotations while leaving their surrounding reply", () => {
    const boxes = {
      fileId: "document-1",
      name: "brief.pdf",
      boxes: [{ label: "Evidence", x1: 1, y1: 2, x2: 3, y2: 4 }],
    };
    const annotation = {
      fileId: "document-1",
      quote: "the important sentence",
      page: 2,
      sheet: "Plan",
      range: "A1:B2",
    };
    const result = splitMarkupBlocks(
      `Before\n\`\`\`boxes\n${JSON.stringify(boxes)}\n\`\`\`\nMiddle\n\`\`\`annotation\n${JSON.stringify(annotation)}\n\`\`\`\nAfter`,
    );

    expect(result).toEqual({ text: "Before\n\nMiddle\n\nAfter", boxes, annotation });
    expect(annotationTarget(annotation)).toEqual({
      quote: "the important sentence",
      find: "the important sentence",
      page: 2,
      sheet: "Plan",
      range: "A1:B2",
    });
  });

  it("removes malformed markup and distinguishes every lost-reply state", () => {
    expect(splitMarkupBlocks("Answer\n\`\`\`boxes\nnot JSON\n\`\`\`")).toEqual({
      text: "Answer",
      boxes: undefined,
      annotation: undefined,
    });
    expect(splitMarkupBlocks("Answer\n\`\`\`annotation\nnot JSON\n\`\`\`")).toEqual({
      text: "Answer",
      boxes: undefined,
      annotation: undefined,
    });

    const lost =
      "*(The agent finished, but the reply was lost before it reached the app.)";
    expect(lostReplyNotice("A real answer mentioning a lost reply")).toBeNull();
    expect(lostReplyNotice("*(The agent replied normally.)")).toBeNull();
    expect(lostReplyNotice(lost)).toBe("clean");
    expect(lostReplyNotice(`${lost} A change was already applied.`)).toBe("after-write");
    expect(
      lostReplyNotice(`${lost} Background work in this room is still running.`),
    ).toBe("with-job");
    expect(lostReplyAdvice("clean")).toContain("safe");
    expect(lostReplyAdvice("after-write")).toContain("check the file");
    expect(lostReplyAdvice("with-job")).toContain("Jobs list");

    expect(patchStreamFences("```typescript\nconst answer = 42;")).toBe(
      "```typescript\nconst answer = 42;\n```");
    expect(patchStreamFences("```typescript\nconst answer = 42;\n```")).toBe(
      "```typescript\nconst answer = 42;\n```");
    expect(patchStreamFences("A reply without code")).toBe("A reply without code");
  });
});

describe("workspace handwritten markup", () => {
  it("uses the hand only for short, readable notes", () => {
    expect(isHandwritten("A quick note for the room")).toBe(true);
    expect(isHandwritten("")).toBe(false);
    expect(isHandwritten("x".repeat(221))).toBe(false);
    expect(isHandwritten("a\nb\nc\nd\ne")).toBe(false);
    expect(isHandwritten("# Heading")).toBe(false);
    expect(isHandwritten("See https://example.test")).toBe(false);
    expect(isHandwritten("Open ./src/main.ts")).toBe(false);
    expect(isHandwritten("Read `notes.pdf`")).toBe(false);
    expect(isHandwritten("שלום")).toBe(false);
    expect(speakerName("assistant")).toBe("Assistant");
    expect(speakerName("user")).toBe("You");
  });

  it("preserves the reply exactly while printing copy-sensitive hand tokens", () => {
    const note = 'Use "@file," then notes.pdf; #command /skill *agent google.com.';
    const tokens = handTokens(note);

    expect(tokens.map((token) => token.text).join("")).toBe(note);
    expect(tokens.filter((token) => token.mono).map((token) => token.text)).toEqual([
      "@file",
      "notes.pdf",
      "#command",
      "/skill",
      "*agent",
      "google.com",
    ]);
    expect(handTokens("42.5 e.g. ordinary").some((token) => token.mono)).toBe(false);
    expect(handTokens("")).toEqual([]);
  });
});
