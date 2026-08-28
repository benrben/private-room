import { accessSync, constants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type NativeCliProvider = "codex" | "claude";

/**
 * Convert Arcelle's user-facing native-model alias into the optional model
 * value expected by Codex and Claude. Omitting the model lets each installed
 * harness use its own configured default; forwarding the literal word
 * `default` makes both CLIs look for a model with that name.
 */
export function nativeHarnessModel(model: string): string | undefined {
  const selected = model.trim();
  return selected === "" || selected.toLowerCase() === "default" ? undefined : selected;
}

function executable(candidate: string): string | null {
  try {
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/**
 * Resolve CLIs without running a user's interactive shell configuration.
 *
 * Finder-launched macOS applications normally receive a small system PATH,
 * while both Codex and Claude install into ~/.local/bin by default. Keep an
 * explicit Arcelle override authoritative, then search the inherited PATH and
 * the standard user/package-manager locations. Returning the bare command is
 * intentional: capability probes remain fail-closed when nothing is present.
 */
export function nativeCliExecutable(
  provider: NativeCliProvider,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const override = provider === "codex" ? env.ARCELLE_CODEX_PATH : env.ARCELLE_CLAUDE_PATH;
  if (override !== undefined && override.trim() !== "") return override;

  const command = provider;
  const directories = new Set([
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
  for (const directory of directories) {
    const found = executable(path.join(directory, command));
    if (found !== null) return found;
  }
  return command;
}
