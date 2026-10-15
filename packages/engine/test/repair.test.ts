import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, caseDetails, checkEdit, editSize, findAnchors, forbiddenDetails, unifiedDiff, type Anchor } from '../src/repair.js';

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
    expect(AGENT.slice(anchors[0]!.offset, anchors[0]!.offset + anchors[0]!.text.length)).toBe(anchors[0]!.text);
  });

  it('falls back to sentences when the prompt is assembled, and skips text that appears twice', () => {
    const files = [
      { path: 'prompt.ts', content: "const base = 'You are a support agent.';\nconst rule = 'Follow the refund policy.';\nconst today = `Today is ${date}.`;" },
      { path: 'test/prompt.test.ts', content: "expect(p).toContain('Follow the refund policy.');" },
    ];
    const anchors = findAnchors([{ label: 'system prompt', text: 'You are a support agent. Follow the refund policy. Today is 2026-09-30.' }], files);
    // The whole prompt is built from pieces; the second sentence is also in a test, so it is not unique.
    expect(anchors.map((a) => [a.text, a.file])).toEqual([['You are a support agent.', 'prompt.ts']]);
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
    expect(edit("You are a support agent. Don't refund above the limit.")).toEqual({ ok: false, reason: expect.stringContaining('quotes') });
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
