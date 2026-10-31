import { consentAsked } from './actions.js';
import type { JobView } from './api.js';
import { commandText } from './goldens.js';
import type { TestBannerOffer, TestsView } from './types.js';

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
  ok: string;
  /** Each command as a person would type it (`shadowlap test goldens/*`); none where the page that starts it doesn't know them exactly. */
  commands?: readonly string[];
}

/** The question a job waits on: the server's words and `confirm`, and the job to send again once it is answered. */
export interface TestsQuestion extends TestsAsk {
  why: string;
  confirm: string;
  kind: string;
  fields: Record<string, unknown>;
}

/** What starting a job needs of the app (`AppState`). */
export interface TestsJobApp {
  client: { startJob(kind: string, fields: Record<string, unknown>): Promise<JobView> };
  guard(fn: () => void): void;
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
 * (`consentAsked`) waits as the question, with `say`'s title, button and commands; a job started
 * without them shows it as any refusal, in its drawer, as does a second question to a job that
 * already sent a yes (a session that changed under it: asked again in its own words, never in a loop).
 */
export function startTestsJob(app: TestsJobApp, kind: string, fields: Record<string, unknown>, say?: TestsAsk): void {
  app.guard(() => {
    void app.client.startJob(kind, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked && say) ask({ ...say, ...asked, kind, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  });
}

/** The answer to the question waiting: yes sends its job again with its `confirm`; no drops it, and nothing runs. */
export function answerTestsQuestion(app: TestsJobApp, yes: boolean): void {
  const q = asking;
  ask(null);
  if (q && yes) startTestsJob(app, q.kind, { ...q.fields, yes: q.confirm }, q);
}

// ---- what each button's question says ----

/** Run tests: every golden, as the page's command runs them. The palette, which doesn't list the goldens, names no command. */
export function runTestsAsk(view?: Pick<TestsView, 'commands'> | null): TestsAsk {
  return { title: 'Run tests', ok: 'Run tests', ...(view ? { commands: [commandText(view.commands.run)] } : {}) };
}

/** Run more attempts on a golden whose gate ran out of them, with the command the page shows on its hover. */
export function moreAttemptsAsk(name: string, args: readonly string[]): TestsAsk {
  return { title: `Run more attempts on ${name}`, ok: 'Run more attempts', commands: [commandText(args)] };
}

/** What a normalizer's job is called by its steps: it updates the golden after the rules when its last step re-records it. */
const normalizerLabel = (steps: readonly (readonly string[])[] | null | undefined) => ((steps?.at(-1) ?? []).includes('--update') ? 'Add normalizer and update' : 'Add normalizer and re-run');

/** Re-run, or Add normalizer and re-run (or update), on a golden that diverged, as Tests offers it: by what the button runs. */
export function divergedAsk(view: Pick<TestsView, 'divergences' | 'rows'>, golden: string, run: 'rerun' | 'normalize' | 'normalize-update'): TestsAsk {
  const d = view.divergences.find((x) => x.golden === golden);
  const name = d?.name ?? view.rows.find((r) => r.path === golden)?.name ?? golden;
  if (run === 'rerun') return { title: `Re-run ${name}`, ok: 'Re-run', commands: [commandText(['test', golden])] };
  const label = normalizerLabel(d?.normalizeAndTest);
  return { title: label, ok: label, commands: (d?.normalizeAndTest ?? []).map(commandText) };
}

/** Add normalizer on a test replay's banner: the rules, then its golden's test (or its update). */
export function bannerNormalizerAsk(t: Pick<TestBannerOffer, 'normalizeAndTest'> | null): TestsAsk {
  const label = normalizerLabel(t?.normalizeAndTest);
  return { title: label, ok: label, commands: (t?.normalizeAndTest ?? []).map(commandText) };
}
