import type { CostWords, FactWords } from '../actions.js';
import { goldenName, num, shortId } from '../format.js';
import { commandText } from '../goldens.js';
import { divergedWhere, insteadOf, recordingCost, replacedIf, updateSteps, type UpdatePlan } from '../update-words.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { bisectBadFact, bisectCost, FLAKY_NOTE, revisionTally, type GoodChoice } from '../runspage/find-commit.js';
import type { BisectOffer, TestBannerOffer } from '../types.js';
import { bisectLabel, updatesAfterRules } from './offers.js';

/**
 * The words of the run page's dialogs that open on a press, kept off the page: Find breaking
 * commit's (RunDialogs.tsx, and its command on the fork menu's card, ForkMenu.tsx) and Update
 * golden's plan (DivergedDialogs.tsx). Only those parts import it, so find-commit.ts and
 * update-words.ts load with them, not with the page. What decides the buttons stays in offers.ts.
 */

/** A shell-quoted value, as the command lines the page shows have it. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Update golden on a test replay's page, as the Tests screen words it. `replayChecks`, how many checks
 * this replay was judged by, stands in for the golden's own from a server that doesn't send them (or
 * for a golden no longer on disk, which an update refuses).
 */
export function updateGoldenCopy(t: TestBannerOffer, callNo: number, canNormalize: boolean, replayChecks = 0): UpdatePlan {
  const v = t.volatile;
  const own = Array.isArray(t.checks) ? t.checks.length : null;
  const name = goldenName(t.golden);
  const perRun = !!v?.certain && !t.normalized;
  const run = perRun && canNormalize ? (updatesAfterRules(t) ? 'normalize-update' : 'normalize') : null;
  const instead = run ? insteadOf(run, t.normalizeAndTest ?? [], t.golden, false) : null;
  const replaced = own === null && !replayChecks ? 'Replaced only if its checks pass' : replacedIf(own ?? replayChecks);
  return {
    title: `Update ${name}?`,
    lead: `Re-records ${name}, for a change you meant.`,
    doc: 'goldenUpdates',
    facts: [],
    goldens: [{ path: t.golden, name, where: divergedWhere({ callNo, volatile: v ?? null }) }],
    steps: updateSteps(replaced, perRun ? (v?.looks ?? 'value') : null),
    advise: perRun && v ? { title: 'A normalizer fixes this for good', text: `is ${v.looks}, new every run. ${instead ? `${instead.label} masks it first.` : 'Updating re-records it, and the next run diverges again.'}`, path: v.path } : null,
    instead,
    note: null,
    command: commandText(['test', t.golden, '--update']),
    cost: recordingCost(true),
    ok: perRun ? 'Update anyway' : confirmWords(ACTIONS.updateGolden.label),
  };
}

export interface BisectCopy {
  title: string;
  /** Its confirm: the menu item's name without the ellipsis. */
  ok: string;
  lead: string;
  /** Good commit, or Start from for a run that passed. */
  label: string;
  /** The revisions to pick from, newest first, each with how its runs went; any other is accepted too. */
  choices: GoodChoice[];
  initial: string;
  facts: FactWords[];
  cost: CostWords;
  /** What one live replay can't settle, for a fork. */
  note: string | null;
  /** The command with a good commit filled in. */
  command: (good: string) => string;
}

/**
 * What the server may add to Find breaking commit's choices: each commit's subject, from the project's git
 * (`c91d0f4 · Escalate refunds above the limit`), and the check each replay is judged by, for a run
 * blame found failing one though it exited 0 (`--expect`).
 */
type BisectFrom = Omit<BisectOffer, 'revisions'> & { revisions: ReadonlyArray<BisectOffer['revisions'][number] & { subject?: string | null }>; expect?: Record<string, unknown> | null };

/** The command Find breaking commit runs from `good`: what it searches (a run, or the golden a test replay came from), up to which commit, and how each is judged. */
function bisectLine(b: BisectFrom, good: string): string {
  const target = b.target.kind === 'golden' ? b.target.golden : shortId(b.target.runId);
  const expect = b.expect && Object.keys(b.expect).length ? ` --expect ${quote(JSON.stringify(b.expect))}` : '';
  return `shadowlap bisect ${target} --good ${good}${b.bad ? ` --bad ${b.bad}` : ''}${expect}${b.fork ? ' --fork' : ''}`;
}

/** Find breaking commit's command for its hover card, before its dialog asks for a commit: from the one the server knows, else `<commit>`. */
export const bisectCardCommand = (offer: BisectOffer): string => `$ ${bisectLine(offer, offer.good ?? '<commit>')}`;

/**
 * Find breaking commit's dialog, from what the server offers: a run that failed looks for where it
 * started failing, from a commit where it still worked up to its own; one that passed, for the first
 * commit after its own that changes what it does. Replays are free unless they run live past where
 * they differ. Each commit is named by its subject when the server knows it, as the design does.
 */
export function bisectCopy(runId: string, offer: BisectOffer): BisectCopy {
  const b = offer as BisectFrom;
  const target = b.target.kind === 'golden' ? b.target.golden : shortId(b.target.runId);
  const whose = b.target.kind === 'golden' ? target : 'the run';
  const runs = (r: { runs: number }) => `${r.runs === 1 ? '1 run' : `${num(r.runs)} runs`} of its command`;
  const choices: GoodChoice[] = b.revisions.map((r) => ({ value: r.rev, subject: r.subject ?? null, how: `${runs(r)} · ${revisionTally(r)}` }));
  if (b.good && !choices.some((c) => c.value === b.good)) choices.unshift({ value: b.good, subject: null, how: b.failed ? 'where it last passed' : 'this run' });
  return {
    title: b.failed ? `Find breaking commit for ${shortId(runId)}` : `Find commit that changed ${shortId(runId)}`,
    ok: confirmWords(bisectLabel(b).label),
    lead: b.failed ? `Finds the first commit that broke ${whose}, from one where it worked.` : `Finds the first commit after its own that changed what ${whose === 'the run' ? 'the run does' : `${whose} does`}.`,
    label: b.failed ? 'Good commit' : 'Start from',
    choices,
    initial: b.good ?? choices[0]?.value ?? '',
    facts: b.failed ? [bisectBadFact(b)] : [],
    cost: bisectCost(b),
    note: b.fork ? FLAKY_NOTE : null,
    command: (good) => bisectLine(b, !good || good === '…' ? '…' : quote(good)),
  };
}
