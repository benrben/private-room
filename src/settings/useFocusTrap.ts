import { useEffect, useRef } from "react";
import type React from "react";
import { FOCUSABLE_SELECTOR } from "./types";

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
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const els = focusableEls();
    if (els.length === 0) {
      // Nothing focusable inside — keep focus from escaping to the workspace.
      e.preventDefault();
      modalRef.current?.focus();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;
    // Node.contains() is true for the node itself, so a focused container
    // (tabIndex=-1) would read as "inside" and let native Shift+Tab escape to
    // the workspace behind the modal. Exclude the container itself.
    const inside =
      !!active &&
      active !== modalRef.current &&
      !!modalRef.current?.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return { modalRef, onModalKeyDown };
}
