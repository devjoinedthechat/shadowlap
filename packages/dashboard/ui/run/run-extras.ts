import { useMemo } from 'react';
import type { RunDetail } from '../api.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { runInjectionView } from '../injection/model.js';
import { rescuedAt } from './model.js';
import type { RunNote } from './notes.js';
import { useNotesPart } from './notes-part.js';
import { presetAttempt } from './preset.js';

const NO_NOTES: readonly RunNote[] = [];

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
 *   attempt, what was planted where, read once, since that reads every call of the run; and the
 *   finding of its newest test, from its results as runs move.
 */
export function useRunExtras(run: RunDetail, parent: RunDetail | null, forkAt: number | null) {
  const { client, exported, runsTick } = useApp();
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  const offers = useLoad(() => (exported || live ? null : client.offers(runId)), `${runId}:offers:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const presets = useLoad(() => (run.run.meta?.chaos && !live ? client.runChaos(runId) : null), `${runId}:presets`, live ? 0 : runsTick).data ?? null;
  const preset = useMemo(() => presetAttempt(presets, runId), [presets, runId]);
  const unrecorded = useLoad(() => (live ? null : client.unrecorded(runId)), `${runId}:unrecorded:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  // What a note says is a part of its own (notes-part.ts), loaded where the run has something a note says.
  const preloads = run.run.meta?.preloads ?? null;
  const websockets = run.websockets ?? null;
  const extraReads = run.summary.extraReads ?? null;
  const part = useNotesPart(!!(unrecorded || preloads || websockets || extraReads));
  const notes = useMemo(() => (part ? part.runNotes({ unrecorded, preloads, websockets, extraReads, mode: run.run.mode }) : NO_NOTES), [part, unrecorded, preloads, websockets, extraReads, run.run.mode]);
  const tested = useLoad(() => (live ? null : client.injectionRun(runId)), `${runId}:injection:${live ? 'live' : 'ended'}`).data ?? null;
  const results = useLoad(() => (live ? null : client.injectionResults(runId)), `${runId}:injection-results:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data?.results ?? null;
  const injection = useMemo(() => runInjectionView(tested, results), [tested, results]);
  return { offers, preset, notes, rescued: rescuedAt(run, parent, forkAt), injection };
}
