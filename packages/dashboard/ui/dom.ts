import type { CSSProperties } from 'react';

/** Small browser helpers. Nothing runs at import time. */

/**
 * CSS custom properties as a style (`style={cssVars({ '--k': 3 })}`): React's CSSProperties names none
 * of them, so an object literal of them is refused where one is expected, and a record of them is not.
 */
export const cssVars = (vars: Readonly<Record<`--${string}`, string | number>>): CSSProperties => vars;

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

/** Inputs that take no key a shortcut uses: ticked or pressed with Space or Enter. */
const KEYLESS_INPUTS = new Set(['checkbox', 'button', 'submit', 'reset', 'image']);

/**
 * Whether the keyboard event goes to a field, where single-key shortcuts must not fire: one that
 * takes typing (a text input, a textarea, a select, an editable element), or an input with keys of its
 * own (a radio's arrows, a date's digits). A checkbox or a button input takes none of them, so with a
 * run ticked on Runs, ? still opens the shortcuts.
 */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT') return !KEYLESS_INPUTS.has((t.getAttribute('type') ?? 'text').toLowerCase());
  return tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** The address's hash as it stands, written or not yet heard of: what an overlay opened on. */
export function addressNow(): string {
  return typeof location === 'undefined' ? '' : location.hash;
}

/** Whether the page is used by a finger: what would open a phone's keyboard waits to be tapped. */
export function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Whether the page leads with a lime step of its own: one lime at a time. */
export function pageLeads(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('#view .btn.lime');
}

/** The way on a job's end offers, where several show: its primary link, then what its kind adds, then a file, then a link beside them. */
export function wayOnControl(root: ParentNode | null): HTMLElement | null {
  if (!root) return null;
  return root.querySelector<HTMLElement>('.jfoot a.btn') ?? root.querySelector<HTMLElement>('.jfoot .jkind .btn') ?? root.querySelector<HTMLElement>('.jfoot .jfile') ?? root.querySelector<HTMLElement>('.jfoot .jlinks a');
}

/** The job's drawer's own place for the focus: its log while it shows, else the button that shows it, else Close. */
export function dockFocusTarget(): HTMLElement | null {
  return ['#jout', '#jlog', '#jx'].map((s) => document.querySelector<HTMLElement>(s)).find((x): x is HTMLElement => !!x && x.getClientRects().length > 0 && !x.closest('[inert]')) ?? null;
}

/** Gives the job's drawer's own place the focus (`dockFocusTarget`): whether there was one. */
export function dockFocus(): boolean {
  const to = dockFocusTarget();
  to?.focus({ preventScroll: true });
  return !!to;
}
