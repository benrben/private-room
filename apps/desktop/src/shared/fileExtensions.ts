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
  if (["pdf", "ai"].includes(ext)) return "PDF";
  if (["md", "markdown"].includes(ext)) return "note";
  if (["csv", "tsv", "xlsx", "xls", "ods"].includes(ext)) return "sheet";
  if (["json", "jsonl", "ndjson"].includes(ext)) return "data";
  if (isScriptExtension(ext)) return "script";
  if (isCodeTextExtension(ext)) return "code";
  if (["docx", "doc"].includes(ext)) return "document";
  if (["html", "htm"].includes(ext)) return "HTML";
  if (["pptx", "ppt", "odp"].includes(ext)) return "presentation";
  if (["epub", "mobi", "azw", "azw3", "fb2", "cbz"].includes(ext)) return "book";
  if (["zip", "7z", "rar", "tar", "gz"].includes(ext)) return "archive";
  if (ext === "ipynb") return "notebook";
  if (["eml", "msg"].includes(ext)) return "message";
  if (["srt", "vtt"].includes(ext)) return "subtitles";
  if (ext === "svg") return "drawing";
  if (ext === "log") return "log";
  if (["txt", "org", "rst"].includes(ext)) return "text";
  return null;
}
