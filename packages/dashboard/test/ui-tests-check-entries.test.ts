import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, type StoredCheck } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import { ApiError, type Client, type TestsView } from '../ui/api.js';
import type { CoverageView } from '../ui/types.js';
import type { ChecksApi, ChecksConfig, GoldenEntry } from '../ui/checks-api.js';
import { checkPhrases, RemoveCheck } from '../ui/checks/RemoveCheck.js';
import type { OnShow } from '../ui/components/OnShow.js';
import { TestsPage } from '../ui/pages/Tests.js';
import type { BuilderProps, RemoveProps } from '../ui/run/check-part.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import type { ToastAction } from '../ui/toast.js';
import { shell, words } from './ui-overlays-page.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * What changes a golden's checks on Tests (ui/tests/check-entries.tsx): Edit and Remove at the end of
 * each check and Add check… after the last, the touch line under them, the builder opened on the
 * golden by the check's label, and Remove's dialog (ui/checks/RemoveCheck.tsx), which asks first with
 * the lines that leave shadowlap.config.json, writes against the version it read, and offers Undo.
 */

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const ISSUE = 'issue_refund called 1 time';
const SEND = 'send_email called 1 time';
const failed = (label: string): StoredCheck => ({ ok: false, status: 'failed', label, detail: 'called 0 times; tools called: add_note' });
const golden = (path: string, checks: string[]): GoldenSource => ({ path, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks });

function view(goldens: GoldenSource[]): TestsView {
  const s = Store.open(':memory:');
  const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', startedAt: T0 });
  s.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refunds', ok: false, failure: 'check', reason: 'failed', runId: null, revision: 'd2e8a1f', at: T0 + 1, data: { mode: 'replay', verdict: 'failed', checks: [failed(ISSUE), failed(SEND)] } });
  s.finishTestSession(session.sessionId, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
  const v = testsView(s, goldens);
  s.close();
  return v;
}
const BEFORE = [golden('goldens/refunds', [ISSUE, SEND]), golden('goldens/bare', [])];

const entry = (o: Partial<GoldenEntry> = {}): GoldenEntry => ({ path: 'goldens/refunds', key: 'goldens/refunds', pattern: false, mode: { label: 'replay', hint: 'replays offline' }, runId: null, inStore: false, entry: { expect: { tools: { issue_refund: 1, send_email: 1 } } }, error: null, ...o });
const config = (o: Partial<ChecksConfig> = {}): ChecksConfig => ({
  version: 'c0ffee12'.repeat(8),
  exists: true,
  indent: '  ',
  order: ['goldens/refunds'],
  read: { keys: {}, tests: { 'goldens/refunds': 't1' } },
  hasTests: true,
  relaid: false,
  agent: 'node agent.mjs',
  goldens: [entry()],
  redactions: 0,
  judges: [],
  models: ['claude-haiku-4-5'],
  ...o,
});

function checksStub(o: { cfg?: () => ChecksConfig; save?: ChecksApi['save']; undo?: ChecksApi['undo'] } = {}) {
  return {
    goldens: vi.fn(async () => (o.cfg ?? config)()),
    context: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(o.save ?? (async () => ({ key: 'goldens/refunds', version: 'b'.repeat(64), added: [], removed: [ISSUE], changed: true, was: 'w-1' }))),
    undo: vi.fn(o.undo ?? (async () => ({ key: 'goldens/refunds', version: 'c'.repeat(64), added: [ISSUE], removed: [], changed: true }))),
  };
}

let r: Rendered | null = null;
const g = globalThis as { location?: unknown };
afterEach(async () => {
  await r?.unmount();
  r = null;
  delete g.location;
});

/** The builder as the served dashboard hands it, standing in: it keeps each opening's props and closes on its one button. */
function fakeBuilder() {
  const opened: BuilderProps[] = [];
  const Part = Object.assign(
    (p: BuilderProps) => {
      opened.push(p);
      return createElement('div', { className: 'fakeb' }, createElement('button', { type: 'button', className: 'fakeb-close', onClick: p.onClose }, 'Close'));
    },
    { preload: vi.fn(), script: 'loaded' as const },
  ) as unknown as OnShow<BuilderProps>;
  return { Part, opened };
}

/** Tests with the builder handed in (unless `builder` is null), its view read from `tests`. */
async function openTests(o: { tests?: () => Promise<TestsView>; builder?: OnShow<BuilderProps> | null; actionsOff?: string | null; checks?: ReturnType<typeof checksStub>; toast?: (...a: unknown[]) => void; coverage?: CoverageView | null } = {}) {
  g.location = { hash: '#/tests' };
  const v = view(BEFORE);
  const client = {
    tests: o.tests ?? (() => Promise.resolve(v)),
    testEvidence: () => Promise.resolve({ attempts: [], carried: 0, gone: 0 }),
    jobs: () => Promise.resolve([]),
    offers: () => Promise.resolve(null),
    startJob: () => Promise.resolve({ id: 'j1' }),
    checks: o.checks ?? checksStub(),
    // What Tests reads under its goldens, Security's untrusted reads and Not covered's scan: none unless given.
    injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }),
    coverage: () => Promise.resolve(o.coverage ?? null),
  } as unknown as Client;
  const app = { client, tick: 0, feeds: {}, jobs: [], actionsOff: o.actionsOff ?? null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: o.toast ?? (() => undefined), refresh: () => undefined };
  const page = createElement(TestsPage);
  r = await render(shell(app as never, o.builder === null ? page : createElement(ServedPartsContext.Provider, { value: { CheckBuilder: o.builder ?? fakeBuilder().Part } }, page)));
  await r.until('the goldens to load', () => r!.all('table.gt tbody tr').length === 2);
  return r;
}

const rowOf = (page: Rendered, path: string) => page.all('table.gt tbody tr').find((tr) => tr.querySelectorAll(`[data-g="${path}"]`).length > 0 || tr.textContent.includes(path.replace('goldens/', '')))!;
const cardTitle = (b: FakeElement) => (JSON.parse(b.getAttribute('data-tip') ?? '{}') as { t?: string }).t;
const said = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();

describe('a golden’s checks on Tests', () => {
  it('end with Edit and Remove each and Add check… after the last, the touch line under them, and Add after exit status only', async () => {
    const page = await openTests();
    const cell = rowOf(page, 'goldens/refunds').querySelectorAll('td.chk')[0];
    const acts = (ck: FakeElement) => ck.querySelectorAll('.cka button').map((b) => [b.getAttribute('data-ck'), b.getAttribute('aria-label'), cardTitle(b)]);
    const [issue, send] = cell.querySelectorAll('.ck');
    expect(acts(issue)).toEqual([
      ['edit', `Edit ${ISSUE}`, 'Edit…'],
      ['remove', `Remove ${ISSUE}`, 'Remove'],
    ]);
    expect(acts(send)).toEqual([
      ['edit', `Edit ${SEND}`, 'Edit…'],
      ['remove', `Remove ${SEND}`, 'Remove'],
      ['add', 'Add check to refunds', 'Add check…'],
    ]);
    // The check's own words stay as they were: the buttons hold none.
    expect(said(issue.querySelectorAll('.cw')[0])).toBe(`${ISSUE}called 0 times; tools called: add_note`);
    expect(cell.querySelectorAll('.ckt button').map((b) => [b.textContent, b.getAttribute('data-label')])).toEqual([
      ['Edit checks…', ISSUE],
      ['Add check…', null],
    ]);
    // Drawn twice, as the checks are: under the name and in the Checks column.
    expect(rowOf(page, 'goldens/refunds').querySelectorAll('[data-ck="remove"]').length).toBe(4);
    const bare = rowOf(page, 'goldens/bare').querySelectorAll('td.chk')[0];
    expect(bare.children.map((c) => c.className)).toEqual(['nil', 'cka', 'ckt']);
    expect(bare.querySelectorAll('.cka button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add check to bare']);
    expect(bare.querySelectorAll('.ckt button').map((b) => b.textContent)).toEqual(['Add check…']);
  });

  it('offer nothing on a dashboard that can’t act, or where nothing hands the page the builder', async () => {
    let page = await openTests({ actionsOff: 'This dashboard is read-only: it was started with --read-only.' });
    expect(page.all('[data-ck]')).toEqual([]);
    await r!.unmount();
    page = await openTests({ builder: null });
    expect(page.all('[data-ck]')).toEqual([]);
    expect(page.all('table.gt .ck').length).toBeGreaterThan(0);
  });

  it('open the builder on the golden at the check by its label, Add check… with none, ask its script ahead, and read the view again on its close', async () => {
    const b = fakeBuilder();
    let reads = 0;
    const v = view(BEFORE);
    const page = await openTests({ builder: b.Part, tests: () => (reads++, Promise.resolve(v)) });
    const cell = rowOf(page, 'goldens/refunds').querySelectorAll('td.chk')[0];
    const edit = cell.querySelectorAll(`[data-ck="edit"][data-label="${SEND}"]`)[0];
    await page.hover(edit);
    expect(b.Part.preload).toHaveBeenCalled();
    await page.click(edit);
    expect(b.opened.at(-1)).toMatchObject({ golden: 'goldens/refunds', edit: SEND });
    const before = reads;
    await page.click(page.one('.fakeb-close'));
    await page.until('the view read again', () => reads > before);
    expect(page.all('.fakeb')).toEqual([]);
    await page.click(cell.querySelectorAll('.cka [data-ck="add"]')[0]);
    expect(b.opened.at(-1)).toMatchObject({ golden: 'goldens/refunds', edit: null });
    await page.click(page.one('.fakeb-close'));
    await page.click(cell.querySelectorAll('.ckt [data-ck="edit"]')[0]);
    expect(b.opened.at(-1)).toMatchObject({ golden: 'goldens/refunds', edit: ISSUE });
  });

  it('remove a check after asking, and hand the focus to the golden’s Add check… once the check has gone from the page', async () => {
    const checks = checksStub();
    const after = view([golden('goldens/refunds', [SEND]), golden('goldens/bare', [])]);
    let removed = false;
    const v = view(BEFORE);
    const page = await openTests({ checks, tests: () => Promise.resolve(removed ? after : v) });
    const remove = rowOf(page, 'goldens/refunds').querySelectorAll('td.chk')[0].querySelectorAll(`[data-ck="remove"][data-label="${ISSUE}"]`)[0];
    await page.click(remove);
    await page.until('Remove’s dialog', () => page.all('.dialog.ckrm .dlg-ok').length > 0 && !page.one('.dialog.ckrm .dlg-ok').hasAttribute('aria-disabled'));
    expect(words(page.focused())).toBe('button Cancel');
    checks.save.mockImplementation(async () => {
      removed = true;
      return { key: 'goldens/refunds', version: 'b'.repeat(64), added: [], removed: [ISSUE], changed: true, was: 'w-1' };
    });
    await page.click(page.one('.dialog.ckrm .dlg-ok'));
    await page.until('the view without the check', () => page.all(`[data-ck="remove"][data-label="${ISSUE}"]`).length === 0);
    await page.until('the focus on Add check…', () => page.focused().getAttribute('data-ck') === 'add');
    expect(page.focused().getAttribute('data-g')).toBe('goldens/refunds');
  });
});

describe('the step a golden’s checks lead Tests with', () => {
  const EDIT = 'It fails refunds’s own recording: edit the check, or update the golden if the agent should now do this';
  const STALE = 'Its checks changed since its last test: the session judges them as they are now';
  const stepped = (step: NonNullable<TestsView['steps']>[string]) => {
    const v = view(BEFORE);
    return () => Promise.resolve({ ...v, steps: { 'goldens/refunds': step } });
  };
  const editStep = stepped({ key: 'edit-check', label: 'Edit check…', golden: 'goldens/refunds', check: ISSUE, sub: EDIT });
  const card = (b: FakeElement) => JSON.parse(b.getAttribute('data-tip') ?? '{}') as { t?: string; s?: string };
  const runTests = (page: Rendered) => page.byText('button', 'Run tests');

  it('is Edit check, lime in the verdict, opening the builder at the check, with Run tests plain', async () => {
    const b = fakeBuilder();
    const page = await openTests({ builder: b.Part, tests: editStep });
    const step = page.one('.tv .actions button');
    expect([step.textContent, step.className.includes('lime'), card(step)]).toEqual(['Edit check…', true, { t: 'Edit check…', s: EDIT, rows: [] }]);
    expect(runTests(page).className.includes('lime')).toBe(false);
    await page.hover(step);
    expect(b.Part.preload).toHaveBeenCalled();
    await page.click(step);
    expect(b.opened.at(-1)).toMatchObject({ golden: 'goldens/refunds', edit: ISSUE });
  });

  it('keeps Edit check on a dashboard that can’t act, saying why, and draws none where nothing hands the page the builder', async () => {
    const b = fakeBuilder();
    let page = await openTests({ builder: b.Part, tests: editStep, actionsOff: 'This dashboard is read-only: it was started with --read-only.' });
    const step = page.one('.tv .actions button');
    expect([step.textContent, step.getAttribute('aria-disabled'), step.className.includes('lime')]).toEqual(['Edit check…', 'true', false]);
    await page.click(step);
    expect(b.opened).toEqual([]);
    await r!.unmount();
    page = await openTests({ builder: null, tests: editStep });
    expect(page.all('.tv .actions button')).toEqual([]);
    expect(runTests(page).className.includes('lime')).toBe(true);
  });

  it('is Run tests where its checks changed since: the header’s own, lime, saying so on its card, and none in the verdict', async () => {
    const page = await openTests({ tests: stepped({ key: 'run-tests', label: 'Run tests', golden: 'goldens/refunds', gone: [ISSUE], sub: STALE }) });
    expect(page.all('.tv .actions button')).toEqual([]);
    const run = runTests(page);
    expect([run.className.includes('lime'), card(run)]).toEqual([true, expect.objectContaining({ t: 'Run tests', s: STALE })]);
  });

  it('keeps the lime on Run tests where it is the step, Rescan coverage reading plain while runs imported since wait for a scan', async () => {
    const unscanned: CoverageView = { scan: null, newRuns: 3, groups: [], uncovered: 0, needsLook: null, commands: { scan: ['coverage'], pack: ['coverage', '--pack'] } };
    const page = await openTests({ tests: stepped({ key: 'run-tests', label: 'Run tests', golden: 'goldens/refunds', gone: [ISSUE], sub: STALE }), coverage: unscanned });
    await page.until('Not covered', () => page.all('#notcovered > header .btn').length === 1);
    expect([runTests(page).className, page.one('#notcovered > header .btn').className]).toEqual(['btn lime', 'btn sm']);
  });
});

async function openRemove(o: { checks?: ReturnType<typeof checksStub>; check?: string } = {}) {
  const checks = o.checks ?? checksStub();
  const toast = vi.fn();
  const props: RemoveProps = { golden: 'goldens/refunds', check: o.check ?? ISSUE, onClose: vi.fn(), onChanged: vi.fn() };
  r = await render(shell({ client: { checks } as never, toast }, createElement(RemoveCheck, props)));
  await r.until('the golden’s checks', () => r!.all('.dialog.ckrm .cb-file').length > 0 || (props.onClose as ReturnType<typeof vi.fn>).mock.calls.length > 0);
  return { page: r, checks, toast, props };
}

const undoOf = (toast: ReturnType<typeof vi.fn>): ToastAction => toast.mock.calls.find((c) => c[2])![2] as ToastAction;

describe('Remove check', () => {
  it('asks first, its check in code, with the lines that leave the file against the version read, the way on red and the focus on Cancel', async () => {
    const { page } = await openRemove();
    expect(said(page.one('.dialog.ckrm header h3'))).toBe('Remove check from refunds?');
    expect(said(page.one('.dialog.ckrm header p'))).toContain(`Removes ${ISSUE} from refunds’s entry in shadowlap.config.json; its other checks stay.`);
    expect(page.all('.dialog.ckrm header p code.ckl .ckp').map((p) => p.textContent)).toEqual([ISSUE]);
    expect(page.all('.dialog.ckrm .cb-k')).toEqual([]);
    // Only its own line goes: the other check's stays as it is, comma and all.
    expect(page.all('.cb-file .codebox .del').map((l) => l.textContent.trim())).toEqual(['−           "issue_refund": 1,']);
    expect(page.all('.cb-file .codebox .add')).toEqual([]);
    expect(said(page.one('.cb-ver'))).toBe('version c0ffee12 · saved only if unchanged');
    expect(said(page.one('.dlg-ok'))).toBe('Remove check');
    expect(page.one('.dlg-ok').className).toContain('danger');
    expect(words(page.focused())).toBe('button Cancel');
  });

  it('writes the entry without the check against the version read, says so with Undo, and Undo puts it back through the server', async () => {
    const { page, checks, toast, props } = await openRemove();
    await page.click(page.one('.dlg-ok'));
    await page.until('the write', () => (props.onClose as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(checks.save).toHaveBeenCalledWith({ golden: 'goldens/refunds', version: config().version, read: config().read, entry: { expect: { tools: { send_email: 1 } } } });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Check removed · refunds', 'notice', expect.objectContaining({ label: 'Undo', undo: true }));
    undoOf(toast).run();
    await page.until('the undo', () => toast.mock.calls.length > 1);
    expect(checks.undo).toHaveBeenCalledWith('w-1');
    expect(toast).toHaveBeenLastCalledWith('Back in shadowlap.config.json · goldens/refunds');
    expect(props.onChanged).toHaveBeenCalledTimes(2);
  });

  it('takes the checks out of the entry with its only check, and says so', async () => {
    const one = () => config({ goldens: [entry({ entry: { expect: { tools: { issue_refund: 1 } }, repeat: 2 } })] });
    const { page, checks } = await openRemove({ checks: checksStub({ cfg: one }) });
    expect(said(page.one('.dialog.ckrm header p'))).toContain(`Removes ${ISSUE} from refunds’s entry in shadowlap.config.json, its only check.`);
    await page.click(page.one('.dlg-ok'));
    await page.until('the write', () => checks.save.mock.calls.length > 0);
    expect(checks.save.mock.calls[0][0].entry).toEqual({ expect: null });
  });

  it('reads the file again after a 409 and offers Remove again under the refusal’s words', async () => {
    const said409 = 'shadowlap.config.json changed on disk since this page read it: "prices" added. It shows your change against the file as it is now; nothing was changed.';
    const checks = checksStub({ save: () => Promise.reject(new ApiError(409, said409)) });
    const { page, props } = await openRemove({ checks });
    await page.click(page.one('.dlg-ok'));
    await page.until('the conflict', () => page.all('.cb-warn').length > 0);
    expect(said(page.one('.cb-warn'))).toBe(said409);
    expect(said(page.one('.dlg-ok'))).toBe('Remove again');
    expect(checks.goldens).toHaveBeenCalledTimes(2);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('says an Undo the server refused in its words, the entry left as it is', async () => {
    const refused = 'shadowlap.config.json changed on disk since this change was saved, and Undo would write over that: nothing was changed.';
    const checks = checksStub({ undo: () => Promise.reject(new ApiError(409, refused)) });
    const { page, toast, props } = await openRemove({ checks });
    await page.click(page.one('.dlg-ok'));
    await page.until('the write', () => toast.mock.calls.length > 0);
    undoOf(toast).run();
    await page.until('the refusal', () => toast.mock.calls.length > 1);
    expect(toast).toHaveBeenLastCalledWith(refused, 'error');
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('closes on a check the entry doesn’t yield as written, saying to edit it there', async () => {
    const { toast, props, checks } = await openRemove({ check: 'escalate called 1 time' });
    expect(props.onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('This check isn’t in shadowlap.config.json as written: edit it there');
    expect(checks.save).not.toHaveBeenCalled();
  });
});

describe('a check set as code in prose', () => {
  it('breaks after its rule’s head, a condition’s colon and a comma, and before a condition’s and or a judge’s answers', () => {
    expect(checkPhrases('when lookup_order has result.amount > 100: escalate called at least 1 time')).toEqual(['when lookup_order has', 'result.amount > 100:', 'escalate called at least 1 time']);
    expect(checkPhrases('when lookup_order has result.total > 200 and result.paid = true: escalate called 1 time')).toEqual(['when lookup_order has', 'result.total > 200', 'and result.paid = true:', 'escalate called 1 time']);
    expect(checkPhrases('every issue_refund call: after lookup_order, amount <= lookup_order.result.total')).toEqual(['every issue_refund call:', 'after lookup_order,', 'amount <= lookup_order.result.total']);
    expect(checkPhrases('judge "explains the escalation" answers yes')).toEqual(['judge "explains the escalation"', 'answers yes']);
    expect(checkPhrases('send_email called 0 times')).toEqual(['send_email called 0 times']);
    // Never inside brackets or a tool's arguments.
    expect(checkPhrases('issue_refund called with {"order_id": "A-1, B"} 0 times')).toEqual(['issue_refund called with {"order_id": "A-1, B"} 0 times']);
  });
});
