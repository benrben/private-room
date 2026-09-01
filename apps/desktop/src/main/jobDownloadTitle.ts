/** Plain guarded-HTTP download engine. */
export const DOWNLOAD_ENGINE_FETCH = "fetch";

/** yt-dlp media download engine. */
export const DOWNLOAD_ENGINE_MEDIA = "media";

function urlDownloadTitle(parsed: URL, engine: string): string | null {
  const lastSegment = parsed.pathname.split("/").filter((part) => part !== "").at(-1) ?? null;
  const fromPath = engine === DOWNLOAD_ENGINE_FETCH ? lastSegment : null;
  return fromPath ?? (parsed.hostname !== "" ? parsed.hostname : null);
}

/** Return the short, user-facing title for a download job. */
export function downloadTitle(url: string, engine: string): string {
  let short: string | null = null;
  try {
    short = urlDownloadTitle(new URL(url), engine);
  } catch {
    short = null;
  }
  return `Download ${short ?? url}`;
}
