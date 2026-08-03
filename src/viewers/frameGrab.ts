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

/** Draw a source into an offscreen canvas and return bare base64 (no `data:`
 * prefix). `maxWidth` caps the long edge; pass the source width for 1:1. */
export function drawToPngB64(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxWidth: number,
): string {
  const scale = Math.min(1, maxWidth / srcW);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't create a 2D canvas context.");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

/** Resolve once the video has actually PRESENTED a frame (safe to draw).
 * requestVideoFrameCallback fires per composited frame; on a paused,
 * just-seeked pipeline it can stall, so after 300ms a muted play/pause forces
 * a frame through the decoder. Always resolves by timeoutMs — a black frame
 * beats a hung tool call. */
export function presentedFrame(
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        video.pause();
        resolve();
      }
    };
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback(() => done());
      window.setTimeout(() => {
        if (!settled) void video.play().catch(() => done());
      }, 300);
    } else {
      requestAnimationFrame(() => requestAnimationFrame(done));
    }
    window.setTimeout(done, timeoutMs);
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

/** One grabbed still, or the reason there isn't one. Never both, and never a
 * blank success — a caller that gets no `imageB64` has an `error` to show. */
export type GrabbedFrame =
  | { imageB64: string; width: number; height: number; atSeconds: number }
  | { error: string };

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

    if ((await mediaEvent(video, "loadedmetadata", 8000)) !== "ok") {
      return {
        error: "That video couldn't be loaded for a frame grab (timed out).",
      };
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
    await presentedFrame(video, 2500);

    try {
      return {
        imageB64: drawToPngB64(video, video.videoWidth, video.videoHeight, maxWidth),
        width: video.videoWidth,
        height: video.videoHeight,
        // The time actually PRESENTED, not the one asked for. A request past
        // the end clamps to `duration`, and `presentedFrame`'s play/pause nudge
        // advances the pipeline — so the two can differ, and a caption that
        // asserted the requested time either way would be quietly wrong.
        atSeconds: video.currentTime,
      };
    } catch {
      return { error: "That video's frames couldn't be exported to an image." };
    }
  } finally {
    video.remove();
  }
}
