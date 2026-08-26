import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CancelFlag } from "./cancel.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** Full document extraction through the Python dispatcher that owns PDF,
 * Office, legacy Office, archives, mail, ebooks and plain-text decoding. */
export async function extractDocumentText(name: string, bytes: Buffer): Promise<string | null> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-docs-"));
  const staged = path.join(tempDir, "document.bin");
  try {
    await fs.promises.writeFile(staged, bytes, { mode: 0o600 });
    const outcome = await sidecarJsonCancellable(
      "/docs/extract",
      { path: staged, name },
      new CancelFlag(),
      10 * 60_000,
    );
    if (outcome.kind === "stopped") throw new Error("Document extraction was stopped.");
    if (outcome.kind === "error") throw new Error(outcome.error.error);
    const text = object(outcome.value).text;
    return typeof text === "string" ? text : null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
