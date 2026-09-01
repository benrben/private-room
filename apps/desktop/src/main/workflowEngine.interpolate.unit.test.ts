import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import type { RoomSource } from "./jobs.js";
import { interpolate } from "./workflowEngine.js";

interface FakeDbOptions {
  readonly fileRows?: readonly unknown[][];
  readonly date?: string;
  readonly failFiles?: boolean;
  readonly failDate?: boolean;
}

function fakeDb(options: FakeDbOptions = {}): {
  readonly db: Database.Database;
  readonly prepare: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(() => ({
    raw: () => ({
      all: () => {
        if (options.failFiles) throw new Error("inventory unavailable");
        return options.fileRows ?? [];
      },
      get: () => {
        if (options.failDate) throw new Error("clock unavailable");
        return [options.date ?? "2026-09-01"];
      },
    }),
  }));
  return { db: { prepare } as unknown as Database.Database, prepare };
}

function roomsAt(roomPath: string, db: Database.Database | null): RoomSource {
  return {
    current: () => (db === null ? null : { path: roomPath, db }),
  };
}

describe("interpolate", () => {
  it("substitutes input literally without resolving markers absent from the template", () => {
    const { db, prepare } = fakeDb();

    expect(
      interpolate(roomsAt("room-a", db), "room-a", "Input: {{input}}", "{{files}} $&"),
    ).toBe("Input: {{files}} $&");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses the fabricated room inventory and date, retaining only nonblank file liners", () => {
    const { db, prepare } = fakeDb({
      fileRows: [
        ["brief.md", "text/markdown", 10, "A summary", ["", ""]],
        ["plain.txt", "text/plain", 2, null, ["", ""]],
        ["blank.txt", "text/plain", 3, "  ", ["", ""]],
      ],
      date: "2030-01-02",
    });

    expect(
      interpolate(
        roomsAt("room-a", db),
        "room-a",
        "Files:\n{{files}}\nDate: {{date}}\nInput: {{input}}",
        "answer",
      ),
    ).toBe("Files:\n- brief.md: A summary\n- plain.txt\n- blank.txt\nDate: 2030-01-02\nInput: answer");
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("leaves room values empty when the room is absent without querying a database", () => {
    const { db, prepare } = fakeDb();

    expect(interpolate(roomsAt("room-a", db), "room-b", "[{{files}}][{{date}}]", "")).toBe(
      "[][]",
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("contains inventory and date lookup failures while leaving input literal and last", () => {
    const { db, prepare } = fakeDb({ failFiles: true, failDate: true });

    expect(
      interpolate(
        roomsAt("room-a", db),
        "room-a",
        "[{{files}}][{{date}}] {{input}}",
        "{{files}} $&",
      ),
    ).toBe("[][] {{files}} $&");
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
