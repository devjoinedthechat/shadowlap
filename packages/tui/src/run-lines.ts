import type { RunRecord } from '@shadowlap/engine';
import { allPassed, attemptsText, type AttemptTally } from './attempts.js';
import type { ForkEffects } from './fork-effects.js';
import { wrap, type RenderedLine } from './render.js';
import type { Theme } from './theme.js';
import { blameFact, checkLine, isFailing, unrecordedConsequence, unrecordedName, type Tone, type Verdict } from './verdict.js';

/**
 * The inspector's verdict tab, how the run stands, and the second half of a fork's diff tab, what
 * the fork did differently: lines in the theme's colours, wrapped to the pane. What they show is
 * worked out once a run (`RunFacts`), not each time the pane draws.
 */
export interface RunFacts {
  verdict: Verdict;
  attempts: AttemptTally[] | null;
  /** Blame's whole report, as `shadowlap blame` printed it, from the run's last blame. */
  blame: string[];
  fork: ForkEffects | null;
}

type Out = RenderedLine[];

const colorOf = (theme: Theme, tone: Tone) => (tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'err' ? theme.err : undefined);

function say(out: Out, text: string, width: number, color?: string) {
  for (const t of wrap(text, width)) out.push({ text: t, ...(color ? { color } : {}) });
}

function heading(out: Out, text: string, theme: Theme) {
  if (out.length) out.push({ text: '' });
  out.push({ text, color: theme.accent, head: true });
}

function stands(out: Out, v: Verdict, width: number, theme: Theme) {
  heading(out, 'How this run stands', theme);
  if (!v.facts.length) say(out, 'Nothing decided yet: no checks ran on this run. shadowlap test, or a replay with --expect, checks it.', width, theme.dim);
  for (const f of v.facts) say(out, f.text, width, colorOf(theme, f.tone));
}

function checks(out: Out, run: RunRecord, width: number, theme: Theme) {
  const list = run.meta?.checks ?? [];
  if (!list.length) return;
  heading(out, 'Checks', theme);
  for (const c of list) {
    const l = checkLine(c);
    say(out, l.text, width, colorOf(theme, l.tone));
  }
}

function blame(out: Out, run: RunRecord, f: RunFacts, width: number, theme: Theme) {
  if (!run.meta?.blame) {
    if (!isFailing(f.verdict.outcome, f.verdict.fix)) return;
    heading(out, 'Blame', theme);
    say(out, `Not blamed yet. shadowlap blame ${run.runId.slice(0, 10)} finds the model call the run was lost at.`, width, theme.dim);
    return;
  }
  heading(out, 'Blame', theme);
  if (!f.blame.length) say(out, blameFact(run)?.text ?? 'blamed', width);
  f.blame.forEach((l, i) => say(out, l, width, i ? theme.dim : undefined));
  say(out, 'b selects the call it was lost at', width, theme.faint);
}

function fix(out: Out, v: Verdict, width: number, theme: Theme) {
  if (!v.fix) return;
  heading(out, 'Fix', theme);
  const f = v.fix;
  say(out, `${f.fixId} “${f.title}”: ${f.status}`, width, f.status === 'open' ? theme.warn : theme.ok);
  say(out, `shadowlap fix show ${f.fixId} has its blame, repair and verify`, width, theme.dim);
}

function unrecorded(out: Out, v: Verdict, width: number, theme: Theme) {
  if (!v.unrecorded.length) return;
  heading(out, 'Not recorded', theme);
  for (const t of v.unrecorded) say(out, `! ${unrecordedName(t)}`, width, theme.warn);
  say(out, `They ran in the agent unseen: ${unrecordedConsequence(v.unrecorded)}.`, width, theme.dim);
  say(out, `Declare one in shadowlap.config.json: "tools": { "unrecorded": { ${JSON.stringify(v.unrecorded[0]!.name)}: "write" } }`, width, theme.dim);
}

function attempts(out: Out, tallies: AttemptTally[] | null, width: number, theme: Theme) {
  if (!tallies?.length) return;
  heading(out, 'Attempts', theme);
  say(out, attemptsText(tallies), width, allPassed(tallies) ? theme.ok : theme.warn);
  say(out, 'a in the runs list shows them one by one', width, theme.faint);
}

function marks(out: Out, run: RunRecord, width: number, theme: Theme) {
  heading(out, 'Labels', theme);
  const labels = run.meta?.labels ?? [];
  say(out, labels.length ? labels.join(', ') : 'none', width, labels.length ? undefined : theme.dim);
  say(out, '+ marks it good, a run a fix must keep working; - marks it bad, one to fix; again takes it off', width, theme.faint);
}

export function runLines(run: RunRecord, f: RunFacts, width: number, theme: Theme): RenderedLine[] {
  const out: Out = [];
  stands(out, f.verdict, width, theme);
  checks(out, run, width, theme);
  blame(out, run, f, width, theme);
  fix(out, f.verdict, width, theme);
  unrecorded(out, f.verdict, width, theme);
  attempts(out, f.attempts, width, theme);
  marks(out, run, width, theme);
  return out;
}

function changes(out: Out, fx: ForkEffects, width: number, theme: Theme) {
  heading(out, 'What the fork did differently', theme);
  if (fx.most) say(out, `most: ${fx.most}`, width, theme.dim);
  if (!fx.changes.length) say(out, 'the same tool calls as its parent, and it ended the same way', width, theme.dim);
  for (const c of fx.changes) {
    say(out, c.detail, width, colorOf(theme, c.tone));
    if (c.before !== null) say(out, `  before  ${c.before}`, width, theme.dim);
    if (c.after !== null) say(out, `  after   ${c.after}`, width, theme.dim);
  }
  if (fx.cut) say(out, 'more tool calls than are compared here: the dashboard has them all', width, theme.faint);
}

function writes(out: Out, fx: ForkEffects, width: number, theme: Theme) {
  if (!fx.writes.length) return;
  heading(out, 'Its writes', theme);
  for (const w of fx.writes) say(out, `#${w.callNo} ${w.tool} ${w.args} · ${w.fate}`, width, w.fate === 'live' || w.fate === 'failed' ? theme.warn : theme.ok);
}

/** What a fork did differently, under its divergence report on the diff tab. */
export function forkLines(fx: ForkEffects | null, width: number, theme: Theme): RenderedLine[] {
  if (!fx) return [];
  const out: Out = [];
  changes(out, fx, width, theme);
  writes(out, fx, width, theme);
  heading(out, 'How each ended', theme);
  say(out, `parent  ${fx.ended.parent.words}`, width, colorOf(theme, fx.ended.parent.tone));
  say(out, `fork    ${fx.ended.fork.words}`, width, colorOf(theme, fx.ended.fork.tone));
  if (fx.words.parent || fx.words.fork) {
    heading(out, 'Last words', theme);
    say(out, `parent  ${fx.words.parent ?? '(none)'}`, width, theme.dim);
    say(out, `fork    ${fx.words.fork ?? '(none)'}`, width, theme.dim);
  }
  return out;
}
