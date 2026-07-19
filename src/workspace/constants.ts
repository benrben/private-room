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

/** Client-only "#help" command. It isn't a backend command (it opens the
 * command list in the composer instead of asking the model), so it's kept
 * separate from `list_chat_commands` and only surfaced in the UI hints. */
export const HELP_COMMAND: ChatCommand = {
  name: "help",
  summary: "List every command and how to use it",
  usage: "#help",
};
