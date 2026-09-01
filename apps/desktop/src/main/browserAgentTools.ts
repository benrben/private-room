import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { ToolEffects, ToolOutcome } from "./execTool.js";
import { Browser, OPEN_BUDGET_MS } from "./browser/browser.js";
import { classify } from "./browser/address.js";
import { browserNavigate, browserSavePage, type BrowseCommandsDeps } from "./browser/browseCommands.js";
import { runSearch, formatHitsForAgent } from "./browser/search.js";
import { searchForBrowser } from "./webSearch.js";
import { modelSetting } from "./gatherContext.js";
import { maskOutboundWeb, outboundUrlHides, webMaskNote } from "./privacy.js";
import { requestAgentUi, type AgentUiRuntime } from "./agentUiSurfaceIpc.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function ok(text: string): ToolOutcome { return { ok: true, text }; }
function fail(error: unknown): ToolOutcome {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function formatSnapshot(raw: unknown): string {
  const value = object(raw);
  const lines = snapshotElements(value).map(formatSnapshotElement);
  if (lines.length === 0) return "No interactive controls are visible on this page.";
  return `${snapshotTitle(value)}${lines.join("\n")}`;
}

function snapshotElements(value: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(value.elements) ? value.elements.map(object) : [];
}

function formatSnapshotElement(item: Record<string, unknown>): string {
  return `[${snapshotField(item.ref, item.mark, "?")}] ${snapshotField(item.role, undefined, "control")} "${snapshotField(item.label, item.name, "")}"${snapshotDetail(item.region, " — ", "")}${snapshotDetail(item.state, " (", ")")}`;
}

function snapshotField(primary: unknown, secondary: unknown, fallback: string): string {
  return String(primary ?? secondary ?? fallback);
}

function snapshotDetail(value: unknown, prefix: string, suffix: string): string {
  return typeof value === "string" && value !== "" ? `${prefix}${value}${suffix}` : "";
}

function snapshotTitle(value: Record<string, unknown>): string {
  return snapshotDetail(value.title, "", "\n");
}

function formatRead(raw: unknown): string {
  const value = object(raw);
  const formatted = `${readTitle(value)}${readUrl(value)}${readText(value)}${readContinuation(value)}`.trim();
  return formatted === "" ? "This page has no readable text." : formatted;
}

function readTitle(value: Record<string, unknown>): string {
  return snapshotDetail(value.title, "", "\n");
}

function readUrl(value: Record<string, unknown>): string {
  return snapshotDetail(value.url, "Source: ", "\n\n");
}

function readText(value: Record<string, unknown>): string {
  return typeof value.text === "string" ? value.text : "";
}

function readContinuation(value: Record<string, unknown>): string {
  return typeof value.nextOffset === "number" ? `\n\nContinue with offset ${value.nextOffset}.` : "";
}

function typedActions(args: Record<string, unknown>): Array<{ field: string; text: string }> {
  const actions = Array.isArray(args.actions) ? args.actions.map(object) : [];
  const out: Array<{ field: string; text: string }> = [];
  for (const action of actions) {
    const type = object(action.type);
    if (typeof type.text === "string" && type.text !== "") {
      out.push({ field: String(type.ref ?? "a field"), text: type.text });
    }
  }
  return out;
}

export interface BrowserAgentRuntimeDeps {
  state: RoomManagerState;
  roomDeps: RoomManagerDeps;
  browser: Browser;
  agentUi: AgentUiRuntime;
  emit: EventSender;
}

export function createBrowserAgentTool(deps: BrowserAgentRuntimeDeps) {
  const commandDeps = (): BrowseCommandsDeps => ({
    browser: deps.browser,
    db: deps.state.room?.conn ?? null,
    roomPath: deps.state.room?.path ?? "",
    scheduleAutoIndex: () => undefined,
    schedulePrivacyScan: () => undefined,
    emitFilesChanged: () => deps.emit("room-files-changed", {}),
  });

  return (name: string, args: Record<string, unknown>, effects: ToolEffects): Promise<ToolOutcome | null> =>
    callBrowserAgentTool(deps, commandDeps, name, args, effects);
}

type BrowserCommandDeps = () => BrowseCommandsDeps;

interface BrowserToolContext {
  deps: BrowserAgentRuntimeDeps;
  commandDeps: BrowserCommandDeps;
  room: NonNullable<RoomManagerState["room"]>;
}

type BrowserToolHandler = (context: BrowserToolContext, args: Record<string, unknown>, effects: ToolEffects) => Promise<ToolOutcome>;

async function callBrowserAgentTool(
  deps: BrowserAgentRuntimeDeps,
  commandDeps: BrowserCommandDeps,
  name: string,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome | null> {
  if (!name.startsWith("browse_")) {
    return null;
  }
  try {
    const context = await prepareBrowserTool(deps, commandDeps, name);
    return await dispatchBrowserTool(name, context, args, effects);
  } catch (error) {
    deps.browser.journal("error", "", `${name} failed: ${errorMessage(error)}`);
    return fail(error);
  }
}

async function prepareBrowserTool(
  deps: BrowserAgentRuntimeDeps,
  commandDeps: BrowserCommandDeps,
  name: string,
): Promise<BrowserToolContext> {
  const room = requireBrowserRoom(deps.state);
  if (deps.browser.takeover) {
    throw new Error("The user is controlling the browser right now. Wait until they hand it back.");
  }
  if (name !== "browse_open" && deps.browser.isOpen()) {
    await deps.browser.waitReady();
  }
  return { deps, commandDeps, room };
}

function requireBrowserRoom(state: RoomManagerState): NonNullable<RoomManagerState["room"]> {
  if (state.room === null) {
    throw new Error("No room is open.");
  }
  return state.room;
}

function dispatchBrowserTool(
  name: string,
  context: BrowserToolContext,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome | null> {
  const handler = BROWSER_TOOL_HANDLERS[name];
  return handler === undefined ? Promise.resolve(null) : handler(context, args, effects);
}

async function browseOpen(
  context: BrowserToolContext,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const address = classify(String(args.url ?? ""));
  if (address === null) {
    throw new Error("Say what to open, or what to search for.");
  }
  return address.kind === "search" ? browseSearch(context, address.query) : browseUrl(context, address.url);
}

async function browseSearch(context: BrowserToolContext, query: string): Promise<ToolOutcome> {
  const masked = maskOutboundWeb(query);
  const result = await runSearch({
    db: context.room.conn,
    searchForBrowser,
    hasModelConfigured: (db) => modelSetting(db) !== null,
    journal: (kind, url, detail) => context.deps.browser.journal(kind, url, detail),
  }, masked?.masked ?? query);
  context.deps.emit("browser-searched", result);
  return ok(`${formatHitsForAgent(result)}${masked ? webMaskNote(masked.hidden) : ""}`);
}

async function browseUrl(context: BrowserToolContext, address: string): Promise<ToolOutcome> {
  const hidden = outboundUrlHides(address);
  if (hidden !== null) {
    return ok(`Not opened: this address carries ${hidden} protected name(s), and Cloud privacy is on.`);
  }
  const url = await browserNavigate(context.commandDeps(), address);
  await context.deps.browser.waitReady(OPEN_BUDGET_MS);
  context.deps.browser.journal("open", url, "Opened by the agent");
  context.deps.emit("browser-navigated", url);
  const settled = object(await context.deps.browser.callAsync("settle", { budget_ms: 8_000 }, 12_000));
  return ok(formatSnapshot(settled.snapshot ?? settled));
}

async function browseRead(
  context: BrowserToolContext,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const page = await context.deps.browser.call("read", { mode: String(args.mode ?? "main"), offset: Number(args.offset ?? 0) });
  return ok(formatRead(page));
}

async function browseFind(
  context: BrowserToolContext,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const text = String(args.text ?? "");
  const found = object(await context.deps.browser.call("find", { text }));
  const matches = Array.isArray(found.matches) ? found.matches : [];
  return ok(findSummary(text, matches));
}

function findSummary(text: string, matches: unknown[]): string {
  if (matches.length === 0) {
    return `Nothing on this page matches "${text}".`;
  }
  return `${matches.length} match(es) for "${text}":\n${formatSnapshot({ elements: matches })}`;
}

async function browseSnapshot(
  context: BrowserToolContext,
  _args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  return ok(formatSnapshot(await context.deps.browser.call("snapshot", {})));
}

async function browseDo(
  context: BrowserToolContext,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  if (actions.length === 0) {
    throw new Error("browse_do needs at least one action.");
  }
  const info = object(await context.deps.browser.call("info", {}));
  await confirmTypedActions(context, args, info);
  const result = object(await context.deps.browser.callAsync("act", { actions }, 60_000));
  return browserActionOutcome(context, info, result);
}

async function confirmTypedActions(
  context: BrowserToolContext,
  args: Record<string, unknown>,
  info: Record<string, unknown>,
): Promise<void> {
  for (const typed of typedActions(args)) {
    const answer = object(await requestAgentUi(context.deps.agentUi, context.deps.emit, "browse_consent", {
      url: String(info.url ?? ""), field: typed.field, text: typed.text, entities: [],
    }));
    if (answer.approved !== true) {
      throw new Error("The user declined, so nothing was typed.");
    }
  }
}

function browserActionOutcome(
  context: BrowserToolContext,
  info: Record<string, unknown>,
  result: Record<string, unknown>,
): ToolOutcome {
  const results = Array.isArray(result.results) ? result.results.map(object) : [];
  const did = results.filter((row) => row.ok === true).map((row) => String(row.did ?? "Done"));
  const summary = did.length > 0 ? `Browser: ${did.join("; ")}` : String(result.error ?? "Nothing was done — the first action failed.");
  context.deps.browser.journal("act", String(info.url ?? ""), summary);
  return result.ok === false ? fail(summary) : ok(`${summary}\n${formatSnapshot(result.snapshot)}`);
}

async function browseLook(
  context: BrowserToolContext,
  _args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  await context.deps.browser.callAsync("annotate", { on: true }, 10_000);
  try {
    const png = await context.deps.browser.captureActivePage();
    effects.pendingImages.push(png.toString("base64"));
    return ok("Captured a picture of the current page with its interactive controls numbered.");
  } finally {
    await context.deps.browser.callAsync("annotate", { on: false }, 10_000).catch(() => undefined);
  }
}

async function browseSave(
  context: BrowserToolContext,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  return ok(await browserSavePage(context.commandDeps(), String(args.what ?? "page")));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BROWSER_TOOL_HANDLERS: Readonly<Record<string, BrowserToolHandler>> = {
  browse_open: browseOpen,
  browse_read: browseRead,
  browse_find: browseFind,
  browse_snapshot: browseSnapshot,
  browse_do: browseDo,
  browse_look: browseLook,
  browse_save: browseSave,
};
