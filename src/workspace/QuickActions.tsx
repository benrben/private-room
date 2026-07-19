import { ReactNode, useEffect, useRef, useState } from "react";
import type { WorkflowBinding } from "../api";

/** A single generic shortcut. Idea 13 (Scripts) will reuse this shape. */
export type QuickAction = {
  id: string;
  label: string;
  icon?: string; // emoji
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

/** Does a file-scoped workflow binding match the open file? Pure + unit-testable.
 * `file_id` pins one file; otherwise a `kinds` or `exts` (suffix) match. A general
 * binding never matches a file header. */
export function bindingMatches(
  binding: WorkflowBinding | undefined | null,
  kind: string,
  name: string,
  fileId: string,
): boolean {
  if (!binding || binding.scope !== "file") return false;
  if (binding.file_id) return binding.file_id === fileId;
  if ((binding.kinds ?? []).includes(kind)) return true;
  const lower = name.toLowerCase();
  return (binding.exts ?? []).some((e) => {
    const ext = e.startsWith(".") ? e : `.${e}`;
    return lower.endsWith(ext.toLowerCase());
  });
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
  const [focusIdx, setFocusIdx] = useState(0);

  const inline = actions.slice(0, inlineMax ?? 0);
  const overflow = actions.slice(inlineMax ?? 0);
  const menuItems: QuickAction[] = overflow;
  const showTrigger = menuItems.length > 0 || footer != null || (inlineMax == null && actions.length > 0);

  useEffect(() => {
    if (open) setFocusIdx(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items?.[focusIdx]?.focus();
  }, [open, focusIdx]);

  if (actions.length === 0 && !footer) return null;

  const total = menuItems.length + (footer ? 1 : 0);
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % total);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => (i - 1 + total) % total);
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocusIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocusIdx(total - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  return (
    <span className="qa-wrap" style={{ position: "relative", display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
      {inline.map((a) => (
        <button
          key={a.id}
          className="qa-pill"
          title={a.hint ?? a.label}
          disabled={a.disabled}
          onClick={a.onRun}
        >
          {a.icon ?? "•"}
        </button>
      ))}
      {showTrigger && (
        <button
          className={pill ? "qa-pill" : "subtle btn-ic"}
          title={buttonLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {buttonIcon}
          {!pill && <span> {buttonLabel}</span>}
        </button>
      )}
      {open && showTrigger && (
        <>
          <div className="menu-backdrop" onMouseDown={() => onOpenChange(false)} />
          <div
            className="pop-menu qa-menu"
            role="menu"
            ref={menuRef}
            onKeyDown={onKey}
            style={{ position: "absolute", top: "100%", right: 0, marginTop: 4 }}
          >
            {menuItems.map((a) => (
              <button
                key={a.id}
                role="menuitem"
                tabIndex={-1}
                className="pop-menu-item"
                disabled={a.disabled}
                onClick={() => {
                  onOpenChange(false);
                  a.onRun();
                }}
              >
                {a.icon && <span>{a.icon}</span>}
                <span>{a.label}</span>
              </button>
            ))}
            {footer && (
              <button
                role="menuitem"
                tabIndex={-1}
                className="pop-menu-item"
                onClick={() => {
                  onOpenChange(false);
                  footer.onClick();
                }}
              >
                {footer.label}
              </button>
            )}
          </div>
        </>
      )}
    </span>
  );
}
