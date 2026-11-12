import { describe, expect, it } from 'vitest';
import { parseRoute } from '../ui/route.js';
import { docTitle, onOpenRunAbout, openRunAbout, setOpenRunAbout, TAB_ABOUT_MAX } from '../ui/title.js';

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
    expect(title('#/compare')).toBe('Compare · Changes — shadowlap');
    expect(title('#/changes')).toBe('Verdicts · Changes — shadowlap');
    expect(title('#/training')).toBe('Pairs · Training — shadowlap');
    expect(title('#/training/tasks')).toBe('Tasks · Training — shadowlap');
    expect(title('#/new')).toBe('Add project — shadowlap');
    expect(title('#/setup')).toBe('Set up — shadowlap');
    expect(title('#/setup/store')).toBe('Set up team store — shadowlap');
    expect(title('#/nothing-here')).toBe('Not found — shadowlap');
  });

  it('names a Settings tab, and the tab an older name opens: CI for alerts, Project for plan', () => {
    expect(title('#/settings')).toBe('Matching · Settings — shadowlap');
    expect(title('#/settings/redaction')).toBe('Redaction · Settings — shadowlap');
    expect(title('#/settings/ci')).toBe('CI · Settings — shadowlap');
    expect(title('#/settings/alerts')).toBe('CI · Settings — shadowlap');
    expect(title('#/settings/plan')).toBe('Project · Settings — shadowlap');
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

  it('names Compare as a tab of Changes whatever its pair, and an exported copy’s, a page of its own, as Compare', () => {
    expect(title('#/compare/01M5GHNZDF0000000000000000/01M5GHQ4770XBC2GET8V493QCY')).toBe('Compare · Changes — shadowlap');
    expect(title('#/compare/01M5GHNZDF0000000000000000/01M5GHQ4770XBC2GET8V493QCY', { exported: true })).toBe('Compare — shadowlap');
  });

  it('names Verdicts and a revision there by its key, and only the tab for one the page can’t show', () => {
    expect(title('#/changes/verdicts')).toBe('Verdicts · Changes — shadowlap');
    expect(title('#/changes/verdicts/d2e8a1f')).toBe('d2e8a1f · Verdicts · Changes — shadowlap');
    expect(title('#/changes/verdicts/d2e8a1f%2Bdirty')).toBe('d2e8a1f+dirty · Verdicts · Changes — shadowlap');
    expect(title('#/changes/verdicts/d2e8a1f', { unshown: true })).toBe('Verdicts · Changes — shadowlap');
    // A preview reads as its tab, its cell open or not, and shown or not; a migration's address opens Verdicts until its tab lands.
    expect(title('#/changes/decisions')).toBe('Preview · Changes — shadowlap');
    expect(title('#/changes/decisions/dc-01M5000000000000000000000A')).toBe('Preview · Changes — shadowlap');
    expect(title('#/changes/decisions/dc-01M5000000000000000000000A/01M5MXZ7H9ABCDEF/17')).toBe('Preview · Changes — shadowlap');
    expect(title('#/changes/decisions/dc-01M5000000000000000000000A', { unshown: true })).toBe('Preview · Changes — shadowlap');
    expect(title('#/changes/migrate/mg-01M5000000000000000000000B')).toBe('Verdicts · Changes — shadowlap');
  });

  it('names only the section for a run or a fix the page can’t show, or with the setup in its place, as the crumbs do', () => {
    expect(title('#/run/01M5GHQ4770XBC2GET8V493QCY', { unshown: true, about: 'Order A-1131' })).toBe('Runs — shadowlap');
    expect(title('#/fixes/fx-nope', { unshown: true })).toBe('Fixes — shadowlap');
    expect(title('#/run/01M5GHQ4770XBC2GET8V493QCY', { setup: true })).toBe('Runs — shadowlap');
    expect(title('#/fixes/fx-01M5GMZKCV', { setup: true })).toBe('Fixes — shadowlap');
    // The list itself, and the Overview, say what shows: the setup.
    expect(title('#/fixes', { setup: true })).toBe('Set up — shadowlap');
  });

  it('names the project that holds a link another project’s store holds, whatever it names, the setup’s place too', () => {
    for (const hash of ['#/run/01M5GHQ4770XBC2GET8V493QCY/3/context', '#/fixes/fx-01M5GMZKCV/repair', '#/compare/01M5GHQ477/01M5GHR0Q1', '#/compare/01M5GHQ477']) {
      expect(title(hash, { heldBy: 'support-agent', unshown: true, about: 'Order A-1131', fixTitle: 'Escalate refunds' }), hash).toBe('In support-agent — shadowlap');
      expect(title(hash, { heldBy: 'support-agent', setup: true }), hash).toBe('In support-agent — shadowlap');
    }
    // Until the page says so, what it opened for.
    expect(title('#/fixes/fx-01M5GMZKCV', { heldBy: null })).toBe('fx-01M5GMZKCV · Fix — shadowlap');
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

describe('the about line of the run a page has open', () => {
  it('is kept for the shell’s title, which an attempt, missing from the run list, reads it from; a change is told once', () => {
    let told = 0;
    const off = onOpenRunAbout(() => told++);
    setOpenRunAbout('01M5JER8B3ZZZZZZZZZZZZZZZZ', { text: 'resampled #5, attempt 1', from: 'change' });
    expect(openRunAbout()).toEqual({ runId: '01M5JER8B3ZZZZZZZZZZZZZZZZ', about: { text: 'resampled #5, attempt 1', from: 'change' } });
    setOpenRunAbout('01M5JER8B3ZZZZZZZZZZZZZZZZ', { text: 'resampled #5, attempt 1', from: 'change' });
    expect(told).toBe(1);
    expect(docTitle(parseRoute('#/run/01M5JER8B3'), { about: openRunAbout()!.about!.text })).toBe('01M5JER8B3 · resampled #5, attempt 1 — shadowlap');
    setOpenRunAbout(null);
    expect([openRunAbout(), told]).toEqual([null, 2]);
    off();
  });
});
