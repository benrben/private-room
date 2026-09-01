import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import {
  MAX_IMPORT_BYTES,
  importModifiedOutputsInRoomForTest,
  scriptFingerprint,
  type Materialized,
  type ModifiedOutputImportDeps,
} from "./scriptRun.js";

const FAKE_DB = {} as Database.Database;

function overCapBytes(): Buffer {
  const bytes = Buffer.from("fabricated changed bytes");
  Object.defineProperty(bytes, "length", { value: MAX_IMPORT_BYTES + 1 });
  return bytes;
}

describe("modified workspace output import cap", () => {
  it("reports an oversized changed materialized file as not saved back without writing it", async () => {
    const bytes = overCapBytes();
    const writeOutput = async () => { throw new Error("must not write an oversized output"); };
    const deps: ModifiedOutputImportDeps = {
      readMaterialized: () => bytes,
      writeOutput,
    };
    const materialized: Materialized[] = [{
      name: "huge-report.bin",
      sha: scriptFingerprint(Buffer.from("original bytes")),
    }];

    await expect(
      importModifiedOutputsInRoomForTest(
        FAKE_DB,
        "/fake-room",
        "/fake-workspace",
        materialized,
        [],
        "fabricated script run",
        deps,
      ),
    ).resolves.toEqual({
      imported: [],
      skipped: ["huge-report.bin: over the 64MB import cap — not saved back"],
    });
  });
});
