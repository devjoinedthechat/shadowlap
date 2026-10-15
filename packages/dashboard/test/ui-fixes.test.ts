import { describe, expect, it } from 'vitest';
import { bundledRuns, bundleGlyph, bundleLine, callRowCells, candidateTone, changeParts, chipKeeps, fixAction, fixName, inlineParts, laterStamp, outcomeTone, parseMarkdown, probeBadge, roleBadges, statusBadge, stepFor, verifyFor } from '../ui/fixes/model.js';
import type { BlameStep, FixBundle, FixDetail, VerifyStep } from '../ui/types.js';

// How the Fixes pages read a fix: the chips, the step and verdict a URL opens, the main action, the
// Blame step's row of calls, the change cut to what changed, the Forks view's bundles and report.md.

const verify = (verifyId: string, verdict: VerifyStep['verdict'] = 'accepted'): VerifyStep =>
  ({ verifyId, verdict, href: `#/fixes/fx-1/verify/${verifyId}`, label: `x · ${verdict}` }) as VerifyStep;

const actions = (o: Partial<FixDetail['actions']>): FixDetail['actions'] => ({ repair: null, apply: null, applied: false, ...o });

describe('the list', () => {
  it('keeps applied fixes under Verified, as the counts do', () => {
    expect(['open', 'verified', 'applied'].filter((status) => chipKeeps('verified', { status: status as 'open' }))).toEqual(['verified', 'applied']);
    expect(['open', 'verified', 'applied'].filter((status) => chipKeeps('open', { status: status as 'open' }))).toEqual(['open']);
    expect(['open', 'verified', 'applied'].filter((status) => chipKeeps('all', { status: status as 'open' }))).toHaveLength(3);
  });

  it('badges a fix by its status, and an applied one that doesn’t hold as broken', () => {
    expect(statusBadge({ status: 'open', broken: null })).toEqual({ tone: 'y', text: 'open' });
    expect(statusBadge({ status: 'verified', broken: null })).toEqual({ tone: 'ok', text: 'verified' });
    expect(statusBadge({ status: 'applied', broken: null })).toEqual({ tone: 'ok', text: 'applied' });
    expect(statusBadge({ status: 'applied', broken: 'shadowlap test failed on its goldens' })).toEqual({ tone: 'no', text: 'broken' });
  });

  it('names a fix by its label, or its short id', () => {
    expect(fixName({ label: 'refund-bug', fixId: 'fx-01M50JGKFVFPKCWKV33N9T9FG8' })).toBe('refund-bug');
    expect(fixName({ label: null, fixId: 'fx-01M50JGKFVFPKCWKV33N9T9FG8' })).toBe('fx-01M50JGKFV');
  });

  it('gives a later time alone on the same day', () => {
    const opened = new Date(2026, 8, 30, 16, 20).getTime();
    expect(laterStamp(new Date(2026, 8, 30, 17, 40).getTime(), opened)).toBe('17:40');
    expect(laterStamp(new Date(2026, 9, 1, 9, 5).getTime(), opened)).toBe('Oct 1, 09:05');
  });
});

describe('a fix', () => {
  it('opens on the step its URL names, else its last finished step', () => {
    expect(stepFor({ defaultStep: 'verify' }, null)).toBe('verify');
    expect(stepFor({ defaultStep: 'verify' }, 'blame')).toBe('blame');
    expect(stepFor({ defaultStep: 'repair' }, 'pit')).toBe('repair');
  });

  it('shows the verdict its URL names, by id or a prefix, else the one the fix shows first', () => {
    const fix = { verify: [verify('vf-01M50AAAAA'), verify('vf-01M50BBBBB', 'rejected')], defaultVerify: 'vf-01M50AAAAA' };
    expect(verifyFor(fix, null)!.verifyId).toBe('vf-01M50AAAAA');
    expect(verifyFor(fix, 'vf-01M50BBBBB')!.verifyId).toBe('vf-01M50BBBBB');
    expect(verifyFor(fix, 'VF-01M50B')!.verifyId).toBe('vf-01M50BBBBB');
    expect(verifyFor(fix, 'vf-nope')!.verifyId).toBe('vf-01M50AAAAA');
    expect(verifyFor({ verify: [], defaultVerify: null }, null)).toBeNull();
  });

  it('offers Repair from here on an open fix, Apply on a verified one, and Patch applied once it is in', () => {
    const repair = { argv: ['repair'], command: 'shadowlap repair' };
    const patch = { kind: 'patch' as const, argv: ['fix', 'apply', 'fx-1'], gitApply: 'git apply x/fix.patch', pending: null };
    expect(fixAction({ status: 'open', actions: actions({ repair }) })).toEqual({ kind: 'repair' });
    expect(fixAction({ status: 'open', actions: actions({}) }).kind).toBe('none');
    expect(fixAction({ status: 'verified', actions: actions({ apply: patch }) })).toEqual({ kind: 'apply', label: 'Apply the patch' });
    expect(fixAction({ status: 'verified', actions: actions({ apply: { ...patch, kind: 'mark', gitApply: null } }) })).toEqual({ kind: 'apply', label: 'Mark applied' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: patch, applied: true }) })).toEqual({ kind: 'applied' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: { ...patch, pending: 'run shadowlap test on its goldens' }, applied: true }) })).toEqual({ kind: 'apply', label: 'Finish applying' });
  });
});

describe('the Blame step', () => {
  const call = (callNo: number, kind: 'api' | 'tool', verdict: BlameStep['callRow'][number]['verdict'] = null): BlameStep['callRow'][number] => ({ callNo, kind, inScope: true, verdict, passes: verdict ? 2 : 0, attempts: verdict ? 4 : 0 });

  it('lines up every call of a short run', () => {
    const row = [call(1, 'api', 'rescued'), call(2, 'tool'), call(3, 'api', 'blamed'), call(4, 'tool'), call(5, 'api', 'lost')];
    const { cells, toolsLeftOut } = callRowCells(row);
    expect(toolsLeftOut).toBe(false);
    expect(cells.map((c) => [c.callNo, c.kind, c.verdict])).toEqual([
      [1, 'm', 'rescued'],
      [2, 't', null],
      [3, 'm', 'blamed'],
      [4, 't', null],
      [5, 'm', 'lost'],
    ]);
  });

  it('keeps the model calls of a longer run, and the probed ones with a gap for the rest of a long one', () => {
    const run = (models: number) => Array.from({ length: models * 2 }, (_, i) => call(i + 1, i % 2 ? 'tool' : 'api'));
    const mid = run(12);
    mid[10] = call(11, 'api', 'blamed');
    const out = callRowCells(mid);
    expect(out.toolsLeftOut).toBe(true);
    expect(out.cells.every((c) => c.kind === 'm')).toBe(true);
    expect(out.cells).toHaveLength(12);

    const long = run(400);
    long[500] = call(501, 'api', 'rescued');
    long[502] = call(503, 'api', 'blamed');
    long[504] = call(505, 'api', 'lost');
    const cut = callRowCells(long);
    const shown = cut.cells.filter((c) => c.kind !== 'gap').map((c) => c.callNo);
    expect(shown).toEqual(expect.arrayContaining([1, 499, 501, 503, 505, 507, 799]));
    expect(shown.length).toBeLessThanOrEqual(18);
    expect(cut.cells.some((c) => c.kind === 'gap')).toBe(true);
    // Cells stay in call order, gaps between them.
    const order = cut.cells.map((c) => c.callNo);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('badges a probe: rescued in lime, lost in red, the blamed one in amber', () => {
    expect(probeBadge('rescued')).toBe('ok');
    expect(probeBadge('lost')).toBe('no');
    expect(probeBadge('rescued · blamed')).toBe('y');
  });
});

describe('the Repair step', () => {
  const BEFORE = 'You are a support agent. Follow the refund policy.';
  const AFTER = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';

  it('marks the text a change added', () => {
    const parts = changeParts({ file: 'agent.mjs', anchor: 'system prompt', before: BEFORE, after: AFTER, added: { at: BEFORE.length - 1, text: ': escalate every refund above the limit it sets' }, removed: '' });
    expect(parts).toEqual({ was: BEFORE, head: 'You are a support agent. Follow the refund policy', added: ': escalate every refund above the limit it sets', tail: '.' });
  });

  it('cuts a long prompt to the change and some text on each side', () => {
    const long = `${'x'.repeat(1000)} Follow the policy.${'y'.repeat(1000)}`;
    const after = long.replace('Follow the policy.', 'Follow the policy. Refund each order once.');
    const at = long.indexOf('Follow the policy.') + 'Follow the policy.'.length;
    const parts = changeParts({ file: 'a', anchor: 'system prompt', before: long, after, added: { at, text: ' Refund each order once.' }, removed: '' }, 50);
    expect(parts.added).toBe(' Refund each order once.');
    expect(parts.head.startsWith('…')).toBe(true);
    expect(parts.head.length).toBe(51);
    expect(parts.tail.endsWith('…')).toBe(true);
    expect(parts.was.startsWith('…') && parts.was.endsWith('…')).toBe(true);
  });

  it('badges candidates and roles', () => {
    expect([candidateTone('accepted'), candidateTone('rejected'), candidateTone('set aside'), candidateTone('build failed')]).toEqual(['ok', 'no', 'n', 'no']);
    expect(roleBadges([{ role: 'target', held: 1, of: 1 }, { role: 'good', held: 0, of: 1 }])).toEqual([
      { text: 'target 1 of 1', tone: 'ok' },
      { text: 'good 0 of 1', tone: 'no' },
    ]);
  });
});

describe('the Verify step', () => {
  it('badges each outcome', () => {
    expect((['fixed', 'kept', 'not fixed', 'broken', 'unsettled'] as const).map(outcomeTone)).toEqual(['ok', 'ok', 'no', 'no', 'n']);
  });
});

describe('the Forks view’s bundles', () => {
  const bundle = (o: Partial<FixBundle>): FixBundle => ({ kind: 'blame', key: 'k', parentRunId: 'R', title: 'blame · probe #5', callNo: 5, blamed: false, change: null, verdict: null, role: null, passes: 1, attempts: [], spent: 0, at: 0, href: '#/fixes/fx-1/blame', fixId: 'fx-1', ...o });
  const attempt = (runId: string, passed: boolean, rescued = false) => ({ runId, passed, note: passed ? 'passed' : 'failed', href: `#/run/${runId}`, rescued });

  it('leaves out every attempt they list but the rescued fork, which shows as a fork', () => {
    const b = bundle({ attempts: [attempt('A', true, true), attempt('B', false)] });
    expect([...bundledRuns([b])]).toEqual(['B']);
  });

  it('gives a verify the icon of its verdict', () => {
    expect(bundleGlyph({ kind: 'blame', verdict: null }).kind).toBe('blame');
    expect(bundleGlyph({ kind: 'verify', verdict: 'accepted' })).toEqual({ kind: 'fixok', label: 'Verify accepted the change' });
    expect(bundleGlyph({ kind: 'verify', verdict: 'rejected' }).kind).toBe('fixbad');
    expect(bundleGlyph({ kind: 'verify', verdict: 'incomplete' }).kind).toBe('fork');
  });

  it('says how many attempts passed, what they cost, and for a verify the change and how it came out', () => {
    const money = (usd: number) => `≈$${usd.toFixed(3)}`;
    expect(bundleLine(bundle({ attempts: [attempt('A', true), attempt('B', false)], passes: 1, spent: 0.032 }), money)).toBe('2 attempts, 1 passed · ≈$0.032');
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true)], passes: 1, change: 'repair candidate 3', verdict: 'accepted' }), money)).toBe('1 attempt, 1 passed · repair candidate 3 accepted');
  });
});

describe('report.md', () => {
  const md = [
    '## Escalate refunds above the policy limit',
    '',
    'A change to the system prompt in `agent.mjs`:',
    '',
    '```diff',
    '- You are a support agent.',
    '+ You are a support agent. Escalate.',
    '```',
    '',
    '### What failed',
    '',
    '| Run | Lost at | What the agent did there |',
    '|---|---|---|',
    '| `01M50JGGW8` | model call #5 (3 of 4) | issue_refund({"a":1}) \\| more |',
    '',
    'A paragraph',
    'that goes on.',
    '- one',
    '- two',
  ].join('\n');

  it('reads the blocks a repair report writes', () => {
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'p', 'code', 'h', 'table', 'p', 'ul']);
    expect(blocks[0]).toEqual({ kind: 'h', level: 2, text: 'Escalate refunds above the policy limit' });
    expect(blocks[2]).toEqual({ kind: 'code', lang: 'diff', lines: ['- You are a support agent.', '+ You are a support agent. Escalate.'] });
    expect(blocks[4]).toEqual({ kind: 'table', head: ['Run', 'Lost at', 'What the agent did there'], rows: [['`01M50JGGW8`', 'model call #5 (3 of 4)', 'issue_refund({"a":1}) | more']] });
    expect(blocks[5]).toEqual({ kind: 'p', text: 'A paragraph that goes on.' });
    expect(blocks[6]).toEqual({ kind: 'ul', items: ['one', 'two'] });
  });

  it('sets text in backticks as code, and leaves the rest text', () => {
    expect(inlineParts('in `agent.mjs`: done')).toEqual([
      { code: false, text: 'in ' },
      { code: true, text: 'agent.mjs' },
      { code: false, text: ': done' },
    ]);
    expect(inlineParts('<b>not html</b>')).toEqual([{ code: false, text: '<b>not html</b>' }]);
  });
});
