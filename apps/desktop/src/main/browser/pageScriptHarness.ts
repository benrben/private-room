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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

// Vitest can execute its transformed test modules from `dist_boot`, where a
// stale packaged page.js may be present. Resolve from the working tree
// instead, whether the focused command starts at apps/desktop or repo root.
const PAGE_SCRIPT_FILES = ["pageCore.js", "pageSnapshot.js", "pageRead.js", "pageActions.js", "page.js"];
const PAGE_SCRIPT_ROOT = [
  path.resolve(process.cwd(), "src/main/browser"),
  path.resolve(process.cwd(), "apps/desktop/src/main/browser"),
].find((root) => PAGE_SCRIPT_FILES.every((file) => existsSync(path.join(root, file))));

if (!PAGE_SCRIPT_ROOT) throw new Error("Could not locate the working-tree page-script fragments for tests.");

const PAGE_SCRIPT_PATHS = PAGE_SCRIPT_FILES.map((file) => path.join(PAGE_SCRIPT_ROOT, file));

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
  pageHtml: () => string;
}

export interface PageScriptHarness {
  document: ReturnType<typeof parseHTML>["document"];
  location: { href: string; host: string };
  /** Fresh VM global, exposed so tests can fabricate browser APIs after load. */
  window: Record<string, unknown>;
  call: (op: string, args?: Record<string, unknown>) => Record<string, unknown>;
  dispatchKey: (key: string | null, advanceMs?: number) => void;
  internals: PageScriptInternals;
}

/**
 * Build a fresh document with `bodyHtml`, load the real page script into it,
 * and hand back both the public `call(op, args)` entry point and the
 * `_internals` the script exposes for exactly this kind of test.
 */
export function loadPageScript(
  bodyHtml: string,
  opts: { url?: string; now?: number; globals?: Record<string, unknown> } = {},
): PageScriptHarness {
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
  let now = opts.now;
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const dispatchKey = (key: string | null, advanceMs = 0): void => {
    if (now !== undefined) now += advanceMs;
    for (const listener of listeners.get("keydown") ?? []) {
      listener(key === null ? null : { key });
    }
  };
  // Keep the VM's clock aligned with the timer functions supplied below. This
  // is invisible in normal execution, while a focused test using Vitest's
  // fake timers can advance both clocks deterministically. A caller that
  // supplies `now` still gets its explicitly controlled clock.
  sandbox["Date"] = now === undefined ? Date : { now: () => now };
  sandbox["addEventListener"] = (type: string, listener: (event: unknown) => void): void => {
    const handlers = listeners.get(type) ?? [];
    handlers.push(listener);
    listeners.set(type, handlers);
  };
  const location = { href: url, host: new URL(url).host };
  sandbox["location"] = location;
  // Minimal browser navigation primitives. They keep action routing tests in
  // the real script deterministic without claiming linkedom has a layout or
  // history implementation; individual tests can replace elementFromPoint
  // when they need a concrete coordinate target.
  sandbox["innerHeight"] = 800;
  sandbox["innerWidth"] = 1_000;
  sandbox["scrollTo"] = () => {};
  sandbox["scrollBy"] = () => {};
  sandbox["history"] = { back: () => {}, forward: () => {} };
  // The production ticket protocol uses timers for settle/wait polling. Give
  // the isolated VM the real timer primitives so its asynchronous public path
  // can be exercised without crossing into a browser runtime.
  sandbox["setInterval"] = setInterval;
  sandbox["clearInterval"] = clearInterval;
  (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => null;
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
  Object.assign(sandbox, opts.globals);

  vm.createContext(sandbox);
  for (const scriptPath of PAGE_SCRIPT_PATHS) {
    vm.runInContext(readFileSync(scriptPath, "utf8"), sandbox, { filename: scriptPath });
  }

  const api = sandbox["__arcelleBrowse"] as {
    call: PageScriptHarness["call"];
    _internals: PageScriptInternals;
  };

  return { document, location, window: sandbox, call: api.call, dispatchKey, internals: api._internals };
}
