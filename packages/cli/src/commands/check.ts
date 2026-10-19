import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { Command } from 'commander';
import { hasRecordedCommand, type Store } from '@shadowlap/engine';
import { checkRecordings, packRecording, type CheckedRecording, type CheckReport, type RecordingToCheck } from '../check-recordings.js';
import { CHECK_MARKS, checkWords, specFor } from '../checks.js';
import { loadConfig, loadTests } from '../config.js';
import { expandRecordings, goldenName } from '../goldens.js';
import { checksOfRun } from '../interventions.js';
import { emitJobEvent } from '../job-events.js';
import { readStore, requireRun, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';
import { readExpectJson, selectRuns } from './fix.js';

/** `shadowlap check`: recordings judged by checks from what they recorded, nothing replayed. */

const COLOUR = { passed: p.green, failed: p.red, inconclusive: p.yellow, 'not-applicable': p.dim } as const;

export function register(program: Command): void {
  program
    .command('check')
    .description('Judge recordings by checks from what they recorded, replaying nothing and spending no tokens: try a check on every run before you save it')
    .argument('[recordings...]', 'run ids, label:<name>, or pack directories such as goldens/* (default: every recording in the store)')
    .option('--expect <json|@file>', 'the checks to judge by, an expect object (default: each recording\'s under "tests" in shadowlap.config.json)')
    .option('--json', 'machine-readable output: each recording\'s outcome and checks, and what the outcomes say against the runs\' labels')
    .action((given: string[], flags: { expect?: string; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const cwd = process.cwd();
      const asked = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const tests = loadTests(cwd);
      const config = loadConfig(cwd);
      const store = readStore(opts);
      const packs: Store[] = [];
      try {
        const recordings = chosen(store, given, cwd, packs).map((r): RecordingToCheck => {
          if (asked) return { ...r, spec: asked.spec, source: '--expect' };
          if (r.pack) {
            const spec = specFor(tests, resolve(cwd, r.pack), cwd);
            return { ...r, spec, source: spec ? goldenName(r.pack, cwd) : null };
          }
          const own = checksOfRun(store, r.run, cwd);
          return { ...r, spec: own?.spec ?? null, source: own ? goldenName(own.source, cwd) : null };
        });
        const report = checkRecordings(recordings, { expect: asked?.json ?? null, ...(config.prices ? { prices: config.prices } : {}) });
        process.stdout.write((flags.json ? JSON.stringify(report, null, 2) : formatCheckReport(report, recordings)) + '\n');
        emitJobEvent({ type: 'result', data: report });
        // Nothing judged is no pass; nor is a recording it can't decide.
        process.exitCode = !report.recordings.length || report.counts.failed || report.counts.inconclusive ? 1 : 0;
      } finally {
        for (const s of packs) s.close();
        store.close();
      }
    });
}

/** The recordings named, or every recording in the store; a pack's is read into a store of its own, added to `packs`. */
function chosen(store: Store, given: readonly string[], cwd: string, packs: Store[]): Array<Pick<RecordingToCheck, 'run' | 'store' | 'pack'>> {
  if (!given.length) {
    return store
      .allRuns()
      .filter((r) => r.mode === 'record' && r.status !== 'running')
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => ({ run, store, pack: null }));
  }
  const out: Array<Pick<RecordingToCheck, 'run' | 'store' | 'pack'>> = [];
  for (const arg of given) {
    if (arg.startsWith('label:')) {
      for (const run of selectRuns(store, [arg], 'check')) out.push({ run, store, pack: null });
    } else if (/[*?]/.test(arg) || existsSync(resolve(cwd, arg))) {
      const { dirs, unmatched } = expandRecordings([arg], cwd);
      if (unmatched.length) throw new Error(`no pack matches ${unmatched.join(', ')}`);
      for (const dir of dirs) {
        const pack = packRecording(resolve(cwd, dir));
        packs.push(pack.store);
        out.push({ ...pack, pack: dir });
      }
    } else {
      out.push({ run: requireRun(store, arg), store, pack: null });
    }
  }
  return out;
}

/** The report as the terminal shows it: a line per recording, its checks under one that did not pass, then the totals. */
export function formatCheckReport(report: CheckReport, given: ReadonlyArray<Pick<RecordingToCheck, 'run'>> = []): string {
  const lines: string[] = [];
  // A run with no command of its own (a capture's) is named by its id and labels alone; a path in
  // a command by its file's name, so `/usr/local/bin/node /…/agent.mjs A-1042` reads `node agent.mjs A-1042`.
  const short = (arg: string) => (isAbsolute(arg) ? basename(arg) : arg);
  const commandOf = new Map(given.map((g) => [g.run.runId, hasRecordedCommand(g.run) ? g.run.command.argv.map(short) : []]));
  const name = (r: CheckedRecording) => {
    const argv = commandOf.get(r.runId);
    const what = r.pack ?? (argv?.length ? quoteArgv(argv) : '');
    return [shortId(r.runId), [r.labels.join(', '), what.length > 60 ? `${what.slice(0, 59)}…` : what].filter(Boolean).join(' · ')].filter(Boolean).join('  ');
  };
  for (const r of report.recordings) {
    const head = `${COLOUR[r.outcome](CHECK_MARKS[r.outcome])} ${safe(name(r))}`;
    if (r.outcome === 'passed') {
      const notApplied = r.checks.filter((c) => c.status === 'not-applicable').length;
      lines.push(`${head}: ${r.checks.length - notApplied} check${r.checks.length - notApplied === 1 ? '' : 's'} passed${notApplied ? `, ${notApplied} not applicable` : ''}`);
      continue;
    }
    lines.push(`${head}: ${r.outcome}${r.why[0] && !r.checks.length ? ` · ${safe(r.why[0])}` : ''}`);
    for (const c of r.checks) lines.push(`    ${COLOUR[c.status](CHECK_MARKS[c.status])} ${safe(checkWords(c))}`);
    // What the checks don't say: how the agent exited, what a recording can't settle.
    for (const why of r.why.filter((w) => !r.checks.some((c) => w.startsWith(c.label)))) lines.push(`    ${p.dim(safe(why))}`);
  }
  const n = report.recordings.length;
  const { passed, failed, inconclusive } = report.counts;
  if (n) {
    const parts = [failed ? `${failed} failed` : '', passed ? `${passed} passed` : '', inconclusive ? `${inconclusive} inconclusive` : ''].filter(Boolean).join(', ');
    lines.push(`${n} recording${n === 1 ? '' : 's'} judged from what ${n === 1 ? 'it' : 'they'} recorded, nothing replayed: ${parts}`);
  } else {
    lines.push(report.unchecked.length ? `no checks to judge ${report.unchecked.length === 1 ? 'this recording' : `these ${report.unchecked.length} recordings`} by: give them with --expect, or under "tests" in shadowlap.config.json` : 'no recordings to judge');
  }
  if (n && report.unchecked.length) lines.push(p.dim(`${report.unchecked.length} other recording${report.unchecked.length === 1 ? ' has' : 's have'} no checks: give them with --expect, or under "tests" in shadowlap.config.json`));
  for (const note of report.notes) lines.push(p.yellow(`! ${note}`));
  return lines.join('\n');
}

