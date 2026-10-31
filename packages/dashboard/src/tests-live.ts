import { askConsent, saidYes, testsEntryFor } from '@shadowlap/engine';
import type { GoldenSource, TestsJob } from './tests.js';

/**
 * What a Tests job runs live, so that it asks before it does. `shadowlap test` replays a golden
 * offline, at no cost, but for what its tests entry may give it: a golden marked `fork` runs live
 * from where its replay forks, asking its judge checks live too, and an injection gate runs live from
 * each payload it plants. Until Spending decides it by the job's estimate, a job that would run any
 * of them answers 409 with the question (`liveAsk`): the goldens that go live and why, and the
 * `confirm` of the lines it names, which the request sends back as `yes`. A job that only replays
 * starts at once, whatever `yes` it sent.
 *
 * Re-recording a golden that diverged (`--update`) runs live too: Update golden and Add normalizer
 * and update say so in their own dialogs before they send the job, so that alone asks nothing here.
 */

/** Why a golden goes live in a test session, by what its tests entry says. */
export type LiveReason = { kind: 'fork' } | { kind: 'judges'; models: string[] } | { kind: 'injection' };

/** A golden a session runs live, and why. */
export interface LiveGolden {
  path: string;
  why: LiveReason[];
}

/**
 * Why `shadowlap test` runs a golden live: none for one that only replays, or whose pack can't be
 * read (its test fails before anything runs). A judge with no verdict for a new answer is asked
 * live, which only a golden that forks gives it.
 */
export function liveReasons(g: GoldenSource): LiveReason[] {
  if (g.error) return [];
  const why: LiveReason[] = [];
  if (g.mode === 'fork') why.push({ kind: 'fork' });
  if (g.mode === 'fork' && g.judges?.length) why.push({ kind: 'judges', models: [...new Set(g.judges)] });
  if (g.injection) why.push({ kind: 'injection' });
  return why;
}

/** The flags of a `test` command the dashboard builds that take a value: the value is no golden. */
const VALUED = new Set(['--max-attempts']);

/** Where the goldens' paths are resolved to be compared: any folder will do, the paths being relative to the same one. */
const ROOT = '/';

/**
 * The goldens a `test` command line runs: each it names, and each a pattern in it matches
 * (`goldens/*`), as the CLI expands one: its `*` within the last part only (the engine's
 * `testsEntryFor`, which matches a tests entry the same way).
 */
export function testedGoldens(goldens: readonly GoldenSource[], args: readonly string[]): GoldenSource[] {
  if (args[0] !== 'test') return [];
  const named: Array<{ recording: string }> = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) named.push({ recording: a });
    else if (VALUED.has(a)) i++;
  }
  return named.length ? goldens.filter((g) => testsEntryFor(named, g.path, ROOT) !== null) : [];
}

/** A job's command lines, after `shadowlap`: the one it runs, or each of its steps. */
const commandsOf = (job: Exclude<TestsJob, { error: string }>): string[][] => ('args' in job ? [job.args] : job.steps);

/** What a Tests job runs live: each golden its `test` commands run that goes live, with why, in the order the goldens are listed. */
export function liveGoldens(goldens: readonly GoldenSource[], job: TestsJob): LiveGolden[] {
  if ('error' in job) return [];
  const tested = new Set(commandsOf(job).flatMap((c) => testedGoldens(goldens, c)));
  return goldens.flatMap((g) => {
    const why = tested.has(g) ? liveReasons(g) : [];
    return why.length ? [{ path: g.path, why }] : [];
  });
}

/** A reason as the question's lines name it: what a yes is to. */
const reasonLine = (w: LiveReason): string => (w.kind === 'judges' ? `judges ${w.models.join(',')}` : w.kind);

/**
 * The question a Tests job asks before it runs anything live (the engine's askConsent): its words
 * name the goldens that go live and why, and its `confirm` is to the job's command lines and those
 * goldens with their reasons, so a yes to it runs no other session. Null when the job runs nothing
 * live, or the request said yes to this very question.
 */
export function liveAsk(goldens: readonly GoldenSource[], job: TestsJob, yes: unknown): { error: string; status: 409; confirm: string } | null {
  if ('error' in job) return null;
  const live = liveGoldens(goldens, job);
  if (!live.length) return null;
  const lines = [...commandsOf(job).map((c) => ['shadowlap', ...c]), ...live.map((g) => [g.path, ...g.why.map(reasonLine)])];
  return saidYes(yes, lines) ? null : askConsent(liveWords(live), lines);
}

/** Up to three of them by name, then how many more: `a`, `a and b`, `a, b and c`, `a, b, c and 4 more`. */
function names(paths: readonly string[]): string {
  if (paths.length > 3) return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
  return paths.length > 1 ? `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)!}` : (paths[0] ?? '');
}

/** One golden's words, or several's. */
const one = (goldens: readonly LiveGolden[], it: string, they: string): string => `${names(goldens.map((g) => g.path))} ${goldens.length === 1 ? it : they}`;

/**
 * The question's words, a clause for each reason naming its goldens: `evals/x is marked fork, so it
 * runs live from where it forks; goldens/y has an injection gate, which runs live from each payload
 * it plants. Live calls are billed by your provider. Confirm it to run it`. A fork's judges are said
 * in its clause when every fork has them (`…, asking its judges live (claude-haiku-4-5)`), else apart.
 */
function liveWords(live: readonly LiveGolden[]): string {
  const having = (kind: LiveReason['kind']) => live.filter((g) => g.why.some((w) => w.kind === kind));
  const [fork, judged, injected] = [having('fork'), having('judges'), having('injection')];
  const models = [...new Set(judged.flatMap((g) => g.why.flatMap((w) => (w.kind === 'judges' ? w.models : []))))].join(', ');
  const asking = judged.length && judged.length === fork.length ? `, asking ${fork.length === 1 ? 'its' : 'their'} judges live (${models})` : '';
  const clauses = [
    fork.length ? `${one(fork, 'is marked fork, so it runs live from where it forks', 'are marked fork, so they run live from where they fork')}${asking}` : null,
    judged.length && !asking ? one(judged, `asks its judges live (${models})`, `ask their judges live (${models})`) : null,
    injected.length ? one(injected, 'has an injection gate, which runs live from each payload it plants', 'have injection gates, which run live from each payload they plant') : null,
  ];
  return `${clauses.filter((c) => c !== null).join('; ')}. Live calls are billed by your provider. Confirm it to run it`;
}
