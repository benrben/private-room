import { describe, expect, it } from "vitest";
import type { BrowseJournalRow } from "../apiTypes";
import { coalesce } from "./browserJournal";

function row(overrides: Partial<BrowseJournalRow> = {}): BrowseJournalRow {
  return {
    id: 1,
    at: "2026-09-01T10:00:00.000Z",
    kind: "blocked",
    url: "https://fake.example/one",
    detail: "fake blocker refusal",
    session: "fake-session",
    ...overrides,
  };
}

describe("browser journal coalesce", () => {
  it("keeps an empty fabricated journal empty", () => {
    expect(coalesce([])).toEqual([]);
  });

  it("merges consecutive rows with the same kind, detail, and address while retaining the first row", () => {
    const first = row();
    const repeated = row({
      id: 2,
      at: "2026-09-01T10:00:02.000Z",
      session: "a later fake session field",
    });

    const lines = coalesce([first, repeated]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ row: first, runs: 2 });
    expect(lines[0]?.row).toBe(first);
    expect(lines[0]?.row).toMatchObject({
      id: 1,
      at: "2026-09-01T10:00:00.000Z",
      session: "fake-session",
    });
  });

  it("keeps kind, detail, URL, and nonconsecutive boundaries as separate record lines", () => {
    const base = row();
    const changedUrl = row({ id: 2, url: "https://fake.example/two" });
    const changedDetail = row({ id: 3, detail: "a different fake refusal" });
    const changedKind = row({ id: 4, kind: "error" });
    const nonconsecutiveBase = row({ id: 5, at: "2026-09-01T10:01:00.000Z" });

    const lines = coalesce([
      base,
      changedUrl,
      changedUrl,
      changedDetail,
      changedKind,
      nonconsecutiveBase,
    ]);

    expect(lines.map(({ row: journalRow, runs }) => [journalRow.id, runs])).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
    expect(lines.map(({ row: journalRow }) => journalRow)).toEqual([
      base,
      changedUrl,
      changedDetail,
      changedKind,
      nonconsecutiveBase,
    ]);
  });
});
