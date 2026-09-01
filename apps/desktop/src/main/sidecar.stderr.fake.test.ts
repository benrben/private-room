import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(),
  openSync: vi.fn(),
  randomUUID: vi.fn(),
  renameSync: vi.fn(),
  spawn: vi.fn(),
  writeSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: fakes.spawn }));
vi.mock("node:crypto", () => ({ randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => ({
  closeSync: fakes.closeSync,
  existsSync: fakes.existsSync,
  openSync: fakes.openSync,
  renameSync: fakes.renameSync,
  unlinkSync: vi.fn(),
  writeSync: fakes.writeSync,
}));
vi.mock("node:os", () => ({ hostname: vi.fn(), tmpdir: () => "/fake/tmp" }));
vi.mock("undici", () => ({ Agent: class FakeAgent {} }));
vi.mock("./turn.js", () => ({ TurnId: class FakeTurnId {} }));

import { spawnAndWait, STDERR_LOG_BUDGET } from "./sidecar.js";

async function driveFakeChildStderr(lines: readonly string[]): Promise<void> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { stdout, stderr, pid: 321 });
  fakes.spawn.mockReturnValueOnce(child);

  const start = spawnAndWait(25);
  queueMicrotask(() => {
    for (const line of lines) stderr.write(`${line}\n`);
    stderr.end();
    stdout.end();
  });

  await expect(start).rejects.toThrow(/printed no SIDECAR_PORT line/);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.existsSync.mockReturnValue(true);
  fakes.openSync.mockReturnValue(41);
  fakes.randomUUID.mockReturnValue("fake-token");
  fakes.writeSync.mockReturnValue(1);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sidecar stderr mirroring", () => {
  it("mirrors a fabricated child diagnostic to stderr and the fake log before closing it", async () => {
    await driveFakeChildStderr(["import warning"]);

    expect(process.stderr.write).toHaveBeenCalledWith("[sidecar] import warning\n");
    expect(fakes.writeSync).toHaveBeenCalledWith(41, "import warning\n");
    expect(fakes.closeSync).toHaveBeenCalledWith(41);
  });

  it("keeps draining a fabricated diagnostic stream when the fake log cannot open", async () => {
    fakes.openSync.mockImplementation(() => {
      throw new Error("fake log unavailable");
    });

    await driveFakeChildStderr(["still visible"]);

    expect(process.stderr.write).toHaveBeenCalledWith("[sidecar] still visible\n");
    expect(fakes.writeSync).not.toHaveBeenCalled();
    expect(fakes.closeSync).not.toHaveBeenCalled();
  });

  it("keeps draining and closes the fake log after a fake write failure", async () => {
    fakes.writeSync.mockImplementation(() => {
      throw new Error("fake log write failed");
    });

    await driveFakeChildStderr(["diagnostic after disk pressure"]);

    expect(process.stderr.write).toHaveBeenCalledWith("[sidecar] diagnostic after disk pressure\n");
    expect(fakes.closeSync).toHaveBeenCalledWith(41);
  });

  it("finishes startup cleanup when closing the fabricated stderr log fails", async () => {
    fakes.closeSync.mockImplementation(() => {
      throw new Error("fabricated already-closed descriptor");
    });

    await driveFakeChildStderr(["close failure is harmless"]);

    expect(fakes.closeSync).toHaveBeenCalledWith(41);
  });

  it("continues cleanup when the fabricated budget notice cannot be written", async () => {
    const crossingLine = "y".repeat(STDERR_LOG_BUDGET);
    fakes.writeSync.mockImplementation((_fd: number, text: string) => {
      if (text.startsWith("[arcelle] log budget")) throw new Error("fabricated notice write failure");
      return text.length;
    });

    await driveFakeChildStderr([crossingLine]);

    expect(fakes.writeSync).toHaveBeenCalledWith(41, "[arcelle] log budget reached — further output dropped\n");
    expect(fakes.closeSync).toHaveBeenCalledWith(41);
  });

  it("writes the crossing line and one budget notice, then only drains later fabricated diagnostics", async () => {
    const crossingLine = "x".repeat(STDERR_LOG_BUDGET);

    await driveFakeChildStderr([crossingLine, "discarded from fake log"]);

    expect(fakes.writeSync).toHaveBeenNthCalledWith(1, 41, `${crossingLine}\n`);
    expect(fakes.writeSync).toHaveBeenNthCalledWith(2, 41, "[arcelle] log budget reached — further output dropped\n");
    expect(fakes.writeSync).toHaveBeenCalledTimes(2);
    expect(process.stderr.write).toHaveBeenCalledWith("[sidecar] discarded from fake log\n");
  });
});
