import type { WSState } from "./state";
import {
  isCloudRoute,
  lostReplyAdvice,
  lostReplyNotice,
} from "./markup";

type ChatMessage = WSState["messages"][number];
type PrivacyReceipt = NonNullable<WSState["askPrivacy"]>;

export function renameDisabled(state: WSState): boolean {
  return state.asking || !state.activeChatId || state.renaming;
}

export function autoSpeakTitle(active: boolean): string {
  return active
    ? "Auto-speak is on — answers are read aloud (voice: Settings → Spoken voice)"
    : "Speak answers aloud as they stream";
}

export function handsFreeTitle(active: boolean): string {
  return active
    ? "Hands-free is on — the mic re-arms after each answer"
    : "Hands-free: re-arm the mic after each answer to keep talking";
}

export function privacySummary(privacy: PrivacyReceipt): string {
  if ((privacy.entities_hidden ?? 0) > 0) {
    return `${privacy.entities_hidden} private detail${privacy.entities_hidden === 1 ? "" : "s"} hidden from the cloud model`;
  }
  return (privacy.images_blocked ?? 0) > 0
    ? "Shielded — no private text needed hiding"
    : "Shielded — nothing private needed hiding";
}

export function hasHiddenPrivacy(privacy: PrivacyReceipt): boolean {
  return (privacy.entities_hidden ?? 0) > 0 || (privacy.images_blocked ?? 0) > 0;
}

export function privacyValveTitle(privacy: PrivacyReceipt): string {
  return privacy.images_blocked
    ? "The cloud model could not see the blocked images. Re-ask sharing them for this one question only."
    : "The hidden details made this answer vague? Re-ask sharing the real values — for this one question only.";
}

export function privacyConfirmationText(privacy: PrivacyReceipt): string {
  return hasBothPrivacyHides(privacy)
    ? "Send this question again with the real details and blocked images?"
    : singlePrivacyConfirmation(privacy.images_blocked ?? 0);
}

function hasBothPrivacyHides(privacy: PrivacyReceipt): boolean {
  return (privacy.entities_hidden ?? 0) > 0 && (privacy.images_blocked ?? 0) > 0;
}

function singlePrivacyConfirmation(imagesBlocked: number): string {
  return imagesBlocked > 0
    ? "Send this question again with the blocked images?"
    : "Send this question again with the real details?";
}

export function localReachFor(state: WSState): string {
  return [
    state.webOn ? "online search" : null,
    state.mcpTools.length > 0 ? "connected tools" : null,
  ].filter(Boolean).join(" and ");
}

export function routeNoteFor(model: string, ai: WSState["ai"], localReach: string): string {
  if (isCloudRoute(model, ai)) return "Asking your cloud AI — content leaves this Mac.";
  return localReach
    ? `Thinking on this Mac — ${localReach} can send parts of this out.`
    : "Thinking locally.";
}

export function finishedTurnNote(
  lastAssistant: ChatMessage | undefined,
  lastAssistantId: string | undefined,
  turnStartId: string | undefined,
): string {
  if (lastAssistantId === turnStartId) return "The turn ended with no answer.";
  const notice = lastAssistant ? lostReplyNotice(lastAssistant.content) : null;
  return notice !== null ? lostReplyAdvice(notice) : "The answer is ready.";
}

export function editTailFor(messages: ChatMessage[], draft: { id: string } | null): number {
  const index = draft ? messages.findIndex((message) => message.id === draft.id) : -1;
  return index < 0 ? 0 : messages.length - index - 1;
}
