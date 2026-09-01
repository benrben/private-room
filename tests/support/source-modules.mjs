import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const repoRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function insideRepo(file) {
  const relative = path.relative(repoRoot, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function repoPath(relativeOrAbsolute) {
  const unresolved = path.resolve(repoRoot, relativeOrAbsolute);
  if (!insideRepo(unresolved)) throw new Error(`${relativeOrAbsolute} is outside the repository`);
  const file = realpathSync(unresolved);
  if (!insideRepo(file)) throw new Error(`${relativeOrAbsolute} resolves outside the repository`);
  return file;
}

export function readRepoFile(relativeOrAbsolute) {
  return readFileSync(repoPath(relativeOrAbsolute), "utf8");
}

function sourceCandidates(base, specifier) {
  const extension = path.extname(specifier);
  if (CODE_EXTENSIONS.has(extension)) {
    const stem = base.slice(0, -extension.length);
    return extension === ".js"
      ? [stem + ".ts", stem + ".tsx", base]
      : [base];
  }
  if (extension) return [];
  return [
    base,
    ...SOURCE_EXTENSIONS.map((candidate) => base + candidate),
    ...SOURCE_EXTENSIONS.map((candidate) => path.join(base, `index${candidate}`)),
  ];
}

/** Resolve the source module named by a relative ESM specifier.
 *
 * TypeScript sources in this repository use emitted `.js` specifiers. The
 * source-side resolver therefore checks the corresponding `.ts`/`.tsx` files
 * before a literal `.js` sibling. Bare packages and non-code assets are not
 * source modules and return null. */
export function resolveLocalSource(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(repoPath(importer)), specifier);
  for (const candidate of sourceCandidates(base, specifier)) {
    if (!insideRepo(candidate)) throw new Error(`${specifier} from ${importer} is outside the repository`);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const resolved = realpathSync(candidate);
      if (!insideRepo(resolved)) throw new Error(`${specifier} from ${importer} resolves outside the repository`);
      return resolved;
    }
  }
  return null;
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function localSpecifiers(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const specifiers = [];
  for (const statement of tree.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Read a deterministic, cycle-safe map of one module and its relative code
 * imports/re-exports. The entry itself is always the first item. */
export function sourceGraph(entry) {
  const graph = new Map();

  function visit(file) {
    const resolved = repoPath(file);
    if (graph.has(resolved)) return;
    const source = readFileSync(resolved, "utf8");
    graph.set(resolved, source);
    for (const specifier of localSpecifiers(resolved, source)) {
      const imported = resolveLocalSource(resolved, specifier);
      if (imported) visit(imported);
    }
  }

  visit(entry);
  return graph;
}

function annotatedSource(files) {
  return [...files]
    .map(([file, source]) => `\n// ===== source: ${path.relative(repoRoot, file)} =====\n${source}`)
    .join("\n");
}

/** Concatenate explicit source entries for positive contract assertions.
 * JavaScript and TypeScript entries contribute their import/re-export closure;
 * other source types, including Python and CSS, are included as leaves. */
export function readSourceModules(entries) {
  const files = new Map();
  for (const entry of entries) {
    const resolved = repoPath(entry);
    const sources = CODE_EXTENSIONS.has(path.extname(resolved))
      ? sourceGraph(resolved)
      : new Map([[resolved, readFileSync(resolved, "utf8")]]);
    for (const [file, source] of sources) files.set(file, source);
  }
  return annotatedSource(files);
}

/** Concatenate a source graph for positive reachability assertions. Filename
 * boundaries keep failures attributable after implementation files split. */
export function readReachableSource(entry) {
  return readSourceModules([entry]);
}

function importedBindings(statement) {
  const names = [];
  let hasDefault = false;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    hasDefault = Boolean(clause?.name);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        names.push((binding.propertyName ?? binding.name).text);
      }
    }
  } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const binding of statement.exportClause.elements) {
      names.push((binding.propertyName ?? binding.name).text);
    }
  }
  return { names, hasDefault };
}

function dataModule(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function stubModule(bindings, overrides = {}) {
  const { names, hasDefault } = bindings;
  return dataModule(
    [
      "const inert = () => null;",
      ...names.map((name) => `export const ${name} = ${overrides[name] ?? "inert"};`),
      hasDefault ? "export default inert;" : "",
    ].join("\n"),
  );
}

/** Build an importable data URL for real TypeScript/TSX source.
 *
 * `bare` maps packages such as React to importable URLs. `stubs` maps absolute
 * or repository-relative source paths to JavaScript expressions for selected
 * named exports; an empty map entry produces inert bindings. `append` can
 * expose a private declaration to a focused test without changing production. */
export function loadTypescriptModule(
  entry,
  { bare = {}, stubs = new Map(), append = new Map() } = {},
) {
  const normalizedStubs = new Map(
    [...stubs].map(([file, overrides]) => [repoPath(file), overrides]),
  );
  const normalizedAppend = new Map(
    [...append].map(([file, source]) => [repoPath(file), source]),
  );
  const cache = new Map();
  const loading = new Set();

  function load(file) {
    const resolved = repoPath(file);
    const cached = cache.get(resolved);
    if (cached) return cached;
    if (loading.has(resolved)) {
      throw new Error(`cyclic TypeScript module graph at ${path.relative(repoRoot, resolved)}`);
    }
    loading.add(resolved);

    try {
      const jsx = resolved.endsWith(".tsx") || resolved.endsWith(".jsx");
      let javascript = ts.transpileModule(readFileSync(resolved, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
        },
      }).outputText;

      const tree = ts.createSourceFile(
        resolved,
        javascript,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const replacements = [];
      for (const statement of tree.statements) {
        if (
          !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteralLike(statement.moduleSpecifier)
        ) continue;

        const specifier = statement.moduleSpecifier.text;
        if (ts.isImportDeclaration(statement) && !statement.importClause && specifier.endsWith(".css")) {
          replacements.push({
            start: statement.getStart(tree),
            end: statement.getEnd(),
            text: "",
          });
          continue;
        }

        const bindings = importedBindings(statement);
        let url;
        if (bare[specifier]) {
          url = bare[specifier];
        } else if (!specifier.startsWith(".")) {
          throw new Error(`bare import ${JSON.stringify(specifier)} needs an explicit mapping`);
        } else {
          const imported = resolveLocalSource(resolved, specifier);
          if (!imported) throw new Error(`cannot resolve ${specifier} from ${resolved}`);
          const stub = normalizedStubs.get(imported);
          url = stub !== undefined ? stubModule(bindings, stub) : load(imported);
        }
        replacements.push({
          start: statement.moduleSpecifier.getStart(tree),
          end: statement.moduleSpecifier.getEnd(),
          text: JSON.stringify(url),
        });
      }
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        javascript = javascript.slice(0, replacement.start) + replacement.text + javascript.slice(replacement.end);
      }

      javascript += normalizedAppend.get(resolved) ?? "";
      const url = dataModule(javascript);
      cache.set(resolved, url);
      return url;
    } finally {
      loading.delete(resolved);
    }
  }

  return load(entry);
}
