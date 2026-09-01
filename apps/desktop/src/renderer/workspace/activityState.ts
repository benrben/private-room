import { useCallback, useRef, useState } from "react";
import type {
  AiActionDef,
  FileMetaSuggestion,
  FrontPage,
  Job,
  OrganizedRecord,
  ScriptApproveRequest,
  ScriptInfo,
  SkillSummary,
  StudioPrompts,
  Workflow,
  WorkflowNodeEvent,
} from "../api";
import type { AutocompleteState } from "./composer";
import type { WorkArea } from "./types";

/** State owned by the workspace's activity, creation, and recording surfaces. */
export function useWorkspaceActivityState() {
  const [showMemoryIntro, setShowMemoryIntro] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const showMapRef = useRef(false);
  showMapRef.current = showMap;
  const [area, setArea] = useState<WorkArea>("files");
  const [aiTab, setAiTab] = useState<"chat" | "studio" | "activity">("chat");
  const [libraryTab, setLibraryTab] = useState<"browse" | "sources" | "trash">(
    "browse",
  );
  const [newCreationSeq, setNewCreationSeq] = useState(0);
  const bumpNewCreation = useCallback(
    () => setNewCreationSeq((sequence) => sequence + 1),
    [],
  );
  const [selectedCreationJob, setSelectedCreationJob] = useState<string | null>(
    null,
  );
  const [showWorkflows, setShowWorkflows] = useState(false);
  const showWorkflowsRef = useRef(false);
  showWorkflowsRef.current = showWorkflows;
  const [wfDetailId, setWfDetailId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [showScripts, setShowScripts] = useState(false);
  const showScriptsRef = useRef(false);
  showScriptsRef.current = showScripts;
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [scriptApprovals, setScriptApprovals] = useState<ScriptApproveRequest[]>(
    [],
  );
  const [wfNodeStatus, setWfNodeStatus] = useState<
    Record<string, Record<string, WorkflowNodeEvent>>
  >({});
  const [qaFileMenuOpen, setQaFileMenuOpen] = useState(false);
  const [qaScriptMenuOpen, setQaScriptMenuOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [fp, setFp] = useState<FrontPage | null>(null);
  const [fpSuggestions, setFpSuggestions] = useState<string[]>([]);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
    name: string;
  } | null>(null);
  const [organized, setOrganized] = useState<OrganizedRecord[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobProgress, setJobProgress] = useState<
    Record<string, { label: string; done: number; total: number }>
  >({});
  const [summaryStarting, setSummaryStarting] = useState(false);
  const [studioStep, setStudioStep] = useState<{ text: string; local: boolean }>({
    text: "",
    local: true,
  });
  const [ocrFiles, setOcrFiles] = useState<string[]>([]);
  const [studioDefaults, setStudioDefaults] = useState<StudioPrompts | null>(
    null,
  );
  const [studioPrompt, setStudioPrompt] = useState<{
    kind: "flashcards" | "mindmap" | "podcast";
    scope?: string;
    text: string;
  } | null>(null);
  const studioPromptRef = useRef<HTMLTextAreaElement>(null);
  const [studioAc, setStudioAc] = useState<AutocompleteState | null>(null);
  const [aiActionDefs, setAiActionDefs] = useState<AiActionDef[] | null>(null);
  const [aiPrompt, setAiPrompt] = useState<{
    def: AiActionDef;
    scope: string | null;
    refs: string[] | null;
    text: string;
    question: string;
  } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOpId, setAiOpId] = useState<string | null>(null);
  const [aiStopping, setAiStopping] = useState(false);
  const [memSuggestion, setMemSuggestion] = useState<{ fact: string } | null>(
    null,
  );
  const [importSuggestions, setImportSuggestions] = useState<
    { fileId: string; current: string; suggestion: FileMetaSuggestion }[]
  >([]);
  const [recLive, setRecLive] = useState<{
    fileId: string;
    status: string;
  } | null>(null);
  const recLiveRef = useRef<{ fileId: string; status: string } | null>(null);
  recLiveRef.current = recLive;
  const [recSave, setRecSave] = useState<{
    stage: "transcribing" | "writing";
    remaining: number;
    startedAt: string;
  } | null>(null);
  const [sttStatus, setSttStatus] = useState<Record<string, string>>({});
  const [showFeedback, setShowFeedback] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const armTimerRef = useRef<number | null>(null);

  return {
    showMemoryIntro,
    setShowMemoryIntro,
    showMap,
    setShowMap,
    showMapRef,
    showHelp,
    setShowHelp,
    area,
    setArea,
    aiTab,
    setAiTab,
    libraryTab,
    setLibraryTab,
    newCreationSeq,
    bumpNewCreation,
    selectedCreationJob,
    setSelectedCreationJob,
    showWorkflows,
    setShowWorkflows,
    showWorkflowsRef,
    wfDetailId,
    setWfDetailId,
    workflows,
    setWorkflows,
    wfNodeStatus,
    setWfNodeStatus,
    showScripts,
    setShowScripts,
    showScriptsRef,
    scripts,
    setScripts,
    skills,
    setSkills,
    selectedSkillId,
    setSelectedSkillId,
    scriptApprovals,
    setScriptApprovals,
    qaFileMenuOpen,
    setQaFileMenuOpen,
    qaScriptMenuOpen,
    setQaScriptMenuOpen,
    fp,
    setFp,
    fpSuggestions,
    setFpSuggestions,
    importProgress,
    setImportProgress,
    organized,
    setOrganized,
    jobs,
    setJobs,
    jobProgress,
    setJobProgress,
    summaryStarting,
    setSummaryStarting,
    studioStep,
    setStudioStep,
    ocrFiles,
    setOcrFiles,
    studioDefaults,
    setStudioDefaults,
    studioPrompt,
    setStudioPrompt,
    studioPromptRef,
    studioAc,
    setStudioAc,
    aiActionDefs,
    setAiActionDefs,
    aiPrompt,
    setAiPrompt,
    aiBusy,
    setAiBusy,
    aiOpId,
    setAiOpId,
    aiStopping,
    setAiStopping,
    memSuggestion,
    setMemSuggestion,
    importSuggestions,
    setImportSuggestions,
    recLive,
    setRecLive,
    recLiveRef,
    recSave,
    setRecSave,
    sttStatus,
    setSttStatus,
    showFeedback,
    setShowFeedback,
    autoSpeak,
    setAutoSpeak,
    handsFree,
    setHandsFree,
    handsFreeRef,
    armTimerRef,
    speakingMsgId,
    setSpeakingMsgId,
  };
}
