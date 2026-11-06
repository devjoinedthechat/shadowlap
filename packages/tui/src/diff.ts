import { endedEarlyCount, normalizeAddCommand, type DivergenceReport } from '@shadowlap/engine';
import type { RenderedLine } from './render.js';
import { wrap } from './render.js';
import { THEMES, type Theme } from './theme.js';

function value(v: unknown, width: number): string[] {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  return wrap(s, width);
}

/** What changed at the fork, in a few words, for the divider row the call list draws there. */
export function divergenceSummary(d: DivergenceReport): string {
  switch (d.type) {
    case 'ended_early':
      return `ended early at #${d.callNo} · ${endedEarlyCount(d)} replayed`;
    case 'forced':
      return `forked at #${d.callNo} · ${d.reason ?? 'forced live'}`;
    case 'beyond_recording':
      return `forked at #${d.callNo} · past the end of the recording`;
    case 'new_call':
      return `forked at #${d.callNo} · a call the recording doesn't have`;
    case 'request_changed': {
      const paths = (d.diff ?? []).map((e) => e.path);
      const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` +${paths.length - 3}` : '');
      return `forked at #${d.callNo} · the request changed${shown ? `: ${shown}` : ''}`;
    }
    default:
      return `forked at #${d.callNo}`;
  }
}

/**
 * The divergence report as the diff tab shows it, wrapped to `width`, in the theme's colours: a run
 * that replayed clean in the replayed colour, a fork you asked for in ink, a divergence nobody asked
 * for in amber, and what a changed request removed in red, what it added in ink.
 */
export function diffLines(d: DivergenceReport | null, width: number, theme: Theme = THEMES.dark): RenderedLine[] {
  if (!d) return [{ text: 'This run did not diverge.', color: theme.origin.replayed }];
  const out: RenderedLine[] = [];
  const say = (text: string, color?: string, head = false) => {
    for (const t of wrap(text, width)) out.push({ text: t, ...(color ? { color } : {}), ...(head ? { head } : {}) });
  };
  if (d.type === 'ended_early') {
    say(`✗ Ended early at call ${d.callNo} (${d.kind} ${d.name}): ${endedEarlyCount(d)} replayed`, theme.warn, true);
    say(`every request the agent sent matched, but it stopped before its recording did, without making #${d.callNo}`, theme.dim);
    return out;
  }
  say(`✗ Diverged at call ${d.callNo} (${d.kind} ${d.name}): ${d.replayedBefore} calls replayed before divergence`, d.type === 'forced' ? undefined : theme.warn, true);
  switch (d.type) {
    case 'forced':
      say(d.reason ?? 'forced live by --live-tool or --diverge-at', theme.dim);
      break;
    case 'beyond_recording':
      say('beyond the recording: the agent made more calls than were recorded', theme.dim);
      break;
    case 'new_call':
      say(`new call: ${d.reason ?? 'no recorded counterpart'}`, theme.dim);
      break;
    case 'request_changed':
      if (d.counterpart) say(`compared with run ${d.counterpart.runId.slice(0, 10)}, call ${d.counterpart.callNo}`, theme.dim);
      out.push({ text: '' });
      for (const e of d.diff ?? []) {
        say(`${e.op === 'changed' ? '~' : e.op === 'added' ? '+' : '-'} ${e.path}`, undefined, true);
        if (e.op !== 'added') for (const l of value(e.before, width - 4)) out.push({ text: `  - ${l}`, color: theme.err });
        if (e.op !== 'removed') for (const l of value(e.after, width - 4)) out.push({ text: `  + ${l}` });
        out.push({ text: '' });
      }
      for (const h of d.hints ?? []) {
        say(`hint: ${h.message}`, theme.warn);
        if (h.normalizer) {
          say(normalizeAddCommand(h.normalizer));
          say('or press : then n to add it', theme.dim);
        }
      }
      break;
  }
  return out;
}
