import { createElement, Fragment, type ReactNode } from 'react';
import { Popover, type PopoverProps } from '../ui/components/Popover.js';
import { OverlaySlots } from '../ui/overlays/slots.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { FakeElement } from './ui-render.js';

/** What the overlays' tests share: an app, the shell's own key handler and slots around a page, and a browser's media queries. */

export function app(over: Partial<AppState> = {}): AppState {
  const base = { conn: 'ok', exported: false, meta: null, palette: false, setPalette: () => undefined, help: false, setHelp: () => undefined, sideOpen: false, setSideOpen: () => undefined, runKeys: { current: null }, toast: () => undefined };
  return { ...base, ...over } as unknown as AppState;
}

/** A browser's answer to its media queries: a phone's width, a finger. */
export function media(o: { phone?: boolean; touch?: boolean }): void {
  Object.assign(globalThis, {
    matchMedia: (q: string) => ({ matches: (q.includes('max-width') && !!o.phone) || (q.includes('pointer') && !!o.touch), addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
}

export function noMedia(): void {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
}

/** A page in the shell's frame: the skip link, the app with the connection bar's place in it, the three slots and the key handler. */
export const shell = (over: Partial<AppState>, ...parts: ReactNode[]) =>
  createElement(AppContext.Provider, { value: app(over) }, createElement('a', { className: 'skip', href: '#view' }, 'Skip'), createElement('div', { id: 'app' }, createElement('div', { id: 'conn' }), ...parts), createElement(OverlaySlots), createElement(Keyboard));

/** A menu as a page draws one, its rows under it. */
export const menuOf = (props: Omit<PopoverProps, 'children'>, ...rows: ReactNode[]) => createElement(Popover, { ...props, children: createElement(Fragment, null, ...rows) });

/** Where the focus is, as a person sees it: the control's words, or its label, or its id. */
export function words(el: FakeElement): string {
  return `${el.tagName.toLowerCase()} ${el.textContent.trim() || el.getAttribute('aria-label') || el.getAttribute('id') || el.className}`.trim();
}
