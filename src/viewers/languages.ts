/**
 * File extension → Monaco language id. The SINGLE source of truth: both the
 * code viewer (monacoSetup) and the eager viewer dispatch (ViewerRouter) read
 * it from here. It imports nothing at RUNTIME — the one import below is
 * type-only and is erased — so pulling it in never drags monaco-editor into
 * the startup bundle.
 *
 * Adding a row here also means adding that language's Monaco contribution in
 * monacoSetup.ts: the values are typed to `LANGUAGES_WITH_SYNTAX` there, so an
 * id whose contribution isn't imported fails the type-check instead of quietly
 * rendering as uncoloured plain text.
 */
import type { SyntaxLanguage } from "./monacoSetup";

export const LANGUAGE_BY_EXT: Record<string, SyntaxLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  xml: "xml",
  r: "r",
  lua: "lua",
  scala: "scala",
  pl: "perl",
};

export function languageForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}
