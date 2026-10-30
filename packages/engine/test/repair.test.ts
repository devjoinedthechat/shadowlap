import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lostWhere } from '../src/blame.js';
import { plain } from '../src/report.js';
import { applyEdit, caseDetails, checkEdit, editSize, findAnchors, forbiddenDetails, formatRepair, noRepairerOf, repairMarkdown, unifiedDiff, type Anchor } from '../src/repair.js';
import { repairReport } from './fix-fixtures.js';

const AGENT = `const system = process.env.AGENT_SYSTEM ?? 'You are a support agent. Follow the refund policy.';
const tools = [
  { name: 'issue_refund', description: 'Refund an order.' },
  { name: 'escalate', description: 'Hand the case to a manager.' },
];
`;

describe('findAnchors', () => {
  it('anchors the largest span of each text that appears exactly once in the project', () => {
    const anchors = findAnchors(
      [
        { label: 'system prompt', text: 'You are a support agent. Follow the refund policy.' },
        { label: 'tool issue_refund', text: 'Refund an order.' },
        { label: 'tool escalate', text: 'Hand the case to a manager.' },
      ],
      [{ path: 'agent.mjs', content: AGENT }],
    );
    expect(anchors.map((a) => [a.id, a.surface, a.text])).toEqual([
      [1, 'system prompt', 'You are a support agent. Follow the refund policy.'],
      [2, 'tool issue_refund', 'Refund an order.'],
      [3, 'tool escalate', 'Hand the case to a manager.'],
    ]);
    expect(AGENT.slice(anchors[0].offset, anchors[0].offset + anchors[0].text.length)).toBe(anchors[0].text);
  });

  it('falls back to sentences when the prompt is assembled, and skips text that appears twice', () => {
    const files = [
      { path: 'prompt.ts', content: "const base = 'You are a support agent.';\nconst rule = 'Follow the refund policy.';\nconst today = `Today is ${date}.`;" },
      { path: 'test/prompt.test.ts', content: "expect(p).toContain('Follow the refund policy.');" },
    ];
    const anchors = findAnchors([{ label: 'system prompt', text: 'You are a support agent. Follow the refund policy. Today is 2026-09-30.' }], files);
    // The whole prompt is built from pieces; the second sentence is also in a test, so it is not
    // unique. The third was sent with the date filled in, and anchors where the file has ${date}.
    expect(anchors.map((a) => [a.text, a.file])).toEqual([
      ['You are a support agent.', 'prompt.ts'],
      ['Today is ${date}.', 'prompt.ts'],
    ]);
  });
});

describe('case details', () => {
  it('finds ids, amounts and addresses, and leaves words and single digits alone', () => {
    expect([...caseDetails('Refund order A-1042 for $1,240.00 to jo@example.com in 2 days; ticket INC_7731, sku 9f2x')].sort()).toEqual(['1042', '1240', '7731', '9f2x', 'a-1042', 'inc_7731', 'jo@example.com']);
  });

  it('forbids what only the failing runs contain', () => {
    const forbidden = forbiddenDetails(['order A-1042, amount 240; policy: above $100 escalate'], ['order B-7, amount 40; policy: above $100 escalate', 'You are a support agent.']);
    expect([...forbidden].sort()).toEqual(['1042', '240', 'a-1042']);
  });
});

describe('checkEdit', () => {
  const anchors: Anchor[] = [{ id: 1, surface: 'system prompt', text: 'You are a support agent. Follow the refund policy.', file: 'agent.mjs', offset: 0 }];
  const forbidden = new Set(['a-1042', '1042', '240']);
  const edit = (replace: string, anchor = 1) => checkEdit({ anchor, replace, strategy: 's', why: 'w' }, anchors, forbidden);

  it('accepts a general rewrite and rejects one fitted to the failing case', () => {
    expect(edit('You are a support agent. Follow the refund policy: escalate any refund above $100 instead of issuing it.')).toEqual({ ok: true });
    expect(edit('You are a support agent. Never refund order A-1042.')).toEqual({ ok: false, reason: expect.stringContaining('mentions A-1042, which only the failing runs contain') });
    expect(edit('You are a support agent. Escalate refunds of $240.')).toEqual({ ok: false, reason: expect.stringContaining('mentions 240') });
  });

  it('rejects what could not be applied safely', () => {
    expect(edit('x', 9)).toEqual({ ok: false, reason: 'anchor 9 does not exist' });
    expect(edit('  ')).toEqual({ ok: false, reason: 'the replacement is empty' });
    expect(edit('You are a support agent. Follow the refund policy.')).toMatchObject({ ok: false });
    expect(edit("You are a support agent. Don't refund above the limit.")).toEqual({ ok: false, reason: expect.stringContaining("adds a ' quote, 1 where the text it replaces has none, which could end the string") });
    // A span that has a quote already: the count says so, rather than that it has none.
    const quoted: Anchor[] = [{ id: 1, surface: 'system prompt', text: "Don't refund above the limit.", file: 'agent.mjs', offset: 0 }];
    expect(checkEdit({ anchor: 1, replace: "Don't refund, and don't promise one.", strategy: 's', why: 'w' }, quoted, forbidden)).toEqual({ ok: false, reason: "it adds a ' quote, 2 where the text it replaces has 1, which could end the string it goes into in agent.mjs" });
    expect(edit('You are a support agent.\nFollow the refund policy.')).toEqual({ ok: false, reason: expect.stringContaining('several lines') });
    expect(edit('a'.repeat(700))).toEqual({ ok: false, reason: expect.stringContaining('far longer') });
  });
});

describe('checkEdit on a prose file', () => {
  it('allows the punctuation of prose in a Markdown policy, where no string can break', () => {
    const policy: Anchor[] = [{ id: 1, surface: 'system prompt', text: '- Refunds above $100 need approval.', file: 'data/retail/policy.md', offset: 0 }];
    expect(checkEdit({ anchor: 1, replace: "- Refunds above $100 need a manager's approval: don't issue them yourself.", strategy: 's', why: 'w' }, policy, new Set())).toEqual({ ok: true });
  });
});

describe('editSize and applyEdit', () => {
  it('counts only what changed', () => {
    expect(editSize('Follow the refund policy.', 'Follow the refund policy. Escalate above $100.')).toBe(21);
    expect(editSize('abc', 'abc')).toBe(0);
    expect(editSize('use small-model', 'use big-model')).toBe(8);
  });

  it('refuses to apply an edit to a file that moved', () => {
    expect(applyEdit('say hello world', { offset: 4, text: 'hello' }, 'hi')).toBe('say hi world');
    expect(() => applyEdit('say hullo world', { offset: 4, text: 'hello' }, 'hi')).toThrow(/changed since/);
  });
});

describe('unifiedDiff', () => {
  function gitApplies(before: string, after: string): void {
    const dir = mkdtempSync(join(tmpdir(), 'fp-diff-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      // The patch is what is tested, not the line endings: Git for Windows converts them on checkout
      // and apply (core.autocrlf, set system-wide on Windows runners).
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
      writeFileSync(join(dir, 'agent.mjs'), before);
      writeFileSync(join(dir, 'fix.patch'), unifiedDiff('agent.mjs', before, after));
      execFileSync('git', ['apply', 'fix.patch'], { cwd: dir });
      expect(readFileSync(join(dir, 'agent.mjs'), 'utf8')).toBe(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes one hunk that git applies, in the middle, at either end, and without a final newline', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const at = (i: number, text: string) => lines.map((l, j) => (j === i ? text : l)).join('\n') + '\n';
    const before = lines.join('\n') + '\n';
    gitApplies(before, at(9, 'line 10, fixed'));
    gitApplies(before, at(0, 'first, fixed'));
    gitApplies(before, at(19, 'last, fixed'));
    gitApplies(lines.join('\n'), lines.slice(0, 19).join('\n') + '\nlast, fixed');
    gitApplies(AGENT, AGENT.replace('Follow the refund policy.', 'Follow the refund policy. Escalate refunds above $100.'));
  });

  it('shows the change with its context', () => {
    const d = unifiedDiff('agent.mjs', AGENT, AGENT.replace('Refund an order.', 'Refund an order within policy.'));
    expect(d).toContain('diff --git a/agent.mjs b/agent.mjs');
    expect(d).toContain("-  { name: 'issue_refund', description: 'Refund an order.' },");
    expect(d).toContain("+  { name: 'issue_refund', description: 'Refund an order within policy.' },");
    expect(d).toMatch(/^@@ -1,5 \+1,5 @@$/m);
    expect(unifiedDiff('a', 'same', 'same')).toBe('');
  });
});

describe('noRepairerOf', () => {
  const asked = { provider: 'anthropic', model: 'claude-opus-5-5', served: 'claude-opus-5-5', cost: 0.01 };
  const missing = 'the repairer could not be asked: claude was not found: install Claude Code, or set SHADOWLAP_CLAUDE to its path';

  it('says why no repairer proposed candidates, with the warning that says it at length', () => {
    expect(noRepairerOf({ noRepairer: 'the repairer could not be asked: claude was not found', repairer: null, warnings: ['agent.mjs changed while candidate 2 was verified', missing] })).toEqual({ text: 'the repairer could not be asked: claude was not found', warning: missing });
    expect(noRepairerOf({ noRepairer: 'the repairer had nothing it could rewrite', repairer: null, warnings: [] })).toEqual({ text: 'the repairer had nothing it could rewrite', warning: null });
  });

  it('says nothing when the repairer answered, or nothing called for one', () => {
    expect(noRepairerOf({ noRepairer: null, repairer: asked, warnings: [] })).toBeNull();
    // A report that says null means it: its warnings aren't read for it.
    expect(noRepairerOf({ noRepairer: null, repairer: null, warnings: [missing] })).toBeNull();
    expect(noRepairerOf({ repairer: asked, warnings: [missing] })).toBeNull();
  });

  it('reads a report kept before it said so from its warnings, cut to what went wrong', () => {
    expect(noRepairerOf({ repairer: null, warnings: ['the repairer could not be asked: the claude-code repairer runs Claude Code, and claude was not found: install it, or set SHADOWLAP_CLAUDE to its path'] })).toEqual({
      text: 'the repairer could not be asked: the claude-code repairer runs Claude Code, and claude was not found',
      warning: 'the repairer could not be asked: the claude-code repairer runs Claude Code, and claude was not found: install it, or set SHADOWLAP_CLAUDE to its path',
    });
    expect(noRepairerOf({ repairer: null, warnings: ['the repairer could not be asked: the repairer declined to answer'] })!.text).toBe('the repairer could not be asked: the repairer declined to answer');
    expect(noRepairerOf({ repairer: null, warnings: ["none of the system prompt or tool descriptions appears verbatim, exactly once, in the project's files, so the repairer had nothing it could rewrite"] })!.text).toBe('the repairer had nothing it could rewrite');
    expect(noRepairerOf({ repairer: null, warnings: ['no repairer is configured, so only fixes that need no model were tried: set one with --repairer anthropic, or repair.repairer in shadowlap.config.json'] })!.text).toBe('no repairer is configured');
    expect(noRepairerOf({ repairer: null, warnings: ['big-model rescued the runs, but the model name small-model appears nowhere in the source as a string, so no model switch was proposed'] })).toBeNull();
  });
});

describe('repairMarkdown', () => {
  it('says in words where each failing run was lost, or that it was not, or that it passed', () => {
    const report = repairReport({ targets: ['01M540RX39NC308SMAJ73MN8RB', '01M540RWR1MGKZC97YKV0T4DB6', '01M540RZZZ0000000000000000'], accepted: false });
    report.targets[1] = { ...report.targets[1], outcome: 'unrescuable', callNo: null, step: null, recorded: null, rescued: null };
    report.targets[2] = { ...report.targets[2], outcome: 'passes', callNo: null, step: null, recorded: null, rescued: null, note: '01M540RZZZ passes its oracle when replayed' };
    const rows = repairMarkdown(report).split('\n').filter((l) => l.startsWith('| `01M540'));
    // #5 is a model call, not pull request 5: GitHub links no reference in it.
    expect(rows.map((l) => l.split(' | ')[1])).toEqual(['model call #<span></span>5 (3 of 4)', 'not rescued from any model call', 'passes when replayed']);
    // One whose blame's first probe couldn't tell is not settled, in the pull request and the terminal.
    report.targets[1] = { ...report.targets[1], unsettled: true };
    expect(repairMarkdown(report).split('\n').filter((l) => l.startsWith('| `01M540')).map((l) => l.split(' | ')[1])).toEqual(['model call #<span></span>5 (3 of 4)', 'not settled from the first model call', 'passes when replayed']);
    expect(formatRepair(report)).toMatch(/01M540RWR1 +not settled from the first model call/);
    expect(formatRepair(report)).not.toContain('not rescued');
  });

  it('says a run blame found lost gradually around two calls, or between two, so, as blame words it, in the pull request and the terminal', () => {
    const report = repairReport({ targets: ['01M540RX39NC308SMAJ73MN8RB', '01M540RWR1MGKZC97YKV0T4DB6', '01M540RZZZ0000000000000000'], accepted: false });
    report.targets[0] = { ...report.targets[0], callNo: 17, step: 17, steps: 30, range: { from: 17, to: 18, fromStep: 17, toStep: 18, gradual: true } };
    report.targets[1] = { ...report.targets[1], callNo: 7, step: 7, steps: 30, range: { from: 7, to: 9, fromStep: 7, toStep: 9 } };
    const md = repairMarkdown(report);
    expect(md.split('\n').filter((l) => l.startsWith('| `01M540')).map((l) => l.split(' | ')[1])).toEqual([
      'gradually, around model calls #<span></span>17 and #<span></span>18 (17 and 18 of 30)',
      'between model calls #<span></span>7 and #<span></span>9 (7 and 9 of 30)',
      'model call #<span></span>5 (3 of 4)',
    ]);
    expect(md).toContain('lets the run pass (`shadowlap blame`), or gradually around two calls, where no one call lost it.');
    expect(formatRepair(report)).toMatch(/01M540RX39 +gradually, around model calls #17 and #18 \(17 and 18 of 30\)/);
    expect(formatRepair(report)).toMatch(/01M540RWR1 +between model calls #7 and #9 \(7 and 9 of 30\)/);
    // A pinned call, or none at all, is the call alone, and so is a range from a pack that isn't two call numbers.
    expect(lostWhere(5, null)).toBe('at model call #5');
    expect(lostWhere(5, { from: 5, to: 5 })).toBe('at model call #5');
    expect(lostWhere(17, { from: 17, to: 18, gradual: true })).toBe('gradually, around model calls #17 and #18');
    expect(lostWhere(7, { from: 7, to: 9 })).toBe('between model calls #7 and #9');
    expect(lostWhere(5, { from: '5\u001b[2J', to: 9, gradual: true })).toBe('at model call #5');
  });

  it('states how a good run was kept against its own baseline: both tallies and the bound on the drop, and both rules', () => {
    const report = repairReport({ targets: ['01M540RX39NC308SMAJ73MN8RB'], good: ['01M540RG00D000000000000000'] });
    const candidate = report.candidates.find((c) => c.id === 3)!;
    const v = candidate.verify!;
    const pairs = Array.from({ length: 38 }, () => ({ ...v.runs[1].attempts[0] }));
    const good = { ...v.runs[1], attempts: pairs, passes: 38, verdict: 'pass' as const, decision: 'pass' as const, baseline: { passes: 38, attempts: 38, source: 'paired' as const, revision: null }, margin: 0.1, drop: { lo: null, hi: 0.1, confidence: 0.95, method: 'betting' as const }, baselineRuns: pairs };
    const verify = { ...v, runs: [v.runs[0], good], gate: { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, kept: { margin: 0.1, risk: 0.05, max: 200, source: 'paired' as const, revision: null, label: null } };
    const kept = { ...report, candidates: report.candidates.map((c) => (c.id === 3 ? { ...c, verify } : c)) };
    const md = repairMarkdown(kept);
    expect(md).toContain('| good | `01M540RG00` | kept | 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%) |');
    expect(md).toContain('it fixes 1 of 1 target run, keeps 1 of 1 good, each failing run by its gate, which tells 90%+ from 70%- at <= 5% risk, and each good one against its baseline, which tells no drop from one of 10+ points at <= 5% risk.');
    // In the terminal, the rules wrap under the counts, each line within 80 columns.
    const text = formatRepair(kept);
    const block = ['  Verified: fixes 1 of 1 target run, keeps 1 of 1 good,', '            each failing run by its gate, which tells 90%+ from 70%- at <= 5%', '            risk, and each good one against its baseline, which tells no drop', '            from one of 10+ points at <= 5% risk'];
    expect(text).toContain(`\n${block.join('\n')}\n`);
    for (const l of block) expect(l.length).toBeLessThanOrEqual(80);
    // A verify before baselines reads as it did.
    expect(formatRepair(report)).toContain('  Verified: fixes 1 of 1 target run, keeps 1 of 1 good,\n            each at 4 of 5 attempts\n');
  });

  it('wraps why each candidate was dropped at whole words to a terminal’s width, indented as it is, and leaves it whole for a pipe', () => {
    const report = repairReport({ targets: ['01M540RX39NC308SMAJ73MN8RB'], good: ['01M540RG00D000000000000000'] });
    const whole = formatRepair(report);
    const fit = formatRepair(report, plain, 80);
    const words = (text: string) => text.split(/\s+/).filter(Boolean);
    expect(words(fit)).toEqual(words(whole));
    // The first candidate's reason, over two lines within 80 columns, under the candidate as it was.
    const wrapped = fit.split('\n').filter((l) => !whole.split('\n').includes(l));
    expect(wrapped).toEqual(['        it mentions A-1042, which only the failing runs contain: a fix has to', '        hold for cases it has not seen']);
  });

  it('names the write policy the replays ran under, and none when the report did not keep one', () => {
    const report = repairReport({ targets: ['01M540RX39NC308SMAJ73MN8RB'], accepted: false });
    const last = (r: typeof report) => repairMarkdown(r).trimEnd().split('\n').at(-1)!;
    expect(last({ ...report, writes: 'block' })).toMatch(/\. Writes were blocked in every replay\.$/);
    expect(last({ ...report, writes: 'stub' })).toMatch(/\. Writes were stubbed in every replay\.$/);
    const { writes: _writes, ...older } = report;
    expect(last(older)).not.toContain('Writes were');
    expect(last(older)).toMatch(/^Cost: .*\.$/);
  });
});
