/**
 * Provider failures are untrusted data. They can echo prompts, file contents,
 * absolute paths, environment variables, credentials, or MCP bearer tokens.
 * Never place raw provider diagnostics in normalized events, MCP responses,
 * audit history, or logs. Detailed diagnostics remain the provider's concern.
 */
export function safeProviderFailure(
  source: string,
  phase: "run" | "tool" | "startup" = "run",
  exitCode?: number | null,
): string {
  const label = source === "ollama-local" ? "Local Ollama"
    : source === "ollama-cloud" ? "Ollama Cloud"
      : source === "openrouter" ? "OpenRouter"
        : source === "codex" ? "Codex"
          : source === "claude" ? "Claude"
            : "The model provider";
  const action = phase === "tool" ? "tool failed" : phase === "startup" ? "runtime could not start" : "run failed";
  const code = typeof exitCode === "number" && Number.isInteger(exitCode) ? ` (exit ${exitCode})` : "";
  return `${label} ${action}${code}. Provider diagnostics were omitted to protect room data.`;
}

export function safeFinalizationFailure(stage: "write-back" | "reconciliation"): string {
  return stage === "write-back"
    ? "Arcelle could not safely finish cloud write-back. Raw diagnostics were omitted to protect room data."
    : "Arcelle could not safely reconcile the room after the run. Raw diagnostics were omitted to protect room data.";
}
