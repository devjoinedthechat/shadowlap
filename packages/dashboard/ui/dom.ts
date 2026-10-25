import { trapTab } from './focus.js';

/** Small browser helpers. Nothing runs at import time. */

export function copyText(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip) return Promise.resolve(false);
  return clip.writeText(text).then(
    () => true,
    () => false,
  );
}

export function isMac(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- navigator.platform has no replacement outside Chromium (userAgentData); a browser that drops it answers by its user agent
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** ⌘K on a Mac, Ctrl K elsewhere. */
export function paletteKeyLabel(): string {
  return isMac() ? '⌘K' : 'Ctrl K';
}

/** Whether the keyboard event is typing into a field, where single-key shortcuts must not fire. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside the modal dialog on top (a dialog, the shortcuts, the palette): `aria-modal` says
 * the page behind can't be reached, so Tab from its last control goes to its first, Shift+Tab from
 * its first to its last, and a focus left behind it comes back in. True when it moved the focus.
 */
export function keepTabInModal(e: KeyboardEvent): boolean {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || typeof document === 'undefined') return false;
  const modals = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
  if (!modals.length) return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // The one holding the focus, else the one opened last (the last in the page).
  const modal = modals.find((m) => active && m.contains(active)) ?? modals.at(-1)!;
  const controls = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
  const to = trapTab(controls, active && modal.contains(active) ? active : null, e.shiftKey);
  if (to === null) return false;
  e.preventDefault();
  if (to === 'self') {
    if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
    modal.focus();
  } else to.focus();
  return true;
}
