import { ChatCommand } from "../api";

/**
 * First-run model chooser. A curated set of local chat models the app can fully
 * drive (chat + tools + image marking), so a fresh install isn't hard-wired to
 * one download. Sizes are the Ollama download size; anything else can still be
 * pulled by name in Settings → Model manager. Keep the first entry the default
 * (matches the backend's DEFAULT_MODEL / best_default).
 */
export const RECOMMENDED_MODELS: {
  name: string;
  label: string;
  size: string;
  blurb: string;
  tag?: string;
}[] = [
  {
    name: "qwen3.5:4b",
    label: "Balanced",
    size: "3.4 GB",
    blurb: "Chat, tools, and image marking. A great default on 16 GB Macs.",
    tag: "Recommended",
  },
  {
    name: "qwen3.5:9b",
    label: "Higher quality",
    size: "6.6 GB",
    blurb: "Sharper answers and reasoning; best with 32 GB+ of RAM.",
  },
  {
    name: "gemma3:4b",
    label: "Compact",
    size: "3.3 GB",
    blurb: "Google's small model — a lighter, capable all-rounder.",
  },
];

/** Room setting recording that the Memory introduction has been seen. A room
 * setting, not a browser key: it must survive renaming/moving the room file and
 * must never be shared between two rooms that happen to be named alike. */
export const MEMORY_INTRO_SEEN = "memory_intro_seen";

/** Client-only "#help" command. It isn't a backend command (it opens the
 * command list in the composer instead of asking the model), so it's kept
 * separate from `list_chat_commands` and only surfaced in the UI hints. */
export const HELP_COMMAND: ChatCommand = {
  name: "help",
  summary: "List every command and how to use it",
  usage: "#help",
};

/** How many chat messages the transcript PAINTS at a time, newest-last.
 *
 * Opening a months-old conversation used to mount every row at once — hundreds
 * of long answers, each with its own Markdown parse, plus inline images and
 * agent diagrams. This bounds the render only: the whole conversation is
 * already in memory, so "Show earlier messages" is instant and nothing is ever
 * missing from what the model is given. Sized so an ordinary conversation is
 * never paged at all. */
export const CHAT_PAGE = 60;

/** The newest `shown` of `all`, plus how many older ones are being held back.
 *
 * Pure and exported so the paging rule is testable without mounting the pane:
 * the transcript is newest-LAST, so a page is a tail slice, and "0 hidden" has
 * to mean the list is whole rather than "we did not check".
 */
export function chatPageSlice<T>(all: T[], shown: number): { hidden: number; visible: T[] } {
  const hidden = Math.max(0, all.length - Math.max(0, shown));
  return { hidden, visible: hidden > 0 ? all.slice(hidden) : all };
}

/** The smallest page that still PAINTS the message at `index` (0-based, oldest
 * first) of a `total`-long, newest-last transcript.
 *
 * Search's "jump to this message" scrolls to an element, so the row has to be
 * mounted before the jump can find it — with a tail page, a hit older than
 * `CHAT_PAGE` had no element and the jump silently did nothing. Paired with
 * `chatPageSlice`: `chatPageSlice(all, chatPageToReveal(all.length, i))`
 * always contains `all[i]`.
 */
export function chatPageToReveal(total: number, index: number): number {
  if (index < 0 || index >= total) return 0;
  return total - index;
}
