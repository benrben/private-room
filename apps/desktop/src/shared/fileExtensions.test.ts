import { describe, expect, it } from "vitest";
import {
  fileExtensionLabel,
  isCodeTextExtension,
  isScriptExtension,
  isTextExtension,
  sharedTextExtensions,
} from "./fileExtensions";

describe("text extension registries", () => {
  it("normalizes extension case and returns an independent text-extension list", () => {
    const extensions = sharedTextExtensions();
    expect(extensions).toContain("markdown");
    expect(extensions).not.toContain("pdf");
    expect(isTextExtension("Md")).toBe(true);
    expect(isTextExtension("PDF")).toBe(false);
    expect(isScriptExtension("TS")).toBe(true);
    expect(isScriptExtension("toml")).toBe(false);
    expect(isCodeTextExtension("properties")).toBe(true);
    expect(isCodeTextExtension("JSON")).toBe(false);
    expect(isCodeTextExtension("txt")).toBe(false);

    const changed = extensions as string[];
    changed.push("temporary-test-extension");
    expect(sharedTextExtensions()).not.toContain("temporary-test-extension");
  });
});

describe("fileExtensionLabel", () => {
  it.each([
    ["PDF", "PDF"],
    ["ai", "PDF"],
    ["md", "note"],
    ["markdown", "note"],
    ["csv", "sheet"],
    ["tsv", "sheet"],
    ["XLSX", "sheet"],
    ["xls", "sheet"],
    ["ods", "sheet"],
    ["json", "data"],
    ["jsonl", "data"],
    ["ndjson", "data"],
    ["ts", "script"],
    ["properties", "code"],
    ["docx", "document"],
    ["doc", "document"],
    ["html", "HTML"],
    ["htm", "HTML"],
    ["pptx", "presentation"],
    ["ppt", "presentation"],
    ["odp", "presentation"],
    ["epub", "book"],
    ["mobi", "book"],
    ["azw", "book"],
    ["azw3", "book"],
    ["fb2", "book"],
    ["cbz", "book"],
    ["zip", "archive"],
    ["7Z", "archive"],
    ["rar", "archive"],
    ["tar", "archive"],
    ["gz", "archive"],
    ["ipynb", "notebook"],
    ["eml", "message"],
    ["msg", "message"],
    ["srt", "subtitles"],
    ["vtt", "subtitles"],
    ["svg", "drawing"],
    ["log", "log"],
    ["rst", "code"],
    ["txt", "text"],
  ] as const)("labels .%s as %s", (extension, label) => {
    expect(fileExtensionLabel(extension)).toBe(label);
  });

  it("keeps direct labels ahead of generic predicates and returns null for unknown extensions", () => {
    expect(fileExtensionLabel("JSON")).toBe("data");
    expect(fileExtensionLabel("MD")).toBe("note");
    expect(fileExtensionLabel("LOG")).toBe("log");
    expect(fileExtensionLabel("unknown-format")).toBeNull();
  });
});
