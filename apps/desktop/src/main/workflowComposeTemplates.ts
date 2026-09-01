import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { createWorkflow, upsertSchedule } from "./db-host/workflows.js";
import { listModels as listModelsReal, stripThinkSpans } from "./engineRouting.js";
import {
  runExternalCli as runExternalCliReal,
  type ExternalRunResult,
  type RunExternalOptions,
} from "./externalAdvisor.js";
import { modelSetting } from "./gatherContext.js";
import { nextRunFromNow } from "./jobScheduler.js";
import { generate as realOllamaGenerate } from "./ollamaGenerate.js";
import { KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { isCliEngine, ROLLBACK_BUSY } from "./turnContext.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  compileWorkflow,
  defUsesRunInput,
  defaultResolvedModel,
  parseWorkflowBinding,
  parseWorkflowDef,
  validateWithBinding,
  type WorkflowBinding,
  type WorkflowDef,
} from "./workflowModel.js";
import type { ScheduleArg } from "./workflowComposeParsing.js";

// ============================================================================
// builtin_templates (workflow.rs:4259-4424)
// ============================================================================

/**
 * One prebuilt gallery template. Matches the renderer's own
 * `apiTypes.ts::WorkflowTemplate` (the shape `workflow_templates` already
 * returns), except that `definition` stays RAW wire JSON rather than a parsed
 * {@link WorkflowDef}: Rust's return type is `Vec<serde_json::Value>`, and these
 * literals legitimately omit optional keys (an edge with no `branch`) that only
 * {@link parseWorkflowDef} normalizes.
 */
export interface WorkflowTemplate {
  name: string;
  description: string;
  emoji: string;
  binding: WorkflowBinding;
  schedule?: ScheduleArg;
  definition: {
    version: number;
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
}

/**
 * Prebuilt workflows for the empty-state gallery. The JSON doubles as the
 * agent's few-shot examples (one is embedded in `save_workflow`'s spec — see
 * `toolSpecs.ts`'s `workflowToolsSpecs`). Ported VERBATIM from
 * `builtin_templates`, which its own doc comment calls "Four prebuilt
 * workflows" while defining SEVEN — ported as found, not as described.
 */
export function builtinTemplates(): WorkflowTemplate[] {
  return [
    // Morning digest — condition on new files → digest → save (daily 08:00).
    {
      name: "Morning digest",
      description: "Each morning, if new files arrived, write a short digest of them.",
      emoji: "🌅",
      binding: { scope: "general" },
      schedule: { kind: "daily", param: "08:00", enabled: true, catchUp: true },
      definition: {
        version: 1,
        nodes: [
          { id: "check", label: "Any new files?", kind: "condition", op: "new_files_since_last_run" },
          {
            id: "digest",
            label: "Write the digest",
            kind: "generate",
            model: "auto",
            prompt:
              "Write a short, friendly morning digest of what's new in this room. Files:\n{{files}}\nKeep it to a few bullet points.",
          },
          {
            id: "save",
            label: "Save the page",
            kind: "save_file",
            name_template: "Morning digest {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [
          { from: "check", to: "digest", branch: "then" },
          { from: "digest", to: "save" },
        ],
      },
    },
    // New-file summarizer — index every still-missing file (interval 30 min).
    {
      name: "New-file summarizer",
      description: "Keep every file's one-line description up to date.",
      emoji: "📥",
      binding: { scope: "general" },
      schedule: { kind: "interval", param: "30", enabled: true, catchUp: false },
      definition: {
        version: 1,
        nodes: [
          {
            id: "index",
            label: "Summarize new files",
            kind: "summarize_file",
            select: { type: "missing_summary" },
          },
        ],
        edges: [],
      },
    },
    // Weekly review — what changed this week (weekly Fri 16:00).
    {
      name: "Weekly review",
      description: "A Friday review of what changed and the open questions.",
      emoji: "📅",
      binding: { scope: "general" },
      schedule: { kind: "weekly", param: "5 16:00", enabled: true, catchUp: true },
      definition: {
        version: 1,
        nodes: [
          {
            id: "review",
            label: "Write the review",
            kind: "generate",
            model: "auto",
            prompt:
              "Given these files, write a weekly review: what changed this week and the open questions.\n{{files}}",
          },
          {
            id: "save",
            label: "Save the review",
            kind: "save_file",
            name_template: "Weekly review {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [{ from: "review", to: "save" }],
      },
    },
    // Deep read — a full pass over the newest file (manual; run from Actions).
    {
      name: "Deep read",
      description: "Read a whole file end to end and save a thorough summary.",
      emoji: "📖",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          {
            id: "pass",
            label: "Full pass",
            kind: "file_pass",
            select: { type: "newest" },
            instruction: "Summarize this file thoroughly — every section, name and figure.",
            mode: "merge",
          },
        ],
        edges: [],
      },
    },
    // Compare perspectives — a DIAMOND: one brief fans out to two parallel
    // reads, which a merge re-joins (fan-out + fan-in, the sectioning pattern).
    {
      name: "Compare perspectives",
      description: "Look at the room from two angles at once, then combine them.",
      emoji: "⚖️",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          {
            id: "brief",
            label: "Gather the material",
            kind: "generate",
            model: "auto",
            prompt: "Briefly summarize what's in this room:\n{{files}}",
          },
          {
            id: "pro",
            label: "The optimistic read",
            kind: "generate",
            model: "auto",
            prompt: "Argue the OPTIMISTIC case about this:\n{{input}}",
          },
          {
            id: "con",
            label: "The skeptical read",
            kind: "generate",
            model: "auto",
            prompt: "Argue the SKEPTICAL case about this:\n{{input}}",
          },
          { id: "merge", label: "Combine both", kind: "merge", mode: "numbered" },
          {
            id: "save",
            label: "Save the memo",
            kind: "save_file",
            name_template: "Two views {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [
          { from: "brief", to: "pro" },
          { from: "brief", to: "con" },
          { from: "pro", to: "merge" },
          { from: "con", to: "merge" },
          { from: "merge", to: "save" },
        ],
      },
    },
    // Summarize every file — for_each_file sectioning over the whole room.
    {
      name: "Summarize every file",
      description: "Write a short summary of every file, then save one page.",
      emoji: "🗂️",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          {
            id: "each",
            label: "Read each file",
            kind: "for_each_file",
            model: "auto",
            select: { type: "all" },
            instruction: "Summarize this file in a short paragraph.",
          },
          {
            id: "save",
            label: "Save the digest",
            kind: "save_file",
            name_template: "File digest {{date}}",
            format: "md",
            mode: "create",
          },
        ],
        edges: [{ from: "each", to: "save" }],
      },
    },
    // Triage the newest note — a ROUTE fans to three specialized handlers that
    // re-converge on a save (N-way routing pattern).
    {
      name: "Triage the newest note",
      description: "Sort the newest file into a bucket and act on it.",
      emoji: "🧭",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          { id: "read", label: "Read newest", kind: "summarize_file", select: { type: "newest" } },
          {
            id: "route",
            label: "Which bucket?",
            kind: "route",
            prompt: "Which bucket does this belong in?",
            labels: ["action", "reference", "idea"],
          },
          {
            id: "act",
            label: "Make a checklist",
            kind: "generate",
            model: "auto",
            prompt: "Turn this into a short action checklist:\n{{input}}",
          },
          {
            id: "ref",
            label: "Note the reference",
            kind: "generate",
            model: "auto",
            prompt: "Write a one-line reference note for this:\n{{input}}",
          },
          {
            id: "idea",
            label: "Expand the idea",
            kind: "generate",
            model: "auto",
            prompt: "Expand this idea into a paragraph:\n{{input}}",
          },
          {
            id: "save",
            label: "Save it",
            kind: "save_file",
            name_template: "Triage {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [
          { from: "read", to: "route" },
          { from: "route", to: "act", branch: "action" },
          { from: "route", to: "ref", branch: "reference" },
          { from: "route", to: "idea", branch: "idea" },
          { from: "act", to: "save" },
          { from: "ref", to: "save" },
          { from: "idea", to: "save" },
        ],
      },
    },
  ];
}

/** `#[tauri::command] workflow_templates` (workflow.rs 3461-3464): the prebuilt
 * template gallery (empty-state) — also the agent's few-shot set. */
export function workflowTemplates(): WorkflowTemplate[] {
  return builtinTemplates();
}
