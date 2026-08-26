import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { PRIVATE_DIR } from "./pathSafety.js";

export type WorkspaceChangeKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir" | "error";

export interface WorkspaceChange {
  kind: WorkspaceChangeKind;
  relativePath: string | null;
  error?: string;
}

export interface WorkspaceWatcherOptions {
  polling?: boolean;
  reconcileEveryMs?: number;
  onChange(change: WorkspaceChange): void;
  reconcile(): Promise<void>;
}

function isPrivateOrTemporary(rootPath: string, candidate: string): boolean {
  const relative = path.relative(rootPath, candidate).replace(/\\/g, "/");
  if (relative === PRIVATE_DIR || relative.startsWith(`${PRIVATE_DIR}/`)) return true;
  return /(^|\/)\.[^/]+\.arcelle-[0-9a-f-]+\.tmp$/i.test(relative);
}

/** Low-latency hints plus periodic full reconciliation as the source of truth. */
export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reconcileRunning = false;

  constructor(private readonly rootPath: string, private readonly options: WorkspaceWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher !== null) return;
    const root = path.resolve(this.rootPath);
    const watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: true,
      atomic: true,
      usePolling: this.options.polling === true,
      interval: this.options.polling === true ? 1_000 : 100,
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
      ignored: (candidate) => isPrivateOrTemporary(root, candidate),
    });
    this.watcher = watcher;
    const emit = (kind: WorkspaceChangeKind, absolutePath: string) => {
      const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
      if (relative === "" || isPrivateOrTemporary(root, absolutePath)) return;
      this.options.onChange({ kind, relativePath: relative });
    };
    watcher.on("add", (p) => emit("add", p));
    watcher.on("change", (p) => emit("change", p));
    watcher.on("unlink", (p) => emit("unlink", p));
    watcher.on("addDir", (p) => emit("addDir", p));
    watcher.on("unlinkDir", (p) => emit("unlinkDir", p));
    watcher.on("error", (error) => {
      this.options.onChange({ kind: "error", relativePath: null, error: String(error) });
      void this.runReconcileSafely();
    });
    await new Promise<void>((resolve, reject) => {
      watcher.once("ready", resolve);
      watcher.once("error", reject);
    });
    const interval = Math.max(30_000, this.options.reconcileEveryMs ?? 5 * 60_000);
    this.timer = setInterval(() => void this.runReconcileSafely(), interval);
    this.timer.unref?.();
  }

  private async runReconcile(): Promise<void> {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try { await this.options.reconcile(); } finally { this.reconcileRunning = false; }
  }

  private async runReconcileSafely(): Promise<void> {
    try {
      await this.runReconcile();
    } catch (error) {
      this.options.onChange({
        kind: "error",
        relativePath: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher !== null) await watcher.close();
  }
}
