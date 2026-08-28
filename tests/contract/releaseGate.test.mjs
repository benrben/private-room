/* Does cutting a release actually CHECK anything first?
 *
 * Electron and sidecar metadata must agree before any artifact is built.
 *
 * So the release script runs the fast half itself. This pins that it still
 * does, and that it does so BEFORE anything is built, signed or uploaded —
 * a check that runs after the assets are on the release is not a check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sh = readFileSync(join(root, "scripts/release.sh"), "utf8");

const lineOf = (re, what) => {
  const i = sh.split("\n").findIndex((l) => !l.trimStart().startsWith("#") && re.test(l));
  assert.notEqual(i, -1, `${what} is gone from scripts/release.sh`);
  return i;
};

test("release.sh gates on the preflight checks", () => {
  // `set -euo pipefail` is what turns a non-zero preflight into a stopped
  // release; without it the script would print the failures and carry on.
  assert.match(sh, /^set -euo pipefail$/m, "a failing check would no longer abort");
  lineOf(/scripts\/preflight\.sh/, "the preflight call");
});

test("the checks run before anything is built or published", () => {
  const preflight = lineOf(/scripts\/preflight\.sh/, "the preflight call");
  const build = lineOf(/npm run package:mac/, "the app build");
  const sidecar = lineOf(/build-sidecar\.sh/, "the sidecar build");
  const publish = lineOf(/gh release (create|upload)/, "the release upload");
  assert.ok(preflight < sidecar, "the sidecar is built before the version is checked");
  assert.ok(preflight < build, "the app is built before the version is checked");
  assert.ok(preflight < publish, "assets are published before the version is checked");
});

test("the preflight it calls really compares every version site", () => {
  // The gate delegates to the tested Electron version checker.
  const pf = readFileSync(join(root, "scripts/preflight.sh"), "utf8");
  for (const site of [
    "@arcelle/desktop",
    "check:versions",
  ]) {
    assert.ok(pf.includes(site), `${site} is not compared by the preflight`);
  }
});

test("release resource defaults stay absolute when npm changes into the Electron package", () => {
  assert.match(sh, /^ROOT="\$\(pwd -P\)"$/m, "release root is not captured as an absolute path");
  assert.match(
    sh,
    /^MODELS="\$\{ARCELLE_MODELS_DIR:-\$\{ROOT\}\/\$\{APP_DIR\}\/resources\/models\}"$/m,
    "the bundled model default can be resolved from the Electron package working directory",
  );
  assert.match(
    sh,
    /^SIDECAR="\$\{ARCELLE_SIDECAR_STAGE_DIR:-\$\{ROOT\}\/services\/agent-sidecar\/dist\/arcelle-sidecar\}"$/m,
    "the bundled sidecar default can be resolved from the Electron package working directory",
  );
  assert.match(
    sh,
    /ARCELLE_MODELS_DIR="\$MODELS"[\s\\]+ARCELLE_SIDECAR_STAGE_DIR="\$SIDECAR" npm run package:mac/,
    "the validated absolute resources are not passed to the package build",
  );
});
