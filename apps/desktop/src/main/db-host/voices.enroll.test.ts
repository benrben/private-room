import type Database from "better-sqlite3-multiple-ciphers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VoicePrint } from "../recFormat.js";

const mocks = vi.hoisted(() => ({
  executeOne: vi.fn(),
  queryOpt: vi.fn(),
  queryRows: vi.fn(),
}));

vi.mock("./util.js", () => mocks);
vi.mock("./files.js", () => ({ inTransaction: vi.fn() }));

import { EMB_DIM, enrollVoice } from "./voices.js";

const db = {} as Database.Database;

function print(vector: number[], frames: number): VoicePrint {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return { v: vector.map((value) => value / norm), f: frames };
}

function blob(vector: readonly number[]): Buffer {
  const out = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => out.writeFloatLE(value, index * 4));
  return out;
}

function floats(value: unknown): number[] {
  const encoded = value as Buffer;
  return Array.from({ length: encoded.length / 4 }, (_, index) => encoded.readFloatLE(index * 4));
}

function neural(axis: number, tilt = 0): VoicePrint {
  const vector = new Array<number>(EMB_DIM).fill(0);
  vector[axis] = 1;
  vector[EMB_DIM - 1] = tilt;
  return print(vector, 200);
}

function writeParams(call = 0): readonly unknown[] {
  return mocks.executeOne.mock.calls[call]?.[2] as readonly unknown[];
}

beforeEach(() => {
  mocks.executeOne.mockReset();
  mocks.queryOpt.mockReset().mockReturnValue(null);
  mocks.queryRows.mockReset().mockReturnValue([]);
});

describe("enrollVoice with a fake database", () => {
  it("does not query or write an empty name or silent print", () => {
    enrollVoice(db, "  ", print([1, 0], 200));
    enrollVoice(db, "Dana", { v: [0, 0], f: 200 });

    expect(mocks.queryOpt).not.toHaveBeenCalled();
    expect(mocks.executeOne).not.toHaveBeenCalled();
  });

  it("writes a trimmed first enrollment and its original evidence counters", () => {
    const incoming = print([3, 4], 200);

    enrollVoice(db, "  Dana  ", incoming);

    expect(mocks.queryOpt).toHaveBeenCalledOnce();
    expect(writeParams()).toMatchObject(["Dana", expect.any(Buffer), 200, 1]);
    floats(writeParams()[1]).forEach((value, index) => {
      expect(value).toBeCloseTo(incoming.v[index] as number, 6);
    });
  });

  it("merges an equal-width prior print with the capped historical weight", () => {
    mocks.queryOpt.mockReturnValue({ emb: blob([1, 0]), frames: 320, takes: 20 });

    enrollVoice(db, "Dana", print([0, 1], 80));

    const params = writeParams();
    const merged = floats(params[1]);
    expect(merged[0]).toBeCloseTo(20 / Math.sqrt(401), 6);
    expect(merged[1]).toBeCloseTo(1 / Math.sqrt(401), 6);
    expect(params.slice(2)).toEqual([400, 21]);
  });

  it("withdraws only a comparable stale denial after saving the newest naming", () => {
    const incoming = neural(3);
    const matching = blob(incoming.v);
    const unrelated = blob(neural(6).v);
    mocks.queryRows.mockReturnValue([matching, unrelated, Buffer.from([1, 2, 3])]);

    enrollVoice(db, "Dana", incoming);

    expect(mocks.executeOne).toHaveBeenCalledTimes(2);
    expect(writeParams(1)).toEqual(["Dana", matching]);
  });

  it("keeps the prior record untouched when two matching-width prints cancel", () => {
    mocks.queryOpt.mockReturnValue({ emb: blob([1, 0]), frames: 320, takes: 1 });

    enrollVoice(db, "Dana", print([-1, 0], 80));

    expect(mocks.executeOne).not.toHaveBeenCalled();
    expect(mocks.queryRows).not.toHaveBeenCalled();
  });
});
