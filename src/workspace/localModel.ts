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
 *  returns "does not support chat". Same rule as Rust's `is_embedding_model`. */
function isEmbeddingModel(model: string): boolean {
  return /embed|bge-/i.test(model);
}

/** An Ollama `:cloud` model runs remotely, so it is never the "use local" answer
 *  even though it is listed alongside the installed ones. */
function isRemote(model: string): boolean {
  return model.toLowerCase().endsWith(":cloud");
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
  const usable = models.filter((m) => !isRemote(m) && !isEmbeddingModel(m));
  for (const want of preferred) {
    const hit = usable.find((m) => m.toLowerCase().startsWith(want.toLowerCase()));
    if (hit) return hit;
  }
  return usable[0] ?? null;
}
