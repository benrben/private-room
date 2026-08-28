// Test-only harness: runs the REAL page.js against a REAL (if
// minimal) DOM built by `linkedom`, so the security-critical parts of the
// agent's page script (password fencing, staleness, the disabled trap) are
// proven against actual execution rather than string-contains assertions.
//
// linkedom has no layout engine — every element's `getBoundingClientRect()`
// comes back all-zero, which would make `isVisible` reject everything before
// it ever reaches a CSS check. The shims below exist ONLY to give
// `isVisible` something to differentiate: elements get a fixed, plausible
// on-screen rect UNLESS their computed `display` is `none`, so the CSS-based
// hide/show paths this file exists to test are exercised for real, without
// pretending this is a full layout engine.
//
// ISOLATION GOTCHA, discovered empirically (there is no doc for this):
// linkedom's `window` facade is a Proxy whose property SETS forward straight
// through to Node's real `global`/`globalThis` — `parseHTML()` called twice
// returns two `window` values that are not `===`, but writing a property on
// one is visible on the other (and on `globalThis` itself). Using that
// `window` as the `vm.createContext` sandbox would mean every test's shims
// (and the page script's OWN `window.__arcelleBrowse = {...}` export, and
// its startup guard `if (window.__arcelleBrowse) return;`) leak into every
// OTHER test in the same process — the second test to run would find the
// guard already tripped and silently keep running the FIRST test's script
// instance, closed over the first test's document. `document` itself (also
// returned by `parseHTML()`) is a genuinely separate object per call, with
// no such leakage. So this harness never touches linkedom's `window`: it
// builds its OWN plain sandbox object (`sandbox.window = sandbox`, the usual
// self-reference trick), and attaches only that per-call `document` plus the
// shims to it, giving each test a truly fresh global.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const PAGE_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "page.js");
const PAGE_SCRIPT_SOURCE = readFileSync(PAGE_SCRIPT_PATH, "utf8");

/** The subset of `window.__arcelleBrowse._internals` this harness exercises.
 * Loosely typed (`any`-ish via index signature) — the real contract lives in
 * `page.js` itself, which no `.d.ts` describes; this is a test
 * convenience, not a second copy of the contract. */
export interface PageScriptInternals {
  snapshot: (opts?: Record<string, unknown>) => Record<string, unknown>;
  read: (args?: Record<string, unknown>) => Record<string, unknown>;
  find: (args?: Record<string, unknown>) => Record<string, unknown>;
  doOne: (action: Record<string, unknown>) => Record<string, unknown>;
  resolve: (ref: unknown) => Record<string, unknown>;
  isSecret: (el: unknown) => boolean;
  labelFor: (el: unknown) => string;
  roleFor: (el: unknown) => string;
  regionFor: (el: unknown) => string;
  lowSignal: (elements: unknown[]) => string | null;
  readMarkdown: (mode: string) => string;
}

export interface PageScriptHarness {
  document: ReturnType<typeof parseHTML>["document"];
  call: (op: string, args?: Record<string, unknown>) => Record<string, unknown>;
  internals: PageScriptInternals;
}

/**
 * Build a fresh document with `bodyHtml`, load the real page script into it,
 * and hand back both the public `call(op, args)` entry point and the
 * `_internals` the script exposes for exactly this kind of test.
 */
export function loadPageScript(bodyHtml: string, opts: { url?: string } = {}): PageScriptHarness {
  // `parseHTML`'s `window` is deliberately never touched (see the module
  // header) — only its `document` is used, which IS genuinely isolated.
  const { document } = parseHTML("<!doctype html><html><body></body></html>");

  const url = opts.url ?? "https://example.com/page";

  // getComputedStyle + getBoundingClientRect: see the module header. Only
  // `display` is read here; `visibility`/`opacity` are also read by
  // `isVisible` and are wired the same way for completeness even though no
  // test below currently exercises them.
  const computedStyle = (el: { style?: { display?: string; visibility?: string; opacity?: string } }) => ({
    display: el.style?.display ?? "",
    visibility: el.style?.visibility ?? "",
    opacity: el.style?.opacity ?? "",
  });

  // The DOM node classes themselves (Element/HTMLElement) ARE shared,
  // process-wide singletons regardless of which `document` created an
  // instance — unlike `window`, that is not a problem: patching
  // `getBoundingClientRect` is a pure function of the instance's own style,
  // so doing it once (idempotently, on every call) has no cross-test state
  // to leak.
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement("div"))) as {
    getBoundingClientRect: (this: { style?: { display?: string } }) => unknown;
  };
  proto.getBoundingClientRect = function (this: { style?: { display?: string } }) {
    const cs = computedStyle(this);
    if (cs.display === "none") {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  };

  document.body.innerHTML = bodyHtml;

  // A fresh, plain sandbox object per call — NOT linkedom's `window` (see
  // the module header for why). `sandbox.window = sandbox` is the usual
  // self-reference trick so the script's own `window.X` reads/writes land on
  // this object, which `vm.createContext` makes the global object for this
  // execution.
  const sandbox: Record<string, unknown> = {};
  sandbox["window"] = sandbox;
  sandbox["document"] = document;
  sandbox["location"] = { href: url, host: new URL(url).host };
  // A fresh `vm` context only gets core ECMAScript intrinsics (Map, Promise,
  // RegExp, WeakRef, ...) — `URL` is a Node/web-platform global, not an
  // ECMAScript one, and is NOT present by default. `readMarkdown`'s link
  // resolution (`new URL(href, location.href)`) needs it, and silently not
  // having it would make every relative link resolve to itself instead of
  // throwing loudly, since the page script wraps that call in try/catch.
  sandbox["URL"] = URL;
  sandbox["getComputedStyle"] = computedStyle;
  // CSS.escape: only reached by `labelFor`'s `label[for=...]` lookup when an
  // element has an `id`; a minimal but correct-enough escape for the plain
  // ids this harness's tests use.
  sandbox["CSS"] = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
  // getSelection: read by `capture`/`info`'s `hasSelection`. No selection
  // API in linkedom; "nothing selected" is the correct, safe default.
  sandbox["getSelection"] = () => "";

  vm.createContext(sandbox);
  vm.runInContext(PAGE_SCRIPT_SOURCE, sandbox);

  const api = sandbox["__arcelleBrowse"] as {
    call: PageScriptHarness["call"];
    _internals: PageScriptInternals;
  };

  return { document, call: api.call, internals: api._internals };
}
