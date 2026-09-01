import { describe, expect, it, vi } from "vitest";
import type { ChatCommand, FileMeta, Folder, SkillSummary, Specialist } from "../api";
import {
  ambiguousDisplayNames,
  displayName,
  fileLabel,
  fileToBase64,
  formatWhen,
  hoistSkill,
  hoistTag,
  isOllamaDown,
  openingSigil,
  parseComposer,
  provenanceLine,
  resolveRefs,
  specialistErrorMessage,
  specialistItems,
  specialistNote,
  tokenAtCaret,
  uniqueFileName,
} from "./composer.js";

function file(name: string, id: string, folderId: string | null = null): FileMeta {
  return {
    id,
    name,
    mimeType: "text/markdown",
    sizeBytes: 0,
    source: "library",
    hasText: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    folderId,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "library",
    libraryVisibility: "linked",
  };
}

const folders: Folder[] = [{ id: "research", name: "Research" }];
const files = [
  file("findings.md", "findings", "research"),
  file("Room summary.md", "summary"),
];
const commands: ChatCommand[] = [{ name: "minutes", summary: "", usage: "" }];
const skills: SkillSummary[] = [{
  id: "digest",
  name: "digest",
  description: "",
  enabled: true,
  createdBy: "user",
  agent: "",
  resourceCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}];
const specialists: Specialist[] = [{
  key: "browse",
  tool: "ask_browser_agent",
  agent: "chat.browse",
  label: "Browser",
  area: "web research",
  description: "",
}];

describe("resolveRefs", () => {
  it("uses the longest folder/file spelling, collects each id once, and keeps unmatched text", () => {
    expect(resolveRefs(
      "#minutes @Research/findings.md @Research/  @Room summary.md\n  @missing",
      files,
      folders,
    )).toEqual({
      refIds: ["findings", "summary"],
      cleaned: "#minutes\n@missing",
    });
  });
});

describe("composer tokens and autocomplete", () => {
  it("recognizes each supported sigil only in its allowed position", () => {
    expect(tokenAtCaret("#minutes", 8)).toEqual({ kind: "cmd", start: 0, query: "minutes" });
    expect(tokenAtCaret("/digest", 7)).toEqual({ kind: "skill", start: 0, query: "digest" });
    expect(tokenAtCaret("*browse", 7)).toEqual({ kind: "agent", start: 0, query: "browse" });
    expect(tokenAtCaret("read @Room Summary", 18)).toEqual({ kind: "ref", start: 5, query: "room summary" });
    expect(tokenAtCaret("a #minutes", 10)).toBeNull();
    expect(openingSigil("*browse inspect")).toBe("*");
    expect(openingSigil("/digest inspect")).toBe("/");
    expect(openingSigil("#minutes inspect")).toBe("#");
    expect(openingSigil("*important* note")).toBeNull();
  });

  it("hoists selected skills and specialist tags without changing their text rules", () => {
    expect(hoistSkill("/digest already first", "digest")).toBe("/digest already first");
    expect(hoistSkill("summarize /digest this", "digest")).toBe("/digest summarize this");
    expect(hoistSkill("@file/digest this", "digest")).toBe("/digest @file this");
    expect(hoistTag("*browse already first", "browse")).toBe("*browse already first");
    expect(hoistTag("summarize *browse this", "browse")).toBe("*browse summarize this");
    expect(hoistTag("@file*browse this", "browse")).toBe("*browse @file this");
  });

  it("describes specialist availability, search rows, and unavailable names", () => {
    const roster: Specialist[] = [
      { ...specialists[0], capability: "full" },
      {
        ...specialists[0],
        key: "inspect",
        label: "Inspector",
        area: "room files",
        capability: "inspect-only",
      },
      {
        ...specialists[0],
        key: "local",
        label: "Local",
        area: "private files",
        capability: "unavailable",
        localHandoff: true,
      },
    ];
    expect(specialistItems(roster, "").map((item) => item.usage)).toEqual([
      "Browser",
      "Inspector · Inspect only",
      "Local · On this Mac",
    ]);
    expect(specialistItems(roster, "room").map((item) => item.key)).toEqual(["ag-inspect"]);
    expect(specialistNote(null, "", "browse")).toContain("Looking up");
    expect(specialistNote(null, "offline", "browse")).toContain("offline");
    expect(specialistNote([], "", "browse")).toContain("no specialists");
    expect(specialistNote(roster, "", "missing")).toContain('"missing"');
    expect(specialistNote(roster, "", "browse")).toBe("");
    expect(specialistErrorMessage("local", [{ ...roster[2], capabilityReason: "No local engine" }]))
      .toBe("No local engine");
    expect(specialistErrorMessage("local", [roster[2]])).toContain("Cloud Privacy");
    expect(specialistErrorMessage("missing", roster)).toContain("Try: *browse");
    expect(specialistErrorMessage("missing", [])).toContain("no specialists");
  });
});

describe("parseComposer", () => {
  it("keeps tag, skill, command, conflict, and validation decisions distinct after references are lifted", () => {
    expect(parseComposer("*browse inspect @Research/findings.md", commands, skills, files, folders, null))
      .toEqual({ specialist: "browse", args: "inspect", refIds: ["findings"] });
    expect(parseComposer("*browse /digest inspect", commands, skills, files, folders, specialists))
      .toEqual({ args: "*browse /digest inspect", refIds: [], tagConflict: true });
    expect(parseComposer("*browse inspect", commands, skills, files, folders, [{ ...specialists[0], capability: "unavailable" }]))
      .toEqual({ args: "*browse inspect", refIds: [], specialistError: "browse" });
    expect(parseComposer("/digest inspect", commands, skills, files, folders))
      .toEqual({ skill: "digest", args: "inspect", refIds: [] });
    expect(parseComposer("/missing inspect", commands, skills, files, folders))
      .toEqual({ args: "/missing inspect", refIds: [], skillError: "missing" });
    expect(parseComposer("#minutes outline", commands, skills, files, folders))
      .toEqual({ command: "minutes", args: "outline", refIds: [] });
    expect(parseComposer("#missing outline", commands, skills, files, folders))
      .toEqual({ args: "#missing outline", refIds: [], commandError: "missing" });
    expect(parseComposer("ordinary message", commands, skills, files, folders))
      .toEqual({ args: "ordinary message", refIds: [] });
  });
});

describe("provenanceLine", () => {
  it("only names an actor or a nonzero source-file count", () => {
    expect(provenanceLine(null)).toBe("");
    expect(provenanceLine({ agent: "#minutes" })).toBe("Written by #minutes");
    expect(provenanceLine({ tool: "research", sourceFileIds: ["one"] })).toBe(
      "Written by research · from 1 file",
    );
    expect(provenanceLine({ sourceFileIds: ["one", "two"] })).toBe("from 2 files");
  });
});

describe("composer display helpers", () => {
  it("keeps filenames readable while resolving collisions and timestamp fallbacks", () => {
    expect(uniqueFileName("AI note.md", [])).toBe("AI note.md");
    expect(uniqueFileName("AI note.md", ["ai NOTE.md"])).toBe("AI note 2.md");
    expect(uniqueFileName("README", ["README"])).toBe("README 2");
    const taken = [
      "AI note.md",
      ...Array.from({ length: 998 }, (_, index) => `AI note ${index + 2}.md`),
    ];
    vi.spyOn(Date, "now").mockReturnValue(42);
    expect(uniqueFileName("AI note.md", taken)).toBe("AI note 42.md");
    vi.restoreAllMocks();
    expect(displayName("sample_file.tar.gz")).toBe("sample file");
    expect(displayName("___")).toBe("___");
    const matching = [{ name: "sample.md" }, { name: "sample.txt" }];
    expect(ambiguousDisplayNames(matching)).toEqual(new Set(["sample"]));
    expect(ambiguousDisplayNames(matching)).toEqual(new Set(["sample"]));
    expect(fileLabel("sample.md", matching)).toBe("sample.md");
    expect(fileLabel("notes.md", [{ name: "notes.md" }])).toBe("notes");
    expect(formatWhen("not-a-date")).toBe("not-a-date");
    expect(formatWhen("2026-07-05T00:47:00.000Z")).not.toBe("2026-07-05T00:47:00.000Z");
    expect(isOllamaDown("OLLAMA_DOWN")).toBe(true);
    expect(isOllamaDown("engine isn't running")).toBe(true);
    expect(isOllamaDown("other failure")).toBe(false);
  });

  it("reads pasted files through a fake reader and keeps its error intact", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
    let readFailure: DOMException | null = null;
    class FakeFileReader {
      result: string | null = "data:text/plain;base64,SGVsbG8=";
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        this.error = readFailure;
        if (readFailure) this.onerror?.();
        else this.onload?.();
      }
    }
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: FakeFileReader });
    try {
      await expect(fileToBase64({} as File)).resolves.toBe("SGVsbG8=");
      readFailure = new DOMException("Unreadable");
      await expect(fileToBase64({} as File)).rejects.toBe(readFailure);
    } finally {
      if (original) Object.defineProperty(globalThis, "FileReader", original);
      else Reflect.deleteProperty(globalThis, "FileReader");
    }
  });
});
