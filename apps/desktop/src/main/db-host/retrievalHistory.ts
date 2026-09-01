import { questionTerms, stripMarkupBlocks } from "./retrievalText.js";

/** Largest UTF-8 byte index not splitting a multi-byte character. */
function floorBoundary(buf: Buffer, max: number): number {
  let cut = max;
  while (cut > 0 && ((buf[cut] as number) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return cut;
}

function compactedHistoryPiece(buffer: Buffer, remaining: number): string {
  const cut = floorBoundary(buffer, Math.max(0, remaining - 40));
  const end = preferredHistoryEnd(buffer, cut);
  return `${buffer.subarray(0, end).toString("utf8")}\n… [rest of this message omitted]`;
}

function preferredHistoryEnd(buffer: Buffer, cut: number): number {
  if (cut < 2) return cut;
  const floor = cut - Math.floor(cut / 5);
  const paragraph = buffer.lastIndexOf("\n\n", cut - 2);
  return paragraph !== -1 && paragraph >= floor ? paragraph : cut;
}

/** Compact oldest-first chat history under a UTF-8 byte budget. */
export function compactHistory(
  history: ReadonlyArray<readonly [string, string]>,
  budget: number
): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  let remaining = budget;
  for (let i = history.length - 1; i >= 0; i--) {
    const [role, raw] = history[i] as readonly [string, string];
    const content = stripMarkupBlocks(raw);
    if (content === "") {
      continue;
    }
    const buf = Buffer.from(content, "utf8");
    if (buf.length <= remaining) {
      remaining -= buf.length;
      kept.push([role, content]);
      continue;
    }
    if (remaining < 400) {
      break;
    }
    kept.push([role, compactedHistoryPiece(buf, remaining)]);
    break;
  }
  kept.reverse();
  return kept;
}

/** Choose relevant memories under a code-point budget, with recency tie-breaks. */
export function selectMemories(
  memories: readonly string[],
  question: string,
  budget: number
): string[] {
  const terms = questionTerms(question);
  const scored = memories.map((m, idx) => {
    const lower = m.toLowerCase();
    const hits = terms.filter((t) => lower.includes(t)).length;
    return { hits, idx, m };
  });
  scored.sort((a, b) => b.hits - a.hits || b.idx - a.idx);
  const out: string[] = [];
  let used = 0;
  for (const { m } of scored) {
    const cost = Array.from(m).length + 3;
    if (used + cost > budget) {
      continue;
    }
    used += cost;
    out.push(m);
  }
  return out;
}
