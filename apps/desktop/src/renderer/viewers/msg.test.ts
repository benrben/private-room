import type { FieldsData } from "@kenjiuno/msgreader";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buffers: [] as ArrayBuffer[],
  getFileData: vi.fn(),
}));

vi.mock("@kenjiuno/msgreader", () => ({
  default: class {
    constructor(buffer: ArrayBuffer) {
      mocks.buffers.push(buffer);
    }

    getFileData() {
      return mocks.getFileData();
    }
  },
}));

import { msgFieldsToEmail, parseMsg } from "./msg";

function fields(overrides: Partial<FieldsData> = {}): FieldsData {
  return {
    dataType: "msg",
    ...overrides,
  } as FieldsData;
}

beforeEach(() => {
  mocks.buffers.length = 0;
  mocks.getFileData.mockReset();
});

describe("msgFieldsToEmail", () => {
  it("keeps sender and recipient order while adapting complete Outlook metadata", () => {
    const parsed = msgFieldsToEmail(
      fields({
        subject: "  Roadmap  ",
        senderName: "Ada",
        senderEmail: "ada@example.test",
        recipients: [
          fields({
            dataType: "recipient",
            recipType: "to",
            name: "Bea",
            email: "bea@example.test",
          }),
          fields({
            dataType: "recipient",
            recipType: "cc",
            name: "Cal",
            email: "cal@example.test",
          }),
          fields({
            dataType: "recipient",
            recipType: "to",
            name: "Dee",
            email: "DEE",
          }),
          fields({
            dataType: "recipient",
            recipType: "to",
            name: "",
            email: "",
          }),
        ],
        messageDeliveryTime: "delivery",
        clientSubmitTime: "submitted",
        creationTime: "created",
        body: "body text",
        preview: "preview text",
        attachments: [
          fields({
            dataType: "attachment",
            fileName: "report.pdf",
            contentLength: 1025,
          }),
          fields({
            dataType: "attachment",
            fileNameShort: "short.txt",
            contentLength: 0,
          }),
          fields({ dataType: "attachment", name: "named.bin" }),
          fields({ dataType: "attachment" }),
        ],
      }),
    );

    expect(parsed).toEqual({
      subject: "Roadmap",
      from: "Ada <ada@example.test>",
      to: "Bea <bea@example.test>, Dee",
      cc: "Cal <cal@example.test>",
      date: "delivery",
      body: "body text",
      attachments: [
        { name: "report.pdf", sizeHint: "2 KB" },
        { name: "short.txt", sizeHint: "0 KB" },
        { name: "named.bin", sizeHint: "" },
        { name: "(unnamed attachment)", sizeHint: "" },
      ],
    });
  });

  it("uses the documented sender, date, body, and attachment fallbacks", () => {
    expect(
      msgFieldsToEmail(
        fields({
          senderName: " Ada ",
          senderEmail: "ada",
          clientSubmitTime: "submitted",
          creationTime: "created",
          preview: "preview only",
          attachments: [],
        }),
      ),
    ).toEqual({
      subject: "",
      from: "Ada",
      to: "",
      cc: "",
      date: "submitted",
      body: "preview only",
      attachments: [],
    });

    expect(msgFieldsToEmail(fields({ creationTime: "created" }))).toMatchObject(
      {
        date: "created",
        body: "",
        attachments: [],
      },
    );
  });
});

describe("parseMsg", () => {
  it("hands MsgReader an owned byte-range and returns the adapted result", () => {
    mocks.getFileData.mockReturnValue(
      fields({ subject: "Parsed", senderEmail: "sender@example.test" }),
    );
    const bytes = new Uint8Array([99, 1, 2, 88]).subarray(1, 3);

    expect(parseMsg(bytes)).toMatchObject({
      subject: "Parsed",
      from: "sender@example.test",
    });
    expect(mocks.buffers).toHaveLength(1);
    expect([...new Uint8Array(mocks.buffers[0])]).toEqual([1, 2]);
  });

  it("preserves MsgReader parser errors", () => {
    mocks.getFileData.mockReturnValue(fields({ error: "Bad OLE stream" }));

    expect(() => parseMsg(new Uint8Array([1]))).toThrow("Bad OLE stream");
  });
});
