/** Stable guarded-web facade; implementation is split by responsibility. */
export { MAX_DOWNLOAD_BYTES, safeFileName } from "./browser/downloads.js";
export {
  MAX_PAGE_CHARS,
  MAX_FETCH_BYTES,
  type CappableResponse,
  bodyCappedTo,
  bodyCapped,
  decodeBody,
  redirectTarget,
  type GuardedResponse,
  guardedGet,
  htmlTitle,
  type FetchedPage,
  fetchPage,
  fetchReadable,
} from "./webFetchCore.js";
export {
  INLINE_DOWNLOAD_BYTES,
  type Downloaded,
  type DownloadOutcome,
  dispositionFileName,
  guessDownloadMime,
  defaultDownloadTempDir,
  downloadToTemp,
} from "./webFetchDownload.js";
export {
  youtubeVideoId,
  extractCaptionTracks,
  timedtextJson3ToLines,
  youtubeTranscript,
} from "./webFetchYoutube.js";
export {
  MAX_PREVIEW_IMAGE_BYTES,
  type PagePreview,
  previewFromHtml,
  fetchPreview,
  fetchImage,
} from "./webFetchPreview.js";
