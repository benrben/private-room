import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
const desktopPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const metricsScript = readFileSync(new URL("../../../scripts/quality-metrics.mjs", import.meta.url), "utf8");

describe("quality metrics coverage scope", () => {
  it("collects production source without remapping generated package copies", () => {
    expect(config).toContain('include: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"]');
  });

  it("activates the sidecar's declared test dependencies for coverage", () => {
    expect(metricsScript).toMatch(/"run",\s*"--extra",\s*"dev",\s*"--with",\s*"coverage"/);
  });

  it("uses the validated desktop coverage worker count", () => {
    expect(desktopPackage.scripts["test:unit"]).toContain("--maxWorkers 4");
  });

  it("traces only sidecar production source with the low-overhead core", () => {
    expect(metricsScript).toMatch(
      /"coverage",\s*"run",\s*"--source=src\/arcelle_sidecar"/,
    );
    expect(metricsScript).toContain('COVERAGE_CORE: "sysmon"');
  });

  it("treats functions with no executable lines as complete without excluding them", () => {
    expect(metricsScript).toContain("const coveragePercent = total === 0 ? 100");
    expect(metricsScript).toContain("coverage_percent: coveragePercent");
  });
});
