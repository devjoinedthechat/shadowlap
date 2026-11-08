import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, type CallDetail, type RunDetail } from '../ui/api.js';
import type { CheckContext, CheckPreview, ChecksApi, ChecksConfig, GoldenEntry, PreviewRow } from '../ui/checks-api.js';
import { Builder } from '../ui/checks/Builder.js';
import type { BuilderProps } from '../ui/run/check-part.js';
import { noMedia, shell, words } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The check builder as it is drawn (ui/checks/Builder.tsx): from a call, its golden's checks with the
 * rule marked, the rule as a sentence, the agent's recordings judged and the entry as the file will
 * hold it; its save, a file changed since and a refusal; and on a golden, its own title and lead.
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

const RUN = '01K5CQ4V3H8M2XWQH6V3T9RB1D';
const GOLD = '01K5CQ0F9B7M2XWQH6V3T9RA0Z';
const run = { run: { runId: RUN, status: 'completed', mode: 'record' }, source: null, judged: null } as unknown as RunDetail;
const args = { order_id: 'A-1042', amount: 240 };
const call = { call: { callNo: 3, name: 'issue_refund', kind: 'tool' }, request: { args } } as unknown as CallDetail;

const golden = (o: Partial<GoldenEntry> = {}): GoldenEntry => ({ path: 'goldens/refund-flow', key: 'goldens/refund-flow', pattern: false, mode: { label: 'replay', hint: 'replays offline' }, runId: GOLD, inStore: true, entry: { expect: { tools: { send_email: 0 } } }, error: null, ...o });
const config = (o: Partial<ChecksConfig> = {}): ChecksConfig => ({
  version: 'c0ffee12'.repeat(8),
  exists: true,
  indent: '  ',
  order: ['goldens/refund-flow'],
  // As the server reads a file whose `tests` is an object: its entries printed apart, not as a key.
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
const context: CheckContext = {
  runId: RUN,
  at: { callNo: 3, tool: 'issue_refund', args, effect: 'write' },
  tools: [
    { callNo: 1, tool: 'lookup_order', args: { order_id: 'A-1042' }, effect: null },
    { callNo: 3, tool: 'issue_refund', args, effect: 'write' },
  ],
  before: ['lookup_order'],
  fields: [{ tool: 'lookup_order', field: 'total', value: 180, callNo: 1 }],
  conds: [{ tool: 'lookup_order', field: 'total', value: 180, callNo: 1 }],
};
const row = (runId: string, outcome: PreviewRow['outcome'], labels: string[] = []): PreviewRow => ({ runId, labels, outcome, na: false, why: outcome === 'failed' ? ['issue_refund called 1 time'] : [], checks: [] });
const preview: CheckPreview = {
  total: 3,
  judged: [row('01K5CQ1AAAAAAAAAAAAAAAAAAA', 'passed'), row('01K5CQ2BBBBBBBBBBBBBBBBBBB', 'passed'), row('01K5CQ3CCCCCCCCCCCCCCCCCCC', 'failed', ['bug'])],
  counts: { passed: 2, failed: 1, inconclusive: 0, notApplicable: 0 },
  notes: [],
  tools: ['lookup_order', 'issue_refund', 'escalate'],
  goldens: [{ path: 'goldens/refund-flow', runId: GOLD, row: row(GOLD, 'passed'), tools: ['lookup_order'], error: null }],
  madeFrom: null,
};

function stub(o: { cfg?: ChecksConfig; save?: ChecksApi['save'] } = {}) {
  const checks = {
    goldens: vi.fn(async () => o.cfg ?? config()),
    context: vi.fn(async () => context),
    preview: vi.fn(async () => preview),
    save: vi.fn(o.save ?? (async () => ({ key: 'goldens/refund-flow', version: 'b'.repeat(64), added: ['issue_refund called 0 times'], removed: [], changed: true }))),
  };
  return { checks, toast: vi.fn(), refresh: vi.fn(), onClose: vi.fn() };
}

async function open(s: ReturnType<typeof stub>, props: Partial<BuilderProps> = { run, call, kind: 'never' }): Promise<Rendered> {
  r = await render(shell({ client: { checks: s.checks } as never, toast: s.toast, refresh: s.refresh }, createElement(Builder, { ...props, onClose: s.onClose } as BuilderProps)));
  await r.until('the golden’s checks', () => r!.all('.cb-units li').length > 0);
  return r;
}

const said = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();
const text = (sel: string) => said(r!.all(sel)[0] ?? r!.one(sel));

describe('the check builder from a call', () => {
  it('shows the golden’s checks with the rule marked, the rule as a sentence, the recordings judged and the entry it writes', async () => {
    const s = stub();
    await open(s);
    await r!.until('the recordings judged', () => r!.all('.cb-count').length > 0);
    expect(text('.dialog.ckb header h3')).toBe('Add check');
    expect(text('.dialog.ckb header p')).toContain('Makes a check from #3 issue_refund in 01K5CQ4V3H, judged on your recordings as you build it.');
    expect(r!.all('.cb-units li').map((li) => li.textContent.replace(/\s+/g, ' ').trim())).toEqual(['send_email called 0 timesEditRemove', 'issue_refund called 0 timesnewRemove']);
    expect(text('.cb-k')).toContain('Checks ofrefund-flowreplay · goldens/refund-flow');
    expect(r!.one('.cb-kinds').getAttribute('aria-label')).toBe('What it checks');
    expect(words(r!.focused())).toBe('button Never');
    expect(s.checks.preview).toHaveBeenLastCalledWith({ tools: { issue_refund: 0 } }, { run: RUN });
    expect(text('.cb-count')).toBe('Passes 2 recordings · fails 1, labelled bug');
    expect(text('.cb-sub')).toContain('replay');
    // A comma comes after the count it follows: that line goes and comes again.
    expect(r!.all('.cb-file .codebox .del').map((l) => l.textContent.trim())).toEqual(['-           "send_email": 0']);
    expect(r!.all('.cb-file .codebox .add').map((l) => l.textContent.trim())).toEqual(['+           "send_email": 0,', '+           "issue_refund": 0']);
    expect(text('.cb-ver')).toBe('version c0ffee12 · saved only if unchanged');
    expect(text('.dlg-ok')).toBe('Save check');
  });

  it('saves the merged check against the version read, toasts where, and reads the runs again', async () => {
    const s = stub();
    await open(s);
    await r!.until('the recordings judged', () => r!.all('.cb-count').length > 0);
    await r!.click(r!.one('.dlg-ok'));
    await r!.until('the save', () => s.onClose.mock.calls.length > 0);
    expect(s.checks.save).toHaveBeenCalledWith({ golden: 'goldens/refund-flow', version: config().version, read: config().read, entry: { expect: { tools: { send_email: 0, issue_refund: 0 } } } });
    expect(s.toast).toHaveBeenCalledWith('Saved to shadowlap.config.json · goldens/refund-flow');
    expect(s.refresh).toHaveBeenCalled();
  });

  it('reads the file again after a 409, keeps the rule, and offers Save again under the conflict’s words', async () => {
    const said = 'shadowlap.config.json changed on disk since this page read it: "prices" added. It shows your change against the file as it is now; nothing was changed.';
    const s = stub({ save: () => Promise.reject(new ApiError(409, said)) });
    await open(s);
    await r!.click(r!.one('.dlg-ok'));
    await r!.until('the conflict', () => r!.all('.cb-warn').length > 0);
    expect(text('.cb-warn')).toBe(said);
    expect(text('.dlg-ok')).toBe('Save again');
    expect(s.checks.goldens).toHaveBeenCalledTimes(2);
    expect(r!.all('.cb-units li em').map((e) => e.textContent)).toEqual(['new']);
    expect(s.onClose).not.toHaveBeenCalled();
  });

  it('says a 400 in the dialog’s amber line and stays open', async () => {
    const said = 'shadowlap.config.json: tests["goldens/refund-flow"].expect.tools["issue_refund"] must be a count such as 0, ">= 1", "<= 12" or "2-4"';
    const s = stub({ save: () => Promise.reject(new ApiError(400, said)) });
    await open(s);
    await r!.click(r!.one('.dlg-ok'));
    await r!.until('the refusal', () => r!.all('.dwarn').length > 0);
    expect(text('.dwarn')).toBe(said);
    expect(s.onClose).not.toHaveBeenCalled();
    // Save stays off on the server's words until something changes.
    expect(r!.one('.dlg-ok').getAttribute('aria-disabled')).toBe('true');
    await r!.click(r!.all('.cb-kinds button')[1]);
    await r!.until('Save on again', () => r!.one('.dlg-ok').getAttribute('aria-disabled') === null);
    expect(r!.all('.dwarn')).toEqual([]);
  });

  it('drops an answer to an older draft: only the newest draft’s answer is drawn', async () => {
    const asked: Array<(p: CheckPreview) => void> = [];
    const s = stub();
    s.checks.preview.mockImplementation(() => new Promise<CheckPreview>((done) => asked.push(done)));
    await open(s);
    await r!.until('the first draft asked', () => asked.length === 1);
    // Another kind while the first draft's read is out: its answer comes late, and is dropped.
    await r!.click(r!.all('.cb-kinds button')[1]);
    const late = row('01K5CQ3CCCCCCCCCCCCCCCCCCC', 'failed');
    asked[0]({ ...preview, judged: [late, late, late], counts: { passed: 0, failed: 3, inconclusive: 0, notApplicable: 0 } });
    await r!.until('the newest draft asked', () => asked.length === 2);
    expect(r!.all('.cb-count')).toEqual([]);
    expect(r!.all('.cb-note').some((n) => said(n) === 'Judging it on your recordings…')).toBe(true);
    asked[1](preview);
    await r!.until('the newest answer', () => r!.all('.cb-count').length > 0);
    expect(text('.cb-count')).toBe('Passes 2 recordings · fails 1, labelled bug');
    expect(s.checks.preview).toHaveBeenCalledTimes(2);
  });

  it('judges no recording on a judge alone, says when it is asked, and keeps Save off until it is asked something', async () => {
    const s = stub();
    await open(s, { run, call, kind: 'judge' });
    expect(r!.one('.dlg-ok').getAttribute('aria-disabled')).toBe('true');
    await r!.type(r!.one('textarea[aria-label="The question it answers yes or no"]'), 'Does it say why the refund was refused?');
    await r!.type(r!.one('input[aria-label="Its name"]'), 'explains-refusal');
    await r!.until('the judge written', () => r!.all('.cb-count').length > 0);
    expect(text('.cb-count')).toBe('Inconclusive on every recording until the golden is packed or updated');
    expect(s.checks.preview).not.toHaveBeenCalled();
    expect(text('.dcost')).toContain('Billed by your provider');
    expect(text('.dcost')).toContain('replays read its verdict free');
    expect(text('.dcost')).toContain('its judge has not been asked yet, so what a call of it costs is unknown');
    expect(r!.one('.dlg-ok').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('the check builder on a golden', () => {
  it('adds a check to it, with none picked to start', async () => {
    const s = stub();
    await open(s, { golden: 'goldens/refund-flow', edit: null });
    expect(text('.dialog.ckb header h3')).toBe('Add check to refund-flow');
    expect(text('.dialog.ckb header p')).toContain('Adds a check to refund-flow, judged on your recordings as you build it.');
    expect(text('#cbEdit .cb-note')).toBe('Pick what it checks.');
    expect(r!.all('.cb-kinds [aria-pressed="true"]')).toEqual([]);
    expect(r!.one('.dlg-ok').getAttribute('aria-disabled')).toBe('true');
  });

  it('changes one of its checks, opened in the editor', async () => {
    const s = stub();
    await open(s, { golden: 'goldens/refund-flow', edit: 0 });
    expect(text('.dialog.ckb header h3')).toBe('Edit check of refund-flow');
    expect(text('.dialog.ckb header p')).toContain('Changes refund-flow’s check, judged on your recordings as you build it.');
    expect(r!.one('.cb-kinds [aria-pressed="true"]').textContent).toBe('Never');
    expect(text('.dlg-ok')).toBe('Save change');
    expect(s.checks.goldens).toHaveBeenCalledWith({ golden: 'goldens/refund-flow' });
  });
});
