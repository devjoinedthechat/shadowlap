import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_KINDS } from '../ui/api.js';
import type { Route } from '../ui/route.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';
import { minuteStamp } from '../ui/format.js';
import { packedGolden, packedTestAsk } from '../ui/not-covered/job-footer.js';
import { coverageSaid, foldSteps, lineSteps, packCommand, rescanLeads, whereOf } from '../ui/not-covered/model.js';
import { NotCovered } from '../ui/not-covered/NotCovered.js';
import { LookStepButton } from '../ui/overview/steps.js';
import type { CoverageGroupView, CoverageView, NeedsLookRow } from '../ui/types.js';

/**
 * Tests › Not covered and what scans and packs from elsewhere: what production did that no golden
 * tests. Rendered as the shell renders each part.
 */

const OVERVIEW: Route = { page: 'overview' };

function app(over: Partial<AppState> & { startJob?: () => Promise<unknown> } = {}): AppState {
  const { startJob = () => Promise.resolve({ id: 'j1' }), ...rest } = over;
  const base = {
    client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }), jobs: async () => [], startJob },
    exported: false,
    meta: null,
    conn: 'ok',
    runs: [],
    runCommands: [],
    actionsOff: null,
    hasKind: (k: string) => k === JOB_KINDS.coverage,
    jobs: [],
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    palette: true,
    setPalette: () => undefined,
    setSideOpen: () => undefined,
    setHelp: () => undefined,
  };
  return { ...base, ...rest } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Rescan coverage in the palette', () => {
  const row = (label: string) => r!.all('.palit').find((el) => el.querySelector('.pl')!.textContent === label);

  it('scans again from Actions where the server runs the scan, with the command as its hint, and never in a copy', async () => {
    const startJob = vi.fn(() => Promise.resolve({ id: 'j1' }));
    r = await render(createElement(AppContext.Provider, { value: app({ startJob }) }, createElement(Palette, { route: OVERVIEW })));
    await r.type(r.one('.palin input'), 'Rescan');
    expect(row('Rescan coverage')!.querySelector('.ph2')!.textContent).toBe('shadowlap coverage');
    await r.click(row('Rescan coverage')!);
    expect(startJob).toHaveBeenCalledWith(JOB_KINDS.coverage, {});
    await r.unmount();
    for (const over of [{ exported: true }, { hasKind: () => false }]) {
      r = await render(createElement(AppContext.Provider, { value: app(over) }, createElement(Palette, { route: OVERVIEW })));
      await r.type(r.one('.palin input'), 'Rescan');
      expect(row('Rescan coverage')).toBeUndefined();
      await r.unmount();
    }
    r = null;
  });
});

const NOW = Date.UTC(2026, 9, 1, 9, 50);
const KEY = '3f9a2c1d00112233';
const GONE = 'aaaa0000bbbb1111';
const SAME = 'cccc2222dddd3333';
const RUN = '01M3S1C7QDZ3W8X2V6B9TDRM4P';
const WHY = "python agent.py doesn't reproduce 01M3S1C7QD: diverged at call 11 (api POST /v1/messages), where the agent sends something else now";

function group(over: Partial<CoverageGroupView> = {}): CoverageGroupView {
  const key = over.key ?? KEY;
  return {
    key,
    covered: false,
    coveredBy: [],
    path: ['get_ticket', 'lookup_order', 'get_policy', 'check_stock', 'lookup_customer', 'lookup_history', 'issue_refund', 'send_email'],
    writes: ['issue_refund', 'send_email'],
    unknown: [],
    outcome: 'answered',
    line: 'get_ticket → lookup_order → … · writes issue_refund, send_email · answered',
    ended: 'answered',
    runs: 3,
    runIds: [RUN, '01M3S1C7QEZ3W8X2V6B9TDRM4P', '01M3S1C7QFZ3W8X2V6B9TDRM4P'],
    runId: RUN,
    sources: ['prod.har', 'tickets.har'],
    firstSeen: NOW - 86_400_000,
    lastSeen: NOW - 6_000_000,
    nearest: { golden: 'goldens/refund-flow-budget', shared: 2, differs: { step: 2, seen: 'get_policy', golden: 'lookup_customer' } },
    packed: null,
    lastPack: null,
    pack: { key, args: ['coverage', '--pack', key], command: ['python', 'agent.py', '{message}'], commandFrom: RUN, forkable: false },
    ...over,
  };
}

const gone = group({
  key: GONE,
  path: ['get_ticket', 'issue_refund'],
  writes: ['issue_refund'],
  runs: 1,
  runIds: [RUN],
  nearest: null,
  lastPack: { at: NOW - 3_600_000, golden: null, mode: null, reason: 'not-reproduced', why: WHY, command: { argv: ['python', 'agent.py', '{message}'], from: '--' }, by: 'dana@example.com' },
  pack: { key: GONE, args: ['coverage', '--pack', GONE], command: null, commandFrom: null, forkable: true },
});
const same = group({ key: SAME, path: ['get_ticket', 'lookup_order'], writes: [], outcome: 'agent-error', ended: 'the agent failed', runs: 2, nearest: { golden: 'goldens/triage', shared: 2, differs: null } });
const covered = group({ key: 'eeee4444ffff5555', covered: true, coveredBy: ['goldens/refund-in-limit'], runs: 4, pack: null });

function view(over: Partial<CoverageView> = {}): CoverageView {
  const groups = over.groups ?? [group(), gone, same, covered];
  return {
    scan: { scanId: 's1', at: NOW - 600_000, runs: 10, groups: groups.length, uncovered: 3, goldens: 2, actor: null, data: null },
    newRuns: 0,
    groups,
    uncovered: groups.filter((g) => !g.covered).length,
    needsLook: null,
    commands: { scan: ['coverage'], pack: ['coverage', '--pack'] },
    ...over,
  };
}

function tests(v: CoverageView | null, lime = true, over: Partial<AppState> & { startJob?: () => Promise<unknown> } = {}) {
  return createElement(AppContext.Provider, { value: app({ hasKind: () => true, feeds: {}, ...over }) }, createElement(NotCovered, { v, lime }));
}

describe('Tests › Not covered', () => {
  const rows = () => r!.all('.covl li');
  const text = (el: { textContent: string | null }) => el.textContent ?? '';

  it('draws a behaviour no golden covers in two lines from where it parts from its nearest golden, one group named in words', async () => {
    r = await render(tests(view()));
    expect(r.one('section#notcovered h2').textContent).toBe('Not covered');
    expect(text(r.one('#notcovered > header .sub'))).toBe('what production did that no golden tests, from where it parts from the nearest one: pack it, and CI replays it on every commit');
    expect(rows().map((li) => li.getAttribute('data-rowkey'))).toEqual([`cov:${KEY}`, `cov:${GONE}`, `cov:${SAME}`]);
    const [first, second, third] = rows();
    expect(text(first.querySelector('.l1')!)).toBe('get_policy → check_stock → … 2 more → issue_refund → send_email → answered');
    expect(first.querySelector('.cvmore')!.getAttribute('data-tip')).toContain('lookup_customer → lookup_history');
    expect(first.querySelectorAll('code.wr').map((c) => [c.textContent, c.getAttribute('title')])).toEqual([
      ['issue_refund', 'a write'],
      ['send_email', 'a write'],
    ]);
    expect(text(first.querySelector('.l2')!)).toBe('after lookup_order\u00a0· refund-flow-budget calls lookup_customer here');
    const line = first.querySelector('.cvln')!;
    expect(line.getAttribute('role')).toBe('group');
    expect(line.getAttribute('aria-label')).toBe(
      'get_ticket, then lookup_order, then get_policy, then check_stock, then lookup_customer, then lookup_history, then issue_refund, then send_email, then answered. Writes issue_refund, send_email. Nearest golden refund-flow-budget, the same for 2 steps, then it calls get_policy where the golden calls lookup_customer.',
    );
    // The agent no longer does it: the amber words on line 2, who tried it when and why on their card; Pack with checks…
    expect(text(second.querySelector('.l2')!)).toBe('no golden starts this way\u00a0· the agent no longer does this');
    expect(JSON.parse(second.querySelector('.cvst')!.getAttribute('data-tip')!)).toMatchObject({ t: `Pack as golden, ${minuteStamp(NOW - 3_600_000)} · dana`, s: WHY });
    // The same steps as its golden, another ending: its last step, red where it failed, and the dashboard's words.
    expect(text(third.querySelector('.l1')!)).toBe('lookup_order → agent failed');
    expect(third.querySelector('.cvend')!.className).toBe('cvend err');
    expect(text(third.querySelector('.l2')!)).toBe('triage takes the same steps, but it ends another way');
    expect(third.querySelector('.cvln')!.getAttribute('aria-label')).toContain('Nearest golden triage, the same for 2 steps, but it ends another way.');
    // How many runs (the toggle of its details) and when, and one action.
    const toggle = first.querySelector('button.cvn')!;
    expect([text(toggle), toggle.getAttribute('aria-label'), toggle.getAttribute('aria-expanded')]).toEqual(['3 runs', '3 runs, details of behaviour 3f9a2c1d', 'false']);
    expect(text(first.querySelector('.cvw')!)).toBe(minuteStamp(NOW - 6_000_000));
    expect(rows().map((li) => text(li.querySelector('.cvacts .btn')!))).toEqual(['Pack as golden', 'Pack with checks…', 'Pack as golden']);
    const card = JSON.parse(first.querySelector('.cvacts .btn')!.getAttribute('data-tip')!) as { t: string; s: string; cmd: string };
    expect(card).toMatchObject({ t: 'Pack as golden', s: 'Asks first: replays 01M3S1C7QD offline with the agent’s command, and packs it when it reproduces', cmd: `$ shadowlap coverage --pack ${KEY} -- python agent.py '{message}'` });
    // The key is the picture's, hidden from a screen reader; the foot the scan, with which golden covers what on its card.
    expect(r.one('.cvkey').getAttribute('aria-hidden')).toBe('true');
    expect(text(r.one('.cvfoot'))).toBe(`scanned ${minuteStamp(NOW - 600_000)} · 10 imported runs · 4 behaviours, 1 with a golden`);
    expect(JSON.parse(r.one('.cvcov').getAttribute('data-tip')!)).toMatchObject({ t: 'Covered by a golden', s: 'refund-in-limit · 4 runs' });
    expect(text(r.one('#notcovered > header .btn'))).toBe('Rescan coverage');
  });

  it('opens a row’s details from its count: the whole path, where it was seen, its nearest golden, the last try with its command and the plain pack, and its key', async () => {
    r = await render(tests(view()));
    await r.click(rows()[0].querySelector('button.cvn')!);
    const toggle = rows()[0].querySelector('button.cvn')!;
    expect([toggle.getAttribute('aria-expanded'), toggle.getAttribute('aria-controls')]).toEqual(['true', 'cvx-3f9a2c1d']);
    const terms = (id: string) => r!.all(`dl#${id} dt`).map((d) => d.textContent);
    expect(terms('cvx-3f9a2c1d')).toEqual(['Path', 'Seen', 'Nearest golden', 'Behaviour']);
    const dd = r.all('dl#cvx-3f9a2c1d dd').map((d) => d.textContent);
    expect(dd[0]).toBe('get_ticket → lookup_order → get_policy → check_stock → lookup_customer → lookup_history → issue_refund → send_email8 tool calls · writes issue_refund and send_email · then it answered');
    expect(dd[1]).toBe(`3 runs, the newest ${minuteStamp(NOW - 6_000_000)}: 01M3S1C7QD 01M3S1C7QE 01M3S1C7QFin prod.har and tickets.har`);
    expect(dd[2]).toBe('refund-flow-budget, the same for 2 steps; then it calls get_policy where the golden calls lookup_customer');
    expect(dd[3]).toBe(KEY);
    await r.click(rows()[1].querySelector('button.cvn')!);
    expect(terms('cvx-aaaa0000')).toEqual(['Path', 'Seen', 'Last tried', 'Behaviour']);
    const tried = r.all('dl#cvx-aaaa0000 dd')[2];
    expect(text(tried.querySelector('p')!)).toBe(`${minuteStamp(NOW - 3_600_000)}, by dana: ${WHY}`);
    expect(text(tried.querySelector('.cmdline')!)).toContain(`shadowlap coverage --pack ${GONE} -- python agent.py '{message}'`);
    const plain = tried.querySelector('.cvq .btn')!;
    expect(text(plain)).toBe('Pack as golden');
    expect(JSON.parse(plain.getAttribute('data-tip')!)).toMatchObject({ s: 'Asks first: replays 01M3S1C7QD offline with the agent’s command, and packs it when it reproduces. The last try found the agent no longer does this' });
  });

  it('shows only where there is an imported run to read: never scanned, runs imported since, every behaviour covered', async () => {
    // Nothing to read: no scan and no imported run, or a scan of none and none since.
    for (const v of [view({ scan: null, newRuns: 0, groups: [] }), view({ scan: { ...view().scan!, runs: 0 }, newRuns: 0, groups: [] }), null]) {
      r = await render(tests(v));
      expect(r.all('#notcovered')).toEqual([]);
      await r.unmount();
    }
    r = await render(tests(view({ scan: null, newRuns: 3, groups: [] })));
    expect(text(r.one('#notcovered .cvnone'))).toBe('Coverage hasn’t read the imported runs yet.');
    expect(text(r.one('.cvfoot'))).toBe('3 imported runs');
    expect(r.one('#notcovered > header .btn').className).toBe('btn sm lime');
    await r.unmount();
    r = await render(tests(view({ newRuns: 2 })));
    expect(text(r.one('.cvfoot'))).toMatch(/ · 2 runs imported since$/);
    expect(r.one('#notcovered > header .btn').className).toBe('btn sm lime');
    await r.unmount();
    // The page's own step leads: Rescan coverage reads plain.
    r = await render(tests(view({ newRuns: 2 }), false));
    expect(r.one('#notcovered > header .btn').className).toBe('btn sm');
    await r.unmount();
    r = await render(tests(view({ groups: [covered] })));
    expect(text(r.one('#notcovered .cvnone'))).toBe('Every behaviour production took has a golden.');
    expect(r.one('#notcovered > header .btn').className).toBe('btn sm');
    expect(r.all('.covl')).toEqual([]);
    expect([rescanLeads(view({ newRuns: 2 })), rescanLeads(view()), rescanLeads(view({ scan: null, newRuns: 0 }))]).toEqual([true, false, false]);
  });

  it('packs from a dialog that shows the path, the agent’s command and the command it runs, sending the yes it shows', async () => {
    const startJob = vi.fn(() => Promise.resolve({ id: 'j1' }));
    r = await render(tests(view(), true, { startJob }));
    await r.click(rows()[0].querySelector('.cvacts .btn')!);
    await r.until('the dialog opens', () => r!.all('.dialog').length === 1);
    expect(text(r.one('.dialog h3'))).toBe('Pack 3f9a2c1d as golden?');
    expect(text(r.one('.dialog header p'))).toContain('Packs 01M3S1C7QD into goldens/ once it reproduces offline.');
    expect(r.all('.dialog .dfacts > div').map((d) => [d.querySelector('dt')?.textContent, d.querySelector('dd')?.textContent])).toEqual([
      ['Changes', 'your working treea golden’s folder under goldens/'],
      ['Tools', 'answered from the capturea tool with no result there runs live, writes stubbed'],
    ]);
    expect(r.one('.dialog .cvk').getAttribute('aria-label')).toBe('get_ticket, then lookup_order, then get_policy, then check_stock, then lookup_customer, then lookup_history, then issue_refund, then send_email, then answered. Writes issue_refund, send_email.');
    expect(r.all('.dialog .cvc code').map((c) => c.textContent)).toEqual(['get_ticket', 'lookup_order', 'get_policy', 'check_stock', 'lookup_customer', 'lookup_history', 'issue_refund', 'send_email']);
    expect(r.one('.dialog input.cvin').value).toBe("python agent.py '{message}'");
    expect(text(r.one('.dialog .cvmsg'))).toBe('{message} stands for 01M3S1C7QD’s first message');
    expect(text(r.one('.dialog .cmdline'))).toContain(`shadowlap coverage --pack ${KEY} -- python agent.py '{message}'`);
    expect(text(r.one('.dialog .dcost'))).toContain('Free');
    await r.click(r.one('.dialog .dlg-ok'));
    expect(startJob).toHaveBeenCalledWith(JOB_KINDS.coveragePack, { key: KEY, command: "python agent.py '{message}'", confirmed: true });
    await r.unmount();
    // With checks: a golden that forks, judged by what the agent must do now, its --expect on the command.
    startJob.mockClear();
    r = await render(tests(view(), true, { startJob }));
    await r.click(rows()[1].querySelector('.cvacts .btn')!);
    await r.until('the dialog opens', () => r!.all('.dialog').length === 1);
    expect(text(r.one('.dialog h3'))).toBe('Pack aaaa0000 with checks?');
    expect(r.all('.dialog .dfacts dd')[0].textContent).toBe('your working treea golden’s folder under goldens/, and its entry in shadowlap.config.json with your checks');
    const [command, expect_] = r.all('.dialog input.cvin');
    expect([command.value, command.getAttribute('placeholder'), expect_.getAttribute('placeholder')]).toEqual(['', 'python agent.py {message}', '{"tools":{"issue_refund":0}}']);
    await r.type(command, 'python agent.py {message}');
    await r.type(expect_, '{"tools":{"issue_refund":0}}');
    expect(text(r.one('.dialog .cmdline'))).toContain(`shadowlap coverage --pack ${GONE} --fork --expect '{"tools":{"issue_refund":0}}' -- python agent.py {message}`);
    expect(text(r.one('.dialog .dlg-ok'))).toBe('Pack with checks');
    await r.click(r.one('.dialog .dlg-ok'));
    expect(startJob).toHaveBeenCalledWith(JOB_KINDS.coveragePack, { key: GONE, command: 'python agent.py {message}', fork: true, expect: '{"tools":{"issue_refund":0}}', confirmed: true });
  });

  it('ends a pack on Run test of the one golden it wrote, asking first for a golden that forks', () => {
    expect(packedGolden({ pack: [{ golden: 'goldens/get-ticket-issue-refund-aaaa00', mode: 'fork' }] })).toEqual({ golden: 'goldens/get-ticket-issue-refund-aaaa00', fork: true });
    expect(packedGolden({ pack: [{ key: GONE, reason: 'not-reproduced' }] })).toBeNull();
    expect(packedTestAsk('goldens/answer-3f9a2c', false)).toMatchObject({ title: 'Run test on answer-3f9a2c', lead: 'Replays answer-3f9a2c offline.', commands: ['shadowlap test goldens/answer-3f9a2c'] });
    expect(packedTestAsk('goldens/answer-3f9a2c', true).lead).toBe('Replays production’s run until your agent parts from it, then judges it by your checks.');
  });

  it('works the lines out of the scan: folds, where it parts, and the command a pack runs', () => {
    expect(foldSteps(['a', 'b', 'c', 'd', 'e'], [], 2)).toEqual([{ name: 'a', write: false }, { name: 'b', write: false }, { more: 2, names: ['c', 'd'] }, { name: 'e', write: false }]);
    expect(foldSteps(['a', 'b', 'c', 'd'], [], 2)).toEqual(['a', 'b', 'c', 'd'].map((name) => ({ name, write: false })));
    expect(lineSteps(group({ nearest: { golden: 'goldens/x', shared: 8, differs: { step: 8, seen: null, golden: 'refund' } } }))).toEqual([]);
    expect(whereOf(group({ nearest: { golden: 'goldens/x', shared: 8, differs: { step: 8, seen: null, golden: null } } }))).toEqual({ after: 'send_email', golden: 'x', calls: null });
    expect(whereOf(group({ nearest: null }))).toBeNull();
    expect(coverageSaid(group({ path: [], writes: [], outcome: 'no-model-calls', nearest: null }))).toBe('made no model calls. No writes.');
    expect(packCommand(KEY, { fork: true })).toBe(`shadowlap coverage --pack ${KEY} --fork --expect <checks>`);
  });
});

describe('Needs a look’s coverage step', () => {
  const text = (el: { textContent: string | null }) => el.textContent ?? '';
  const row: NeedsLookRow = { kind: 'coverage', icon: 'cap', title: '3 behaviours seen in production have no golden', detail: 'the newest', key: `attn:coverage:${KEY}`, group: 'tests', step: { of: 'pack', key: KEY, label: 'Pack as golden', fork: false }, href: '#/tests?at=notcovered', runId: RUN, fixId: null, at: NOW };

  it('packs the newest behaviour from the Overview, in Not covered’s dialog, waiting as every pack does', async () => {
    const startJob = vi.fn(() => Promise.resolve({ id: 'j1' }));
    const value = app({ hasKind: () => true, feeds: {}, startJob });
    (value.client as unknown as Record<string, unknown>).coverage = () => Promise.resolve(view());
    r = await render(createElement(AppContext.Provider, { value }, createElement(LookStepButton, { row, wait: () => null, version: '1' })));
    const button = r.one('.btn');
    expect(JSON.parse(button.getAttribute('data-tip')!)).toMatchObject({ t: 'Pack as golden', s: 'Asks first: replays 01M3S1C7QD offline with the agent’s command, and packs it when it reproduces', cmd: `$ shadowlap coverage --pack ${KEY}` });
    await r.click(button);
    await r.until('the dialog opens', () => r!.all('.dialog').length === 1);
    expect(text(r.one('.dialog h3'))).toBe('Pack 3f9a2c1d as golden?');
    await r.click(r.one('.dialog .dlg-ok'));
    expect(startJob).toHaveBeenCalledWith(JOB_KINDS.coveragePack, { key: KEY, command: "python agent.py '{message}'", confirmed: true });
    await r.unmount();
    r = await render(createElement(AppContext.Provider, { value }, createElement(LookStepButton, { row, wait: () => 'A test session is running: pack it once it is done', version: '1' })));
    expect(r.one('.btn').getAttribute('data-why')).toBe('A test session is running: pack it once it is done');
  });
});
