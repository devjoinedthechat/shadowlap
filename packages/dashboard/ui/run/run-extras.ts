import { useMemo } from 'react';
import type { RunDetail } from '../api.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
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
 *   the parent's blame (`parent`).
 */
export function useRunExtras(run: RunDetail, parent: RunDetail | null, forkAt: number | null) {
  const { client, exported, runsTick } = useApp();
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  const offers = useLoad(() => (exported || live ? null : client.offers(runId)), `${runId}:offers:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const presets = useLoad(() => (run.run.meta?.chaos && !live ? client.runChaos(runId) : null), `${runId}:presets`, live ? 0 : runsTick).data ?? null;
  const preset = useMemo(() => presetAttempt(presets, runId), [presets, runId]);
  const unrecorded = useLoad(() => (live ? null : client.unrecorded(runId)), `${runId}:unrecorded:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const notes = useMemo(() => runNotes({ unrecorded, preloads: run.run.meta?.preloads ?? null, websockets: run.websockets ?? null, extraReads: run.summary.extraReads ?? null, mode: run.run.mode }), [unrecorded, run.run.meta?.preloads, run.websockets, run.summary.extraReads, run.run.mode]);
  const rescued: { callNo: number | null } | null = run.rescuedBy ? { callNo: run.rescuedBy.callNo ?? forkAt } : parent?.run.meta?.blame?.rescuedRunId === runId && run.run.divergence ? { callNo: run.run.divergence.callNo } : null;
  return { offers, preset, notes, rescued };
}
