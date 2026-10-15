import type { BlameProbe, BlameReport, Footprint, RepairCandidate, RepairReport, RunStatus, Store, VerifiedRun, VerifyReport } from '../src/index.js';

/**
 * Reports shaped like the ones blame, verify and repair make, built by hand for the Fixes tests:
 * the story of a refund agent that refunds $240 against policy, blamed at its third model call.
 */

export const EXPECT = { tools: { issue_refund: { count: 0, args: { amount: 240 } } } };
export const ORACLE = ['the agent exits 0', 'issue_refund with {"amount":240} called 0 times'];

let n = 0;
/** A run id that sorts in creation order, as ulids do. */
export const runId = (): string => `01M3RZ${String(++n).padStart(4, '0')}${'0'.repeat(16)}`;

export function makeRun(store: Store, o: { labels?: string[]; status?: Exclude<RunStatus, 'running'>; mode?: 'record' | 'replay'; parent?: string; meta?: Record<string, unknown>; startedAt?: number; calls?: Array<'api' | 'tool'>; scope?: string } = {}): string {
  const id = runId();
  store.createRun({ runId: id, mode: o.mode ?? 'record', parentRunId: o.parent ?? null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: o.startedAt ?? 1_000, meta: { ...(o.labels ? { labels: o.labels } : {}), ...(o.meta ?? {}) } });
  (o.calls ?? []).forEach((kind, i) => {
    const callNo = i + 1;
    store.appendCallStart({ runId: id, callNo, kind, name: kind === 'api' ? 'POST /v1/messages' : 'lookup_order', fingerprint: `f${callNo}`, occurrence: 0, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef: null, meta: o.scope ? { scope: o.scope } : {}, at: 1_000 + callNo });
    store.appendCallEnd({ kind, name: 'x', fingerprint: `f${callNo}`, occurrence: 0 }, { runId: id, callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: 1_000 + callNo });
  });
  store.endRun(id, o.status ?? 'failed');
  return id;
}

function probe(callNo: number, step: number, results: boolean[], failure = 'issue_refund with {"amount":240} called 0 times, but called 1 time (1 blocked or stubbed)'): BlameProbe {
  const attempts = results.map((passed) => ({ runId: runId(), passed, exitCode: 0, failures: passed ? [] : [failure], spent: 0.01, upstreamRequests: 2 }));
  return { callNo, step, attempts, passes: results.filter(Boolean).length, rescued: results.filter(Boolean).length >= 2 };
}

/** A blame that found model call #5 (3 of 4); `outcome` changes what it found. */
export function blameReport(run: string, outcome: BlameReport['outcome'] = 'blamed'): BlameReport {
  const p1 = probe(1, 1, [true, false, true]);
  const p5 = probe(5, 3, [true, false, true, false]);
  const p7 = probe(7, 4, [false, false, false, false]);
  const probes = outcome === 'blamed' ? [p1, p5, p7] : outcome === 'unrescuable' ? [probe(1, 1, [false, true, false, false])] : [p1];
  const blamed = outcome === 'blamed' ? p5 : outcome === 'stopped' ? p1 : null;
  const attempts = probes.reduce((s, x) => s + x.attempts.length, 0);
  return {
    outcome,
    blamed,
    lost: outcome === 'blamed' ? p7 : null,
    probes,
    nonMonotone: [],
    confidence: outcome === 'stopped' ? 'low' : 'high',
    runId: run,
    steps: 4,
    attemptsPerProbe: 5,
    needed: 2,
    rescue: { fields: {} },
    oracle: ORACLE,
    recordedFailures: ['issue_refund with {"amount":240} called 0 times, but called 1 time'],
    contrast:
      outcome === 'blamed'
        ? { callNo: 5, recorded: [{ type: 'tool_call', name: 'issue_refund', input: { order_id: 'A-1042', amount: 240 } }], rescued: [{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'refund of $240 is above $100' } }], rescuedRunId: p5.attempts[0]!.runId }
        : null,
    attempts,
    spent: attempts * 0.01,
    upstreamRequests: attempts * 2,
    unknownModels: [],
    stopReason: outcome === 'stopped' ? 'the budget of $0.05 is spent' : null,
    warnings: [],
  };
}

const footprint = (inputTokens: number, cost: number | null = inputTokens / 300_000): Footprint => ({ inputTokens, outputTokens: 30, cost });

/** A verify of runs, each passing or failing every attempt it made. */
export function verifyReport(runs: Array<{ runId: string; role: VerifiedRun['role']; pass: boolean; deterministic?: boolean }>, o: { codeVersion?: string } = {}): VerifyReport {
  const verified: VerifiedRun[] = runs.map((r) => {
    const count = r.deterministic ? 1 : r.pass ? 4 : 2;
    const attempts = Array.from({ length: count }, () => ({ runId: runId(), passed: r.pass, exitCode: r.pass ? 0 : 1, failures: r.pass ? [] : [r.role === 'good' ? 'the agent exited with code 1' : 'issue_refund with {"amount":240} called 0 times, but called 1 time'], forkedAt: r.deterministic ? null : 1, spent: r.deterministic ? 0 : 0.012, upstreamRequests: r.deterministic ? 0 : 3, footprint: footprint(r.pass ? 4_402 : 5_193) }));
    return { runId: r.runId, role: r.role, attempts, passes: r.pass ? count : 0, deterministic: !!r.deterministic, verdict: r.pass ? 'pass' : 'fail', recorded: { passed: r.role === 'good', failures: [], footprint: footprint(4_329) } };
  });
  const failed = verified.filter((r) => r.verdict === 'fail');
  const attempts = verified.reduce((s, r) => s + r.attempts.length, 0);
  return {
    verdict: failed.length ? 'rejected' : 'accepted',
    reasons: failed.map((r) => `${r.role} run ${r.runId.slice(0, 10)} ${r.role === 'good' ? 'broken' : 'not fixed'}: 0 of ${r.attempts.length} passed`),
    warnings: [],
    runs: verified,
    attemptsPerRun: 5,
    needed: 4,
    oracle: ORACLE,
    fields: {},
    codeVersion: o.codeVersion ?? '370712a+dirty',
    attempts,
    spent: verified.reduce((s, r) => s + r.attempts.reduce((t, a) => t + a.spent, 0), 0),
    upstreamRequests: verified.reduce((s, r) => s + r.attempts.reduce((t, a) => t + a.upstreamRequests, 0), 0),
    unknownModels: [],
    stopReason: null,
    replayWarnings: [],
  };
}

export const BEFORE = 'You are a support agent. Follow the refund policy.';
export const AFTER = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';

function candidate(id: number, state: RepairCandidate['state'], after: string, reason: string | null, verify: VerifyReport | null): RepairCandidate {
  return { id, source: 'repairer', strategy: id === 3 ? 'Escalate refunds above the policy limit' : `Candidate ${id}`, why: 'why', surface: 'system prompt', file: 'agent.mjs', offset: 10, before: BEFORE, after, size: after.length - BEFORE.length, state, reason, verify };
}

/** A repair of `targets` (each blamed at #5), held-out and good runs; accepted unless `accepted` is false. */
export function repairReport(o: { targets: string[]; holdout?: string[]; good?: string[]; accepted?: boolean; dir?: string; pr?: string | null; applied?: boolean }): RepairReport {
  const holdout = o.holdout ?? [];
  const good = o.good ?? [];
  const roles = [...o.targets.map((r) => ({ runId: r, role: 'target' as const })), ...holdout.map((r) => ({ runId: r, role: 'holdout' as const })), ...good.map((r) => ({ runId: r, role: 'good' as const }))];
  const rejected = verifyReport(roles.map((r) => ({ ...r, pass: r.role === 'good' })));
  const accepted = o.accepted === false ? null : verifyReport(roles.map((r) => ({ ...r, pass: true })), { codeVersion: 'a7b3c2e+dirty' });
  const dir = o.dir ?? '.shadowlap/repairs/repair-munzln2i';
  const candidates = [
    candidate(1, 'invalid', 'Follow the refund policy. For order A-1042, escalate instead of refunding.', 'it mentions A-1042, which only the failing runs contain: a fix has to hold for cases it has not seen', null),
    candidate(2, 'rejected', 'Follow the refund policy carefully.', 'target run 01M3RZ4XKN not fixed: 0 of 2 passed', rejected),
    ...(accepted ? [candidate(3, 'accepted', AFTER, null, accepted)] : []),
  ];
  return {
    outcome: accepted ? 'fixed' : 'not-fixed',
    why: accepted ? null : 'the gate accepted none of the 1 candidate tried',
    targets: o.targets.map((r) => ({ runId: r, outcome: 'blamed', callNo: 5, step: 3, steps: 4, rescuedRunId: null, rescuedBy: null, reused: false, recorded: 'issue_refund({"amount":240})', rescued: 'escalate({})', note: null })),
    holdout,
    good,
    heldOutAutomatically: false,
    oracle: ORACLE,
    repairer: { provider: 'claude-code', model: '', served: 'claude-opus-5-5', cost: 0.004 },
    diagnosis: 'The system prompt says to follow the policy but not what the policy asks of large refunds.',
    anchors: 2,
    candidates,
    accepted: accepted ? 3 : null,
    patch: accepted ? `diff --git a/agent.mjs b/agent.mjs\n--- a/agent.mjs\n+++ b/agent.mjs\n@@ -1,1 +1,1 @@\n-${BEFORE}\n+${AFTER}\n` : null,
    cost: { blame: 0.1, repairer: 0.004, verify: (accepted?.spent ?? 0) + rejected.spent },
    output: { dir, patch: accepted ? `${dir}/fix.patch` : null, report: `${dir}/report.md`, goldens: accepted ? o.targets.map((r) => `${dir}/goldens/${r.slice(0, 10)}`) : [], applied: !!o.applied && !!accepted, branch: null, pr: o.pr ?? null },
    warnings: [],
  };
}
