import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => ({
  existsSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: probes.existsSync }));
vi.mock("node:child_process", () => ({ spawn: probes.spawn, spawnSync: probes.spawnSync }));

import {
  parseScriptManifest,
  resetBinCachesForTests,
  resolveInterpreter,
  setCachedPathPrefix,
} from "./scriptRun.js";

beforeEach(() => {
  probes.existsSync.mockReset().mockReturnValue(false);
  probes.spawn.mockReset();
  probes.spawnSync.mockReset().mockReturnValue({ status: 1, stdout: "" });
  setCachedPathPrefix("");
  resetBinCachesForTests();
});

afterEach(() => {
  resetBinCachesForTests();
  vi.restoreAllMocks();
});

describe("resolveInterpreter missing-uv diagnostics with fabricated binary probes", () => {
  it("routes every policy choice to an in-memory runner without executing a script", () => {
    setCachedPathPrefix("/fake-runtime");
    probes.existsSync.mockImplementation((candidate: string) => candidate === "/fake-runtime/uv");
    const dependencyPython = parseScriptManifest(
      "analysis.py",
      '# dependencies = ["pandas", "yfinance"]\nprint("fake")\n',
    );

    expect(resolveInterpreter(dependencyPython)).toEqual({
      program: "/fake-runtime/uv",
      argvPrefix: ["run", "--no-project", "--with", "pandas", "--with", "yfinance"],
    });

    resetBinCachesForTests();
    setCachedPathPrefix("");
    probes.existsSync.mockImplementation((candidate: string) => candidate === "/usr/bin/python3");
    const plainPython = parseScriptManifest("plain.py", 'print("fake")\n');

    expect(resolveInterpreter(plainPython)).toEqual({ program: "/usr/bin/python3", argvPrefix: [] });

    resetBinCachesForTests();
    setCachedPathPrefix("/fake-runtime");
    probes.existsSync.mockImplementation((candidate: string) => candidate === "/fake-runtime/node");
    const plainJavaScript = parseScriptManifest("tool.js", 'console.log("fake");\n');

    expect(resolveInterpreter(plainJavaScript)).toEqual({ program: "/fake-runtime/node", argvPrefix: [] });
    expect(probes.spawn).not.toHaveBeenCalled();
  });

  it("names every declared Python dependency when the fake probes find no uv", () => {
    const manifest = parseScriptManifest(
      "analysis.py",
      '# dependencies = ["pandas", "yfinance"]\nprint("fake")\n',
    );

    expect(() => resolveInterpreter(manifest)).toThrow(
      "This script needs pandas, yfinance. Install uv (`brew install uv`) to run scripts with dependencies.",
    );
    expect(probes.existsSync).toHaveBeenCalled();
    expect(probes.spawnSync).toHaveBeenCalled();
    expect(probes.spawn).not.toHaveBeenCalled();
  });

  it("keeps the original actionable policy errors when the missing-uv condition is false", () => {
    const noDepsPython = parseScriptManifest("plain.py", "print('fake')\n");
    const dependencyJavaScript = parseScriptManifest("analysis.js", '// dependencies = ["left-pad"]\n');

    expect(() => resolveInterpreter(noDepsPython)).toThrow(
      "No Python interpreter was found. Install Python 3, or uv (`brew install uv`), to run this script.",
    );
    resetBinCachesForTests();
    expect(() => resolveInterpreter(dependencyJavaScript)).toThrow(
      "JavaScript scripts with dependencies aren't supported yet",
    );
  });
});
