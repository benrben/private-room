import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Hosted macOS runners can make encrypted filesystem and real-Electron
    // integration tests take more than Vitest's 5s default under contention.
    // This does not delay passing tests; it only keeps CI's failure deadline
    // proportional to the slower machine.
    testTimeout: process.env["CI"] ? 15_000 : 5_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "cli/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      include: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    },
  },
});
