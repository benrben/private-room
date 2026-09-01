import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyPrivacyReport, type PrivacyReport } from "./privacyRedact.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { splitExternalModel } from "./turnContext.js";
import { ExternalUsage, parseAntigravityJsonStream, parseClaudeJsonResult, parseCodexJsonStream } from "./externalAdvisorParsing.js";
import { ActiveAdvisorPolicy, AdvisorBridge, AdvisorPrivacyPolicy, AdvisorSpawnFn, CancelFlagLike, CliEngine, CliRunOutcome, CliRunResult, DEFAULT_SHELL, MAX_IMAGES_PER_MESSAGE, RunCliArgs, STDERR_SNIPPET_CHARS, buildCommandLine, checkCliSlug, claudeImageUserEvent, cleanupScratchDir, decodeBase64Strict, defaultActivePolicy, realAdvisorSpawn, runCli } from "./externalAdvisor.js";



export interface RunExternalOptions {
  /** ADD-7: the Stop flag. Polled every 100ms; the child is killed the moment
   * it reads true. */
  cancel?: CancelFlagLike;
  /** ADD-20: hands the CLI the room's tools over a scoped localhost MCP
   * bridge. See the module doc for why no call site supplies one yet. */
  bridge?: AdvisorBridge;
  /** PRIV-1: overrides the `privacy.ts` lookup this otherwise does for
   * itself. Called once per turn — see the module doc for why this is a thunk
   * rather than a policy value. */
  activePolicy?: ActiveAdvisorPolicy;
  /** PRIV-1: "send real details this once" — skips the privacy door for this
   * one turn even when {@link activePolicy} would otherwise engage it. */
  privacyBypass?: boolean;
  /** Test seam: the shell that runs the built command line. Defaults to the
   * real `zsh -ilc`; see the module doc for why tests swap it. */
  shell?: { command: string; args: readonly string[] };
  /** Test seam: env for the spawned shell. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the real `child_process.spawn`. */
  spawnFn?: AdvisorSpawnFn;
}


export interface ExternalRunResult {
  text: string;
  usage: ExternalUsage | null;
}
export interface StagedAttachments {
  readonly claudeImages: string[];
  readonly imagePaths: string[];
}
export interface BridgeCommandOptions {
  readonly mcpConfigPath: string | null;
  readonly codexMcpFlags: string;
  readonly codexBridgeToken: string | null;
}
export type RunCliOnce = () => Promise<CliRunOutcome>;
export function selectedAdvisorPolicy(options: RunExternalOptions): AdvisorPrivacyPolicy | null {
  if (options.privacyBypass) return null;
  return (options.activePolicy ?? defaultActivePolicy)() ?? null;
}
export function redactAdvisorMessage(
  message: SidecarChatMessage,
  policy: AdvisorPrivacyPolicy,
  report: PrivacyReport,
): SidecarChatMessage {
  const redacted: SidecarChatMessage = { ...message, content: policy.redact(message.content, report) };
  if (message.images === undefined) return redacted;
  report.imagesBlocked += message.images.length;
  delete redacted.images;
  return redacted;
}
export function guardedAdvisorMessages(
  messages: readonly SidecarChatMessage[],
  policy: AdvisorPrivacyPolicy | null,
  report: PrivacyReport,
): readonly SidecarChatMessage[] {
  return policy === null ? messages : messages.map((message) => redactAdvisorMessage(message, policy, report));
}
export function messageAttachments(message: SidecarChatMessage): readonly string[] {
  return message.images === undefined ? [] : message.images.slice(0, MAX_IMAGES_PER_MESSAGE);
}
export async function writeImageAttachment(bytes: Buffer, tmpDir: string, imagePaths: string[]): Promise<void> {
  if (imagePaths.length === 0) await mkdir(tmpDir, { recursive: true });
  const imagePath = path.join(tmpDir, `attachment-${imagePaths.length + 1}.png`);
  try {
    await writeFile(imagePath, bytes);
    imagePaths.push(imagePath);
  } catch {
    // Best-effort, matching Rust's `if std::fs::write(...).is_ok()`: a failed
    // write is skipped rather than aborting the turn.
  }
}
export async function stageAttachment(
  engine: string,
  b64: string,
  tmpDir: string,
  staged: StagedAttachments,
): Promise<void> {
  const bytes = decodeBase64Strict(b64);
  if (bytes === null) return;
  if (engine === "claude-cli") {
    staged.claudeImages.push(b64);
    return;
  }
  await writeImageAttachment(bytes, tmpDir, staged.imagePaths);
}
export async function stageAttachments(
  engine: string,
  messages: readonly SidecarChatMessage[],
  tmpDir: string,
): Promise<StagedAttachments> {
  const staged: StagedAttachments = { claudeImages: [], imagePaths: [] };
  for (const message of messages) {
    for (const b64 of messageAttachments(message)) await stageAttachment(engine, b64, tmpDir, staged);
  }
  return staged;
}
export function promptLine(message: SidecarChatMessage): string {
  if (message.role === "system") return `Instructions:\n${message.content}\n\n`;
  if (message.role === "user") return `User: ${message.content}\n\n`;
  if (message.role === "assistant") return `Assistant: ${message.content}\n\n`;
  return "";
}
export function attachmentPrompt(staged: StagedAttachments): string {
  if (staged.claudeImages.length > 0) {
    return (
      `${staged.claudeImages.length} image(s) are attached to this request as image content blocks. ` +
      "Inspect those pixels before answering.\n\n"
    );
  }
  if (staged.imagePaths.length > 0) {
    return (
      `The user attached ${staged.imagePaths.length} image(s), saved for you at:\n${staged.imagePaths.join("\n")}\n` +
      "Open and view them before answering.\n\n"
    );
  }
  return "";
}
export function bridgePrompt(bridge: AdvisorBridge | undefined): string {
  if (bridge === undefined) return "";
  return (
    "You are connected to the user's Arcelle through the MCP " +
    'server named "room". Use its tools to list, search, open, edit, ' +
    "create, or annotate the room's files whenever the question " +
    "involves files — do not guess file contents from memory.\n\n"
  );
}
export function advisorPrompt(
  messages: readonly SidecarChatMessage[],
  staged: StagedAttachments,
  bridge: AdvisorBridge | undefined,
): string {
  return messages.map(promptLine).join("") + attachmentPrompt(staged) + bridgePrompt(bridge)
    + "Respond to the last user message. Reply with the answer only.";
}
export function emptyBridgeCommandOptions(): BridgeCommandOptions {
  return { mcpConfigPath: null, codexMcpFlags: "", codexBridgeToken: null };
}
export async function claudeBridgeCommandOptions(bridge: AdvisorBridge, tmpDir: string): Promise<BridgeCommandOptions> {
  await mkdir(tmpDir, { recursive: true });
  const mcpConfigPath = path.join(tmpDir, "mcp-room.json");
  await writeFile(mcpConfigPath, bridge.mcpConfigJson());
  return { mcpConfigPath, codexMcpFlags: "", codexBridgeToken: null };
}
export function codexBridgeCommandOptions(bridge: AdvisorBridge): BridgeCommandOptions {
  return {
    mcpConfigPath: null,
    codexMcpFlags:
      ` -c 'mcp_servers.room.url="${bridge.mcpUrl()}"' ` +
      "-c 'mcp_servers.room.bearer_token_env_var=\"PR_ROOM_MCP_TOKEN\"'",
    codexBridgeToken: bridge.token,
  };
}
export async function createBridgeCommandOptions(
  engine: string,
  bridge: AdvisorBridge | undefined,
  tmpDir: string,
): Promise<BridgeCommandOptions> {
  if (bridge === undefined) return emptyBridgeCommandOptions();
  if (engine === "claude-cli") return claudeBridgeCommandOptions(bridge, tmpDir);
  if (engine === "codex-cli") return codexBridgeCommandOptions(bridge);
  return emptyBridgeCommandOptions();
}
export function isCliEngine(engine: string): engine is CliEngine {
  return engine === "claude-cli" || engine === "codex-cli" || engine === "antigravity-cli";
}
export function requireCliEngine(engine: string): CliEngine {
  if (!isCliEngine(engine)) throw new Error("Unknown engine");
  return engine;
}
export function cliEnvironment(options: RunExternalOptions, bridgeOptions: BridgeCommandOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (bridgeOptions.codexBridgeToken !== null) env.PR_ROOM_MCP_TOKEN = bridgeOptions.codexBridgeToken;
  return env;
}
export function cliStdinText(engine: CliEngine, prompt: string, claudeImages: string[]): string {
  if (engine === "antigravity-cli") {
    return `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
  }
  if (engine === "claude-cli" && claudeImages.length > 0) return claudeImageUserEvent(prompt, claudeImages);
  return prompt;
}
export function runCliArguments(
  engine: CliEngine,
  options: RunExternalOptions,
  shell: { command: string; args: readonly string[] },
  cmdline: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  claudeImages: string[],
): RunCliArgs {
  return {
    spawnFn: options.spawnFn ?? realAdvisorSpawn,
    command: shell.command,
    args: [...shell.args, cmdline],
    cwd,
    env,
    stdinText: cliStdinText(engine, prompt, claudeImages),
    engineName: engine,
    cancel: options.cancel,
  };
}
export function stderrSnippet(stderr: Buffer): string {
  return Array.from(stderr.toString("utf8")).slice(0, STDERR_SNIPPET_CHARS).join("");
}
export function successfulCliResult(engine: CliEngine, outcome: CliRunOutcome): CliRunResult {
  if (!outcome.ok) throw new Error(outcome.error);
  if (outcome.result.code !== 0) throw new Error(`${engine} failed: ${stderrSnippet(outcome.result.stderr)}`);
  return outcome.result;
}
export async function runSuccessfulCli(engine: CliEngine, runOnce: RunCliOnce): Promise<CliRunResult> {
  return successfulCliResult(engine, await runOnce());
}
export function parseCliResult(engine: CliEngine, stdout: Buffer): { text: string; usage: ExternalUsage } {
  if (engine === "claude-cli") return parseClaudeJsonResult(stdout);
  if (engine === "antigravity-cli") return parseAntigravityJsonStream(stdout);
  return parseCodexJsonStream(stdout);
}
export function emptyAntigravityResponse(engine: CliEngine, parsed: { text: string }): boolean {
  return engine === "antigravity-cli" && parsed.text.trim() === "";
}
export function retryDiagnostic(label: string, value: Buffer): string {
  const snippet = stderrSnippet(value).trim();
  return `${label}=${snippet === "" ? "(empty)" : snippet}`;
}
export function emptyAntigravityError(engine: CliEngine, first: CliRunResult, retry: CliRunResult): Error {
  return new Error(
    `${engine} failed after one bounded retry: exit=${String(retry.code)}; `
    + `${retryDiagnostic("stdout", retry.stdout)}; ${retryDiagnostic("stderr", retry.stderr)}; `
    + `first_stdout_bytes=${first.stdout.length}; first_stderr_bytes=${first.stderr.length}`,
  );
}
export async function parseExternalResponse(
  engine: CliEngine,
  runOnce: RunCliOnce,
): Promise<{ text: string; usage: ExternalUsage }> {
  const first = await runSuccessfulCli(engine, runOnce);
  const parsed = parseCliResult(engine, first.stdout);
  if (!emptyAntigravityResponse(engine, parsed)) return parsed;
  const retry = await runSuccessfulCli(engine, runOnce);
  const retryParsed = parseAntigravityJsonStream(retry.stdout);
  if (!emptyAntigravityResponse(engine, retryParsed)) return retryParsed;
  throw emptyAntigravityError(engine, first, retry);
}
export function restoreAdvisorResponse(
  policy: AdvisorPrivacyPolicy | null,
  parsed: { text: string; usage: ExternalUsage },
): ExternalRunResult {
  return { text: policy === null ? parsed.text : policy.restore(parsed.text), usage: parsed.usage };
}


/**
 * Run one prompt through a cloud CLI (Claude Code / Codex / Antigravity) — the real port of
 * `run_external` (external.rs lines 643-892). The content leaves the machine
 * via the user's own account.
 *
 * Claude receives attached images as base64 content blocks on stream-JSON
 * stdin, including when its file tools are disabled. Other CLI adapters retain
 * their private temporary-file flow, cleaned on every exit path rather than
 * just the happy one ({@link cleanupScratchDir}).
 *
 * `engineRaw` is either a bare engine id (`"claude-cli"`/`"codex-cli"`) or a
 * composite one carrying the model and/or reasoning effort the Cloud picker
 * chose (`"codex-cli::gpt-5.6-sol::high"`).
 *
 * Rejects (never resolves with a fabricated answer) on: an unknown engine, an
 * unsafe model/effort slug, a spawn failure, or a non-zero exit — exactly
 * `run_external`'s own `Err` cases. `execTool.ts`'s `execConsultAdvisor`
 * already turns a rejection into "the advisor could not be reached" for the
 * user; this function's job stops at reporting the failure honestly.
 */
export async function runExternalCli(
  engineRaw: string,
  messages: readonly SidecarChatMessage[],
  options: RunExternalOptions = {}
): Promise<ExternalRunResult> {
  const [engineRawName, submodelRaw, effortRaw] = splitExternalModel(engineRaw);
  const policy = selectedAdvisorPolicy(options);
  const report = emptyPrivacyReport();
  const guarded = guardedAdvisorMessages(messages, policy, report);
  const tmpDir = path.join(os.tmpdir(), `arcelle-cli-${randomUUID()}`);
  try {
    const staged = await stageAttachments(engineRawName, guarded, tmpDir);
    const prompt = advisorPrompt(guarded, staged, options.bridge);
    const bridgeOptions = await createBridgeCommandOptions(engineRawName, options.bridge, tmpDir);
    const submodel = checkCliSlug(submodelRaw, "model");
    const effort = checkCliSlug(effortRaw, "reasoning effort");
    const engine = requireCliEngine(engineRawName);
    const cmdline = buildCommandLine(engine, {
      submodel,
      effort,
      mcpConfigPath: bridgeOptions.mcpConfigPath,
      codexMcpFlags: bridgeOptions.codexMcpFlags,
      streamJsonInput: engine === "claude-cli" && staged.claudeImages.length > 0,
    });
    const workDir = staged.imagePaths.length === 0 ? os.tmpdir() : tmpDir;
    const shell = options.shell ?? DEFAULT_SHELL;
    const env = cliEnvironment(options, bridgeOptions);
    const runOnce = () => runCli(runCliArguments(engine, options, shell, cmdline, workDir, env, prompt, staged.claudeImages));
    return restoreAdvisorResponse(policy, await parseExternalResponse(engine, runOnce));
  } finally {
    // Decrypted content must not linger on disk, however this function
    // returns — including on every throw above.
    await cleanupScratchDir(tmpDir);
  }
}


// -------------------------------------------------------- the runAdvisorCli seam

/**
 * The exact shape `execTool.ts`'s `ExecToolDeps.runAdvisorCli` declares:
 * `(engine, question) => Promise<string>`. Builds the one-message prompt
 * `consult_advisor`'s own Rust arm builds (agent.rs line 4643:
 * `vec![ollama::ChatMessage::new("user", question)]`) and discards usage —
 * agent.rs's own comment on that call says why: "a nested sub-call inside one
 * turn, already captured as ordinary tool-result char length under the outer
 * turn's 'tools' category".
 */
export async function runAdvisorCli(
  engine: CliEngine,
  question: string,
  options: RunExternalOptions = {}
): Promise<string> {
  const { text } = await runExternalCli(engine, [{ role: "user", content: question }], options);
  return text;
}


/** The `(engine, question) => Promise<string>` seam, bound to a fixed set of
 * {@link RunExternalOptions} — how a host that HAS a live privacy thunk, room
 * bridge or cancel flag hands them to every advisor call it wires up. */
export function makeRunAdvisorCli(
  options: RunExternalOptions = {}
): (engine: CliEngine, question: string) => Promise<string> {
  return (engine, question) => runAdvisorCli(engine, question, options);
}


/**
 * Ready-made seam with no bridge, cancel flag or privacy thunk — the honest
 * default given none of those live instances exist yet in this migration (see
 * the module doc). This is what `execTool.ts`'s `withRealAdvisorCli` installs.
 */
export const realRunAdvisorCli: (engine: CliEngine, question: string) => Promise<string> = makeRunAdvisorCli();
