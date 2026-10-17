import { shortId } from './format.js';

/**
 * A run being recorded: on its page, where the selection goes as calls arrive; on any page, when to
 * say the recording finished or was interrupted. No DOM here: the tests import it.
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

/** A run as the run list has it, for the toast when its recording ends. */
export interface ListedRun {
  runId: string;
  status: string;
  calls: number;
  attempt?: unknown;
  attemptOf?: string | null;
  test?: unknown;
}

export interface EndedRecording {
  runId: string;
  calls: number;
  how: 'finished' | 'interrupted';
}

/**
 * The recordings that ended between two loads of the run list, for the toast that says so on
 * whatever page is open: each run that was recording at the last load and has ended now. Left out:
 * attempts (blame's probes, verify's and `--repeat`'s runs) and test replays, which the command that
 * made them reports, and the runs of a job this page follows (`own`), whose drawer, or the toast when
 * it ends behind a closed one, says so. A run gone from the list (deleted) says nothing, and neither
 * does the first list a page loads (`before` null).
 */
export function endedRecordings(before: readonly ListedRun[] | null, after: readonly ListedRun[], own: ReadonlySet<string> = new Set()): EndedRecording[] {
  if (!before) return [];
  const was = new Set(before.filter((r) => r.status === 'running').map((r) => r.runId));
  const out: EndedRecording[] = [];
  for (const r of after) {
    if (!was.has(r.runId) || own.has(r.runId) || r.attempt || r.attemptOf || r.test) continue;
    const how = recordingEnded({ wasStatus: 'running', status: r.status });
    if (how) out.push({ runId: r.runId, calls: r.calls, how });
  }
  return out;
}

/**
 * The toast for recordings that ended: "Recording finished · 01M53JE2Q0 · 32 calls" (or
 * "interrupted"), and for several in one look, how many and which. Null when none did.
 */
export function recordingToast(ended: readonly EndedRecording[]): string | null {
  const [one] = ended;
  if (!one) return null;
  if (ended.length === 1) return `Recording ${one.how} · ${shortId(one.runId)} · ${one.calls} ${one.calls === 1 ? 'call' : 'calls'}`;
  const cut = ended.filter((e) => e.how === 'interrupted').length;
  const ids = ended.slice(0, 3).map((e) => shortId(e.runId)).join(', ');
  return `${ended.length} recordings ${cut === ended.length ? 'interrupted' : cut ? 'ended' : 'finished'} · ${ids}${ended.length > 3 ? ', …' : ''}`;
}
