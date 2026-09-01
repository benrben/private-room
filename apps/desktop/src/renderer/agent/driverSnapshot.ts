/* tsconfig targets ES2020 but WKWebView supplies WeakRef. */
interface AgentElementRef {
  deref(): Element | undefined;
}
declare const WeakRef: new (target: Element) => AgentElementRef;

/** Mark registry is rebuilt for every snapshot; WeakRefs do not retain closed UI. */
const registry = new Map<number, AgentElementRef>();

const MARK_CAP = 80;

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

/** Ordered most-specific-first so each mark reports its surrounding region. */
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

export function uiSnapshot(): Record<string, unknown> {
  document
    .querySelectorAll("[data-agent-mark]")
    .forEach((element) => element.removeAttribute("data-agent-mark"));
  registry.clear();
  removeSomLayer();

  const candidates = interactiveCandidates();
  const overflow = Math.max(0, candidates.length - MARK_CAP);
  const chosen = chooseSnapshotCandidates(candidates, overflow);
  const layer = createSomLayer();
  const elements = snapshotEntries(chosen, layer);
  const summary = snapshotSummary(elements, overflow);
  return { summary, count: elements.length, elements };
}

interface SnapshotCandidate {
  el: Element;
  top: number;
  order: number;
}

function interactiveCandidates(): SnapshotCandidate[] {
  const candidates: SnapshotCandidate[] = [];
  let order = 0;
  for (const element of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (element.closest("[data-agent-blocked]")) continue;
    if (isDisabled(element) || !isVisible(element)) continue;
    candidates.push({
      el: element,
      top: element.getBoundingClientRect().top,
      order: order++,
    });
  }
  return candidates;
}

function chooseSnapshotCandidates(
  candidates: SnapshotCandidate[],
  overflow: number,
): SnapshotCandidate[] {
  if (overflow === 0) return candidates;
  return [...candidates]
    .sort((a, b) => Math.max(a.top, 0) - Math.max(b.top, 0))
    .slice(0, MARK_CAP)
    .sort((a, b) => a.order - b.order);
}

function snapshotEntries(
  chosen: SnapshotCandidate[],
  layer: HTMLDivElement,
): SnapshotEntry[] {
  return chosen.map((candidate, index) =>
    snapshotEntry(candidate.el, index + 1, layer),
  );
}

function snapshotEntry(
  element: Element,
  mark: number,
  layer: HTMLDivElement,
): SnapshotEntry {
  element.setAttribute("data-agent-mark", String(mark));
  registry.set(mark, new WeakRef(element));
  addSomBadge(layer, element, mark);
  const entry: SnapshotEntry = {
    mark,
    role: roleFor(element),
    label: labelFor(element),
    region: regionFor(element),
  };
  const state = stateFor(element);
  if (state !== undefined) entry.state = state;
  return entry;
}

function snapshotSummary(elements: SnapshotEntry[], overflow: number): string {
  const regions = Array.from(new Set(elements.map((entry) => entry.region)));
  const summary = `${elements.length} interactive elements across ${
    regions.join("/") || "app"
  }`;
  return overflow > 0
    ? `${summary}; …and ${overflow} more (scroll to reveal)`
    : summary;
}

export function markedElement(mark: number): Element | undefined {
  return registry.get(mark)?.deref();
}

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (!hasVisibleDimensions(rect) || !isWithinViewport(rect)) return false;
  const probe = element as Element & {
    checkVisibility?: (opts?: { checkVisibilityCSS?: boolean }) => boolean;
  };
  if (typeof probe.checkVisibility === "function") {
    return probe.checkVisibility({ checkVisibilityCSS: true });
  }
  return hasVisibleComputedStyle(element);
}

function hasVisibleDimensions(rect: DOMRect): boolean {
  return !(rect.width <= 0 || rect.height <= 0);
}

function isWithinViewport(rect: DOMRect): boolean {
  return !(
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  );
}

function hasVisibleComputedStyle(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function isDisabled(element: Element): boolean {
  return (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  );
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Read visible text without aria-hidden decoration. */
function visibleText(element: Element): string {
  let output = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.nodeValue ?? "";
    } else if (node instanceof Element) {
      if (node.getAttribute("aria-hidden") === "true") continue;
      output += visibleText(node);
    }
  }
  return output;
}

export function labelFor(element: Element): string {
  const explicit = explicitLabel(element);
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement && element.value) {
    return truncate(element.value, 60);
  }
  return "(unlabeled)";
}

function explicitLabel(element: Element): string | undefined {
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria) return truncate(aria, 60);
  const text = visibleText(element).replace(/\s+/g, " ").trim();
  if (text) return truncate(text, 60);
  const placeholder = element.getAttribute("placeholder")?.trim();
  if (placeholder) return truncate(placeholder, 60);
  const title = element.getAttribute("title")?.trim();
  if (title) return truncate(title, 60);
  return undefined;
}

export function roleFor(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const nativeRole = nativeRoleFor(element);
  if (nativeRole) return nativeRole;
  if (element instanceof HTMLElement && element.isContentEditable) return "textbox";
  return "item";
}

const TAG_ROLES: Readonly<Record<string, string>> = {
  A: "link",
  BUTTON: "button",
  SELECT: "combobox",
  TEXTAREA: "textbox",
};

const INPUT_ROLES: Readonly<Record<string, string>> = {
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  button: "button",
  submit: "button",
  reset: "button",
};

function nativeRoleFor(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    return INPUT_ROLES[element.type] ?? "textbox";
  }
  return TAG_ROLES[element.tagName];
}

function stateFor(element: Element): string | undefined {
  return (
    checkedState(element) ??
    selectedState(element) ??
    selectState(element) ??
    textValueState(element)
  );
}

function checkedState(element: Element): string | undefined {
  if (element instanceof HTMLInputElement && isCheckableInput(element)) {
    return element.checked ? "checked" : "unchecked";
  }
  if (element.getAttribute("aria-checked") === "true") return "checked";
  return undefined;
}

function isCheckableInput(element: HTMLInputElement): boolean {
  return element.type === "checkbox" || element.type === "radio";
}

function selectedState(element: Element): string | undefined {
  if (
    element.getAttribute("aria-selected") === "true" ||
    element.classList.contains("active") ||
    element.classList.contains("selected")
  ) {
    return "selected";
  }
  return undefined;
}

function selectState(element: Element): string | undefined {
  if (element instanceof HTMLSelectElement) {
    const option = element.selectedOptions[0];
    return option ? truncate(option.text.trim(), 40) : undefined;
  }
  return undefined;
}

function textValueState(element: Element): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value ? truncate(element.value, 40) : undefined;
  }
  return undefined;
}

export function regionFor(element: Element): string {
  for (const [selector, name] of REGION_MAP) {
    if (element.closest(selector)) return name;
  }
  return "app";
}

let somLayer: HTMLDivElement | null = null;
let somTimer = 0;

export function removeSomLayer(): void {
  if (somTimer) {
    window.clearTimeout(somTimer);
    somTimer = 0;
  }
  somLayer?.remove();
  somLayer = null;
}

function createSomLayer(): HTMLDivElement {
  removeSomLayer();
  const layer = document.createElement("div");
  layer.className = "agent-som-layer";
  document.body.appendChild(layer);
  somLayer = layer;
  somTimer = window.setTimeout(removeSomLayer, 2500);
  return layer;
}

function addSomBadge(layer: HTMLDivElement, element: Element, mark: number): void {
  const rect = element.getBoundingClientRect();
  const badge = document.createElement("div");
  badge.className = "agent-som-badge";
  badge.textContent = String(mark);
  badge.style.left = `${Math.max(0, rect.left - 6)}px`;
  badge.style.top = `${Math.max(0, rect.top - 8)}px`;
  layer.appendChild(badge);
}

export function flashGhostRing(element: Element): void {
  const rect = element.getBoundingClientRect();
  const ring = document.createElement("div");
  ring.className = "agent-ghost-ring";
  ring.style.left = `${rect.left}px`;
  ring.style.top = `${rect.top}px`;
  ring.style.width = `${rect.width}px`;
  ring.style.height = `${rect.height}px`;
  document.body.appendChild(ring);
  window.setTimeout(() => ring.remove(), 700);
}
