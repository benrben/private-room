import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CancelFlag } from "./cancel.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** Full document extraction through the Python dispatcher that owns PDF,
 * Office, legacy Office, archives, mail, ebooks and plain-text decoding. */
export interface StreamExtractionResult {
  text: string | null;
  sha256: string;
  sizeBytes: number;
}

/**
 * Stage a trusted stream for the sidecar while calculating the exact source
 * hash. Workspace files use this path so large documents are never buffered
 * in Electron only to be copied into the sidecar staging file.
 */
export async function extractDocumentStream(
  name: string,
  content: Readable,
): Promise<StreamExtractionResult> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-docs-"));
  const staged = path.join(tempDir, "document.bin");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const observe = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.length;
      callback(null, bytes);
    },
  });
  try {
    await pipeline(content, observe, createWriteStream(staged, { flags: "wx", mode: 0o600 }));
    const outcome = await sidecarJsonCancellable(
      "/docs/extract",
      { path: staged, name },
      new CancelFlag(),
      10 * 60_000,
    );
    if (outcome.kind === "stopped") throw new Error("Document extraction was stopped.");
    if (outcome.kind === "error") throw new Error(outcome.error.error);
    const text = object(outcome.value).text;
    return {
      text: typeof text === "string" ? text : null,
      sha256: hash.digest("hex"),
      sizeBytes,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Full document extraction through the trusted streaming staging path. */
export async function extractDocumentText(name: string, bytes: Buffer): Promise<string | null> {
  return (await extractDocumentStream(name, Readable.from([bytes]))).text;
}
