import { agentCallsOf, FixIdError, fixRecords, pathOf, resolveFix, shownBlame, type StoreOf } from '@shadowlap/engine';
import { links } from './links.js';

/**
 * A gate's attempts grouped by what each did, for a fix's page: blame's probes and each verified
 * run, their attempts grouped by the tool calls each made from where it left the run (in order, the
 * tools of one model turn sorted, a call that didn't plainly run marked: `issue_refund (blocked)`,
 * as `replay --repeat` groups its attempts, engine repeat.ts) and by how each came out. Each group
 * says how many attempts took it, why the first of them failed, and opens one of them. So the
 * failing attempts show how they differ from the passing ones. A plain function of the store, for
 * `GET /api/fixes/:id/groups`.
 */

export type AttemptVerdict = 'passed' | 'failed' | 'inconclusive';

export interface AttemptGroup {
  /** The tool calls its attempts made from where they left the run, in order; empty when they called none. */
  path: string[];
  verdict: AttemptVerdict;
  count: number;
  /** Why they failed, as the first of them says it; null for attempts that passed. */
  why: string | null;
  /** One of its attempts, at the call it left the run at. */
  example: { runId: string; href: string };
}

export interface ProbeGroups {
  callNo: number;
  attempts: number;
  /** How many of them the groups read: the first `MAX_ATTEMPTS` of more. */
  read: number;
  groups: AttemptGroup[];
}

export interface VerifiedRunGroups {
  runId: string;
  role: 'target' | 'held-out' | 'good';
  attempts: number;
  /** How many of them the groups read: the first `MAX_ATTEMPTS` of more. */
  read: number;
  groups: AttemptGroup[];
}

export interface FixAttemptGroups {
  fixId: string;
  /** The blame the Blame step shows: its probes, each with its attempts grouped. */
  blame: { blameId: string; probes: ProbeGroups[] } | null;
  /** Every change verified, as the Verify step lists them: each run with its attempts grouped. */
  verify: Array<{ verifyId: string; runs: VerifiedRunGroups[] }>;
}

/** The attempts read for one probe or one run: enough to see how they differ. */
export const MAX_ATTEMPTS = 200;
const ROLE = { target: 'target', holdout: 'held-out', good: 'good' } as const;
const ORDER: Record<AttemptVerdict, number> = { failed: 0, inconclusive: 1, passed: 2 };

interface Attempt {
  runId: string;
  passed: boolean;
  verdict?: AttemptVerdict | undefined;
  failures: string[];
  /** Where it left the run, when the report says; else the run's own divergence. */
  forkedAt?: number | null;
}

const verdictOf = (a: Attempt): AttemptVerdict => a.verdict ?? (a.passed ? 'passed' : 'failed');

/** Attempts grouped by their path and how they came out, the biggest group first, a failing one first among equals; `read`, how many of them were. */
export function groupAttempts(store: StoreOf<'recording'>, attempts: readonly Attempt[]): { groups: AttemptGroup[]; read: number } {
  const groups = new Map<string, AttemptGroup>();
  for (const a of attempts.slice(0, MAX_ATTEMPTS)) {
    const run = store.getRun(a.runId);
    // An attempt gc deleted since says nothing of what it did.
    if (!run) continue;
    const from = a.forkedAt ?? run.divergence?.callNo ?? null;
    const path = pathOf(agentCallsOf(store.getCalls(a.runId)), from);
    const verdict = verdictOf(a);
    const key = `${verdict}\u0000${JSON.stringify(path)}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { path, verdict, count: 1, why: verdict === 'passed' ? null : (a.failures[0] ?? null), example: { runId: a.runId, href: links.run(a.runId, from) } });
  }
  return { groups: [...groups.values()].sort((x, y) => y.count - x.count || ORDER[x.verdict] - ORDER[y.verdict]), read: Math.min(attempts.length, MAX_ATTEMPTS) };
}

/** The attempts of a fix's blame and verifies, grouped by what each did; null for no such fix. */
export function fixAttemptGroups(store: StoreOf<'recording' | 'fixes'>, idOrPrefix: string): FixAttemptGroups | null {
  let fix;
  try {
    fix = resolveFix(store, idOrPrefix);
  } catch (err) {
    if (err instanceof FixIdError) return null;
    throw err;
  }
  if (!fix) return null;
  const rec = fixRecords(store, fix);
  const b = shownBlame(rec);
  const blame = b ? { blameId: b.blameId, probes: b.report.probes.map((p) => ({ callNo: p.callNo, attempts: p.attempts.length, ...groupAttempts(store, p.attempts.map((a) => ({ ...a, forkedAt: p.callNo }))) })) } : null;
  const verify = [...rec.verdicts].reverse().map((v) => ({
    verifyId: v.verifyId,
    runs: v.report.runs.map((x) => ({ runId: x.runId, role: ROLE[x.role], attempts: x.attempts.length, ...groupAttempts(store, x.attempts) })),
  }));
  return { fixId: fix.fixId, blame, verify };
}
