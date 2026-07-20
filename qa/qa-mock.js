/* Visual-QA Tauri IPC mock. Loaded BEFORE the app bundle in dist/qa.html so
 * the real UI renders with realistic data in an ordinary browser (no Rust
 * backend). Never shipped: qa.html is generated on demand by qa/make-qa.mjs
 * and only served via `vite preview`. */
(() => {
  const now = new Date();
  const iso = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();

  const files = [
    { id: "f-direction", name: "Arcelle UX direction.md", mimeType: "text/markdown", sizeBytes: 4210, source: "generated", hasText: true, createdAt: iso(2), folderId: "fo-product", partiallyIndexed: false },
    { id: "f-ideas", name: "Ideas.md", mimeType: "text/markdown", sizeBytes: 2130, source: "upload", hasText: true, createdAt: iso(300), folderId: "fo-product", partiallyIndexed: false },
    { id: "f-issues", name: "Issues.md", mimeType: "text/markdown", sizeBytes: 1830, source: "upload", hasText: true, createdAt: iso(14), folderId: "fo-product", partiallyIndexed: false },
    { id: "f-clean", name: "clean-code.pdf", mimeType: "application/pdf", sizeBytes: 3_980_000, source: "upload", hasText: true, createdAt: iso(900), folderId: "fo-research", partiallyIndexed: true },
    { id: "f-review", name: "review-sample.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 188_000, source: "upload", hasText: true, createdAt: iso(1300), folderId: "fo-research", partiallyIndexed: false },
    { id: "f-apollo", name: "Apollo missions.csv", mimeType: "text/csv", sizeBytes: 8210, source: "upload", hasText: true, createdAt: iso(2100), folderId: "fo-research", partiallyIndexed: false },
    { id: "f-meeting", name: "Product review.m4a", mimeType: "audio/mp4", sizeBytes: 22_000_000, source: "recording", hasText: true, createdAt: iso(60), folderId: null, partiallyIndexed: false },
    { id: "f-script", name: "prepare_release.py", mimeType: "text/x-python", sizeBytes: 1180, source: "upload", hasText: true, createdAt: iso(400), folderId: null, partiallyIndexed: false },
  ];

  const folders = [
    { id: "fo-product", name: "Product" },
    { id: "fo-research", name: "Research" },
  ];

  const memories = [
    { id: "m1", content: "Prefers concise product documents", category: "preference", createdAt: iso(4000) },
    { id: "m2", content: "Arcelle is a local-first research workspace", category: "project", createdAt: iso(3000) },
    { id: "m3", content: "Ben reads Hebrew sources; keep RTL rendering intact", category: "fact", createdAt: iso(2000) },
  ];

  const chats = [
    { id: "c1", title: "Core interaction model", createdAt: iso(30) },
    { id: "c2", title: "Apollo dataset questions", createdAt: iso(500) },
  ];

  const messages = [
    { id: "msg1", role: "user", content: "What should be the core interaction model for Arcelle?", sources: [], createdAt: iso(16), effects: null },
    {
      id: "msg2",
      role: "assistant",
      content:
        "Use a persistent three-part workspace: **source library**, focused editor, and contextual AI.\n\n- Selections in the library define the AI's evidence.\n- Citations reopen the exact supporting source.\n- Layout changes are reversible and remembered.",
      sources: ["Ideas.md", "review-sample.docx"],
      createdAt: iso(15),
      effects: {
        annotation: { fileId: "f-ideas", name: "Ideas.md", quote: "Keep sources, the active page, and AI in one view", note: "Workspace model", range: null, approx: false },
      },
    },
  ];

  const docText = `# Arcelle UX direction\n\nA calmer, source-grounded workspace where navigation, writing, and assistance stay visible without competing for attention.\n\n## One workspace, three clear jobs\n\nThe interface should behave like a room rather than a stack of destinations. The library is for orientation, the editor is for the current thought, and AI is for asking or transforming. All three remain available side by side, and each can disappear completely when it is not needed.\n\n- Keep the writing surface stable while sources and AI resize around it.\n- Make AI context explicit with source checkboxes and visible citations.\n- Preserve every user layout and restore it on the next visit.\n\n> **Design rule:** Quiet does not mean hidden. Essential controls remain discoverable; secondary controls appear where the user is already looking.\n\n## Reading and writing should feel effortless\n\nUse a restrained type scale, a comfortable line length, and generous vertical rhythm. The page is the visual center. Toolbars stay compact, while frequently used actions are reachable from the keyboard and the activity rail.\n\n## Trust must be visible\n\nShow what leaves the device, what stays local, which files are informing an answer, and where every citation came from. Privacy language should describe behavior, not merely claim safety.`;

  const contents = {
    "f-direction": { kind: "markdown", name: "Arcelle UX direction.md", mime: "text/markdown", editable: true, text: docText, dataB64: null },
    "f-ideas": { kind: "markdown", name: "Ideas.md", mime: "text/markdown", editable: true, text: "# Workspace model\n\nKeep sources, the active page, and AI in one view. Make the page the visual anchor.", dataB64: null },
    "f-issues": { kind: "markdown", name: "Issues.md", mime: "text/markdown", editable: true, text: "# High priority\n\n- Navigation changes meaning between workspace and chat.\n- Source scope is invisible before sending.", dataB64: null },
    "f-apollo": { kind: "csv", name: "Apollo missions.csv", mime: "text/csv", editable: true, text: "mission,year,crew\nApollo 7,1968,3\nApollo 8,1968,3\nApollo 11,1969,3\nApollo 13,1970,3\nApollo 17,1972,3", dataB64: null },
    "f-script": { kind: "code", name: "prepare_release.py", mime: "text/x-python", editable: true, text: "# /// script\n# room-inputs: Research/*.md\n# room-outputs: Reports/release-brief.md\n# room-timeout: 120\n# ///\n\nfrom pathlib import Path\nnotes = list(Path('Research').glob('*.md'))\nprint(len(notes))", dataB64: null },
    "f-meeting": { kind: "recording", name: "Product review.m4a", mime: "audio/mp4", editable: false, text: "[00:12] We should keep the document in the center.\n[00:41] And the AI needs to say which sources it used.", dataB64: null, mediaToken: null },
  };

  const workflows = [
    { id: "w1", name: "Weekly research synthesis", description: "", emoji: "🧪", definition: { version: 1, nodes: [{ id: "n1", kind: "generate", name: "Collect weekly changes", params: { prompt: "Summarize the week" } }, { id: "n2", kind: "save_file", name: "Weekly synthesis.md", params: { name: "Weekly synthesis.md" } }], edges: [{ from: "n1", to: "n2" }] }, status: "active", createdBy: "user", binding: { scope: "general" }, pinned: true, createdAt: iso(9000), updatedAt: iso(200) },
    { id: "w2", name: "Tidy imported files", description: "", emoji: "🧹", definition: { version: 1, nodes: [{ id: "n1", kind: "generate", name: "Collect weekly changes", params: { prompt: "Summarize the week" } }, { id: "n2", kind: "save_file", name: "Weekly synthesis.md", params: { name: "Weekly synthesis.md" } }], edges: [{ from: "n1", to: "n2" }] }, status: "draft", createdBy: "agent", binding: { scope: "file", kinds: ["pdf"], exts: [], fileId: null }, pinned: false, createdAt: iso(8000), updatedAt: iso(4000) },
  ];

  const scripts = [
    { fileId: "f-script", name: "prepare_release.py", lang: "py", deps: [], inputs: ["Research/*.md"], outputs: ["Reports/release-brief.md"], shortcut: "global", approved: true, changedSinceApproval: false, workflowId: null, schedule: null, lastRun: null },
  ];

  const jobs = [
    { id: "j1", kind: "deep_summary", title: "Room summary", plan: null, state: null, cursor: 3, total: 5, status: "running", error: null, createdAt: iso(2), updatedAt: iso(0) },
  ];

  const settings = { memory_auto_save: "0", autolock_minutes: "off", web_provider: "off", voice_archetype: "off", edit_approval: "off" };

  const listeners = new Map(); // event name -> Map(handlerId -> cb)
  let cbId = 1;
  const cbs = new Map();

  // #gate → land on the start screen (no open room) to QA onboarding.
  const gateMode = location.hash === "#gate";
  const commands = {
    room_info: () =>
      gateMode
        ? null
        : { name: "Research Room", path: "/Users/ben/Research Room.roomai", fileCount: files.length, messageCount: 12, synced: false, pendingMcp: null },
    take_pending_open: () => null,
    list_recent: () =>
      gateMode
        ? [
            { path: "/Users/ben/Research Room.roomai", name: "Research Room", lastOpened: iso(60) },
            { path: "/Users/ben/Journal.roomai", name: "Journal", lastOpened: iso(2000) },
          ]
        : [],
    list_files: () => files,
    list_folders: () => folders,
    list_memories: () => memories,
    list_chats: () => chats,
    get_messages: (a2) => (a2 && a2.chatId === "c1" ? messages : []),
    list_chat_commands: () => [
      { name: "summary", summary: "Summarize the attached files", usage: "#summary" },
      { name: "minutes", summary: "Meeting minutes from a transcript", usage: "#minutes" },
    ],
    ai_status: () => ({ running: true, installed: true, models: ["qwen3.5:4b"], defaultModel: "qwen3.5:4b", external: ["claude-cli"] }),
    model_capabilities: () => [{ model: "qwen3.5:4b", tools: true, vision: false }],
    get_setting: (a2) => settings[a2?.key] ?? null,
    set_setting: (a2) => { if (a2) settings[a2.key] = a2.value; return null; },
    // PRIV-1: the cloud-privacy gatekeeper (stubbed: door on, one sample entity).
    privacy_status: () => ({
      globalDefaultOn: true,
      roomSetting: null,
      effectiveOn: true,
      entities: [
        { id: "pe1", realText: "Dana Levi", placeholder: "[Person A]", category: "person", source: "user" },
      ],
      concepts: ["my health"],
      pendingFiles: 0,
      scanning: false,
    }),
    set_privacy_room: () => null,
    set_privacy_global: () => null,
    add_privacy_block: (a2) => ({ id: "pe" + Math.random().toString(36).slice(2), realText: a2?.text ?? "", placeholder: "[Person B]", category: a2?.category ?? "person", source: "user" }),
    remove_privacy_entity: () => null,
    set_privacy_concepts: () => null,
    privacy_preview: (a2) => ({
      text: "Lease agreement between [Person A] and the landlord…",
      entitiesHidden: 1,
      replacements: 1,
      present: ["[Person A]"],
    }),
    start_privacy_scan: () => null,
    front_page: () => ({ recentFiles: files.slice(0, 3), recentChats: chats, memories, suggestions: [], fileCount: files.length, chatCount: chats.length }),
    front_page_suggestions: () => ["What changed in this room this week?", "Draft a release brief from Research"],
    list_workflows: () => workflows,
    workflow_templates: () => [],
    list_scripts: () => scripts,
    list_jobs: () => jobs,
    mcp_status: () => [],
    mcp_get_config: () => "",
    get_file_content: (a2) => contents[a2?.id] ?? { kind: "text", name: "unknown", mime: "text/plain", editable: false, text: "(no preview)", dataB64: null },
    list_file_versions: () => [],
    search_all: (a2) => ({
      files: files.filter((f) => f.name.toLowerCase().includes((a2?.query ?? "").toLowerCase())).map((f) => ({ id: f.id, name: f.name, snippet: "…" })),
      messages: [],
      memories: [],
    }),
    rec_live_status: () => null,
    room_graph: () => ({ nodes: files.slice(0, 6).map((f, i) => ({ id: f.id, name: f.name, kind: "file", links: i % 3 })), edges: [{ from: "f-direction", to: "f-ideas", why: "shared concepts" }, { from: "f-direction", to: "f-review", why: "cited" }] }),
    studio_prompts: () => ({ flashcards: "Make flashcards", mindmap: "Make a mind map", podcast: "Write a podcast script" }),
    ai_action_prompts: () => [],
    warm_model: () => null,
    create_chat: () => ({ id: "c" + Math.random().toString(36).slice(2), title: "New chat", createdAt: new Date().toISOString() }),
    touchid_has: () => false,
    has_recovery_key: () => false,
    get_workflow_runs: () => [],
    get_workflow_schedule: () => null,
    validate_workflow: () => [],
    get_workflow: (a2) => workflows.find((w) => w.id === a2?.id) ?? null,
    app_diag: () => "qa-mock",
    list_room_checkpoints: () => ({ entries: [{ id: "ck1", name: "Checkpoint — Jul 18", createdAt: iso(1440), sizeBytes: 18_000_000, auto: false }], totalBytes: 18_000_000 }),
    stt_status: () => ({ installed: true, downloading: false, sizeMb: 620 }),
    room_server_status: () => ({ running: false, url: "", config: "", scope: "files", stable: false, allowCloud: false }),
    list_speech_voices: () => [{ id: "com.apple.samantha", name: "Samantha", lang: "en-US" }],
    // Voice QA: a tiny valid silent WAV so decodeAudioData succeeds and the
    // auto-speak pipeline schedules real (inaudible) audio end-to-end.
    speak_text: () => {
      window.__qaSpeaks = (window.__qaSpeaks || 0) + 1;
      const rate = 8000, n = 400; // 50 ms of silence
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const str = (o, s2) => { for (let i = 0; i < s2.length; i++) v.setUint8(o + i, s2.charCodeAt(i)); };
      str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
      str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, rate, true);
      v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, "data"); v.setUint32(40, n * 2, true);
      let bin = "";
      new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
      return btoa(bin);
    },
    // First stop yields a follow-up (drives one hands-free auto-send loop),
    // later stops yield silence so the QA run terminates.
    transcribe_audio: () => {
      window.__qaTranscribes = (window.__qaTranscribes || 0) + 1;
      return window.__qaTranscribes === 1 ? "and a follow-up question" : "";
    },
    recommended_models: () => ({ vision: "qwen2.5vl:3b", embed: "nomic-embed-text" }),
    get_ollama_url: () => "",
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      listeners.get(event)?.delete(id);
    },
  };

  window.__TAURI_INTERNALS__ = {
    plugins: {},
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback(cb) {
      const id = cbId++;
      cbs.set(id, cb);
      return id;
    },
    async invoke(cmd, args) {
      if (cmd === "plugin:event|listen") {
        const { event, handler } = args;
        if (!listeners.has(event)) listeners.set(event, new Map());
        listeners.get(event).set(handler, cbs.get(handler));
        return handler;
      }
      if (cmd === "plugin:event|unlisten") {
        const { event, eventId } = args;
        listeners.get(event)?.delete(eventId);
        return null;
      }
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return null;
      if (cmd === "plugin:updater|check") return null;
      if (cmd.startsWith("plugin:dialog|")) return null;
      if (cmd.startsWith("plugin:")) return null;
      const fn = commands[cmd];
      if (fn) return fn(args);
      if (cmd.startsWith("list_")) return [];
      if (cmd === "ask" || cmd === "run_command") {
        window.__qaAsks = (window.__qaAsks || 0) + 1;
        (window.__qaAskLog = window.__qaAskLog || []).push(args?.question ?? args?.text ?? "?");
        // Pretend a short streamed answer, so Send visibly works in QA.
        setTimeout(() => window.__qaEmit("ask-delta", "Thinking about your sources… "), 150);
        setTimeout(() => window.__qaEmit("ask-delta", "here is a grounded answer."), 450);
        return new Promise((resolve) =>
          setTimeout(() => resolve({ id: "msg-live", role: "assistant", content: "Thinking about your sources… here is a grounded answer.", sources: ["Ideas.md"], createdAt: new Date().toISOString(), effects: null }), 800),
        );
      }
      console.warn("[qa-mock] unhandled command:", cmd, args);
      return null;
    },
  };

  // Hands-free QA: a synthetic mic (oscillator → MediaStream) so dictation
  // runs headless without fake-device launch flags.
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = new AudioContext();
      const osc = c.createOscillator();
      const dst = c.createMediaStreamDestination();
      osc.connect(dst);
      osc.start();
      window.__qaMicGrants = (window.__qaMicGrants || 0) + 1;
      // Pin the context: GC would end the track and auto-stop MediaRecorder,
      // which would fake a user stop-click mid-QA.
      (window.__qaMicCtxs = window.__qaMicCtxs || []).push(c);
      dst.stream.getAudioTracks()[0].addEventListener("ended", () => {
        window.__qaTrackEnded = (window.__qaTrackEnded || 0) + 1;
      });
      return dst.stream;
    };
  }

  window.__qaEmit = (event, payload) => {
    const subs = listeners.get(event);
    if (!subs) return 0;
    for (const cb of subs.values()) cb?.({ event, id: 0, payload });
    return subs.size;
  };
  console.log("[qa-mock] installed");
})();
