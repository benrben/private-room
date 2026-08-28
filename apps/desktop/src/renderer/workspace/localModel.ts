/** Which on-device model a room should fall back to.
 *
 * Mirrors the host's `best_local_default` (src-tauri/src/commands/models.rs):
 * prefer the tuned default, then the rest of the curated order, and only then
 * whatever else is installed. The list this picks from is Ollama's raw
 * `/api/tags` order, which is not sorted anywhere in the Rust -> sidecar -> UI
 * chain and therefore says NOTHING about which model can hold a chat turn —
 * taking its first entry can hand a room the grounding model or a 1B model with
 * no tool calling, which is what the whole agent loop runs on.
 *
 * Import-free on purpose: the caller filters out cloud engines with the shared
 * `isCloudEngine`, so the one list of cloud engine ids stays in `markup.ts`,
 * and this stays a plain function the Node test runner can load.
 */

/** Embedding-only models answer `/api/embed` but NOT `/api/chat` — picking one
 *  returns "does not support chat". Same rule as Rust's `is_embedding_model`.
 *
 *  Exported because the model PICKER needs the identical rule: this module only
 *  kept a room from *falling back* to an embedding model, while the menu still
 *  offered `nomic-embed-text` (pulled for semantic search) as a chat model, and
 *  choosing it failed the turn with HTTP 400 (live QA 2026-08-03). One copy, so
 *  the picker and the fallback can never disagree about what can hold a chat. */
export function isEmbeddingModel(model: string): boolean {
  return /embed|bge-/i.test(model);
}

/** An Ollama model that is RELAYED to ollama.com rather than run here, so it is
 *  never the "use local" answer even though it is listed alongside the
 *  installed ones — and never the "Local only" trust label either.
 *
 *  Mirrors the host's declared record (`commands/capabilities.rs`, whose Ollama
 *  split is `runs_on_this_mac`): the tag's LAST segment ending in "cloud", not
 *  an exact `:cloud` suffix. Ollama also tags hosted entries `<size>-cloud`
 *  (`gpt-oss:120b-cloud`, `qwen3-vl:235b-cloud`), which the exact-suffix test
 *  missed — so such a room was labelled "Local only" in the trust chip and told
 *  "nothing leaves the device" while every prompt was already going to
 *  ollama.com. Strict on purpose, exactly as the host is: the cost of a false
 *  exclusion is one unnecessary "Cloud" badge, the cost of a false inclusion is
 *  a privacy claim the app cannot back.
 *
 *  Exported so `markup.isRemoteModel` — which drives that chip — has one copy
 *  of the rule to read, the same reason `isEmbeddingModel` above is exported. */
export function isRelayedModel(model: string): boolean {
  const tag = model.toLowerCase().split(":").pop() ?? "";
  return model.includes(":") && (tag === "cloud" || tag.endsWith("-cloud"));
}

/**
 * @param models   installed model names, cloud engines already filtered out.
 * @param preferred model names in preference order (RECOMMENDED_MODELS), matched
 *                  as a prefix so "qwen3.5:4b" also finds "qwen3.5:4b-instruct".
 * @returns the model to switch to, or null when nothing installed can chat.
 */
export function bestLocalModel(
  models: readonly string[],
  preferred: readonly string[],
): string | null {
  const usable = models.filter((m) => !isRelayedModel(m) && !isEmbeddingModel(m));
  for (const want of preferred) {
    const hit = usable.find((m) => m.toLowerCase().startsWith(want.toLowerCase()));
    if (hit) return hit;
  }
  return usable[0] ?? null;
}
