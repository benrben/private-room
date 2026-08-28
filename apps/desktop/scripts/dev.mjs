import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyRuntimeAssets } from "./copyRuntimeAssets.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stop(signal = "SIGTERM") {
  for (const child of children) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop(signal);
    process.exit(0);
  });
}

function waitForVite() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const attempt = () => {
      const request = http.get("http://127.0.0.1:1420", (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() >= deadline) reject(new Error("Vite did not become ready on port 1420."));
        else setTimeout(attempt, 100);
      });
      request.setTimeout(1_000, () => request.destroy());
    };
    attempt();
  });
}

const vite = run("npm", ["run", "dev:renderer"], { cwd: appRoot });
vite.once("exit", (code) => {
  if (code !== null && code !== 0) {
    stop();
    process.exit(code);
  }
});

await waitForVite();
const compile = run("npx", ["tsc", "-p", "tsconfig.package.json"], { cwd: appRoot });
const compiled = await new Promise((resolve) => compile.once("exit", (code) => resolve(code ?? 1)));
if (compiled !== 0) {
  stop();
  process.exit(compiled);
}
await copyRuntimeAssets({ sourceRoot: appRoot, outputRoot: path.join(appRoot, "dist_package") });

const electron = run(
  "npx",
  ["electron", "dist_package/src/main/index.js"],
  { cwd: appRoot, env: { ...process.env, ARCELLE_RENDERER_URL: "http://127.0.0.1:1420" } },
);
const exitCode = await new Promise((resolve) => electron.once("exit", (code) => resolve(code ?? 0)));
stop();
process.exit(exitCode);
