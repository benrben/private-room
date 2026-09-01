import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  execFile: vi.fn(),
  randomUUID: vi.fn(),
  readFile: vi.fn(),
  tmpdir: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: fake.execFile }));
vi.mock("node:crypto", () => ({ randomUUID: fake.randomUUID }));
vi.mock("node:fs", () => ({
  unlinkSync: fake.unlinkSync,
  writeFileSync: fake.writeFileSync,
}));
vi.mock("node:fs/promises", () => ({ readFile: fake.readFile }));
vi.mock("node:os", () => ({ tmpdir: fake.tmpdir }));

import { convert } from "./textUtil.js";

const sourcePath = "/fake/tmp/arcelle-tu-unit-id.rtf";
const outputPath = "/fake/tmp/arcelle-tu-unit-id.txt";

function succeeds(): void {
  fake.execFile.mockImplementation(
    (_binary: string, _args: string[], done: (error: Error | null) => void) => done(null)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.randomUUID.mockReturnValue("unit-id");
  fake.tmpdir.mockReturnValue("/fake/tmp");
  fake.writeFileSync.mockImplementation(() => undefined);
  fake.unlinkSync.mockImplementation(() => undefined);
  fake.readFile.mockResolvedValue(Buffer.from(" converted text\n"));
  succeeds();
});

describe("convert with fabricated textutil and filesystem seams", () => {
  it("writes, converts, strictly reads, and cleans both generated paths", async () => {
    const source = Buffer.from("{\\rtf1 source}");

    await expect(convert("Notes.RTF", source, "txt")).resolves.toBe(" converted text\n");

    expect(fake.writeFileSync).toHaveBeenCalledWith(sourcePath, source, {
      flag: "wx",
      mode: 0o600,
    });
    expect(fake.execFile).toHaveBeenCalledWith(
      "/usr/bin/textutil",
      ["-convert", "txt", "-output", outputPath, sourcePath],
      expect.any(Function)
    );
    expect(fake.readFile).toHaveBeenCalledWith(outputPath);
    expect(fake.unlinkSync.mock.calls).toEqual([[sourcePath], [outputPath]]);
  });

  it("short-circuits unsupported input without allocating or cleaning paths", async () => {
    await expect(convert("notes.pdf", Buffer.from("bytes"), "txt")).resolves.toBeNull();

    expect(fake.randomUUID).not.toHaveBeenCalled();
    expect(fake.writeFileSync).not.toHaveBeenCalled();
    expect(fake.execFile).not.toHaveBeenCalled();
    expect(fake.unlinkSync).not.toHaveBeenCalled();
  });

  it("returns null and cleans paths when the private write is refused", async () => {
    fake.writeFileSync.mockImplementation(() => {
      throw new Error("exists");
    });

    await expect(convert("notes.rtf", Buffer.from("bytes"), "txt")).resolves.toBeNull();

    expect(fake.execFile).not.toHaveBeenCalled();
    expect(fake.unlinkSync.mock.calls).toEqual([[sourcePath], [outputPath]]);
  });

  it("returns null and cleans paths when the fabricated converter fails", async () => {
    fake.execFile.mockImplementation(
      (_binary: string, _args: string[], done: (error: Error | null) => void) =>
        done(new Error("converter failed"))
    );

    await expect(convert("notes.rtf", Buffer.from("bytes"), "html")).resolves.toBeNull();

    expect(fake.readFile).not.toHaveBeenCalled();
    expect(fake.unlinkSync.mock.calls).toEqual([
      ["/fake/tmp/arcelle-tu-unit-id.rtf"],
      ["/fake/tmp/arcelle-tu-unit-id.html"],
    ]);
  });

  it.each([
    ["missing converted output", () => Promise.reject(new Error("missing"))],
    ["invalid UTF-8", () => Promise.resolve(Buffer.from([0xff, 0xfe]))],
    ["blank converted text", () => Promise.resolve(Buffer.from(" \n\t"))],
  ])("returns null and cleans paths for %s", async (_label, output) => {
    fake.readFile.mockImplementation(output);

    await expect(convert("notes.rtf", Buffer.from("bytes"), "txt")).resolves.toBeNull();

    expect(fake.unlinkSync.mock.calls).toEqual([[sourcePath], [outputPath]]);
  });
});
