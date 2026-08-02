/* A minimal DOM, good enough to exercise the browser page script's real logic
 * under `node --test`.
 *
 * Why hand-rolled: the repo has no jsdom (and no network to add one), and the
 * things worth testing in `src-tauri/src/browser/page.js` — mark ordering, the
 * mark cap, the password fence, ref staleness, label resolution, markdown
 * extraction — are all pure DOM-shape logic. This implements exactly the API
 * surface the script touches, so the assertions are about the script rather
 * than about the stub.
 *
 * It is deliberately NOT a general DOM: the selector engine handles only the
 * forms `INTERACTIVE` actually uses (tag, `tag[attr]`, `[attr="value"]`,
 * `[attr]:not([attr="value"])`).
 */

let idSeq = 0;

export class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.nodeType = 1;
    this.__id = ++idSeq;
    this.isConnected = true;
    this.rect = { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 };
    this.style = { cssText: "" };
    this.__style = { display: "block", visibility: "visible", opacity: "1" };
    this.__text = attrs.__text ?? "";
    delete this.attrs.__text;
    this.clicked = 0;
    this.events = [];
    this.focused = false;
    for (const c of children) this.appendChild(c);
  }

  // ---- attributes
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  get id() {
    return this.attrs.id || "";
  }
  // Must be settable: the page script assigns `layer.id = …` when painting the
  // badge overlay, and the script runs under "use strict", where assigning to
  // a getter-only property throws.
  set id(v) {
    this.attrs.id = String(v);
  }
  get value() {
    return this.attrs.value ?? "";
  }
  set value(v) {
    this.attrs.value = v;
  }
  get disabled() {
    return this.attrs.disabled === true || this.attrs.disabled === "true";
  }
  get isContentEditable() {
    const c = this.getAttribute("contenteditable");
    return c === "" || c === "true";
  }
  get options() {
    return this.children.filter((c) => c.tagName === "OPTION");
  }
  get selectedOptions() {
    const i = this.selectedIndex ?? 0;
    return this.options[i] ? [this.options[i]] : [];
  }
  get form() {
    let n = this.parentElement;
    while (n) {
      if (n.tagName === "FORM") return n;
      n = n.parentElement;
    }
    return null;
  }

  // ---- tree
  /** Alias of `parentElement`. The page script's `removeBadges` reaches for
   *  `parentNode`, as real DOM code does; without this the overlay would look
   *  removable and silently never be removed. */
  get parentNode() {
    return this.parentElement;
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentElement = null;
  }
  get childNodes() {
    // Text content is modelled as one synthetic text node, so the markdown
    // walker sees the same shape it would in a real document.
    const nodes = [];
    if (this.__text) nodes.push({ nodeType: 3, nodeValue: this.__text });
    return nodes.concat(this.children);
  }
  get textContent() {
    return this.__text + this.children.map((c) => c.textContent).join(" ");
  }
  set textContent(v) {
    this.__text = v;
    this.children = [];
  }
  get innerText() {
    return this.textContent;
  }
  /** Enough of a serializer for `capture()`, which saves the page's HTML
   *  alongside its markdown. Attributes and nesting are what "Save page" is
   *  judged on; entity handling beyond `"` is not what that code decides. */
  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    const attrs = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`)
      .join("");
    const inner = this.__text + this.children.map((c) => c.outerHTML).join("");
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  /** Real DOM has this; the walker's modal check uses it. */
  contains(other) {
    let n = other;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
  }
  querySelectorAll(sel) {
    const out = [];
    walk(this, (n) => {
      if (n !== this && matchesAny(n, sel)) out.push(n);
    });
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  /** Minimal open shadow root, enough to model the real boundary: content
   * inside it is reachable through `.shadowRoot` and INVISIBLE to the host
   * document's `querySelectorAll` — which is exactly the gap that hid popup
   * inputs from the walker (owner report 2026-07-30). */
  attachShadow() {
    const host = this;
    const root = new El("shadow-root");
    root.parentElement = null;
    root.__isShadowRoot = true;
    // A shadow root is not a child of its host, so `walk` never reaches it.
    Object.defineProperty(host, "shadowRoot", { value: root, configurable: true });
    return root;
  }

  // ---- layout / paint
  getBoundingClientRect() {
    return {
      ...this.rect,
      bottom: this.rect.top + this.rect.height,
      right: this.rect.left + this.rect.width,
    };
  }
  checkVisibility() {
    return this.__style.display !== "none" && this.__style.visibility !== "hidden";
  }
  scrollIntoView() {}
  focus() {
    this.focused = true;
    doc.activeElement = this;
  }
  click() {
    this.clicked++;
    this.events.push("click");
  }
  dispatchEvent(ev) {
    this.events.push(ev.type);
    return true;
  }
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

/** `a, b, c` — any of the comma-separated simple selectors. */
function matchesAny(el, selectorList) {
  return selectorList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => matches(el, s));
}

/** Supports: `tag`, `tag[attr]`, `[attr]`, `[attr="v"]`, and a trailing
 *  `:not([attr="v"])`. That is exactly the grammar INTERACTIVE uses. */
function matches(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  let rest = sel.trim();
  if (rest === "*") return true;

  let negation = null;
  const notAt = rest.indexOf(":not(");
  if (notAt >= 0) {
    const close = rest.indexOf(")", notAt);
    negation = rest.slice(notAt + 5, close);
    rest = (rest.slice(0, notAt) + rest.slice(close + 1)).trim();
  }

  const bracket = rest.indexOf("[");
  const tag = (bracket >= 0 ? rest.slice(0, bracket) : rest).trim();
  if (tag && el.tagName !== tag.toUpperCase()) return false;

  if (bracket >= 0) {
    const attrPart = rest.slice(bracket);
    if (!attrMatches(el, attrPart)) return false;
  }
  if (negation && attrMatches(el, negation)) return false;
  return true;
}

function attrMatches(el, part) {
  const m = /^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(part.trim());
  if (!m) return false;
  const [, name, want] = m;
  const have = el.getAttribute(name);
  if (have === null) return false;
  if (want === undefined) return true;
  return String(have) === want;
}

// ---------------------------------------------------------------- document

class Doc {
  constructor() {
    this.documentElement = new El("html");
    this.body = new El("body");
    this.documentElement.appendChild(this.body);
    this.title = "Test Page";
    this.readyState = "complete";
    this.activeElement = null;
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  getElementById(id) {
    return this.documentElement.querySelectorAll("*").find((e) => e.id === id) || null;
  }
  createElement(tag) {
    return new El(tag);
  }
  elementFromPoint(x, y) {
    let hit = null;
    walk(this.documentElement, (n) => {
      const r = n.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = n;
    });
    return hit;
  }
}

let doc = new Doc();
let selectionText = "";

/** Install a fresh global environment and return `window.__arcelleBrowse`. */
export function install(scriptSource) {
  doc = new Doc();

  const g = globalThis;
  g.document = doc;
  g.location = { href: "https://example.com/page", host: "example.com" };
  g.history = { length: 3, back() {}, forward() {} };
  g.innerWidth = 1200;
  g.innerHeight = 800;
  g.window = g;
  g.getComputedStyle = (el) => el.__style || { display: "block", visibility: "visible", opacity: "1" };
  g.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  g.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  g.scrollTo = () => {};
  g.scrollBy = () => {};
  g.MouseEvent = class { constructor(type, init) { Object.assign(this, init); this.type = type; } };
  g.KeyboardEvent = class { constructor(type, init) { Object.assign(this, init); this.type = type; } };
  g.Event = class { constructor(type, init) { Object.assign(this, init); this.type = type; } };
  g.PerformanceObserver = class { observe() {} disconnect() {} };
  g.MutationObserver = class { observe() {} disconnect() {} };
  // `capture({what:"selection"})` stringifies the Selection object, so this
  // models the toString rather than a text property. Empty until a test sets
  // one, which is the state "Save selection" has to refuse.
  selectionText = "";
  g.getSelection = () => ({ toString: () => selectionText });

  // The script guards against double-injection; clear the previous run's copy.
  delete g.__arcelleBrowse;
  // eslint-disable-next-line no-new-func
  new Function(scriptSource)();
  return g.__arcelleBrowse;
}

export function currentDocument() {
  return doc;
}

/** What `window.getSelection()` reports, for the "Save selection" path. */
export function setSelection(text) {
  selectionText = String(text ?? "");
}

export { doc };
