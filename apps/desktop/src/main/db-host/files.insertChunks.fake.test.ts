import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ randomUUID: vi.fn() }));

vi.mock("node:crypto", () => ({ randomUUID: fakes.randomUUID }));

import { insertChunks } from "./files.js";

type FakeStatement = {
  run: ReturnType<typeof vi.fn>;
  raw?: () => { get: () => unknown[] | undefined };
};

function memoryDatabase(options: {
  trashed: boolean;
  missingFile?: boolean;
  rejectInsert?: Error;
  rejectRollback?: Error;
}) {
  const exec = vi.fn((sql: string) => {
    if (sql.startsWith("ROLLBACK") && options.rejectRollback !== undefined) throw options.rejectRollback;
  });
  const inserted: unknown[][] = [];
  const select: FakeStatement = {
    run: vi.fn(),
    raw: () => ({ get: () => options.missingFile ? undefined : [options.trashed ? 1 : 0] }),
  };
  const insert: FakeStatement = {
    run: vi.fn((...values: unknown[]) => {
      if (options.rejectInsert !== undefined) throw options.rejectInsert;
      inserted.push(values);
    }),
  };
  const prepare = vi.fn((sql: string) => sql.startsWith("SELECT") ? select : insert);
  return { db: { exec, prepare } as never, exec, insert, inserted, prepare };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.randomUUID.mockReturnValue("fake-id");
});

describe("insertChunks with an in-memory database", () => {
  it("does not query or write when the fabricated file has no extracted text", () => {
    const fake = memoryDatabase({ trashed: false });

    insertChunks(fake.db, "file-without-text", null);

    expect(fake.prepare).not.toHaveBeenCalled();
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it("writes stripped text to the fabricated live chunk index inside one savepoint", () => {
    const fake = memoryDatabase({ trashed: false, missingFile: true });

    insertChunks(fake.db, "live-file", "קֹהֶלֶת");

    expect(fake.prepare).toHaveBeenLastCalledWith(
      "INSERT INTO chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)",
    );
    expect(fake.insert.run).toHaveBeenCalledWith("fake-id", "live-file", 0, "קהלת");
    expect(fake.exec.mock.calls).toEqual([
      ['SAVEPOINT "chunk_fakeid"'],
      ['RELEASE "chunk_fakeid"'],
    ]);
  });

  it("routes a fabricated trashed file to its stash instead of the live index", () => {
    const fake = memoryDatabase({ trashed: true });

    insertChunks(fake.db, "trashed-file", "archived text");

    expect(fake.prepare).toHaveBeenLastCalledWith(
      "INSERT INTO trashed_chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)",
    );
    expect(fake.insert.run).toHaveBeenCalledWith("fake-id", "trashed-file", 0, "archived text");
  });

  it("rolls back a fabricated partial write and preserves the write failure", () => {
    const failure = new Error("fabricated chunk write failure");
    const fake = memoryDatabase({ trashed: false, rejectInsert: failure });

    expect(() => insertChunks(fake.db, "broken-file", "text that cannot be indexed")).toThrow(failure);

    expect(fake.exec.mock.calls).toEqual([
      ['SAVEPOINT "chunk_fakeid"'],
      ['ROLLBACK TO "chunk_fakeid"; RELEASE "chunk_fakeid"'],
    ]);
  });

  it("preserves the fabricated write failure when rollback cleanup also fails", () => {
    const writeFailure = new Error("fabricated chunk write failure");
    const rollbackFailure = new Error("fabricated rollback failure");
    const fake = memoryDatabase({
      trashed: false,
      rejectInsert: writeFailure,
      rejectRollback: rollbackFailure,
    });

    expect(() => insertChunks(fake.db, "rollback-broken-file", "text")).toThrow(writeFailure);

    expect(fake.exec).toHaveBeenLastCalledWith('ROLLBACK TO "chunk_fakeid"; RELEASE "chunk_fakeid"');
  });
});
