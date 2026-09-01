import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OFFICE_ARTIFACTS,
  OfficeConverter,
  installOfficeArtifacts,
  officeConvertible,
  officeDownloadRedirect,
  officePdfFilter,
  receiveOfficeDownload,
  resolveOfficeServerFile,
  setOfficeResponseHeaders,
  verifyOfficeArtifacts,
} from "./officeConvert.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

type ConverterInternals = {
  boot(): Promise<void>;
  window: {
    webContents: { executeJavaScript(script: string, userGesture: boolean): Promise<string> };
    destroy(): void;
  } | null;
  completedInWindow: number;
};

function converterWithResult(result: Promise<string>) {
  const converter = new OfficeConverter("/fake/office-artifacts");
  const internals = converter as unknown as ConverterInternals;
  const executeJavaScript = vi.fn().mockReturnValue(result);
  internals.boot = vi.fn().mockResolvedValue(undefined);
  internals.window = {
    webContents: { executeJavaScript },
    destroy: vi.fn(),
  };
  return { converter, internals, executeJavaScript };
}

function installerFakes(initialHashes: ReadonlyMap<string, string> = new Map()) {
  const hashes = new Map(initialHashes);
  const deps = {
    join: path.join,
    exists: vi.fn((filePath: string) => hashes.has(filePath)),
    mkdir: vi.fn(async () => undefined),
    remove: vi.fn(async (filePath: string) => {
      hashes.delete(filePath);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const digest = hashes.get(from);
      hashes.delete(from);
      if (digest) hashes.set(to, digest);
    }),
    sha256: vi.fn(async (filePath: string) => hashes.get(filePath) ?? "missing"),
    download: vi.fn(async (url: string, destination: string) => {
      const artifact = OFFICE_ARTIFACTS.find((item) => item.url === url);
      if (!artifact) throw new Error(`Unexpected fake artifact URL: ${url}`);
      hashes.set(destination, artifact.sha256);
    }),
  };
  return { deps, hashes };
}

function fakeOfficeRuntime(address: { port: number } | string | null = { port: 4312 }) {
  const onError = { current: undefined as ((error: Error) => void) | undefined };
  const requestHandler = {
    current: undefined as ((request: { url?: string }, response: { setHeader(): void; writeHead(): { end(): void } }) => void) | undefined,
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    webContents: { executeJavaScript: vi.fn(async () => true) },
    destroy: vi.fn(),
  };
  const server = {
    once: vi.fn((event: string, listener: (error: Error) => void) => {
      if (event === "error") onError.current = listener;
      return server;
    }),
    listen: vi.fn((_port: number, _host: string, ready: () => void) => {
      ready();
      return server;
    }),
    address: vi.fn(() => address),
    close: vi.fn(),
  };
  const BrowserWindow = vi.fn(() => window);
  const runtime = {
    loadElectron: vi.fn(async () => ({
      app: { getAppPath: () => "/fake/app" },
      BrowserWindow,
    })),
    createServer: vi.fn((handler) => {
      requestHandler.current = handler;
      return server;
    }),
  };
  return { runtime, server, window, BrowserWindow, onError, requestHandler };
}

describe("office conversion policy", () => {
  it.each([
    ["slides.ppt", "impress_pdf_Export"], ["slides.odp", "impress_pdf_Export"],
    ["table.xls", "calc_pdf_Export"], ["note.rtf", "writer_pdf_Export"],
  ])("chooses the PDF filter for %s", (name, filter) => expect(officePdfFilter(name)).toBe(filter));

  it("allows only the explicitly supported offline office inputs", () => {
    for (const name of ["a.ppt", "a.odp", "a.rtf", "a.odt", "a.doc", "a.xls"]) expect(officeConvertible(name)).toBe(true);
    for (const name of ["a.exe", "a.pages", "a.pdf"]) expect(officeConvertible(name)).toBe(false);
  });

  it("rejects absent and hash-mismatched artifact sets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-office-test-"));
    dirs.push(dir);
    expect(await verifyOfficeArtifacts(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "soffice.js"), "not the pinned build");
    expect(await verifyOfficeArtifacts(dir)).toBe(false);
  });
});

describe("office artifact installer", () => {
  const directory = "/fake/office-artifacts";

  it("leaves an already verified fabricated artifact set untouched", async () => {
    const { deps } = installerFakes(new Map(
      OFFICE_ARTIFACTS.map((artifact) => [path.join(directory, artifact.name), artifact.sha256]),
    ));

    await installOfficeArtifacts(directory, deps);

    expect(deps.mkdir).toHaveBeenCalledWith(directory);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.rename).not.toHaveBeenCalled();
  });

  it("replaces a stale fabricated artifact only after its partial digest verifies", async () => {
    const first = OFFICE_ARTIFACTS[0];
    const { deps, hashes } = installerFakes(new Map([
      [path.join(directory, first.name), "outdated-digest"],
      ...OFFICE_ARTIFACTS.slice(1).map((artifact) => [
        path.join(directory, artifact.name),
        artifact.sha256,
      ]),
    ]));

    await installOfficeArtifacts(directory, deps);

    const partial = path.join(directory, `${first.name}.partial`);
    expect(deps.download).toHaveBeenCalledOnce();
    expect(deps.download).toHaveBeenCalledWith(first.url, partial);
    expect(deps.remove).toHaveBeenCalledWith(partial);
    expect(deps.rename).toHaveBeenCalledWith(partial, path.join(directory, first.name));
    expect(hashes.get(path.join(directory, first.name))).toBe(first.sha256);
  });

  it("removes a fabricated bad partial and preserves installer failures", async () => {
    const first = OFFICE_ARTIFACTS[0];
    const { deps } = installerFakes();
    deps.download.mockResolvedValueOnce(undefined);

    await expect(installOfficeArtifacts(directory, deps)).rejects.toThrow(
      `The downloaded ${first.name} failed its integrity check.`,
    );
    const partial = path.join(directory, `${first.name}.partial`);
    expect(deps.remove).toHaveBeenNthCalledWith(1, partial);
    expect(deps.remove).toHaveBeenNthCalledWith(2, partial);
    expect(deps.rename).not.toHaveBeenCalled();

    const unavailable = installerFakes().deps;
    unavailable.mkdir.mockRejectedValueOnce(new Error("fake disk unavailable"));
    await expect(installOfficeArtifacts(directory, unavailable)).rejects.toThrow("fake disk unavailable");
    expect(unavailable.exists).not.toHaveBeenCalled();
  });
});

describe("office converter boot", () => {
  it("boots once using only fabricated Electron and private-server seams", async () => {
    const fake = fakeOfficeRuntime();
    const files = {
      fileExists: vi.fn(() => false),
      openReadStream: vi.fn(),
    };
    const converter = new OfficeConverter("/fake/artifacts", files as never, fake.runtime as never);
    const internals = converter as unknown as ConverterInternals;

    await internals.boot();
    await internals.boot();

    expect(fake.runtime.loadElectron).toHaveBeenCalledOnce();
    expect(fake.runtime.createServer).toHaveBeenCalledOnce();
    expect(fake.server.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
    expect(fake.BrowserWindow).toHaveBeenCalledWith({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    expect(fake.window.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:4312/converter.html?artifacts=http%3A%2F%2F127.0.0.1%3A4312%2Fartifacts%2F",
    );
    expect(fake.window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("window.officeReady"),
      true,
    );
    const end = vi.fn();
    const response = {
      setHeader: vi.fn(),
      writeHead: vi.fn(() => ({ end })),
    };
    fake.requestHandler.current!({ url: "/missing.js" }, response);
    expect(response.writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
  });

  it("reports fabricated bind and address failures before creating a window", async () => {
    const bindFailure = fakeOfficeRuntime();
    bindFailure.server.listen.mockImplementationOnce(() => {
      bindFailure.onError.current?.(new Error("fake bind failure"));
      return bindFailure.server;
    });
    const bindConverter = new OfficeConverter(
      "/fake/artifacts",
      undefined,
      bindFailure.runtime as never,
    ) as unknown as ConverterInternals;
    await expect(bindConverter.boot()).rejects.toThrow("fake bind failure");
    expect(bindFailure.BrowserWindow).not.toHaveBeenCalled();

    const missingAddress = fakeOfficeRuntime("unexpected socket");
    const addressConverter = new OfficeConverter(
      "/fake/artifacts",
      undefined,
      missingAddress.runtime as never,
    ) as unknown as ConverterInternals;
    await expect(addressConverter.boot()).rejects.toThrow(
      "The office converter could not bind its private server.",
    );
    expect(missingAddress.BrowserWindow).not.toHaveBeenCalled();
  });
});

describe("OfficeConverter conversion boundary", () => {
  it("refuses unsupported inputs before booting an office window", async () => {
    const converter = new OfficeConverter("/fake/office-artifacts");
    const internals = converter as unknown as ConverterInternals;
    const boot = vi.fn();
    internals.boot = boot;

    await expect(converter.convert("notes.pdf", new Uint8Array([1]))).rejects.toThrow(
      "This file type is not supported by the office converter.",
    );
    expect(boot).not.toHaveBeenCalled();
  });

  it("passes an encoded supported input to the fake window and returns its PDF", async () => {
    const pdf = Buffer.from("%PDF-fabricated");
    const { converter, internals, executeJavaScript } = converterWithResult(
      Promise.resolve(pdf.toString("base64")),
    );
    const dispose = vi.spyOn(converter, "dispose");

    await expect(converter.convert('Quarter "one".ppt', new Uint8Array([1, 2, 3]))).resolves.toEqual(pdf);
    expect(internals.boot).toHaveBeenCalledOnce();
    expect(executeJavaScript).toHaveBeenCalledWith(
      'window.convertOfficeFile("Quarter \\"one\\".ppt", "AQID")',
      true,
    );
    expect(dispose).not.toHaveBeenCalled();
    expect(internals.completedInWindow).toBe(1);
  });

  it("disposes the fake window when conversion rejects or returns a non-PDF", async () => {
    const rejected = converterWithResult(Promise.reject(new Error("fake renderer failed")));
    const rejectedDispose = vi.spyOn(rejected.converter, "dispose");
    await expect(rejected.converter.convert("letter.doc", new Uint8Array([5]))).rejects.toThrow(
      "fake renderer failed",
    );
    expect(rejectedDispose).toHaveBeenCalledOnce();

    const invalid = converterWithResult(Promise.resolve(Buffer.from("not a PDF").toString("base64")));
    const invalidDispose = vi.spyOn(invalid.converter, "dispose");
    await expect(invalid.converter.convert("letter.doc", new Uint8Array([5]))).rejects.toThrow(
      "The converter did not produce a PDF.",
    );
    expect(invalidDispose).toHaveBeenCalledOnce();
  });

  it("recycles the fake window after its tenth completed conversion", async () => {
    const { converter, internals } = converterWithResult(
      Promise.resolve(Buffer.from("%PDF-tenth").toString("base64")),
    );
    internals.completedInWindow = 9;
    const dispose = vi.spyOn(converter, "dispose");

    await expect(converter.convert("letter.doc", new Uint8Array())).resolves.toEqual(
      Buffer.from("%PDF-tenth"),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.completedInWindow).toBe(0);
  });

  it("times out a fake pending conversion and disposes its window", async () => {
    vi.useFakeTimers();
    const { converter } = converterWithResult(new Promise<string>(() => undefined));
    const dispose = vi.spyOn(converter, "dispose");
    const pending = converter.convert("letter.doc", new Uint8Array([7]));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).rejects.toThrow("Office conversion timed out after 60 seconds.");
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("office converter private-server assets", () => {
  const artifactDir = "/private/artifacts";
  const rendererRoot = "/private/renderer/office";

  it("selects pinned artifacts and refuses absent or escaping paths without reading the filesystem", () => {
    const existing = new Set([path.join(artifactDir, "soffice.data")]);
    const fileExists = (filePath: string) => existing.has(filePath);

    expect(resolveOfficeServerFile(artifactDir, rendererRoot, "/artifacts/soffice.data", fileExists)).toEqual({
      artifact: expect.objectContaining({ name: "soffice.data", brotli: true }),
      localPath: path.join(artifactDir, "soffice.data"),
    });
    expect(resolveOfficeServerFile(artifactDir, rendererRoot, "/missing.js", fileExists)).toBeNull();
    expect(resolveOfficeServerFile(artifactDir, rendererRoot, "/../private.txt", () => true)).toBeNull();
  });

  it("uses artifact encoding metadata and renderer file types for response headers", () => {
    const headers = new Map<string, string>();
    const response = { setHeader: (name: string, value: string) => headers.set(name, value) };
    const dataFile = resolveOfficeServerFile(
      artifactDir,
      rendererRoot,
      "/artifacts/soffice.data",
      () => true,
    );
    const htmlFile = resolveOfficeServerFile(artifactDir, rendererRoot, "/converter.html", () => true);
    const scriptFile = resolveOfficeServerFile(artifactDir, rendererRoot, "/converter.js", () => true);

    expect(dataFile).not.toBeNull();
    setOfficeResponseHeaders(response, dataFile!);
    expect(headers).toEqual(new Map([
      ["Content-Type", "application/octet-stream"],
      ["Content-Encoding", "br"],
    ]));

    headers.clear();
    expect(htmlFile).not.toBeNull();
    setOfficeResponseHeaders(response, htmlFile!);
    expect(headers).toEqual(new Map([["Content-Type", "text/html; charset=utf-8"]]));

    headers.clear();
    expect(scriptFile).not.toBeNull();
    setOfficeResponseHeaders(response, scriptFile!);
    expect(headers).toEqual(new Map([["Content-Type", "application/javascript; charset=utf-8"]]));
  });

  it("serves only available private files through fake stream and response seams", () => {
    const stream = { pipe: vi.fn() };
    const headers = new Map<string, string>();
    const end = vi.fn();
    const response = {
      setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
      writeHead: vi.fn(() => ({ end })),
    };
    type OfficeRequestHandler = {
      serveOfficeRequest(
        request: { url?: string },
        response: typeof response,
        rendererRoot: string,
      ): void;
    };
    const converter = new OfficeConverter(artifactDir, {
      fileExists: () => true,
      openReadStream: () => stream,
    }) as unknown as OfficeRequestHandler;

    converter.serveOfficeRequest({ url: "/converter.html" }, response, rendererRoot);
    expect(headers).toEqual(new Map([
      ["Cross-Origin-Opener-Policy", "same-origin"],
      ["Cross-Origin-Embedder-Policy", "require-corp"],
      ["Cross-Origin-Resource-Policy", "same-origin"],
      ["Content-Type", "text/html; charset=utf-8"],
    ]));
    expect(stream.pipe).toHaveBeenCalledWith(response);

    const missingConverter = new OfficeConverter(artifactDir, {
      fileExists: () => false,
      openReadStream: () => stream,
    }) as unknown as OfficeRequestHandler;
    missingConverter.serveOfficeRequest({ url: "/missing.js" }, response, rendererRoot);
    expect(response.writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("office artifact downloads", () => {
  it("accepts only redirects with a location", () => {
    const at = "https://cdn.example.test/soffice.js";
    expect(officeDownloadRedirect({ statusCode: 302, headers: { location: "/next" } } as never, at))
      .toBe("https://cdn.example.test/next");
    expect(officeDownloadRedirect({ statusCode: 302, headers: {} } as never, at)).toBeNull();
    expect(officeDownloadRedirect({ statusCode: 200, headers: { location: "/next" } } as never, at)).toBeNull();
    expect(officeDownloadRedirect({ headers: { location: "/next" } } as never, at)).toBeNull();
  });

  it("uses only fake stream and download seams for redirects, errors, and successful output", async () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    const followRedirect = vi.fn().mockResolvedValue(undefined);
    const redirect = {
      statusCode: 302,
      headers: { location: "/next" },
      resume: vi.fn(),
      pipe: vi.fn(),
      on: vi.fn(),
    };
    receiveOfficeDownload(redirect as never, "https://cdn.example.test/soffice.js", "/fake/out", 2, resolve, reject, followRedirect);
    await Promise.resolve();
    expect(redirect.resume).toHaveBeenCalledOnce();
    expect(followRedirect).toHaveBeenCalledWith("https://cdn.example.test/next", "/fake/out", 3);
    expect(resolve).toHaveBeenCalledOnce();

    const failed = { statusCode: 503, headers: {}, resume: vi.fn(), pipe: vi.fn(), on: vi.fn() };
    receiveOfficeDownload(failed as never, "https://cdn.example.test/soffice.js", "/fake/out", 0, resolve, reject);
    expect(failed.resume).toHaveBeenCalledOnce();
    expect((reject.mock.calls.at(-1)?.[0] as Error).message).toContain("HTTP 503");

    const outputEvents = new Map<string, () => void>();
    const output = {
      on: vi.fn((event: string, listener: () => void) => outputEvents.set(event, listener)),
      close: vi.fn((done: () => void) => done()),
    };
    const success = {
      statusCode: 200,
      headers: {},
      resume: vi.fn(),
      pipe: vi.fn(),
      on: vi.fn(),
    };
    receiveOfficeDownload(
      success as never,
      "https://cdn.example.test/soffice.js",
      "/fake/out",
      0,
      resolve,
      reject,
      undefined,
      () => output,
    );
    expect(success.pipe).toHaveBeenCalledWith(output);
    outputEvents.get("finish")!();
    expect(output.close).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
