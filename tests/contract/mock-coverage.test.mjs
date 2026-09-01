/* Runs the frontend ↔ host ↔ qa-mock drift checker as a test.
 *
 * `tests/support/check-mock-coverage.mjs` exits 1 when the frontend invokes a Tauri
 * command the host does not register, or when qa-mock.js fakes one Rust no
 * longer has. That is exactly how `save_page` → `browse_save` slipped through:
 * the browser harness kept answering the old name and stayed green while the
 * shipped build broke. The checker was written to catch it but nothing ran it
 * — no npm script, no preflight step, no CI step — so a rename today would
 * still go green everywhere.
 *
 * Hanging it off `npm run test:page` covers all three at once: `npm test`
 * (preflight --suites), a full `scripts/preflight.sh`, and the frontend CI job.
 * The fixture gap it also reports is a number to watch, not a failure — the
 * checker's own exit code is the contract, so this asserts nothing more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("no frontend/host/qa-mock command drift", () => {
  const run = spawnSync(
    process.execPath,
    [join(root, "tests/support/check-mock-coverage.mjs"), "--bridge=electron"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    run.status,
    0,
    `tests/support/check-mock-coverage.mjs failed — run it for the full list:\n${run.stdout}${run.stderr}`,
  );
});

test("Electron command coverage follows interfaces extended by the facade", () => {
  const fixture = fs.mkdtempSync(join(os.tmpdir(), "electron-mock-coverage-"));
  const write = (relativePath, contents) => {
    const target = join(fixture, relativePath);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };

  try {
    write(
      "apps/desktop/src/shared/ipc-contract.ts",
      `import type { RoomCommands } from "./ipcRoomCommands.js";\n\n` +
        `export interface Commands extends RoomCommands {}\n`,
    );
    write(
      "apps/desktop/src/shared/ipcRoomCommands.ts",
      `export interface RoomCommands {\n  list_things: { args: {}; result: string[] };\n}\n`,
    );
    write("tests/support/qa-mock.js", `const commands = {\n    list_things: () => [],\n};\n`);

    const run = spawnSync(
      process.execPath,
      [join(root, "tests/support/check-mock-coverage.mjs"), "--bridge=electron"],
      {
        encoding: "utf8",
        env: { ...process.env, MOCK_COVERAGE_ROOT: fixture },
      },
    );
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /ipc-contract\.ts commands : 1/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
