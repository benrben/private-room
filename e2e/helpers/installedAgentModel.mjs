/** Resolve the exact installed Ollama tag an installed-app agent review uses.
 * The review must not pin a machine-specific build suffix such as `-mlx`. */
export function resolveInstalledOllamaModel(status, configured) {
  const models = Array.isArray(status?.models)
    ? status.models.filter((model) => typeof model === "string")
    : [];
  const usable = models.filter((model) => {
    const tag = model.toLowerCase().split(":").pop() ?? "";
    const relayed = model.includes(":") && (tag === "cloud" || tag.endsWith("-cloud"));
    return !relayed && !/embed|bge-/i.test(model);
  });
  const exactOrUniqueFolded = (wanted) => {
    const exact = usable.find((candidate) => candidate === wanted);
    if (exact) return exact;
    const folded = usable.filter((candidate) => candidate.toLowerCase() === wanted.toLowerCase());
    return folded.length === 1 ? folded[0] : null;
  };

  if (configured) {
    const selected = exactOrUniqueFolded(configured.trim());
    if (selected) return selected;
    throw new Error(
      `Requested local review model “${configured}” is not installed. ` +
      `Installed chat models: ${usable.length ? usable.join(", ") : "none"}.`,
    );
  }
  const preferred = typeof status?.defaultModel === "string"
    ? exactOrUniqueFolded(status.defaultModel.trim())
    : null;
  if (preferred) return preferred;
  if (usable[0]) return usable[0];
  throw new Error(
    `No installed local Ollama chat model is available. Ollama reported: ${models.length ? models.join(", ") : "no models"}.`,
  );
}
