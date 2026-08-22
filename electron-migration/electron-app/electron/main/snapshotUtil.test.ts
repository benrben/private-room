import { describe, expect, it, vi } from "vitest";
import {
  captureWebviewPng,
  NON_MACOS_SNAPSHOT_ERROR,
  type CapturableWebContents,
} from "./snapshotUtil.js";

/** A `CapturableWebContents` whose `capturePage` resolves with `png`, or
 *  never resolves at all (to exercise the timeout branch), or rejects. */
function fakeWebContents(opts: {
  png?: Buffer;
  destroyed?: boolean;
  hang?: boolean;
  rejectWith?: string;
}): CapturableWebContents {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    capturePage: () => {
      if (opts.hang) {
        return new Promise(() => {
          /* never settles */
        });
      }
      if (opts.rejectWith !== undefined) {
        return Promise.reject(new Error(opts.rejectWith));
      }
      return Promise.resolve({ toPNG: () => opts.png ?? Buffer.from([1, 2, 3]) });
    },
  };
}

describe("captureWebviewPng", () => {
  it("returns the captured PNG bytes on the happy path", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const wc = fakeWebContents({ png });
    await expect(captureWebviewPng(wc, true)).resolves.toEqual(png);
  });

  it("refuses on a non-macOS platform with the exact Rust stub message", async () => {
    const wc = fakeWebContents({});
    await expect(captureWebviewPng(wc, false)).rejects.toThrow(NON_MACOS_SNAPSHOT_ERROR);
  });

  it("refuses when the webview has already been destroyed", async () => {
    const wc = fakeWebContents({ destroyed: true });
    await expect(captureWebviewPng(wc, true)).rejects.toThrow(/destroyed/);
  });

  it("wraps a capturePage rejection as a labeled snapshot failure", async () => {
    const wc = fakeWebContents({ rejectWith: "no image and no error" });
    await expect(captureWebviewPng(wc, true)).rejects.toThrow(
      "webview snapshot failed: no image and no error"
    );
  });

  it("times out rather than hanging forever on an unresponsive webview", async () => {
    const wc = fakeWebContents({ hang: true });
    await expect(captureWebviewPng(wc, true, 20)).rejects.toThrow(
      "timed out waiting for the webview snapshot (0.02s)"
    );
  });

  it("does not mistake a slow-but-real capture for a timeout when it wins the race", async () => {
    const wc = fakeWebContents({ png: Buffer.from([9]) });
    // Generous timeout relative to the fake's instant resolution — this just
    // proves the winning branch is the capture, not the timer.
    await expect(captureWebviewPng(wc, true, 5000)).resolves.toEqual(Buffer.from([9]));
  });

  it("labels a webview failure even when the webview's OWN message mentions a timeout", async () => {
    // In the Rust source the two failures come from structurally different
    // places and can never be confused: a completion-handler failure is
    // always `format!("webview snapshot failed: {msg}")`, built inside the
    // block from WebKit's own NSError, while the timeout is a caller-side
    // `rx.recv_timeout` branch that can only fire when NOTHING came back at
    // all. Deciding between them here by sniffing the rejection's message
    // TEXT let a real, answered-with-an-error capture masquerade as our own
    // silence — the one report that tells an operator "the webview never
    // responded" when in fact it responded with the reason.
    const wc = fakeWebContents({ rejectWith: "timed out waiting for the webview snapshot (30s)" });
    await expect(captureWebviewPng(wc, true)).rejects.toThrow(
      "webview snapshot failed: timed out waiting for the webview snapshot (30s)"
    );
  });

  it("labels a non-Error rejection value too", async () => {
    const wc: CapturableWebContents = {
      isDestroyed: () => false,
      // eslint-disable-next-line prefer-promise-reject-errors
      capturePage: () => Promise.reject("nil image, nil error") as never,
    };
    await expect(captureWebviewPng(wc, true)).rejects.toThrow(
      "webview snapshot failed: nil image, nil error"
    );
  });

  it("labels a synchronous throw from capturePage rather than letting it escape raw", async () => {
    const wc: CapturableWebContents = {
      isDestroyed: () => false,
      capturePage: () => {
        throw new Error("could not reach the platform webview");
      },
    };
    await expect(captureWebviewPng(wc, true)).rejects.toThrow(
      "webview snapshot failed: could not reach the platform webview"
    );
  });

  it("labels a toPNG() failure — the Rust PNG-encoding branch is a failure, not a hang", async () => {
    const wc: CapturableWebContents = {
      isDestroyed: () => false,
      capturePage: () =>
        Promise.resolve({
          toPNG: () => {
            throw new Error("PNG encoding of the snapshot failed");
          },
        }),
    };
    await expect(captureWebviewPng(wc, true)).rejects.toThrow(
      "webview snapshot failed: PNG encoding of the snapshot failed"
    );
  });

  it("clears its timer once a capture wins the race", async () => {
    // The Rust source drops its receiver the moment `recv_timeout` returns;
    // an Electron port that forgot `clearTimeout` would leave a 5s timer —
    // and the closure it holds — pending after EVERY screenshot. `unref()`
    // hides that from `process.getActiveResourcesInfo()`, so the count of
    // pending fake timers is what actually observes it. (Checked by
    // mutation: with `clearTimeout` removed this fails; the
    // getActiveResourcesInfo version of it did not.)
    vi.useFakeTimers();
    try {
      const wc = fakeWebContents({ png: Buffer.from([1]) });
      await expect(captureWebviewPng(wc, true, 60_000)).resolves.toEqual(Buffer.from([1]));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks the platform before ever touching the (possibly destroyed) webview", async () => {
    // A destroyed AND non-macOS webview must fail with the platform message,
    // matching the Rust source's cfg-gated function bodies where the
    // non-macOS build never reaches the main-thread/null-pointer checks at
    // all.
    const wc = fakeWebContents({ destroyed: true });
    await expect(captureWebviewPng(wc, false)).rejects.toThrow(NON_MACOS_SNAPSHOT_ERROR);
  });
});
