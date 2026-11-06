import type { Page } from '@playwright/test';
import { gateResult } from '@shadowlap/engine';
import { evidenceWords } from '../src/tests-evidence.js';
import type { DivergenceView, TestEvidence, TestsView } from '../ui/types.js';
import { dash } from './dashboard.js';

/** A rule Add normalizer and update adds for a golden, as `newRules` gives it: the `normalize add` arguments. */
const rule = (field: string): string[] => ['normalize', 'add', '--kind', 'api', '--path', `$.body.${field}`, '--replace', `<${field}>`];

/**
 * Tests as the demo store can't draw it, for the sweeps: the demo's own answer with a golden that
 * passed decided by a gate (12 attempts, all passed), its evidence answered when its row opens, and
 * a second golden diverged as the demo's one did, so the header offers Update goldens and its dialog
 * Add normalizer and update. The demo has no gated golden and one divergence (scripts/demo-store.mjs).
 */
export async function routeTestsFixture(page: Page): Promise<{ gated: string }> {
  const { origin, token } = dash();
  const real = (await (await page.request.get(`${origin}/api/tests`, { headers: { 'x-shadowlap-token': token } })).json()) as TestsView;
  const d = real.divergences[0];
  const gated = real.rows.find((r) => r.last.verdict === 'passed' && r.path !== d?.golden);
  const other = real.rows.find((r) => r.path !== gated?.path && r.path !== d?.golden);
  if (!d || !gated || !other) throw new Error('the demo store has no divergence, or not two other goldens');
  const decided = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, Array<boolean>(12).fill(true));
  const gate = { ...decided, tally: '12 of 12 passed', perAttempt: null, more: null, words: evidenceWords(decided, null) };
  const twin: DivergenceView = { ...d, golden: other.path, name: other.name, newRules: [rule('request_id')] };
  const view: TestsView = {
    ...real,
    rows: real.rows.map((r) => (r.path === gated.path ? { ...r, last: { ...r.last, gate } } : r)),
    divergences: [{ ...d, newRules: [rule('idempotency_key')] }, twin, ...real.divergences.slice(1)],
    diverged: [...new Set([...real.diverged, d.golden, other.path])],
  };
  const runId = d.runId ?? (dash().runs.ticket as string);
  const evidence: TestEvidence = { attempts: Array.from({ length: 12 }, () => ({ runId, href: `#/run/${runId}`, outcome: 'passed', note: null })), carried: 0, gone: 0 };
  await page.route((url) => url.pathname === '/api/tests', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue()));
  await page.route((url) => url.pathname === '/api/tests/evidence', (route) => route.fulfill({ json: evidence }));
  return { gated: gated.name };
}
