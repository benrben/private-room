import { type ReactNode, useEffect, useRef, useState } from "react";
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
import {
  autoSpeakTitle,
  editTailFor,
  finishedTurnNote,
  handsFreeTitle,
  hasHiddenPrivacy,
  localReachFor,
  privacyConfirmationText,
  privacySummary,
  privacyValveTitle,
  renameDisabled,
  routeNoteFor,
} from "./chatPaneRules";

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

/** `effects.edits` outcome tags that mean bytes actually landed: the edit
 * methods `edit_file` records, plus `edit_files`'s own "applied". The same
 * array also carries declines and failures ("failed", "not_found", "error",
 * …), and counting those would be the room claiming a change it never made. */
const LANDED_EDIT_OUTCOMES = new Set([
  "applied",
  "exact",
  "exact_all",
  "fuzzy",
  "docx",
  "html",
]);

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

function ChatHeader({ s, a }: { s: WSState; a: WSActions }) {
  return <div className="chat-head"><ChatSelector s={s} a={a} /><ChatHeaderActions s={s} a={a} /><ChatHeaderToggles s={s} a={a} />{s.activeChatId && <DeleteControl k={`chat:${s.activeChatId}`} trigger={<TrashIcon size={14} />} onConfirm={() => a.removeChat(s.activeChatId!)} title="Delete this chat session" confirmDelete={s.confirmDelete} askConfirm={a.askConfirm} cancelConfirm={a.cancelConfirm} />}</div>;
}

function ChatSelector({ s, a }: { s: WSState; a: WSActions }) {
  if (s.renaming) return <RenameChat s={s} onCommit={a.commitRename} />;
  return <select className="chat-select" value={s.activeChatId ?? ""} dir="auto" onChange={(event) => s.setActiveChatId(event.target.value)}>{s.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select>;
}

function RenameChat({ s, onCommit }: { s: WSState; onCommit: () => void }) {
  return <input className="chat-select chat-rename" autoFocus dir="auto" value={s.renameDraft} onChange={(event) => s.setRenameDraft(event.target.value)} onBlur={onCommit} onKeyDown={(event) => renameKey(event.key, onCommit, () => s.setRenaming(false))} />;
}

function renameKey(key: string, onCommit: () => void, onCancel: () => void) {
  if (key === "Enter") onCommit();
  if (key === "Escape") onCancel();
}

function ChatHeaderActions({ s, a }: { s: WSState; a: WSActions }) {
  return <><button className="subtle btn-ic" title="Rename this chat" aria-label="Rename this chat" disabled={renameDisabled(s)} onClick={a.startRename}><PencilIcon size={14} /></button><button className="subtle" title="New chat ⌘N" onClick={a.newChat}>＋ New</button><button className="subtle" title="Copy this whole conversation as text" disabled={s.messages.length === 0} onClick={a.copyConversation}>Copy chat</button></>;
}

function ChatHeaderToggles({ s, a }: { s: WSState; a: WSActions }) {
  return <><ToggleChatSpeech active={s.autoSpeak} title={autoSpeakTitle(s.autoSpeak)} label="Read answers aloud" onClick={a.toggleAutoSpeak} icon={<SpeakerIcon size={14} />} /><ToggleChatSpeech active={s.handsFree} title={handsFreeTitle(s.handsFree)} label="Hands-free — re-arm the mic after each answer" onClick={a.toggleHandsFree} icon={<HandsFreeIcon size={14} />} /></>;
}

function ToggleChatSpeech({ active, title, label, onClick, icon }: { active: boolean; title: string; label: string; onClick: () => void; icon: ReactNode }) {
  return <button className={`subtle btn-ic${active ? " accent" : ""}`} title={title} aria-label={label} aria-pressed={active} onClick={onClick}>{icon}</button>;
}

function ChatBanners({ s, a, model, modelReady }: { s: WSState; a: WSActions; model: string; modelReady: boolean }) {
  return <>
    {s.showSyncWarn && <SyncWarning onDismiss={a.dismissSyncWarn} />}
    {isCloudRoute(model, s.ai) && s.privacyOn === false && <PrivacyOffWarning />}
    <AiOnboarding s={s} a={a} model={model} modelReady={modelReady} />
  </>;
}

function SyncWarning({ onDismiss }: { onDismiss: () => void }) {
  return <div className="banner notice"><span className="banner-kicker">Note</span>This room lives in a synced folder. Never open it on two computers at the same time — the file can be damaged. Lock it before switching machines.{" "}<button className="subtle" onClick={onDismiss}>Dismiss</button></div>;
}

function PrivacyOffWarning() {
  return <div className="banner privacy-off-banner" role="alert"><span className="banner-kicker">Heads up</span>Privacy is off — cloud models can see everything in this room, names and all. Turn it back on in Settings → Cloud privacy.</div>;
}

function AiOnboarding({ s, a, model, modelReady }: { s: WSState; a: WSActions; model: string; modelReady: boolean }) {
  if (!s.ai || s.ai.running) return <ModelDownload s={s} a={a} model={model} modelReady={modelReady} />;
  return s.ai.installed ? <AiNotRunning onOpen={a.openOllamaApp} /> : <AiNotInstalled onGet={a.getOllama} onRefresh={a.refreshAi} />;
}

function AiNotInstalled({ onGet, onRefresh }: { onGet: () => void; onRefresh: () => void }) {
  return <div className="banner onboard"><span>This room's AI runs on <strong>Ollama</strong>, a free app.</span><span className="onboard-actions"><button className="subtle" onClick={onGet}>Get Ollama</button><button className="subtle" onClick={onRefresh}>I installed it — check again</button></span></div>;
}

function AiNotRunning({ onOpen }: { onOpen: () => void }) {
  return <div className="banner onboard"><span><strong>Ollama</strong> is installed but not running.</span><span className="onboard-actions"><button className="subtle" onClick={onOpen}>Open Ollama</button></span></div>;
}

function ModelDownload({ s, a, model, modelReady }: { s: WSState; a: WSActions; model: string; modelReady: boolean }) {
  if (!s.ai?.running || modelReady) return null;
  return <div className="banner onboard"><ModelDownloadBody s={s} a={a} model={model} />{s.pullError && <div className="banner-error">{s.pullError}</div>}</div>;
}

function ModelDownloadBody({ s, a, model }: { s: WSState; a: WSActions; model: string }) {
  return s.pullingModel ? <PullProgress s={s} onStop={() => void a.stopModelPull()} model={model} /> : <ModelPicker onPick={a.pickAndDownload} />;
}

function PullProgress({ s, onStop, model }: { s: WSState; onStop: () => void; model: string }) {
  return <span className="banner-pull"><span className="banner-pull-label">Downloading <strong>{model}</strong>…</span><span className="pull-bar"><span className="pull-bar-fill" style={{ width: `${s.pullPercent ?? 0}%` }} /></span><span className="banner-pull-status">{s.pullStatus}{s.pullPercent != null && ` — ${s.pullPercent.toFixed(0)}%`}</span><button className="subtle" onClick={onStop}>Stop</button></span>;
}

function ModelPicker({ onPick }: { onPick: (model: string) => void }) {
  return <div className="model-pick"><div className="model-pick-head"><strong>Pick a model to download</strong><span className="model-pick-sub">It runs entirely on your Mac. You can switch or add more anytime in Settings.</span></div><div className="model-pick-grid">{RECOMMENDED_MODELS.map((m) => <ModelCard key={m.name} model={m} onPick={onPick} />)}</div></div>;
}

function ModelCard({ model, onPick }: { model: (typeof RECOMMENDED_MODELS)[number]; onPick: (model: string) => void }) {
  return <div className="model-pick-card">{model.tag && <span className="model-pick-tag">{model.tag}</span>}<div className="model-pick-name">{model.name}</div><div className="model-pick-meta">{model.label} · {model.size}</div><div className="model-pick-blurb">{model.blurb}</div><button className="subtle btn-ic model-pick-get" onClick={() => onPick(model.name)}><DownloadIcon size={14} /> Download</button></div>;
}

type ChatMessage = WSState["messages"][number];
type EditDraft = { id: string; text: string } | null;
type MessageView = ReturnType<typeof messageView>;

function ChatTranscript({ s, a, info, shownMessages, hiddenOlder, onShowOlder, lastAssistantId, graphByMsg, editDraft, onStartEdit, onChangeEdit, onSubmitEdit, onCancelEdit, editTail, liveTimings, model, localReach, confirmReal, setConfirmReal, turnNote }: {
  s: WSState; a: WSActions; info: RoomInfo; shownMessages: ChatMessage[]; hiddenOlder: number; onShowOlder: () => void; lastAssistantId: string | undefined; graphByMsg: Record<string, PastGraph>; editDraft: EditDraft; onStartEdit: (message: ChatMessage) => void; onChangeEdit: (id: string, text: string) => void; onSubmitEdit: () => void; onCancelEdit: () => void; editTail: number; liveTimings: { current: Record<string, AgentTiming> }; model: string; localReach: string; confirmReal: boolean; setConfirmReal: (value: boolean) => void; turnNote: string;
}) {
  return <div className="messages" ref={s.chatRef}>
    <TranscriptIntro messages={s.messages} s={s} info={info} />
    <EarlierMessageControl count={hiddenOlder} onShow={onShowOlder} />
    <MessageList s={s} a={a} messages={shownMessages} lastAssistantId={lastAssistantId} graphByMsg={graphByMsg} editDraft={editDraft} onStartEdit={onStartEdit} onChangeEdit={onChangeEdit} onSubmitEdit={onSubmitEdit} onCancelEdit={onCancelEdit} editTail={editTail} />
    <TranscriptStatus s={s} a={a} model={model} localReach={localReach} timings={liveTimings} confirmReal={confirmReal} setConfirmReal={setConfirmReal} />
    <p className="agraph-sr" role="status">{turnNote}</p>
  </div>;
}

function TranscriptIntro({ messages, s, info }: { messages: ChatMessage[]; s: WSState; info: RoomInfo }) {
  return messages.length === 0 ? <ChatHero s={s} info={info} /> : null;
}

function EarlierMessageControl({ count, onShow }: { count: number; onShow: () => void }) {
  return count > 0 ? <OlderMessages count={count} onShow={onShow} /> : null;
}

function TranscriptStatus({ s, a, model, localReach, timings, confirmReal, setConfirmReal }: { s: WSState; a: WSActions; model: string; localReach: string; timings: { current: Record<string, AgentTiming> }; confirmReal: boolean; setConfirmReal: (value: boolean) => void }) {
  return <><ActiveTurn asking={s.asking} s={s} model={model} localReach={localReach} timings={timings} /><FinishedPrivacy asking={s.asking} s={s} a={a} confirmReal={confirmReal} setConfirmReal={setConfirmReal} /><MemoryCard suggestion={s.memSuggestion} s={s} a={a} /></>;
}

function ActiveTurn({ asking, s, model, localReach, timings }: { asking: boolean; s: WSState; model: string; localReach: string; timings: { current: Record<string, AgentTiming> } }) {
  return asking ? <StreamingTurn s={s} model={model} localReach={localReach} timings={timings} /> : null;
}

function FinishedPrivacy({ asking, s, a, confirmReal, setConfirmReal }: { asking: boolean; s: WSState; a: WSActions; confirmReal: boolean; setConfirmReal: (value: boolean) => void }) {
  return !asking && s.askPrivacy ? <PrivacyReceipt s={s} a={a} confirmReal={confirmReal} setConfirmReal={setConfirmReal} /> : null;
}

function MemoryCard({ suggestion, s, a }: { suggestion: WSState["memSuggestion"]; s: WSState; a: WSActions }) {
  return suggestion ? <MemorySuggestion s={s} a={a} /> : null;
}

function ChatHero({ s, info }: { s: WSState; info: RoomInfo }) {
  const ask = (text: string) => { s.setQuestion(text); s.composerRef.current?.focus(); };
  return <div className="chat-hero"><div className="chat-hero-icon"><EmptyChatArt /></div><h2>Ask your room</h2><p>I can work across everything inside {info.path.split("/").pop()}, using only the context you attach or make available.</p><div className="prompt-chips">{["Summarize what's in this room", "What are the key points across my files?", "What did I add recently?", "Draft a short memo from these files"].map((prompt) => <button key={prompt} className="prompt-chip" onClick={() => ask(prompt)}>{prompt}</button>)}</div>{s.commands.length > 0 && <CommandHints commands={s.commands} ask={ask} />}</div>;
}

function CommandHints({ commands, ask }: { commands: WSState["commands"]; ask: (text: string) => void }) {
  return <div className="cmd-hints"><span className="cmd-hints-label">Or run a command:</span>{[...commands, HELP_COMMAND].map((command) => <button key={command.name} className="cmd-hint-chip" title={`${command.summary} — ${command.usage}`} onClick={() => ask(`#${command.name} `)}>#{command.name}</button>)}</div>;
}

function OlderMessages({ count, onShow }: { count: number; onShow: () => void }) {
  return <button className="subtle chat-load-older" onClick={onShow} title="These are already loaded — this only draws them">Show earlier messages ({count} older)</button>;
}

function MessageList({ s, a, messages, lastAssistantId, graphByMsg, editDraft, onStartEdit, onChangeEdit, onSubmitEdit, onCancelEdit, editTail }: { s: WSState; a: WSActions; messages: ChatMessage[]; lastAssistantId: string | undefined; graphByMsg: Record<string, PastGraph>; editDraft: EditDraft; onStartEdit: (message: ChatMessage) => void; onChangeEdit: (id: string, text: string) => void; onSubmitEdit: () => void; onCancelEdit: () => void; editTail: number }) {
  return <>{messages.map((message) => message.kind === "handoff" ? <HandoffMarker key={message.id} message={message} /> : <ChatMessageRow key={message.id} s={s} a={a} message={message} lastAssistantId={lastAssistantId} graph={graphByMsg[message.id]} editDraft={editDraft} onStartEdit={onStartEdit} onChangeEdit={onChangeEdit} onSubmitEdit={onSubmitEdit} onCancelEdit={onCancelEdit} editTail={editTail} />)}</>;
}

function ChatMessageRow({ s, a, message, lastAssistantId, graph, editDraft, onStartEdit, onChangeEdit, onSubmitEdit, onCancelEdit, editTail }: { s: WSState; a: WSActions; message: ChatMessage; lastAssistantId: string | undefined; graph: PastGraph | undefined; editDraft: EditDraft; onStartEdit: (message: ChatMessage) => void; onChangeEdit: (id: string, text: string) => void; onSubmitEdit: () => void; onCancelEdit: () => void; editTail: number }) {
  const view = messageView(message);
  return <div id={`msg-${message.id}`} className={messageClass(message, view.hand, lastAssistantId)}><MessageLabel message={message} clock={view.clock} /><MessageGraph message={message} graph={graph} /><MessageContent message={message} view={view} editDraft={editDraft} onChangeEdit={onChangeEdit} onSubmitEdit={onSubmitEdit} onCancelEdit={onCancelEdit} editTail={editTail} a={a} /><MessageActions s={s} a={a} message={message} view={view} lastAssistantId={lastAssistantId} editDraft={editDraft} onStartEdit={onStartEdit} /></div>;
}

function messageView(message: ChatMessage) {
  const content = messageContent(message);
  const lostReply = message.role === "assistant" ? lostReplyNotice(message.content) : null;
  return { ...content, lostReply, hand: lostReply === null && isHandwritten(content.text), clock: messageClock(message.createdAt) };
}

function messageContent(message: ChatMessage) {
  if (message.role !== "assistant") return { text: message.content, boxes: undefined, annotation: undefined };
  if (!hasViewerEffect(message)) return splitMarkupBlocks(message.content);
  return { text: message.content, boxes: message.effects!.boxes, annotation: message.effects!.annotation };
}

function hasViewerEffect(message: ChatMessage): boolean {
  return !!(message.effects && (message.effects.boxes || message.effects.annotation));
}

function messageClass(message: ChatMessage, hand: boolean, lastAssistantId: string | undefined): string {
  return `msg ${message.role}${message.kind === "turn_error" ? " is-turn-error" : ""}${hand ? " is-hand" : ""}${message.id === lastAssistantId ? " is-latest" : ""}`;
}

function MessageLabel({ message, clock }: { message: ChatMessage; clock: string | null }) {
  return <div className="msg-label"><span className="msg-avatar" aria-hidden>{message.role === "assistant" ? <SparkIcon size={12} /> : "•"}</span><span className="msg-who">{speakerName(message.role)}</span>{clock && <time className="msg-when" dateTime={message.createdAt}>{clock}</time>}</div>;
}

function MessageGraph({ message, graph }: { message: ChatMessage; graph: PastGraph | undefined }) {
  if (message.role !== "assistant") return null;
  return graph ? <AgentGraph plan={graph.plan} active={graph.active} agentSteps={graph.agentSteps} agentReports={graph.agentReports} steps={graph.steps} lane={graph.lane} timings={graph.timings} live={false} /> : <SavedAgentStrip agents={message.effects?.agents} />;
}

function SavedAgentStrip({ agents }: { agents: AskPlanStep[] | undefined }) {
  if (!agents || agents.length === 0) return null;
  return <div className="agent-strip past" aria-label="Agents that handled this request"><span className="agent-strip-caption">{agents.length > 1 ? "Agents" : "Agent"}</span>{agents.map((agent, index) => <span key={index} className="agent-pipe">{index > 0 && <span className="agent-arrow" aria-hidden>→</span>}<span className={`agent-chip past${agent.status === "failed" ? " failed" : ""}`} title={agent.instruction}>{agent.status === "failed" && <span role="img" aria-label="failed">⚠</span>}{agent.label}</span></span>)}</div>;
}

function MessageContent({ message, view, editDraft, onChangeEdit, onSubmitEdit, onCancelEdit, editTail, a }: { message: ChatMessage; view: MessageView; editDraft: EditDraft; onChangeEdit: (id: string, text: string) => void; onSubmitEdit: () => void; onCancelEdit: () => void; editTail: number; a: WSActions }) {
  if (message.role === "assistant") return <AssistantContent view={view} a={a} />;
  if (editDraft?.id === message.id) return <UserEditForm draft={editDraft} onChange={(text) => onChangeEdit(message.id, text)} onSubmit={onSubmitEdit} onCancel={onCancelEdit} editTail={editTail} />;
  return <div className="msg-content" dir="auto">{view.hand ? <HandNote text={view.text} /> : view.text}</div>;
}

function AssistantContent({ view, a }: { view: MessageView; a: WSActions }) {
  return <div className="msg-content" dir="auto"><MarkdownView text={view.text} />{view.boxes && <ChatAnnotatedImage fileId={view.boxes.fileId} boxes={view.boxes.boxes} />}{view.annotation && <AnnotationChip annotation={view.annotation} a={a} />}</div>;
}

function AnnotationChip({ annotation, a }: { annotation: NonNullable<MessageView["annotation"]>; a: WSActions }) {
  const verified = !!annotation.quote && !annotation.approx;
  return <div className="annot-chip-wrap msg-annot"><span className="nb-arrow-curve nb-arrow-curve--nw msg-tie" aria-hidden /><AnnotationLink annotation={annotation} verified={verified} onView={() => a.viewFile(annotation.fileId, annotationTarget(annotation))} />{verified && annotation.quote && <button className="subtle" title="Copy this quote as a citation (quote · file · page)" onClick={() => a.copyReceipt(annotation)}>Copy as receipt</button>}</div>;
}

function AnnotationLink({ annotation, verified, onView }: { annotation: NonNullable<MessageView["annotation"]>; verified: boolean; onView: () => void }) {
  return <button className={`annot-chip${verified ? " receipt-verified" : ""}`} title="Show the highlight in the viewer" onClick={onView}><AnnotationIcon verified={verified} /> {annotationLabel(annotation)} — {annotation.name}<AnnotationVerified verified={verified} /><AnnotationApproximate approximate={annotation.approx} /></button>;
}

function AnnotationIcon({ verified }: { verified: boolean }) {
  return verified ? <CheckIcon size={14} /> : <EyeIcon size={14} />;
}

function annotationLabel(annotation: NonNullable<MessageView["annotation"]>): string {
  return annotation.note || annotation.quote || annotation.range || "";
}

function AnnotationVerified({ verified }: { verified: boolean }) {
  return verified ? <span className="receipt-badge"><CheckIcon size={12} /> Verified</span> : null;
}

function AnnotationApproximate({ approximate }: { approximate: boolean | undefined }) {
  return approximate ? <span className="annot-approx" title="The exact quote wasn't found — the closest passage was highlighted"> · ≈ closest match</span> : null;
}

function UserEditForm({ draft, onChange, onSubmit, onCancel, editTail }: { draft: Exclude<EditDraft, null>; onChange: (text: string) => void; onSubmit: () => void; onCancel: () => void; editTail: number }) {
  return <div className="msg-content" dir="auto"><div className="composer-card"><textarea className="composer-input" value={draft.text} autoFocus rows={3} dir="auto" onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }} /><span className="save-form"><button className="subtle" onClick={onSubmit}>{editTail === 0 ? "Send again" : `Send again — deletes the ${editTail} message${editTail === 1 ? "" : "s"} below`}</button><button className="subtle" onClick={onCancel}>Cancel</button></span></div></div>;
}

function MessageActions({ s, a, message, view, lastAssistantId, editDraft, onStartEdit }: { s: WSState; a: WSActions; message: ChatMessage; view: MessageView; lastAssistantId: string | undefined; editDraft: EditDraft; onStartEdit: (message: ChatMessage) => void }) {
  if (message.role === "assistant") return <><LostReplyRecovery s={s} a={a} message={message} lostReply={view.lostReply} lastAssistantId={lastAssistantId} /><AssistantMessageFooter s={s} a={a} message={message} lastAssistantId={lastAssistantId} /></>;
  return !editDraft && !message.id.startsWith("pending-") ? <UserMessageActions s={s} a={a} message={message} onStartEdit={onStartEdit} /> : null;
}

function UserMessageActions({ s, a, message, onStartEdit }: { s: WSState; a: WSActions; message: ChatMessage; onStartEdit: (message: ChatMessage) => void }) {
  return <div className="msg-footer"><button className="subtle" title="Copy this message" onClick={() => a.copyMessage(message)}>Copy</button><button className="subtle" title="Change this question and ask again — everything after it is removed" disabled={s.asking} onClick={() => onStartEdit(message)}>Edit & resend</button></div>;
}

function LostReplyRecovery({ s, a, message, lostReply, lastAssistantId }: { s: WSState; a: WSActions; message: ChatMessage; lostReply: MessageView["lostReply"]; lastAssistantId: string | undefined }) {
  if (message.id !== lastAssistantId || lostReply === null) return null;
  return <div className="msg-recover"><span>{lostReplyAdvice(lostReply)}</span><button className="subtle" title="Delete this notice and run the same question again" disabled={s.asking} onClick={() => a.regenerate(message.id)}>Try again</button></div>;
}

function AssistantMessageFooter({ s, a, message, lastAssistantId }: { s: WSState; a: WSActions; message: ChatMessage; lastAssistantId: string | undefined }) {
  return <div className="msg-footer"><MessageSources sources={message.sources} onOpen={a.openSource} /><LandedEditReport effects={message.effects} /><SpeakControl active={s.speakingMsgId === message.id} onSpeak={() => a.speakMessage(message)} /><button className="subtle" title="Copy this answer" disabled={s.asking} onClick={() => a.copyMessage(message)}>Copy</button><UndoControl edits={s.undoByMsg[message.id]} disabled={s.asking} onUndo={() => a.undoEdits(message.id)} />{message.id === lastAssistantId && <button className="subtle" title="Delete this answer and ask again (the original attachments are not re-sent)" disabled={s.asking} onClick={() => a.regenerate(message.id)}>Regenerate</button>}<AssistantSave s={s} a={a} message={message} /></div>;
}

function MessageSources({ sources, onOpen }: { sources: string[]; onOpen: (source: string) => void }) {
  return sources.length > 0 ? <span className="msg-sources"><span className="nb-arrow-curve nb-arrow-curve--nw msg-tie" aria-hidden /><span className="msg-sources-kicker">Sources</span>{sources.map((source) => <button key={source} className="source-chip" title={`Open ${source}`} onClick={() => onOpen(source)}>{source}</button>)}</span> : null;
}

function LandedEditReport({ effects }: { effects: ChatMessage["effects"] }) {
  const landed = (effects?.edits ?? []).filter((edit) => LANDED_EDIT_OUTCOMES.has(edit.outcome));
  if (landed.length === 0) return null;
  const files = landed.reduce((count, edit) => count + (edit.files ?? 1), 0);
  return <span className="msg-edits" title="Each change is in that file's History and can be undone there.">Made {files} file change{files === 1 ? "" : "s"} in this room</span>;
}

function SpeakControl({ active, onSpeak }: { active: boolean; onSpeak: () => void }) {
  return <button className="subtle btn-ic" title={active ? "Stop speaking" : "Read this answer aloud"} onClick={onSpeak}>{active ? <><StopIcon size={12} /> Stop</> : <><PlayIcon size={12} /> Play</>}</button>;
}

function UndoControl({ edits, disabled, onUndo }: { edits: unknown[] | undefined; disabled: boolean; onUndo: () => void }) {
  return edits ? <button className="subtle undo-edit" title="Undo the file change this answer made (reversible via version history)" disabled={disabled} onClick={onUndo}><UndoIcon size={14} /> Undo {edits.length > 1 ? `${edits.length} edits` : "edit"}</button> : null;
}

function AssistantSave({ s, a, message }: { s: WSState; a: WSActions; message: ChatMessage }) {
  if (s.saveDraft?.id === message.id) return <span className="save-form"><input value={s.saveDraft.name} autoFocus onChange={(event) => s.setSaveDraft({ id: message.id, name: event.target.value })} onKeyDown={(event) => event.key === "Enter" && a.saveToRoom(message)} /><button className="subtle" onClick={() => a.saveToRoom(message)}>Save</button><button className="subtle" onClick={() => s.setSaveDraft(null)}>Cancel</button></span>;
  return <button className="subtle" onClick={() => s.setSaveDraft({ id: message.id, name: uniqueFileName("AI note.md", s.files.map((file) => file.name)) })}>Save to room</button>;
}

function StreamingTurn({ s, model, localReach, timings }: { s: WSState; model: string; localReach: string; timings: { current: Record<string, AgentTiming> } }) {
  return <div className={`msg assistant is-streaming ${s.streamText ? "" : "thinking"}`} aria-busy><div className="msg-label"><span className="msg-avatar" aria-hidden><SparkIcon size={12} /></span><span className="msg-who">{speakerName("assistant")}</span></div>{s.agentPlan && s.agentPlan.length > 0 && <AgentGraph plan={s.agentPlan} active={s.activeAgent} agentSteps={s.agentSteps} agentReports={s.agentReports} steps={s.steps} lane={s.lane} timings={timings} />}<StreamingSteps steps={s.steps} lane={s.lane} /><div className="msg-content" dir="auto"><StreamingBody text={s.streamText} model={model} ai={s.ai} localReach={localReach} /></div></div>;
}

function StreamingSteps({ steps, lane }: { steps: WSState["steps"]; lane: string }) {
  const shown = steps.slice(-6);
  const earlier = steps.length - shown.length;
  if (!lane && shown.length === 0) return null;
  return <div className="step-chips">{lane && <span className="lane-chip">{lane}</span>}{earlier > 0 && <span className="step-chip" title="Earlier steps in this turn">+{earlier} earlier</span>}{shown.map((step, index) => <span key={earlier + index} className={`step-chip${step.ok ? "" : " failed"}`} title={step.ok ? undefined : "This step didn't succeed"}>{step.ok ? "" : "⚠ "}{step.label}</span>)}</div>;
}

function StreamingBody({ text, model, ai, localReach }: { text: string; model: string; ai: WSState["ai"]; localReach: string }) {
  if (text) return <><MarkdownView text={patchStreamFences(text)} /><span className="stream-cursor" aria-hidden>▍</span></>;
  return <StreamingRoute cloud={isCloudRoute(model, ai)} localReach={localReach} />;
}

function StreamingRoute({ cloud, localReach }: { cloud: boolean; localReach: string }) {
  if (cloud) return <span className="chat-route chat-route-cloud">Asking your cloud AI — content leaves this Mac…</span>;
  return localReach ? <span className="chat-route chat-route-cloud">Thinking on this Mac — {localReach} can send parts of this out…</span> : <span className="chat-route">Thinking locally…</span>;
}

function PrivacyReceipt({ s, a, confirmReal, setConfirmReal }: { s: WSState; a: WSActions; confirmReal: boolean; setConfirmReal: (value: boolean) => void }) {
  const privacy = s.askPrivacy;
  if (!privacy) return null;
  return <div className="privacy-receipt" role="status"><PrivacyReceiptText privacy={privacy} />{!privacy.bypassed && <PrivacyValve privacy={privacy} confirm={confirmReal} onConfirm={() => { setConfirmReal(false); void a.askAgainWithRealDetails(); }} onOpen={() => setConfirmReal(true)} onCancel={() => setConfirmReal(false)} />}</div>;
}

function PrivacyReceiptText({ privacy }: { privacy: NonNullable<WSState["askPrivacy"]> }) {
  if (privacy.bypassed) return <span className="privacy-receipt-chip bypassed">Real details were shared this once</span>;
  return <span className="privacy-receipt-chip">{privacySummary(privacy)}{privacy.images_blocked && ` · ${privacy.images_blocked} image${privacy.images_blocked === 1 ? "" : "s"} kept on this Mac`}</span>;
}

function PrivacyValve({ privacy, confirm, onConfirm, onOpen, onCancel }: { privacy: NonNullable<WSState["askPrivacy"]>; confirm: boolean; onConfirm: () => void; onOpen: () => void; onCancel: () => void }) {
  if (!hasHiddenPrivacy(privacy)) return null;
  return confirm ? <PrivacyConfirmation privacy={privacy} onConfirm={onConfirm} onCancel={onCancel} /> : <button className="subtle privacy-valve" data-agent-blocked title={privacyValveTitle(privacy)} onClick={onOpen}>{privacy.images_blocked ? "Ask again sharing blocked images…" : "Ask again with real details…"}</button>;
}

function PrivacyConfirmation({ privacy, onConfirm, onCancel }: { privacy: NonNullable<WSState["askPrivacy"]>; onConfirm: () => void; onCancel: () => void }) {
  return <span className="privacy-valve-confirm" data-agent-blocked>{privacyConfirmationText(privacy)}<button className="subtle danger" onClick={onConfirm}>Yes, this once</button><button className="subtle" onClick={onCancel}>Cancel</button></span>;
}

function MemorySuggestion({ s, a }: { s: WSState; a: WSActions }) {
  return <div className="memory-suggestion" data-agent-blocked><div className="memory-suggestion-head"><MemoryIcon size={14} /> Worth remembering?</div><div className="memory-suggestion-fact">{s.memSuggestion?.fact}</div><div className="memory-suggestion-actions"><button type="button" className="primary" onClick={a.saveSuggestedMemory}>Save to memory</button><button type="button" className="subtle" onClick={() => s.setMemSuggestion(null)}>Ignore</button><button type="button" className="subtle" title="Save this and every future suggestion automatically (turn off in Settings → Behavior)" onClick={a.enableMemoryAutoSave}>Always save</button></div></div>;
}

type LastGraph = { chatId: string | null; graph: Omit<PastGraph, "timings"> } | null;
type GraphRef = { current: LastGraph };

function useChatPaging(s: WSState, lastGraph: GraphRef) {
  const [shownCount, setShownCount] = useState(CHAT_PAGE);
  const shownChat = useRef(s.activeChatId);
  useEffect(() => {
    if (shownChat.current === s.activeChatId) return;
    shownChat.current = s.activeChatId;
    s.setMemSuggestion(null);
    lastGraph.current = null;
    setShownCount(CHAT_PAGE);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.activeChatId]);
  const revealSeen = useRef<unknown>(null);
  useEffect(() => revealPagedMessage(s, revealSeen, setShownCount), [s.revealMsgId, s.messages]);
  return { ...chatPageSlice(s.messages, shownCount), setShownCount };
}

function revealPagedMessage(s: WSState, revealSeen: { current: unknown }, setShownCount: (next: (count: number) => number) => void) {
  const id = s.revealMsgId;
  if (!id) { revealSeen.current = null; return; }
  if (revealSeen.current === null) revealSeen.current = s.messages;
  const index = s.messages.findIndex((message) => message.id === id);
  if (index >= 0) { setShownCount((count) => Math.max(count, chatPageToReveal(s.messages.length, index))); s.setRevealMsgId(null); return; }
  if (s.messages !== revealSeen.current) s.setRevealMsgId(null);
}

function useGraphHistory(s: WSState, lastAssistantId: string | undefined) {
  const liveTimings = useRef<Record<string, AgentTiming>>({});
  const lastGraph = useRef<LastGraph>(null);
  const wasAsking = useRef(false);
  const askingChat = useRef<string | null>(null);
  const [graphByMsg, setGraphByMsg] = useState<Record<string, PastGraph>>({});
  useEffect(() => rememberDelegatedGraph(s, lastGraph), [s.agentPlan, s.activeAgent, s.agentSteps, s.agentReports, s.steps, s.lane]);
  useEffect(() => updateGraphHistory(s, lastAssistantId, graphByMsg, liveTimings, lastGraph, wasAsking, askingChat, setGraphByMsg), [s.asking, s.activeChatId, lastAssistantId, graphByMsg]);
  return { liveTimings, lastGraph, graphByMsg };
}

function rememberDelegatedGraph(s: WSState, lastGraph: GraphRef) {
  if (!s.agentPlan || s.agentPlan.length <= 1) return;
  lastGraph.current = { chatId: s.activeChatId, graph: { plan: s.agentPlan, active: s.activeAgent, agentSteps: s.agentSteps, agentReports: s.agentReports, steps: s.steps, lane: s.lane } };
}

function updateGraphHistory(s: WSState, lastAssistantId: string | undefined, graphByMsg: Record<string, PastGraph>, liveTimings: { current: Record<string, AgentTiming> }, lastGraph: GraphRef, wasAsking: { current: boolean }, askingChat: { current: string | null }, setGraphByMsg: (update: (current: Record<string, PastGraph>) => Record<string, PastGraph>) => void) {
  const { was, sameChat } = previousAskingState(s, wasAsking, askingChat);
  if (s.asking) { if (!was) liveTimings.current = {}; return; }
  if (!sameChat) return;
  const graph = takeCurrentGraph(lastGraph, s.activeChatId);
  if (!canStoreGraph(was, graph, lastAssistantId, graphByMsg)) return;
  storeGraph(lastAssistantId!, graph!, liveTimings, setGraphByMsg);
}

function previousAskingState(s: WSState, wasAsking: { current: boolean }, askingChat: { current: string | null }): { was: boolean; sameChat: boolean } {
  const sameChat = askingChat.current === s.activeChatId;
  const was = sameChat && wasAsking.current;
  wasAsking.current = s.asking;
  askingChat.current = s.activeChatId;
  return { was, sameChat };
}

function takeCurrentGraph(lastGraph: GraphRef, chatId: string | null): Omit<PastGraph, "timings"> | null {
  const kept = lastGraph.current;
  const graph = kept?.chatId === chatId ? kept.graph : null;
  if (graph) lastGraph.current = null;
  return graph;
}

function canStoreGraph(was: boolean, graph: Omit<PastGraph, "timings"> | null, lastAssistantId: string | undefined, graphByMsg: Record<string, PastGraph>): boolean {
  return was && graph !== null && lastAssistantId !== undefined && !graphByMsg[lastAssistantId];
}

function storeGraph(id: string, graph: Omit<PastGraph, "timings">, liveTimings: { current: Record<string, AgentTiming> }, setGraphByMsg: (update: (current: Record<string, PastGraph>) => Record<string, PastGraph>) => void) {
  const frozen = freezeTimings(liveTimings.current);
  liveTimings.current = {};
  setGraphByMsg((current) => ({ ...current, [id]: { ...graph, timings: { current: frozen } } }));
}

function freezeTimings(timings: Record<string, AgentTiming>): Record<string, AgentTiming> {
  const now = performance.now();
  return Object.fromEntries(Object.entries(timings).map(([key, timing]) => [key, { start: timing.start, end: timing.end ?? now }]));
}

function useTurnAnnouncement(s: WSState, model: string, lastAssistant: ChatMessage | undefined, lastAssistantId: string | undefined) {
  const [turnNote, setTurnNote] = useState("");
  const turnRunning = useRef(false);
  const turnChat = useRef<string | null>(null);
  const turnStartId = useRef<string | undefined>(undefined);
  const localReach = localReachFor(s);
  const routeNote = routeNoteFor(model, s.ai, localReach);
  useEffect(() => updateTurnAnnouncement(s, lastAssistant, lastAssistantId, routeNote, turnRunning, turnChat, turnStartId, setTurnNote), [s.asking, s.activeChatId, lastAssistantId, routeNote]);
  return { turnNote, localReach };
}

function updateTurnAnnouncement(s: WSState, lastAssistant: ChatMessage | undefined, lastAssistantId: string | undefined, routeNote: string, turnRunning: { current: boolean }, turnChat: { current: string | null }, turnStartId: { current: string | undefined }, setTurnNote: (note: string) => void) {
  if (s.asking) { startTurnAnnouncement(s.activeChatId, lastAssistantId, routeNote, turnRunning, turnChat, turnStartId, setTurnNote); return; }
  finishTurnAnnouncement(s.activeChatId, lastAssistant, lastAssistantId, turnRunning, turnChat, turnStartId, setTurnNote);
}

function startTurnAnnouncement(chatId: string | null, lastAssistantId: string | undefined, routeNote: string, turnRunning: { current: boolean }, turnChat: { current: string | null }, turnStartId: { current: string | undefined }, setTurnNote: (note: string) => void) {
  if (turnRunning.current && turnChat.current === chatId) return;
  turnRunning.current = true;
  turnChat.current = chatId;
  turnStartId.current = lastAssistantId;
  setTurnNote(routeNote);
}

function finishTurnAnnouncement(chatId: string | null, lastAssistant: ChatMessage | undefined, lastAssistantId: string | undefined, turnRunning: { current: boolean }, turnChat: { current: string | null }, turnStartId: { current: string | undefined }, setTurnNote: (note: string) => void) {
  if (!turnRunning.current) return;
  turnRunning.current = false;
  if (turnChat.current !== chatId) { setTurnNote(""); return; }
  setTurnNote(finishedTurnNote(lastAssistant, lastAssistantId, turnStartId.current));
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
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const lastAssistantId = lastAssistant?.id;

  const { liveTimings, lastGraph, graphByMsg } = useGraphHistory(s, lastAssistantId);
  const { hidden: hiddenOlder, visible: shownMessages, setShownCount } = useChatPaging(s, lastGraph);
  const { turnNote, localReach } = useTurnAnnouncement(s, model, lastAssistant, lastAssistantId);
  const submitEdit = () => {
    if (editDraft === null) return;
    setEditDraft(null);
    void a.editAndResend(editDraft.id, editDraft.text);
  };
  const editTail = editTailFor(messages, editDraft);

  return (
    <div className="chat" aria-label="Chat">
      <ChatHeader s={s} a={a} />

      <ChatBanners s={s} a={a} model={model} modelReady={modelReady} />
      <ChatTranscript
        s={s}
        a={a}
        info={info}
        shownMessages={shownMessages}
        hiddenOlder={hiddenOlder}
        onShowOlder={() => setShownCount((count) => count + CHAT_PAGE)}
        lastAssistantId={lastAssistantId}
        graphByMsg={graphByMsg}
        editDraft={editDraft}
        onStartEdit={(message) => setEditDraft({ id: message.id, text: message.content })}
        onChangeEdit={(id, text) => setEditDraft({ id, text })}
        onSubmitEdit={submitEdit}
        onCancelEdit={() => setEditDraft(null)}
        editTail={editTail}
        liveTimings={liveTimings}
        model={model}
        localReach={localReach}
        confirmReal={confirmReal}
        setConfirmReal={setConfirmReal}
        turnNote={turnNote}
      />

      <Composer s={s} a={a} />
    </div>
  );
}
