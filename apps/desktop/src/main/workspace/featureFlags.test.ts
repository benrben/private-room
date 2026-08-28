import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_HARNESS_FLAGS,
  workspaceHarnessCapabilities,
  workspaceHarnessFlag,
} from "./featureFlags.js";

const ENV_KEYS = WORKSPACE_HARNESS_FLAGS.map(
  (name) => `ARCELLE_${name.toUpperCase()}`,
);
const originalEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnvironment.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnvironment.clear();
});

describe("workspace harness feature flags", () => {
  it("enables the GA surface when no override is present", () => {
    expect(workspaceHarnessCapabilities()).toEqual({
      workspace_rooms_v2: true,
      workspace_conversion: true,
      sealed_export_v2: true,
      unified_harness: true,
      codex_app_server: true,
      claude_agent_sdk: true,
      deep_agent_harness: true,
      cloud_redacted_mirror: true,
    });
  });

  it.each(["1", "true"])("accepts %s as an enabled override", (value) => {
    process.env.ARCELLE_UNIFIED_HARNESS = value;
    expect(workspaceHarnessFlag("unified_harness")).toBe(true);
  });

  it.each(["0", "false"])("accepts %s as a disabled override", (value) => {
    process.env.ARCELLE_WORKSPACE_ROOMS_V2 = value;
    expect(workspaceHarnessFlag("workspace_rooms_v2")).toBe(false);
  });

  it("falls back to each flag's default for an invalid override", () => {
    process.env.ARCELLE_WORKSPACE_ROOMS_V2 = "yes";
    process.env.ARCELLE_UNIFIED_HARNESS = "TRUE";

    expect(workspaceHarnessFlag("workspace_rooms_v2")).toBe(true);
    expect(workspaceHarnessFlag("unified_harness")).toBe(true);
  });

  it("does not change environment overrides while reading them", () => {
    process.env.ARCELLE_CLAUDE_AGENT_SDK = "1";
    process.env.ARCELLE_CODEX_APP_SERVER = "invalid";

    workspaceHarnessCapabilities();

    expect(process.env.ARCELLE_CLAUDE_AGENT_SDK).toBe("1");
    expect(process.env.ARCELLE_CODEX_APP_SERVER).toBe("invalid");
  });
});
