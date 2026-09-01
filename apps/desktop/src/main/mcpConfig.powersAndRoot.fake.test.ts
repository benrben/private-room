import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: fakes.existsSync,
  mkdirSync: fakes.mkdirSync,
  readFileSync: fakes.readFileSync,
  writeFileSync: fakes.writeFileSync,
}));
vi.mock("./db-host/settings.js", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock("./mcpOauth.js", () => ({ clearTokens: vi.fn(), loadTokens: vi.fn() }));
vi.mock("./mcpClient.js", () => ({ parseMcpConfig: vi.fn() }));

import { agentMcpRoot, writeMcpConnectorPower } from "./mcpConfig.js";

const userDataDir = "/fabricated/app-data";
const powerFile = "/fabricated/app-data/mcp_connector_powers.json";

describe("writeMcpConnectorPower with fabricated persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fakes.existsSync.mockReturnValue(true);
  });

  it("merges one fabricated override and writes its canonical sorted wire JSON", () => {
    fakes.readFileSync.mockReturnValue('{"linear":{"auto_approve":true}}');

    const next = writeMcpConnectorPower(userDataDir, "github", "outbound_unmask", true);

    expect(next).toBe('{"github":{"outbound_unmask":true},"linear":{"auto_approve":true}}');
    expect(fakes.existsSync).toHaveBeenCalledWith(powerFile);
    expect(fakes.readFileSync).toHaveBeenCalledWith(powerFile, "utf8");
    expect(fakes.mkdirSync).toHaveBeenCalledWith(userDataDir, { recursive: true });
    expect(fakes.writeFileSync).toHaveBeenCalledWith(powerFile, next);
  });

  it("uses an empty fabricated store when the powers file is absent", () => {
    fakes.existsSync.mockReturnValue(false);

    const next = writeMcpConnectorPower(userDataDir, "linear", "auto_approve", false);

    expect(next).toBe('{"linear":{"auto_approve":false}}');
    expect(fakes.readFileSync).not.toHaveBeenCalled();
    expect(fakes.writeFileSync).toHaveBeenCalledWith(powerFile, next);
  });

  it("clears the final fabricated override instead of retaining an empty connector record", () => {
    fakes.readFileSync.mockReturnValue('{"linear":{"auto_approve":true}}');

    const next = writeMcpConnectorPower(userDataDir, "linear", "auto_approve", null);

    expect(next).toBe("{}");
    expect(fakes.writeFileSync).toHaveBeenCalledWith(powerFile, "{}");
  });

  it("surfaces a fabricated persistence failure rather than claiming the power was saved", () => {
    fakes.readFileSync.mockReturnValue("{}");
    fakes.writeFileSync.mockImplementation(() => { throw new Error("fabricated disk refusal"); });

    expect(() => writeMcpConnectorPower(userDataDir, "linear", "auto_approve", true))
      .toThrow("fabricated disk refusal");
  });
});

describe("agentMcpRoot", () => {
  it("adds an empty mcpServers object to a fabricated root that omits it", () => {
    expect(agentMcpRoot('{"schemaVersion":1}')).toEqual({ schemaVersion: 1, mcpServers: {} });
  });

  it("keeps a fabricated object-valued mcpServers map intact", () => {
    expect(agentMcpRoot('{"mcpServers":{"github":{"type":"http"}}}')).toEqual({
      mcpServers: { github: { type: "http" } },
    });
  });

  it("refuses a fabricated malformed JSON config", () => {
    expect(() => agentMcpRoot("not json")).toThrow("the room's connector config isn't valid JSON");
  });

  it("refuses a fabricated top-level array", () => {
    expect(() => agentMcpRoot("[]")).toThrow("the room's connector config must be a JSON object");
  });

  it("refuses a fabricated non-object mcpServers value", () => {
    expect(() => agentMcpRoot('{"mcpServers":[]}')).toThrow("the room's mcpServers value must be an object");
  });
});
