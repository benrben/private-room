import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("./platform", () => ({ invoke: mocks.invoke, listen: mocks.listen }));

import { api, askEvent } from "./api";

describe("askEvent", () => {
  it("keeps owned payload values paired with their producing turn", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementationOnce((_name, callback) => {
      deliver = callback;
      return Promise.resolve(() => undefined);
    });
    const received = vi.fn();
    await askEvent<string>("ask-report", received);
    deliver?.({ payload: { v: "complete", runId: "run-1", chatId: "chat-2" } });
    expect(received).toHaveBeenCalledWith("complete", { runId: "run-1", chatId: "chat-2" });
  });

  it("marks unexpected legacy payloads as unowned instead of inventing a turn", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementationOnce((_name, callback) => {
      deliver = callback;
      return Promise.resolve(() => undefined);
    });
    const received = vi.fn();
    await askEvent<{ answer: number }>("ask-answer", received);
    deliver?.({ payload: { answer: 42 } });
    expect(received).toHaveBeenCalledWith({ answer: 42 }, { runId: null, chatId: null });
  });
});

describe("api.onAskStep", () => {
  it("normalizes fabricated string and structured step events without losing the producing turn", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementationOnce((_name, callback) => {
      deliver = callback;
      return Promise.resolve(() => undefined);
    });
    const received = vi.fn();

    await api.onAskStep(received);
    expect(mocks.listen).toHaveBeenLastCalledWith("ask-step", expect.any(Function));

    deliver?.({ payload: { v: "Searching notes", runId: "run-1", chatId: "chat-1" } });
    deliver?.({ payload: { v: { label: "Read file", node: "research" }, runId: "run-2", chatId: "chat-2" } });
    deliver?.({ payload: { v: { label: "Answer" }, runId: "run-3", chatId: "chat-3" } });

    expect(received).toHaveBeenNthCalledWith(
      1,
      { label: "Searching notes", node: null },
      { runId: "run-1", chatId: "chat-1" },
    );
    expect(received).toHaveBeenNthCalledWith(
      2,
      { label: "Read file", node: "research" },
      { runId: "run-2", chatId: "chat-2" },
    );
    expect(received).toHaveBeenNthCalledWith(
      3,
      { label: "Answer", node: null },
      { runId: "run-3", chatId: "chat-3" },
    );
  });

  it("keeps a fabricated subscription failure observable to the caller", async () => {
    const failure = new Error("fabricated ask-step listener failure");
    mocks.listen.mockRejectedValueOnce(failure);

    await expect(api.onAskStep(vi.fn())).rejects.toBe(failure);
  });
});
