import { INJECTION_PART, moreAttemptsParts, updatePart } from '../../engine/src/cost-words.js';
import { consentAsked, type FactWords, type LiveGolden } from './actions.js';
import type { DocKey } from './docs-links.js';
import type { JobView } from './api.js';
import { mergeTreeJobs, treeBusy, type TreeJob } from './fixes/model.js';
import { goldenName } from './format.js';
import { commandText } from './goldens.js';
import type { MoreAttempts, TestBannerOffer, TestsView } from './types.js';
import { ACTIONS } from './labels.js';

/**
 * A Tests job that would run anything live asks first, wherever it was started: Tests' Run tests,
 * Run more attempts and Re-run, Add normalizer there and on a test replay's banner, the palette's Run
 * the tests. The server decides (src/tests-live.ts): a session that runs a golden marked fork or an
 * injection gate answers 409, naming the goldens that go live and why, with the `confirm` that says
 * yes to it. The question then waits here until the dialog the shell draws for it (`TestsAskHost`)
 * is answered: its button sends the same job again with that `confirm` as `yes`, Cancel or Esc drops
 * it, and nothing runs meanwhile. A session that only replays starts on the click. No DOM here: the
 * tests drive it with a stand-in app.
 */

/** What a job's question says besides the server's words: its title, its button and the commands the job runs. */
export interface TestsAsk {
  title: string;
  /** The golden its title names, set in mono there. */
  name?: string;
  lead: string;
  doc: DocKey;
  ok: string;
  /** Each command as a person would type it (`shadowlap test goldens/*`). */
  commands?: readonly string[];
  /** Its own rows, in place of the goldens that go live: a limit, and how soon it settles. */
  facts?: readonly FactWords[];
  /** What it bills, past `Billed by your provider`. */
  parts?: readonly string[];
}

/**
 * What a job's question says, or how to read it once the server asks one: the palette, which lists
 * no goldens, reads its command then (`paletteTestsAsk`), and may find it can't ask at all.
 */
export type TestsAskSource = TestsAsk | (() => Promise<TestsAsk>);

/** The question a job waits on: the server's words and `confirm`, and the job to send again once it is answered. */
export interface TestsQuestion extends TestsAsk {
  why: string;
  confirm: string;
  /** Which goldens go live and why, as rows. */
  live?: readonly LiveGolden[];
  kind: string;
  fields: Record<string, unknown>;
}

/** What starting a job needs of the app (`AppState`). */
export interface TestsJobApp {
  client: { startJob(kind: string, fields: Record<string, unknown>): Promise<JobView> };
  guard(fn: () => void): boolean;
  watchJob(p: Promise<JobView>): void;
}

let asking: TestsQuestion | null = null;
const listeners = new Set<() => void>();

/** The question waiting to be answered, or null. */
export function testsQuestion(): TestsQuestion | null {
  return asking;
}

export function onTestsQuestion(on: () => void): () => void {
  listeners.add(on);
  return () => {
    listeners.delete(on);
  };
}

function ask(q: TestsQuestion | null): void {
  asking = q;
  for (const on of listeners) on();
}

/**
 * Starts a Tests job, its drawer showing it once the server has taken it. A 409 that asks a yes
 * (`consentAsked`) waits as the question, with `say`'s title, button and commands, read then when
 * `say` reads them. Any other refusal shows as every refused job's does, in an error toast, and so
 * does a question `say` can't be read for (the reason it gives), one to a job started without `say`,
 * and a second one to a job that already sent a yes (a session that changed under it: asked again
 * in its own words, never in a loop).
 */
export function startTestsJob(app: TestsJobApp, kind: string, fields: Record<string, unknown>, say?: TestsAskSource): boolean {
  const refused = (err: unknown) => app.watchJob(Promise.reject(err));
  return app.guard(() => {
    void app.client.startJob(kind, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (!asked || !say) refused(err);
        else void (typeof say === 'function' ? say() : Promise.resolve(say)).then((s) => ask({ ...s, ...asked, kind, fields }), refused);
      },
    );
  });
}

/**
 * The answer to the question waiting: yes sends its job again with its `confirm`, and the question
 * goes once that is sent; no drops it, and nothing runs. False while the job can't start (offline),
 * so its dialog stays open with the question.
 */
export function answerTestsQuestion(app: TestsJobApp, yes: boolean): boolean {
  const q = asking;
  const sent = !q || !yes || startTestsJob(app, q.kind, { ...q.fields, yes: q.confirm }, q);
  if (sent) ask(null);
  return sent;
}

// ---- what each button's question says ----

/** Run tests: every golden, as the page's command runs them. */
export function runTestsAsk(view: Pick<TestsView, 'commands'>): TestsAsk {
  return { title: ACTIONS.runTests.label, lead: 'Replays every golden, as CI does.', doc: 'ciMode', ok: ACTIONS.runTests.label, commands: [commandText(view.commands.run)], parts: ['only what runs live'] };
}

/** What the palette's question reads of the app (`AppState`). */
export interface PaletteTestsApp {
  client: { tests(): Promise<Pick<TestsView, 'commands'>>; jobs(): Promise<readonly TreeJob[]> };
  jobs: ReadonlyArray<{ job: TreeJob; lost?: boolean }>;
  meta: { project?: { path: string } | null } | null;
}

/**
 * The palette's Run the tests, which lists no goldens: once the server asks, its question names the
 * command from what Tests lists, as Tests' own Run tests does. That button waits while a job holds
 * the working tree (`treeBusy`), which the server checks only once it has the yes; so this asks
 * nothing then, and says why instead, as the refusal after the yes would.
 */
export function paletteTestsAsk(app: PaletteTestsApp): () => Promise<TestsAsk> {
  return () =>
    Promise.all([app.client.tests(), app.client.jobs()]).then(([view, listed]) => {
      const held = treeBusy(mergeTreeJobs(listed, app.jobs), 'reads', 'run the tests', app.meta?.project?.path ?? null);
      if (held) throw new Error(held);
      return runTestsAsk(view);
    });
}

/** Run more attempts on a golden whose gate ran out of them, with the command the page shows on its hover, the limit it goes on to and how often that settles it. */
export function moreAttemptsAsk(name: string, more: Pick<MoreAttempts, 'args' | 'attempts' | 'most' | 'expected' | 'settles'>): TestsAsk {
  const ran = more.attempts - more.most;
  return {
    title: `${ACTIONS.runMoreAttempts.label} on ${name}`,
    name,
    lead: `Carries its gate on from attempt ${ran + 1}, for this session only.`,
    doc: 'gating',
    ok: ACTIONS.runMoreAttempts.label,
    commands: [commandText(more.args)],
    facts: [
      { label: 'Limit', value: `${more.attempts} attempts`, quiet: `its first ${ran} count` },
      { label: 'Settles', value: `${Math.round(more.settles * 100)}% of the time`, quiet: `in about ${Math.round(more.expected)} more` },
    ],
    parts: moreAttemptsParts(more.most),
  };
}

/** What a normalizer's job is called by its steps: it updates the golden after the rules when its last step re-records it. */
const normalizerLabel = (steps: readonly (readonly string[])[] | null | undefined) => ((steps?.at(-1) ?? []).includes('--update') ? ACTIONS.addNormalizerAndUpdate.label : ACTIONS.addNormalizerAndRerun.label);

/** Add normalizer on a golden that forks: masks the value, then tests it, or re-records it when its last step does. */
function normalizerAsk(name: string, steps: readonly (readonly string[])[] | null | undefined): TestsAsk {
  const label = normalizerLabel(steps);
  const updates = label === ACTIONS.addNormalizerAndUpdate.label;
  return {
    title: updates ? `${label} ${name}?` : label,
    lead: updates ? `Masks the value, then re-records ${name}, for a change you meant.` : 'Masks the value, then tests the golden again.',
    doc: 'goldenUpdates',
    ok: label,
    commands: (steps ?? []).map(commandText),
    parts: [updates ? updatePart(true, false) : 'live from where it forks'],
  };
}

/** Re-run on a golden that diverged, from Tests or a test replay's next step: its test again, live from where it forks. */
export function rerunAsk(name: string, golden: string): TestsAsk {
  return { title: `Re-run ${name}`, lead: `Replays ${name} again, live from where it forks.`, doc: 'goldensThatFork', ok: 'Re-run', commands: [commandText(['test', golden])], parts: ['only what runs live'] };
}

/** Re-run test on a golden whose injection gate showed too little to say: its test again, which plants its payloads again, live. */
export function gateAgainAsk(name: string, golden: string): TestsAsk {
  return { title: `Re-run ${name}`, name, lead: 'Plants the same payloads in the same reads again.', doc: 'injectionTests', ok: 'Re-run', commands: [commandText(['test', golden])], parts: [INJECTION_PART] };
}

/** Re-run, or Add normalizer and re-run (or update), on a golden that diverged, as Tests offers it: by what the button runs. */
export function divergedAsk(view: Pick<TestsView, 'divergences' | 'rows'>, golden: string, run: 'rerun' | 'normalize' | 'normalize-update'): TestsAsk {
  const d = view.divergences.find((x) => x.golden === golden);
  const name = d?.name ?? view.rows.find((r) => r.path === golden)?.name ?? golden;
  if (run === 'rerun') return rerunAsk(name, golden);
  return normalizerAsk(name, d?.normalizeAndTest);
}

/** Add normalizer on a test replay's banner: the rules, then its golden's test (or its update). */
export function bannerNormalizerAsk(t: Pick<TestBannerOffer, 'normalizeAndTest' | 'golden'> | null): TestsAsk {
  return normalizerAsk(t ? goldenName(t.golden) : 'the golden', t?.normalizeAndTest);
}

/** What a session's goldens do live, as rows: those marked fork, those whose judges it asks, and the payloads it plants. */
export function liveFacts(live: readonly LiveGolden[] | undefined): FactWords[] {
  if (!live?.length) return [];
  const having = (kind: LiveGolden['why'][number]['kind']) => live.filter((g) => g.why.some((w) => w.kind === kind)).length;
  const goldens = (n: number) => `${n} ${n === 1 ? 'golden' : 'goldens'}`;
  const [fork, judged, planted] = [having('fork'), having('judges'), having('injection')];
  const models = [...new Set(live.flatMap((g) => g.why.flatMap((w) => (w.kind === 'judges' ? w.models : []))))].join(', ');
  return [
    ...(fork ? [{ label: 'Runs live', value: `${goldens(fork)} marked fork`, quiet: `from where ${fork === 1 ? 'it forks' : 'they fork'}, writes blocked` }] : []),
    ...(judged ? [{ label: 'Asks', value: judged === 1 ? 'its judges live' : 'their judges live', quiet: models }] : []),
    ...(planted ? [{ label: 'Plants', value: `the payloads of ${planted} injection ${planted === 1 ? 'gate' : 'gates'}` }] : []),
  ];
}
