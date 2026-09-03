import { afterEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_TITLES,
  newItemLabel,
  newItemOf,
  showsDocumentTabs,
  sidebarMenuLabel,
  sidebarRegionLabel,
} from "./destinations";

const originalTitles = { ...SIDEBAR_TITLES };

afterEach(() => {
  Object.assign(SIDEBAR_TITLES, originalTitles);
});

describe("sidebarRegionLabel", () => {
  it("names the Library evidence region only for Home and files, and every other contextual region by its own title", () => {
    expect(sidebarRegionLabel("files")).toBe("Library and sources");
    expect(sidebarRegionLabel("home")).toBe("Library and sources");
    expect(sidebarRegionLabel("map")).toBe("Map");
    expect(sidebarRegionLabel("recordings")).toBe("Recordings");
    expect(sidebarRegionLabel("workflows")).toBe("Workflows");
    expect(sidebarRegionLabel("scripts")).toBe("Scripts");
    expect(sidebarRegionLabel("skills")).toBe("Skills");
    expect(sidebarRegionLabel("memory")).toBe("Memory");
    expect(sidebarRegionLabel("connectors")).toBe("Connectors");
    expect(sidebarRegionLabel("create")).toBe("Creations");
    expect(sidebarRegionLabel("sketch")).toBe("Sketches");
    expect(sidebarRegionLabel("browser")).toBe("Private pages");
    expect(sidebarRegionLabel("skin")).toBe("Skin Studio");
  });

  it("uses the generic region name for a destination declared without a second column", () => {
    SIDEBAR_TITLES.map = null;

    expect(sidebarRegionLabel("map")).toBe("Contextual sidebar");
  });
});

describe("newItemOf", () => {
  it("assigns the new-item verb only to destinations that own one", () => {
    expect(newItemOf("browser")).toBe("page");
    expect(newItemOf("sketch")).toBe("sketch");
    expect(newItemOf("create")).toBe("creation");
    expect(newItemOf("files")).toBe("note");
    expect(newItemOf("home")).toBe("note");
    for (const area of ["map", "recordings", "workflows", "scripts", "skills", "memory", "connectors", "skin"] as const) {
      expect(newItemOf(area)).toBeNull();
    }
  });
});

describe("destination labels", () => {
  it("uses contextual sidebar labels and shows document tabs only in Home", () => {
    expect(sidebarMenuLabel("files")).toBe("Library");
    expect(sidebarMenuLabel("browser")).toBe("Private pages");
    SIDEBAR_TITLES.map = null;
    expect(sidebarMenuLabel("map")).toBe("Sidebar");

    expect(showsDocumentTabs("files")).toBe(true);
    expect(showsDocumentTabs("home")).toBe(true);
    for (const area of ["map", "recordings", "workflows", "scripts", "skills", "memory", "connectors", "create", "sketch", "browser", "skin"] as const) {
      expect(showsDocumentTabs(area)).toBe(false);
    }
  });

  it("names each destination-owned new item and leaves other destinations blank", () => {
    expect(newItemLabel("browser")).toBe("New page");
    expect(newItemLabel("sketch")).toBe("New sketch");
    expect(newItemLabel("create")).toBe("New creation");
    expect(newItemLabel("files")).toBe("New note");
    expect(newItemLabel("home")).toBe("New note");
    for (const area of ["map", "recordings", "workflows", "scripts", "skills", "memory", "connectors", "skin"] as const) {
      expect(newItemLabel(area)).toBeNull();
    }
  });
});
