/**
 * ONE frame grab for the whole app.
 *
 * The agent's `view_media_frame` tool and the video viewer's "Save frame"
 * button both need a still out of a `roommedia://` stream, and both are one
 * mistake away from returning a black rectangle or throwing a SecurityError.
 * Those two fixes — waiting for a PRESENTED frame, and asking for the stream
 * as CORS — live HERE so a repair to either reaches both callers, rather than
 * being made twice and drifting.
 *
 * What differs between the callers is only the output size, so that is the
 * parameter: the agent caps at 1280px because it is feeding a vision model,
 * while an exported still passes the video's own width and gets full
 * resolution.
 */

export interface DrawnPng {
  imageB64: string;
  width: number;
  height: number;
}

/** Exact canvas dimensions used by {@link drawToPng}. Kept pure so the receipt
 * sizing rule can be pinned without pretending source-video dimensions describe
 * a resized PNG. */
export function frameOutputDimensions(
  srcW: number,
  srcH: number,
  maxWidth: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / srcW);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/** Draw a source into an offscreen canvas and return bare base64 (no `data:`
 * prefix) together with the exact encoded PNG dimensions. */
export function drawToPng(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxWidth: number,
): DrawnPng {
  const dimensions = frameOutputDimensions(srcW, srcH, maxWidth);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't create a 2D canvas context.");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/png");
  return { imageB64: url.slice(url.indexOf(",") + 1), ...dimensions };
}

/** Compatibility wrapper for screenshot callers that only need the pixels. */
export function drawToPngB64(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxWidth: number,
): string {
  return drawToPng(source, srcW, srcH, maxWidth).imageB64;
}

/** Resolve once the video has actually PRESENTED a frame (safe to draw).
 * requestVideoFrameCallback fires per composited frame; on a paused,
 * just-seeked pipeline it can stall, so after 300ms a muted play/pause forces
 * a frame through the decoder. A bounded wait that sees no callback is an
 * honest timeout, never permission to attach a possibly black or stale canvas. */
export function presentedFrame(
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<
  | { status: "presented"; mediaTime: number }
  | { status: "invalid-timestamp" }
  | { status: "timeout" }
> {
  return new Promise((resolve) => {
    let settled = false;
    let nudgeTimer = 0;
    let timeoutTimer = 0;
    const done = (result:
      | { status: "presented"; mediaTime: number }
      | { status: "invalid-timestamp" }
      | { status: "timeout" }) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(nudgeTimer);
        window.clearTimeout(timeoutTimer);
        video.pause();
        resolve(result);
      }
    };
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback((_now, metadata) => {
        // mediaTime names the exact media frame Chromium presented. Reading
        // video.currentTime after the play/pause nudge can observe the playback
        // clock after it advanced or wrapped, producing a receipt for 0.002s
        // alongside pixels actually decoded at 1.05s.
        if (typeof metadata.mediaTime !== "number" || !Number.isFinite(metadata.mediaTime)) {
          done({ status: "invalid-timestamp" });
          return;
        }
        done({ status: "presented", mediaTime: metadata.mediaTime });
      });
    }
    // Engines without requestVideoFrameCallback have no trustworthy paint
    // receipt. Nudge their decoder too, but never promote an animation-frame
    // guess to success; if no real callback exists, the bounded timeout below
    // returns an honest failure instead of attaching an unproven canvas.
    nudgeTimer = window.setTimeout(() => {
      // A rejected nudge is not evidence that a frame was painted. Leave the
      // request alive until the bounded timeout reports the honest failure.
      if (!settled) void video.play().catch(() => {});
    }, 300);
    timeoutTimer = window.setTimeout(() => done({ status: "timeout" }), timeoutMs);
  });
}

/** Await one media event, racing "error" and a timeout — a bad token or a
 * codec WKWebView won't play must degrade to an {error} payload, not a hang. */
export function mediaEvent(
  el: HTMLMediaElement,
  event: string,
  timeoutMs: number,
): Promise<"ok" | "error" | "timeout"> {
  return new Promise((resolve) => {
    const finish = (result: "ok" | "error" | "timeout") => {
      window.clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
      resolve(result);
    };
    const timer = window.setTimeout(() => finish("timeout"), timeoutMs);
    const onOk = () => finish("ok");
    const onErr = () => finish("error");
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

/** Turn the two distinct media-load failures into claims the app can support.
 * An `error` event usually means Chromium rejected the container/codec; it is
 * not a timeout and must not be reported as one. */
export function mediaLoadFailure(result: "error" | "timeout"): string {
  return result === "error"
    ? "That video couldn't be decoded for a frame grab. Its codec or container may not be supported."
    : "That video couldn't be loaded for a frame grab (timed out).";
}

/** One grabbed still, or the reason there isn't one. Never both, and never a
 * blank success — a caller that gets no `imageB64` has an `error` to show. */
export type GrabbedFrame =
  | { imageB64: string; width: number; height: number; atSeconds: number; sha256: string }
  | { error: string };

/** SHA-256 of the decoded frame bytes, not of their base64 spelling. Exported
 * so the renderer contract can be pinned without constructing a video DOM. */
export async function frameSha256(imageB64: string): Promise<string> {
  const binary = atob(imageB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Grab one frame of a staged video at `seconds`.
 *
 * A HIDDEN element does the work even when a player is already on screen: the
 * visible one carries no `crossOrigin`, and `roommedia://` is a different
 * origin than the app, so drawing from it taints the canvas and `toDataURL`
 * throws (the shipped symptom was "that video's frames couldn't be exported").
 * `crossOrigin` cannot be added after the fact either — it only takes effect
 * when set BEFORE the source is assigned, which is exactly what this function
 * can guarantee and a mounted player cannot.
 */
export async function grabFrame(
  token: string,
  mime: string,
  seconds: number,
  maxWidth: number,
): Promise<GrabbedFrame> {
  if (!token) return { error: "There is no media stream to grab a frame from." };

  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.setAttribute("playsinline", "");
  // Paired with the roommedia:// handler's Access-Control-Allow-Origin: *.
  video.crossOrigin = "anonymous";
  // Off-screen but in the document — WKWebView won't load detached media.
  video.style.position = "fixed";
  video.style.left = "-10000px";
  video.style.width = "1px";
  video.style.height = "1px";

  try {
    const source = document.createElement("source");
    source.src = `roommedia://localhost/${token}`;
    if (mime) source.type = mime;
    video.appendChild(source);
    document.body.appendChild(video);
    video.load();

    const loaded = await mediaEvent(video, "loadedmetadata", 8000);
    if (loaded !== "ok") {
      return { error: mediaLoadFailure(loaded) };
    }
    if (!video.videoWidth || !video.videoHeight) {
      return { error: "That file has no video track." };
    }

    const duration = video.duration;
    const t = Number.isFinite(duration)
      ? Math.min(Math.max(0, seconds), duration)
      : Math.max(0, seconds);
    video.currentTime = t;
    const seeked = await mediaEvent(video, "seeked", 8000);
    // HAVE_CURRENT_DATA: even if "seeked" got lost, a decodable frame is up.
    if (seeked !== "ok" && video.readyState < 2) {
      return { error: `Couldn't seek that video to ${t.toFixed(1)}s.` };
    }
    // WKWebView fires "seeked" before the decoder has PAINTED the new frame —
    // drawing immediately captures a black canvas (the model then honestly
    // reports "a completely black screen").
    const presented = await presentedFrame(video, 2500);
    if (presented.status === "invalid-timestamp") {
      return {
        error: "That video presented a frame without a verifiable media timestamp, so no pixels were attached.",
      };
    }
    if (presented.status !== "presented") {
      return {
        error: "That video did not present the requested frame before the frame-grab timeout.",
      };
    }

    try {
      const png = drawToPng(video, video.videoWidth, video.videoHeight, maxWidth);
      return {
        imageB64: png.imageB64,
        width: png.width,
        height: png.height,
        // The time actually PRESENTED, not the one asked for. A request past
        // the end clamps to `duration`, and `presentedFrame`'s play/pause nudge
        // advances the pipeline — so the two can differ, and a caption that
        // asserted the requested time either way would be quietly wrong.
        atSeconds: presented.mediaTime,
        // Hash the exact PNG attached to the model. The Electron host verifies
        // this receipt again before accepting the frame into tool provenance.
        sha256: await frameSha256(png.imageB64),
      };
    } catch {
      return { error: "That video's frames couldn't be exported to an image." };
    }
  } finally {
    video.remove();
  }
}
