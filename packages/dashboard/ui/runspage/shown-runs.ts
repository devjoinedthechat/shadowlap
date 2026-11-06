import { shownRuns } from '../list-keys.js';

/**
 * Notes the runs a list shows and how to read on. One read at a time: a second press while a page
 * comes waits for that page, so no page is listed twice, and one that failed can be asked for again.
 * Noted anew, the list before it stays as it was. `grew` hears how many it holds after each page.
 */
export function noteShownRuns(first: readonly string[], next: string | null, read: (cursor: string) => Promise<{ ids: readonly string[]; next: string | null }>, grew?: (n: number) => void): void {
  let ids = first;
  let cursor = next;
  let reading: Promise<readonly string[]> | null = null;
  const more = (): Promise<readonly string[]> => {
    if (!cursor) return Promise.resolve(ids);
    reading ??= read(cursor)
      .then((page) => {
        ids = [...ids, ...page.ids];
        cursor = page.next;
        if (shownRuns.current?.more === more) {
          grew?.(ids.length);
          shownRuns.current = { ids, more: cursor ? more : null };
        }
        return ids;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
  shownRuns.current = { ids, more: cursor ? more : null };
}
