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
// Added with the extensions the app already accepted but rendered uncoloured.
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution.js"; // id "proto"
import "monaco-editor/esm/vs/basic-languages/restructuredtext/restructuredtext.contribution.js";
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
  "dockerfile",
  "go",
  "graphql",
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
  "proto",
  "python",
  "r",
  "restructuredtext",
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

/** The editor's own monospace stack.
 *
 * Monaco takes a font as a STRING, once, at construction — it cannot read a
 * CSS custom property, so `var(--mono)` is not available to it and this list
 * has to be spelled out. Keep it identical to `--mono` in tokens.css: a code
 * file rendered in the editor and the same file quoted in a chat answer must
 * not be set in two different faces.
 *
 * IBM Plex Mono is bundled (src/assets/fonts), so it arrives as a webfont
 * rather than from the system — which is exactly why `remeasureFonts()` is
 * called below once `document.fonts` says it has landed. */
export const EDITOR_FONT =
  '"IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

/** The syntax palette, in the product's own five marker inks.
 *
 * Monaco's stock `vs` / `vs-dark` are a different product's palette sitting
 * inside this one, and one of their colours does not carry: the light theme's
 * comment green (#008000) measures 4.13:1 on the editor's ground and fails
 * WCAG 1.4.3 outright. So both themes are defined here instead, from the same
 * tokens the rest of the app draws with — keyword takes the pink pen, strings
 * the green, numbers the yellow, types the blue, patterns the red, and a
 * comment is pencil. Every value below was measured against its own editor
 * background; the lowest in either theme is 4.95:1.
 *
 * The hexes are literals for the same reason the font is: this is a JS object
 * handed to monaco, not a stylesheet. They are the resolved values of
 * --mk-*-ink / --ink* in tokens.css; change one there and change it here. */
const THEMES: Record<
  "arcelle-dark" | "arcelle-light",
  { base: "vs" | "vs-dark"; ink: Record<string, string>; ui: Record<string, string> }
> = {
  "arcelle-dark": {
    base: "vs-dark",
    ink: {
      comment: "8f958c", // pencil. 5.87:1
      keyword: "d1849a", // --mk-pink-ink. 6.41:1
      string: "79a47d", // --mk-green-ink. 6.36:1
      number: "baa457", // --mk-yellow-ink. 7.32:1
      type: "73a0bc", // --mk-blue-ink. 6.42:1
      regexp: "cf8883", // --mk-red-ink. 6.43:1
      operator: "a9ada3", // --ink-2. 7.88:1
    },
    ui: {
      page: "#151716",
      ink: "#f0eee5",
      gutter: "#959a92",
      hover: "#2e322e",
      accent: "#d1849a",
      selection: "#c77a9040",
      rule: "#3d413c",
    },
  },
  "arcelle-light": {
    base: "vs",
    ink: {
      comment: "666960", // pencil, --ink-muted. 4.95:1
      keyword: "ba3350", // --mk-pink-ink. 5.06:1
      string: "447142", // --mk-green-ink. 5.04:1
      number: "786420", // --mk-yellow-ink. 5.10:1
      type: "366b8d", // --mk-blue-ink. 5.10:1
      regexp: "b53c32", // --mk-red-ink. 5.08:1
      operator: "5a5d54", // --ink-2. 5.94:1
    },
    ui: {
      page: "#f4f1e8",
      ink: "#20221f",
      gutter: "#666960",
      hover: "#ebe7da",
      accent: "#ba3350",
      selection: "#e9a4b355",
      rule: "#d8d3c4",
    },
  },
};

let defined = false;

/** Register both themes once. Monaco keeps themes in a global registry, so
 * this is idempotent by intent — every editor calls it before construction and
 * only the first call does any work. */
function defineThemes(): void {
  if (defined) return;
  defined = true;
  for (const [name, t] of Object.entries(THEMES)) {
    monaco.editor.defineTheme(name, {
      base: t.base,
      inherit: true,
      rules: [
        { token: "comment", foreground: t.ink.comment, fontStyle: "italic" },
        { token: "keyword", foreground: t.ink.keyword },
        { token: "keyword.json", foreground: t.ink.keyword },
        { token: "metatag", foreground: t.ink.keyword },
        { token: "tag", foreground: t.ink.keyword },
        { token: "string", foreground: t.ink.string },
        { token: "string.value.json", foreground: t.ink.string },
        { token: "attribute.value", foreground: t.ink.string },
        { token: "number", foreground: t.ink.number },
        { token: "constant", foreground: t.ink.number },
        { token: "type", foreground: t.ink.type },
        { token: "type.identifier", foreground: t.ink.type },
        { token: "attribute.name", foreground: t.ink.type },
        { token: "string.key.json", foreground: t.ink.type },
        { token: "key", foreground: t.ink.type },
        { token: "regexp", foreground: t.ink.regexp },
        { token: "delimiter", foreground: t.ink.operator },
        { token: "operator", foreground: t.ink.operator },
      ],
      colors: {
        "editor.background": t.ui.page,
        "editor.foreground": t.ui.ink,
        "editorGutter.background": t.ui.page,
        "editorLineNumber.foreground": t.ui.gutter,
        "editorLineNumber.activeForeground": t.ui.ink,
        "editor.lineHighlightBackground": t.ui.hover,
        "editor.selectionBackground": t.ui.selection,
        "editorCursor.foreground": t.ui.accent,
        "editorIndentGuide.background": t.ui.rule,
        "editorIndentGuide.activeBackground": t.ui.gutter,
        "editorWidget.background": t.ui.page,
        "editorWidget.border": t.ui.rule,
        "input.background": t.ui.page,
        "input.foreground": t.ui.ink,
        // Bracket-pair colouring, flattened to the delimiter ink.
        //
        // `inherit: true` brought the stock six-hue nesting palette with it,
        // and its light values do not carry: the rendered audit measured
        // `bracket-highlighting-1` at 3.48:1 on the ivory ground, a fail of
        // WCAG 1.4.3 on characters that are part of the code. Six hues is also
        // an IDE affordance for writing deeply nested expressions, which is
        // not what a read-mostly viewer is for — a bracket is a delimiter, so
        // it takes the delimiter's ink like every other one.
        //
        // A bracket with no partner keeps a colour of its own, in the red that
        // means "wrong" everywhere else in the product. That one IS a finding.
        ...Object.fromEntries(
          [1, 2, 3, 4, 5, 6].map((n) => [
            `editorBracketHighlight.foreground${n}`,
            `#${t.ink.operator}`,
          ]),
        ),
        "editorBracketHighlight.unexpectedBracket.foreground": `#${t.ink.regexp}`,
      },
    });
  }
}

/** The Monaco theme matching the app's own light/dark switch (src/theme.ts
 * stamps `data-theme` on <html>). Without this the editor, both compare views
 * and the diff preview stay black panes in an otherwise white window. */
export function monacoTheme(): "arcelle-dark" | "arcelle-light" {
  defineThemes();
  return document.documentElement.dataset.theme === "light"
    ? "arcelle-light"
    : "arcelle-dark";
}

/** Re-measure the glyph box once the bundled monospace face has actually
 * arrived.
 *
 * Monaco measures a character cell at construction and lays every line out on
 * that number. `--mono` is a bundled webfont with `font-display: block`, so on
 * a cold start the editor can be built while the face is still loading, lay
 * itself out against the fallback, and then have the real face swap in
 * underneath a grid that no longer fits it — which paints as overlapping
 * glyphs along the top rows. Live QA saw exactly that on the first open of a
 * .js file. `remeasureFonts` is monaco's own answer and is safe to call at any
 * time; `document.fonts.ready` has usually already resolved, in which case
 * this costs one microtask.
 *
 * Returns a promise so a caller can also correct its scroll position after the
 * relayout — the same swap can leave the first line pushed off the top. */
export function remeasureWhenFontReady(): Promise<void> {
  const ready = document.fonts?.ready;
  if (!ready) {
    monaco.editor.remeasureFonts();
    return Promise.resolve();
  }
  return ready.then(() => {
    monaco.editor.remeasureFonts();
  });
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
