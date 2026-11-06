import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyGoldens, asGoldenName, defaultGoldenNames, goldenNameArgs, goldenNamesProblem, goldensFolder, NAME_MAX, parseJudge, type StoredFix, type StoredRepair } from '../src/index.js';

/**
 * The names the goldens a fix's apply copies go by (`fix apply --name <run>=<name>`, the dashboard's
 * Apply fix): the rule a name keeps and the words for one that doesn't, the name each takes when
 * none is given, which recordings an apply copies, and what the goldens folder holds already.
 */

describe('a golden’s name', () => {
  it('is made from a label or a title: lower-case, hyphens between, at most 40 characters, never ending on a hyphen', () => {
    expect(asGoldenName('refund-over-limit')).toBe('refund-over-limit');
    expect(asGoldenName('Refund over the LIMIT!')).toBe('refund-over-the-limit');
    expect(asGoldenName('issue_refund called with {"amount":240}')).toBe('issue-refund-called-with-amount-240');
    expect(asGoldenName('Escalate every refund above the policy limit it sets')).toBe('escalate-every-refund-above-the-policy');
    expect(asGoldenName('Escalate every refund above the policyx limit')).toBe('escalate-every-refund-above-the-policyx');
    expect(asGoldenName('a'.repeat(50))).toBe('a'.repeat(40));
    expect(asGoldenName('Rückerstattung über Limit')).toBe('ruckerstattung-uber-limit');
    expect(asGoldenName('払い戻し')).toBe('');
  });

  it('defaults to the fix’s label, else its title, else golden, numbered when its repair made several', () => {
    expect(defaultGoldenNames({ label: 'double-email', title: 'Sends the confirmation twice' }, 1)).toEqual(['double-email']);
    expect(defaultGoldenNames({ label: 'refund-bug', title: 't' }, 2)).toEqual(['refund-bug-1', 'refund-bug-2']);
    expect(defaultGoldenNames({ label: null, title: 'Sends the confirmation twice' }, 1)).toEqual(['sends-the-confirmation-twice']);
    expect(defaultGoldenNames({ label: '払い戻し', title: 'Refund bug' }, 1)).toEqual(['refund-bug']);
    expect(defaultGoldenNames({ label: null, title: '払い戻し' }, 2)).toEqual(['golden-1', 'golden-2']);
  });

  it('says what is wrong with the first name that won’t do, in the dialog’s words, and which it is', () => {
    const ok = { folder: 'goldens', held: [] };
    expect(goldenNamesProblem(['double-email'], ok)).toBeNull();
    expect(goldenNamesProblem(['refund-bug-1', 'refund-bug-2'], ok)).toBeNull();
    expect(goldenNamesProblem([''], ok)).toEqual({ at: 0, text: 'Give the golden a name.' });
    expect(goldenNamesProblem(['refund-bug-1', ''], ok)).toEqual({ at: 1, text: 'Give each golden a name.' });
    for (const bad of ['Double-Email', 'double_email', 'double email', '-double', 'goldens/x', '..']) expect(goldenNamesProblem([bad], ok)).toEqual({ at: 0, text: 'A golden’s name takes lower-case letters, digits and hyphens.' });
    expect(goldenNamesProblem(['a'.repeat(64), '0-refund--twice-'], ok)).toBeNull();
    expect(goldenNamesProblem(['refund-bug', 'refund-bug'], ok)).toEqual({ at: 1, text: 'Each golden needs a name of its own.' });
    // Taken in the folder, read without case as macOS and Windows read a folder's name.
    expect(goldenNamesProblem(['refund-bug', 'confirmation-email'], { folder: 'goldens/', held: ['Confirmation-Email'] })).toEqual({ at: 1, text: 'goldens/confirmation-email is taken: pick another name.' });
    expect(goldenNamesProblem(['refund-bug'], { folder: 'tests/goldens', held: ['refund-bug'] })).toEqual({ at: 0, text: 'tests/goldens/refund-bug is taken: pick another name.' });
  });

  it('is at most 64 characters, as a judge’s name in a check is, so none the rule takes is too long for a folder', () => {
    const ok = { folder: 'goldens', held: [] };
    expect(NAME_MAX).toBe(64);
    expect(goldenNamesProblem(['a'.repeat(NAME_MAX)], ok)).toBeNull();
    expect(goldenNamesProblem(['refund-bug', 'a'.repeat(NAME_MAX + 1)], ok)).toEqual({ at: 1, text: 'A golden’s name is at most 64 characters.' });
    // What once passed the rule and then failed at mkdir with ENAMETOOLONG.
    expect(goldenNamesProblem(['a'.repeat(300)], ok)).toEqual({ at: 0, text: 'A golden’s name is at most 64 characters.' });
    const judge = (name: string) => () => parseJudge({ name, question: 'Does the reply say why?', model: 'claude-haiku-4-5' }, 'judge[0]');
    expect(judge('a'.repeat(NAME_MAX))).not.toThrow();
    expect(judge('a'.repeat(NAME_MAX + 1))).toThrow('judge[0].name must be a short name');
    // A label or a title, however long, makes a name within it, numbered or not.
    const long = 'Escalate every refund above the policy limit it sets '.repeat(6);
    for (const count of [1, 12]) {
      const names = defaultGoldenNames({ label: long, title: long }, count);
      expect(names.every((n) => n.length <= NAME_MAX)).toBe(true);
      expect(goldenNamesProblem(names, ok)).toBeNull();
    }
    expect(defaultGoldenNames({ label: null, title: long }, 1)).toEqual(['escalate-every-refund-above-the-policy']);
  });

  it('is none of the names Windows keeps for itself, read without case, nor one a label or a title makes', () => {
    const ok = { folder: 'goldens', held: [] };
    const devices = ['con', 'nul', 'prn', 'aux', ...Array.from({ length: 9 }, (_, i) => [`com${i + 1}`, `lpt${i + 1}`]).flat()];
    for (const name of [...devices, 'CON', 'Nul', 'cOm3', 'LPT9']) {
      expect(goldenNamesProblem(['refund-bug', name], ok)).toEqual({ at: 1, text: `${name} is a name Windows keeps for itself: pick another.` });
      expect(asGoldenName(name)).toBe('');
    }
    expect(goldenNamesProblem(['console', 'com10', 'con-1', 'nul-amount', 'lpt1x'], ok)).toBeNull();
    // A label of one gives way to the title, and a title of one to golden, numbered or not.
    expect(defaultGoldenNames({ label: 'con', title: 'Crashes on a null amount' }, 1)).toEqual(['crashes-on-a-null-amount']);
    expect(defaultGoldenNames({ label: 'AUX', title: 'Prn' }, 1)).toEqual(['golden']);
    expect(defaultGoldenNames({ label: null, title: 'nul' }, 2)).toEqual(['golden-1', 'golden-2']);
    // Cut at a word's end to one, it makes none either.
    expect(asGoldenName(`Con ${'x'.repeat(40)}`)).toBe('');
  });

  it('goes to fix apply as one --name for each golden', () => {
    expect(goldenNameArgs([{ run: '01K5CQ2E8M', name: 'double-email' }, { run: '01K5CQ3F1N', name: 'refund-bug' }])).toEqual(['--name', '01K5CQ2E8M=double-email', '--name', '01K5CQ3F1N=refund-bug']);
    expect(goldenNameArgs([])).toEqual([]);
  });
});

describe('the recordings an apply copies', () => {
  const dir = '.shadowlap/repairs/repair-munzln2i';
  const repair = { repairId: 'repair-munzln2i', report: { output: { goldens: [`${dir}/goldens/01M3RZ0001`, `${dir}\\goldens\\01M3RZ0002`] } } } as unknown as StoredRepair;
  const fix = (applied?: StoredFix['data']['applied']) => ({ fixId: 'fx-1', data: applied ? { applied } : {} }) as unknown as StoredFix;
  const applied = (goldens: string[], from?: Record<string, string>) => ({ patch: 'applied' as const, repairId: 'repair-munzln2i', goldens, tests: 'failed' as const, ...(from ? { from } : {}) });

  it('are its repair’s, each by its run, none copied before', () => {
    expect(applyGoldens(fix(), repair)).toEqual([
      { run: '01M3RZ0001', source: `${dir}/goldens/01M3RZ0001`, copied: null },
      { run: '01M3RZ0002', source: `${dir}/goldens/01M3RZ0002`, copied: null },
    ]);
    expect(applyGoldens(fix(), null)).toEqual([]);
    // A teammate's repair, from the team store: its recordings stayed on the machine that ran it.
    expect(applyGoldens(fix(), repair, { pulled: true })).toEqual([]);
  });

  it('finds a copy made before under any name by the run kept beside it, else by the run it is named by', () => {
    const named = applyGoldens(fix(applied(['goldens/refund-bug-1', 'tests/goldens/01M3RZ0002'], { 'goldens/refund-bug-1': '01M3RZ0001' })), repair);
    expect(named.map((g) => g.copied)).toEqual(['goldens/refund-bug-1', 'tests/goldens/01M3RZ0002']);
    // A path outside the project is no copy.
    expect(applyGoldens(fix(applied(['../elsewhere/01M3RZ0001', '/tmp/01M3RZ0002'])), repair).map((g) => g.copied)).toEqual([null, null]);
  });
});

describe('what the goldens folder holds', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the very recording an apply stopped part way copied, under any name, and names every entry as held', () => {
    root = mkdtempSync(join(tmpdir(), 'sl-goldens-held-'));
    const goldens = join(root, 'goldens');
    const pack = (at: string, text: string) => {
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'run.json'), text);
    };
    const source = join(root, 'repair', '01M3RZ0001');
    expect(goldensFolder(goldens, [])).toEqual({ there: [], held: [] });
    pack(source, '{"runs":[1]}\n');
    pack(join(goldens, 'refund-twice'), '{"runs":[1]}\n');
    pack(join(goldens, 'Double-Email'), '{"runs":[2]}\n');
    pack(join(goldens, 'same-size'), '{"runs":[3]}\n');
    writeFileSync(join(goldens, 'notes.md'), 'x');
    // Copied under a name the dialog gave it, not the label's: found there all the same, by its bytes.
    expect(goldensFolder(goldens, [{ run: '01M3RZ0001', source }])).toEqual({ there: [{ run: '01M3RZ0001', at: 'refund-twice' }], held: ['Double-Email', 'notes.md', 'refund-twice', 'same-size'] });
    // A recording no entry holds, or one whose folder isn't to be read, is in it nowhere.
    pack(source, '{"runs":[4]}\n');
    expect(goldensFolder(goldens, [{ run: '01M3RZ0001', source }]).there).toEqual([]);
    expect(goldensFolder(goldens, [{ run: '01M3RZ0001', source: '' }]).there).toEqual([]);
  });

  it('says which recordings are in it already under their run’s name, as repair --goldens copies them', () => {
    root = mkdtempSync(join(tmpdir(), 'sl-goldens-there-'));
    const goldens = join(root, 'goldens');
    mkdirSync(join(goldens, '01M3RZ0002'), { recursive: true });
    const offered = [
      { run: '01M3RZ0001', source: '' },
      { run: '01M3RZ0002', source: '' },
    ];
    expect(goldensFolder(goldens, offered)).toEqual({ there: [{ run: '01M3RZ0002', at: '01M3RZ0002' }], held: ['01M3RZ0002'] });
  });
});
