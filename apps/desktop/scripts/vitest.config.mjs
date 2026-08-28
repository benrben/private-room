// Packaging-tooling test configuration. The live `vitest.config.ts` also
// `include` to `electron/**/*.test.ts` and `cli/**/*.test.ts`, so it never
// discovers anything under `scripts/`. Per this batch's rule ("do NOT edit
// any live file directly"), that root config is left untouched; this file is
// candidate A's own way to run its packaging-tooling proofs. Folding
// `scripts/**/*.test.{ts,mjs}` into the real `vitest.config.ts` is a small,
// deliberate merge-time edit for whichever candidate is picked, not something
// to sneak in here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs", "scripts/**/*.test.ts"],
  },
});
