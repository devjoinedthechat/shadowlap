/**
 * The pure parts of the tau2-bench experiment: choosing tasks, grouping failures, splitting runs
 * into the half fixes are developed on and the half they are judged on, and scoring the result.
 * experiment.mjs does everything that runs something.
 */

/** Task ids compare as numbers when both are, as tau2's retail and airline ids are. */
export function compareTaskIds(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a).localeCompare(String(b));
}

/**
 * The tasks to run, in the split's order: `all`, `first:10`, or a list of ids such as `5,7,12`.
 * An id the split doesn't have is an error, not a silent skip.
 */
export function selectTasks(spec, ids) {
  if (!spec || spec === 'all') return [...ids];
  const first = /^first:(\d+)$/.exec(spec);
  if (first) return ids.slice(0, Number(first[1]));
  const wanted = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const missing = wanted.filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`the split has no task ${missing.join(', ')}`);
  return ids.filter((id) => wanted.includes(id));
}

/** What the agent did in one model response: the tools it called, or `reply` when it only wrote. */
export function actionOf(blocks) {
  const tools = [...new Set((blocks ?? []).filter((b) => b.type === 'tool_call').map((b) => b.name))].sort();
  return tools.length ? tools.join('+') : 'reply';
}

/**
 * The group a failure belongs to: what the agent did where the run was lost, and what a run that
 * passed from the same point did instead. Failures blame could not localize have groups of their own.
 */
export function signatureOf(blame) {
  if (!blame || blame.outcome === 'error' || blame.outcome === 'stopped') return 'not blamed';
  if (blame.outcome === 'unrescuable') return 'not rescued';
  if (!blame.contrast) return 'not blamed';
  return `${actionOf(blame.contrast.recorded)} → ${actionOf(blame.contrast.rescued)}`;
}

/** Whether repair has anything to learn from a group: a passing path to contrast the failure with. */
export const repairable = (signature) => signature !== 'not rescued' && signature !== 'not blamed';

/**
 * Failures grouped by signature, and every group, like the passing runs, split between a dev half,
 * which repair sees, and a test half, which nothing sees until the end. Within a group the runs
 * alternate between halves in task order, and the alternation carries across groups, so single-run
 * groups are spread over both halves instead of all landing in one.
 *
 * `failures`: `{ runId, task, signature }`; `passing`: `{ runId, task }`.
 */
export function splitRuns(failures, passing) {
  const byTask = (a, b) => compareTaskIds(a.task, b.task);
  const groups = new Map();
  for (const f of [...failures].sort(byTask)) {
    if (!groups.has(f.signature)) groups.set(f.signature, []);
    groups.get(f.signature).push(f);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out = { clusters: [], dev: { failed: [], passed: [] }, test: { failed: [], passed: [] } };
  let turn = 0;
  for (const [signature, runs] of ordered) {
    const cluster = { signature, repairable: repairable(signature), dev: [], test: [] };
    for (const r of runs) (turn++ % 2 === 0 ? cluster.dev : cluster.test).push(r.runId);
    out.dev.failed.push(...cluster.dev);
    out.test.failed.push(...cluster.test);
    out.clusters.push(cluster);
  }
  [...passing].sort(byTask).forEach((r, i) => (i % 2 === 0 ? out.dev.passed : out.test.passed).push(r.runId));
  return out;
}

/** The warning `shadowlap repair --json` gives when it could not reach its repairer, or null. */
export function unreachableRepairer(report) {
  return (report?.warnings ?? []).find((w) => w.startsWith('the repairer could not be asked')) ?? null;
}

/**
 * The repairer is the one thing the experiment reaches over the network. A repair that could not
 * ask it says nothing about the group, so it is run again after each wait in `waits` (minutes) and
 * the report of the first repair that reached it is returned; null when none did. Nothing else in a
 * repair is lost by trying again: the blame is stored, and no candidate ran.
 */
export async function untilRepairerReached(run, waits, sleep, note) {
  for (let i = 0; ; i++) {
    const report = await run();
    const why = unreachableRepairer(report);
    if (!why) return report;
    if (i >= waits.length) return null;
    note(why, waits[i]);
    await sleep(waits[i]);
  }
}

/** What `shadowlap verify --json` says about the test half: failures fixed, passing runs broken, cost. */
export function scoreEvaluation(verify) {
  const targets = verify.runs.filter((r) => r.role === 'target');
  const good = verify.runs.filter((r) => r.role === 'good');
  return {
    fixed: targets.filter((r) => r.outcome === 'fixed').length,
    failures: targets.length,
    broken: good.filter((r) => r.outcome === 'broken').length,
    passing: good.length,
    unsettled: verify.runs.filter((r) => r.outcome === 'unsettled').length,
    spent: verify.cost?.spent ?? 0,
  };
}

/** An arm's name from its repairer: `anthropic:claude-opus-5-5` → `anthropic-claude-opus-5-5`. */
export function armName(repairer) {
  return repairer.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `1 failure`, `2 failures`. */
export const count = (n, noun, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`;

const usd = (n) => (n === null || n === undefined ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

/** The results as Markdown: the setup, the funnel from runs to repairs, and one row per arm. */
export function resultsMarkdown(state) {
  const c = state.config;
  const runs = Object.values(state.runs ?? {});
  const failed = runs.filter((r) => !r.passed);
  const blames = Object.values(state.blames ?? {});
  const split = state.split;
  const lines = [];
  lines.push(`# tau2-bench ${c.domain}, ${c.split} split: repairing failures with Shadowlap`, '');
  lines.push(`Agent \`${c.agentLlm}\`, simulated user \`${c.userLlm}\`${c.apiBase ? ` (served at ${c.apiBase})` : ''}, seed ${c.seed}, tau2-bench \`${c.tau2Commit.slice(0, 12)}\`. Blame resampled the agent at temperature ${c.rescueTemperature}.`, '');
  lines.push(`- **Recorded**: ${count(runs.length, 'task')}, ${runs.length - failed.length} passed and ${failed.length} failed (${usd(state.cost?.record)}).`);
  const blamed = blames.filter((b) => b.outcome === 'blamed').length;
  lines.push(`- **Blamed**: ${blamed} of ${failed.length} failures localized to a model call of the agent; ${blames.filter((b) => b.outcome === 'unrescuable').length} not rescued from any call (${usd(state.cost?.blame)}).`);
  if (split) {
    const groups = split.clusters.filter((k) => k.repairable);
    lines.push(`- **Split**: ${count(groups.length, 'group')} of failures a fix can learn from. Dev half: ${count(split.dev.failed.length, 'failure')} and ${count(split.dev.passed.length, 'passing run')}; test half: ${count(split.test.failed.length, 'failure')} and ${count(split.test.passed.length, 'passing run')}, which no repair saw.`);
  }
  lines.push('');
  const arms = Object.entries(state.arms ?? {});
  if (arms.length) {
    lines.push('| Arm | Repairer | Fixes kept | Test failures fixed | Test passing runs broken | Cost |', '|---|---|---|---|---|---|');
    for (const [name, arm] of arms) {
      const e = arm.evaluation;
      const kept = arm.repairs ? `${arm.repairs.filter((r) => r.outcome === 'fixed').length} of ${count(arm.repairs.length, 'group')}` : '—';
      const cost = (arm.repairs ?? []).reduce((s, r) => s + (r.spent ?? 0), 0) + (e?.spent ?? 0);
      lines.push(`| ${name} | ${arm.repairer ? `\`${arm.repairer}\`` : 'none (placebo)'} | ${kept} | ${e ? `${e.fixed} of ${e.failures} (${pct(e.fixed, e.failures)})` : 'not evaluated'} | ${e ? `${e.broken} of ${e.passing}` : '—'} | ${usd(cost)} |`);
    }
    lines.push('');
    lines.push('A test failure is fixed when at least ' + `${c.passes} of ${c.attempts} attempts pass under the arm's policy, and a passing run is broken when fewer do. The control arm changes nothing the agent reads, only enough to make every run go live at the same call as under a fix: its row is how much comes from re-running alone.`);
  }
  return lines.join('\n') + '\n';
}
