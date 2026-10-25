import { describe, expect, it } from 'vitest';
import { appliedButton, applyText, attemptMark, blameNextStep, breakPoints, bundledRuns, bundleGlyph, bundleLine, bundleSource, callRowCells, candidateTone, cellKeepsWhole, changeParts, chipKeeps, failedMust, failingLine, fixAction, fixJobStatus, fixName, flagParts, footWarnings, inlineParts, keepAt, laterStamp, markText, mergeTreeJobs, moreLine, nothingAcceptedWhy, outcomeTone, outdatedOf, parseCheck, parseMarkdown, patchLines, plainCell, probeBadge, probeVerdictWords, repairAside, repairAsk, repairBy, repairReceipt, roleBadges, sameFolder, statusBadge, stepFor, stepLeads, treeBusy, updateOutdatedAsk, verdictTone, verifyFor, wholeParts, type TreeJob } from '../ui/fixes/model.js';
import { jobStatus } from '../ui/jobs.js';
import type { BlameStep, FixBundle, FixDetail, RepairStep, VerifyStep } from '../ui/types.js';

// How the Fixes pages read a fix: the chips, the step and verdict a URL opens, the main action, the
// Blame step's row of calls, the change cut to what changed, the Forks view's bundles and report.md.

const verify = (verifyId: string, verdict: VerifyStep['verdict'] = 'accepted'): VerifyStep =>
  ({ verifyId, verdict, href: `#/fixes/fx-1/verify/${verifyId}`, label: `x · ${verdict}` }) as VerifyStep;

const actions = (o: Partial<FixDetail['actions']>): FixDetail['actions'] => ({ repair: null, apply: null, applied: false, blameAgain: null, blameStronger: null, ...o });

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

  it('says what the failing runs did and what they must do, labelled, and what failed only when the title doesn’t say it', () => {
    expect(failingLine({ failing: 3 })).toBe('3 failing runs');
    expect(failingLine({ failing: 1 })).toBe('1 failing run');
    expect(failedMust({ title: 'Confirmation email sent twice', failed: 'send_email called twice, not once', check: 'send_email called once' })).toEqual({ failed: 'send_email called twice, not once', must: 'send_email called once' });
    // Blame titled it by how the agent exited, and nobody renamed it: the title says what failed.
    expect(failedMust({ title: 'The agent exited with code 1', failed: 'The agent exited with code 1', check: 'the agent exits 0' })).toEqual({ failed: null, must: 'the agent exits 0' });
    expect(failedMust({ title: 'Send email twice', failed: 'send email TWICE', check: 'send_email called once' })).toEqual({ failed: null, must: 'send_email called once' });
    expect(failedMust({ title: 'A run failed', failed: null, check: 'the agent exits 0' })).toEqual({ failed: null, must: 'the agent exits 0' });
  });

  it('keeps a count with its unit and a comparison whole where a check wraps', () => {
    expect(wholeParts('send_email called 1 time; tools called 2 times')).toEqual([{ text: 'send_email called 1\u00a0time; tools called 2\u00a0times', whole: false }]);
    expect(wholeParts('every issue_refund call: after get_policy, amount <= get_policy.result.limit')).toEqual([
      { text: 'every issue_refund call: after get_policy, ', whole: false },
      { text: 'amount <=\u00a0get_policy.result.limit', whole: true },
    ]);
    expect(wholeParts('issue_refund: amount 240 > get_policy.result.limit 100 (#4)')).toEqual([
      { text: 'issue_refund: ', whole: false },
      { text: 'amount 240 >\u00a0get_policy.result.limit\u00a0100', whole: true },
      { text: ' (#4)', whole: false },
    ]);
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
    const repair = { argv: ['repair'], command: 'shadowlap repair', noFix: null };
    const patch = { kind: 'patch' as const, argv: ['fix', 'apply', 'fx-1'], gitApply: 'git apply x/fix.patch', pending: null, pulled: false, files: ['agent.mjs'], diff: 'diff --git a/agent.mjs b/agent.mjs\n', patchFile: 'x/fix.patch', refused: null, inTree: false, goldens: 1, change: null };
    expect(fixAction({ status: 'open', actions: actions({ repair }) })).toEqual({ kind: 'repair' });
    expect(fixAction({ status: 'open', actions: actions({}) })).toEqual({ kind: 'none', label: 'Repair from here', why: expect.stringMatching(/nothing to repair from here/) });
    expect(fixAction({ status: 'verified', actions: actions({ apply: patch }) })).toEqual({ kind: 'apply', label: 'Apply the patch' });
    expect(fixAction({ status: 'verified', actions: actions({ apply: { ...patch, kind: 'mark', gitApply: null } }) })).toEqual({ kind: 'apply', label: 'Mark applied' });
    // Merged, or applied by hand: applying only marks it applied.
    expect(fixAction({ status: 'verified', actions: actions({ apply: { ...patch, gitApply: null, inTree: true } }) })).toEqual({ kind: 'apply', label: 'Mark applied' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: patch, applied: true }) })).toEqual({ kind: 'applied' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: { ...patch, pending: 'run shadowlap test on its goldens' }, applied: true }) })).toEqual({ kind: 'apply', label: 'Finish applying' });
    // A patch fix apply refuses: the button stays off, and says why on hover.
    const refused = { ...patch, gitApply: null, refused: 'it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone' };
    expect(fixAction({ status: 'verified', actions: actions({ apply: refused }) })).toEqual({ kind: 'none', label: 'Apply the patch', why: 'This patch is not the change its repair verified: it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone. Nothing applies it from here.' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: { ...refused, pending: 'run shadowlap test on its goldens' }, applied: true }) })).toMatchObject({ kind: 'none' });
    expect(fixAction({ status: 'applied', actions: actions({ apply: refused, applied: true }) })).toEqual({ kind: 'applied' });
  });

  it('says what marking a fix applied does: for a patch in the tree already, what applying still does', () => {
    expect(markText({ inTree: true, goldens: 2, pulled: false, change: null })).toBe('The patch is already in your working tree: this copies the goldens it is missing into goldens/, runs them with shadowlap test and marks the fix applied.');
    expect(markText({ inTree: true, goldens: 0, pulled: true, change: null })).toBe('The patch is already in your working tree: this marks the fix applied. The recordings the fixed code made stay on the machine that ran the repair.');
    expect(markText({ inTree: false, goldens: 0, pulled: false, change: null })).toBe('It was verified on your working tree as it is, so there is no patch to apply: this marks it applied.');
    // A change of request fields is in no file: never "no patch to apply", which reads as if the change were in the tree.
    expect(markText({ inTree: false, goldens: 0, pulled: false, change: "temperature=1 from each run's first model call" })).toBe("It was verified with temperature=1 from each run's first model call, a change to the requests rather than to your files: once your agent makes it, this marks the fix applied.");
  });

  it('says a fix with no patch was marked applied, naming the change its agent makes, never that a patch went in', () => {
    expect(appliedButton({ kind: 'patch', pulled: false, change: null })).toEqual({ label: 'Patch applied', title: 'The patch is in the working tree and its goldens pass' });
    expect(appliedButton({ kind: 'patch', pulled: true, change: null }).title).toBe('The patch is in the working tree; its goldens are on the machine that ran the repair');
    const field = appliedButton({ kind: 'mark', pulled: false, change: "temperature=1 from each run's first model call" });
    expect(field).toEqual({ label: 'Marked applied', title: "Verified with temperature=1 from each run's first model call, a change to the requests that your agent makes, not to your files" });
    const tree = appliedButton({ kind: 'mark', pulled: false, change: null });
    expect(tree).toEqual({ label: 'Marked applied', title: 'Verified on your working tree as it was, and marked applied' });
    for (const b of [field, tree]) expect(b.title).not.toMatch(/patch/);
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

  it('keeps Repair from here but not as the lead when the repair would end with no fix to try, and says why', () => {
    const noFix = 'No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.';
    expect(repairAside({ actions: actions({ repair: { argv: ['repair'], command: 'shadowlap repair', noFix } }) })).toBe(noFix);
    // A blame that couldn't settle has a look of its own on the Blame step, which says nothing of a repair.
    expect(repairAside({ actions: actions({ repair: { argv: ['repair'], command: 'shadowlap repair', noFix: null } }), blame: { look: 'Not settled: resampled from #1…' } as FixDetail['blame'] } as FixDetail)).toBeNull();
    expect(repairAside({ actions: actions({}) })).toBeNull();
  });

  it('names the repairer Repair from here asks as the fix reads again, and sends that one', () => {
    const fix = (repairer: FixDetail['repairer'], o: Partial<FixDetail> = {}) =>
      ({ status: 'open', repairer, actions: actions({ repair: { argv: ['repair'], command: `shadowlap repair${repairer.configured ? '' : ' --repairer claude-code'}`, noFix: null } }), ...o }) as FixDetail;
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
    const page = { status: 'open', repairer: { name: 'claude-code', configured: false, problem: null }, actions: actions({ repair: { argv: ['repair'], command: 'shadowlap repair --repairer claude-code', noFix: null } }) } as FixDetail;
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

  it('leads its receipt with the attempts it ran, then what every stage cost, each candidate it tried included, as the CLI says it', () => {
    const cost = { blame: 0.0539172, repairer: 0.008466, verify: 0.238736 };
    expect(repairReceipt(step({ repairer: 'anthropic:claude-opus-5-5', cost, attempts: 87 })).join(' · ')).toBe('87 attempts · cost: blame ≈$0.054 · repairer ≈$0.0085 · verify ≈$0.239');
    expect(repairReceipt(step({ repairer: 'openai:gpt-6', served: 'gpt-6-2026-08-01', cost: { ...cost, repairer: null, judge: 0.0021 }, attempts: 1 }))).toEqual(['1 attempt', 'cost: blame ≈$0.054', 'repairer (no price for gpt-6-2026-08-01)', 'verify ≈$0.239', 'judge checks ≈$0.0021']);
    // No repairer was asked: nothing to say of it.
    expect(repairReceipt(step({ cost: { blame: 0, repairer: null, verify: 0 }, attempts: 0 })).join(' · ')).toBe('0 attempts · cost: blame $0 · verify $0');
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
  const repairing = { id: 'j1', done: false, worktree: { use: 'writes' as const, doing: 'a repair is verifying candidates made from your working tree' } };
  const blaming = { id: 'j2', done: false, worktree: { use: 'reads' as const, doing: 'a blame is running your agent from your working tree' } };
  const packing = { id: 'j3', done: false, worktree: null };

  it('keeps a blame waiting while a repair or an apply changes the tree, as the server would refuse it', () => {
    expect(treeBusy([repairing], 'reads', 'blame')).toBe('A repair is verifying candidates made from your working tree: blame once it is done.');
    expect(treeBusy([{ ...repairing, done: true }], 'reads', 'blame')).toBeNull();
    // Agents run side by side from a tree nothing changes, and a job that runs no agent never waits.
    expect(treeBusy([blaming, packing], 'reads', 'blame')).toBeNull();
  });

  it('keeps a repair or an apply waiting while anything runs the agent from the tree', () => {
    expect(treeBusy([packing, blaming], 'writes', 'repair')).toBe('A blame is running your agent from your working tree: repair once it is done.');
    expect(treeBusy([repairing], 'writes', 'apply the patch')).toBe('A repair is verifying candidates made from your working tree: apply the patch once it is done.');
    expect(treeBusy([packing], 'writes', 'repair')).toBeNull();
    expect(treeBusy([], 'writes', 'repair')).toBeNull();
  });

  it('counts only jobs in the project’s own tree: its folder, or one inside it or around it', () => {
    const at = (folder: string | null) => ({ ...repairing, worktree: { ...repairing.worktree, folder } });
    expect(treeBusy([at('/p/one')], 'reads', 'blame', '/p/one')).toMatch(/^A repair is verifying candidates/);
    expect(treeBusy([at('/p/one/sub')], 'reads', 'blame', '/p/one')).toMatch(/^A repair is verifying candidates/);
    expect(treeBusy([at('/p')], 'reads', 'blame', '/p/one')).toMatch(/^A repair is verifying candidates/);
    expect(treeBusy([at('/p/two')], 'reads', 'blame', '/p/one')).toBeNull();
    expect(treeBusy([at('/p/one-two')], 'reads', 'blame', '/p/one')).toBeNull();
    // A job, or a page, with no folder is the dashboard's own: one with every tree.
    expect(treeBusy([at(null)], 'reads', 'blame', '/p/one')).toMatch(/^A repair is verifying candidates/);
    expect(treeBusy([at('/p/two')], 'reads', 'blame')).toMatch(/^A repair is verifying candidates/);
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

  it('badges a probe: rescued in lime, the blamed one too, lost in red, and only an inconclusive one in amber', () => {
    expect(probeBadge('rescued')).toBe('ok');
    expect(probeBadge('lost')).toBe('no');
    // The blamed call rescued the run: lime, and marked blamed apart, in ink.
    expect(probeBadge('rescued · blamed')).toBe('ok');
    expect(probeVerdictWords('rescued · blamed')).toEqual({ word: 'rescued', blamed: true });
    expect(probeVerdictWords('lost')).toEqual({ word: 'lost', blamed: false });
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
  it('badges each outcome, a run nothing decided in amber', () => {
    expect((['fixed', 'kept', 'not fixed', 'broken', 'unsettled', 'inconclusive'] as const).map(outcomeTone)).toEqual(['ok', 'ok', 'no', 'no', 'y', 'y']);
    expect((['accepted', 'rejected', 'incomplete'] as const).map(verdictTone)).toEqual(['ok', 'no', 'warn']);
  });

  it('says what Run more attempts takes, and why the run it names is open', () => {
    const run = { runId: '01M5JERYHZ', state: 'stopped' as const, why: 'the budget of $0.01 is spent', attempt: null };
    expect(moreLine({ kind: 'more', run, max: 80, expected: 12, cost: 0.045, budget: '0.012' })).toBe(' is not settled: the budget of $0.01 is spent. Run more attempts verifies again from the start (verify has no --continue), up to 80 a run, without its --budget 0.012: about\u00a012 attempts, ≈$0.045.');
    expect(moreLine({ kind: 'more', run: { ...run, state: 'inconclusive', why: null }, max: 160, expected: 35, cost: null, budget: null })).toBe(' is inconclusive. Run more attempts verifies again from the start (verify has no --continue), up to 160 a run: about\u00a035 attempts.');
    expect(moreLine({ kind: 'again', run: { ...run, state: 'unjudged', why: 'no key for anthropic', attempt: 3 }, max: 80, expected: 3, cost: null, budget: null })).toBe(' stopped at attempt 3, which could not be judged: no key for anthropic. Verify again once it can be.');
  });

  it('leads from the Verify step while the verdict it shows counts and is left incomplete with what settles it', () => {
    const more = { kind: 'more', run: { runId: 'R', state: 'stopped', why: null, attempt: null }, max: 80, expected: 12, cost: null, budget: null, argv: [], command: '' };
    const v = (o: Partial<VerifyStep>) => ({ verifyId: 'vf-1', counts: true, verdict: 'incomplete', more, ...o }) as VerifyStep;
    const f = (verify: VerifyStep[]) => ({ defaultStep: 'blame' as const, verify, defaultVerify: verify[0]?.verifyId ?? null });
    expect(stepLeads(f([v({})]), 'verify', null)).toBe(true);
    expect(stepLeads(f([v({})]), null, null)).toBe(false);
    expect(stepLeads(f([v({})]), 'blame', null)).toBe(false);
    expect(stepLeads(f([v({ more: null })]), 'verify', null)).toBe(false);
    expect(stepLeads(f([v({ counts: false })]), 'verify', null)).toBe(false);
    expect(stepLeads(f([v({ verdict: 'accepted' })]), 'verify', null)).toBe(false);
  });

  it('leads an open fix with its blame’s next step while blame placed the failure on no call', () => {
    const none = actions({});
    const gate = { kind: 'sprt' as const, good: 0.4, bad: 0.1, risk: 0.05, max: 40 };
    expect(blameNextStep({ status: 'open', actions: { ...none, blameAgain: { kind: 'unsettled', argv: [], command: 'shadowlap blame R --gate x', gate, pulled: null, left: [] } } })).toEqual({ kind: 'again', label: 'Blame again', tip: 'More attempts and a lower bar: a rescue at 40% or more, up to 40 attempts', command: 'shadowlap blame R --gate x' });
    expect(blameNextStep({ status: 'open', actions: { ...none, blameAgain: { kind: 'stopped', argv: [], command: 'c', gate: null, pulled: null, left: [] } } })).toMatchObject({ kind: 'again', tip: 'Runs the search to the end, without the budget that stopped it' });
    expect(blameNextStep({ status: 'open', actions: { ...none, blameStronger: { argv: [], command: 'c --model <model>', attempts: 4, spent: 0.002, pulled: null, left: [] } } })).toMatchObject({ kind: 'stronger', label: 'Blame with a stronger model…' });
    expect(blameNextStep({ status: 'open', actions: none })).toBeNull();
    expect(blameNextStep({ status: 'verified', actions: { ...none, blameStronger: { argv: [], command: 'c', attempts: 4, spent: 0, pulled: null, left: [] } } })).toBeNull();
  });
});

describe('the Forks view’s bundles', () => {
  const bundle = (o: Partial<FixBundle>): FixBundle => ({ kind: 'blame', key: 'k', parentRunId: 'R', title: 'blame · probe #5', callNo: 5, blamed: false, change: null, verdict: null, role: null, counts: null, passes: 1, attempts: [], spent: 0, at: 0, verdictLine: null, tone: null, rule: null, href: '#/fixes/fx-1/blame', fixId: 'fx-1', ...o });
  const attempt = (runId: string, passed: boolean, rescued = false, verdict: 'passed' | 'failed' | 'inconclusive' = passed ? 'passed' : 'failed') => ({ runId, passed, verdict, note: passed ? 'passed' : verdict === 'inconclusive' ? 'inconclusive: judge "issued" answers yes' : 'failed', href: `#/run/${runId}`, rescued });

  it('leaves out every attempt they list but the rescued fork, which shows as a fork', () => {
    const b = bundle({ attempts: [attempt('A', true, true), attempt('B', false)] });
    expect([...bundledRuns([b])]).toEqual(['B']);
  });

  it('gives a verify the icon of how its run came out, inconclusive in amber, never a fork’s, and plain for one that doesn’t count for the fix', () => {
    expect(bundleGlyph({ kind: 'blame', verdict: null, counts: null }).kind).toBe('blame');
    // A run the change fixed, under a verify that rejected it for another run: its own outcome.
    expect(bundleGlyph({ kind: 'verify', verdict: 'rejected', counts: true, tone: 'ok' })).toEqual({ kind: 'fixok', label: 'Verify attempts: the run held' });
    expect(bundleGlyph({ kind: 'verify', verdict: 'accepted', counts: true, tone: 'no' }).kind).toBe('fixbad');
    expect(bundleGlyph({ kind: 'verify', verdict: 'incomplete', counts: true, tone: 'y' }).kind).toBe('warn');
    // Attempts no report names go by the verdict.
    expect(bundleGlyph({ kind: 'verify', verdict: 'accepted', counts: null })).toEqual({ kind: 'fixok', label: 'Verify accepted the change' });
    expect(bundleGlyph({ kind: 'verify', verdict: 'rejected', counts: null }).kind).toBe('fixbad');
    expect(bundleGlyph({ kind: 'verify', verdict: 'incomplete', counts: null }).kind).toBe('warn');
    // Accepted under another check: no verdict on the fix, so never its lime check, whatever its run did.
    expect(bundleGlyph({ kind: 'verify', verdict: 'accepted', counts: false, tone: 'ok' })).toEqual({ kind: 'fixok', label: "Verify attempts of a verdict that doesn't count for the fix", plain: true });
    // A candidate a repair dropped is no verdict of the fix's: its icon is its own verdict's.
    expect(bundleGlyph({ kind: 'verify', verdict: 'rejected', counts: null }).kind).toBe('fixbad');
  });

  it('says a bundle’s verdict as a gate’s is said, then what its attempts spent', () => {
    const money = (v: number) => `≈$${v.toFixed(3)}`;
    expect(bundleLine(bundle({ verdictLine: 'rescued · 2 of 2 · rate >= 0.34 (95%)', spent: 0.032 }), money)).toBe('rescued · 2 of 2 · rate >= 0.34 (95%) · ≈$0.032');
    // A verify's then names the change it checked and how that came out: a run kept under a rejected change says so.
    expect(bundleLine(bundle({ kind: 'verify', verdictLine: 'fixed · 12 of 12 · rate >= 0.76 (95%)', spent: 0.046, change: 'repair candidate 3', verdict: 'accepted' }), money)).toBe('fixed · 12 of 12 · rate >= 0.76 (95%) · ≈$0.046 · repair candidate 3 · accepted');
    expect(bundleLine(bundle({ kind: 'verify', verdictLine: 'kept · 3 of 3', spent: 0.011, change: 'repair candidate 2', verdict: 'rejected' }), money)).toBe('kept · 3 of 3 · ≈$0.011 · repair candidate 2 · rejected');
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
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true)], passes: 1, change: 'repair candidate 3', verdict: 'accepted' }), money)).toBe('1 attempt, 1 passed · repair candidate 3 · accepted');
  });

  it('says a verdict that doesn’t count for the fix doesn’t, as the Verify step’s switch does, and keeps a revision with its “at”', () => {
    const money = (usd: number) => `≈$${usd.toFixed(3)}`;
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true)], passes: 1, spent: 0.057, change: 'dbcef5d', verdict: 'accepted', counts: false }), money)).toBe("1 attempt, 1 passed · ≈$0.057 · dbcef5d · accepted · doesn't count");
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true)], passes: 1, change: 'dbcef5d', verdict: 'accepted', counts: true }), money)).toBe('1 attempt, 1 passed · dbcef5d · accepted');
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true)], passes: 1, change: "temperature=1 from each run's first model call · at dbcef5d", verdict: 'accepted', counts: true }), money)).toBe("1 attempt, 1 passed · temperature=1 from each run's first model call · at\u00a0dbcef5d · accepted");
  });

  it('keeps a change’s revision with the “at” before it, and a field’s own words as they are', () => {
    expect(keepAt("temperature=1 from each run's first model call · at dbcef5d · accepted")).toBe("temperature=1 from each run's first model call · at\u00a0dbcef5d · accepted");
    expect(keepAt(`system="look at this" from each run's first model call · at dbcef5d`)).toBe(`system="look at this" from each run's first model call · at\u00a0dbcef5d`);
    expect(keepAt('repair candidate 3')).toBe('repair candidate 3');
  });

  it('marks an attempt that could not be judged apart from one that failed, and counts it apart', () => {
    const unsure = attempt('C', false, false, 'inconclusive');
    expect([attempt('A', true), attempt('B', false), unsure].map(attemptMark)).toEqual([undefined, 'no', 'unsure']);
    // An attempt kept before attempts had a verdict reads as whether it passed.
    expect(attemptMark({ passed: false })).toBe('no');
    expect(bundleLine(bundle({ kind: 'verify', attempts: [attempt('A', true), unsure], passes: 1, change: 'working tree', verdict: 'incomplete' }), (usd) => `≈$${usd.toFixed(3)}`)).toBe('2 attempts, 1 passed, 1 inconclusive · working tree · incomplete');
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
    // Claude Code was never asked, and nothing else was tried: no fix was looked for, which is no failure of the agent's.
    const unasked = { outcome: 'not-fixed', noRepairer: 'the repairer could not be asked: claude was not found', candidates: [] };
    expect(jobStatus(job('repair', 1, unasked), [])).toEqual({ text: 'repairer not asked · exit 1', tone: 'warn' });
    expect(jobStatus(job('repair', 1, { ...unasked, noRepairer: 'no repairer is configured' }), [])).toEqual({ text: 'repairer not asked · exit 1', tone: 'warn' });
    // A model switch was tried and rejected first: a fix was looked for, and none found.
    expect(jobStatus(job('repair', 1, { ...unasked, noRepairer: 'no repairer is configured', candidates: [{ id: 1, state: 'rejected' }] }), [])).toEqual({ text: 'no fix found · exit 1', tone: 'err' });
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
