import { describe, expect, it } from 'vitest';
import { parseRoute } from '../ui/route.js';
import { docTitle, TAB_ABOUT_MAX } from '../ui/title.js';

/**
 * Every tab read "Shadowlap", whatever it showed: ten tabs of the dashboard couldn't be told apart.
 * Each route now names its page, as the design's docTitle() does: a run by its id, every other page
 * by what it is, then the product.
 */
const title = (hash: string, facts = {}) => docTitle(parseRoute(hash), facts);

describe('a tab’s title', () => {
  it('names each page by what it is', () => {
    expect(title('#/')).toBe('Overview — shadowlap');
    expect(title('#/runs')).toBe('Runs — shadowlap');
    expect(title('#/fixes')).toBe('Fixes — shadowlap');
    expect(title('#/tests')).toBe('Tests — shadowlap');
    expect(title('#/compare')).toBe('Compare — shadowlap');
    expect(title('#/training')).toBe('Pairs · Training — shadowlap');
    expect(title('#/training/tasks')).toBe('Tasks · Training — shadowlap');
    expect(title('#/new')).toBe('Add a project — shadowlap');
    expect(title('#/setup')).toBe('Set up — shadowlap');
    expect(title('#/setup/store')).toBe('Set up the store — shadowlap');
    expect(title('#/nothing-here')).toBe('Not found — shadowlap');
  });

  it('names a Settings tab, CI by the label its address has kept since Alerts', () => {
    expect(title('#/settings')).toBe('Matching · Settings — shadowlap');
    expect(title('#/settings/redaction')).toBe('Redaction · Settings — shadowlap');
    expect(title('#/settings/alerts')).toBe('CI · Settings — shadowlap');
    expect(title('#/settings/agents')).toBe('Coding agents · Settings — shadowlap');
    expect(title('#/settings/store')).toBe('Store · Settings — shadowlap');
  });

  it('names a run by its id, at any call and in any view', () => {
    expect(title('#/run/01M5GHQ4770XBC2GET8V493QCY')).toBe('01M5GHQ477 — shadowlap');
    expect(title('#/run/01M5GHQ4770XBC2GET8V493QCY/16/provenance')).toBe('01M5GHQ477 — shadowlap');
    // A short id in the address names the same run.
    expect(title('#/run/01M5GHQ477')).toBe('01M5GHQ477 — shadowlap');
  });

  it('adds a run’s about line when it fits, and leaves out one that doesn’t rather than cut a word', () => {
    expect(title('#/run/01M5GHQ4770XBC2GET8V493QCY', { about: 'override #16' })).toBe('01M5GHQ477 · override #16 — shadowlap');
    const long = 'A customer asks for a refund on order A-1131';
    expect(long.length).toBeGreaterThan(TAB_ABOUT_MAX);
    expect(title('#/run/01M5GHQ4770XBC2GET8V493QCY', { about: long })).toBe('01M5GHQ477 — shadowlap');
  });

  it('names a comparison by its two runs', () => {
    expect(title('#/compare/01M5GHNZDF0000000000000000/01M5GHQ4770XBC2GET8V493QCY')).toBe('01M5GHNZDF → 01M5GHQ477 · Compare — shadowlap');
  });

  it('names a fix by its title once it is known, and by its id until then', () => {
    expect(title('#/fixes/fx-01M5GMZKCV/repair', { fixTitle: 'Escalate refunds above the policy limit' })).toBe('Escalate refunds above the policy limit · Fix — shadowlap');
    expect(title('#/fixes/fx-01M5GMZKCV')).toBe('fx-01M5GMZKCV · Fix — shadowlap');
  });

  it('says Set up where the setup shows in place of the page, and why a project can’t be opened', () => {
    expect(title('#/runs', { setup: true })).toBe('Set up — shadowlap');
    expect(title('#/', { setup: true, problem: { name: 'research-agent' } })).toBe('Can’t open research-agent — shadowlap');
    // Not yet known: the page's own name.
    expect(title('#/runs', { setup: null })).toBe('Runs — shadowlap');
  });
});
