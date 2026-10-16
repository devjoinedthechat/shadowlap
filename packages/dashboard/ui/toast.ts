/**
 * Toasts, one at a time at the bottom of the window. A notice has the lime dot and goes after 2.6
 * seconds, as the design's do. An error (a job the server refused, a change that failed, a job that
 * failed with its drawer closed) has a red dot, is read out at once (`role=alert`) and stays until
 * it is dismissed or for 8 seconds: the reason it gives is what the person has to act on, and a
 * notice that looks like a success and goes in 2.6 seconds is easy to miss. No DOM here: the tests
 * import it, and `components/Toast.tsx` shows it.
 */

export type ToastKind = 'notice' | 'error';

/** How long a toast stays, by kind. */
export const TOAST_MS: Readonly<Record<ToastKind, number>> = { notice: 2600, error: 8000 };

/**
 * A message as a sentence, starting with a capital: the server's reasons start in lower case ("the
 * repairer in shadowlap.config.json changed since this page loaded…"). Only a plain first word is
 * raised: a first word that is a name (`fx-01K…`, `runIds:`, `baseUrl`, `shadowlap`, a file) is left
 * as it is.
 */
export function sentence(text: string): string {
  const first = /^([a-z]+)\s/.exec(text)?.[1];
  if (!first || first === 'shadowlap') return text;
  return `${first[0]!.toUpperCase()}${text.slice(1)}`;
}

/** What an error toast says for an error: its message, as a sentence. */
export function errorText(err: unknown): string {
  return sentence(err instanceof Error ? err.message : String(err));
}
