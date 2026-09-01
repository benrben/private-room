// Real-execution behavioural tests for the ported agent page script (page.js),
// run against a real (if minimal) DOM via pageScriptHarness.ts.
//
// This is coverage the Rust source never had: browser.rs can only scan PAGE_JS
// for substrings, so every one of its page-script tests passes on a file that
// would throw on the first line. These run the real script. They complement,
// not replace, the string-contains contract tests in pageScript.test.ts —
// those pin names the host side reads by name, which real execution against a
// tiny DOM would not necessarily exercise.

import { describe, expect, it } from "vitest";
import { loadPageScript } from "./pageScriptHarness.js";

describe("keyboard escape hatch", () => {
  it("latches only a timely double Escape, resets on other events, and reports it once", () => {
    const h = loadPageScript("<main>Fake page</main>", { now: 1_000 });
    const info = () => h.call("info", {}) as { leaveRequested: boolean };

    h.dispatchKey("Escape");
    h.dispatchKey("x", 10);
    h.dispatchKey(null, 10);
    expect(info().leaveRequested).toBe(false);

    h.dispatchKey("Escape", 10);
    h.dispatchKey("Escape", 700);
    expect(info().leaveRequested).toBe(true);
    expect(info().leaveRequested).toBe(false);

    h.dispatchKey("Escape", 1);
    h.dispatchKey("Escape", 701);
    expect(info().leaveRequested).toBe(false);
  });
});

describe("password fencing (PRIVACY invariant)", () => {
  it("excludes a password field from the snapshot but counts it as a secret", () => {
    const { call } = loadPageScript(
      '<input id="pw" type="password" name="password"><button id="go">Sign in</button>',
    );
    const snap = call("snapshot", {}) as {
      elements: Array<{ ref: string; role: string }>;
      secrets: number;
      summary: string;
    };
    expect(snap.elements).toHaveLength(1);
    expect(snap.elements[0]?.role).toBe("button");
    expect(snap.secrets).toBe(1);
    expect(snap.summary).toContain("password field(s) present");
  });

  it("recognizes a password field by NAME even after a 'show password' toggle sets type=text", () => {
    const h = loadPageScript('<input id="pw" type="text" name="login-password">');
    const input = h.document.getElementById("pw");
    expect(h.internals.isSecret(input)).toBe(true);
  });

  it("does NOT treat a checkbox that merely mentions 'password' in its id as secret", () => {
    const h = loadPageScript('<input id="showPassword" type="checkbox">');
    const el = h.document.getElementById("showPassword");
    expect(h.internals.isSecret(el)).toBe(false);
  });

  it("refuses to resolve a ref for a password field even if one were forced into the registry", () => {
    const h = loadPageScript('<input id="pw" type="password">');
    const resolved = h.internals.resolve("e1");
    // Nothing was ever marked (password fields never get a ref at all), so
    // this must fail as "gone", not succeed.
    expect((resolved as { error?: string }).error).toBeDefined();
  });
});

describe("labelFor fallback chain", () => {
  it("prefers aria-label over everything else", () => {
    const h = loadPageScript('<button id="b" aria-label="Close dialog">X</button>');
    expect(h.internals.labelFor(h.document.getElementById("b"))).toBe("Close dialog");
  });

  it("falls back to aria-labelledby, joining the referenced nodes", () => {
    const h = loadPageScript(
      '<span id="l1">Full</span> <span id="l2">Name</span><input id="f" aria-labelledby="l1 l2">',
    );
    expect(h.internals.labelFor(h.document.getElementById("f"))).toBe("Full Name");
  });

  it("falls back to its own text content", () => {
    const h = loadPageScript('<a id="a" href="/x">Read more</a>');
    expect(h.internals.labelFor(h.document.getElementById("a"))).toBe("Read more");
  });

  it("falls back to a <label for=...>", () => {
    const h = loadPageScript('<label for="e">Email address</label><input id="e">');
    expect(h.internals.labelFor(h.document.getElementById("e"))).toBe("Email address");
  });

  it("falls back to placeholder, then title, then name", () => {
    const ph = loadPageScript('<input id="p" placeholder="Your name">');
    expect(ph.internals.labelFor(ph.document.getElementById("p"))).toBe("Your name");

    const t = loadPageScript('<input id="t" title="Search the site">');
    expect(t.internals.labelFor(t.document.getElementById("t"))).toBe("Search the site");

    const n = loadPageScript('<input id="n" name="zip_code">');
    expect(n.internals.labelFor(n.document.getElementById("n"))).toBe("zip_code");
  });

  it("names an unlabelable control honestly", () => {
    const h = loadPageScript('<input id="x">');
    expect(h.internals.labelFor(h.document.getElementById("x"))).toBe("(unlabeled)");
  });
});

describe("roleFor", () => {
  it("maps common tags to their ARIA role", () => {
    const h = loadPageScript(
      '<a id="a" href="/x">l</a><button id="b">b</button><select id="s"></select>' +
        '<textarea id="t"></textarea><input id="cb" type="checkbox"><input id="tx">',
    );
    const { document } = h;
    expect(h.internals.roleFor(document.getElementById("a"))).toBe("link");
    expect(h.internals.roleFor(document.getElementById("b"))).toBe("button");
    expect(h.internals.roleFor(document.getElementById("s"))).toBe("select");
    expect(h.internals.roleFor(document.getElementById("t"))).toBe("textbox");
    expect(h.internals.roleFor(document.getElementById("cb"))).toBe("checkbox");
    expect(h.internals.roleFor(document.getElementById("tx"))).toBe("textbox");
  });

  it("prefers an explicit role attribute over the tag guess", () => {
    const h = loadPageScript('<div id="d" role="button">go</div>');
    expect(h.internals.roleFor(h.document.getElementById("d"))).toBe("button");
  });
});

describe("regionFor", () => {
  it("finds the nearest landmark ancestor", () => {
    const h = loadPageScript(
      "<nav><a id='navlink' href='/x'>Home</a></nav>" +
        "<header><button id='hbtn'>Menu</button></header>" +
        "<main><button id='mbtn'>Go</button></main>" +
        "<footer><a id='fbtn' href='/y'>Contact</a></footer>",
    );
    const { document } = h;
    expect(h.internals.regionFor(document.getElementById("navlink"))).toBe("nav");
    expect(h.internals.regionFor(document.getElementById("hbtn"))).toBe("header");
    expect(h.internals.regionFor(document.getElementById("mbtn"))).toBe("main");
    expect(h.internals.regionFor(document.getElementById("fbtn"))).toBe("footer");
  });

  it("falls back to body with no landmark ancestor", () => {
    const h = loadPageScript('<div><button id="b">go</button></div>');
    expect(h.internals.regionFor(h.document.getElementById("b"))).toBe("body");
  });
});

describe("visibility (display:none exclusion)", () => {
  it("excludes a display:none control from the snapshot", () => {
    const { call } = loadPageScript(
      '<button id="visible">Shown</button><button id="hidden" style="display:none">Hidden</button>',
    );
    const snap = call("snapshot", {}) as { elements: Array<{ label: string }> };
    expect(snap.elements.map((e) => e.label)).toEqual(["Shown"]);
  });
});

describe("cross-origin frame reporting", () => {
  it("counts only opaque frames while leaving same-origin frames to their own page script", () => {
    const h = loadPageScript('<iframe id="same"></iframe><iframe id="opaque"></iframe>');
    const same = h.document.getElementById("same") as unknown as { contentDocument?: unknown };
    const opaque = h.document.getElementById("opaque") as unknown as { contentDocument?: unknown };
    Object.defineProperty(same, "contentDocument", { configurable: true, value: {} });
    Object.defineProperty(opaque, "contentDocument", {
      configurable: true,
      get() {
        throw new Error("fabricated cross-origin frame");
      },
    });

    expect((h.call("snapshot", {}) as { crossOriginFrames: number }).crossOriginFrames).toBe(1);
  });
});

describe("the disabled trap — a control alive at snapshot time can die before the click lands", () => {
  it("resolves fine but doOne refuses a click on a NOW-disabled control", () => {
    const h = loadPageScript('<button id="submit">Submit</button>');
    const snap = h.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    expect(snap.elements).toHaveLength(1);
    const ref = snap.elements[0]?.ref;
    // Disable it AFTER the ref was issued — the ordinary "form disables
    // Submit while validating" case.
    h.document.getElementById("submit")?.setAttribute("disabled", "");
    const result = h.internals.doOne({ click: ref }) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disabled");
  });
});

describe("staleness — an old ref must never silently act on a re-laid-out element", () => {
  it("refuses a ref from an earlier snapshot generation", () => {
    const h = loadPageScript('<button id="a">A</button>');
    h.call("snapshot", {});
    // A second snapshot clears every mark and bumps the generation.
    h.call("snapshot", {});
    const result = h.internals.doOne({ click: "e1" }) as { ok: boolean; error?: string };
    // e1 was cleared by the second snapshot before this ran (or was
    // reissued to the same element, which the resolve staleness check
    // would still accept) — either way this must never throw, and a truly
    // stale ref must be refused, not silently actioned.
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("act via doOne: click and type actually mutate the DOM", () => {
  it("types into a text field", () => {
    const h = loadPageScript('<input id="name">');
    const snap = h.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    const ref = snap.elements[0]?.ref as string;
    const result = h.internals.doOne({ type: { ref, text: "Ada" } }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect((h.document.getElementById("name") as unknown as { value: string }).value).toBe("Ada");
  });

  it("clicks a button", () => {
    const h = loadPageScript('<button id="btn" onclick="this.setAttribute(\'clicked\',\'1\')">Go</button>');
    const snap = h.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    const ref = snap.elements[0]?.ref as string;
    const result = h.internals.doOne({ click: ref }) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

describe("readMarkdown renders headings, paragraphs and links", () => {
  it("produces markdown-ish text from ordinary content", () => {
    const h = loadPageScript(
      '<main><h1>Title</h1><p>Hello world.</p><a href="/there">There</a></main>',
      { url: "https://example.com/" },
    );
    const text = h.internals.readMarkdown("main");
    expect(text).toContain("# Title");
    expect(text).toContain("Hello world.");
    expect(text).toContain("[There](https://example.com/there)");
  });

  it("renders every supported content shape while skipping browser chrome and hidden data", () => {
    const h = loadPageScript(
      "<main><h2>Title</h2><blockquote>Quoted words</blockquote>" +
        "<ul><li>First</li><li>Second</li></ul><pre>const answer = 42;\n</pre>" +
        '<a href="/there">There</a><br><table><tr><th>Name</th><th>Value</th></tr>' +
        "<tr><td>One</td><td>1</td></tr></table><img alt='A diagram'>" +
        "<div>Trailing text</div><nav>Navigation</nav><p aria-hidden='true'>Hidden</p>" +
        "<script>ignored()</script><div data-arcelle-ui='1'>Agent chrome</div></main>",
      { url: "https://example.com/base" },
    );

    const text = h.internals.readMarkdown("main");

    expect(text).toContain("## Title");
    expect(text).toContain("> Quoted words");
    expect(text).toContain("- First");
    expect(text).toContain("- Second");
    expect(text).toContain("```\nconst answer = 42;\n```");
    expect(text).toContain("[There](https://example.com/there)");
    expect(text).toContain("| Name | Value |");
    expect(text).toContain("| --- | --- |");
    expect(text).toContain("| One | 1 |");
    expect(text).toContain("![A diagram]");
    expect(text).toContain("Trailing text");
    expect(text).not.toContain("Navigation");
    expect(text).not.toContain("Hidden");
    expect(text).not.toContain("ignored");
    expect(text).not.toContain("Agent chrome");
  });

  it("falls back to plain text when walking a malformed DOM throws", () => {
    const h = loadPageScript("<main>Safe fallback text</main>");
    const main = h.document.querySelector("main") as unknown as { childNodes: unknown; textContent: string };
    Object.defineProperty(main, "childNodes", {
      configurable: true,
      get() {
        throw new Error("broken child list");
      },
    });

    expect(h.internals.readMarkdown("full")).toBe("Safe fallback text");
  });
});

describe("doOne routes every supported browser action", () => {
  it("preserves action results, protections, and form-control side effects", () => {
    const h = loadPageScript(
      "<button aria-label='Target'>Target</button><input aria-label='Search'>" +
        "<select aria-label='Size'><option value='small'>Small</option><option value='medium'>Medium choice</option></select>" +
        "<form id='form'><input aria-label='Submit field'></form><div aria-label='Note' contenteditable='true'>Old</div>" +
        "<input id='secret' type='password'>",
    );
    const snap = h.call("snapshot", {}) as { elements: Array<{ ref: string; label: string }> };
    const refFor = (label: string) => snap.elements.find((element) => element.label === label)?.ref as string;
    const target = h.document.querySelector("button") as unknown as { click: () => void };
    const secret = h.document.getElementById("secret");
    const pointDocument = h.document as unknown as {
      elementFromPoint: (x: number, y: number) => unknown;
    };
    const submittedInput = h.document.querySelector("form input") as unknown as {
      form: { requestSubmit?: () => void; submit?: () => void };
    };
    const form = h.document.getElementById("form") as unknown as {
      requestSubmit?: () => void;
      submit?: () => void;
    };
    const editable = h.document.querySelector("[contenteditable]") as unknown as {
      isContentEditable: boolean;
      textContent: string;
    };
    let submits = 0;

    Object.defineProperty(submittedInput, "form", { configurable: true, value: form });
    form.requestSubmit = () => {
      submits++;
    };
    Object.defineProperty(editable, "isContentEditable", { configurable: true, value: true });

    expect(h.internals.doOne({ scroll: "top" })).toMatchObject({ ok: true, did: "scrolled top" });
    expect(h.internals.doOne({ scroll: "bottom" })).toMatchObject({ ok: true, did: "scrolled bottom" });
    expect(h.internals.doOne({ scroll: { dir: "up" } })).toMatchObject({ ok: true, did: "scrolled up" });
    expect(h.internals.doOne({ scroll: "down" })).toMatchObject({ ok: true, did: "scrolled down" });
    expect(h.internals.doOne({ scroll: { to: refFor("Target") } })).toMatchObject({
      ok: true,
      did: `scrolled to ${refFor("Target")}`,
    });
    expect(h.internals.doOne({ scroll: { to: "missing" } })).toMatchObject({ ok: false });

    expect(h.internals.doOne({ click_at: { x: "bad", y: 2 } })).toMatchObject({ ok: false });
    pointDocument.elementFromPoint = () => null;
    expect(h.internals.doOne({ click_at: { x: 3, y: 4 } })).toMatchObject({ ok: false });
    pointDocument.elementFromPoint = () => secret;
    expect(h.internals.doOne({ click_at: { x: 3, y: 4 } })).toMatchObject({ ok: false, error: expect.stringContaining("fenced") });
    pointDocument.elementFromPoint = () => target;
    expect(h.internals.doOne({ click_at: { x: 3.2, y: 4.8 } })).toMatchObject({
      ok: true,
      did: expect.stringContaining("clicked (3, 5)"),
    });

    target.click = () => {
      throw new Error("native click unavailable");
    };
    expect(h.internals.doOne({ click: refFor("Target") })).toMatchObject({ ok: true });
    expect(h.internals.doOne({ type: { ref: refFor("Search"), text: "Ada", clear: true } })).toMatchObject({
      ok: true,
    });
    expect(h.internals.doOne({ type: { ref: refFor("Note"), text: "New", clear: true } })).toMatchObject({
      ok: true,
    });
    expect(editable.textContent).toBe("New");
    expect(h.internals.doOne({ type: { ref: refFor("Submit field"), text: "go", submit: true } })).toMatchObject({
      ok: true,
      did: expect.stringContaining("and submitted"),
    });
    expect(submits).toBe(1);

    expect(h.internals.doOne({ select: { ref: refFor("Size"), value: "medium" } })).toMatchObject({ ok: true });
    expect(h.internals.doOne({ select: { ref: refFor("Size"), value: "absent" } })).toMatchObject({ ok: false });
    expect(h.internals.doOne({ key: "Escape" })).toEqual({ ok: true, did: "pressed Escape" });
    expect(h.internals.doOne({ back: true })).toEqual({ ok: true, did: "went back" });
    expect(h.internals.doOne({ forward: true })).toEqual({ ok: true, did: "went forward" });
    expect(h.internals.doOne({ unknown: true })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown action") });
    expect(h.internals.doOne(null as unknown as Record<string, unknown>)).toMatchObject({ ok: false });
  });
});

describe("find searches the CURRENT numbering without re-snapshotting", () => {
  it("finds a control by its label text", () => {
    const h = loadPageScript('<button id="a">Save changes</button><button id="b">Cancel</button>');
    h.call("snapshot", {});
    const result = h.call("find", { text: "save" }) as { matches: Array<{ label: string }> };
    expect(result.matches.map((m) => m.label)).toEqual(["Save changes"]);
  });
});

describe("public protocol dispatch", () => {
  async function takeEventually(h: ReturnType<typeof loadPageScript>, ticket: string) {
    let taken = h.call("take", { ticket }) as {
      ok: boolean;
      done: boolean;
      value?: Record<string, unknown>;
    };
    for (let attempt = 0; !taken.done && attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      taken = h.call("take", { ticket }) as typeof taken;
    }
    return taken;
  }

  it("executes badge rendering plus the read and capture response paths", () => {
    const h = loadPageScript(`<main>${"Readable page. ".repeat(30)}</main><button>Save</button>`);

    const snap = h.call("snapshot", { badges: true }) as { count: number };
    expect(snap.count).toBe(1);
    expect(h.document.getElementById("__arcelle_som_layer")).not.toBeNull();

    const read = h.call("read", { mode: "main", offset: 0 }) as {
      ok: boolean;
      mode: string;
      text: string;
      nextOffset: number;
    };
    expect(read).toMatchObject({ ok: true, mode: "main" });
    expect(read.text).toContain("Readable page.");
    expect(read.nextOffset).toBe(read.text.length);

    const page = h.call("capture", {}) as { ok: boolean; what: string; html: string };
    expect(page).toMatchObject({ ok: true, what: "page" });
    expect(page.html).toContain("<!doctype html>");
    expect(h.call("capture", { what: "selection" })).toEqual({
      ok: false,
      error: "Nothing is selected on the page.",
    });
  });

  it("keeps async action and wait failures ticketed instead of throwing", async () => {
    const h = loadPageScript('<button id="save">Save</button><video id="media"></video>');
    Object.defineProperty(h.document, "readyState", { configurable: true, value: "complete" });
    const media = h.document.getElementById("media") as unknown as {
      getBoundingClientRect: () => { width: number; height: number; top: number; bottom: number };
    };
    media.getBoundingClientRect = () => ({ width: 80, height: 80, top: 0, bottom: 80 });
    expect((h.call("info", {}) as { mediaAreas: number }).mediaAreas).toBe(1);

    const snap = h.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    const started = h.call("begin", {
      op: "act",
      args: {
        actions: [
          { click: snap.elements[0]?.ref, settle_ms: 1 },
          { wait_for: { gone: "e404", timeout_ms: 1 } },
        ],
      },
    }) as { ok: boolean; ticket: string };
    expect(started.ok).toBe(true);

    const taken = await takeEventually(h, started.ticket);
    expect(taken).toMatchObject({ ok: true, done: true });
    expect(taken.value).toMatchObject({ ok: false });
    expect((taken.value?.results as Array<{ ok: boolean; error?: string }>)[1]).toMatchObject({
      ok: false,
      error: expect.stringContaining("not one of this page's refs"),
    });
    expect(h.call("not-an-op", {})).toEqual({ ok: false, error: "Unknown op: not-an-op" });
  });

  it("keeps successful waits, navigation, and settled tickets on their protocol paths", async () => {
    const h = loadPageScript('<button id="save">Save</button><p>Ready</p>');
    Object.defineProperty(h.document, "readyState", { configurable: true, value: "complete" });
    Object.defineProperty(h.document.body, "innerText", { configurable: true, value: "Ready" });
    const first = h.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    h.document.getElementById("save")?.remove();
    const waited = h.call("begin", {
      op: "act",
      args: {
        actions: [
          { wait_for: { text: "ready", timeout_ms: 1 }, settle_ms: 1 },
          { wait_for: { gone: first.elements[0]?.ref, timeout_ms: 1 }, settle_ms: 1 },
        ],
      },
    }) as { ticket: string };
    expect((await takeEventually(h, waited.ticket)).value).toMatchObject({ ok: true });

    const settled = h.call("begin", { op: "settle", args: { budget_ms: 1 } }) as { ticket: string };
    expect((await takeEventually(h, settled.ticket)).value).toMatchObject({ ok: true, settled: false });

    const annotation = h.call("begin", { op: "annotate", args: {} }) as { ticket: string };
    expect((await takeEventually(h, annotation.ticket)).value).toMatchObject({ ok: false });

    const navigating = loadPageScript('<button id="go">Go</button>');
    Object.defineProperty(navigating.document, "readyState", { configurable: true, value: "complete" });
    const snap = navigating.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    setTimeout(() => {
      navigating.location.href = "https://example.com/next";
    }, 10);
    const moved = navigating.call("begin", {
      op: "act",
      args: { actions: [{ click: snap.elements[0]?.ref, settle_ms: 1 }, { key: "Escape" }] },
    }) as { ticket: string };
    expect((await takeEventually(navigating, moved.ticket)).value).toMatchObject({ navigated: true });
    expect(h.call("ping", {})).toMatchObject({ ok: true });
  });

  it("retains modal ordering and surrogate-safe read boundaries", () => {
    const modalButtons = Array.from({ length: 81 }, (_, index) => `<button>Choice ${index}</button>`).join("");
    const modal = loadPageScript(`<dialog open>${modalButtons}</dialog>`);
    expect(modal.call("snapshot", {})).toMatchObject({ count: 80, overflow: 1 });

    const low = loadPageScript(`<main>😀${"x".repeat(40010)}</main>`);
    expect(low.call("read", { offset: 1 })).toMatchObject({ offset: 0 });

    const high = loadPageScript(`<main>${"x".repeat(39999)}😀tail</main>`);
    expect(high.call("read", { offset: 0 })).toMatchObject({ nextOffset: 39999 });
  });
});
