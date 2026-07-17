import { isOllamaDown } from "./composer";
import { WSState } from "./state";

/** The one "the local model is down" toast, with its one-click remediation.
 * Every model-touching action shows exactly this, so it lives here once. */
export function toastOllamaDown(s: WSState, openOllamaApp: () => Promise<void>) {
  s.pushToast(
    "error",
    "Ollama is not running. Start the Ollama app, then try again.",
    { label: "Open Ollama", run: openOllamaApp },
  );
}

export interface GuardOptions {
  /** Raise the busy flag(s). Runs before `run`. */
  begin?: () => void;
  /** Lower the busy flag(s). Always runs, in `finally`. */
  finish?: () => void | Promise<void>;
  /** Errors this action swallows completely — no toast, no `onError`
   *  (a user-pressed Stop is not a failure). */
  ignore?: (msg: string) => boolean;
  /** Extra error branches, tried before the Ollama/plain-message fallback.
   *  Return true when the branch reported the error itself. */
  handle?: (msg: string) => boolean;
  /** Runs after a reported error (e.g. re-poll the jobs/model state). */
  onError?: (msg: string) => void | Promise<void>;
  /** Enables the "Ollama is not running" branch. Omit for actions that never
   *  touch the model — they just get the plain error toast. */
  openOllamaApp?: () => Promise<void>;
}

/** The shape every long-running action shares: raise a busy flag, run, report
 * failures through the same error taxonomy (stopped → ignored/informed, model
 * down → "Open Ollama", anything else → the raw message), and always lower the
 * flag again. */
export async function runGuarded(
  s: WSState,
  run: () => Promise<unknown>,
  opts: GuardOptions = {},
): Promise<void> {
  opts.begin?.();
  try {
    await run();
  } catch (e) {
    const msg = String(e);
    if (!opts.ignore?.(msg)) {
      if (!opts.handle?.(msg)) {
        if (opts.openOllamaApp && isOllamaDown(msg)) {
          toastOllamaDown(s, opts.openOllamaApp);
        } else {
          s.pushToast("error", msg);
        }
      }
      await opts.onError?.(msg);
    }
  } finally {
    await opts.finish?.();
  }
}

/** The micro-handler shape: mutate, then refresh whatever list the mutation
 * invalidated, and surface any failure as an error toast. `after` runs inside
 * the same try, so a failed refresh is reported too. */
export async function tryToast(
  s: WSState,
  run: () => Promise<unknown>,
  after?: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    if (after) await after();
  } catch (e) {
    s.pushToast("error", String(e));
  }
}
