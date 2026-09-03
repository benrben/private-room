import type { AgentNodeStatus } from "../apiTypes";

/** Mirror of the sidecar's `agents.REGISTRY` descriptions (agents.py), for the
 * inspector. Duplicated rather than fetched on purpose: the app is offline-first
 * and this is stable copy, not state — a round trip to render a tooltip would be
 * the wrong trade. Anything missing degrades to the label alone. */
export const AGENT_DESCRIPTIONS: Record<string, string> = {
  "chat.answer":
    "The user's single interlocutor: calls specialist agents for anything that needs the room or tools, answers directly what it knows, and composes every final answer itself.",
  "files.read":
    "Read, search, open and edit the room's files — the default specialist.",
  "scripts.run":
    "See and run this room's .py/.js scripts (the user approves each new one).",
  "chat.web": "Find or fetch current information from the internet.",
  "chat.browse":
    "Open and operate a web page in the private browser — navigate, read, click and fill in.",
  "app.ui": "See and operate this app's own interface for the user.",
  "app.design":
    "Collaborate on the app's visual skin — fonts, colours, canvas, shape, spacing, motion and layout.",
  "jobs.run":
    "Cover an ENTIRE file with a durable background job; report job status.",
  "jobs.workflows": "Author, test, schedule or run saved multi-step workflows.",
  "skills.use": "Find, read and run Agent Skills.",
  "skills.author":
    "Create, modify or delete Agent Skills (drafts, human-reviewed).",
  "connectors.admin":
    "Inspect or configure MCP connector integrations (drafts only).",
  "connectors.use":
    "Reach the user's connected third-party tools (email, calendar, chat…).",
  "media.transcribe": "Transcribe or re-transcribe audio/video on-device.",
  "media.video": "Watch a room video: look at what is on screen at a moment.",
  "creator.studio":
    "Generate flashcards, mind maps or podcast scripts from room content.",
  "creator.draw":
    "Draws on this room's sketches, then measures its own work and corrects it",
};

export const GLYPH: Record<AgentNodeStatus, string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  failed: "⚠",
};
export const STATUS_WORD: Record<AgentNodeStatus, string> = {
  pending: "queued",
  running: "running",
  done: "done",
  failed: "failed",
};

export function elapsedLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms - m * 60_000) / 1000)}s`;
}

export interface Edge {
  key: string;
  status: AgentNodeStatus;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dx: number;
  label: string;
  /** Where the edge label sits — just above and left of the child it points
   * at, so labels stack one per row and never collide with a spoke. */
  lx: number;
  ly: number;
}

/** Cheap structural equality, so re-measuring an unchanged layout commits no
 * state. Sub-pixel jitter is rounded away: `getBoundingClientRect` returns
 * fractional values that can flip on a scrollbar appearing, and a 0.01px
 * difference must not count as "the graph moved". */
function sameEdgePosition(a: Edge, b: Edge): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return (
    near(a.x1, b.x1) && near(a.y1, b.y1) && near(a.x2, b.x2) && near(a.y2, b.y2)
  );
}

function sameEdge(a: Edge, b: Edge | undefined): boolean {
  return (
    !!b &&
    a.key === b.key &&
    a.status === b.status &&
    a.label === b.label &&
    sameEdgePosition(a, b)
  );
}

export function sameEdges(a: Edge[], b: Edge[]): boolean {
  return (
    a.length === b.length && a.every((edge, index) => sameEdge(edge, b[index]))
  );
}
