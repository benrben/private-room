export function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

export type Strength = { score: 0 | 1 | 2 | 3; label: string; level: "weak" | "okay" | "strong" };

// Simple, library-free estimate: length plus the mix of character kinds
// (lowercase, uppercase, digit, symbol). Empty input scores nothing.
export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: "", level: "weak" };
  let kinds = 0;
  if (/[a-z]/.test(pw)) kinds++;
  if (/[A-Z]/.test(pw)) kinds++;
  if (/[0-9]/.test(pw)) kinds++;
  if (/[^A-Za-z0-9]/.test(pw)) kinds++;

  let points = 0;
  if (pw.length >= 8) points++;
  if (pw.length >= 12) points++;
  if (kinds >= 2) points++;
  if (kinds >= 3) points++;

  if (pw.length < 8 || points <= 1) {
    return { score: 1, label: "Weak", level: "weak" };
  }
  if (points === 2 || points === 3) {
    return { score: 2, label: "Okay", level: "okay" };
  }
  return { score: 3, label: "Strong", level: "strong" };
}

// Friendly "Opened 2 hours ago" for the Recent list.
export function relativeTime(ms?: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.round(mo / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

// The check-off chips shown under the strength meter, so "how much more?" is
// answerable rather than a mystery between Weak and Strong.
export function passwordCriteria(pw: string): { label: string; met: boolean }[] {
  const kinds =
    (/[a-z]/.test(pw) ? 1 : 0) +
    (/[A-Z]/.test(pw) ? 1 : 0) +
    (/[0-9]/.test(pw) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(pw) ? 1 : 0);
  return [
    { label: "8+ characters", met: pw.length >= 8 },
    { label: "12+ characters", met: pw.length >= 12 },
    { label: "Mix of letters, numbers or symbols", met: kinds >= 2 },
  ];
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
