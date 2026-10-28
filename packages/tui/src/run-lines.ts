import type { CallRecord, RunRecord, Store } from '@shadowlap/engine';
import { attemptsText, type Attempts } from './attempts.js';
import { forkEffects } from './fork-effects.js';
import { wrap, type RenderedLine } from './render.js';
import type { Theme } from './theme.js';
import { blameFact, blameReport, checkLine, failing, unrecordedConsequence, unrecordedName, type Tone, type Verdict } from './verdict.js';

/**
 * The inspector's run tab, how the run stands, and the second half of a fork's diff tab, what the
 * fork did differently: lines in the theme's colours, wrapped to the pane.
 */
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

function blame(out: Out, store: Store, run: RunRecord, v: Verdict, width: number, theme: Theme) {
  const id = run.runId.slice(0, 10);
  if (!run.meta?.blame) {
    if (!failing(v.outcome)) return;
    heading(out, 'Blame', theme);
    say(out, `Not blamed yet. shadowlap blame ${id} finds the model call the run was lost at.`, width, theme.dim);
    return;
  }
  heading(out, 'Blame', theme);
  const report = blameReport(store, run.runId);
  if (!report.length) say(out, blameFact(run)?.text ?? 'blamed', width);
  report.forEach((l, i) => say(out, l, width, i ? theme.dim : undefined));
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
  say(out, `Declare one in shadowlap.config.json: "tools": { "unrecorded": { "${v.unrecorded[0]!.name}": "write" } }`, width, theme.dim);
}

function attempts(out: Out, a: Attempts | null, width: number, theme: Theme) {
  if (!a) return;
  heading(out, 'Attempts', theme);
  say(out, attemptsText(a), width, a.passed === a.count ? theme.ok : a.passed ? theme.warn : theme.err);
  say(out, 'a in the runs list shows them one by one', width, theme.faint);
}

function marks(out: Out, run: RunRecord, width: number, theme: Theme) {
  heading(out, 'Labels', theme);
  const labels = run.meta?.labels ?? [];
  say(out, labels.length ? labels.join(', ') : 'none', width, labels.length ? undefined : theme.dim);
  say(out, '+ marks it good, a run a fix must keep working; - marks it bad, one to fix', width, theme.faint);
}

export function runLines(store: Store, run: RunRecord, v: Verdict, a: Attempts | null, width: number, theme: Theme): RenderedLine[] {
  const out: Out = [];
  stands(out, v, width, theme);
  checks(out, run, width, theme);
  blame(out, store, run, v, width, theme);
  fix(out, v, width, theme);
  unrecorded(out, v, width, theme);
  attempts(out, a, width, theme);
  marks(out, run, width, theme);
  return out;
}

/** What a fork did differently, under its divergence report on the diff tab. */
export function forkLines(store: Store, run: RunRecord, calls: CallRecord[], width: number, theme: Theme): RenderedLine[] {
  const fx = forkEffects(store, run, calls);
  if (!fx) return [];
  const out: Out = [];
  heading(out, 'What the fork did differently', theme);
  if (fx.most) say(out, `most: ${fx.most}`, width, theme.dim);
  if (!fx.changes.length) say(out, 'the same tool calls as its parent, and it ended the same way', width, theme.dim);
  for (const c of fx.changes) say(out, c.text, width, colorOf(theme, c.tone));
  heading(out, 'How each ended', theme);
  say(out, `parent  ${fx.ends.parent}`, width);
  say(out, `fork    ${fx.ends.fork}`, width);
  if (fx.words.parent || fx.words.fork) {
    heading(out, 'Last words', theme);
    say(out, `parent  ${fx.words.parent ?? '(none)'}`, width, theme.dim);
    say(out, `fork    ${fx.words.fork ?? '(none)'}`, width, theme.dim);
  }
  return out;
}
