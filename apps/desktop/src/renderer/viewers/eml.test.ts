import { describe, expect, it } from "vitest";
import {
  decodeBase64Text,
  decodeMimeWords,
  decodeQuotedPrintable,
  parseEml,
} from "./eml";

function message(lines: string[], lineEnding = "\r\n") {
  return lines.join(lineEnding);
}

describe("EML decoders", () => {
  it("decodes quoted-printable bytes, soft lines, encoded words, and base64 fallbacks", () => {
    expect(decodeQuotedPrintable("si=C3=A8ge=\nnext=ZZ\nline")).toBe("siègenext=ZZ\nline");
    expect(decodeBase64Text("U2VjcmV0IPCflJE=")).toBe("Secret 🔑");
    expect(decodeBase64Text("not valid base64!")).toBe("not valid base64!");
    expect(decodeBase64Text(" \n ")).toBe("");
    expect(decodeMimeWords("=?utf-8?B?Q2Fmw6k=?= =?utf-8?Q?and_more?=")).toBe("Café and more");
  });
});

describe("parseEml", () => {
  it("unfolds and decodes headers while retaining a plain leaf body", () => {
    const parsed = parseEml(message([
      "﻿Subject: =?utf-8?Q?Roadmap_=F0=9F=9A=80?=",
      "From: Ada <ada@example.test>",
      "To: Bea <bea@example.test>",
      "Cc: Cal <cal@example.test>",
      "Date: Tue, 1 Sep 2026 09:00:00 +0000",
      "X-Note: a folded",
      " continuation",
      "",
      "Plain text",
    ]));

    expect(parsed).toEqual({
      subject: "Roadmap 🚀",
      from: "Ada <ada@example.test>",
      to: "Bea <bea@example.test>",
      cc: "Cal <cal@example.test>",
      date: "Tue, 1 Sep 2026 09:00:00 +0000",
      body: "Plain text",
      attachments: [],
    });
  });

  it("uses a text plain multipart body before HTML and still records attachments after it", () => {
    const parsed = parseEml(message([
      "Subject: With files",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: text/html",
      "",
      "<style>hide</style><p>HTML &amp; fallback</p>",
      "--outer",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Plain =C3=A9",
      "--outer",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "QUJDRA==",
      "--outer",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment",
      "",
      "",
      "--outer--",
    ]));

    expect(parsed.body).toBe("Plain é\n");
    expect(parsed.attachments).toEqual([
      { name: "report.pdf", sizeHint: "0 KB" },
      { name: "(unnamed attachment)", sizeHint: "" },
    ]);
  });

  it("prefers a nested plain body over an outer HTML fallback and tolerates malformed multipart declarations", () => {
    const nested = parseEml(message([
      "Subject: Nested",
      "Content-Type: multipart/mixed; boundary=outer",
      "",
      "--outer",
      "Content-Type: text/html",
      "",
      "<p>outer fallback</p>",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/html",
      "",
      "<div>inner HTML</div>",
      "--inner",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: base64",
      "",
      "TmVzdGVkIHBsYWlu",
      "--inner--",
      "--outer--",
    ]));
    expect(nested.body).toBe("Nested plain");

    const malformed = parseEml(message([
      "Content-Type: multipart/mixed",
      "",
      "This remains the body when no boundary exists.",
    ], "\n"));
    expect(malformed).toMatchObject({
      subject: "",
      from: "",
      body: "This remains the body when no boundary exists.",
      attachments: [],
    });
    expect(parseEml("Subject: Header only")).toMatchObject({
      subject: "Header only",
      body: "",
    });
  });
});
