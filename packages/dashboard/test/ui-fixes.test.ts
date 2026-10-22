import { describe, expect, it } from 'vitest';
import { applyText, attemptMark, breakPoints, bundledRuns, bundleGlyph, bundleLine, bundleSource, callRowCells, candidateTone, cellKeepsWhole, changeParts, chipKeeps, fixAction, fixJobStatus, fixName, flagParts, footWarnings, inlineParts, laterStamp, mergeTreeJobs, nothingAcceptedWhy, outcomeTone, outdatedOf, parseCheck, parseMarkdown, patchLines, plainCell, probeBadge, repairAside, repairAsk, repairBy, roleBadges, sameFolder, statusBadge, stepFor, treeBusy, updateOutdatedAsk, verifyFor, type TreeJob } from '../ui/fixes/model.js';
import { jobStatus } from '../ui/jobs.js';
import type { BlameStep, FixBundle, FixDetail, RepairStep, VerifyStep } from '../ui/types.js';

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
    const patch = { kind: 'patch' as const, argv: ['fix', 'apply', 'fx-1'], gitApply: 'git apply x/fix.patch', pending: null, pulled: false, files: ['agent.mjs'], diff: 'diff --git a/agent.mjs b/agent.mjs\n', refused: null };
    expect(fixAction({ status: 'open', actions: actions({ repair }) })).toEqual({ kind: 'repair' });
    expect(fixAction({ status: 'open', actions: actions({}) })).toEqual({ kind: 'none', label: 'Repair from here', why: expect.stringMatching(/nothing to repair from here/) });
    expect(fixAction({ status: 'verified', actions: actions({ apply: patch }) })).toEqual({ kind: 'apply', label: 'Apply the patch' });
    expect(fixAction({ status: 'verified', actions: actions({ apply: { ...patch, kind: 'mark', gitApply: null } }) })).toEqual({ kind: 'apply', label: 'Mark applied' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: patch, applied: true }) })).toEqual({ kind: 'applied' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: { ...patch, pending: 'run shadowlap test on its goldens' }, applied: true }) })).toEqual({ kind: 'apply', label: 'Finish applying' });
    // A patch fix apply refuses: the button stays off, and says why on hover.
    const refused = { ...patch, gitApply: null, refused: 'it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone' };
    expect(fixAction({ status: 'verified', actions: actions({ apply: refused }) })).toEqual({ kind: 'none', label: 'Apply the patch', why: 'This patch is not the change its repair verified: it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone. Nothing applies it from here.' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: { ...refused, pending: 'run shadowlap test on its goldens' }, applied: true }) })).toMatchObject({ kind: 'none' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: refused, applied: true }) })).toEqual({ kind: 'applied' });
  });

  it('asks before applying with every file the patch changes and the patch itself, and runs nothing from a teammate’s', () => {
    expect(applyText({ files: ['agent.mjs'], pulled: false })).toBe(
      'This changes your working tree: the patch below goes into agent.mjs with git apply, the recordings the fixed code made are copied into goldens/, and shadowlap test replays them. Your other goldens are replayed offline, to name any the change makes diverge. Review the change before you commit it.',
    );
    expect(applyText({ files: ['agent.mjs', 'src/tools.mjs', 'prompt.txt'], pulled: true })).toBe(
      "This changes your working tree: the patch below goes into agent.mjs, src/tools.mjs and prompt.txt with git apply. It came from the team store, so nothing here runs it: the recordings the fixed code made stay on the machine that ran the repair, and your goldens aren't replayed against it. Read it first; once it is in and is what you meant, check your goldens with shadowlap test.",
    );
    expect(patchLines('diff --git a/agent.mjs b/agent.mjs\n--- a/agent.mjs\n+++ b/agent.mjs\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n--- removed dashes\n')).toEqual([
      { text: 'diff --git a/agent.mjs b/agent.mjs', tone: null },
      { text: '--- a/agent.mjs', tone: null },
      { text: '+++ b/agent.mjs', tone: null },
      { text: '@@ -1,2 +1,2 @@', tone: null },
      { text: '-old', tone: 'del' },
      { text: '+new', tone: 'add' },
      { text: ' context', tone: null },
      // A removed line that starts with dashes is still a removed line.
      { text: '--- removed dashes', tone: 'del' },
    ]);
  });

  it("keeps Repair from here but not as the lead when blame found no answer of the model's lost the run", () => {
    const look = "No answer of the model's lost this run: look at the tools, the harness or the command.";
    expect(repairAside({ blame: { look } as FixDetail['blame'] })).toBe("Blame found that no answer of the model's lost this run, so a rewrite of the prompt is unlikely to fix it: look at the tools, the harness or the command.");
    expect(repairAside({ blame: { look: null } as FixDetail['blame'] })).toBeNull();
    expect(repairAside({ blame: null })).toBeNull();
  });

  it('names the repairer Repair from here asks as the fix reads again, and sends that one', () => {
    const fix = (repairer: FixDetail['repairer'], o: Partial<FixDetail> = {}) =>
      ({ status: 'open', repairer, actions: actions({ repair: { argv: ['repair'], command: `shadowlap repair${repairer.configured ? '' : ' --repairer claude-code'}` } }), ...o }) as FixDetail;
    // The page loaded before the config named a repairer; the dialog reads it again as it opens.
    const page = fix({ name: 'claude-code', configured: false, problem: null });
    const now = fix({ name: 'anthropic', configured: true, problem: null });
    expect(repairAsk(page, null)).toEqual({ ready: false, who: null, repairer: null, command: 'shadowlap repair --repairer claude-code', why: null });
    expect(repairAsk(page, { fix: now })).toEqual({ ready: true, who: 'anthropic (from shadowlap.config.json)', repairer: 'anthropic', command: 'shadowlap repair', why: null });
    expect(repairAsk(now, { fix: page })).toMatchObject({ ready: true, who: 'your own Claude Code', repairer: 'claude-code', command: 'shadowlap repair --repairer claude-code' });
    // A read that fails names the page's: the server still holds the job to the config.
    expect(repairAsk(page, { fix: null })).toMatchObject({ ready: true, repairer: 'claude-code' });
    // Repaired meanwhile, or its runs deleted: nothing to confirm.
    expect(repairAsk(page, { fix: fix(page.repairer, { status: 'verified' }) })).toMatchObject({ ready: false, why: 'It was verified meanwhile, so there is nothing left to repair.' });
    expect(repairAsk(page, { fix: fix(page.repairer, { actions: actions({}) }) })).toMatchObject({ ready: false, why: expect.stringMatching(/nothing to repair from here/) });
  });

  it('keeps Repair off, saying why, when the repairer it would ask can’t be asked from here', () => {
    const page = { status: 'open', repairer: { name: 'claude-code', configured: false, problem: null }, actions: actions({ repair: { argv: ['repair'], command: 'shadowlap repair --repairer claude-code' } }) } as FixDetail;
    const problem = 'This repair asks your own Claude Code, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, or name another repairer in shadowlap.config.json (repair.repairer).';
    // claude went missing since the page loaded: the dialog reads the fix again as it opens.
    expect(repairAsk(page, { fix: { ...page, repairer: { ...page.repairer, problem } } })).toEqual({ ready: false, who: null, repairer: null, command: 'shadowlap repair --repairer claude-code', why: problem });
    expect(repairAsk(page, { fix: page })).toMatchObject({ ready: true, why: null });
  });
});

describe('the Repair step', () => {
  const step = (o: Partial<RepairStep>): RepairStep => ({ repairer: null, served: null, noRepairer: null, accepted: false, candidates: [], why: null, warnings: [], ...o }) as RepairStep;
  const unasked = { text: 'the repairer could not be asked: claude was not found', warning: 'the repairer could not be asked: claude was not found: install Claude Code, or set SHADOWLAP_CLAUDE to its path' };

  it('says who proposed the candidates, or why no repairer did, and “no repairer needed” only when none was', () => {
    expect(repairBy(step({ repairer: 'anthropic:claude-opus-5-5', served: 'claude-fable-5-1', accepted: true }))).toEqual({ repairer: 'anthropic:claude-opus-5-5', served: 'claude-fable-5-1' });
    // claude wasn't found: the header says so, with what to do, never that no repairer was needed.
    expect(repairBy(step({ noRepairer: unasked, why: unasked.text }))).toEqual({ text: unasked.warning });
    expect(repairBy(step({ noRepairer: { text: 'the repairer had nothing it could rewrite', warning: null } }))).toEqual({ text: 'the repairer had nothing it could rewrite' });
    // A switch to the model that rescued the runs needs no repairer.
    expect(repairBy(step({ accepted: true }))).toEqual({ text: 'no repairer needed' });
    // No failing run rescued, or stopped before: its why says it all.
    expect(repairBy(step({ why: 'resampling rescued no failing run' }))).toBeNull();
  });

  it('follows with what a repair that accepted nothing tried, unless that is only the repairer’s silence again', () => {
    const tried = (verdict: RepairStep['candidates'][number]['verdict']) => ({ verdict }) as RepairStep['candidates'][number];
    expect(nothingAcceptedWhy(step({ noRepairer: unasked, why: unasked.text }))).toBeNull();
    // Stopped after the repairer couldn't be asked: that it stopped is news.
    expect(nothingAcceptedWhy(step({ noRepairer: unasked, why: 'interrupted' }))).toBe('interrupted');
    expect(nothingAcceptedWhy(step({ why: 'interrupted' }))).toBe('interrupted');
    expect(nothingAcceptedWhy(step({}))).toBe('nothing was accepted');
    expect(nothingAcceptedWhy(step({ candidates: [tried('set aside'), tried('rejected')], noRepairer: unasked }))).toBe('1 candidate tried, none accepted');
  });

  it('lists every warning at its foot but the one its header says', () => {
    const other = 'agent.mjs changed while candidate 2 was verified, so it was left as it is: check it for the candidate’s edit';
    expect(footWarnings(step({ noRepairer: unasked, warnings: [unasked.warning, other] }))).toEqual([other]);
    expect(footWarnings(step({ warnings: [unasked.warning, other] }))).toEqual([unasked.warning, other]);
  });
});

describe('the working tree', () => {
  const repairing = { id: 'j1', done: false, worktree: { use: 'writes' as const, doing: 'a repair is trying candidates in your working tree' } };
  const blaming = { id: 'j2', done: false, worktree: { use: 'reads' as const, doing: 'a blame is running your agent from your working tree' } };
  const packing = { id: 'j3', done: false, worktree: null };

  it('keeps a blame waiting while a repair or an apply changes the tree, as the server would refuse it', () => {
    expect(treeBusy([repairing], 'reads', 'blame')).toBe('A repair is trying candidates in your working tree: blame once it is done.');
    expect(treeBusy([{ ...repairing, done: true }], 'reads', 'blame')).toBeNull();
    // Agents run side by side from a tree nothing changes, and a job that runs no agent never waits.
    expect(treeBusy([blaming, packing], 'reads', 'blame')).toBeNull();
  });

  it('keeps a repair or an apply waiting while anything runs the agent from the tree', () => {
    expect(treeBusy([packing, blaming], 'writes', 'repair')).toBe('A blame is running your agent from your working tree: repair once it is done.');
    expect(treeBusy([repairing], 'writes', 'apply the patch')).toBe('A repair is trying candidates in your working tree: apply the patch once it is done.');
    expect(treeBusy([packing], 'writes', 'repair')).toBeNull();
    expect(treeBusy([], 'writes', 'repair')).toBeNull();
  });

  it('counts only jobs in the project’s own tree: its folder, or one inside it or around it', () => {
    const at = (folder: string | null) => ({ ...repairing, worktree: { ...repairing.worktree, folder } });
    expect(treeBusy([at('/p/one')], 'reads', 'blame', '/p/one')).toMatch(/^A repair is trying/);
    expect(treeBusy([at('/p/one/sub')], 'reads', 'blame', '/p/one')).toMatch(/^A repair is trying/);
    expect(treeBusy([at('/p')], 'reads', 'blame', '/p/one')).toMatch(/^A repair is trying/);
    expect(treeBusy([at('/p/two')], 'reads', 'blame', '/p/one')).toBeNull();
    expect(treeBusy([at('/p/one-two')], 'reads', 'blame', '/p/one')).toBeNull();
    // A job, or a page, with no folder is the dashboard's own: one with every tree.
    expect(treeBusy([at(null)], 'reads', 'blame', '/p/one')).toMatch(/^A repair is trying/);
    expect(treeBusy([at('/p/two')], 'reads', 'blame')).toMatch(/^A repair is trying/);
  });

  it('tells folders apart as the server does, whatever their trailing slash', () => {
    expect(sameFolder('/p/one', '/p/one/')).toBe(true);
    expect(sameFolder('/p/one/', '/p/one/a')).toBe(true);
    expect(sameFolder('C:\\p\\one', 'C:\\p\\one\\a')).toBe(true);
    expect(sameFolder('/p/one', '/p/onetwo')).toBe(false);
    expect(sameFolder(undefined, '/p')).toBe(true);
  });

  it('reads the server’s jobs with this tab’s own on top, and forgets one the server lost', () => {
    const listed = [blaming, { ...repairing, done: false }];
    const watched: Array<{ job: TreeJob; lost?: boolean }> = [{ job: { ...repairing, done: true } }, { job: packing }, { job: blaming, lost: true }];
    expect(mergeTreeJobs(listed, watched)).toEqual([{ ...repairing, done: true }, packing]);
    expect(mergeTreeJobs(null, [{ job: blaming }])).toEqual([blaming]);
    expect(mergeTreeJobs(undefined, [])).toEqual([]);
  });
});

describe('the Blame step', () => {
  const call = (callNo: number, kind: 'api' | 'tool', verdict: BlameStep['callRow'][number]['verdict'] = null): BlameStep['callRow'][number] => ({ callNo, kind, inScope: true, verdict, passes: verdict ? 2 : 0, attempts: verdict ? 4 : 0, inconclusive: 0 });

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
    // Inconclusive reads amber, as every page shows it: neither rescued nor lost.
    expect(probeBadge('inconclusive')).toBe('y');
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
  const bundle = (o: Partial<FixBundle>): FixBundle => ({ kind: 'blame', key: 'k', parentRunId: 'R', title: 'blame · probe #5', callNo: 5, blamed: false, change: null, verdict: null, role: null, passes: 1, attempts: [], spent: 0, at: 0, verdictLine: null, tone: null, rule: null, href: '#/fixes/fx-1/blame', fixId: 'fx-1', ...o });
  const attempt = (runId: string, passed: boolean, rescued = false, verdict: 'passed' | 'failed' | 'inconclusive' = passed ? 'passed' : 'failed') => ({ runId, passed, verdict, note: passed ? 'passed' : verdict === 'inconclusive' ? 'inconclusive: judge "issued" answers yes' : 'failed', href: `#/run/${runId}`, rescued });

  it('leaves out every attempt they list but the rescued fork, which shows as a fork', () => {
    const b = bundle({ attempts: [attempt('A', true, true), attempt('B', false)] });
    expect([...bundledRuns([b])]).toEqual(['B']);
  });

  it('gives a verify the icon of how its run came out, inconclusive in amber, never a fork’s', () => {
    expect(bundleGlyph({ kind: 'blame', verdict: null }).kind).toBe('blame');
    // A run the change fixed, under a verify that rejected it for another run: its own outcome.
    expect(bundleGlyph({ kind: 'verify', verdict: 'rejected', tone: 'ok' })).toEqual({ kind: 'fixok', label: 'Verify attempts: the run held' });
    expect(bundleGlyph({ kind: 'verify', verdict: 'accepted', tone: 'no' }).kind).toBe('fixbad');
    expect(bundleGlyph({ kind: 'verify', verdict: 'incomplete', tone: 'y' }).kind).toBe('warn');
    // Attempts no report names go by the verdict.
    expect(bundleGlyph({ kind: 'verify', verdict: 'accepted' })).toEqual({ kind: 'fixok', label: 'Verify accepted the change' });
    expect(bundleGlyph({ kind: 'verify', verdict: 'rejected' }).kind).toBe('fixbad');
    expect(bundleGlyph({ kind: 'verify', verdict: 'incomplete' }).kind).toBe('warn');
  });

  it('says a bundle’s verdict as a gate’s is said, then what its attempts spent', () => {
    const money = (v: number) => `≈$${v.toFixed(3)}`;
    expect(bundleLine(bundle({ verdictLine: 'rescued · 2 of 2 · rate >= 0.34 (95%)', spent: 0.032 }), money)).toBe('rescued · 2 of 2 · rate >= 0.34 (95%) · ≈$0.032');
    // Attempts no report names: their count.
    expect(bundleLine(bundle({ attempts: [attempt('A', true), attempt('B', false)], passes: 1 }), money)).toBe('2 attempts, 1 passed');
  });

  it('asks the server for them until it says it has none, and leaves a run it doesn’t know unbundled', async () => {
    const answers: Array<() => Promise<FixBundle[]>> = [];
    let asked = 0;
    const fail = (status: number) => () => Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));
    const source = bundleSource(() => {
      asked++;
      return answers.shift()!();
    });
    const one = bundle({});
    answers.push(() => Promise.resolve([one]), fail(404), fail(500), fail(405));
    expect(await source('R')).toEqual([one]);
    // A run the server doesn't know: none this time, and it is asked again next time.
    expect(await source('R')).toBeNull();
    await expect(source('R')).rejects.toThrow('HTTP 500');
    // A server that doesn't bundle them: none, and it isn't asked again.
    expect(await source('R')).toBeNull();
    expect(await source('S')).toBeNull();
    expect(asked).toBe(4);
  });

  it('says how many attempts passed, what they cost, and for a verify the change and how it came out', () => {
    const money = (usd: number) => `≈$${usd.toFixed(3)}`;
    expect(bundleLine(bundle({ attempts: [attempt('A', true), attempt('B', false)], passes: 1, spent: 0.032 }), money)).toBe('2 attempts, 1 passed · ≈$0.032');
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true)], passes: 1, change: 'repair candidate 3', verdict: 'accepted' }), money)).toBe('1 attempt, 1 passed · repair candidate 3 accepted');
  });

  it('marks an attempt that could not be judged apart from one that failed, and counts it apart', () => {
    const unsure = attempt('C', false, false, 'inconclusive');
    expect([attempt('A', true), attempt('B', false), unsure].map(attemptMark)).toEqual([undefined, 'no', 'unsure']);
    // An attempt kept before attempts had a verdict reads as whether it passed.
    expect(attemptMark({ passed: false })).toBe('no');
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true), unsure], passes: 1, change: 'working tree', verdict: 'incomplete' }), (usd) => `≈$${usd.toFixed(3)}`)).toBe('2 attempts, 1 passed, 1 inconclusive · working tree incomplete');
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

  it('keeps a cell that reads as one token whole, and labels each value on a phone by its plain header', () => {
    expect(cellKeepsWhole('`01M50JGGW8`')).toBe(true);
    expect(cellKeepsWhole('held-out')).toBe(true);
    expect(cellKeepsWhole('4 of 4 passed')).toBe(false);
    expect(cellKeepsWhole('issue_refund({"order_id":"A-1042","amount":240})')).toBe(false);
    expect(plainCell(' `Run` id ')).toBe('Run id');
    expect(breakPoints('issue_refund({"order_id":"A-1042","amount":240})')).toEqual(['issue_refund(', '{', '"order_id":', '"A-1042",', '"amount":', '240})']);
    expect(breakPoints('fixed')).toEqual(['fixed']);
    expect(breakPoints('model call #5 (3 of 4)')).toEqual(['model call #5 (3 of 4)']);
    expect(breakPoints('"Above.", escalate({"reason":"over the limit"})')).toEqual(['"Above.", escalate(', '{', '"reason":', '"over the limit"})']);
  });

  it('sets text in backticks as code, and leaves the rest text', () => {
    expect(inlineParts('in `agent.mjs`: done')).toEqual([
      { code: false, text: 'in ' },
      { code: true, text: 'agent.mjs' },
      { code: false, text: ': done' },
    ]);
    expect(inlineParts('<b>not html</b>')).toEqual([{ code: false, text: '<b>not html</b>' }]);
  });

  it('sets each command-line flag in a sentence apart, with its placeholder, so it keeps to one line', () => {
    expect(flagParts('try a stronger model with --stronger <model>, or look at the code and the tools')).toEqual([
      { flag: false, text: 'try a stronger model with ' },
      { flag: true, text: '--stronger <model>' },
      { flag: false, text: ', or look at the code and the tools' },
    ]);
    expect(flagParts('--branch and --pr hand it over')).toEqual([
      { flag: true, text: '--branch' },
      { flag: false, text: ' and ' },
      { flag: true, text: '--pr' },
      { flag: false, text: ' hand it over' },
    ]);
    expect(flagParts('input tokens per run grow 30%, more than --max-growth 25%')).toEqual([
      { flag: false, text: 'input tokens per run grow 30%, more than ' },
      { flag: true, text: '--max-growth' },
      { flag: false, text: ' 25%' },
    ]);
    // Not a flag: a dash in a word, a lone --, an em dash.
    expect(flagParts('a pre--release run -- <command> — then')).toEqual([{ flag: false, text: 'a pre--release run -- <command> — then' }]);
  });
});

describe('Run blame’s check', () => {
  it('takes a JSON object, and says why anything else isn’t one', () => {
    expect(parseCheck(' {"tools":{"send_email":1}} ')).toEqual({ expect: { tools: { send_email: 1 } } });
    expect(parseCheck('{"tools":')).toEqual({ error: 'That isn’t JSON. Give an object, such as {"tools":{"send_email":1}}.' });
    for (const text of ['[1]', 'null', '"send_email"', '3']) expect(parseCheck(text)).toEqual({ error: 'The check is an object, such as {"tools":{"send_email":1}}.' });
  });
});

describe('the job drawer', () => {
  const job = (kind: string, code: number | null, result: unknown) => ({ kind, code, result, args: [kind], done: true });

  it('ends a blame, a repair and a fix apply on how they came out', () => {
    expect(jobStatus(job('blame', 0, { outcome: 'blamed', blamed: { callNo: 5 } }), [])).toEqual({ text: 'lost at #5 · exit 0', tone: 'ok' });
    expect(jobStatus(job('blame', 0, { outcome: 'unrescuable', blamed: null }), [])).toEqual({ text: 'not rescued · exit 0', tone: 'warn' });
    // Its first probe couldn't tell, and nothing else was found: not settled, never "not rescued".
    const unsettled = { outcome: 'unrescuable', blamed: null, sameAnswer: null, failedWrite: null, probes: [{ callNo: 1, decision: 'inconclusive' }] };
    expect(jobStatus(job('blame', 0, unsettled), [])).toEqual({ text: 'not settled · exit 0', tone: 'warn' });
    expect(jobStatus(job('blame', 0, { ...unsettled, failedWrite: { name: 'post_digest', message: 'channel_not_found', callNo: 1 } }), [])).toEqual({ text: 'not rescued · exit 0', tone: 'warn' });
    expect(jobStatus(job('blame', 0, { ...unsettled, probes: [{ callNo: 1, decision: 'fail' }] }), [])).toEqual({ text: 'not rescued · exit 0', tone: 'warn' });
    expect(jobStatus(job('blame', 1, { outcome: 'stopped' }), [])).toEqual({ text: 'stopped early · exit 1', tone: 'err' });
    expect(jobStatus(job('repair', 0, { outcome: 'fixed' }), [])).toEqual({ text: 'fixed · exit 0', tone: 'ok' });
    expect(jobStatus(job('repair', 1, { outcome: 'not-fixed' }), [])).toEqual({ text: 'no fix found · exit 1', tone: 'err' });
    expect(jobStatus(job('repair', 1, { outcome: 'fixed', error: { message: 'gh refused' } }), [])).toEqual({ text: 'fixed, not handed over · exit 1', tone: 'err' });
    expect(jobStatus(job('apply', 0, { status: 'applied', tests: 'passed' }), [])).toEqual({ text: 'applied · tests passed · exit 0', tone: 'ok' });
    expect(jobStatus(job('apply', 1, { status: 'applied', tests: 'failed' }), [])).toEqual({ text: 'applied · tests failed · exit 1', tone: 'err' });
    expect(jobStatus(job('apply', 0, { status: 'applied', tests: 'skipped' }), [])).toEqual({ text: 'applied · exit 0', tone: 'ok' });
  });

  it('ends a fix apply that left other goldens behind on how many to update, and asks before updating them', () => {
    const outdated = [
      { golden: 'goldens/refund-in-limit', callNo: 1, path: '$.tools[4].description' },
      { golden: 'goldens/01M53A4MZS', callNo: 1, path: '$.tools[4].description' },
    ];
    expect(jobStatus(job('apply', 0, { status: 'applied', tests: 'passed', outdated }), [])).toEqual({ text: 'applied · tests passed · 2 goldens to update · exit 0', tone: 'warn' });
    expect(jobStatus(job('apply', 1, { status: 'applied', tests: 'failed', outdated: outdated.slice(0, 1) }), [])).toEqual({ text: 'applied · tests failed · 1 golden to update · exit 1', tone: 'err' });
    expect(outdatedOf({ outdated: [...outdated, { golden: '', callNo: 1, path: '$' }, { golden: 'x' }, 'goldens/y'] })).toEqual(outdated);
    expect(outdatedOf(null)).toEqual([]);
    const ask = updateOutdatedAsk(outdated);
    expect(ask).toMatchObject({ title: 'Update 2 goldens?', command: 'shadowlap test goldens/refund-in-limit goldens/01M53A4MZS --update', fields: { goldens: ['goldens/refund-in-limit', 'goldens/01M53A4MZS'] } });
    expect(ask.text).toMatch(/^They diverge on what the patch changed \(#1 \$\.tools\[4\]\.description\)\. Use this when the change was intended: each is re-recorded live with writes stubbed/);
    expect(updateOutdatedAsk(outdated.slice(1))).toMatchObject({ title: 'Update 01M53A4MZS?', fields: { golden: 'goldens/01M53A4MZS' } });
  });

  it('leaves other jobs, and a result it does not know, to the output', () => {
    expect(fixJobStatus(job('apply', 1, { fixId: 'fx', status: 'error', error: { message: 'conflict' } }))).toBeNull();
    expect(fixJobStatus(job('pack', 0, { outcome: 'blamed' }))).toBeNull();
    expect(fixJobStatus(job('blame', null, null))).toBeNull();
    expect(jobStatus(job('apply', 1, null), ['✗ agent.mjs has uncommitted changes'])).toEqual({ text: 'exit 1', tone: 'err' });
  });
});
