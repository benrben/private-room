import { useEffect, useRef } from "react";
import type React from "react";
import { FOCUSABLE_SELECTOR } from "./types";

function closesForEscape(e: React.KeyboardEvent, onClose: () => void): boolean {
  if (e.key !== "Escape") return false;
  e.preventDefault();
  onClose();
  return true;
}

function trapsEmptyModal(
  els: HTMLElement[],
  e: React.KeyboardEvent,
  modal: HTMLDivElement | null,
): boolean {
  if (els.length > 0) return false;
  e.preventDefault();
  modal?.focus();
  return true;
}

function isInsideModal(
  modal: HTMLDivElement | null,
  active: HTMLElement | null,
): boolean {
  if (!modal || !active) return false;
  // A focused container (tabIndex=-1) must wrap Shift+Tab, rather than let
  // native navigation reach the workspace behind the modal.
  if (active === modal) return false;
  return modal.contains(active);
}

function shouldWrapFocus(
  active: HTMLElement | null,
  boundary: HTMLElement,
  inside: boolean,
): boolean {
  if (!inside) return true;
  return active === boundary;
}

function wrapTabFocus(
  e: React.KeyboardEvent,
  els: HTMLElement[],
  modal: HTMLDivElement | null,
): void {
  if (trapsEmptyModal(els, e, modal)) return;
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = isInsideModal(modal, active);
  const destination = e.shiftKey ? last : first;
  const boundary = e.shiftKey ? first : last;
  if (!shouldWrapFocus(active, boundary, inside)) return;
  e.preventDefault();
  destination.focus();
}

/** FOCUS TRAP (audit HIGH): the modal renders over a live workspace whose
 * "Lock" button sits behind it. Without a trap, Tab walks focus out of the
 * modal and a keyboard user could lock the room by accident. We keep Tab /
 * Shift+Tab cycling among focusable elements inside `modalRef`, close on
 * Escape, move focus in on open, and restore it to the trigger on close. */
export function useFocusTrap(onClose: () => void) {
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  function focusableEls(): HTMLElement[] {
    const root = modalRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(
      // Skip elements hidden by display:none (offsetParent null) or collapsed
      // <details>; keep the currently-focused one even if measured as hidden.
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  useEffect(() => {
    // Remember what had focus (typically the "…" menu button that opened us),
    // so we can hand focus back when the modal closes.
    triggerRef.current = document.activeElement as HTMLElement | null;
    // Move focus into the modal; fall back to the container (tabindex=-1).
    const els = focusableEls();
    (els[0] ?? modalRef.current)?.focus();
    return () => {
      const t = triggerRef.current;
      if (t && typeof t.focus === "function" && document.contains(t)) {
        t.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onModalKeyDown(e: React.KeyboardEvent) {
    if (closesForEscape(e, onClose)) return;
    if (e.key !== "Tab") return;
    wrapTabFocus(e, focusableEls(), modalRef.current);
  }

  /** Put focus back inside the trapped subtree.
   *
   * The dimmed backdrop is the trap's PARENT, not part of it, and it is not
   * focusable — so a click on it leaves focus on <body>. When that click only
   * ASKS (unsaved work turns it into "closing now would discard them") the
   * modal stays up with focus outside it: `onModalKeyDown` is bound to the
   * modal, so it never fires again, Tab walks straight into the workspace this
   * trap exists to fence off — the Lock button included — and Escape does
   * nothing at all. Focusing the container (tabIndex=-1) restores both, and the
   * first Tab from there lands on the first control inside. */
  function refocusModal() {
    const root = modalRef.current;
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== root && root.contains(active)) return;
    root.focus();
  }

  return { modalRef, onModalKeyDown, refocusModal };
}
