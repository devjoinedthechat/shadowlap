import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPRT_DEFAULTS, planSuite, riskPercent, type SprtGate, type SuiteGolden } from '@shadowlap/engine';
import { suiteJson, suiteLines } from '../src/suite-plan.js';
import { markdownReport, testReport } from '../src/test-report.js';

/**
 * What a test session says before any golden runs (suite-plan.ts): the forecast and how its one risk
 * is split, word for word as docs/gating.md shows them, and what `--json` reports as `suite`.
 */
const PAGE = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
const goldens = (n: number, o: Partial<SuiteGolden> = {}): SuiteGolden[] => Array.from({ length: n }, (_, i) => ({ golden: `goldens/g${i}`, gate, maxGiven: false, ...o }));

describe('the session plan', () => {
  it('says the forecast and the split, as the page shows them for 100 goldens at 95% and $0.025 an attempt', () => {
    const lines = suiteLines(planSuite(goldens(100, { rate: 0.95, costPerAttempt: 0.025 }))!);
    expect(lines).toEqual([
      'forecast: about 1,675 attempts (16.7 a golden on average), up to 17,900 · about $41.87',
      'suite risk 5%: 100 gated goldens, 0.05% each, so a healthy suite goes red for nothing in 5% of runs or fewer',
    ]);
    expect(PAGE.includes(`\`\`\`\n${lines.join('\n')}\n\`\`\``), 'docs/gating.md shows the forecast as the session prints it').toBe(true);
  });

  it('reports the plan under suite in --json: the risk, each golden’s share, and the forecast of attempts and cost', () => {
    const plan = planSuite(goldens(2, { rate: null, costPerAttempt: null }))!;
    const suite = suiteJson(plan);
    expect(suite).toEqual({ risk: 0.05, perGoldenRisk: 0.025, method: 'bonferroni', goldens: 2, inconclusive: 'fail', red: plan.red, forecast: { attempts: plan.forecast.attempts, most: 164, cost: null, unpriced: 2 } });
    expect(suite.red).toBeLessThanOrEqual(0.05);
    // No price for its models: the cost is unknown, and says so.
    expect(suiteLines(plan)[0]).toMatch(/^forecast: about \d+ attempts \([\d.]+ a golden on average\), up to 164 · cost unknown: no price for their models$/);
  });

  it('says what the plan works out, not the risk it was given, when a golden can’t keep within its share', () => {
    // Nine goldens the session sizes, and one whose config pins its max at 20: a fifth of its
    // attempts at its good rate run out inconclusive, far past its 0.5% share.
    const plan = planSuite([...goldens(9), { golden: 'goldens/pinned', gate: { ...gate, max: 20 }, maxGiven: true }])!;
    expect(plan.red).toBeGreaterThan(0.5);
    const lines = suiteLines(plan);
    expect(lines[1]).toBe(`suite risk 5%: 10 gated goldens, 0.5% each, but 1 golden can't keep within its share, so a healthy suite goes red for nothing in ${riskPercent(plan.red)} of runs or fewer`);
    expect(lines[1]).not.toContain('in 5% of runs or fewer');
    expect(lines[2]).toMatch(/^goldens\/pinned: its max of 20 leaves /);
    // The JSON says how many, and the Markdown summary says what the terminal does.
    const suite = suiteJson(plan);
    expect(suite).toMatchObject({ red: plan.red, over: 1 });
    const md = markdownReport(testReport([], null, suite));
    expect(md).toContain(`Suite risk 5%, split across 10 gated goldens (0.5% each), but 1 golden can't keep within its share, so a healthy suite goes red for nothing in ${riskPercent(plan.red)} of runs or fewer.`);
    // Within the risk, the line is as before, and the risk it says is the one given.
    expect(suiteLines(planSuite(goldens(10))!)[1]).toBe('suite risk 5%: 10 gated goldens, 0.5% each, so a healthy suite goes red for nothing in 5% of runs or fewer');
  });

  it('says nothing of a split for one golden, and names one whose max can’t keep within its share', () => {
    expect(suiteLines(planSuite(goldens(1, { costPerAttempt: 0.01 }))!)).toEqual(['forecast: about 25 attempts, up to 80 · about $0.248']);
    const short = suiteLines(planSuite(goldens(2, { gate: { ...gate, max: 20 }, maxGiven: true, costPerAttempt: 0.01 }))!);
    expect(short.at(-1)).toMatch(/^goldens\/g1: its max of 20 leaves \d+(\.\d+)?% of attempts at its good rate inconclusive, more than its 2\.5% share of the suite's risk: raise its max, or leave it out to let the session size it$/);
  });
});
