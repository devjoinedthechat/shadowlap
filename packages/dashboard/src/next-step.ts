import {
  ACTIONS,
  bisectEstimate,
  blameEstimate,
  callRuleLabel,
  checkStatus,
  confirmWords,
  familyGoldens,
  goldenTestEstimate,
  hasRecordedCommand,
  injectionAgainEstimate,
  injectionEstimate,
  injectionGateEstimate,
  injectionTemplates,
  isObject,
  keptCaptureVerdict,
  modelResolver,
  noEstimate,
  parseTests,
  pathSetByCode,
  pricedCalls,
  shortRunId as short,
  untrustedReads,
  updateEstimate,
  type CallRecord,
  type CleanReport,
  type Estimate,
  type FixStatus,
  type PlantReport,
  type Price,
  type PricedCall,
  type RunRecord,
  type Store,
  type StoreOf,
  type StoredFix,
  type StoredInjectionResult,
  type TestResult,
  type ToolTrust,
} from '@shadowlap/engine';
import { chaosMatrices, type ChaosMatrix } from './chaos.js';
import { HEX } from './commits-here.js';
import { commandLine } from './fix-shared.js';
import { fixForRun } from './fix-for-run.js';
import { injectionLine } from './injection.js';
import { links } from './links.js';
import { gitAsync } from './patch-in-tree.js';
import { blameOffer, passedSince, testOffer, type BlameOffer, type TestOffer } from './run-offers.js';
import { runCalls } from './run-calls.js';
import { loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import type { RunJudged } from './run-outcome.js';
import { callTotals, priced } from './run-stats.js';
import { runStates, type RunRow, type RunState } from './runs-list.js';
import { bisectAnswers, bisectChoices, standingAnswer, unjudgedOffline, unreadable, verdictOfResult, type AnswerEvent, type BisectAnswer, type GoldenSource } from './tests.js';

/**
 * The one next step of a run (A12): what its page's lime button leads with, worked out here from how
 * the run stands, so the run page, the lists, Needs a look and the palette say the same. The first
 * that applies:
 *
 * - still recording: Replay, off until it ends;
 * - a test replay whose golden passed when it ran again: Open passing run;
 * - a test that diverged: on a value that changes every run, Add normalizer and re-run (or Re-run test
 *   once the rule is in the config); on what a patch or a config change changed, Update golden; on
 *   anything else, Find breaking commit…;
 * - a test whose judge check couldn't be judged offline: Update golden;
 * - an injection attempt that obeyed, while no golden is made from the recording it tested: Pack with
 *   injection gate…;
 * - any other attempt: Compare with parent, failed or not, since it is one sample of many;
 * - a test replay whose agent exited (a crash): Find breaking commit, Run blame plain beside it, until
 *   the commit is named;
 * - a recording's newest injection test: Open proof where it failed, Run injection test… where a
 *   budget stopped it, Re-run injection test (Re-run test for a golden's gate) where it showed too
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
 *   from; on a capture Replay with your command….
 *
 * A step that runs a job says what it runs and, on a run's page, what it bills: its estimate, from the
 * engine, read from the recording it replays (`pricedNextStep`). A list reads no run's calls for its
 * rows: each row carries its step's key, words and link (`stepRow`).
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

export type NextStepKey = 'replay' | 'passing' | 'normalizer' | 'rule' | 'rerun-test' | 'update-golden' | 'gate-again' | 'bisect' | 'pack-gate' | 'pack' | 'compare' | 'injection-proof' | 'injection-test' | 'injection-again' | 'preset-proof' | 'fix' | 'blame';

/** A step as a list's row carries it: which one, its words, where it opens when it is a link, and why it can't start when it can't. */
export interface NextStepRow {
  key: NextStepKey;
  label: string;
  href?: string;
  off?: string;
}

/** A step on a run's page: the row's, and what its hover says, what it runs and bills. */
interface StepWords extends NextStepRow {
  /** The hover's title, where it isn't the label: `Against 01K5CQ3W6H`, `Opens 01K5CQ4R1T`. */
  title?: string;
  /** The hover's sentence under it. */
  sub?: string;
  /** The command it runs, as a person would type it. */
  command?: string;
  /** What it bills, where it runs something live; absent on a long run's first answer, and for a step that bills nothing. */
  estimate?: Estimate;
}

/** The fields each kind of step adds for what it does. */
export type NextStep = StepWords &
  (
    | { key: 'replay'; runId: string }
    | { key: 'passing' | 'injection-proof' | 'preset-proof'; runId: string }
    | { key: 'compare'; parent: string }
    | { key: 'fix'; fixId: string; status: FixStatus }
    | { key: 'blame'; offer: BlameOffer; capture?: true }
    | { key: 'normalizer' | 'update-golden'; golden: string; test: TestOffer | null }
    | { key: 'rerun-test' | 'gate-again'; golden: string }
    | { key: 'bisect'; golden: string; starts: boolean; blame: BlameOffer | null }
    | { key: 'rule' }
    | { key: 'injection-test'; runId: string }
    | { key: 'injection-again'; runId: string; job: InjectionAgain }
    | { key: 'pack-gate' | 'pack'; runId: string; folder: string }
  );

/** What the `injection` job takes to run a test again as the last one ran. */
export interface InjectionAgain {
  repeat: number;
  templates: string[];
  baselines: number;
  liveReads: boolean;
}

/** The folder a run is packed into as a golden: `goldens/` and its short id in lower case, never a label, which groups and filters runs and names none. */
export const goldenFolder = (runId: string): string => `goldens/${short(runId).toLowerCase()}`;

/** What finding a next step reads once for all the runs it is asked about: each read when it is first needed. */
export interface StepReads {
  state: (runId: string) => RunState | null;
  injection: (runId: string) => StoredInjectionResult[];
  presets: (runId: string) => ChaosMatrix | null;
  fixes: () => StoredFix[];
  answers: () => Map<string, AnswerEvent[]>;
  parents: (runId: string) => string | null | undefined;
}

function once<T>(read: () => T): () => T {
  let known: { value: T } | null = null;
  return () => (known ??= { value: read() }).value;
}

export function stepReads(store: Store, index: RunIndex = loadRunIndex(store)): StepReads {
  const tested = once(() => new Set(store.query('SELECT DISTINCT run_id AS id FROM injection_results').map((r) => String(r.id))));
  const matrices = once(() => {
    const byRun = new Map<string, ChaosMatrix>();
    // Newest first: a run's own, the newest where goldens that hold one recording each have one.
    for (const m of chaosMatrices(store)) if (!byRun.has(m.runId)) byRun.set(m.runId, m);
    return byRun;
  });
  return {
    state: runStates(store),
    injection: (runId) => (tested().has(runId) ? store.listInjectionResults({ runId, limit: 50 }) : []),
    presets: (runId) => matrices().get(runId) ?? null,
    fixes: once(() => store.listFixes()),
    answers: once(() => bisectAnswers(store)),
    parents: (runId) => {
      const r = index.byId.get(runId);
      return r ? r.parentRunId : undefined;
    },
  };
}

/** What a step's price reads, once the page's answer has the run's calls: pricing a list's rows would read every run's. */
interface Pricing {
  /** A run's calls, and its model calls priced as asked live. */
  raw: (runId: string) => readonly CallRecord[];
  calls: (runId: string) => PricedCall[];
  prices: Record<string, Price> | undefined;
}

/** A step as a rule decides it: with how to work out what it bills, for a run's page. */
type Decided = NextStep & { price?: (p: Pricing) => Estimate | null | Promise<Estimate | null> };

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
}

// ---- the steps ----

/** Replay: a clean or a test replay is the recording it came from served again, so it replays that recording, and says so. */
export function replayStep(row: Pick<IndexedRun, 'runId' | 'kind' | 'parentRunId'>, record: RunRecord, index: RunIndex): NextStep {
  // Not a capture's, which has no command of its own to replay it with: the replay of it has one.
  const parent = row.parentRunId && index.byId.get(row.parentRunId)?.source === null ? row.parentRunId : null;
  if ((row.kind === 'clean' || row.kind === 'test') && parent) return { key: 'replay', label: ACTIONS.replayRecording.label, runId: parent, title: `Replays ${short(parent)}, the recording this replay came from`, command: `shadowlap replay ${short(parent)}` };
  if (!hasRecordedCommand(record)) return { key: 'replay', label: ACTIONS.replayWithCommand.label, runId: row.runId, command: `shadowlap replay ${short(row.runId)} -- <your command>` };
  return { key: 'replay', label: ACTIONS.replay.label, runId: row.runId, command: `shadowlap replay ${short(row.runId)}` };
}

function compareStep(parent: string, runId: string): Decided {
  return { key: 'compare', label: ACTIONS.compareWithParent.label, parent, href: links.compare(parent, runId), title: `Against ${short(parent)}`, command: `shadowlap diff ${short(parent)} ${short(runId)}` };
}

function fixStep(fix: { fixId: string; title: string; status: FixStatus }, href = links.fixes(fix.fixId)): Decided {
  return { key: 'fix', label: ACTIONS.openFix.label, fixId: fix.fixId, status: fix.status, href, title: `“${fix.title}”` };
}

function blameCommand(runId: string, offer: BlameOffer, capture: boolean): string {
  const expect = offer.from === 'ask' ? ` --expect '<what it must do>'` : offer.expect !== null && offer.expect !== undefined ? ` --expect '${JSON.stringify(offer.expect)}'` : '';
  return `shadowlap blame ${short(runId)}${expect}${capture ? ' -- <your command>' : ''}`;
}

function blameStep(runId: string, offer: BlameOffer, capture = false): Decided {
  return { key: 'blame', label: ACTIONS.runBlame.label, offer, ...(capture ? { capture: true as const } : {}), command: blameCommand(runId, offer, capture), price: (p) => blameEstimate(p.calls(runId), p.prices ? { prices: p.prices } : {}) };
}

/** Whether a golden is made from a run: one its family replays or was unpacked from, or whose pack holds a run of its family. */
function madeIntoGolden(f: Facts, run: RunRecord): boolean {
  const w = f.work;
  return !!w && familyGoldens(f.store, run, w.goldens, w.dir ?? '.', f.reads.parents).length > 0;
}

/** The payloads every template plants, as a test with none picked plants them. */
const allTemplates = () => injectionTemplates().templates.length;

function packGateStep(f: Facts, runId: string, parent: boolean): Decided {
  const folder = goldenFolder(runId);
  return {
    key: 'pack-gate',
    label: ACTIONS.packWithGate.label,
    runId,
    folder,
    title: `Pack ${short(runId)} with injection gate`,
    sub: parent ? 'A golden with an injection gate: it fails while the agent obeys a planted instruction' : 'A golden with an injection gate: it fails while the agent obeys a planted instruction, and passes once it is fixed',
    command: `shadowlap pack ${short(runId)} ${folder}`,
    price: (p) => injectionGateEstimate(p.calls(runId), untrustedReads(p.raw(runId), f.work?.tools).reads, { payloads: allTemplates() }),
  };
}

// ---- a test replay ----

/** A test replay of its own whose golden is on disk and can be read, and its golden's result in its session: what its steps run on. */
interface TestedGolden {
  golden: string;
  source: GoldenSource;
  result: TestResult | null;
}

function testedGolden(f: Facts): TestedGolden | null {
  const test = f.row.meta.test;
  // The index reads the record field by field, and a golden or a session that isn't text as empty: a run can come from someone else's pack.
  if (f.row.kind !== 'test' || f.row.attemptKind || !test?.golden || !test.session) return null;
  const source = f.work?.goldens.find((g) => g.path === test.golden);
  if (!source || unreadable(source)) return null;
  return { golden: test.golden, source, result: f.store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0] ?? null };
}

/** Whether a test replay's agent exited with an error, as its golden's result says (a run keeps no exit of its own): a crash. */
function crashed(row: IndexedRun, result: TestResult | null): boolean {
  if (result) return result.failure === 'exit';
  return row.status === 'failed' && row.outcome.kind === 'check-failed' && row.outcome.check === null;
}

const REMADE = 'It re-records the golden under the change';
const JUDGE_ONCE = 'Asks the judge once, live, and keeps its verdict in the pack: every test after judges from the recording, free';

/** Update golden: re-recorded live, about what its recording cost. */
function updateStep(f: Facts, golden: string, source: GoldenSource): Decided {
  return { key: 'update-golden', label: ACTIONS.updateGolden.label, golden, test: testOffer(f.store, f.record, f.work?.normalize, f.work?.goldens ?? []), sub: REMADE, command: `shadowlap test ${golden} --update`, price: (p) => updateEstimate([{ calls: source.runId ? p.calls(source.runId) : [] }]) };
}

/** What the values made anew on every run lead a diverged test to: the rule, then the test again or an update; null for an id that may be a real change, which only the person can tell, so neither leads. */
function valueStep(f: Facts, t: TestedGolden, offer: TestOffer): Decided | null {
  const { golden, source, result } = t;
  const all = offer.values.coversAll;
  const update = (p: Pricing) => updateEstimate([{ calls: source.runId ? p.calls(source.runId) : [] }]);
  const test = () => goldenTestEstimate(source.mode === 'fork', result);
  if (offer.normalized) return all ? { key: 'rerun-test', label: ACTIONS.rerunTest.label, golden, command: `shadowlap test ${golden}`, sub: 'The rule is in shadowlap.config.json: it replays the golden again', price: test } : updateStep(f, golden, source);
  if (offer.maybeReal) return null;
  return {
    key: 'normalizer',
    label: all ? ACTIONS.addNormalizerAndRerun.label : ACTIONS.addNormalizerAndUpdate.label,
    golden,
    test: offer,
    command: (offer.normalizeAndTest ?? []).map((a) => commandLine(a)).join(' && '),
    sub: all ? 'Masks the value at match time, then replays the golden offline' : 'Masks the value at match time, then re-records the golden',
    price: all ? test : update,
  };
}

/** What a diverged test leads with: the rule for a value made anew on every run, an update for a change that was meant, else the commit that changed it. */
function divergedStep(f: Facts, t: TestedGolden): Decided {
  const { golden, source, result } = t;
  const offer = testOffer(f.store, f.record, f.work?.normalize, f.work?.goldens ?? []);
  const rule = offer?.values.values.length ? valueStep(f, t, offer) : null;
  if (rule) return rule;
  const d = f.record.divergence;
  if (d?.type === 'request_changed' && (d.diff ?? []).some((e) => pathSetByCode(e.path, d.name))) return updateStep(f, golden, source);
  const c = bisectChoices(f.store, f.row.runId, { goldens: f.work?.goldens ?? [] });
  if (c?.unavailable) return updateStep(f, golden, source);
  const price = bisectPrice(f, source, result, c?.good ?? null, c?.bad ?? null);
  return { key: 'bisect', label: ACTIONS.findBreakingCommit.label, golden, starts: false, blame: null, command: bisectCommand(golden, null, commitName(c?.bad)), sub: 'Asks for a commit where it still worked, then replays it at the commits between', ...(price ? { price } : {}) };
}

/** What a test replay of its own leads with while its golden is on disk: its passing run, or by how it diverged, or its judge's verdict. */
function testStep(f: Facts): Decided | null {
  const t = testedGolden(f);
  if (!t) return null;
  const { row, store } = f;
  const diverged = row.failed && row.outcome.kind === 'diverged';
  if (diverged || (row.failed && crashed(row, t.result))) {
    const passing = passedSince(store, f.record, t.golden);
    if (passing) return { key: 'passing', label: ACTIONS.openPassingRun.label, runId: passing, href: links.run(passing), title: `Opens ${short(passing)}` };
  }
  if (diverged) return divergedStep(f, t);
  const r = t.result;
  if (r && verdictOfResult(r) === 'inconclusive' && t.source.mode === 'replay' && unjudgedOffline(r)) {
    // A verdict the pack lacks: one call of its judge, at what one has cost where the result kept it.
    const judge = (r.data?.checks ?? []).find((c) => checkStatus(c) === 'inconclusive' && c.judge)?.judge?.cost ?? null;
    return { ...updateStep(f, t.golden, t.source), sub: JUDGE_ONCE, price: () => updateEstimate([{ calls: [], judge }]) };
  }
  return null;
}

/** The answer Find breaking commit gave for the failure its golden shows now: once it names the commit, the change is the code's. */
function bisectAnswer(f: Facts, golden: string): BisectAnswer | null {
  const answers = f.reads.answers().get(golden);
  if (!answers?.length) return null;
  const past = f.store.listTestResults({ golden, limit: 1000 });
  return past[0] ? standingAnswer(answers, past, past[0]) : null;
}

/**
 * A revision as a commit's hex name, or null for anything else: a revision comes from a run, which
 * may have come from anyone, so nothing else is handed to git, or shown as a command to paste.
 */
const commitName = (rev: string | null | undefined): string | null => (rev && HEX.test(rev) ? rev : null);

const bisectCommand = (golden: string, good: string | null, bad: string | null): string => `${commandLine(['bisect', golden])} --good ${good ?? '<commit>'}${bad ? ` --bad ${bad}` : ''}`;

/**
 * What Find breaking commit bills: nothing on a golden that replays, which it replays offline at
 * each commit; on one marked fork, its gate live at every commit it may test, each attempt as dear
 * as the costliest of its last session's. How many commits that is, git says, once the search has a
 * commit to start from, and only of two commits.
 */
function bisectPrice(f: Facts, source: GoldenSource, result: TestResult | null, good: string | null, bad: string | null): Decided['price'] {
  if (source.mode !== 'fork') return undefined;
  return async (p) => {
    const dir = f.work?.dir;
    const from = commitName(good);
    const to = bad === null ? 'HEAD' : commitName(bad);
    if (!from || !dir) return noEstimate('bisect', 'no estimate until it has a commit to start from');
    if (!to) return noEstimate('bisect', 'no estimate: the revision it would search up to is no commit');
    const count = await gitAsync(dir, ['rev-list', '--count', `${from}..${to}`]);
    const commits = count.code === 0 ? Number(count.stdout.trim()) : NaN;
    if (!Number.isInteger(commits)) return noEstimate('bisect', 'git could not say how many commits it would search');
    const gate = source.gate && 'max' in source.gate ? source.gate.max : null;
    const runs = (result?.data?.attempts?.runs ?? []).map((id) => f.index.byId.get(id)).filter((r): r is IndexedRun => !!r);
    const spends = [...callTotals(f.store, f.index, runs).values()].map((t) => priced(t, p.prices).spent);
    return bisectEstimate(commits, { fork: true, attempts: gate ?? source.repeat, each: spends.length ? Math.max(...spends) : null, commit: result?.data?.spent ?? null, count: gate === null });
  };
}

/** A crash: its commit leads, found offline and free from the newest commit its golden passed at, with Run blame beside it, until the commit is named. */
function crashStep(f: Facts): Decided | null {
  const t = testedGolden(f);
  const { row, store } = f;
  if (!t || !row.failed || !crashed(row, t.result) || bisectAnswer(f, t.golden)?.found) return null;
  const c = bisectChoices(store, row.runId, { goldens: f.work?.goldens ?? [] });
  if (!c || c.unavailable) return null;
  const good = commitName(c.good);
  const starts = !!good && !c.live;
  const price = bisectPrice(f, t.source, t.result, c.good, c.bad);
  return {
    key: 'bisect',
    label: starts ? confirmWords(ACTIONS.findBreakingCommit.label) : ACTIONS.findBreakingCommit.label,
    golden: t.golden,
    starts,
    blame: fixForRun(store, row.runId)?.fix ? null : blameOffer(store, f.record, f.work?.tests),
    command: bisectCommand(t.golden, good, commitName(c.bad)),
    sub: starts ? `Replays the golden at the commits since ${good!}, where it passed, offline: no tokens` : 'Asks for a commit where it still worked, then replays it at the commits between',
    ...(price ? { price } : {}),
  };
}

// ---- injection tests and presets ----

const asPlant = (r: StoredInjectionResult) => r.data as unknown as Partial<PlantReport>;
const asClean = (r: StoredInjectionResult) => r.data as unknown as Partial<CleanReport>;

/** The attempt a result's proof is, among those the store still has: the first that obeyed, else the first influenced, else the first that couldn't say why. */
function proofOf(store: StoreOf<'recording'>, report: Partial<PlantReport>): NonNullable<PlantReport['attempts']>[number] | null {
  for (const verdict of ['obeyed', 'influenced', 'inconclusive']) {
    const a = (report.attempts ?? []).find((x) => x.verdict === verdict && store.getRun(x.runId));
    if (a) return a;
  }
  return null;
}

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

/** What the `injection` job takes to test again as the test did. */
function testedAs(report: Partial<PlantReport>): InjectionAgain {
  const baselines = (report.baselines ?? []).reduce((n, b) => Math.max(n, b.runs.length), 0);
  return { repeat: report.repeat ?? 1, templates: report.templates?.ids ?? [], baselines, liveReads: report.unrecordedReads === 'live' };
}

function againCommand(runId: string, again: InjectionAgain): string {
  const args = ['injection', short(runId), ...(again.templates.length ? ['--templates', again.templates.join(',')] : []), ...(again.repeat !== 1 ? ['--repeat', String(again.repeat)] : []), ...(again.liveReads ? ['--live-reads'] : [])];
  return commandLine(args);
}

/** What a recording's newest finished plant leads with: its proof when it failed, running again when it showed too little; null when it says nothing to do. */
function plantStep(f: Facts, newest: StoredInjectionResult): Decided | null {
  const { row, store } = f;
  const report = asPlant(newest);
  const verdict = report.gate?.verdict;
  const proof = verdict === 'failed' ? proofOf(store, report) : null;
  if (proof) return { key: 'injection-proof', label: ACTIONS.openProof.label, runId: proof.runId, href: links.run(proof.runId, proof.evidence?.[0]?.callNo ?? proof.readAt ?? null), title: `Opens ${short(proof.runId)}`, sub: `${injectionLine(newest)} · ${proof.payload} at #${proof.read}` };
  if (verdict !== 'inconclusive') return null;
  const again = () => (report.cost ? injectionAgainEstimate(report as PlantReport) : null);
  const why = report.gate?.reason ?? 'no attempt decided';
  // Stopped early, or with a payload file its result doesn't keep: it can't run again as it ran, so it asks what to test.
  const ownFile = report.payloads?.some((x) => x.source === 'file');
  if ((report.stopReason || ownFile) && !newest.golden) return { key: 'injection-test', label: ACTIONS.runInjectionTest.label, runId: row.runId, command: `shadowlap injection ${short(row.runId)}`, sub: report.stopReason ? `It stopped early (${report.stopReason}): test with fewer templates, or a higher budget` : `It showed too little to say: ${why}`, price: (p) => injectionEstimate(p.calls(row.runId), untrustedReads(p.raw(row.runId), f.work?.tools).reads, { payloads: allTemplates() }) };
  if (newest.golden) return { key: 'gate-again', label: ACTIONS.rerunTest.label, golden: newest.golden, command: `shadowlap test ${newest.golden}`, sub: `Its injection gate showed too little to say: ${why}`, price: again };
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
  return (newest ? plantStep(f, newest) : null) ?? (causedAWrite(results) && !madeIntoGolden(f, f.record) ? packGateStep(f, row.runId, false) : null);
}

/** A run whose newest presets failed leads with their proof, the first attempt that failed. Presets left inconclusive change nothing: running them again finds the same. */
function presetStep(f: Facts): Decided | null {
  const m = f.reads.presets(f.row.runId);
  if (!m) return null;
  for (const c of m.cells) {
    if (c.verdict !== 'failed') continue;
    const kept = c.runs.filter((x) => f.store.getRun(x.runId));
    const attempt = kept.find((x) => x.verdict === 'failed') ?? kept.find((x) => x.verdict !== 'passed') ?? kept.at(-1);
    if (attempt) return { key: 'preset-proof', label: ACTIONS.openProof.label, runId: attempt.runId, href: links.run(attempt.runId, c.callNo ?? 1), title: `Opens ${short(attempt.runId)}`, sub: `${c.label} failed · ${c.passes} of ${c.attempts} passed${c.detail ? ` · ${c.detail}` : ''}` };
  }
  return null;
}

// ---- a capture its import judged ----

/** What failed, without its call numbers and amounts, as a fix holds the same failure: a count (`send_email called 1 time`), or a rule's words. */
export function failureKey(text: string): string {
  const t = text.replace(/^check failed: /, '');
  const count = /^(\S+) called (\d+) times?\b/.exec(t);
  if (count) return `${count[1]!} called ${count[2]!}`;
  return t.replace(/ \(#\d+\)| #\d+/g, '').replace(/\d+(\.\d+)?/g, 'N');
}

/** The fix that holds the same failure as these words, one not yet applied first; null for a failure of its own. */
export function fixByFailure(fixes: readonly StoredFix[], failed: string): StoredFix | null {
  const key = failureKey(failed);
  const holds = (f: StoredFix) => [...f.check.oracle, ...f.check.text.split('; ')].some((part) => failureKey(part) === key);
  const found = fixes.filter(holds);
  return found.find((f) => f.status !== 'applied') ?? found[0] ?? null;
}

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
  if (fix) return fixStep(fix);
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
    if (tested && !madeIntoGolden(f, tested)) return packGateStep(f, parent, true);
  }
  return row.attemptKind ? compareStep(parent, row.runId) : null;
}

/** Failed, and a fix covers it: the fix, its link as its page has it. */
function coveredStep(f: Facts): Decided | null {
  if (!f.row.failed) return null;
  const fix = fixForRun(f.store, f.row.runId)?.fix;
  return fix ? fixStep(fix, fix.href) : null;
}

/** Failed, and nobody blamed it: blame, where blame can take it. */
function unblamedStep(f: Facts): Decided | null {
  if (!f.row.failed) return null;
  const offer = blameOffer(f.store, f.record, f.work?.tests);
  return offer ? blameStep(f.row.runId, offer) : null;
}

/** A replay left on a value made anew on every run: the rule its divergence proposes (a test's is its golden's, above). */
function ruleStep(f: Facts): Decided | null {
  if (f.row.kind !== 'fork' || !f.record.divergence?.hints?.some((h) => h.normalizer)) return null;
  return { key: 'rule', label: ACTIONS.addNormalizer.label, command: 'shadowlap normalize add', sub: 'Masks the value made anew on every run, at match time' };
}

/** A recording that didn't fail, no golden made from it yet: a golden from a failed run would pass on the failure and diverge once the fix ships. */
function packStep(f: Facts): Decided | null {
  const { row, work } = f;
  if (row.kind !== 'recording' || row.status !== 'completed' || row.failed || !row.calls || !work?.dir) return null;
  if (f.judged?.verdict === 'failed' || !hasRecordedCommand(f.record) || madeIntoGolden(f, f.record)) return null;
  const folder = goldenFolder(row.runId);
  return { key: 'pack', label: ACTIONS.packAsGolden.label, runId: row.runId, folder, title: 'Pack as golden', sub: 'A golden that CI replays on every commit', command: `shadowlap pack ${short(row.runId)} ${folder}` };
}

function decide(f: Facts): Decided {
  const { row, record, index } = f;
  if (row.status === 'running') return { ...replayStep(row, record, index), label: ACTIONS.replay.label, off: 'Replay once the recording finishes' };
  return (
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
    replayStep(row, record, index)
  );
}

/** A run from the index as every list shows it now: one its recorder left marked running reads interrupted. */
function asListed(row: IndexedRun, state: RunState | null): IndexedRun {
  return state && state.status !== row.status ? { ...row, status: state.status, endedAt: state.endedAt, outcome: state.outcome, failed: state.failed } : row;
}

function decided(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; reads?: StepReads }): Decided | null {
  const index = loadRunIndex(store);
  const found = index.byId.get(runId);
  const record = found ? store.getRun(runId) : null;
  if (!found || !record) return null;
  const reads = o.reads ?? stepReads(store, index);
  return decide({ store, index, row: asListed(found, reads.state(runId)), record, judged: o.judged, work, reads });
}

/** A run's next step, without what it bills, or null for a run the store doesn't have. */
export function nextStepOf(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; reads?: StepReads } = {}): NextStep | null {
  const step = decided(store, runId, work, o);
  if (!step) return null;
  const { price: _price, ...plain } = step;
  return plain;
}

/**
 * A run's next step for its page: with its estimate when it bills, worked out as the job's ask states
 * it, from the run's calls and the recording it replays. Without `whole`, a long run's first answer,
 * it leaves the estimate out rather than read every call, and has it once the page asks again.
 */
export async function pricedNextStep(store: Store, runId: string, work: NextStepWork | null, o: { judged?: RunJudged | null | undefined; whole: boolean }): Promise<NextStep | null> {
  const step = decided(store, runId, work, { judged: o.judged });
  if (!step) return null;
  const { price, ...plain } = step;
  if (!price || !o.whole) return plain;
  const modelOf = modelResolver(store);
  const prices = work?.prices;
  const estimate = await price({ raw: (id) => runCalls(store, id), calls: (id) => pricedCalls(runCalls(store, id), { modelOf, ...(prices ? { prices } : {}) }), prices });
  return estimate ? { ...plain, estimate } : plain;
}

/** The Replay a run's header keeps beside its next step: on a clean or a test replay, its recording's. Null for a run the store doesn't have. */
export function replayStepOf(store: Store, runId: string): NextStep | null {
  const index = loadRunIndex(store);
  const row = index.byId.get(runId);
  const record = row ? store.getRun(runId) : null;
  return row && record ? replayStep(row, record, index) : null;
}

/**
 * What a run's page answer says of its steps: its next step, and what its Replay replays. A record
 * they can't be read from (a run can come from someone else's pack) leaves them out: the page still
 * answers, with no lime button.
 */
export async function pageSteps(store: Store, runId: string, work: NextStepWork | null, o: { judged: RunJudged | null | undefined; whole: boolean }): Promise<{ next?: NextStep; replay?: NextStep }> {
  try {
    const next = await pricedNextStep(store, runId, work, o);
    const replay = replayStepOf(store, runId);
    return { ...(next ? { next } : {}), ...(replay ? { replay } : {}) };
  } catch {
    return {};
  }
}

/**
 * What an exported copy's run leads with: a copy runs nothing and holds no fix, so only a comparison
 * of an attempt or a fork with the run it came from, when the copy holds that run.
 */
export function copyNextStep(store: Store, runId: string, held: readonly string[]): NextStep | null {
  const row = loadRunIndex(store).byId.get(runId);
  const parent = row?.parentRunId;
  return row && parent && held.includes(parent) && (row.attemptKind || row.kind === 'fork') ? compareStep(parent, runId) : null;
}

/** A step as a list's row carries it: which one, its words and its link. */
export function stepRow(step: NextStep): NextStepRow {
  return { key: step.key, label: step.label, ...(step.href ? { href: step.href } : {}), ...(step.off ? { off: step.off } : {}) };
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

/** Each row with its next step, its light form: what needs no run's calls read, so a list's cost stays what its rows' records cost. */
export function nextStepRows<R extends Pick<RunRow, 'runId'> & { judged?: RunJudged | null }>(store: Store, rows: readonly R[], work: NextStepWork | null): Array<R & { next?: NextStepRow }> {
  const index = loadRunIndex(store);
  const reads = stepReads(store, index);
  return rows.map((row) => {
    const step = listedStep(store, row.runId, work, { judged: row.judged, reads });
    return step ? { ...row, next: stepRow(step) } : row;
  });
}

/**
 * What a run's next step reads besides the run's own record, which the run's page answer is tagged by
 * (run-version.ts) so a page asks again once it moves: the tests its injection and presets ran, and a
 * test replay's golden's results and what Find breaking commit said of them.
 */
export function nextStepStamp(store: StoreOf<'activity'>, run: Pick<RunRecord, 'meta'>): string {
  const c = store.changeCounts();
  return [c.injection ?? 0, c.chaos ?? 0, ...(run.meta?.test ? [c.tests ?? 0, c.events ?? 0] : [])].join(':');
}
