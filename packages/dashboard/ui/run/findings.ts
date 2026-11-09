import type { ForkDifferences } from '../../src/fork-differences.js';
import type { InjectionFinding } from '../injection/model.js';
import type { Banner } from './banner.js';
import type { RunNote } from './notes.js';

/**
 * What a run's page found, as one bar (FindingsBar.tsx): the run's own finding (banner.ts), what its
 * fork did differently from its parent, what it did not record, its notes (notes.ts), and the
 * injection test kept for it (injection/model.ts), each a finding, the most telling first: a failure, then what needs a look, then the rest, each kind in
 * that order within its weight. No DOM here: the tests import it.
 */

/** How much a finding weighs: 2 a failure (red), 1 what needs a look (amber), 0 the rest. */
export type Severity = 0 | 1 | 2;

export interface Finding {
  key: string;
  kind: Banner['kind'] | 'differences' | RunNote['kind'] | 'injection';
  sev: Severity;
  /** The finding in a few words, for the card that lists the others: its label, or what it leads with. */
  says: string;
  /** Whether it has more to show under its line once the bar is open: a note's tools and hint, the fork's changes. */
  body: boolean;
  banner?: Banner;
  note?: RunNote;
  differences?: ForkDifferences;
  injection?: InjectionFinding;
}

/** The colour each weight is listed in, on the card of the others. */
export const SEVERITY_COLOURS: Readonly<Record<Severity, string>> = { 0: 'var(--cq-muted)', 1: 'var(--cq-amber)', 2: 'var(--cq-red)' };

/**
 * A banner's weight: lost, diverged, failed and not recorded are failures; a check that couldn't be
 * judged, or a blame stopped or inconclusive, needs a look. A test replay its golden passed since is
 * no failure, as Runs' Status reads it muted.
 */
export function bannerSeverity(b: Banner): Severity {
  if ((b.kind === 'diverged' || b.kind === 'failed') && b.fixedBy) return 0;
  switch (b.kind) {
    case 'diverged':
    case 'lost':
    case 'not-recorded':
      return 2;
    case 'failed':
      return b.label === 'stopped' || b.label === 'inconclusive' ? 1 : 2;
    case 'checks':
      return b.checks.some((c) => c.status === 'inconclusive') ? 1 : 0;
    default:
      return 0;
  }
}

/** A banner in a few words: its label, as the bar draws it, or what it leads with where it has none. */
export function bannerSays(b: Banner): string {
  switch (b.kind) {
    case 'preset':
      return 'forked at';
    case 'attempt':
      return b.callNo !== null ? 'forked at' : 'replayed';
    case 'diverged':
      return b.lead;
    case 'fork':
      return 'forked at';
    case 'lost':
      return b.words.split('#')[0]!.trim();
    case 'not-recorded':
      return 'not recorded';
    case 'failed':
      return b.label ?? b.lead ?? 'failed';
    default:
      return b.kind;
  }
}

const NOTE_SEVERITY: Readonly<Record<RunNote['tone'], Severity>> = { err: 2, warn: 1, n: 0 };

/** The heading the fork's differences have, as the terminal UI's section names it. */
export const DIFFERENCES_HEADING = 'What the fork did differently';

const ofBanner = (key: string, b: Banner): Finding => ({ key, kind: b.kind, sev: bannerSeverity(b), says: bannerSays(b), body: false, banner: b });

/** A kept test's weight: a failed gate a failure, one that showed too little to say a look, one that passed neither. */
const GATE_SEVERITY: Readonly<Record<InjectionFinding['gate'], Severity>> = { failed: 2, inconclusive: 1, passed: 0 };

/**
 * Every finding a run has, sorted: by weight, then in the order they come, the run's own first, then
 * what its fork did differently (once that has come), what it did not record, its notes, then the
 * injection test kept for it, so at one weight the run's own findings come before its tests'.
 */
export function runFindings(i: { own: Banner | null; differences: ForkDifferences | null; notRecorded: Banner | null; notes: readonly RunNote[]; injection?: InjectionFinding | null | undefined }): Finding[] {
  const all: Finding[] = [];
  if (i.own) all.push(ofBanner('own', i.own));
  if (i.differences) all.push({ key: 'differences', kind: 'differences', sev: 0, says: DIFFERENCES_HEADING, body: true, differences: i.differences });
  if (i.notRecorded) all.push(ofBanner('not-recorded', i.notRecorded));
  i.notes.forEach((n, at) => all.push({ key: `note:${n.kind}:${at}`, kind: n.kind, sev: NOTE_SEVERITY[n.tone], says: n.label, body: !!(n.tools?.length || n.hint), note: n }));
  if (i.injection) all.push({ key: 'injection', kind: 'injection', sev: GATE_SEVERITY[i.injection.gate], says: `${i.injection.label} ${i.injection.gate}`, body: false, injection: i.injection });
  return all.map((f, at) => ({ f, at })).sort((a, b) => b.f.sev - a.f.sev || a.at - b.at).map((x) => x.f);
}
