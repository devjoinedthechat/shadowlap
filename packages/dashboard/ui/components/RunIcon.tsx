import { runGlyph, type GlyphKind, type RunLike } from '../runs.js';
import { tipText } from './HoverCard.js';
import { Icon } from './Icon.js';

/**
 * One set of icons for runs and events, each with the same words beside it or on hover: a pulsing
 * dot (recording now), a ring (recording), a crossed circle (failed), replay (clean, in the replayed
 * colour, or plain), fork, import (capture) and tests, amber where a test was inconclusive (the kind
 * `warn`, as the server sends it); events add
 * Fixes (the loop: lime accepted, red rejected, amber inconclusive), a folder (project), sliders
 * (settings) and a target (training). An event's shape says what it was and its colour how it came
 * out (`outcome`): red what failed, amber what couldn't decide, stopped or needs a look.
 */

export const EVENT_LABEL: Record<GlyphKind, string> = {
  live: 'Recording',
  rec: 'Recorded',
  fail: 'Failed',
  warn: 'Inconclusive',
  clean: 'Clean replay',
  replay: 'Replay',
  fork: 'Fork',
  cap: 'Imported',
  test: 'Test',
  blame: 'Blame',
  fixok: 'Fix accepted',
  fixbad: 'Fix rejected',
  fixinc: 'Fix inconclusive',
  retire: 'Model retires',
  project: 'Project',
  setting: 'Settings',
  train: 'Training',
};

function Mark({ kind }: { kind: GlyphKind }) {
  switch (kind) {
    case 'live':
      return <i />;
    case 'rec':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="4.75" />
        </svg>
      );
    case 'fail':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.75" />
          <path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8" />
        </svg>
      );
    case 'clean':
    case 'replay':
      return <Icon name="replay" />;
    case 'fork':
      return <Icon name="fork" />;
    case 'cap':
      return <Icon name="import" />;
    case 'test':
    case 'warn':
      return <Icon name="tests" />;
    case 'blame':
    case 'fixok':
    case 'fixbad':
    case 'fixinc':
      return <Icon name="loop" />;
    case 'project':
      return <Icon name="folder" />;
    case 'setting':
      return <Icon name="gear" />;
    case 'train':
      return <Icon name="target" />;
    case 'retire':
      return <Icon name="clock" />;
  }
}

/** An icon with its words on hover and for screen readers. `done` stops a recording's dot pulsing. */
export function Glyph({ kind, label, className = '', done = false }: { kind: GlyphKind; label: string; className?: string; done?: boolean }) {
  return (
    <span className={`glyph ${kind}${className ? ` ${className}` : ''}${done ? ' done' : ''}`} role="img" aria-label={label} data-tip={tipText(label)}>
      <Mark kind={kind} />
    </span>
  );
}

export function RunIcon({ run, className = 'ri' }: { run: RunLike; className?: string }) {
  const g = runGlyph(run);
  return <Glyph kind={g.kind} label={g.label} className={className} />;
}

/**
 * An activity or Needs-a-look entry's icon, its colour how it came out where that differs from its
 * kind's: `err` red, `warn` amber (a stopped blame is the loop in amber). A "Recording started" entry
 * stops pulsing once the run ends.
 */
export function EventIcon({ kind, live = false, outcome, className = 'ic' }: { kind: GlyphKind; live?: boolean; outcome?: 'err' | 'warn' | undefined; className?: string }) {
  const tone = outcome === 'warn' ? ' amb' : outcome === 'err' ? ' err' : '';
  return <Glyph kind={kind} label={EVENT_LABEL[kind]} className={`${className}${tone}`} done={kind === 'live' && !live} />;
}
