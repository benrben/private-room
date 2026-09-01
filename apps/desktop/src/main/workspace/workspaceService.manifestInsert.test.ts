import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: mocks.randomUUID,
}));

import type { ManifestEntry } from "./types.js";
import { WorkspaceService } from "./workspaceService.js";

interface Statement {
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

interface ManifestServiceInternals {
  db: { prepare(sql: string): Statement };
  insertManifestEntry(entry: ManifestEntry): string;
  reconciledIndexState(row: unknown, sha256: string): string;
  updateManifestRow(fileId: string, entry: ManifestEntry, state: string): void;
}

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    relativePath: "notes/Plan.md",
    pathKey: "notes/plan.md",
    sizeBytes: 42,
    mtimeNs: 123_456,
    sha256: "fabricated-sha",
    fsIdentity: "fabricated-device:inode:birth",
    ...overrides,
  };
}

function serviceWithStatements(statements: {
  insert: Statement;
  existing?: Statement;
  row?: Statement;
}): {
  service: ManifestServiceInternals;
  prepare: ReturnType<typeof vi.fn>;
  reconciledIndexState: ReturnType<typeof vi.fn>;
  updateManifestRow: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn((sql: string): Statement => {
    if (sql.includes("INSERT INTO files")) return statements.insert;
    if (sql.includes("SELECT id FROM files")) return statements.existing!;
    if (sql.includes("SELECT content_sha256")) return statements.row!;
    throw new Error(`Unexpected fabricated query: ${sql}`);
  });
  const reconciledIndexState = vi.fn(() => "stale");
  const updateManifestRow = vi.fn();
  const service = Object.create(WorkspaceService.prototype) as ManifestServiceInternals;
  service.db = { prepare };
  service.reconciledIndexState = reconciledIndexState;
  service.updateManifestRow = updateManifestRow;
  return { service, prepare, reconciledIndexState, updateManifestRow };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.randomUUID.mockReturnValue("fabricated-file-id");
});

describe("WorkspaceService manifest insertion", () => {
  it("inserts a fabricated manifest entry with its stable workspace projection", () => {
    const insert = { get: vi.fn(), run: vi.fn() };
    const { service } = serviceWithStatements({ insert });
    const manifestEntry = entry();

    expect(service.insertManifestEntry(manifestEntry)).toBe("fabricated-file-id");

    expect(insert.run).toHaveBeenCalledWith(
      "fabricated-file-id",
      "Plan.md",
      "text/markdown",
      42,
      "notes/Plan.md",
      "notes/plan.md",
      "fabricated-sha",
      123_456,
      "fabricated-device:inode:birth",
    );
  });

  it("reuses and refreshes the fabricated winner after a duplicate manifest insert", () => {
    const insert = { get: vi.fn(), run: vi.fn(() => {
      throw Object.assign(new Error("fabricated duplicate"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    }) };
    const existing = { get: vi.fn(() => ({ id: "existing-file-id" })), run: vi.fn() };
    const row = {
      get: vi.fn(() => ({ content_sha256: "old-sha", index_state: "ready" })),
      run: vi.fn(),
    };
    const { service, reconciledIndexState, updateManifestRow } = serviceWithStatements({
      insert,
      existing,
      row,
    });
    const manifestEntry = entry({ sha256: "new-sha" });

    expect(service.insertManifestEntry(manifestEntry)).toBe("existing-file-id");

    expect(existing.get).toHaveBeenCalledWith("notes/plan.md");
    expect(row.get).toHaveBeenCalledWith("existing-file-id");
    expect(reconciledIndexState).toHaveBeenCalledWith(
      { content_sha256: "old-sha", index_state: "ready" },
      "new-sha",
    );
    expect(updateManifestRow).toHaveBeenCalledWith("existing-file-id", manifestEntry, "stale");
  });

  it("rethrows a fabricated constraint when no stable workspace row exists", () => {
    const duplicate = Object.assign(new Error("fabricated duplicate"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const insert = { get: vi.fn(), run: vi.fn(() => { throw duplicate; }) };
    const existing = { get: vi.fn(() => undefined), run: vi.fn() };
    const { service } = serviceWithStatements({ insert, existing });

    expect(() => service.insertManifestEntry(entry())).toThrow(duplicate);
  });

  it("rethrows a fabricated non-constraint database error unchanged", () => {
    const failure = Object.assign(new Error("fabricated database unavailable"), { code: "SQLITE_BUSY" });
    const insert = { get: vi.fn(), run: vi.fn(() => { throw failure; }) };
    const { service } = serviceWithStatements({ insert });

    expect(() => service.insertManifestEntry(entry())).toThrow(failure);
  });
});
