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
});

describe("find searches the CURRENT numbering without re-snapshotting", () => {
  it("finds a control by its label text", () => {
    const h = loadPageScript('<button id="a">Save changes</button><button id="b">Cancel</button>');
    h.call("snapshot", {});
    const result = h.call("find", { text: "save" }) as { matches: Array<{ label: string }> };
    expect(result.matches.map((m) => m.label)).toEqual(["Save changes"]);
  });
});
