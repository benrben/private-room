import { useEffect, useRef, useState } from "react";
import { RoomInfo } from "../api";
import type { AskActiveAgent, AskPlanStep } from "../apiTypes";
import {
  CheckIcon,
  DownloadIcon,
  EmptyChatArt,
  EyeIcon,
  HandsFreeIcon,
  MemoryIcon,
  PencilIcon,
  PlayIcon,
  SparkIcon,
  SpeakerIcon,
  StopIcon,
  TrashIcon,
  UndoIcon,
} from "../icons";
import ChatAnnotatedImage from "../viewers/ChatAnnotatedImage";
import MarkdownView from "../viewers/MarkdownView";
import { HandoffMarker } from "./TokenBudgetBar";
import { AgentGraph, type AgentTiming } from "./AgentGraph";
import { uniqueFileName } from "./composer";
import {
  annotationTarget,
  handTokens,
  isCloudRoute,
  isHandwritten,
  isLatinScript,
  isModelReady,
  lostReplyAdvice,
  lostReplyNotice,
  messageClock,
  patchStreamFences,
  speakerName,
  splitMarkupBlocks,
} from "./markup";
import {
  CHAT_PAGE,
  chatPageSlice,
  chatPageToReveal,
  HELP_COMMAND,
  RECOMMENDED_MODELS,
} from "./constants";
import DeleteControl from "./DeleteControl";
import Composer from "./ComposerPane";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** One finished turn's agent diagram, kept so it can be read after the answer
 * lands: which helpers ran, what each did, and how long it took. */
interface PastGraph {
  plan: AskPlanStep[];
  active: AskActiveAgent | null;
  agentSteps: Record<string, { label: string; ok: boolean }[]>;
  /** What each specialist reported back — kept with the rest of the diagram so
   * the answer a child gave can still be read after the turn ends. */
  agentReports: Record<string, { text: string; ok: boolean }>;
  steps: { label: string; ok: boolean }[];
  lane: string;
  timings: { current: Record<string, AgentTiming> };
}

/** A short message set in the hand, with its technical tokens PRINTED.
 *
 * A person writing a note still prints the things that have to be read
 * exactly — a filename, a host, an @mention — so `handTokens` marks those runs
 * and they come out in the mono face inside the handwriting. The runs
 * concatenate back to the message character for character (see `handTokens`),
 * and this renders TEXT NODES only: the string never becomes markup, which is
 * the same guarantee the sanitised Markdown path gives the other speaker.
 *
 * Used for the user's own notes alone. A short answer from the model goes
 * through MarkdownView, which cannot be token-split — it does not need to be,
 * because a model answer carrying code, a table or a URL fails the hand test
 * outright and is set in the sans. */
function HandNote({ text }: { text: string }) {
  return (
    <>
      {handTokens(text).map((t, i) =>
        t.mono ? (
          <span key={i} className="msg-mono">
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  );
}

/** Pane 3: the chat header, onboarding banners, the message transcript (with
 * receipts/undo/regenerate/save), the streaming placeholder, the "worth
 * remembering?" card, and the composer. Extracted verbatim. */
export default function ChatPane({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  const { ai, model, messages } = s;
  const modelReady = isModelReady(ai, model);
  // PRIV-1: two-step confirm for the "send real details this once" valve.
  const [confirmReal, setConfirmReal] = useState(false);
  // Inline rewrite of one of your own messages (null when nothing is open).
  const [editDraft, setEditDraft] = useState<{ id: string; text: string } | null>(
    null,
  );
  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  // The privacy receipt and the "worth remembering?" card describe the turn
  // that just finished IN THIS conversation. They belong to the window, so
  // switching conversations used to carry them along and pin a claim about one
  // chat under another. A remount (the AI pane's tabs) must NOT clear them,
  // hence the ref rather than a bare [activeChatId] effect.
  const shownChat = useRef(s.activeChatId);
  useEffect(() => {
    if (shownChat.current === s.activeChatId) return;
    shownChat.current = s.activeChatId;
    // The privacy receipt is per chat now (owner replacement #4), so it needs
    // no clearing — it is simply read from the conversation on screen. The
    // memory-suggestion card is still window-wide and does.
    s.setMemSuggestion(null);
    // So does the PENDING roster below. It is filed against an answer only when
    // a turn ends in the chat that produced it, so leaving that chat mid-answer
    // strands it — and the next NON-delegating turn in that same chat writes no
    // roster of its own, so it would inherit this one: a diagram of specialists
    // that never ran, with their steps and reports, under an answer they had
    // nothing to do with. Diagrams already filed (`graphByMsg`) are untouched.
    lastGraph.current = null;
    // A conversation opens on its newest page — see `shownCount`.
    setShownCount(CHAT_PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.activeChatId]);

  /** How many of `messages` are actually PAINTED, newest-last.
   *
   * There was no limit: switching to a months-old chat mounted every row at
   * once — hundreds of long answers, each with its own Markdown parse, plus
   * inline images and agent diagrams — which stalls the pane and holds all of
   * it in memory for as long as the chat is open, and gets worse the more you
   * use that chat. Only the render is bounded here; the backend still hands
   * over the whole conversation, so nothing is lost and "Show earlier
   * messages" is instant.
   *
   * Deliberately NOT a scroll-triggered auto-load: this pane auto-scrolls to
   * the bottom on every new token, and a top-of-list trigger fights that. */
  const [shownCount, setShownCount] = useState(CHAT_PAGE);
  const { hidden: hiddenOlder, visible: shownMessages } = chatPageSlice(
    messages,
    shownCount,
  );

  /* Jumping to a search hit has to survive the page above. `revealMessage`
   * (miscActions) scrolls to `#msg-<id>` and polls for it, which worked only
   * because every message used to be mounted; with a tail page, a hit older
   * than CHAT_PAGE has no element, the poll expires and the search result
   * silently does nothing. Widen the page far enough to include the row —
   * the messages are already in memory, so this costs a render, not a load.
   * Cleared once the row is reachable (or once the loaded conversation is
   * known not to contain it) so this cannot latch on. */
  const revealSeen = useRef<unknown>(null);
  useEffect(() => {
    const id = s.revealMsgId;
    if (!id) {
      revealSeen.current = null;
      return;
    }
    // A hit picked from another conversation arrives in the SAME commit as the
    // chat switch, so `messages` here is still the old chat's. Remember which
    // list the request arrived with and only give up once a different one has
    // been loaded and still does not contain the message.
    if (revealSeen.current === null) revealSeen.current = messages;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      setShownCount((n) => Math.max(n, chatPageToReveal(messages.length, idx)));
      s.setRevealMsgId(null);
    } else if (messages !== revealSeen.current) {
      s.setRevealMsgId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.revealMsgId, messages]);

  // The agent diagram is the only record of which helpers ran and for how
  // long, and it used to exist only while the answer was being written.
  // Keep the last roster and its clocks, and re-attach them to the answer.
  const liveTimings = useRef<Record<string, AgentTiming>>({});
  // The kept roster and the "was a turn running?" reading are both facts about
  // ONE conversation (owner replacement #4): `s.asking` is per chat now, so
  // walking away from a running chat also flips it false, and without the chat
  // id beside them the diagram from the chat being LEFT was filed against the
  // new chat's last answer.
  const lastGraph = useRef<
    { chatId: string | null; graph: Omit<PastGraph, "timings"> } | null
  >(null);
  const wasAsking = useRef(false);
  const askingChat = useRef<string | null>(null);
  const [graphByMsg, setGraphByMsg] = useState<Record<string, PastGraph>>({});
  useEffect(() => {
    // Only a turn that DELEGATED has a diagram worth keeping; a lone Main
    // agent draws a single chip, which the finished message already shows.
    if (s.agentPlan && s.agentPlan.length > 1) {
      lastGraph.current = {
        chatId: s.activeChatId,
        graph: {
          plan: s.agentPlan,
          active: s.activeAgent,
          agentSteps: s.agentSteps,
          agentReports: s.agentReports,
          steps: s.steps,
          lane: s.lane,
        },
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.agentPlan, s.activeAgent, s.agentSteps, s.agentReports, s.steps, s.lane]);
  useEffect(() => {
    // A turn ENDED here only if the chat this reading describes is still the
    // one on screen; otherwise the user simply switched away and nothing
    // finished.
    const sameChat = askingChat.current === s.activeChatId;
    const was = sameChat && wasAsking.current;
    wasAsking.current = s.asking;
    askingChat.current = s.activeChatId;
    if (s.asking) {
      if (!was) liveTimings.current = {};
      return;
    }
    if (!sameChat) return;
    const kept = lastGraph.current;
    const graph = kept && kept.chatId === s.activeChatId ? kept.graph : null;
    if (graph) lastGraph.current = null;
    // Only a turn that just ENDED files a graph, and only against an answer
    // that has none — a stopped turn must not overwrite the previous answer's.
    if (!was || !graph || !lastAssistantId || graphByMsg[lastAssistantId]) return;
    const now = performance.now();
    const frozen: Record<string, AgentTiming> = {};
    for (const [key, t] of Object.entries(liveTimings.current)) {
      frozen[key] = { start: t.start, end: t.end ?? now };
    }
    liveTimings.current = {};
    setGraphByMsg((g) => ({
      ...g,
      [lastAssistantId]: { ...graph, timings: { current: frozen } },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.asking, s.activeChatId, lastAssistantId, graphByMsg]);

  const submitEdit = () => {
    const draft = editDraft;
    if (!draft) return;
    setEditDraft(null);
    void a.editAndResend(draft.id, draft.text);
  };

  return (
    <div className="chat" aria-label="Chat">
      <div className="chat-head">
        {s.renaming ? (
          <input
            className="chat-select chat-rename"
            autoFocus
            dir="auto"
            value={s.renameDraft}
            onChange={(e) => s.setRenameDraft(e.target.value)}
            onBlur={a.commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") a.commitRename();
              if (e.key === "Escape") s.setRenaming(false);
            }}
          />
        ) : (
          <select
            className="chat-select"
            value={s.activeChatId ?? ""}
            dir="auto"
            onChange={(e) => s.setActiveChatId(e.target.value)}
          >
            {s.chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        <button
          className="subtle btn-ic"
          title="Rename this chat"
          aria-label="Rename this chat"
          disabled={s.asking || !s.activeChatId || s.renaming}
          onClick={a.startRename}
        >
          <PencilIcon size={13} />
        </button>
        <button className="subtle" title="New chat ⌘N" onClick={a.newChat}>
          ＋ New
        </button>
        <button
          className="subtle"
          title="Copy this whole conversation as text"
          disabled={messages.length === 0}
          onClick={a.copyConversation}
        >
          Copy chat
        </button>
        <button
          className={`subtle btn-ic${s.autoSpeak ? " accent" : ""}`}
          title={
            s.autoSpeak
              ? "Auto-speak is on — answers are read aloud (voice: Settings → Spoken voice)"
              : "Speak answers aloud as they stream"
          }
          aria-label="Read answers aloud"
          aria-pressed={s.autoSpeak}
          onClick={a.toggleAutoSpeak}
        >
          <SpeakerIcon size={14} />
        </button>
        <button
          className={`subtle btn-ic${s.handsFree ? " accent" : ""}`}
          title={
            s.handsFree
              ? "Hands-free is on — the mic re-arms after each answer"
              : "Hands-free: re-arm the mic after each answer to keep talking"
          }
          aria-label="Hands-free — re-arm the mic after each answer"
          aria-pressed={s.handsFree}
          onClick={a.toggleHandsFree}
        >
          <HandsFreeIcon size={14} />
        </button>
        {s.activeChatId && (
          <DeleteControl
            k={`chat:${s.activeChatId}`}
            trigger={<TrashIcon size={14} />}
            onConfirm={() => a.removeChat(s.activeChatId!)}
            title="Delete this chat session"
            confirmDelete={s.confirmDelete}
            askConfirm={a.askConfirm}
            cancelConfirm={a.cancelConfirm}
          />
        )}
      </div>

      {/* The kicker is the one handwritten word on a notice, and the rule
          behind that split is worth stating once: the LABEL is an aside, so it
          takes the hand; the CONSEQUENCE is an instruction about what leaves
          this Mac, so it stays in the interface sans at reading size. A
          privacy warning set in a handwriting face would be decoration
          wearing the clothes of the product's core promise. */}
      {s.showSyncWarn && (
        <div className="banner notice">
          <span className="banner-kicker">Note</span>
          This room lives in a synced folder. Never open it on two computers
          at the same time — the file can be damaged. Lock it before
          switching machines.{" "}
          <button className="subtle" onClick={a.dismissSyncWarn}>
            Dismiss
          </button>
        </div>
      )}
      {/* PRIV-1: OFF must be loud — a room talking to a cloud model with the
          door open says so persistently, not in a setting nobody reopens. */}
      {isCloudRoute(model, s.ai) && s.privacyOn === false && (
        <div className="banner privacy-off-banner" role="alert">
          <span className="banner-kicker">Heads up</span>
          Privacy is off — cloud models can see everything in this room,
          names and all. Turn it back on in Settings → Cloud privacy.
        </div>
      )}
      {ai && !ai.running && !ai.installed && (
        <div className="banner onboard">
          <span>
            This room's AI runs on <strong>Ollama</strong>, a free app.
          </span>
          <span className="onboard-actions">
            <button className="subtle" onClick={a.getOllama}>
              Get Ollama
            </button>
            <button className="subtle" onClick={a.refreshAi}>
              I installed it — check again
            </button>
          </span>
        </div>
      )}
      {ai && !ai.running && ai.installed && (
        <div className="banner onboard">
          <span>
            <strong>Ollama</strong> is installed but not running.
          </span>
          <span className="onboard-actions">
            <button className="subtle" onClick={a.openOllamaApp}>
              Open Ollama
            </button>
          </span>
        </div>
      )}
      {ai?.running && !modelReady && (
        <div className="banner onboard">
          {s.pullingModel ? (
            <span className="banner-pull">
              <span className="banner-pull-label">
                Downloading <strong>{model}</strong>…
              </span>
              <span className="pull-bar">
                <span
                  className="pull-bar-fill"
                  style={{ width: `${s.pullPercent ?? 0}%` }}
                />
              </span>
              <span className="banner-pull-status">
                {s.pullStatus}
                {s.pullPercent != null && ` — ${s.pullPercent.toFixed(0)}%`}
              </span>
              {/* A multi-gigabyte download started here could only be escaped by
                  quitting the app: the Rust half has been cancellable all along
                  (`pull:<model>` in the same registry chat's Stop uses) with no
                  surface calling it. */}
              <button className="subtle" onClick={() => void a.stopModelPull()}>
                Stop
              </button>
            </span>
          ) : (
            <div className="model-pick">
              <div className="model-pick-head">
                <strong>Pick a model to download</strong>
                <span className="model-pick-sub">
                  It runs entirely on your Mac. You can switch or add more
                  anytime in Settings.
                </span>
              </div>
              <div className="model-pick-grid">
                {RECOMMENDED_MODELS.map((m) => (
                  <div className="model-pick-card" key={m.name}>
                    {m.tag && (
                      <span className="model-pick-tag">{m.tag}</span>
                    )}
                    <div className="model-pick-name">{m.name}</div>
                    <div className="model-pick-meta">
                      {m.label} · {m.size}
                    </div>
                    <div className="model-pick-blurb">{m.blurb}</div>
                    <button
                      className="subtle btn-ic model-pick-get"
                      onClick={() => a.pickAndDownload(m.name)}
                    >
                      <DownloadIcon size={13} /> Download
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {s.pullError && <div className="banner-error">{s.pullError}</div>}
        </div>
      )}
      <div className="messages" ref={s.chatRef}>
        {messages.length === 0 && (
          <div className="chat-hero">
            <div className="chat-hero-icon">
              <EmptyChatArt />
            </div>
            <h2>Ask your room</h2>
            <p>
              I can work across everything inside{" "}
              {info.path.split("/").pop()}, using only the context you attach
              or make available.
            </p>
            <div className="prompt-chips">
              {[
                "Summarize what's in this room",
                "What are the key points across my files?",
                "What did I add recently?",
                "Draft a short memo from these files",
              ].map((p) => (
                <button
                  key={p}
                  className="prompt-chip"
                  onClick={() => {
                    s.setQuestion(p);
                    s.composerRef.current?.focus();
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
            {s.commands.length > 0 && (
              <div className="cmd-hints">
                <span className="cmd-hints-label">Or run a command:</span>
                {[...s.commands, HELP_COMMAND].map((c) => (
                  <button
                    key={c.name}
                    className="cmd-hint-chip"
                    title={`${c.summary} — ${c.usage}`}
                    onClick={() => {
                      s.setQuestion(`#${c.name} `);
                      s.composerRef.current?.focus();
                    }}
                  >
                    #{c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {hiddenOlder > 0 && (
          // A COUNT, not a vague "more": the number is the honest thing to say,
          // and it is what tells you whether one press is enough.
          <button
            className="subtle chat-load-older"
            onClick={() => setShownCount((n) => n + CHAT_PAGE)}
            title="These are already loaded — this only draws them"
          >
            Show earlier messages ({hiddenOlder} older)
          </button>
        )}
        {shownMessages.map((m) => {
          // Context handoff: a divider, not a participant turn — render it
          // before any of the ordinary assistant/user branches below (`role`
          // stays `"assistant"` on a marker row, so those checks alone would
          // render it as a normal reply).
          if (m.kind === "handoff") {
            return <HandoffMarker key={m.id} message={m} />;
          }
          // ADD-23: structured effects ride on the message row; the content is
          // plain prose. Legacy rooms (effects: null) still carry fenced
          // ```boxes/```annotation blocks inside the text — split those out.
          // Wave 2 (Idea 4): key off the two VIEWER keys, NOT effects-null — an
          // edit turn now writes an "edits"-only effects object, and a message
          // with no boxes/annotation must still run splitMarkupBlocks so a
          // hallucinated fenced block is stripped rather than shown raw.
          const hasViewerEffect = !!(m.effects && (m.effects.boxes || m.effects.annotation));
          const { text, boxes, annotation } =
            m.role === "assistant"
              ? hasViewerEffect
                ? {
                    text: m.content,
                    boxes: m.effects!.boxes,
                    annotation: m.effects!.annotation,
                  }
                : splitMarkupBlocks(m.content)
              : { text: m.content, boxes: undefined, annotation: undefined };
          const annotVerified = !!annotation?.quote && !annotation?.approx;
          // Is this row one of Arcelle's own "no answer" notices rather than a
          // reply? Only then does the recovery strip below appear.
          const lostReply =
            m.role === "assistant" ? lostReplyNotice(m.content) : null;
          // The hand is a function of LENGTH and KIND, never of who is
          // speaking (see `isHandwritten`) — with one carve-out: Arcelle's own
          // "the reply was lost" notice is a consequence the reader has to act
          // on, and the system reserves the sans for those. It is short enough
          // to pass the hand test, so it is excluded by name rather than by
          // length.
          const hand = lostReply === null && isHandwritten(text);
          // A LONG answer goes to the sans but keeps handwritten headings, per
          // the brief. That only works while the hand has the glyphs — Kalam
          // bundles latin + latin-ext only — so a Hebrew or CJK answer must
          // keep its headings in the sans too. `is-hand` cannot carry this:
          // these are exactly the messages that are NOT handwritten.
          const latin = isLatinScript(text);
          const clock = messageClock(m.createdAt);
          return (
          <div
            key={m.id}
            id={`msg-${m.id}`}
            className={`msg ${m.role}${hand ? " is-hand" : ""}${
              latin ? " is-latin" : ""
            }${m.id === lastAssistantId ? " is-latest" : ""}`}
          >
            <div className="msg-label">
              <span className="msg-avatar" aria-hidden>
                {m.role === "assistant" ? <SparkIcon size={12} /> : "•"}
              </span>
              <span className="msg-who">{speakerName(m.role)}</span>
              {/* The margin time of a notebook log line. Real stored data, in
                  the mono face with the rest of the technical metadata — the
                  page never derives a SHAPE from the clock, so a given
                  conversation still draws identically on every render. */}
              {clock && (
                <time className="msg-when" dateTime={m.createdAt}>
                  {clock}
                </time>
              )}
            </div>
            {/* The turn's own diagram when this session drew one (helpers,
                their steps and their clocks stay readable afterwards); the
                flat strip persisted on the message otherwise — that is all a
                room reopened later still has. */}
            {m.role === "assistant" && graphByMsg[m.id] ? (
              <AgentGraph
                plan={graphByMsg[m.id].plan}
                active={graphByMsg[m.id].active}
                agentSteps={graphByMsg[m.id].agentSteps}
                agentReports={graphByMsg[m.id].agentReports}
                steps={graphByMsg[m.id].steps}
                lane={graphByMsg[m.id].lane}
                timings={graphByMsg[m.id].timings}
                live={false}
              />
            ) : (
              m.role === "assistant" &&
              !!m.effects?.agents?.length && (
                <div
                  className="agent-strip past"
                  aria-label="Agents that handled this request"
                >
                  <span className="agent-strip-caption">
                    {m.effects.agents.length > 1 ? "Agents" : "Agent"}
                  </span>
                  {m.effects.agents.map((p, i) => (
                    <span key={i} className="agent-pipe">
                      {i > 0 && <span className="agent-arrow" aria-hidden>→</span>}
                      <span className="agent-chip past" title={p.instruction}>
                        {p.label}
                      </span>
                    </span>
                  ))}
                </div>
              )
            )}
            <div className="msg-content" dir="auto">
              {m.role === "assistant" ? (
                <>
                  <MarkdownView text={text} />
                  {boxes && (
                    <ChatAnnotatedImage
                      fileId={boxes.fileId}
                      boxes={boxes.boxes}
                    />
                  )}
                  {annotation && (
                    // The one honest margin annotation on an answer: the model
                    // located a passage and said so, so the note beside the
                    // answer is the model's OWN output, tied back to the
                    // paragraph it came from with a drawn arrow. Nothing here
                    // is written by the interface — an annotation Arcelle
                    // invented ("good point", "check this") would be the UI
                    // manufacturing an opinion and attributing it to nobody,
                    // which is why the decorative reading of the brief is not
                    // implemented anywhere in this pane.
                    // The arrow is an aria-hidden, pointer-events:none masked
                    // span from paper.css, and it is a FLEX ITEM rather than an
                    // absolutely positioned mark, so it lands on the correct
                    // side of an RTL answer without a single hard `left`.
                    <div className="annot-chip-wrap msg-annot">
                      <span
                        className="nb-arrow-curve nb-arrow-curve--nw msg-tie"
                        aria-hidden
                      />
                      <button
                        className={`annot-chip${annotVerified ? " receipt-verified" : ""}`}
                        title="Show the highlight in the viewer"
                        onClick={() =>
                          a.viewFile(
                            annotation.fileId,
                            annotationTarget(annotation),
                          )
                        }
                      >
                        {annotVerified ? (
                          <CheckIcon size={13} />
                        ) : (
                          <EyeIcon size={13} />
                        )}{" "}
                        {annotation.note ||
                          annotation.quote ||
                          annotation.range}{" "}
                        — {annotation.name}
                        {annotVerified && (
                          <span className="receipt-badge">
                            <CheckIcon size={11} /> Verified
                          </span>
                        )}
                        {annotation.approx && (
                          <span
                            className="annot-approx"
                            title="The exact quote wasn't found — the closest passage was highlighted"
                          >
                            {" "}
                            · ≈ closest match
                          </span>
                        )}
                      </button>
                      {annotVerified && annotation.quote && (
                        <button
                          className="subtle"
                          title="Copy this quote as a citation (quote · file · page)"
                          onClick={() => a.copyReceipt(annotation)}
                        >
                          Copy as receipt
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : editDraft?.id === m.id ? (
                <div className="composer-card">
                  <textarea
                    className="composer-input"
                    value={editDraft.text}
                    autoFocus
                    rows={3}
                    dir="auto"
                    onChange={(e) =>
                      setEditDraft({ id: m.id, text: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submitEdit();
                      }
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditDraft(null);
                      }
                    }}
                  />
                  <span className="save-form">
                    <button className="subtle" onClick={submitEdit}>
                      Send again
                    </button>
                    <button
                      className="subtle"
                      onClick={() => setEditDraft(null)}
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              ) : hand ? (
                <HandNote text={text} />
              ) : (
                text
              )}
            </div>
            {/* Your own messages were the only rows in the app with no
                actions at all — a sent question could not be copied, let
                alone corrected. */}
            {m.role === "user" && !editDraft && !m.id.startsWith("pending-") && (
              <div className="msg-footer">
                <button
                  className="subtle"
                  title="Copy this message"
                  onClick={() => a.copyMessage(m)}
                >
                  Copy
                </button>
                <button
                  className="subtle"
                  title="Change this question and ask again — everything after it is removed"
                  disabled={s.asking}
                  onClick={() => setEditDraft({ id: m.id, text: m.content })}
                >
                  Edit & resend
                </button>
              </div>
            )}
            {/* A turn that produced no answer used to be a dead end: the
                notice said "Please try again" and left the user to retype the
                question. Regenerate could always do it, but it sits unlabelled
                among Copy/Play/Save and its title reads "Delete this answer
                and ask again", which is not what someone whose reply was lost
                is looking for. Offer the action where the failure is, and say
                first what is actually true of this turn — a write that landed
                or a job still running makes asking again NOT free.
                There is no Resume: a run keeps no durable state to resume
                from (the sidecar releases its registry entry when the stream
                ends, and the host's delta mirror is a local in `stream_run`),
                so only Try again is offered rather than a button that would
                restart the turn while calling itself a resume. */}
            {m.role === "assistant" &&
              m.id === lastAssistantId &&
              lostReply !== null && (
                <div className="msg-recover">
                  <span>{lostReplyAdvice(lostReply)}</span>
                  <button
                    className="subtle"
                    title="Delete this notice and run the same question again"
                    disabled={s.asking}
                    onClick={() => a.regenerate(m.id)}
                  >
                    Try again
                  </button>
                </div>
              )}
            {m.role === "assistant" && (
              <div className="msg-footer">
                {m.sources.length > 0 && (
                  // Citations are load-bearing, so they lead the action group
                  // on their own line instead of sitting among the buttons —
                  // and they are the one thing in this footer that never
                  // fades: an answer's evidence is content, not an action.
                  // The kicker labels a group that had no label at all, and
                  // the drawn arrow ties it back to the answer above it.
                  <span className="msg-sources">
                    <span
                      className="nb-arrow-curve nb-arrow-curve--nw msg-tie"
                      aria-hidden
                    />
                    <span className="msg-sources-kicker">Sources</span>
                    {m.sources.map((src) => (
                      <button
                        key={src}
                        className="source-chip"
                        title={`Open ${src}`}
                        onClick={() => a.openSource(src)}
                      >
                        {src}
                      </button>
                    ))}
                  </span>
                )}
                <button
                  className="subtle btn-ic"
                  title={
                    s.speakingMsgId === m.id
                      ? "Stop speaking"
                      : "Read this answer aloud"
                  }
                  onClick={() => a.speakMessage(m)}
                >
                  {s.speakingMsgId === m.id ? (
                    <><StopIcon size={12} /> Stop</>
                  ) : (
                    <><PlayIcon size={12} /> Play</>
                  )}
                </button>
                <button
                  className="subtle"
                  title="Copy this answer"
                  disabled={s.asking}
                  onClick={() => a.copyMessage(m)}
                >
                  Copy
                </button>
                {s.undoByMsg[m.id] && (
                  <button
                    className="subtle undo-edit"
                    title="Undo the file change this answer made (reversible via version history)"
                    disabled={s.asking}
                    onClick={() => a.undoEdits(m.id)}
                  >
                    <UndoIcon size={13} /> Undo{" "}
                    {s.undoByMsg[m.id].length > 1 ? `${s.undoByMsg[m.id].length} edits` : "edit"}
                  </button>
                )}
                {m.id === lastAssistantId && (
                  <button
                    className="subtle"
                    title="Delete this answer and ask again (the original attachments are not re-sent)"
                    disabled={s.asking}
                    onClick={() => a.regenerate(m.id)}
                  >
                    Regenerate
                  </button>
                )}
                {s.saveDraft?.id === m.id ? (
                  <span className="save-form">
                    <input
                      value={s.saveDraft.name}
                      autoFocus
                      onChange={(e) =>
                        s.setSaveDraft({ id: m.id, name: e.target.value })
                      }
                      onKeyDown={(e) => e.key === "Enter" && a.saveToRoom(m)}
                    />
                    <button className="subtle" onClick={() => a.saveToRoom(m)}>
                      Save
                    </button>
                    <button className="subtle" onClick={() => s.setSaveDraft(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="subtle"
                    // A name no file is using yet: "AI note.md", "AI note 2.md"
                    // … Three answers called the same thing left the source
                    // chip able to open only the newest of them.
                    onClick={() =>
                      s.setSaveDraft({
                        id: m.id,
                        name: uniqueFileName(
                          "AI note.md",
                          s.files.map((f) => f.name),
                        ),
                      })
                    }
                  >
                    Save to room
                  </button>
                )}
              </div>
            )}
          </div>
          );
        })}
        {s.asking && (
          // The live turn is ALWAYS set in the sans, whatever it ends up
          // saying. The voice is a property of a finished message, and
          // re-deciding it as tokens arrive would swap the face — and relayout
          // the whole block — several times per answer. It settles into the
          // hand, if it earns it, when the stored message replaces this row.
          <div
            className={`msg assistant is-streaming ${s.streamText ? "" : "thinking"}`}
          >
            <div className="msg-label">
              <span className="msg-avatar" aria-hidden>
                <SparkIcon size={12} />
              </span>
              <span className="msg-who">{speakerName("assistant")}</span>
            </div>
            {/* The live roster as a hub-and-spoke graph. A turn where nothing
                was delegated has no graph to draw, and AgentGraph falls back to
                the single flat chip this used to be. */}
            {s.agentPlan && s.agentPlan.length > 0 && (
              <AgentGraph
                plan={s.agentPlan}
                active={s.activeAgent}
                agentSteps={s.agentSteps}
                agentReports={s.agentReports}
                steps={s.steps}
                lane={s.lane}
                // The LIVE graph is the only thing that ever measures, so it
                // has to stamp into the store this pane freezes onto the
                // finished answer. Left to its own internal ref, every clock
                // died with the streaming bubble and every archived diagram
                // was handed an empty store — roster, nodes and steps, but
                // never a single duration.
                timings={liveTimings}
              />
            )}
            {(s.lane || s.steps.length > 0) && (
              <div className="step-chips">
                {s.lane && <span className="lane-chip">{s.lane}</span>}
                {s.steps.map((st, i) => (
                  <span
                    key={i}
                    className={`step-chip${st.ok ? "" : " failed"}`}
                    title={st.ok ? undefined : "This step didn't succeed"}
                  >
                    {st.ok ? "" : "⚠ "}
                    {st.label}
                  </span>
                ))}
              </div>
            )}
            <div className="msg-content" dir="auto">
              {s.streamText ? (
                <>
                  <MarkdownView text={patchStreamFences(s.streamText)} />
                  {/* The nib. Decorative and repeating, so it is kept out of
                      assistive technology entirely — a screen reader following
                      a streaming answer must not be handed a block glyph after
                      every delta. */}
                  <span className="stream-cursor" aria-hidden>
                    ▍
                  </span>
                </>
              ) : isCloudRoute(model, s.ai) ? (
                // Where this question is going is a privacy consequence, so it
                // is a taped note in the sans at reading size — never the hand,
                // and never quieter than the local line beside it.
                <span className="chat-route chat-route-cloud">
                  Asking your cloud AI — content leaves this Mac…
                </span>
              ) : (
                <span className="chat-route">Thinking locally…</span>
              )}
            </div>
          </div>
        )}
        {!s.asking && s.askPrivacy && (
          <div className="privacy-receipt" role="status">
            {s.askPrivacy.bypassed ? (
              <span className="privacy-receipt-chip bypassed">
                Real details were shared this once
              </span>
            ) : (
              <span className="privacy-receipt-chip">
                {(s.askPrivacy.entities_hidden ?? 0) > 0
                  ? `${s.askPrivacy.entities_hidden} private detail${
                      (s.askPrivacy.entities_hidden ?? 0) === 1 ? "" : "s"
                    } hidden from the cloud model`
                  : "Shielded — nothing private needed hiding"}
                {(s.askPrivacy.images_blocked ?? 0) > 0 &&
                  ` · ${s.askPrivacy.images_blocked} image${
                    (s.askPrivacy.images_blocked ?? 0) === 1 ? "" : "s"
                  } kept on this Mac`}
              </span>
            )}
            {/* The valve: only offered when something was actually hidden, and
                only through a human click — the agent driver is fenced out. */}
            {!s.askPrivacy.bypassed &&
              (s.askPrivacy.entities_hidden ?? 0) > 0 &&
              (confirmReal ? (
                <span className="privacy-valve-confirm" data-agent-blocked>
                  Send this question again with the real details?
                  <button
                    className="subtle danger"
                    onClick={() => {
                      setConfirmReal(false);
                      void a.askAgainWithRealDetails();
                    }}
                  >
                    Yes, this once
                  </button>
                  <button className="subtle" onClick={() => setConfirmReal(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="subtle privacy-valve"
                  data-agent-blocked
                  title="The hidden details made this answer vague? Re-ask sharing the real values — for this one question only."
                  onClick={() => setConfirmReal(true)}
                >
                  Ask again with real details…
                </button>
              ))}
          </div>
        )}
        {s.memSuggestion && (
          // ADD-25: saving a memory is the user's explicit choice — the agent
          // driver must not be able to click "Save to memory" for them.
          <div className="memory-suggestion" data-agent-blocked>
            <div className="memory-suggestion-head">
              <MemoryIcon size={13} /> Worth remembering?
            </div>
            <div className="memory-suggestion-fact">
              {s.memSuggestion.fact}
            </div>
            <div className="memory-suggestion-actions">
              <button className="primary" onClick={a.saveSuggestedMemory}>
                Save to memory
              </button>
              <button
                className="subtle"
                onClick={() => s.setMemSuggestion(null)}
              >
                Ignore
              </button>
              {/* Wave 1b (idea 5): opt into auto-save. The click is the
                  consent; the agent driver still can't press it (the chip is
                  data-agent-blocked). Off-switch: Settings → Behavior. */}
              <button
                className="subtle"
                title="Save this and every future suggestion automatically (turn off in Settings → Behavior)"
                onClick={a.enableMemoryAutoSave}
              >
                Always save
              </button>
            </div>
          </div>
        )}
      </div>

      <Composer s={s} a={a} />
    </div>
  );
}
