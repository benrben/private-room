/* The chat transcript's render page (`workspace/constants.ts`).
 *
 * Opening a months-old conversation mounted EVERY message at once — hundreds of
 * long answers, each with its own Markdown parse, plus inline images and agent
 * diagrams. The pane now paints a tail page and offers the rest; the rule lives
 * in a pure helper precisely so it can be pinned here without a React mount.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/workspace/constants.ts"), "utf8");

/** The helper, lifted out of the TypeScript source — no build step involved, so
 *  the test reads the shipped rule rather than a copy of it. */
function load() {
  const body = SOURCE.slice(SOURCE.indexOf("export function chatPageSlice"))
    .replace(/^export function chatPageSlice<T>\(all: T\[\], shown: number\): \{ hidden: number; visible: T\[\] \}/, "function chatPageSlice(all, shown)")
    .replace("export function chatPageToReveal(total: number, index: number): number", "function chatPageToReveal(total, index)");
  const page = /export const CHAT_PAGE = (\d+);/.exec(SOURCE);
  assert.ok(page, "CHAT_PAGE has to exist for the pane to have a page size");
  assert.ok(
    /export function chatPageToReveal/.test(SOURCE),
    "paging without a way to widen for a search hit breaks jump-to-message",
  );
  return {
    chatPageSlice: new Function(`${body}\nreturn chatPageSlice;`)(),
    chatPageToReveal: new Function(`${body}\nreturn chatPageToReveal;`)(),
    CHAT_PAGE: Number(page[1]),
  };
}

test("a short conversation is never paged, and 0 hidden means whole", () => {
  const { chatPageSlice, CHAT_PAGE } = load();
  const all = Array.from({ length: 12 }, (_, i) => i);
  const { hidden, visible } = chatPageSlice(all, CHAT_PAGE);
  assert.equal(hidden, 0);
  assert.deepEqual(visible, all, "the whole list, not a copy of part of it");
  assert.ok(CHAT_PAGE >= 20, "a page smaller than an ordinary chat would page everyone");
});

test("a long conversation paints its NEWEST page and holds the rest back", () => {
  const { chatPageSlice, CHAT_PAGE } = load();
  const all = Array.from({ length: CHAT_PAGE + 40 }, (_, i) => i);
  const { hidden, visible } = chatPageSlice(all, CHAT_PAGE);
  assert.equal(hidden, 40, "the count under the button has to be the real one");
  assert.equal(visible.length, CHAT_PAGE);
  // Newest-LAST: the transcript reads downward, so the tail is what you see.
  assert.equal(visible[visible.length - 1], all[all.length - 1]);
  assert.equal(visible[0], 40);
});

test("pressing Show earlier reveals exactly one more page, then the whole list", () => {
  const { chatPageSlice, CHAT_PAGE } = load();
  const all = Array.from({ length: CHAT_PAGE + 10 }, (_, i) => i);
  const second = chatPageSlice(all, CHAT_PAGE * 2);
  assert.equal(second.hidden, 0, "one press clears a 10-message overhang");
  assert.deepEqual(second.visible, all);
  // Over-shooting must not slice past the start or report a negative count.
  const over = chatPageSlice(all, 10_000);
  assert.equal(over.hidden, 0);
  assert.deepEqual(over.visible, all);
});

test("a search hit older than one page is still painted, so the jump has an element", () => {
  // Regression: `revealMessage` scrolls to `#msg-<id>` and polls for it. With a
  // tail page and no widening, a hit 200 messages back never mounts, the poll
  // expires after 2 s and picking the search result does nothing at all.
  const { chatPageSlice, chatPageToReveal, CHAT_PAGE } = load();
  const all = Array.from({ length: 300 }, (_, i) => `m${i}`);
  const hitIndex = 7; // far older than CHAT_PAGE
  assert.ok(
    !chatPageSlice(all, CHAT_PAGE).visible.includes(all[hitIndex]),
    "this test is pointless unless the default page really hides the hit",
  );
  const widened = chatPageToReveal(all.length, hitIndex);
  assert.ok(widened > CHAT_PAGE, "widening has to actually widen");
  assert.ok(chatPageSlice(all, widened).visible.includes(all[hitIndex]));
  // The oldest message needs the whole conversation; the newest needs one row.
  assert.equal(chatPageToReveal(all.length, 0), all.length);
  assert.equal(chatPageToReveal(all.length, all.length - 1), 1);
  // A message that is not in this conversation must not widen anything.
  assert.equal(chatPageToReveal(all.length, -1), 0);
  assert.equal(chatPageToReveal(all.length, all.length), 0);
});

test("degenerate inputs cannot produce a negative hidden count or a bad slice", () => {
  const { chatPageSlice } = load();
  assert.deepEqual(chatPageSlice([], 60), { hidden: 0, visible: [] });
  const all = [1, 2, 3];
  assert.deepEqual(chatPageSlice(all, 0), { hidden: 3, visible: [] });
  assert.deepEqual(chatPageSlice(all, -5), { hidden: 3, visible: [] });
});
