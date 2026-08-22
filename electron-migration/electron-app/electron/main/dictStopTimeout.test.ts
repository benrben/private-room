import { describe, expect, it, vi } from "vitest";
import {
  DICT_STOP_BASE_SECS,
  DICT_STOP_PER_AUDIO_SEC,
  DICT_STOP_TIMEOUT_CHANNEL,
  dictStopTimeoutMs,
  dictStopTimeoutSecs,
  registerDictIpc,
} from "./dictStopTimeout.js";

// Constants pinned against stt_cmds.rs:574,577 — a drift here is a drift
// against the shipped Rust app, not just this port.
describe("constants match stt_cmds.rs", () => {
  it("base is 120s (stt_cmds.rs:574)", () => {
    expect(DICT_STOP_BASE_SECS).toBe(120);
  });
  it("per-audio-second grace is 2 (stt_cmds.rs:577)", () => {
    expect(DICT_STOP_PER_AUDIO_SEC).toBe(2);
  });
});

describe("dictStopTimeoutSecs", () => {
  it("0s captured -> the flat 120s base", () => {
    expect(dictStopTimeoutSecs(0)).toBe(120);
  });

  it("30s captured -> 120 + 30*2 = 180s", () => {
    expect(dictStopTimeoutSecs(30)).toBe(180);
  });

  it("60s captured -> 120 + 60*2 = 240s", () => {
    expect(dictStopTimeoutSecs(60)).toBe(240);
  });

  it("matches the exact Rust formula for an arbitrary value (300s -> 720s)", () => {
    expect(dictStopTimeoutSecs(300)).toBe(DICT_STOP_BASE_SECS + 300 * DICT_STOP_PER_AUDIO_SEC);
    expect(dictStopTimeoutSecs(300)).toBe(720);
  });

  it("handles fractional seconds (Duration::from_millis is exact to the ms)", () => {
    // 1500ms captured == 1.5s; Rust's Duration multiply/add is exact here too.
    expect(dictStopTimeoutSecs(1.5)).toBe(123);
  });

  it("boundary: negative captured clamps to 0 (Rust's Duration cannot go negative)", () => {
    expect(dictStopTimeoutSecs(-5)).toBe(120);
  });

  it("boundary: non-finite captured clamps to 0", () => {
    expect(dictStopTimeoutSecs(NaN)).toBe(120);
    expect(dictStopTimeoutSecs(Infinity)).toBe(120);
  });
});

describe("dictStopTimeoutMs", () => {
  it("is dictStopTimeoutSecs * 1000", () => {
    expect(dictStopTimeoutMs(0)).toBe(120_000);
    expect(dictStopTimeoutMs(30)).toBe(180_000);
  });
});

describe("registerDictIpc", () => {
  it("registers a handler on DICT_STOP_TIMEOUT_CHANNEL that returns the ms wait", () => {
    const handle = vi.fn();
    registerDictIpc({ handle });

    expect(handle).toHaveBeenCalledTimes(1);
    const [channel, listener] = handle.mock.calls[0] as [string, (...args: unknown[]) => unknown];
    expect(channel).toBe(DICT_STOP_TIMEOUT_CHANNEL);
    expect(channel).toBe("dict-stop-timeout");

    // Simulate an ipcMain.handle invocation: (event, ...args).
    const fakeEvent = {} as never;
    expect(listener(fakeEvent, 30)).toBe(180_000);
    expect(listener(fakeEvent, 0)).toBe(120_000);
  });
});
