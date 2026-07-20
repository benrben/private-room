import {
  BookOpenIcon,
  CalendarCheckIcon,
  CompareIcon,
  FilesIcon,
  InboxIcon,
  ListFilterIcon,
  SparklesIcon,
  SunriseIcon,
  WorkflowsIcon,
} from "../../icons";
import { ComponentType } from "react";
import { IconProps } from "../../icons/types";

/** A workflow's stored `emoji` field is kept only as a stable string key: the UI
 * never renders the emoji itself, it maps the key to one quiet line icon so the
 * whole surface reads as a single professional icon family. Unknown/custom keys
 * fall back to the generic workflow mark. */
type IconCmp = ComponentType<IconProps>;

/** Strip the emoji variation selector so "⚖️" (with U+FE0F) and "⚖" both match. */
const norm = (e: string) => e.replace(/️/g, "").trim();

const GLYPHS: Record<string, IconCmp> = {};
(
  [
    ["🌅", SunriseIcon],
    ["📥", InboxIcon],
    ["📅", CalendarCheckIcon],
    ["📖", BookOpenIcon],
    ["⚖️", CompareIcon],
    ["🗂️", FilesIcon],
    ["🧭", ListFilterIcon],
    ["✨", SparklesIcon],
    ["⚙️", WorkflowsIcon],
  ] as [string, IconCmp][]
).forEach(([e, cmp]) => {
  GLYPHS[norm(e)] = cmp;
});

/** The curated set offered by the workflow icon picker (label = accessible name). */
export const WORKFLOW_ICON_CHOICES: { key: string; label: string }[] = [
  { key: "⚙️", label: "Workflow" },
  { key: "🌅", label: "Sunrise" },
  { key: "📥", label: "Inbox" },
  { key: "📅", label: "Calendar" },
  { key: "📖", label: "Read" },
  { key: "⚖️", label: "Compare" },
  { key: "🗂️", label: "Files" },
  { key: "🧭", label: "Triage" },
  { key: "✨", label: "Sparkle" },
];

/** Render the line icon for a workflow's stored key (defaults to the workflow mark). */
export function WorkflowGlyph({
  emoji,
  size = 18,
  className,
}: {
  emoji?: string | null;
  size?: number;
  className?: string;
}) {
  const Cmp = (emoji && GLYPHS[norm(emoji)]) || WorkflowsIcon;
  return <Cmp size={size} className={className} />;
}
