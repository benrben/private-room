#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const desktopSourceDirectory = path.join(projectRoot, "apps", "desktop", "src");
const sidecarSourceDirectory = path.join(projectRoot, "services", "agent-sidecar", "src");
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function reportPath(value) {
  return path.relative(projectRoot, value).split(path.sep).join("/");
}

function parseArguments(arguments_) {
  const reportIndex = arguments_.indexOf("--report");
  const report = arguments_[reportIndex + 1];
  if (!report) throw new Error("Expected --report <path>.");
  return { report };
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(entryPath));
    if (entry.isFile() && sourceExtensions.includes(path.extname(entry.name)) && !/\.(test|spec)\.[^.]+$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function resolveLocalImport(source, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(source), specifier);
  const withoutRuntimeExtension = base.replace(/\.(?:[cm]?js)$/, "");
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${withoutRuntimeExtension}${extension}`),
    ...sourceExtensions.map((extension) => path.join(withoutRuntimeExtension, `index${extension}`)),
  ];
  return candidates.find((candidate) => knownFiles.has(reportPath(candidate))) ?? null;
}

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const reference = node.moduleSpecifier;
    return reference && ts.isStringLiteral(reference) ? reference.text : null;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return expression && ts.isStringLiteral(expression) ? expression.text : null;
  }
  if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    return isRequire || isDynamicImport ? node.arguments[0].text : null;
  }
  return null;
}

function typescriptEdges() {
  const files = sourceFiles(desktopSourceDirectory);
  const knownFiles = new Set(files.map(reportPath));
  const edges = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const specifier = moduleSpecifier(node);
      const target = specifier && resolveLocalImport(file, specifier, knownFiles);
      if (target) {
        edges.push({
          from: reportPath(file),
          to: reportPath(target),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return edges;
}

function pythonEdges() {
  const script = path.join(scriptDirectory, "quality-python-dependencies.py");
  const result = spawnSync("python3", [script, "--root", projectRoot, "--source", sidecarSourceDirectory], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "Python dependency analysis failed.");
  return JSON.parse(result.stdout);
}

function main() {
  const { report } = parseArguments(process.argv.slice(2));
  const edges = [...typescriptEdges(), ...pythonEdges()];
  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.from}:${edge.line}:${edge.to}`, edge])).values()];
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, `${JSON.stringify({ edges: uniqueEdges })}\n`);
}

main();
