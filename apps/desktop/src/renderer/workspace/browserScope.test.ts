import { describe, expect, it } from "vitest";

import {
  MAX_PAGE_CHARS,
  chatScope,
  offeredScopes,
  pageContext,
  placeholderOf,
  readablePage,
  scopeLabel,
  selectedObjectsBlock,
  withPageContext,
  withPreamble,
  withSelectionContext,
  type OpenSketch,
  type ScopeSubject,
} from "./browserScope";

const sketch: OpenSketch = {
  fileId: "sketch-1",
  name: "Launch plan",
  selection: ["A yellow arrow", "A release date"],
};

function subject(overrides: Partial<ScopeSubject> = {}): ScopeSubject {
  return {
    area: "home",
    page: null,
    hasSelection: false,
    sketch: null,
    attachments: 0,
    ...overrides,
  };
}

describe("browser chat scope", () => {
  it("offers only readable browser pages and keeps the publisher's selection state", () => {
    expect(readablePage(null)).toBeNull();
    expect(
      readablePage({
        url: "https://example.test/article",
        title: "Article",
        readable: false,
        hasSelection: true,
      }),
    ).toBeNull();
    expect(
      readablePage({
        url: "https://example.test/article",
        title: "Article",
        readable: true,
        hasSelection: true,
      }),
    ).toEqual({
      url: "https://example.test/article",
      title: "Article",
      hasSelection: true,
    });
  });

  it("offers page and sketch scopes without promoting a selection to the default", () => {
    expect(offeredScopes(subject())).toEqual(["room"]);
    expect(offeredScopes(subject({ area: "browser" }))).toEqual(["room"]);
    expect(
      offeredScopes(
        subject({
          area: "browser",
          page: { url: "https://example.test", title: "Example", hasSelection: false },
        }),
      ),
    ).toEqual(["page", "room"]);
    expect(
      offeredScopes(
        subject({
          area: "browser",
          page: { url: "https://example.test", title: "Example", hasSelection: true },
          hasSelection: true,
        }),
      ),
    ).toEqual(["page", "selection", "room"]);
    expect(offeredScopes(subject({ area: "sketch", sketch }))).toEqual([
      "sketch",
      "objects",
      "room",
    ]);
    expect(
      offeredScopes(subject({ area: "sketch", sketch: { ...sketch, selection: [] } })),
    ).toEqual(["sketch", "room"]);
  });

  it("states every scope accurately, including fallbacks a stale UI could request", () => {
    expect(scopeLabel("page", subject())).toBe("this page");
    expect(scopeLabel("selection", subject())).toBe("the selected passage");
    expect(scopeLabel("sketch", subject({ sketch }))).toBe("“Launch plan”");
    expect(scopeLabel("sketch", subject({ sketch, attachments: 2 }))).toBe(
      "“Launch plan” + 2 attached",
    );
    expect(scopeLabel("sketch", subject())).toBe("this drawing");
    expect(scopeLabel("objects", subject({ sketch: { ...sketch, selection: ["Only"] } }))).toBe(
      "the selected object",
    );
    expect(scopeLabel("objects", subject({ sketch }))).toBe("the 2 selected objects");
    expect(scopeLabel("objects", subject())).toBe("the 0 selected objects");
    expect(scopeLabel("room", subject())).toBe("the whole room");
    expect(scopeLabel("room", subject({ attachments: 1 }))).toBe("1 attached source");
    expect(scopeLabel("room", subject({ attachments: 2 }))).toBe("2 attached sources");
  });

  it("gives the composer a placeholder that matches the selected scope", () => {
    const selectedPage = subject({
      area: "browser",
      page: { url: "https://example.test", title: "Example", hasSelection: true },
      hasSelection: true,
    });
    const selectedSketch = subject({ area: "sketch", sketch });

    expect(chatScope(selectedPage, "page").placeholder).toBe("Ask about this page…");
    expect(chatScope(selectedPage, "selection").placeholder).toBe(
      "Ask about the selected passage…",
    );
    expect(chatScope(selectedSketch, "sketch").placeholder).toBe(
      "Ask about “Launch plan”…",
    );
    expect(chatScope(selectedSketch, "objects").placeholder).toBe(
      "Ask about what you have selected…",
    );
    expect(chatScope(subject({ attachments: 2 }), null).placeholder).toBe(
      "Ask anything about this room…",
    );
  });

  it("keeps the stale sketch placeholder honest and drops a scope with no remaining subject", () => {
    const absentSketch = subject({ area: "sketch", sketch: null });

    expect(placeholderOf("sketch", absentSketch)).toBe("Ask about this drawing…");
    expect(chatScope(absentSketch, "sketch")).toMatchObject({
      scope: "room",
      placeholder: "Ask anything about this room…",
      preamble: "",
      fileIds: [],
    });
  });

  it("drops unavailable choices and sends exactly the material its scope promises", () => {
    const selectedPage = chatScope(
      subject({
        area: "browser",
        page: { url: "https://example.test", title: "Example", hasSelection: true },
        hasSelection: true,
      }),
      "selection",
    );
    expect(selectedPage).toMatchObject({
      scope: "selection",
      sendsPageText: true,
      fileIds: [],
      preamble: "",
    });

    const unavailableSelection = chatScope(
      subject({
        area: "browser",
        page: { url: "https://example.test", title: "Example", hasSelection: false },
      }),
      "selection",
    );
    expect(unavailableSelection.scope).toBe("page");
    expect(unavailableSelection.sendsPageText).toBe(true);

    const selectedObjects = chatScope(subject({ area: "sketch", sketch }), "objects");
    expect(selectedObjects).toMatchObject({
      scope: "objects",
      sendsPageText: false,
      fileIds: [],
      preamble: "Selected on the drawing “Launch plan”:\n- A yellow arrow\n- A release date",
    });

    const wholeSketch = chatScope(
      subject({ area: "sketch", sketch: { ...sketch, selection: [] } }),
      "sketch",
    );
    expect(wholeSketch).toMatchObject({
      scope: "sketch",
      sendsPageText: false,
      fileIds: ["sketch-1"],
      preamble: "",
    });
    expect(chatScope(subject(), null).scope).toBe("room");
  });

  it("formats selected objects and preserves an empty preamble", () => {
    expect(selectedObjectsBlock(sketch)).toBe(
      "Selected on the drawing “Launch plan”:\n- A yellow arrow\n- A release date",
    );
    expect(withPreamble("What is next?", "Context")).toBe("Context\n\nWhat is next?");
    expect(withPreamble("What is next?", "")).toBe("What is next?");
  });

  it("normalizes, caps, and honestly reports page text", () => {
    expect(pageContext({ text: "  \n  " })).toBeNull();
    expect(
      pageContext({ title: " Title ", url: " https://example.test ", text: " Words " }),
    ).toEqual({
      title: "Title",
      url: "https://example.test",
      text: "Words",
      omitted: 0,
    });
    const longText = "x".repeat(MAX_PAGE_CHARS + 4);
    const shortened = pageContext({ text: longText, total: MAX_PAGE_CHARS + 10 });
    expect(shortened).toMatchObject({ text: "x".repeat(MAX_PAGE_CHARS), omitted: 10 });
    expect(
      pageContext({ title: null as never, url: null as never, text: null as never, total: null as never }),
    ).toBeNull();
  });

  it("uses distinct page and selected-passage introductions", () => {
    const wholePage = { title: "Title", url: "https://example.test", text: "Words", omitted: 0 };
    const cutPassage = { ...wholePage, omitted: 2 };
    expect(withPageContext("Question", wholePage)).toBe(
      'The page open in the private browser, as text:\nTitle — https://example.test\n\n"""\nWords\n"""\n\nQuestion',
    );
    expect(withSelectionContext("Question", cutPassage)).toBe(
      'The passage selected in the private browser:\nTitle — https://example.test\nOnly the first 5 characters of the selection are below; 2 more are not.\n\n"""\nWords\n"""\n\nQuestion',
    );
    expect(withSelectionContext("Question", wholePage)).toContain(
      'The passage selected in the private browser:\nTitle — https://example.test\n\n"""',
    );
    expect(withPageContext("Question", cutPassage)).toContain(
      "Only the first 5 characters are below; 2 more of the page are not.",
    );
  });
});
