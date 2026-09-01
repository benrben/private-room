import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  file: { bytes: null as Uint8Array | null, error: "", loading: false },
  read: vi.fn(),
  realRead: null as unknown as (...args: unknown[]) => unknown,
}));

vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();
  mocks.realRead = actual.read as unknown as (...args: unknown[]) => unknown;
  return { ...actual, read: (...args: unknown[]) => mocks.read(...args) };
});
vi.mock("./useFileBytes", () => ({
  useFileBytes: vi.fn(() => mocks.file),
}));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
  "ResizeObserver",
  "requestAnimationFrame",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type SheetProps = {
  dataB64?: string | null;
  editable?: boolean;
  mediaToken?: string | null;
  onEditCell?: (sheet: string, cell: string, value: string) => void;
  readOnlyReason?: string;
  target?: { range?: string; sheet?: string };
  text?: string | null;
};
type View = Awaited<ReturnType<typeof renderSheet>>;

beforeEach(() => {
  mocks.file = { bytes: null, error: "", loading: false };
  mocks.read
    .mockReset()
    .mockImplementation((...args: unknown[]) => mocks.realRead(...args));
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderSheet(props: SheetProps = {}) {
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
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 240,
  });
  Object.defineProperty(window.HTMLDivElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 240,
  });
  Reflect.set(
    globalThis,
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  );
  const [{ createRoot }, { default: SheetView }] = await Promise.all([
    import("react-dom/client"),
    import("./SheetView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const onEditCell = vi.fn();
  const listeners: Record<string, (event: Record<string, unknown>) => void> =
    {};
  const originalAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: (event: Record<string, unknown>) => void,
    options?: unknown,
  ) => {
    if (type === "keydown") listeners[type] = listener;
    return originalAddEventListener(type, listener as never, options as never);
  }) as never;
  const draw = async (next: SheetProps = props) => {
    await act(async () => {
      root.render(
        createElement(SheetView, {
          text: "Name,Value\nDulce,12\nMarco,7",
          onEditCell,
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
    listeners,
    onEditCell,
    window,
  };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React props missing for ${name}`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () =>
    reactProp(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    }),
  );
}

async function setValue(element: Element, value: string) {
  await invoke(element, "onChange", { target: { value } });
}

function cell(view: View, row: number, column: number) {
  const result = view.host.querySelector(
    `td[data-r='${row}'][data-c='${column}']`,
  );
  if (!result) throw new Error(`cell ${row}:${column} missing`);
  return result;
}

function button(view: View, text: string) {
  const result = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!result) throw new Error(`button ${text} missing`);
  return result;
}

function workbookBytes() {
  const workbook = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([
    ["Budget", 12],
    ["Formula", 3],
    ["Wide", "merged"],
  ]);
  first.B2 = { f: "SUM(B1:B1)", v: 12, w: "12" };
  first.A3.s = {
    font: { bold: true, color: { rgb: "FF00AA00" } },
    fill: { patternType: "solid", fgColor: { rgb: "FFFF0000" } },
    alignment: { horizontal: "center", wrapText: true },
  };
  first["!ref"] = "A1:C3";
  first["!cols"] = [{ wpx: 130 }, { hidden: true }, { wch: 8 }];
  first["!merges"] = [{ s: { r: 2, c: 0 }, e: { r: 2, c: 1 } }];
  const second = XLSX.utils.aoa_to_sheet([["Second", "Here"]]);
  XLSX.utils.book_append_sheet(workbook, first, "Budget");
  XLSX.utils.book_append_sheet(workbook, second, "Other");
  return new Uint8Array(
    XLSX.write(workbook, { type: "array", bookType: "xlsx", cellStyles: true }),
  );
}

function styledWorkbook(): XLSX.WorkBook {
  return {
    SheetNames: ["Styled"],
    Sheets: {
      Styled: {
        "!ref": "A1:TS2",
        "!cols": [{ wpx: 120 }, { hidden: true }, { wch: 4 }],
        "!merges": [{ s: { r: 1, c: 0 }, e: { r: 1, c: 1 } }],
        A1: {
          t: "s",
          v: "Styled",
          w: "Styled",
          s: {
            font: {
              bold: true,
              italic: true,
              underline: true,
              color: { rgb: "FF123456" },
              sz: 13,
            },
            fill: { patternType: "solid", fgColor: { rgb: "FFABCDEF" } },
            alignment: { horizontal: "center", wrapText: true },
          },
        },
        A2: { t: "s", v: "Merged", w: "Merged" },
        B1: {
          t: "s",
          v: "Fallback",
          w: "Fallback",
          s: { alignment: { horizontal: "distributed" } },
        },
      },
    },
  } as XLSX.WorkBook;
}

describe("SheetView", () => {
  it("renders CSV cells, sheet information, read-only notice, and cell inspection", async () => {
    const view = await renderSheet({
      readOnlyReason: "This legacy workbook is read-only.",
    });
    expect(view.host.textContent).toContain("3 rows");
    expect(view.host.textContent).toContain(
      "This legacy workbook is read-only.",
    );
    expect(cell(view, 1, 0).textContent).toBe("Dulce");
    await invoke(cell(view, 1, 0));
    expect(view.host.textContent).toContain("A2");
    expect(view.host.textContent).toContain("Dulce");
    expect(cell(view, 1, 1).className).toContain("num");
    await view.close();
  });

  it("edits values, declines formulas, supports keyboard movement, and undoes changes", async () => {
    const view = await renderSheet({ editable: true });
    const target = cell(view, 1, 0);
    await invoke(target);
    const input = view.host.querySelector(".cell-input");
    if (!input) throw new Error("cell input missing");
    await setValue(input, "Dulce updated");
    await invoke(input, "onKeyDown", { key: "Enter" });
    expect(view.onEditCell).toHaveBeenCalledWith(
      "Sheet1",
      "A2",
      "Dulce updated",
    );
    expect(view.host.textContent).toContain("1 cell changed");
    expect(cell(view, 1, 0).className).toContain("cell-changed");
    await invoke(button(view, "Undo A2"));
    expect(view.onEditCell).toHaveBeenLastCalledWith("Sheet1", "A2", "Dulce");
    await act(async () =>
      view.listeners.keydown?.({
        key: "z",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
      }),
    );

    await invoke(target, "onKeyDown", { key: "ArrowDown" });
    await invoke(cell(view, 2, 0), "onKeyDown", { key: "F2" });
    const formulaInput = view.host.querySelector(".cell-input");
    if (!formulaInput) throw new Error("formula input missing");
    await setValue(formulaInput, "=SUM(A1:A2)");
    await invoke(formulaInput, "onBlur");
    expect(view.host.textContent).toContain("saves values, not formulas");
    await invoke(cell(view, 2, 0), "onKeyDown", { key: "x" });
    const replacement = view.host.querySelector(".cell-input");
    if (!replacement) throw new Error("replacement input missing");
    expect((replacement as HTMLInputElement).value).toBe("x");
    await invoke(replacement, "onKeyDown", { key: "Escape" });
    await view.close();
  });

  it("renders workbook styles, formula source, tabs, merges, hidden columns, and targets", async () => {
    mocks.file = { bytes: workbookBytes(), error: "", loading: false };
    const view = await renderSheet({
      text: null,
      target: { sheet: "Other", range: "A1:B1" },
    });
    expect(view.host.textContent).toContain("Other");
    expect(cell(view, 0, 0).className).toContain("cell-hl");
    await invoke(button(view, "Budget"));
    expect(view.host.textContent).toContain("Budget");
    const formula = cell(view, 1, 1);
    await invoke(formula);
    expect(view.host.textContent).toContain("Formula");
    expect(view.host.textContent).toContain("=SUM(B1:B1)");
    expect(
      view.host.querySelectorAll("col")[2].getAttribute("style"),
    ).toContain("width:0");
    expect(view.host.textContent).toContain("Merged");
    expect(view.host.textContent).toContain("Hidden");
    await view.close();
  });

  it("shows loading, read, and empty-workbook failures without a live grid", async () => {
    mocks.file = { bytes: null, error: "", loading: true };
    const loading = await renderSheet({ text: null });
    expect(loading.host.textContent).toContain("Opening spreadsheet");
    await loading.close();

    mocks.file = {
      bytes: null,
      error: "The room file expired.",
      loading: false,
    };
    const readFailure = await renderSheet({ text: null });
    expect(readFailure.host.textContent).toContain("The room file expired.");
    await readFailure.close();

    mocks.file = { bytes: null, error: "", loading: false };
    const empty = await renderSheet({ text: null });
    expect(empty.host.textContent).toContain(
      "Could not parse this spreadsheet.",
    );
    await empty.close();
  });

  it("handles styled, merged and capped workbooks plus parser and observer fallbacks", async () => {
    mocks.read.mockImplementation(() => styledWorkbook());
    mocks.file = { bytes: new Uint8Array([1]), error: "", loading: false };
    const observer = { disconnect: vi.fn(), observe: vi.fn() };
    Reflect.set(
      globalThis,
      "ResizeObserver",
      class {
        disconnect = observer.disconnect;
        observe = observer.observe;
      },
    );
    const styled = await renderSheet({ text: null, target: { range: "A1" } });
    expect(cell(styled, 0, 0).getAttribute("style")).toContain(
      "font-weight:600",
    );
    expect(cell(styled, 0, 0).getAttribute("style")).toContain(
      "background:#ABCDEF",
    );
    expect(styled.host.textContent).toContain(
      "Showing the first 512 of 539 columns",
    );
    expect(observer.observe).toHaveBeenCalled();
    const scroll = styled.host.querySelector(".sheet-scroll") as HTMLDivElement;
    scroll.scrollTop = 1000;
    await invoke(scroll, "onScroll");
    expect(styled.host.querySelector("tbody tr[aria-hidden]")).not.toBeNull();
    await styled.close();
    expect(observer.disconnect).toHaveBeenCalled();
    mocks.read.mockImplementation(() => {
      throw new Error("password encrypted");
    });
    const locked = await renderSheet({ text: "broken" });
    expect(locked.host.textContent).toContain("protected with a password");
    await locked.close();

    mocks.read.mockImplementation(() => {
      throw new Error("invalid stream");
    });
    const invalid = await renderSheet({ text: "broken" });
    expect(invalid.host.textContent).toContain(
      "Could not parse this spreadsheet.",
    );
    await invalid.close();

    mocks.read.mockImplementation(
      () => ({ SheetNames: ["Blank"], Sheets: { Blank: {} } }) as XLSX.WorkBook,
    );
    const blank = await renderSheet({ text: "blank" });
    expect(blank.host.textContent).toContain("—");
    await blank.close();

    const hugeKeys = Array.from(
      { length: 250_001 },
      (_, index) => `!meta${index}`,
    );
    const hugeSheet = new Proxy(
      { "!ref": "A1:A1", A1: { t: "s", v: "one", w: "one" } },
      {
        ownKeys: () => hugeKeys,
        getOwnPropertyDescriptor: () => ({
          configurable: true,
          enumerable: true,
        }),
      },
    );
    mocks.read.mockImplementation(
      () =>
        ({
          SheetNames: ["Huge"],
          Sheets: { Huge: hugeSheet },
        }) as XLSX.WorkBook,
    );
    const huge = await renderSheet({ text: "huge" });
    expect(huge.host.textContent).toContain("too many cells to count");
    await huge.close();
  });
});
