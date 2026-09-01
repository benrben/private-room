/** Detect a YouTube page after removing any URL scheme. */
export function isYoutubeUrl(url: string): boolean {
  const bare = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return /(^|\.)((youtube(-nocookie)?\.com)|youtu\.be)\//i.test(bare);
}

/** Format a byte estimate at the scale a person uses for a download. */
export function fmtSize(bytes: number): string {
  const gib = 1024 ** 3;
  return bytes >= gib
    ? `${(bytes / gib).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function importModeCopy(isYoutube: boolean) {
  return isYoutube
    ? {
        pageName: "Transcript only",
        pageDetail: "captions, small and fast",
        videoName: "Video + transcript",
        videoDetail: "larger, plays offline forever",
      }
    : {
        pageName: "Page text",
        pageDetail: "readable copy, small and fast",
        videoName: "Video from this page",
        videoDetail: "works on most video sites",
      };
}

export function submitButtonLabel({ downloading, importing, isYoutube, saveVideo }: {
  downloading: boolean;
  importing: boolean;
  isYoutube: boolean;
  saveVideo: boolean;
}) {
  if (downloading) return "Downloading…";
  if (importing) return "Fetching…";
  if (isYoutube) return saveVideo ? "Import video" : "Import transcript";
  return saveVideo ? "Download video" : "Save page";
}
