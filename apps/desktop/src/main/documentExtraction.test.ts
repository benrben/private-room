import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sidecar: vi.fn(),
}));

vi.mock("./sidecarJsonCancellable.js", () => ({ sidecarJsonCancellable: mocks.sidecar }));

import { extractDocumentStream, extractDocumentText } from "./documentExtraction.js";

describe("document extraction staging", () => {
  let scratch = "";

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-document-extraction-test-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(scratch);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it("streams bytes to a private staged file, hashes them, and removes the staging directory", async () => {
    const bytes = Buffer.from("private document");
    mocks.sidecar.mockImplementation(async (endpoint: string, payload: unknown, _cancel: unknown, timeout: number) => {
      const request = payload as { path: string; name: string };
      expect(endpoint).toBe("/docs/extract");
      expect(request.name).toBe("notes.md");
      expect(timeout).toBe(10 * 60_000);
      expect(await fs.promises.readFile(request.path)).toEqual(bytes);
      return { kind: "value", value: { text: "extracted text" } };
    });

    await expect(extractDocumentStream("notes.md", Readable.from([bytes]))).resolves.toEqual({
      text: "extracted text",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
    await expect(fs.promises.readdir(scratch)).resolves.toEqual([]);
  });

  it("keeps an absent text value honest and surfaces a stopped extraction after cleanup", async () => {
    mocks.sidecar.mockResolvedValueOnce({ kind: "value", value: { text: 42 } });
    await expect(extractDocumentText("binary.bin", Buffer.from([1, 2]))).resolves.toBeNull();

    mocks.sidecar.mockResolvedValueOnce({ kind: "stopped" });
    await expect(extractDocumentText("cancelled.txt", Buffer.from("x"))).rejects.toThrow(
      "Document extraction was stopped."
    );
    await expect(fs.promises.readdir(scratch)).resolves.toEqual([]);
  });

  it("surfaces the sidecar's extraction error without leaving staged data behind", async () => {
    mocks.sidecar.mockResolvedValue({ kind: "error", error: { error: "unsupported archive" } });

    await expect(extractDocumentText("bundle.rar", Buffer.from("archive"))).rejects.toThrow("unsupported archive");
    await expect(fs.promises.readdir(scratch)).resolves.toEqual([]);
  });
});
