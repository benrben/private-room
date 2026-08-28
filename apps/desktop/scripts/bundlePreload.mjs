#!/usr/bin/env node

/**
 * Electron sandboxed preloads do not have an ESM loader and their restricted
 * CommonJS `require` cannot load a graph of local modules. Bundle the complete
 * bridge and its static allowlists into one CommonJS file, leaving `electron`
 * external so Electron's sandbox loader supplies its restricted renderer API.
 */
import { build } from "esbuild";

const outfile = process.env.ARCELLE_PRELOAD_OUTFILE || "dist_package/src/preload/index.cjs";

await build({
  entryPoints: ["src/preload/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
  logLevel: "warning",
});

process.stdout.write(`Bundled sandboxed preload into ${outfile}.\n`);
