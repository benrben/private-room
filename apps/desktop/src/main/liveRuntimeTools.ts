import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { ToolEffects, ToolOutcome } from "./execTool.js";
import type { Browser } from "./browser/browser.js";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import { createBrowserAgentTool } from "./browserAgentTools.js";
import {
  countBatchOps,
  parseBatchOps,
  planBatch,
  planBatchWorkspace,
  planSetCells,
  planSetCellsWorkspace,
  planSingleEdit,
  planSingleEditWorkspace,
  planWriteFile,
  planWriteFileWorkspace,
  type PlannedWrite,
  type PreviewEdit,
} from "./editMatch.js";
import { gatedWrite } from "./editGate.js";
import { availableName, findFileLike, getFileExtractedText, getFileMeta, insertFileFromUrl, setFileExtractedText } from "./db-host/files.js";
import { Readable } from "node:stream";
import { checkpointJob, createJob, getJob, listJobs, setJobStatus } from "./db-host/jobs.js";
import { agentListScriptsInRoom, clampScriptOutput, scriptOutput } from "./scriptConsent.js";
import { createScriptBytesApprovalRequester, runScriptFile } from "./scriptSurfaceIpc.js";
import { agentRunSkillScript } from "./skillsCmds.js";
import { createDownloadEngineDeps } from "./mediaDownloadSurfaceIpc.js";
import { DOWNLOAD_ENGINE_FETCH, startDownloadJobInner } from "./jobDownload.js";
import { INLINE_DOWNLOAD_BYTES, downloadToTemp, fetchReadable, youtubeTranscript, youtubeVideoId } from "./webFetch.js";
import { sttStatus, type SttModelState } from "./sttTools.js";
import { retranscribeFile } from "./speechSttSurfaceIpc.js";
import { recReadRowStarter, startRecRead } from "./recRead.js";
import { listModels } from "./engineRouting.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { modelSetting } from "./gatherContext.js";
import { runsOnThisMac } from "./capabilities.js";
import { chatStructured, generate } from "./ollamaGenerate.js";
import { resolveLocalGenerateModel } from "./toolSpecs.js";
import { stripThinkSpans } from "./engineRouting.js";
import type { SidecarChatMessage } from "./sidecar.js";
import type { Lane } from "./jobs.js";
import { spawnJobRunner } from "./jobs.js";
import { atCapacity, QUEUE_FULL, runnerDepsFrom, submit, type RowStarter } from "./jobQueue.js";
import { driveFilePass } from "./filePass.js";
import { locateInImage } from "./visionTools.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { outboundUrlHides } from "./privacy.js";
import {
  execCreateFileWorkspace,
  execMergeFilesWorkspace,
  execMoveFileWorkspace,
  execOrganizeFilesWorkspace,
  execRenameFileWorkspace,
  execTrashFilesWorkspace,
} from "./organizeTools.js";

function ok(text: string): ToolOutcome { return { ok: true, text }; }
function fail(error: unknown): ToolOutcome {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function dryRunSummary(plans: readonly PlannedWrite[]): string {
  const count = plans.reduce((n, plan) => n + Math.max(plan.count, plan.renameTo ? 1 : 0), 0);
  return `Dry run only — ${count} change(s) would affect ${plans.length} file(s):\n${plans.map((p) => `- ${p.realName}${p.renameTo ? ` → ${p.renameTo}` : ""}`).join("\n")}`;
}

function writeSummary(plan: PlannedWrite): string {
  return `Rewrote "${plan.realName}" (${plan.after.length} characters). Saved to the room — its prior version is in History and can be restored.`;
}

function jobStatusReply(args: Record<string, unknown>, jobs: ReturnType<typeof listJobs>): string {
  if (jobs.length === 0) return "There are no background jobs in this room.";
  const line = (job: (typeof jobs)[number]): string => {
    const why = job.parkedReason ? ` — ${job.parkedReason} Resume picks it up here.` : "";
    return `- [${job.id.slice(0, 8)}] ${job.title} — ${job.status} (${job.cursor} of ${job.total} steps done)${why}`;
  };
  const query = str(args.job_id).trim().toLowerCase();
  if (!query) return jobs.slice(0, 8).map(line).join("\n");
  const matches = jobs.filter((job) => job.id.toLowerCase().startsWith(query));
  if (matches.length === 0) return `No background job matches id "${query}". Call job_status with no arguments to see every job's id.`;
  if (matches.length > 1) return `"${query}" matches ${matches.length} jobs; be more specific:\n${matches.map(line).join("\n")}`;
  const job = matches[0]!;
  return `[${job.id}] ${job.title}\nStatus: ${job.status} (${job.cursor} of ${job.total} steps done)${job.parkedReason ? `\nWhy it's paused: ${job.parkedReason}` : ""}${job.error ? `\nError: ${job.error}` : ""}`;
}

async function resolveLocalModel(state: RoomManagerState): Promise<{ model: string; lane: Lane }> {
  if (!state.room) throw new Error("No room is open.");
  const installed = await listModels();
  const model = modelSetting(state.room.conn) ?? bestLocalDefault(installed);
  return { model, lane: runsOnThisMac(model) ? "local_llm" : "cloud" };
}

export interface LiveRuntimeToolOptions {
  state: RoomManagerState;
  roomDeps: RoomManagerDeps;
  userDataDir: string;
  resourcesPath: string | null;
  emit: EventSender;
  browser: Browser;
  agentUi: AgentUiRuntime;
  sttModelState: SttModelState;
  /** Test seam for the long-running transcription operation. */
  retranscribe?: typeof retranscribeFile;
}

export function createLiveRuntimeTool(options: LiveRuntimeToolOptions) {
  const { state, roomDeps, userDataDir, resourcesPath, emit } = options;
  const browserTool = createBrowserAgentTool({ state, roomDeps, browser: options.browser, agentUi: options.agentUi, emit });
  const sttBusy = new Map<string, string>();
  const passStarter: RowStarter = async (jobQueue, job, roomPath, cancel) => {
    const plan = typeof job.plan === "object" && job.plan !== null ? job.plan as Record<string, unknown> : {};
    const fileId = str(plan.fileId);
    const fileName = str(plan.fileName);
    if (!fileId || !fileName) return { kind: "error", message: "This file pass has an unreadable plan." };
    const runner = runnerDepsFrom(jobQueue);
    void spawnJobRunner(runner, job.id, roomPath, async () => {
      const startDb = runner.rooms.current()?.path === roomPath ? runner.rooms.current()?.db ?? null : null;
      if (startDb) setJobStatus(startDb, job.id, "running", null);
      let error: string | null = null;
      let message = "";
      try {
        const result = await driveFilePass(
          {
            rooms: jobQueue.rooms,
            emit,
            resolveEngine: async () => {
              const picked = await resolveLocalModel(state);
              return { model: picked.model, lane: picked.lane };
            },
          },
          job.id,
          roomPath,
          fileId,
          fileName,
          str(plan.instruction),
          str(plan.mode) || "merge",
          cancel,
        );
        message = result.message;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const end = runner.rooms.current();
      const endDb = end?.path === roomPath ? end.db : null;
      const paused = cancel.load() || error === "STOPPED";
      if (endDb) setJobStatus(endDb, job.id, error === null ? "done" : paused ? "paused" : "error", paused ? null : error);
      runner.removeCancelFlag(job.id);
      runner.sink.emit(error === null
        ? { jobId: job.id, label: message || "Full file pass ready", done: 1, total: 1, finished: true }
        : paused
          ? { jobId: job.id, label: "Paused", done: 0, total: 1, paused: true }
          : { jobId: job.id, label: `Stopped — ${error}`, done: 0, total: 1, failed: true });
      await runner.onSettled(job.id);
    });
    return { kind: "runner" };
  };
  const queue = roomDeps.jobQueue;
  if (queue) {
    const starters = new Map(queue.starters);
    starters.set("rec_read", recReadRowStarter({
      resolvePassEngine: async () => {
        const picked = await resolveLocalModel(state);
        return { chatModel: picked.model, lane: picked.lane };
      },
      onReadDone: (event) => emit("rec-read-done", event),
    }));
    starters.set("file_pass", passStarter);
    roomDeps.jobQueue = { ...queue, starters };
  }

  return async (name: string, args: Record<string, unknown>, effects: ToolEffects): Promise<ToolOutcome | null> => {
    const browsed = await browserTool(name, args, effects);
    if (browsed !== null) return browsed;
    try {
      const room = state.room;
      if (!room) throw new Error("No room is open.");
      const gated = {
        rooms: {
          currentRoom: () => state.room ? {
            db: state.room.conn,
            path: state.room.path,
            ...(state.room.workspace === undefined ? {} : { workspace: state.room.workspace }),
          } : null,
        },
        editPending: state.editPending,
        emit,
      };
      switch (name) {
        case "create_file":
          if (room.workspace === undefined) return null;
          return execCreateFileWorkspace(room.conn, room.workspace, args, effects, {
            runId: null,
            emit,
          });
        case "rename_file":
          return room.workspace === undefined ? null : execRenameFileWorkspace(room.conn, room.workspace, args, effects, emit);
        case "move_file":
          return room.workspace === undefined ? null : execMoveFileWorkspace(room.conn, room.workspace, args, effects, emit);
        case "organize_files":
          return room.workspace === undefined ? null : execOrganizeFilesWorkspace(room.conn, room.workspace, args, effects, emit);
        case "trash_files":
          return room.workspace === undefined ? null : execTrashFilesWorkspace(room.conn, room.workspace, args, effects, emit);
        case "merge_files":
          return room.workspace === undefined ? null : execMergeFilesWorkspace(room.conn, room.workspace, args, effects, emit);
        case "mark_image": {
          const [fileId, realName] = findFileLike(room.conn, str(args.image_name));
          const existing = effects.boxes;
          if (typeof existing === "object" && existing !== null &&
              (existing as Record<string, unknown>).fileId === fileId) {
            return ok(`The image "${realName}" is already marked.`);
          }
          const boxes = await locateInImage(room.conn, fileId, str(args.find));
          effects.boxes = { fileId, name: realName, boxes };
          return ok(boxes.length === 0
            ? `I couldn't find ${str(args.find)} in "${realName}".`
            : `Marked ${boxes.length} match${boxes.length === 1 ? "" : "es"} for ${str(args.find)} in "${realName}".`);
        }
        case "edit_file": {
          const oldText = str(args.old_text);
          if (!oldText) throw new Error("old_text is required — copy the exact text to replace.");
          const all = args.all === true;
          const occurrence = typeof args.occurrence === "number" && Number.isInteger(args.occurrence) ? args.occurrence : undefined;
          if (occurrence !== undefined && all) throw new Error("occurrence and all: true can't both be set.");
          const edit: PreviewEdit = {
            name: str(args.name), oldText, newText: str(args.new_text), all,
            prefixContext: typeof args.prefix_context === "string" ? args.prefix_context : undefined,
            suffixContext: typeof args.suffix_context === "string" ? args.suffix_context : undefined,
            occurrence, section: typeof args.section === "string" ? args.section : undefined,
          };
          if (args.dry_run === true) {
            const plans = room.workspace === undefined
              ? planSingleEdit(room.conn, edit)
              : await planSingleEditWorkspace(room.conn, room.workspace, edit);
            return ok(dryRunSummary(plans));
          }
          const result = await gatedWrite("edit_file", "AI edit", gated, effects, (db, workspace) =>
            workspace === undefined ? planSingleEdit(db, edit) : planSingleEditWorkspace(db, workspace, edit));
          if (result.kind === "declined") return ok(result.message);
          if (result.kind === "error") return fail(result.error.message);
          const plan = result.plans[0]!;
          effects.editOutcomes.push({ tool: name, outcome: plan.method ?? "exact", n: plan.count });
          return ok(`${plan.method === "fuzzy" ? "Matched despite quote/spacing differences. " : ""}Replaced ${plan.count} occurrence(s) in "${plan.realName}". Saved to the room and undoable from History.`);
        }
        case "edit_files": {
          const ops = parseBatchOps(args);
          if (args.dry_run === true) {
            const plans = room.workspace === undefined
              ? planBatch(room.conn, ops)
              : await planBatchWorkspace(room.conn, room.workspace, ops);
            return ok(dryRunSummary(plans));
          }
          const counts = countBatchOps(ops);
          const result = await gatedWrite("edit_files", `AI edit (batch ${randomUUID().slice(0, 8)})`, gated, effects, (db, workspace) =>
            workspace === undefined ? planBatch(db, ops) : planBatchWorkspace(db, workspace, ops));
          if (result.kind === "declined") return ok(result.message);
          if (result.kind === "error") return fail(result.error.message);
          const total = counts.edits + counts.renames;
          effects.editOutcomes.push({ tool: name, outcome: "applied", files: result.plans.length, n: total });
          return ok(`Applied ${total} change(s) across ${result.plans.length} file(s) atomically.`);
        }
        case "write_file": {
          const result = await gatedWrite("write_file", "AI rewrite", gated, effects, (db, workspace) =>
            workspace === undefined
              ? planWriteFile(db, str(args.name), str(args.content))
              : planWriteFileWorkspace(db, workspace, str(args.name), str(args.content)));
          if (result.kind === "declined") return ok(result.message);
          return result.kind === "error" ? fail(result.error.message) : ok(writeSummary(result.plans[0]!));
        }
        case "set_cells": {
          const raw = Array.isArray(args.updates) ? args.updates : [];
          const updates = raw.map((item) => {
            const row = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
            const cell = str(row.cell).trim().toUpperCase();
            if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell)) throw new Error(`Invalid cell reference: ${cell || "(empty)"}.`);
            if (!("value" in row) || row.value === null || row.value === undefined) {
              throw new Error(`${cell} has no value — use "" to clear it.`);
            }
            return [cell, typeof row.value === "string" ? row.value : JSON.stringify(row.value)] as [string, string];
          });
          if (updates.length === 0) throw new Error("No cells given — pass updates: [{cell, value}, …].");
          const result = await gatedWrite("set_cells", "AI cell change", gated, effects, (db, workspace) =>
            workspace === undefined
              ? planSetCells(db, str(args.name), typeof args.sheet === "string" ? args.sheet : null, updates)
              : planSetCellsWorkspace(db, workspace, str(args.name), typeof args.sheet === "string" ? args.sheet : null, updates));
          if (result.kind === "declined") return ok(result.message);
          return result.kind === "error" ? fail(result.error.message) : ok(`Set ${updates.map(([c, v]) => `${c}=${v}`).join(", ")} in "${result.plans[0]!.realName}".`);
        }
        case "save_link": {
          const url = str(args.url).trim();
          const hidden = outboundUrlHides(url);
          if (hidden !== null) return ok(`Not fetched: this URL carries ${hidden} protected name(s), and Cloud privacy is on.`);
          if (!webAccessEnabled(room.conn)) return ok("Web access is turned off in Settings → Online features.");
          let title: string;
          let text: string;
          if (youtubeVideoId(url)) {
            const transcript = await youtubeTranscript(url);
            title = transcript.title;
            text = transcript.transcript;
          } else {
            const page = await fetchReadable(url);
            title = page.title || new URL(url).hostname;
            text = page.text;
          }
          const name = availableName(room.conn, `${title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100) || "Web source"}.md`);
          const content = `# ${title}\n\nSource: ${url}\n\n${text}`;
          const meta = room.workspace === undefined
            ? insertFileFromUrl(room.conn, name, "text/markdown", Buffer.from(content), content, "web", url)
            : await room.workspace.createFile(name, Readable.from([Buffer.from(content)]), "web").then((entry) => {
                setFileExtractedText(room.conn, entry.fileId, content);
                room.conn.prepare("UPDATE files SET origin_url = ?, mime_type = 'text/markdown' WHERE id = ?")
                  .run(url, entry.fileId);
                return getFileMeta(room.conn, entry.fileId);
              });
          emit("room-files-changed", {});
          effects.wrote = true;
          return ok(`Saved "${meta.name}" into the room.`);
        }
        case "download_url": {
          const url = str(args.url).trim();
          const hidden = outboundUrlHides(url);
          if (hidden !== null) return ok(`Not fetched: this URL carries ${hidden} protected name(s), and Cloud privacy is on.`);
          if (!webAccessEnabled(room.conn)) return ok("Web access is turned off in Settings → Online features.");
          const outcome = await downloadToTemp(url, INLINE_DOWNLOAD_BYTES, undefined, () => undefined);
          if (outcome.kind === "tooLarge") {
            if (!roomDeps.jobQueue) throw new Error("The background job queue is unavailable.");
            const id = startDownloadJobInner({ ...roomDeps.jobQueue, ...createDownloadEngineDeps(state, userDataDir, emit) }, url, DOWNLOAD_ENGINE_FETCH);
            return ok(`This file is larger than 64 MB, so it is continuing as background job ${id}. Track it with job_status.`);
          }
          const engine = createDownloadEngineDeps(state, userDataDir, emit);
          try {
            const meta = await engine.importDownload!(outcome.downloaded.path, outcome.downloaded.fileName, url);
            effects.wrote = true;
            return ok(`Downloaded "${meta.name}" into the room.`);
          } finally {
            await fs.promises.rm(outcome.downloaded.path, { force: true }).catch(() => undefined);
          }
        }
        case "list_scripts": return ok(await agentListScriptsInRoom(
          {
            db: room.conn,
            path: room.path,
            ...(room.workspace === undefined ? {} : { workspace: room.workspace }),
          },
          userDataDir,
        ));
        case "run_script": {
          const [fileId, realName] = findFileLike(room.conn, str(args.name));
          const jobId = await runScriptFile(state, roomDeps, userDataDir, emit, fileId);
          const deadline = Date.now() + 150_000;
          while (Date.now() < deadline) {
            if (!state.room || state.room.path !== room.path) throw new Error("The room was closed while the script ran.");
            const job = getJob(state.room.conn, jobId);
            if (job.status === "done") return ok(clampScriptOutput(realName, scriptOutput(state.room.conn, jobId)));
            if (job.status === "error") return fail(job.error ?? `${realName} failed.`);
            if (job.status === "paused") return ok(`Started ${realName}, but it is paused. Resume it from Jobs.`);
            await sleep(250);
          }
          return ok(`Started ${realName} as background job ${jobId}; it is still running.`);
        }
        case "stt_status": {
          const status = sttStatus(userDataDir, resourcesPath, options.sttModelState);
          const lane = sttBusy.size ? ` Transcribing ${[...sttBusy.keys()].join(", ")} right now.` : " Nothing is transcribing right now.";
          return ok(status.installed ? `The on-device speech model is installed and ready.${lane}` : status.downloading ? "The on-device speech model is still downloading." : `The on-device speech model is not installed (${status.sizeMb} MB).`);
        }
        case "retranscribe_file": {
          const [fileId, realName] = findFileLike(room.conn, str(args.name));
          const modelStatus = sttStatus(userDataDir, resourcesPath, options.sttModelState);
          if (!modelStatus.installed) {
            return fail(modelStatus.downloading
              ? "The on-device speech model is still downloading. Try again when it is ready."
              : `The on-device speech model is not installed (${modelStatus.sizeMb} MB).`);
          }
          const already = sttBusy.get(realName);
          if (already !== undefined) {
            return fail(`Re-transcription job ${already} for “${realName}” is still running.`);
          }
          const jobId = createJob(room.conn, "retranscribe", `Re-transcribe — ${realName}`, { fileId, fileName: realName }, 1);
          setJobStatus(room.conn, jobId, "running", null);
          sttBusy.set(realName, jobId);
          try {
            await (options.retranscribe ?? retranscribeFile)(state, userDataDir, resourcesPath, emit, fileId);
            const current = state.room;
            if (current === null || current.path !== room.path) {
              throw new Error("The room was closed while transcription was running.");
            }
            const transcript = getFileExtractedText(current.conn, fileId)?.trim() ?? "";
            const status = transcript === "" ? "no-speech" : "completed";
            checkpointJob(current.conn, jobId, 1, { fileId, status, characters: transcript.length });
            setJobStatus(current.conn, jobId, "done", null);
            const receipt = JSON.stringify({ jobId, fileId, fileName: realName, status, characters: transcript.length });
            if (transcript === "") {
              return ok(`TRANSCRIPTION_RECEIPT ${receipt}\nNo speech was detected in “${realName}”.`);
            }
            const preview = transcript.length > 16_000
              ? `${transcript.slice(0, 16_000)}\n… (transcript continues in the room file)`
              : transcript;
            return ok(`TRANSCRIPTION_RECEIPT ${receipt}\nTranscript:\n${preview}`);
          } catch (error) {
            const current = state.room;
            if (current !== null && current.path === room.path) {
              setJobStatus(current.conn, jobId, "error", error instanceof Error ? error.message : String(error));
            }
            return fail(`Re-transcription job ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            sttBusy.delete(realName);
          }
        }
        case "read_recording": {
          if (!roomDeps.jobQueue) throw new Error("The background job queue is unavailable.");
          const [fileId, realName] = findFileLike(room.conn, str(args.name));
          const jobId = await startRecRead(roomDeps.jobQueue, {
            resolvePassEngine: async () => {
              const picked = await resolveLocalModel(state);
              return { chatModel: picked.model, lane: picked.lane };
            },
            onReadDone: (event) => emit("rec-read-done", event),
          }, fileId);
          return ok(`Started reading "${realName}" as background job ${jobId}. Chapters, highlights and notes appear when it finishes.`);
        }
        case "run_skill_script": return ok(await agentRunSkillScript(room.conn, args, {
          cacheDir: path.join(userDataDir, "cache"),
          approveScriptBytes: createScriptBytesApprovalRequester(state, userDataDir, emit),
        }));
        case "start_file_pass": {
          if (!roomDeps.jobQueue) throw new Error("The background job queue is unavailable.");
          if (atCapacity(room.conn)) throw new Error(QUEUE_FULL);
          const [fileId, realName] = findFileLike(room.conn, str(args.name));
          const instruction = str(args.instruction).trim() || "Summarize this file completely and thoroughly.";
          const mode = str(args.mode) === "stitch" ? "stitch" : "merge";
          const jobId = createJob(room.conn, "file_pass", `Full pass — ${realName}`, { fileId, fileName: realName, instruction, mode }, 1);
          await submit(roomDeps.jobQueue, jobId);
          return ok(`Started a full pass over "${realName}" as job ${jobId}. The result will be saved as a new room file; progress is visible in Jobs.`);
        }
        case "job_status": return ok(jobStatusReply(args, listJobs(room.conn)));
        case "local_generate": {
          const prompt = str(args.prompt).trim();
          if (!prompt) throw new Error("local_generate needs a non-empty `prompt`.");
          const models = await listModels();
          const model = resolveLocalGenerateModel(modelSetting(room.conn) ?? undefined, models, runsOnThisMac, bestLocalDefault);
          const messages: SidecarChatMessage[] = [];
          if (str(args.system).trim()) messages.push({ role: "system", content: str(args.system) });
          messages.push({ role: "user", content: prompt });
          const temperature = typeof args.temperature === "number" ? args.temperature : null;
          const text = typeof args.schema === "object" && args.schema !== null
            ? await chatStructured(model, messages, temperature, "5m", args.schema)
            : stripThinkSpans(await generate(model, messages, temperature, "5m")).trim();
          return ok(text);
        }
        default: return null;
      }
    } catch (error) {
      return fail(error);
    }
  };
}
