import { AnnotationPayload, FileTarget } from "../api";

/** External CLI engines (Claude Code / Codex): a separate subprocess path —
 * no in-app tool chips, no Ollama daemon needed. */
export function isExternalEngine(model: string): boolean {
  return model === "claude-cli" || model === "codex-cli";
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
