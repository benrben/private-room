import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  createWriteStream: vi.fn(),
  digests: [] as string[],
  existsSync: vi.fn(),
  get: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  default: {
    createHash: () => ({
      update: vi.fn(),
      digest: () => fake.digests.shift() ?? "missing",
    }),
  },
}));
vi.mock("node:https", () => ({ default: { get: fake.get } }));
vi.mock("node:fs", () => ({
  default: {
    createReadStream: () => ({
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "data") listener(Buffer.from("fabricated"));
        if (event === "end") listener();
        return this;
      },
    }),
    createWriteStream: fake.createWriteStream,
    existsSync: fake.existsSync,
    promises: { mkdir: fake.mkdir, rm: fake.rm, rename: fake.rename },
  },
}));

import {
  installOfficeArtifacts,
  OFFICE_ARTIFACTS,
  receiveOfficeDownload,
  verifyOfficeArtifacts,
} from "./officeConvert.js";

beforeEach(() => {
  vi.clearAllMocks();
  fake.digests.splice(0);
});

describe("default office filesystem adapters", () => {
  it("accepts a complete artifact set whose hashes all match", async () => {
    fake.existsSync.mockReturnValue(true);
    fake.digests.push(...OFFICE_ARTIFACTS.map((artifact) => artifact.sha256));

    await expect(verifyOfficeArtifacts("/fabricated/artifacts")).resolves.toBe(true);
    expect(fake.existsSync).toHaveBeenCalledTimes(OFFICE_ARTIFACTS.length);
  });

  it("creates the directory and removes a partial before preserving a download failure", async () => {
    fake.existsSync.mockReturnValue(false);
    const response = { statusCode: 503, headers: {}, resume: vi.fn() };
    const request = { on: vi.fn() };
    fake.get.mockImplementation((_url, _options, listener) => {
      listener(response);
      return request;
    });

    await expect(installOfficeArtifacts("/fabricated/artifacts")).rejects.toThrow("HTTP 503");

    expect(fake.mkdir).toHaveBeenCalledWith("/fabricated/artifacts", {
      recursive: true,
      mode: 0o700,
    });
    expect(fake.rm).toHaveBeenCalledWith(
      "/fabricated/artifacts/soffice.js.partial",
      { force: true },
    );
  });

  it("opens a private output stream for a successful response", () => {
    const events = new Map<string, () => void>();
    const output = {
      on: vi.fn((event: string, listener: () => void) => events.set(event, listener)),
      close: vi.fn((done: () => void) => done()),
    };
    fake.createWriteStream.mockReturnValue(output);
    const response = {
      statusCode: 200,
      headers: {},
      pipe: vi.fn(),
      on: vi.fn(),
    };
    const resolve = vi.fn();

    receiveOfficeDownload(
      response as never,
      "https://example.test/soffice.js",
      "/fabricated/soffice.js.partial",
      0,
      resolve,
      vi.fn(),
    );
    events.get("finish")!();

    expect(fake.createWriteStream).toHaveBeenCalledWith(
      "/fabricated/soffice.js.partial",
      { mode: 0o600 },
    );
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("completes every default download before publishing the verified artifacts", async () => {
    fake.existsSync.mockReturnValue(false);
    fake.digests.push(...OFFICE_ARTIFACTS.map((artifact) => artifact.sha256));
    fake.createWriteStream.mockImplementation(() => {
      const events = new Map<string, () => void>();
      return {
        on: vi.fn((event: string, listener: () => void) => {
          events.set(event, listener);
          return undefined;
        }),
        close: vi.fn((done: () => void) => done()),
        finish: () => events.get("finish")?.(),
      };
    });
    fake.get.mockImplementation((_url, _options, listener) => {
      const response = {
        statusCode: 200,
        headers: {},
        on: vi.fn(),
        pipe: vi.fn((output: { finish(): void }) => queueMicrotask(() => output.finish())),
      };
      listener(response);
      return { on: vi.fn() };
    });

    await expect(installOfficeArtifacts("/fabricated/artifacts")).resolves.toBeUndefined();

    expect(fake.get).toHaveBeenCalledTimes(OFFICE_ARTIFACTS.length);
    expect(fake.rename).toHaveBeenCalledTimes(OFFICE_ARTIFACTS.length);
    expect(fake.rename).toHaveBeenLastCalledWith(
      "/fabricated/artifacts/soffice.wasm.partial",
      "/fabricated/artifacts/soffice.wasm",
    );
  });
});
