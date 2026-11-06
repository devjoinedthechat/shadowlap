import { describe, expect, it } from 'vitest';
import { GROUP_ORDER, matchPalette, type PaletteEntry } from '../ui/palette.js';

// How a typed word finds a row: an action by its label and its words, never by the command in its
// hint; a run's id leads with Runs; typed-only rows wait for a word.

const run = (label: string, hint: string): PaletteEntry => ({ group: 'Runs', label, hint });
const action = (label: string, hint: string, more: Partial<PaletteEntry> = {}): PaletteEntry => ({ group: 'Actions', label, hint, ...more });

describe('the palette’s matching', () => {
  it('finds an action by its label and its words, never by the command in its hint', () => {
    const items = [action('Find breaking commit…', 'shadowlap bisect', { group: 'This run', match: 'bisect' }), action('Replay', 'shadowlap replay 01M5GRX8K4', { group: 'This run' }), run('01M5GRX8K4', 'override #16')];
    // The id finds its run alone, not every action whose command names it.
    expect(matchPalette(items, '01M5GRX8K4').map((x) => x.label)).toEqual(['01M5GRX8K4']);
    expect(matchPalette(items, 'shadowlap')).toEqual([]);
    // Its words find it.
    expect(matchPalette(items, 'bisect').map((x) => x.label)).toEqual(['Find breaking commit…']);
    // A hint that isn't a command is searched, and so is a page's.
    expect(matchPalette([action('Calibrate', 'propose normalizers')], 'propose').map((x) => x.label)).toEqual(['Calibrate']);
    expect(matchPalette([{ group: 'Go to', label: 'Compare', hint: 'shadowlap diff' }], 'diff').map((x) => x.label)).toEqual(['Compare']);
  });

  it('puts Runs first for one word that is part of a run’s id', () => {
    const items = [{ group: 'Go to' as const, label: 'Runs gx8', hint: '' }, run('01M5GRX8K4', 'override #16')];
    expect(matchPalette(items, 'rx8').map((x) => x.group)).toEqual(['Runs']);
    expect(matchPalette(items, 'gx8').map((x) => x.group)).toEqual(['Go to']);
    // Both found: the run leads, as an id does in an issue tracker.
    const both = [{ group: 'Go to' as const, label: 'Overview 5gr', hint: '' }, run('01M5GRX8K4', 'override #16')];
    expect(matchPalette(both, '5gr').map((x) => x.group)).toEqual(['Runs', 'Go to']);
    // Two words, or fewer than three characters: the groups keep their order.
    expect(matchPalette(both, '5g').map((x) => x.group)).toEqual(['Go to', 'Runs']);
  });

  it('keeps typed-only rows, Settings among them, off the open palette, and puts Settings after Go to', () => {
    const settings: PaletteEntry = { group: 'Settings', label: 'Tools', hint: 'what a fork runs again, and what brings outside text in', match: 'settings trusted untrusted security prompt injection mcp', typed: true };
    const rule = action('Add redaction rule…', 'shadowlap redact add', { match: 'redaction mask', typed: true });
    const page: PaletteEntry = { group: 'Go to', label: 'Settings', hint: '' };
    expect(matchPalette([settings, rule, page], '').map((x) => x.label)).toEqual(['Settings']);
    expect(matchPalette([settings, rule], 'injection').map((x) => x.label)).toEqual(['Tools']);
    expect(matchPalette([settings, rule], 'mask').map((x) => x.label)).toEqual(['Add redaction rule…']);
    // Its command finds nothing: `redact` does through its label.
    expect(matchPalette([rule], 'shadowlap')).toEqual([]);
    expect(matchPalette([rule, settings, page], 'settings').map((x) => x.group)).toEqual(['Go to', 'Settings']);
    expect(GROUP_ORDER.indexOf('Settings')).toBe(GROUP_ORDER.indexOf('Go to') + 1);
  });
});
