import { useEffect, useRef } from "react";
import { listen, onDragDropEvent, setWindowTitle } from "../platform";
import { api, type AskTurn, type RoomInfo } from "../api";
import { configureMic, micVoiceProcessingFromSetting, stopMicTap } from "./liveRec";
import { handleAgentUiRequest } from "../agent/driver";
import { annotationTarget } from "./markup";
import { ownerOf as ownsEvent } from "./runIdentity";
import { applyRecState } from "./recSession";
import { startRecordingTransport } from "./recordingTransport";
import { applyHarnessEvent, mergeHarnessHistory } from "./harnessUi";
import { refreshSharedFilesForHarnessEvent } from "./harnessFileRefresh";
import * as voice from "./voice";
import type { WSState } from "./state";
import type { WSActions } from "./actions";
import { MAX_ORGANIZED, handleJobProgress, handleAgentOpenFile, handleWorkspaceDrop, loadSavedVoice } from "./effects";

export function useWorkspaceSubscriptions(s: WSState, a: WSActions, info: RoomInfo) {
  const aRef = useRef(a);
  aRef.current = a;
  useEffect(() => {
    const readFailed = (what: string) => (e: unknown) =>
      s.pushToast("error", `Could not read this room's ${what}: ${String(e)}`);
    if (!s.seededRef.current) {
      s.seededRef.current = true;
      setWindowTitle(`${info.name} — Arcelle`).catch(() => {});
      api.listFiles().then(s.setFiles).catch(readFailed("files"));
      api.listFolders().then(s.setFolders).catch(readFailed("folders"));
      api.listTrashedFiles().then(s.setTrashed).catch(readFailed("trash"));
      api.listMemories().then(s.setMemories).catch(readFailed("memories"));
      api
        .getSetting("memory_auto_save")
        .then((v) => {
          s.memAutoSaveRef.current = v === "1";
        })
        .catch(() => {});
      api
        .listChatCommands()
        .then(s.setCommands)
        .catch(() => {});
      void a.refreshSpecialists();
      void a.loadAiActions();
      void a.refreshWorkflows();
      void a.refreshScripts();
      void a.refreshSkills();
      api
        .harnessListRuns()
        .then((history) =>
          s.setHarnessRuns((runs) => mergeHarnessHistory(runs, history)),
        )
        .catch(readFailed("workspace agent history"));
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
    const ownerOf = (turn: AskTurn) =>
      ownsEvent(turn, s.activeChatIdRef.current);
    const unlisten = api.onAskDelta((delta, turn) => {
      const chat = ownerOf(turn);
      if (!chat) return;
      s.applyToRun(chat, turn.runId, (t) => ({ ...t, text: t.text + delta }));
      if (voice.turnBelongsTo(chat)) voice.feedStreamDelta(delta);
    });
    const unlistenStep = api.onAskStep(({ label, node }, turn) => {
      const chat = ownerOf(turn);
      if (!chat) return;
      s.applyToRun(chat, turn.runId, (t) => ({
        ...t,
        steps: [...t.steps, { label, ok: true }],
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
            ? [
                ...t.steps.slice(0, -1),
                { ...t.steps[t.steps.length - 1], ok: false },
              ]
            : t.steps,
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
      if (voice.turnBelongsTo(chat)) voice.roundBoundary();
    });
    const unlistenPrivacy = api.onAskPrivacy((p, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.setAskPrivacy(chat, p);
    });
    const unlistenTokenUsage = api.onAskTokenUsage((p, turn) => {
      const chat = ownerOf(turn);
      if (chat) s.setChatUsage(chat, p);
    });
    const unlistenImport = api.onImportProgress((p) => {
      s.setImportProgress(p.done >= p.total ? null : p);
    });
    const unlistenScan = api.onPrivacyScan((p) => {
      s.setPrivacyScanning(p.running);
      if (p.running) return;
      if (p.error) {
        s.pushToast("error", `Couldn't scan for private details — ${p.error}`, {
          label: "Open privacy",
          run: () => {
            s.setSettingsSection("set-cloud-privacy");
            s.setShowSettings(true);
          },
        });
      }
      a.refreshPrivacy();
    });
    const seenJobs = new Set<string>();
    void a.refreshJobs();
    const unlistenJobs = api.onJobProgress((progress) =>
      handleJobProgress(s, a, seenJobs, progress),
    );
    const unlistenStudioStep = api.onStudioStep((p) =>
      s.setStudioStep({ text: p.step, local: p.local }),
    );
    const unlistenWfNode = api.onWorkflowNode((e) => {
      s.setWfNodeStatus((m) => ({
        ...m,
        [e.jobId]: { ...(m[e.jobId] ?? {}), [e.nodeId]: e },
      }));
    });
    const unlistenWfChanged = api.onWorkflowsChanged(() => {
      void a.refreshWorkflows();
      void a.refreshScripts();
    });
    const unlistenScriptApprove = api.onScriptApproveRequest((req) => {
      s.setScriptApprovals((q) => [...q, req]);
    });
    const unlistenSkillsChanged = api.onSkillsChanged(() => {
      void a.refreshSkills();
    });
    const unlistenMemories = api.onMemoriesChanged(() => {
      api.listMemories().then(s.setMemories).catch(readFailed("memories"));
    });
    const unlistenPull = listen<{ status: string; percent: number | null }>(
      "pull-progress",
      (e) => {
        s.setPullStatus(e.payload.status);
        s.setPullPercent(e.payload.percent);
      },
    );
    const unlistenDrop = onDragDropEvent(({ payload }) =>
      handleWorkspaceDrop(s, a, payload),
    );
    const unlistenBrowserNav = api.onBrowserNavigated(() => {
      a.revealBrowser();
    });
    const unlistenBrowserDownload = api.onBrowserDownload((p) => {
      if (p.ok) {
        s.pushToast("success", `${p.name} arrived in the room.`);
      } else {
        s.pushToast(
          "error",
          `Download of ${p.name} failed: ${p.error ?? "unknown error"}`,
        );
      }
    });
    const unlistenBrowserOversize = api.onBrowserDownloadOversize((p) => {
      s.pushToast("error", p.detail);
    });
    const unlistenMcpApprove = api.onMcpApproveRequest((req) => {
      s.setMcpApprovals((q) => [...q, req]);
    });
    const unlistenEditApprove = api.onEditApproveRequest((req) => {
      s.setEditApprovals((q) => [...q, req]);
    });
    const unlistenAgentUi = api.onAgentUiRequest(async (req) => {
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
    const unlistenHarness = api.onHarnessEvent((event) => {
      s.setHarnessRuns((runs) => applyHarnessEvent(runs, event));
      if (event.type === "approval_requested") s.setAiTab("activity");
      void refreshSharedFilesForHarnessEvent(
        event,
        api.listFiles,
        s.setFiles,
      ).catch(() => {});
      if (event.type === "run_failed") {
        s.pushToast("error", `Agent run failed: ${event.error}`);
      }
      if (event.type === "run_failed" || event.type === "run_completed") {
        api
          .harnessListRuns()
          .then((history) =>
            s.setHarnessRuns((runs) => mergeHarnessHistory(runs, history)),
          )
          .catch(() => {});
      }
    });
    a.refreshWebAccess();
    a.refreshAutolock();
    a.refreshPrivacy();
    api
      .privacyStatus()
      .then((st) => {
        if (!st.lastScanError) return;
        s.pushToast(
          "error",
          `Couldn't scan for private details — ${st.lastScanError}`,
          {
            label: "Open privacy",
            run: () => {
              s.setSettingsSection("set-cloud-privacy");
              s.setShowSettings(true);
            },
          },
        );
      })
      .catch(() => {});
    void api
      .getSetting("mic_voice_processing")
      .then((v) => configureMic(micVoiceProcessingFromSetting(v)))
      .catch(() => {});
    loadSavedVoice(s);
    voice.setTurnAudioDoneListener(() => {
      if (s.armTimerRef.current !== null) return;
      const arm = () => {
        s.armTimerRef.current = null;
        if (!s.handsFreeRef.current) return;
        if (s.askingRef.current) {
          s.armTimerRef.current = window.setTimeout(arm, 150);
          return;
        }
        if (s.dictStateRef.current !== "idle") return;
        aRef.current.dictateTo(
          "composer",
          (text) => void aRef.current.send(text),
        );
      };
      arm();
    });
    voice.setVoiceProblemListener((message) => s.pushToast("error", message));
    if (info.synced) {
      api
        .getSetting("hlt6_sync_dismissed")
        .then((v) => {
          if (v !== "1") s.setShowSyncWarn(true);
        })
        .catch(() => {});
    }
    const unlistenOpen = api.onAgentOpenFile((payload) =>
      handleAgentOpenFile(s, a, payload),
    );
    const unlistenAnnotate = api.onAgentAnnotate((payload) => {
      a.viewFile(payload.fileId, annotationTarget(payload));
    });
    const unlistenUpdated = api.onFileUpdated(async (fileId) => {
      s.editedRef.current.add(fileId);
      const current = s.openFileRef.current;
      if (current && current.id === fileId) {
        if (s.editModeRef.current && s.editorDirtyRef.current) {
          s.setStaleFile(fileId);
          return;
        }
        const content = await api.getFileContent(current.id);
        s.setOpenFile({ ...current, content });
        s.setViewerRev((r) => r + 1);
      }
    });
    const unlistenOrganized = api.onAssistantOrganized((change) => {
      s.setOrganized((prev) =>
        [{ ...change, seq: (prev[0]?.seq ?? 0) + 1 }, ...prev].slice(
          0,
          MAX_ORGANIZED,
        ),
      );
    });
    const unlistenFiles = api.onRoomFilesChanged(() => {
      api.listFiles().then(s.setFiles).catch(readFailed("files"));
      api.listFolders().then(s.setFolders).catch(readFailed("folders"));
      api.listTrashedFiles().then(s.setTrashed).catch(readFailed("trash"));
      a.loadFrontPage(false);
      void a.refreshScripts();
      a.refreshPrivacy();
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
    void api
      .recLiveStatus()
      .then((r) => {
        if (r) {
          if (r.sessionUrl) startRecordingTransport(r.sessionUrl, r.fileId);
          s.setRecLive({ fileId: r.fileId, status: r.status });
        }
      })
      .catch(() => {});
    const unlistenRecState = api.onRecState((p) => {
      const next = applyRecState(p, s.openFileRef.current?.id);
      s.setRecLive(next.live);
      if (next.stopTap) stopMicTap();
      if (next.clearSave) s.setRecSave(null);
      if (next.reload) void a.viewFile(p.fileId);
    });
    const unlistenRecSave = api.onRecSaveProgress((p) => {
      s.setRecSave((prev) => ({
        stage: p.stage,
        remaining: p.remaining,
        startedAt: prev?.startedAt ?? new Date().toISOString(),
      }));
    });
    const unlistenStt = api.onSttProgress(([name, stage]) => {
      s.setSttStatus((m) => ({
        ...m,
        [name]: stage === "started" ? "processing" : stage,
      }));
      if (stage === "done") void api.listFiles().then(s.setFiles);
    });
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
    const shownRecovery = new Set<string>();
    const recoveryOnce = (message: string) => {
      if (shownRecovery.has(message)) return;
      shownRecovery.add(message);
      s.pushToast("error", message);
    };
    const unlistenRecError = api.onRecError((p) => {
      if (!p.fileId) {
        recoveryOnce(p.message);
        return;
      }
      s.pushToast("error", p.message);
    });
    void api
      .takeRecRecoveryError()
      .then((message) => {
        if (message) recoveryOnce(message);
      })
      .catch(() => {});
    const flaggedSources = new Set<string>();
    const unlistenRecSource = api.onRecSource((p) => {
      const key = `${p.fileId}:${p.source}`;
      if (p.status === "error") {
        if (flaggedSources.has(key)) return;
        flaggedSources.add(key);
        if (s.openFileRef.current?.id !== p.fileId)
          s.pushToast("error", p.message);
      } else {
        flaggedSources.delete(key);
      }
    });
    return () => {
      voice.cancelAll();
      voice.setTurnAudioDoneListener(null);
      voice.setVoiceProblemListener(null);
      stopMicTap();
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
      unlistenScan.then((fn) => fn());
      unlistenJobs.then((fn) => fn());
      unlistenStudioStep.then((fn) => fn());
      unlistenWfNode.then((fn) => fn());
      unlistenWfChanged.then((fn) => fn());
      unlistenScriptApprove.then((fn) => fn());
      unlistenSkillsChanged.then((fn) => fn());
      unlistenMemories.then((fn) => fn());
      unlistenPull.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
      unlistenOpen.then((fn) => fn());
      unlistenAnnotate.then((fn) => fn());
      unlistenUpdated.then((fn) => fn());
      unlistenOrganized.then((fn) => fn());
      unlistenFiles.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
      unlistenBrowserNav.then((fn) => fn());
      unlistenBrowserDownload.then((fn) => fn());
      unlistenBrowserOversize.then((fn) => fn());
      unlistenMcpApprove.then((fn) => fn());
      unlistenEditApprove.then((fn) => fn());
      unlistenAgentUi.then((fn) => fn());
      unlistenHarness.then((fn) => fn());
      unlistenRecState.then((fn) => fn());
      unlistenRecSave.then((fn) => fn());
      unlistenStt.then((fn) => fn());
      unlistenOcr.then((fn) => fn());
      unlistenRecSource.then((fn) => fn());
      unlistenRecError.then((fn) => fn());
      window.clearInterval(s.recheckTimer.current);
    };
  }, []);

}
