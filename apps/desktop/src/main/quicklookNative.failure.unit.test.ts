import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
const fileSystem = vi.hoisted(() => ({ failOpen: false }));

vi.mock("node:child_process", () => ({ execFile: childProcess.execFile }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fileSystem.failOpen) throw new Error("fabricated exclusive-create failure");
      return actual.writeFileSync(...args);
    },
  };
});

afterEach(() => {
  fileSystem.failOpen = false;
  vi.restoreAllMocks();
});

describe("Quick Look failure paths", () => {
  it("returns null when the private temporary copy cannot be created", async () => {
    fileSystem.failOpen = true;
    const { previewPng } = await import("./quicklookNative.js");

    await expect(previewPng("private.pdf", Buffer.from("secret"), vi.fn())).resolves.toBeNull();
  });

  it("returns null when qlmanage reports success but produces no readable output", async () => {
    childProcess.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(null);
      return {};
    });
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const { qlmanageThumbnailPng } = await import("./quicklookNative.js");
      await expect(qlmanageThumbnailPng("/tmp/definitely-no-such-preview-input.pdf", 64)).resolves.toBeNull();
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});
