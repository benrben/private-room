import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ buildFromTemplate: vi.fn() }));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate },
}));

describe("build", () => {
  it("hands the complete template to Electron and returns its menu", async () => {
    const fakeMenu = { kind: "fabricated-electron-menu" };
    electron.buildFromTemplate.mockReturnValue(fakeMenu);
    const { build } = await import("./menu.js");
    const onCommand = vi.fn();

    await expect(build(onCommand)).resolves.toBe(fakeMenu);
    expect(electron.buildFromTemplate).toHaveBeenCalledOnce();
    expect(electron.buildFromTemplate.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Arcelle", submenu: expect.any(Array) })]),
    );
  });
});
