import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../visual/qaround.mjs"), "utf8");

test("the browser-context capture uses the live agent-open route, not Home-only tabs", () => {
  const start = source.indexOf('it("a file opened from the browser');
  const end = source.indexOf('it("many open tabs', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const scenario = source.slice(start, end);

  assert.match(scenario, /goArea\("browser"\)/);
  assert.match(scenario, /\.browser-area/);
  assert.match(scenario, /__qaEmit\?\.\("agent-open-file", \{ id: "f-ideas" \}\)/);
  assert.doesNotMatch(scenario, /\$\("\.tab"\)\.waitForExist/);
  assert.doesNotMatch(scenario, /browser\.keys\(\["Alt", "Meta", "1"\]\)/);
  assert.match(scenario, /rail-button\[data-area=\\?"browser\\?"\]/);
  assert.doesNotMatch(scenario, /\.crumb-back/);
});
