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
  const elements = Array.isArray(value.elements) ? value.elements.map(object) : [];
  const lines = elements.map((item) => {
    const ref = String(item.ref ?? item.mark ?? "?");
    const role = String(item.role ?? "control");
    const label = String(item.label ?? item.name ?? "");
    const region = typeof item.region === "string" && item.region ? ` — ${item.region}` : "";
    const state = typeof item.state === "string" && item.state ? ` (${item.state})` : "";
    return `[${ref}] ${role} "${label}"${region}${state}`;
  });
  if (lines.length === 0) return "No interactive controls are visible on this page.";
  const title = typeof value.title === "string" && value.title ? `${value.title}\n` : "";
  return `${title}${lines.join("\n")}`;
}

function formatRead(raw: unknown): string {
  const value = object(raw);
  const title = typeof value.title === "string" && value.title ? `${value.title}\n` : "";
  const url = typeof value.url === "string" && value.url ? `Source: ${value.url}\n\n` : "";
  const text = typeof value.text === "string" ? value.text : "";
  const next = typeof value.nextOffset === "number" ? `\n\nContinue with offset ${value.nextOffset}.` : "";
  return `${title}${url}${text}${next}`.trim() || "This page has no readable text.";
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

  return async (name: string, args: Record<string, unknown>, effects: ToolEffects): Promise<ToolOutcome | null> => {
    if (!name.startsWith("browse_")) return null;
    try {
      if (!deps.state.room) throw new Error("No room is open.");
      if (deps.browser.takeover) throw new Error("The user is controlling the browser right now. Wait until they hand it back.");
      if (name !== "browse_open" && deps.browser.isOpen()) await deps.browser.waitReady();
      switch (name) {
        case "browse_open": {
          const address = classify(String(args.url ?? ""));
          if (address === null) throw new Error("Say what to open, or what to search for.");
          if (address.kind === "search") {
            const masked = maskOutboundWeb(address.query);
            const query = masked?.masked ?? address.query;
            const result = await runSearch({
              db: deps.state.room.conn,
              searchForBrowser,
              hasModelConfigured: (db) => modelSetting(db) !== null,
              journal: (kind, url, detail) => deps.browser.journal(kind, url, detail),
            }, query);
            deps.emit("browser-searched", result);
            return ok(`${formatHitsForAgent(result)}${masked ? webMaskNote(masked.hidden) : ""}`);
          }
          const hidden = outboundUrlHides(address.url);
          if (hidden !== null) return ok(`Not opened: this address carries ${hidden} protected name(s), and Cloud privacy is on.`);
          const url = await browserNavigate(commandDeps(), address.url);
          await deps.browser.waitReady(OPEN_BUDGET_MS);
          deps.browser.journal("open", url, "Opened by the agent");
          deps.emit("browser-navigated", url);
          const settled = object(await deps.browser.callAsync("settle", { budget_ms: 8_000 }, 12_000));
          return ok(formatSnapshot(settled.snapshot ?? settled));
        }
        case "browse_read": {
          const page = await deps.browser.call("read", { mode: String(args.mode ?? "main"), offset: Number(args.offset ?? 0) });
          return ok(formatRead(page));
        }
        case "browse_find": {
          const text = String(args.text ?? "");
          const found = object(await deps.browser.call("find", { text }));
          const matches = Array.isArray(found.matches) ? found.matches : [];
          return ok(matches.length === 0 ? `Nothing on this page matches "${text}".` : `${matches.length} match(es) for "${text}":\n${formatSnapshot({ elements: matches })}`);
        }
        case "browse_snapshot": return ok(formatSnapshot(await deps.browser.call("snapshot", {})));
        case "browse_do": {
          const actions = Array.isArray(args.actions) ? args.actions : [];
          if (actions.length === 0) throw new Error("browse_do needs at least one action.");
          const info = object(await deps.browser.call("info", {}));
          for (const typed of typedActions(args)) {
            const answer = object(await requestAgentUi(deps.agentUi, deps.emit, "browse_consent", {
              url: String(info.url ?? ""), field: typed.field, text: typed.text, entities: [],
            }));
            if (answer.approved !== true) throw new Error("The user declined, so nothing was typed.");
          }
          const result = object(await deps.browser.callAsync("act", { actions }, 60_000));
          const results = Array.isArray(result.results) ? result.results.map(object) : [];
          const did = results.filter((row) => row.ok === true).map((row) => String(row.did ?? "Done"));
          const summary = did.length ? `Browser: ${did.join("; ")}` : String(result.error ?? "Nothing was done — the first action failed.");
          deps.browser.journal("act", String(info.url ?? ""), summary);
          return result.ok === false ? fail(summary) : ok(`${summary}\n${formatSnapshot(result.snapshot)}`);
        }
        case "browse_look": {
          await deps.browser.callAsync("annotate", { on: true }, 10_000);
          try {
            const png = await deps.browser.captureActivePage();
            effects.pendingImages.push(png.toString("base64"));
            return ok("Captured a picture of the current page with its interactive controls numbered.");
          } finally {
            await deps.browser.callAsync("annotate", { on: false }, 10_000).catch(() => undefined);
          }
        }
        case "browse_save": return ok(await browserSavePage(commandDeps(), String(args.what ?? "page")));
        default: return null;
      }
    } catch (error) {
      deps.browser.journal("error", "", `${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return fail(error);
    }
  };
}
