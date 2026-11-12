import type { FixesViewRow } from '../types.js';

/* A fix's rung as Fixes' rows, a fix's page and Runs' issues say it: small, so a page that shows only this imports no more of Fixes. */

/** A fix's place on the ladder, as a dot and a word: open and blamed muted, verified, applied and merged lime, an applied fix that doesn't hold red. */
export function rungStatus(f: Pick<FixesViewRow, 'rung' | 'pr' | 'broken' | 'status'>): { tone: 'mu' | 'ok' | 'err'; text: string } {
  if (f.status === 'applied' && f.broken) return { tone: 'err', text: 'broken' };
  if (f.rung === 'open' || f.rung === 'blamed') return { tone: 'mu', text: f.rung };
  return { tone: 'ok', text: f.rung === 'merged' && f.pr?.number != null ? `merged · PR #${f.pr.number}` : f.rung };
}
