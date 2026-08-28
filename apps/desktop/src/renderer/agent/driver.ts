import "./driver.css";
import type { AgentUiRequest } from "../api";
import { drawToPngB64, grabFrame } from "../viewers/frameGrab";

/**
 * ADD-25: the frontend half of the agent↔UI bridge. The backend emits an
 * AgentUiRequest ("look at the screen", "click mark 7", "grab a video
 * frame"), effects.ts hands it here, and the payload we return goes back
 * via api.resolveAgentUi. The model only ever sees numbered marks — it can
 * name an element but never fabricate a selector — and everything under
 * [data-agent-blocked] (consent surfaces: settings, approvals, destructive
 * confirms) is invisible AND untouchable, enforced in this file rather than
 * trusted to the prompt.
 */

/* tsconfig's lib is ES2020 and WeakRef shipped in ES2021 — but WKWebView has
 * had it since Safari 14.1, so declare the sliver we use instead of bumping
 * the lib for one type. */
interface AgentElementRef {
  deref(): Element | undefined;
}
declare const WeakRef: new (target: Element) => AgentElementRef;

/** mark → element, rebuilt on every ui_snapshot. WeakRefs so a closed panel's
 * rows don't outlive their DOM; a dead ref tells the model to re-snapshot. */
const registry = new Map<number, AgentElementRef>();

const MARK_CAP = 80;

/** Every capture that goes to a VISION MODEL is capped here — the model gains
 * nothing from a 4K still and the bridge payload is base64. Captures the user
 * keeps (an exported video frame) are not capped: that would silently save a
 * 1280px PNG of a 4K video. */
const VISION_MAX_WIDTH = 1280;

/** Anything a human could plausibly click or type into, plus this app's
 * click-handler rows/chips that carry no interactive tag of their own. */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[contenteditable]:not([contenteditable="false"])',
  ".file-row",
  ".prompt-chip",
  ".cmd-hint-chip",
  ".source-chip",
  ".annot-chip",
].join(", ");

/** Ordered most-specific-first: the shell's three panes plus chrome. The
 * legacy selectors stay as fallbacks so older markup keeps labeling.
 *
 * `.activity-rail` is a CONTRACT, not an implementation detail. The
 * navigation redesign rebuilt everything inside that element — the pane
 * toggles left, the destinations split into a pinned tier and a "More tools"
 * disclosure — and deliberately kept the class, because it is the only thing
 * telling the model that a control it can see is navigation.
 *
 * ONE THING THE MODEL MUST KNOW, and cannot learn from a snapshot: the
 * unpinned destinations are not in the DOM until the disclosure is opened, so
 * `ui_snapshot` genuinely does not list them. The reliable route to any place
 * is the ⌘K palette, which enumerates every area whether pinned or not (see
 * `buildPaletteActions` in workspace/Overlays.tsx). Hence the "More tools"
 * region name below: when the model does see that row, it should read as a
 * container of more controls rather than as a destination it can navigate to. */
const REGION_MAP: Array<[selector: string, name: string]> = [
  [".viewer, .viewer-pane, .pane-center", "viewer"],
  [".pane-library, .sidebar", "sidebar"],
  [".pane-ai, .chat", "chat"],
  [".activity-rail", "activity rail"],
  [".pr-statusbar", "status bar"],
  ["header, .top-bar, .pr-topbar", "top bar"],
  ["main", "chat"],
];

interface SnapshotEntry {
  mark: number;
  role: string;
  label: string;
  state?: string;
  region: string;
}

export async function handleAgentUiRequest(
  req: AgentUiRequest,
): Promise<Record<string, unknown>> {
  try {
    switch (req.kind) {
      case "ui_snapshot":
        return uiSnapshot();
      case "ui_act":
        return uiAct(req.args);
      case "view_screenshot":
        return viewScreenshot();
      case "media_frame":
        return await mediaFrame(req.args);
    }
    // Unreachable for a well-typed request; a newer backend could still send
    // a kind this build doesn't know.
    return { error: `Unknown agent UI request kind "${String(req.kind)}".` };
  } catch (e) {
    // The contract is "never throw" — the backend side of the bridge is
    // awaiting resolve_agent_ui and a lost reply would hang the agent turn.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- snapshot

function uiSnapshot(): Record<string, unknown> {
  // Stale marks from the previous snapshot must go first — the model's old
  // numbers must never silently point at re-laid-out elements.
  document
    .querySelectorAll("[data-agent-mark]")
    .forEach((el) => el.removeAttribute("data-agent-mark"));
  registry.clear();
  removeSomLayer();

  const candidates: Array<{ el: Element; top: number; order: number }> = [];
  let order = 0;
  for (const el of Array.from(
    document.querySelectorAll(INTERACTIVE_SELECTOR),
  )) {
    // The consent-surface fence (ADD-25): blocked elements are excluded at
    // the walker, so they never even get a mark the model could act on.
    if (el.closest("[data-agent-blocked]")) continue;
    if (isDisabled(el) || !isVisible(el)) continue;
    candidates.push({ el, top: el.getBoundingClientRect().top, order: order++ });
  }

  const overflow = Math.max(0, candidates.length - MARK_CAP);
  let chosen = candidates;
  if (overflow > 0) {
    // Keep what's nearest the viewport top (the model is usually working
    // there), then restore document order so marks read naturally.
    chosen = [...candidates]
      .sort((a, b) => Math.max(a.top, 0) - Math.max(b.top, 0))
      .slice(0, MARK_CAP)
      .sort((a, b) => a.order - b.order);
  }

  const layer = createSomLayer();
  const elements: SnapshotEntry[] = chosen.map((c, i) => {
    const mark = i + 1;
    c.el.setAttribute("data-agent-mark", String(mark));
    registry.set(mark, new WeakRef(c.el));
    addSomBadge(layer, c.el, mark);
    const entry: SnapshotEntry = {
      mark,
      role: roleFor(c.el),
      label: labelFor(c.el),
      region: regionFor(c.el),
    };
    const state = stateFor(c.el);
    if (state !== undefined) entry.state = state;
    return entry;
  });

  const regions = Array.from(new Set(elements.map((e) => e.region)));
  let summary = `${elements.length} interactive elements across ${
    regions.join("/") || "app"
  }`;
  // There was a "; file viewer open: X" clause here, read from
  // `.viewer .viewer-title`. The navigation redesign moved the file header off
  // that class, and the only `.viewer-title` elements left inside `.viewer`
  // belong to the Workflows and Scripts pages — which render ONLY when no file
  // is open. So it announced "file viewer open: Workflows", a file that does
  // not exist, in exactly the state it should have called empty. The model has
  // no way to tell a fabricated file from a real one, and this file spends its
  // length making sure it never has to. What the agent is looking at now
  // travels with the question instead (`viewing`, in `ask`), which reaches
  // every engine rather than only the local one.
  if (overflow > 0) summary += `; …and ${overflow} more (scroll to reveal)`;

  return { summary, count: elements.length, elements };
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (
    r.bottom <= 0 ||
    r.right <= 0 ||
    r.top >= window.innerHeight ||
    r.left >= window.innerWidth
  ) {
    return false;
  }
  // checkVisibility (Safari 17.4+) sees through display:none/visibility on
  // any ancestor; older WKWebViews fall back to the element's own style.
  const probe = el as Element & {
    checkVisibility?: (opts?: { checkVisibilityCSS?: boolean }) => boolean;
  };
  if (typeof probe.checkVisibility === "function") {
    return probe.checkVisibility({ checkVisibilityCSS: true });
  }
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
}

function isDisabled(el: Element): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true"
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The element's text the way a screen reader takes it: a subtree marked
 * `aria-hidden` is decoration and contributes nothing.
 *
 * `textContent` does not know that, and the tab strip is where it showed. A tab
 * renders a short — sometimes model-generated — title in an `aria-hidden` span
 * and the real file name in an `sr-only` one beside it, so the naive read
 * glued them into "lease.pdflease.pdf", or welded an invented label onto a real
 * name. The agent then handed that back to `open_file` as if it were a
 * filename. Every icon in the app is `aria-hidden` too, so this is the correct
 * reading everywhere, not a special case for tabs. */
function visibleText(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
    } else if (node instanceof Element) {
      if (node.getAttribute("aria-hidden") === "true") continue;
      out += visibleText(node);
    }
  }
  return out;
}

function labelFor(el: Element): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return truncate(aria, 60);
  const text = visibleText(el).replace(/\s+/g, " ").trim();
  if (text) return truncate(text, 60);
  const placeholder = el.getAttribute("placeholder")?.trim();
  if (placeholder) return truncate(placeholder, 60);
  const title = el.getAttribute("title")?.trim();
  if (title) return truncate(title, 60);
  if (el instanceof HTMLInputElement && el.value) {
    return truncate(el.value, 60);
  }
  return "(unlabeled)";
}

function roleFor(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  switch (el.tagName) {
    case "A":
      return "link";
    case "BUTTON":
      return "button";
    case "SELECT":
      return "combobox";
    case "TEXTAREA":
      return "textbox";
    case "INPUT": {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "button" || t === "submit" || t === "reset") return "button";
      return "textbox";
    }
  }
  if (el instanceof HTMLElement && el.isContentEditable) return "textbox";
  return "item"; // class-marked clickable rows/chips
}

function stateFor(el: Element): string | undefined {
  if (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  ) {
    return el.checked ? "checked" : "unchecked";
  }
  if (el.getAttribute("aria-checked") === "true") return "checked";
  if (
    el.getAttribute("aria-selected") === "true" ||
    el.classList.contains("active") ||
    el.classList.contains("selected")
  ) {
    return "selected";
  }
  if (el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions[0];
    return opt ? truncate(opt.text.trim(), 40) : undefined;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value ? truncate(el.value, 40) : undefined;
  }
  return undefined;
}

function regionFor(el: Element): string {
  for (const [selector, name] of REGION_MAP) {
    if (el.closest(selector)) return name;
  }
  return "app";
}

// -------------------------------------------- Set-of-Marks / ghost cursor

let somLayer: HTMLDivElement | null = null;
let somTimer = 0;

function removeSomLayer(): void {
  if (somTimer) {
    window.clearTimeout(somTimer);
    somTimer = 0;
  }
  somLayer?.remove();
  somLayer = null;
}

/** One fixed pointer-events:none layer holding every badge — so a screenshot
 * taken while it's up is exactly a Set-of-Marks image, and the user sees
 * what the agent was shown. Self-clears after 2.5s. */
function createSomLayer(): HTMLDivElement {
  removeSomLayer();
  const layer = document.createElement("div");
  layer.className = "agent-som-layer";
  document.body.appendChild(layer);
  somLayer = layer;
  somTimer = window.setTimeout(removeSomLayer, 2500);
  return layer;
}

function addSomBadge(layer: HTMLDivElement, el: Element, mark: number): void {
  const r = el.getBoundingClientRect();
  const badge = document.createElement("div");
  badge.className = "agent-som-badge";
  badge.textContent = String(mark);
  // Nudge up-left of the corner but never off-screen.
  badge.style.left = `${Math.max(0, r.left - 6)}px`;
  badge.style.top = `${Math.max(0, r.top - 8)}px`;
  layer.appendChild(badge);
}

/** Flash a ring where the agent is about to act — the user must be able to
 * follow the "ghost cursor" with their eyes, not discover changes after. */
function flashGhostRing(el: Element): void {
  const r = el.getBoundingClientRect();
  const ring = document.createElement("div");
  ring.className = "agent-ghost-ring";
  ring.style.left = `${r.left}px`;
  ring.style.top = `${r.top}px`;
  ring.style.width = `${r.width}px`;
  ring.style.height = `${r.height}px`;
  document.body.appendChild(ring);
  window.setTimeout(() => ring.remove(), 700);
}

// -------------------------------------------------------------------- act

function uiAct(args: Record<string, unknown>): Record<string, unknown> {
  const mark = typeof args.mark === "number" ? args.mark : NaN;
  const action = typeof args.action === "string" ? args.action : "";
  const text = typeof args.text === "string" ? args.text : undefined;

  const el = registry.get(mark)?.deref();
  if (
    !el ||
    !el.isConnected ||
    el.getAttribute("data-agent-mark") !== String(mark)
  ) {
    return { error: "That element is gone — take a fresh ui_snapshot." };
  }
  // Re-check the fence at act time: a consent dialog may have opened AROUND
  // a previously-marked element since the snapshot (ADD-25).
  if (el.closest("[data-agent-blocked]")) {
    return {
      error:
        "That element is part of a consent surface the agent may not operate — the user has to act there themselves.",
    };
  }

  const label = labelFor(el);
  const where = `${roleFor(el)}, ${regionFor(el)}`;

  // The badges belong to the snapshot they were drawn for, and acting is what
  // ends that snapshot: every branch below scrolls or types, so the numbers
  // would sit pinned to coordinates the page has just moved out from under
  // them. Only `uiSnapshot` cleared the layer, and its 2.5 s self-clear is long
  // enough for the user to watch the marks lie. Clearing here keeps the
  // strongest signal the agent has — "these are the things I can see" — true
  // for exactly as long as it is true.
  //
  // Ahead of the switch, so the two argument guards below clear it too. That is
  // deliberate and harmless: a call the agent got wrong is still the end of the
  // snapshot it was reading, and the alternative is repeating this line in
  // every acting branch.
  removeSomLayer();

  switch (action) {
    case "click": {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      flashGhostRing(el);
      dispatchClick(el);
      return { done: true, description: `Clicked "${label}" (${where})` };
    }
    case "type":
    case "set": {
      if (text === undefined) {
        return { error: `Action "${action}" needs a "text" argument.` };
      }
      el.scrollIntoView({ block: "center", inline: "nearest" });
      flashGhostRing(el);
      return writeValue(el, action, text, label, where);
    }
    case "scroll": {
      flashGhostRing(el);
      const dir = text === "up" ? "up" : "down";
      const target = scrollableFor(el);
      target.scrollBy({
        top: target.clientHeight * 0.8 * (dir === "up" ? -1 : 1),
        behavior: "auto",
      });
      return {
        done: true,
        description: `Scrolled ${dir} in "${label}" (${where})`,
      };
    }
    default:
      return {
        error: `Unknown action "${action}" — use click, type, set, or scroll.`,
      };
  }
}

/** Full pointer sequence, not a bare .click(): React's delegated handlers
 * fire on bubbled untrusted events (it never checks isTrusted), and some of
 * this app's rows listen on mousedown/pointerdown rather than click. */
function dispatchClick(el: Element): void {
  const r = el.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  if (el instanceof HTMLElement) el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.dispatchEvent(new MouseEvent("click", init));
}

/** React controlled inputs ignore a plain `el.value = x` because React has
 * already patched the value property on the instance; going through the
 * NATIVE prototype setter and then dispatching a bubbling "input" makes
 * React's onChange see it as a real edit. */
function writeValue(
  el: Element,
  action: "type" | "set",
  text: string,
  label: string,
  where: string,
): Record<string, unknown> {
  const said = truncate(text, 40);
  const done = (description: string) => ({ done: true, description });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    const next = action === "type" ? el.value + text : text;
    const proto =
      el instanceof HTMLInputElement
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return done(
      action === "type"
        ? `Typed "${said}" into "${label}" (${where})`
        : `Set "${label}" (${where}) to "${said}"`,
    );
  }

  if (el instanceof HTMLSelectElement) {
    el.focus();
    const wanted = text.trim().toLowerCase();
    const option =
      Array.from(el.options).find((o) => o.value === text) ??
      Array.from(el.options).find(
        (o) => o.text.trim().toLowerCase() === wanted,
      );
    if (!option) {
      return { error: `"${text}" is not an option of "${label}".` };
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(el, option.value);
    else el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return done(`Set "${label}" (${where}) to "${truncate(option.text, 40)}"`);
  }

  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    el.textContent = action === "type" ? (el.textContent ?? "") + text : text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return done(
      action === "type"
        ? `Typed "${said}" into "${label}" (${where})`
        : `Set "${label}" (${where}) to "${said}"`,
    );
  }

  return { error: `"${label}" doesn't accept text — it's a ${roleFor(el)}.` };
}

function scrollableFor(el: Element): Element {
  let node: Element | null = el;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

// ------------------------------------------------------------- screenshot

/** DOM-composite FALLBACK: the real whole-window capture lives in Rust; this
 * grabs just the viewer pane's visual content (PDF.js canvas / image) when
 * the native path isn't available. */
function viewScreenshot(): Record<string, unknown> {
  const noVisual = {
    error:
      "No visual content is open in the viewer — open an image or PDF first, or use ui_snapshot for the interface.",
  };
  const pane =
    document.querySelector(".viewer") ??
    document.querySelector('main [class*="viewer"]');
  if (!pane) return noVisual;

  // PDF.js renders one canvas per page — take the one most on screen.
  let source: HTMLCanvasElement | HTMLImageElement | null = null;
  let best = 0;
  for (const canvas of Array.from(pane.querySelectorAll("canvas"))) {
    const area = visibleArea(canvas);
    if (area > best) {
      best = area;
      source = canvas;
    }
  }
  if (!source) {
    const img = pane.querySelector("img");
    if (img && img.naturalWidth > 0 && isVisible(img)) source = img;
  }
  if (!source) return noVisual;

  const srcW =
    source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const srcH =
    source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
  if (!srcW || !srcH) return noVisual;

  try {
    return {
      imageB64: drawToPngB64(source, srcW, srcH, VISION_MAX_WIDTH),
      note: "DOM-composite fallback capture of the viewer content only — window chrome and overlays are not included.",
    };
  } catch {
    // A tainted canvas (cross-origin image) throws on toDataURL.
    return {
      error:
        "The viewer content couldn't be exported from the page — use the native window capture instead.",
    };
  }
}

function visibleArea(el: Element): number {
  const r = el.getBoundingClientRect();
  const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  return Math.max(0, w) * Math.max(0, h);
}


// ------------------------------------------------------------ media frame

/** Grab one frame of a video at a timestamp via the roommedia:// streaming
 * protocol (ADD-24 tokens) — a hidden <video> seeks and paints to canvas, so
 * no decoded bytes ever leave the webview.
 *
 * The grab itself lives in `viewers/frameGrab.ts`: the video viewer's "Save
 * frame" button runs the same code, and the two fixes that make it work at all
 * (CORS before src, wait for a PRESENTED frame) must not exist in two copies.
 * This wrapper only caps the result for the vision model. */
async function mediaFrame(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = typeof args.token === "string" ? args.token : "";
  const mime = typeof args.mime === "string" ? args.mime : "";
  const seconds = typeof args.seconds === "number" ? args.seconds : 0;
  if (!token) return { error: "media_frame needs a media token." };
  return { ...(await grabFrame(token, mime, seconds, VISION_MAX_WIDTH)) };
}
