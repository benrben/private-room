/* ART-1: the attribution line under a version in the Time Machine strip.
 *
 * "Ask before AI edits files" is OFF by the owner's decision, so the History
 * strip is where a person finds out that an AI wrote — or rewrote — a document.
 * That makes two things load-bearing about this one string:
 *
 *   * it must appear when the room WITNESSED an AI write, and
 *   * it must be absent otherwise, including for a version the room recorded
 *     nothing about. A line that showed up for every version would stop
 *     carrying the information, and a line that guessed would be a fabrication
 *     in the one place a person goes to check.
 *
 * Runs against the REAL TypeScript source, type-stripped in memory (the trick
 * filelabel.test.mjs uses), so there is no compiled copy to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const { provenanceLine } = await load("src/workspace/composer.ts");

test("a witnessed AI write names who wrote it and how much it read", () => {
  assert.equal(
    provenanceLine({ agent: "#minutes", sourceFileIds: ["a", "b"] }),
    "Written by #minutes · from 2 files",
  );
  assert.equal(
    provenanceLine({ agent: "#summarize", sourceFileIds: ["a"] }),
    "Written by #summarize · from 1 file",
  );
});

test("the tool stands in when no agent was recorded", () => {
  assert.equal(provenanceLine({ tool: "create_file" }), "Written by create_file");
});

test("nothing recorded means NO line — never an empty attribution", () => {
  // A person's own save, and every version written before provenance existed.
  assert.equal(provenanceLine(null), "");
  assert.equal(provenanceLine(undefined), "");
  assert.equal(provenanceLine({}), "");
  // A run id alone identifies the write for support; it tells a reader nothing,
  // so it does not earn a line on its own.
  assert.equal(provenanceLine({ runId: "ask-1" }), "");
});

test("source files are counted, never named", () => {
  // Their names are room content; the strip has no need of them, so they must
  // not be able to leak into it via provenance.
  const line = provenanceLine({
    agent: "#extract",
    sourceFileIds: ["id-1", "id-2", "id-3"],
  });
  assert.equal(line, "Written by #extract · from 3 files");
  assert.ok(!line.includes("id-1"));
});
