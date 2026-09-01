const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

export interface Tick {
  at: number;
  pct: number;
  major: boolean;
  label: string;
}

function tickStep(duration: number, target = 8): number {
  for (const step of TICK_STEPS) {
    if (duration / step <= target) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

export function axisTicks(duration: number): Tick[] {
  if (!(duration > 0)) return [];
  const step = tickStep(duration);
  const ticks: Tick[] = [];
  const half = step / 2;
  for (let index = 0; index * half <= duration; index += 1) {
    const at = index * half;
    const major = index % 2 === 0;
    const pct = (at / duration) * 100;
    ticks.push({ at, pct, major, label: major && pct <= 96 ? fmtStamp(at) : "" });
  }
  return ticks;
}

export function fmtStamp(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = String(rounded % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}
