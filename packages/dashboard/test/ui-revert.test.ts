import { describe, expect, it } from 'vitest';
import { UNTESTED_WORDS } from '../../engine/src/bisect-words.js';
import { editorOpened, editorSub, editorTarget } from '../ui/revert/editor.js';
import { changeLines, gitRevertCommand, outsideWords, revertedLines } from '../ui/revert/model.js';
import { runFindings } from '../ui/run/findings.js';
import { stepCard, stepJob } from '../ui/run/next-step.js';
import type { FoundCommit, NextStep } from '../ui/types.js';

/**
 * The way back once Find breaking commit named a crash's first bad commit (ui/revert/): the change as
 * the commit made it and undone, Copy git revert's command, where Open in editor opens, Revert's wait
 * and card, and the commit's finding leading the crash's.
 */

const HUNK = '@@ -10,3 +10,4 @@ def refund(order):\n     total = order["amount"]\n-    log(total)\n+    log(order["total"])\n+    audit(total)\n     return total\n';
const CHANGE = { file: 'agent/refund.py', files: ['agent/refund.py'], hunk: HUNK, line: 12, cut: false, merge: false, path: 'refund.py', outside: 0 };
const FOUND: FoundCommit = { rev: 'ccccccc', subject: 'Log the total', author: '', date: '2026-10-30T10:00:00Z', why: 'the agent exited 1', untested: [], replays: 3, tokens: 0, at: 1, change: CHANGE };
const STEP = { key: 'revert', label: 'Revert', golden: 'goldens/refund', rev: 'ccccccc', merge: false, live: false, blame: null, title: 'Revert ccccccc', sub: 'Log the total: undone in your working tree, then goldens/refund replayed offline', command: 'git revert --no-commit ccccccc && shadowlap test goldens/refund' } as unknown as NextStep;

describe('the first bad commit’s change', () => {
  it('marks what the commit added and removed, and the dialog shows it undone', () => {
    expect(changeLines(CHANGE)!.map((l) => l.tone)).toEqual([null, null, 'del', 'add', 'add', null]);
    expect(changeLines({ hunk: null })).toBeNull();
    expect(revertedLines(HUNK).slice(2, 5)).toEqual([
      { text: '+    log(total)', tone: 'add' },
      { text: '-    log(order["total"])', tone: 'del' },
      { text: '-    audit(total)', tone: 'del' },
    ]);
  });

  it('copies git revert as a commit of its own, a merge against its first parent', () => {
    expect(gitRevertCommand('ccccccc', false)).toBe('git revert ccccccc');
    expect(gitRevertCommand('ccccccc', true)).toBe('git revert -m 1 ccccccc');
  });

  it('opens the project’s file at the line it added, as the server runs the editor, and only where it can', () => {
    const t = editorTarget(CHANGE, 'code --goto <file>:<line>');
    expect(t).toEqual({ path: 'refund.py', line: 12, cmd: 'code --goto refund.py:12' });
    expect(editorSub(t!)).toBe('Opens refund.py at line 12 in the editor $VISUAL or $EDITOR names');
    expect(editorOpened({ file: 'refund.py', line: 12 })).toBe('Opened refund.py at line 12 in your editor');
    expect(editorTarget(CHANGE, 'vim +<line> <file>')!.cmd).toBe('vim +12 refund.py');
    expect(editorTarget(CHANGE, null)).toBeNull();
    expect(editorTarget({ ...CHANGE, path: null }, 'vim +<line> <file>')).toBeNull();
    expect(editorTarget({ ...CHANGE, line: null }, 'vim +<line> <file>')).toBeNull();
  });

  it('warns of the commit’s files outside the project, which git reverts too, and words the untested commits one way', () => {
    expect(outsideWords(1)).toBe('1 of the commit’s files is outside this project, and git reverts it too');
    expect(outsideWords(3)).toBe('3 of the commit’s files are outside this project, and git reverts them too');
    expect(UNTESTED_WORDS.line(['aaaaaaa', 'bbbbbbb'])).toBe('or one just before it, which could not be tested: aaaaaaa, bbbbbbb');
  });
});

describe('Revert on a run’s page', () => {
  it('waits for every job using the working tree and for Tests’ jobs, and its card gives the amount alone, as its dialog always asks', () => {
    expect(stepJob(STEP)).toEqual({ verb: 'revert it', tests: true, use: 'writes' });
    const card = stepCard({ ...STEP, estimate: { kind: 'tests', usd: 0, ceiling: null, parts: ['replays offline'], note: null } } as unknown as NextStep);
    expect(card).toMatchObject({ title: 'Revert ccccccc', cmd: '$ git revert --no-commit ccccccc && shadowlap test goldens/refund' });
    expect(card.est).toMatchObject({ form: true });
  });

  it('leads the crash’s findings with the first bad commit', () => {
    const own = { kind: 'failed', label: 'crashed', lead: 'Traceback', why: 'at call 4' } as never;
    const findings = runFindings({ own, differences: null, notRecorded: null, notes: [], commit: FOUND });
    expect(findings.map((f) => f.key)).toEqual(['commit', 'own']);
    expect(findings[0]).toMatchObject({ kind: 'commit', sev: 2, says: 'first bad commit', commit: FOUND });
    expect(runFindings({ own, differences: null, notRecorded: null, notes: [], commit: null }).map((f) => f.key)).toEqual(['own']);
  });
});
