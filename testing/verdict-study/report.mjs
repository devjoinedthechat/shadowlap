#!/usr/bin/env node
// Reads the study's results (study.mjs) and scores each verdict against what was measured.
//
//   node testing/verdict-study/report.mjs <results.json>
//
// What a change really does to a run is the pass rate measured live, with the change and without:
//   a good run       is broken when its pass rate dropped 30 points or more, kept when it dropped 5
//                    or less, and unclear between the two: the measurement can't tell a small drop
//                    from none at its number of runs, so no verdict is scored against it;
//   a run to fix     is fixed at 90% or more, not fixed at 70% or less (the gate's two rates), and
//                    unclear between.
// A change should be accepted when every run is kept or fixed, and rejected when one is broken or
// not fixed.
import { readFileSync } from 'node:fs';

const results = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const share = (m) => m.passed / m.runs;
const tally = (m) => `${m.passed}/${m.runs}`;

/** What a run should come out as, from its measured pass rates. */
function expected(role, base, changed) {
  if (role === 'good') {
    const drop = share(base) - share(changed);
    return drop >= 0.3 ? 'broken' : drop <= 0.05 ? 'kept' : 'unclear';
  }
  return share(changed) >= 0.9 ? 'fixed' : share(changed) <= 0.7 ? 'not-fixed' : 'unclear';
}

/** One verify of a change scored: each run against its measurement, and the verdict against them all. */
function scored(entry, verify) {
  const base = results.suites[entry.suite].base;
  const runs = verify.runs.map((run) => {
    const want = expected(run.role, base[run.order], entry.measured[run.order]);
    const right = want === 'unclear' ? null : run.outcome === want;
    return { ...run, want, right, base: base[run.order], changed: entry.measured[run.order] };
  });
  const wants = runs.map((run) => run.want);
  const want = wants.some((w) => w === 'broken' || w === 'not-fixed') ? 'rejected' : wants.includes('unclear') ? 'unclear' : 'accepted';
  let score = 'right';
  if (verify.verdict === 'error') score = 'error';
  else if (want === 'unclear') score = 'unclear';
  else if (verify.verdict === 'incomplete') score = 'incomplete';
  else if (verify.verdict !== want) score = verify.verdict === 'accepted' ? 'false accept' : 'false reject';
  return { want, score, runs };
}

const rows = [];
for (const [id, entry] of Object.entries(results.changes)) {
  rows.push({ id, entry, verify: entry.verify, ...scored(entry, entry.verify) });
  if (entry.verifyLive) rows.push({ id: `${id} --live-tool`, entry, verify: entry.verifyLive, ...scored(entry, entry.verifyLive) });
}

const count = (score) => rows.filter((row) => row.score === score).length;
const runs = rows.flatMap((row) => row.runs);
const out = [];
out.push(`# Verdict study: ${results.mock ? 'a dry run against the stand-in model' : results.model}`);
out.push('');
out.push(`${rows.length} verdicts on ${Object.keys(results.changes).length} changes, each change measured by ${results.truthRuns} live runs an order. ≈$${results.spent.toFixed(2)} spent.`);
out.push('');
out.push('| Verdicts | Count |');
out.push('|---|---:|');
for (const score of ['right', 'false accept', 'false reject', 'incomplete', 'unclear', 'error']) out.push(`| ${score[0].toUpperCase()}${score.slice(1)} | ${count(score)} |`);
out.push('');
const decided = runs.filter((run) => run.right !== null);
out.push(`Run by run: ${decided.filter((run) => run.right).length} of ${decided.length} outcomes match what was measured; ${runs.length - decided.length} more had a measurement too close to score.`);
out.push('');
out.push('| Change | Measured, unchanged → changed | Should be | Verdict |');
out.push('|---|---|---|---|');
for (const row of rows) {
  const measured = row.runs.map((run) => `${run.order} ${tally(run.base)} → ${tally(run.changed)}`).join(', ');
  const verdict = `${row.verify.verdict}, ${row.verify.attempts} attempts${row.score === 'right' ? '' : ` (**${row.score}**)`}`;
  out.push(`| \`${row.id}\` (${row.entry.kind}) | ${measured} | ${row.want} | ${verdict} |`);
}
out.push('');
out.push('## Each run');
out.push('');
out.push('| Change | Run | Should be | Came out |');
out.push('|---|---|---|---|');
for (const row of rows) {
  for (const run of row.runs) {
    const tallies = run.baseline ? `${run.passes}/${run.attempts}, baseline ${run.baseline.passes}/${run.baseline.attempts}` : `${run.passes}/${run.attempts}${run.deterministic ? ', a clean replay' : ''}`;
    out.push(`| \`${row.id}\` | ${run.role} ${run.order} | ${run.want} | ${run.outcome} (${tallies})${run.right === false ? ' **wrong**' : ''} |`);
  }
}
const warned = rows.filter((row) => row.verify.warnings?.length);
if (warned.length) {
  out.push('');
  out.push('## Warnings the reports carried');
  out.push('');
  for (const row of warned) for (const warning of row.verify.warnings) out.push(`- \`${row.id}\`: ${warning}`);
}
process.stdout.write(`${out.join('\n')}\n`);
