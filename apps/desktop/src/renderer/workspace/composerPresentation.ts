/** Return a friendly file name while retaining compound archive semantics. */
export function displayName(name: string): string {
  const compound = /\.tar\.(?:gz|bz2|xz|zst)$/i.exec(name);
  const dot = compound?.index ?? name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const cleaned = base.replace(/_+/g, " ").trim();
  return cleaned || name;
}

let ambiguousFor: { name: string }[] | null = null;
let ambiguousSet = new Set<string>();

/** Return the display names shared by multiple files in the same list. */
export function ambiguousDisplayNames(files: { name: string }[]): Set<string> {
  if (files === ambiguousFor) return ambiguousSet;
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const file of files) {
    const key = displayName(file.name).toLowerCase();
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  ambiguousFor = files;
  ambiguousSet = dupes;
  return dupes;
}

/** Keep the real extension only when the friendly label would be ambiguous. */
export function fileLabel(name: string, files: { name: string }[]): string {
  const base = displayName(name);
  return ambiguousDisplayNames(files).has(base.toLowerCase()) ? name : base;
}

/** Format a saved-version timestamp without an ambiguous numeric month. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Return the short attribution shown for generated artifact versions. */
export function provenanceLine(
  provenance: { agent?: string; tool?: string; sourceFileIds?: string[] } | null | undefined,
): string {
  if (!provenance) return "";
  return [provenanceActor(provenance), provenanceSources(provenance)].filter(Boolean).join(" · ");
}

function provenanceActor(provenance: { agent?: string; tool?: string }): string {
  const actor = provenance.agent || provenance.tool;
  return actor ? `Written by ${actor}` : "";
}

function provenanceSources(provenance: { sourceFileIds?: string[] }): string {
  const count = provenance.sourceFileIds?.length ?? 0;
  if (count === 0) return "";
  return `from ${count} file${count === 1 ? "" : "s"}`;
}

/** Recognize both local-engine-down messages used by the backend. */
export function isOllamaDown(message: string): boolean {
  return message.includes("OLLAMA_DOWN") || message.includes("isn't running");
}
