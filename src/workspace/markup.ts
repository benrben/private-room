import { AiStatus, AnnotationPayload, FileTarget, splitExternalModel } from "../api";

/** External cloud engines/providers. Recognizes both a bare engine id and a
 * composite "engine::submodel" selection from the Cloud picker. */
export function isExternalEngine(model: string): boolean {
  const [engine] = splitExternalModel(model);
  return engine === "claude-cli" || engine === "codex-cli" || engine === "openrouter";
}

/** An Ollama `:cloud` model: listed alongside local models and driven through
 * the same tool loop (ADD-29 parity), but it RUNS REMOTELY — prompts and file
 * context leave this Mac. Must never be labeled "Local". */
export function isRemoteModel(model: string): boolean {
  return model.endsWith(":cloud");
}

/** Anything that sends room content off this Mac (SEC-6): drives the privacy
 * strip and the Cloud tier label. */
export function isCloudEngine(model: string): boolean {
  return isExternalEngine(model) || isRemoteModel(model);
}

export type TrustTone = "good" | "warn" | "danger";
export interface TrustState {
  tone: TrustTone;
  label: string;
  title: string;
}

/** The room's ONE trust state, derived from the engine (local vs cloud) and the
 * privacy door (protected vs raw). Every surface that tells the user whether
 * their content leaves this Mac — the status-bar chip, the top-bar engine
 * badge — reads from this single function, so they can never say different
 * things about the same room at the same time.
 *   • Local only      — the model runs on this Mac; nothing leaves.       (good)
 *   • Protected cloud — a cloud model, but private details are redacted. (warn)
 *   • Raw cloud       — a cloud model with the door OPEN; real content leaves. (danger) */
export function trustState(cloud: boolean, protectedOn: boolean | null): TrustState {
  if (!cloud) {
    return {
      tone: "good",
      label: "Local only",
      title: "The AI runs on this Mac — nothing leaves the device.",
    };
  }
  if (protectedOn === false) {
    return {
      tone: "danger",
      label: "Raw cloud",
      title:
        "Cloud model with privacy OFF — questions, documents and tool results leave this Mac with real names and details.",
    };
  }
  return {
    tone: "warn",
    label: "Protected cloud",
    title:
      "Cloud model with the privacy door on — private details are replaced with neutral tags before anything leaves this Mac.",
  };
}

/** Is the room's selected model usable right now (so no "download a model"
 * card is warranted)? A local/`:cloud` model must be present in Ollama's live
 * list (matched loosely on the `:tag` boundary). A cloud CLI is ready as soon
 * as its engine is detected — but the picker hands us a composite
 * "engine::model::effort" selection, so we split down to the bare engine id
 * before checking `ai.external` (which only ever holds bare engine ids). */
export function isModelReady(ai: AiStatus | null | undefined, model: string): boolean {
  if (!ai) return false;
  const [engine] = splitExternalModel(model);
  if (ai.external.includes(engine)) return true;
  return (
    ai.running &&
    (ai.models.includes(model) ||
      ai.models.some((m) => m.startsWith(model + ":") || model.startsWith(m)))
  );
}

export interface BoxesPayload {
  fileId: string;
  name?: string;
  boxes: { label: string; x1: number; y1: number; x2: number; y2: number }[];
}

/** Split assistant content into visible text and optional viewer-markup payloads. */
export function splitMarkupBlocks(content: string): {
  text: string;
  boxes?: BoxesPayload;
  annotation?: AnnotationPayload;
} {
  let text = content;
  let boxes: BoxesPayload | undefined;
  let annotation: AnnotationPayload | undefined;
  const boxMatch = text.match(/```boxes\n([\s\S]*?)\n?```/);
  if (boxMatch) {
    try {
      boxes = JSON.parse(boxMatch[1]) as BoxesPayload;
    } catch {
      /* malformed payload — show the text alone */
    }
    text = text.replace(boxMatch[0], "").trim();
  }
  const annotMatch = text.match(/```annotation\n([\s\S]*?)\n?```/);
  if (annotMatch) {
    try {
      annotation = JSON.parse(annotMatch[1]) as AnnotationPayload;
    } catch {
      /* malformed payload — show the text alone */
    }
    text = text.replace(annotMatch[0], "").trim();
  }
  return { text, boxes, annotation };
}

/** Viewer navigation for an annotation: quote or cell range. */
export function annotationTarget(a: AnnotationPayload): FileTarget {
  return {
    quote: a.quote,
    find: a.quote,
    page: a.page,
    sheet: a.sheet,
    range: a.range,
  };
}

/** CHG-6: an in-progress stream may hold a half-open ``` fence — balance it
 * (display only) so MarkdownView never renders a broken code block. */
export function patchStreamFences(s: string): string {
  const fences = (s.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${s}\n\`\`\`` : s;
}
