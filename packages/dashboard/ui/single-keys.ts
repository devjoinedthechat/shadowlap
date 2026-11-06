import { useSyncExternalStore } from 'react';

/**
 * Whether single-key shortcuts are on: remembered in the browser, one value every reader shares, and
 * read on first use, so nothing touches storage at import. The key handler, its toasts and the top
 * bar read it from the first look; the table of keys is shortcuts.ts.
 */

const STORED = 'shadowlap-single-keys';
let on: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether single-key shortcuts are on: read from the browser on first use, on where it can't say. */
export function singleKeysOn(): boolean {
  if (on === null) {
    try {
      on = localStorage.getItem(STORED) !== 'off';
    } catch {
      on = true;
    }
  }
  return on;
}

/** Turns them on or off for this browser; it works without storage, for this page only. */
export function setSingleKeys(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(STORED, next ? 'on' : 'off');
  } catch {
    // Remembered for this page only.
  }
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The switch, read so a component draws again when it moves. The third argument is for tests that draw to a string, where every key is on. */
export function useSingleKeys(): boolean {
  return useSyncExternalStore(subscribe, singleKeysOn, () => true);
}
