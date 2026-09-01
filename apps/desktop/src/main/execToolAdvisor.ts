/** Cohesive extraction from execTool.ts; its public API remains on that module. */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { webAccessEnabled } from "./browser/webAccess.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  memoriesLike,
  updateMemory,
  type Memory,
} from "./db-host/memories.js";
import {
  createSkill as createSkillDb,
  deleteSkillResource as deleteSkillResourceDb,
  findSkill as findSkillDb,
  getSkillResource as getSkillResourceDb,
  listSkillResources as listSkillResourcesDb,
  listSkills as listSkillsDb,
  setSkillEnabled as setSkillEnabledDb,
  updateSkill as updateSkillDb,
  upsertSkillResource as upsertSkillResourceDb,
} from "./db-host/skills.js";
import { agentDeleteSkill, agentSaveSkill } from "./skillsCmds.js";
import {
  execAnnotateFile,
  execListRoomFiles,
  execOpenFile,
  execSearchRoom,
} from "./fileTools.js";
import {
  execDraw,
  execDrawInRoom,
  execReadDrawing,
  execReadDrawingInRoom,
  type SketchRoom,
} from "./sketchCommands.js";
import { execViewFileImage } from "./staticVisualTools.js";
import {
  agentDeleteMcp,
  agentListMcps,
  agentReadMcp,
  agentSaveMcp,
} from "./mcpConfig.js";
import type { ServerConfig } from "./mcpClient.js";
import {
  execCreateFile,
  execMarkImage,
  execMergeFiles,
  execMoveFile,
  execOrganizeFiles,
  execRenameFile,
  execSetInLibrary,
  execTrashFiles,
} from "./organizeTools.js";
import {
  DOWNLOAD_ENGINE_MEDIA,
  startDownloadJobInner,
  type DownloadJobDeps,
} from "./jobDownload.js";
import { makeRunAdvisorCli, realRunAdvisorCli, type RunExternalOptions } from "./externalAdvisor.js";
import {
  agentDeleteWorkflow,
  agentListWorkflows,
  agentRunWorkflow,
  agentSaveWorkflow,
  agentTestWorkflow,
  agentUpdateWorkflow,
  type AgentTestWorkflowDeps,
} from "./workflowRuns.js";
import { DELETE_DECLINED } from "./mcpConfig.js";
import { getFreshWebPage, getFreshWebSearch, putWebSearch, saveWebPage } from "./db-host/webCache.js";
import { blockedNote, fetchPage, joinNames, renderHits, searchWeb, type FetchedPage, type SearchPage } from "./web.js";
import { fetchPageReply } from "./fetchPageWindow.js";
import { maskOutboundWeb as privacyMaskOutboundWeb, outboundUrlHides, webMaskNote } from "./privacy.js";
import { clampBytes, clampBytesMarked, normalizeForMatch } from "./textClamp.js";
import {
  BUILTIN_TOOL_NAMES,
  MAX_ADVISOR_CALLS,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_LISTED_MEMORIES,
  SKILL_AGENT_IDS,
  isBrowseTool,
  maskedArgsNote,
  masksOutboundArgs,
  type McpRoute,
} from "./toolSpecs.js";
import { missingRequiredArg } from "./toolSchema.js";
import { mindmapSpec, RUN_STUDIO_PIPELINE_GAP as RUN_STUDIO_PIPELINE_GAP_MINDMAP } from "./studiosMindmap.js";
import { EXEC_STUDIO_FLASHCARDS_GAP, execStudioFlashcards } from "./studiosFlashcards.js";
import { execStudio, type RunStudioDeps, type StudioSpec } from "./studiosCmds.js";
import { podcastSpec, RUN_STUDIO_PIPELINE_GAP as RUN_STUDIO_PIPELINE_GAP_PODCAST } from "./studiosPodcast.js";
import { execTool } from "./execToolDispatch.js";
import { ExecToolDeps, ToolEffects, ToolOutcome, errMessage, notImplemented, ok } from "./execToolEffects.js";
import { asString } from "./execToolMemory.js";
// -------------------------------------------------------- REAL: consult_advisor

/**
 * ADD-21: delegate a hard subtask to a cloud CLI. Ported from `exec_tool`'s own
 * `"consult_advisor"` arm (agent.rs lines ~4620-4662) — the SECOND of the two
 * budget checks, deliberately.
 *
 * `bridgeDispatcher.ts` already refused an over-budget call against the
 * per-turn `AdvisorRuntime` counter; this one reads `effects.advisorCalls`, a
 * different counter on a different object, and Rust keeps both for a stated
 * reason: "the tool is only in the catalog when the advanced setting is on and
 * a CLI exists, but re-check the budget here so the model can't overspend the
 * user's cloud account by looping". A native (non-bridge) chat loop reaches
 * THIS check and nothing else.
 *
 * The budget is spent BEFORE the slow call so a mid-flight retry cannot
 * double-spend, and a CLI that fails comes back as `Ok` — the local model then
 * recovers by answering itself instead of showing the user a raw tool error.
 *
 * {@link ExecToolDeps.runAdvisorCli} is the injected seam. The subprocess
 * behind it IS ported (`externalAdvisor.ts`); what no code path does yet is
 * INSTALL it, which {@link withRealAdvisorCli} exists to do. Without it this
 * REFUSES rather than inventing an advisor's answer — the one thing a tool
 * whose whole output is "what a second model said" must never do.
 */
export async function execConsultAdvisor(
  deps: ExecToolDeps,
  effects: ToolEffects,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const budgetOutcome = advisorBudgetOutcome(effects);
  if (budgetOutcome !== null) return budgetOutcome;
  const question = asString(args.question).trim();
  const want = typeof args.advisor === "string" ? args.advisor : "claude";
  const engine = want === "codex" ? "codex-cli" : "claude-cli";
  const cli = deps.runAdvisorCli;
  if (cli === undefined) return missingAdvisorCliOutcome();
  // Spend the budget before the slow call so a mid-flight retry can't
  // double-spend. Deliberately AFTER the not-implemented refusal above: a
  // refusal that cost nothing must not also cost the turn's only consult.
  effects.advisorCalls += 1;
  return advisorReply(cli, engine, want, question);
}

export function advisorBudgetOutcome(effects: ToolEffects): ToolOutcome | null {
  if (effects.advisorCalls < MAX_ADVISOR_CALLS) return null;
  return ok(
    "You have already consulted an advisor this turn. Use that answer, or " +
      "answer the user yourself — do not consult again.",
  );
}

export function missingAdvisorCliOutcome(): ToolOutcome {
  return notImplemented(
    "nothing has installed the advisor seam on this deps object. The advisor SELECTION, both " +
      "budget caps AND the CLI subprocess itself (externalAdvisor.ts's runExternalCli) are all " +
      "implemented for real — the only missing piece is a host bootstrap that builds its deps " +
      "through execTool.ts's withRealAdvisorCli(). Do NOT re-port run_external",
  );
}

export async function advisorReply(
  runAdvisorCli: NonNullable<ExecToolDeps["runAdvisorCli"]>,
  engine: "claude-cli" | "codex-cli",
  want: string,
  question: string,
): Promise<ToolOutcome> {
  try {
    const answer = await runAdvisorCli(engine, question);
    return ok(`Advisor (${want}) replied:\n\n${answer}`);
  } catch (e) {
    // Ok, not an error, so the local model recovers by answering itself
    // instead of surfacing a raw tool error to the user.
    return ok(
      `The advisor could not be reached (${errMessage(e)}). Answer the user from what you ` +
        `already have.`
    );
  }
}

/**
 * ADD-21 wiring: fills {@link ExecToolDeps.runAdvisorCli} with the real
 * `claude -p` / `codex exec` subprocess (`externalAdvisor.ts`'s port of
 * `run_external`) whenever a caller has not already supplied its own —
 * purely additive, and it never touches {@link execConsultAdvisor} above:
 * every existing test that builds its own bare `ExecToolDeps` object literal
 * (this file's own `deps()` test helper included) still exercises the
 * injected-seam behavior exactly as before, because nothing calls this
 * function on their behalf. A REAL caller constructing the deps a running app
 * hands to {@link execTool} should build its object THROUGH this
 * (`execTool("consult_advisor", args, effects, withRealAdvisorCli(deps))`) so
 * `consult_advisor` gets a real advisor instead of `NOT_IMPLEMENTED`.
 *
 * The PRIVACY DOOR needs nothing from here: `externalAdvisor.ts` looks
 * `privacy.ts`'s active policy up in the leaf itself, exactly as
 * `run_external` calls `active_policy()`, so a caller cannot forget to pass
 * it. `options` is for the two pieces that must be handed DOWN because they
 * belong to one ask rather than to the process — a per-ask MCP bridge and the
 * run's cancel flag. Neither has a live instance anywhere in this migration
 * yet (no ported per-ask bridge lifecycle; no ported chat loop that hands
 * `execTool` a run-scoped flag), so the default passes neither.
 *
 * THE BRIDGE IS CLAUDE-ONLY, and this function — not the leaf — is where that
 * rule lives, because it is a property of the `consult_advisor` CALL SITE:
 * agent.rs line 4642 is `let bridge = if engine == "claude-cli" {
 * advisor_bridge } else { None };`, with the reason in its own comment ("the
 * per-ask advisor bridge … is claude-only; codex gets a plain pipe").
 * `runExternalCli` itself supports the bridge on BOTH engines on purpose —
 * `jobs/workflow.rs` really does hand a codex chat turn one — so restricting
 * it there would break the other caller. Binding `options` before the engine
 * is known is exactly how a codex advisor would have quietly acquired the
 * room's file tools, so the seam below picks per call instead.
 *
 * WIRING HAZARD for whichever host bootstrap fills this in: pass `cancel`.
 * Rust's own arm passes `cancel.clone()` on every consult, and it is the ONLY
 * kill path either port has — there is no wall-clock timeout in `run_external`
 * or in `runExternalCli`. Without it a wedged `claude -p` leaves this
 * `await` pending for the life of the process, holding the turn open with no
 * way for Stop to end it.
 */
export function withRealAdvisorCli(deps: ExecToolDeps, options?: RunExternalOptions): ExecToolDeps {
  if (deps.runAdvisorCli !== undefined) {
    return deps;
  }
  if (options === undefined) {
    return { ...deps, runAdvisorCli: realRunAdvisorCli };
  }
  const withBridge = makeRunAdvisorCli(options);
  if (options.bridge === undefined) {
    return { ...deps, runAdvisorCli: withBridge };
  }
  const withoutBridge = makeRunAdvisorCli({ ...options, bridge: undefined });
  return {
    ...deps,
    runAdvisorCli: (engine, question) =>
      engine === "claude-cli" ? withBridge(engine, question) : withoutBridge(engine, question),
  };
}

/**
 * PRIV-4 wiring, the counterpart to {@link withRealAdvisorCli}: fills
 * {@link ExecToolDeps.maskOutboundWeb} and
 * {@link ExecToolDeps.outboundUrlRefusal} with `privacy.ts`'s real, committed
 * port of `privacy::mask_outbound_web` / `privacy::web_mask_note` /
 * `privacy::outbound_url_hides`, for any caller that has not supplied its own.
 *
 * THIS FUNCTION EXISTS BECAUSE THE CHECKS ARE NOT MISSING. Both seams read as
 * "privacy has no port yet" if you only look at the arms, and BOTH candidate
 * ports of the web tools wrote that in their refusal text — but `privacy.ts` is
 * committed, tested, and already read directly by `externalAdvisor.ts`'s leaf
 * (`activePolicy()`, exactly as `run_external` calls it). The only thing still
 * absent is a host bootstrap that builds the deps object a running app hands to
 * {@link execTool}; that bootstrap should build it through here
 * (`execTool(name, args, effects, withRealPrivacyGates(deps))`) so `web_search`
 * masks and `fetch_page`/`download_media` refuse for real instead of coming
 * back `NOT_IMPLEMENTED`.
 *
 * Purely additive, and deliberately NOT applied inside the arms: every existing
 * test that builds a bare `ExecToolDeps` literal still exercises the
 * injected-seam behavior unchanged, because nothing calls this on its behalf.
 *
 * NO ROOM/POLICY ARGUMENT, on purpose. `privacy.ts` holds the active policy in
 * a module-level cell that `refreshPolicy` installs and room teardown clears —
 * the direct analogue of Rust's `active_policy()` global. When no policy is
 * installed (or the Cloud-privacy switch is off) both functions return "nothing
 * to do", which is precisely what the Rust arms do in the same situation: the
 * door is a switch the user owns, not a check this seam can forget.
 */
export function withRealPrivacyGates(deps: ExecToolDeps): ExecToolDeps {
  const filled: ExecToolDeps = { ...deps };
  if (filled.maskOutboundWeb === undefined) {
    filled.maskOutboundWeb = realMaskOutboundWeb;
  }
  if (filled.outboundUrlRefusal === undefined) {
    filled.outboundUrlRefusal = realOutboundUrlRefusal;
  }
  return filled;
}

/** `privacy.ts`'s `maskOutboundWeb` reshaped to this file's seam: the masked
 * query plus the disclosure line `web_mask_note` writes, or `null` when nothing
 * needed masking. Mirrors the Rust arm's own two-line
 * `mask_outbound_web(...)` + `web_mask_note(hidden)`. */
export function realMaskOutboundWeb(query: string): { query: string; note: string } | null {
  const masked = privacyMaskOutboundWeb(query);
  return masked === null ? null : { query: masked.masked, note: webMaskNote(masked.hidden) };
}

/** Ported verbatim from agent.rs's `outbound_url_refusal`: `outbound_url_hides`
 * behind the sentence the model reads. */
export function realOutboundUrlRefusal(url: string): string | null {
  const hidden = outboundUrlHides(url);
  if (hidden === null) {
    return null;
  }
  return (
    `Not fetched: this URL carries ${hidden} protected name(s) from this room's block list, and ` +
    "Cloud privacy is on, so it must not leave this Mac (Settings → Cloud privacy). Tell the user " +
    "rather than retrying."
  );
}
