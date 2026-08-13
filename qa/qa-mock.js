/* Visual-QA Tauri IPC mock. Loaded BEFORE the app bundle in dist/qa.html so
 * the real UI renders with realistic data in an ordinary browser (no Rust
 * backend). Never shipped: qa.html is generated on demand by qa/make-qa.mjs
 * and only served via `vite preview`. */
(() => {
  const now = new Date();
  const iso = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();
  /* Unix epoch MILLIS, for the handful of fields the backend sends as a number
   * rather than as an ISO string (RecentRoom.openedAt). */
  const epochMs = (minAgo) => now.getTime() - minAgo * 60000;
  /* Seconds → the "m-ss" stamp `commands/video.rs` puts in a derived file's
   * name. Mirrored here so the trim/still receipts read the way the real ones
   * do — a fixture that returned "clip.mp4" would hide the naming entirely. */
  const stampFor = (secs) => {
    const s = Math.max(0, Math.round(Number(secs) || 0));
    const pad = (n) => String(n).padStart(2, "0");
    return s >= 3600
      ? `${Math.floor(s / 3600)}-${pad(Math.floor((s % 3600) / 60))}-${pad(s % 60)}`
      : `${Math.floor(s / 60)}-${pad(s % 60)}`;
  };

  /* VISUAL STATE, chosen with `?qa_state=empty|loading|error` (default: full).
   *
   * The fixtures below describe one well-stocked room, which is the state worth
   * having for regression specs but only ONE of the four a screen can be in. A
   * vision dataset that shows the model a populated Files pane and never an
   * empty, loading or failed one teaches it that those states do not exist —
   * and a calibration set with that gap marks the machinery behind them unused.
   *
   * Applied to READ commands only, so the shell still mounts and the state is
   * visible where a user would see it: inside the pane, not instead of it. */
  const QA_STATE = new URLSearchParams(location.search).get("qa_state") || "full";

  /* Reads whose NAME does not begin with one of the prefixes below. Guessing
   * from the name alone silently excluded Home, Settings, the recording pane,
   * the connectors pane and the browser — none of their loaders are called
   * `list_*`/`get_*` — so `?qa_state=` never reached them and their empty,
   * loading and failed looks were never captured. Anything a pane fetches on
   * mount belongs here; `room_info` deliberately does NOT (blanking it ejects
   * the shell to the gate, which is a different screenshot entirely). */
  const EXTRA_READS = new Set([
    "front_page",
    "front_page_suggestions",
    "room_graph",
    "studio_prompts",
    "ai_action_prompts",
    "workflow_templates",
    "ai_status",
    "model_capabilities",
    "engine_capabilities",
    "engine_preflight",
    "engine_support_matrix",
    "grounding_model_for_room",
    "recommended_models",
    "stt_status",
    "privacy_status",
    "room_server_status",
    "app_diag",
    "rec_live_status",
    "rec_get",
    "mcp_status",
    "mcp_get_config",
    "mcp_get_tool_prefs",
    "mcp_registry_search",
    "mcp_registry_optin_status",
    "mcp_oauth_status",
    "browser_info",
    "browser_tabs",
    "browser_journal",
    "browser_search",
  ]);
  const isRead = (cmd) =>
    /^(list_|get_|read_|search_|load_|fetch_)/.test(cmd) || EXTRA_READS.has(cmd);

  /* Every command this mock does NOT answer, with a call count, on
   * `window.__qaUnhandled`. A silent `[]` for an unfaked read is the worst
   * outcome a harness can produce: the pane renders blank, the run stays
   * green, and the screenshot is filed as a picture of the real app. The
   * fallback still returns a non-crashing shape — but it now leaves a record a
   * spec (or a human reading the console) can fail on.
   *   node qa/check-mock-coverage.mjs   lists the gap without running the app. */
  const noteUnhandled = (cmd, fallback) => {
    const seen = (window.__qaUnhandled = window.__qaUnhandled || {});
    seen[cmd] = (seen[cmd] || 0) + 1;
    if (seen[cmd] === 1) {
      console.warn("[qa-mock] NO FIXTURE for command:", cmd);
      showGap();
    }
    return fallback;
  };

  /* ...and the same fact ON the page, because the two records above are only
   * seen by someone who went looking. A pane fed an unfaked read draws a
   * perfectly healthy-looking empty list — "no skills yet", "no providers", an
   * empty marketplace — and a person eyeballing the harness before a release
   * has no way to tell that apart from the real empty state. This badge says
   * which it is, in the same frame as the emptiness, and lands in any
   * screenshot taken of it. `pointer-events: none` so it can never take a
   * click the spec meant for the app. */
  const showGap = () => {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", showGap, { once: true });
      return;
    }
    let el = document.getElementById("qa-mock-gap");
    if (!el) {
      el = document.createElement("div");
      el.id = "qa-mock-gap";
      el.style.cssText =
        "position:fixed;left:0;bottom:0;z-index:2147483647;pointer-events:none;" +
        "max-width:60vw;padding:4px 8px;font:11px/1.4 ui-monospace,monospace;" +
        "background:#e5646c;color:#fff;border-top-right-radius:6px";
      document.body.appendChild(el);
    }
    const names = Object.keys(window.__qaUnhandled || {}).sort();
    el.textContent = `qa-mock has no fixture for ${names.length} command(s) — what you see below them is the MOCK'S emptiness, not the app's: ${names.join(", ")}`;
  };

  /** Same object shape, every collection emptied — an empty room, not a broken
   * one. Blanking the whole response instead would crash panes that read
   * `.name` off it, which is a different screenshot than "you have no files". */
  const emptied = (v) => {
    if (Array.isArray(v)) return [];
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = Array.isArray(val) ? [] : typeof val === "number" ? 0 : val;
      }
      return out;
    }
    return v;
  };

  const files = [
    { id: "f-direction", name: "Arcelle UX direction.md", mimeType: "text/markdown", sizeBytes: 4210, source: "generated", hasText: true, createdAt: iso(2), folderId: "fo-product", partiallyIndexed: false, aiSummary: "Product notes on the shell redesign's rail, panes and token system." },
    { id: "f-ideas", name: "Ideas.md", mimeType: "text/markdown", sizeBytes: 2130, source: "upload", hasText: true, createdAt: iso(300), folderId: "fo-product", partiallyIndexed: false, aiSummary: null },
    { id: "f-issues", name: "Issues.md", mimeType: "text/markdown", sizeBytes: 1830, source: "upload", hasText: true, createdAt: iso(14), folderId: "fo-product", partiallyIndexed: false, aiSummary: null },
    // No description: a large PDF that hasn't reached the auto-index filler
    // yet — the fixture the "most files may not have one" case needs.
    { id: "f-clean", name: "clean-code.pdf", mimeType: "application/pdf", sizeBytes: 3_980_000, source: "upload", hasText: true, createdAt: iso(900), folderId: "fo-research", partiallyIndexed: true, aiSummary: null },
    { id: "f-review", name: "review-sample.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 188_000, source: "upload", hasText: true, createdAt: iso(1300), folderId: "fo-research", partiallyIndexed: false, aiSummary: "A sample review document used to exercise the Word-doc viewer and editor." },
    { id: "f-apollo", name: "Apollo missions.csv", mimeType: "text/csv", sizeBytes: 8210, source: "upload", hasText: true, createdAt: iso(2100), folderId: "fo-research", partiallyIndexed: false, aiSummary: null },
    { id: "f-meeting", name: "Product review.m4a", mimeType: "audio/mp4", sizeBytes: 22_000_000, source: "recording", hasText: true, createdAt: iso(60), folderId: null, partiallyIndexed: false, aiSummary: "A recorded product review meeting with a full speaker transcript." },
    { id: "f-script", name: "prepare_release.py", mimeType: "text/x-python", sizeBytes: 1180, source: "upload", hasText: true, createdAt: iso(400), folderId: null, partiallyIndexed: false, aiSummary: null },
    // The video viewer's own surface (technical strip, Set start/Set end, Trim,
    // Save frame) had NO fixture at all, so nothing in this harness could reach
    // it — the `probe_video_meta` fixture below was unreachable.
    { id: "f-demo", name: "Kickoff demo.mp4", mimeType: "video/mp4", sizeBytes: 48_000_000, source: "upload", hasText: true, createdAt: iso(45), folderId: null, partiallyIndexed: false, aiSummary: null },
    // Two SAVED WEB PAGES, because the viewer's source strip renders from
    // `files.web_meta` and there was no fixture carrying one — so the strip was
    // unreachable from this harness even though the UA checklist asks a tester
    // to look at it. They are a PAIR on purpose: one page declared its site,
    // author and dates, the other declared nothing but the address, and the
    // whole promise of the strip is that those two look different (no
    // "Author: unknown" row on the second).
    { id: "f-heron", name: "The Heron Returns.md", mimeType: "text/markdown", sizeBytes: 4300, source: "web", hasText: true, createdAt: iso(20), folderId: "fo-research", partiallyIndexed: false, aiSummary: null },
    { id: "f-bare", name: "Status page.md", mimeType: "text/markdown", sizeBytes: 900, source: "web", hasText: true, createdAt: iso(18), folderId: null, partiallyIndexed: false, aiSummary: null },
    // A podcast SCRIPT, so the Studio tab's Voices panel is reachable at all.
    // Without a file that has a `podcasts` row behind it the panel only ever
    // renders its "this page has no script attached" branch.
    { id: "f-podcast", name: "Diarization - podcast script.html", mimeType: "text/html", sizeBytes: 7400, source: "generated", hasText: true, createdAt: iso(9), folderId: null, partiallyIndexed: false, aiSummary: null },
  ];

  const folders = [
    { id: "fo-product", name: "Product" },
    { id: "fo-research", name: "Research" },
  ];

  /** Run `step` over each id and answer in the shape the batch commands really
   * return: `{ ok, failed, capped }`.
   *
   * `ok` holds NAMES, not ids, because that is what the receipt shows the user
   * — a toast reading "moved f-clean" would be the harness leaking its own
   * primary keys into a sentence meant for a person. A step that throws is
   * recorded as a named failure and the batch carries on, which is exactly the
   * best-effort contract the real commands have. */
  const bulk = (ids, step) => {
    const report = { ok: [], failed: [], capped: 0 };
    for (const id of ids || []) {
      try {
        report.ok.push(step(id));
      } catch (e) {
        report.failed.push({ name: id, error: String(e && e.message ? e.message : e) });
      }
    }
    return report;
  };

  /* The podcast behind `f-podcast`: two hosts, two DIFFERENT voices, and a
     line each so the panel's Preview speaks a host's own words rather than a
     generic sample. `audioFileId` is null — nothing recorded yet — so the
     Record button is reachable in its first state. */
  const podcast = {
    fileId: "f-podcast",
    title: "How diarization actually works",
    turns: [
      { speaker: "Ada", line: "Welcome in — today we're talking about telling voices apart." },
      { speaker: "Bo", line: "Which sounds simple until two people talk over each other." },
      { speaker: "Ada", line: "Right, and that overlap is where most of the errors live." },
    ],
    cast: [
      { name: "Ada", voice: "en-US-AvaMultilingualNeural", rate: "", pitch: "" },
      { name: "Bo", voice: "en-US-AndrewMultilingualNeural", rate: "", pitch: "" },
    ],
    audioFileId: null,
    createdAt: iso(9),
  };

  /* Trash: the Library pane's third tab. Deliberately seeded with all three
     actor kinds — a person's delete, an AI's, and one Arcelle did on its own —
     because the whole reason the actor is recorded is that those must not look
     alike, and a fixture with only "by you" rows could never show that. */
  let trashedFiles = [
    { id: "t-notes", name: "Scratch notes.md", mimeType: "text/markdown", sizeBytes: 1420, trashedAt: iso(30), trashedBy: "user", trashedById: null, folderId: null },
    { id: "t-draft", name: "Q3 draft.md", mimeType: "text/markdown", sizeBytes: 9800, trashedAt: iso(120), trashedBy: "agent", trashedById: "files.edit/write_file", folderId: "fo-product" },
    { id: "t-legacy", name: "Room summary.md", mimeType: "text/markdown", sizeBytes: 6100, trashedAt: iso(900), trashedBy: "app", trashedById: "summarize_room", folderId: null },
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
        agents: [{ agent: "files.read", label: "File agent", instruction: "What should be the core interaction model for Arcelle?" }, { agent: "chat.answer", label: "Main agent", instruction: "compose the answer" }],
      },
    },
  ];

  const docText = `# Arcelle UX direction\n\nA calmer, source-grounded workspace where navigation, writing, and assistance stay visible without competing for attention.\n\n## One workspace, three clear jobs\n\nThe interface should behave like a room rather than a stack of destinations. The library is for orientation, the editor is for the current thought, and AI is for asking or transforming. All three remain available side by side, and each can disappear completely when it is not needed.\n\n- Keep the writing surface stable while sources and AI resize around it.\n- Make AI context explicit with source checkboxes and visible citations.\n- Preserve every user layout and restore it on the next visit.\n\n> **Design rule:** Quiet does not mean hidden. Essential controls remain discoverable; secondary controls appear where the user is already looking.\n\n## Reading and writing should feel effortless\n\nUse a restrained type scale, a comfortable line length, and generous vertical rhythm. The page is the visual center. Toolbars stay compact, while frequently used actions are reachable from the keyboard and the activity rail.\n\n## Trust must be visible\n\nShow what leaves the device, what stays local, which files are informing an answer, and where every citation came from. Privacy language should describe behavior, not merely claim safety.`;

  const contents = {
    "f-direction": { kind: "markdown", name: "Arcelle UX direction.md", mime: "text/markdown", editable: true, text: docText, dataB64: null },
    "f-ideas": { kind: "markdown", name: "Ideas.md", mime: "text/markdown", editable: true, text: "# Workspace model\n\nKeep sources, the active page, and AI in one view. Make the page the visual anchor.", dataB64: null },
    "f-issues": { kind: "markdown", name: "Issues.md", mime: "text/markdown", editable: true, text: "# High priority\n\n- Navigation changes meaning between workspace and chat.\n- Source scope is invisible before sending.", dataB64: null },
    /* REAL bytes, so the PDF and .docx viewers actually render. Without
     * these two the mock has no content for them and the viewer falls back
     * to "(no preview)" — which a capture run then files away as a picture
     * of "the pdf viewer". A mislabelled screen is worse in a calibration
     * set than a missing one: it reports coverage that does not exist. */
    "f-clean": { kind: "pdf", name: "clean-code.pdf", mime: "application/pdf", editable: false, text: null, dataB64: "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nsrMp+czG6nd1G72Je4lPswe5g7xJ9kP2S+ln/mfJE+A7ctOpaawv6eWszvZD6ivBBHeNKxoYQ6SUYhnRAnxtI7jiVRg0qJTLKLI8BwHK1OcThRhhVqng7gZhAfwmOEVjLFb34WyYSW6rVL+AjA0cnWhag1br2RLteWFrvVnE2wEZONKfwCEQfsLgMH/AL8amfIdDmDv3yOL8envI3vgi3xbZDV+oCPSsQO/RmaMfJEMTd4t6B9q42r4uP4l9AHNoNtQBVqNGui1zGp2tWUj2khv4DbwL9F7mJfYMH2IOcSeZE6yZ5mzrF0EAKkpAWEgTVksjN5i7NIDJMPCEqzTK/BtDnylg2hLlzJYdJDeNFlg3rCoj/PZUewEdg67jmVZj00PnxPBilppVCPaKnPlLyqjPCglJoJYdLLEQhaYjLAIL5BVeHbJcZI7J6vuQh7Zd6V6KhO7FYQkJiCdOwT3p/p1tJ+GZd7yw5FRq38+Pm54adHdaxe40pms9la66Pq/Iq9+aNruKmoZSvhTTMnMCmpt17dQ8V3fQvnSiAO75VuoYmYIJS9eTGJ2bevcR/ITv7FlwjkaZE7fpY3kC0YHoLYE7XvEZPgSMRNWbrLhvyD6g4QWoEJUBNHiCHglJeC2b0dl8J8Ro9Ed8J94Y+E/Msj/d4xH5fC67kb3oHvRPrg7BrQMdgg2jnw/OZRsw1JL59xfPWkOae3ejsPBu0DngC5FG7AMpQ+IKIgKNBqoCqgWqB6oEeg5oBDQUaB3gc4BXYpOnJKh9AFlAalAo4GqgGqB6oEagZ4DCgEdBXoX6BzQJcIUIBnIB5QFpAKNBqoCqgWqB2oEeq6za0Ow3TgGWe5R79Wjntyjntajrn0BetP9tC8sb6pn9+jfu0c9p0d9YI/60B714T3qBT3qRT3qt/Wo396jXtqjXtajPrZH/c4edc293zTf6h7tE3vUJ/WoT+5R1/6f96b7TenRPrVHfVqP+vQe9Zk96rN61Gf3qN/fow7Cf4u8gEzdUp/boz6vR31+jzr5v+Sb5U9L2d0037oe7QTh39z/wR51yD3d3O7TPkH9f3K6EacKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgMTIKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAxMDYyIDAwMDAwIG4gCjAwMDAwMDQ3NjAgMDAwMDAgbiAKMDAwMDAwMDAyMiAwMDAwMCBuIAowMDAwMDAxMTQyIDAwMDAwIG4gCjAwMDAwMDQ3MjUgMDAwMDAgbiAKMDAwMDAwNTA1NSAwMDAwMCBuIAowMDAwMDAxMjM5IDAwMDAwIG4gCjAwMDAwMDQ4NDMgMDAwMDAgbiAKMDAwMDAwNDg5MiAwMDAwMCBuIAowMDAwMDA1NjcxIDAwMDAwIG4gCjAwMDAwMDU5MjkgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSAxMiAvUm9vdCA4IDAgUiAvSW5mbyA5IDAgUiAvSUQgWyA8ZTdhNzNkYTU4MjE1NGVhODY3MTEzNDBhZjczMWMxNDk+CjxlN2E3M2RhNTgyMTU0ZWE4NjcxMTM0MGFmNzMxYzE0OT4gXSA+PgpzdGFydHhyZWYKMTcwMjcKJSVFT0YK" },
    "f-review": { kind: "docx", name: "review-sample.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", editable: false, text: null, dataB64: "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" },
    "f-apollo": { kind: "csv", name: "Apollo missions.csv", mime: "text/csv", editable: true, text: "mission,year,crew\nApollo 7,1968,3\nApollo 8,1968,3\nApollo 11,1969,3\nApollo 13,1970,3\nApollo 17,1972,3", dataB64: null },
    "f-script": { kind: "code", name: "prepare_release.py", mime: "text/x-python", editable: true, text: "# /// script\n# room-inputs: Research/*.md\n# room-outputs: Reports/release-brief.md\n# room-timeout: 120\n# ///\n\nfrom pathlib import Path\nnotes = list(Path('Research').glob('*.md'))\nprint(len(notes))", dataB64: null },
    "f-meeting": { kind: "recording", name: "Product review.m4a", mime: "audio/mp4", editable: false, text: "[00:12] We should keep the document in the center.\n[00:41] And the AI needs to say which sources it used.", dataB64: null, mediaToken: null },
    // `mediaMeta: null` ON PURPOSE: this is the room that predates the column,
    // so opening it is what makes the viewer ask for `probe_video_meta`. That
    // on-open probe is the ONLY way an already-imported video ever fills in.
    "f-demo": { kind: "video", name: "Kickoff demo.mp4", mime: "video/mp4", editable: false, text: "[00:05] Dana: Thanks for making the time.\n[01:12] Sam: Here's what shipped this week.", dataB64: null, mediaToken: null, mediaMeta: null },
    // A saved page that declared everything: the strip above the reading shows
    // Site · Author · Published · Source · Saved, and the file's own header is
    // a LIST so it does not render as one run-on paragraph.
    "f-heron": { kind: "markdown", name: "The Heron Returns.md", mime: "text/markdown", editable: true, dataB64: null, webMeta: { title: "The Heron Returns", byline: "Dana Okafor", siteName: "The Marsh Review", published: "2026-03-04T09:12:00Z", lang: "en", sourceUrl: "https://marshreview.example/heron", capturedAt: "2026-08-03T07:20:00Z" }, text: "# The Heron Returns\n\n- Source: https://marshreview.example/heron\n- Site: The Marsh Review\n- Author: Dana Okafor\n- Published: 2026-03-04T09:12:00Z\n- Saved: 2026-08-03\n\nAfter eleven years of absence the grey heron has come back to the lower marsh, and the wardens who counted its going are counting its return with something close to disbelief.\n\n## What the counts show\n\nThree nests, then five, then eleven by the end of the season.\n" },
    // The same viewer with a page that declared NOTHING but its address: no
    // Author row, no Published row, and above all no \"unknown\".
    "f-bare": { kind: "markdown", name: "Status page.md", mime: "text/markdown", editable: true, dataB64: null, webMeta: { title: "Status page", sourceUrl: "https://status.example/", capturedAt: "2026-08-03T07:24:00Z" }, text: "# Status page\n\n- Source: https://status.example/\n- Saved: 2026-08-03\n\nAll systems normal.\n" },
  };

  const workflows = [
    { id: "w1", name: "Weekly research synthesis", description: "", emoji: "🧪", definition: { version: 1, nodes: [{ id: "n1", kind: "generate", name: "Collect weekly changes", params: { prompt: "Summarize the week" } }, { id: "n2", kind: "save_file", name: "Weekly synthesis.md", params: { name: "Weekly synthesis.md" } }], edges: [{ from: "n1", to: "n2" }] }, status: "active", createdBy: "user", binding: { scope: "general" }, pinned: true, createdAt: iso(9000), updatedAt: iso(200) },
    { id: "w2", name: "Tidy imported files", description: "", emoji: "🧹", definition: { version: 1, nodes: [{ id: "n1", kind: "generate", name: "Collect weekly changes", params: { prompt: "Summarize the week" } }, { id: "n2", kind: "save_file", name: "Weekly synthesis.md", params: { name: "Weekly synthesis.md" } }], edges: [{ from: "n1", to: "n2" }] }, status: "draft", createdBy: "agent", binding: { scope: "file", kinds: ["pdf"], exts: [], fileId: null }, pinned: false, createdAt: iso(8000), updatedAt: iso(4000) },
  ];

  const scripts = [
    { fileId: "f-script", name: "prepare_release.py", lang: "py", deps: [], inputs: ["Research/*.md"], outputs: ["Reports/release-brief.md"], shortcut: "global", approved: true, changedSinceApproval: false, workflowId: null, schedule: null, lastRun: null },
  ];

  /* One row per Activity SECTION, because the pane is now three of them
   * (decision #12): work running, work stopped and waiting for you, and the
   * history of what already happened. With only the running job the parked and
   * history sections never drew at all, so a capture run could not tell an
   * empty log from a missing one. `parkedReason` is what a job the APP stopped
   * carries — it must read differently from a Stop the user chose. */
  // The Story tab's fixtures: a cast with one face and one without, so the
  // "no face yet" state is exercised rather than only the happy one.
  let storyCast = [
    {
      id: "cast1",
      name: "Mira",
      description: "tall, grey wool coat, hair cut short",
      story: "Lost her ship in the winter. Back to find out who sold it.",
      faceFileId: "pic1",
      ord: 0,
    },
    {
      id: "cast2",
      name: "Doran",
      description: "broad, weathered, a burn scar on the left hand",
      story: "",
      faceFileId: null,
      ord: 1,
    },
  ];
  let storyLists = [
    {
      id: "list1",
      title: "The harbour",
      logline: "One night on the harbour, and a boat that should not be leaving",
      aspectRatio: "",
      stillResolution: "",
      clipResolution: "",
      shotCount: 2,
      updatedAt: new Date().toISOString(),
    },
  ];
  let storyShots = [
    {
      id: "shot1",
      listId: "list1",
      ord: 0,
      action: "Mira walks the length of the quay, counting the moorings",
      castIds: ["cast1"],
      seconds: 6,
      imageModel: "openrouter::qwen/qwen-image-3-pro",
      videoModel: "openrouter::bytedance/seedance-2.0",
      stillFileId: "pic1",
      clipFileId: null,
    },
    {
      id: "shot2",
      listId: "list1",
      ord: 1,
      action: "Doran cuts the rope as the tide turns",
      castIds: ["cast2", "cast1"],
      seconds: null,
      imageModel: "",
      videoModel: "",
      stillFileId: null,
      clipFileId: null,
    },
  ];
  // A 1x1 PNG is enough: the picker asserts that thumbnails RENDER, not what
  // they contain.
  const TINY_JPEG =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  const storyPictures = [
    { fileId: "pic1", name: "Mira on the quay.png", thumbB64: TINY_JPEG },
    { fileId: "pic2", name: "The harbour at dusk.png", thumbB64: TINY_JPEG },
  ];

  const jobs = [
    { id: "j1", kind: "deep_summary", title: "Room summary", plan: null, state: null, cursor: 3, total: 5, status: "running", error: null, parkedReason: null, createdAt: iso(2), updatedAt: iso(0) },
    { id: "j2", kind: "file_pass", title: "Full pass — Arcelle UX direction.md", plan: null, state: null, cursor: 4, total: 11, status: "paused", error: null, parkedReason: "The room was locked while this was still running.", createdAt: iso(4), updatedAt: iso(3) },
    { id: "j3", kind: "workflow", title: "Workflow — Morning digest", plan: null, state: null, cursor: 6, total: 6, status: "done", error: null, parkedReason: null, createdAt: iso(6), updatedAt: iso(5) },
  ];

  /* Skills area. One of each `createdBy`, one disabled, and one with no
   * resources — the row variants the list actually draws. Without these the
   * pane rendered blank in EVERY qa_state, so its "empty" capture was
   * indistinguishable from its "full" one. */
  const skills = [
    { id: "sk-brief", name: "Release brief", description: "Turn a week of room changes into a one-page brief.", enabled: true, createdBy: "user", agent: "", resourceCount: 2, createdAt: iso(5000), updatedAt: iso(120) },
    { id: "sk-cite", name: "Citation hygiene", description: "Check every claim in a draft against the source it cites.", enabled: true, createdBy: "agent", agent: "files.read", resourceCount: 0, createdAt: iso(3400), updatedAt: iso(900) },
    { id: "sk-hebrew", name: "Hebrew RTL cleanup", description: "Repair visual-order Hebrew pasted out of a PDF.", enabled: false, createdBy: "import", agent: "", resourceCount: 1, createdAt: iso(9000), updatedAt: iso(8000) },
  ];
  const skillInstructions = {
    "sk-brief": "# Release brief\n\nRead the week's changed files, then write one page: what shipped, what moved, what is still open.",
    "sk-cite": "# Citation hygiene\n\nFor every claim, open the cited file and quote the sentence that supports it. Flag anything you cannot ground.",
    "sk-hebrew": "# Hebrew RTL cleanup\n\nDetect visual-order Hebrew and reverse it per line before any other processing.",
  };
  const skillResources = {
    "sk-brief": [
      { path: "references/tone.md", kind: "reference", sizeBytes: 1840, text: true, updatedAt: iso(400) },
      { path: "scripts/collect.py", kind: "script", sizeBytes: 920, text: true, updatedAt: iso(400) },
    ],
    "sk-cite": [],
    "sk-hebrew": [
      { path: "references/bidi-notes.md", kind: "reference", sizeBytes: 610, text: true, updatedAt: iso(8000) },
    ],
  };

  /* Connectors area. All four status dots at once (connected local, connected
   * remote, disabled, failed-with-an-error-line) — the pane's whole visual
   * vocabulary in one screenshot. */
  const mcpServers = [
    { name: "filesystem", status: "connected", error: null, tools: ["read_file", "write_file", "list_directory"], remote: false },
    { name: "linear", status: "connected", error: null, tools: ["create_issue", "search_issues", "update_issue"], remote: true },
    { name: "sqlite", status: "disabled", error: null, tools: [], remote: false },
    { name: "weather", status: "failed", error: "spawn weather-mcp ENOENT", tools: [], remote: false },
  ];
  const mcpToolPrefs = { linear: ["update_issue"] };
  /* The per-connector overrides of the two connector powers. LIVE STATE, not a
   * snapshot: the selects on the page write through `set_mcp_connector_power`
   * below, so QA can see "in force here" actually change. Seeded with one
   * connector answering each power differently from the (off) switches above —
   * the whole point of the split is that two connectors need not agree, and a
   * fixture where they all agree would screenshot as if they still did. */
  const mcpConnectorPowers = {
    filesystem: { auto_approve: true },
    linear: { outbound_unmask: true },
  };
  const mcpCatalog = [
    { id: "io.github.modelcontextprotocol/filesystem", name: "filesystem", title: "Filesystem", icon: null, description: "Read and write files in directories you choose.", publisher: "modelcontextprotocol", verified: true, remote: false, transport: "stdio", repository: "https://github.com/modelcontextprotocol/servers", install: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], envKeys: [] }, altInstall: null },
    { id: "com.linear/linear", name: "linear", title: "Linear", icon: null, description: "Issues, projects and cycles from your Linear workspace.", publisher: "linear.app", verified: true, remote: true, transport: "http", repository: null, install: { kind: "http", url: "https://mcp.linear.app/mcp", headerKeys: ["Authorization"] }, altInstall: null },
    { id: "dev.example/sqlite", name: "sqlite", title: null, icon: null, description: "Query a local SQLite database.", publisher: "example.dev", verified: false, remote: false, transport: "stdio", repository: "https://example.dev/sqlite-mcp", install: { kind: "stdio", command: "uvx", args: ["mcp-server-sqlite"], envKeys: [] }, altInstall: null },
  ];

  /* Private browser. LIVE STATE, not a snapshot: the pages below are created,
   * navigated, selected and closed by the same commands the chrome calls, and
   * `browser_info` is DERIVED from whichever page is active — so the address
   * bar, the padlock, Save, the start screen, the tab strip and the journal all
   * tell one story instead of four.
   *
   * Before this, every browser MUTATION was unfaked: `browser_navigate`
   * returned the fallback `null`, the view assigned that straight into the
   * address bar, and the next keystroke threw on `null.trim()`. That is why
   * the Browser area was the one screen QA could not use.
   *
   * It starts with NO page, which is the real cold state — the native child
   * webview does not exist until something navigates, so a fresh room's
   * Browser area really is a start screen with the back/forward/Save buttons
   * disabled. Type an address (or press New page) and the harness walks the
   * same path the app does. What can never appear here is the page itself: it
   * is a native view floating above the DOM, so once something is loaded the
   * stage is the empty rectangle that view would be parked over. */
  const browserTabs = [];
  const browserState = { takeover: false };
  const activeTab = () => browserTabs.find((t) => t.active) ?? null;
  /** The title a page gets from its address, the way a real `<title>` reads. */
  const titleFor = (url) => {
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop();
      return `${(last || u.hostname).replace(/[-_]/g, " ")} — ${u.hostname}`;
    } catch {
      return url;
    }
  };
  const browseJournal = [
    { id: 4, at: iso(1), kind: "read", url: "https://en.wikipedia.org/wiki/Speaker_diarisation", detail: "read 3,120 words" },
    { id: 3, at: iso(2), kind: "consent", url: "https://en.wikipedia.org/wiki/Speaker_diarisation", detail: "typing allowed once" },
    { id: 2, at: iso(4), kind: "blocked", url: "https://ads.example.com/track", detail: "content blocker" },
    { id: 1, at: iso(5), kind: "open", url: "https://en.wikipedia.org/wiki/Speaker_diarisation", detail: "opened by the Web agent" },
  ];
  /** Record what the harness just did, newest first, and tell the view — the
   * journal panel refreshes on the event, not on a poll, so a row that is only
   * appended here would not appear until it was reopened. */
  const journal = (kind, url, detail) => {
    const row = { id: (browseJournal[0]?.id ?? 0) + 1, at: new Date().toISOString(), kind, url, detail };
    browseJournal.unshift(row);
    window.__qaEmit?.("browser-journal", row);
    return row;
  };

  /* Settings → Connections → AI providers, and the live catalog behind the
   * cloud tab of the engine-model picker. */
  const aiProviders = [{ id: "openrouter", label: "OpenRouter", connected: true }];
  const engineModels = {
    openrouter: [
      { slug: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", efforts: [], defaultEffort: null, contextWindow: 200000, description: "Balanced reasoning and speed.", inputPrice: "0.000003", outputPrice: "0.000015", inputModalities: ["text", "image"], tools: true, vision: true, reasoning: true, structuredOutputs: true },
      { slug: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 400000, description: "Coding-heavy work.", inputPrice: "0.00000125", outputPrice: "0.00001", inputModalities: ["text"], tools: true, vision: false, reasoning: true, structuredOutputs: true },
    ],
    "claude-cli": [
      { slug: "sonnet", label: "Sonnet (CLI default)", efforts: [], defaultEffort: null, contextWindow: 200000, description: null, inputPrice: null, outputPrice: null, inputModalities: ["text"], tools: true, vision: true, reasoning: false, structuredOutputs: false },
    ],
  };

  /* The room-role picker (Create screen + Settings → Room role). An empty list
   * hides the picker entirely, so the mock has to mirror the real roster. */
  const roles = [
    { id: "default", name: "Assistant", blurb: "A calm, careful helper grounded in your files.", instructions: "", prompts: ["Summarize this room", "What should I look at first?"], commands: ["summarize", "find"] },
    { id: "tutor", name: "Tutor", blurb: "Explains patiently and checks your understanding.", instructions: "You are a patient tutor.", prompts: ["Teach me the key ideas in this room", "Quiz me on @file"], commands: ["summarize", "research"] },
    { id: "critic", name: "Critic", blurb: "Pushes back and finds the weak points.", instructions: "You are a sharp but fair critic.", prompts: ["What's weak about @file?"], commands: ["compare", "find"] },
    { id: "opposing-counsel", name: "Opposing counsel", blurb: "Argues the other side to stress-test your case.", instructions: "You act as opposing counsel.", prompts: ["Argue against @contract"], commands: ["compare", "extract"] },
    { id: "scribe", name: "Scribe", blurb: "Turns discussion into tidy notes and minutes.", instructions: "You are a meticulous scribe.", prompts: ["Take minutes from @recording"], commands: ["minutes", "to-sheet"] },
  ];

  /* `web_provider` is ON: with the internet switch off the app hides the whole
   * browser half of the workspace — no page tabs are adopted from
   * `browser_tabs`, the tab strip's New page button is not rendered, and the
   * Browser area is a chrome bar over a start screen with nothing behind it.
   * The harness has to sit on the side of the switch where those exist. */
  const settings = { memory_auto_save: "0", autolock_minutes: "off", web_provider: "on", voice_archetype: "off", edit_approval: "off" };

  // A saved recording with a real transcript (GH #5 speaker naming). Mutable:
  // rec_set_speaker_name writes the overlay back here, so a reload inside one
  // QA run sees the names that were just set.
  const word = (w, t0, t1) => ({ w, t0, t1, del: false });
  const recSeg = (id, speaker, t0, text) => ({
    id,
    source: speaker === "You" ? "mic" : "sys",
    speaker,
    t0,
    t1: t0 + 200,
    text,
    words: text.split(" ").map((w, i, arr) =>
      word(w, t0 + Math.round((i * 200) / arr.length), t0 + Math.round(((i + 1) * 200) / arr.length)),
    ),
    lang: "en",
  });
  const recMeta = {
    name: "Product review.m4a",
    meta: {
      // No `version`: the real RecMeta has no such field. Sending one here hid
      // the divergence from the harness.
      durationCs: 900,
      cuts: [],
      maxSpeakers: 0,
      segments: [
        recSeg("s1", "Speaker 1", 0, "We should keep the document in the center"),
        recSeg("s2", "Speaker 2", 300, "And the AI needs to say which sources it used"),
        recSeg("s3", "Speaker 1", 600, "Agreed lets ship it that way"),
      ],
    },
  };

  const listeners = new Map(); // event name -> Map(handlerId -> cb)
  let cbId = 1;
  const cbs = new Map();

  // #gate → land on the start screen (no open room) to QA onboarding.
  const gateMode = location.hash === "#gate";
  /* BROWSE-3: the browser's results page. Fixtures chosen to exercise the
     states that actually differ — a five-engine consensus at the top, a
     single-engine long-tail hit, one result with NO preview image (the
     monogram fallback is a designed state, not a failure), and a dated news
     hit. The tiny inline SVG stands in for the enrich pass's data URLs. */
  const searchHits = [
    { title: "Speaker diarisation — Wikipedia", url: "https://en.wikipedia.org/wiki/Speaker_diarisation", engines: ["wikipedia", "duckduckgo", "brave", "mojeek", "ddg-ia"], date: null, snippet: "The process of partitioning an audio stream into homogeneous segments according to speaker identity — answering “who spoke when”.", score: 0.98 },
    { title: "pyannote-audio: neural speaker diarization toolkit", url: "https://github.com/pyannote/pyannote-audio", engines: ["duckduckgo", "brave", "mojeek"], date: null, snippet: "Pretrained pipelines and DER benchmarks on AMI, DIHARD and VoxConverse, with recipes for fine-tuning segmentation models.", score: 0.86 },
    { title: "DIHARD III: evaluation plan and results", url: "https://arxiv.org/abs/2012.01477", engines: ["duckduckgo", "brave"], date: "2021-02-11", snippet: "Diarization across eleven domains, from clean interviews to restaurant conversation, with track-level DER leaderboards.", score: 0.79 },
    { title: "NIST Rich Transcription evaluation series", url: "https://www.nist.gov/itl/iad/mig/rich-transcription-evaluation", engines: ["mojeek", "marginalia", "duckduckgo"], date: null, snippet: "The series that defined diarization scoring: DER, collar conventions, and the meeting-room test sets systems still report against.", score: 0.71 },
    { title: "What is speaker diarization, and how does it work?", url: "https://www.assemblyai.com/blog/speaker-diarization", engines: ["brave", "duckduckgo"], date: "2026-03-18", snippet: "The modern pipeline — VAD, embeddings, clustering, resegmentation — and the failure modes that actually move DER in production.", score: 0.64 },
    { title: "New diarization model tops the VoxSRC leaderboard", url: "https://news.ycombinator.com/item?id=44120001", engines: ["news"], date: "2026-07-28", snippet: "A sub-second streaming diarizer claims state of the art; the thread asks whether leaderboard DER survives real meeting audio.", score: 0.58 },
    { title: "Notes on TitaNet embeddings for meeting audio", url: "https://blog.fastforward.dev/titanet-meetings", engines: ["marginalia"], date: null, snippet: "Why per-frame embedding quality matters less than window purity once your audio has real crosstalk.", score: 0.51 },
    { title: "AMI Corpus — 100 hours of annotated meetings", url: "https://groups.inf.ed.ac.uk/ami/corpus/", engines: ["mojeek", "duckduckgo", "marginalia"], date: null, snippet: "Headset and distant-microphone recordings with word-level and speaker-turn annotation, free for research use.", score: 0.47 },
  ];
  const qaThumb = (hue) =>
    "data:image/svg+xml;base64," +
    btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 42%)"/><stop offset="1" stop-color="hsl(${hue + 40} 45% 22%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="240" cy="52" r="46" fill="rgba(255,255,255,.14)"/></svg>`,
    );

  // The open room's identity. Mutable so `rename_room` can actually change it
  // — the top bar reads the name back from the command's answer, so a fixture
  // that returned a constant would make a broken rename look like a working one.
  const roomInfo = {
    name: "Research Room",
    path: "/Users/ben/Research Room.roomai",
    fileCount: files.length,
    messageCount: 12,
    synced: false,
    pendingMcp: null,
  };

  const commands = {
    room_info: () => (gateMode ? null : { ...roomInfo, fileCount: files.length }),
    rename_room: (a2) => {
      const name = String(a2?.name ?? "").trim();
      if (!name) throw new Error("A room needs a name.");
      if ([...name].length > 120) throw new Error("That name is too long — 120 characters at most.");
      roomInfo.name = name;
      return { ...roomInfo, fileCount: files.length };
    },
    // Nothing failed: the honest answer is null, and the workspace shows nothing.
    take_rec_recovery_error: () => null,
    take_pending_open: () => null,
    // `openedAt` is EPOCH MILLIS, and the key is `openedAt` — the mock used to
    // send `lastOpened` as an ISO string, so the start screen's "Opened 2 hours
    // ago" line was never drawn in a QA screenshot and never reviewed.
    // `missing` is what marks a room whose file has gone.
    list_recent: () =>
      gateMode
        ? [
            { path: "/Users/ben/Research Room.roomai", name: "Research Room", openedAt: epochMs(60), missing: false },
            // One MISSING on purpose: the "File not found" row is a state the
            // start screen can now draw, and a fixture where it never appears
            // means it is never reviewed.
            { path: "/Users/ben/Journal.roomai", name: "Journal", openedAt: epochMs(2000), missing: true },
          ]
        : [],
    list_files: () => files,
    // ---- Trash / undo ----
    list_trashed_files: () => trashedFiles,
    trash_file: (a2) => {
      const i = files.findIndex((f) => f.id === a2?.id);
      if (i < 0) throw new Error("That file is not in this room.");
      const [gone] = files.splice(i, 1);
      trashedFiles = [
        { id: gone.id, name: gone.name, mimeType: gone.mimeType, sizeBytes: gone.sizeBytes, trashedAt: new Date().toISOString(), trashedBy: "user", trashedById: null, folderId: gone.folderId },
        ...trashedFiles,
      ];
      return null;
    },
    restore_file: (a2) => {
      const i = trashedFiles.findIndex((f) => f.id === a2?.id);
      if (i < 0) throw new Error("That file is not in the trash.");
      const [back] = trashedFiles.splice(i, 1);
      const meta = { id: back.id, name: back.name, mimeType: back.mimeType, sizeBytes: back.sizeBytes, source: "upload", hasText: true, createdAt: iso(500), folderId: back.folderId, partiallyIndexed: false };
      files.unshift(meta);
      return meta;
    },
    delete_file_permanently: (a2) => {
      const i = trashedFiles.findIndex((f) => f.id === a2?.id);
      if (i < 0) throw new Error("Only a file already in the trash can be deleted permanently.");
      trashedFiles.splice(i, 1);
      return null;
    },
    // Returns the number ACTUALLY destroyed, so QA can check that an empty
    // trash reports "already empty" instead of a cheerful success.
    empty_trash: () => {
      const n = trashedFiles.length;
      trashedFiles = [];
      return n;
    },

    /* ---- multi-file operations -------------------------------------------
       The batch commands return a REPORT, not nothing, and the whole point of
       that report is partial failure. So these fixtures deliberately fail one
       id — the last one — whenever more than two are asked for: a harness that
       only ever succeeds cannot show a tester what a half-done batch looks
       like, which is the state the receipt exists to describe. */
    move_file_to_folder: (a2) => {
      const f = files.find((x) => x.id === a2?.fileId);
      if (!f) throw new Error("That file is not in this room.");
      f.folderId = a2?.folderId ?? null;
      return null;
    },
    trash_files: (a2) => bulk(a2?.ids, (id) => {
      const i = files.findIndex((f) => f.id === id);
      if (i < 0) throw new Error("That file is not in this room.");
      const [gone] = files.splice(i, 1);
      trashedFiles = [
        { id: gone.id, name: gone.name, mimeType: gone.mimeType, sizeBytes: gone.sizeBytes, trashedAt: new Date().toISOString(), trashedBy: "user", trashedById: null, folderId: gone.folderId },
        ...trashedFiles,
      ];
      return gone.name;
    }),
    move_files_to_folder: (a2) => bulk(a2?.ids, (id) => {
      const f = files.find((x) => x.id === id);
      if (!f) throw new Error("That file is not in this room.");
      f.folderId = a2?.folderId ?? null;
      return f.name;
    }),
    restore_files: (a2) => bulk(a2?.ids, (id) => {
      const i = trashedFiles.findIndex((f) => f.id === id);
      if (i < 0) throw new Error("That file is not in the trash.");
      const [back] = trashedFiles.splice(i, 1);
      files.unshift({ id: back.id, name: back.name, mimeType: back.mimeType, sizeBytes: back.sizeBytes, source: "upload", hasText: true, createdAt: iso(500), folderId: back.folderId, partiallyIndexed: false });
      return back.name;
    }),
    delete_files_permanently: (a2) => bulk(a2?.ids, (id) => {
      const i = trashedFiles.findIndex((f) => f.id === id);
      if (i < 0) throw new Error("Only a file already in the trash can be deleted permanently.");
      const [gone] = trashedFiles.splice(i, 1);
      return gone.name;
    }),

    /* ---- podcast voices --------------------------------------------------
       The cast's two hosts are seeded with DIFFERENT voices on purpose. A
       fixture that gave both the same one would make the panel look right
       while hiding the exact collision the feature exists to prevent. */
    get_podcast: (a2) => (a2?.fileId === "f-podcast" ? podcast : null),
    set_podcast_cast: (a2) => {
      podcast.cast = (a2?.cast || []).map((h) => ({ ...h }));
      return podcast;
    },
    // A tiny silent WAV — enough for the panel to build a blob and "play" it,
    // without a fixture that pretends a voice was actually synthesized.
    preview_podcast_voice: () =>
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=",
    start_podcast_audio_job: () => ({
      id: "job-podcast",
      kind: "podcast_audio",
      status: "running",
      title: "Recording the episode",
      createdAt: new Date().toISOString(),
    }),
    // BROWSE-3: the browser's search half.
    browser_search: (a2) => ({
      hits: searchHits,
      merged: 31,
      tookMs: 1840,
      cached: false,
      query: (a2 && a2.query) || "speaker diarization benchmarks",
      previewsEnabled: true,
      summaryAvailable: true,
    }),
    // The enrich pass. Deliberately incomplete: the TitaNet blog gets no
    // image, so QA always sees the monogram fallback next to real previews.
    browser_preview: (a2) =>
      ((a2 && a2.urls) || []).map((url, i) => ({
        url,
        image: url.includes("fastforward") ? null : qaThumb((i * 47) % 360),
        icon: null,
        description: null,
        title: null,
        done: true,
      })),
    browser_peek: () =>
      "Speaker diarisation is the process of partitioning an audio stream containing human speech into homogeneous segments according to the identity of each speaker. It can enhance the readability of an automatic speech transcription by structuring the audio stream into speaker turns.",
    browser_search_summary: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              "Speaker diarization splits an audio stream into segments by speaker identity, and is scored with the diarization error rate [1]. Open toolkits such as pyannote publish DER benchmarks on AMI, DIHARD and VoxConverse [2], while the DIHARD III evaluation showed that conversational and restaurant audio remain by far the hardest domains [3].",
            ),
          900,
        ),
      ),
    import_search_result: (a2) => ({
      id: `f-web-${Math.random().toString(36).slice(2, 8)}`,
      name: `${((a2 && a2.title) || "result").slice(0, 40)}.md`,
      mimeType: "text/markdown",
      sizeBytes: 8400,
      source: "web",
      hasText: true,
      createdAt: new Date().toISOString(),
      folderId: null,
      partiallyIndexed: false,
    }),
    list_folders: () => folders,
    list_memories: () => memories,
    list_chats: () => chats,
    get_messages: (a2) => (a2 && a2.chatId === "c1" ? messages : []),
    list_chat_commands: () => [
      { name: "summary", summary: "Summarize the attached files", usage: "#summary" },
      { name: "minutes", summary: "Meeting minutes from a transcript", usage: "#minutes" },
    ],
    // The composer's "*" menu. Three of the fourteen AGENTS, deliberately: the
    // harness room is a local-engine room with the web ON, and a roster that
    // listed every agent would let a UI test pass against a menu the real
    // `specialist_workers` would never produce.
    //
    // One row per AGENT, not per domain — Web and Browser are two rows sharing
    // `ask_web_agent`, which is the case a menu built per domain got wrong.
    list_specialists: () => [
      { key: "file", tool: "ask_file_agent", agent: "files.read", label: "File agent", area: "this room's own files and notes", description: "Lists, searches, reads, opens, summarizes, creates and edits the files, notes and memories in this room." },
      { key: "web", tool: "ask_web_agent", agent: "chat.web", label: "Web agent", area: "searching and reading the internet", description: "Searches the internet and fetches pages to read them. It READS pages; it does not operate them." },
      { key: "browse", tool: "ask_web_agent", agent: "chat.browse", label: "Browser agent", area: "driving a real page in the private browser", description: "Opens a site in this room's private browser and OPERATES the live page: reads it, clicks, fills forms, signs in." },
    ],
    ai_status: () => ({ running: true, installed: true, models: ["qwen3.5:4b"], defaultModel: "qwen3.5:4b", external: ["claude-cli"], remoteRelay: false }),
    model_capabilities: () => [{ model: "qwen3.5:4b", tools: true, vision: false }],
    // The room's engine as ONE declared capability record. Mirrors the mock's
    // own `ai_status` (a local tool-only model), so Settings shows a coherent
    // room rather than a capability answer that contradicts the model list.
    engine_capabilities: () => ({
      engine: "ollama",
      label: "Ollama (this Mac)",
      model: "qwen3.5:4b",
      local: true,
      streaming: "yes",
      toolCalling: "yes",
      vision: "no",
      structuredOutput: "yes",
      chat: "yes",
      contextWindow: 131072,
      tier: "local-engine",
      imageReaches: true,
    }),
    // PREFLIGHT for the room's engine, and it must AGREE with
    // `engine_capabilities` above: that record says `vision: "no"`, so the real
    // command returns `blocked` with the `capability` code, not "ready". The
    // fixture said "ready" to keep the vision Download button on screen, which
    // hid a real bug — Settings was keying off `status` alone and dropped the
    // button for every blocked verdict, including this one. The code is what
    // decides: `capability` keeps the download offer, `privacy-door` replaces
    // it. Flip this to `privacy-door` to exercise the other branch.
    engine_preflight: () => ({
      status: "blocked",
      code: "capability",
      reason:
        "Ollama (this Mac) cannot look at an image — the room is set to qwen3.5:4b. " +
        "Choose a different model in Settings → Model.",
    }),
    // The published provider x agent matrix. The real one is derived from the
    // host's capability table plus the sidecar's agent registry; the harness has
    // neither, so this fixture stands in for a two-provider Mac. `agentsKnown`
    // is true here on purpose — the "sidecar unreachable" half of the section
    // is exercised by simply removing this fixture.
    engine_support_matrix: () => ({
      agentsKnown: true,
      agentsError: null,
      agents: [
        { id: "files.read", label: "File agent" },
        { id: "chat.web", label: "Web agent" },
        { id: "app.ui", label: "App agent" },
      ],
      providers: [
        {
          engine: "ollama", label: "Ollama (this Mac)", model: "", local: true,
          streaming: "yes", toolCalling: "unknown", vision: "unknown",
          structuredOutput: "yes", chat: "unknown", contextWindow: null,
          tier: "local-engine", imageReaches: true,
          available: true, agents: ["files.read", "chat.web", "app.ui"],
        },
        {
          engine: "claude-cli", label: "Claude Code", model: "", local: false,
          streaming: "no", toolCalling: "yes", vision: "no",
          structuredOutput: "no", chat: "unknown", contextWindow: null,
          tier: "cloud-engine", imageReaches: false,
          available: true, agents: ["files.read", "chat.web", "app.ui"],
        },
        {
          engine: "openrouter", label: "OpenRouter", model: "", local: false,
          streaming: "yes", toolCalling: "unknown", vision: "unknown",
          structuredOutput: "unknown", chat: "unknown", contextWindow: null,
          tier: "cloud-engine", imageReaches: false,
          available: false, agents: ["files.read", "chat.web", "app.ui"],
        },
      ],
    }),
    // Which model would mark an image for this room; null = nothing can, which
    // is what this mock room (one tool-only model) honestly reflects — so the
    // viewer's vision offer and the Settings helper row both show their
    // "nothing can see" state under the harness.
    grounding_model_for_room: () => null,
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
      connectorArgsMasked: true,
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
    get_job_step_artifact: () => null,
    // Connectors area (and the marketplace inside it).
    mcp_status: () => mcpServers,
    mcp_get_config: () => JSON.stringify({ mcpServers: {} }, null, 2),
    // The two connector powers are separate switches and both ship OFF, so the
    // harness must see two independent falses — not one answer reused.
    get_mcp_auto_approve: () => false,
    get_mcp_outbound_unmask: () => false,
    // …and the setters, which the harness omitted: without them the switch
    // flips optimistically, `invoke` answers null, and the reload-on-failure
    // path never runs — so QA could not tell a working switch from one whose
    // command name had drifted.
    set_mcp_auto_approve: () => null,
    set_mcp_outbound_unmask: () => null,
    get_mcp_connector_powers: () => JSON.stringify(mcpConnectorPowers),
    set_mcp_connector_power: (a2) => {
      const name = (a2 && a2.server) || "";
      const power = (a2 && a2.power) || "";
      const entry = { ...(mcpConnectorPowers[name] ?? {}) };
      // `null` clears the override back to "follow the switch above" — an
      // ABSENT key, never a false, which is the distinction the whole
      // per-connector layer rests on.
      if (a2 && (a2.value === true || a2.value === false)) entry[power] = a2.value;
      else delete entry[power];
      if (Object.keys(entry).length) mcpConnectorPowers[name] = entry;
      else delete mcpConnectorPowers[name];
      return JSON.stringify(mcpConnectorPowers);
    },
    mcp_get_tool_prefs: () => JSON.stringify(mcpToolPrefs),
    mcp_registry_optin_status: () => true,
    mcp_registry_search: (a2) => {
      const q = ((a2 && a2.query) || "").toLowerCase();
      return mcpCatalog.filter((e) => !q || (e.title ?? e.name).toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
    },
    mcp_oauth_status: () => false,
    // AUDIT 506: the drawer's "Sign out". Answers the fresh status list the
    // real command returns, so clicking it in the harness exercises the same
    // path the app does instead of throwing.
    mcp_oauth_sign_out: () => mcpServers,
    // Skills area.
    list_skills: () => skills,
    get_skill: (a2) => {
      const found = skills.find((sk) => sk.id === (a2 && a2.id));
      if (!found) return null;
      // SkillBundle.skill is a Skill: the summary WITHOUT resourceCount, plus
      // the instructions body the detail pane edits.
      const { resourceCount: _n, ...summary } = found;
      return { skill: { ...summary, instructions: skillInstructions[found.id] ?? "" }, resources: skillResources[found.id] ?? [] };
    },
    get_skill_resource: (a2) => ({ path: (a2 && a2.path) || "", kind: "reference", text: "# Reference\n\nA short skill resource.", dataB64: null }),
    /* Private browser. The page is a native child webview, so the one thing
     * this mock cannot produce is the page itself; everything the chrome reads
     * and writes around it is real state here. Mirrors the Rust commands:
     * `browser_navigate`/`browser_new_tab` return the SETTLED url / the new tab
     * id (the view assigns the return value straight into the address bar and
     * the tab strip), the rest return null.
     *
     * The AGENT's tools (`browse_open`, `browse_click`, `browse_screenshot`,
     * `browse_save`, the SoM numbering) are deliberately absent: they are not
     * Tauri commands the frontend invokes at all — they reach Rust through the
     * sidecar's MCP bridge, which does not exist in this harness. Agent
     * behaviour is faked in the `ask` branch below instead. */
    browser_info: () => {
      const t = activeTab();
      // No page, no webview — the same `{ open: false }` Rust answers before
      // anything has navigated, which is what disables the chrome buttons.
      if (!t) return { open: false };
      return {
        open: true,
        blank: !t.url,
        url: t.url || null,
        title: t.url ? t.title : null,
        ready: t.url ? "complete" : null,
        takeover: browserState.takeover,
        // Item #18: only a real double Escape inside the native page sets
        // this, and there is no native page here. Present and false, exactly
        // as Rust reports it, so the view's branch is exercised as a no-op
        // rather than left undefined.
        leaveRequested: false,
      };
    },
    browser_tabs: () => browserTabs,
    /* Item #18: the reading view. The mock has no page to extract, so this
     * returns the same SHAPE with fixture prose — a list and a table included,
     * because those are the two structures the extractor was fixed to emit and
     * the two a screen reader most depends on. `truncated: false` means the
     * "showing the first N of M" line stays off, which is the honest state for
     * text this short. */
    browser_page_text: (a2) => {
      const t = activeTab();
      if (!t || !t.url) throw new Error("The browser isn't open — there is no page to read.");
      const text =
        `# ${titleFor(t.url).split(" — ")[0]}\n\n` +
        "The page as text, extracted by the same reader the assistant uses.\n\n" +
        "- first point\n- second point\n- third point\n\n" +
        "| column | value |\n| --- | --- |\n| one | 1 |\n| two | 2 |\n\n" +
        `[A link on the page](${t.url})\n`;
      return {
        ok: true,
        url: t.url,
        title: t.title,
        mode: (a2 && a2.mode) === "full" ? "full" : "main",
        offset: 0,
        nextOffset: text.length,
        total: text.length,
        truncated: false,
        text,
      };
    },
    // Moving the window's first responder is a native act with no meaning in a
    // plain browser; the command must still exist or the escape route throws.
    browser_focus_app: () => null,
    browser_journal: (a2) => browseJournal.slice(0, (a2 && a2.limit) || browseJournal.length),
    browser_verify_private: () => true,
    // Bounds are pushed several times a second by the view's ResizeObserver.
    // Nothing to park in a plain browser, but it must not be an unhandled
    // command: that alone made every Browser-area capture and spec suspect.
    browser_set_bounds: () => null,
    // The address bar. Same normalisation as Rust (bare host → https), and the
    // same refusal for the addresses `browse_guard_url` rejects, so QA sees the
    // real error banner rather than a navigation that silently "works".
    browser_navigate: (a2) => {
      const raw = String((a2 && a2.url) || "").trim();
      const url = raw.includes("://") ? raw : `https://${raw}`;
      if (/^https?:\/\/(localhost|127\.|0\.|10\.|192\.168\.|\[?::1)/i.test(url)) {
        throw new Error(`Blocked ${url} — that address points at this Mac or a private network.`);
      }
      // `browser::ensure` creates the page when there isn't one, so the first
      // address typed into a cold browser has to open it rather than fail.
      let t = activeTab();
      if (!t) {
        t = { id: "bt" + Math.random().toString(36).slice(2, 7), title: "", url: "", active: true };
        browserTabs.push(t);
      }
      t.url = url;
      t.title = titleFor(url);
      journal("open", url, "Opened by the user");
      window.__qaEmit?.("browser-navigated", url);
      return url;
    },
    browser_new_tab: (a2) => {
      const raw = String((a2 && a2.url) || "").trim();
      const url = raw && !raw.includes("://") ? `https://${raw}` : raw;
      const tab = { id: "bt" + Math.random().toString(36).slice(2, 7), title: url ? titleFor(url) : "New tab", url, active: true };
      for (const t of browserTabs) t.active = false;
      browserTabs.push(tab);
      journal("open", url || "about:blank", "Opened by the user in a new tab");
      return tab.id;
    },
    browser_select_tab: (a2) => {
      const id = a2 && a2.id;
      if (!browserTabs.some((t) => t.id === id)) throw new Error("That page is already closed.");
      for (const t of browserTabs) t.active = t.id === id;
      return null;
    },
    browser_close_tab: (a2) => {
      const i = browserTabs.findIndex((t) => t.id === (a2 && a2.id));
      if (i < 0) return null;
      const [gone] = browserTabs.splice(i, 1);
      // Closing the ACTIVE page has to leave some page active, or the chrome
      // reads "no browser" while a tab is still on screen.
      if (gone.active && browserTabs.length) browserTabs[browserTabs.length - 1].active = true;
      return null;
    },
    // back / forward / reload / stop. There is no history to walk without a
    // real page; what QA checks here is that the buttons report rather than
    // silently do nothing, and that an unknown action still errors.
    browser_go: (a2) => {
      const action = (a2 && a2.action) || "";
      if (!["back", "forward", "reload", "stop"].includes(action)) {
        throw new Error(`Unknown browser action: ${action}`);
      }
      return null;
    },
    browser_set_takeover: (a2) => {
      browserState.takeover = !!(a2 && a2.on);
      journal("takeover", "", browserState.takeover ? "User took over the browser" : "User handed the browser back");
      return null;
    },
    browser_clear_journal: () => {
      browseJournal.length = 0;
      return null;
    },
    // BROWSE-2: the Save strip. Returns the same sentence the Rust command
    // does — the view prints it verbatim in the notice banner.
    browser_save_page: (a2) => {
      const t = activeTab();
      if (!t || !t.url) throw new Error("No page is open.");
      const stem = titleFor(t.url).split(" — ")[0].slice(0, 40) || "page";
      // The sentence names what was really saved: the ARTICLE when one could be
      // extracted, and the metadata the page actually declared. The mock has a
      // page with both, so it says so — a mock that claimed an article for a
      // page with none would be teaching the harness the wrong sentence.
      return (a2 && a2.what) === "selection"
        ? `Saved the selected text as "${stem} (selection).md".`
        : `Saved the readable article as "${stem}.md" (searchable) and "${stem}.html" (formatted). ` +
            `Kept from the page: Example · by A. Writer · published 2026-01-09.`;
    },
    // The other two buttons on that same strip — Save link and Download video.
    // Faked here because a Save strip where half the buttons throw is not the
    // strip the app ships.
    import_link: (a2) => ({
      id: `f-link-${Math.random().toString(36).slice(2, 8)}`,
      name: `${titleFor(String((a2 && a2.url) || "")).split(" — ")[0].slice(0, 40) || "link"}.md`,
      mimeType: "text/markdown",
      sizeBytes: 6200,
      source: "web",
      hasText: true,
      createdAt: new Date().toISOString(),
      folderId: null,
      partiallyIndexed: false,
    }),
    // The notice this returns to sends the user to the Activity view for the
    // job's card, so the job has to actually be there when they look.
    start_download_job: (a2) => {
      const job = {
        id: "j" + Math.random().toString(36).slice(2, 8),
        kind: "download",
        title: String((a2 && a2.url) || "Download").slice(0, 60),
        plan: null,
        state: null,
        cursor: 0,
        total: 1,
        status: "running",
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.push(job);
      return job.id;
    },
    // The Create page. A stocked shelf AND a populated "why not" list, because
    // the exclusions are half of what the page is for — a fixture with only
    // the models would let the ledger regress unnoticed.
    list_create_models: () => ({
      models: [
        {
          model: "openrouter::qwen/qwen-image-3-pro",
          slug: "qwen/qwen-image-3-pro",
          label: "Qwen Image 3 Pro",
          engine: "openrouter",
          engineLabel: "OpenRouter",
          local: false,
          description: "Highest-fidelity Qwen image model — holds legible text.",
          image: true,
          video: false,
          outputPrice: "0.00004",
          limits: {
            durations: [],
            resolutions: ["1K", "2K"],
            aspectRatios: ["1:1", "16:9"],
            frameImages: [],
            maxReferences: 4,
            generateAudio: false,
          },
        },
        {
          model: "openrouter::krea/krea-2-large",
          slug: "krea/krea-2-large",
          label: "Krea 2 Large",
          engine: "openrouter",
          engineLabel: "OpenRouter",
          local: false,
          description: "Photoreal lean, strong on lighting and material detail.",
          image: true,
          video: false,
          outputPrice: "0.00003",
          limits: null,
        },
        {
          model: "openrouter::bytedance/seedance-2.0",
          slug: "bytedance/seedance-2.0",
          label: "Seedance 2.0",
          engine: "openrouter",
          engineLabel: "OpenRouter",
          local: false,
          description: "Holds a scene together while the camera moves.",
          image: false,
          video: true,
          outputPrice: "0.0006",
          // The real published shape: legal lengths only, and both frame
          // slots — so the bench offers 4–15s and a starting picture.
          limits: {
            durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            resolutions: ["480p", "720p", "1080p", "4K"],
            aspectRatios: ["16:9", "9:16", "1:1"],
            frameImages: ["first_frame", "last_frame"],
            maxReferences: null,
            generateAudio: true,
          },
        },
      ],
      scanned: 34,
      excluded: [
        {
          engineLabel: "OpenRouter",
          reason: "Text output only, per the provider's own catalog.",
          count: 29,
          examples: ["deepseek/deepseek-v4", "moonshot/kimi-k3"],
        },
        {
          engineLabel: "Claude Code",
          reason: "Reads pictures, cannot make them — vision in, no image out.",
          count: 1,
          examples: ["Claude Code"],
        },
        {
          engineLabel: "Ollama (this Mac)",
          reason:
            "Serves chat models. A drawing model is not reachable over its chat API at all.",
          count: 1,
          examples: ["Ollama (this Mac)"],
        },
      ],
      anyProvider: true,
      error: null,
    }),
    start_create_job: (a2) => {
      const job = {
        id: "j" + Math.random().toString(36).slice(2, 8),
        kind: "create",
        title: `Painting “${String((a2 && a2.prompt) || "").slice(0, 30)}”`,
        plan: null,
        state: null,
        cursor: 0,
        total: 100,
        status: "running",
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.push(job);
      return job.id;
    },
    // ---- the Story tab: a room's cast and its shot lists ----
    story_pictures: () => storyPictures,
    // The room already HOLDS the script and the character sheet. These are
    // what stop the Story tab asking for either to be typed in again.
    story_documents: () => [
      {
        fileId: "f-script",
        name: "Episode 1 — The First Echo.md",
        words: 1240,
        snippet:
          "**00:00–00:15** — Establishing Lumina. Noa weaves through the market stalls.",
      },
      {
        fileId: "f-cast",
        name: "Characters.md",
        words: 310,
        snippet: "## Mira Halloran — tall, grey wool coat, hair cut short.",
      },
    ],
    story_text_from_file: (a2) =>
      (a2 && a2.fileId) === "f-cast"
        ? "## Mira Halloran\nTall, grey wool coat.\n"
        : [
            "**00:00–00:15** — Establishing Lumina. Noa weaves through the market stalls.",
            "",
            "**00:15–00:30** — A fruit-seller's hand closes on empty air.",
            "",
            "**00:30–00:40** — Noa jolts back into her own body, gasping.",
          ].join("\n"),
    story_read_cast_file: (a2) => ({
      // Which reader produced these. Shown on screen, because the model and
      // the fallback are not equally good on a messy sheet.
      readBy: "qwen3.5:4b",
      fellBack: null,
      name: (a2 && a2.fileId) === "f-cast" ? "Characters.md" : "Episode 1 — The First Echo.md",
      found:
        (a2 && a2.fileId) === "f-cast"
          ? [
              {
                name: "Mira Halloran",
                description: "Tall, grey wool coat, hair cut short.",
                story: "Lost her ship in the winter.",
              },
              {
                name: "Doran",
                description: "Broad, weathered, salt-stained oilskin.",
                story: "Harbourmaster for thirty years.",
              },
            ]
          : // A script is not a character sheet, and the honest answer is
            // nobody — never one invented hero, which would be believed.
            [],
    }),
    story_add_cast_many: (a2) => {
      const members = (a2 && a2.members) || [];
      for (const m of members)
        storyCast.push({
          id: "cast" + (storyCast.length + 1),
          name: m.name,
          description: m.description,
          story: m.story,
          faceFileId: null,
          ord: storyCast.length,
        });
      return members.length;
    },
    story_board: (a2) => {
      const selected =
        (a2 && a2.listId) || (storyLists[0] ? storyLists[0].id : null);
      return {
        cast: storyCast,
        lists: storyLists,
        shots: storyShots.filter((s2) => s2.listId === selected),
        selected,
      };
    },
    story_add_cast: (a2) => {
      const member = {
        id: "cast" + (storyCast.length + 1),
        name: (a2 && a2.name) || "Someone",
        description: (a2 && a2.description) || "",
        story: (a2 && a2.story) || "",
        faceFileId: null,
        ord: storyCast.length,
      };
      storyCast.push(member);
      return member;
    },
    story_update_cast: (a2) => {
      const member = storyCast.find((c) => c.id === (a2 && a2.id));
      if (member) Object.assign(member, {
        name: a2.name,
        description: a2.description,
        story: a2.story,
      });
      return null;
    },
    story_set_face: (a2) => {
      const member = storyCast.find((c) => c.id === (a2 && a2.id));
      if (member) member.faceFileId = (a2 && a2.fileId) || null;
      return null;
    },
    story_remove_cast: (a2) => {
      storyCast = storyCast.filter((c) => c.id !== (a2 && a2.id));
      return null;
    },
    story_create_list: (a2) => {
      const id = "list" + (storyLists.length + 1);
      storyLists.unshift({
        id,
        title: (a2 && a2.title) || "Untitled",
        logline: (a2 && a2.logline) || "",
        aspectRatio: "",
        stillResolution: "",
        clipResolution: "",
        shotCount: 0,
        updatedAt: new Date().toISOString(),
      });
      return id;
    },
    story_update_list: (a2) => {
      const list = storyLists.find((l) => l.id === (a2 && a2.id));
      if (list) Object.assign(list, { title: a2.title, logline: a2.logline });
      return null;
    },
    story_delete_list: (a2) => {
      storyLists = storyLists.filter((l) => l.id !== (a2 && a2.id));
      return null;
    },
    story_add_shot: (a2) => {
      const shot = {
        id: "shot" + (storyShots.length + 1),
        listId: (a2 && a2.listId) || "list1",
        ord: storyShots.length,
        action: (a2 && a2.action) || "",
        castIds: [],
        seconds: null,
        imageModel: "",
        videoModel: "",
        stillFileId: null,
        clipFileId: null,
      };
      storyShots.push(shot);
      return shot;
    },
    story_update_shot: (a2) => {
      const shot = storyShots.find((s2) => s2.id === (a2 && a2.id));
      if (shot) Object.assign(shot, {
        action: a2.action,
        castIds: a2.castIds || [],
        seconds: a2.seconds ?? null,
        imageModel: a2.imageModel || "",
        videoModel: a2.videoModel || "",
      });
      return null;
    },
    story_remove_shot: (a2) => {
      storyShots = storyShots.filter((s2) => s2.id !== (a2 && a2.id));
      return null;
    },
    story_reorder_shots: () => null,
    // The five-minute-episode path: a script cut into fixed-length shots.
    // The Sketch page. `create_sketch` hands back a file row the Library will
    // list; the drawing itself is loaded and saved through the ordinary file
    // commands, which the harness already fakes.
    create_sketch: (a2) => {
      const name = String((a2 && a2.name) || "Sketch").replace(/\.sketch$/i, "");
      return {
        id: `sketch-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: `${name}.sketch`,
        mimeType: "application/json",
        sizeBytes: 96,
        source: "upload",
        hasText: false,
        createdAt: new Date().toISOString(),
        folderId: null,
        partiallyIndexed: false,
        originUrl: null,
        aiSummary: null,
      };
    },
    save_sketch: () => null,
    export_sketch_svg: () => ({
      id: "sketch-export-svg",
      name: "Sketch.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 1200,
      source: "generated",
      hasText: true,
      createdAt: new Date().toISOString(),
      folderId: null,
      partiallyIndexed: false,
      originUrl: null,
      aiSummary: null,
    }),
    story_plan_split: (a2) => {
      const script = String((a2 && a2.script) || "");
      // A script that marks its own chunks is taken at its word — the same
      // rule the real splitter follows, so the harness exercises both paths.
      const marks = [...script.matchAll(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/g)];
      if (marks.length >= 2) {
        const shots = marks.map((m, i) => {
          const start = +m[1] * 60 + +m[2];
          const end = +m[3] * 60 + +m[4];
          const from = m.index + m[0].length;
          const to = i + 1 < marks.length ? marks[i + 1].index : script.length;
          return {
            action: script.slice(from, to).replace(/[*#]/g, "").replace(/\s+/g, " ").trim(),
            seconds: Math.max(1, end - start),
          };
        });
        return {
          parts: shots.length,
          totalSeconds: shots.reduce((n, s2) => n + s2.seconds, 0),
          shots,
          fromScript: true,
        };
      }
      const each = (a2 && a2.secondsEach) || 15;
      const parts = Math.max(1, Math.ceil((((a2 && a2.minutes) || 0) * 60) / each));
      const words = script.split(/\s+/).filter(Boolean);
      const per = Math.max(1, Math.ceil(words.length / parts));
      const shots = [];
      for (let i = 0; i < parts; i++)
        shots.push({ action: words.slice(i * per, (i + 1) * per).join(" "), seconds: each });
      return { parts, totalSeconds: parts * each, shots, fromScript: false };
    },
    story_apply_split: (a2) => {
      const planned = (a2 && a2.shots) || [];
      let lastCastIds = [];
      for (const { action, seconds } of planned) {
        storyShots.push({
          id: "shot" + (storyShots.length + 1),
          listId: (a2 && a2.listId) || "list1",
          ord: storyShots.length,
          action,
          // Mirrors `assign_cast`: a name in the shot's words puts that person
          // in it, and a shot naming nobody inherits the one before.
          castIds: (() => {
            const here = storyCast
              .filter((c) => {
                const first = c.name.split(/\s+/)[0];
                return new RegExp(`\\b(${c.name}|${first})\\b`, "i").test(action);
              })
              .map((c) => c.id);
            if (here.length) {
              lastCastIds = here;
              return here;
            }
            return lastCastIds.slice();
          })(),
          seconds: seconds || 15,
          imageModel: (a2 && a2.imageModel) || "",
          videoModel: (a2 && a2.videoModel) || "",
          stillFileId: null,
          clipFileId: null,
        });
      }
      return planned.length;
    },
    // The review sheet: what the run WOULD do, before any of it is billed.
    // Mirrors the Rust — every shot appears, sent or skipped, and a skipped
    // one carries its reason.
    story_film_plan: (a2) => {
      const kind = (a2 && a2.kind) || "video";
      const video = kind === "video";
      const chain = !a2 || a2.continuous !== false;
      const listId = (a2 && a2.listId) || "list1";
      const mine = storyShots.filter((s2) => s2.listId === listId);
      const shots = mine.map((shot, i) => {
        const model = video ? shot.videoModel : shot.imageModel;
        const made = video ? shot.clipFileId : shot.stillFileId;
        const next = mine[i + 1];
        let skip = null;
        if (made) skip = video ? "already filmed" : "already drawn";
        else if (!model) skip = video ? "no clip model chosen" : "no picture model chosen";
        return {
          shotId: shot.id,
          n: i + 1,
          action: shot.action,
          prompt: [storyLists.find((l) => l.id === listId)?.logline, shot.action]
            .filter(Boolean)
            .join(". "),
          seconds: skip ? shot.seconds : (video ? shot.seconds || 15 : null),
          model: (model || "").split("::")[1] || model || "",
          startFileId: !skip && video ? shot.stillFileId : null,
          endFileId: !skip && video && chain && next ? next.stillFileId : null,
          referenceFileIds: [],
          cast: shot.castIds
            .map((id) => storyCast.find((c) => c.id === id)?.name)
            .filter(Boolean),
          // A hero with no portrait is drawn from words alone and comes out a
          // different person every call — the thing that is invisible until
          // twenty clips have been paid for.
          faceless: shot.castIds
            .map((id) => storyCast.find((c) => c.id === id))
            .filter((c) => c && !c.faceFileId)
            .map((c) => c.name),
          joinDropped: null,
          // Mirrors the Rust rule INCLUDING the skip gates: a skipped row
          // promises nothing, and a skipped PREDECESSOR (no model) hands
          // nothing forward.
          startsOnPrevious:
            !skip &&
            video &&
            chain &&
            i > 0 &&
            (!!mine[i - 1].clipFileId ||
              (!!mine[i - 1].videoModel && !mine[i - 1].clipFileId)),
          skip,
        };
      });
      const sending = shots.filter((s2) => !s2.skip);
      return {
        kind,
        shots,
        sending: sending.length,
        skipped: shots.length - sending.length,
        totalSeconds: sending.reduce((n, s2) => n + (s2.seconds || 0), 0),
        joined: sending.filter((s2) => s2.startsOnPrevious).length,
        joinBlockedBy: null,
        faceless: [
          ...new Set(sending.flatMap((s2) => s2.faceless)),
        ],
        overCap: sending.length > 80,
      };
    },
    story_set_shape: (a2) => {
      const list = storyLists.find((l) => l.id === (a2 && a2.id));
      if (list)
        Object.assign(list, {
          aspectRatio: a2.aspectRatio,
          stillResolution: a2.stillResolution,
          clipResolution: a2.clipResolution,
        });
      return null;
    },
    // Returns the shape the real command does: what STARTED, what was ASKED
    // for, and the shortfall between them. A bare id list is what let a
    // 21-shot run report "11" with nothing to compare it against.
    start_shot_list_job: (a2) => {
      const listId = (a2 && a2.listId) || "list1";
      const video = ((a2 && a2.kind) || "video") === "video";
      const asked = storyShots.filter(
        (s2) =>
          s2.listId === listId &&
          (video ? s2.videoModel && !s2.clipFileId : s2.imageModel && !s2.stillFileId),
      ).length;
      return {
        jobIds: Array.from({ length: asked }, (_, i) => "j-shot-" + (i + 1)),
        asked,
        shortfall: null,
      };
    },
    // Settings → Connections → AI providers, and the picker's cloud catalog.
    list_ai_providers: () => aiProviders,
    list_engine_models: (a2) => engineModels[(a2 && a2.engine) || ""] ?? [],
    web_search_test: () => "Working ✓ — 8 results. Top hit: Speaker diarisation — Wikipedia (via wikipedia · relevance 0.94)",
    // The room-role picker (Create screen + Settings → Room role).
    list_roles: () => roles,
    memory_suggestion: () => ({ worth: true, fact: "Ben prefers release briefs under one page" }),
    get_file_content: (a2) => contents[a2?.id] ?? { kind: "text", name: "unknown", mime: "text/plain", editable: false, text: "(no preview)", dataB64: null },
    // The viewer's encoding strip. The fixture room's files are all UTF-8, so
    // the honest answer is the boring one — and `chosen` when the harness picks
    // an encoding, because the strip must say a pick took effect. The text is
    // handed back unchanged: this mock has no bytes to re-read, and inventing a
    // "re-decoded" string would fake the one thing the feature exists to do.
    decode_file_text: (a2) => ({
      text: contents[a2?.id]?.text ?? "",
      encoding: a2?.encoding ?? "UTF-8",
      source: a2?.encoding ? "chosen" : "utf8",
      lossy: false,
      editable: contents[a2?.id]?.editable ?? false,
      options: [
        { name: "UTF-8", title: "Unicode (UTF-8)" },
        { name: "windows-1252", title: "Western European (Windows 1252)" },
        { name: "windows-1254", title: "Turkish (Windows 1254 / ISO-8859-9)" },
      ],
    }),
    // The waveform's envelope. A synthetic speech-shaped curve rather than a
    // flat line, so the browser harness exercises the real drawing path
    // (regions, legend, hover) instead of an empty lane.
    audio_peaks: () => ({
      peaks: Array.from({ length: 600 }, (_, i) =>
        Math.abs(Math.sin(i / 9) * Math.sin(i / 71)) * (i % 97 < 12 ? 0.06 : 1),
      ),
      duration: 372,
      // The curve above crosses the host's noise floor, so this fixture is a
      // track WITH signal — the "no audio signal" label must not appear here.
      silent: false,
    }),
    // A video that states MOST of itself but not all of it — the interesting
    // case for the technical strip, because `frameRate: null` is what has to
    // render as "unknown" rather than as a plausible number.
    probe_video_meta: () => ({
      durationSecs: 372,
      width: 1920,
      height: 1080,
      videoCodec: "H.264",
      frameRate: null,
      bitrateKbps: 1354,
      hasAudio: true,
      audioCodec: "AAC",
    }),
    // Trim writes a NEW file and leaves the original alone; the receipt names
    // the file the room actually stored, so the fixture has to name one too.
    // Without it the button threw "no fixture" and the whole trim path — the
    // one the packet exists for — was untestable in this harness.
    video_trim: (a2) => ({
      id: `f-trim-${Math.random().toString(36).slice(2, 8)}`,
      name: `Kickoff demo (trim ${stampFor(a2 && a2.startSecs)} to ${stampFor(a2 && a2.endSecs)}).mp4`,
      mimeType: "video/mp4",
      sizeBytes: 6_400_000,
      source: "generated",
      hasText: false,
      createdAt: new Date().toISOString(),
      folderId: null,
      partiallyIndexed: false,
    }),
    save_video_frame: (a2) => ({
      id: `f-still-${Math.random().toString(36).slice(2, 8)}`,
      name: `Kickoff demo @ ${stampFor(a2 && a2.atSecs)}.png`,
      mimeType: "image/png",
      sizeBytes: 1_900_000,
      source: "generated",
      hasText: false,
      createdAt: new Date().toISOString(),
      folderId: null,
      partiallyIndexed: false,
    }),
    // QuickLook is a system service the harness has no access to; "this Mac
    // can't draw it either" is the honest fixture and the viewer's own
    // no-preview path is what gets exercised.
    quicklook_preview: () => null,
    // In-place .docx save. Mirrors the Rust command's ONE refusal the UI has
    // to render: paragraphs may be reworded, not added or removed.
    update_docx_text: (a2) => {
      const before = (contents[a2?.id]?.text ?? "").split("\n").filter((l) => l.trim());
      const after = String(a2?.content ?? "").split("\n").filter((l) => l.trim());
      if (before.length !== after.length) {
        throw new Error(
          `This editor can change the wording of a Word file's paragraphs, but not add or remove them — the document has ${before.length} and the edited text has ${after.length}.`,
        );
      }
      if (contents[a2?.id]) contents[a2.id] = { ...contents[a2.id], text: after.join("\n") };
      return files.find((f) => f.id === a2?.id) ?? files[0];
    },
    list_file_versions: () => [],
    // The rolling window the History strip now STATES, plus its per-version
    // Keep/Delete. The harness only has to answer them; the strip's own empty
    // case is what this fixture room exercises.
    file_versions_kept: () => 10,
    pin_file_version: () => null,
    delete_file_version: () => null,
    // The Skills screen's owner picker asks the host for the roster rather than
    // carrying its own copy.
    skill_agent_ids: () => [
      "files.read",
      "scripts.run",
      "chat.web",
      "chat.browse",
      "app.ui",
      "jobs.run",
      "jobs.workflows",
      "skills.use",
      "skills.author",
      "connectors.admin",
      "connectors.use",
      "media.transcribe",
      "media.video",
      "creator.studio",
    ],
    skill_import_conflict: () => null,
    // ART-1: what produced the open file's current content. `null` is the honest
    // answer for this fixture room — its files were imported, not generated — so
    // the History strip shows no attribution line, which is the case that must
    // look right first.
    get_file_provenance: () => null,
    get_file_version: () => ({ fileName: "Ideas.md", versionText: "# Workspace model\n\nKeep sources and AI in one view.", currentText: contents["f-ideas"].text }),
    search_all: (a2) => ({
      files: files.filter((f) => f.name.toLowerCase().includes((a2?.query ?? "").toLowerCase())).map((f) => ({ id: f.id, name: f.name, snippet: "…" })),
      messages: [],
      memories: [],
    }),
    rec_live_status: () => null,
    // A finished, transcribed meeting: two voices, one of them speaking twice
    // — enough to prove that naming a speaker renames EVERY line they said.
    rec_get: (a2) => ({ name: recMeta.name, meta: recMeta.meta }),
    // GH #5. Mirrors the Rust command: an overlay keyed by the machine label,
    // empty name clears it, and the segments are never rewritten.
    rec_set_speaker_name: (a2) => {
      const { speaker, name } = a2 ?? {};
      // The two refusals the real command has and this stand-in used to skip,
      // so a UI that sent either was "passing" under QA.
      if (!String(speaker ?? "").trim()) throw new Error("No speaker selected.");
      if (recMeta.meta.segments.length === 0) {
        throw new Error("That recording has no transcript yet.");
      }
      if (!recMeta.meta.segments.some((s) => s.speaker === speaker)) {
        throw new Error(`Nobody in this recording is labelled "${speaker}".`);
      }
      const clean = String(name ?? "").trim().slice(0, 60);
      const names = { ...(recMeta.meta.speakerNames ?? {}) };
      if (!clean || clean === speaker) delete names[speaker];
      else names[speaker] = clean;
      recMeta.meta = { ...recMeta.meta, speakerNames: names };
      return recMeta.meta;
    },
    // Typed links, in the REAL GraphEdge shape (a/b/weight/kind/directed/shared)
    // — this used to mock a {from,to,why} shape the app has never sent, so the
    // map rendered nothing under QA and nobody could tell.
    room_graph: () => ({
      nodes: files.slice(0, 6).map((f) => ({ id: f.id, name: f.name, kind: "file" })),
      edges: [
        { a: "f-direction", b: "f-ideas", weight: 1, kind: "derived", directed: true, shared: [] },
        { a: "f-direction", b: "f-review", weight: 0.7, kind: "cited", directed: false, shared: ["cited together in 2 answers"] },
        { a: "f-ideas", b: "f-review", weight: 0.45, kind: "similar", directed: false, shared: ["roadmap", "quarter"] },
      ],
    }),
    studio_prompts: () => ({ flashcards: "Make flashcards", mindmap: "Make a mind map", podcast: "Write a podcast script" }),
    ai_action_prompts: () => [],
    warm_model: () => null,
    create_chat: () => ({ id: "c" + Math.random().toString(36).slice(2), title: "New chat", createdAt: new Date().toISOString() }),
    touchid_has: () => false,
    has_recovery_key: () => false,
    get_workflow_runs: () => [],
    get_workflow_schedule: () => null,
    set_workflow_schedule: () => null,
    validate_workflow: () => [],
    get_workflow: (a2) => workflows.find((w) => w.id === a2?.id) ?? null,
    // A real AppDiag shape (the FeedbackModal reads .version/.os/.arch/.repo
    // and builds the GitHub URL from them) — a bare string used to leave
    // `repo` undefined and the modal's primary button permanently dead.
    app_diag: () => ({ version: "0.11.0-qa", os: "macOS 26.3", arch: "aarch64", repo: "benrben/private-room" }),
    // Owner replacement #1: Settings → Updates & version reveals the log folder.
    // The mock returns the path the real command returns without touching Finder.
    reveal_logs: () => "/var/folders/qa/T",
    feedback_draft: (a2) => ({
      title: (a2?.text ?? "").slice(0, 48) || "Untitled issue",
      body: `## What happened\n\n${a2?.text ?? ""}`,
    }),
    list_room_checkpoints: () => ({ entries: [{ id: "ck1", name: "Checkpoint — Jul 18", createdAt: iso(1440), sizeBytes: 18_000_000, auto: false }], totalBytes: 18_000_000 }),
    stt_status: () => ({ installed: true, downloading: false, sizeMb: 620 }),
    // Nothing is downloading under QA, and the honest answer to "stop it" is
    // that there was nothing to stop.
    stt_cancel_download: () => false,
    room_server_status: () => ({ running: false, url: "", config: "", scope: "files", stable: false, allowCloud: false }),
    // The Settings picker's live catalog (dynamic in the real app — a tiny
    // fixed sample here keeps the grouped select renderable offline).
    list_neural_voices: () => [
      { id: "en-US-AndrewMultilingualNeural", gender: "Male", locale: "en-US" },
      { id: "en-US-AvaMultilingualNeural", gender: "Female", locale: "en-US" },
      { id: "he-IL-AvriNeural", gender: "Male", locale: "he-IL" },
      { id: "he-IL-HilaNeural", gender: "Female", locale: "he-IL" },
    ],
    // Voice QA: a tiny valid silent WAV so decodeAudioData succeeds and the
    // auto-speak pipeline schedules real (inaudible) audio end-to-end.
    // (Neural is the only engine — the app never calls anything else.)
    speak_text_neural: () => {
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
    // Streaming dictation (start → push → stop) is the ONLY dictation path the
    // app has; the old send-the-whole-clip `transcribe_audio` is still a Rust
    // command but no screen calls it, so faking it here only implied a route
    // that is gone. Without these three the composer mic throws, and the error
    // toast then sits on top of the button the next click needs.
    dict_start: () => null,
    dict_push_audio: () => null,
    dict_cancel: () => null,
    // First stop yields a follow-up (drives one hands-free auto-send loop),
    // later stops yield silence so the QA run terminates.
    dict_stop: () => {
      window.__qaDictStops = (window.__qaDictStops || 0) + 1;
      return window.__qaDictStops === 1 ? "and a follow-up question" : "";
    },
    recommended_models: () => ({ vision: "qwen2.5vl:3b", embed: "nomic-embed-text" }),
    get_ollama_url: () => "",
    // Token-budget bar QA: a context-compaction marker, appended so the next
    // get_messages reflects it in place (ChatPane renders it as a divider).
    handoff_chat: () => {
      const marker = {
        id: "msg-handoff-" + Math.random().toString(36).slice(2),
        role: "assistant",
        content:
          "**Recap:** The user asked about the core interaction model for Arcelle. " +
          "The assistant recommended a persistent three-part workspace — source " +
          "library, focused editor, and contextual AI — with visible citations and " +
          "reversible layout.",
        sources: [],
        createdAt: new Date().toISOString(),
        effects: {
          usage: {
            total_tokens: 340,
            max_context: 24576,
            estimated: true,
            breakdown: {
              system: { tokens: 120, estimated: true },
              history: { tokens: 180, estimated: true },
              tools: { tokens: 20, estimated: true },
              skills: { tokens: 10, estimated: true },
              files: { tokens: 10, estimated: true },
            },
          },
        },
        kind: "handoff",
      };
      messages.push(marker);
      return marker;
    },
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
      if (fn) {
        if (QA_STATE !== "full" && isRead(cmd)) {
          if (QA_STATE === "empty") return emptied(await fn(args));
          // A promise that never settles is what "still loading" actually is;
          // a slow timeout would race the screenshot instead of pinning it.
          if (QA_STATE === "loading") return new Promise(() => {});
          if (QA_STATE === "error") throw new Error(`${cmd} failed: room unavailable`);
        }
        return fn(args);
      }
      if (cmd.startsWith("list_")) return noteUnhandled(cmd, []);
      if (cmd === "ask" || cmd === "run_command") {
        window.__qaAsks = (window.__qaAsks || 0) + 1;
        // Owner replacement #4: the host wraps every ask-* event in
        // { runId, chatId, v } so a conversation can reject events that are not
        // its own. The mock has to speak the same wire — with bare payloads the
        // composer treats them as belonging to nobody, and a QA run that
        // switched chats would show exactly the bug this replaced.
        const turn = { runId: args?.askId ?? null, chatId: args?.chatId ?? null };
        const askEmit = (event, v) => window.__qaEmit(event, { ...turn, v });
        (window.__qaAskLog = window.__qaAskLog || []).push(args?.question ?? args?.text ?? "?");
        // Dispatch-first agent visibility: roster + active-agent walk, so the
        // agent strip (done/active/queued chips) is exercised in browser QA.
        // Hub v3: the roster GROWS as the Main agent delegates.
        // Dispatch-first agent visibility, hub v3 with PARALLEL delegation:
        // every `ask-plan` is a complete snapshot in which each entry carries
        // its own status, its dispatch `batch` and a unique `key`. This script
        // reproduces the case a flat strip cannot draw — three children live at
        // once, finishing out of order — plus a second batch afterwards, so the
        // band grouping and the "then" sequencing are both on screen.
        const N = (agent, label, instruction, status, batch, key) =>
          ({ agent, label, instruction, status, batch, key });
        const MAIN = (status) =>
          N("chat.answer", "Main agent", "answer the user from the specialists' reports", status, null, "main");
        const KIDS = [
          N("files.read", "File agent", "read the lease and pull the rent clause", "running", 0, "files.read#0"),
          N("chat.web", "Web agent", "check the current market rate for the area", "running", 0, "chat.web#1"),
          N("jobs.run", "Jobs agent", "how is the translation pass going", "running", 0, "jobs.run#2"),
        ];
        const snap = (statuses, extra = []) => {
          const kids = KIDS.map((k, i) => ({ ...k, status: statuses[i] }));
          const all = [...kids, ...extra];
          const running = all.map((e, i) => (e.status === "running" ? i + 1 : 0)).filter(Boolean);
          const plan = [...all, MAIN(running.length ? "pending" : "running")];
          askEmit("ask-plan", plan);
          const step = running[0] ?? plan.length;
          askEmit("ask-agent", {
            id: plan[step - 1].agent, label: plan[step - 1].label,
            step, total: plan.length, active_steps: running.length ? running : [step],
          });
        };
        const at = (ms, fn) => setTimeout(fn, ms);
        // window.__qaSolo drives the OTHER shape a turn can take: the Main
        // agent answers alone, delegating nothing. That turn has no graph to
        // draw and must still render the plain one-chip strip it always did.
        if (window.__qaSolo) {
          at(80, () => {
            askEmit("ask-plan", [MAIN("running")]);
            askEmit("ask-agent", { id: "chat.answer", label: "Main agent", step: 1, total: 1, active_steps: [1] });
          });
          at(150, () => askEmit("ask-delta", "Answering directly. "));
          return new Promise((resolve) =>
            setTimeout(() => resolve({ id: "msg-solo", role: "assistant", content: "Answering directly.", sources: [], createdAt: new Date().toISOString(), effects: null }), Number(window.__qaTurnMs) || 4200));
        }
        at(80, () => {
          askEmit("ask-plan", [MAIN("running")]);
          askEmit("ask-agent", { id: "chat.answer", label: "Main agent", step: 1, total: 1, active_steps: [1] });
        });
        // The batch is dispatched: three children light up together.
        at(500, () => {
          snap(["running", "running", "running"]);
          for (const k of KIDS) askEmit("ask-step", { label: `Asked the ${k.label}`, node: "main" });
        });
        // Their tool traffic interleaves — each step names the node that ran it.
        at(700, () => askEmit("ask-step", { label: "Searched the room", node: "files.read#0" }));
        at(820, () => askEmit("ask-step", { label: "Searched the web", node: "chat.web#1" }));
        at(900, () => askEmit("ask-step-status", { ok: true, node: "files.read#0" }));
        at(980, () => askEmit("ask-step", { label: "Checked job status", node: "jobs.run#2" }));
        at(1100, () => askEmit("ask-step", { label: "Opened Lease.pdf", node: "files.read#0" }));
        at(1200, () => askEmit("ask-step-status", { ok: false, node: "chat.web#1" }));
        // Out-of-order completion: the Jobs agent finishes first, the Web agent
        // fails, the File agent is still working. This frame is the feature.
        at(1400, () => snap(["running", "running", "done"]));
        at(1900, () => snap(["running", "failed", "done"]));
        at(2400, () => snap(["done", "failed", "done"]));
        // A SECOND round dispatches one more child: its own batch, its own band.
        at(2900, () => {
          const later = N("connectors.use", "Connector agent", "send the summary to Slack", "running", 1, "connectors.use#3");
          snap(["done", "failed", "done"], [later]);
          askEmit("ask-step", { label: "Asked the Connector agent", node: "main" });
        });
        at(3600, () =>
          snap(["done", "failed", "done"], [
            N("connectors.use", "Connector agent", "send the summary to Slack", "done", 1, "connectors.use#3"),
          ]),
        );
        // Pretend a short streamed answer, so Send visibly works in QA.
        setTimeout(() => askEmit("ask-delta", "Thinking about your sources… "), 150);
        setTimeout(() => askEmit("ask-delta", "here is a grounded answer."), 450);
        // Token-budget bar QA: a live per-turn snapshot, growing a bit each ask
        // so repeated sends visibly fill the bar.
        window.__qaTurns = (window.__qaTurns || 0) + 1;
        const base = 4200 + window.__qaTurns * 900;
        setTimeout(
          () =>
            askEmit("ask-token-usage", {
              round: 0,
              total_tokens: base,
              max_context: 24576,
              estimated: window.__qaTurns % 3 === 0,
              breakdown: {
                system: { tokens: 620, estimated: true },
                history: { tokens: Math.round(base * 0.62), estimated: true },
                tools: { tokens: Math.round(base * 0.18), estimated: true },
                skills: { tokens: Math.round(base * 0.06), estimated: true },
                files: { tokens: Math.round(base * 0.06), estimated: true },
              },
            }),
          650,
        );
        return new Promise((resolve) =>
          setTimeout(() => resolve({ id: "msg-live", role: "assistant", content: "Thinking about your sources… here is a grounded answer.", sources: ["Ideas.md"], createdAt: new Date().toISOString(), effects: null }), Number(window.__qaTurnMs) || 4200),
        );
      }
      return noteUnhandled(cmd, null);
    },
  };

  // Hands-free QA: a synthetic mic (oscillator → MediaStream) so dictation
  // runs headless without fake-device launch flags.
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      // GH #4: every constraint set we ask for, in order. The e2e spec asserts
      // on this — autoGainControl must never be requested, because on macOS it
      // rides the shared input device's real gain and other apps on the same
      // microphone hear it as their own volume dropping.
      (window.__qaMicConstraints = window.__qaMicConstraints || []).push(
        constraints?.audio,
      );
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
