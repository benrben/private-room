import type { SkillResourceMeta } from "../../api";

export type SkillDraft = {
  name: string;
  description: string;
  instructions: string;
  /** The one specialist this skill is offered to. "" = every agent (general).
   * It was invisible here before: an imported skill's owner could not be seen
   * and could not be corrected without hand-editing the folder. */
  agent: string;
};

export const STARTER = `# Purpose

Follow this workflow when the skill applies.

## Workflow

1. Inspect the user's request and relevant room context.
2. Apply the specialized procedure.
3. Verify the result before replying.`;

/** What the host will actually store: `validate_skill_name` lowercases and
 * turns spaces and underscores into hyphens, so "Review Contracts" was saved
 * as `review-contracts` and the field only admitted it after a reload. It
 * TRIMS first, so a leading space is not a hyphen there and must not become
 * one here — that would refuse a name the host accepts. */
export const normalizeSkillName = (value: string) =>
  value.toLowerCase().replace(/[ _]/g, "-").replace(/^-+/, "");

export function pathLabel(path: string) {
  const parts = path.split("/");
  return { folder: parts.length > 1 ? parts.slice(0, -1).join("/") : "root", name: parts.at(-1) ?? path };
}

/* -------------------------------------------------------------- skill state
   A skill card has to be able to say what state it is in without the reader
   decoding a colour, so every flag is a marker MEANING plus a word:

     Enabled        green   done      the assistant can reach it
     Draft          yellow  pending   saved, but not offered to anyone yet
     Incomplete     red     urgent    a real fault, not a stage — a skill with
                                      no trigger sentence can never be chosen,
                                      so it is inert however enabled it looks
     Unknown owner  red     urgent    bound to a specialist this app does not
                                      have, which is the same silent inertness

   These are the four states the brief names, and each one is DERIVED from the
   data rather than invented: nothing here can light up for a condition the
   room cannot actually be in. */
export type SkillFlag = { key: string; word: string; mark: string; why: string };

/** `instructions` is optional because the list only has SkillSummary, which
 * carries no body — the editor passes it and gets the fuller answer. */
export function skillFlags(
  skill: { enabled: boolean; description: string; agent: string; instructions?: string },
  agentIds: string[],
): SkillFlag[] {
  const flags: SkillFlag[] = [skill.enabled ? enabledSkillFlag() : draftSkillFlag()];
  if (skillIsIncomplete(skill)) flags.push(incompleteSkillFlag());
  const ownerFlag = unknownOwnerFlag(skill.agent, agentIds);
  if (ownerFlag) flags.push(ownerFlag);
  return flags;
}

function enabledSkillFlag(): SkillFlag {
  return {
    key: "on",
    word: "Enabled",
    mark: "nb-sem-done",
    why: "Its description is offered to the assistant, so it can choose this skill.",
  };
}

function draftSkillFlag(): SkillFlag {
  return {
    key: "draft",
    word: "Draft",
    mark: "nb-sem-pending",
    why: "Saved in this room, but not offered to the assistant yet.",
  };
}

function skillIsIncomplete(skill: { description: string; instructions?: string }): boolean {
  return !skill.description.trim() || (skill.instructions !== undefined && !skill.instructions.trim());
}

function incompleteSkillFlag(): SkillFlag {
  return {
    key: "incomplete",
    word: "Incomplete",
    mark: "nb-sem-urgent",
    why: "A skill needs a description to be chosen and instructions to follow. This one is missing at least one of them.",
  };
}

function unknownOwnerFlag(agent: string, agentIds: string[]): SkillFlag | null {
  if (!agent || agentIds.length === 0 || agentIds.includes(agent)) return null;
  return {
    key: "owner",
    word: "Unknown owner",
    mark: "nb-sem-urgent",
    why: `Offered to "${agent}", which is not a specialist this app has, so nothing can use it.`,
  };
}

function skillNameProblem(name: string): string | null {
  if (name.length <= 64 && !name.startsWith("-") && !name.endsWith("-") && /^[a-z0-9-]+$/.test(name)) return null;
  return "Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.";
}

export function skillProblems(draft: SkillDraft | null): string[] {
  if (!draft) return [];
  const problems: string[] = [];
  const name = draft.name.trim();
  if (!name) problems.push("Give the skill a name.");
  const nameProblem = name ? skillNameProblem(name) : null;
  if (nameProblem) problems.push(nameProblem);
  if (!draft.description.trim()) problems.push("Describe what the skill does and when the assistant should use it.");
  return problems;
}

/* ---------------------------------------------------------- folder contents
   A skill is a real portable folder, and what is IN it is the interesting
   part — so the folder pane groups by what each file is for rather than
   listing a flat pile. Only the groups a skill actually has are drawn: four
   permanent empty slots would tell the reader a one-file skill is missing
   three things it was never supposed to have. */
export const KIND_ORDER = ["reference", "script", "asset", "agent", "resource"] as const;
export type ResKind = (typeof KIND_ORDER)[number];
export const KIND_LABEL: Record<ResKind, string> = {
  reference: "References",
  script: "Scripts",
  asset: "Assets",
  agent: "Agents",
  resource: "Other files",
};
const KNOWN_KINDS = new Set<string>(KIND_ORDER);
/** Exhaustive on purpose: a kind the host adds later still renders, under
 * "Other files", instead of disappearing out of a pane that claims to be the
 * folder's contents. */
export const kindOf = (r: SkillResourceMeta): ResKind =>
  KNOWN_KINDS.has(r.kind) ? (r.kind as ResKind) : "resource";

/** The empty state's worked example: one realistic skill folder drawn as an
 * index card.
 *
 * It must be impossible to mistake for something installed, so it carries
 * four independent signals — a dashed pencil border (the system's mark for a
 * provisional boundary), a tape label reading "Example", a caption that says
 * in words that it is not installed, and no interactive element at all, which
 * also puts it out of the tab order. */
