import { formatUsd, pluralS as s, safeLine, shortFixId, type Palette } from '@shadowlap/engine';
import type { FixDetail, FixList, FixRow, FixStep } from '@shadowlap/dashboard';
import { ago, quoteArgv, table } from './ui.js';

/** `shadowlap fix ls` and `fix show` in a terminal, from the read model `--json` prints. Times read as `ls` prints them: 3h ago. */

// The fix id as the list shows it, for the commands that print one.
export { shortFixId };

const one = (text: string, n = 100) => {
  const line = safeLine(text).replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

function status(st: string, p: Palette, width = 0): string {
  const padded = st.padEnd(width);
  return st === 'open' ? p.yellow(padded) : p.green(padded);
}

const unpriced = (models: readonly string[]) => (models.length ? ` (no price for ${models.map((m) => one(m, 40)).join(', ')})` : '');

const mark = (x: FixStep, p: Palette) => (x.state === 'done' ? p.green('✓') : x.state === 'no' ? p.red('✗') : p.dim('·'));

/**
 * What a fix's failing runs did and the check they must meet, labelled as the dashboard's list and
 * header label them: `failed: send_email called twice, not once · must: send_email called once`.
 * What they did is left out while the title says it (blame titled the fix by it, and nobody renamed
 * it), as the page's failedMust() leaves it out.
 */
function failedMust(f: Pick<FixRow, 'title' | 'failed' | 'check'>, n: number): string {
  const failed = f.failed?.trim() ?? '';
  const said = !failed || failed.toLowerCase() === f.title.trim().toLowerCase();
  return [...(said ? [] : [`failed: ${one(failed, n)}`]), `must: ${one(f.check, n)}`].join(' · ');
}

/**
 * A probe's or a verified run's tally: the attempts that passed of those judged, then `unit` (`2 of
 * 4 passed`), and those that could not be judged (all they fell short on is a check no attempt could
 * decide) apart, never as failures: `1 of 1 passed, an attempt not judged`.
 */
function tally(x: { passes: number; attempts: number; inconclusive: number }, unit = ''): string {
  const judged = x.attempts - x.inconclusive;
  if (!x.inconclusive) return `${x.passes} of ${x.attempts}${unit}`;
  const apart = `${x.inconclusive === 1 ? 'an attempt' : `${x.inconclusive} attempts`} not judged`;
  return judged ? `${x.passes} of ${judged}${unit}, ${apart}` : apart;
}

/** A repair's outcome in words, as `shadowlap repair` prints it. */
const OUTCOME: Record<NonNullable<FixDetail['repair']>['outcome'], string> = { fixed: 'fixed', 'not-fixed': 'not fixed', 'no-diagnosis': 'no fix to try', stopped: 'stopped' };

export function formatFixList(list: FixList, p: Palette): string {
  if (!list.fixes.length) return p.dim(`No fixes here. A fix starts from a blame: shadowlap blame <run> --expect '<check>'`);
  const rows = list.fixes.map((f) => [f.status, shortFixId(f.fixId), one(f.title, 60), `${f.label ? `${one(f.label, 30)} · ` : ''}${f.failing} failing`, f.steps.map((x) => x.short).join(' · ')]);
  const lines = table(rows).split('\n');
  const width = Math.max(...list.fixes.map((f) => f.status.length));
  const indent = ' '.repeat(width + 2);
  const out: string[] = [];
  list.fixes.forEach((f, i) => {
    out.push(status(f.status, p, width) + lines[i]!.slice(width));
    // What its runs did and must do, where it came from and when it was opened, under its row.
    out.push(p.dim(`${indent}${[failedMust(f, 90), ...(f.source ? [one(f.source, 40)] : []), `opened ${ago(f.openedAt)}`].join(' · ')}`));
    if (f.broken) out.push(`${indent}${p.red(`! ${f.broken}`)}`);
  });
  out.push('', p.dim(`${list.counts.all} fix${list.counts.all === 1 ? '' : 'es'}, ${list.counts.open} open · shadowlap fix show <fix>`));
  return out.join('\n');
}

/**
 * The repair to run next for an open fix. A repairer set in shadowlap.config.json applies by itself;
 * otherwise the user's own Claude Code, as the dashboard asks.
 */
export function repairLine(argv: readonly string[], configured: string | null | undefined): string {
  return quoteArgv(['shadowlap', ...argv, ...(configured ? [] : ['--repairer', 'claude-code'])]);
}

export function formatFixDetail(d: FixDetail, p: Palette, o: { repairer?: string | null } = {}): string {
  const out: string[] = [];
  out.push(`${p.bold(d.fixId)}  ${p.bold(one(d.title, 120))}`);
  const meta = [status(d.status, p), ...(d.label ? [one(d.label, 40)] : []), `${d.failing} failing run${s(d.failing)}`, `${d.good} good`, `opened ${ago(d.openedAt)}`, ...(d.verifiedAt ? [`verified ${ago(d.verifiedAt)}`] : []), ...(d.appliedAt ? [`applied ${ago(d.appliedAt)}`] : [])];
  out.push(`  ${meta.join(' · ')}`);
  out.push(`  ${failedMust(d, 200)}`);
  if (d.source) out.push(`  ${p.dim(d.source)}`);
  if (d.broken) out.push(`  ${p.red(`! ${d.broken}`)}`);
  out.push('');
  const stepRows = d.steps.map((x) => [`${x.n} ${x.key}`, x.title, x.meta]);
  const stepLines = table(stepRows.map((r) => [r[0]!, one(r[1]!, 60), one(r[2]!, 80)])).split('\n');
  stepLines.forEach((line, i) => out.push(`  ${mark(d.steps[i]!, p)} ${line}`));

  const b = d.blame;
  if (b) {
    out.push('', p.bold(`Blame · ${b.runId.slice(0, 10)}${b.step !== null ? `, model call ${b.step} of ${b.steps}` : ''}${b.scope ? ` in scope ${one(b.scope, 30)}` : ''} · confidence ${b.confidence}`));
    out.push(`  ${one(b.boundary, 200)}`);
    if (b.answers) {
      const label = `At #${b.answers.callNo}`;
      out.push(`  ${label}  ${p.dim('the recording ')}  ${one(b.answers.recorded, 110)}`);
      out.push(`  ${' '.repeat(label.length)}  ${p.dim('a rescued fork')}  ${one(b.answers.rescued, 110)}${b.rescuedRunId ? p.dim(`  (${b.rescuedRunId.slice(0, 10)})`) : ''}`);
    }
    if (b.probes.length) {
      out.push(`  ${p.dim(`probes: ${b.rule}; ${b.rescue}`)}`);
      // Each probe's tally with the Wilson bound its gate decided on; the rule is the line above.
      const rows = b.probes.map((x) => [`#${x.callNo}`, `${x.step} of ${b.steps}`, `${tally(x, ' passed')}${x.bound ? ` · ${x.bound}` : ''}`, x.verdict]);
      out.push(table(rows, '    '));
    }
    out.push(p.dim(`  ${b.cost.attempts} attempt${s(b.cost.attempts)} · ${b.cost.upstreamRequests} upstream requests · ≈${formatUsd(b.cost.spent)} spent${unpriced(b.cost.unknownModels)}`));
    out.push(p.dim(`  $ ${b.command}`));
  }

  const r = d.repair;
  if (r) {
    // Who proposed its candidates, or why no repairer did ("the repairer could not be asked: claude was not found").
    const by = r.repairer ? ` · proposed by ${r.repairer}` : r.noRepairer ? ` · ${one(r.noRepairer.text, 300)}` : '';
    out.push('', p.bold(`Repair · ${r.repairId}, ${r.accepted ? 'accepted' : OUTCOME[r.outcome]} ${ago(r.at)}${by}`));
    if (r.change) {
      out.push(`  ${p.dim(`${one(r.change.file, 80)} · ${one(r.change.anchor, 60)}`)}`);
      out.push(`  ${p.red(`- ${one(r.change.before, 200)}`)}`, `  ${p.green(`+ ${one(r.change.after, 200)}`)}`);
      if (r.roles.length) out.push(`  ${r.roles.map((x) => `${x.role} ${x.held} of ${x.of}`).join(' · ')}${r.rule !== null ? `, ${r.rule}` : ''}`);
      if (r.verify && !r.verify.counts) out.push(`  ${p.yellow('!')} verified under another check than this fix's, so it doesn't count for it`);
    } else if (r.why && r.why !== r.noRepairer?.text) out.push(`  ${one(r.why, 200)}`);
    if (r.diagnosis) out.push(`  ${p.dim('diagnosis:')} ${one(r.diagnosis, 200)}`);
    if (r.candidates.length) {
      out.push(`  ${p.dim('candidates, smallest first:')}`);
      for (const c of r.candidates) {
        const v = c.verdict === 'accepted' ? p.green(c.verdict.padEnd(9)) : c.verdict === 'not tried' ? p.dim(c.verdict.padEnd(9)) : p.yellow(c.verdict.padEnd(9));
        out.push(`    ${String(c.id).padStart(2)}  ${v}  ${one(c.text, 80)}`);
        if (c.verdict !== 'accepted') out.push(`        ${p.dim(one(c.why, 140))}`);
      }
    }
    out.push(p.dim(`  files: ${r.dir}/ (${r.files.map((f) => f.name).join(', ')})`));
    out.push(p.dim(`  $ ${r.command}`));
    // What the evidence lacks, as the Repair step lists it: why no repairer proposed candidates, with what to do, among them.
    for (const w of r.warnings) out.push(`  ${p.yellow('!')} ${one(w, 400)}`);
  }

  if (d.verify.length) {
    out.push('', p.bold(`Verify · ${d.verify.length} change${s(d.verify.length)} verified`));
    for (const v of d.verify) {
      const badge = v.verdict === 'accepted' ? p.green('✓ accepted') : v.verdict === 'rejected' ? p.red('✗ rejected') : p.yellow('! incomplete');
      // Named by what changed (a request field set is named by it, never by its commit alone); one
      // that doesn't count for the fix is headed with why.
      out.push(`  ${badge}  ${one(v.code, 90)}  ${v.counts ? v.headline : p.yellow(v.headline)}`);
      if (v.note) out.push(`    ${p.red(one(v.note, 200))}`);
      out.push(p.dim(`    ${one(v.oracle, 200)}`));
      const rows = v.rows.map((x) => [x.role, x.runId.slice(0, 10), x.outcome, x.deterministic && !x.inconclusive ? 'clean replay' : `${tally(x)}${x.rate?.bound ? ` · ${x.rate.bound}` : ''}`, x.note === 'clean replay' ? '' : one(x.note, 70)]);
      if (rows.length) out.push(table(rows, '    '));
      const delta = v.tokens ? `${Math.round(v.tokens.before).toLocaleString('en-US')} → ${Math.round(v.tokens.after).toLocaleString('en-US')} input tokens per run (${v.tokens.change})` : '';
      out.push(p.dim(`    ${v.attempts} attempt${s(v.attempts)} · ${v.upstreamRequests} upstream requests · ≈${formatUsd(v.spent)} spent${unpriced(v.unknownModels)}${delta ? ` · ${delta}` : ''}`));
    }
  }

  out.push('', p.dim(`  ${d.attempts} attempt${s(d.attempts)} behind this fix · ≈${formatUsd(d.spent)} spent live; everything before each fork replayed free`));
  const apply = d.actions.apply;
  if (d.actions.repair) {
    out.push(`  next: ${repairLine(d.actions.repair.argv, o.repairer)}`);
    // The blames it would reuse rescued no run: it would end "No fix to try", as the dashboard says.
    if (d.actions.repair.noFix) out.push(`  ${p.yellow('!')} ${one(d.actions.repair.noFix, 600)}`);
    // Its repairer can't be asked from here: it would blame the runs and find no one to propose a fix.
    if (d.repairer.problem) out.push(`  ${p.yellow('!')} ${one(d.repairer.problem, 600)}`);
  } else if (apply?.refused && !(d.actions.applied && !apply.pending)) {
    // More than the one rewrite its repair verified: fix apply won't put it in, and nothing here offers to.
    out.push(`  ${p.yellow('!')} its patch is not the change its repair verified: ${one(apply.refused, 600)}. shadowlap fix apply won't apply it`);
  } else if (apply && !d.actions.applied) {
    // Merged, or applied by hand: there is nothing to apply, and fix apply only marks it applied.
    if (apply.inTree) out.push(`  next: shadowlap fix apply ${shortFixId(d.fixId)} ${p.dim(`(its patch is in your working tree already: ${apply.goldens ? 'copies the goldens it is missing, runs them and marks it applied' : 'marks it applied'})`)}`);
    else if (apply.kind === 'patch') out.push(`  next: shadowlap fix apply ${shortFixId(d.fixId)}${apply.gitApply ? p.dim(`   (or by hand: ${apply.gitApply})`) : ''}`);
    // A change of request fields no patch carries: making it in the agent is left to you.
    else if (apply.change) out.push(`  next: shadowlap fix apply ${shortFixId(d.fixId)} ${p.dim(`(verified with ${one(apply.change, 200)}: once your agent makes that change, marks it applied)`)}`);
    else out.push(`  next: shadowlap fix apply ${shortFixId(d.fixId)} ${p.dim('(verified on your working tree: marks it applied)')}`);
  }
  if (d.applied) {
    // With no patch, a change of request fields is named: the agent makes it, not a file.
    const none = apply?.change ? `none (verified with ${one(apply.change, 200)}: set it in your agent)` : 'none (verified on the working tree)';
    out.push(p.dim(`  applied${d.applied.via === 'repair --apply' ? ' by repair --apply' : ''}: patch ${d.applied.patch === 'already' ? 'was already in the tree' : d.applied.patch === 'none' ? none : 'applied'}${d.applied.goldens.length ? ` · ${d.applied.goldens.length} golden${s(d.applied.goldens.length)} copied` : ''} · tests ${d.applied.tests}`));
    if (apply?.pending) out.push(`  next: shadowlap fix apply ${shortFixId(d.fixId)} ${p.dim(`(to ${apply.pending})`)}`);
  }
  return out.join('\n');
}
