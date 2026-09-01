import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bytes: { bytes: null as Uint8Array | null, error: "", loading: false },
  parseMsg: vi.fn(),
}));

vi.mock("./msg", () => ({ parseMsg: mocks.parseMsg }));
vi.mock("./useFileBytes", () => ({ useFileBytes: vi.fn(() => mocks.bytes) }));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type EmailProps = {
  dataB64?: string | null;
  mediaToken?: string | null;
  name?: string;
  text?: string;
};
type View = Awaited<ReturnType<typeof renderEmail>>;

beforeEach(() => {
  mocks.bytes = { bytes: null, error: "", loading: false };
  mocks.parseMsg.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderEmail(props: EmailProps = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

  const [{ createRoot }, { default: EmailView }] = await Promise.all([
    import("react-dom/client"),
    import("./EmailView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: EmailProps = props) => {
    await act(async () => {
      root.render(
        createElement(EmailView, {
          mediaToken: "mail-token",
          name: "message.eml",
          text: "",
          ...next,
        }),
      );
      await Promise.resolve();
    });
  };
  await draw();
  return {
    close: async () => act(async () => root.unmount()),
    document,
    draw,
    host,
  };
}

function expectText(view: View, value: string) {
  expect(view.host.textContent).toContain(value);
}

describe("EmailView", () => {
  it("keeps EML headers, attachments, and text body aligned with the parser", async () => {
    const view = await renderEmail({
      text: [
        "Subject: Quarterly plan",
        "From: Ada <ada@example.test>",
        "To: Bea <bea@example.test>",
        "Cc: Cal <cal@example.test>",
        "Date: Tue, 1 Sep 2026 09:00:00 +0000",
        'Content-Type: multipart/mixed; boundary="mail"',
        "",
        "--mail",
        "Content-Type: text/plain",
        "",
        "Review the quarterly plan.",
        "--mail",
        'Content-Type: application/pdf; name="agenda.pdf"',
        'Content-Disposition: attachment; filename="agenda.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "QUJDRA==",
        "--mail--",
      ].join("\r\n"),
    });

    expect(view.host.querySelector(".eml-subject")?.textContent).toBe(
      "Quarterly plan",
    );
    for (const value of [
      "From",
      "Ada <ada@example.test>",
      "To",
      "Bea <bea@example.test>",
      "Cc",
      "Cal <cal@example.test>",
      "Date",
      "Tue, 1 Sep 2026 09:00:00 +0000",
      "agenda.pdf",
      "0 KB",
      "Review the quarterly plan.",
    ]) {
      expectText(view, value);
    }
    expect(view.host.querySelector(".eml-body")?.getAttribute("dir")).toBe(
      "auto",
    );
    await view.close();
  });

  it("uses readable subject and body fallbacks for sparse EML messages", async () => {
    const view = await renderEmail({ text: "From: Ada\r\n\r\n   " });

    expect(view.host.querySelector(".eml-subject")?.textContent).toBe(
      "(no subject)",
    );
    expectText(view, "Ada");
    expectText(view, "This message has no readable text body.");
    expect(view.host.querySelector(".eml-attachments")).toBeNull();
    await view.close();
  });

  it("reports every Outlook read and parse transition before rendering the parsed mail", async () => {
    mocks.bytes = { bytes: null, error: "", loading: true };
    const view = await renderEmail({ name: "OUTLOOK.MSG" });
    expectText(view, "Opening message…");

    mocks.bytes = {
      bytes: null,
      error: "The staged file expired.",
      loading: false,
    };
    await view.draw({ name: "OUTLOOK.MSG" });
    expectText(view, "The staged file expired.");

    mocks.bytes = { bytes: null, error: "", loading: false };
    await view.draw({ name: "OUTLOOK.MSG" });
    expectText(view, "Reading Outlook message…");

    mocks.parseMsg.mockImplementationOnce(() => {
      throw new Error("The message is corrupt.");
    });
    mocks.bytes = { bytes: new Uint8Array([1]), error: "", loading: false };
    await view.draw({ name: "OUTLOOK.MSG" });
    await flush();
    expectText(
      view,
      "This Outlook message could not be read: The message is corrupt.",
    );

    mocks.parseMsg.mockReturnValue({
      subject: "Outlook plan",
      from: "Dana <dana@example.test>",
      to: "",
      cc: "",
      date: "",
      body: "",
      attachments: [],
    });
    mocks.bytes = { bytes: new Uint8Array([2]), error: "", loading: false };
    await view.draw({ name: "OUTLOOK.MSG" });
    await flush();
    expectText(view, "Outlook plan");
    expectText(view, "Dana <dana@example.test>");
    expectText(view, "This message has no readable text body.");
    expect(mocks.parseMsg).toHaveBeenLastCalledWith(new Uint8Array([2]));
    await view.close();
  });

  it("turns non-Error Outlook parser failures into the displayed error", async () => {
    mocks.parseMsg.mockImplementationOnce(() => {
      throw "unsupported MAPI field";
    });
    mocks.bytes = { bytes: new Uint8Array([9]), error: "", loading: false };
    const view = await renderEmail({ name: "message.msg" });
    await flush();

    expectText(
      view,
      "This Outlook message could not be read: unsupported MAPI field",
    );
    await view.close();
  });
});
