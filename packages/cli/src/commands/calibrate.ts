import { addRules, calibrationTarget, commandIsImported, formatDivergence, formatSummary, proposeNormalizers, setupRunOf, type Normalizer, type Proposal, type RunRecord, type Store } from '@shadowlap/engine';
import { configPath, loadConfig, type ShadowlapConfig } from '../config.js';
import { EXIT } from '../exit-codes.js';
import { emitJobEvent } from '../job-events.js';
import { placeholdersFor } from '../placeholder-keys.js';
import { providerIds, testAttempt, type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, openStoreIfExists, recordEvents, requireEnded, requireRun, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';
import { allowedUnrecorded, refuseUnrecorded } from '../unrecorded.js';

/**
 * `shadowlap calibrate`: a recording replayed offline, round after round, until it is clean, with a
 * normalizer proposed for each value the agent makes anew on every run. It picks the recording, runs
 * the rounds (calibrationRounds), and reports the normalizers found, adding them with --write.
 */

/** The flags of `shadowlap calibrate`, as commander gives them. */
export interface CalibrateFlags {
  write?: boolean;
  maxRounds: number;
  yes?: boolean;
  guard: GuardMode;
  allowUnrecorded?: string[];
  json?: boolean;
}

/** How calibration ended: clean, or stopped, with why and what shows it. */
type Outcome = { clean: true; total: number } | { clean: false; why: string; details: string };

/** One round, as --json reports it: where its replay diverged, and the normalizers it proposed. */
interface Round {
  round: number;
  divergence: { callNo: number; kind: string; name: string; type: string } | null;
  proposals: Normalizer[];
}

const RECORD_FIRST = 'Record a run first: shadowlap run -- <command>. Calibrate replays a finished recording made here.';

/** `shadowlap calibrate [run]`. */
export async function calibrate(opts: GlobalOpts, runArg: string | undefined, flags: CalibrateFlags): Promise<void> {
  const say = (text: string) => {
    if (!flags.json) process.stdout.write(text);
  };
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  // Nothing recorded yet: say so without creating a store.
  const store = openStoreIfExists(opts);
  if (!store) throw new Error(RECORD_FIRST);
  try {
    const target = chooseRecording(store, runArg);
    const parent = target.run;
    requireEnded(store, parent, 'calibrate');
    // Each round replays the run: a tool its model called that it never recorded, which writes, would run again for real.
    const allowed = allowedUnrecorded(flags.allowUnrecorded);
    refuseUnrecorded(store, parent, allowed);
    if (commandIsImported(parent) && !flags.yes && !(await confirmImportedCommand(parent, parent.command.argv))) {
      process.exitCode = EXIT.usage;
      return;
    }
    say(`${p.yellow('⑂')} Calibrating ${shortId(parent.runId)} (${safe(quoteArgv(parent.command.argv))}): replaying it offline until it is clean\n\n`);
    const rounds: Round[] = [];
    const { outcome, proposals } = await calibrationRounds(store, parent, { cwd, config, flags, allowed, say, rounds });
    reportCalibration(opts, { parent, source: target.source, cwd, flags, say, rounds, outcome, proposals });
  } finally {
    store.close();
  }
}

/** Without a run named: the run the dashboard's setup recorded for this project, else the newest recording. */
function chooseRecording(store: Store, runArg: string | undefined): NonNullable<ReturnType<typeof calibrationTarget>> | { run: RunRecord; source: 'given' } {
  const target = runArg ? { run: requireRun(store, runArg), source: 'given' as const } : calibrationTarget(store, { setupRunId: setupRunOf(process.cwd()) });
  if (!target) throw new Error(RECORD_FIRST);
  return target;
}

/**
 * The rounds: each replays the recording offline with the normalizers found so far, and proposes
 * one for each value its divergence shows the agent made anew, until a round replays clean, none
 * can be proposed, or --max-rounds is reached.
 */
async function calibrationRounds(store: Store, parent: RunRecord, o: { cwd: string; config: ShadowlapConfig; flags: CalibrateFlags; allowed: ReturnType<typeof allowedUnrecorded>; say: (text: string) => void; rounds: Round[] }): Promise<{ outcome: Outcome; proposals: Proposal[] }> {
  const { cwd, config, flags, allowed, say, rounds } = o;
  const offline = Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  // Offline, the agent gets a placeholder for each key the environment lacks.
  const placeholders = placeholdersFor(store, parent, 'offline');
  const proposals: Proposal[] = [];
  // The blobs this calibration's own replays wrote: the only ones it collects afterwards.
  const written = new Set<string>();
  let outcome: Outcome | null = null;
  for (let round = 1; round <= flags.maxRounds && !outcome; round++) {
    const normalizers = [...config.normalize, ...proposals.map((x) => x.normalizer)];
    const attempt = await testAttempt(store, parent, { cwd, upstreams: offline, extraEnv: placeholders, writes: 'block', guard: flags.guard, normalizers, prices: config.prices, clock: config.clock, http: config.http, spec: null, allowUnrecorded: allowed });
    const s = attempt.ended.summary;
    for (const hash of store.runBlobRefs(attempt.ended.run.runId)) written.add(hash);
    store.deleteRun(attempt.ended.run.runId);
    const label = `  ${p.dim(`round ${round}`)}  `;
    const d = s.divergence;
    rounds.push({ round, divergence: d ? { callNo: d.callNo, kind: d.kind, name: d.name, type: d.type } : null, proposals: [] });
    // A replay that stopped before its recording did sent no request that changed: no normalizer helps.
    if (!d || d.type === 'ended_early') {
      if (s.total === 0 && store.getCalls(parent.runId).length > 0) outcome = { clean: false, why: 'the replay made no calls through Shadowlap, so the agent reached its model some other way (a local model server needs SHADOWLAP_UPSTREAM_OPENAI or the like, as when it was recorded)', details: attempt.output.trim().split('\n').slice(-15).join('\n') };
      else if (attempt.code !== 0) outcome = { clean: false, why: `the agent exited with code ${attempt.code} without diverging`, details: attempt.output.trim().split('\n').slice(-15).join('\n') };
      else if (d) outcome = { clean: false, why: `the agent ended before call ${d.callNo} (${d.kind} ${safe(d.name)}), which it made when recorded: its control flow varies between runs, and no normalizer changes that`, details: formatSummary(s) };
      else {
        say(`${label}${p.green(`clean: ${s.byOrigin.replayed}/${s.total} calls replayed`)}\n`);
        outcome = { clean: true, total: s.total };
      }
      break;
    }
    say(`${label}diverged at call ${d.callNo} (${d.kind} ${safe(d.name)})\n`);
    const step = proposeNormalizers(d, normalizers);
    rounds.at(-1)!.proposals = step.proposals.map((x) => x.normalizer);
    for (const x of step.proposals) say(`           ${p.green('+')} ${safe(x.normalizer.path ?? '(every string)')}: ${x.why}${x.normalizer.pattern ? p.dim(`  ${safe(x.normalizer.pattern)}`) : ''}\n`);
    if (step.proposals.length === 0) {
      const why =
        d.type === 'request_changed'
          ? 'a change Shadowlap cannot tell apart from a real one'
          : d.type === 'new_call' || d.type === 'beyond_recording'
            ? 'the agent made a different call than it recorded, so its control flow varies between runs (a random choice, a set iterated in a different order, a clock read outside the Shadowlap SDK)'
            : `a ${d.type} divergence`;
      outcome = { clean: false, why, details: formatDivergence(d) };
    } else {
      proposals.push(...step.proposals);
    }
  }
  // Only blobs nothing else references, and none while a run is recording (gcBlobs checks).
  store.gcBlobs({ among: written });
  return { outcome: outcome ?? { clean: false, why: `still diverging after ${flags.maxRounds} rounds`, details: '' }, proposals };
}

/** What calibration found: the normalizers, added with --write or each as a command, why it stopped, and its JSON. */
function reportCalibration(opts: GlobalOpts, r: { parent: RunRecord; source: ReturnType<typeof chooseRecording>['source']; cwd: string; flags: CalibrateFlags; say: (text: string) => void; rounds: Round[]; outcome: Outcome; proposals: Proposal[] }): void {
  const { parent, source, cwd, flags, say, rounds, outcome, proposals } = r;
  let added: number[] = [];
  const emitJson = () => {
    // Each normalizer says why it was proposed; `proposedRules` in the dashboard reads the rules back out of it.
    const data = { runId: parent.runId, source, clean: outcome.clean, rounds, normalizers: proposals.map((x) => ({ ...x.normalizer, why: x.why })), written: added.length > 0, added, stopped: outcome.clean ? null : { why: outcome.why, details: outcome.details } };
    emitJobEvent({ type: 'result', data });
    if (flags.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  };
  say('\n');
  if (outcome.clean && proposals.length === 0) {
    say(`${p.green('✓')} This recording replays clean with the current rules. Nothing to add.\n`);
    emitJson();
    return;
  }
  if (proposals.length) {
    const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
    const commands = proposals.map(({ normalizer: n }) => `shadowlap normalize add${n.kind ? ` --kind ${n.kind}` : ''}${n.name ? ` --name ${quote(n.name)}` : ''}${n.path !== undefined ? ` --path ${quote(n.path)}` : ''}${n.pattern ? ` --pattern ${quote(n.pattern)}` : ''} --replace ${quote(n.replace)}`);
    const lead = outcome.clean ? `${p.green('✓')} ${proposals.length} normalizer${proposals.length === 1 ? '' : 's'} make${proposals.length === 1 ? 's' : ''} this recording replay clean.` : `${p.yellow('!')} ${proposals.length} normalizer${proposals.length === 1 ? '' : 's'} found before calibration stopped.`;
    if (flags.write) {
      const saved = addRules(cwd, 'normalize', proposals.map((x) => x.normalizer));
      added = saved.rules.filter((rule) => rule.added).map((rule) => rule.n);
      const had = saved.rules.filter((rule) => !rule.added).map((rule) => `#${rule.n}`);
      recordEvents(opts, saved.events.map((e) => ({ ...e, runId: parent.runId, data: { ...e.data, via: 'calibrate' } })));
      const where = added.length ? `Added to ${configPath(cwd)} as normalizer${added.length === 1 ? '' : 's'} ${added.map((n) => `#${n}`).join(', ')}.` : `Nothing added to ${configPath(cwd)}.`;
      say(`${lead} ${where}${had.length ? ` Already there: ${had.join(', ')}.` : ''}\n`);
    } else {
      say(`${lead} Add them with --write, or one by one:\n${commands.map((c) => `    ${safe(c)}`).join('\n')}\n`);
    }
  }
  if (!outcome.clean) {
    say(`\n${p.red('✗')} Stopped: ${outcome.why}.\n${outcome.details ? outcome.details.split('\n').map((l) => `    ${l}`).join('\n') + '\n' : ''}`);
    process.exitCode = EXIT.failed;
  }
  emitJson();
}
