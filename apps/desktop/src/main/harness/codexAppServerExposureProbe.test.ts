import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "./codexAppServer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ProbeBehavior = "initialize" | "protocol-error" | "hang";

interface FakeProbe {
  child: ChildProcessWithoutNullStreams;
  writes: string[];
  kills: NodeJS.Signals[];
}

function fakeProbe(behavior: ProbeBehavior): FakeProbe {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const kills: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 987_654,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      kills.push(signal);
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  stdin.on("data", (chunk) => {
    writes.push(chunk.toString());
    if (behavior === "initialize") {
      stdout.write(`${JSON.stringify({ id: "arcelle-capability", result: { userAgent: "fake" } })}\n`);
    }
    if (behavior === "protocol-error") {
      stdout.write(`${JSON.stringify({ id: "arcelle-capability", error: { message: "fake" } })}\n`);
    }
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, writes, kills };
}

async function fixture(): Promise<{ runtimePath: string; sourceHome: string; workspacePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-probe-"));
  roots.push(root);
  const runtimePath = path.join(root, "runtime");
  const sourceHome = path.join(root, "source-home");
  const workspacePath = path.join(root, "workspace");
  await Promise.all([mkdir(runtimePath), mkdir(sourceHome), mkdir(workspacePath)]);
  return { runtimePath, sourceHome, workspacePath };
}

function fakeRuntime(probe: FakeProbe, sourceHome: string, timeoutMs = 20): CodexAppServerRuntime {
  return new CodexAppServerRuntime("not-used", (() => probe.child) as never, timeoutMs, sourceHome);
}

describe("Codex app-server exposure probe", () => {
  it("accepts only an initialized fake app-server and sends its initialization request", async () => {
    const paths = await fixture();
    const probe = fakeProbe("initialize");

    await expect(fakeRuntime(probe, paths.sourceHome).verifyExposure(paths.workspacePath, paths.runtimePath, false)).resolves.toBe(true);

    expect(probe.writes).toHaveLength(1);
    expect(JSON.parse(probe.writes[0])).toMatchObject({ id: "arcelle-capability", method: "initialize" });
    expect(probe.kills).toContain("SIGTERM");
    expect(probe.child.stdin.destroyed).toBe(true);
    expect(probe.child.stdout.destroyed).toBe(true);
    expect(probe.child.stderr.destroyed).toBe(true);
  });

  it("fails closed for a fake initialize error", async () => {
    const paths = await fixture();
    const probe = fakeProbe("protocol-error");

    await expect(fakeRuntime(probe, paths.sourceHome).verifyExposure(paths.workspacePath, paths.runtimePath, false)).resolves.toBe(false);

    expect(probe.kills).toContain("SIGTERM");
  });

  it("fails closed when a fake app-server does not answer before the probe timeout", async () => {
    const paths = await fixture();
    const probe = fakeProbe("hang");

    await expect(fakeRuntime(probe, paths.sourceHome, 5).verifyExposure(paths.workspacePath, paths.runtimePath, false)).resolves.toBe(false);

    expect(probe.kills).toContain("SIGTERM");
  });
});
