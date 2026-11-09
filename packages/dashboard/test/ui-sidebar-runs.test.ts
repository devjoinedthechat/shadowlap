import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNS_TEXT } from '../ui/pages/Runs.js';
import { RunsTable } from '../ui/runspage/RunsTable.js';
import { statusGivesWay } from '../ui/runs.js';
import { RecentRuns } from '../ui/shell/Sidebar.js';
import type { RunListItem } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * The lists agree on depth and words. The sidebar draws a family as deep as it goes, a step in for
 * each level with its branch lines, as a run's lineage has it, and says a failure as Runs'
 * Status says it. Runs gives a fork's Status what came of its writes, or the check it failed, and
 * says clean replay where it names one.
 */

const T = Date.UTC(2026, 9, 22, 7, 48);
const run = (runId: string, o: Partial<RunListItem>): RunListItem => ({
  runId,
  parentRunId: null,
  depth: 0,
  mode: 'record',
  status: 'completed',
  label: 'recording',
  divergence: null,
  command: 'node refund_agent.mjs T-8812',
  codeVersion: 'c91d0f4',
  startedAt: T,
  endedAt: T + 1000,
  calls: 30,
  spent: 0.016,
  saved: 0,
  captured: 0,
  imported: false,
  covers: null,
  source: null,
  labels: [],
  kind: 'recording',
  outcome: { kind: 'none' },
  failed: false,
  origins: 'l'.repeat(30),
  ...o,
});

const REC = run('01M5H2DKE9E1HZP3QWVC8XN5RA', { startedAt: T });
const CLEAN = run('01M5H2DP5Y2Z8F0B4M7R1KD3QX', { parentRunId: REC.runId, mode: 'replay', kind: 'clean', label: 'clean replay', outcome: { kind: 'clean' }, origins: 'r'.repeat(30), startedAt: T + 1 });
const FORK = run('01M5H2ECBJ6W9N2T5H8K1D4FQZ', { parentRunId: REC.runId, mode: 'replay', kind: 'fork', label: 'fork @16', divergence: { callNo: 16, type: 'request_changed' }, origins: `${'r'.repeat(15)}${'l'.repeat(13)}bb`, startedAt: T + 2 });
// A fork of the fork: the grid nests it under the fork it came from, and so does the sidebar.
const FORK2 = run('01M5H2EDGW3J7P0X4C9V2B6NRM', { parentRunId: FORK.runId, mode: 'replay', kind: 'fork', label: 'fork @19', divergence: { callNo: 19, type: 'request_changed' }, origins: `${'r'.repeat(18)}ss`, calls: 20, startedAt: T + 3 });
// A fork whose check failed: send_email was called more often than its check allows.
const FAILED_FORK = run('01M5H2EFHX5K2Q8M1R7T4W9CZD', { parentRunId: REC.runId, mode: 'replay', kind: 'fork', label: 'fork @7', divergence: { callNo: 7, type: 'request_changed' }, status: 'completed', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true, origins: `${'r'.repeat(6)}${'l'.repeat(20)}bbbb`, startedAt: T + 4 });
// A recording blame found lost at its model call #9: the sidebar says so, and Runs that its check failed.
const LOST = run('01M5H2E9Q2C6YDRJ11VPNM4W0J', { command: 'node agent.mjs A-1150', status: 'failed', outcome: { kind: 'lost', callNo: 9 }, failed: true, lostAt: 9, calls: 11, origins: 'l'.repeat(11), startedAt: T - 10 });
// A test whose judge check could not be decided: neither passed nor failed.
const UNSURE = run('01M5H2EHJ4R8N3W6T1Y5B9CXQK', { parentRunId: REC.runId, mode: 'replay', kind: 'test', label: 'test', test: { golden: 'goldens/refund-polite' }, outcome: { kind: 'inconclusive', check: 'judge "polite" answers yes' }, origins: 'r'.repeat(30), startedAt: T + 5 });

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const byId = (r: Rendered, id: string) => r.all('a.run').find((a) => a.querySelector('.id')!.textContent === id.slice(0, 10))!;
const depthOf = (a: FakeElement) => (a.props.style as Record<string, number>)['--d'];

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('the sidebar’s recent runs', () => {
  it('draws each family as deep as it goes, a step in per level, with branch lines to later siblings', async () => {
    r = await render(createElement(RecentRuns, { runs: [LOST, REC, CLEAN, FORK, FORK2, FAILED_FORK], current: null, loading: false }));
    const rows = r.all('a.run').map((a) => [a.querySelector('.id')!.textContent, depthOf(a)]);
    expect(rows).toEqual([
      ['01M5H2DKE9', 0],
      ['01M5H2DP5Y', 1],
      ['01M5H2ECBJ', 1],
      ['01M5H2EDGW', 2],
      ['01M5H2EFHX', 1],
      ['01M5H2E9Q2', 0],
    ]);
    const tree = (id: string) =>
      byId(r!, id)
        .querySelector('.tree')
        ?.children.map((i) => `${i.className}@${(i.props.style as Record<string, number>)['--k']}`) ?? [];
    // The recording: a line down from its icon to its replay and forks.
    expect(tree(REC.runId)).toEqual(['tc@1']);
    // The fork with a fork of its own: the line goes on to its later sibling, bends into it, and goes down to its fork.
    expect(tree(FORK.runId)).toEqual(['tl@1', 'te@1', 'tc@2']);
    // The fork of the fork, a level further in: the line under the recording's runs goes on through it.
    expect(tree(FORK2.runId)).toEqual(['tl@1', 'te@2']);
    // The last fork: the line ends in it.
    expect(tree(FAILED_FORK.runId)).toEqual(['te@1']);
    expect(byId(r, LOST.runId).querySelector('.tree')).toBeNull();
  });

  it('says a failure in the words Runs’ Status uses, and a check it couldn’t decide in the design’s one word', async () => {
    r = await render(createElement(RecentRuns, { runs: [LOST, REC, CLEAN, FORK, FORK2, FAILED_FORK, UNSURE], current: null, loading: false }));
    const line = (id: string) => text(byId(r!, id).querySelector('.r2')!);
    const red = (id: string) => byId(r!, id).querySelector('.r2 em:not(.inc)')?.textContent ?? null;
    // Not "check failed": blame found where it was lost, and the sidebar says so.
    expect([red(LOST.runId), line(LOST.runId)]).toEqual(['lost at #9', 'lost at #9 · 11 calls']);
    expect([red(FAILED_FORK.runId), line(FAILED_FORK.runId)]).toEqual(['check failed', 'check failed · fork @7']);
    expect([red(FORK2.runId), line(FORK2.runId)]).toEqual([null, 'fork @19 · 0 live · 2 stubbed']);
    expect(line(CLEAN.runId)).toBe('clean replay · 30/30');
    // Amber, and shorter than Runs' "check inconclusive", as the design's sidebar says it.
    expect([byId(r, UNSURE.runId).querySelector('.r2 em.inc')?.textContent, line(UNSURE.runId)]).toEqual(['inconclusive', 'inconclusive · test']);
  });

  it('marks the words its status gives way with first, before the about line goes: its word stays, its icon saying the rest', async () => {
    expect(statusGivesWay('check failed')).toEqual({ lead: 'check ', word: 'failed', tail: '' });
    expect(statusGivesWay('lost at #9')).toEqual({ lead: '', word: 'lost', tail: ' at #9' });
    expect(statusGivesWay('lost gradually around #5 and #7')).toEqual({ lead: '', word: 'lost', tail: ' gradually around #5 and #7' });
    expect(statusGivesWay('lost between #3 and #5')?.word).toBe('lost');
    expect(statusGivesWay('diverged at #1')).toEqual({ lead: '', word: 'diverged', tail: ' at #1' });
    // No shorter word: it goes whole.
    for (const whole of ['exited 1', 'inconclusive', 'interrupted', '9 calls']) expect(statusGivesWay(whole)).toBeNull();
    // Beside an about line (decision 10), which a server that sends one gives each run.
    const about = { text: 'Order A-1150: the customer asks for a refund', from: 'user' as const };
    r = await render(createElement(RecentRuns, { runs: [{ ...LOST, about }, { ...FAILED_FORK, about }], current: null, loading: false }));
    const gives = (id: string) => byId(r!, id).querySelectorAll('.r2s .sgw').map((x) => x.textContent);
    expect(gives(LOST.runId)).toEqual([' at #9']);
    expect(gives(FAILED_FORK.runId)).toEqual(['check ']);
  });

  it('folds at its heading’s caret, which names it, loading, empty or full', async () => {
    for (const [runs, loading] of [
      [[LOST, REC], false],
      [[], false],
      [[], true],
    ] as const) {
      r = await render(createElement(RecentRuns, { runs: [...runs], current: null, loading, folded: true }));
      expect(r.one('.runs').getAttribute('id')).toBe('runs');
      expect(r.one('.runs').getAttribute('hidden')).not.toBeNull();
      await r.unmount();
      r = await render(createElement(RecentRuns, { runs: [...runs], current: null, loading }));
      expect(r.one('.runs').getAttribute('hidden')).toBeNull();
      await r.unmount();
      r = null;
    }
  });
});

describe('the Runs table', () => {
  const table = (rows: RunListItem[]) => createElement(RunsTable, { rows, picked: new Set<string>(), selectable: false, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: T + 60_000 });
  const row = (r: Rendered, id: string) => r.all('table.runst tbody tr').find((tr) => tr.querySelector('.rid code')!.textContent === id.slice(0, 10))!;

  it('gives a fork’s Status what came of its writes, its terms defined, and the check a run failed on hover', async () => {
    r = await render(table([FORK, FORK2, FAILED_FORK, LOST, REC]));
    // What shows: a defined term's definition is read out from a hidden part beside it.
    const shown = (el: FakeElement): string => (el.hasAttribute('hidden') ? '' : el.children.length ? el.childNodes.map((n) => ('tagName' in n ? shown(n) : n.textContent)).join('') : el.textContent);
    const status = (id: string) => {
      const st = row(r!, id).querySelector('.st')!;
      return [st.className, shown(st).replace(/\s+/g, ' ').trim()];
    };
    expect(status(FORK.runId)).toEqual(['st fk', 'forked · 2 writes blocked']);
    expect(status(FORK2.runId)).toEqual(['st fk', 'forked · 2 writes stubbed']);
    // At every width it wraps after the dot only, onto the row's second line.
    expect(shown(row(r, FORK.runId).querySelector('.st')!)).toBe('forked\u00a0· 2\u00a0writes\u00a0blocked');
    // A fork no check judges has no card of its own, so its first blocked and stubbed are the ones defined.
    expect(row(r, FORK.runId).querySelector('.st')!.getAttribute('data-tip')).toBeNull();
    expect(row(r, FORK.runId).querySelector('.st .term.on')!.getAttribute('data-term')).toBe('blocked');
    expect(row(r, FORK2.runId).querySelector('.st .term.on')!.getAttribute('data-term')).toBe('stubbed');
    // The check it failed is on hover, so the row keeps one line.
    expect(status(FAILED_FORK.runId)).toEqual(['st err', 'check failed']);
    expect(row(r, FAILED_FORK.runId).querySelector('.st')!.getAttribute('data-tip')).toContain('send_email called 1 time');
    // Blame found where it was lost, as the sidebar says; its Status says how it came out: the check it failed.
    expect(status(LOST.runId)).toEqual(['st err', 'check failed']);
    // A recording with nothing to report keeps its dash.
    expect(status(REC.runId)).toEqual(['st n', '—']);
  });

  it('says clean replay where it names one, and that every attempt is bundled', async () => {
    r = await render(table([CLEAN, FORK]));
    // The line under the id is the run's about line (decision 10); what kind of run it is, of which, and its command are on the id's hover.
    const hover = (id: string) => row(r!, id).querySelector('.rowa')!.getAttribute('title');
    expect(hover(CLEAN.runId)).toBe('clean replay of 01M5H2DKE9 · node refund_agent.mjs T-8812');
    expect(hover(FORK.runId)).toBe('fork @16 of 01M5H2DKE9 · node refund_agent.mjs T-8812');
    // Not only --repeat's, blame's and verify's: a golden's repeats and the error-path presets' too.
    expect(RUNS_TEXT).toBe('Recordings, and the replays and forks made from them. Attempts are bundled under the run they came from.');
  });
});
