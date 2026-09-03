import "./driver.css";
import type { AgentUiRequest } from "../api";
import { drawToPngB64, grabFrame } from "../viewers/frameGrab";
import {
  flashGhostRing,
  isVisible,
  labelFor,
  markedElement,
  regionFor,
  removeSomLayer,
  roleFor,
  truncate,
  uiSnapshot,
} from "./driverSnapshot";
import { handleSkinAgentRequest, type SkinAgentRequestKind } from "../skin/skinAgentBridge";

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

/** Every capture that goes to a VISION MODEL is capped here — the model gains
 * nothing from a 4K still and the bridge payload is base64. Captures the user
 * keeps (an exported video frame) are not capped: that would silently save a
 * 1280px PNG of a 4K video. */
const VISION_MAX_WIDTH = 1280;

export async function handleAgentUiRequest(
  req: AgentUiRequest,
): Promise<Record<string, unknown>> {
  try {
    return await knownAgentUiRequest(req);
  } catch (e) {
    // The contract is "never throw" — the backend side of the bridge is
    // awaiting resolve_agent_ui and a lost reply would hang the agent turn.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function knownAgentUiRequest(
  req: AgentUiRequest,
): Promise<Record<string, unknown>> {
  if (isSkinRequest(req.kind)) {
    return handleSkinAgentRequest(req.kind, req.args);
  }
  switch (req.kind) {
    case "ui_snapshot":
      return uiSnapshot();
    case "ui_act":
      return uiAct(req.args);
    case "view_screenshot":
      return viewScreenshot();
    case "media_frame":
      return mediaFrame(req.args);
  }
  // Unreachable for a well-typed request; a newer backend could still send
  // a kind this build doesn't know.
  return { error: `Unknown agent UI request kind "${String(req.kind)}".` };
}

const SKIN_REQUESTS: ReadonlySet<string> = new Set([
  "skin_read", "skin_update", "skin_undo", "skin_validate", "skin_save",
]);

function isSkinRequest(kind: AgentUiRequest["kind"]): kind is SkinAgentRequestKind {
  return SKIN_REQUESTS.has(kind);
}

// -------------------------------------------------------------------- act

function uiAct(args: Record<string, unknown>): Record<string, unknown> {
  const request = uiActionRequest(args);
  const target = actionTarget(request.mark);
  if ("error" in target) return { error: target.error };
  return performUiAction(target.el, request);
}

interface UiActionRequest {
  mark: number;
  action: string;
  text: string | undefined;
}

interface UiActionTarget {
  el: Element;
}

interface UiActionError {
  error: string;
}

function uiActionRequest(args: Record<string, unknown>): UiActionRequest {
  return {
    mark: typeof args.mark === "number" ? args.mark : NaN,
    action: typeof args.action === "string" ? args.action : "",
    text: typeof args.text === "string" ? args.text : undefined,
  };
}

function actionTarget(mark: number): UiActionTarget | UiActionError {
  const el = markedElement(mark);
  if (!el) return { error: "That element is gone — take a fresh ui_snapshot." };
  if (isStaleMark(el, mark)) {
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
  return { el };
}

function isStaleMark(el: Element, mark: number): boolean {
  return !el.isConnected || el.getAttribute("data-agent-mark") !== String(mark);
}

function performUiAction(
  el: Element,
  request: UiActionRequest,
): Record<string, unknown> {
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
  // Ahead of the action guards, so invalid calls clear it too. That is
  // deliberate and harmless: a call the agent got wrong is still the end of the
  // snapshot it was reading.
  removeSomLayer();
  if (request.action === "click") return clickMarkedElement(el, label, where);
  if (isTextAction(request.action)) {
    return writeMarkedElement(el, request.action, request.text, label, where);
  }
  if (request.action === "scroll") {
    return scrollMarkedElement(el, request.text, label, where);
  }
  return {
    error: `Unknown action "${request.action}" — use click, type, set, or scroll.`,
  };
}

function isTextAction(action: string): action is "type" | "set" {
  return action === "type" || action === "set";
}

function clickMarkedElement(
  el: Element,
  label: string,
  where: string,
): Record<string, unknown> {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  flashGhostRing(el);
  dispatchClick(el);
  return { done: true, description: `Clicked "${label}" (${where})` };
}

function writeMarkedElement(
  el: Element,
  action: "type" | "set",
  text: string | undefined,
  label: string,
  where: string,
): Record<string, unknown> {
  if (text === undefined) return { error: `Action "${action}" needs a "text" argument.` };
  el.scrollIntoView({ block: "center", inline: "nearest" });
  flashGhostRing(el);
  return writeValue(el, action, text, label, where);
}

function scrollMarkedElement(
  el: Element,
  text: string | undefined,
  label: string,
  where: string,
): Record<string, unknown> {
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
  const textResult = writeTextControl(el, action, text, said, label, where);
  if (textResult) return textResult;
  const selectResult = writeSelectControl(el, text, label, where);
  if (selectResult) return selectResult;
  const editableResult = writeEditableElement(el, action, text, said, label, where);
  if (editableResult) return editableResult;

  return { error: `"${label}" doesn't accept text — it's a ${roleFor(el)}.` };
}

function writeTextControl(
  el: Element,
  action: "type" | "set",
  text: string,
  said: string,
  label: string,
  where: string,
): Record<string, unknown> | undefined {
  if (!isTextControl(el)) return undefined;
  el.focus();
  const next = action === "type" ? el.value + text : text;
  const prototype = el instanceof HTMLInputElement
    ? window.HTMLInputElement.prototype
    : window.HTMLTextAreaElement.prototype;
  setNativeValue(el, prototype, next);
  dispatchInputAndChange(el);
  return completedTextAction(action, said, label, where);
}

function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  prototype: object,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) {
    setter.call(el, value);
    return;
  }
  el.value = value;
}

function dispatchInputAndChange(el: Element): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function completedTextAction(
  action: "type" | "set",
  said: string,
  label: string,
  where: string,
): Record<string, unknown> {
  return action === "type"
    ? { done: true, description: `Typed "${said}" into "${label}" (${where})` }
    : { done: true, description: `Set "${label}" (${where}) to "${said}"` };
}

function writeSelectControl(
  el: Element,
  text: string,
  label: string,
  where: string,
): Record<string, unknown> | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined;
  el.focus();
  const option = matchingOption(el, text);
  if (!option) return { error: `"${text}" is not an option of "${label}".` };
  setNativeValue(el, window.HTMLSelectElement.prototype, option.value);
  dispatchInputAndChange(el);
  return { done: true, description: `Set "${label}" (${where}) to "${truncate(option.text, 40)}"` };
}

function matchingOption(
  select: HTMLSelectElement,
  text: string,
): HTMLOptionElement | undefined {
  const wanted = text.trim().toLowerCase();
  return (
    Array.from(select.options).find((option) => option.value === text) ??
    Array.from(select.options).find(
      (option) => option.text.trim().toLowerCase() === wanted,
    )
  );
}

function writeEditableElement(
  el: Element,
  action: "type" | "set",
  text: string,
  said: string,
  label: string,
  where: string,
): Record<string, unknown> | undefined {
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return undefined;
  el.focus();
  el.textContent = action === "type" ? (el.textContent ?? "") + text : text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return completedTextAction(action, said, label, where);
}

function scrollableFor(el: Element): Element {
  let node: Element | null = el;
  while (node) {
    if (isScrollable(node)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

function isScrollable(el: Element): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  return hasScrollableOverflow(getComputedStyle(el).overflowY);
}

function hasScrollableOverflow(overflowY: string): boolean {
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

// ------------------------------------------------------------- screenshot

/** DOM-composite FALLBACK: the real whole-window capture lives in Rust; this
 * grabs just the viewer pane's visual content (PDF.js canvas / image) when
 * the native path isn't available. */
function viewScreenshot(): Record<string, unknown> {
  const pane = viewerPane();
  if (!pane) return noVisualScreenshot();
  const source = viewerSource(pane);
  if (!source) return noVisualScreenshot();
  const [srcW, srcH] = sourceDimensions(source);
  if (!srcW || !srcH) return noVisualScreenshot();
  return captureViewerSource(source, srcW, srcH);
}

function noVisualScreenshot(): Record<string, unknown> {
  return {
    error:
      "No visual content is open in the viewer — open an image or PDF first, or use ui_snapshot for the interface.",
  };
}

function viewerPane(): Element | null {
  return (
    document.querySelector(".viewer") ??
    document.querySelector('main [class*="viewer"]')
  );
}

function viewerSource(
  pane: Element,
): HTMLCanvasElement | HTMLImageElement | null {
  return mostVisibleCanvas(pane) ?? visibleViewerImage(pane);
}

function mostVisibleCanvas(pane: Element): HTMLCanvasElement | null {
  // PDF.js renders one canvas per page — take the one most on screen.
  let source: HTMLCanvasElement | null = null;
  let best = 0;
  for (const canvas of Array.from(pane.querySelectorAll("canvas"))) {
    const area = visibleArea(canvas);
    if (area > best) {
      best = area;
      source = canvas;
    }
  }
  return source;
}

function visibleViewerImage(pane: Element): HTMLImageElement | null {
  const image = pane.querySelector("img");
  if (!image) return null;
  if (!(image.naturalWidth > 0)) return null;
  if (!isVisible(image)) return null;
  return image;
}

function sourceDimensions(
  source: HTMLCanvasElement | HTMLImageElement,
): [number, number] {
  return source instanceof HTMLCanvasElement
    ? [source.width, source.height]
    : [source.naturalWidth, source.naturalHeight];
}

function captureViewerSource(
  source: HTMLCanvasElement | HTMLImageElement,
  srcW: number,
  srcH: number,
): Record<string, unknown> {
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
