import { useEffect, useLayoutEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { api, AskTurn, RoomInfo } from "../api";
import { configureMic, stopMicTap } from "./liveRec";
import { handleAgentUiRequest } from "../agent/driver";
import { annotationTarget } from "./markup";
import { MEMORY_INTRO_SEEN } from "./constants";
import * as voice from "./voice";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { ownerOf as ownsEvent } from "./runIdentity";
import { applyRecState } from "./recSession";

/** All of Workspace's effects: the mount-time backend-event wiring (which
 * dispatches agent-open-file → viewFile, agent-annotate → the open viewer, MCP
 * approvals, sync warning), plus the smaller orchestration effects. Kept in one
 * place because they call across the hooks. Dependency arrays are unchanged. */
export function useWorkspaceEffects(
  s: WSState,
  a: WSActions,
  info: RoomInfo,
  onLock: () => void | Promise<void>,
) {
  // The mount-once wiring below closes over the FIRST render's `a`/`s` —
  // fine for handlers built on refs and stable setters, wrong for anything
  // that must read current state (the hands-free auto-send needs the live
  // activeChatId, which is still null on the first render). Callbacks that
  // fire long after mount go through this ref to reach the latest actions.
  const aRef = useRef(a);
  aRef.current = a;
  // TWO halves, deliberately guarded differently. The one-shot LOADS run once
  // per room (creating the first conversation twice would leave two empty
  // chats); the SUBSCRIPTIONS are re-made on every mount and torn down by this
  // effect's own cleanup. They used to share one mount-once guard, which made
  // the app deaf in dev: StrictMode mounts, unmounts (cleanup unlistened
  // everything) and mounts again, and the second mount re-subscribed to
  // nothing — no streaming answers, no refreshes, no approvals.
  useEffect(() => {
    // A failed read used to be silent, so a room that could not be read looked
    // exactly like a room that had lost everything — say so instead, and name
    // what is missing.
    const readFailed = (what: string) => (e: unknown) =>
      s.pushToast("error", `Could not read this room's ${what}: ${String(e)}`);
    if (!s.seededRef.current) {
      s.seededRef.current = true;
      getCurrentWindow()
        .setTitle(`${info.name} — Arcelle`)
        .catch(() => {});
      // The reads that FILL the room.
      api.listFiles().then(s.setFiles).catch(readFailed("files"));
      api.listFolders().then(s.setFolders).catch(readFailed("folders"));
      // Trash: read at open like every other room list, so the Library tab
      // can show a real count from the first paint instead of a hopeful 0.
      api.listTrashedFiles().then(s.setTrashed).catch(readFailed("trash"));
      api.listMemories().then(s.setMemories).catch(readFailed("memories"));
      // Wave 1b (idea 5): seed the auto-save ref; re-read when Settings closes
      // (a.refreshMemAutoSave) so the off-switch applies without a room reopen.
      api
        .getSetting("memory_auto_save")
        .then((v) => {
          s.memAutoSaveRef.current = v === "1";
        })
        .catch(() => {});
      api.listChatCommands().then(s.setCommands).catch(() => {});
      // The composer's "*" menu. Seeded here so the menu is instant the first
      // time it opens; `refreshAutocomplete` re-reads it on every open, because
      // the roster follows the room's engine and its web switch.
      void a.refreshSpecialists();
      void a.loadAiActions();
      // Wave 4a: load the room's workflows once — one source of truth for the
      // page, the top-bar pins, and the file-header Actions menu.
      void a.refreshWorkflows();
      // Wave 5 (Idea 13): load the room's scripts once — one source of truth
      // for the Scripts page, the file-header Run button, and the shortcut
      // bars.
      void a.refreshScripts();
      void a.refreshSkills();
      a.refreshAi();
      a.loadFrontPage(true);
      api.warmModel().catch(() => {});
      api
        .listChats()
        .then(async (cs) => {
          if (cs.length === 0) {
            const c = await api.createChat();
            s.setChats([c]);
            s.setActiveChatId(c.id);
          } else {
            s.setChats(cs);
            s.setActiveChatId(cs[0].id);
          }
        })
        .catch(readFailed("conversations"));
    }
    // ---- the live overlay of a turn in progress -------------------------
    //
    // Owner replacement #4 (2026-08-03). Every event below now names the run
    // and chat that produced it (`crate::turn`), and `ownerOf` turns that into
    // the conversation whose slot it may write. `applyToRun` then drops
    // anything the named chat is not actually running — a straggler from a
    // finished turn, or an event for a run this chat never started.
    //
    // What that replaces: these listeners used to write module-wide state, so
    // "which chat is this for" was answered by "whichever one is mounted".
    // Start an answer, open another conversation, and the first chat's text,
    // step chips and agent roster painted into the second one.
    //
    // An event with NO ids belongs to no conversation (the AI-actions menu).
    // It is offered to the chat on screen, which takes it only while it is
    // itself running something — the one case where "the chat in front of you"
    // is the honest owner.
    const ownerOf = (turn: AskTurn) =>
      ownsEvent(turn, s.activeChatIdRef.current);
    const unlisten = api.onAskDelta((delta, turn) => {
      const chat = ownerOf(turn);
      if (!chat) return;
      s.applyToRun(chat, turn.runId, (t) => ({ ...t, text: t.text + delta }));
      // Idea 3: feed the spoken voice (no-ops when auto-speak is off). Gated on
      // the conversation that OWNS the pipeline, not the one on screen: there
      // is a single voice turn, and `feedStreamDelta` accumulates a sentence
      // buffer, so skipping the deltas that arrive while the user is looking
      // elsewhere would read the answer aloud with words silently missing.
      if (voice.turnBelongsTo(chat)) voice.feedStreamDelta(delta);
    });
    const unlistenStep = api.onAskStep(({ label, node }, turn) => {
      const chat = ownerOf(turn);
      if (!chat) return;
      s.applyToRun(chat, turn.runId, (t) => ({
        ...t,
        steps: [...t.steps, { label, ok: true }],
        // Also file it under the agent that ran it, for the graph's inspector.
        // Steps with no node (every non-sidecar emitter) stay flat-list only.
        agentSteps: node
          ? {
              ...t.agentSteps,
              [node]: [...(t.agentSteps[node] ?? []), { label, ok: true }],
            }
          : t.agentSteps,
      }));
    });
    const unlistenLane = api.onAskLane((label, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.applyToRun(chat, turn.runId, (t) => ({ ...t, lane: label }));
    });
    // Dispatch-first agent visibility: the roster arrives once per ask; the
    // active-agent marker advances as plan steps start.
    const unlistenPlan = api.onAskPlan((plan, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.applyToRun(chat, turn.runId, (t) => ({ ...t, plan }));
    });
    const unlistenAgent = api.onAskAgent((agent, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.applyToRun(chat, turn.runId, (t) => ({ ...t, agent }));
    });
    const unlistenStepStatus = api.onAskStepStatus(({ ok, node }, turn) => {
      const chat = ownerOf(turn);
      if (ok || !chat) return;
      s.applyToRun(chat, turn.runId, (t) => {
        const mine = node ? t.agentSteps[node] : undefined;
        return {
          ...t,
          steps: t.steps.length
            ? [...t.steps.slice(0, -1), { ...t.steps[t.steps.length - 1], ok: false }]
            : t.steps,
          // Fail THIS node's last step, not the globally-last one: with siblings
          // running concurrently the two are frequently different steps.
          agentSteps:
            node && mine?.length
              ? {
                  ...t.agentSteps,
                  [node]: [
                    ...mine.slice(0, -1),
                    { ...mine[mine.length - 1], ok: false },
                  ],
                }
              : t.agentSteps,
        };
      });
    });
    // What a specialist handed back. Filed under its node so the diagram can
    // show the report itself, not just a green tick — and, when the child
    // failed, the reason, which appears nowhere else in the UI.
    const unlistenReport = api.onAskReport(({ node, text, ok }, turn) => {
      const chat = ownerOf(turn);
      if (!node || !chat) return;
      s.applyToRun(chat, turn.runId, (t) => ({
        ...t,
        agentReports: { ...t.agentReports, [node]: { text, ok } },
      }));
    });
    const unlistenRound = api.onAskRound((turn) => {
      const chat = ownerOf(turn);
      if (!chat) return;
      s.applyToRun(chat, turn.runId, (t) => ({ ...t, text: "" }));
      // Idea 3: a new round discards the previous round's text — drop its
      // queued/in-flight audio the same way (spoken deliberation must not
      // outlive the text the user no longer sees).
      // Same owner rule as the deltas: dropping a round boundary for a chat the
      // user has stepped away from would leave the previous round's audio
      // playing over text that has already been replaced.
      if (voice.turnBelongsTo(chat)) voice.roundBoundary();
    });
    // PRIV-1: the door's per-turn receipt ("N details hidden" / bypassed). Filed
    // against the chat whose turn it describes and shown after that turn ends,
    // so it lives beside the token bar rather than inside the run record.
    const unlistenPrivacy = api.onAskPrivacy((p, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.setAskPrivacy(chat, p);
    });
    // Token-budget bar: one live snapshot per completed model round, for the
    // conversation that round belongs to. A chat that has run nothing keeps no
    // entry at all, which is why a new one now reads zero.
    const unlistenTokenUsage = api.onAskTokenUsage((p, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.setChatUsage(chat, p);
    });
    // ADD-31: live import queue. The receipt toast comes from reportImport
    // (which knows names and errors) — this event only drives the strip.
    const unlistenImport = api.onImportProgress((p) => {
      s.setImportProgress(p.done >= p.total ? null : p);
    });
    // ADD-30: background-job cards — live counts, and on any terminal flag
    // re-read the job list so the card flips to Resume / disappears.
    // Job ids we've already pulled into `s.jobs`. A running tick for an id NOT in
    // here belongs to a job started outside the UI (e.g. the agent's whole-file
    // pass tool) with no frontend action to seed the list — refresh once so its
    // card appears instead of the progress landing nowhere.
    const seenJobs = new Set<string>();
    void a.refreshJobs();
    const unlistenJobs = api.onJobProgress((p) => {
      if (p.finished || p.paused || p.failed) {
        s.setJobProgress((m) => {
          const next = { ...m };
          delete next[p.jobId];
          return next;
        });
        // AUDIT 262: the Studio step line belongs to a RUN. It must not outlive
        // one, or a finished deck leaves "a local model can take a few
        // minutes…" sitting under an idle sidebar.
        s.setStudioStep("");
        void a.refreshJobs();
        if (p.finished) {
          // The label names what finished ("Summary ready", "Full pass of …").
          s.pushToast("success", p.label || "Background job finished.");
          if (p.fileId) void a.viewFile(p.fileId);
        } else if (p.paused) {
          s.pushToast("info", "Paused — resume it any time from the sidebar.");
        }
      } else {
        if (!seenJobs.has(p.jobId)) {
          seenJobs.add(p.jobId);
          void a.refreshJobs();
        }
        s.setJobProgress((m) => ({
          ...m,
          [p.jobId]: { label: p.label, done: p.done, total: p.total },
        }));
      }
    });
    // AUDIT 262: the Studio's own progress. The backend named every step from
    // the start and nothing listened — a run that takes minutes on a local
    // model read "Starting…" the whole way, and the step that says the content
    // is leaving this Mac was never shown at all.
    const unlistenStudioStep = api.onStudioStep((text) => s.setStudioStep(text));
    // Wave 4a: per-node run status feeds the pipeline animation; a save/update/
    // delete refreshes the library (esp. an agent-authored draft appearing).
    const unlistenWfNode = api.onWorkflowNode((e) => {
      s.setWfNodeStatus((m) => ({
        ...m,
        [e.jobId]: { ...(m[e.jobId] ?? {}), [e.nodeId]: e },
      }));
    });
    const unlistenWfChanged = api.onWorkflowsChanged(() => {
      void a.refreshWorkflows();
      // Wave 5: a script's run finished → its last-run/status changed.
      void a.refreshScripts();
    });
    // Wave 5 (Idea 13): queue a script-run consent card (data-agent-blocked).
    const unlistenScriptApprove = api.onScriptApproveRequest((req) => {
      s.setScriptApprovals((q) => [...q, req]);
    });
    const unlistenSkillsChanged = api.onSkillsChanged(() => {
      void a.refreshSkills();
    });
    const unlistenPull = listen<{ status: string; percent: number | null }>(
      "pull-progress",
      (e) => {
        s.setPullStatus(e.payload.status);
        s.setPullPercent(e.payload.percent);
      },
    );
    const unlistenDrop = getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (s.internalDragRef.current) return;
      if (p.type === "enter" || p.type === "over") {
        s.setDragOver(true);
      } else if (p.type === "leave") {
        s.setDragOver(false);
      } else if (p.type === "drop") {
        s.setDragOver(false);
        if (p.paths && p.paths.length > 0) {
          if (p.paths.length > 1) {
            s.setImportProgress({ done: 0, total: p.paths.length, name: "Starting…" });
          }
          try {
            const report = await api.importFiles(p.paths);
            s.setFiles(await api.listFiles());
            a.reportImport(report);
          } catch (e) {
            s.pushToast("error", String(e));
          } finally {
            s.setImportProgress(null);
          }
        }
      }
    });
    // BROWSE-1: the agent can open a page from any area. The native webview is
    // positioned over the window rather than inside a pane, so the area has to
    // follow it or the page lands on top of whatever the user was looking at.
    const unlistenBrowserNav = api.onBrowserNavigated(() => {
      a.revealBrowser();
    });
    // BROWSE-2 (D9): a browser download finished importing into the room —
    // or truthfully failed. The file list refreshes via room-files-changed.
    const unlistenBrowserDownload = api.onBrowserDownload((p) => {
      if (p.ok) {
        s.pushToast("success", `${p.name} arrived in the room.`);
      } else {
        s.pushToast("error", `Download of ${p.name} failed: ${p.error ?? "unknown error"}`);
      }
    });
    // AUDIT 169: the same download, still running, already past the size a room
    // file may be. Told now rather than after the whole file has landed.
    const unlistenBrowserOversize = api.onBrowserDownloadOversize((p) => {
      s.pushToast("error", p.detail);
    });
    const unlistenMcpApprove = api.onMcpApproveRequest((req) => {
      s.setMcpApprovals((q) => [...q, req]);
    });
    // Wave 2 (Idea 6): queue a diff-preview approval card.
    const unlistenEditApprove = api.onEditApproveRequest((req) => {
      s.setEditApprovals((q) => [...q, req]);
    });
    // ADD-25: the agent↔UI bridge — the backend's ui_snapshot / ui_act /
    // view_screenshot / media_frame tools land here; the driver performs them
    // against the live DOM (enforcing the data-agent-blocked consent denylist)
    // and every outcome, including a thrown surprise, is answered so the
    // backend's oneshot never waits out its timeout.
    const unlistenAgentUi = api.onAgentUiRequest(async (req) => {
      // BROWSE-1: the outbound-typing door needs a HUMAN answer, so it never
      // reaches the DOM driver. It is queued as a consent card and resolved by
      // `resolveBrowseConsent` — the same oneshot the driver would have
      // answered, so the backend's tool call waits exactly as it does for any
      // other agent-UI request.
      if (req.kind === "browse_consent") {
        s.setBrowseConsents((q) => [
          ...q,
          {
            id: req.id,
            url: String(req.args.url ?? ""),
            field: String(req.args.field ?? "a field"),
            text: String(req.args.text ?? ""),
            entities: Array.isArray(req.args.entities)
              ? (req.args.entities as string[])
              : [],
          },
        ]);
        return;
      }
      const payload = await handleAgentUiRequest(req).catch((e) => ({
        error: String(e),
      }));
      api.resolveAgentUi(req.id, payload).catch(() => {});
    });
    a.refreshWebAccess();
    a.refreshAutolock();
    a.refreshPrivacy();
    // GH #4: microphone clean-up is on unless the user opted out. Cached in
    // liveRec because acquireMic can't await IPC without losing the gesture.
    void api
      .getSetting("mic_voice_processing")
      .then((v) => configureMic(v !== "0"))
      .catch(() => {});
    // Idea 3: the spoken voice's per-room config + the hands-free re-arm.
    void Promise.all([
      api.getSetting("voice_archetype"),
      api.getSetting("voice_params"),
      api.getSetting("voice_autospeak"),
      api.getSetting("voice_handsfree"),
      api.getSetting("voice_neural_id"),
    ]).then(([arch, params, auto, hands, neuralId]) => {
      let parsed: voice.VoiceParams | null = null;
      try {
        parsed = params ? (JSON.parse(params) as voice.VoiceParams) : null;
      } catch {
        /* malformed save — fall back to the archetype's defaults */
      }
      const archetype = (arch as voice.VoiceArchetype) || "off";
      voice.configure({
        archetype,
        params:
          parsed ??
          voice.ARCHETYPE_DEFAULTS[
            archetype === "custom" ? "off" : archetype
          ],
        autoSpeak: auto === "1",
        neuralVoiceId: neuralId || null,
      });
      s.setAutoSpeak(auto === "1");
      s.setHandsFree(hands === "1");
    }).catch(() => {});
    // Hands-free: when a streamed turn's audio has fully finished playing,
    // re-arm the composer mic through the ordinary dictation path — never
    // earlier, so the microphone can't capture the speaker's own voice.
    // The done signal can fire synchronously inside the turn's finish()
    // (nothing was spoken, or playback outran the stream) while `asking` is
    // still true — so instead of dropping the re-arm there, wait for the ask
    // to close. Single-flight: one pending arm attempt at a time.
    voice.setTurnAudioDoneListener(() => {
      if (s.armTimerRef.current !== null) return;
      const arm = () => {
        s.armTimerRef.current = null;
        if (!s.handsFreeRef.current) return;
        if (s.askingRef.current) {
          s.armTimerRef.current = window.setTimeout(arm, 150);
          return;
        }
        // The composer mic stays live while an answer streams, so the user may
        // ALREADY be dictating when this turn's audio finishes. `dictateTo`
        // would then take its toggle branch and STOP them mid-sentence — the
        // opposite of arming. Their own recording outranks the re-arm; the
        // next turn's audio-done fires this listener again.
        if (s.dictStateRef.current !== "idle") return;
        aRef.current.dictateTo("composer", (text) => void aRef.current.send(text));
      };
      arm();
    });
    // Read-aloud has no on-device fallback voice: a sentence that cannot be
    // synthesized is dropped. Without this the app just went quiet, which
    // reads as "the app is mute", not "this needs a connection".
    voice.setVoiceProblemListener((message) => s.pushToast("error", message));
    if (info.synced) {
      api
        .getSetting("hlt6_sync_dismissed")
        .then((v) => {
          if (v !== "1") s.setShowSyncWarn(true);
        })
        .catch(() => {});
    }
    const unlistenOpen = api.onAgentOpenFile((p) => {
      const id = typeof p === "string" ? p : p.id;
      const hint =
        typeof p === "string" ? undefined : (p.page ?? p.cell ?? p.find ?? undefined);
      const current = s.openFileRef.current;
      if (hint == null && current?.id === id && current.target) return;
      if (typeof p === "string" || hint == null) {
        a.viewFile(id);
      } else {
        a.viewFile(p.id, {
          page: p.page ?? undefined,
          cell: p.cell ?? undefined,
          range: p.cell ?? undefined,
          find: p.find ?? undefined,
          quote: p.find ?? undefined,
        });
      }
    });
    const unlistenAnnotate = api.onAgentAnnotate((payload) => {
      a.viewFile(payload.fileId, annotationTarget(payload));
    });
    const unlistenUpdated = api.onFileUpdated(async (fileId) => {
      s.editedRef.current.add(fileId);
      const current = s.openFileRef.current;
      if (current && current.id === fileId) {
        // Wave 1b (idea 10): reloading remounts the keyed Monaco editor and
        // would silently discard a dirty buffer — if the user is mid-edit,
        // park the reload behind the choice banner instead. Refs, not state:
        // this listener is mount-once and captures the first render.
        if (s.editModeRef.current && s.editorDirtyRef.current) {
          s.setStaleFile(fileId);
          return;
        }
        const content = await api.getFileContent(current.id);
        s.setOpenFile({ ...current, content });
        s.setViewerRev((r) => r + 1);
      }
    });
    const unlistenFiles = api.onRoomFilesChanged(() => {
      api.listFiles().then(s.setFiles).catch(readFailed("files"));
      api.listFolders().then(s.setFolders).catch(readFailed("folders"));
      // A file can leave the library WITHOUT this window asking (a workflow,
      // a job, the summarizer dropping a legacy file). Re-reading the trash
      // on the same event is what makes those deletions visible at all.
      api.listTrashedFiles().then(s.setTrashed).catch(readFailed("trash"));
      a.loadFrontPage(false);
      // Wave 5: scripts ARE files — a new/edited/imported script updates the
      // index (and a script that just ran wrote its outputs here).
      void a.refreshScripts();
    });
    api
      .mcpStatus()
      .then((st) => {
        s.setMcpTools(a.connectedTools(st));
        s.setMcpStatuses(st);
      })
      .catch(() => {});
    const unlistenMcp = api.onMcpStatus((statuses) => {
      s.setMcpTools(a.connectedTools(statuses));
      s.setMcpStatuses(statuses);
    });
    // ADD-27: keep the workspace-wide live-recording state in sync with the
    // engine (the TopBar chip + RecordingView both read s.recLive), re-attach
    // to a session that survived a reload, and refresh the open view when a
    // pause/stop lands fresh audio bytes.
    void api.recLiveStatus().then((r) => {
      if (r) s.setRecLive({ fileId: r.fileId, status: r.status });
    }).catch(() => {});
    const unlistenRecState = api.onRecState((p) => {
      // "saved" is not the only terminal status — a final write that failed
      // ends the session as "failed" (recording.rs `Engine::finish`). Treating
      // that as still-live left the microphone open for the rest of the app's
      // life and every "start a recording" affordance disabled. The decision
      // itself lives in recSession.ts so it can be tested.
      const next = applyRecState(p, s.openFileRef.current?.id);
      s.setRecLive(next.live);
      // The engine can stop ITSELF (3-hour limit, room closed under it) —
      // the microphone must never stay open past the session it fed.
      if (next.stopTap) stopMicTap();
      if (next.clearSave) s.setRecSave(null);
      if (next.reload) void a.viewFile(p.fileId);
    });
    // Stop→saved drain progress. First event = the audio bytes are durable;
    // startedAt is kept from the first event so the card's clock measures the
    // whole drain, not the latest decode.
    const unlistenRecSave = api.onRecSaveProgress((p) => {
      s.setRecSave((prev) => ({
        stage: p.stage,
        remaining: p.remaining,
        startedAt: prev?.startedAt ?? new Date().toISOString(),
      }));
    });
    // ADD-18: imported audio/video transcribes itself in the background —
    // reflect that on the file (sidebar token + viewer status line) instead
    // of letting the transcript just "appear". Keyed by file name.
    const unlistenStt = api.onSttProgress(([name, stage]) => {
      s.setSttStatus((m) => ({
        ...m,
        [name]: stage === "started" ? "processing" : stage,
      }));
      if (stage === "done") void api.listFiles().then(s.setFiles);
    });
    // AUDIT 262: the same treatment for a scanned page. `ocr-progress` has
    // always been emitted and never listened to, so a vision pass that runs for
    // minutes showed no sign of activity at all.
    const unlistenOcr = api.onOcrProgress(([name, stage]) => {
      s.setOcrFiles((f) =>
        stage === "started"
          ? f.includes(name)
            ? f
            : [...f, name]
          : f.filter((n) => n !== name),
      );
      if (stage === "done") void api.listFiles().then(s.setFiles);
    });
    const unlistenRecError = api.onRecError((p) => {
      s.pushToast("error", p.message);
    });
    // The unlock's crash-recovery pass runs before this listener exists, so a
    // failure it reported would have been emitted into nothing. Collect the
    // parked message here instead — null (the ordinary case) shows nothing.
    void api
      .takeRecRecoveryError()
      .then((message) => {
        if (message) s.pushToast("error", message);
      })
      .catch(() => {});
    // A capture lane dying must reach the user even when the recording's
    // view is closed (they're usually in Zoom, not here). One toast per
    // outage per source; the view's banner handles the on-screen case.
    const flaggedSources = new Set<string>();
    const unlistenRecSource = api.onRecSource((p) => {
      const key = `${p.fileId}:${p.source}`;
      if (p.status === "error") {
        if (flaggedSources.has(key)) return;
        flaggedSources.add(key);
        if (s.openFileRef.current?.id !== p.fileId) s.pushToast("error", p.message);
      } else {
        flaggedSources.delete(key);
      }
    });
    return () => {
      // Idea 3: the voice singleton outlives the Workspace by design — this
      // cleanup is the catch-all "no lock path may keep speaking decrypted
      // content" stop (autolock and handleLock also cancel explicitly, since
      // they run without unmounting the Workspace).
      voice.cancelAll();
      voice.setTurnAudioDoneListener(null);
      voice.setVoiceProblemListener(null);
      if (s.armTimerRef.current !== null) {
        window.clearTimeout(s.armTimerRef.current);
        s.armTimerRef.current = null;
      }
      unlisten.then((fn) => fn());
      unlistenStep.then((fn) => fn());
      unlistenLane.then((fn) => fn());
      unlistenPlan.then((fn) => fn());
      unlistenAgent.then((fn) => fn());
      unlistenStepStatus.then((fn) => fn());
      unlistenReport.then((fn) => fn());
      unlistenRound.then((fn) => fn());
      unlistenPrivacy.then((fn) => fn());
      unlistenTokenUsage.then((fn) => fn());
      unlistenImport.then((fn) => fn());
      unlistenJobs.then((fn) => fn());
      unlistenStudioStep.then((fn) => fn());
      unlistenWfNode.then((fn) => fn());
      unlistenWfChanged.then((fn) => fn());
      unlistenScriptApprove.then((fn) => fn());
      unlistenSkillsChanged.then((fn) => fn());
      unlistenPull.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
      unlistenOpen.then((fn) => fn());
      unlistenAnnotate.then((fn) => fn());
      unlistenUpdated.then((fn) => fn());
      unlistenFiles.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
      unlistenBrowserNav.then((fn) => fn());
      unlistenBrowserDownload.then((fn) => fn());
      unlistenBrowserOversize.then((fn) => fn());
      unlistenMcpApprove.then((fn) => fn());
      unlistenEditApprove.then((fn) => fn());
      unlistenAgentUi.then((fn) => fn());
      unlistenRecState.then((fn) => fn());
      unlistenRecSave.then((fn) => fn());
      unlistenStt.then((fn) => fn());
      unlistenOcr.then((fn) => fn());
      unlistenRecSource.then((fn) => fn());
      unlistenRecError.then((fn) => fn());
      window.clearInterval(s.recheckTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Nothing to clear on the way in. The live overlay, the token reading and
    // the privacy receipt are all held per chat now (state.ts `runs`,
    // `usageByChat`, `privacyByChat`), so opening a conversation simply reads
    // ITS state: a fresh chat shows an empty bar because it has no run, and a
    // chat left mid-answer shows the answer still arriving. Before owner
    // replacement #4 this effect had to wipe a set of globals here, which is
    // also why the wipe could not distinguish "nothing to show" from "the
    // previous chat's leftovers".
    if (s.activeChatId) {
      api
        .getMessages(s.activeChatId)
        .then(s.setMessages)
        .catch((e) =>
          // An empty conversation and an unreadable one look identical —
          // never let the second pass for the first.
          s.pushToast("error", `Could not read this conversation: ${String(e)}`),
        );
    } else {
      s.setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.activeChatId]);

  useEffect(() => {
    const el = s.chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // `agentPlan` is in here because the agent graph GROWS: each dispatch adds
    // a row (and sometimes a band header) to the live bubble. Without it the
    // list stays pinned to where the bubble used to end and the newest
    // specialists render below the fold — the roster often grows in the gap
    // before any delta arrives, so `streamText` does not cover this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.messages, s.asking, s.streamText, s.agentPlan]);

  useEffect(() => {
    if (s.prevAskingRef.current && !s.asking) {
      s.lastActivityRef.current = Date.now();
    }
    s.prevAskingRef.current = s.asking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.asking]);

  useEffect(() => {
    const bump = () => {
      s.lastActivityRef.current = Date.now();
    };
    // Activity is ANY real interaction, not just mouse/keyboard hardware
    // events. VoiceOver and other assistive tech drive the app through AX
    // actions that surface as click/input/focus — without these, an active
    // assisted session idle-locks mid-use and ejects the user to the gate.
    const activityEvents = [
      "mousemove",
      "keydown",
      "pointerdown",
      "click",
      "input",
      "focusin",
      "wheel",
    ] as const;
    for (const ev of activityEvents) window.addEventListener(ev, bump);
    let lastTick = Date.now();
    const interval = window.setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      const setting = s.autolockRef.current;
      if (setting === "off") return;
      const limitMs = Number(setting) * 60_000;
      if (!Number.isFinite(limitMs) || limitMs <= 0) return;
      if (s.askingRef.current) return;
      // A live recording IS activity. During a meeting the user is in
      // Zoom/Meet, not here — locking would close the room and cut the
      // recording at exactly the idle limit (a real on-device casualty).
      if (s.recLiveRef.current) {
        s.lastActivityRef.current = now;
        return;
      }
      // Idea 3 decision: playing speech IS activity too (same rationale —
      // listening to a multi-minute answer produces no input events, and
      // idle-locking would cut audio the user is actively consuming).
      // Autolock resumes counting the moment playback ends.
      if (voice.isSpeaking()) {
        s.lastActivityRef.current = now;
        return;
      }
      const idle = now - s.lastActivityRef.current;
      const slept = gap > 45_000;
      if (idle >= limitMs || (slept && gap >= limitMs)) {
        // Silence speech at the call site as well as in handleLock/unmount:
        // this timer calls onLock() directly, bypassing both.
        voice.cancelAll();
        onLock();
      }
    }, 30_000);
    return () => {
      for (const ev of activityEvents) window.removeEventListener(ev, bump);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLock]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (s.ctxMenuRef.current) {
          e.preventDefault();
          s.setCtxMenu(null);
          return;
        }
        if (s.showSearchRef.current) {
          e.preventDefault();
          s.setShowSearch(false);
          return;
        }
        if (s.showSettingsRef.current) return;
        if (s.showMapRef.current) {
          e.preventDefault();
          s.setShowMap(false);
          return;
        }
        // Wave 4a: Escape closes the full-pane Workflows view.
        if (s.showWorkflowsRef.current) {
          e.preventDefault();
          s.setShowWorkflows(false);
          return;
        }
        // Wave 5: Escape closes the full-pane Scripts view.
        if (s.showScriptsRef.current) {
          e.preventDefault();
          s.setShowScripts(false);
          return;
        }
        const t = e.target as HTMLElement | null;
        const typing =
          t != null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
        if (!typing && s.openFileRef.current) {
          e.preventDefault();
          s.setOpenFile(null);
        }
        return;
      }
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        a.newChat();
      } else if (k === "l") {
        e.preventDefault();
        a.handleLock();
      } else if (k === "f" || k === "k") {
        // ⌘F belongs to whatever is showing when that thing can search inside
        // itself: the PDF viewer claims it in the capture phase (find in this
        // document) and the room-wide search must not open on top of it.
        // ⌘K is always the palette.
        if (k === "f" && e.defaultPrevented) return;
        e.preventDefault();
        s.setSearchSel(0);
        s.setShowSearch(true);
      } else if (k === ",") {
        e.preventDefault();
        s.setShowSettings(true);
      } else if (k === "j") {
        // Wave 4a: toggle the top-bar pinned-workflows menu (no-op if none).
        e.preventDefault();
        s.setQaMenuOpen((o) => !o);
      } else if (k === "/") {
        // The shortcuts sheet — the app's own list of these keys.
        e.preventDefault();
        s.setShowShortcuts((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!s.showSearch) return;
    const q = s.searchQuery.trim();
    if (!q) {
      s.setSearchResults(null);
      s.setSearchError("");
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      api
        .searchAll(q)
        .then((r) => {
          if (stale) return;
          s.setSearchResults(r);
          s.setSearchError("");
          s.setSearchSel(0);
        })
        .catch((e) => {
          if (stale) return;
          // The previous query's hits must not stay on screen under a query
          // that never ran — you would act on results for something else.
          s.setSearchResults(null);
          s.setSearchError(String(e));
          s.setSearchSel(0);
        });
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.searchQuery, s.showSearch]);

  useEffect(() => {
    s.setShowHistory(false);
    // Wave 1b (idea 10): a different file means a fresh buffer — clear the
    // stale-write banner and the dirty mirror so old state can't leak onto it.
    s.setStaleFile(null);
    s.editorDirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.openFile?.id]);

  useEffect(() => {
    s.ctxMenuRef.current = s.ctxMenu !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ctxMenu]);

  useLayoutEffect(() => {
    if (s.ctxMenu) a.clampMenu(s.ctxMenuElRef.current, s.ctxMenu.x, s.ctxMenu.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ctxMenu]);
  useLayoutEffect(() => {
    if (s.moveMenuFor) a.clampMenu(s.moveMenuElRef.current, s.moveMenuFor.x, s.moveMenuFor.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.moveMenuFor]);

  // Whether the memory introduction has been seen is a fact about THIS ROOM,
  // so it lives in the room's own settings. It used to be a localStorage key
  // built from the room's file name: renaming the file brought the intro back,
  // and two rooms with the same file name shared one marker.
  useEffect(() => {
    api
      .getSetting(MEMORY_INTRO_SEEN)
      .then((v) => {
        if (v !== "1") s.setShowMemoryIntro(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.path]);

  useEffect(() => {
    const prev = s.prevModelRef.current;
    if (prev && s.model && prev !== s.model && !s.userPickedModelRef.current) {
      s.pushToast("info", `Switched to ${a.engineLabelOf(s.model)}`);
    }
    s.prevModelRef.current = s.model;
    s.userPickedModelRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.model]);
}
