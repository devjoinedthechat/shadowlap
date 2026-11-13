import { useMemo, useRef } from 'react';
import type { RunDetail } from '../api.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { runInjectionView } from '../injection/model.js';
import { rescuedAt } from './model.js';
import { runNotes } from './notes.js';
import { presetAttempt } from './preset.js';

/**
 * What a run's page reads beside the run. None of it applies while the run records, so it is asked for
 * once the run has ended, and again as runs change:
 * - `offers`: what the page offers beyond the run's record (Share's counts, Push, Run blame, Find
 *   breaking commit);
 * - `preset`: an error-path preset's attempt, the preset it played in and its verdict, from the presets
 *   of the session that decided it;
 * - `notes`: what the run did that Shadowlap did not record, or answered as it went (notes.ts), the
 *   tools the model called that it never recorded read beside the server;
 * - `rescued`: where the fork that rescued its parent's blame sets out, by the server's `rescuedBy` or
 *   the parent's blame (`parent`, rescuedAt);
 * - `injection`: the injection tests it was in (injection/model.ts): its untrusted reads and, for an
 *   attempt, what was planted where, read once, since that reads every call of the run, and again
 *   as a Find cause… ends, for its answer; and the finding of its newest test, from its results as
 *   runs move.
 */
export function useRunExtras(run: RunDetail, parent: RunDetail | null, forkAt: number | null) {
  const { client, exported, runsTick } = useApp();
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  const offers = useLoad(() => (exported || live ? null : client.offers(runId)), `${runId}:offers:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const presets = useLoad(() => (live ? null : client.runChaos(runId)), `${runId}:presets`, live ? 0 : runsTick).data ?? null;
  const preset = useMemo(() => presetAttempt(presets, runId), [presets, runId]);
  const unrecorded = useLoad(() => (live ? null : client.unrecorded(runId)), `${runId}:unrecorded:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const notes = useMemo(() => runNotes({ unrecorded, preloads: run.run.meta?.preloads ?? null, websockets: run.websockets ?? null, extraReads: run.summary.extraReads ?? null, mode: run.run.mode }), [unrecorded, run.run.meta?.preloads, run.websockets, run.summary.extraReads, run.run.mode]);
  const results = useLoad(() => (live ? null : client.injectionResults(runId)), `${runId}:injection-results:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data?.results ?? null;
  // Read again as a Find cause… ends, so its answer shows: as more have ended than when the results
  // first came, never as they first come, so a page opens on one read of every call.
  const asked = results ? results.filter((r) => r.mode === 'clean' && !r.running).length : null;
  const first = useRef<{ runId: string; asked: number } | null>(null);
  if (asked !== null && first.current?.runId !== runId) first.current = { runId, asked };
  const more = asked === null || !first.current ? 0 : asked - first.current.asked;
  const tested = useLoad(() => (live ? null : client.injectionRun(runId)), `${runId}:injection:${live ? 'live' : 'ended'}`, more).data ?? null;
  const injection = useMemo(() => runInjectionView(tested, results), [tested, results]);
  // The presets' finding is on the recording they ran on, never on an attempt's page, and once one made an attempt.
  const ran = presets?.runId === runId && presets.counts.passed + presets.counts.failed + presets.counts.inconclusive > 0 ? presets : null;
  return { offers, preset, presets: ran, notes, rescued: rescuedAt(run, parent, forkAt), injection };
}
