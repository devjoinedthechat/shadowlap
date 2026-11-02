import { safeLine, type RunRecord } from '@shadowlap/engine';
import { allPassed, attemptsText, type AttemptTally } from './attempts.js';
import type { ForkEffects, ForkWrite } from './fork-effects.js';
import { wrap, type RenderedLine } from './render.js';
import { toneColour, type Theme } from './theme.js';
import { blameFact, checkLine, isFailing, unrecordedConsequence, unrecordedName, type Verdict } from './verdict.js';

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

/** A write's fate in the colour the dashboard's fork banner gives it: blocked, stubbed or overridden in its origin's, failed in red, what ran in ink. */
const fateColour = (theme: Theme, fate: ForkWrite['fate']) => (fate === 'failed' ? theme.err : fate === 'blocked' || fate === 'stubbed' || fate === 'overridden' ? theme.origin[fate] : undefined);

function say(out: Out, text: string, width: number, color?: string) {
  for (const t of wrap(text, width)) out.push({ text: t, ...(color ? { color } : {}) });
}

/** A part's heading, in bold ink. */
function heading(out: Out, text: string) {
  if (out.length) out.push({ text: '' });
  out.push({ text, head: true });
}

function stands(out: Out, v: Verdict, width: number, theme: Theme) {
  heading(out, 'How this run stands');
  if (!v.facts.length) say(out, 'Nothing decided yet: no checks ran on this run. shadowlap test, or a replay with --expect, checks it.', width, theme.dim);
  for (const f of v.facts) say(out, f.text, width, toneColour(theme, f.tone));
}

function checks(out: Out, run: RunRecord, width: number, theme: Theme) {
  const list = run.meta?.checks ?? [];
  if (!list.length) return;
  heading(out, 'Checks');
  for (const c of list) {
    const l = checkLine(c);
    say(out, l.text, width, toneColour(theme, l.tone));
  }
}

function blame(out: Out, run: RunRecord, f: RunFacts, width: number, theme: Theme) {
  if (!run.meta?.blame) {
    if (!isFailing(f.verdict.outcome, f.verdict.fix)) return;
    heading(out, 'Blame');
    say(out, `Not blamed yet. : then B finds the model call the run was lost at (shadowlap blame ${run.runId.slice(0, 10)}).`, width, theme.dim);
    return;
  }
  heading(out, 'Blame');
  if (!f.blame.length) say(out, blameFact(run)?.text ?? 'blamed', width);
  f.blame.forEach((l, i) => say(out, l, width, i ? theme.dim : undefined));
  say(out, 'b selects the call it was lost at', width, theme.faint);
}

function fix(out: Out, v: Verdict, width: number, theme: Theme) {
  if (!v.fix) return;
  heading(out, 'Fix');
  const f = v.fix;
  say(out, safeLine(`${f.fixId} “${f.title}”: ${f.status}`), width, f.status === 'open' ? theme.warn : theme.ok);
  // What the fork menu does for it from here, then where the rest of it is.
  const next = f.status === 'open' ? ': then R repairs it, or V verifies a change you made for it' : ': then V verifies it again';
  say(out, `${next}. shadowlap fix show ${f.fixId} has its blame, repair and verify`, width, theme.dim);
}

function unrecorded(out: Out, v: Verdict, width: number, theme: Theme) {
  if (!v.unrecorded.length) return;
  heading(out, 'Not recorded');
  for (const t of v.unrecorded) say(out, `! ${unrecordedName(t)}`, width, theme.warn);
  say(out, `They ran in the agent unseen: ${unrecordedConsequence(v.unrecorded)}.`, width, theme.dim);
  say(out, `Declare one in shadowlap.config.json: "tools": { "unrecorded": { ${JSON.stringify(v.unrecorded[0]!.name)}: "write" } }`, width, theme.dim);
}

function attempts(out: Out, tallies: AttemptTally[] | null, width: number, theme: Theme) {
  if (!tallies?.length) return;
  heading(out, 'Attempts');
  say(out, attemptsText(tallies), width, allPassed(tallies) ? theme.ok : theme.warn);
  say(out, 'a in the runs list shows them one by one', width, theme.faint);
}

function marks(out: Out, run: RunRecord, width: number, theme: Theme) {
  heading(out, 'Labels');
  const labels = run.meta?.labels ?? [];
  say(out, labels.length ? labels.join(', ') : 'none', width, labels.length ? undefined : theme.dim);
  say(out, '+ marks it good, a run a fix must keep working; - marks it bad, one to fix; again takes it off', width, theme.faint);
}

/** Every note left on the run, its calls' and its own, oldest first. */
function notes(out: Out, run: RunRecord, width: number, theme: Theme) {
  const list = run.meta?.notes ?? [];
  if (!list.length) return;
  heading(out, 'Notes');
  for (const n of list) say(out, `${n.callNo !== null ? `#${n.callNo}` : 'run'}  ${n.text}`, width);
  say(out, 'N adds one on the selected call', width, theme.faint);
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
  notes(out, run, width, theme);
  return out;
}

function changes(out: Out, fx: ForkEffects, width: number, theme: Theme) {
  heading(out, 'What the fork did differently');
  if (fx.most) say(out, `most: ${fx.most}`, width, theme.dim);
  if (!fx.changes.length) say(out, 'the same tool calls as its parent, and it ended the same way', width, theme.dim);
  for (const c of fx.changes) {
    say(out, c.detail, width, c.tone === 'write' ? theme.write : toneColour(theme, c.tone));
    if (c.before !== null) say(out, `  before  ${c.before}`, width, theme.dim);
    if (c.after !== null) say(out, `  after   ${c.after}`, width, theme.dim);
  }
  if (fx.cut) say(out, 'more tool calls than are compared here: the dashboard has them all', width, theme.faint);
}

function writes(out: Out, fx: ForkEffects, width: number, theme: Theme) {
  if (!fx.writes.length) return;
  heading(out, 'Its writes');
  for (const w of fx.writes) say(out, `#${w.callNo} ${w.tool} ${w.args} · ${w.fate}`, width, fateColour(theme, w.fate));
}

/** What a fork did differently, under its divergence report on the diff tab. */
export function forkLines(fx: ForkEffects | null, width: number, theme: Theme): RenderedLine[] {
  if (!fx) return [];
  const out: Out = [];
  changes(out, fx, width, theme);
  writes(out, fx, width, theme);
  heading(out, 'How each ended');
  say(out, `parent  ${fx.ended.parent.words}`, width, toneColour(theme, fx.ended.parent.tone));
  say(out, `fork    ${fx.ended.fork.words}`, width, toneColour(theme, fx.ended.fork.tone));
  if (fx.words.parent || fx.words.fork) {
    heading(out, 'Last words');
    say(out, `parent  ${fx.words.parent ?? '(none)'}`, width, theme.dim);
    say(out, `fork    ${fx.words.fork ?? '(none)'}`, width, theme.dim);
  }
  return out;
}
