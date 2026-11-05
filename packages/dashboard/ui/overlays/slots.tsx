import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLatest } from '../hooks.js';

/**
 * Three places on top of the page, so one overlay never takes another's: a menu (a menu, a listbox, a
 * picker) in `#menu`, a modal (a dialog, the palette, the shortcuts) in `#layer`, the job's drawer in
 * `#dock`. They sit beside the app, not in it, so a modal can make the app behind it inert, and no
 * page's styles reach what they hold. Where none is drawn (a test of one part) what goes in one is
 * drawn in place.
 */

export type SlotName = 'menu' | 'layer' | 'dock';

const slots: Record<SlotName, HTMLElement | null> = { menu: null, layer: null, dock: null };
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const put = (name: SlotName) => (el: HTMLElement | null) => {
  if (slots[name] === el) return;
  slots[name] = el;
  for (const fn of [...listeners]) fn();
};
const SETTERS: Record<SlotName, (el: HTMLElement | null) => void> = { menu: put('menu'), layer: put('layer'), dock: put('dock') };

/** The three slots: the shell draws them once, after the app. */
export function OverlaySlots() {
  return (
    <>
      <div id="dock" ref={SETTERS.dock} />
      <div id="layer" ref={SETTERS.layer} />
      <div id="menu" ref={SETTERS.menu} />
    </>
  );
}

/** Draws `children` in a slot: React's tree stays where it is, so what they read of it (the app, a page's state) stays theirs. */
export function InSlot({ name, children }: { name: SlotName; children: ReactNode }) {
  const el = useSyncExternalStore(
    subscribe,
    () => slots[name],
    () => null,
  );
  return el ? createPortal(children, el) : <>{children}</>;
}

/** A panel beside the page (the job's drawer): Esc closes the last one opened, after any menu or modal. */
const panels: Array<{ current: () => void }> = [];

/** Registers an open panel, so Esc closes it. */
export function usePanel(close: () => void): void {
  const latest = useLatest(close);
  useEffect(() => {
    panels.push(latest);
    return () => {
      panels.splice(panels.indexOf(latest), 1);
    };
  }, [latest]);
}

/** Closes the panel opened last; false when none is open. */
export function closeTopPanel(): boolean {
  const top = panels.at(-1);
  top?.current();
  return !!top;
}
