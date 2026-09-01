import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("node:https", () => ({ default: { get: fakes.get } }));
vi.mock("node:fs", () => ({
  default: {
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    existsSync: vi.fn(),
    promises: { mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn() },
  },
}));

import { receiveOfficeDownload } from "./officeConvert.js";

type FakeResponse = {
  headers: { location?: string };
  on: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  statusCode: number;
};

function response(statusCode: number, location?: string): FakeResponse {
  return {
    headers: location === undefined ? {} : { location },
    on: vi.fn(),
    pipe: vi.fn(),
    resume: vi.fn(),
    statusCode,
  };
}

function receive(responseValue: FakeResponse, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    receiveOfficeDownload(
      responseValue as never,
      "https://downloads.invalid/releases/manifest.json",
      "/fabricated/soffice.data.partial",
      redirects,
      resolve,
      reject,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("downloadRaw behind the office-download redirect seam", () => {
  it("follows a fabricated redirect and preserves the final HTTP failure", async () => {
    const redirect = response(302, "../soffice.data");
    const failedDownload = response(503);
    const request = { on: vi.fn() };
    fakes.get.mockImplementation((_url: string, _options: unknown, onResponse: (value: FakeResponse) => void) => {
      onResponse(failedDownload);
      return request;
    });

    await expect(receive(redirect)).rejects.toThrow("Office-converter download returned HTTP 503.");

    expect(redirect.resume).toHaveBeenCalledOnce();
    expect(fakes.get).toHaveBeenCalledWith(
      "https://downloads.invalid/soffice.data",
      { headers: { "Accept-Encoding": "br" } },
      expect.any(Function),
    );
    expect(request.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(failedDownload.resume).toHaveBeenCalledOnce();
  });

  it("refuses the seventh fabricated redirect before creating a request", async () => {
    const redirect = response(302, "/soffice.data");

    await expect(receive(redirect, 5)).rejects.toThrow("Too many office-converter download redirects.");

    expect(fakes.get).not.toHaveBeenCalled();
  });

  it("preserves a fabricated HTTPS request error without creating an output stream", async () => {
    const redirect = response(302, "/soffice.data");
    const failure = new Error("fabricated HTTPS failure");
    const request = {
      on: vi.fn((event: string, listener: (error: Error) => void) => {
        if (event === "error") listener(failure);
        return request;
      }),
    };
    fakes.get.mockReturnValue(request);

    await expect(receive(redirect)).rejects.toThrow(failure);

    expect(fakes.get).toHaveBeenCalledOnce();
    expect(request.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
