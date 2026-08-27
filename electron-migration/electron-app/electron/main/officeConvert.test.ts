import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { officeConvertible, officePdfFilter, verifyOfficeArtifacts } from "./officeConvert.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("office conversion policy", () => {
  it.each([
    ["slides.ppt", "impress_pdf_Export"], ["slides.odp", "impress_pdf_Export"],
    ["table.xls", "calc_pdf_Export"], ["note.rtf", "writer_pdf_Export"],
  ])("chooses the PDF filter for %s", (name, filter) => expect(officePdfFilter(name)).toBe(filter));

  it("allows only the explicitly supported offline office inputs", () => {
    for (const name of ["a.ppt", "a.odp", "a.rtf", "a.odt", "a.doc", "a.xls"]) expect(officeConvertible(name)).toBe(true);
    for (const name of ["a.exe", "a.pages", "a.pdf"]) expect(officeConvertible(name)).toBe(false);
  });

  it("rejects absent and hash-mismatched artifact sets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-office-test-"));
    dirs.push(dir);
    expect(await verifyOfficeArtifacts(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "soffice.js"), "not the pinned build");
    expect(await verifyOfficeArtifacts(dir)).toBe(false);
  });
});
