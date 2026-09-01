#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const desktopDirectory = path.join(projectRoot, "apps", "desktop");
const sidecarDirectory = path.join(projectRoot, "services", "agent-sidecar");
const desktopSourceDirectory = path.join(desktopDirectory, "src");
const sidecarSourceDirectory = path.join(sidecarDirectory, "src");

function parseArguments(arguments_) {
  const options = { run: false, report: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--run") options.run = true;
    if (argument === "--report") options.report = arguments_[index + 1] ?? null;
  }
  if (!options.report) throw new Error("Expected --report <path>.");
  return options;
}

function runResult(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: "pipe",
  });
}

function runAsyncResult(command, arguments_, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let error;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (childError) => {
      error = childError;
    });
    child.on("close", (status) => {
      resolve({ error, status, stdout, stderr });
    });
  });
}

function resultError(command, arguments_, result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
}

function run(command, arguments_, options = {}) {
  const result = runResult(command, arguments_, options);
  resultError(command, arguments_, result);
  return result.stdout;
}

async function runCoverage() {
  const coverageDirectory = path.join(sidecarDirectory, "coverage");
  fs.mkdirSync(coverageDirectory, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-quality-"));
  const desktopTemporaryDirectory = path.join(temporaryRoot, "desktop");
  const sidecarTemporaryDirectory = path.join(temporaryRoot, "sidecar");
  fs.mkdirSync(desktopTemporaryDirectory);
  fs.mkdirSync(sidecarTemporaryDirectory);
  const coverageData = path.join(coverageDirectory, ".quality-metrics-data");
  const uvCoverageArguments = ["run", "--extra", "dev", "--with", "coverage"];
  const pythonArguments = [
    ...uvCoverageArguments,
    "coverage",
    "run",
    "--source=src/arcelle_sidecar",
    "-m",
    "pytest",
    "-q",
  ];
  const pythonOptions = {
    cwd: sidecarDirectory,
    env: {
      COVERAGE_CORE: "sysmon",
      COVERAGE_FILE: coverageData,
      TMPDIR: sidecarTemporaryDirectory,
      TMP: sidecarTemporaryDirectory,
      TEMP: sidecarTemporaryDirectory,
    },
  };
  // The desktop and sidecar suites write distinct coverage artifacts, so run
  // both complete suites concurrently to keep the fast loop responsive.
  const [desktopResult, pythonResult] = await Promise.all([
    runAsyncResult("npm", ["run", "test:coverage"], {
      env: {
        TMPDIR: desktopTemporaryDirectory,
        TMP: desktopTemporaryDirectory,
        TEMP: desktopTemporaryDirectory,
      },
    }),
    runAsyncResult("uv", pythonArguments, pythonOptions),
  ]);
  const jsonArguments = [
    ...uvCoverageArguments,
    "coverage",
    "json",
    "-o",
    path.join("coverage", "quality-metrics.json"),
  ];
  const jsonResult = await runAsyncResult(
    "uv",
    jsonArguments,
    pythonOptions,
  );
  // Coverage data is written even when pytest finds a failure. Generate the
  // JSON before surfacing that failure so the fast loop can still report the
  // affected CRAAP functions diagnostically; certification remains blocked.
  resultError("npm", ["run", "test:coverage"], desktopResult);
  resultError("uv", pythonArguments, pythonResult);
  resultError("uv", jsonArguments, jsonResult);
}

function normalizedPath(value) {
  return value.split(path.sep).join("/");
}

function reportPath(value, sourceRoot) {
  const resolved = path.isAbsolute(value) ? path.relative(projectRoot, value) : value;
  const normalized = normalizedPath(resolved).replace(/^\.\//, "");
  return normalized.startsWith("apps/") || normalized.startsWith("services/")
    ? normalized
    : `${sourceRoot}/${normalized}`;
}

function addCoverageLine(coverage, file, line, hits) {
  if (!coverage.has(file)) coverage.set(file, new Map());
  coverage.get(file).set(line, hits);
}

function readLcov() {
  const coverage = new Map();
  const lcov = fs.readFileSync(path.join(desktopDirectory, "coverage", "lcov.info"), "utf8");
  let source = null;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) source = reportPath(line.slice(3), "apps/desktop");
    if (!source || !line.startsWith("DA:")) continue;
    const [lineNumber, hits] = line.slice(3).split(",").map(Number);
    addCoverageLine(coverage, source, lineNumber, hits);
  }
  return coverage;
}

function readPythonCoverage() {
  const coverage = new Map();
  const report = JSON.parse(
    fs.readFileSync(path.join(sidecarDirectory, "coverage", "quality-metrics.json"), "utf8"),
  );
  for (const [file, details] of Object.entries(report.files ?? {})) {
    const source = reportPath(file, "services/agent-sidecar");
    for (const line of details.missing_lines ?? []) addCoverageLine(coverage, source, line, 0);
    for (const line of details.executed_lines ?? []) addCoverageLine(coverage, source, line, 1);
  }
  return coverage;
}

function sourceFiles(directory, extensions) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(entryPath, extensions));
    if (entry.isFile() && extensions.has(path.extname(entry.name)) && !/\.(test|spec)\.[^.]+$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isFunction(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function functionName(node, source) {
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return parent.name.getText(source);
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  return "(anonymous)";
}

function isComplexityBranch(node) {
  if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCatchClause(node) || ts.isCaseClause(node) || ts.isConditionalExpression(node)) return true;
  return ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
}

function complexityOf(node) {
  let complexity = 1;
  const visit = (child) => {
    if (isFunction(child)) return;
    if (isComplexityBranch(child)) complexity += 1;
    ts.forEachChild(child, visit);
  };
  if (node.body) ts.forEachChild(node.body, visit);
  return complexity;
}

function typescriptFunctions() {
  const files = sourceFiles(desktopSourceDirectory, new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]));
  const functions = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (isFunction(node) && node.body) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        functions.push({
          path: normalizedPath(path.relative(projectRoot, file)),
          name: functionName(node, source),
          start_line: start,
          end_line: end,
          complexity: complexityOf(node),
          parser: "typescript-ast",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return functions;
}

function pythonFunctions() {
  const analyzer = path.join(scriptDirectory, "quality-python-metrics.py");
  return JSON.parse(run("python3", [analyzer, "--root", projectRoot, "--source", sidecarSourceDirectory]));
}

function addCoverage(functions, coverage) {
  return functions.map((function_) => {
    const lineHits = coverage.get(function_.path) ?? new Map();
    let covered = 0;
    let total = 0;
    for (const [line, hits] of lineHits) {
      if (line < function_.start_line || line > function_.end_line) continue;
      total += 1;
      if (hits > 0) covered += 1;
    }
    // A Protocol/type declaration can be a real production function-shaped
    // node while containing no executable statements. It has no missed lines,
    // so keep it in the metric and report the executable-line goal as complete.
    const coveragePercent = total === 0 ? 100 : (100 * covered) / total;
    return {
      ...function_,
      covered_lines: covered,
      total_lines: total,
      coverage_percent: coveragePercent,
    };
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.run) await runCoverage();
  const coverage = new Map([...readLcov(), ...readPythonCoverage()]);
  const functions = addCoverage([...typescriptFunctions(), ...pythonFunctions()], coverage);
  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.report, `${JSON.stringify({ functions })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
