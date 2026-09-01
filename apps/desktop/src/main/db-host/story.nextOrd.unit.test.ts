import { describe, expect, it, vi } from "vitest";
import { addCastMember } from "./story.js";

describe("story ordering fallback", () => {
  it("starts at zero when the aggregate ordering query fails", () => {
    const inserted: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT COALESCE")) throw new Error("fabricated aggregate failure");
        return { run: (...args: unknown[]) => inserted.push(args) };
      }),
    };

    const member = addCastMember(db as never, "  Mira  ", "  lead  ", "  voyage  ");

    expect(member).toMatchObject({ name: "Mira", description: "lead", story: "voyage", ord: 0 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.at(-1)).toBe(0);
  });
});
