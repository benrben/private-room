/** Which conversation an in-flight turn's events belong to.
 *
 * Owner replacement #4 (2026-08-03). Two live-QA symptoms, one cause: an answer
 * streamed into whatever chat happened to be on screen, and a brand-new chat
 * displayed the previous chat's token bar ("30,034 / 1,000,000" with 12,092
 * tokens of history on a conversation that had none). Neither was a bug in the
 * turn — the answer is filed against the right chat and the history really is
 * empty. The EVENTS were anonymous, so ownership was inferred from what was
 * mounted.
 *
 * The host now stamps every `ask-*` event with the run and chat that produced
 * it (`crate::turn`), and the rules for reading that stamp live here — pure,
 * and in their own module rather than inside `state.ts`, because these are the
 * rules worth pinning in a test and a file that imports React cannot be loaded
 * by the plain-Node runner (`e2e/page-script/runIdentity.test.mjs`).
 */
import type {
  AskActiveAgent,
  AskPlanStep,
  AskTokenUsage,
  AskTurn,
} from "../apiTypes";

/** Everything one conversation's turn is painting right now, under the id of
 * the run painting it. `runId` is the ask id the composer minted and handed to
 * `ask`/`run_command`, which the host stamps on every event of that turn. */
export interface LiveTurn {
  runId: string;
  text: string;
  steps: { label: string; ok: boolean }[];
  lane: string;
  plan: AskPlanStep[] | null;
  agent: AskActiveAgent | null;
  agentSteps: Record<string, { label: string; ok: boolean }[]>;
  agentReports: Record<string, { text: string; ok: boolean }>;
}

/** Every conversation with a turn in flight. A chat with no entry is idle —
 * which is the whole point: "nothing is running here" is the ABSENCE of a
 * record, not a set of globals someone remembered to clear. */
export type Runs = Record<string, LiveTurn>;

/** What a chat with nothing running reads. One shared instance, so an idle
 * conversation hands its consumers the same identities on every render. */
export const NO_LIVE_TURN: LiveTurn = {
  runId: "",
  text: "",
  steps: [],
  lane: "",
  plan: null,
  agent: null,
  agentSteps: {},
  agentReports: {},
};

/** Register a chat's turn BEFORE the question is sent, so the chat already
 * knows the run id its events will carry. Also clears whatever the previous
 * turn left in this chat's slot. */
export function startRun(runs: Runs, chatId: string, runId: string): Runs {
  return { ...runs, [chatId]: { ...NO_LIVE_TURN, runId } };
}

/** The turn is over (finished, failed or stopped) — its overlay goes with it,
 * and no other conversation's run is touched. Idempotent: `runGuarded`'s
 * `finally` can reach here more than once. */
export function finishRun(runs: Runs, chatId: string): Runs {
  if (!(chatId in runs)) return runs;
  const next = { ...runs };
  delete next[chatId];
  return next;
}

/** Apply one event to the run that produced it.
 *
 * The two guards ARE the fix. An event for a chat with no live run is dropped
 * (it is late, or it came from an emitter that belongs to no conversation), and
 * so is one naming a run this chat is not on — which is exactly how a finished
 * turn's straggler used to land on the next one. Returning the SAME object when
 * nothing applies keeps a dropped event from re-rendering anything. */
export function applyEvent(
  runs: Runs,
  chatId: string,
  runId: string | null,
  patch: (t: LiveTurn) => LiveTurn,
): Runs {
  const cur = runs[chatId];
  if (!cur) return runs;
  if (runId !== null && runId !== cur.runId) return runs;
  return { ...runs, [chatId]: patch(cur) };
}

/** The overlay to paint for the conversation on screen. */
export function liveTurn(runs: Runs, chatId: string | null): LiveTurn {
  return (chatId && runs[chatId]) || NO_LIVE_TURN;
}

/** Does THIS conversation have a turn in flight? Not "is something running
 * somewhere": a chat that asked nothing must never show Stop or a thinking
 * bubble. */
export function isAsking(runs: Runs, chatId: string | null): boolean {
  return !!chatId && chatId in runs;
}

/** The run id a chat is on, or null when it is idle — what Stop cancels. */
export function runIdOf(runs: Runs, chatId: string | null): string | null {
  return (chatId && runs[chatId]?.runId) || null;
}

/** Which chat's slot an event may write.
 *
 * An event that names its chat owns itself, wherever the user happens to be
 * looking. An event with NO ids belongs to no conversation at all (the
 * AI-actions menu, which runs from the file header) — it is offered to the chat
 * on screen, which takes it only if it is itself running something. That last
 * step is `applyEvent`'s job, not this one's: here we only name a candidate. */
export function ownerOf(turn: AskTurn, onScreen: string | null): string | null {
  return turn.chatId ?? onScreen;
}

/** The token-budget reading for one conversation.
 *
 * A fresh chat reads null — and therefore zero — because it HAS no entry, not
 * because something remembered to clear a global. That global is what made a
 * brand-new conversation show the previous one's 30,034 tokens: the readout was
 * stale while the system underneath was correct, which is the more dangerous
 * kind of wrong because it makes a working app look broken. */
export function usageOf(
  byChat: Record<string, AskTokenUsage>,
  chatId: string | null,
): AskTokenUsage | null {
  return (chatId && byChat[chatId]) || null;
}
