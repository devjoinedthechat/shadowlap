import { updatePart } from '../../engine/src/cost-words.js';
import type { CostWords, FactWords } from './actions.js';
import type { DocKey } from './docs-links.js';
import { commandText, divergenceButtons, n } from './goldens.js';
import { ACTIONS, confirmWords } from './labels.js';
import type { DivergenceView, TestsView } from './types.js';

/**
 * What Update golden says, on Tests and on a test replay's page, and from the apply drawer: the pages'
 * words, so the first look doesn't load them. No DOM here: the tests import it.
 */

export interface UpdatePlan {
  title: string;
  lead: string;
  doc: DocKey;
  /** What a judge's update decides by: what the pack holds, and whose key asks it. */
  facts: FactWords[];
  /** The golden as a row, or the diverged goldens as a list; none when the title names the one golden and nothing diverged. */
  goldens: Array<{ path: string; name: string; where: string }>;
  steps: Array<[string, string]>;
  /**
   * The advice: a value that changes every run diverged and no rule masks it yet, so a normalizer is
   * the lasting fix; or, for one golden, the rule for it is in the config now and alone makes the
   * replay match, so a re-run passes without an update; or a judge's verdict in the pack was given on
   * other material, which a value that changes every run would make again, so its normalizer comes first.
   */
  advise: { title: string; text: string; path: string | null } | null;
  /** The lime way on beside it, named for what it runs, with its command and what it bills: null when the server runs none of it, or there is none. */
  instead: OneInstead | SeveralInstead | null;
  /** A plain line above the command, a path set in code: several goldens' rules are in the config already, so a re-run is the fix. */
  note: Array<string | { code: string }> | null;
  command: string;
  cost: CostWords;
  ok: string;
}

/** One golden's way on beside Update anyway: its normalizer and a re-run, its normalizer and the update, or a re-run. */
export interface OneInstead {
  label: string;
  golden: string;
  run: 'normalize' | 'normalize-update' | 'rerun';
  command: readonly string[];
  cost: CostWords;
}

/**
 * Several goldens': Add normalizer and update, one job (`test-update` with `normalize`) that adds the
 * rules the server found for them, then updates them all. It bills what the update does, which the
 * line under Update anyway says for both.
 */
export interface SeveralInstead {
  label: string;
  goldens: readonly string[];
  run: 'normalize-update-all';
  command: readonly string[];
  cost: null;
}

/** The amber box's button, by what it runs in place of the update. */
const INSTEAD: Record<OneInstead['run'], string> = {
  normalize: ACTIONS.addNormalizerAndRerun.label,
  // The rule alone can't make the replay match: it is added, and the golden updated after it.
  'normalize-update': ACTIONS.addNormalizerAndUpdate.label,
  rerun: 'Re-run instead',
};

/** An update's confirm, by how many goldens it re-records: `Update golden`, `Update 2 goldens`. */
const updateOk = (goldens: number): string => (goldens === 1 ? confirmWords(ACTIONS.updateGolden.label) : `Update ${goldens} goldens`);

/** Whether the rules alone can't make the replay match, so the golden is updated after them. */
const updatesAfterRules = (d: DivergenceView) => !!d.normalizeAndTest && (d.normalizeAndTest.at(-1) ?? []).includes('--update');

/** What re-recording bills: until a price is known, who bills it. */
export const recordingCost = (one: boolean): CostWords => ({ price: 'Billed by your provider', parts: [updatePart(one, false)] });

/** An update's cost line, or its estimate's, where several goldens' normalizer and update bills the same: `either way, as their recordings cost`. */
export const eitherWay = <T extends { parts?: readonly string[] }>(cost: T): T => ({ ...cost, parts: (cost.parts ?? []).map((p, i) => (i ? p : `either way, ${p}`)) });

/** Its checks, as the step that replaces it says them: an update is kept only if they pass, or with none, if it exits 0. */
export const replacedIf = (checks: number) => (checks === 0 ? 'Replaced only if it exits 0' : checks === 1 ? 'Replaced only if its check passes' : `Replaced only if its ${n(checks, 'check')} pass`);

/** Re-recorded, kept only if it passes, replayed as the next test will, and reviewed. */
export function updateSteps(replaced: string, diverges: string | null): Array<[string, string]> {
  return [
    ['Re-recorded live', 'writes stubbed'],
    [replaced, 'in your working tree'],
    ['Replayed offline, as the next test will', diverges ? `a new ${diverges.replace(/^an? /, '')} diverges again` : 'it should replay clean'],
    ['You review the change', 'in your pull request'],
  ];
}

/** Where a golden diverged, as a row says it: the call, and the path where one value did. */
export const divergedWhere = (d: { callNo: number; volatile: { path: string } | null }) => (d.volatile?.path ? `#${d.callNo} ~ ${d.volatile.path}` : `diverged at call ${d.callNo}`);

/**
 * The lime way on beside Update anyway: what it runs, and what that bills. A re-run after the rules
 * replays offline, unless the golden may fork; one whose last step updates it re-records.
 */
export function insteadOf(run: OneInstead['run'], steps: readonly (readonly string[])[], golden: string, fork: boolean): OneInstead {
  const lines = (run === 'rerun' ? steps.slice(-1) : steps).map((c) => commandText(c));
  const cost: CostWords = run === 'normalize-update' ? recordingCost(true) : fork ? { price: 'Billed by your provider', parts: ['live from where it forks'] } : { price: 'Free', parts: ['replays offline'] };
  return { label: INSTEAD[run], golden, run, command: lines, cost };
}

/** The advice beside one golden's update: its normalizer, the lasting fix; or a re-run, once that alone makes the replay match. */
function oneGoldenAdvice(d: DivergenceView, perRun: boolean, rerun: boolean, has: (kind: string) => boolean, fork: boolean): Pick<UpdatePlan, 'advise' | 'instead' | 'note'> {
  const v = d.volatile;
  const button = perRun || rerun ? divergenceButtons(d, has).normalize?.run : undefined;
  const instead = button ? insteadOf(button, d.normalizeAndTest ?? [], d.golden, fork) : null;
  if (perRun && v) return { advise: { title: 'A normalizer fixes this for good', text: `is ${v.looks}, new every run. ${instead ? `${instead.label} masks it first.` : 'Updating re-records it, and the next run diverges again.'}`, path: v.path }, instead, note: null };
  return { advise: rerun ? { title: 'Its normalizer is in the config now', text: 'is masked by a rule added since this replay, so a re-run passes without an update.', path: v?.path ?? null } : null, instead, note: null };
}

/**
 * The advice beside several goldens' update: which diverged on values new every run, and which a re-run
 * would pass. Where the server runs it, Add normalizer and update masks the values first, the rules it
 * names for each golden (`newRules`) each once, then updates them all; without it, the advice says
 * the next run diverges again.
 */
function severalAdvice(paths: readonly string[], ds: readonly DivergenceView[], perRun: readonly DivergenceView[], rerun: readonly DivergenceView[], has: (kind: string) => boolean): Pick<UpdatePlan, 'advise' | 'instead' | 'note'> {
  const masks = has('test-update') ? ds.filter((d) => d.newRules?.length) : [];
  const them = (list: readonly unknown[]) => (list.length === 1 ? 'it' : 'them');
  const note: UpdatePlan['note'] = rerun.length ? [`The normalizers for ${rerun.map((d) => d.name).join(', ')} are in shadowlap.config.json now: a re-run passes without updating ${them(rerun)}.`] : null;
  if (!masks.length) {
    const names = perRun.map((d) => d.name).join(', ');
    return { advise: perRun.length ? { title: 'A normalizer fixes this for good', text: `${names} diverged on values that change every run. Updating re-records ${them(perRun)}, and the next run diverges again.`, path: null } : null, instead: null, note };
  }
  const label = ACTIONS.addNormalizerAndUpdate.label;
  const values = masks.length === 1 ? 'a value that is new every run' : 'values that are new every run';
  const rules = [...new Set(masks.flatMap((d) => (d.newRules ?? []).map((r) => commandText(r))))];
  return {
    advise: { title: 'A normalizer fixes this for good', text: `${masks.map((d) => d.name).join(', ')} diverged on ${values}. ${label} masks ${them(masks)} first.`, path: null },
    instead: { label, goldens: [...paths], run: 'normalize-update-all', command: [...rules, commandText(['test', ...paths, '--update'])], cost: null },
    note,
  };
}

/**
 * Update golden: the golden as a row (or the diverged goldens as a list), What happens as numbered
 * rows, the advice when what diverged is a value that changes every run, and the command. `paths` are
 * the goldens to update; `has` says which jobs the server runs, for the advice's way on. A divergence
 * whose rules are in the config already (added since, for this golden or another) gets no advice that
 * a normalizer would fix it: an update is the fix then, or, when the rules alone make it match, a re-run.
 */
export function updatePlan(view: TestsView, paths: readonly string[], has: (kind: string) => boolean = () => true): UpdatePlan {
  // A golden whose replay is clean and only lacks a judge's verdict: the update asks the judge once and re-records nothing.
  const judged = paths.length === 1 ? judgePlan(view, paths[0]!) : null;
  if (judged) return judged;
  const ds = paths.map((p) => view.divergences.find((d) => d.golden === p)).filter((d): d is DivergenceView => !!d);
  const rows = paths.map((p) => view.rows.find((r) => r.path === p));
  const goldens = paths.map((p, i) => {
    const d = ds.find((x) => x.golden === p);
    return { path: p, name: rows[i]?.name ?? p, where: d ? divergedWhere(d) : (rows[i]?.last.line ?? '') };
  });
  const one = goldens.length === 1;
  // A value that changes every run, with no rule for it yet: updating alone diverges again next run.
  const perRun = ds.filter((d) => d.volatile?.certain && !d.rulesAdded);
  // Its rules are in the config now: alone they make the replay match.
  const rerun = ds.filter((d) => d.rulesAdded && !!d.normalizeAndTest && !updatesAfterRules(d));
  const d0 = one ? (ds[0] ?? null) : null;
  const said = d0 ? oneGoldenAdvice(d0, perRun.includes(d0), rerun.includes(d0), has, rows[0]?.mode === 'fork') : one ? { advise: null, instead: null, note: null } : severalAdvice(paths, ds, perRun, rerun, has);
  const { advise, instead, note } = said;
  const replaced = one ? replacedIf(rows[0]?.checks.length ?? 0) : 'Each replaced only if its checks pass';
  // Several masked first: updating anyway leaves a value that diverges again, and either way bills the same.
  const masked = instead?.run === 'normalize-update-all';
  return {
    title: one ? `Update ${goldens[0]!.name}?` : `Update ${goldens.length} diverged goldens?`,
    lead: `${one ? `Re-records ${goldens[0]!.name}` : `Re-records the ${goldens.length} goldens`}, for a change you meant.`,
    doc: 'goldenUpdates',
    facts: [],
    goldens,
    steps: updateSteps(replaced, perRun.length || masked ? (one ? (perRun[0]!.volatile?.looks ?? 'value') : 'value') : null),
    advise,
    instead,
    note,
    command: commandText(['test', ...paths, '--update']),
    cost: masked ? eitherWay(recordingCost(one)) : recordingCost(one),
    ok: advise ? 'Update anyway' : updateOk(goldens.length),
  };
}

/**
 * Update golden for a golden that replays offline and is inconclusive only for want of a judge's
 * verdict it could use, as the mock's dialog has it: no row (nothing diverged, and the title names
 * the golden), its replay is clean, so nothing is re-recorded; the judge is asked once, live, with its
 * provider's key where the dashboard runs, and its verdict is kept in the pack, which you review. What
 * the pack holds says the rest: no verdict, one given to an older form of the judge's request, or one
 * given on other material, where the advice says that a value that changes every run needs its
 * normalizer first, or the next test reads not judged again. Null for any other golden.
 */
function judgePlan(view: TestsView, path: string): UpdatePlan | null {
  const v = view.inconclusive.find((x) => x.golden === path);
  const j = v?.judge;
  if (!v || !j?.update) return null;
  const material = j.held === 'material';
  return {
    title: `Update ${v.name}?`,
    lead: 'Asks its judge once and keeps the verdict in the pack; nothing is re-recorded.',
    doc: 'judgeChecks',
    facts: [
      { label: 'Holds', value: j.held === 'older' ? 'a verdict given to an older form of the judge’s request' : material ? 'a verdict given on other material' : 'no verdict' },
      { label: 'Key', value: j.provider ? `the ${PROVIDER_KEY[j.provider] ?? j.provider} key` : 'the key', quiet: 'in the dashboard’s environment' },
    ],
    goldens: [],
    steps: [
      ['Replayed offline, as recorded', 'clean'],
      ['Its judge asked once, live', j.model],
      ['Its verdict kept in the pack', material ? 'for what it reads now' : 'the next test judges from it, free'],
      ['You review the change', 'in your pull request'],
    ],
    advise: material ? { title: 'A value that changes every run needs a normalizer', text: `${j.changed ? `What the judge reads changed: ${j.changed}. ` : ''}If that is such a value (an id the agent prints, say), add a normalizer for it first: a verdict given on one run’s value answers no other, and the next test reads not judged again.`, path: null } : null,
    instead: null,
    note: null,
    command: commandText(j.update),
    cost: { price: 'Billed by your provider', parts: [updatePart(true, true)] },
    ok: material ? 'Update anyway' : updateOk(1),
  };
}

/** Whose key a judge's provider is asked with. */
const PROVIDER_KEY: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' };

