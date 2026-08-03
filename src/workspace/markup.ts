import { AiStatus, AnnotationPayload, FileTarget, splitExternalModel } from "../api";
import { isRelayedModel } from "./localModel";

/** External cloud engines/providers. Recognizes both a bare engine id and a
 * composite "engine::submodel" selection from the Cloud picker. */
export function isExternalEngine(model: string): boolean {
  const [engine] = splitExternalModel(model);
  return engine === "claude-cli" || engine === "codex-cli" || engine === "openrouter";
}

/** An Ollama relayed model: listed alongside local models and driven through
 * the same tool loop (ADD-29 parity), but it RUNS REMOTELY — prompts and file
 * context leave this Mac. Must never be labeled "Local".
 *
 * The rule itself lives in `localModel.isRelayedModel`, which mirrors the
 * host's declared capability record. It used to be an exact `endsWith(":cloud")`
 * here, which misses Ollama's `<size>-cloud` spelling (`gpt-oss:120b-cloud`) —
 * so `trustState` called such a room "Local only — nothing leaves the device"
 * while every prompt was going to ollama.com. */
export function isRemoteModel(model: string): boolean {
  return isRelayedModel(model);
}

/** Anything that sends room content off this Mac (SEC-6): drives the privacy
 * strip and the Cloud tier label. */
export function isCloudEngine(model: string): boolean {
  return isExternalEngine(model) || isRemoteModel(model);
}

/** Does this room's content leave this Mac — engine OR transport?
 *
 * `isCloudEngine` reads the model NAME, and a name cannot know that Settings →
 * the Closet has pointed Ollama at another computer. With that set, the very
 * same `qwen3.5:4b` runs on a LAN box: prompts, documents and transcripts go
 * there. The host reports it as `AiStatus.remoteRelay` (its own locality rule
 * is `capabilities::ollama_runs_here`), and every trust surface ORs it in — so
 * the chip can never say "Local only" about a relayed room. */
export function isCloudRoute(model: string, ai: { remoteRelay?: boolean } | null): boolean {
  return isCloudEngine(model) || ai?.remoteRelay === true;
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
  // Both directions match only across a `:` TAG BOUNDARY. A bare prefix test
  // would call "qwen3.5:4b" installed because an unrelated "qwen3" is — the
  // download card then never appears and the turn fails with MODEL_MISSING.
  return (
    ai.running &&
    (ai.models.includes(model) ||
      ai.models.some(
        (m) => m.startsWith(model + ":") || model.startsWith(m + ":"),
      ))
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

/** What the app itself wrote into the transcript when a turn produced no
 * answer, and what the user may safely do about it.
 *  • "clean"      — no answer, nothing written, nothing running: re-ask freely.
 *  • "after-write"— a file change already landed; re-asking would repeat it.
 *  • "with-job"   — background work is still running; re-asking may start it twice.
 * `null` for every real answer, including one that merely talks about a
 * failure. The strings are Arcelle's own constants (`agent.rs`
 * LOST_REPLY_*), pinned from the Rust side by
 * `the_notices_keep_the_fragments_the_chat_ui_matches_on`. */
export type LostReplyKind = "clean" | "after-write" | "with-job";

export function lostReplyNotice(content: string): LostReplyKind | null {
  const t = content.trimStart();
  if (!t.startsWith("*(The agent ")) return null;
  if (!t.includes("the reply was lost before it reached the app")) return null;
  if (t.includes("A change was already applied")) return "after-write";
  if (t.includes("Background work in this room is still running")) return "with-job";
  return "clean";
}

/** The one line the recovery strip shows above Try again. Says what is true of
 * THIS turn — never "nothing happened" when a write landed or a job is live. */
export function lostReplyAdvice(kind: LostReplyKind): string {
  if (kind === "after-write") {
    return "A change was already applied before the reply was lost — check the file first; asking again may repeat it.";
  }
  if (kind === "with-job") {
    return "Background work in this room is still running — check the Jobs list first; asking again may start it twice.";
  }
  return "Nothing was written, so asking again is safe.";
}

/** CHG-6: an in-progress stream may hold a half-open ``` fence — balance it
 * (display only) so MarkdownView never renders a broken code block. */
export function patchStreamFences(s: string): string {
  const fences = (s.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${s}\n\`\`\`` : s;
}
