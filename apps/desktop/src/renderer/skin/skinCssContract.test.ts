import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");

describe("skin CSS contract", () => {
  it("keeps room folders on the translucent material instead of opaque surfaces", () => {
    const folders = styles("sidebar-folders.css");
    expect(folders).toMatch(/\.folder-group\s*\{[^}]*background:\s*transparent/s);
    expect(folders).toMatch(/\.folder-head:hover\s*\{[^}]*var\(--hover-glass\)/s);
    expect(folders).toMatch(/\.move-pop\s*\{[^}]*var\(--raised-glass\)[^}]*backdrop-filter/s);
  });

  it("uses the skin's press, tracking, material, preference, and corner variables", () => {
    const base = styles("base.css");
    expect(base).toContain("scale(var(--press-scale))");
    expect(base).toContain("letter-spacing: var(--tracking-heading)");
    expect(base).toContain("letter-spacing: var(--tracking-numeric)");
    expect(base).toContain("prefers-reduced-transparency: reduce");
    expect(base).toContain("prefers-contrast: more");
    expect(base).toContain("corner-shape: squircle");
  });
});
