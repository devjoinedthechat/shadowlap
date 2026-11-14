import { useEffect, useId, useRef, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { Dialog } from '../components/Dialog.js';
import { toggled, ToggleChips } from '../components/ToggleChips.js';
import { plural } from '../format.js';
import { commandText } from '../goldens.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { useApp } from '../state.js';
import { liveFacts, type TestsAsk } from '../tests-ask.js';
import type { Price } from '../tests-estimates.js';
import type { GoldenRow } from '../types.js';

/**
 * Run tests on…: the goldens to run, picked as toggle chips (none at first, one whose pack can't be
 * read left out, as no test can run it), then what the session runs live among them, its command and
 * what it bills, asked again a moment after each pick (`GET /api/tests/estimates?run=`, Run tests'
 * price over the goldens picked). Its confirm runs `test` with `goldens`, as the page starts every
 * Tests job: one that runs a golden live asks the server's question first, which Spending answers
 * where the price lets it (tests-ask.ts).
 */

const PICK = 'Pick at least one golden';
const PRICING = 'Pricing your picks';

/** The command the goldens picked run with, as the job runs it: no shell, each path a word. */
export const pickedCommand = (paths: readonly string[]): string => commandText(['test', ...paths]);

/** The question the session asks before it runs any of them live, in the page's own words for it. */
export function pickedAsk(paths: readonly string[]): TestsAsk {
  return { title: confirmWords(ACTIONS.runTestsOn.label), lead: 'Replays the goldens you picked, as CI does.', doc: 'ciMode', ok: ACTIONS.runTestsOn.confirm, commands: [pickedCommand(paths)], parts: ['only what runs live'] };
}

/** What the session runs live, by what each golden picked is marked: the rows Run tests asks with. */
const liveOf = (rows: readonly GoldenRow[]) => rows.flatMap((r) => (r.mode === 'fork' || r.injection ? [{ path: r.path, why: [...(r.mode === 'fork' ? [{ kind: 'fork' as const }] : []), ...(r.injection ? [{ kind: 'injection' as const }] : [])] }] : []));

/**
 * The price of the picks: none until one is picked; else asked 250 ms after the last pick, the last
 * answer kept while the next is read (`pricing` till it comes). One that can't be read leaves the
 * picks unpriced, so the job asks. Undefined where nothing can price them (a stand-in with no client).
 */
function usePickedPrice(picks: readonly string[]): { estimate: Price; pricing: boolean } {
  const { client } = useApp();
  const api = client.estimates;
  const key = picks.join('\n');
  const [got, setGot] = useState<{ key: string; estimate: Estimate | null } | null>(null);
  const asked = useRef('');
  useEffect(() => {
    if (!api || !key) return;
    let alive = true;
    const t = setTimeout(() => {
      asked.current = key;
      api.testsEstimates(undefined, key.split('\n')).then(
        (e) => alive && setGot({ key, estimate: e.picked ?? null }),
        () => alive && setGot({ key, estimate: null }),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [api, key]);
  if (!key || !api) return { estimate: undefined, pricing: false };
  return got?.key === key ? { estimate: got.estimate, pricing: false } : { estimate: undefined, pricing: true };
}

export interface RunPickedProps {
  rows: readonly GoldenRow[];
  /** Why Tests' jobs wait (a session, a job holding the goldens), as Run tests waits. */
  wait: string | null | undefined;
  /** Starts the session on the goldens picked, with the price the dialog showed; false while it can't. */
  onRun: (goldens: string[], estimate: Price) => unknown;
  onClose: () => void;
}

export function RunPickedDialog({ rows, wait, onRun, onClose }: RunPickedProps) {
  const head = useId();
  const readable = rows.filter((r) => !r.error);
  const order = readable.map((r) => r.path);
  const [picks, setPicks] = useState<string[]>([]);
  const { estimate, pricing } = usePickedPrice(picks);
  const picked = readable.filter((r) => picks.includes(r.path));
  return (
    <Dialog
      title={picks.length ? `${confirmWords(ACTIONS.runTestsOn.label)} ${plural(picks.length, 'golden')}` : `${confirmWords(ACTIONS.runTestsOn.label)} goldens`}
      lead="Replays the goldens you pick, as CI does: those marked fork live from where they fork."
      doc="ciMode"
      facts={[{ label: <span id={head}>Goldens</span>, value: <ToggleChips chips={readable.map((r) => ({ id: r.path, label: r.name }))} picked={picks} labelledBy={head} onToggle={(id) => setPicks((p) => toggled(order, p, id))} /> }, ...liveFacts(liveOf(picked))]}
      command={picks.length ? pickedCommand(picks) : null}
      cost={picks.length ? { price: 'Billed by your provider', parts: ['only what runs live'], estimate } : { price: PICK, estimate: null }}
      ok={ACTIONS.runTestsOn.confirm}
      okWhy={picks.length ? (wait ?? (pricing ? PRICING : null)) : PICK}
      onOk={() => onRun(picks, estimate)}
      onClose={onClose}
    />
  );
}
