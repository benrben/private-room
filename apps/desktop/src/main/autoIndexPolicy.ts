/** Drops at or below this size use the quiet filler instead of a visible job. */
export const QUIET_FILLER_MAX = 5;

export type AutoIndexDecision = "skip" | "quietFiller" | "startJob" | "retry";

export function autoIndexDecision(
  settingOn: boolean,
  missing: number,
  jobRunning: boolean,
  asking: boolean,
  modelsAvailable: boolean,
): AutoIndexDecision {
  if (!settingOn) return "skip";
  if (autoIndexIsBusy(jobRunning, asking)) return "retry";
  return readyAutoIndexDecision(missing, modelsAvailable);
}

function autoIndexIsBusy(jobRunning: boolean, asking: boolean): boolean {
  return asking || jobRunning;
}

function readyAutoIndexDecision(missing: number, modelsAvailable: boolean): AutoIndexDecision {
  if (!modelsAvailable || missing === 0) return "skip";
  return missing <= QUIET_FILLER_MAX ? "quietFiller" : "startJob";
}
