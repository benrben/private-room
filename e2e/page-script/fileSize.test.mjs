/* AUDIT 250: one human file size for the whole app.
 *
 * There were four. The shared one stopped at MB, so a 2 GB recording read
 * "2048.0 MB"; the checkpoints screen, the cloud preview and the Skills
 * resource list each printed sizes their own way, so the same file read
 * differently depending which screen you were on.
 *
 * `formatSize` (src/api.ts) is now the one for BYTES. The cloud preview joined
 * it: its private `fmtSize` measured JS string length — UTF-16 code units —
 * and printed the answer as KB, so a Hebrew or Chinese document shown as
 * "40 KB" was really 80 KB or more on the wire. It now encodes to UTF-8 first
 * and formats with this same function.
 *
 * Extracted with a regex rather than imported: src/api.ts pulls in the Tauri
 * bridge at module load, which does not exist under node.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const API = readFileSync(join(root, "src/api.ts"), "utf8");
const fn = API.slice(
  API.indexOf("export function formatSize"),
  API.indexOf("export type FileKind"),
);
const JS = ts.transpileModule(fn, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { formatSize } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

test("it carries on past MB", () => {
  // The reported symptom: a 2 GB recording that read "2048.0 MB".
  assert.equal(formatSize(2 * 1024 ** 3), "2.0 GB");
  assert.equal(formatSize(1024 ** 3), "1.0 GB");
});

test("the smaller units are unchanged", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
});

test("the screens that rolled their own now use it", () => {
  // Checkpoints and the Skills resource list each had a private formatter;
  // a second one is how "2048.0 MB" survived being fixed in one place.
  const ck = readFileSync(join(root, "src/settings/CheckpointsSection.tsx"), "utf8");
  assert.ok(!/function formatBytes/.test(ck), "CheckpointsSection kept a private formatter");
  assert.match(ck, /formatSize\(/);
  const skills = readFileSync(join(root, "src/workspace/skills/SkillsView.tsx"), "utf8");
  assert.ok(
    !/Math\.ceil\(r\.sizeBytes \/ 1024\)/.test(skills),
    "the Skills resource list is printing KB by hand again",
  );
});

test("the cloud preview sizes the payload in UTF-8 bytes, not characters", () => {
  // "What the cloud sees" is a trust screen: understating a Hebrew or Chinese
  // document's size by half is the headline number lying.
  const cloud = readFileSync(join(root, "src/viewers/CloudView.tsx"), "utf8");
  assert.ok(
    !/preview\.text\.length/.test(cloud),
    "CloudView is measuring the payload with String.length (UTF-16 units) again",
  );
  assert.match(cloud, /new TextEncoder\(\)\.encode\(text\)\.length/);
  assert.match(cloud, /formatSize\(/);
  // And the units it can print are the shared ones — no bare "characters".
  assert.ok(
    !/characters`/.test(cloud),
    "CloudView is calling a byte count 'characters' again",
  );
});
