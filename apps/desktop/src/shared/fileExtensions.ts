/**
 * The one language-neutral registry for normal text files Arcelle can read and
 * edit directly. Both the Electron host and the React library import this
 * module; adding a format in one surface can no longer leave the other saying
 * "File" or routing it through Quick Look.
 */
const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "json", "jsonl", "ndjson", "csv", "tsv", "log", "xml", "yml",
  "yaml", "toml", "ini", "rs", "py", "js", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp",
  "cs", "go", "rb", "php", "swift", "kt", "sh", "zsh", "bash", "sql", "r", "m", "scala", "lua",
  "pl", "css", "scss", "less", "vue", "svelte", "tex", "org", "rst", "diff", "patch",
  "dockerfile", "graphql", "gql", "proto", "properties", "env", "gitignore", "cfg", "conf",
] as const;

const TEXT_EXTENSION_SET: ReadonlySet<string> = new Set(TEXT_EXTENSIONS);

export function sharedTextExtensions(): readonly string[] {
  return [...TEXT_EXTENSIONS];
}

/** Extensions which are source programs rather than configuration/markup. */
export const SCRIPT_EXTENSIONS = [
  "rs", "py", "js", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp", "cs", "go", "rb",
  "php", "swift", "kt", "sh", "zsh", "bash", "sql", "r", "m", "scala", "lua", "pl", "vue",
  "svelte",
] as const;

const SCRIPT_EXTENSION_SET: ReadonlySet<string> = new Set(SCRIPT_EXTENSIONS);

/** Text formats with a purpose-built viewer instead of Monaco. */
const SPECIAL_TEXT_EXTENSION_SET: ReadonlySet<string> = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log",
]);

const EARLY_FILE_LABELS: ReadonlyMap<string, string> = new Map([
  ["pdf", "PDF"], ["ai", "PDF"],
  ["md", "note"], ["markdown", "note"],
  ["csv", "sheet"], ["tsv", "sheet"], ["xlsx", "sheet"], ["xls", "sheet"], ["ods", "sheet"],
  ["json", "data"], ["jsonl", "data"], ["ndjson", "data"],
]);

const LATE_FILE_LABELS: ReadonlyMap<string, string> = new Map([
  ["docx", "document"], ["doc", "document"],
  ["html", "HTML"], ["htm", "HTML"],
  ["pptx", "presentation"], ["ppt", "presentation"], ["odp", "presentation"],
  ["epub", "book"], ["mobi", "book"], ["azw", "book"], ["azw3", "book"], ["fb2", "book"], ["cbz", "book"],
  ["zip", "archive"], ["7z", "archive"], ["rar", "archive"], ["tar", "archive"], ["gz", "archive"],
  ["ipynb", "notebook"],
  ["eml", "message"], ["msg", "message"],
  ["srt", "subtitles"], ["vtt", "subtitles"],
  ["svg", "drawing"],
  ["log", "log"],
  ["txt", "text"], ["org", "text"], ["rst", "text"],
]);

export function isTextExtension(extension: string): boolean {
  return TEXT_EXTENSION_SET.has(extension.toLowerCase());
}

export function isScriptExtension(extension: string): boolean {
  return SCRIPT_EXTENSION_SET.has(extension.toLowerCase());
}

/** True when a recognized text format should open in the Monaco code viewer. */
export function isCodeTextExtension(extension: string): boolean {
  const normalized = extension.toLowerCase();
  return TEXT_EXTENSION_SET.has(normalized) && !SPECIAL_TEXT_EXTENSION_SET.has(normalized);
}

/** Human Library-row label for an extension, after MIME-level media checks. */
export function fileExtensionLabel(extension: string): string | null {
  const ext = extension.toLowerCase();
  const early = EARLY_FILE_LABELS.get(ext);
  if (early !== undefined) return early;
  if (isScriptExtension(ext)) return "script";
  if (isCodeTextExtension(ext)) return "code";
  return LATE_FILE_LABELS.get(ext) ?? null;
}
