/**
 * Launcher-side readiness gate shared by QA and screenshot capture.
 *
 * WebdriverIO may continue enumerating specs after an `onPrepare` rejection.
 * Keeping the successful preparation fact in the launcher and checking it in
 * `onWorkerStart` makes that continuation harmless: no browser worker starts
 * unless build, QA-page generation, preview launch, and the HTTP probe all
 * completed.
 */
export function readinessGate(suiteName) {
  let ready = false;
  let failure = null;
  return {
    begin() {
      ready = false;
      failure = null;
    },
    pass() {
      ready = true;
      failure = null;
    },
    fail(error) {
      ready = false;
      failure = error instanceof Error ? error : new Error(String(error));
    },
    assertWorkerMayStart() {
      if (ready) return;
      const detail = failure?.message ? `: ${failure.message}` : "";
      throw new Error(`${suiteName} preparation did not complete; refusing to launch a browser worker${detail}`);
    },
    reset() {
      ready = false;
      failure = null;
    },
  };
}
