import { beforeEach, describe, expect, it, vi } from "vitest";

const composer = vi.hoisted(() => ({
  isOllamaDown: vi.fn(),
}));

vi.mock("./composer", () => ({ isOllamaDown: composer.isOllamaDown }));

import { runGuarded } from "./guard";
import type { WSState } from "./state";

function fakeState() {
  const pushToast = vi.fn();
  return { pushToast, state: { pushToast } as unknown as WSState };
}

describe("runGuarded", () => {
  beforeEach(() => {
    composer.isOllamaDown.mockReset().mockReturnValue(false);
  });

  it("brackets a fabricated successful action with its busy callbacks", async () => {
    const { state, pushToast } = fakeState();
    const steps: string[] = [];

    await runGuarded(
      state,
      async () => { steps.push("run"); },
      { begin: () => steps.push("begin"), finish: async () => { steps.push("finish"); } },
    );

    expect(steps).toEqual(["begin", "run", "finish"]);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("silently finishes an error accepted by the fabricated ignore policy", async () => {
    const { state, pushToast } = fakeState();
    const ignore = vi.fn(() => true);
    const onError = vi.fn();
    const finish = vi.fn();

    await runGuarded(state, async () => { throw new Error("stopped by user"); }, { ignore, onError, finish });

    expect(ignore).toHaveBeenCalledWith("Error: stopped by user");
    expect(onError).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("lets a fabricated specialized handler report an error before refreshing its state", async () => {
    const { state, pushToast } = fakeState();
    const handle = vi.fn(() => true);
    const onError = vi.fn();

    await runGuarded(state, async () => { throw new Error("needs approval"); }, { handle, onError });

    expect(handle).toHaveBeenCalledWith("Error: needs approval");
    expect(onError).toHaveBeenCalledWith("Error: needs approval");
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("offers the fabricated local-app remediation when the classifier reports an unavailable model", async () => {
    const { state, pushToast } = fakeState();
    const openOllamaApp = vi.fn(async () => undefined);
    composer.isOllamaDown.mockReturnValue(true);

    await runGuarded(state, async () => { throw new Error("connection refused"); }, { openOllamaApp });

    expect(composer.isOllamaDown).toHaveBeenCalledWith("Error: connection refused");
    expect(pushToast).toHaveBeenCalledWith(
      "error",
      "Ollama is not running. Start the Ollama app, then try again.",
      { label: "Open Ollama", run: openOllamaApp },
    );
  });

  it("surfaces an unhandled fabricated error as a plain toast", async () => {
    const { state, pushToast } = fakeState();

    await runGuarded(state, async () => { throw new Error("fabricated failure"); });

    expect(pushToast).toHaveBeenCalledWith("error", "Error: fabricated failure");
  });
});
