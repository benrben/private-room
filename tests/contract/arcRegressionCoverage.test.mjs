import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(join(here, "../.."));
const manifestPath = join(root, "tests/coverage/arc-findings.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const expectedArcIds = Array.from(
  { length: 30 },
  (_unused, index) => `ARC-${String(index + 1).padStart(3, "0")}`,
);

function javascriptTestNames(source, file) {
  const scriptKind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const names = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "test" || node.expression.text === "it")
    ) {
      const name = node.arguments[0];
      if (name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) {
        names.push(name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return names;
}

function pythonTestNames(source) {
  return Array.from(
    source.matchAll(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gmu),
    (match) => match[1],
  );
}

function isCiCollected(target) {
  if (target.framework === "node:test") {
    return /^tests\/contract\/[^/]+\.test\.mjs$/u.test(target.file);
  }
  if (target.framework === "vitest") {
    return /^apps\/desktop\/src\/[^/]+(?:\/[^/]+)*\.test\.ts$/u.test(target.file);
  }
  if (target.framework === "pytest") {
    return /^services\/agent-sidecar\/tests\/(?:[^/]+\/)*test_[^/]+\.py$/u.test(target.file);
  }
  return false;
}

test("ARC coverage manifest enumerates ARC-001 through ARC-030 exactly once", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.entries), "manifest.entries must be an array");
  const ids = manifest.entries.map((entry) => entry.arc);
  assert.deepEqual(ids, expectedArcIds, "ARC entries must be complete, unique, and numerically ordered");
  assert.equal(new Set(ids).size, expectedArcIds.length, "an ARC id may appear only once");
});

test("every ARC points to a stable E2E id and existing CI-collected contract tests", async (t) => {
  for (const entry of manifest.entries) {
    await t.test(entry.arc, () => {
      const targetKeys = new Set();
      assert.equal(typeof entry.finding, "string");
      assert.ok(entry.finding.trim().length > 0, `${entry.arc} needs a finding summary`);
      assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${entry.arc} needs test coverage`);
      assert.ok(
        entry.tests.some(
          (target) =>
            target.framework === "node:test" &&
            target.file.startsWith("tests/contract/") &&
            target.test.startsWith(`[${entry.arc}]`),
        ),
        `${entry.arc} needs its own stable [${entry.arc}] E2E regression id`,
      );

      for (const target of entry.tests) {
        assert.equal(typeof target.file, "string");
        assert.equal(typeof target.test, "string");
        assert.ok(isCiCollected(target), `${entry.arc}: ${target.file} is not collected by CI`);
        const absolute = resolve(root, target.file);
        const resolved = realpathSync(absolute);
        const repoRelative = relative(root, resolved);
        assert.ok(
          repoRelative !== ".." && !repoRelative.startsWith(`..${sep}`) && !isAbsolute(repoRelative),
          `${entry.arc}: coverage path escapes the repository`,
        );
        const source = readFileSync(resolved, "utf8");
        const declared = target.framework === "pytest"
          ? pythonTestNames(source)
          : javascriptTestNames(source, target.file);
        const occurrences = declared.filter((name) => name === target.test).length;
        assert.equal(
          occurrences,
          1,
          `${entry.arc}: missing or ambiguous test id ${target.file} :: ${target.test}`,
        );
        const key = `${target.file}\0${target.test}`;
        assert.ok(!targetKeys.has(key), `${entry.arc}: duplicate coverage target ${target.file} :: ${target.test}`);
        targetKeys.add(key);
      }
    });
  }
});
