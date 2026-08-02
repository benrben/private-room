/**
 * Monaco, trimmed to what this app can actually reach.
 *
 * Importing the `monaco-editor` barrel pulls in syntax definitions for ~90
 * languages (ABAP, Apex, Bicep, CameLIGO, ECL, Flow9, FreeMarker …) plus the
 * TypeScript/CSS/HTML *language services* — a multi-megabyte type-checker
 * whose whole job is live diagnostics and autocomplete, which this read-mostly
 * viewer never offers. LANGUAGE_BY_EXT names about thirty extensions, so the
 * rest could never be reached: dead weight in every download and every
 * auto-update.
 *
 * So we assemble it by hand instead:
 *   • editor.api          — the typed API surface;
 *   • edcore.main         — every EDITOR contribution (find, folding, context
 *                           menu, multi-cursor, the diff editor …), i.e. the
 *                           whole editor experience, minus the language packs;
 *   • language/json       — JSON is the one mapped language with no basic
 *                           tokenizer, so its (small) service stays;
 *   • basic-languages/*   — exactly the languages LANGUAGE_BY_EXT can name.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/edcore.main.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"; // c + cpp
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";

export { languageForFile } from "./languages";

/**
 * Exactly the language ids the contributions imported above register — the
 * other half of the cross-check `languages.ts` describes. LANGUAGE_BY_EXT is
 * typed to this union, so mapping an extension to a language whose
 * contribution isn't imported is a TYPE ERROR (`npx tsc --noEmit`) instead of
 * plain, uncoloured text that nothing catches. Add the import line above and
 * the id here together.
 */
export const LANGUAGES_WITH_SYNTAX = [
  "c",
  "cpp",
  "csharp",
  "css",
  "go",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "less",
  "lua",
  "markdown",
  "perl",
  "php",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "scss",
  "shell",
  "sql",
  "swift",
  "typescript",
  "xml",
  "yaml",
] as const;

/** A language id this build can actually colour. */
export type SyntaxLanguage = (typeof LANGUAGES_WITH_SYNTAX)[number];

// Everything runs from bundled assets — no CDN, in keeping with the app's
// fully-local promise. JSON is the only language service still loaded, so it
// is the only non-default worker label that can be asked for.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === "json" ? new jsonWorker() : new editorWorker();
  },
};

/** The Monaco theme matching the app's own light/dark switch (src/theme.ts
 * stamps `data-theme` on <html>). Without this the editor, both compare views
 * and the diff preview stay black panes in an otherwise white window. */
export function monacoTheme(): "vs" | "vs-dark" {
  return document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark";
}

/** Apply the current theme and keep applying it as the user toggles. Monaco's
 * setTheme is global (all editors follow), so every mounted editor calling
 * this is harmless. Returns the unsubscribe, so it can be used directly as a
 * `useEffect` body. */
export function watchMonacoTheme(): () => void {
  monaco.editor.setTheme(monacoTheme());
  const obs = new MutationObserver(() => monaco.editor.setTheme(monacoTheme()));
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => obs.disconnect();
}

export default monaco;
