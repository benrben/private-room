import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(),
  openSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeSync: vi.fn(),
}));
vi.mock("undici", () => ({ Agent: class FakeAgent {} }));

import { parsePortLine } from "./sidecar.js";

describe("parsePortLine", () => {
  it("accepts trimmed handshake lines at both valid port boundaries", () => {
    expect(parsePortLine("  SIDECAR_PORT=0\t")).toBe(0);
    expect(parsePortLine("SIDECAR_PORT=65535")).toBe(65535);
  });

  it("rejects text that is not a decimal sidecar handshake", () => {
    expect(parsePortLine("sidecar listening on 127.0.0.1:43123")).toBeNull();
    expect(parsePortLine("SIDECAR_PORT=43123.5")).toBeNull();
    expect(parsePortLine("SIDECAR_PORT=+43123")).toBeNull();
    expect(parsePortLine("SIDECAR_PORT=")).toBeNull();
  });

  it("rejects decimal values outside the TCP port range and values too large for a number", () => {
    expect(parsePortLine("SIDECAR_PORT=65536")).toBeNull();
    expect(parsePortLine(`SIDECAR_PORT=${"9".repeat(400)}`)).toBeNull();
  });
});
