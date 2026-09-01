import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readZipEntryText: vi.fn() }));

vi.mock("./db-host/files.js", () => ({ getFileFull: vi.fn() }));
vi.mock("./workspace/roomContent.js", () => ({ readRoomFile: vi.fn() }));
vi.mock("./editMatchZip.js", () => ({
  buildZip: vi.fn(),
  parseZip: vi.fn(),
  readZipEntryText: mocks.readZipEntryText,
}));
vi.mock("./previewTools.js", () => ({ previewRenderNotImplemented: vi.fn() }));
vi.mock("./textUtil.js", () => ({ convert: vi.fn(), resolveFieldCodes: vi.fn() }));

import { slideCountOf } from "./officeTools.js";

beforeEach(() => vi.resetAllMocks());

describe("slideCountOf through the self-closing slide-id splitter", () => {
  it("counts self-closing and full slide-id elements without losing nested XML", () => {
    mocks.readZipEntryText.mockReturnValue(
      "<p:presentation><p:sldIdLst>" +
        '<p:sldId id="256" r:id="rId1"/>' +
        '<p:sldId id="257" r:id="rId2"><p:extLst><p:ext uri="fake"/></p:extLst></p:sldId>' +
        '<p:sldId id="258" r:id="rId3"></p:sldId>' +
        "</p:sldIdLst></p:presentation>",
    );

    expect(slideCountOf(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(mocks.readZipEntryText).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "ppt/presentation.xml");
  });

  it("does not count a slide element that is missing its closing angle bracket", () => {
    mocks.readZipEntryText.mockReturnValue('<p:sldIdLst><p:sldId id="256"</p:sldIdLst>');

    expect(slideCountOf(new Uint8Array())).toBe(0);
  });

  it("does not emit a partial long-form slide element with no closing tag", () => {
    mocks.readZipEntryText.mockReturnValue('<p:sldIdLst><p:sldId id="256"><p:ext/></p:sldIdLst>');

    expect(slideCountOf(new Uint8Array())).toBe(0);
  });
});
