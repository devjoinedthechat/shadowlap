import { ACTIONS, type PlantReport, type StoreOf } from '@shadowlap/engine';
import { proofCall } from '../injection-view.js';
import { injectionNeedsLook } from '../injection.js';
import { links } from '../links.js';
import type { GoldenList, GoldenSource } from '../tests.js';
import { goldenName, type LookSource, type NeedsLookRow, plural } from './row.js';

/*
 * Needs a look's Security group: the newest injection test of each run or golden that a planted
 * instruction got through (obeyed, in red, first), that it influenced, or that showed too little to
 * say (in amber). Each row is titled by the test's one line, says where the planted text was read,
 * and opens the run tested; its step opens the proof, the first attempt with the row's verdict at the
 * call that shows it. A golden's injection gate is Tests' to list: a result its newest test result
 * carries (it ran in that test's session) is already a failing or an inconclusive test, so it adds no
 * row of its own; a golden tested on its own (`shadowlap injection goldens/x`) does. A golden no
 * longer on disk, or a run no longer in the store, has none.
 */

const pathOf = (g: string | GoldenSource) => (typeof g === 'string' ? g : g.path);
const kept = (store: StoreOf<'recording'>, runId: string | null | undefined): string | null => (runId && store.getRun(runId) ? runId : null);

/** Where the attempts with a verdict read the planted text: `at #4 get_ticket, #14 get_shipping and 12 more`, two reads named at most. */
export function readsWhere(report: Partial<PlantReport>, verdict: string): string {
  const name = new Map((report.reads ?? []).map((r) => [r.callNo, r.name]));
  const reads = [...new Set((report.attempts ?? []).filter((a) => a.verdict === verdict && typeof a.read === 'number').map((a) => a.read))].sort((a, b) => a - b);
  if (!reads.length) return '';
  const named = reads.slice(0, 2).map((n) => `#${n} ${name.get(n) ?? 'a read'}`);
  return ` · at ${named.join(', ')}${reads.length > 2 ? ` and ${reads.length - 2} more` : ''}`;
}

function securityLooks(store: StoreOf<'recording' | 'tests' | 'injection'>, goldens: GoldenList): NeedsLookRow[] {
  const onDisk = new Set(goldens.map(pathOf));
  const tested = new Map(store.latestTestResults().map((t) => [t.golden, t]));
  const failed: NeedsLookRow[] = [];
  const warn: NeedsLookRow[] = [];
  for (const x of injectionNeedsLook(store)) {
    if (x.golden ? !onDisk.has(x.golden) : !kept(store, x.runId)) continue;
    const result = store.getInjectionResult(x.resultId);
    const test = x.golden ? tested.get(x.golden) : undefined;
    if (test && (test.data?.injection?.resultId === x.resultId || (!!result?.sessionId && test.sessionId === result.sessionId))) continue;
    const report = (result?.data ?? {}) as Partial<PlantReport>;
    const name = x.golden ? goldenName(x.golden) : x.runId.slice(0, 10);
    const runId = kept(store, x.runId);
    // The proof: the first attempt with the row's verdict that the store still has, at its call.
    const proof = x.severity === 'inconclusive' ? null : (report.attempts ?? []).find((a) => a.verdict === x.severity && kept(store, a.runId));
    const row: NeedsLookRow = {
      key: `attn:injection:${runId ? links.run(runId) : x.resultId}`,
      group: 'security',
      kind: 'injection',
      icon: x.severity === 'obeyed' ? 'fail' : 'warn',
      title: x.text,
      detail: `injection test of ${name}${readsWhere(report, x.severity)}`,
      step: proof ? { of: 'link', label: ACTIONS.openProof.label, href: links.run(proof.runId, proofCall(proof)) } : null,
      href: runId ? links.run(runId) : links.tests(),
      runId,
      fixId: null,
      at: result?.endedAt ?? 0,
    };
    (x.severity === 'obeyed' ? failed : warn).push(row);
  }
  return [...failed, ...warn];
}

/** Obeyed first: the line for the rest reads in red when any of the rest obeyed. */
export const security: LookSource = {
  id: 'injection',
  group: 'security',
  order: 10,
  rows: (w) => securityLooks(w.store, w.goldens),
  rest: (n, rest) => ({ icon: rest.some((x) => x.icon === 'fail') ? 'fail' : 'warn', title: `${plural(n, 'more injection test')} to look at`, detail: 'each on its run, under Runs', href: links.runs() }),
};
