import { RoomInfo } from "../api";

export type RoomRole = {
  id: string;
  name: string;
  blurb: string;
  instructions: string;
  prompts: string[];
  commands: string[];
};

export type Screen =
  | { kind: "start" }
  | { kind: "create"; path: string }
  | { kind: "unlock"; path: string }
  | { kind: "workspace"; info: RoomInfo };

export const ROOM_FILTER = [{ name: "Private Room Project", extensions: ["roomai"] }];

export const MIN_PASSWORD = 8;

// THE SEAL — one deliberate ritual in both directions (see seal.css).
// Unlock blooms the keyhole open before the workspace mounts; lock seals it
// shut before returning to the gate. These durations MUST match the CSS
// (--seal-unlock-dur / --seal-lock-dur) so the overlay is removed exactly as
// its animation lands. Reduced motion skips the motion entirely — the
// lock/unlock still happens, just instantly.
export const SEAL_UNLOCK_MS = 520;
export const SEAL_LOCK_MS = 460;

// ADD-15 — Room templates.
// Plain frontend data: each template pre-fills the room's custom
// instructions, a couple of starter memories, and a Welcome.md note.
// Applied AFTER create_room succeeds using ordinary APIs, so everything
// a template makes is normal, editable content — no special machinery.
// "Blank" is the default and seeds nothing (a room exactly like today).
export type RoomTemplate = {
  key: string;
  label: string;
  // One-line description shown under the template pills so choosing one isn't
  // a leap of faith about what it pre-fills.
  blurb: string;
  customInstructions: string;
  memories: string[];
  welcome: string;
  // Extra starter files beyond Welcome.md (used by the demo tour). Each is
  // saved through save_generated_file exactly like Welcome.md, so they are
  // ordinary, editable room files.
  files?: { name: string; content: string }[];
};

export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    key: "blank",
    label: "Blank",
    blurb: "An empty room. Add anything and set it up your own way.",
    customInstructions: "",
    memories: [],
    welcome: "",
  },
  {
    key: "legal",
    label: "Legal",
    blurb: "Contracts and letters — flags deadlines, obligations, odd clauses.",
    customInstructions:
      "This room holds legal documents and correspondence. Answer plainly " +
      "and cite the exact file and clause you are drawing from. Flag " +
      "deadlines, obligations, and anything that looks unusual. You are " +
      "not a lawyer and do not give legal advice — when something has real " +
      "consequences, say so and suggest checking with a professional.",
    memories: [
      "This room is for keeping and understanding legal paperwork.",
      "Prefer quoting the document over paraphrasing when wording matters.",
      "Always note dates, deadlines, and who is responsible for what.",
    ],
    welcome:
      "# Welcome to your Legal room\n\n" +
      "A quiet, private place for contracts, letters, and anything with " +
      "fine print. Nothing here leaves your computer.\n\n" +
      "## What to add here\n\n" +
      "- Contracts and agreements (leases, employment, services)\n" +
      "- Letters and notices you have sent or received\n" +
      "- Terms, policies, and any document you want to actually understand\n\n" +
      "## Three questions to try\n\n" +
      "1. What are my main obligations and deadlines in this contract?\n" +
      "2. Summarize this letter in plain language.\n" +
      "3. Are there any unusual or one-sided clauses I should notice?\n",
  },
  {
    key: "medical",
    label: "Medical",
    blurb: "Health records — plain-language explanations, tracks dates and meds.",
    customInstructions:
      "This room holds personal medical records and notes. Explain terms " +
      "in plain, calm language and always point to the file a fact comes " +
      "from. Help track dates, results, and medications. You are not a " +
      "doctor and do not diagnose — for anything worrying, encourage the " +
      "person to speak with a clinician.",
    memories: [
      "This room is for personal health records and understanding them.",
      "Explain medical terms simply, without alarm.",
      "Keep track of test dates, results, and medications when they appear.",
    ],
    welcome:
      "# Welcome to your Medical room\n\n" +
      "A private place to keep and make sense of your health records. " +
      "Everything stays on this computer.\n\n" +
      "## What to add here\n\n" +
      "- Test and lab results, scans, and doctor's letters\n" +
      "- Medication lists and prescriptions\n" +
      "- Notes from appointments and questions for next time\n\n" +
      "## Three questions to try\n\n" +
      "1. What do the results in this report mean, in plain words?\n" +
      "2. List every medication mentioned across my files.\n" +
      "3. What questions should I bring to my next appointment?\n",
  },
  {
    key: "research",
    label: "Research",
    blurb: "Papers and sources — compares, summarizes, cites every claim.",
    customInstructions:
      "This room is for research and reading. Help gather, compare, and " +
      "summarize sources, and always cite the file behind each claim. When " +
      "sources disagree, say so rather than smoothing it over. Keep a clear " +
      "line between what a source states and your own reasoning.",
    memories: [
      "This room is for collecting and thinking through research material.",
      "Cite the source file for every claim.",
      "When sources conflict, surface the disagreement plainly.",
    ],
    welcome:
      "# Welcome to your Research room\n\n" +
      "A calm workspace for papers, articles, and notes on a topic you " +
      "care about. Read, compare, and connect — all offline.\n\n" +
      "## What to add here\n\n" +
      "- Papers, PDFs, and saved web pages\n" +
      "- Your own notes, outlines, and questions\n" +
      "- Anything you want to compare, summarize, or cite later\n\n" +
      "## Three questions to try\n\n" +
      "1. Summarize the key findings across these documents.\n" +
      "2. Where do these sources agree, and where do they disagree?\n" +
      "3. What questions are still open based on what I have here?\n",
  },
  {
    key: "journal",
    label: "Journal",
    blurb: "A private diary — a warm listener that notices patterns over time.",
    customInstructions:
      "This room is a personal journal. Be a warm, unhurried listener. " +
      "Help reflect, notice patterns over time, and find past entries when " +
      "asked. Never judge. Keep everything private and gentle in tone.",
    memories: [
      "This room is a private personal journal.",
      "Respond with warmth and without judgement.",
      "Help notice themes and patterns across entries over time.",
    ],
    welcome:
      "# Welcome to your Journal\n\n" +
      "A private space to write, reflect, and look back. No one else can " +
      "read this — it lives only on your computer.\n\n" +
      "## What to add here\n\n" +
      "- Daily or occasional entries, however long or short\n" +
      "- Thoughts, plans, gratitude, or things weighing on you\n" +
      "- Photos or notes you want to remember\n\n" +
      "## Three questions to try\n\n" +
      "1. What themes come up most often in my entries?\n" +
      "2. How was I feeling around last month?\n" +
      "3. Find the entry where I wrote about a particular day or event.\n",
  },
  {
    key: "demo",
    label: "Demo",
    blurb: "A guided sample room — a few files to try highlighting and #extract.",
    customInstructions:
      "This is a demo room with a couple of sample files about a small " +
      "project called Aurora. Answer questions from those files and always " +
      "cite the file you used. Keep replies short and warm, and feel free to " +
      "point out features like text highlighting and the #extract command.",
    memories: [
      "This is a demo room for exploring Private Room.",
      "The sample files describe a small project called Aurora.",
    ],
    welcome:
      "# Welcome to your demo room\n\n" +
      "A tiny, self-contained tour of Private Room. Everything here is just " +
      "ordinary content — edit or delete any of it. Nothing leaves your Mac.\n\n" +
      "## Try these three things\n\n" +
      "1. Open **Project Brief.md** and select a sentence — a highlight menu " +
      "appears. Highlights are saved in the room as quick references.\n" +
      "2. In the chat, type **#extract owner, due date, budget from " +
      "@Project Brief.md** to pull those fields into a clean table.\n" +
      "3. Ask a plain question like *\"What is the launch date?\"* and watch " +
      "it answer from these files, with a citation.\n",
    files: [
      {
        name: "Project Brief.md",
        content:
          "# Project Brief — Aurora\n\n" +
          "**Owner:** Dana Whitfield  \n" +
          "**Due date:** 2026-09-15  \n" +
          "**Budget:** $48,000  \n" +
          "**Status:** In planning\n\n" +
          "## Summary\n\n" +
          "Aurora is a small, private tool for keeping personal documents " +
          "searchable offline. The first release targets macOS only.\n\n" +
          "## Goals\n\n" +
          "- Ship a working macOS build by the due date above.\n" +
          "- Keep everything on-device — no accounts, no cloud.\n" +
          "- Make search feel instant across a few thousand documents.\n\n" +
          "## Open questions\n\n" +
          "- Do we bundle the model, or ask the user to install it?\n" +
          "- What is the smallest useful set of file types to support first?\n",
      },
      {
        name: "Kickoff Notes.md",
        content:
          "# Kickoff notes — 2026-07-02\n\n" +
          "Present: Dana Whitfield, Marcus Lee, Priya Anand.\n\n" +
          "- Dana confirmed the launch date of 2026-09-15 and the $48,000 " +
          "budget.\n" +
          "- Marcus will own the importer; Priya takes search and " +
          "highlighting.\n" +
          "- Decision: macOS first, Windows deferred to a later release.\n" +
          "- Action: Priya to draft the highlighting UX by next week.\n\n" +
          "> \"If it isn't private by default, it isn't worth building.\" " +
          "— Dana\n",
      },
    ],
  },
];
