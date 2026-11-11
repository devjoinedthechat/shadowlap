import type { InjectionGateRow } from '../../src/injection-gates.js';
import type { GoldenRow } from '../api.js';
import { injectionTally } from '../../../engine/src/trust-words.js';
import { num, plural } from '../format.js';
import { CHECK_MARK } from '../goldens.js';
import { href } from '../route.js';

/*
 * A golden's injection gate on Tests, as the design draws it: no check, but a line under its checks
 * that its tests entry sets (so no edit or remove), its config on hover, and its words opening its
 * results. No DOM here: the tests import it.
 */

export interface GateCheckView {
  /** How its last test came out; null when none ran it (its replay hasn't passed yet). */
  status: 'passed' | 'failed' | 'inconclusive' | null;
  /** ✓ ✗ or ?, as a check's; null with no result. */
  mark: string | null;
  /** `injection: no attempt obeys a planted instruction`. */
  text: string;
  /** Its tally under its line, or `runs once its replay passes`; null for a pass, which keeps it on its hover as a passed check does. */
  sub: string | null;
  /** Its card: `failed · injection gate`, then what it plants where, its entry, why, and where its words go. */
  title: string;
  line: string;
  /** The run its last test planted into, which its words open with that test's results; null when none is kept. */
  open: { runId: string; key: string } | null;
}

/** What a gate's templates are, in its card: `user-recipient, system-notice`, `every template`, `a payload file`. */
function plants(e: InjectionGateRow['entry']): string {
  const templates = e.templates === 'all' ? 'every template' : e.templates === 'none' ? null : e.templates.join(', ');
  if (!e.payloads) return templates ?? 'no template';
  return templates ? `${templates} and a payload file` : 'a payload file';
}

/** The gate's line under a golden's checks, with its card (mock:assets/app.js:14405-14414). */
export function gateCheck(gate: InjectionGateRow, last: GoldenRow['last']): GateCheckView {
  const r = last.injection ?? null;
  const status = r?.verdict ?? null;
  const { obeyed, repeat } = gate.entry;
  const text = `injection: ${obeyed ? `at most ${plural(obeyed, 'attempt')} ${obeyed === 1 ? 'obeys' : 'obey'}` : 'no attempt obeys'} a planted instruction`;
  const tally = r && status ? injectionTally(r, { num }) : 'runs once its replay passes';
  const open = gate.results ? { runId: gate.results.runId, key: `injection:${gate.results.resultId}` } : null;
  const why = status && status !== 'passed' && r?.reason ? `. ${r.reason}` : '';
  // Its entry as the config holds it, left out where the file can't be read now.
  const written = gate.json ? `. "injection": ${gate.json}` : '';
  const line = `${plants(gate.entry)} at every untrusted read, ${plural(repeat, 'attempt')} each${written}${why}${open ? '. Opens its results' : ''}`;
  return {
    status,
    mark: status ? CHECK_MARK[status] : null,
    text,
    sub: status === 'passed' ? null : tally,
    title: `${status ?? 'not run yet'} · injection gate`,
    line: status === 'passed' ? `${tally}. ${line}` : line,
    open,
  };
}

/** The attempt that proves a golden's verdict where that verdict is its injection gate's, else null. */
export function rowProof(row: { last?: Pick<GoldenRow['last'], 'failure'>; injectionGate?: InjectionGateRow | undefined }): InjectionGateRow['proof'] {
  return row.last?.failure === 'injection' ? (row.injectionGate?.proof ?? null) : null;
}

/**
 * Where a golden's row opens: the attempt that proves its verdict where that verdict is its injection
 * gate's (mock:MISSING.md:1259), else its run; null for a golden with neither.
 */
export function rowHref(row: Pick<GoldenRow, 'runId' | 'last' | 'injectionGate'>): string | null {
  const proof = rowProof(row);
  if (proof) return href.run(proof.runId, proof.callNo);
  return row.runId ? href.run(row.runId) : null;
}
