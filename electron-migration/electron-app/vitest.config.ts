import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts", "cli/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
