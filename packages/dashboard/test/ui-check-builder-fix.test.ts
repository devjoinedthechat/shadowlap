import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../ui/api.js';
import type { CheckContext, CheckPreview, ChecksConfig, FixCheckPreview, FixCheckRow, GoldenEntry } from '../ui/checks-api.js';
import { Builder } from '../ui/checks/Builder.js';
import type { BuilderFix, BuilderProps } from '../ui/run/check-part.js';
import { noMedia, shell } from './ui-overlays-page.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * The check builder on a fix (ui/checks/FixMode.tsx): Edit check… on an open fix, its check as
 * units, its runs judged by the check as built, what a change does and Save check through the
 * fix-check job; and Add check to <golden>… beside a verified fix, the fix's runs folded for context,
 * or with no golden guarding it, how to pack one.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  noMedia();
});
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

const FIX = '01K5FIX0AAAAAAAAAAAAAAAAAA';
const RUN = '01K5CQ4V3H8M2XWQH6V3T9RB1D';
const LEFT = '01K5CQ5W4J9N3YXRJ7W4V0SC2E';
const GOOD = '01K5CQ6X5K0P4ZYSK8X5W1TD3F';
const DROPPED = '01K5CQ7Y6M1Q5AZTM9Y6X2VE4G';
const GOLD = '01K5CQ0F9B7M2XWQH6V3T9RA0Z';
const EXPECT = { tools: { issue_refund: 0 } };
const fix = (o: Partial<BuilderFix> = {}): BuilderFix => ({ fixId: FIX, title: 'Refund issued twice', label: 'refund-twice', expect: EXPECT, runId: RUN, blamesAgain: true, fixedRun: null, ...o });

const golden = (o: Partial<GoldenEntry> = {}): GoldenEntry => ({ path: 'goldens/refund-flow', key: 'goldens/refund-flow', pattern: false, mode: { label: 'replay', hint: 'replays offline' }, runId: GOLD, inStore: true, entry: { expect: { tools: { send_email: 0 } } }, error: null, ...o });
const config = (o: Partial<ChecksConfig> = {}): ChecksConfig => ({
  version: 'c0ffee12'.repeat(8),
  exists: true,
  indent: '  ',
  order: ['goldens/refund-flow'],
  read: { keys: { redact: 'k1' }, tests: { 'goldens/refund-flow': 't1' } },
  hasTests: true,
  relaid: false,
  agent: 'node agent.mjs',
  goldens: [golden()],
  redactions: 2,
  judges: [],
  models: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  ...o,
});
const context: CheckContext = { runId: RUN, at: null, tools: [{ callNo: 3, tool: 'issue_refund', args: { amount: 240 }, effect: 'write' }], before: [], fields: [], conds: [] };
const preview: CheckPreview = { total: 0, judged: [], counts: { passed: 0, failed: 0, inconclusive: 0, notApplicable: 0 }, notes: [], tools: ['issue_refund'], goldens: [], madeFrom: null };

const failed = { status: 'failed' as const, ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' };
const row = (runId: string, role: FixCheckRow['role'], outcome: FixCheckRow['outcome'], o: Partial<FixCheckRow> = {}): FixCheckRow => ({ runId, role, outcome, na: false, why: outcome === 'failed' ? ['issue_refund called 0 times, but called 1 time'] : [], checks: outcome === 'failed' ? [failed] : [], ...o });
const runs: FixCheckPreview = { rows: [row(RUN, 'failing', 'failed'), row(LEFT, 'failing', 'passed'), row(GOOD, 'good', 'passed'), row(DROPPED, 'good', 'failed')], refused: null, uncounted: [] };

function stub(o: { cfg?: ChecksConfig; answer?: FixCheckPreview; start?: () => Promise<unknown> } = {}) {
  const checks = {
    goldens: vi.fn(async () => o.cfg ?? config()),
    context: vi.fn(async () => context),
    preview: vi.fn(async () => preview),
    save: vi.fn(async () => ({ key: 'goldens/refund-flow', version: 'b'.repeat(64), added: [], removed: [], changed: true })),
    fixPreview: vi.fn(async () => o.answer ?? runs),
  };
  const startJob = vi.fn(o.start ?? (async () => ({ id: 'job-1', kind: 'fix-check' })));
  return { checks, startJob, watchJob: vi.fn(), toast: vi.fn(), onClose: vi.fn() };
}

/** What a page hands the builder, but its onClose: the test's own. */
type Opened = BuilderProps extends infer P ? (P extends unknown ? Omit<P, 'onClose'> : never) : never;

async function open(s: ReturnType<typeof stub>, props: Opened = { fix: fix() }): Promise<Rendered> {
  r = await render(shell({ client: { checks: s.checks, startJob: s.startJob } as never, toast: s.toast, watchJob: s.watchJob, refresh: vi.fn(), guard: (fn: () => void) => (fn(), true) }, createElement(Builder, { ...props, onClose: s.onClose } as BuilderProps)));
  await r.until('the check’s units', () => r!.all('.cb-units li').length > 0);
  return r;
}

const said = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const text = (sel: string) => said(r!.all(sel)[0] ?? r!.one(sel));
const rows = () => r!.all('.cb-fixr .cb-row').map((el) => [said(el.querySelector('.cb-role')!), el.querySelector('.cm')!.getAttribute('aria-label'), said(el.querySelector('.cb-d')!), el.className.includes(' y')]);
/** A row of What changes: its label, its value and the value's quiet part. */
const facts = () =>
  r!.all('.dfacts > div').map((el) => {
    const quiet = el.querySelector('small');
    const value = said(el.querySelector('dd')!);
    return [said(el.querySelector('dt')!), quiet ? value.slice(0, value.length - said(quiet).length) : value, quiet ? said(quiet) : ''].join(' | ');
  });
/** Another kind for the rule in the editor, Must call, once its runs were judged by the check as it was, then judged again. */
async function changeKind(s: ReturnType<typeof stub>) {
  await r!.until('its runs judged', () => s.checks.fixPreview.mock.calls.length === 1 && r!.all('.cb-fixr .cb-row').length > 0);
  await r!.click(r!.all('.cb-kinds button')[1]);
  await r!.until('the change judged', () => s.checks.fixPreview.mock.calls.length === 2 && r!.all('.cb-fixr .cb-row').length > 0);
}
const card = (el: FakeElement) => JSON.parse(el.getAttribute('data-tip') ?? 'null') as { t: string; s?: string; rows?: string[][] };

describe('the check builder in fix mode', () => {
  it('opens on the fix’s check, its first rule in the editor, its runs judged by it and what a change does', async () => {
    const s = stub();
    await open(s);
    await r!.until('its runs judged', () => r!.all('.cb-fixr .cb-row').length > 0);
    expect(text('.dialog.ckb header h3')).toBe('Edit check');
    expect(text('.dialog.ckb header p')).toContain('Changes what “Refund issued twice” must do.');
    expect(text('.cb-k')).toBe('The check of this fix');
    expect(r!.all('.cb-units li').map(said)).toEqual(['issue_refund called 0 timesRemove']);
    expect(r!.one('.cb-kinds [aria-pressed="true"]').textContent).toBe('Never');
    expect(s.checks.goldens).toHaveBeenCalledWith({ run: RUN });
    expect(s.checks.context).toHaveBeenCalledWith(RUN, Number.MAX_SAFE_INTEGER);
    expect(s.checks.preview).not.toHaveBeenCalled();
    expect(s.checks.fixPreview).toHaveBeenLastCalledWith(FIX, EXPECT, {});
    expect(r!.all('.cb-k .k').map(said)).toEqual(['The check of this fix', 'Its runs under this check', 'What changes']);
    expect(rows()).toEqual([
      ['failing', 'failed', 'still fails · issue_refund called 1 time', false],
      ['failing', 'passed', 'passes as recorded · it would leave the fix', true],
      ['good', 'passed', 'passes', false],
      ['good', 'failed', 'fails · it would no longer be kept as good', true],
    ]);
    // A run that doesn't pass shows what each check found on its card, from the keyboard too.
    const why = r!.all('.cb-fixr .cb-d')[0];
    expect([why.getAttribute('tabindex'), card(why)]).toEqual(['0', { t: 'Still fails', rows: [['issue_refund called 0 times', 'failed · called 1 time', 'var(--cq-red)']] }]);
    expect(r!.all('.cb-fixr .cb-d')[1].getAttribute('data-tip')).toBeNull();
    expect(text('.cb-sec .cb-cmd')).toContain(`shadowlap check ${RUN.slice(0, 10)}`);
    expect(facts()).toEqual(['Blame | runs again first, under this check | ', 'Repair, verify | use this check | ', 'Config | unchanged | the fix keeps its check in the store, not in shadowlap.config.json']);
    expect(said(r!.all('.cb-cmd').at(-1)!)).toContain(`shadowlap fix check 01K5FIX0AAAAA --expect '{"tools":{"issue_refund":0}}'`);
    const ok = r!.one('.dlg-ok');
    expect([said(ok), ok.getAttribute('aria-disabled'), card(ok).t]).toEqual(['Save check', 'true', 'Save check']);
    expect(ok.getAttribute('data-why')).toBe('Nothing changed yet');
  });

  it('saves a change through the fix-check job, plain while a run needs a look, and closes once it starts', async () => {
    const s = stub();
    await open(s);
    await changeKind(s);
    const merged = s.checks.fixPreview.mock.calls[1][1];
    expect(merged).not.toEqual(EXPECT);
    const ok = r!.one('.dlg-ok');
    expect([ok.getAttribute('aria-disabled'), ok.className.includes('lime'), card(ok).s]).toEqual([null, false, 'Saves it as it is, though something above needs a look']);
    await r!.click(ok);
    await r!.until('the job started', () => s.onClose.mock.calls.length > 0);
    expect(s.startJob).toHaveBeenCalledWith('fix-check', { fixId: FIX, expect: merged });
    expect(s.watchJob).toHaveBeenCalledTimes(1);
  });

  it('is lime once no run needs a look, and keeps its card on the store', async () => {
    const s = stub({ answer: { rows: [row(RUN, 'failing', 'failed'), row(GOOD, 'good', 'passed')], refused: null, uncounted: [] } });
    await open(s);
    await changeKind(s);
    const ok = r!.one('.dlg-ok');
    expect([ok.className.includes('lime'), card(ok).s]).toEqual([true, 'The fix keeps it in the store']);
  });

  it('keeps Save off on the refusal the fix’s runs give, and names a verdict that would stop counting', async () => {
    const refused = `None of ${FIX.slice(0, 13)}'s failing runs fails this check as recorded, so it would no longer be this failure. Nothing changed.`;
    const s = stub({ answer: { rows: [row(RUN, 'failing', 'passed', { na: true })], refused, uncounted: [{ verifyId: 'verify-1', code: 'verify-1abcde' }] } });
    await open(s);
    await changeKind(s);
    expect(r!.one('.dlg-ok').getAttribute('data-why')).toBe(refused);
    expect(rows()).toEqual([['failing', 'not applicable', 'not applicable · it would leave the fix', true]]);
    expect(facts()).toContain('Verdict | verify-1abcde no longer counts | it checked the old one');
  });

  it('keeps the builder open on a refusal of the job, its words in the amber line', async () => {
    const no = 'fx is verified: it keeps the check its accepted verdict counted under.';
    const s = stub({ answer: { rows: [row(RUN, 'failing', 'failed')], refused: null, uncounted: [] }, start: () => Promise.reject(new ApiError(409, no)) });
    await open(s);
    await changeKind(s);
    expect(r!.one('.dlg-ok').getAttribute('aria-disabled')).toBeNull();
    await r!.click(r!.one('.dlg-ok'));
    await r!.until('the refusal', () => r!.all('.dwarn').length > 0);
    expect(text('.dwarn')).toBe(no);
    expect(s.onClose).not.toHaveBeenCalled();
  });

  it('opens a fix whose check is the exit code alone on one blank rule, judging its runs by the exit code', async () => {
    const s = stub();
    await open(s, { fix: fix({ expect: null, blamesAgain: false }) });
    expect(r!.all('.cb-units li').map(said)).toEqual(['a new checknew']);
    await r!.until('its runs judged', () => r!.all('.cb-fixr .cb-row').length > 0);
    expect(s.checks.fixPreview).toHaveBeenLastCalledWith(FIX, {}, {});
    expect(facts()[0]).toBe('Repair, verify | use this check | ');
  });

  it('judges a judge’s rule whole, says when verify asks a judge a recording can’t settle, and bills it in each attempt', async () => {
    const JUDGE = { name: 'explains-refusal', question: 'Does the answer say why the refund was refused?', of: 'run', model: 'claude-haiku-4-5', pass: 'yes' };
    const judge = { status: 'inconclusive' as const, ok: false, label: 'judge "explains-refusal" answers yes', detail: 'no verdict recorded for it' };
    const s = stub({ answer: { rows: [row(RUN, 'failing', 'inconclusive', { checks: [judge], why: ['judge "explains-refusal" answers yes, but it is inconclusive: no verdict recorded for it'] })], refused: null, uncounted: [] } });
    await open(s, { fix: fix({ expect: { judge: [JUDGE] } }) });
    await r!.until('its runs judged', () => r!.all('.cb-fixr .cb-row').length > 0);
    expect(s.checks.fixPreview).toHaveBeenLastCalledWith(FIX, { judge: [JUDGE] }, {});
    expect(rows()).toEqual([['failing', 'inconclusive', 'inconclusive · no verdict recorded for it', true]]);
    expect(r!.all('.cb-note').map(said)).toContain('Verify’s judge is asked live in each attempt that exits 0.');
    const cost = text('.dcost');
    expect(cost).toContain('Billed by your provider');
    expect(cost).toContain('asked live in each attempt that exits 0');
    expect(cost).toContain('your 2 redaction rules apply');
    expect(cost).toContain('its judge has not been asked yet, so what a call of it costs is unknown');
    expect(cost).not.toContain('replays read its verdict free');
  });
});

describe('the check builder beside a verified fix', () => {
  it('adds a check to the golden that guards it, the fix’s runs under the draft folded for context', async () => {
    const s = stub();
    await open(s, { golden: 'goldens/refund-flow', edit: null, fix: fix() });
    expect(text('.dialog.ckb header h3')).toBe('Add check to refund-flow');
    expect(text('.dialog.ckb header p')).toContain('Adds a check to refund-flow, the golden that guards this fix.');
    expect(text('.cb-k')).toContain('Checks ofrefund-flow');
    expect(r!.all('.cb-k select')).toEqual([]);
    expect(s.checks.goldens).toHaveBeenCalledWith({ golden: 'goldens/refund-flow' });
    await r!.click(r!.all('.cb-kinds button')[0]);
    await r!.until('the fix’s runs judged', () => r!.all('.cb-more[aria-expanded]').some((b) => said(b).endsWith('runs')));
    expect(s.checks.fixPreview.mock.calls.at(-1)![2]).toEqual({ context: true });
    const fold = r!.all('.cb-more').at(-1)!;
    expect([said(fold), fold.getAttribute('aria-expanded'), rows()]).toEqual(['Show 4 runs', 'false', []]);
    await r!.click(fold);
    expect(rows()).toEqual([
      ['failing', 'failed', 'fails · issue_refund called 1 time', false],
      ['failing', 'passed', 'passes', false],
      ['good', 'passed', 'passes', false],
      ['good', 'failed', 'fails · issue_refund called 1 time', false],
    ]);
    expect(r!.all('.cb-k .k').map(said)).toContain('The fix’s runs');
    expect(text('.cb-fixr')).not.toContain('shadowlap check');
  });

  it('with no golden guarding it, says how to pack one from a recording of it working, Save off', async () => {
    const s = stub();
    await open(s, { golden: null, edit: null, fix: fix({ fixedRun: GOOD }) });
    expect(text('.dialog.ckb header h3')).toBe('Add check');
    expect(text('.dialog.ckb header p')).toContain('No golden guards this fix yet.');
    expect(s.checks.goldens).toHaveBeenCalledWith({ run: RUN });
    expect(r!.all('.cb-note').map(said)).toContain('No golden guards this fix yet. Pack one of its fixed runs as a golden, then add the check to it.');
    expect(said(r!.all('.cmdline').at(-1)!)).toContain(`shadowlap pack ${GOOD.slice(0, 10)} goldens/refund-twice`);
    await r!.click(r!.all('.cb-kinds button')[0]);
    await r!.until('Save’s why', () => r!.one('.dlg-ok').getAttribute('data-why') === 'No golden guards this fix');
  });
});
