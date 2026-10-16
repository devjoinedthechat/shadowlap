/**
 * A run being recorded, on its page: where the selection goes as calls arrive, and when to say the
 * recording finished or was interrupted. No DOM here: the tests import it.
 */

export interface LiveStep {
  /** The run's status at the last look, and now. */
  wasStatus: string;
  status: string;
  /** The newest call at the last look, and now. */
  prevLast: number | null;
  last: number | null;
  /** The selected call, as the address bar still has it. */
  selected: number | null;
}

/**
 * The call the selection moves to, or null to leave it. It follows the newest call when it was on the
 * newest: also when the last calls and the end of the recording arrive in the same poll, which is why
 * this reads the status the run had before, not the one it has now.
 */
export function followNewest(s: LiveStep): number | null {
  if (s.wasStatus !== 'running') return null;
  if (s.last === null || s.prevLast === null || s.last === s.prevLast) return null;
  return s.selected === s.prevLast ? s.last : null;
}

/**
 * Whether the recording just ended, and how, for the toast that says so: `finished`, or `interrupted`
 * when it stopped before it ended (Ctrl-C, its recorder killed), as every list then says; null while
 * it records, and for a run that had already ended.
 */
export function recordingEnded(s: Pick<LiveStep, 'wasStatus' | 'status'>): 'finished' | 'interrupted' | null {
  if (s.wasStatus !== 'running' || s.status === 'running') return null;
  return s.status === 'crashed' ? 'interrupted' : 'finished';
}
