import { ReactNode, useEffect, useRef, useState } from "react";
import type { WorkflowBinding } from "../api";

/** A single generic shortcut. Idea 13 (Scripts) will reuse this shape. */
export type QuickAction = {
  id: string;
  label: string;
  icon?: ReactNode; // a line icon (or any node)
  hint?: string;
  disabled?: boolean;
  onRun: () => void;
};

type Props = {
  actions: QuickAction[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  buttonLabel: string;
  buttonIcon: ReactNode;
  /** Render the first N actions as direct buttons; the rest live in the menu. */
  inlineMax?: number;
  /** A trailing menu item, e.g. "All workflows…" jump-to-page. */
  footer?: { label: string; onClick: () => void };
  /** Render the trigger as a round emoji pill (top bar) vs a subtle text button. */
  pill?: boolean;
};

type MenuLayout = {
  inline: QuickAction[];
  menuItems: QuickAction[];
  showTrigger: boolean;
  total: number;
};

type FileWorkflowBinding = Extract<WorkflowBinding, { scope: "file" }>;

/** Does a file-scoped workflow binding match the open file? Pure + unit-testable.
 * `file_id` pins one file; otherwise a `kinds` or `exts` (suffix) match. A general
 * binding never matches a file header. */
export function bindingMatches(
  binding: WorkflowBinding | undefined | null,
  kind: string,
  name: string,
  fileId: string,
): boolean {
  const fileBinding = fileScopedBinding(binding);
  if (!fileBinding) return false;
  const fileIdMatch = boundFileIdMatch(fileBinding.file_id, fileId);
  if (fileIdMatch !== null) return fileIdMatch;
  if (boundKindsMatch(fileBinding.kinds, kind)) return true;
  return boundExtensionsMatch(fileBinding.exts, name);
}

function fileScopedBinding(
  binding: WorkflowBinding | undefined | null,
): FileWorkflowBinding | null {
  if (!binding || binding.scope !== "file") return null;
  return binding;
}

function boundFileIdMatch(boundFileId: string | null | undefined, fileId: string): boolean | null {
  if (!boundFileId) return null;
  return boundFileId === fileId;
}

function boundKindsMatch(kinds: string[] | undefined, kind: string): boolean {
  return (kinds ?? []).includes(kind);
}

function boundExtensionsMatch(extensions: string[] | undefined, name: string): boolean {
  const lowerName = name.toLowerCase();
  return (extensions ?? []).some((extension) =>
    lowerName.endsWith(normalizedExtension(extension).toLowerCase()),
  );
}

function normalizedExtension(extension: string): string {
  return extension.startsWith(".") ? extension : `.${extension}`;
}

/** A generic shortcut container: inline direct buttons + an overflow popover.
 * Renders NOTHING when there are no actions and no footer (zero footprint). */
export function QuickActionsMenu({
  actions,
  open,
  onOpenChange,
  buttonLabel,
  buttonIcon,
  inlineMax,
  footer,
  pill,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Whether the menu was open on the previous render, so closing can hand
  // focus back WITHOUT the first render stealing it from whatever has it.
  const wasOpen = useRef(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const layout = menuLayout(actions, inlineMax, footer);

  // The menu takes focus on open (below), so it owes it back on close: it
  // unmounts while a menu item holds focus, which drops focus on <body> and
  // restarts the next Tab at the top of the document. Escape, a chosen item
  // and the backdrop all end here.
  useEffect(() => {
    if (open) {
      setFocusIdx(0);
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      // Only reclaim what the menu DROPPED. A chosen item can open a dialog or
      // a page that focuses something itself, and that focus commits before
      // this effect runs — pulling it back to the trigger would be the same
      // defect pointed the other way.
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items?.[focusIdx]?.focus();
  }, [open, focusIdx]);

  if (actions.length === 0 && !footer) return null;

  function onKey(e: React.KeyboardEvent) {
    const update = menuFocusUpdate(e.key, layout.total);
    if (update) {
      e.preventDefault();
      setFocusIdx(update);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  return (
    <QuickActionsLayout>
      <InlineActions actions={layout.inline} />
      <MenuTrigger
        buttonIcon={buttonIcon}
        buttonLabel={buttonLabel}
        open={open}
        onOpenChange={onOpenChange}
        pill={pill}
        show={layout.showTrigger}
        triggerRef={triggerRef}
      />
      <QuickActionsPopover
        buttonLabel={buttonLabel}
        footer={footer}
        menuItems={layout.menuItems}
        menuRef={menuRef}
        onClose={() => onOpenChange(false)}
        onKeyDown={onKey}
        open={open}
        show={layout.showTrigger}
      />
    </QuickActionsLayout>
  );
}

function menuLayout(
  actions: QuickAction[],
  inlineMax: number | undefined,
  footer: Props["footer"],
): MenuLayout {
  const count = inlineMax ?? 0;
  const inline = actions.slice(0, count);
  const menuItems = actions.slice(count);
  return {
    inline,
    menuItems,
    showTrigger: showMenuTrigger(actions, menuItems, footer, inlineMax),
    total: menuItems.length + (footer ? 1 : 0),
  };
}

function showMenuTrigger(
  actions: QuickAction[],
  menuItems: QuickAction[],
  footer: Props["footer"],
  inlineMax: number | undefined,
): boolean {
  if (menuItems.length > 0) return true;
  if (footer != null) return true;
  return inlineMax == null && actions.length > 0;
}

function menuFocusUpdate(
  key: string,
  total: number,
): ((index: number) => number) | null {
  if (key === "ArrowDown") return (index) => (index + 1) % total;
  if (key === "ArrowUp") return (index) => (index - 1 + total) % total;
  if (key === "Home") return () => 0;
  if (key === "End") return () => total - 1;
  return null;
}

function QuickActionsLayout({ children }: { children: ReactNode }) {
  return (
    // The layout is inline because `.qa-wrap` has no rule of its own and the
    // two stylesheets that DO style this component (.qa-pill / .qa-menu, in
    // shell.css and workflows.css) belong to other areas. The values are token
    // references rather than loose rems, so the spacing still comes off the
    // system's scale.
    <span
      className="qa-wrap"
      style={{
        position: "relative",
        display: "inline-flex",
        gap: "var(--sp-1)",
        alignItems: "center",
      }}
    >
      {children}
    </span>
  );
}

function InlineActions({ actions }: { actions: QuickAction[] }) {
  return (
    <>
      {actions.map((action) => (
        <button
          key={action.id}
          className="qa-pill"
          title={action.hint ?? action.label}
          // An icon-only button's name came from `title` alone, which is a
          // hint and not a label — and then from the HINT, so a control with a
          // short name announced as a sentence. The name is the label; the
          // hint stays the hint.
          aria-label={action.label}
          // aria-disabled, never the attribute (see AreaChip in FrontPage): a
          // disabled button fires no pointer events, so the title explaining
          // why it cannot be used can never open.
          aria-disabled={action.disabled || undefined}
          onClick={action.disabled ? undefined : action.onRun}
        >
          {action.icon ?? "•"}
        </button>
      ))}
    </>
  );
}

function MenuTrigger({
  buttonIcon,
  buttonLabel,
  open,
  onOpenChange,
  pill,
  show,
  triggerRef,
}: {
  buttonIcon: ReactNode;
  buttonLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pill: boolean | undefined;
  show: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  if (!show) return null;
  return (
    <button
      ref={triggerRef}
      className={pill ? "qa-pill" : "subtle btn-ic"}
      title={buttonLabel}
      // Only in the pill form: the text form already says the words, and
      // labelling it again would name it twice.
      aria-label={pill ? buttonLabel : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
    >
      {buttonIcon}
      {!pill && <span> {buttonLabel}</span>}
    </button>
  );
}

function QuickActionsPopover({
  buttonLabel,
  footer,
  menuItems,
  menuRef,
  onClose,
  onKeyDown,
  open,
  show,
}: {
  buttonLabel: string;
  footer: Props["footer"];
  menuItems: QuickAction[];
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  open: boolean;
  show: boolean;
}) {
  if (!open || !show) return null;
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose} />
      {/* The menu is the one thing here that genuinely floats, so it takes
          the system's arrival: a 3px rise and a fade, which paper.css
          already switches off under prefers-reduced-motion. */}
      <div
        className="pop-menu qa-menu nb-float-draw"
        role="menu"
        // A menu owes an accessible name; this one had none, so it opened
        // as an unnamed list of items. The trigger's own words are the
        // right name — "Workflows", "Scripts" — and they are already the
        // words on screen.
        aria-label={buttonLabel}
        ref={menuRef}
        onKeyDown={onKeyDown}
        style={{
          position: "absolute",
          top: "100%",
          right: 0,
          marginTop: "var(--sp-1)",
        }}
      >
        <OverflowItems footer={footer} menuItems={menuItems} onClose={onClose} />
      </div>
    </>
  );
}

function OverflowItems({
  footer,
  menuItems,
  onClose,
}: {
  footer: Props["footer"];
  menuItems: QuickAction[];
  onClose: () => void;
}) {
  return (
    <>
      {menuItems.map((action) => (
        <button
          key={action.id}
          role="menuitem"
          tabIndex={-1}
          className="pop-menu-item"
          disabled={action.disabled}
          onClick={() => {
            onClose();
            action.onRun();
          }}
        >
          {action.icon && <span>{action.icon}</span>}
          <span>{action.label}</span>
        </button>
      ))}
      {footer && (
        <button
          role="menuitem"
          tabIndex={-1}
          className="pop-menu-item"
          onClick={() => {
            onClose();
            footer.onClick();
          }}
        >
          {footer.label}
        </button>
      )}
    </>
  );
}
