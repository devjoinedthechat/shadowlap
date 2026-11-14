import {
  ACTIONS,
  GOLDEN_JOB_WORDS,
  bisectEstimate,
  blameEstimate,
  callRuleLabel,
  checkStatus,
  confirmWords,
  GATE_REPEAT,
  GATE_TOO_LITTLE,
  goldenLiveParts,
  goldenRerunEstimate,
  goldenWords,
  hasRecordedCommand,
  injectionAgainEstimate,
  isObject,
  keptCaptureVerdict,
  noEstimate,
  normalizeAddArgs,
  parseTests,
  pathSetByCode,
  proofCall,
  proofOf,
  shortRunId as short,
  testsEstimate,
  updateEstimate,
  type CleanReport,
  type Estimate,
  type FixStatus,
  type PlantReport,
  type Price,
  type RunRecord,
  type Store,
  type StoreOf,
  type StoredFix,
  type StoredInjectionResult,
  type TestResult,
  type ToolTrust,
  presetProof,
} from '@shadowlap/engine';
import { actionsFor, lookupRun, noSuchRun, type ActionItem } from './api.js';
import { chaosMatrices, type ChaosMatrix } from './chaos.js';
import { GOLDEN_HISTORY } from './bisect-start.js';
import { gatePrice, injectionPrice } from './injection-plan.js';
import { HEX } from './commits-here.js';
import { commandLine } from './fix-shared.js';
import { withFixByCheck } from './fix-by-check.js';
import { fixForRun, type FixForRun, fixRef, type FixRef } from './fix-for-run.js';
import { injectionLine } from './injection.js';
import { againCommand, testedAs } from './injection-view.js';
import { links } from './links.js';
import { gitAsync } from './patch-in-tree.js';
import { blameOffer, crashed, goldenFolder, keepable, packableIn, testOffer, type BlameOffer, type TestOffer } from './run-offers.js';
import { aboutsWithin } from './run-about.js';
import { runCalls } from './run-calls.js';
import { loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import { QUICK_FROM } from './run-page.js';
import { estimateOf, pricingOf, type Priced, type Pricing } from './pricing.js';
import { answer, failed, type ReadTable } from './read-registry.js';
import { runJudged, type OutcomeWork, type RunJudged } from './run-outcome.js';
import { callTotals, priced as pricedTotals } from './run-stats.js';
import { fixedBy } from './runs-filter.js';
import { runStates, type RunRow, type RunState } from './runs-list.js';
import { checksStep, checksStepWords } from './check-steps.js';
import { liveReasons, sessionLiveGoldens, type LiveReason } from './tests-live.js';
import { bisectChoices, gateResultView, runTestsJob, underChecks, unjudgedOffline, unreadable, verdictOfResult, type BisectChoices, type GoldenSource } from './tests.js';
import { bisectAnswers, standingAnswer, type BisectAnswer, type FoundCommit } from './tests-bisect.js';

/**
 * The one next step of a run (A12): what its page's lime button leads with, worked out here from how
 * the run stands, so the run page, the lists, Needs a look and the palette say the same. The first
 * that applies:
 *
 * - still recording: Replay, off until it ends;
 * - a failed test replay whose golden passed when it ran again, whatever way it failed: Open passing
 *   run, as Runs' Status says `fixed by <run>`;
 * - its golden's last test replay, by the golden's checks (check-steps.ts): Run tests once a check it
 *   failed or couldn't decide left the config, Edit check… for a check added since that the golden's
 *   own recording fails; Tests leads a golden with the same, before Run more attempts;
 * - a test that diverged: on a value that changes every run, Add normalizer and re-run (or Re-run test
 *   once the rule is in the config); on what a patch or a config change changed, Update golden; on
 *   anything else, Find breaking commit…, unless it can't start from this replay (one cut short, or an
 *   inconclusive session, which say nothing of its golden), and then the rules below decide;
 * - a test whose judge check couldn't be judged offline: Update golden;
 * - an injection attempt that obeyed, while no golden is packed or unpacked from the recording it
 *   tested: Pack with injection gate…;
 * - any other attempt: Compare with parent, failed or not, since it is one sample of many;
 * - a test replay whose agent exited (a crash): Find breaking commit, Run blame plain beside it; once
 *   the commit is named, Revert, Run blame beside it, unless the golden was tested since the answer
 *   with changes on top of a commit, when the rules below decide;
 * - a recording's newest injection test: Open proof where it failed, Run injection test… where it
 *   stopped early, Re-run injection test (Re-run test for a golden's gate) where it showed too
 *   little to say; a read proven to have caused a write, in a recording no golden is made from yet:
 *   Pack with injection gate…;
 * - error-path presets that failed: Open proof (presets left inconclusive change nothing);
 * - failed, and a fix covers it: Open fix;
 * - a capture its import judged failed: Open fix where a fix holds the same failure, else Run blame;
 * - failed, and nobody blamed it: Run blame, a fork too;
 * - a replay left on a value made anew on every run: Add normalizer;
 * - a fork: Compare with parent;
 * - a recording that didn't fail, no golden made from it yet: Pack as golden…;
 * - anything else: Replay; on a clean or a test replay Replay recording, which replays the run it came
 *   from; on a capture, or a replay of one, what starts your agent is asked first.
 *
 * A step that runs a job says what it runs and, on a run's page, what it bills: its estimate, from the
 * engine, read from the recording it replays (`pricedNextStep`). A list reads no run's calls for its
 * rows, each of which carries its step's key, words and link (`stepRow`): what it reads besides each
 * row's own records is each golden's results, once for all the rows that fail it (`StepReads`).
 */

/** What the server reads of the project for a run's next step, as plain data in a job: the goldens on disk, and the config as written. */
export interface NextStepWork {
  goldens: GoldenSource[];
  /** shadowlap.config.json's `tests` and `normalize`, as written. */
  tests: unknown;
  normalize: unknown;
  /** The project's folder: the tests entries' and the goldens' folders are relative to it. Null with no project, which packs nothing. */
  dir: string | null;
  /** What makes a read untrusted (the config's `tools`), which an injection test's price reads. */
  tools?: ToolTrust;
  prices?: Record<string, Price>;
}

/**
 * What a list's steps read of the project, as one key its kept rows are tagged by: the goldens (each
 * one's mode, gate, checks, injection test and judges), the config's tests and normalize, and its
 * folder. Not the prices or the tools: only a step's estimate reads them, asked for on its own.
 */
export const listedWorkKey = (work: NextStepWork | null): string => (work ? JSON.stringify([work.goldens, work.tests ?? null, work.normalize ?? null, work.dir]) : '');

export type NextStepKey = 'replay' | 'run-tests' | 'edit-check' | 'passing' | 'normalizer' | 'rule' | 'rerun-test' | 'update-golden' | 'gate-again' | 'more-attempts' | 'bisect' | 'revert' | 'pack-gate' | 'pack' | 'compare' | 'injection-proof' | 'injection-test' | 'injection-again' | 'preset-proof' | 'fix' | 'blame';

/** A step as a list's row carries it: which one, its words, where it opens when it is a link, why it can't start when it can't, and what it says it does: none of which reads a call. */
export interface NextStepRow {
  key: NextStepKey;
  label: string;
  href?: string;
  off?: string;
  /** The hover's title, where it isn't the label: `Against 01K5CQ3W6H`, `Opens 01K5CQ4R1T`. */
  title?: string;
  /** The command it runs, as a person would type it. */
  command?: string;
  /** A capture's Run blame, which first asks for your command, as only its page can. */
  capture?: true;
  /** Replay's run: the recording a clean or a test replay came from, else the run itself. */
  runId?: string;
  /** Pack as golden…'s folder, the goldens' named for the run: Tests with no golden yet offers it. */
  folder?: string;
}

/** A step on a run's page: the row's, and the rest of what its hover says, what it bills. */
interface StepWords extends NextStepRow {
  /** The hover's sentence under its title. */
  sub?: string;
  /** What it bills, where it runs something live; absent for a step that bills nothing. */
  estimate?: Estimate;
  /**
   * This answer leaves part of it out, as it would have read a long run's calls: what it bills, or a
   * verdict that may change what leads. `GET /api/runs/:id/next` answers with it whole.
   */
  later?: true;
}

/** The fields each kind of step adds for what it does. */
export type NextStep = StepWords &
  (
    | { key: 'replay'; runId: string; action?: ActionItem }
    | { key: 'passing' | 'injection-proof' | 'preset-proof'; runId: string }
    | { key: 'compare'; parent: string }
    | { key: 'fix'; fixId: string; status: FixStatus; /** The fix's check, as its page states it. */ check: string; /** How it stands, as Fixes says it (fix-for-run.ts `FixRef`), where the step was read from the run's fix. */ standing?: Pick<FixRef, 'rung' | 'pr' | 'broken' | 'change'> }
    | { key: 'blame'; offer: BlameOffer }
    | { key: 'normalizer' | 'update-golden'; golden: string; test: TestOffer | null }
    | { key: 'rerun-test' | 'gate-again'; golden: string }
    | { key: 'more-attempts'; golden: string }
    | { key: 'run-tests'; golden: string; gone: string[] }
    | { key: 'edit-check'; golden: string; check: string }
    | { key: 'bisect'; golden: string; starts: boolean; blame: BlameBeside | null }
    /** `merge`: the commit is a merge, reverted against its first parent (`-m 1`); `live`: why its golden's test runs live (`liveReasons`), as the question it asks through liveAsk lists it; none where it replays offline. */
    | { key: 'revert'; golden: string; rev: string; merge: boolean; live: LiveReason[]; blame: BlameBeside | null }
    | { key: 'rule' }
    | { key: 'injection-test'; runId: string }
    | { key: 'injection-again'; runId: string; job: InjectionAgain }
    | { key: 'pack'; runId: string; folder: string }
    | { key: 'pack-gate'; runId: string; folder: string; gate: GateEntry }
  );

/** Run blame, plain beside a crash's Find breaking commit or Revert: the check it would use, and what its hover says, runs and bills. */
export interface BlameBeside {
  offer: BlameOffer;
  sub: string;
  command: string;
  estimate?: Estimate;
}

/** The `injection` a golden's entry under `tests` gives it, for a gate that fails while the agent obeys: what `tests` reads. */
export interface GateEntry {
  obeyed: number;
  repeat: number;
}

/** What the `injection` job takes to run a test again as the last one ran. */
export interface InjectionAgain {
  repeat: number;
  templates: string[];
  baselines: number;
  liveReads: boolean;
}


/** What finding a next step reads once for all the runs it is asked about: each read when it is first needed. */
export interface StepReads {
  index: RunIndex;
  state: (runId: string) => RunState | null;
  injection: (runId: string) => StoredInjectionResult[];
  presets: (runId: string) => ChaosMatrix | null;
  fixes: () => StoredFix[];
  /** A golden's results, newest first. */
  results: (golden: string) => readonly TestResult[];
  /** Those that passed under the checks it has now: where Find breaking commit starts from. */
  passes: (golden: GoldenSource) => readonly TestResult[];
  /** What Find breaking commit said of the failure it shows now. */
  standing: (golden: string) => BisectAnswer | null;
  /** A failed test replay no fix holds joins one by its check (fix-by-check.ts): a run's page and Tests' steps, which read every open fix for it. */
  byCheck?: boolean;
}

function once<T>(read: () => T): () => T {
  let known: { value: T } | null = null;
  return () => (known ??= { value: read() }).value;
}

function perKey<T>(read: (key: string) => T): (key: string) => T {
  const known = new Map<string, T>();
  return (key) => {
    if (!known.has(key)) known.set(key, read(key));
    return known.get(key)!;
  };
}

export function stepReads(store: Store, index: RunIndex = loadRunIndex(store), o: { byCheck?: boolean } = {}): StepReads {
  const tested = once(() => new Set(store.query('SELECT DISTINCT run_id AS id FROM injection_results').map((r) => String(r.id))));
  const matrices = once(() => {
    const byRun = new Map<string, ChaosMatrix>();
    // Newest first: a run's own, the newest where goldens that hold one recording each have one.
    for (const m of chaosMatrices(store)) if (!byRun.has(m.runId)) byRun.set(m.runId, m);
    return byRun;
  });
  const answers = once(() => bisectAnswers(store));
  const results = perKey((golden) => store.listTestResults({ golden, limit: GOLDEN_HISTORY }));
  const passing = new Map<string, readonly TestResult[]>();
  const standing = perKey((golden) => {
    const past = results(golden);
    return past[0] ? standingAnswer(answers().get(golden), past, past[0]) : null;
  });
  return {
    index,
    state: runStates(store),
    injection: (runId) => (tested().has(runId) ? store.listInjectionResults({ runId, limit: 50 }) : []),
    presets: (runId) => matrices().get(runId) ?? null,
    fixes: once(() => store.listFixes()),
    results,
    passes: (g) => {
      const known = passing.get(g.path) ?? results(g.path).filter((r) => r.ok && underChecks(r, g.checks));
      passing.set(g.path, known);
      return known;
    },
    standing,
    byCheck: !!o.byCheck,
  };
}

/** A step as a rule decides it, what the Run blame beside it bills, and the run whose about line its card's sentence is, for a run's page. */
type Decided = NextStep & Priced & { beside?: Priced; about?: string };

/** What each rule below reads of a run. */
interface Facts {
  store: Store;
  index: RunIndex;
  row: IndexedRun;
  record: RunRecord;
  /** Its outcome by checks, when it is known: a capture's kept from its import among them. */
  judged: RunJudged | null | undefined;
  work: NextStepWork | null;
  reads: StepReads;
  /** How it takes part in Fixes: its next step reads that several times. */
  fix: () => FixForRun | null;
  /** The test it replays, if any. */
  tested: () => TestedGolden | null;
  /** Its banner's offer, as a test that diverged. */
  offer: () => TestOffer | null;
  /** Where Find breaking commit may start from it. */
  choices: () => BisectChoices | null;
}

// ---- the steps ----

/** What a command takes from you where a run has none of its own, left for you to fill in: the one word of a command line that isn't quoted. */
const YOUR_COMMAND = '-- <your command>';

/**
 * Replay: a clean or a test replay is the recording it came from served again, so it replays that
 * recording, and says so. One with no command of its own, a capture, takes yours: the action that asks
 * for it comes with the step, for the page that shows the replay of it.
 */
export function replayStep(store: StoreOf<'recording'>, row: Pick<IndexedRun, 'runId' | 'kind' | 'parentRunId'>, record: RunRecord, index: RunIndex): NextStep {
  const parent = (row.kind === 'clean' || row.kind === 'test') && row.parentRunId ? index.byId.get(row.parentRunId) : undefined;
  const target = parent?.runId ?? row.runId;
  const commandless = !hasRecordedCommand(parent ? { command: { argv: parent.argv } } : record);
  const command = `${commandLine(['replay', short(target)])}${commandless ? ` ${YOUR_COMMAND}` : ''}`;
  if (!parent) return { key: 'replay', label: commandless ? ACTIONS.replayWithCommand.label : ACTIONS.replay.label, runId: target, command };
  const recording = commandless ? store.getRun(target) : null;
  const action = recording ? actionsFor(recording, undefined).find((a) => a.key === 'r') : undefined;
  return { key: 'replay', label: ACTIONS.replayRecording.label, runId: target, title: `Replays ${short(target)}, the recording this replay came from`, command, ...(action ? { action } : {}) };
}

function compareStep(parent: string, runId: string): Decided {
  return { key: 'compare', label: ACTIONS.compareWithParent.label, parent, href: links.compare(parent, runId), title: `Against ${short(parent)}`, about: parent, command: commandLine(['diff', short(parent), short(runId)]) };
}

function fixStep(fix: { fixId: string; title: string; status: FixStatus } & Partial<Pick<FixRef, 'rung' | 'pr' | 'broken' | 'change'>>, check: string, href = links.fixes(fix.fixId)): Decided {
  const standing = fix.rung ? { standing: { rung: fix.rung, pr: fix.pr ?? null, broken: fix.broken ?? null, change: fix.change ?? null } } : {};
  return { key: 'fix', label: ACTIONS.openFix.label, fixId: fix.fixId, status: fix.status, check, href, title: `“${fix.title}”`, ...standing };
}

function blameCommand(runId: string, offer: BlameOffer, capture: boolean): string {
  const expect = offer.from === 'ask' ? ['--expect', '<what it must do>'] : offer.expect !== null && offer.expect !== undefined ? ['--expect', JSON.stringify(offer.expect)] : [];
  return `${commandLine(['blame', short(runId), ...expect])}${capture ? ` ${YOUR_COMMAND}` : ''}`;
}

/** What a blame bills: at most its ceiling, from the run's model calls. */
export const blamePrice = (runId: string): Priced => ({ reads: [runId], price: (p) => blameEstimate(p.calls(runId), p.prices ? { prices: p.prices } : {}) });

function blameStep(runId: string, offer: BlameOffer, capture = false): Decided {
  return { key: 'blame', label: ACTIONS.runBlame.label, offer, ...(capture ? { capture: true as const } : {}), command: blameCommand(runId, offer, capture), ...blamePrice(runId) };
}

const packable = (f: Facts, run: RunRecord): boolean => packableIn(f.work?.dir, f.work?.goldens ?? [], run);

function packGateStep(f: Facts, runId: string, parent: boolean): Decided {
  const folder = goldenFolder(runId);
  return {
    key: 'pack-gate',
    label: ACTIONS.packWithGate.label,
    runId,
    folder,
    gate: { obeyed: 0, repeat: GATE_REPEAT },
    // On an attempt's page the run it packs is another: its card names it.
    ...(parent ? { title: `Pack ${short(runId)} with injection gate` } : {}),
    sub: parent ? 'A golden with an injection gate: it fails while the agent obeys a planted instruction' : 'A golden with an injection gate: it fails while the agent obeys a planted instruction, and passes once it is fixed',
    command: commandLine(['pack', short(runId), folder]),
    reads: [runId],
    price: gatePrice(runId, f.work?.tools),
  };
}

// ---- a test replay ----

/** A test replay of its own whose golden is on disk and can be read, and its golden's result in its session: what its steps run on. */
interface TestedGolden {
  golden: string;
  source: GoldenSource;
  result: TestResult | null;
}

function testedGolden(f: Pick<Facts, 'row' | 'work' | 'store'>): TestedGolden | null {
  const test = f.row.meta.test;
  // The index reads the record field by field, and a golden or a session that isn't text as empty: a run can come from someone else's pack.
  if (f.row.kind !== 'test' || f.row.attemptKind || !test?.golden || !test.session) return null;
  const source = f.work?.goldens.find((g) => g.path === test.golden);
  if (!source || unreadable(source)) return null;
  return { golden: test.golden, source, result: f.store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0] ?? null };
}

const { remade: REMADE, judgeOnce: JUDGE_ONCE } = GOLDEN_JOB_WORDS;

/** A golden's newest finished plant, as its report says it: what its injection gate spent the last time it ran; null before one has. */
export function newestGate(store: Store, golden: string): PlantReport | null {
  const data = store.listInjectionResults({ golden, limit: 50 }).find((x) => x.mode === 'plant' && x.endedAt !== null)?.data as Partial<PlantReport> | undefined;
  return data?.cost ? (data as PlantReport) : null;
}

/** Run test on one golden, as its session runs it (`result` its newest test): Free only where nothing of it runs live, as tests-live.ts `liveReasons` says. */
export function goldenRerunPrice(store: Store, source: GoldenSource, result: TestResult | null): Estimate {
  const why = liveReasons(source).map((w) => w.kind);
  const injection = why.includes('injection');
  return goldenRerunEstimate({ live: why.length > 0, fork: why.includes('fork'), injection }, result, injection ? newestGate(store, source.path) : null);
}

/** What re-recording a golden bills: about what its recording cost. */
export const updatePrice = (source: GoldenSource): Priced => ({ reads: source.runId ? [source.runId] : [], price: (p) => updateEstimate([{ calls: source.runId ? p.calls(source.runId) : [] }]) });

/** Update golden: re-recorded live. */
function updateStep(f: Facts, golden: string, source: GoldenSource): Decided {
  return { key: 'update-golden', label: ACTIONS.updateGolden.label, golden, test: f.offer(), sub: REMADE, command: commandLine(['test', golden, '--update']), ...updatePrice(source) };
}

/** What the values made anew on every run lead a diverged test to: the rule, then the test again or an update; null for an id that may be a real change, which only the person can tell, so neither leads. */
function valueStep(f: Facts, t: TestedGolden, offer: TestOffer): Decided | null {
  const { golden, source, result } = t;
  const all = offer.values.coversAll;
  const test = () => goldenRerunPrice(f.store, source, result);
  if (offer.normalized) return all ? { key: 'rerun-test', label: ACTIONS.rerunTest.label, golden, command: commandLine(['test', golden]), sub: GOLDEN_JOB_WORDS.ruleIn, price: test } : updateStep(f, golden, source);
  if (offer.maybeReal) return null;
  return {
    key: 'normalizer',
    label: all ? ACTIONS.addNormalizerAndRerun.label : ACTIONS.addNormalizerAndUpdate.label,
    golden,
    test: offer,
    command: (offer.normalizeAndTest ?? []).map((a) => commandLine(a)).join(' && '),
    sub: all ? GOLDEN_JOB_WORDS.masksThenReplays : GOLDEN_JOB_WORDS.masksThenRemakes,
    ...(all ? { price: test } : updatePrice(source)),
  };
}

/** What a diverged test leads with: the rule for a value made anew on every run, an update for a change that was meant, else the commit that changed it; null where Find breaking commit can't start from it, which says nothing of its golden: the rules after decide. */
function divergedStep(f: Facts, t: TestedGolden): Decided | null {
  const { golden, source, result } = t;
  const offer = f.offer();
  const rule = offer?.values.values.length ? valueStep(f, t, offer) : null;
  if (rule) return rule;
  const d = f.record.divergence;
  if (d?.type === 'request_changed' && (d.diff ?? []).some((e) => pathSetByCode(e.path, d.name))) return updateStep(f, golden, source);
  const c = f.choices();
  if (c?.unavailable) return null;
  return { key: 'bisect', label: ACTIONS.findBreakingCommit.label, golden, starts: false, blame: null, command: bisectCommand(golden, null, commitName(c?.bad)), sub: 'Asks for a commit where it still worked, then replays it at the commits between', ...bisectPrice(f, source, result, c?.good ?? null, c?.bad ?? null) };
}

/**
 * A failed test replay a later replay of its golden passed, whatever way it failed: the run that
 * passed, which Runs' Status names (`fixed by <run>`), by the rule both read (runs-filter.ts
 * `fixedBy`) on the run as the index has it.
 */
function passingStep(f: Facts): Decided | null {
  const run = f.index.byId.get(f.row.runId);
  const passing = run ? fixedBy(f.store, run, f.reads.results) : null;
  return passing ? { key: 'passing', label: ACTIONS.openPassingRun.label, runId: passing, href: links.run(passing), title: `Opens ${short(passing)}`, about: passing } : null;
}

/**
 * Run tests: what each golden it runs live spent the last time it ran, as the mock adds them up (a
 * session that re-ran one golden says nothing of the others): the newest test of each that forks,
 * and each injection gate's newest; none until each has run once, and Free when every golden replays
 * offline. Tests' header prices it (estimates.ts), and so does a stale golden's step: it reads no call.
 */
export function runTestsEstimate(store: Store, goldens: readonly GoldenSource[], folder?: string): Estimate {
  const live = sessionLiveGoldens(goldens, runTestsJob(goldens, {}, folder ? { folder } : {}));
  const by = (kind: LiveReason['kind']) => live.filter((g) => g.why.some((w) => w.kind === kind));
  const results = by('fork').map((g) => store.listTestResults({ golden: g.path, limit: 1 })[0] ?? null);
  const gates = by('injection').map((g) => newestGate(store, g.path)?.cost ?? null);
  return testsEstimate(live.length, { results, injection: gates });
}

/** What the last test replay of a golden leads with by its checks: Run tests once they changed since, Edit check for one added since that its recording fails (check-steps.ts). */
function checksLead(f: Facts): Decided | null {
  const t = f.tested();
  // Only a result that didn't pass has a step by its checks: one that passed reads no history.
  const results = t?.result && !t.result.ok ? f.reads.results(t.golden) : [];
  const step = t && results[0]?.runId === f.row.runId ? checksStep(t.source, results) : null;
  if (!step) return null;
  const goldens = f.work?.goldens ?? [];
  return { ...checksStepWords(step, goldens, true), ...(step.key === 'run-tests' ? { reads: [], price: () => runTestsEstimate(f.store, goldens) } : {}) };
}

/** What a test replay of its own leads with while its golden is on disk: by how it diverged, or its judge's verdict. */
function testStep(f: Facts): Decided | null {
  const t = f.tested();
  if (!t) return null;
  const { row } = f;
  const lead = row.failed && row.outcome.kind === 'diverged' ? divergedStep(f, t) : null;
  if (lead) return lead;
  const only = judgeOnly(t.source, t.result);
  return only ? { ...updateStep(f, t.golden, t.source), sub: JUDGE_ONCE, reads: [], price: () => updateEstimate([{ calls: [], judge: only.judge }]) } : null;
}

/**
 * Whether a replay golden's result `r` lacks only a verdict its pack doesn't keep, so Update golden
 * asks the judge once rather than re-recording: with what one call of its judge cost where the result
 * kept it (else null); null for a result that lacks no verdict.
 */
export function judgeOnly(source: Pick<GoldenSource, 'mode'>, r: TestResult | null): { judge: number | null } | null {
  if (!r || verdictOfResult(r) !== 'inconclusive' || source.mode !== 'replay' || !unjudgedOffline(r)) return null;
  return { judge: (r.data?.checks ?? []).find((c) => checkStatus(c) === 'inconclusive' && c.judge)?.judge?.cost ?? null };
}

/**
 * A revision as a commit's hex name, or null for anything else: a revision comes from a run, which
 * may have come from anyone, so nothing else is handed to git, or shown as a command to paste.
 */
const commitName = (rev: string | null | undefined): string | null => (rev && HEX.test(rev) ? rev : null);

const bisectCommand = (golden: string, good: string | null, bad: string | null): string => `${commandLine(['bisect', golden])} --good ${good ?? '<commit>'}${bad ? ` --bad ${bad}` : ''}`;

/**
 * How many commits Find breaking commit searches from `good` up to `to`, as git counts them in the
 * project's folder `dir`; else, as an estimate, why that can't be said: no commit to start from yet,
 * an end that is no commit, or git that can't count them.
 */
export async function searchedCommits(dir: string | null | undefined, good: string | null, to: string | null): Promise<number | Estimate> {
  if (!good || !dir) return noEstimate('bisect', 'no estimate until it has a commit to start from');
  if (!to) return noEstimate('bisect', 'no estimate: the revision it would search up to is no commit');
  const count = await gitAsync(dir, ['rev-list', '--count', `${good}..${to}`]);
  const commits = count.code === 0 ? Number(count.stdout.trim()) : NaN;
  return Number.isInteger(commits) ? commits : noEstimate('bisect', 'git could not say how many commits it would search');
}

/** What each of a gate's attempts spent live, at `prices`: those the run index has. */
export function attemptSpends(store: Store, index: RunIndex, attempts: readonly string[], prices: Record<string, Price> | undefined): number[] {
  const runs = attempts.map((id) => index.byId.get(id)).filter((r): r is IndexedRun => !!r);
  return [...callTotals(store, index, runs).values()].map((t) => pricedTotals(t, prices).spent);
}

/**
 * What Find breaking commit bills on golden `source`, `commits` apart: nothing on one that replays,
 * which it replays offline at each commit; on one marked fork, its gate live at every commit it may
 * test, each attempt as dear as the costliest of `result`'s session's (its newest).
 */
export function goldenBisectEstimate(store: Store, index: RunIndex, source: GoldenSource, result: TestResult | null, commits: number, prices: Record<string, Price> | undefined): Estimate {
  const gate = source.gate && 'max' in source.gate ? source.gate.max : null;
  const spends = attemptSpends(store, index, result?.data?.attempts?.runs ?? [], prices);
  return bisectEstimate(commits, { fork: source.mode === 'fork', attempts: gate ?? source.repeat, each: spends.length ? Math.max(...spends) : null, commit: result?.data?.spent ?? null, count: gate === null });
}

/**
 * What Find breaking commit bills as a next step: on a golden marked fork, its estimate, once the
 * search has a commit to start from, and only of two commits; nothing shown on one that replays.
 */
function bisectPrice(f: Facts, source: GoldenSource, result: TestResult | null, good: string | null, bad: string | null): Priced {
  if (source.mode !== 'fork') return {};
  const price = async (p: Pricing): Promise<Estimate> => {
    const commits = await searchedCommits(f.work?.dir, commitName(good), bad === null ? 'HEAD' : commitName(bad));
    return typeof commits === 'number' ? goldenBisectEstimate(f.store, f.index, source, result, commits, p.prices) : commits;
  };
  return { price, reads: result?.data?.attempts?.runs ?? [] };
}

/** What Revert runs, as a person would type it: the commit undone, uncommitted (a merge against its first parent), then its golden's test. */
export const revertCommand = (rev: string, merge: boolean, golden: string): string => `git revert --no-commit ${merge ? '-m 1 ' : ''}${rev} && ${commandLine(['test', golden])}`;

/**
 * A crash: its commit leads, found offline and free from the newest commit its golden passed at, with
 * Run blame beside it; once the commit is named, Revert (revertStep).
 */
function crashStep(f: Facts): Decided | null {
  const t = f.tested();
  const { row, store } = f;
  if (!t || !row.failed || !crashed(row, t.result)) return null;
  const blame = f.fix()?.fix ? null : blameOffer(store, f.record, f.work?.tests, f.fix);
  const beside: Pick<Decided & { key: 'bisect' }, 'blame' | 'beside'> = blame ? { blame: { offer: blame, sub: 'Whether an answer of the model’s lost the run', command: blameCommand(row.runId, blame, false) }, beside: blamePrice(row.runId) } : { blame: null };
  const found = f.reads.standing(t.golden)?.found;
  if (found) return revertStep(f, t, found, beside);
  const c = f.choices();
  if (!c || c.unavailable) return null;
  const good = commitName(c.good);
  const starts = !!good && !c.live;
  return {
    key: 'bisect',
    label: starts ? confirmWords(ACTIONS.findBreakingCommit.label) : ACTIONS.findBreakingCommit.label,
    golden: t.golden,
    starts,
    ...beside,
    command: bisectCommand(t.golden, good, commitName(c.bad)),
    sub: starts ? GOLDEN_JOB_WORDS.replaysSince(good) : 'Asks for a commit where it still worked, then replays it at the commits between',
    ...bisectPrice(f, t.source, t.result, c.good, c.bad),
  };
}

/**
 * Revert, once Find breaking commit named a crash's commit: the commit undone in the working tree,
 * uncommitted, then its golden tested, priced as Re-run test, with Run blame plain beside it. Its
 * sentence names the golden and says how its test runs, in its estimate's parts where it runs live,
 * since its card shows only the amount. None where the answer names no commit, or where the golden's
 * newest result, newer than the answer, was tested with changes on top of a commit (reverted already,
 * or other work in the tree): fix or blame then decide, as they did before the search.
 */
function revertStep(f: Facts, t: TestedGolden, found: FoundCommit, beside: Pick<Decided & { key: 'revert' }, 'blame' | 'beside'>): Decided | null {
  const rev = commitName(found.rev);
  const newest = f.reads.results(t.golden)[0];
  if (!rev || (newest && newest.at > found.at && newest.revision?.endsWith('+dirty'))) return null;
  const merge = found.change?.merge === true;
  const live = liveReasons(t.source);
  const parts = goldenLiveParts({ fork: live.some((w) => w.kind === 'fork'), injection: live.some((w) => w.kind === 'injection') });
  const then = `then ${goldenWords(t.golden)} ${parts.length ? `tested: ${parts.join('; ')}` : 'replayed offline'}`;
  return {
    key: 'revert',
    label: ACTIONS.revert.label,
    golden: t.golden,
    rev,
    merge,
    live,
    ...beside,
    title: `${ACTIONS.revert.label} ${rev}`,
    sub: found.subject ? `${found.subject}: undone in your working tree, ${then}` : `Undone in your working tree, ${then}`,
    command: revertCommand(rev, merge, t.golden),
    price: () => goldenRerunPrice(f.store, t.source, t.result),
  };
}

// ---- injection tests and presets ----

const asPlant = (r: StoredInjectionResult) => r.data as unknown as Partial<PlantReport>;
const asClean = (r: StoredInjectionResult) => r.data as unknown as Partial<CleanReport>;

/** Whether the newest answer for any read and write of a run says the read's content caused the write. */
function causedAWrite(results: readonly StoredInjectionResult[]): boolean {
  const seen = new Set<string>();
  for (const r of results) {
    if (r.mode !== 'clean' || r.endedAt === null) continue;
    const c = asClean(r);
    for (const w of c.writes ?? []) {
      const key = `${c.read?.callNo ?? 0}:${w.callNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (w.verdict === 'caused') return true;
    }
  }
  return false;
}

/** Why a test stopped short and what to do about it: its budget's the advice to spend it better, any other stop in its own words. */
const stopWords = (reason: string): string => (/\bbudget\b/.test(reason) ? 'It stopped at its budget: test with fewer templates, or a higher budget' : `It stopped early (${reason}): test it again`);

/** Re-run test's card, where a golden's injection gate showed too little to say, in the engine's words (trust-words.ts): on its run's page and on Needs a look's row. */
export const gateAgainSub = (why: string | null | undefined): string => `${GATE_TOO_LITTLE.charAt(0).toUpperCase()}${GATE_TOO_LITTLE.slice(1)}: ${why ?? 'no attempt decided'}`;

/** What a recording's newest finished plant leads with: its proof when it failed, running again when it showed too little; null when it says nothing to do. */
function plantStep(f: Facts, newest: StoredInjectionResult): Decided | null {
  const { row, store } = f;
  const report = asPlant(newest);
  const verdict = report.gate?.verdict;
  const proof = verdict === 'failed' ? proofOf(store, report) : null;
  if (proof) return { key: 'injection-proof', label: ACTIONS.openProof.label, runId: proof.runId, href: links.run(proof.runId, proofCall(proof)), title: `Opens ${short(proof.runId)}`, sub: `${injectionLine(newest)} · ${proof.payload} at #${proof.read}` };
  if (verdict !== 'inconclusive') return null;
  const again = () => (report.cost ? injectionAgainEstimate(report as PlantReport) : null);
  const why = report.gate?.reason ?? 'no attempt decided';
  // Stopped early, or with a payload file its result doesn't keep: it can't run again as it ran, so it asks what to test.
  const ownFile = report.payloads?.some((x) => x.source === 'file');
  const stopped = report.stopReason ? stopWords(report.stopReason) : null;
  if ((report.stopReason || ownFile) && !newest.golden) return { key: 'injection-test', label: ACTIONS.runInjectionTest.label, runId: row.runId, command: commandLine(['injection', short(row.runId)]), sub: stopped ?? `It showed too little to say: ${why}`, reads: [row.runId], price: injectionPrice(row.runId, f.work?.tools) };
  if (newest.golden) return { key: 'gate-again', label: ACTIONS.rerunTest.label, golden: newest.golden, command: commandLine(['test', newest.golden]), sub: gateAgainSub(why), price: again };
  const job = testedAs(report);
  return { key: 'injection-again', label: ACTIONS.rerunInjectionTest.label, runId: row.runId, job, command: againCommand(row.runId, job), sub: `It showed too little to say: ${why}`, price: again };
}

/** The lime button as a recording's tests stand: a failed test or gate leads to its proof, one that showed too little runs again, and a write a read caused is packed with its gate. */
function injectionStep(f: Facts): Decided | null {
  const { row } = f;
  if ((row.kind !== 'recording' && row.kind !== 'pack') || row.meta.injection) return null;
  const results = f.reads.injection(row.runId);
  if (!results.length) return null;
  const newest = results.find((r) => r.mode === 'plant' && r.endedAt !== null);
  return (newest ? plantStep(f, newest) : null) ?? (causedAWrite(results) && packable(f, f.record) ? packGateStep(f, row.runId, false) : null);
}

/** A run whose newest presets failed leads with their proof, the first attempt that failed. Presets left inconclusive change nothing: running them again finds the same. */
function presetStep(f: Facts): Decided | null {
  const m = f.reads.presets(f.row.runId);
  // The engine's rule, which a presets job's Open proof follows too.
  const proof = m ? presetProof(m.cells, (runId) => f.store.getRun(runId) !== null) : null;
  if (!proof) return null;
  const { cell: c, attempt } = proof;
  return { key: 'preset-proof', label: ACTIONS.openProof.label, runId: attempt.runId, href: links.run(attempt.runId, c.callNo ?? 1), title: `Opens ${short(attempt.runId)}`, sub: `${c.label} failed · ${c.passes} of ${c.attempts} passed${c.detail ? ` · ${c.detail}` : ''}` };
}

// ---- a capture its import judged ----

/** What failed, without its call numbers and amounts, as a fix holds the same failure: a count (`send_email called 1 time`), or a rule's words. */
export function failureKey(text: string): string {
  const t = text.replace(/^check failed: /, '');
  const count = /^(\S+) called (\d+) times?\b/.exec(t);
  if (count) return `${count[1]!} called ${count[2]!}`;
  return t.replace(/ \(#\d+\)| #\d+/g, '').replace(/\d+(\.\d+)?/g, 'N');
}

/**
 * The fix that holds the same failure as the words it is asked, one not yet applied first; null for a
 * failure of its own. Each fix's oracle and check are keyed once, so Runs' issues ask it of every
 * failed run in one read (issues.ts).
 */
export function fixesByFailure(fixes: readonly StoredFix[]): (failed: string) => StoredFix | null {
  const holding = new Map<string, StoredFix[]>();
  for (const f of fixes) {
    for (const key of new Set([...f.check.oracle, ...f.check.text.split('; ')].map(failureKey))) {
      const held = holding.get(key);
      if (held) held.push(f);
      else holding.set(key, [f]);
    }
  }
  return (failed) => {
    const found = holding.get(failureKey(failed)) ?? [];
    return found.find((f) => f.status !== 'applied') ?? found[0] ?? null;
  };
}

/** The fix that holds the same failure as these words, as `fixesByFailure` finds it. */
export const fixByFailure = (fixes: readonly StoredFix[], failed: string): StoredFix | null => fixesByFailure(fixes)(failed);

/**
 * The rules on calls a capture's import failed it on, as `--expect` takes them, from the config's
 * `tests` as written: what a blame of it checks. Null when the verdict it kept names none the config
 * still gives, and then the page asks.
 */
export function captureExpect(run: Pick<RunRecord, 'meta'>, tests: unknown): { calls: unknown[] } | null {
  const failed = (keptCaptureVerdict(run)?.checks ?? []).filter((c) => checkStatus(c) === 'failed').map((c) => c.label);
  if (!failed.length || !isObject(tests)) return null;
  const raw: unknown[] = [];
  try {
    for (const entry of parseTests(tests)) {
      const written: unknown = tests[entry.recording];
      const calls = isObject(written) && isObject(written.expect) && Array.isArray(written.expect.calls) ? written.expect.calls : [];
      (entry.spec.calls ?? []).forEach((rule, i) => {
        if (failed.includes(callRuleLabel(rule)) && i < calls.length && !raw.some((x) => JSON.stringify(x) === JSON.stringify(calls[i]))) raw.push(calls[i]);
      });
    }
  } catch {
    return null;
  }
  return raw.length ? { calls: raw } : null;
}

/** A capture its import judged failed: the fix that holds the same failure, else blame, as a failed recording leads. */
function captureStep(f: Facts): Decided | null {
  const j = f.judged;
  if (f.row.kind !== 'capture' || j?.by !== 'import' || j.verdict !== 'failed') return null;
  const first = j.first?.label;
  const fix = first ? fixByFailure(f.reads.fixes(), first) : null;
  if (fix) return fixStep(fixRef(f.store, fix), fix.check.text);
  const failed = (j.checks ?? []).filter((c) => c.status === 'failed').map((c) => c.label);
  const expect = captureExpect(f.record, f.work?.tests);
  return blameStep(f.row.runId, expect ? { from: 'golden', expect, failed: failed.length ? failed : first ? [first] : [] } : { from: 'ask', failed: failed.length ? failed : first ? [first] : [] }, true);
}

// ---- the first that applies ----

function attemptStep(f: Facts): Decided | null {
  const { row, index } = f;
  const parent = row.parentRunId && index.byId.has(row.parentRunId) ? row.parentRunId : null;
  if (!parent) return null;
  if (row.meta.injection?.verdict === 'obeyed') {
    const tested = f.store.getRun(parent);
    if (tested && packable(f, tested)) return packGateStep(f, parent, true);
  }
  return row.attemptKind ? compareStep(parent, row.runId) : null;
}

/** Failed, and a fix covers it: the fix, its link as its page has it. */
function coveredStep(f: Facts): Decided | null {
  if (!f.row.failed) return null;
  const fix = f.fix()?.fix;
  return fix ? fixStep(fix, fix.check, fix.href) : null;
}

/** Failed, and nobody blamed it: blame, where blame can take it. */
function unblamedStep(f: Facts): Decided | null {
  if (!f.row.failed) return null;
  const offer = blameOffer(f.store, f.record, f.work?.tests, f.fix);
  return offer ? blameStep(f.row.runId, offer) : null;
}

/** A replay left on a value made anew on every run: the rule its divergence proposes (a test's is its golden's, above). */
function ruleStep(f: Facts): Decided | null {
  const rule = f.row.kind === 'fork' ? f.record.divergence?.hints?.find((h) => h.normalizer)?.normalizer : null;
  return rule ? { key: 'rule', label: ACTIONS.addNormalizer.label, command: commandLine(normalizeAddArgs(rule)), sub: 'Masks the value made anew on every run, at match time' } : null;
}

/** Pack as golden…, where nothing else leads: a recording a golden can be made from (`keepable`), not failed by today's checks either. */
function packStep(f: Facts): Decided | null {
  const { row } = f;
  if (f.judged?.verdict === 'failed' || !keepable(row, f.record, f.work?.dir, f.work?.goldens ?? [])) return null;
  const folder = goldenFolder(row.runId);
  return { key: 'pack', label: ACTIONS.packAsGolden.label, runId: row.runId, folder, title: 'Pack as golden', sub: 'A golden that CI replays on every commit', command: commandLine(['pack', short(row.runId), folder]) };
}

function decide(f: Facts): Decided {
  const { row, record, index } = f;
  if (row.status === 'running') return { ...replayStep(f.store, row, record, index), label: ACTIONS.replay.label, off: 'Replay once the recording finishes' };
  return (
    passingStep(f) ??
    checksLead(f) ??
    testStep(f) ??
    attemptStep(f) ??
    crashStep(f) ??
    injectionStep(f) ??
    presetStep(f) ??
    coveredStep(f) ??
    captureStep(f) ??
    unblamedStep(f) ??
    ruleStep(f) ??
    (row.kind === 'fork' && row.parentRunId && index.byId.has(row.parentRunId) ? compareStep(row.parentRunId, row.runId) : null) ??
    packStep(f) ??
    replayStep(f.store, row, record, index)
  );
}

/** A run from the index as every list shows it now: one its recorder left marked running reads interrupted. */
function asListed(row: IndexedRun, state: RunState | null): IndexedRun {
  return state && state.status !== row.status ? { ...row, status: state.status, endedAt: state.endedAt, outcome: state.outcome, failed: state.failed } : row;
}

function decided(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; reads?: StepReads }): Decided | null {
  const reads = o.reads ?? stepReads(store);
  const found = reads.index.byId.get(runId);
  const record = found ? store.getRun(runId) : null;
  if (!found || !record) return null;
  const row = asListed(found, reads.state(runId));
  const tested = once(() => testedGolden({ store, row, work }));
  return decide({
    store,
    index: reads.index,
    row,
    record,
    judged: o.judged,
    work,
    reads,
    tested,
    fix: once(() => {
      const found = fixForRun(store, runId, reads.index);
      return reads.byCheck ? withFixByCheck(store, record, work?.tests, found) : found;
    }),
    offer: once(() => testOffer(store, record, work?.normalize, work?.goldens ?? [])),
    choices: once(() => {
      const t = tested();
      return bisectChoices(store, runId, { goldens: work?.goldens ?? [], ...(t ? { known: { passes: reads.passes(t.source), result: t.result } } : {}) });
    }),
  });
}

/** A step as it is answered: what a rule decides it from left out. */
function plainStep(step: Decided): NextStep {
  const { price: _price, reads: _reads, beside: _beside, about: _about, ...plain } = step;
  return plain;
}

/** Open fix, as a run the fix holds leads with: what Runs' issue of a fix leads with once its runs are blamed (issues.ts). */
export const openFixStep = (fix: StoredFix): NextStep => plainStep(fixStep(fix, fix.check.text));

/** A run's next step, without what it bills, or null for a run the store doesn't have. */
export function nextStepOf(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; reads?: StepReads } = {}): NextStep | null {
  const step = decided(store, runId, work, o);
  if (!step) return null;
  return plainStep(step);
}

/** A run's about line, as a list quotes it: a long run's from its first calls until what its user asked is known. A hover's sentence, like an estimate: one that can't be worked out is left out. */
function aboutLine(store: Store, index: RunIndex, runId: string): string | null {
  const row = index.byId.get(runId);
  try {
    return row ? (aboutsWithin(store, index, [row], { budget: QUICK_FROM - 1 }).get(runId)?.text ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * A run's next step for its page: with its estimate when it bills, worked out as the job's ask states
 * it, from the run's calls and the recording it replays, and on a card that names another run, that
 * run's about line. A price that reads a long run's calls, unless this answer keeps them (`kept`), is
 * left out rather than read every call, and the step says so (`later`): a price that reads no calls
 * is always worked out.
 */
export async function pricedNextStep(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; kept: (runId: string) => boolean }): Promise<NextStep | null> {
  const reads = stepReads(store, undefined, { byCheck: true });
  const step = decided(store, runId, work, { judged: o.judged, reads });
  if (!step) return null;
  const plain = plainStep(step);
  const pricing = pricingOf(store, work?.prices);
  const priced = async (p: Priced | undefined): Promise<{ estimate?: Estimate; later?: true }> => {
    if (!p?.price) return {};
    if ((p.reads ?? []).some((id) => !o.kept(id) && (reads.index.byId.get(id)?.calls ?? 0) >= QUICK_FROM)) return { later: true };
    const estimate = await estimateOf(p.price, pricing);
    return estimate ? { estimate } : {};
  };
  const own = await priced(step);
  const other = await priced(step.beside);
  const about = step.about ? aboutLine(store, reads.index, step.about) : null;
  return { ...plain, ...(about ? { sub: about } : {}), ...own, ...(other.later ? { later: true as const } : {}), ...((plain.key === 'bisect' || plain.key === 'revert') && plain.blame && other.estimate ? { blame: { ...plain.blame, estimate: other.estimate } } : {}) };
}

/** The Replay a run's header keeps beside its next step: on a clean or a test replay, its recording's. Null for a run the store doesn't have. */
export function replayStepOf(store: Store, runId: string, index: RunIndex = loadRunIndex(store)): NextStep | null {
  const row = index.byId.get(runId);
  const record = row ? store.getRun(runId) : null;
  return row && record ? replayStep(store, row, record, index) : null;
}

/**
 * What a run's page answer says of its steps: its next step, and what its Replay replays. A record
 * they can't be read from (a run can come from someone else's pack) leaves them out: the page still
 * answers, with no lime button. `judged` undefined, as a long run's first answer leaves it: what its
 * verdict says may change what leads, so the step comes again with its analysis (`later`).
 */
export async function pageSteps(store: Store, runId: string, work: NextStepWork | null, o: { judged: RunJudged | null | undefined; kept: (runId: string) => boolean }): Promise<{ next?: NextStep; replay?: NextStep }> {
  try {
    const next = await pricedNextStep(store, runId, work, o);
    const replay = replayStepOf(store, runId);
    return { ...(next ? { next: o.judged === undefined ? { ...next, later: true as const } : next } : {}), ...(replay ? { replay } : {}) };
  } catch {
    return {};
  }
}

/** How many calls the runs a step's price may read have, as the index counts them: its own, its parent's and its golden's recording: how long the read may take. */
export function stepCalls(store: StoreOf<'readModels'>, run: Pick<RunRecord, 'runId' | 'parentRunId' | 'meta'>, work: NextStepWork | null): number {
  const { byId } = loadRunIndex(store);
  const golden: unknown = run.meta?.test?.golden;
  const source = typeof golden === 'string' ? work?.goldens.find((g) => g.path === golden)?.runId : null;
  return [run.runId, run.parentRunId, source].reduce((n, id) => n + (id ? (byId.get(id)?.calls ?? 0) : 0), 0);
}

/**
 * What a golden that didn't pass leads Tests with, by its newest result: Run more attempts where its
 * gate ran out of attempts between its bounds, which only Tests runs; else its replay's own step, as
 * the replay's page leads with it, in the light form a list's row has. Null for a golden that passed,
 * has no result yet, or whose replay the store doesn't hold or can't read.
 */
export function goldenStep(store: Store, golden: string, work: NextStepWork | null, reads: StepReads): NextStep | null {
  const result = reads.results(golden)[0];
  if (!result || verdictOfResult(result) === 'passed') return null;
  const source = work?.goldens.find((g) => g.path === golden);
  const checks = source ? checksStep(source, reads.results(golden)) : null;
  if (checks) return checksStepWords(checks, work?.goldens ?? [], false);
  const gate = gateStep(store, golden, result);
  if (gate !== undefined) return gate;
  const more = verdictOfResult(result) === 'inconclusive' ? gateResultView(result, golden)?.more : null;
  if (more) return { key: 'more-attempts', label: ACTIONS.runMoreAttempts.label, golden, command: commandLine(more.args) };
  return (result.runId ? listedStep(store, result.runId, work, { reads }) : null) ?? null;
}

/**
 * A golden whose verdict is its injection gate's (its replay passed): a failed gate leads with its
 * proof, the first attempt that obeyed (else influenced) that the store still has; one that showed too
 * little to say runs the golden and its gate again. Undefined for a golden whose verdict is not its gate's.
 */
function gateStep(store: Store, golden: string, result: TestResult): NextStep | null | undefined {
  const gate = result.failure === 'injection' ? result.data?.injection : null;
  if (!gate) return undefined;
  if (gate.verdict === 'inconclusive') return { key: 'gate-again', label: ACTIONS.rerunTest.label, golden, command: commandLine(['test', golden]), sub: gateAgainSub(gate.reason) };
  const kept = gate.resultId ? store.getInjectionResult(gate.resultId) : null;
  const proof = kept ? proofOf(store, kept.data) : null;
  return proof ? { key: 'injection-proof', label: ACTIONS.openProof.label, runId: proof.runId, href: links.run(proof.runId, proofCall(proof)), title: `Opens ${short(proof.runId)}`, sub: `${injectionLine(kept!)} · ${proof.payload} at #${proof.read}` } : null;
}

/** Tests' steps (`GET /api/tests`): of the goldens named, each that leads with one, by its path. */
export function goldenSteps(store: Store, goldens: readonly string[], work: NextStepWork | null): Record<string, NextStep> {
  const reads = stepReads(store, undefined, { byCheck: true });
  const steps: Record<string, NextStep> = {};
  for (const golden of goldens) {
    const step = goldenStep(store, golden, work, reads);
    if (step) steps[golden] = step;
  }
  return steps;
}

/** The jobs this module's table answers: one run's next step, whole, with what it bills, however long the runs it reads; and Tests' goldens' steps, in their light form. */
export type NextStepJob = { kind: 'next'; runId: string; outcome: OutcomeWork | null; next: NextStepWork | null } | { kind: 'tests-steps'; goldens: string[]; next: NextStepWork | null };

export const NEXT_STEP_READS: ReadTable<NextStepJob> = {
  next: async (store, job) => {
    const run = lookupRun(store, job.runId);
    if (!run) {
      const no = noSuchRun(store, job.runId);
      return failed(no.status, no.message);
    }
    const judged = runJudged(store, loadRunIndex(store), run.runId, job.outcome, { calls: () => [...runCalls(store, run.runId)], checks: true });
    const { next } = await pageSteps(store, run.runId, job.next, { judged: judged ?? null, kept: () => true });
    return answer({ runId: run.runId, next: next ?? null }, { tagged: true });
  },
  'tests-steps': (store, job) => answer(goldenSteps(store, job.goldens, job.next)),
};

/**
 * What an exported copy's run leads with: a copy runs nothing and holds no fix, so only a comparison
 * of an attempt or a fork with the run it came from, when the copy holds that run.
 */
export function copyNextStep(store: Store, runId: string, held: readonly string[]): NextStep | null {
  const row = loadRunIndex(store).byId.get(runId);
  const parent = row?.parentRunId;
  return row && parent && held.includes(parent) && (row.attemptKind || row.kind === 'fork') ? plainStep(compareStep(parent, runId)) : null;
}

/** A step as a list's row carries it. */
export function stepRow(step: NextStep): NextStepRow {
  return { key: step.key, label: step.label, ...(step.href ? { href: step.href } : {}), ...(step.off ? { off: step.off } : {}), ...(step.title ? { title: step.title } : {}), ...(step.command ? { command: step.command } : {}), ...(step.capture ? { capture: true as const } : {}), ...(step.key === 'replay' ? { runId: step.runId } : {}), ...(step.key === 'pack' ? { folder: step.folder } : {}) };
}

/**
 * A run's next step for a list: undefined for a record it can't be read from. A run can come from
 * someone else's pack, which can carry anything, and one such record never fails the list it is in:
 * its row stays as it was.
 */
export function listedStep(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; reads: StepReads }): NextStep | null | undefined {
  try {
    return nextStepOf(store, runId, work, o);
  } catch {
    return undefined;
  }
}

/** A crash's own step: Find breaking commit, then Revert once that named the commit. */
export type CrashStep = Extract<NextStep, { key: 'bisect' | 'revert' }>;

/**
 * A test replay's listed step where its agent exited with an error and the step is a crash's
 * (`crashStep`): what a fix whose blame found no call that rescues the run leads with
 * (fix-crash.ts). Null for a diverged test's Find breaking commit, a run whose step is another (a
 * later replay passed it), and a record that can't be read.
 */
export function crashStepOf(store: Store, runId: string, work: NextStepWork | null, reads: StepReads): CrashStep | null {
  const step = listedStep(store, runId, work, { reads });
  const found = reads.index.byId.get(runId);
  if ((step?.key !== 'bisect' && step?.key !== 'revert') || !found) return null;
  const row = asListed(found, reads.state(runId));
  const tested = testedGolden({ store, row, work });
  return tested && crashed(row, tested.result) ? step : null;
}

/**
 * The newest run's step on the row of failed runs nobody has blamed (Fixes, Needs a look): its listed
 * step, a capture's by the verdict its import kept, as the lists count it failed (fix-shared.ts
 * `capturedFailure`): the fix that holds the same failure, else Run blame, which asks for your
 * command on the capture's page. No call is read for it.
 */
export function unblamedListedStep(store: Store, runId: string, work: NextStepWork | null, o: { reads: StepReads }): NextStep | null | undefined {
  const capture = o.reads.index.byId.get(runId)?.kind === 'capture';
  const judged = capture ? runJudged(store, o.reads.index, runId, null, { quick: true }) : undefined;
  return listedStep(store, runId, work, judged === undefined ? o : { ...o, judged });
}

/** A run's Replay for a list, as its page keeps it beside its next step: undefined for a record it can't be read from. */
function listedReplay(store: Store, index: RunIndex, runId: string): NextStepRow | undefined {
  try {
    const step = replayStepOf(store, runId, index);
    return step ? stepRow(step) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each row with its next step, its light form: what needs no run's calls read, with what several
 * rows read, read once for all of them (`StepReads`). And its Replay, for ⌘K on its row, where the
 * next step is another: it reads the run's record, as the step does, and no call.
 */
export function nextStepRows<R extends Pick<RunRow, 'runId'> & { judged?: RunJudged | null }>(store: Store, rows: readonly R[], work: NextStepWork | null): Array<R & { next?: NextStepRow; replay?: NextStepRow }> {
  const index = loadRunIndex(store);
  const reads = stepReads(store, index);
  return rows.map((row) => {
    const step = listedStep(store, row.runId, work, { judged: row.judged, reads });
    if (!step) return row;
    const replay = step.key === 'replay' ? undefined : listedReplay(store, index, row.runId);
    return { ...row, next: stepRow(step), ...(replay ? { replay } : {}) };
  });
}

/** What a test replay's step reads of its golden's results, and of what Find breaking commit said of them. */
const RESULTS_STAMP_SQL = `SELECT COUNT(*) AS n, MAX(at) AS at FROM test_results WHERE golden = ?`;
const ANSWERS_STAMP_SQL = `SELECT COUNT(*) AS n, MAX(at) AS at FROM events WHERE ref = ? AND kind IN ('bisect.found', 'bisect.none')`;
/** A recording's: the injection tests run on it, each until it ends, and its presets. */
const INJECTION_STAMP_SQL = `SELECT COUNT(*) AS n, COUNT(ended_at) AS ended, MAX(COALESCE(ended_at, at)) AS at FROM injection_results WHERE run_id = ?`;
const PRESETS_STAMP_SQL = `SELECT COUNT(*) AS n, MAX(at) AS at FROM chaos_results WHERE run_id = ?`;

/**
 * Each golden's stamp while the store's tests and events stand as they did, so a page asked again
 * while nothing moved pays no look through the events, which aren't kept by what they are about.
 */
const goldenStamps = new WeakMap<object, { at: string; stamps: Map<string, string> }>();

function goldenStamp(store: StoreOf<'readModels'>, golden: string, at: string): string {
  let kept = goldenStamps.get(store);
  if (kept?.at !== at) goldenStamps.set(store, (kept = { at, stamps: new Map() }));
  const known = kept.stamps.get(golden);
  if (known !== undefined) return known;
  const stamp = JSON.stringify([store.query(RESULTS_STAMP_SQL, golden)[0], store.query(ANSWERS_STAMP_SQL, golden)[0]]);
  kept.stamps.set(golden, stamp);
  return stamp;
}

/**
 * What a run's next step reads besides the run's own record, which the run's page answer is tagged by
 * (run-version.ts) so a page asks again once it moves: the tests its injection and presets ran, and a
 * test replay's golden's results and what Find breaking commit said of them. Nothing about another
 * run or another golden moves it: a long run's answer is megabytes.
 */
export function nextStepStamp(store: StoreOf<'readModels' | 'activity'>, run: Pick<RunRecord, 'runId' | 'meta'>): string {
  const golden: unknown = run.meta?.test?.golden;
  const c = store.changeCounts();
  return JSON.stringify([store.query(INJECTION_STAMP_SQL, run.runId)[0], store.query(PRESETS_STAMP_SQL, run.runId)[0], ...(typeof golden === 'string' ? [goldenStamp(store, golden, `${c.tests ?? 0}:${c.events ?? 0}`)] : [])]);
}
