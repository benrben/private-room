import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "cli/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      include: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    },
  },
});
