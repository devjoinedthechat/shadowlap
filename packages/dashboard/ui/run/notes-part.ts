import { useEffect, useSyncExternalStore } from 'react';
import type * as Notes from './RunNotes.js';

/*
 * A run's notes, a part of its own (RunNotes.tsx, with notes.ts' words): what a run did that was not
 * recorded, its preloads, its WebSockets and a replay's extra reads are said by a script that loads
 * as a page first has one of them, so the run's page holds none of their words. Its findings draw
 * the notes once it is in (FindingsBar.tsx); until then, a moment after the page draws, they wait.
 */

export type NotesPart = typeof Notes;

let part: NotesPart | null = null;
let loading: Promise<NotesPart> | null = null;
const heard = new Set<() => void>();
const subscribe = (on: () => void) => {
  heard.add(on);
  return () => void heard.delete(on);
};

/** Loads the part once, every page that waits for it told as it comes; a load that failed is tried again next time. */
export function loadNotesPart(): Promise<NotesPart> {
  loading ??= import('./RunNotes.js').then(
    (m) => {
      part = m;
      for (const on of heard) on();
      return m;
    },
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

/** The part, once it is in. */
export const notesPart = (): NotesPart | null => part;

/** The part once it is in, loading it where `want` holds: a run with something a note says. */
export function useNotesPart(want: boolean): NotesPart | null {
  const got = useSyncExternalStore(subscribe, notesPart, notesPart);
  useEffect(() => {
    if (want && !got) void loadNotesPart().catch(() => undefined);
  }, [want, got]);
  return got;
}
