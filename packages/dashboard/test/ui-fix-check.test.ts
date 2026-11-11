import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeFixCheck, checkKey, recordBlame, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, ORACLE, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixAttemptGroups } from '../src/attempt-groups.js';
import { fixDetail } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';
import type { Client } from '../ui/api.js';
import type { OnShow } from '../ui/components/OnShow.js';
import { checkEntryWords } from '../ui/fixes/check-entry.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { FixesPage } from '../ui/pages/Fixes.js';
import type { BuilderProps } from '../ui/run/check-part.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { actionSaid } from '../ui/toast.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Changing a fix's check, as its pages draw it: the check's judge on its card, and a fix whose check
 * changed after its blame and verdict, which say they were made under the old one. The server is the
 * read model itself, so the pages read what `GET /api/fixes/:id` would send.
 */

let store: Store;
let r: Rendered | null = null;

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

function app(over: Partial<AppState> = {}): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id)),
    fixes: () => Promise.resolve(fixesView(store)),
    attemptGroups: (id: string) => Promise.resolve(fixAttemptGroups(store, id)),
    jobs: () => Promise.resolve([]),
    startJob: () => new Promise(() => undefined),
  } as unknown as Client;
  return { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, ...over } as unknown as AppState;
}

/** The check builder as the served dashboard hands it in, standing in for it: what each opening gave it. */
function builderPart() {
  const opened: BuilderProps[] = [];
  const preload = vi.fn();
  const part = Object.assign(
    (p: BuilderProps) => {
      opened.push(p);
      return createElement('div', { className: 'stand-in' });
    },
    { preload, script: 'idle' },
  ) as unknown as OnShow<BuilderProps>;
  return { part, opened, preload };
}

/** The fix's page at a step, once its own header has loaded: with the builder handed in where `part` is given. */
async function open(fixId: string, step: string | null = null, o: { part?: OnShow<BuilderProps>; app?: Partial<AppState> } = {}): Promise<Rendered> {
  const page = createElement(FixPage, { id: fixId, step, sub: null });
  r = await render(createElement(AppContext.Provider, { value: app(o.app) }, o.part ? createElement(ServedPartsContext.Provider, { value: { CheckBuilder: o.part } }, page) : page));
  await r.until('the fix to load', () => r!.all('.ph.fxh h1').length === 1);
  return r;
}

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const card = (el: FakeElement): { t: string; s?: string; rows?: string[][] } => JSON.parse(el.getAttribute('data-tip') ?? 'null') as { t: string; s?: string; rows?: string[][] };
/** This file is type-checked with the browser code, which reads the engine as it is built, while the fixtures read its sources: one store either way. */
const newRun = (): string => makeRun(store as unknown as Parameters<typeof makeRun>[0], { labels: ['refund-bug'] });

const JUDGE = { name: 'explains-refusal', question: 'Does the answer say why the refund was refused?', of: 'run', model: 'claude-haiku-4-5', pass: 'yes' };
const DRAFT = { tools: { issue_refund: 0 } };

function blamed(runId: string, expect: unknown = EXPECT) {
  return recordBlame(store, { runId, report: blameReport(runId), expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, rerun: { flags: [], command: null }, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' }).fix;
}

describe("a fix's judge", () => {
  const judged = { ...EXPECT, judge: [JUDGE, { ...JUDGE, name: 'second', of: 'answer' }] };
  const asks = { t: 'judge "explains-refusal" answers yes', s: 'Asked live in each attempt that exits 0', rows: [['Asks', JUDGE.question, ''], ['Reads', 'the whole run', ''], ['Model', 'claude-haiku-4-5', '']] };

  it("puts its check's first judge on the Must line's card, on the fix's header and its Fixes row", async () => {
    const fix = blamed(newRun(), judged);
    await open(fix.fixId);
    const must = r!.all('.ph p.chk .fmv').at(-1)!;
    expect(card(must)).toEqual(asks);
    expect(must.getAttribute('tabindex')).toBe('0');
    await r!.unmount();
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(FixesPage, { id: null, step: null, sub: null })));
    await r.until('the list to load', () => r!.all('.pslist a.rt').length === 1);
    expect(r.all('.pslist .fm .fmv').flatMap((el) => (el.getAttribute('data-tip') ? [card(el)] : []))).toEqual([asks]);
  });

  it("gives each judge's line of the Blame step's check its own card, from the blame's check", async () => {
    const run = newRun();
    const fix = recordBlame(store, { runId: run, report: { ...blameReport(run, 'unrescuable'), oracle: [...ORACLE, 'judge "explains-refusal" answers yes', 'judge "second" answers yes'] }, expect: judged, scope: null, command: 'shadowlap blame', rerun: { flags: [], command: null }, title: 't', checkText: 'c' }).fix;
    await open(fix.fixId, 'blame');
    const lines = r!.all('ul.fxlist li span[data-tip]');
    expect(lines.map((el) => [text(el), card(el).rows?.[1]?.[1]])).toEqual([
      ['judge "explains-refusal" answers yes', 'the whole run'],
      ['judge "second" answers yes', 'the answer'],
    ]);
    expect(lines.every((el) => el.getAttribute('tabindex') === '0')).toBe(true);
  });
});

describe("a fix's page after its check changed", () => {
  const change = (fixId: string, failing: string) =>
    changeFixCheck(store, fixId, { check: { expect: DRAFT, key: checkKey(DRAFT), oracle: ['the agent exits 0', 'issue_refund called 0 times'], text: 'issue_refund never called' }, judged: { failing: { [failing]: 'failed' }, good: {} } });

  it('says its blame was found under the old check, and blames again under the fix’s first, Run repair saying so', async () => {
    const run = newRun();
    const fix = blamed(run);
    change(fix.fixId, run);
    await open(fix.fixId, 'blame');
    expect(text(r!.one('p.fxreceipt.fxold'))).toBe('Found under the fix’s old check, issue_refund never called with {"amount":240}. Run blame again searches under the new one:');
    expect(text(r!.one('.cmdline.fxoldcmd'))).toContain(`blame ${run} --expect`);
    const again = r!.byText('button', 'Run blame again');
    expect(card(again).t).toBe('Finds the call that lost the run under the fix’s check');
    expect(again.className).toContain('lime');
    expect(card(r!.byText('button', 'Run repair')).s).toBe('Its blame was found under the old check: repair blames again first, under the fix’s check');
  });

  it('says a verdict checked under the old check is kept and no longer counted, with the verify command under the fix’s check', async () => {
    const run = newRun();
    const fix = blamed(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: false }], { oracle: ORACLE }), expect: EXPECT, command: 'shadowlap verify', at: Date.now() });
    change(fix.fixId, run);
    await open(fix.fixId, 'verify');
    expect(text(r!.one('p.fxreceipt.fxold'))).toBe('Checked under the fix’s old check: kept, and no longer counted for it. Verify the change under its check now:');
    expect(text(r!.one('.cmdline.fxoldcmd'))).toContain(JSON.stringify(DRAFT));
  });
});

describe("the way to change a fix's check", () => {
  it("ends an open fix's Must line on Edit check…, its card saying what it judges, and opens the builder on the fix's check", async () => {
    const run = newRun();
    const fix = blamed(run);
    const b = builderPart();
    await open(fix.fixId, null, { part: b.part });
    const link = r!.one('.ph p.chk .fm .fmx button');
    expect([text(link), link.className, card(link)]).toEqual(['Edit check…', 'linkbtn', { t: 'Edit check…', s: 'Judges its failing and good runs again from their recordings, nothing replayed', rows: [] }]);
    expect(text(r!.one('.ph p.chk'))).toBe('Must: issue_refund never called with {"amount":240}Edit check…');
    await r!.hover(link);
    expect(b.preload).toHaveBeenCalled();
    await r!.click(link);
    await r!.until('the builder', () => r!.all('.stand-in').length === 1);
    expect(b.opened.at(-1)).toMatchObject({ fix: { fixId: fix.fixId, title: fix.title, label: 'refund-bug', expect: EXPECT, runId: run, blamesAgain: true, fixedRun: null } });
    expect('golden' in b.opened.at(-1)!).toBe(false);
  });

  it('waits where the server runs no fix-check job, and draws nothing where no builder is handed in, as in a copy', async () => {
    const fix = blamed(newRun());
    await open(fix.fixId, null, { part: builderPart().part, app: { hasKind: (kind: string) => kind !== 'fix-check' } });
    const link = r!.one('.ph p.chk .fmx button');
    expect([link.getAttribute('aria-disabled'), link.getAttribute('data-why')]).toEqual(['true', 'This dashboard doesn’t run it: run the command in a terminal.']);
    await r!.unmount();
    await open(fix.fixId);
    expect(r!.all('.ph p.chk .fmx')).toEqual([]);
  });

  it('offers a verified fix a check added to the golden that guards it, and with none, a check of its own to pack one for', async () => {
    const run = makeRun(store as unknown as Parameters<typeof makeRun>[0], { labels: ['refund-bug'], meta: { test: { golden: 'goldens/refund-flow' } } });
    const fix = blamed(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true }], { oracle: ORACLE }), expect: EXPECT, command: 'shadowlap verify', at: Date.now() });
    const b = builderPart();
    await open(fix.fixId, null, { part: b.part });
    const link = r!.one('.ph p.chk .fmx button');
    expect([text(link), card(link).s]).toEqual(['Add check to refund-flow…', 'The fix keeps the check its verdict was given under; refund-flow keeps the fix, and takes a new one']);
    await r!.click(link);
    await r!.until('the builder', () => b.opened.length > 0);
    expect(b.opened.at(-1)).toMatchObject({ golden: 'goldens/refund-flow', edit: null, fix: { fixId: fix.fixId, runId: run } });
    expect(checkEntryWords({ status: 'verified', guard: null })).toEqual({ label: 'Add check…', sub: 'The fix keeps the check its verdict was given under, and no golden keeps it yet' });
  });

  it("gives a repair that rejected every candidate Edit check… as its way out, in the notice Run repair's press raises", async () => {
    const run = newRun();
    const fix = blamed(run);
    recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [run], accepted: false }), expect: EXPECT, command: 'shadowlap repair', at: Date.now() });
    const b = builderPart();
    const toast = vi.fn();
    await open(fix.fixId, null, { part: b.part, app: { toast } });
    const repair = r!.byText('.ph .actions button', 'Run repair');
    expect(card(repair).s).toBe('Nothing has changed since its last repair, whose gate rejected every candidate: edit the check, or verify a change of your own');
    await r!.click(repair);
    const [why, kind, action] = toast.mock.calls.at(-1) as [string, string, { label: string; run: () => void; returnTo: unknown }];
    expect([why, kind, action.label, action.returnTo === repair]).toEqual(['Repair rejected every candidate', 'notice', 'Edit check…', true]);
    // What the notice's live region says of it.
    expect(`${why}${actionSaid(action, false)}`).toBe('Repair rejected every candidate · Edit check… in the notice');
    action.run();
    await r!.until('the builder', () => r!.all('.stand-in').length === 1);
    expect(b.opened.at(-1)).toMatchObject({ fix: { fixId: fix.fixId } });
  });
});
